use super::manager::SessionOwnerRelease;
use super::runtime_identity::{admit_runtime_identity, distribution_default_runtime_identity};
use super::*;

pub(crate) type SessionLifecycleGuard = crate::keyed_lifecycle::KeyedLifecycleGuard;

static SESSION_LIFECYCLE_LOCKS: std::sync::OnceLock<
    crate::keyed_lifecycle::KeyedLifecycleRegistry,
> = std::sync::OnceLock::new();

pub(crate) async fn acquire_session_lifecycle(session_ids: &[&str]) -> SessionLifecycleGuard {
    SESSION_LIFECYCLE_LOCKS
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .acquire(session_ids)
        .await
}

/// Reusing a source is optional for desktop New. Never queue that optimization
/// behind recovery or another source mutation; independent birth needs neither.
pub(crate) async fn try_acquire_session_lifecycle(
    session_ids: &[&str],
) -> Option<SessionLifecycleGuard> {
    SESSION_LIFECYCLE_LOCKS
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .try_acquire_many(session_ids)
        .await
}

/// Close one active generation under the manager lock, wait without that
/// lock, then move the exact process into manager-owned recovery state.
fn replace_session_sidecar_after_drain<'a>(
    manager: &'a ManagedSidecarManager,
    mut manager_guard: std::sync::MutexGuard<'a, SidecarManager>,
    session_id: &str,
) -> Result<std::sync::MutexGuard<'a, SidecarManager>, String> {
    let drain = manager_guard.prepare_session_sidecar_replacement(session_id);
    drop(manager_guard);
    if let Some(drain) = drain {
        drain.wait();
        manager_guard = manager.lock().map_err(|error| error.to_string())?;
        manager_guard.finish_session_sidecar_replacement(&drain);
        Ok(manager_guard)
    } else {
        manager.lock().map_err(|error| error.to_string())
    }
}

/// A concurrent last-owner release may leave a closed, ownerless entry visible
/// while its admitted request finishes. Ensure callers can help complete that
/// exact retirement before retrying, without inventing a second state owner.
fn finish_unowned_session_after_drain(
    manager: &ManagedSidecarManager,
    session_id: &str,
    drain: DispatchDrain,
) -> Result<(), String> {
    drain.wait();
    let retirement = {
        let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
        manager_guard.prepare_unowned_session_retirement(session_id)
    };
    if let Some(retirement) = retirement {
        retirement.wait();
        let retired = {
            let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
            manager_guard.finish_unowned_session_retirement(&retirement)
        };
        drop(retired);
    }
    Ok(())
}

