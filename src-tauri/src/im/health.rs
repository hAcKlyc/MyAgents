// IM Health State — periodic persistence to ~/.myagents/im_bots/{botId}/state.json
// Used for Desktop UI status display, restart recovery, and diagnostics.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::time::{interval, Duration};

use super::router::SessionRouter;
use super::types::{ImActiveSession, ImHealthState, ImStatus};
use crate::utils::bom::strip_bom;
use crate::{ulog_info, ulog_warn};

/// Persist interval (seconds)
const PERSIST_INTERVAL_SECS: u64 = 5;

/// Managed health state with periodic persistence
pub struct HealthManager {
    state: Arc<Mutex<ImHealthState>>,
    persist_path: PathBuf,
    active_sessions_projection: Arc<Mutex<()>>,
    persist_write: Arc<Mutex<()>>,
}

impl HealthManager {
    pub fn new(persist_path: PathBuf) -> Self {
        // Try to load existing state, or start fresh
        let state = if persist_path.exists() {
            match std::fs::read_to_string(&persist_path) {
                Ok(content) => serde_json::from_str::<ImHealthState>(&content).unwrap_or_default(),
                Err(_) => ImHealthState::default(),
            }
        } else {
            ImHealthState::default()
        };

        Self {
            state: Arc::new(Mutex::new(state)),
            persist_path,
            active_sessions_projection: Arc::new(Mutex::new(())),
            persist_write: Arc::new(Mutex::new(())),
        }
    }

    /// Get a clone of current health state
    pub async fn get_state(&self) -> ImHealthState {
        self.state.lock().await.clone()
    }

    /// Update status
    pub async fn set_status(&self, status: ImStatus) {
        self.state.lock().await.status = status;
    }

    /// Set bot username
    pub async fn set_bot_username(&self, username: Option<String>) {
        self.state.lock().await.bot_username = username;
    }

    /// Set error message
    pub async fn set_error(&self, message: Option<String>) {
        self.state.lock().await.error_message = message;
    }

    /// Increment restart count
    pub async fn increment_restart_count(&self) {
        self.state.lock().await.restart_count += 1;
    }

    /// Update uptime
    pub async fn set_uptime(&self, seconds: u64) {
        self.state.lock().await.uptime_seconds = seconds;
    }

    /// Update last message timestamp
    pub async fn set_last_message_at(&self, timestamp: String) {
        self.state.lock().await.last_message_at = Some(timestamp);
    }

    /// Update buffered messages count
    pub async fn set_buffered_messages(&self, count: usize) {
        self.state.lock().await.buffered_messages = count;
    }

    /// Update active sessions
    pub async fn set_active_sessions(&self, sessions: Vec<ImActiveSession>) {
        self.state.lock().await.active_sessions = sessions;
    }

    /// Add an active session
    pub async fn add_active_session(&self, session: ImActiveSession) {
        self.state.lock().await.active_sessions.push(session);
    }

    /// Remove an active session
    pub async fn remove_active_session(&self, session_key: &str) {
        self.state
            .lock()
            .await
            .active_sessions
            .retain(|s| s.session_key != session_key);
    }

    /// Reset state (on stop)
    pub async fn reset(&self) {
        let mut state = self.state.lock().await;
        *state = ImHealthState::default();
    }

    /// Persist current state to disk
    pub async fn persist(&self) -> Result<(), String> {
        let _write_guard = self.persist_write.lock().await;
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        next.last_persisted = chrono::Utc::now().to_rfc3339();
        write_health_state(&self.persist_path, &next)?;
        *state = next;
        Ok(())
    }

    /// Serialize a peer-binding transition with every other active-session
    /// projection. Callers that mutate a Router transactionally acquire this
    /// guard before the Router lock, matching `persist_router_active_sessions`.
    pub(crate) async fn lock_active_sessions_projection(&self) -> tokio::sync::OwnedMutexGuard<()> {
        Arc::clone(&self.active_sessions_projection)
            .lock_owned()
            .await
    }

