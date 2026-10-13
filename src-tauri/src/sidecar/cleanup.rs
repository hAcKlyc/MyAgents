use super::*;

// ===== Port File for CLI Discovery =====

/// Write the Global Sidecar port to ~/.myagents/sidecar.port so the CLI can discover it.
pub(super) fn write_global_port_file(port: u16) {
    if let Some(home) = dirs::home_dir() {
        let port_file = home.join(crate::app_dirs::APP_DATA_DIR_NAME).join(PORT_FILE_NAME);
        if let Err(e) = std::fs::write(&port_file, port.to_string()) {
            ulog_warn!("[sidecar] Failed to write port file {:?}: {}", port_file, e);
        } else {
            ulog_info!("[sidecar] Wrote CLI port file: {:?} = {}", port_file, port);
        }
    }
}

/// Remove the port file (called on app exit / sidecar shutdown).
pub(super) fn remove_global_port_file() {
    if let Some(home) = dirs::home_dir() {
        let port_file = home.join(crate::app_dirs::APP_DATA_DIR_NAME).join(PORT_FILE_NAME);
        let _ = std::fs::remove_file(&port_file);
    }
}

// ============= Stale process cleanup =============
//
// Two updater/startup recovery pattern sets share the same legacy child
// signatures. Normal shutdown never consumes either set; live process owners
// terminate only their exact `ChildTree` containment authority.
//
// * [`STARTUP_CLEANUP_PATTERNS`] additionally sweeps sidecars by
//   [`SIDECAR_MARKER`]. Startup cleanup runs only when `acquire_lock`
//   reports a prior instance — in that scenario the prior instance is
//   already dead (SIGKILL'd by our lock code or crashed), so any matching
//   sidecar must be an orphan we legitimately own.
//
// * [`CHILD_CLEANUP_PATTERNS`] is updater-only residual recovery and
//   deliberately **does not** sweep by `SIDECAR_MARKER`. It remains separate
//   from normal shutdown because update file-lock verification has a distinct
//   protected-root contract.
//
// All forward-slash form — the matcher in `process_cleanup` normalizes
// `\` → `/` and lowercases both sides before comparison.
pub(super) const CHILD_CLEANUP_PATTERNS: &[crate::process_cleanup::ProcessPattern] = &[
    // SDK subprocess spawned by Claude Agent SDK.
    crate::process_cleanup::ProcessPattern::new("SDK", "claude-agent-sdk"),
    // MCP servers installed under ~/.myagents/mcp/.
    crate::process_cleanup::ProcessPattern::new("MCP", ".myagents/mcp/"),
    // Well-known external MCP packages launched via `bun x` / `npx`.
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@playwright/mcp"),
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@anthropic-ai/mcp"),
    // MCP servers running under bundled Node.js (cmd.exe intermediates on
    // Windows can orphan these; the descendants-by-PPID walk inside
    // `process_cleanup` catches them regardless).
    crate::process_cleanup::ProcessPattern::new("nodejs", "/myagents/nodejs/"),
];

pub(super) const STARTUP_CLEANUP_PATTERNS: &[crate::process_cleanup::ProcessPattern] = &[
    // Our own Bun sidecar, identified by the argv marker.
    crate::process_cleanup::ProcessPattern::new("sidecar", SIDECAR_MARKER),
    // SDK subprocess spawned by Claude Agent SDK.
    crate::process_cleanup::ProcessPattern::new("SDK", "claude-agent-sdk"),
    crate::process_cleanup::ProcessPattern::new("MCP", ".myagents/mcp/"),
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@playwright/mcp"),
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@anthropic-ai/mcp"),
    crate::process_cleanup::ProcessPattern::new("nodejs", "/myagents/nodejs/"),
];

// ===== Startup cleanup synchronization =====
//
// `cleanup_stale_sidecars` is hoisted off the main thread (see
// `lib.rs::setup`). Any sidecar start path MUST wait on this barrier before
// spawning. The barrier covers both prior-process termination and the single
// startup ref inventory, so a new writer cannot race that inventory. It is set
// up once at app start and, in the vast majority of cases, is already signaled
// by the time the first sidecar spawn is requested.

pub(crate) struct StartupCleanupBarrier {
    done: std::sync::atomic::AtomicBool,
}

static STARTUP_CLEANUP_BARRIER: std::sync::OnceLock<Arc<StartupCleanupBarrier>> =
    std::sync::OnceLock::new();

/// Initialize the startup-cleanup barrier. Call exactly once, before any
/// potential call to [`wait_for_startup_cleanup`]. Safe to call multiple
/// times — subsequent calls are no-ops.
pub fn init_startup_cleanup_barrier() -> Arc<StartupCleanupBarrier> {
    STARTUP_CLEANUP_BARRIER
        .get_or_init(|| {
            Arc::new(StartupCleanupBarrier {
                done: std::sync::atomic::AtomicBool::new(false),
            })
        })
        .clone()
}

/// Mark the startup cleanup as complete. Waiters will observe the flag
/// via their own polling loop — no async condvar needed.
pub fn mark_startup_cleanup_done() {
    if let Some(b) = STARTUP_CLEANUP_BARRIER.get() {
        b.done.store(true, std::sync::atomic::Ordering::Release);
    }
}

