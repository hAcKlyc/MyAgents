use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::Duration;

use notify_debouncer_full::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::{ulog_info, ulog_warn};

const SESSION_METADATA_CHANGED_EVENT: &str = "session:metadata-changed";
const PROJECTION_DEBOUNCE_WINDOW: Duration = Duration::from_millis(300);
const WATCHER_RESTART_DELAY: Duration = Duration::from_secs(2);

fn sessions_path() -> Result<std::path::PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .map(|dir| dir.join("sessions.json"))
        .ok_or_else(|| "无法定位 MyAgents 数据目录".to_string())
}

pub(crate) fn redact_session_metadata(mut session: Value) -> Option<Value> {
    crate::mcp_selection::normalize_mcp_selection_field(&mut session);
    let obj = session.as_object_mut()?;
    if obj
        .get("materializationState")
        .and_then(Value::as_str)
        .is_some_and(|state| state == "prepared")
    {
        return None;
    }
    if obj.contains_key("providerEnvJson") {
        obj.insert(
            "providerEnvJson".to_string(),
            Value::String("[redacted]".to_string()),
        );
    }
    if let Some(stats) = obj.get_mut("stats").and_then(Value::as_object_mut) {
        if let Some(turn_count) = stats.remove("messageCount") {
            stats.insert("turnCount".to_string(), turn_count);
        }
    }
    crate::session_tags::project_sanitized_session_user_tags(obj);
    Some(session)
}

fn read_session_metadata(agent_dir: Option<String>) -> Result<Vec<Value>, String> {
    let path = sessions_path()?;
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(format!(
                "读取 sessions.json 失败：{} ({})",
                path.display(),
                e
            ))
        }
    };
    let sessions: Vec<Value> = serde_json::from_str(crate::utils::bom::strip_bom(&content))
        .map_err(|e| format!("解析 sessions.json 失败：{} ({})", path.display(), e))?;
    let sessions_dir = path.parent().unwrap_or(Path::new(".")).join("sessions");
    let agent_dir_identity = agent_dir
        .as_deref()
        .map(crate::cron_task::normalize_path)
        .filter(|value| !value.is_empty());

    let mut out = Vec::with_capacity(sessions.len());
    for session in sessions {
        if let Some(expected) = agent_dir_identity.as_deref() {
            let current = session
                .get("agentDir")
                .and_then(Value::as_str)
                .map(crate::cron_task::normalize_path);
            if current.as_deref() != Some(expected) {
                continue;
            }
        }
        if !crate::session_visibility::is_history_visible_session(&session, &sessions_dir) {
            continue;
        }
        if let Some(redacted) = redact_session_metadata(session) {
            out.push(redacted);
        }
    }
    Ok(out)
}

/// Lightweight launcher/history metadata read. This intentionally avoids the
/// global Node sidecar so the Launcher can show recent conversations before the
/// AI runtime finishes cold-starting.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_list_session_metadata(agentDir: Option<String>) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || read_session_metadata(agentDir))
        .await
        .map_err(|e| format!("读取会话元数据任务失败：{}", e))?
}

type SessionProjectionSnapshot = HashMap<String, Value>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetadataChangedPayload {
    agent_dirs: Vec<String>,
}

fn projection_snapshot(sessions: Vec<Value>) -> SessionProjectionSnapshot {
    sessions
        .into_iter()
        .filter_map(|session| {
            let id = session.get("id")?.as_str()?.to_string();
            Some((id, session))
        })
        .collect()
}

fn read_projection_snapshot() -> Result<SessionProjectionSnapshot, String> {
    read_session_metadata(None).map(projection_snapshot)
}

/// Return `None` when the visible Session projection is unchanged. `Some([])`
/// is meaningful: a malformed historical row can change without carrying an
/// agentDir, in which case the renderer conservatively invalidates all loaded
/// workspace slices.
fn changed_agent_dirs(
    previous: &SessionProjectionSnapshot,
    current: &SessionProjectionSnapshot,
) -> Option<Vec<String>> {
    let mut changed = false;
    let mut agent_dirs = BTreeSet::new();

    for (id, current_session) in current {
        if previous.get(id) == Some(current_session) {
            continue;
        }
        changed = true;
        if let Some(agent_dir) = current_session.get("agentDir").and_then(Value::as_str) {
            agent_dirs.insert(agent_dir.to_string());
        }
        if let Some(agent_dir) = previous
            .get(id)
            .and_then(|session| session.get("agentDir"))
            .and_then(Value::as_str)
        {
            agent_dirs.insert(agent_dir.to_string());
        }
    }

    for (id, previous_session) in previous {
        if current.contains_key(id) {
            continue;
        }
        changed = true;
        if let Some(agent_dir) = previous_session.get("agentDir").and_then(Value::as_str) {
            agent_dirs.insert(agent_dir.to_string());
        }
    }

    changed.then(|| agent_dirs.into_iter().collect())
}

