use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

const CONFIG_KEY: &str = "externalCliAccess";
const EXTERNAL_CLI_SKILL_DIR: &str = "external-myagents-cli";
const EXTERNAL_CLI_SKILL_FILE: &str = "SKILL.md";
const EXTERNAL_CLI_SKILL_CONTENT: &str =
    include_str!("../../bundled-guides/external-myagents-cli/SKILL.md");
pub const INTERNAL_TOKEN_HEADER: &str = "x-myagents-internal-cli-token";
pub const INTERNAL_TOKEN_ENV: &str = "MYAGENTS_INTERNAL_CLI_TOKEN";

static INTERNAL_TOKEN: OnceLock<String> = OnceLock::new();
static EXTERNAL_CLI_SKILL_SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static EXTERNAL_CLI_SKILL_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliAccessState {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub launcher_path: String,
    pub skill_path: String,
    pub skill_ready: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredExternalCliAccess {
    #[serde(default)]
    enabled: bool,
    token: Option<String>,
    created_at: Option<String>,
}

fn new_secret(prefix: &str) -> String {
    format!(
        "{prefix}_{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn internal_token() -> &'static str {
    INTERNAL_TOKEN.get_or_init(|| new_secret("mai")).as_str()
}

pub fn inject_internal_token(command: &mut std::process::Command) {
    command.env(INTERNAL_TOKEN_ENV, internal_token());
}

pub fn inject_internal_token_builder(command: &mut portable_pty::CommandBuilder) {
    command.env(INTERNAL_TOKEN_ENV, internal_token());
}

pub fn internal_request_is_valid(headers: &HeaderMap) -> bool {
    headers
        .get(INTERNAL_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|candidate| {
            constant_time_eq(candidate.as_bytes(), internal_token().as_bytes())
        })
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left_byte, right_byte) in left.iter().zip(right) {
        difference |= left_byte ^ right_byte;
    }
    difference == 0
}

fn config_path() -> Result<PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join("config.json"))
        .ok_or_else(|| "MyAgents data directory is unavailable".to_string())
}

fn launcher_path() -> String {
    let file_name = PathBuf::from(if cfg!(windows) {
        format!("{}.cmd", crate::app_dirs::APP_CLI_NAME)
    } else {
        crate::app_dirs::APP_CLI_NAME.to_string()
    });
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join("bin").join(&file_name))
        .unwrap_or(file_name)
        .to_string_lossy()
        .into_owned()
}

fn external_cli_skill_path_at(data_dir: &Path) -> PathBuf {
    data_dir
        .join(EXTERNAL_CLI_SKILL_DIR)
        .join(EXTERNAL_CLI_SKILL_FILE)
}

fn external_cli_skill_path() -> String {
    crate::app_dirs::myagents_data_dir()
        .map(|dir| external_cli_skill_path_at(&dir))
        .unwrap_or_else(|| PathBuf::from(EXTERNAL_CLI_SKILL_DIR).join(EXTERNAL_CLI_SKILL_FILE))
        .to_string_lossy()
        .into_owned()
}

/// Reconcile the explicit-read external AI guide with the current App version.
///
/// This intentionally writes outside `~/.myagents/skills`: the file is a
/// handoff document referenced by Settings, not an installed/injected skill.
pub(crate) fn ensure_external_cli_skill() -> Result<bool, String> {
    let data_dir = crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "MyAgents data directory is unavailable".to_string())?;
    let _guard = EXTERNAL_CLI_SKILL_SYNC_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|error| format!("External CLI guide lock failed: {error}"))?;
    reconcile_external_cli_skill(&data_dir)
}