pub(crate) async fn has_persisted_session_owner(session_id: &str) -> Result<bool, String> {
    Ok(crate::session_goal::get_session_goal_manager()
        .has_session_identity_protection(session_id)
        .await
        .map_err(|error| error.to_string())?
        || crate::task_scheduler::has_persistent_task_for_session(session_id).await)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDesktopSessionResult {
    new_session_id: Option<String>,
    create_new_sidecar: bool,
}

impl NewDesktopSessionResult {
    pub(crate) fn migrated(session_id: String) -> Self {
        Self {
            new_session_id: Some(session_id),
            create_new_sidecar: false,
        }
    }
}

/// Protecting a source from reset does not prevent this Tab from starting a
/// separate conversation. The source's owners and Channel binding stay put.
pub(crate) fn desktop_session_reset_port(
    manager: &ManagedSidecarManager,
    source: &str,
    tab_id: &str,
    channel_key: Option<&str>,
    retained_identity: bool,
) -> Result<Option<u16>, String> {
    let mut state = manager.lock().map_err(|error| error.to_string())?;
    if !state.session_has_exact_owner(source, &SidecarOwner::Tab(tab_id.to_string())) {
        return Err("The Tab no longer owns this Session".to_string());
    }
    let migratable = match channel_key {
        Some(key) => state.surface_session_migration_is_admissible(source, tab_id, key),
        None => state.desktop_session_migration_is_admissible(source, tab_id),
    };
    Ok(if retained_identity || !migratable {
        None
    } else {
        state.get_session_port(source)
    })
}

pub(crate) async fn preserve_desktop_session<R: Runtime>(
    app: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    source: &str,
    tab_id: &str,
) -> Result<NewDesktopSessionResult, String> {
    if !manager
        .lock()
        .map_err(|error| error.to_string())?
        .session_has_exact_owner(source, &SidecarOwner::Tab(tab_id.to_string()))
    {
        return Err("The Tab no longer owns this Session".to_string());
    }
    let app = app.clone();
    let manager = manager.clone();
    let source = source.to_string();
    // Reuse the existing handoff owner even when the source is recovering or
    // its activity cannot currently be sampled. The existing poller settles it.
    tauri::async_runtime::spawn_blocking(move || {
        super::background::start_headless_background_completion(&app, &manager, &source)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(NewDesktopSessionResult {
        new_session_id: None,
        create_new_sidecar: true,
    })
}

/// New conversation authority is shared by every desktop entry, independently
/// of the renderer's Channel status projection. Router -> lifecycle lock order
/// is the same as IM enqueue/handover; the unbound path checks disk while fenced.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_new_desktop_session<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, ManagedSidecarManager>,
    oldSessionId: String,
    tabId: String,
) -> Result<NewDesktopSessionResult, String> {
    if let Some(result) =
        crate::im::handover::new_channel_desktop_session(&app, state.inner(), &oldSessionId, &tabId)
            .await?
    {
        return Ok(result);
    }
    let target = uuid::Uuid::new_v4().to_string();
    let Some(_lifecycle) = try_acquire_session_lifecycle(&[&oldSessionId, &target]).await else {
        return preserve_desktop_session(&app, state.inner(), &oldSessionId, &tabId).await;
    };
    // A dormant binding is still authoritative. A concurrently attached live
    // Channel first acquires its Agent owner under this same lifecycle fence.
    let retained_identity =
        crate::im::session_delivery::configured_session_binding_exists(&oldSessionId)
            || has_persisted_session_owner(&oldSessionId).await?;
    let Some(port) = desktop_session_reset_port(
        state.inner(),
        &oldSessionId,
        &tabId,
        None,
        retained_identity,
    )?
    else {
        return preserve_desktop_session(&app, state.inner(), &oldSessionId, &tabId).await;
    };
    // Admit the existing background owner here, once, under the source fence.
    // App consumes this decision and never re-samples activity after it returns.
    let background_app = app.clone();
    let background_manager = state.inner().clone();
    let background_source = oldSessionId.clone();
    let background = tauri::async_runtime::spawn_blocking(move || {
        super::background::start_background_completion(
            &background_app,
            &background_manager,
            &background_source,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    if !matches!(background, Ok(ref result) if !result.started) {
        return preserve_desktop_session(&app, state.inner(), &oldSessionId, &tabId).await;
    }
    let Some(dispatch) = transition_desktop_runtime(
        state.inner(),
        &oldSessionId,
        &target,
        port,
        false,
        false,
        true,
    )
    .await?
    else {
        return preserve_desktop_session(&app, state.inner(), &oldSessionId, &tabId).await;
    };
    if !commit_desktop_runtime_transition(
        state.inner(),
        &oldSessionId,
        &target,
        &tabId,
        None,
        dispatch,
    )
    .await?
    {
        return Err("Session owners changed before new conversation committed".to_string());
    }
    Ok(NewDesktopSessionResult::migrated(target))
}

enum DesktopTransitionFailure {
    Busy,
    Rejected(String),
    Uncertain(String),
}

async fn request_desktop_runtime_transition(
    client: &reqwest::Client,
    port: u16,
    payload: &serde_json::Value,
) -> Result<(), DesktopTransitionFailure> {
    let response = client
        .post(format!(
            "http://127.0.0.1:{port}/api/session/new-conversation"
        ))
        .json(payload)
        .send()
        .await;
    let failure = match response {
        Ok(response) if response.status().is_success() => {
            let result: serde_json::Value = response
                .json()
                .await
                .map_err(|error| DesktopTransitionFailure::Uncertain(error.to_string()))?;
            if result.get("sessionId") == payload.get("targetSessionId") {
                return Ok(());
            }
            "Runtime returned an unexpected Session identity".to_string()
        }
        Ok(response) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            // Only the adapter can confirm that it refused before entering
            // reset. Preserve the admitted operation which won its mutation
            // lease; HTTP timeout or a post-reset failure carries no such proof.
            if status == reqwest::StatusCode::CONFLICT {
                if let Ok(result) = serde_json::from_str::<serde_json::Value>(&body) {
                    if result.get("sourceUnchanged") == Some(&serde_json::Value::Bool(true)) {
                        if result.get("errorCode").and_then(serde_json::Value::as_str)
                            == Some("session_busy")
                        {
                            return Err(DesktopTransitionFailure::Busy);
                        }
                        return Err(DesktopTransitionFailure::Rejected(
                            result
                                .get("error")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("Session transition was not started")
                                .to_string(),
                        ));
                    }
                }
            }
            format!("Session transition returned {status}: {body}")
        }
        Err(error) => format!("Session transition response unavailable: {error}"),
    };
    // Only the completed response proves the whole adapter mutation, including
    // durable metadata publication. Reading the target ID alone cannot prove
    // that publication finished or that a still-queued operation has stopped.
    Err(DesktopTransitionFailure::Uncertain(failure))
}

/// Caller holds the source lifecycle guard. Manager identity stays on source
/// until commit, so the existing replacement owner can retire an uncertain
/// writer without rekeying a recovering generation or losing its owners.
pub(crate) async fn transition_desktop_runtime(
    manager: &ManagedSidecarManager,
    source: &str,
    target: &str,
    port: u16,
    channel_bound: bool,
    metadata_birth_pending: bool,
    metadata_indexed: bool,
) -> Result<Option<super::manager::SidecarHttpDispatch>, String> {
    let client = crate::local_http::json_client(Duration::from_secs(30));
    transition_desktop_runtime_with_client(
        manager,
        source,
        target,
        port,
        channel_bound,
        metadata_birth_pending,
        metadata_indexed,
        &client,
    )
    .await
}

async fn transition_desktop_runtime_with_client(
    manager: &ManagedSidecarManager,
    source: &str,
    target: &str,
    port: u16,
    channel_bound: bool,
    metadata_birth_pending: bool,
    metadata_indexed: bool,
    client: &reqwest::Client,
) -> Result<Option<super::manager::SidecarHttpDispatch>, String> {
    // Keep this exact writer manager-owned even if its final Tab closes while
    // Node is processing the request. A timeout does not release this lease.
    let Some(dispatch) = manager
        .lock()
        .map_err(|error| error.to_string())?
        .acquire_session_dispatch(source)?
    else {
        // No mutation was sent. Source recovery must not block a separate birth.
        return Ok(None);
    };
    if dispatch.url_for_path("/")? != format!("http://127.0.0.1:{port}/") {
        return Err("Source Sidecar generation changed".to_string());
    }
    // pending-* names the Rust bootstrap slot, not a Product Session. Resolve
    // its Runtime identity from this pinned process before entering the adapter
    // mutation boundary; ordinary canonical sources must still match exactly.
    let runtime_source = if source.starts_with("pending-") {
        let probe = async {
            let result: serde_json::Value = client
                .get(dispatch.url_for_path("/api/session-state")?)
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?
                .json()
                .await
                .map_err(|error| error.to_string())?;
            result
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .map(str::to_string)
                .ok_or_else(|| "Bootstrap Runtime identity is unavailable".to_string())
        }
        .await;
        match probe {
            Ok(identity) => identity,
            Err(error) => {
                ulog_warn!(
                    "[sidecar] New conversation retains bootstrap source {}: {}",
                    source,
                    error
                );
                return Ok(None);
            }
        }
    } else {
        source.to_string()
    };
    let payload = serde_json::json!({
        "sourceSessionId": runtime_source, "targetSessionId": target, "channelBound": channel_bound,
        "metadataBirthPending": metadata_birth_pending, "metadataIndexed": metadata_indexed,
    });
    if let Err(failure) = request_desktop_runtime_transition(client, port, &payload).await {
        return match failure {
            DesktopTransitionFailure::Busy => Ok(None),
            DesktopTransitionFailure::Rejected(error) => Err(error),
            DesktopTransitionFailure::Uncertain(error) => {
                retire_failed_desktop_transition(manager, source, dispatch).await?;
                Err(error)
            }
        };
    }
    Ok(Some(dispatch))
}

/// Commit only the owners admitted for this transition. A concurrent release
/// may invalidate the final owner set; settle its writer before returning that
/// refusal to the Router or renderer. `Ok(false)` proves the writer retired;
/// `Err` means retirement is unconfirmed and must never authorize rollback.
pub(crate) async fn commit_desktop_runtime_transition(
    manager: &ManagedSidecarManager,
    source: &str,
    target: &str,
    tab_id: &str,
    channel_key: Option<&str>,
    dispatch: super::manager::SidecarHttpDispatch,
) -> Result<bool, String> {
    let rekeyed = {
        let mut state = manager.lock().map_err(|error| error.to_string())?;
        match channel_key {
            Some(key) => {
                state.upgrade_session_id_for_surface_migration(source, target, tab_id, key)
            }
            None => state.upgrade_session_id_for_tab(source, target, tab_id),
        }
    };
    if !rekeyed {
        retire_failed_desktop_transition(manager, source, dispatch).await?;
        return Ok(false);
    }
    Ok(true)
}

pub(crate) async fn retire_failed_desktop_transition(
    manager: &ManagedSidecarManager,
    source: &str,
    dispatch: super::manager::SidecarHttpDispatch,
) -> Result<(), String> {
    let manager = manager.clone();
    let source = source.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        // Close admission and stop the exact writer while our dispatch lease
        // still pins it. Otherwise last-owner release could remove the entry
        // before process termination, making absence look like cancellation.
        {
            let mut state = manager.lock().map_err(|error| error.to_string())?;
            if state.current_generation(&source) != dispatch.generation() {
                return Err("Session writer generation changed during transition".to_string());
            }
            let _closed = state.prepare_session_sidecar_replacement(&source);
            let writer = state
                .sidecars
                .get_mut(&source)
                .ok_or_else(|| "Session writer disappeared during transition".to_string())?;
            writer
                .process
                .kill()
                .map_err(|error| format!("Cannot retire Session transition writer: {error}"))?;
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let exited = manager
                .lock()
                .map_err(|error| error.to_string())?
                .sidecars
                .get_mut(&source)
                .ok_or_else(|| "Session writer disappeared before confirmed exit".to_string())?
                .process
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_some();
            if exited {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err("Session transition writer exit is unconfirmed".to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        drop(dispatch);
        retire_session_writer(&manager, &source)
    })
    .await
    .map_err(|error| format!("Session transition retirement failed: {error}"))?
}

/// Product metadata may still be queued in SessionStore while a Session is
/// already owned and executing. Disk absence only invalidates an unowned
/// identity. Callers that mutate a binding hold its Session lifecycle fence.
pub(crate) fn session_exists_for_continuation(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> bool {
    manager
        .lock()
        .is_ok_and(|state| state.session_has_owners(session_id))
        || resolve_session_runtime_identity_full(session_id).is_some()
}

async fn has_non_tab_session_owner(
    session_id: &str,
    agents: &crate::im::ManagedAgents,
    im_bots: &crate::im::ManagedImBots,
) -> Result<bool, String> {
    if has_persisted_session_owner(session_id).await? {
        return Ok(true);
    }
    Ok(crate::im::session_delivery::has_session_binding(agents, im_bots, session_id).await)
}

// ============= Session-Centric Sidecar API (v0.1.11) =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
    /// Internal process identity used to commit replacement work. This is not
    /// part of the renderer/Tauri wire contract.
    #[serde(skip)]
    pub(crate) generation: u64,
}

/// Upper bound on ensure re-entry. The ensure path re-runs itself on
/// generation-change and concurrent-create (it must re-wait for `/health/ready`
/// rather than return a replacement port directly). This caps that re-entry so
/// a thrashing health monitor that keeps bumping the generation can't recurse
/// without a depth bound. Each attempt costs ≥2s (HTTP/readiness window), so 8
/// is generous — real churn settles in 1–2 (cross-review: all three reviewers
/// flagged the prior unbounded self-recursion).
const MAX_ENSURE_ATTEMPTS: u32 = 8;
const RECOVERY_ATTEMPT_STALE: &str = "RECOVERY_ATTEMPT_STALE";

/// Blocking ensure kernel. Callers must normally use the lifecycle-fenced
/// async wrapper below. The health monitor is the sole direct caller because
/// it already holds the lifecycle guard while preserving the dead owner object
/// across restart failure.
pub(crate) fn ensure_session_sidecar_with_runtime_identity_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    let _lifecycle_spawn_permit = begin_lifecycle_spawn_permit()?;
    let attempt_result = ensure_session_sidecar_attempt(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        runtime_source_override,
        0,
        expected_recovery_epoch,
    );
    let mut result = match attempt_result {
        Ok(result) => result,
        Err(error) => {
            if let Ok(mut manager_guard) = manager.lock() {
                if error != RECOVERY_ATTEMPT_STALE {
                    if let Some(failure) = manager_guard.record_session_recovery_failure(
                        session_id,
                        expected_recovery_epoch,
                        std::time::Instant::now(),
                    ) {
                        ulog_error!(
                            "[sidecar-recovery] action=retry-scheduled session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={} error={}",
                            session_id,
                            failure.epoch,
                            failure.dead_generation,
                            failure.candidate_generation,
                            failure.failed_attempts,
                            failure.retry_after.as_millis(),
                            error
                        );
                    }
                }
            }
            return Err(error);
        }
    };
    let should_commit = result.is_new
        || manager
            .lock()
            .map_err(|error| error.to_string())?
            .has_session_recovery(session_id);
    if should_commit {
        let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
        let Some(commit) = manager_guard.commit_ready_session_sidecar(session_id) else {
            let error = format!(
                "Session {} replacement on port {} lost lifecycle authority before commit",
                session_id, result.port
            );
            if let Some(failure) = manager_guard.record_session_recovery_failure(
                session_id,
                expected_recovery_epoch,
                std::time::Instant::now(),
            ) {
                ulog_error!(
                    "[sidecar-recovery] action=commit-rejected session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={} error={}",
                    session_id,
                    failure.epoch,
                    failure.dead_generation,
                    failure.candidate_generation,
                    failure.failed_attempts,
                    failure.retry_after.as_millis(),
                    error
                );
            }
            return Err(error);
        };
        if commit.generation != result.generation || commit.port != result.port {
            result.port = commit.port;
            result.generation = commit.generation;
            result.is_new = false;
        }
    }
    Ok(result)
}

/// Async pit-of-success entrypoint for every owner-acquiring ensure.
///
/// The per-session lifecycle guard is held across the entire blocking ensure,
/// including readiness waits. Session deletion takes the same guard, so it
/// cannot validate an ownerless identity and then have this path recreate that
/// fixed identity immediately after deletion.
pub(crate) async fn ensure_session_sidecar_with_lifecycle<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_with_runtime_identity_override_lifecycle(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        None,
        None,
    )
    .await
}

pub(crate) async fn ensure_session_sidecar_with_runtime_identity_override_lifecycle<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    let lifecycle = Arc::new(acquire_session_lifecycle(&[&session_id]).await);
    ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
        lifecycle,
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        runtime_source_override,
    )
    .await
}

/// Blocking-thread ensure for a caller that already owns this Session's
/// lifecycle authority. The shared lease keeps that exact acquisition alive
/// through readiness without attempting to re-enter the non-reentrant lock.
///
/// Task reservation is the non-generic caller: the exact execution retains a
/// shared handle until SessionStore metadata is born, while the worker moves
/// its handle through Sidecar ensure. Other callers use the wrapper above.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ensure_session_sidecar_with_runtime_identity_override_lifecycle_held<
    R: Runtime,
>(
    lifecycle: Arc<SessionLifecycleGuard>,
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    // Keep the caller's authority alive until the blocking ensure and its
    // readiness wait finish. This is intentionally not a fresh acquisition.
    let _lifecycle = lifecycle;
    let ensure_app_handle = app_handle.clone();
    let event_session_id = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        ensure_session_sidecar_with_runtime_identity_override(
            &ensure_app_handle,
            &manager,
            &session_id,
            &workspace_path,
            owner,
            runtime_override,
            runtime_source_override,
            None,
        )
    })
    .await
    .map_err(|error| format!("ensure_session_sidecar blocking task failed: {error:?}"))??;

    // Every newly-created process starts a fresh liveRevision epoch. Emit from
    // the shared async ensure authority (not just the renderer command) so a
    // Task/IM/Goal revive cannot leave an attached Tab comparing revisions
    // from the previous process. First-ever creates are harmless: renderer
    // consumers filter by their currently attached Session, and pending births
    // already ignore this event.
    if result.is_new {
        let _ = app_handle.emit(
            "session-sidecar:restarted",
            serde_json::json!({
                "sessionId": event_session_id,
                "port": result.port,
            }),
        );
    }
    Ok(result)
}

fn resolve_runtime_identity_for_owner(
    _owner: &SidecarOwner,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
    session_runtime_identity: Option<RuntimeIdentity>,
    agent_runtime_identity: Option<RuntimeIdentity>,
) -> RuntimeIdentity {
    if let Some(identity) = session_runtime_identity {
        if let Some(runtime) = runtime_override {
            let requested = RuntimeIdentity::new(Some(runtime), runtime_source_override);
            if identity.runtime != requested.runtime
                || identity.runtime_source != requested.runtime_source
            {
                return RuntimeIdentity::incompatible(
                    "Runtime override conflicts with persisted Session identity",
                );
            }
        }
        return identity;
    }
    if let Some(runtime) = runtime_override {
        return admit_runtime_identity(RuntimeIdentity::new(
            Some(runtime),
            runtime_source_override,
        ));
    }
    agent_runtime_identity.unwrap_or_else(distribution_default_runtime_identity)
}

fn resolve_expected_runtime_identity(
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: &SidecarOwner,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
) -> RuntimeIdentity {
    // Every existing Product Session owns its execution identity, including IM.
    let session_runtime_identity = resolve_session_runtime_identity_full(session_id);
    let agent_runtime_identity = resolve_agent_runtime_identity_from_config(workspace_path);
    resolve_runtime_identity_for_owner(
        owner,
        runtime_override,
        runtime_source_override,
        session_runtime_identity,
        agent_runtime_identity,
    )
}