fn changed_agent_dirs_from_baseline(
    previous: Option<&SessionProjectionSnapshot>,
    current: &SessionProjectionSnapshot,
) -> Option<Vec<String>> {
    match previous {
        Some(previous) => changed_agent_dirs(previous, current),
        // Unknown is not the same state as an empty projection. We cannot
        // recover old workspace identities after a failed baseline read, so
        // the first successful read must invalidate every loaded slice even
        // when the repaired projection is empty.
        None => Some(Vec::new()),
    }
}

fn is_session_projection_path(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file_name == "sessions.json" {
        return true;
    }
    file_name.ends_with(".jsonl")
        && path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some("sessions")
}

fn run_session_metadata_watcher(app_handle: AppHandle) -> Result<(), String> {
    let sessions_file = sessions_path()?;
    let data_dir = sessions_file
        .parent()
        .ok_or_else(|| "sessions.json 缺少父目录".to_string())?
        .to_path_buf();
    let sessions_dir = data_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir)
        .map_err(|error| format!("创建 Session 目录失败：{}", error))?;

    let (tx, rx) = std::sync::mpsc::channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(PROJECTION_DEBOUNCE_WINDOW, None, tx)
        .map_err(|error| format!("创建 Session metadata watcher 失败：{}", error))?;
    debouncer
        .watch(&sessions_dir, RecursiveMode::NonRecursive)
        .map_err(|error| format!("监听 Session 消息目录失败：{}", error))?;
    debouncer
        .watch(&data_dir, RecursiveMode::NonRecursive)
        .map_err(|error| format!("监听 sessions.json 失败：{}", error))?;

    let mut snapshot = match read_projection_snapshot() {
        Ok(snapshot) => Some(snapshot),
        Err(error) => {
            // The observer must outlive a corrupt or temporarily unreadable
            // startup file. Keep the baseline explicitly unknown so the first
            // successful repair broadly invalidates even if it recovers to an
            // empty projection.
            ulog_warn!(
                "[session-metadata] initial projection read failed; waiting for repair: {}",
                error
            );
            None
        }
    };
    ulog_info!(
        "[session-metadata] projection watcher started (debounce={:?})",
        PROJECTION_DEBOUNCE_WINDOW
    );
    // The OS watcher has no pre-registration replay. Emit a broad readiness
    // invalidation after watches + baseline are established so a renderer that
    // already reconciled before this thread armed cannot retain that old read.
    // If no renderer listener exists yet, its post-registration catch-up reads
    // the same persisted authority instead.
    if let Err(error) = app_handle.emit(
        SESSION_METADATA_CHANGED_EVENT,
        SessionMetadataChangedPayload {
            agent_dirs: Vec::new(),
        },
    ) {
        ulog_warn!(
            "[session-metadata] projection-ready event emit failed: {}",
            error
        );
    }

    for result in rx {
        let events = match result {
            Ok(events) => events,
            Err(errors) => {
                for error in errors {
                    ulog_warn!("[session-metadata] watcher event error: {}", error);
                }
                continue;
            }
        };
        if !events
            .iter()
            .flat_map(|event| event.event.paths.iter())
            .any(|path| is_session_projection_path(path))
        {
            continue;
        }

        let current = match read_projection_snapshot() {
            Ok(current) => current,
            Err(error) => {
                // Keep the last good baseline. Atomic SessionStore writes make
                // this rare; retaining it ensures the next filesystem event
                // still computes a real delta instead of accepting corruption.
                ulog_warn!("[session-metadata] projection read failed: {}", error);
                continue;
            }
        };
        let change = changed_agent_dirs_from_baseline(snapshot.as_ref(), &current);
        snapshot = Some(current);
        let Some(agent_dirs) = change else {
            continue;
        };

        if let Err(error) = app_handle.emit(
            SESSION_METADATA_CHANGED_EVENT,
            SessionMetadataChangedPayload { agent_dirs },
        ) {
            ulog_warn!("[session-metadata] projection event emit failed: {}", error);
        }
    }

    drop(debouncer);
    Ok(())
}