fn reconcile_external_cli_skill(data_dir: &Path) -> Result<bool, String> {
    let target = external_cli_skill_path_at(data_dir);
    let parent = target
        .parent()
        .ok_or_else(|| "External CLI guide target has no parent directory".to_string())?;

    match fs::symlink_metadata(parent) {
        Ok(metadata)
            if metadata.file_type().is_dir()
                && !crate::workspace_files::path_safety::metadata_is_link_like(&metadata) => {}
        Ok(_) => {
            return Err(format!(
                "External CLI guide directory is not a real directory: {}",
                parent.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create external CLI guide directory {}: {error}",
                    parent.display()
                )
            })?;
            let metadata = fs::symlink_metadata(parent).map_err(|error| {
                format!(
                    "Failed to inspect external CLI guide directory {}: {error}",
                    parent.display()
                )
            })?;
            if !metadata.file_type().is_dir()
                || crate::workspace_files::path_safety::metadata_is_link_like(&metadata)
            {
                return Err(format!(
                    "External CLI guide directory changed identity during creation: {}",
                    parent.display()
                ));
            }
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect external CLI guide directory {}: {error}",
                parent.display()
            ));
        }
    }

    let expected = EXTERNAL_CLI_SKILL_CONTENT.as_bytes();
    if fs::symlink_metadata(&target)
        .ok()
        .is_some_and(|metadata| metadata.file_type().is_file())
        && fs::read(&target).is_ok_and(|actual| actual == expected)
    {
        return Ok(false);
    }

    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(EXTERNAL_CLI_SKILL_FILE);
    let (mut temp_file, temp_path) = (0..16)
        .find_map(|_| {
            let sequence = EXTERNAL_CLI_SKILL_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temp_path = parent.join(format!(
                ".{file_name}.{}.{}.tmp",
                std::process::id(),
                sequence
            ));
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)
            {
                Ok(file) => Some(Ok((file, temp_path))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!(
                    "Failed to create external CLI guide temp file {}: {error}",
                    temp_path.display()
                ))),
            }
        })
        .unwrap_or_else(|| {
            Err(format!(
                "Failed to reserve an external CLI guide temp file in {}",
                parent.display()
            ))
        })?;

    let install_result = (|| -> Result<(), String> {
        temp_file.write_all(expected).map_err(|error| {
            format!(
                "Failed to write external CLI guide temp file {}: {error}",
                temp_path.display()
            )
        })?;
        temp_file.sync_all().map_err(|error| {
            format!(
                "Failed to sync external CLI guide temp file {}: {error}",
                temp_path.display()
            )
        })?;
        drop(temp_file);
        fs::rename(&temp_path, &target).map_err(|error| {
            format!(
                "Failed to publish external CLI guide {}: {error}",
                target.display()
            )
        })?;
        Ok(())
    })();
    if install_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    install_result.map(|()| true)
}

fn parse_state(config: &serde_json::Value, reveal_token: bool) -> ExternalCliAccessState {
    let stored = config
        .get(CONFIG_KEY)
        .cloned()
        .and_then(|value| serde_json::from_value::<StoredExternalCliAccess>(value).ok())
        .unwrap_or(StoredExternalCliAccess {
            enabled: false,
            token: None,
            created_at: None,
        });
    ExternalCliAccessState {
        enabled: stored.enabled,
        token: reveal_token.then_some(stored.token).flatten(),
        created_at: stored.created_at,
        launcher_path: launcher_path(),
        skill_path: external_cli_skill_path(),
        skill_ready: false,
    }
}

fn parse_state_with_skill_result(
    config: &serde_json::Value,
    reveal_token: bool,
    skill_result: Result<bool, String>,
) -> ExternalCliAccessState {
    let mut state = parse_state(config, reveal_token);
    state.skill_ready = skill_result.is_ok();
    state
}

fn emit_config_changed() {
    if let Some(app) = crate::logger::get_app_handle() {
        let _ = app.emit("app:config-changed", ());
        let _ = app.emit("external-cli-access-changed", ());
    }
}

#[tauri::command]
pub async fn cmd_get_external_cli_access() -> Result<ExternalCliAccessState, String> {
    let config = crate::config_io::read_config_json(&config_path()?)?;
    Ok(parse_state_with_skill_result(
        &config,
        true,
        ensure_external_cli_skill(),
    ))
}

#[tauri::command]
pub async fn cmd_set_external_cli_enabled(enabled: bool) -> Result<ExternalCliAccessState, String> {
    let path = config_path()?;
    let config = crate::config_io::with_config_lock(&path, false, move |config| {
        let current = parse_state(config, true);
        let token = current.token.or_else(|| enabled.then(|| new_secret("mae")));
        let created_at = current
            .created_at
            .or_else(|| token.as_ref().map(|_| chrono::Utc::now().to_rfc3339()));
        config[CONFIG_KEY] = serde_json::json!({
            "enabled": enabled,
            "token": token,
            "createdAt": created_at,
        });
        Ok(())
    })?;
    emit_config_changed();
    Ok(parse_state_with_skill_result(
        &config,
        true,
        ensure_external_cli_skill(),
    ))
}