fn retained_session_runtime_identity(
    manager: &SidecarManager,
    session_id: &str,
) -> Option<RuntimeIdentity> {
    if let Some(sidecar) = manager.sidecars.get(session_id) {
        return Some(RuntimeIdentity::new(
            sidecar.runtime.as_deref(),
            sidecar.runtime_source.as_deref(),
        ));
    }
    manager.recovering_sidecars.get(session_id).map(|sidecar| {
        RuntimeIdentity::new(
            sidecar.runtime.as_deref(),
            sidecar.runtime_source.as_deref(),
        )
    })
}

fn ensure_session_sidecar_attempt<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    runtime_source_override: Option<String>,
    attempt: u32,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    if attempt >= MAX_ENSURE_ATTEMPTS {
        return Err(format!(
            "Session {} ensure exceeded {} attempts (sidecar generation churn not settling)",
            session_id, MAX_ENSURE_ATTEMPTS
        ));
    }
    if attempt == 0 {
        // Session Sidecars use this lifecycle path rather than the tab/global
        // instance path. Apply the same CLI admission contract before any
        // existing Session is reused or a new process is born.
        crate::cli::ensure_launcher()?;
    }
    ulog_info!(
        "[sidecar] ensure_session_sidecar called for session: {}, owner: {:?} (attempt {})",
        session_id,
        owner,
        attempt
    );
    let ensure_started = trace_start();
    let owner_for_trace = format!("{:?}", owner);
    let mut expected_runtime_identity = resolve_expected_runtime_identity(
        session_id,
        workspace_path,
        &owner,
        runtime_override.as_deref(),
        runtime_source_override.as_deref(),
    );
    if let Some(error) = &expected_runtime_identity.compatibility_error {
        return Err(format!("RUNTIME_BINDING_INCOMPATIBLE: {error}"));
    }
    let requested_runtime_for_trace = expected_runtime_identity.runtime.clone();
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_start")
            .session_id(Some(session_id))
            .runtime(Some(&requested_runtime_for_trace))
            .detail("owner", &owner_for_trace),
    );

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    // Block briefly if startup cleanup is still running — same barrier as
    // `start_tab_sidecar`. Without this, Cron task recovery / session-monitor
    // auto-restart / IM message arrival during the startup window would spawn
    // a new session sidecar that races with the stale-process sweep (the very
    // case db58545 set out to prevent). In the common case this returns
    // immediately (AtomicBool load; cleanup completes in ~50 ms).
    wait_for_startup_cleanup(Duration::from_secs(15))?;

    ulog_debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        ulog_error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    ulog_debug!("[sidecar] Manager lock acquired");
    // A V2 birth may already be bound and running while its product metadata
    // is still awaiting publication. The active generation retains its runtime
    // identity; an Agent template is not authority to replace that process.
    if runtime_override.is_none() && resolve_session_runtime_identity_full(session_id).is_none() {
        if let Some(identity) = retained_session_runtime_identity(&manager_guard, session_id) {
            expected_runtime_identity = identity;
        }
    }
    if expected_recovery_epoch.is_some_and(|epoch| {
        !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
    }) {
        return Err(RECOVERY_ATTEMPT_STALE.to_string());
    }

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    // Note: there used to be an inline drift check for Agent-owner Sidecars
    // here, but it's been removed as of v0.1.66. Drift is now handled at the
    // IM router layer (`SessionRouter::check_and_reset_on_runtime_drift`)
    // which runs BEFORE `ensure_session_sidecar` and regenerates the peer
    // session_id on drift. By the time we reach here:
    //
    //   - IM message path (router-driven): the router already forked to a
    //     fresh session_id, so `session_id` has no existing Sidecar and the
    //     spawn path below uses the owner-aware priority chain to pick the
    //     correct runtime from agent config.
    //
    //   - memory auto-update callers: they target an existing session_id
    //     that may be shared with a desktop Tab. Killing the Sidecar here
    //     would orphan the Tab's SSE stream. Better to let memory_auto_update
    //     reuse the existing (possibly stale-runtime) Sidecar — memory file
    //     updates are runtime-agnostic so a mismatched runtime doesn't
    //     actually break anything.
    //
    // The priority chain at the spawn path below still enforces "Agent owner
    // uses agent config, not session metadata" so fresh spawns for Agent
    // owners always honor the user's latest runtime choice, including the
    // external → builtin switch direction.

    let mut replace_existing = false;
    let mut clear_generation_after_replace = false;
    let existing_sidecar_info: Option<ExistingSidecarReuse> = {
        let generation = manager_guard.current_generation(session_id);
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_dead() {
                // Process exited, clean up
                ulog_info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                replace_existing = true;
                None
            } else if sidecar.is_reusable() {
                if validate_sidecar_runtime_invariant(
                    session_id,
                    &expected_runtime_identity,
                    sidecar.runtime.as_deref(),
                    sidecar.runtime_source.as_deref(),
                    "reuse-healthy-precheck",
                )
                .is_err()
                {
                    replace_existing = true;
                    clear_generation_after_replace = true;
                    None
                } else {
                    // Healthy — needs HTTP verification outside the lock
                    Some(ExistingSidecarReuse::Healthy {
                        port: sidecar.port,
                        generation,
                        runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                        runtime_source: sidecar.runtime_source.clone(),
                    })
                }
            } else if sidecar.is_starting() {
                // Starting — another thread is doing wait_for_health/readiness.
                // Add the owner now, then wait for /health/ready outside the lock.
                ulog_info!(
                    "[sidecar] Session {} Sidecar still starting on port {}, adding owner {:?}",
                    session_id,
                    sidecar.port,
                    owner
                );
                if validate_sidecar_runtime_invariant(
                    session_id,
                    &expected_runtime_identity,
                    sidecar.runtime.as_deref(),
                    sidecar.runtime_source.as_deref(),
                    "reuse-starting",
                )
                .is_err()
                {
                    replace_existing = true;
                    clear_generation_after_replace = true;
                    None
                } else {
                    let owner_added = sidecar.add_owner(owner.clone());
                    Some(ExistingSidecarReuse::Starting {
                        port: sidecar.port,
                        generation,
                        runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                        runtime_source: sidecar.runtime_source.clone(),
                        owner_added,
                    })
                }
            } else {
                Some(ExistingSidecarReuse::Draining(DispatchGate::close(
                    &sidecar.dispatch_gate,
                )))
            }
        } else {
            None
        }
    };
    if replace_existing {
        manager_guard = replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
        if clear_generation_after_replace {
            manager_guard.clear_generation(session_id);
        }
    }

    // If we found a running sidecar, verify HTTP health (with lock released).
    // CRITICAL: The lock is dropped during the 2s HTTP check. Another thread (health monitor)
    // can replace the sidecar during this window. We use a generation counter to detect this
    // and avoid accidentally killing the healthy replacement.
    if let Some(existing) = existing_sidecar_info {
        let (
            port,
            pre_gen,
            runtime_for_trace,
            runtime_source_for_trace,
            wait_for_starting,
            joined_owner_added,
        ) = match existing {
            ExistingSidecarReuse::Healthy {
                port,
                generation,
                runtime,
                runtime_source,
            } => (port, generation, runtime, runtime_source, false, false),
            ExistingSidecarReuse::Starting {
                port,
                generation,
                runtime,
                runtime_source,
                owner_added,
            } => (port, generation, runtime, runtime_source, true, owner_added),
            ExistingSidecarReuse::Draining(drain) => {
                drop(manager_guard);
                finish_unowned_session_after_drain(manager, session_id, drain)?;
                return ensure_session_sidecar_attempt(
                    app_handle,
                    manager,
                    session_id,
                    workspace_path,
                    owner,
                    runtime_override,
                    runtime_source_override,
                    attempt + 1,
                    expected_recovery_epoch,
                );
            }
        };
        let runtime_source_label =
            normalize_runtime_source_name(&runtime_for_trace, runtime_source_for_trace.as_deref())
                .to_string();
        drop(manager_guard);

        let check_started = trace_start();
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_start")
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_label)
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );
        let http_healthy = if wait_for_starting {
            wait_for_readiness(port, 30).is_ok()
        } else {
            // Verify HTTP server is actually responsive (not just process alive)
            check_sidecar_http_health(port)
        };
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_end")
                .duration_ms(elapsed_ms(check_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_label)
                .status(if http_healthy { "ok" } else { "error" })
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if expected_recovery_epoch.is_some_and(|epoch| {
            !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
        }) {
            return Err(RECOVERY_ATTEMPT_STALE.to_string());
        }
        let post_gen = manager_guard.current_generation(session_id);

        if post_gen != pre_gen {
            // Generation changed: another thread replaced the sidecar during our HTTP check.
            // Re-enter the normal ensure path for the replacement instead of returning its
            // port directly. The replacement may still be Starting; the normal path knows
            // how to wait for /health/ready and also re-verifies Healthy sidecars over HTTP.
            ulog_info!(
                "[sidecar] Session {} generation changed ({} → {}) during HTTP check on port {}, checking replacement",
                session_id, pre_gen, post_gen, port
            );
            let mut remove_replacement_for_runtime_drift = false;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if !sidecar.is_dead() {
                    ulog_info!(
                        "[sidecar] Session {} replacement on port {} is {:?}, retrying ensure",
                        session_id,
                        sidecar.port,
                        sidecar.state
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        &expected_runtime_identity,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-replacement",
                    )
                    .is_err()
                    {
                        remove_replacement_for_runtime_drift = true;
                    } else {
                        drop(manager_guard);
                        return ensure_session_sidecar_attempt(
                            app_handle,
                            manager,
                            session_id,
                            workspace_path,
                            owner,
                            runtime_override,
                            runtime_source_override,
                            attempt + 1,
                            expected_recovery_epoch,
                        );
                    }
                }
            }
            if remove_replacement_for_runtime_drift {
                manager_guard =
                    replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
                manager_guard.clear_generation(session_id);
            }
            // Replacement sidecar process also dead — fall through to create
        } else if http_healthy {
            // Same generation, HTTP healthy — try to reuse
            let mut remove_for_runtime_drift = false;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port && sidecar.is_reusable() {
                    ulog_info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id,
                        port,
                        owner
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        &expected_runtime_identity,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-http-healthy",
                    )
                    .is_err()
                    {
                        remove_for_runtime_drift = true;
                    } else {
                        sidecar.add_owner(owner.clone());
                        emit_perf_trace(
                            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                                .duration_ms(elapsed_ms(ensure_started))
                                .session_id(Some(session_id))
                                .runtime(Some(&runtime_for_trace))
                                .detail("runtimeSource", &runtime_source_label)
                                .status("ok")
                                .detail("port", port)
                                .detail("is_new", false)
                                .detail(
                                    "reuse",
                                    if wait_for_starting {
                                        "starting-ready"
                                    } else {
                                        "healthy"
                                    },
                                ),
                        );
                        return Ok(EnsureSidecarResult {
                            port,
                            is_new: false,
                            generation: pre_gen,
                        });
                    }
                } else if sidecar.port == port && wait_for_starting {
                    ulog_info!(
                        "[sidecar] Session {} starting Sidecar reached readiness on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    if validate_sidecar_runtime_invariant(
                        session_id,
                        &expected_runtime_identity,
                        sidecar.runtime.as_deref(),
                        sidecar.runtime_source.as_deref(),
                        "reuse-starting-ready",
                    )
                    .is_err()
                    {
                        remove_for_runtime_drift = true;
                    } else {
                        sidecar.state = SidecarState::Healthy;
                        sidecar.add_owner(owner.clone());
                        emit_perf_trace(
                            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                                .duration_ms(elapsed_ms(ensure_started))
                                .session_id(Some(session_id))
                                .runtime(Some(&runtime_for_trace))
                                .detail("runtimeSource", &runtime_source_label)
                                .status("ok")
                                .detail("port", port)
                                .detail("is_new", false)
                                .detail("reuse", "starting-ready"),
                        );
                        return Ok(EnsureSidecarResult {
                            port,
                            is_new: false,
                            generation: pre_gen,
                        });
                    }
                }
            }
            if remove_for_runtime_drift {
                manager_guard =
                    replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
                manager_guard.clear_generation(session_id);
            }
            // Sidecar gone but generation unchanged (removed without replacement)
            ulog_info!(
                "[sidecar] Session {} Sidecar removed during HTTP check, will create new",
                session_id
            );
        } else {
            if wait_for_starting {
                // We joined a sidecar that another owner was already starting.
                // Our independent readiness timeout must not kill or replace
                // that startup; the original creator may still be inside its
                // longer TCP+ready boot window. Detach only the owner we added.
                ulog_warn!(
                    "[sidecar] Session {} starting Sidecar on port {} did not become ready for joining owner {:?}; preserving original startup",
                    session_id, port, owner
                );
                // Only detach the owner if THIS call actually added it. When the
                // owner was already present (a same-owner concurrent ensure joined
                // the same Starting sidecar), `add_owner` returned false; removing
                // it here would empty the shared owner set and tear down a sidecar
                // the other caller is still legitimately starting (cross-review
                // Codex Critical #2). Leave teardown to whoever truly owns it.
                let should_stop = if joined_owner_added {
                    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                        let (removed, last_owner_removed) = sidecar.remove_owner(&owner);
                        sidecar.port == port && removed && last_owner_removed
                    } else {
                        false
                    }
                } else {
                    false
                };
                if should_stop {
                    let retired = manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                    drop(manager_guard);
                    drop(retired);
                }
                return Err(format!(
                    "Session {} sidecar on port {} is still starting",
                    session_id, port
                ));
            }
            // Same generation, HTTP unhealthy — safe to remove (no one replaced it)
            ulog_warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard =
                replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
        }

        let result = create_new_session_sidecar(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            manager_guard,
            runtime_override.as_deref(),
            runtime_source_override.as_deref(),
            &expected_runtime_identity,
            attempt,
            expected_recovery_epoch,
        );
        if let Ok(ensure_result) = &result {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                    .duration_ms(elapsed_ms(ensure_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&requested_runtime_for_trace))
                    .status("ok")
                    .detail("port", ensure_result.port)
                    .detail("is_new", ensure_result.is_new),
            );
        }
        return result;
    }

    // No existing sidecar found, create a new one with the original guard
    let result = create_new_session_sidecar(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        manager_guard,
        runtime_override.as_deref(),
        runtime_source_override.as_deref(),
        &expected_runtime_identity,
        attempt,
        expected_recovery_epoch,
    );
    if let Ok(ensure_result) = &result {
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                .duration_ms(elapsed_ms(ensure_started))
                .session_id(Some(session_id))
                .runtime(Some(&requested_runtime_for_trace))
                .status("ok")
                .detail("port", ensure_result.port)
                .detail("is_new", ensure_result.is_new),
        );
    }
    result
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
fn create_new_session_sidecar<'a, R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &'a ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'a, SidecarManager>,
    runtime_override: Option<&str>,
    runtime_source_override: Option<&str>,
    resolved_identity: &RuntimeIdentity,
    attempt: u32,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    let boot_started = trace_start();

    // Guard against double-creation: if another thread already created a sidecar for this
    // session (e.g., health monitor raced with frontend), reuse it instead of spawning another.
    let mut replace_dead_existing = false;
    if let Some(existing) = manager_guard.sidecars.get_mut(session_id) {
        if !existing.is_dead() {
            ulog_info!(
                "[sidecar] Session {} already has a {:?} sidecar on port {} (created by another thread), retrying ensure",
                session_id, existing.state, existing.port
            );
            drop(manager_guard);
            return ensure_session_sidecar_attempt(
                app_handle,
                manager,
                session_id,
                workspace_path,
                owner,
                runtime_override.map(str::to_string),
                runtime_source_override.map(str::to_string),
                attempt + 1,
                expected_recovery_epoch,
            );
        }
        // Exists but process dead — remove before creating fresh
        replace_dead_existing = true;
    }
    if replace_dead_existing {
        manager_guard = replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
    }

    // Need to start a new Sidecar
    // First, find executables
    let node_path =
        find_node_executable(app_handle).ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path =
        find_server_script(app_handle).ok_or_else(|| "Server script not found".to_string())?;

    // Port probing has no lifecycle authority and may perform many socket
    // binds. The per-Session lifecycle guard held by the caller serializes
    // this Session while the shared manager lock is released.
    let port_allocator = manager_guard.port_allocator();
    drop(manager_guard);
    let port = allocate_sidecar_port(&port_allocator)?;
    let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
    if expected_recovery_epoch.is_some_and(|epoch| {
        !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
    }) {
        return Err(RECOVERY_ATTEMPT_STALE.to_string());
    }
    if manager_guard.sidecars.contains_key(session_id) {
        drop(manager_guard);
        return ensure_session_sidecar_attempt(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            runtime_override.map(str::to_string),
            runtime_source_override.map(str::to_string),
            attempt + 1,
            expected_recovery_epoch,
        );
    }

    ulog_info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id,
        port,
        owner
    );

    // Build command (see sibling SessionSidecar path for the tsx-loader rationale)
    let mut cmd = crate::process_cmd::new(&node_path);
    append_sidecar_entrypoint_args(&mut cmd, &script_path, port, SidecarProcessRole::Session);
    cmd.arg("--agent-dir").arg(workspace_path);

    // Pass session_id to Bun for real sessions (not pending-xxx)
    // so Bun uses the same UUID as Rust/SDK, enabling resume on crash recovery
    if !session_id.starts_with("pending-") {
        cmd.arg("--session-id").arg(session_id);
    }

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("MYAGENTS_MANAGEMENT_PORT", mgmt_port.to_string());
    }
    crate::external_cli::inject_internal_token(&mut cmd);

    // Reuse validation and process spawn consume the same identity snapshot for
    // this ensure attempt. In particular, missing Session metadata is not an
    // implicit builtin identity for a metadata creator.
    if let Some(runtime) = resolved_identity.runtime_for_env() {
        cmd.env("MYAGENTS_RUNTIME", runtime);
    }
    if let Some(runtime_source) = resolved_identity.runtime_source_for_env() {
        cmd.env("MYAGENTS_RUNTIME_SOURCE", runtime_source);
    }
    if let Some(runtime_binding_json) = &resolved_identity.runtime_binding_json {
        cmd.env("MYAGENTS_RUNTIME_BINDING", runtime_binding_json);
    }
    let sidecar_generation = manager_guard.next_generation(session_id);
    cmd.env("MYAGENTS_SIDECAR_ID", session_id);
    cmd.env(
        "MYAGENTS_SIDECAR_GENERATION",
        sidecar_generation.to_string(),
    );
    let runtime_for_trace = resolved_identity.runtime.clone();
    let runtime_source_for_trace = resolved_identity.runtime_source_label().to_string();

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Spawn
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_start")
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("runtimeSource", &runtime_source_for_trace)
            .detail("owner", format!("{:?}", owner)),
    );
    let mut child = crate::process_cmd::spawn_tree(&mut cmd).map_err(|e| {
        manager_guard.clear_generation(session_id);
        ulog_error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_failed")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_for_trace)
                .status("error")
                .detail("error", e.to_string()),
        );
        format!("Failed to spawn sidecar: {}", e)
    })?;
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawned")
            .duration_ms(elapsed_ms(boot_started))
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("runtimeSource", &runtime_source_for_trace)
            .status("ok")
            .detail("port", port),
    );

    // Capture stdout/stderr → 写入统一日志
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().flatten() {
                // Once Bun's unified logger is initialized, ALL console.log output is
                // written directly to the unified log file by Bun's logger interceptor.
                // Capturing stdout after this point causes 100% duplication ([BUN] + [bun-out]).
                // Only pre-logger startup lines need to go through bun-out.
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][session:{}] {}", session_id_for_log, line);
                }
                // After logger init: silently drop stdout (Bun logger handles it)
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info => {
                        ulog_info!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Warn => {
                        ulog_warn!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Error => {
                        ulog_error!("[bun-err][session:{}] {}", session_id_for_log, line)
                    }
                }
            }
        });
    }

    // Check if the process already exited (non-blocking poll). No pre-sleep;
    // the health-loop's alive_check catches any crash this probe misses.
    if let Ok(Some(status)) = child.try_wait() {
        manager_guard.clear_generation(session_id);
        thread::sleep(Duration::from_millis(100));
        ulog_error!(
            "[sidecar] SessionSidecar exited immediately with status: {:?}",
            status
        );
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_immediate_exit")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("runtimeSource", &runtime_source_for_trace)
                .status("error")
                .detail("status", format!("{:?}", status)),
        );
        return Err(diag);
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        management_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        state: SidecarState::Starting,
        owners,
        completion_claims: HashSet::new(),
        dispatch_gate: DispatchGate::new(),
        created_at: std::time::Instant::now(),
        runtime: resolved_identity.runtime_for_env().map(str::to_string),
        runtime_source: resolved_identity
            .runtime_source_for_env()
            .map(str::to_string),
    };

    manager_guard.insert_sidecar_at_generation(session_id, sidecar_generation, sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure for session sidecar
    let liveness_manager = manager.clone();
    let liveness_session_id = session_id.to_string();
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(sidecar) = guard.sidecars.get_mut(&liveness_session_id) {
                matches!(sidecar.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health (TCP up). Then wait for /health/ready (deferred init
    // complete) so renderer-driven session startup gates on actual readiness,
    // not just liveness. Other startup paths (cron / IM bot) keep the looser
    // liveness-only contract — they don't surface a "still warming up" UI.
    let health_started = trace_start();
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            // Pattern 4: tighten the renderer-driven session sidecar startup
            // to wait for /health/ready as well. 30s timeout matches existing
            // long-running migration / SDK init budgets.
            let readiness_started = trace_start();
            if let Err(e) = wait_for_readiness(port, 30) {
                ulog_error!(
                    "[sidecar] Session {} /health/ready failed: {}",
                    session_id,
                    e
                );
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::SidecarBoot, "ready_failed")
                        .duration_ms(elapsed_ms(readiness_started))
                        .session_id(Some(session_id))
                        .runtime(Some(&runtime_for_trace))
                        .status("error")
                        .detail("port", port)
                        .detail("error", &e),
                );
                let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
                let port_matches = manager_guard
                    .sidecars
                    .get(session_id)
                    .map(|s| s.port == port)
                    .unwrap_or(false);
                let retired = port_matches
                    .then(|| manager_guard.remove_sidecar(session_id))
                    .flatten();
                drop(manager_guard);
                drop(retired);
                return Err(e);
            }
            // Mark as healthy — verify port to avoid mutating a replacement sidecar
            // that was created by another thread (e.g., health monitor) during the wait.
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port {
                    sidecar.state = SidecarState::Healthy;
                } else {
                    ulog_warn!(
                        "[sidecar] Session {} sidecar replaced during wait_for_health (expected port {}, found {}), skipping Healthy transition",
                        session_id, port, sidecar.port
                    );
                }
            }
            ulog_info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id,
                port
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ready_ok")
                    .duration_ms(elapsed_ms(boot_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            Ok(EnsureSidecarResult {
                port,
                is_new: true,
                generation: sidecar_generation,
            })
        }
        Err(e) => {
            ulog_error!("[sidecar] SessionSidecar health check failed: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live_failed")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("error")
                    .detail("port", port)
                    .detail("error", &e),
            );
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            // Verify port before acting — another thread may have replaced the sidecar
            let port_matches = manager_guard
                .sidecars
                .get(session_id)
                .map(|s| s.port == port)
                .unwrap_or(false);
            let retired = if port_matches {
                // Check exit status and mark crashed bun for fallback
                #[cfg(target_os = "windows")]
                if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                    if let Ok(Some(status)) = sidecar.process.try_wait() {
                        maybe_mark_crashed_node(&status, &node_path);
                    }
                }
                // Remove the failed sidecar (ours, not a replacement)
                manager_guard.remove_sidecar(session_id)
            } else {
                ulog_warn!(
                    "[sidecar] Session {} sidecar replaced during wait_for_health (port {}), skipping removal",
                    session_id, port
                );
                None
            };
            drop(manager_guard);
            drop(retired);
            Err(e)
        }
    }
}