/// Observe the authoritative history-visible Session projection independently
/// from any Sidecar, Runtime, channel, or search-index lifecycle. This watcher
/// is intentionally separate from the 5s Tantivy watcher: navigation freshness
/// needs a short debounce and must remain available if the derived search index
/// cannot initialize.
pub fn spawn_session_metadata_watcher(app_handle: AppHandle) {
    if let Err(error) = std::thread::Builder::new()
        .name("session-metadata-watcher".to_string())
        .spawn(move || loop {
            match run_session_metadata_watcher(app_handle.clone()) {
                Ok(()) => {
                    ulog_warn!("[session-metadata] projection watcher stopped unexpectedly")
                }
                Err(error) => {
                    ulog_warn!(
                        "[session-metadata] projection watcher terminated: {}",
                        error
                    );
                }
            }

            // OS watch resources can fail transiently (for example Linux
            // inotify exhaustion). This dedicated app-lifetime thread owns
            // re-arming; every successful run emits the broad ready event, so
            // writes during downtime reconcile without a replay protocol.
            std::thread::sleep(WATCHER_RESTART_DELAY);
        })
    {
        ulog_warn!(
            "[session-metadata] failed to spawn projection watcher: {}",
            error
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        changed_agent_dirs, changed_agent_dirs_from_baseline, is_session_projection_path,
        projection_snapshot, redact_session_metadata, SessionProjectionSnapshot,
    };
    use serde_json::{json, Value};
    use std::path::Path;

    #[test]
    fn projects_legacy_mcp_selection_without_changing_snapshot_authority() {
        let value = redact_session_metadata(json!({
            "id": "session-1",
            "configSnapshotAt": "frozen",
            "mcpEnabledServers": "[playwright,tavily-search]"
        }))
        .unwrap();
        assert_eq!(value["configSnapshotAt"], "frozen");
        assert_eq!(
            value["mcpEnabledServers"],
            json!(["playwright", "tavily-search"])
        );
    }

    #[test]
    fn redacts_provider_env_json() {
        let value = redact_session_metadata(json!({
            "id": "session-1",
            "providerEnvJson": "{\"apiKey\":\"secret\"}"
        }));

        assert_eq!(
            value
                .and_then(|v| v.get("providerEnvJson").cloned())
                .and_then(|v| v.as_str().map(str::to_string))
                .as_deref(),
            Some("[redacted]"),
        );
    }

    #[test]
    fn projects_legacy_message_count_as_turn_count() {
        let value = redact_session_metadata(json!({
            "id": "session-1",
            "stats": {
                "messageCount": 3,
                "totalInputTokens": 10,
                "totalOutputTokens": 2
            }
        }))
        .unwrap();

        assert_eq!(
            value.pointer("/stats/turnCount").and_then(Value::as_u64),
            Some(3)
        );
        assert!(value.pointer("/stats/messageCount").is_none());
    }

    #[test]
    fn filters_prepared_sessions() {
        let value = redact_session_metadata(json!({
            "id": "pending-session",
            "materializationState": "prepared"
        }));

        assert!(value.is_none());
    }

    #[test]
    fn projects_only_valid_user_tags() {
        let value = redact_session_metadata(json!({
            "id": "session-1",
            "userTags": [" Alpha ", "alpha", 42, "Beta"]
        }))
        .unwrap();

        assert_eq!(value.get("userTags"), Some(&json!(["Alpha", "Beta"])));
    }

    #[test]
    fn projection_diff_routes_create_update_move_and_delete_to_affected_workspaces() {
        let previous = projection_snapshot(vec![
            json!({ "id": "updated", "agentDir": "/work/a", "title": "Old" }),
            json!({ "id": "moved", "agentDir": "/work/a", "title": "Move" }),
            json!({ "id": "deleted", "agentDir": "/work/c", "title": "Delete" }),
        ]);
        let current = projection_snapshot(vec![
            json!({ "id": "updated", "agentDir": "/work/a", "title": "New" }),
            json!({ "id": "moved", "agentDir": "/work/b", "title": "Move" }),
            json!({ "id": "created", "agentDir": "/work/d", "title": "Create" }),
        ]);

        assert_eq!(
            changed_agent_dirs(&previous, &current),
            Some(vec![
                "/work/a".to_string(),
                "/work/b".to_string(),
                "/work/c".to_string(),
                "/work/d".to_string(),
            ]),
        );
        assert_eq!(changed_agent_dirs(&current, &current), None);
        assert_eq!(
            changed_agent_dirs(&SessionProjectionSnapshot::new(), &current),
            Some(vec![
                "/work/a".to_string(),
                "/work/b".to_string(),
                "/work/d".to_string(),
            ]),
        );
        assert_eq!(
            changed_agent_dirs_from_baseline(None, &SessionProjectionSnapshot::new()),
            Some(Vec::new()),
        );
    }

    #[test]
    fn projection_path_matching_is_structural_across_apfs_aliases() {
        assert!(is_session_projection_path(Path::new(
            "/System/Volumes/Data/Users/alice/.myagents/sessions.json"
        )));
        assert!(is_session_projection_path(Path::new(
            "/System/Volumes/Data/Users/alice/.myagents/sessions/session-1.jsonl"
        )));
        assert!(!is_session_projection_path(Path::new(
            "/Users/alice/.myagents/sessions.json.tmp"
        )));
        assert!(!is_session_projection_path(Path::new(
            "/Users/alice/other/session-1.jsonl"
        )));
    }
}
