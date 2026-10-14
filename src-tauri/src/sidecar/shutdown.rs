use super::*;

static UPDATE_SHUTDOWN_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static LIFECYCLE_QUIESCE: std::sync::LazyLock<Arc<LifecycleQuiesce>> =
    std::sync::LazyLock::new(|| Arc::new(LifecycleQuiesce::default()));

#[derive(Default)]
struct LifecycleQuiesce {
    state: std::sync::Mutex<LifecycleQuiesceState>,
    idle: std::sync::Condvar,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum CreationAdmission {
    #[default]
    Open,
    UpdateShutdown,
    AppExit,
}

#[derive(Default)]
struct LifecycleQuiesceState {
    admission: CreationAdmission,
    active_creations: usize,
}

pub struct UpdateShutdownGuard {
    gate: Arc<LifecycleQuiesce>,
    active: bool,
}

pub struct LifecycleSpawnPermit {
    gate: Arc<LifecycleQuiesce>,
    active: bool,
}

impl Drop for UpdateShutdownGuard {
    fn drop(&mut self) {
        if self.active {
            if let Ok(mut state) = self.gate.state.lock() {
                // App exit is terminal. An update guard that happens to drop
                // after ExitRequested must not reopen process/resource birth.
                if state.admission == CreationAdmission::UpdateShutdown {
                    state.admission = CreationAdmission::Open;
                    UPDATE_SHUTDOWN_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                    self.gate.idle.notify_all();
                    ulog_info!("[sidecar] Update shutdown gate released");
                }
            }
        }
    }
}

impl Drop for LifecycleSpawnPermit {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.gate.state.lock() {
            state.active_creations = state.active_creations.saturating_sub(1);
            if state.active_creations == 0 {
                self.gate.idle.notify_all();
            }
        }
    }
}

impl LifecycleQuiesce {
    fn begin_spawn(self: &Arc<Self>) -> Result<LifecycleSpawnPermit, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.admission != CreationAdmission::Open {
            return Err("UPDATE_SHUTDOWN_IN_PROGRESS".to_string());
        }
        state.active_creations += 1;
        Ok(LifecycleSpawnPermit {
            gate: Arc::clone(self),
            active: true,
        })
    }

    fn begin_update(self: &Arc<Self>) -> Result<UpdateShutdownGuard, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.admission != CreationAdmission::Open {
            return Err("UPDATE_SHUTDOWN_ALREADY_IN_PROGRESS".to_string());
        }
        state.admission = CreationAdmission::UpdateShutdown;
        UPDATE_SHUTDOWN_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
        while state.active_creations > 0 {
            ulog_info!(
                "[sidecar] Waiting for {} owner creation(s) before update shutdown",
                state.active_creations
            );
            state = match self.idle.wait(state) {
                Ok(state) => state,
                Err(error) => {
                    let mut state = error.into_inner();
                    state.admission = CreationAdmission::Open;
                    UPDATE_SHUTDOWN_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
                    self.idle.notify_all();
                    return Err("UPDATE_SHUTDOWN_GATE_POISONED".to_string());
                }
            };
        }
        ulog_info!("[sidecar] Update shutdown gate acquired");
        Ok(UpdateShutdownGuard {
            gate: Arc::clone(self),
            active: true,
        })
    }

    fn try_begin_update(self: &Arc<Self>) -> Result<UpdateShutdownGuard, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?;
        // Do not close admission underneath an already-admitted creator that
        // may need to acquire another resource permit before publication.
        if state.admission != CreationAdmission::Open || state.active_creations > 0 {
            return Err("UPDATE_BUSY".to_string());
        }
        state.admission = CreationAdmission::UpdateShutdown;
        UPDATE_SHUTDOWN_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(UpdateShutdownGuard {
            gate: Arc::clone(self),
            active: true,
        })
    }

    fn begin_app_exit(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.admission = CreationAdmission::AppExit;
        UPDATE_SHUTDOWN_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
        while state.active_creations > 0 {
            ulog_info!(
                "[sidecar] Waiting for {} owner creation(s) before app exit",
                state.active_creations
            );
            state = self
                .idle
                .wait(state)
                .map_err(|_| "APP_EXIT_CREATION_GATE_POISONED".to_string())?;
        }
        ulog_info!("[sidecar] App-exit creation gate acquired");
        Ok(())
    }
}