#[tauri::command]
pub async fn cmd_reset_external_cli_token() -> Result<ExternalCliAccessState, String> {
    let path = config_path()?;
    let config = crate::config_io::with_config_lock(&path, false, |config| {
        let current = parse_state(config, true);
        config[CONFIG_KEY] = serde_json::json!({
            "enabled": current.enabled,
            "token": new_secret("mae"),
            "createdAt": chrono::Utc::now().to_rfc3339(),
        });
        Ok(())
    })?;
    emit_config_changed();
    Ok(parse_state_with_skill_result(
        &config,
        true,
        ensure_external_cli_skill(),
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCliAdmission {
    pub allowed: bool,
    pub code: &'static str,
}

pub fn authorize_external_token(token: &str) -> Result<ExternalCliAdmission, String> {
    let config = crate::config_io::read_config_json(&config_path()?)?;
    let state = parse_state(&config, true);
    if !state.enabled {
        return Ok(ExternalCliAdmission {
            allowed: false,
            code: "external_cli_disabled",
        });
    }
    let Some(expected) = state.token else {
        return Ok(ExternalCliAdmission {
            allowed: false,
            code: "external_cli_token_missing",
        });
    };
    if token.is_empty() || !constant_time_eq(token.as_bytes(), expected.as_bytes()) {
        return Ok(ExternalCliAdmission {
            allowed: false,
            code: "external_cli_token_invalid",
        });
    }
    Ok(ExternalCliAdmission {
        allowed: true,
        code: "ok",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_path_uses_the_active_product_cli_name() {
        let path = PathBuf::from(launcher_path());
        let expected = if cfg!(windows) {
            format!("{}.cmd", crate::app_dirs::APP_CLI_NAME)
        } else {
            crate::app_dirs::APP_CLI_NAME.to_string()
        };
        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some(expected.as_str()));
    }

    #[test]
    fn constant_time_comparison_requires_equal_bytes() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn internal_token_is_stable_for_process_lifetime() {
        let first = internal_token().to_string();
        assert_eq!(first, internal_token());
        assert!(first.starts_with("mai_"));
        assert!(first.len() > 64);
    }

    #[test]
    fn internal_request_requires_the_exact_process_capability() {
        let mut headers = HeaderMap::new();
        assert!(!internal_request_is_valid(&headers));
        headers.insert(INTERNAL_TOKEN_HEADER, "wrong".parse().unwrap());
        assert!(!internal_request_is_valid(&headers));
        headers.insert(
            INTERNAL_TOKEN_HEADER,
            internal_token().parse().expect("internal token header"),
        );
        assert!(internal_request_is_valid(&headers));
    }

    #[test]
    fn external_cli_skill_is_created_updated_and_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let target = external_cli_skill_path_at(root.path());

        assert!(reconcile_external_cli_skill(root.path()).unwrap());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            EXTERNAL_CLI_SKILL_CONTENT
        );
        assert!(!reconcile_external_cli_skill(root.path()).unwrap());

        fs::write(&target, "stale guide").unwrap();
        assert!(reconcile_external_cli_skill(root.path()).unwrap());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            EXTERNAL_CLI_SKILL_CONTENT
        );
    }

    #[cfg(unix)]
    #[test]
    fn external_cli_skill_rejects_a_symlinked_projection_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let redirect = tempfile::tempdir().unwrap();
        symlink(redirect.path(), root.path().join(EXTERNAL_CLI_SKILL_DIR)).unwrap();

        let error = reconcile_external_cli_skill(root.path()).unwrap_err();
        assert!(error.contains("not a real directory"));
        assert!(!redirect.path().join(EXTERNAL_CLI_SKILL_FILE).exists());
    }

    #[cfg(windows)]
    #[test]
    fn external_cli_skill_rejects_a_junction_projection_directory() {
        let root = tempfile::tempdir().unwrap();
        let redirect = tempfile::tempdir().unwrap();
        let junction_path = root.path().join(EXTERNAL_CLI_SKILL_DIR);
        junction::create(redirect.path(), &junction_path).unwrap();

        let error = reconcile_external_cli_skill(root.path()).unwrap_err();
        assert!(error.contains("not a real directory"));
        assert!(!redirect.path().join(EXTERNAL_CLI_SKILL_FILE).exists());

        junction::delete(&junction_path).unwrap();
    }

    #[test]
    fn skill_sync_failure_does_not_hide_external_access_state() {
        let config = serde_json::json!({
            CONFIG_KEY: {
                "enabled": true,
                "token": "mae_existing",
                "createdAt": "2026-09-19T00:00:00Z",
            }
        });

        let state = parse_state_with_skill_result(
            &config,
            true,
            Err("guide directory unavailable".to_string()),
        );

        assert!(state.enabled);
        assert_eq!(state.token.as_deref(), Some("mae_existing"));
        assert!(!state.skill_ready);
    }
}