    /// Persist an already-snapshotted Router state while the caller owns the
    /// active-session projection guard. This keeps binding mutation, durable
    /// projection, and rollback on one authority path without a second store.
    pub(crate) async fn persist_active_sessions_snapshot(
        &self,
        sessions: Vec<ImActiveSession>,
    ) -> Result<(), String> {
        let _write_guard = self.persist_write.lock().await;
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        next.active_sessions = sessions;
        next.last_persisted = chrono::Utc::now().to_rfc3339();
        // Commit the durable projection before publishing the matching
        // in-memory snapshot. A failed write therefore leaves both authorities
        // on the prior binding and needs no second, failure-prone rollback IO.
        write_health_state(&self.persist_path, &next)?;
        *state = next;
        Ok(())
    }

    /// Start periodic persistence task (runs until shutdown)
    pub fn start_persist_loop(
        &self,
        mut shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let state = Arc::clone(&self.state);
        let persist_path = self.persist_path.clone();
        let persist_write = Arc::clone(&self.persist_write);

        tauri::async_runtime::spawn(async move {
            let mut tick = interval(Duration::from_secs(PERSIST_INTERVAL_SECS));

            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let _write_guard = persist_write.lock().await;
                        let mut s = state.lock().await;
                        let mut next = s.clone();
                        next.last_persisted = chrono::Utc::now().to_rfc3339();
                        if let Err(e) = write_health_state(&persist_path, &next) {
                            ulog_warn!("[im-health] Failed to persist: {}", e);
                        } else {
                            *s = next;
                        }
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            ulog_info!("[im-health] Persist loop shutting down");
                            break;
                        }
                    }
                }
            }
        })
    }
}

fn write_health_state(path: &Path, state: &ImHealthState) -> Result<(), String> {
    let json =
        serde_json::to_vec_pretty(state).map_err(|error| format!("Serialize error: {error}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create health dir: {error}"))?;
    }
    crate::workspace_files::path_safety::atomic_write_file(path, &json)
        .map_err(|error| format!("Failed to write health state: {error}"))
}

