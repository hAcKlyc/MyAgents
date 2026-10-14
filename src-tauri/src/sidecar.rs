// Sidecar process management module
// Handles spawning, monitoring, and shutting down multiple Bun backend server instances
// Supports per-Tab isolation with independent Sidecar processes

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
#[cfg(unix)]
use std::sync::Once;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::perf_trace::{elapsed_ms, emit_perf_trace, trace_start, PerfTrace, PerfTraceName};
use crate::process_cmd::ChildTree;
use crate::proxy_config;

pub(crate) mod background;
pub(crate) mod cleanup;
pub(crate) mod commands;
pub(crate) mod cron_execute;
pub(crate) mod health;
pub(crate) mod instances;
pub(crate) mod legacy;
pub(crate) mod manager;
pub(crate) mod proxy;
pub(crate) mod runtime_identity;
pub(crate) mod session_lifecycle;
pub(crate) mod shutdown;
pub(crate) mod spawn;
pub(crate) mod stdio;
pub(crate) mod types;

use background::check_sidecar_session_state;
#[allow(unused_imports)]
pub use background::{
    cancel_background_completion, cmd_cancel_background_completion, cmd_get_background_sessions,
    cmd_start_background_completion, start_background_completion,
    start_headless_background_completion, BackgroundCompletionResult,
};
use cleanup::CHILD_CLEANUP_PATTERNS;
pub use cleanup::{
    cleanup_stale_sidecars, cleanup_stale_sidecars_preamble, init_startup_cleanup_barrier,
    mark_startup_cleanup_done, recover_proxy_spills_after_startup_cleanup,
    wait_for_startup_cleanup,
};
use cleanup::{remove_global_port_file, write_global_port_file, STARTUP_CLEANUP_PATTERNS};
#[allow(unused_imports)]
pub use commands::cmd_reconcile_session_tab_activation;
#[allow(unused_imports)]
pub use cron_execute::{
    ensure_goal_sidecar_owner, execute_cron_task, execute_goal_turn, CronExecutePayload,
    CronExecuteResponse, GoalExecutePayload, GoalExecuteResponse,
};
use health::{check_sidecar_http_health, wait_for_health, wait_for_readiness};
pub use instances::{
    forward_terminal_events_to_renderer, get_tab_server_url, get_tab_sidecar_status,
    monitor_global_sidecar, monitor_session_sidecars, monitor_turn_wake_lock, start_global_sidecar,
    start_tab_sidecar, stop_tab_sidecar,
};
pub use legacy::{
    check_process_alive, ensure_sidecar_running, get_sidecar_status, restart_sidecar,
    start_sidecar, stop_sidecar,
};
#[allow(unused_imports)]
pub use manager::create_sidecar_manager;
pub use manager::{
    create_sidecar_state, LegacySidecarConfig, ManagedSidecar, ManagedSidecarManager,
    SidecarManager, SidecarStatus,
};
pub(crate) use manager::{FrontendSidecarBinding, SessionProcessSource};
#[allow(unused_imports)]
pub use proxy::cmd_propagate_proxy;
#[allow(unused_imports)]
pub use runtime_identity::cmd_can_restore_session;
pub(crate) use runtime_identity::resolve_agent_runtime_identity_by_id_from_config;
#[cfg(test)]
use runtime_identity::resolve_session_runtime_identity_from_json;
#[allow(unused_imports)]
use runtime_identity::{
    distribution_default_runtime_identity, resolve_agent_runtime_identity_from_config,
    resolve_session_runtime_identity_full_from_json, validate_sidecar_runtime_invariant,
    RuntimeIdentity,
};
#[allow(unused_imports)]
pub use runtime_identity::{
    resolve_session_runtime_identity, resolve_session_runtime_identity_full,
};
pub(crate) use session_lifecycle::{
    acquire_session_lifecycle, ensure_session_sidecar_with_lifecycle,
    ensure_session_sidecar_with_runtime_identity_override,
    ensure_session_sidecar_with_runtime_identity_override_lifecycle,
    ensure_session_sidecar_with_runtime_identity_override_lifecycle_held,
    finish_session_owner_release, has_persisted_session_owner, release_session_owner_everywhere,
    release_session_sidecar_from_blocking_thread, SessionLifecycleGuard,
};
#[allow(unused_imports)]
pub use session_lifecycle::{
    cmd_delete_session_if_unowned, cmd_ensure_session_sidecar, cmd_get_session_generation,
    cmd_get_session_port, cmd_has_session_sidecar, cmd_release_session_sidecar,
    cmd_release_tab_session, cmd_session_has_persistent_owners, cmd_upgrade_session_id,
    get_session_generation, get_session_sidecar_port, has_session_sidecar, release_session_sidecar,
    schedule_release_session_sidecar, EnsureSidecarResult,
};
pub use shutdown::{
    begin_app_exit_shutdown, begin_lifecycle_spawn_permit, begin_update_shutdown,
    is_update_shutdown_in_progress, prepare_update_restart, shutdown_for_update_verified,
    stop_all_sidecars, LifecycleSpawnPermit,
};
pub use spawn::find_node_executable_pub;
pub(crate) use spawn::normalize_external_path;
use spawn::{
    diagnose_immediate_exit, diagnose_node_not_found, find_node_executable, find_server_script,
    is_port_available,
};
pub(crate) use stdio::{classify_sidecar_stderr, SidecarStderrLevel};
#[allow(unused_imports)]
pub use types::SidecarInfo;
use types::{
    normalize_runtime_name, normalize_runtime_source_name, sidecar_removal_event_policy,
    ExistingSidecarReuse,
};