pub fn begin_lifecycle_spawn_permit() -> Result<LifecycleSpawnPermit, String> {
    LIFECYCLE_QUIESCE.begin_spawn()
}

pub fn begin_update_shutdown() -> Result<UpdateShutdownGuard, String> {
    LIFECYCLE_QUIESCE.begin_update()
}

/// Permanently close process/resource birth for this app instance and wait
/// until every already-admitted creation has either registered its owner or
/// dropped the newly created resource. Unlike update quiesce, this gate never
/// reopens because Tauri's exit path terminates the Rust process.
pub fn begin_app_exit_shutdown() -> Result<(), String> {
    LIFECYCLE_QUIESCE.begin_app_exit()
}

pub fn is_update_shutdown_in_progress() -> bool {
    UPDATE_SHUTDOWN_IN_PROGRESS.load(std::sync::atomic::Ordering::SeqCst)
}

/// A user-confirmed update keeps the existing lifecycle gate closed and the
/// exact Node generation's SessionEngine admissions frozen until restart.
/// Failure drops this guard, releasing only this transaction's freeze tokens.
pub struct UpdateRestartGuard {
    lifecycle: Option<UpdateShutdownGuard>,
    token: String,
    targets: Vec<GlobalShutdownTarget>,
}

impl UpdateRestartGuard {
    /// Installation succeeded: retain admission closure until process exit.
    /// Do not call this until the live bundle replacement has completed.
    pub fn commit_restart(self) {
        std::mem::forget(self);
    }

    pub async fn release(mut self) {
        release_update_targets(&self.targets, &self.token).await;
        self.targets.clear();
        self.lifecycle.take();
    }
}

impl Drop for UpdateRestartGuard {
    fn drop(&mut self) {
        let targets = std::mem::take(&mut self.targets);
        let token = self.token.clone();
        let lifecycle = self.lifecycle.take();
        tauri::async_runtime::spawn(async move {
            release_update_targets(&targets, &token).await;
            // Reopen Rust births only after every Node release was attempted.
            drop(lifecycle);
        });
    }
}

async fn update_target_request(
    target: GlobalShutdownTarget,
    token: &str,
    action: &str,
) -> Result<(), String> {
    let response = crate::local_http::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?
        .post(format!(
            "http://127.0.0.1:{}/api/process/update-quiesce",
            target.port
        ))
        .header(
            "x-myagents-sidecar-generation",
            target.generation.to_string(),
        )
        .header(
            crate::external_cli::INTERNAL_TOKEN_HEADER,
            crate::external_cli::internal_token(),
        )
        .json(&serde_json::json!({ "action": action, "token": token }))
        .send()
        .await
        .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?;
    if status.is_success() && body.get("success").and_then(serde_json::Value::as_bool) == Some(true)
    {
        return Ok(());
    }
    Err(
        if body.get("error").and_then(serde_json::Value::as_str) == Some("UPDATE_BUSY") {
            "UPDATE_BUSY"
        } else {
            "UPDATE_ACTIVITY_UNKNOWN"
        }
        .to_string(),
    )
}

async fn release_update_targets(targets: &[GlobalShutdownTarget], token: &str) {
    for target in targets {
        if update_target_request(*target, token, "release")
            .await
            .is_err()
        {
            ulog_warn!(
                "[Updater] Unable to release exact generation {} update admission",
                target.generation
            );
        }
    }
}