/// Release an owner from a Session's Sidecar.
/// If this was the last owner, the Sidecar is stopped.
///
/// Returns true if the Sidecar was stopped (no more owners).
pub(crate) fn finish_session_owner_release(
    manager: &ManagedSidecarManager,
    release: SessionOwnerRelease,
) -> Result<(bool, bool), String> {
    let SessionOwnerRelease {
        removed,
        stopped,
        drain,
    } = release;
    if let Some(drain) = drain {
        // The exact generation remains manager-authoritative with admission
        // closed while this waits. No global manager mutex is held here.
        drain.wait();
        let browser_host = {
            let mut manager_guard = manager
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            manager_guard.global_process_binding()
        };
        if let Some((port, generation)) = browser_host {
            let retirement = crate::local_http::blocking_builder()
                .timeout(std::time::Duration::from_millis(5_500))
                .build()
                .and_then(|client| {
                    client
                        .post(format!(
                            "http://127.0.0.1:{port}/api/browser/session/retire"
                        ))
                        .header("x-myagents-sidecar-generation", generation.to_string())
                        .json(&serde_json::json!({
                            "productSessionId": &drain.session_id,
                        }))
                        .send()
                });
            match retirement {
                Ok(response) if response.status().is_success() => {}
                Ok(response) => ulog_warn!(
                    "[browser-profile] action=session-retire status=rejected session={} http_status={}",
                    drain.session_id,
                    response.status()
                ),
                Err(error) => ulog_warn!(
                    "[browser-profile] action=session-retire status=unavailable session={} error={}",
                    drain.session_id,
                    error
                ),
            }
        }
        let retired = {
            // Owner removal already committed before the drain. Recovering a
            // poisoned lock here is required to finish that same transition;
            // returning an error would strand a half-retired Sidecar that no
            // caller can safely roll back.
            let mut manager_guard = manager
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            manager_guard.finish_unowned_session_retirement(&drain)
        };
        // SessionSidecar::drop terminates the already-drained process. Keep it
        // outside the manager guard even though the second wait is immediate.
        drop(retired);
    }
    Ok((removed, stopped))
}