/// Probe the next process-wide Sidecar port without retaining lifecycle state.
/// Callers clone the allocator handle while the manager is locked, then perform
/// the bounded socket probes after releasing that lock.
pub(crate) fn allocate_sidecar_port(counter: &AtomicU16) -> Result<u16, String> {
    const MAX_ATTEMPTS: u32 = 200;

    for _ in 0..MAX_ATTEMPTS {
        let port = next_sidecar_port_candidate(counter);
        if is_port_available(port) {
            return Ok(port);
        }
    }

    Err(format!(
        "No available port found after {} attempts",
        MAX_ATTEMPTS
    ))
}

fn next_sidecar_port_candidate(counter: &AtomicU16) -> u16 {
    let mut observed = counter.load(Ordering::SeqCst);
    loop {
        let candidate = if (BASE_PORT..=BASE_PORT + PORT_RANGE).contains(&observed) {
            observed
        } else {
            BASE_PORT
        };
        let next = if candidate == BASE_PORT + PORT_RANGE {
            BASE_PORT
        } else {
            candidate + 1
        };
        match counter.compare_exchange(observed, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return candidate,
            Err(actual) => observed = actual,
        }
    }
}
pub(crate) use types::{
    DispatchDrain, DispatchGate, DispatchLease, DispatchReplacement, GlobalShutdownTarget,
    SessionCompletionClaim, SessionGenerationDrain, SidecarRetirement, SidecarShutdownPreparation,
};
pub use types::{SessionSidecar, SidecarInstance, SidecarOwner, SidecarState};

// Ensure file descriptor limit is increased only once (unix only)
#[cfg(unix)]
static RLIMIT_INIT: Once = Once::new();