fn summarize_active_sessions(sessions: &[ImActiveSession]) -> String {
    sessions
        .iter()
        .take(4)
        .map(|session| {
            let short_session_id: String = session.session_id.chars().take(8).collect();
            format!(
                "{}:{}",
                session.session_key,
                if short_session_id.is_empty() {
                    "<empty>"
                } else {
                    short_session_id.as_str()
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

pub(crate) async fn persist_router_active_sessions(
    health: &Arc<HealthManager>,
    router: &Arc<Mutex<SessionRouter>>,
    context: &str,
) -> Result<(), String> {
    let _projection_guard = health.lock_active_sessions_projection().await;
    let sessions = {
        let router_guard = router.lock().await;
        router_guard.active_sessions()
    };
    let count = sessions.len();
    let summary = summarize_active_sessions(&sessions);
    match health.persist_active_sessions_snapshot(sessions).await {
        Ok(()) => Ok(()),
        Err(e) => {
            ulog_warn!(
                "[im-health] persist active sessions failed context={} count={} sessions=[{}]: {}",
                context,
                count,
                summary,
                e
            );
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// ~/.myagents/
fn myagents_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
}

/// ~/.myagents/im_bots/{botId}/
/// Panics if bot_id contains path separators or `..` (defense in depth).
pub fn bot_data_dir(bot_id: &str) -> PathBuf {
    assert!(
        !bot_id.is_empty()
            && !bot_id.contains('/')
            && !bot_id.contains('\\')
            && !bot_id.contains(".."),
        "[im-health] Invalid bot_id for path construction: {:?}",
        bot_id
    );
    myagents_dir().join("im_bots").join(bot_id)
}

/// v3 path: ~/.myagents/im_bots/{botId}/state.json
pub fn bot_health_path(bot_id: &str) -> PathBuf {
    bot_data_dir(bot_id).join("state.json")
}

/// v3 path: ~/.myagents/im_bots/{botId}/buffer.json
pub fn bot_buffer_path(bot_id: &str) -> PathBuf {
    bot_data_dir(bot_id).join("buffer.json")
}

/// v3 path: ~/.myagents/im_bots/{botId}/dedup.json
pub fn bot_dedup_path(bot_id: &str) -> PathBuf {
    bot_data_dir(bot_id).join("dedup.json")
}

// ---------------------------------------------------------------------------
// Agent channel path helpers (v0.1.41 — TD-3)
// ---------------------------------------------------------------------------

/// ~/.myagents/agents/{agentId}/channels/{channelId}/
pub fn agent_channel_data_dir(agent_id: &str, channel_id: &str) -> PathBuf {
    debug_assert!(
        !agent_id.is_empty()
            && !agent_id.contains('/')
            && !agent_id.contains('\\')
            && !agent_id.contains(".."),
        "[im-health] Invalid agent_id for path construction: {:?}",
        agent_id
    );
    debug_assert!(
        !channel_id.is_empty()
            && !channel_id.contains('/')
            && !channel_id.contains('\\')
            && !channel_id.contains(".."),
        "[im-health] Invalid channel_id for path construction: {:?}",
        channel_id
    );
    myagents_dir()
        .join("agents")
        .join(agent_id)
        .join("channels")
        .join(channel_id)
}

pub fn agent_channel_health_path(agent_id: &str, channel_id: &str) -> PathBuf {
    agent_channel_data_dir(agent_id, channel_id).join("state.json")
}

/// Read the Session identities retained by a configured channel while its
/// runtime instance is stopped or temporarily detached for replacement.
///
/// The health file is the restart authority for peer bindings. A missing or
/// unreadable file contributes no binding, matching channel restore behavior.
pub(crate) fn persisted_active_session_ids(path: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(state) = serde_json::from_str::<ImHealthState>(strip_bom(&content)) else {
        return Vec::new();
    };
    state
        .active_sessions
        .into_iter()
        .filter_map(|session| {
            let id = session.session_id.trim();
            (!id.is_empty()).then(|| id.to_string())
        })
        .collect()
}

pub fn agent_channel_buffer_path(agent_id: &str, channel_id: &str) -> PathBuf {
    agent_channel_data_dir(agent_id, channel_id).join("buffer.json")
}

pub fn agent_channel_dedup_path(agent_id: &str, channel_id: &str) -> PathBuf {
    agent_channel_data_dir(agent_id, channel_id).join("dedup.json")
}

/// Migrate bot data from legacy im_bots/{channelId}/ to agents/{agentId}/channels/{channelId}/.
/// Copies files to new path first; only deletes old path on success. Idempotent (skips if new exists).
pub fn migrate_bot_data_to_agent(channel_id: &str, agent_id: &str) {
    let old_dir = bot_data_dir(channel_id);
    let new_dir = agent_channel_data_dir(agent_id, channel_id);

    // Nothing to migrate if old dir doesn't exist
    if !old_dir.exists() {
        // Ensure new dir exists for fresh starts
        let _ = std::fs::create_dir_all(&new_dir);
        return;
    }

    // Skip if new dir already has data (idempotent)
    if new_dir.join("state.json").exists() {
        ulog_info!(
            "[im-health] Agent channel data already exists at {:?}, skipping migration",
            new_dir
        );
        return;
    }

    // Create new dir
    if let Err(e) = std::fs::create_dir_all(&new_dir) {
        ulog_warn!(
            "[im-health] Failed to create agent channel dir {:?}: {}, skipping migration",
            new_dir,
            e
        );
        return;
    }

    // Copy each file
    let files = ["state.json", "buffer.json", "dedup.json"];
    let mut all_copied = true;
    for file in &files {
        let old_path = old_dir.join(file);
        let new_path = new_dir.join(file);
        if old_path.exists() {
            match std::fs::copy(&old_path, &new_path) {
                Ok(_) => ulog_info!(
                    "[im-health] Migrated {} from im_bots/{} to agents/{}/channels/{}",
                    file,
                    channel_id,
                    agent_id,
                    channel_id
                ),
                Err(e) => {
                    ulog_warn!(
                        "[im-health] Failed to copy {} during migration: {}",
                        file,
                        e
                    );
                    all_copied = false;
                }
            }
        }
    }

    // Only delete old dir if all files copied successfully
    if all_copied {
        match std::fs::remove_dir_all(&old_dir) {
            Ok(_) => ulog_info!(
                "[im-health] Removed old bot data dir: im_bots/{}",
                channel_id
            ),
            Err(e) => ulog_warn!(
                "[im-health] Failed to remove old bot dir {:?}: {}",
                old_dir,
                e
            ),
        }
    }
}

/// Clean up agent channel data (called when channel config is removed).
pub fn cleanup_agent_channel_data(agent_id: &str, channel_id: &str) {
    let dir = agent_channel_data_dir(agent_id, channel_id);
    if dir.exists() {
        match std::fs::remove_dir_all(&dir) {
            Ok(_) => ulog_info!(
                "[im-health] Cleaned agent channel data: agents/{}/channels/{}",
                agent_id,
                channel_id
            ),
            Err(e) => ulog_warn!(
                "[im-health] Failed to remove agent channel dir {:?}: {}",
                dir,
                e
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Legacy path helpers (private, migration only)
// ---------------------------------------------------------------------------

/// v1 legacy: single-bot era — ~/.myagents/im_state.json
fn legacy_health_path() -> PathBuf {
    myagents_dir().join("im_state.json")
}
/// v1 legacy: single-bot era — ~/.myagents/im_buffer.json
fn legacy_buffer_path() -> PathBuf {
    myagents_dir().join("im_buffer.json")
}

/// v2 flat: multi-bot era — ~/.myagents/im_{botId}_state.json
fn flat_health_path(bot_id: &str) -> PathBuf {
    myagents_dir().join(format!("im_{}_state.json", bot_id))
}
/// v2 flat: multi-bot era — ~/.myagents/im_{botId}_buffer.json
fn flat_buffer_path(bot_id: &str) -> PathBuf {
    myagents_dir().join(format!("im_{}_buffer.json", bot_id))
}
/// v2 flat: multi-bot era — ~/.myagents/im_{botId}_dedup.json
fn flat_dedup_path(bot_id: &str) -> PathBuf {
    myagents_dir().join(format!("im_{}_dedup.json", bot_id))
}

// ---------------------------------------------------------------------------
// Migration: v1 (single-bot) + v2 (flat) → v3 (subdir)
// ---------------------------------------------------------------------------

static ORPHAN_CLEANUP: std::sync::Once = std::sync::Once::new();

/// Migrate legacy/flat files to v3 subdir structure, then clean orphans once.
pub fn migrate_legacy_files(bot_id: &str) {
    // Ensure target directory exists
    let target_dir = bot_data_dir(bot_id);
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        ulog_warn!(
            "[im-health] Failed to create bot data dir {:?}: {}, skipping migration",
            target_dir,
            e
        );
        return;
    }

    // --- v1: single-bot era → v3 subdir ---
    migrate_single_file(&legacy_health_path(), &bot_health_path(bot_id), "health");
    migrate_single_file(&legacy_buffer_path(), &bot_buffer_path(bot_id), "buffer");

    // --- v2: flat multi-bot → v3 subdir ---
    migrate_flat_file(
        &flat_health_path(bot_id),
        &bot_health_path(bot_id),
        "health",
    );
    migrate_flat_file(
        &flat_buffer_path(bot_id),
        &bot_buffer_path(bot_id),
        "buffer",
    );
    migrate_flat_file(&flat_dedup_path(bot_id), &bot_dedup_path(bot_id), "dedup");

    // --- One-time cleanup of orphaned flat files + legacy markers ---
    ORPHAN_CLEANUP.call_once(|| {
        cleanup_orphaned_flat_files();
        cleanup_legacy_markers();
    });
}

/// v1 migration: copy then rename original to `.migrated`.
fn migrate_single_file(legacy: &Path, target: &Path, label: &str) {
    if !legacy.exists() || target.exists() {
        return;
    }
    match std::fs::copy(legacy, target) {
        Ok(_) => {
            ulog_info!("[im-health] Migrated legacy {} → {:?}", label, target);
            let migrated = legacy.with_extension("json.migrated");
            if let Err(e) = std::fs::rename(legacy, &migrated) {
                ulog_warn!(
                    "[im-health] Failed to rename legacy {} to .migrated: {}",
                    label,
                    e
                );
            }
        }
        Err(e) => {
            ulog_warn!("[im-health] Failed to migrate legacy {} file: {}", label, e);
        }
    }
}

/// v2 flat migration: copy then delete source (per-bot file, no sharing concern).
fn migrate_flat_file(src: &Path, dst: &Path, label: &str) {
    if !src.exists() || dst.exists() {
        return;
    }
    match std::fs::copy(src, dst) {
        Ok(_) => {
            if let Err(e) = std::fs::remove_file(src) {
                ulog_warn!(
                    "[im-health] Migrated flat {} → {:?} but failed to remove source: {}",
                    label,
                    dst,
                    e
                );
            } else {
                ulog_info!("[im-health] Migrated flat {} → {:?}", label, dst);
            }
        }
        Err(e) => ulog_warn!("[im-health] Failed to migrate flat {}: {}", label, e),
    }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/// Delete all persisted files for a bot (called when bot config is removed).
pub fn cleanup_bot_data(bot_id: &str) {
    // Remove v3 subdir
    let dir = bot_data_dir(bot_id);
    if dir.exists() {
        match std::fs::remove_dir_all(&dir) {
            Ok(_) => ulog_info!("[im-health] Cleaned bot data dir: {}", bot_id),
            Err(e) => ulog_warn!("[im-health] Failed to remove bot dir {:?}: {}", dir, e),
        }
    }

    // Clean up any residual v2 flat files
    for path in [
        flat_health_path(bot_id),
        flat_buffer_path(bot_id),
        flat_dedup_path(bot_id),
    ] {
        let _ = std::fs::remove_file(&path);
    }
}

/// Remove v1 legacy `.migrated` marker files.
fn cleanup_legacy_markers() {
    let dir = myagents_dir();
    for name in ["im_state.json.migrated", "im_buffer.json.migrated"] {
        let path = dir.join(name);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
            ulog_info!("[im-health] Cleaned legacy marker: {}", name);
        }
    }
}

/// Scan ~/.myagents/ for orphaned v2 flat files (bot IDs not in config.json).
fn cleanup_orphaned_flat_files() {
    let dir = myagents_dir();
    let active_ids = read_active_bot_ids(&dir);
    // If we can't read config, don't delete anything (safety)
    if active_ids.is_none() {
        return;
    }
    let active_ids = active_ids.unwrap();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("im_")
            && (name.ends_with("_state.json")
                || name.ends_with("_buffer.json")
                || name.ends_with("_dedup.json"))
        {
            if let Some(bot_id) = extract_bot_id_from_flat_filename(&name) {
                // Skip active bots (their files will be migrated on next start)
                if active_ids.contains(&bot_id) {
                    continue;
                }
                let _ = std::fs::remove_file(entry.path());
                ulog_info!("[im-health] Cleaned orphaned flat file: {}", name);
            }
        }
    }
}

/// Read active bot IDs from config.json. Returns None on any read/parse error.
/// Includes both legacy imBotConfigs IDs and agent channel IDs to prevent orphan cleanup
/// from accidentally deleting data for either path.
fn read_active_bot_ids(myagents: &Path) -> Option<HashSet<String>> {
    let config_path = myagents.join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    // Tolerate UTF-8 BOM (issue #170 #6) — without this a hand-edited
    // config.json silently drops all bot IDs, then orphan-cleanup deletes
    // their data. See utils/bom.rs.
    let config: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;

    let mut ids = HashSet::new();

    // Legacy imBotConfigs
    if let Some(bots) = config.get("imBotConfigs").and_then(|v| v.as_array()) {
        for b in bots {
            if let Some(id) = b.get("id").and_then(|v| v.as_str()) {
                ids.insert(id.to_string());
            }
        }
    }

    // Agent channel IDs (v0.1.41)
    if let Some(agents) = config.get("agents").and_then(|v| v.as_array()) {
        for agent in agents {
            if let Some(channels) = agent.get("channels").and_then(|v| v.as_array()) {
                for ch in channels {
                    if let Some(id) = ch.get("id").and_then(|v| v.as_str()) {
                        ids.insert(id.to_string());
                    }
                }
            }
        }
    }

    Some(ids)
}

/// Extract bot_id from flat filename like "im_{botId}_state.json".
fn extract_bot_id_from_flat_filename(name: &str) -> Option<String> {
    let name = name.strip_prefix("im_")?;
    // Find the suffix (_state.json, _buffer.json, _dedup.json)
    for suffix in ["_state.json", "_buffer.json", "_dedup.json"] {
        if let Some(bot_id) = name.strip_suffix(suffix) {
            if !bot_id.is_empty() {
                return Some(bot_id.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::router::SessionRouter;
    use super::super::types::{ImSourceType, PeerSession};
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::sync::Mutex;

    fn peer(session_key: &str, session_id: &str) -> PeerSession {
        PeerSession {
            session_key: session_key.to_string(),
            session_id: session_id.to_string(),
            sidecar_port: 0,
            workspace_path: PathBuf::from("/tmp/workspace"),
            source_type: ImSourceType::Private,
            source_id: session_key.to_string(),
            source_display_name: None,
            last_sender_name: None,
            message_count: 0,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: Instant::now(),
        }
    }

    #[tokio::test]
    async fn router_active_session_projection_reads_current_router_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let health = Arc::new(HealthManager::new(path.clone()));
        let router = Arc::new(Mutex::new(SessionRouter::new(PathBuf::from(
            "/tmp/workspace",
        ))));

        {
            let mut router_guard = router.lock().await;
            router_guard.upsert_peer_session(peer("agent:a:weixin:private:a", "session-a"));
            let stale_snapshot = router_guard.active_sessions();
            assert_eq!(stale_snapshot.len(), 1);
            router_guard.upsert_peer_session(peer("agent:a:weixin:private:b", "session-b"));
        }

        persist_router_active_sessions(&health, &router, "test-current-router-state")
            .await
            .expect("persist active sessions");

        let state = health.get_state().await;
        let mut ids = state
            .active_sessions
            .iter()
            .map(|session| session.session_id.as_str())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        assert_eq!(ids, vec!["session-a", "session-b"]);

        let disk_state: ImHealthState =
            serde_json::from_str(&std::fs::read_to_string(path).expect("state file"))
                .expect("state json");
        assert_eq!(disk_state.active_sessions.len(), 2);
    }

    #[tokio::test]
    async fn failed_projection_write_does_not_publish_the_staged_binding_in_memory() {
        let dir = tempfile::tempdir().expect("tempdir");
        // An existing directory cannot be replaced by the atomic file rename,
        // giving this test a deterministic write failure on every platform.
        let health = HealthManager::new(dir.path().to_path_buf());
        health
            .set_active_sessions(vec![ImActiveSession {
                session_key: "agent:a:feishu:private:user".to_string(),
                session_id: "session-a".to_string(),
                source_type: ImSourceType::Private,
                source_id: Some("user".to_string()),
                source_display_name: None,
                last_sender_name: None,
                workspace_path: "/tmp/workspace".to_string(),
                message_count: 1,
                metadata_birth_pending: false,
                metadata_indexed: true,
                last_active: chrono::Utc::now().to_rfc3339(),
            }])
            .await;
        let mut staged = health.get_state().await.active_sessions;
        staged[0].session_id = "session-b".to_string();

        assert!(health
            .persist_active_sessions_snapshot(staged)
            .await
            .is_err());
        assert_eq!(
            health.get_state().await.active_sessions[0].session_id,
            "session-a"
        );
    }

    #[tokio::test]
    async fn pending_new_binding_round_trips_through_the_existing_health_schema() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let health = HealthManager::new(path.clone());
        let session_key = "agent:a:feishu:private:user";
        let mut router = SessionRouter::new(PathBuf::from("/tmp/workspace"));
        router.upsert_peer_session(peer(session_key, "session-a"));

        let transition = router.stage_new_session_binding(session_key);
        health
            .persist_active_sessions_snapshot(router.active_sessions())
            .await
            .expect("persist pending binding");

        let restored = HealthManager::new(path).get_state().await;
        let pending = restored.active_sessions.first().expect("pending binding");
        assert_eq!(pending.session_id, transition.target_session_id());
        assert_eq!(pending.message_count, 0);
        assert!(pending.metadata_birth_pending);
        assert!(!pending.metadata_indexed);
    }

    #[test]
    fn persisted_active_session_ids_preserve_stopped_channel_bindings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state.json");
        let mut state = ImHealthState::default();
        state.active_sessions = vec![super::super::types::ImActiveSession {
            session_key: "agent:a:weixin:private:u1".to_string(),
            session_id: "persisted-session".to_string(),
            source_type: ImSourceType::Private,
            source_id: Some("u1".to_string()),
            source_display_name: None,
            last_sender_name: None,
            workspace_path: "/tmp/workspace".to_string(),
            message_count: 1,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: chrono::Utc::now().to_rfc3339(),
        }];
        std::fs::write(&path, serde_json::to_vec(&state).expect("serialize state"))
            .expect("write state");

        assert_eq!(
            persisted_active_session_ids(&path),
            vec!["persisted-session".to_string()]
        );
    }
}
