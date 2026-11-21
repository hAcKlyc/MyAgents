//! Component installation facts. Activation is called by the account owner only
//! after it drains leases and successfully starts the replacement process.
//! Required context: specs/tech_docs/managed_cliproxy.md, especially installed selection.
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::manifest::{
    self, Artifact, Component, Controls, SignedManifest, MANIFEST_URL, MAX_MANIFEST_BYTES,
};
use super::store::{private_dir, read_json, write_json};
use super::types::{Error, Result};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Installed {
    pub approval: SignedManifest,
    pub source: String,
    pub min_app_version: String,
}

impl Installed {
    pub fn component(&self) -> Result<Component> {
        self.approval.verify()?.releases.into_iter()
            .find(|release| release.compatibility.min_app_version == self.min_app_version)
            .ok_or_else(Error::contract)
    }
    pub fn select(approval: SignedManifest, source: &str, app: &str) -> Result<Option<Self>> {
        let manifest = approval.verify()?;
        Ok(manifest.select(app)?.map(|release| Self {
            min_app_version: release.compatibility.min_app_version.clone(),
            approval,
            source: source.to_owned(),
        }))
    }
    pub fn identity(&self, app: &str, sdk: &str) -> Result<String> {
        let component = self.component()?;
        let platform = manifest::platform().ok_or_else(Error::contract)?;
        // Identity comparison must also work for a previous App/SDK approval.
        // Applicability belongs to allowed(), not historical pointer lookup.
        let artifact = component
            .artifacts
            .get(platform)
            .ok_or_else(Error::contract)?;
        if !manifest::digest_valid(&artifact.sha256) || component.compatibility.revision == 0 {
            return Err(Error::contract());
        }
        Ok(format!(
            "{}:{app}:{sdk}:{}",
            artifact.sha256, component.compatibility.revision
        ))
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct State {
    #[serde(skip)]
    policy_error: Option<Error>,
    #[serde(skip)]
    pub control_source: String,
    pub controls: Option<SignedManifest>,
    pub current: Option<Installed>,
    pub previous: Option<Installed>,
    pub pending: Option<Installed>,
    /// Started is also a failed automatic attempt after a crash. Only an
    /// explicit retry, new artifact or tested compatibility identity retries.
    pub attempts: BTreeSet<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Update {
    pub phase: String,
    pub target_version: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub last_checked_at: Option<String>,
    pub error: Option<Error>,
}

pub(super) struct ComponentStore {
    pub state: Mutex<State>,
    pub update: std::sync::Mutex<Update>,
    pub installation: Mutex<()>,
    pub root: PathBuf,
    pub bundled: PathBuf,
    pub state_path: PathBuf,
    pub app_version: String,
    pub sdk_version: String,
}

struct StagingDirectory(PathBuf);
impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl ComponentStore {
    pub fn bundled_installed(&self) -> Result<Installed> {
        let approval = self.bundled_approval()?;
        let mut manifest = approval.verify()?;
        manifest.releases.retain(Component::matches_bundled_source);
        let release = manifest.select(&self.app_version)?.ok_or_else(Error::contract)?;
        Ok(Installed { min_app_version: release.compatibility.min_app_version.clone(),
            approval, source: "bundled".to_owned() })
    }
    pub fn new(
        data: &Path,
        bundled: PathBuf,
        app_version: String,
        sdk_version: String,
    ) -> Result<Self> {
        let state_path = data.join("providers/cliproxy/component-state.json");
        let state = read_json::<State>(&state_path)?.unwrap_or_default();
        if let Some(controls) = &state.controls {
            controls.verify()?;
        }
        Ok(Self {
            state: Mutex::new(state),
            update: std::sync::Mutex::new(Update {
                phase: "idle".to_owned(),
                ..Default::default()
            }),
            installation: Mutex::new(()),
            root: data.join("runtimes/cliproxy"),
            bundled,
            state_path,
            app_version,
            sdk_version,
        })
    }
    pub fn bundled_approval(&self) -> Result<SignedManifest> {
        let json_path = self.bundled.join("manifest-v1.json");
        if fs::metadata(&json_path)
            .map_err(|_| Error::new("bundled_missing", "安装包缺少批准的模型组件"))?
            .len()
            > MAX_MANIFEST_BYTES as u64
        {
            return Err(Error::contract());
        }
        let approval = SignedManifest {
            json: fs::read_to_string(json_path).map_err(|_| Error::storage())?,
            signature: fs::read_to_string(self.bundled.join("manifest-v1.json.sig"))
                .map_err(|_| Error::storage())?,
        };
        approval.verify()?;
        Ok(approval)
    }
    pub async fn controls(&self) -> Result<Controls> {
        let state = self.state.lock().await;
        if let Some(error) = &state.policy_error {
            return Err(error.clone());
        }
        state
            .controls
            .as_ref()
            .ok_or_else(|| Error::new("manifest_missing", "组件批准记录不可用"))?
            .verify()
            .map(|m| m.controls)
    }
    pub async fn ingest_controls(&self, approval: &SignedManifest, source: &str) -> Result<()> {
        let incoming = approval.verify()?.controls;
        let mut state = self.state.lock().await;
        let current = state
            .controls
            .as_ref()
            .map(|s| s.verify().map(|m| m.controls))
            .transpose()?;
        let merged = manifest::merge_controls(current.as_ref(), &incoming)?;
        if current.as_ref() != Some(&merged) || state.policy_error.is_some() {
            let mut next = state.clone();
            if current.as_ref() != Some(&merged) {
                next.controls = Some(approval.clone());
                next.control_source = source.to_owned();
            }
            next.policy_error = None;
            let saved = write_json(&self.state_path, &next);
            // Keep the newest authenticated record even if persistence fails.
            // All admission stays closed until that exact record is durable.
            if let Err(error) = &saved {
                next.policy_error = Some(error.clone());
            }
            *state = next;
            saved?;
        }
        if current.as_ref() == Some(&incoming) {
            state.control_source = source.to_owned();
        }
        Ok(())
    }
    fn persist_state(&self, state: &mut State, next: State) -> Result<()> {
        let saved = write_json(&self.state_path, &next);
        if saved.is_ok() || saved.as_ref().is_err_and(|e| e.code == "storage_sync") {
            *state = next;
        }
        saved
    }
    pub async fn allowed(&self, installed: &Installed) -> Result<Component> {
        let controls = self.controls().await?;
        if !controls.allows(cfg!(debug_assertions)) {
            return Err(Error::new("provider_disabled", "当前无法使用 Antigravity"));
        }
        let component = installed.component()?;
        let artifact = component.artifact(
            manifest::platform().ok_or_else(Error::contract)?,
            &self.app_version)?;
        if controls.revoked(&component.version, &artifact.sha256) {
            return Err(Error::new("component_revoked", "需要更新模型组件后使用"));
        }
        Ok(component)
    }
    pub fn directory(&self, installed: &Installed) -> Result<PathBuf> {
        let component = installed.component()?;
        let platform = manifest::platform().ok_or_else(Error::contract)?;
        let artifact = component.artifact(platform, &self.app_version)?;
        Ok(self
            .root
            .join(&component.version)
            .join(platform)
            .join(&artifact.sha256))
    }
    pub fn executable(&self, installed: &Installed) -> Result<PathBuf> {
        let component = installed.component()?;
        let artifact = component.artifact(
            manifest::platform().ok_or_else(Error::contract)?,
            &self.app_version)?;
        let directory = self.directory(installed)?;
        validate_installed(&directory, artifact)?;
        Ok(directory.join(&artifact.executable))
    }
    pub async fn begin_attempt(&self, installed: &Installed, manual: bool) -> Result<()> {
        let identity = installed.identity(&self.app_version, &self.sdk_version)?;
        let mut state = self.state.lock().await;
        if !manual && state.attempts.contains(&identity) {
            return Err(Error::new(
                "retry_required",
                "此组件安装或启动曾失败，请手动重试",
            ));
        }
        let mut next = state.clone();
        next.attempts.insert(identity);
        self.persist_state(&mut state, next)?;
        Ok(())
    }
    pub async fn failed_attempt(&self, installed: &Installed) -> Result<bool> {
        let identity = installed.identity(&self.app_version, &self.sdk_version)?;
        Ok(self.state.lock().await.attempts.contains(&identity))
    }
    pub async fn clear_attempt(&self, installed: &Installed) -> Result<()> {
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        next.attempts
            .remove(&installed.identity(&self.app_version, &self.sdk_version)?);
        self.persist_state(&mut state, next)?;
        Ok(())
    }
    pub async fn set_pending(&self, installed: Installed) -> Result<()> {
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        next.attempts
            .remove(&installed.identity(&self.app_version, &self.sdk_version)?);
        let incoming = installed.component()?;
        let platform = manifest::platform().ok_or_else(Error::contract)?;
        let controls = next
            .controls
            .as_ref()
            .map(|s| s.verify().map(|m| m.controls))
            .transpose()?;
        for retained in next.pending.iter().chain(next.current.iter()) {
            let component = retained.component()?;
            if let Ok(artifact) = component.artifact(platform, &self.app_version)
            {
                let revoked = controls
                    .as_ref()
                    .is_some_and(|c| c.revoked(&component.version, &artifact.sha256));
                if !manifest::should_prepare_update(Some(&component), &incoming, platform, revoked)?
                {
                    self.persist_state(&mut state, next)?;
                    return Ok(());
                }
            }
        }
        next.pending = Some(installed);
        self.persist_state(&mut state, next)?;
        Ok(())
    }
    pub async fn activate(&self, installed: &Installed) -> Result<()> {
        let component = self.allowed(installed).await?;
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        let identity = installed.identity(&self.app_version, &self.sdk_version)?;
        if next
            .current
            .as_ref()
            .map(|i| i.identity(&self.app_version, &self.sdk_version))
            .transpose()?
            .as_deref()
            != Some(&identity)
        {
            next.previous = next.current.take();
        }
        next.current = Some(installed.clone());
        if next
            .pending
            .as_ref()
            .map(|i| i.identity(&self.app_version, &self.sdk_version))
            .transpose()?
            .as_deref()
            == Some(&identity)
        {
            next.pending = None;
        }
        // Successful activation removes the failed-attempt marker. Live crash
        // restart uses its independent, bounded in-memory budget.
        next.attempts.remove(&identity);
        self.persist_state(&mut state, next)?;
        drop(state);
        crate::ulog_info!(
            "[cliproxy] component activated version={} source={}",
            component.version,
            installed.source
        );
        if let Ok(mut update) = self.update.lock() {
            if update.target_version.as_deref() == Some(&component.version)
                && matches!(update.phase.as_str(), "ready" | "waiting-to-switch")
            {
                update.phase = "idle".to_owned();
                update.target_version = None;
                update.error = None;
            }
        }
        if let Err(error) = self.collect_garbage().await {
            crate::ulog_warn!("[cliproxy] component cleanup deferred code={}", error.code);
        }
        Ok(())
    }

    pub async fn collect_garbage(&self) -> Result<()> {
        // Never hold an account transition waiting for an unrelated download.
        let Ok(_installation) = self.installation.try_lock() else {
            return Ok(());
        };
        let state = self.state.lock().await.clone();
        let mut retained = BTreeSet::new();
        for installed in state
            .current
            .iter()
            .chain(state.previous.iter())
            .chain(state.pending.iter())
        {
            let component = installed.component()?;
            manifest::version(&component.version)?;
            let platform = manifest::platform().ok_or_else(Error::contract)?;
            if let Some(artifact) = component.artifacts.get(platform) {
                if !manifest::digest_valid(&artifact.sha256) {
                    return Err(Error::contract());
                }
                retained.insert(
                    self.root
                        .join(component.version)
                        .join(platform)
                        .join(&artifact.sha256),
                );
            }
        }
        if !self.root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&self.root).map_err(|_| Error::storage())? {
            let entry = entry.map_err(|_| Error::storage())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().map_err(|_| Error::storage())?.is_dir() {
                continue;
            }
            if name
                .strip_prefix(".staging-")
                .is_some_and(|id| Uuid::parse_str(id).is_ok())
            {
                fs::remove_dir_all(entry.path()).map_err(|_| Error::storage())?;
                continue;
            }
            if manifest::version(&name).is_err() {
                continue;
            }
            for platform in ["darwin-arm64", "darwin-x64", "win32-x64"] {
                let directory = entry.path().join(platform);
                let Ok(metadata) = fs::symlink_metadata(&directory) else {
                    continue;
                };
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    continue;
                }
                for artifact in fs::read_dir(directory).map_err(|_| Error::storage())? {
                    let artifact = artifact.map_err(|_| Error::storage())?;
                    if manifest::digest_valid(&artifact.file_name().to_string_lossy())
                        && artifact.file_type().map_err(|_| Error::storage())?.is_dir()
                        && !retained.contains(&artifact.path())
                    {
                        fs::remove_dir_all(artifact.path()).map_err(|_| Error::storage())?;
                    }
                }
            }
        }
        Ok(())
    }
    pub async fn fetch_manifest(&self) -> Result<SignedManifest> {
        let client = external_client(crate::resource_download::RESOURCE_DOWNLOAD_TIMEOUT)?;
        let json = crate::resource_download::fetch_limited_bytes(
            &client,
            MANIFEST_URL,
            MAX_MANIFEST_BYTES as u64,
            "CLIProxy manifest",
        )
        .await
        .map_err(|error| manifest_download_error("manifest", error))?;
        let signature = crate::resource_download::fetch_limited_bytes(
            &client,
            &format!("{MANIFEST_URL}.sig"),
            16 * 1024,
            "CLIProxy signature",
        )
        .await
        .map_err(|error| manifest_download_error("signature", error))?;
        let approved = SignedManifest {
            json: String::from_utf8(json).map_err(|_| Error::contract())?,
            signature: String::from_utf8(signature).map_err(|_| Error::contract())?,
        };
        approved.verify()?;
        Ok(approved)
    }
    pub async fn install(
        &self,
        installed: &Installed,
        manual: bool,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> Result<()> {
        let _installation = self.installation.lock().await;
        if *cancelled.borrow() {
            return Err(Error::cancelled());
        }
        let component = installed.component()?;
        let artifact = component.artifact(
            manifest::platform().ok_or_else(Error::contract)?,
            &self.app_version)?;
        let destination = self.directory(installed)?;
        if self.executable(installed).is_ok() {
            if !manual && self.failed_attempt(installed).await? {
                return Err(Error::new("retry_required", "此组件曾启动失败，请手动重试"));
            }
            return self.set_pending(installed.clone()).await;
        }
        self.begin_attempt(installed, manual).await?;
        private_dir(&self.root)?;
        let stage = self.root.join(format!(".staging-{}", Uuid::new_v4()));
        private_dir(&stage)?;
        let _stage = StagingDirectory(stage.clone());
        let archive = stage.join("artifact.zip");
        let result = async {
            if installed.source == "bundled" {
                if fs::metadata(self.bundled.join("artifact.zip")).map_err(|_| Error::storage())?.len() != artifact.size {
                    return Err(Error::new("artifact_integrity", "内置组件大小与批准记录不符"));
                }
                fs::copy(self.bundled.join("artifact.zip"), &archive).map_err(|_| Error::new("bundled_missing", "内置模型组件不完整"))?;
            } else {
                self.set_update("downloading", Some(component.version.clone()), None);
                let client = external_client(crate::resource_download::RESOURCE_DOWNLOAD_TIMEOUT)?;
                let downloaded = tokio::select! {
                    _ = cancelled.changed() => { self.clear_attempt(installed).await?; return Err(Error::cancelled()); },
                    result = crate::resource_download::download_to_file_with_hash(&client, &artifact.url, &archive,
                    artifact.size, Some(artifact.size), crate::resource_download::RESOURCE_DOWNLOAD_TIMEOUT, |done, total| {
                        if let Ok(mut update) = self.update.lock() { update.downloaded_bytes = Some(done); update.total_bytes = total; }
                    }) => result,
                };
                if let Err(error) = downloaded {
                    match error {
                        crate::resource_download::DownloadError::Transport(_) | crate::resource_download::DownloadError::Http(_) => {
                            // Only transport failures are automatically retryable.
                            let mut state = self.state.lock().await; let mut next = state.clone();
                            next.attempts.remove(&installed.identity(&self.app_version, &self.sdk_version)?);
                            self.persist_state(&mut state, next)?;
                            return Err(Error::new("update_network", "组件下载失败，继续使用本机版本"));
                        }
                        crate::resource_download::DownloadError::SizeLimit => return Err(Error::new("artifact_integrity", "组件文件超出批准大小，已拒绝安装")),
                        crate::resource_download::DownloadError::Storage(_) => return Err(Error::storage()),
                    }
                }
            }
            self.set_update("installing", Some(component.version.clone()), None);
            if fs::metadata(&archive).map_err(|_| Error::storage())?.len() != artifact.size || hash_file(&archive)? != artifact.sha256 {
                return Err(Error::new("artifact_integrity", "组件文件校验失败，已拒绝安装"));
            }
            let payload = stage.join("payload"); private_dir(&payload)?;
            extract(&archive, &payload, artifact)?;
            private_dir(destination.parent().ok_or_else(Error::storage)?)?;
            crate::durable_fs::rename_directory_noreplace(&payload, &destination).map_err(|_| Error::storage())?;
            crate::durable_fs::sync_directory(destination.parent().ok_or_else(Error::storage)?).map_err(|_| Error::storage())?;
            self.set_pending(installed.clone()).await?;
            self.set_update("ready", Some(component.version.clone()), None);
            Ok(())
        }.await;
        result
    }
    pub fn set_update(&self, phase: &str, target: Option<String>, error: Option<Error>) {
        if let Some(error) = &error {
            crate::ulog_warn!(
                "[cliproxy] component update phase={} code={}",
                phase,
                error.code
            );
        } else {
            crate::ulog_info!(
                "[cliproxy] component update phase={} target={}",
                phase,
                target.as_deref().unwrap_or("-")
            );
        }
        if let Ok(mut update) = self.update.lock() {
            update.phase = phase.to_owned();
            update.target_version = target;
            update.error = error;
        }
    }
}

fn external_client(timeout: Duration) -> Result<reqwest::Client> {
    // External signed-resource CDN only: retain configured/system proxies.
    // This is the per-call-site external-host exception defined in clippy.toml.
    #[allow(clippy::disallowed_methods)]
    crate::proxy_config::build_client_with_proxy(
        reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none()),
    )
    .map_err(|_| Error::new("update_network", "无法连接组件更新服务"))
}

fn manifest_download_error(
    resource: &str,
    error: crate::resource_download::DownloadError,
) -> Error {
    use crate::resource_download::DownloadError;
    let (reason, status) = match &error {
        DownloadError::Http(status) => ("http", *status),
        DownloadError::Transport(_) => ("transport", 0),
        DownloadError::SizeLimit => ("size", 0),
        DownloadError::Storage(_) => ("storage", 0),
    };
    // The transport error may contain proxy credentials or URLs. Log only
    // the finite stage/class/status; never the raw error or response body.
    crate::ulog_warn!(
        "[cliproxy] update check failed resource={} reason={} http_status={}",
        resource,
        reason,
        status
    );
    match error {
        DownloadError::Http(404) => Error::new(
            "update_unpublished",
            "组件更新清单尚未发布，当前继续使用本机版本。",
        ),
        DownloadError::SizeLimit => {
            Error::new("update_invalid", "组件更新清单无效，当前继续使用本机版本。")
        }
        _ => Error::new("update_network", "暂时无法检查组件更新，继续使用本机版本"),
    }
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(|_| Error::storage())?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| Error::storage())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn validate_installed(directory: &Path, artifact: &Artifact) -> Result<()> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| Error::storage())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::storage());
    }
    let entries = fs::read_dir(directory)
        .map_err(|_| Error::storage())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| Error::storage())?;
    if entries.len() != artifact.files.len() {
        return Err(Error::contract());
    }
    for (name, expected) in &artifact.files {
        let path = directory.join(name);
        let metadata = fs::symlink_metadata(&path).map_err(|_| Error::storage())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > 256 * 1024 * 1024
            || hash_file(&path)? != *expected
        {
            return Err(Error::new("artifact_integrity", "已安装组件的文件校验失败"));
        }
    }
    Ok(())
}