/// Increase file descriptor limit to prevent "low max file descriptors" error from Bun
/// This is especially important on macOS where the default soft limit is often 2560
#[cfg(unix)]
fn ensure_high_file_descriptor_limit() {
    RLIMIT_INIT.call_once(|| {
        use libc::{getrlimit, setrlimit, rlimit, RLIMIT_NOFILE};

        unsafe {
            let mut rlim = rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };

            // Get current limits
            if getrlimit(RLIMIT_NOFILE, &mut rlim) == 0 {
                let old_soft = rlim.rlim_cur;
                let hard_limit = rlim.rlim_max;

                // Only increase if current soft limit is below a reasonable threshold
                // Target: at least 65536, or hard limit if lower
                let target = std::cmp::min(65536, hard_limit);

                if old_soft < target {
                    rlim.rlim_cur = target;

                    if setrlimit(RLIMIT_NOFILE, &rlim) == 0 {
                        ulog_info!(
                            "[sidecar] Increased file descriptor limit: {} -> {} (hard limit: {})",
                            old_soft, target, hard_limit
                        );
                    } else {
                        ulog_warn!(
                            "[sidecar] Failed to increase file descriptor limit (current: {}, target: {})",
                            old_soft, target
                        );
                    }
                } else {
                    ulog_info!(
                        "[sidecar] File descriptor limit already sufficient: {} (hard: {})",
                        old_soft, hard_limit
                    );
                }
            } else {
                ulog_warn!("[sidecar] Failed to get current file descriptor limit");
            }
        }
    });
}

#[cfg(not(unix))]
fn ensure_high_file_descriptor_limit() {
    // No-op on non-Unix systems
}

// Configuration constants
#[cfg(all(myagents_moxbot, not(myagents_isolated_qa)))]
const BASE_PORT: u16 = 32415;
#[cfg(not(myagents_moxbot))]
const BASE_PORT: u16 = 31415;
#[cfg(myagents_updater_qa)]
const BASE_PORT: u16 = 33415;
#[cfg(myagents_model_qa)]
const BASE_PORT: u16 = 34415;
// Health check: exponential backoff 50ms → 500ms, capped. Wall-clock ceiling ≈ 5 min.
// Node cold start is ~2s (tsx boot + module load), so the first 5 attempts at
// 50/100/200/400/500ms (cumulative 1.25s) usually arrive before listen — cheap,
// no-ops. Attempts 6+ poll at 500ms to accommodate Windows Defender first-run
// scanning (20-30s hold) without burning CPU.
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 600;
const HEALTH_CHECK_DELAY_CAP_MS: u64 = 500;
const HEALTH_CHECK_DELAY_START_MS: u64 = 50;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 100;
// HTTP health check for existing sidecar.
// 2000ms accommodates Windows systems under startup load (Defender, proxy, Plugin Bridge init).
// Previously 500ms which caused false "unhealthy" during busy startup windows.
const HTTP_HEALTH_CHECK_TIMEOUT_MS: u64 = 2000;
// Grace period after sidecar creation during which the health monitor skips checks.
// Prevents the monitor from killing a sidecar that's still completing its initial startup
// (TCP health check, Bun init, Plugin Bridge, etc.), especially on Windows with Defender.
const STARTUP_GRACE_SECS: u64 = 45;
// Port range: 500 ports (31415-31914)
const PORT_RANGE: u16 = 500;
// Special identifier for global sidecar (used by Settings page)
pub const GLOBAL_SIDECAR_ID: &str = "__global__";
// Process identification marker (used to identify our sidecar processes)
// This marker is added to all sidecar commands for reliable process identification
#[cfg(all(myagents_moxbot, not(myagents_isolated_qa)))]
const SIDECAR_MARKER: &str = "--moxbot-sidecar";
#[cfg(not(myagents_moxbot))]
const SIDECAR_MARKER: &str = "--myagents-sidecar";
#[cfg(myagents_updater_qa)]
const SIDECAR_MARKER: &str = "--moxbot-updaterqa-sidecar";
#[cfg(myagents_model_qa)]
const SIDECAR_MARKER: &str = "--moxbot-modelqa-sidecar";
const SESSION_DELETE_AUTHORITY_ENV: &str = "MYAGENTS_SESSION_DELETE_AUTHORITY";
const SESSION_DELETE_AUTHORITY_HEADER: &str = "X-MyAgents-Session-Delete-Authority";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarProcessRole {
    Global,
    Session,
}

impl SidecarProcessRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Session => "session",
        }
    }
}

fn append_sidecar_role_arg(cmd: &mut std::process::Command, role: SidecarProcessRole) {
    cmd.arg("--sidecar-role").arg(role.as_str());
}