/// Fail closed without interrupting any task. Scheduler claims use the same
/// lifecycle birth permit, and Sidecar turn admissions atomically freeze only
/// when the adapter and its queue/background/approval owners are idle.
pub async fn prepare_update_restart(
    app: &AppHandle,
    manager: &ManagedSidecarManager,
) -> Result<UpdateRestartGuard, String> {
    let lifecycle = LIFECYCLE_QUIESCE.try_begin_update()?;
    let mut guard = UpdateRestartGuard {
        lifecycle: Some(lifecycle),
        token: uuid::Uuid::new_v4().to_string(),
        targets: Vec::new(),
    };
    if !crate::task_scheduler::get_task_scheduler()
        .execution_projections_snapshot()
        .await
        .is_empty()
    {
        ulog_info!("[Updater] Restart deferred: task execution owner remains active");
        return Err("UPDATE_BUSY".to_string());
    }
    if let Some(terminals) = app.try_state::<Arc<crate::terminal::TerminalManager>>() {
        if terminals.has_open_sessions().await {
            ulog_info!("[Updater] Restart deferred: user terminal is still open; finish and close it before retrying");
            return Err("UPDATE_BUSY".to_string());
        }
    }
    if let Some(recording) = app.try_state::<crate::recording::ManagedRecordingManager>() {
        if recording.snapshot().await.is_some() {
            ulog_info!(
                "[Updater] Restart deferred: recording slot remains live, paused, or settling"
            );
            return Err("UPDATE_BUSY".to_string());
        }
    }
    if let Some(documents) = crate::document_processing::global() {
        if documents.has_pending_work()? {
            ulog_info!("[Updater] Restart deferred: document queue or worker remains active");
            return Err("UPDATE_BUSY".to_string());
        }
    }
    if let Some(speech) = crate::speech_recognition::global() {
        if speech.has_pending_work()? {
            ulog_info!(
                "[Updater] Restart deferred: speech queue, live session, or probe remains active"
            );
            return Err("UPDATE_BUSY".to_string());
        }
    }
    let targets = manager
        .lock()
        .map_err(|_| "UPDATE_ACTIVITY_UNKNOWN".to_string())?
        .update_restart_targets()?;
    for target in targets {
        // Record before sending: lost ACK may still have frozen this owner.
        guard.targets.push(target);
        if let Err(error) = update_target_request(target, &guard.token, "freeze").await {
            ulog_info!(
                "[Updater] Restart deferred: Session owner generation={} reason={}",
                target.generation,
                error
            );
            guard.release().await;
            return Err(error);
        }
    }
    Ok(guard)
}

/// Stop all Sidecar instances through their exact birth-time process-tree authority.
///
/// `reason` is required because this is an application-wide destructive
/// boundary. Callers must make the owning lifecycle explicit in diagnostics.
pub fn stop_all_sidecars(manager: &ManagedSidecarManager, reason: &str) -> Result<(), String> {
    ulog_info!(
        "[sidecar] stop_all action=begin reason={} scope=application",
        reason
    );

    // Close ordinary request admission first, but keep exact generations in
    // manager authority while the Global Host checkpoints Browser identity.
    let preparation = manager
        .lock()
        .map_err(|error| {
            let error = error.to_string();
            ulog_error!(
                "[sidecar] stop_all action=error reason={} scope=application error={}",
                reason,
                error
            );
            error
        })?
        .prepare_stop_all();
    preparation.wait();
    checkpoint_global_owned_resources(&preparation.globals);

    // Only after the callback has settled do we revoke generation authority
    // and drop the retained process trees (the Windows hard-containment path).
    let retirement = manager
        .lock()
        .map_err(|error| error.to_string())?
        .stop_all();
    retirement.finish();

    ulog_info!(
        "[sidecar] stop_all action=complete reason={} scope=application",
        reason
    );

    Ok(())
}

