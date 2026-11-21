//! Required context: specs/tech_docs/managed_cliproxy.md.
//! Signed global controls are independent of App-version resource selection.
#[path = "../cliproxy_policy.rs"]
mod policy;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::types::{Error, Result};

pub(super) const MANIFEST_URL: &str =
    "https://download.myagents.io/runtimes/cliproxy/manifest-v1.json";
pub(super) const MAX_MANIFEST_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Mode {
    Disabled,
    Internal,
    Enabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Controls {
    pub policy_revision: u64,
    pub provider_mode: Mode,
    pub revoked_versions: BTreeSet<String>,
    pub revoked_artifacts: BTreeSet<String>,
}

impl Controls {
    pub fn allows(&self, internal_build: bool) -> bool {
        self.provider_mode == Mode::Enabled
            || (internal_build && self.provider_mode == Mode::Internal)
    }
    pub fn revoked(&self, version: &str, digest: &str) -> bool {
        self.revoked_versions.contains(version) || self.revoked_artifacts.contains(digest)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Compatibility {
    pub min_app_version: String,
    pub revision: u64,
    /// Each listed version has passed *both directions* with this version.
    /// A downgrade never restores a historical snapshot of token contents.
    pub credential_compatible_versions: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Artifact {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub source_sha256: String,
    /// Final files after platform signing; every member is checked on install.
    pub files: BTreeMap<String, String>,
    pub executable: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Component {
    pub version: String,
    pub tag: String,
    pub commit: String,
    pub compatibility: Compatibility,
    pub artifacts: BTreeMap<String, Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub schema_version: u32,
    pub controls: Controls,
    pub releases: Vec<Component>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SignedManifest {
    pub json: String,
    pub signature: String,
}

impl SignedManifest {
    pub fn verify(&self) -> Result<Manifest> {
        if self.json.len() > MAX_MANIFEST_BYTES || self.signature.len() > 16 * 1024 {
            return Err(Error::contract());
        }
        crate::resource_signature::verify_minisign_bytes(
            self.json.as_bytes(),
            self.signature.trim(),
            "CLIProxy manifest",
        )
        .map_err(|_| Error::new("manifest_signature", "组件批准记录签名无效"))?;
        let manifest: Manifest = serde_json::from_str(&self.json).map_err(|_| Error::contract())?;
        if manifest.schema_version != 1 || manifest.controls.policy_revision == 0 {
            return Err(Error::contract());
        }
        let floors: Vec<_> = manifest.releases.iter().map(|release| release.compatibility.min_app_version.as_str()).collect();
        policy::select_release_index("0.0.0", &floors).map_err(|_| Error::contract())?;
        if manifest.releases.is_empty() { return Err(Error::contract()); }
        // Do not validate component compatibility here. Applicable controls
        // must first be persisted even when this component cannot run here.
        Ok(manifest)
    }
}

pub(super) fn merge_controls(current: Option<&Controls>, incoming: &Controls) -> Result<Controls> {
    match current {
        Some(current) if current.policy_revision > incoming.policy_revision => Ok(current.clone()),
        Some(current)
            if current.policy_revision == incoming.policy_revision && current != incoming =>
        {
            Err(Error::new(
                "policy_revision_conflict",
                "组件策略版本冲突，保留已有规则",
            ))
        }
        _ => Ok(incoming.clone()),
    }
}

impl Manifest {
    pub fn select(&self, app: &str) -> Result<Option<&Component>> {
        let floors: Vec<_> = self.releases.iter().map(|r| r.compatibility.min_app_version.as_str()).collect();
        let index = policy::select_release_index(app, &floors).map_err(|_| Error::contract())?;
        Ok(index.map(|index| &self.releases[index]))
    }
}

pub(super) fn version(value: &str) -> Result<[u64; 3]> {
    policy::version(value).map_err(|_| Error::contract())
}

pub(super) fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub(super) fn download_url(raw: &str) -> Result<()> {
    let url = url::Url::parse(raw).map_err(|_| Error::contract())?;
    if url.scheme() != "https"
        || url.host_str() != Some("download.myagents.io")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw.contains('%')
        || raw.contains('\\')
        || !url.path().starts_with("/runtimes/cliproxy/")
    {
        return Err(Error::new("artifact_url", "组件下载地址不受信任"));
    }
    Ok(())
}

pub(super) fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

impl Component {
    pub fn artifact(&self, platform: &str, app: &str) -> Result<&Artifact> {
        version(&self.version)?;
        if self.tag != format!("v{}", self.version)
            || self.commit.len() != 40
            || !self.commit.bytes().all(|c| c.is_ascii_hexdigit())
            || version(app)? < version(&self.compatibility.min_app_version)?
            || self.compatibility.revision == 0
        {
            return Err(Error::new(
                "incompatible",
                "组件版本尚未通过当前应用的兼容验证",
            ));
        }
        let artifact = self
            .artifacts
            .get(platform)
            .ok_or_else(|| Error::new("platform", "当前平台没有批准的组件"))?;
        download_url(&artifact.url)?;
        if artifact.size == 0
            || artifact.size > 128 * 1024 * 1024
            || !digest_valid(&artifact.sha256)
            || !digest_valid(&artifact.source_sha256)
            || artifact.files.is_empty()
            || artifact.files.len() > 64
            || !artifact.files.contains_key(&artifact.executable)
            || !artifact.files.contains_key("LICENSE")
            || artifact
                .files
                .iter()
                .any(|(name, digest)| !safe_filename(name) || !digest_valid(digest))
        {
            return Err(Error::contract());
        }
        Ok(artifact)
    }
    pub fn matches_bundled_source(&self) -> bool {
        let source: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/managed-cliproxy-source.json"
        )).expect("build verifies the bundled CLIProxy source lock");
        source["version"] == self.version && source["commit"] == self.commit
    }

    /// The App ships this upgrade for existing accounts as well as new ones.
    /// A later rollback still needs the signed bidirectional compatibility record.
    pub fn accepts_accounts_from(&self, current: &Self) -> bool {
        self.credential_compatible(current)
            || (self.matches_bundled_source()
                && matches!((version(&self.version), version(&current.version)),
                    (Ok(target), Ok(old)) if target > old))
    }

    fn credential_compatible(&self, other: &Self) -> bool {
        // The newer approval attests both directions. A shipped older
        // manifest cannot know the name of every future compatible release.
        match version(&self.version)
            .and_then(|this| version(&other.version).map(|other| this.cmp(&other)))
        {
            Ok(std::cmp::Ordering::Equal) => self.commit == other.commit,
            Ok(std::cmp::Ordering::Greater) => self
                .compatibility
                .credential_compatible_versions
                .contains(&other.version),
            Ok(std::cmp::Ordering::Less) => other
                .compatibility
                .credential_compatible_versions
                .contains(&self.version),
            Err(_) => false,
        }
    }
}

pub(super) fn should_prepare_update(
    current: Option<&Component>,
    incoming: &Component,
    platform: &str,
    current_revoked: bool,
) -> Result<bool> {
    let Some(current) = current else {
        return Ok(true);
    };
    let ordering = version(&incoming.version)?.cmp(&version(&current.version)?);
    if current_revoked {
        return Ok(true);
    }
    if ordering != std::cmp::Ordering::Equal {
        return Ok(ordering == std::cmp::Ordering::Greater);
    }
    let same_artifact = current
        .artifacts
        .get(platform)
        .zip(incoming.artifacts.get(platform))
        .is_some_and(|(old, new)| {
            old.sha256 == new.sha256 && old.source_sha256 == new.source_sha256
        });
    Ok(same_artifact
        && current.commit == incoming.commit
        && incoming.compatibility.revision > current.compatibility.revision)
}

/// Distribution packages deliberately contain only a flat executable/license
/// payload. Arbitrary archives and user-configured paths are not supported.
pub(super) fn safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !matches!(
            name.split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
        && !name.ends_with('.')
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(in crate::cliproxy) fn component(version: &str) -> Component {
        Component {
            version: version.to_owned(),
            tag: format!("v{version}"),
            commit: "a".repeat(40),
            compatibility: Compatibility {
                min_app_version: "0.4.17".to_owned(),
                revision: 1,
                credential_compatible_versions: BTreeSet::new(),
            },
            artifacts: BTreeMap::from([(
                "darwin-arm64".to_owned(),
                Artifact {
                    url: format!(
                        "https://download.myagents.io/runtimes/cliproxy/{version}/test.zip"
                    ),
                    size: 10,
                    sha256: "b".repeat(64),
                    source_sha256: "c".repeat(64),
                    executable: "cli-proxy-api".to_owned(),
                    files: BTreeMap::from([
                        ("cli-proxy-api".to_owned(), "d".repeat(64)),
                        ("LICENSE".to_owned(), "e".repeat(64)),
                    ]),
                },
            )]),
        }
    }
    #[test]
    fn newer_approval_attests_both_credential_directions_without_rewriting_old_release() {
        let old = component("7.2.157");
        let mut new = component("7.2.158");
        assert!(!old.credential_compatible(&new));
        assert!(!new.credential_compatible(&old));
        new.compatibility
            .credential_compatible_versions
            .insert(old.version.clone());
        assert!(old.credential_compatible(&new));
        assert!(new.credential_compatible(&old));
        assert!(old.compatibility.credential_compatible_versions.is_empty());
        let mut changed_source = old.clone();
        changed_source.commit = "f".repeat(40);
        assert!(!old.credential_compatible(&changed_source));
    }
    #[test]
    fn app_bundled_upgrade_accepts_existing_accounts_without_a_version_list() {
        let manifest = SignedManifest {
            json: include_str!("../../../.github/cliproxy/manifest-v1.json").into(),
            signature: include_str!("../../../.github/cliproxy/manifest-v1.json.sig").into(),
        }.verify().unwrap();
        let bundled = manifest.releases.iter().find(|c| c.matches_bundled_source()).unwrap();
        let old = component("8.0.13");
        assert!(bundled.accepts_accounts_from(&old));
        assert!(!old.accepts_accounts_from(bundled));
        assert!(!component("999.0.0").accepts_accounts_from(&old));
    }

    #[test]
    fn update_admits_higher_versions_and_same_artifact_new_compatibility_only() {
        let old = component("7.2.158");
        assert!(!should_prepare_update(Some(&old), &old, "darwin-arm64", false).unwrap());
        assert!(
            should_prepare_update(Some(&old), &component("7.2.159"), "darwin-arm64", false)
                .unwrap()
        );
        assert!(
            !should_prepare_update(Some(&old), &component("7.2.157"), "darwin-arm64", false)
                .unwrap()
        );
        assert!(
            should_prepare_update(Some(&old), &component("7.2.157"), "darwin-arm64", true).unwrap()
        );
        let mut newer_proof = old.clone();
        newer_proof.compatibility.revision += 1;
        assert!(should_prepare_update(Some(&old), &newer_proof, "darwin-arm64", false).unwrap());
        newer_proof
            .artifacts
            .get_mut("darwin-arm64")
            .unwrap()
            .sha256 = "f".repeat(64);
        assert!(!should_prepare_update(Some(&old), &newer_proof, "darwin-arm64", false).unwrap());
    }
    #[test]
    fn component_incompatibility_does_not_prevent_a_new_control_revision() {
        let old = Controls {
            policy_revision: 1,
            provider_mode: Mode::Enabled,
            revoked_versions: BTreeSet::new(),
            revoked_artifacts: BTreeSet::new(),
        };
        let incoming = Controls {
            policy_revision: 2,
            provider_mode: Mode::Disabled,
            ..old.clone()
        };
        let mut next = component("7.2.159");
        next.compatibility.min_app_version = "99.0.0".to_owned();
        assert_eq!(merge_controls(Some(&old), &incoming).unwrap(), incoming);
        assert!(next.artifact("darwin-arm64", "0.4.16").is_err());
    }
    #[test]
    fn controls_remain_sticky_across_old_bundles_and_same_revision_conflicts() {
        let disabled = Controls {
            policy_revision: 4,
            provider_mode: Mode::Disabled,
            revoked_versions: BTreeSet::from(["7.2.157".to_owned()]),
            revoked_artifacts: BTreeSet::new(),
        };
        let mut old = disabled.clone();
        old.policy_revision = 1;
        old.provider_mode = Mode::Enabled;
        assert_eq!(merge_controls(Some(&disabled), &old).unwrap(), disabled);
        old.policy_revision = 4;
        assert!(merge_controls(Some(&disabled), &old).is_err());
        assert!(!disabled.allows(true));
        assert!(disabled.revoked("7.2.157", ""));
    }
    #[test]
    fn numeric_versions_and_artifact_paths_are_unambiguous() {
        assert!(version("7.2.10").unwrap() > version("7.2.9").unwrap());
        for value in [
            "v7.2.158",
            "07.2.158",
            "7.2",
            "7.2.158-beta",
            "7.2.158/../x",
        ] {
            assert!(version(value).is_err());
        }
        for name in [
            "../binary",
            "/binary",
            "C:binary",
            "CON.exe",
            "binary.",
            "a/b",
            "a\\b",
            ".env",
        ] {
            assert!(!safe_filename(name));
        }
        assert!(safe_filename("CLIProxyAPI.exe"));
        assert!(download_url(MANIFEST_URL).is_ok());
        assert!(
            download_url("https://download.myagents.io.evil.test/runtimes/cliproxy/a.zip").is_err()
        );
        assert!(
            download_url("https://download.myagents.io/runtimes/cliproxy/%2F..%2Fother/a.zip")
                .is_err()
        );
    }
}