fn configure_session_delete_authority(
    cmd: &mut std::process::Command,
    role: SidecarProcessRole,
) -> Option<String> {
    if role != SidecarProcessRole::Global {
        return None;
    }
    let token = uuid::Uuid::new_v4().to_string();
    cmd.env(SESSION_DELETE_AUTHORITY_ENV, &token);
    Some(token)
}

/// Append the shared Node entrypoint argv used by both generic/global and
/// Session-centric spawn paths. Keeping role serialization in this production
/// builder makes a missing role impossible in either caller.
fn append_sidecar_entrypoint_args(
    cmd: &mut std::process::Command,
    script_path: &std::path::Path,
    port: u16,
    role: SidecarProcessRole,
) {
    if crate::app_dirs::IS_ISOLATED_QA {
        // Keep even direct QA launches from forwarding credentials to Node children.
        for (name, _) in std::env::vars_os() {
            let text = name.to_string_lossy();
            if text.starts_with("ANTHROPIC_") || text.starts_with("OPENAI_")
                || text.starts_with("CLAUDE_CODE_OAUTH") || text.starts_with("MYAGENTS_HOST_")
                || text == "CODEX_HOME" || text == "CLAUDE_CONFIG_DIR"
                || matches!(text.as_ref(), "NODE_OPTIONS" | "NODE_PATH" | "BASH_ENV" | "ENV" | "ZDOTDIR" | "LD_PRELOAD" | "DYLD_INSERT_LIBRARIES" | "DYLD_LIBRARY_PATH") {
                cmd.env_remove(name);
            }
        }
        if let Some(root) = crate::app_dirs::myagents_data_dir() {
            cmd.env("CLAUDE_CONFIG_DIR", root.join("claude"));
            cmd.env("CODEX_HOME", root.join("codex"));
        }
    }
    cmd.env("MYAGENTS_APP_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.env(
        "MYAGENTS_APP_BUILD_MODE",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
    );
    if script_path.extension().and_then(|s| s.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx/esm");
    }
    cmd.arg(script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER);
    append_sidecar_role_arg(cmd, role);
}

#[cfg(test)]
mod sidecar_process_role_tests {
    use super::{
        append_sidecar_entrypoint_args, append_sidecar_role_arg,
        configure_session_delete_authority, next_sidecar_port_candidate, SidecarProcessRole,
        BASE_PORT, PORT_RANGE, SESSION_DELETE_AUTHORITY_ENV,
    };
    use std::path::Path;