fn checkpoint_global_owned_resources(targets: &[GlobalShutdownTarget]) {
    for target in targets {
        let client = match crate::local_http::blocking_builder()
            .timeout(Duration::from_millis(5_500))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                ulog_warn!(
                    "[sidecar-global] action=graceful-shutdown status=client-error generation={} error={}",
                    target.generation,
                    error
                );
                continue;
            }
        };
        let url = format!(
            "http://127.0.0.1:{}/api/process/graceful-shutdown",
            target.port
        );
        match client
            .post(url)
            .header(
                "x-myagents-sidecar-generation",
                target.generation.to_string(),
            )
            .send()
        {
            Ok(response) if response.status().is_success() => {
                ulog_info!(
                    "[sidecar-global] action=graceful-shutdown status=complete generation={}",
                    target.generation
                );
            }
            Ok(response) => {
                ulog_warn!(
                    "[sidecar-global] action=graceful-shutdown status=rejected generation={} http_status={}",
                    target.generation,
                    response.status()
                );
            }
            Err(error) => {
                ulog_warn!(
                    "[sidecar-global] action=graceful-shutdown status=unavailable generation={} error={}",
                    target.generation,
                    error
                );
            }
        }
    }
}

/// Shutdown for update — block until all child processes are fully terminated.
/// Unlike stop_all_sidecars (which is non-blocking), this function waits for
/// all bun/SDK/MCP processes to exit, preventing NSIS installer file-lock errors on Windows.
pub fn shutdown_for_update_verified<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<(), String> {
    // The document Worker is an App-owned native child and may hold bundled
    // PDFium/ONNX Runtime files open. Settle it at the same verified update
    // boundary before an installer replaces those resources.
    if let Some(document_manager) = crate::document_processing::global() {
        document_manager.shutdown()?;
    }
    let protected_roots = update_protected_roots(app_handle);
    shutdown_for_update_inner(manager, &protected_roots)?;
    wait_for_update_file_locks(app_handle)?;
    Ok(())
}

fn shutdown_for_update_inner(
    manager: &ManagedSidecarManager,
    protected_roots: &[PathBuf],
) -> Result<(), String> {
    ulog_info!("[sidecar] Shutdown for update: stopping all processes...");

    // 1. Stop all Sidecar instances via their retained process-group / Job authority.
    stop_all_sidecars(manager, "update")?;

    // 2. Preserve the updater's existing residual-recovery pass. This is a
    //    verified update boundary, not the normal live-owner shutdown path.
    cleanup_update_residual_processes();

    // 3. Wait for all related processes to truly exit. Uses the same
    //    sysinfo-backed process scan as startup cleanup — no PowerShell
    //    subprocesses, no cmd-line-escaping edge cases, consistent
    //    behavior across Windows and Unix.
    let max_wait = Duration::from_secs(20);
    let start = std::time::Instant::now();
    let mut sleep_ms = 100u64;
    let mut residual_pids: Vec<u32> = Vec::new();
    loop {
        // Update path MUST verify our own sidecars (SIDECAR_MARKER) too —
        // NSIS can't overwrite `bun.exe` while it's in use, so we need
        // confirmation that every MyAgents-related process is gone. Uses
        // STARTUP patterns (superset that includes the sidecar marker).
        let matches = crate::process_cleanup::find_matching_processes_with_roots(
            STARTUP_CLEANUP_PATTERNS,
            protected_roots,
        );
        let residual_matches = crate::process_cleanup::find_live_processes_by_pid(&residual_pids);
        residual_pids = residual_matches.iter().map(|m| m.pid).collect();
        if matches.is_empty() && residual_matches.is_empty() {
            ulog_info!(
                "[sidecar] All processes terminated in {:?}",
                start.elapsed()
            );
            break;
        }

        if start.elapsed() > max_wait {
            ulog_warn!("[sidecar] Update shutdown timeout, force killing remaining...");
            let report = crate::process_cleanup::kill_stale_processes_with_roots(
                STARTUP_CLEANUP_PATTERNS,
                protected_roots,
            );
            ulog_info!(
                "[sidecar] Force-kill final pass: killed {}, residual {} ({:?})",
                report.killed,
                report.residual,
                report.elapsed
            );
            if report.residual > 0 {
                residual_pids.extend(report.residual_pids.iter().copied());
                residual_pids.sort_unstable();
                residual_pids.dedup();
            }
            let remaining = crate::process_cleanup::find_matching_processes_with_roots(
                STARTUP_CLEANUP_PATTERNS,
                protected_roots,
            );
            let residual_remaining =
                crate::process_cleanup::find_live_processes_by_pid(&residual_pids);
            if remaining.is_empty() && residual_remaining.is_empty() {
                break;
            }
            let mut all_remaining = remaining;
            all_remaining.extend(residual_remaining);
            return Err(format!(
                "UPDATE_PROCESSES_STILL_RUNNING: {}",
                describe_process_matches(&all_remaining)
            ));
        }

        let mut blocking = matches;
        blocking.extend(residual_matches);
        ulog_warn!(
            "[sidecar] Waiting for {} update-blocking process(es): {}",
            blocking.len(),
            describe_process_matches(&blocking)
        );
        let report = crate::process_cleanup::kill_stale_processes_with_roots(
            STARTUP_CLEANUP_PATTERNS,
            protected_roots,
        );
        if report.residual > 0 {
            residual_pids.extend(report.residual_pids.iter().copied());
            residual_pids.sort_unstable();
            residual_pids.dedup();
        }
        if report.total_targets() > 0 {
            ulog_info!(
                "[sidecar] Update shutdown kill pass: killed {} (roots={}, descendants={}, residual={}) in {:?}",
                report.killed,
                report.matched_roots,
                report.descendants,
                report.residual,
                report.elapsed
            );
        }
        thread::sleep(Duration::from_millis(sleep_ms));
        sleep_ms = std::cmp::min(sleep_ms.saturating_mul(2), 1_000);
    }

    ulog_info!("[sidecar] Shutdown for update complete");
    Ok(())
}