/// Block the current (sync) thread until prior writers are quiescent and the
/// startup ref inventory has finished. A timeout rejects this spawn rather
/// than letting a new writer race the still-running inventory.
///
/// Implementation note: pure `AtomicBool` polling with a 25 ms sleep —
/// deliberately **not** using `tokio::sync::Notify` + `block_on`. This
/// function is called from `start_tab_sidecar`, which is invoked from
/// within an async Tauri command (running on a tokio worker), where
/// `tauri::async_runtime::block_on` would panic
/// ("cannot start a runtime from within a runtime"). Polling is also
/// cheap enough here: the common case is the barrier is already
/// signaled before the first sidecar spawn is requested, so we exit on
/// the first atomic-load without ever sleeping.
pub fn wait_for_startup_cleanup(timeout: Duration) -> Result<(), String> {
    let Some(barrier) = STARTUP_CLEANUP_BARRIER.get() else {
        return Ok(());
    };
    if barrier.done.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(());
    }
    let start = std::time::Instant::now();
    let poll = Duration::from_millis(25);
    while !barrier.done.load(std::sync::atomic::Ordering::Acquire) {
        if start.elapsed() >= timeout {
            return Err(format!(
                "STARTUP_CLEANUP_IN_PROGRESS: timed out after {:?}",
                start.elapsed()
            ));
        }
        thread::sleep(poll);
    }
    let elapsed = start.elapsed();
    if elapsed > Duration::from_millis(100) {
        ulog_info!(
            "[sidecar] Sidecar spawn waited {:?} for startup cleanup",
            elapsed
        );
    }
    Ok(())
}

/// Fast synchronous preamble — safe to run on the main thread before the
/// heavy cleanup pass is spawned into a blocking worker. Removes the stale
/// port file so a lingering CLI read doesn't see a dead port.
pub fn cleanup_stale_sidecars_preamble() {
    remove_global_port_file();
}

/// Heavy cleanup pass — enumerate and kill stale sidecar/SDK/MCP
/// subprocesses left behind by a prior app instance.
///
/// Intended to run on a blocking tokio worker off the main thread. The
/// entire Windows path previously took 5–15 seconds synchronously by
/// shelling out to PowerShell+WMI six times; this native implementation
/// typically completes in 10–200 ms.
///
/// When `had_prior_instance` is `false` (true first launch / post-uninstall),
/// the scan is skipped entirely — there cannot be any orphans to kill,
/// so the PID enumeration overhead is pure waste.
pub fn cleanup_stale_sidecars(had_prior_instance: bool) -> bool {
    if !had_prior_instance {
        ulog_info!(
            "[sidecar] True first launch (no prior lock file) — skipping stale process scan"
        );
        return true;
    }

    // MoX bot must never sweep the global SDK/MCP signatures used by MyAgents.
    // Recovery authority is limited to this installation and this profile's data.
    let report = if crate::app_dirs::IS_MOXBOT {
        let mut roots = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                roots.push(parent.join("../Resources"));
            }
        }
        if let Some(data) = crate::app_dirs::myagents_data_dir() {
            roots.push(data);
        }
        let roots: Vec<_> = roots.into_iter().filter_map(|p| p.canonicalize().ok()).collect();
        crate::process_cleanup::kill_stale_processes_with_roots(&[], &roots)
    } else {
        crate::process_cleanup::kill_stale_processes(STARTUP_CLEANUP_PATTERNS)
    };
    if report.total_targets() == 0 {
        ulog_info!(
            "[sidecar] Startup cleanup complete in {:?} (no stale processes found)",
            report.elapsed
        );
    } else {
        ulog_info!(
            "[sidecar] Startup cleanup: killed {} (roots={}, descendants={}, residual={}) in {:?}",
            report.killed,
            report.matched_roots,
            report.descendants,
            report.residual,
            report.elapsed
        );
        if report.residual > 0 {
            ulog_warn!(
                "[sidecar] {} processes survived termination deadline",
                report.residual
            );
        }
    }
    report.residual == 0
}

/// Inventory proxy spill residue only after prior Sidecar/Bridge writers are
/// confirmed stopped. Residual or panicked cleanup leaves the manager's
/// `inventory_complete` fact false, so Rust spill admission remains closed for
/// this run without a live-directory rescan.
pub async fn recover_proxy_spills_after_startup_cleanup(
    spill_manager: &crate::proxy_spill::ProxySpillManager,
    writers_quiesced: bool,
) -> Result<usize, String> {
    if !writers_quiesced {
        return Err(
            "[proxy] prior ref writers did not quiesce; startup inventory remains incomplete"
                .to_string(),
        );
    }
    spill_manager.recover_startup_orphans().await
}

#[cfg(test)]
mod startup_inventory_tests {
    use super::*;

    #[tokio::test]
    async fn ref_inventory_stays_closed_until_prior_writers_quiesce() {
        let root = tempfile::tempdir().expect("temp refs");
        let orphan = root.path().join(format!("{}.part", "a".repeat(32)));
        std::fs::write(&orphan, b"in-flight").expect("write orphan");
        let manager = crate::proxy_spill::ProxySpillManager::new(root.path().to_path_buf());

        assert!(recover_proxy_spills_after_startup_cleanup(&manager, false)
            .await
            .is_err());
        assert!(orphan.exists(), "inventory must not touch a live writer");

        assert_eq!(
            recover_proxy_spills_after_startup_cleanup(&manager, true)
                .await
                .expect("quiesced inventory"),
            1
        );
        assert!(!orphan.exists());
    }
}