fn extract(archive: &Path, destination: &Path, artifact: &Artifact) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|_| Error::storage())?)
        .map_err(|_| Error::contract())?;
    if zip.len() != artifact.files.len() {
        return Err(Error::contract());
    }
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| Error::contract())?;
        let name = entry.name().to_owned();
        if !manifest::safe_filename(&name)
            || !artifact.files.contains_key(&name)
            || !seen.insert(name.clone())
            || entry.is_dir()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(Error::contract());
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(Error::contract)?;
        if total > 256 * 1024 * 1024 {
            return Err(Error::contract());
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination.join(&name))
            .map_err(|_| Error::storage())?;
        let size = entry.size();
        let copied = std::io::copy(&mut (&mut entry).take(size + 1), &mut output)
            .map_err(|_| Error::contract())?;
        if copied != size {
            return Err(Error::contract());
        }
        output.flush().map_err(|_| Error::storage())?;
        output.sync_all().map_err(|_| Error::storage())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                destination.join(&name),
                fs::Permissions::from_mode(if name == artifact.executable {
                    0o700
                } else {
                    0o600
                }),
            )
            .map_err(|_| Error::storage())?;
        }
    }
    validate_installed(destination, artifact)?;
    crate::durable_fs::sync_directory(destination).map_err(|_| Error::storage())
}