/// Clean up SDK and MCP residual processes only for verified update shutdown.
///
/// SDK-spawned node/bun processes from a previous containment implementation
/// may survive until the updater boundary (especially through Windows
/// `cmd.exe` / `npx.cmd` wrappers). This updater-only cleanup walks descendants
/// by PPID via sysinfo and kills them all — orphans included — in one pass.
///
/// Normal app exit and debug stop MUST NOT call this function: those paths own
/// only the live [`ChildTree`] values retained by Sidecar/Bridge owners and may
/// not infer process ownership from argv.
fn cleanup_update_residual_processes() {
    let report = crate::process_cleanup::kill_stale_processes(CHILD_CLEANUP_PATTERNS);
    if report.total_targets() == 0 {
        ulog_info!(
            "[sidecar] Update residual cleanup: nothing to kill ({:?})",
            report.elapsed
        );
    } else {
        ulog_info!(
            "[sidecar] Update residual cleanup: killed {} (roots={}, descendants={}, residual={}) in {:?}",
            report.killed,
            report.matched_roots,
            report.descendants,
            report.residual,
            report.elapsed
        );
    }
}

fn update_protected_roots<R: Runtime>(app_handle: &AppHandle<R>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        roots.push(normalize_external_path(resource_dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(normalize_external_path(dir.to_path_buf()));
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn describe_process_matches(matches: &[crate::process_cleanup::ProcessMatch]) -> String {
    matches
        .iter()
        .take(8)
        .map(|m| {
            let exe = m.exe.as_deref().unwrap_or("<unknown-exe>");
            format!(
                "pid={} name={} reason={} exe={}",
                m.pid, m.name, m.reason, exe
            )
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

#[cfg(test)]
mod lifecycle_quiesce_tests {
    use super::*;

    #[test]
    fn confirmed_update_does_not_interrupt_an_admitted_creator_or_its_nested_resource() {
        let gate = Arc::new(LifecycleQuiesce::default());
        let creator = gate.begin_spawn().unwrap();
        assert!(matches!(gate.try_begin_update(), Err(error) if error == "UPDATE_BUSY"));
        let nested = gate
            .begin_spawn()
            .expect("the already-admitted creator can continue");
        drop(nested);
        drop(creator);
        let update = gate
            .try_begin_update()
            .expect("idle lifecycle admits confirmed update");
        assert!(
            gate.begin_spawn().is_err(),
            "new work cannot race accepted installation"
        );
        drop(update);
        assert!(
            gate.begin_spawn().is_ok(),
            "failed update restores admission"
        );
    }

    #[test]
    fn app_exit_closes_admission_and_waits_for_inflight_creation() {
        let gate = Arc::new(LifecycleQuiesce::default());
        let permit = gate.begin_spawn().expect("admit creation");
        let exit_gate = Arc::clone(&gate);
        let completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let completed_after_wait = Arc::clone(&completed);
        let waiter = std::thread::spawn(move || {
            exit_gate.begin_app_exit().expect("app exit gate");
            completed_after_wait.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while gate.state.lock().expect("gate state").admission != CreationAdmission::AppExit {
            assert!(
                std::time::Instant::now() < deadline,
                "exit did not close admission"
            );
            std::thread::yield_now();
        }
        assert!(gate.begin_spawn().is_err());
        assert!(!completed.load(std::sync::atomic::Ordering::SeqCst));

        drop(permit);
        waiter.join().expect("join app exit waiter");
        assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(
            gate.begin_spawn().is_err(),
            "app-exit admission is terminal"
        );
    }

    #[test]
    fn app_exit_cannot_be_reopened_by_a_late_update_guard_drop() {
        let gate = Arc::new(LifecycleQuiesce::default());
        let update = gate.begin_update().expect("update gate");
        gate.begin_app_exit().expect("upgrade to app exit");
        drop(update);
        assert!(gate.begin_spawn().is_err());
    }
}

#[cfg(target_os = "windows")]
fn wait_for_update_file_locks<R: Runtime>(app_handle: &AppHandle<R>) -> Result<(), String> {
    let paths = update_lock_probe_paths(app_handle)?;
    if paths.is_empty() {
        return Err("UPDATE_LOCK_PROBE_UNAVAILABLE: no probe paths resolved".to_string());
    }

    let max_wait = Duration::from_secs(20);
    let start = std::time::Instant::now();
    let mut sleep_ms = 100u64;
    loop {
        let locked = probe_locked_paths(&paths);
        if locked.is_empty() {
            ulog_info!(
                "[sidecar] Update file-lock probe passed for {} path(s) in {:?}",
                paths.len(),
                start.elapsed()
            );
            return Ok(());
        }
        if start.elapsed() > max_wait {
            return Err(format!(
                "UPDATE_FILES_STILL_LOCKED: {}",
                locked
                    .iter()
                    .map(|(path, err)| format!("{} ({})", path.display(), err))
                    .collect::<Vec<_>>()
                    .join(" | ")
            ));
        }
        ulog_warn!(
            "[sidecar] Waiting for {} update file lock(s): {}",
            locked.len(),
            locked
                .iter()
                .map(|(path, err)| format!("{} ({})", path.display(), err))
                .collect::<Vec<_>>()
                .join(" | ")
        );
        thread::sleep(Duration::from_millis(sleep_ms));
        sleep_ms = std::cmp::min(sleep_ms.saturating_mul(2), 1_000);
    }
}

#[cfg(not(target_os = "windows"))]
fn wait_for_update_file_locks<R: Runtime>(_app_handle: &AppHandle<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn update_lock_probe_paths<R: Runtime>(app_handle: &AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    let resource_dir = app_handle.path().resource_dir().map_err(|err| {
        format!(
            "UPDATE_LOCK_PROBE_UNAVAILABLE: failed to resolve resource_dir: {}",
            err
        )
    })?;
    let resource_dir = normalize_external_path(resource_dir);
    let entries: [(&str, PathBuf, bool); 5] = [
        (
            "bundled node",
            resource_dir.join("nodejs").join("node.exe"),
            true,
        ),
        (
            "claude sdk",
            resource_dir.join("claude-agent-sdk").join("claude.exe"),
            true,
        ),
        ("sidecar bundle", resource_dir.join("server-dist.js"), true),
        (
            "plugin bridge bundle",
            resource_dir.join("plugin-bridge-dist.mjs"),
            true,
        ),
        (
            "tsx loader",
            resource_dir
                .join("tsx-runtime")
                .join("node_modules")
                .join("tsx")
                .join("dist")
                .join("esm")
                .join("index.mjs"),
            true,
        ),
    ];

    let mut paths = Vec::new();
    let mut missing_required = Vec::new();
    for (label, path, required) in entries {
        if path.exists() {
            paths.push(path);
        } else if required {
            missing_required.push(format!("{} ({})", label, path.display()));
        }
    }

    if !missing_required.is_empty() {
        return Err(format!(
            "UPDATE_LOCK_PROBE_UNAVAILABLE: missing required path(s): {}",
            missing_required.join(" | ")
        ));
    }
    Ok(paths)
}

#[cfg(target_os = "windows")]
fn probe_locked_paths(paths: &[PathBuf]) -> Vec<(PathBuf, String)> {
    use std::os::windows::fs::OpenOptionsExt;

    paths
        .iter()
        .filter_map(|path| {
            let write_probe = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(path);
            match write_probe {
                Ok(_) => None,
                Err(err) if is_windows_file_lock_error(&err) => {
                    Some((path.clone(), err.to_string()))
                }
                Err(err) if err.raw_os_error() == Some(5) => {
                    let read_probe = std::fs::OpenOptions::new()
                        .read(true)
                        .share_mode(0)
                        .open(path);
                    match read_probe {
                        Ok(_) => {
                            ulog_warn!(
                                "[sidecar] Update file-lock probe ignored write-access denial for {}: {}",
                                path.display(),
                                err
                            );
                            None
                        }
                        Err(read_err) if is_windows_file_lock_error(&read_err) => {
                            Some((path.clone(), read_err.to_string()))
                        }
                        Err(read_err) => {
                            ulog_warn!(
                                "[sidecar] Update file-lock probe ignored non-lock read probe error for {}: {}",
                                path.display(),
                                read_err
                            );
                            None
                        }
                    }
                }
                Err(err) => {
                    ulog_warn!(
                        "[sidecar] Update file-lock probe ignored non-lock error for {}: {}",
                        path.display(),
                        err
                    );
                    None
                }
            }
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn is_windows_file_lock_error(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_USER_MAPPED_FILE.
        Some(32 | 33 | 1224)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ExternalMatchingProcess {
        child: std::process::Child,
    }

    impl ExternalMatchingProcess {
        fn spawn() -> Self {
            #[cfg(unix)]
            let mut command = {
                use std::os::unix::process::CommandExt;
                let mut command = crate::process_cmd::new("sh");
                command.args(["-c", "sleep 60; : # independent @playwright/mcp process"]);
                command.process_group(0);
                command
            };

            #[cfg(target_os = "windows")]
            let mut command = {
                let mut command = crate::process_cmd::new("powershell");
                command.args([
                    "-NoProfile",
                    "-Command",
                    "Start-Sleep -Seconds 60 # independent @playwright/mcp process",
                ]);
                command
            };

            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let child = command.spawn().expect("spawn independent matching process");
            Self { child }
        }

        fn is_alive(&mut self) -> bool {
            matches!(self.child.try_wait(), Ok(None))
        }
    }

    impl Drop for ExternalMatchingProcess {
        fn drop(&mut self) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
            #[cfg(target_os = "windows")]
            {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
    }

    #[test]
    fn normal_shutdown_leaves_unowned_matching_process_alive() {
        let mut external = ExternalMatchingProcess::spawn();
        assert!(
            external.is_alive(),
            "test setup must start an external process"
        );

        let manager = create_sidecar_state();
        stop_all_sidecars(&manager, "test-normal-shutdown").expect("normal shutdown");

        assert!(
            external.is_alive(),
            "normal shutdown must never infer ownership from a matching argv substring"
        );
    }
}