    fn role_args(role: SidecarProcessRole) -> Vec<String> {
        let mut command = crate::process_cmd::new("node");
        append_sidecar_role_arg(&mut command, role);
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn concurrent_port_candidate_wrap_never_rolls_the_counter_back() {
        let counter =
            std::sync::Arc::new(std::sync::atomic::AtomicU16::new(BASE_PORT + PORT_RANGE));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let threads = (0..16)
            .map(|_| {
                let counter = std::sync::Arc::clone(&counter);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    next_sidecar_port_candidate(&counter)
                })
            })
            .collect::<Vec<_>>();
        let candidates = threads
            .into_iter()
            .map(|thread| thread.join().expect("allocator thread"))
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(candidates.len(), 16);
        assert!(candidates.contains(&(BASE_PORT + PORT_RANGE)));
        assert!(candidates.contains(&BASE_PORT));
    }

    #[test]
    fn global_and_session_roles_have_explicit_node_argv() {
        assert_eq!(
            role_args(SidecarProcessRole::Global),
            vec!["--sidecar-role", "global"]
        );
        assert_eq!(
            role_args(SidecarProcessRole::Session),
            vec!["--sidecar-role", "session"]
        );
    }

    #[test]
    fn production_entrypoint_builder_always_serializes_its_role() {
        let mut global = crate::process_cmd::new("node");
        append_sidecar_entrypoint_args(
            &mut global,
            Path::new("server-dist.js"),
            31415,
            SidecarProcessRole::Global,
        );
        let global_args: Vec<_> = global
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(global_args
            .windows(2)
            .any(|pair| pair == ["--sidecar-role", "global"]));

        let mut session = crate::process_cmd::new("node");
        append_sidecar_entrypoint_args(
            &mut session,
            Path::new("server.ts"),
            31416,
            SidecarProcessRole::Session,
        );
        for command in [&global, &session] {
            let environment: std::collections::HashMap<_, _> = command.get_envs().collect();
            assert_eq!(
                environment.get(std::ffi::OsStr::new("MYAGENTS_APP_VERSION")),
                Some(&Some(std::ffi::OsStr::new(env!("CARGO_PKG_VERSION")))),
            );
            assert!(environment.contains_key(std::ffi::OsStr::new("MYAGENTS_APP_BUILD_MODE")));
        }
        let session_args: Vec<_> = session
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(session_args
            .windows(2)
            .any(|pair| pair == ["--sidecar-role", "session"]));
        assert!(session_args
            .windows(2)
            .any(|pair| pair == ["--import", "tsx/esm"]));
    }

    #[test]
    fn only_global_sidecar_receives_session_delete_authority() {
        let mut global = crate::process_cmd::new("node");
        let global_token =
            configure_session_delete_authority(&mut global, SidecarProcessRole::Global)
                .expect("global authority token");
        assert!(!global_token.is_empty());
        assert!(global.get_envs().any(|(key, value)| {
            key == SESSION_DELETE_AUTHORITY_ENV
                && value.and_then(|value| value.to_str()) == Some(global_token.as_str())
        }));

        let mut session = crate::process_cmd::new("node");
        assert!(
            configure_session_delete_authority(&mut session, SidecarProcessRole::Session).is_none()
        );
        assert!(!session
            .get_envs()
            .any(|(key, _)| key == SESSION_DELETE_AUTHORITY_ENV));
    }
}

// Port file for CLI discovery — written when Global Sidecar starts,
// read by `cli.rs` to know which port to connect to.
const PORT_FILE_NAME: &str = "sidecar.port";

// ===== Crashed Node Tracking =====
// When a bundled Node.js crashes with STATUS_ACCESS_VIOLATION (0xC0000005) on Windows —
// usually a missing VC++ runtime DLL or some AV-injection incompatibility — mark it as
// crashed so subsequent spawn attempts fall through to system Node.
// v0.1.x tracked Bun crashes here (AVX2 baseline issue); Node has its own failure modes.
static CRASHED_NODE_PATHS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[allow(dead_code)] // Only called from #[cfg(windows)] blocks; harmless on other platforms
fn mark_node_as_crashed(path: &std::path::Path) {
    let normalized = normalize_external_path(path.to_path_buf());
    // unwrap_or_else recovers from Mutex poisoning — the body is trivial (Vec::push),
    // so the data is still consistent even if a previous holder panicked.
    let mut paths = CRASHED_NODE_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    if !paths.iter().any(|p| p == &normalized) {
        paths.push(normalized.clone());
        ulog_warn!(
            "[sidecar] Marked node as crashed (will try system fallback on next attempt): {:?}",
            normalized
        );
    }
}

fn is_node_crashed(path: &std::path::Path) -> bool {
    let normalized = normalize_external_path(path.to_path_buf());
    let paths = CRASHED_NODE_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    paths.iter().any(|x| x == &normalized)
}

/// On Windows, check if the process exited with STATUS_ACCESS_VIOLATION (0xC0000005)
/// and mark the node binary as crashed for fallback to system node.
#[cfg(target_os = "windows")]
fn maybe_mark_crashed_node(status: &std::process::ExitStatus, node_path: &std::path::Path) {
    let code = status.code().unwrap_or(0) as u32;
    if code == 0xc0000005 {
        mark_node_as_crashed(node_path);
    }
}

// ===== Proxy Configuration =====
// Default values (must match TypeScript PROXY_DEFAULTS in types.ts)
// Proxy configuration is now managed by the shared proxy_config module
// See src/proxy_config.rs for implementation details