fn release_session_sidecar_blocking(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let release = {
        let mut manager_guard = manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        manager_guard.remove_session_owner(session_id, owner)
    };
    let (removed, stopped) = finish_session_owner_release(manager, release)?;

    if removed {
        if stopped {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar stopped (last owner)",
                owner,
                session_id
            );
        } else {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar continues running",
                owner,
                session_id
            );
        }
        Ok(stopped)
    } else {
        ulog_debug!(
            "[sidecar] Session {} has no Sidecar to release owner {:?} from",
            session_id,
            owner
        );
        Ok(false)
    }
}

/// Blocking-thread-only owner release entrypoint.
///
/// This exists for lifecycle pollers that already run on a dedicated
/// `std::thread`. Tokio/async callers must use [`release_session_sidecar`].
pub(crate) fn release_session_sidecar_from_blocking_thread(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    release_session_sidecar_blocking(manager, session_id, owner)
}

/// Async-safe owner release entrypoint. The exact generation drain, Browser
/// Host retirement request, and process drop are intentionally executed on a
/// blocking worker; callers on Tokio must never enter reqwest's blocking
/// client lifecycle directly.
pub async fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let manager = manager.clone();
    let session_id = session_id.to_string();
    let owner = owner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        release_session_sidecar_blocking(&manager, &session_id, &owner)
    })
    .await
    .map_err(|error| format!("Session owner release task failed: {error:?}"))?
}

/// Release one exact owner wherever it currently resides.
///
/// This is narrower than owner-only routing: it is a lifecycle teardown
/// operation for an owner whose handover may temporarily span two Sessions.
/// All removals are committed under one manager lock before any exact process
/// drain is awaited.
pub(crate) async fn release_session_owner_everywhere(
    manager: &ManagedSidecarManager,
    owner: &SidecarOwner,
) -> Result<usize, String> {
    let manager = manager.clone();
    let owner = owner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let releases = {
            let mut manager_guard = manager
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            manager_guard.remove_owner_from_all_sessions(&owner)
        };
        let removed_count = releases.len();
        let mut errors = Vec::new();
        for (session_id, release) in releases {
            if let Err(error) = finish_session_owner_release(&manager, release) {
                errors.push(format!("session={session_id} error={error}"));
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "Failed to finish one or more exact owner releases: {}",
                errors.join("; ")
            ));
        }
        Ok(removed_count)
    })
    .await
    .map_err(|error| format!("Session owner sweep task failed: {error:?}"))?
}

/// Transfer a Drop-only release obligation to the async lifecycle owner.
/// Ordinary control flow must await [`release_session_sidecar`] directly.
pub fn schedule_release_session_sidecar(
    manager: ManagedSidecarManager,
    session_id: String,
    owner: SidecarOwner,
) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = release_session_sidecar(&manager, &session_id, &owner).await {
            ulog_warn!(
                "[sidecar] deferred owner release failed session={} owner={:?}: {}",
                session_id,
                owner,
                error
            );
        }
    });
}

/// Get the port for a Session's Sidecar
pub fn get_session_sidecar_port(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u16>, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.get_session_port(session_id))
}

/// Check whether a Session has a live Sidecar entry, including one still starting.
pub fn has_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.has_session_sidecar(session_id))
}

/// Get the current sidecar generation for a Session, if Rust still tracks one.
pub fn get_session_generation(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u64>, String> {
    let manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.generation_for(session_id))
}

// ============= Session-Centric Tauri Commands =============

fn is_canonical_session_id(session_id: &str) -> bool {
    let len = session_id.len();
    (1..=99).contains(&len)
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Ensure a Session has a Sidecar running, adding the specified owner
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_ensure_session_sidecar(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    workspacePath: String,
    ownerType: String,
    ownerId: String,
    birthRuntime: Option<String>,
    birthRuntimeSource: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    if birthRuntime.is_some() || birthRuntimeSource.is_some() {
        if !sessionId.starts_with("pending-")
            || !is_canonical_session_id(&sessionId)
            || !matches!(
                birthRuntime.as_deref(),
                Some("builtin" | "claude-code" | "codex" | "antigravity")
            )
            || !matches!(
                birthRuntimeSource.as_deref(),
                None | Some("system-cli" | "managed-provider")
            )
            || (birthRuntimeSource.as_deref() == Some("managed-provider")
                && birthRuntime.as_deref() != Some("codex"))
        {
            return Err(
                "Runtime birth selection requires a valid pending desktop Session".to_string(),
            );
        }
    }
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "companion" => SidecarOwner::Companion(ownerId),
        "task" => SidecarOwner::Task(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    if !crate::floating_ball::sidecar_owner_admitted(&owner) {
        return Err("Desktop pet Companion owner admission is closed".to_string());
    }

    let workspace_path = PathBuf::from(&workspacePath);
    // The async lifecycle entrypoint owns both the per-session deletion fence
    // and the blocking-thread handoff for the full cold boot/readiness wait.
    let manager = state.inner().clone();
    let result = ensure_session_sidecar_with_runtime_identity_override_lifecycle(
        app_handle,
        manager.clone(),
        sessionId.clone(),
        workspace_path,
        owner.clone(),
        birthRuntime,
        birthRuntimeSource,
    )
    .await?;
    if !crate::floating_ball::sidecar_owner_admitted(&owner) {
        release_session_sidecar(&manager, &sessionId, &owner).await?;
        return Err("Desktop pet Companion owner admission closed during ensure".to_string());
    }
    Ok(result)
}

/// Release an owner from a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_release_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    ownerType: String,
    ownerId: String,
) -> Result<bool, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "companion" => SidecarOwner::Companion(ownerId),
        "background_completion" => SidecarOwner::BackgroundCompletion(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    release_session_sidecar(state.inner(), &sessionId, &owner).await
}

/// Get the ready port for a Session's Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_port(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u16>, String> {
    get_session_sidecar_port(&state, &sessionId)
}

/// Check whether a Session has a live Sidecar entry, including Starting.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_has_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    has_session_sidecar(&state, &sessionId)
}

/// Get the current sidecar generation for a Session, if any.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_generation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u64>, String> {
    get_session_generation(&state, &sessionId)
}

/// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
/// This updates HashMap keys without stopping the Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_upgrade_session_id(
    state: tauri::State<'_, ManagedSidecarManager>,
    oldSessionId: String,
    newSessionId: String,
    tabId: String,
    ownerType: Option<String>,
) -> Result<bool, String> {
    let owner = match ownerType.as_deref().unwrap_or("tab") {
        "tab" => SidecarOwner::Tab(tabId),
        "companion" => SidecarOwner::Companion(tabId),
        _ => return Err("Only a desktop owner can materialize a pending Session".to_string()),
    };
    let _lifecycle = acquire_session_lifecycle(&[&oldSessionId, &newSessionId]).await;
    {
        let manager = state.lock().map_err(|e| e.to_string())?;
        if manager.session_id_upgrade_is_already_applied_for_desktop_owner(
            &oldSessionId,
            &newSessionId,
            &owner,
        ) {
            return Ok(true);
        }
    }
    if has_persisted_session_owner(&oldSessionId).await?
        || has_persisted_session_owner(&newSessionId).await?
    {
        return Ok(false);
    }
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    // The exact-owner predicate rejects every additional Tab/background owner,
    // while allowing the Companion itself to materialize its own fresh birth.
    Ok(manager.upgrade_session_id_for_desktop_owner(&oldSessionId, &newSessionId, &owner))
}

/// Check whether a session identity must remain stable after a Tab detaches.
/// Includes both live background owners and durable Task/Goal state whose
/// physical Sidecar owner may still be attaching or recovering.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_session_has_persistent_owners(
    state: tauri::State<'_, ManagedSidecarManager>,
    agent_state: tauri::State<'_, crate::im::ManagedAgents>,
    im_state: tauri::State<'_, crate::im::ManagedImBots>,
    sessionId: String,
) -> Result<bool, String> {
    let sidecars = state.inner().clone();
    let has_live_owner = {
        let manager = sidecars.lock().unwrap_or_else(|e| e.into_inner());
        manager.session_has_persistent_owners(&sessionId)
    };
    Ok(has_live_owner
        || has_non_tab_session_owner(&sessionId, agent_state.inner(), im_state.inner()).await?)
}