#[cfg(test)]
mod tests {
    #[test]
    fn unpublished_update_is_distinct_from_transport_failure_without_exposing_details() {
        use crate::resource_download::DownloadError;
        let missing = super::manifest_download_error("manifest", DownloadError::Http(404));
        assert_eq!(missing.code, "update_unpublished");
        let transport = super::manifest_download_error(
            "signature",
            DownloadError::Transport("private proxy details".to_owned()),
        );
        assert_eq!(transport.code, "update_network");
        assert!(!transport.message.contains("private proxy details"));
        assert_eq!(
            super::manifest_download_error("manifest", DownloadError::SizeLimit).code,
            "update_invalid"
        );
    }
    use super::*;
    fn signed_fixture() -> SignedManifest {
        // Internal, empty-model approval; contains no credentials or private key.
        SignedManifest {
            json: include_str!("fixtures/internal-manifest.json").to_owned(),
            signature: include_str!("fixtures/internal-manifest.json.sig").to_owned(),
        }
    }
    #[test]
    #[cfg(any(
        all(target_os = "macos", any(target_arch = "aarch64", target_arch = "x86_64")),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    fn installed_selection_remains_fixed_across_app_and_sdk_changes() {
        let installed = Installed {
            min_app_version: "0.4.17".to_owned(),
            approval: signed_fixture(),
            source: "bundled".to_owned(),
        };
        assert!(installed.identity("99.0.0", "99.0.0").is_ok());
        assert!(installed
            .component()
            .unwrap()
            .artifact(manifest::platform().unwrap(), "99.0.0")
            .is_ok());
        assert_eq!(installed.component().unwrap().compatibility.min_app_version, "0.4.17");
        let updated = Installed::select(signed_fixture(), "updated", "0.4.20").unwrap().unwrap();
        assert_eq!(updated.min_app_version, "0.4.20");
        assert_eq!(updated.component().unwrap().compatibility.revision, 2);
        assert_eq!(installed.component().unwrap().compatibility.revision, 1);
        assert!(Installed::select(signed_fixture(), "updated", "0.4.16").unwrap().is_none());
        let mut modified = signed_fixture();
        modified.json.push(' ');
        assert!(modified.verify().is_err());
    }
    #[tokio::test]
    async fn unpersisted_controls_close_admission_and_retry_the_known_record() {
        let temp = tempfile::tempdir().unwrap();
        let store = ComponentStore::new(
            temp.path(),
            temp.path().join("bundle"),
            "0.4.17".to_owned(),
            "0.3.261".to_owned(),
        )
        .unwrap();
        let approval = signed_fixture();
        // Deterministic storage failure at the atomic replacement boundary.
        private_dir(&store.state_path).unwrap();
        assert!(store.ingest_controls(&approval, "remote").await.is_err());
        assert!(store.controls().await.is_err());
        assert!(store.state.lock().await.controls.is_some());
        fs::remove_dir(&store.state_path).unwrap();
        store.ingest_controls(&approval, "remote").await.unwrap();
        assert_eq!(store.controls().await.unwrap().policy_revision, 1);
        assert!(read_json::<State>(&store.state_path)
            .unwrap()
            .unwrap()
            .controls
            .is_some());
    }
    #[tokio::test]
    #[cfg(any(
        all(target_os = "macos", any(target_arch = "aarch64", target_arch = "x86_64")),
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    async fn immutable_pointer_reuse_does_not_create_a_duplicate_update_and_gc_keeps_current() {
        let temp = tempfile::tempdir().unwrap();
        let store = ComponentStore::new(
            temp.path(),
            temp.path().join("bundle"),
            "0.4.17".to_owned(),
            "0.3.261".to_owned(),
        )
        .unwrap();
        let installed = Installed {
            min_app_version: "0.4.17".to_owned(),
            approval: signed_fixture(),
            source: "bundled".to_owned(),
        };
        store
            .ingest_controls(&installed.approval, "bundled")
            .await
            .unwrap();
        let current = store.directory(&installed).unwrap();
        private_dir(&current).unwrap();
        let obsolete = current.parent().unwrap().join("f".repeat(64));
        private_dir(&obsolete).unwrap();
        store.activate(&installed).await.unwrap();
        assert!(current.exists());
        assert!(!obsolete.exists());
        store.set_pending(installed).await.unwrap();
        assert!(store.state.lock().await.pending.is_none());
    }
    fn fixture(path: &Path, extra: Option<&str>) -> Artifact {
        let mut artifact = manifest::tests::component("7.2.158").artifacts["darwin-arm64"].clone();
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for name in ["cli-proxy-api", "LICENSE"].into_iter().chain(extra) {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(name.as_bytes()).unwrap();
            if extra != Some(name) {
                artifact.files.insert(
                    name.to_owned(),
                    format!("{:x}", Sha256::digest(name.as_bytes())),
                );
            }
        }
        zip.finish().unwrap();
        artifact
    }
    #[test]
    fn extraction_and_reuse_check_every_file_and_reject_extra_or_modified_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("component.zip");
        let artifact = fixture(&archive, None);
        let destination = temp.path().join("payload");
        private_dir(&destination).unwrap();
        extract(&archive, &destination, &artifact).unwrap();
        validate_installed(&destination, &artifact).unwrap();
        fs::write(destination.join("LICENSE"), "changed").unwrap();
        assert!(validate_installed(&destination, &artifact).is_err());
        let extra = fixture(&archive, Some("unapproved.dll"));
        let other = temp.path().join("other");
        private_dir(&other).unwrap();
        assert!(extract(&archive, &other, &extra).is_err());
    }
    #[test]
    fn extraction_does_not_follow_traversal_members() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("component.zip");
        let mut artifact = fixture(&archive, Some("../escape"));
        artifact.files.insert(
            "../escape".to_owned(),
            format!("{:x}", Sha256::digest(b"../escape")),
        );
        let destination = temp.path().join("payload");
        private_dir(&destination).unwrap();
        assert!(extract(&archive, &destination, &artifact).is_err());
        assert!(!temp.path().join("escape").exists());
    }
}