/// Retire a writer before storage deletion or recovery from an uncertain
/// identity transition. Existing owner tokens stay in ordinary generation
/// recovery, so mounted owners can resume the unchanged source identity.
fn retire_session_writer(sidecars: &ManagedSidecarManager, session_id: &str) -> Result<(), String> {
    let drain = {
        let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
        manager.prepare_session_sidecar_replacement(session_id)
    };
    if let Some(drain) = drain {
        drain.wait();
        let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
        manager.finish_session_sidecar_replacement(&drain);
    }
    {
        let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
        if let Some(previous) = manager.recovering_sidecars.get_mut(session_id) {
            previous
                .process
                .kill()
                .map_err(|error| format!("Cannot retire session writer: {error}"))?;
        }
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let exited = {
            let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
            match manager.recovering_sidecars.get_mut(session_id) {
                Some(previous) => previous
                    .process
                    .try_wait()
                    .map_err(|error| format!("Cannot confirm session writer exit: {error}"))?
                    .is_some(),
                None => true,
            }
        };
        if exited {
            let unowned = sidecars
                .lock()
                .map_err(|error| error.to_string())?
                .prepare_unowned_session_retirement(session_id);
            if let Some(unowned) = unowned {
                unowned.wait();
                let retired = sidecars
                    .lock()
                    .map_err(|error| error.to_string())?
                    .finish_unowned_session_retirement(&unowned);
                drop(retired);
            }
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(
                "Session writer has not exited; lifecycle mutation was not committed".to_string(),
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Delete a transcript while releasing only the exact mounted Tab owners named
/// by App. The per-Session lifecycle guard stays held across owner validation,
/// the local DELETE, and successful owner release, so every refusal preserves
/// both storage and the mounted owner set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteCommandResult {
    deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl SessionDeleteCommandResult {
    fn deleted() -> Self {
        Self {
            deleted: true,
            reason: None,
        }
    }

    fn refused(reason: &'static str) -> Self {
        Self {
            deleted: false,
            reason: Some(reason),
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_delete_session_if_unowned(
    state: tauri::State<'_, ManagedSidecarManager>,
    agent_state: tauri::State<'_, crate::im::ManagedAgents>,
    im_state: tauri::State<'_, crate::im::ManagedImBots>,
    sessionId: String,
    releasableTabIds: Vec<String>,
) -> Result<SessionDeleteCommandResult, String> {
    if !is_canonical_session_id(&sessionId) {
        return Ok(SessionDeleteCommandResult::refused("invalid-session-id"));
    }
    // Fast negative for the common active Task/Goal case. A fresh Session
    // creator may retain the lifecycle guard until metadata birth; waiting on
    // that guard before looking at the already-published durable/transient
    // owner would make a delete click hang for the entire AI turn. This is
    // only a UX shortcut: the same predicate is checked again under the guard
    // below, which remains the correctness boundary for false -> true races.
    if has_non_tab_session_owner(&sessionId, agent_state.inner(), im_state.inner()).await? {
        return Ok(SessionDeleteCommandResult::refused("in-use"));
    }
    let _lifecycle = acquire_session_lifecycle(&[&sessionId]).await;
    // Do not lock IM routers while holding the Session lifecycle fence: IM
    // message/runtime paths take router → lifecycle. Configured dormant
    // bindings are disk-only and safe to repeat here. Any live binding that
    // appears after the preflight first attaches an Agent owner under this same
    // fence, and `session_has_owners` below catches it.
    if has_persisted_session_owner(&sessionId).await?
        || crate::im::session_delivery::configured_session_binding_exists(&sessionId)
    {
        return Ok(SessionDeleteCommandResult::refused("in-use"));
    }
    let sidecars = state.inner().clone();
    let releasable_tab_ids = releasableTabIds.into_iter().collect::<HashSet<_>>();

    tauri::async_runtime::spawn_blocking(move || {
        let session_port = {
            let manager = sidecars.lock().map_err(|error| error.to_string())?;
            if manager.session_has_unreleasable_owners(&sessionId, &releasable_tab_ids) {
                return Ok(SessionDeleteCommandResult::refused("in-use"));
            }
            manager
                .get_session_sidecar(&sessionId)
                .filter(|sidecar| sidecar.is_reusable())
                .map(|sidecar| sidecar.port)
        };
        if let Some(port) = session_port {
            match super::background::check_sidecar_is_busy(port) {
                Some(false) => {}
                Some(true) => return Ok(SessionDeleteCommandResult::refused("in-use")),
                None => return Ok(SessionDeleteCommandResult::refused("activity-unavailable")),
            }
        }

        // The activity request intentionally runs without the manager lock.
        // Revalidate owners before the storage mutation while the outer
        // per-Session lifecycle fence still excludes new owner acquisition.
        let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
        if manager.session_has_unreleasable_owners(&sessionId, &releasable_tab_ids) {
            return Ok(SessionDeleteCommandResult::refused("in-use"));
        }
        let delete_authority = {
            let Some(instance) = manager.get_instance_mut(GLOBAL_SIDECAR_ID) else {
                return Ok(SessionDeleteCommandResult::refused("authority-unavailable"));
            };
            if !instance.is_running() {
                return Ok(SessionDeleteCommandResult::refused("authority-unavailable"));
            }
            let Some(delete_authority) = instance.session_delete_authority.clone() else {
                return Ok(SessionDeleteCommandResult::refused("authority-unavailable"));
            };
            delete_authority
        };
        let delete_dispatch = match manager.acquire_global_dispatch() {
            Ok(dispatch) => dispatch,
            Err(_) => return Ok(SessionDeleteCommandResult::refused("authority-unavailable")),
        };
        drop(manager);
        // A closed dispatch gate alone does not stop a writer's 100ms timer.
        // Do not unlink until the exact old Node process has actually exited.
        retire_session_writer(&sidecars, &sessionId)?;
        let client = crate::local_http::blocking_builder()
            // Integrated DSH deletion verifies and starts the pinned Runtime,
            // tombstones native state, purges it, then commits Product removal.
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| format!("Failed to create local HTTP client: {error}"))?;
        let delete_url = delete_dispatch.url_for_path(&format!("/sessions/{sessionId}"))?;
        let response = client
            .delete(delete_url)
            .header(SESSION_DELETE_AUTHORITY_HEADER, delete_authority)
            .send()
            .map_err(|error| format!("Failed to delete session: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .unwrap_or_else(|_| "<unreadable response>".to_string());
        // The lease ends at response-body materialization, before any later
        // owner release or Tauri/WebKit IPC delivery.
        drop(delete_dispatch);
        let result = if status.is_success() {
            SessionDeleteCommandResult::deleted()
        } else {
            match status.as_u16() {
                403 => return Ok(SessionDeleteCommandResult::refused("protected-session")),
                404 => SessionDeleteCommandResult::refused("not-found"),
                409 => return Ok(SessionDeleteCommandResult::refused("in-use")),
                _ => {
                    return Err(format!(
                        "Global Sidecar failed to delete session (HTTP {status}): {body}"
                    ))
                }
            }
        };

        // Success and not-found are both terminal/idempotent outcomes. Release
        // only the App-authorized Tab owners after storage has reached that
        // terminal state; every refusal above leaves them untouched.
        let releases = {
            let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
            releasable_tab_ids
                .iter()
                .map(|tab_id| manager.release_tab_session(&sessionId, tab_id, false))
                .collect::<Vec<_>>()
        };
        for release in releases {
            finish_session_owner_release(&sidecars, release)?;
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("Session deletion task failed: {error:?}"))?
}

/// Release a Tab owner under the Session lifecycle guard. This prevents a
/// newly-created Goal/Agent owner from landing between the renderer-side
/// presence check and owner removal.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_release_tab_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: String,
) -> Result<bool, String> {
    let _lifecycle = acquire_session_lifecycle(&[&sessionId]).await;
    let has_persisted_owner = has_persisted_session_owner(&sessionId).await?;
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let release = {
            let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
            manager_guard.release_tab_session(&sessionId, &tabId, has_persisted_owner)
        };
        let (removed, stopped) = finish_session_owner_release(&manager, release)?;
        Ok(removed && stopped)
    })
    .await
    .map_err(|error| format!("Tab Session release task failed: {error:?}"))?
}

#[cfg(test)]
mod session_lifecycle_tests {
    use super::{
        acquire_session_lifecycle, is_canonical_session_id, resolve_runtime_identity_for_owner,
        retained_session_runtime_identity, retire_session_writer,
        validate_sidecar_runtime_invariant, EnsureSidecarResult, RuntimeIdentity,
        SessionDeleteCommandResult, SidecarManager, SidecarOwner,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn desktop_new_does_not_wait_for_source_recovery() {
        use tauri::Manager;
        for source in [
            "pending-recovering-desktop",
            "370d8bc3-1de0-4090-b913-ce5830f70f27",
        ] {
            let app = tauri::test::mock_app();
            let manager = super::create_sidecar_manager();
            app.manage(manager.clone());
            app.manage(crate::im::ManagedAgents::default());
            app.manage(crate::im::ManagedImBots::default());
            let owner = SidecarOwner::Tab("recovering-tab".into());
            let epoch = {
                let mut state = manager.lock().unwrap();
                state.insert_test_ready_frontend_sidecar(source, 12345, owner.clone());
                state.begin_session_sidecar_replacement(source);
                state.recovering_sidecars[source].epoch
            };
            // Recovery holds this until the replacement is ready. Independent
            // birth must settle while that operation is still suspended.
            let recovery = acquire_session_lifecycle(&[source]).await;
            let result = tokio::time::timeout(
                Duration::from_millis(250),
                super::cmd_new_desktop_session(
                    app.handle().clone(),
                    app.state(),
                    source.into(),
                    "recovering-tab".into(),
                ),
            )
            .await
            .expect("new conversation waited for source recovery")
            .unwrap();
            assert!(result.create_new_sidecar);
            assert!(result.new_session_id.is_none());
            {
                let mut state = manager.lock().unwrap();
                assert_eq!(state.recovering_sidecars[source].epoch, epoch);
                assert!(state.session_has_exact_owner(source, &owner));
                let background = SidecarOwner::BackgroundCompletion(source.into());
                assert!(state.session_has_exact_owner(source, &background));
                // A late old-Tab release cannot discard the ongoing recovery.
                let _release = state.remove_session_owner(source, &owner);
                assert!(state.has_session_recovery(source));
                state.insert_test_ready_frontend_sidecar(source, 12346, background.clone());
                assert!(state.commit_ready_session_sidecar(source).is_some());
                assert!(!state.has_session_recovery(source));
                assert!(state.session_has_exact_owner(source, &background));
            }
            drop(recovery);
        }
    }

    #[tokio::test]
    async fn desktop_new_does_not_wait_for_channel_discovery_but_requires_its_tab() {
        use tauri::Manager;
        let app = tauri::test::mock_app();
        let manager = super::create_sidecar_manager();
        app.manage(manager.clone());
        app.manage(crate::im::ManagedAgents::default());
        app.manage(crate::im::ManagedImBots::default());
        manager.lock().unwrap().insert_test_ready_frontend_sidecar(
            "discovery-source",
            12345,
            SidecarOwner::Tab("actual-tab".into()),
        );
        for legacy in [false, true] {
            let agents = app.state::<crate::im::ManagedAgents>();
            let bots = app.state::<crate::im::ManagedImBots>();
            let agent_lock = if legacy {
                None
            } else {
                Some(agents.lock().await)
            };
            let bot_lock = if legacy {
                Some(bots.lock().await)
            } else {
                None
            };
            assert!(tokio::time::timeout(
                Duration::from_millis(250),
                super::cmd_new_desktop_session(
                    app.handle().clone(),
                    app.state(),
                    "discovery-source".into(),
                    "wrong-tab".into(),
                )
            )
            .await
            .unwrap()
            .is_err());
            let result = tokio::time::timeout(
                Duration::from_millis(250),
                super::cmd_new_desktop_session(
                    app.handle().clone(),
                    app.state(),
                    "discovery-source".into(),
                    "actual-tab".into(),
                ),
            )
            .await
            .expect("discovery blocked independent birth")
            .unwrap();
            assert!(result.create_new_sidecar);
            drop((agent_lock, bot_lock));
        }
    }

    // A real child HTTP writer. Running this test normally is a no-op; only
    // the isolated parent case supplies its temporary directory in the child.
    #[test]
    fn desktop_transition_writer_child() {
        use std::io::{BufRead, Read, Write};
        let Some(directory) = std::env::var_os("MYAGENTS_TRANSITION_TEST_CHILD") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(
            directory.join("port.tmp"),
            listener.local_addr().unwrap().port().to_string(),
        )
        .unwrap();
        std::fs::rename(directory.join("port.tmp"), directory.join("port")).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["sourceSessionId"], "source");
        std::fs::write(directory.join("accepted"), "source").unwrap();
        // Simulate a queued mutation which ignores HTTP client cancellation.
        // The parent opens this gate only after the lifecycle call has failed.
        while !directory.join("release").exists() {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::fs::write(directory.join("committed"), "target").unwrap();
        let body = r#"{"sessionId":"target"}"#;
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
    }

    #[tokio::test]
    async fn desktop_timeout_retires_the_actual_http_writer_before_delayed_mutation_can_commit() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = crate::process_cmd::new(std::env::current_exe().unwrap());
        command.args(["--exact", "sidecar::session_lifecycle::session_lifecycle_tests::desktop_transition_writer_child", "--nocapture"])
            .env("MYAGENTS_TRANSITION_TEST_CHILD", directory.path())
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let child = crate::process_cmd::spawn_tree(&mut command).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !directory.path().join("port").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "child HTTP writer did not become ready"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let port = std::fs::read_to_string(directory.path().join("port"))
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        {
            let mut manager = sidecars.lock().unwrap();
            manager.insert_test_ready_frontend_sidecar(
                "source",
                port,
                SidecarOwner::Tab("tab".into()),
            );
            manager.sidecars.get_mut("source").unwrap().process = child;
        }
        let client = crate::local_http::json_client(Duration::from_millis(200));
        assert!(super::transition_desktop_runtime_with_client(
            &sidecars, "source", "target", port, true, false, true, &client,
        )
        .await
        .is_err());
        assert!(directory.path().join("accepted").exists());
        {
            let mut manager = sidecars.lock().unwrap();
            assert!(!manager.sidecars.contains_key("source"));
            assert!(!manager.sidecars.contains_key("target"));
            let writer = manager.recovering_sidecars.get_mut("source").unwrap();
            assert!(writer.process.try_wait().unwrap().is_some());
            assert!(writer.owners.contains(&SidecarOwner::Tab("tab".into())));
        }
        // Opening the queued mutation gate after rollback cannot resurrect it.
        std::fs::write(directory.path().join("release"), "go").unwrap();
        assert!(!directory.path().join("committed").exists());
    }

    #[tokio::test]
    async fn desktop_pending_slot_resolves_the_pinned_runtime_source_before_reset() {
        use axum::{
            routing::{get, post},
            Json, Router,
        };
        let runtime_source = "b90ee5d4-0923-4c35-921c-8a2f87135df7";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = Router::new()
            .route(
                "/api/session-state",
                get(move || async move { Json(serde_json::json!({"sessionId":runtime_source})) }),
            )
            .route(
                "/api/session/new-conversation",
                post(move |Json(payload): Json<serde_json::Value>| async move {
                    assert_eq!(payload["sourceSessionId"], runtime_source);
                    Json(serde_json::json!({"sessionId":"target"}))
                }),
            );
        let server =
            tauri::async_runtime::spawn(
                async move { axum::serve(listener, service).await.unwrap() },
            );
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        sidecars.lock().unwrap().insert_test_ready_frontend_sidecar(
            "pending-tab",
            port,
            SidecarOwner::Tab("tab".into()),
        );
        let client = crate::local_http::json_client(Duration::from_secs(1));
        let dispatch = super::transition_desktop_runtime_with_client(
            &sidecars,
            "pending-tab",
            "target",
            port,
            false,
            false,
            true,
            &client,
        )
        .await
        .unwrap()
        .unwrap();
        super::commit_desktop_runtime_transition(
            &sidecars,
            "pending-tab",
            "target",
            "tab",
            None,
            dispatch,
        )
        .await
        .unwrap();
        assert!(sidecars
            .lock()
            .unwrap()
            .session_has_exact_owner("target", &SidecarOwner::Tab("tab".into())));
        server.abort();
    }

    #[tokio::test]
    async fn desktop_source_loss_before_reset_allows_separate_birth_without_retirement() {
        use axum::{routing::get, Router};
        // The identity probe is read-only. Failure must not issue a reset or
        // retire a writer that has not accepted a transition.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tauri::async_runtime::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/api/session-state",
                    get(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }),
                ),
            )
            .await
            .unwrap();
        });
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        sidecars.lock().unwrap().insert_test_ready_frontend_sidecar(
            "pending-source",
            port,
            SidecarOwner::Tab("tab".into()),
        );
        let client = crate::local_http::json_client(Duration::from_secs(1));
        assert!(super::transition_desktop_runtime_with_client(
            &sidecars,
            "pending-source",
            "target",
            port,
            false,
            false,
            true,
            &client,
        )
        .await
        .unwrap()
        .is_none());
        {
            let mut state = sidecars.lock().unwrap();
            assert!(
                state.session_has_exact_owner("pending-source", &SidecarOwner::Tab("tab".into()))
            );
            assert_eq!(state.get_session_port("pending-source"), Some(port));
            let source = state.sidecars.get_mut("pending-source").unwrap();
            source.process.kill().unwrap();
            source.process.wait().unwrap();
        }
        assert!(super::transition_desktop_runtime_with_client(
            &sidecars,
            "pending-source",
            "target",
            port,
            false,
            false,
            true,
            &client,
        )
        .await
        .unwrap()
        .is_none());
        assert!(sidecars
            .lock()
            .unwrap()
            .session_has_exact_owner("pending-source", &SidecarOwner::Tab("tab".into()),));
        server.abort();
    }

    #[tokio::test]
    async fn desktop_explicit_refusal_keeps_the_source_writer_and_owners_usable() {
        use axum::{routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = Router::new().route(
            "/api/session/new-conversation",
            post(|Json(payload): Json<serde_json::Value>| async move {
                (
                    axum::http::StatusCode::CONFLICT,
                    Json(serde_json::json!({
                        "success": false, "sourceUnchanged": true,
                        "errorCode": (payload["targetSessionId"] == "busy-target").then_some("session_busy"),
                        "error": "Wait for the current Session operation to finish",
                    })),
                )
            }),
        );
        let server =
            tauri::async_runtime::spawn(
                async move { axum::serve(listener, service).await.unwrap() },
            );
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        sidecars.lock().unwrap().insert_test_ready_frontend_sidecar(
            "source",
            port,
            SidecarOwner::Tab("tab".into()),
        );
        let client = crate::local_http::json_client(Duration::from_secs(1));
        assert!(super::transition_desktop_runtime_with_client(
            &sidecars, "source", "target", port, true, false, true, &client,
        )
        .await
        .is_err());
        assert!(super::transition_desktop_runtime_with_client(
            &sidecars,
            "source",
            "busy-target",
            port,
            true,
            false,
            true,
            &client,
        )
        .await
        .unwrap()
        .is_none());
        let mut state = sidecars.lock().unwrap();
        assert_eq!(state.get_session_port("source"), Some(port));
        assert!(state.session_has_exact_owner("source", &SidecarOwner::Tab("tab".into())));
        assert!(!state.recovering_sidecars.contains_key("source"));
        assert!(state.acquire_session_dispatch("source").unwrap().is_some());
        server.abort();
    }

    #[test]
    fn desktop_retained_sources_can_start_separately_without_resetting_other_owners() {
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        let tab = SidecarOwner::Tab("tab".into());
        sidecars
            .lock()
            .unwrap()
            .insert_test_ready_frontend_sidecar("source", 12345, tab.clone());
        assert_eq!(
            super::desktop_session_reset_port(&sidecars, "source", "tab", None, false).unwrap(),
            Some(12345)
        );
        // A dormant Channel binding or persisted Task/Goal protects identity,
        // not the user's ability to create a separate conversation.
        assert_eq!(
            super::desktop_session_reset_port(&sidecars, "source", "tab", None, true).unwrap(),
            None
        );
        for owner in [
            SidecarOwner::Companion("companion".into()),
            SidecarOwner::Task("task".into()),
            SidecarOwner::Tab("other-tab".into()),
        ] {
            sidecars
                .lock()
                .unwrap()
                .add_session_owner("source", owner.clone());
            assert_eq!(
                super::desktop_session_reset_port(&sidecars, "source", "tab", None, false).unwrap(),
                None
            );
            assert!(sidecars
                .lock()
                .unwrap()
                .session_has_exact_owner("source", &owner));
            let release = sidecars
                .lock()
                .unwrap()
                .remove_session_owner("source", &owner);
            assert!(release.drain.is_none());
        }
        let channel = SidecarOwner::Agent("peer".into());
        sidecars
            .lock()
            .unwrap()
            .add_session_owner("source", channel.clone());
        assert_eq!(
            super::desktop_session_reset_port(&sidecars, "source", "tab", Some("peer"), false)
                .unwrap(),
            Some(12345)
        );
        assert_eq!(
            super::desktop_session_reset_port(&sidecars, "source", "tab", Some("peer"), true)
                .unwrap(),
            None
        );
        assert!(sidecars
            .lock()
            .unwrap()
            .session_has_exact_owner("source", &channel));
        assert!(
            super::desktop_session_reset_port(&sidecars, "source", "wrong-tab", None, false)
                .is_err()
        );
    }

    #[tokio::test]
    async fn desktop_rekey_refusal_after_runtime_ack_retires_writer_and_retains_remaining_owner() {
        use axum::{routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = Router::new().route(
            "/api/session/new-conversation",
            post(|| async { Json(serde_json::json!({"sessionId":"target"})) }),
        );
        let server =
            tauri::async_runtime::spawn(
                async move { axum::serve(listener, service).await.unwrap() },
            );
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        let channel = SidecarOwner::Agent("channel".into());
        {
            let mut manager = sidecars.lock().unwrap();
            manager.insert_test_ready_frontend_sidecar(
                "source",
                port,
                SidecarOwner::Tab("tab".into()),
            );
            manager.add_session_owner("source", channel.clone());
        }
        let client = crate::local_http::json_client(Duration::from_secs(1));
        let dispatch = super::transition_desktop_runtime_with_client(
            &sidecars, "source", "target", port, true, false, true, &client,
        )
        .await
        .unwrap()
        .unwrap();
        let _release = sidecars
            .lock()
            .unwrap()
            .remove_session_owner("source", &SidecarOwner::Tab("tab".into()));
        assert!(!super::commit_desktop_runtime_transition(
            &sidecars,
            "source",
            "target",
            "tab",
            Some("channel"),
            dispatch
        )
        .await
        .unwrap());
        let mut manager = sidecars.lock().unwrap();
        assert!(!manager.sidecars.contains_key("target"));
        let source = manager.recovering_sidecars.get_mut("source").unwrap();
        assert!(source.process.try_wait().unwrap().is_some());
        assert_eq!(source.owners, std::collections::HashSet::from([channel]));
        server.abort();
    }

    #[tokio::test]
    async fn desktop_failure_settles_exact_writer_when_the_last_tab_closes() {
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        let (dispatch, release) = {
            let mut manager = sidecars.lock().unwrap();
            manager.insert_test_ready_frontend_sidecar(
                "source",
                31420,
                SidecarOwner::Tab("tab".into()),
            );
            let dispatch = manager.acquire_session_dispatch("source").unwrap().unwrap();
            let release = manager.remove_session_owner("source", &SidecarOwner::Tab("tab".into()));
            (dispatch, release)
        };
        let release_manager = sidecars.clone();
        let closing = tokio::task::spawn_blocking(move || {
            super::finish_session_owner_release(&release_manager, release)
        });
        super::retire_failed_desktop_transition(&sidecars, "source", dispatch)
            .await
            .unwrap();
        closing.await.unwrap().unwrap();
        let manager = sidecars.lock().unwrap();
        assert!(!manager.sidecars.contains_key("source"));
        assert!(!manager.recovering_sidecars.contains_key("source"));
    }

    #[tokio::test]
    async fn desktop_lost_response_does_not_treat_target_identity_as_completed_publication() {
        use axum::{
            routing::{get, post},
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let service = Router::new()
            .route(
                "/api/session/new-conversation",
                post(|| async { axum::http::StatusCode::BAD_GATEWAY }),
            )
            .route(
                "/api/session-state",
                get(|| async { Json(serde_json::json!({"sessionId": "target"})) }),
            );
        let server =
            tauri::async_runtime::spawn(
                async move { axum::serve(listener, service).await.unwrap() },
            );
        let client = crate::local_http::json_client(Duration::from_secs(1));
        super::request_desktop_runtime_transition(
            &client,
            port,
            &serde_json::json!({"sourceSessionId":"source", "targetSessionId":"target"}),
        )
        .await
        .unwrap_err();
        server.abort();
    }

    #[test]
    fn deletion_retires_the_real_writer_before_storage_mutation_and_retains_tab_ownership() {
        let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
        {
            let mut manager = sidecars.lock().unwrap();
            manager.insert_test_ready_frontend_sidecar(
                "delete-writer",
                31419,
                SidecarOwner::Tab("delete-tab".into()),
            );
        }
        retire_session_writer(&sidecars, "delete-writer").unwrap();
        let mut manager = sidecars.lock().unwrap();
        assert!(manager.get_session_sidecar("delete-writer").is_none());
        assert!(manager.session_has_owners("delete-writer"));
        let retained = manager
            .recovering_sidecars
            .get_mut("delete-writer")
            .unwrap();
        assert!(retained.process.try_wait().unwrap().is_some());
        drop(manager);
        // A missing/already-retired process is an idempotent boundary.
        retire_session_writer(&sidecars, "delete-writer").unwrap();
        retire_session_writer(&sidecars, "missing").unwrap();
    }

    #[test]
    fn unpublished_birth_identity_survives_retirement_for_builtin_and_external() {
        for runtime in [None, Some("codex")] {
            let sidecars = std::sync::Arc::new(std::sync::Mutex::new(SidecarManager::new()));
            {
                let mut manager = sidecars.lock().unwrap();
                manager.insert_test_ready_frontend_sidecar(
                    "birth",
                    31420,
                    SidecarOwner::Tab("tab".into()),
                );
                manager.sidecars.get_mut("birth").unwrap().runtime = runtime.map(String::from);
                assert_eq!(
                    retained_session_runtime_identity(&manager, "birth")
                        .unwrap()
                        .runtime,
                    runtime.unwrap_or("builtin")
                );
            }
            retire_session_writer(&sidecars, "birth").unwrap();
            let manager = sidecars.lock().unwrap();
            assert_eq!(
                retained_session_runtime_identity(&manager, "birth")
                    .unwrap()
                    .runtime,
                runtime.unwrap_or("builtin")
            );
        }
    }

    #[test]
    fn metadata_creator_uses_agent_runtime_for_external_reuse_and_spawn() {
        let expected = resolve_runtime_identity_for_owner(
            &SidecarOwner::Task("task-a".to_string()),
            None,
            None,
            None,
            Some(RuntimeIdentity::new(
                Some("codex"),
                Some("managed-provider"),
            )),
        );

        assert_eq!(expected.runtime, "codex");
        assert_eq!(expected.runtime_source.as_deref(), Some("managed-provider"));
        assert!(validate_sidecar_runtime_invariant(
            "metadata-creator",
            &expected,
            Some("codex"),
            Some("managed-provider"),
            "test-healthy-reuse",
        )
        .is_ok());
        assert!(validate_sidecar_runtime_invariant(
            "metadata-creator",
            &expected,
            Some("codex"),
            Some("managed-provider"),
            "test-starting-reuse",
        )
        .is_ok());
        assert!(validate_sidecar_runtime_invariant(
            "metadata-creator",
            &expected,
            None,
            None,
            "test-wrong-builtin-reuse",
        )
        .is_err());
    }

    #[test]
    fn metadata_creator_runtime_override_wins_before_metadata_birth() {
        let expected = resolve_runtime_identity_for_owner(
            &SidecarOwner::Task("task-a".to_string()),
            Some("claude-code"),
            Some("system-cli"),
            None,
            Some(RuntimeIdentity::new(
                Some("codex"),
                Some("managed-provider"),
            )),
        );

        assert_eq!(expected.runtime, "claude-code");
        assert_eq!(expected.runtime_source.as_deref(), Some("system-cli"));
    }

    #[test]
    fn im_owner_keeps_persisted_managed_identity_and_rejects_override() {
        let owner = SidecarOwner::Agent("im-peer".into());
        let frozen = RuntimeIdentity::new(Some("codex"), Some("managed-provider"));
        let resolved = resolve_runtime_identity_for_owner(
            &owner,
            None,
            None,
            Some(frozen.clone()),
            Some(RuntimeIdentity::new(Some("builtin"), None)),
        );
        assert_eq!(resolved, frozen);
        let rejected = resolve_runtime_identity_for_owner(
            &owner,
            Some("codex"),
            Some("system-cli"),
            Some(frozen),
            Some(RuntimeIdentity::new(Some("builtin"), None)),
        );
        assert!(validate_sidecar_runtime_invariant(
            "im-peer",
            &rejected,
            Some("codex"),
            Some("managed-provider"),
            "test"
        )
        .is_err());
    }

    #[test]
    fn persisted_binding_and_compatibility_state_survive_owner_resolution() {
        let binding = serde_json::json!({
            "family": "integrated",
            "id": "dsh",
            "implementationVersion": "0.0.0",
            "protocolVersion": "2.0.0",
            "protocolSchemaSha256": "schema",
            "runtimeArtifactSha256": "artifact",
            "compatibilityManifestSha256": "compatibility",
            "sessionFormat": "dsh-session-events-v1",
            "platformTarget": "darwin-arm64"
        });
        let dsh = RuntimeIdentity::new(Some("dsh"), Some("integrated")).with_binding(&binding);
        let expected = resolve_runtime_identity_for_owner(
            &SidecarOwner::Tab("tab-a".to_string()),
            None,
            None,
            Some(dsh.clone()),
            Some(RuntimeIdentity::new(Some("builtin"), None)),
        );
        assert_eq!(expected, dsh);

        let incompatible = RuntimeIdentity::incompatible("invalid frozen binding");
        let expected = resolve_runtime_identity_for_owner(
            &SidecarOwner::Tab("tab-a".to_string()),
            None,
            None,
            Some(incompatible.clone()),
            Some(RuntimeIdentity::new(Some("builtin"), None)),
        );
        assert_eq!(expected, incompatible);
        assert!(
            validate_sidecar_runtime_invariant("quarantined", &expected, None, None, "test",)
                .is_err()
        );
    }

    #[test]
    fn deletion_accepts_only_one_canonical_session_path_segment() {
        assert!(is_canonical_session_id(
            "11111111-2222-4333-8444-555555555555"
        ));
        assert!(is_canonical_session_id("pending-tab-123"));

        for invalid in [
            "",
            "owned?shadow",
            "owned#shadow",
            "owned/shadow",
            "owned\\shadow",
            "owned_shadow",
            "owned%2Fshadow",
        ] {
            assert!(!is_canonical_session_id(invalid), "accepted {invalid:?}");
        }
        assert!(!is_canonical_session_id(&"a".repeat(100)));
    }

    #[test]
    fn deletion_result_preserves_machine_readable_refusal_reasons() {
        assert_eq!(
            serde_json::to_value(SessionDeleteCommandResult::deleted()).unwrap(),
            serde_json::json!({ "deleted": true })
        );
        assert_eq!(
            serde_json::to_value(SessionDeleteCommandResult::refused("in-use")).unwrap(),
            serde_json::json!({ "deleted": false, "reason": "in-use" })
        );
    }

    #[test]
    fn ensure_result_process_generation_is_not_part_of_public_wire_shape() {
        assert_eq!(
            serde_json::to_value(EnsureSidecarResult {
                port: 32001,
                is_new: true,
                generation: 42,
            })
            .unwrap(),
            serde_json::json!({ "port": 32001, "isNew": true })
        );
    }

    #[tokio::test]
    async fn lifecycle_lock_serializes_one_session_without_blocking_another() {
        let suffix = uuid::Uuid::new_v4();
        let first_session = format!("lifecycle-first-{suffix}");
        let other_session = format!("lifecycle-other-{suffix}");
        let first_guard = acquire_session_lifecycle(&[&first_session]).await;

        let (same_tx, same_rx) = tokio::sync::oneshot::channel();
        let same_session = first_session.clone();
        let same_task = tauri::async_runtime::spawn(async move {
            let _guard = acquire_session_lifecycle(&[&same_session]).await;
            let _ = same_tx.send(());
        });
        assert!(tokio::time::timeout(Duration::from_millis(50), same_rx)
            .await
            .is_err());

        let (other_tx, other_rx) = tokio::sync::oneshot::channel();
        let other_task = tauri::async_runtime::spawn(async move {
            let _guard = acquire_session_lifecycle(&[&other_session]).await;
            let _ = other_tx.send(());
        });
        tokio::time::timeout(Duration::from_secs(1), other_rx)
            .await
            .expect("another session must not be blocked")
            .expect("other-session sender must stay alive");

        drop(first_guard);
        tokio::time::timeout(Duration::from_secs(1), same_task)
            .await
            .expect("same-session waiter must proceed after release")
            .expect("same-session task must complete");
        other_task.await.expect("other-session task must complete");
    }
}
