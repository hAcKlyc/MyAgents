// MyAgents Tauri Application
// Main entry point with sidecar lifecycle management

pub mod app_dirs;
pub mod app_route;
pub mod attachment_protocol;
pub mod browser;
pub mod browser_identity_store;
pub mod browser_resource;
pub mod browser_runtime_authority;
pub mod cli;
mod commands;
pub mod config_io;
mod crash_artifact_retention;
pub mod cron_task;
pub mod device_identity;
pub mod document_processing;
mod durable_fs;
mod durable_journal;
mod filesystem_capacity;
pub mod floating_ball;
pub mod floating_ball_pets;
mod global_shortcut;
pub mod grok_auth;
pub mod tokendance;
pub mod i18n;
pub mod im;
pub mod inbox;
mod keyed_lifecycle;
pub mod legacy_upgrade;
mod litellm_cache;
pub mod local_http;
pub mod local_inference;
pub mod logger;
#[cfg(target_os = "macos")]
mod macos_arrow_filter;
#[cfg(target_os = "macos")]
mod macos_traffic_light;
pub mod managed_codex;
pub mod management_api;
pub mod mcp_startup_admission;
pub use myagents_media_worker_protocol as media_worker_protocol;
pub mod memory_auto_update;
pub mod memory_evolution;
pub mod notification;
pub mod notification_badge;
pub mod perf_trace;
pub mod process_cleanup;
pub mod process_cmd;
mod proxy_config;
mod proxy_spill;
pub mod record;
mod record_analytics;
pub mod recording;
mod resource_signature;
pub mod runtime_launch_guard;
pub mod search;
pub mod session_goal;
pub mod session_metadata;
pub mod session_tags;
pub mod session_visibility;
mod sidecar;
pub mod space_cloud;
mod space_cloud_mock;
#[path = "../media-worker/src/model_pack_source.rs"]
pub mod speech_model_pack;
mod speech_model_pack_manager;
pub mod speech_recognition;
mod sse_proxy;
pub mod system_binary;
pub mod task;
pub mod task_application;
pub mod task_execution;
pub mod task_scheduler;
pub mod task_trigger;
pub mod terminal;
pub mod thought;
mod tray;
mod updater;
pub mod utils;
pub mod wake_lock;
mod webview_policy;
pub mod workspace_files;
mod workspace_path;

use sidecar::{
    begin_app_exit_shutdown, cleanup_stale_sidecars, cleanup_stale_sidecars_preamble,
    create_sidecar_state, init_startup_cleanup_barrier, recover_proxy_spills_after_startup_cleanup,
    stop_all_sidecars,
};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{
    utils::config::Color, webview::PageLoadEvent, Emitter, Listener, Manager, Theme, Url,
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(target_os = "macos")]
const MAIN_TRAFFIC_LIGHT_X: f64 = 15.0;
#[cfg(target_os = "macos")]
const MAIN_TRAFFIC_LIGHT_Y: f64 = 20.0;

// Note: lib.rs is the crate root, so `#[macro_export]` macros (ulog_info!,
// ulog_error!, etc.) are already in scope here without `use`. Importing them
// would cause E0255 "name defined multiple times".

/// Check if CLI arguments indicate CLI mode (delegates to cli module).
pub fn is_cli_mode(args: &[String]) -> bool {
    cli::is_cli_mode(args)
}

/// Run in CLI mode — forward args to the Bun CLI script and return exit code.
pub fn run_cli(args: &[String]) -> i32 {
    cli::run(args)
}

/// What the main-window `on_navigation` guard should do with a navigation.
#[derive(Debug, PartialEq, Eq)]
enum NavDecision {
    /// Let the navigation proceed in the webview.
    Allow,
    /// Cancel it and hand the URL to the OS default browser.
    OpenExternally,
    /// Cancel it silently (disallowed scheme — potential attack vector).
    BlockSilently,
}

// Native startup surface only. The canonical values remain the Theme's
// `--paper` tokens in myagents-default.css; the unit guard below fails if this
// platform projection drifts. Keeping the surface to one flat token avoids
// duplicating the actual Theme palette or material system in Rust.
const THEME_BOOTSTRAP_LIGHT_PAPER: Color = Color(250, 246, 238, 255);
const THEME_BOOTSTRAP_DARK_PAPER: Color = Color(26, 22, 20, 255);
const THEME_BOOTSTRAP_APPEARANCE_MARKER: &str = "__MYAGENTS_APPEARANCE_MODE__";
const THEME_BOOTSTRAP_RUN_ID_MARKER: &str = "__MYAGENTS_BOOTSTRAP_RUN_ID__";
const THEME_BOOTSTRAP_WINDOW_LABEL_MARKER: &str = "__MYAGENTS_WINDOW_LABEL__";
const THEME_BOOTSTRAP_SCRIPT_TEMPLATE: &str =
    include_str!("../../src/renderer/theme/native-bootstrap-script.js");

fn theme_bootstrap_paper(theme: Theme) -> Color {
    match theme {
        Theme::Dark => THEME_BOOTSTRAP_DARK_PAPER,
        Theme::Light => THEME_BOOTSTRAP_LIGHT_PAPER,
        _ => THEME_BOOTSTRAP_LIGHT_PAPER,
    }
}

fn theme_bootstrap_script(
    selection: &config_io::ThemeBootstrapSelection,
    bootstrap_run_id: &str,
    window_label: &str,
) -> String {
    // Theme ID validity is renderer-registry knowledge. Preserve the resolved
    // ID previously published by ThemeRuntime instead of letting an unknown
    // durable ID bypass whole-package fallback on the next pre-React frame.
    // With no explicit trustworthy snapshot, the compiled product default is
    // used; canonical CSS still supplies the structural pre-React fallback.
    let appearance_mode = serde_json::to_string(&selection.appearance_mode)
        .unwrap_or_else(|_| "\"system\"".to_owned());
    let run_id = serde_json::to_string(bootstrap_run_id).unwrap_or_else(|_| "\"\"".to_owned());
    let window_label =
        serde_json::to_string(window_label).unwrap_or_else(|_| "\"unknown\"".to_owned());
    THEME_BOOTSTRAP_SCRIPT_TEMPLATE
        .replacen(THEME_BOOTSTRAP_APPEARANCE_MARKER, &appearance_mode, 1)
        .replacen(THEME_BOOTSTRAP_RUN_ID_MARKER, &run_id, 1)
        .replacen(THEME_BOOTSTRAP_WINDOW_LABEL_MARKER, &window_label, 1)
}

/// Pure decision for `on_navigation` (Functional Core — unit-tested below;
/// the imperative shell in `setup` does the logging + external-open side
/// effects). Decides per URL scheme/host whether a navigation may proceed.
fn classify_navigation(url: &Url) -> NavDecision {
    let scheme = url.scheme();

    // Tauri-internal schemes: always allow.
    // - tauri / ipc: Tauri 2.x core IPC bridges
    // - asset: tauri-plugin-fs asset serving
    // - myagents-resource / myagents-internal: app's custom protocols
    if matches!(
        scheme,
        "tauri" | "ipc" | "asset" | "myagents-resource" | "myagents-internal"
    ) {
        return NavDecision::Allow;
    }

    // `about:` (about:srcdoc / about:blank): the Generative-UI widget renders
    // its sandbox in an `<iframe sandbox="allow-scripts" srcDoc=...>`, whose
    // document URL is `about:srcdoc`. In the macOS WKWebView `on_navigation`
    // fires for SUB-FRAME navigations too (not just the top frame, contrary to
    // a long-standing assumption here) — so without this branch the widget
    // iframe is blocked into an empty document and renders blank (the
    // desktop-only widget-blank bug; `data:`/`blob:` srcdoc fallbacks hit the
    // same wall). `about:` URLs are safe to allow: a top frame cannot be
    // navigated to attacker-controlled `about:srcdoc` (it has no srcdoc source
    // there) and `about:blank` carries no payload. `data:`/`blob:` deliberately
    // stay blocked below — a top-frame `data:text/html,<script>…` WOULD run
    // attacker HTML in the privileged app origin.
    if scheme == "about" {
        return NavDecision::Allow;
    }

    // http(s): allow only localhost / 127.0.0.1 / tauri.localhost /
    // ipc.localhost. Dev loads from http://localhost:5173, Windows prod from
    // http://tauri.localhost, IPC bridges from http://ipc.localhost. Anything
    // else is external → hand to the OS browser and cancel.
    if scheme == "http" || scheme == "https" {
        let host = url.host_str().unwrap_or("");
        if matches!(
            host,
            "localhost" | "127.0.0.1" | "tauri.localhost" | "ipc.localhost"
        ) {
            return NavDecision::Allow;
        }
        return NavDecision::OpenExternally;
    }

    // mailto / tel: route to OS default handler, cancel nav.
    if matches!(scheme, "mailto" | "tel") {
        return NavDecision::OpenExternally;
    }

    // Everything else (data:, blob:, javascript:, file:, unknown) — block.
    NavDecision::BlockSilently
}

fn should_request_exit_confirmation(code: Option<i32>, confirmed: bool) -> bool {
    code != Some(tauri::RESTART_EXIT_CODE) && !confirmed
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── DIAGNOSTIC PANIC HOOK (April 2026 crash investigation) ─────────────
    // Install BEFORE any other init so we capture every panic, including
    // setup-time / did_finish_launching ones that don't reach the unified
    // logger. Writes to ~/.myagents/logs/panic-{pid}-{timestamp}.log so a
    // post-mortem has the actual panic message even when the app aborts
    // before normal log flush.
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let log_dir = app_dirs::myagents_data_dir()
                .map(|d| d.join("logs"))
                .unwrap_or_else(|| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&log_dir);
            let pid = std::process::id();
            let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
            let path = log_dir.join(format!("panic-{}-{}.log", pid, ts));
            let backtrace = std::backtrace::Backtrace::force_capture();
            let payload = format!(
                "TIME: {}\nPID: {}\nINFO: {}\nLOCATION: {:?}\n\nBACKTRACE:\n{}\n",
                chrono::Local::now().to_rfc3339(),
                pid,
                info,
                info.location(),
                backtrace,
            );
            let _ = std::fs::write(&path, &payload);
            // Also try to print to stderr as a fallback
            eprintln!("[PANIC-HOOK] wrote {}", path.display());
            eprintln!("{}", payload);
            prev(info);
        }));
    }

    // NOTE: cleanup_stale_sidecars() was moved into .setup() callback below.
    // This ensures it only runs for the PRIMARY app instance, not when a second
    // instance is launched (which would kill the running app's sidecar processes).
    // The single-instance plugin exits the second process before .setup() is called.

    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();

    // Create IM Bot managed state
    let im_bot_state = im::create_im_bot_state();
    // Create Agent managed state (v0.1.41)
    let agent_state = im::create_agent_state();
    let sidecar_state_for_exit = sidecar_state.clone();
    let sidecar_state_for_monitor = sidecar_state.clone();
    let sidecar_state_for_session_monitor = sidecar_state.clone();
    let sidecar_state_for_wakelock_monitor = sidecar_state.clone();
    let sidecar_state_for_terminal_forwarder = sidecar_state.clone();

    let im_state_for_management = im_bot_state.clone();
    let agent_state_for_management = agent_state.clone();
    let sidecar_state_for_management = sidecar_state.clone();
    let im_state_for_exit = im_bot_state.clone();
    let agent_state_for_exit = agent_state.clone();

    // App-owned cleanup is performed exactly once by the app exit lifecycle.
    // Monitor tasks only observe the same flag so they can stop promptly.
    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_done_for_exit = cleanup_done.clone();
    let cleanup_done_for_monitor = cleanup_done.clone();
    let cleanup_done_for_session_monitor = cleanup_done.clone();
    let cleanup_done_for_wakelock_monitor = cleanup_done.clone();
    let cleanup_done_for_agent_monitor = cleanup_done.clone();
    let cleanup_done_for_terminal_forwarder = cleanup_done.clone();
    let frontend_exit_confirmed = Arc::new(AtomicBool::new(false));
    let frontend_exit_confirmed_for_setup = frontend_exit_confirmed.clone();
    let frontend_exit_confirmed_for_exit = frontend_exit_confirmed.clone();

    // Create terminal manager state
    let terminal_state = terminal::TerminalManager::new();
    let terminal_state_for_exit = terminal_state.clone();

    // Create browser manager state
    let browser_state = browser::BrowserManager::new();
    let browser_state_for_exit = browser_state.clone();

    // RecordStore is the sole authority for both canonical Records and the
    // legacy Thought compatibility surface. Its startup adapter migrates old
    // Thought files before the in-memory snapshot becomes visible.
    let data_dir = app_dirs::myagents_data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let record_state: record::ManagedRecordStore = Arc::new(record::RecordStore::new(
        data_dir.join("records"),
        Some(data_dir.join("thoughts")),
    ));
    record::set_record_store(record_state.clone());
    let recording_state = recording::RecordingManager::new(record_state.clone());
    let recording_state_for_exit = recording_state.clone();
    let task_state: task::ManagedTaskStore = Arc::new(task::TaskStore::new(data_dir.clone()));
    // Expose the same Arcs via OnceLock singletons so the Rust Management API
    // (used by Bun CLI bridge → /api/admin/task/*) can read/write tasks without
    // access to Tauri `State`. They point at the same inner store.
    task::set_task_store(task_state.clone());

    // Create SSE proxy state
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());
    let proxy_spill_state = Arc::new(proxy_spill::ProxySpillManager::new(data_dir.join("refs")));
    let app_route_queue = app_route::create_queue();
    let app_route_queue_for_single_instance = app_route_queue.clone();
    let notification_center = space_cloud::notifications::create_state(task_state.clone());
    let notification_center_for_window_events = notification_center.clone();

    // Build the app first, then run with event handler
    // This allows us to handle RunEvent::ExitRequested for Cmd+Q and Dock quit
    let builder = tauri::Builder::default()
        // Builder-level menu event handler (canonical Tauri 2 pattern).
        // Routes Window > Close Tab (Cmd+W accelerator + mouse click) to the
        // frontend, which walks its own overlay/tab close hierarchy.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "cmd-w-close" {
                if let Err(e) = app.emit("window:cmd-w", ()) {
                    ulog_warn!("[App] Cmd+W emit failed: {}", e);
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol("myagents-resource", attachment_protocol::handle)
        // Historical WebView-only compatibility. OS deep links are parsed by
        // app_route and reject these authorities.
        .register_asynchronous_uri_scheme_protocol("myagents", attachment_protocol::handle)
        .plugin(tauri_plugin_single_instance::init(
            move |app, args, _cwd| {
                // Another instance was launched — bring the existing window to the
                // foreground. Reuses the same routine as tray click and toast click
                // so all three "raise window" entry points stay in lockstep.
                ulog_info!("[App] single-instance activation, showing main window");
                tray::show_main_window(app);
                app_route::enqueue_from_args(app, &app_route_queue_for_single_instance, &args);
            },
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(global_shortcut::build_plugin());

    // Tauri 2.11 wires WKWebView's web-content-process termination callback.
    // Recover only after WebKit confirms that the renderer process is gone;
    // ordinary macOS wake/resume must preserve the healthy page and its local
    // draft state without an unconditional reload.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        let label = webview.label();
        ulog_warn!(
            "[WebView] content process terminated for '{}'; reloading from authoritative session state",
            label
        );
        if let Err(error) = webview.reload() {
            ulog_error!(
                "[WebView] failed to reload '{}' after content process termination: {}",
                label,
                error
            );
        }
    });

    // Floating ball panels need the NSPanel plugin (macOS only).
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    let app = builder
        .manage(sidecar_state)
        .manage(sse_proxy_state)
        .manage(proxy_spill_state)
        .manage(im_bot_state)
        .manage(agent_state)
        .manage(terminal_state)
        .manage(browser_state)
        .manage(record_state)
        .manage(recording_state)
        .manage(task_state)
        .manage(app_route_queue)
        .manage(notification_center)
        // PRD 0.2.35 — global force-wake-lock holder. `setup_tray` later registers
        // `TrayMenuHandles` for the matching CheckMenuItem; the boot hydrate
        // runs after both so they start coherent.
        .manage(wake_lock::ForceWakeLockState::default())
        // PRD 0.2.7 Phase D: per-process registry of active workspace
        // filesystem watchers (one debouncer per workspace, ref-counted).
        .manage(std::sync::Arc::new(workspace_files::watcher::WorkspaceWatchers::default()))
        // SearchEngine will be added as managed state in .setup()
        .invoke_handler(tauri::generate_handler![
            // Legacy commands (backward compatibility)
            commands::cmd_start_sidecar,
            commands::cmd_stop_sidecar,
            commands::cmd_get_sidecar_status,
            commands::cmd_get_server_url,
            commands::cmd_restart_sidecar,
            commands::cmd_ensure_sidecar_running,
            commands::cmd_check_sidecar_alive,
            // New multi-instance commands
            commands::cmd_start_tab_sidecar,
            commands::cmd_stop_tab_sidecar,
            commands::cmd_get_tab_server_url,
            commands::cmd_get_tab_sidecar_status,
            commands::cmd_start_global_sidecar,
            commands::cmd_get_global_server_url,
            commands::cmd_stop_all_sidecars,
            commands::cmd_shutdown_for_update,
            // SSE proxy commands (multi-instance)
            sse_proxy::start_sse_proxy,
            sse_proxy::stop_sse_proxy,
            sse_proxy::stop_all_sse_proxies,
            sse_proxy::session_sidecar_http_request,
            sse_proxy::global_sidecar_http_request,
            sse_proxy::proxy_analytics_http_request,
            browser_resource::cmd_browser_resource_status,
            browser_resource::cmd_browser_resource_install,
            browser_resource::cmd_browser_resource_maintain,
            // Updater commands
            updater::check_and_download_update,
            updater::restart_app,
            updater::test_update_connectivity,
            updater::check_pending_update,
            updater::install_pending_update,
            // Platform & device info
            commands::cmd_get_platform,
            commands::cmd_get_device_id,
            commands::cmd_get_device_identity,
            logger::cmd_record_renderer_boot_event,
            i18n::cmd_get_ui_language_state,
            i18n::cmd_sync_ui_language_from_config,
            i18n::cmd_set_ui_language,
            // Bundled workspace initialization
            commands::cmd_initialize_bundled_workspace,
            commands::cmd_create_bot_workspace,
            commands::cmd_remove_bot_workspace,
            // Agent Runtime detection (v0.1.59)
            commands::cmd_detect_runtimes,
            managed_codex::cmd_managed_codex_status,
            managed_codex::cmd_managed_codex_download,
            managed_codex::cmd_managed_codex_check_update,
            managed_codex::cmd_managed_codex_login_start,
            managed_codex::cmd_managed_codex_login_status,
            managed_codex::cmd_managed_codex_login,
            managed_codex::cmd_managed_codex_logout,
            speech_recognition::cmd_speech_model_pack_status,
            speech_recognition::cmd_speech_model_pack_install,
            speech_recognition::cmd_speech_model_pack_remove,
            speech_recognition::cmd_speech_record_transcribe,
            grok_auth::cmd_grok_auth_status,
            grok_auth::cmd_grok_login_start,
            grok_auth::cmd_grok_login_status,
            grok_auth::cmd_grok_login_cancel,
            grok_auth::cmd_grok_verify_account,
            grok_auth::cmd_grok_fetch_models,
            grok_auth::cmd_grok_logout,
            tokendance::cmd_tokendance_auth_open,
            tokendance::cmd_tokendance_auth_status,
            tokendance::cmd_tokendance_auth_close,
            tokendance::cmd_tokendance_auth_retry_save,
            tokendance::cmd_tokendance_balance,
            tokendance::cmd_tokendance_payment,
            tokendance::cmd_tokendance_prepare_payment_request,
            tokendance::cmd_tokendance_cancel_payment_request,
            // Workspace template commands
            commands::cmd_create_workspace_from_template,
            commands::cmd_create_workspace_from_bundled_template,
            commands::cmd_template_apply_preview,
            commands::cmd_apply_template_to_workspace,
            commands::cmd_copy_folder_to_templates,
            commands::cmd_remove_template_folder,
            // Admin agent sync
            commands::cmd_sync_admin_agent,
            // Product-owned system Skill sync (including task discussion).
            commands::cmd_sync_system_skills,
            memory_evolution::cmd_configure_memory_evolution_tasks,
            memory_evolution::cmd_get_memory_evolution_status,
            memory_auto_update::cmd_configure_memory_auto_update_task,
            // Cron task commands
            cron_task::commands::cmd_create_cron_task,
            cron_task::commands::cmd_start_cron_task,
            cron_task::commands::cmd_stop_cron_task,
            cron_task::commands::cmd_delete_cron_task,
            cron_task::commands::cmd_get_cron_task,
            cron_task::commands::cmd_get_cron_tasks,
            cron_task::commands::cmd_get_unmigrated_legacy_cron_tasks,
            cron_task::commands::cmd_get_workspace_cron_tasks,
            session_metadata::cmd_list_session_metadata,
            cron_task::commands::cmd_get_session_cron_task,
            session_goal::commands::cmd_create_session_goal,
            session_goal::commands::cmd_get_session_goal,
            session_goal::commands::cmd_pause_session_goal,
            session_goal::commands::cmd_resume_session_goal,
            session_goal::commands::cmd_mark_session_goal_terminal,
            session_goal::commands::cmd_get_user_scheduler_lifecycle_snapshot,
            cron_task::commands::cmd_is_task_executing,
            cron_task::commands::cmd_get_cron_runs,
            cron_task::commands::cmd_update_cron_task_fields,
            // Session owner reconciliation
            sidecar::commands::cmd_reconcile_session_tab_activation,
            // Session Inbox cross-sidecar delivery (PRD 0.2.18)
            crate::inbox::deliver::cmd_inbox_deliver,
            // Session-centric Sidecar API (v0.1.11)
            sidecar::session_lifecycle::cmd_ensure_session_sidecar,
            sidecar::session_lifecycle::cmd_release_session_sidecar,
            sidecar::session_lifecycle::cmd_get_session_port,
            sidecar::session_lifecycle::cmd_has_session_sidecar,
            sidecar::session_lifecycle::cmd_get_session_generation,
            sidecar::session_lifecycle::cmd_upgrade_session_id,
            sidecar::session_lifecycle::cmd_session_has_persistent_owners,
            sidecar::session_lifecycle::cmd_delete_session_if_unowned,
            sidecar::session_lifecycle::cmd_release_tab_session,
            sidecar::runtime_identity::cmd_can_restore_session,
            // Background session completion
            sidecar::background::cmd_start_background_completion,
            sidecar::background::cmd_cancel_background_completion,
            sidecar::background::cmd_get_background_sessions,
            // Proxy hot-reload
            sidecar::proxy::cmd_propagate_proxy,
            // Global shortcut (summon-or-toggle, PRD 0.2.16)
            global_shortcut::cmd_get_global_summon_shortcut,
            global_shortcut::cmd_set_global_summon_shortcut,
            // Floating ball desktop companion (PRD 0.2.35)
            floating_ball::cmd_fb_enable,
            floating_ball::cmd_fb_disable,
            floating_ball::cmd_fb_capabilities,
            floating_ball_pets::cmd_fb_pet_list_installed,
            floating_ball_pets::cmd_fb_pet_delete_installed,
            floating_ball_pets::cmd_fb_pet_import_path,
            floating_ball_pets::cmd_fb_pet_import_codex,
            floating_ball_pets::cmd_fb_pet_import_petdex,
            floating_ball::cmd_fb_show_companion,
            floating_ball::cmd_fb_pin_companion,
            floating_ball::cmd_fb_hide_companion,
            floating_ball::cmd_fb_shield_dismiss,
            floating_ball::cmd_fb_drag_ball_start,
            floating_ball::cmd_fb_drag_ball_move,
            floating_ball::cmd_fb_drag_ball_end,
            floating_ball::cmd_fb_drag_ball_cancel,
            floating_ball::cmd_fb_drag_companion_start,
            floating_ball::cmd_fb_drag_companion_move,
            floating_ball::cmd_fb_drag_companion_end,
            floating_ball::cmd_fb_move_ball_to,
            floating_ball::cmd_fb_snap_ball,
            floating_ball::cmd_fb_move_companion_to,
            floating_ball::cmd_fb_set_companion_size,
            floating_ball::cmd_fb_capture_context,
            floating_ball::cmd_fb_ax_status,
            floating_ball::cmd_fb_screenshot,
            floating_ball::cmd_fb_relay,
            floating_ball::cmd_fb_open_main_with_session,
            floating_ball::cmd_fb_open_desktop_pet_settings,
            // OS notification + click-to-foreground deep-link (v0.2.14)
            notification::cmd_show_notification,
            notification::cmd_request_notification_permission,
            notification_badge::cmd_set_notification_badge,
            app_route::cmd_take_pending_app_route,
            space_cloud::notifications::cmd_notification_get_snapshot,
            space_cloud::notifications::cmd_notification_refresh,
            space_cloud::notifications::cmd_notification_load_more,
            space_cloud::notifications::cmd_notification_mark_read,
            space_cloud::notifications::cmd_notification_mark_all_read,
            space_cloud::notifications::cmd_notification_open_external,
            // IM Bot commands (non-deprecated survivors)
            im::commands::cmd_im_conversations,
            // Group permission commands (v0.1.28)
            im::commands::cmd_approve_group,
            im::commands::cmd_reject_group,
            im::commands::cmd_remove_group,
            // OpenClaw Channel Plugin commands
            im::commands::cmd_install_openclaw_plugin,
            im::commands::cmd_list_openclaw_plugins,
            im::commands::cmd_uninstall_openclaw_plugin,
            im::commands::cmd_restart_channels_using_plugin,
            im::commands::cmd_plugin_qr_login_start,
            im::commands::cmd_plugin_qr_login_wait,
            im::commands::cmd_plugin_restart_gateway,
            im::credential_provisioning::cmd_channel_credential_qr_start,
            im::credential_provisioning::cmd_channel_credential_qr_poll,
            // Agent commands (v0.1.41)
            im::commands::cmd_start_agent_channel,
            im::commands::cmd_stop_agent_channel,
            im::commands::cmd_agent_channel_status,
            im::commands::cmd_agent_status,
            im::commands::cmd_all_agents_status,
            im::commands::cmd_update_agent_config,
            // Session ↔ channel surface handover (PRD 0.2.14)
            im::handover::cmd_session_new_with_surface_migration,
            im::handover::cmd_handover_session_to_channel,
            // WeCom QR code commands (public API, not plugin gateway)
            commands::cmd_wecom_qr_generate,
            commands::cmd_wecom_qr_poll,
            // Network diagnostics
            commands::cmd_probe_provider_network,
            commands::cmd_probe_proxy,
            // Model discovery
            commands::cmd_fetch_provider_models,
            // Terminal commands (embedded PTY)
            terminal::cmd_terminal_create,
            terminal::cmd_terminal_write,
            terminal::cmd_terminal_resize,
            terminal::cmd_terminal_close,
            // Browser commands (embedded webview)
            browser::cmd_browser_create,
            browser::cmd_browser_navigate,
            browser::cmd_browser_go_back,
            browser::cmd_browser_go_forward,
            browser::cmd_browser_reload,
            browser::cmd_browser_resize,
            browser::cmd_browser_show,
            browser::cmd_browser_hide,
            browser::cmd_browser_close,
            // File utility commands
            commands::cmd_read_workspace_file,
            commands::cmd_write_workspace_file,
            commands::cmd_delete_workspace_file,
            commands::cmd_read_file_base64,
            commands::cmd_open_file,
            config_io::cmd_fsync_path,
            // Workspace file IO (workspace_files module).
            // Phase A (input-box unification): files_b64 / transfer / gitignore /
            //   search / delete / slash.
            // Phase D (DirectoryPanel migration): tree / read_preview / download /
            //   crud / system_open / git_branch / watcher.
            //
            // These replace sidecar HTTP endpoints (/api/files/*, /agent/*,
            // /api/commands, /api/git/branch). See PRD 0.2.7.
            //
            // tauri::generate_handler! resolves auto-generated `__cmd__<name>` wrappers
            // from the same module that defined the command, so we MUST use the
            // submodule path (e.g. `workspace_files::files_b64::cmd_…`), not the
            // re-export at the parent module level.
            workspace_files::files_b64::cmd_workspace_import_files_b64,
            workspace_files::files_b64::cmd_workspace_read_files_b64,
            workspace_files::user_attachments::cmd_prepare_user_image_attachments,
            workspace_files::check_paths::cmd_workspace_check_paths,
            workspace_files::check_paths::cmd_check_local_paths,
            workspace_files::transfer::cmd_workspace_copy_paths,
            workspace_files::transfer::cmd_workspace_copy_internal,
            workspace_files::gitignore::cmd_workspace_add_gitignore,
            workspace_files::memory_rules::cmd_ensure_memory_rule_substrate,
            workspace_files::memory_rules::cmd_ensure_update_memory_file,
            workspace_files::search::cmd_workspace_search_files_fuzzy,
            workspace_files::delete::cmd_workspace_delete,
            workspace_files::slash::cmd_list_slash_commands,
            workspace_files::tree::cmd_workspace_dir_tree,
            workspace_files::tree::cmd_workspace_dir_expand,
            workspace_files::read_preview::cmd_workspace_read_preview,
            workspace_files::read_preview::cmd_read_local_preview,
            workspace_files::download::cmd_workspace_download_file,
            workspace_files::download::cmd_workspace_download_bytes,
            workspace_files::download::cmd_download_local_file,
            workspace_files::download::cmd_download_local_bytes,
            workspace_files::attachment_export::cmd_export_tool_attachment,
            workspace_files::attachment_export::cmd_read_tool_attachment_bytes,
            workspace_files::save_file::cmd_workspace_save_file,
            workspace_files::claude_md::cmd_workspace_read_claude_md,
            workspace_files::claude_md::cmd_workspace_write_claude_md,
            workspace_files::crud::cmd_workspace_new_file,
            workspace_files::crud::cmd_workspace_new_folder,
            workspace_files::crud::cmd_workspace_rename,
            workspace_files::crud::cmd_workspace_move,
            workspace_files::system_open::cmd_workspace_open_in_finder,
            workspace_files::system_open::cmd_workspace_open_with_default,
            workspace_files::system_open::cmd_open_path_external,
            workspace_files::system_open::cmd_open_path_with_default,
            workspace_files::git_branch::cmd_workspace_git_branch,
            workspace_files::watcher::cmd_workspace_watch_start,
            workspace_files::watcher::cmd_workspace_watch_stop,
            // Full-text search commands
            search::cmd_search_sessions,
            search::cmd_search_records,
            search::cmd_search_workspace_files,
            search::cmd_search_index_status,
            search::cmd_invalidate_workspace_index,
            search::cmd_refresh_workspace_index,
            search::cmd_search_thoughts,
            search::cmd_search_tasks,
            // Canonical Record commands.
            record::cmd_record_create,
            record::cmd_record_list,
            record::cmd_record_get,
            record::cmd_record_discussion_context,
            record::cmd_record_transcript,
            record::cmd_record_transcript_delta,
            record::cmd_record_diarization,
            record::cmd_record_rename_speaker,
            record::cmd_record_merge_speakers,
            record::cmd_record_reassign_segment_speaker,
            record::cmd_record_timeline,
            record::cmd_record_add_note,
            record::cmd_record_add_mark,
            record::cmd_record_update_note,
            record::cmd_record_delete_timeline_item,
            record::cmd_record_update_text,
            record::cmd_record_update_audio_metadata,
            record::cmd_record_export_audio,
            record::cmd_record_export_text,
            record::cmd_record_set_archived,
            record::cmd_record_delete,
            record::cmd_record_merge_text,
            record_analytics::cmd_record_analytics_bridge_ready,
            recording::manager::cmd_recording_snapshot,
            recording::manager::cmd_recording_start,
            recording::manager::cmd_recording_pause,
            recording::manager::cmd_recording_resume,
            recording::manager::cmd_recording_set_source_enabled,
            recording::manager::cmd_recording_stop,
            recording::privacy_settings::cmd_open_recording_privacy_settings,
            // Task Center — Thought commands (v0.1.69)
            thought::cmd_thought_create,
            thought::cmd_thought_list,
            thought::cmd_thought_get,
            thought::cmd_thought_update,
            thought::cmd_thought_delete,
            thought::cmd_thought_merge,
            thought::cmd_thought_open_dir,
            thought::cmd_thought_set_archived,
            // Task Center — Task commands (v0.1.69)
            task::cmd_task_create_direct,
            task::cmd_task_create_attached,
            task::cmd_task_list,
            task::cmd_task_get,
            task::cmd_task_trigger_validate,
            task::cmd_task_trigger_test,
            task::cmd_task_check_now,
            task::cmd_task_run_now,
            task::cmd_task_reset_checkpoint,
            task::cmd_task_update,
            task::cmd_task_update_status,
            task::cmd_task_append_session,
            task::cmd_task_list_comments,
            task::cmd_task_get_comment_context,
            task::cmd_task_create_user_comment,
            task::cmd_task_retry_comment,
            task::cmd_task_prepare_discussion,
            task::cmd_task_archive,
            task::cmd_task_delete,
            task::cmd_task_read_doc,
            task::cmd_task_write_doc,
            task::cmd_task_open_docs_dir,
            task::cmd_task_get_run_stats,
            // MyAgents Cloud Space
            space_cloud::cmd_space_get_capability,
            space_cloud::cmd_space_get_session,
            space_cloud::cmd_space_set_active_space,
            space_cloud::cmd_space_auth_start,
            space_cloud::cmd_space_auth_poll,
            space_cloud::cmd_space_auth_ack,
            space_cloud::cmd_space_logout,
            space_cloud::cmd_space_update_profile,
            space_cloud::cmd_space_get_avatar_presets,
            space_cloud::cmd_space_update_space,
            space_cloud::cmd_space_api_request,
            space_cloud::cmd_space_register_agent,
            space_cloud::cmd_space_update_registered_agent,
            space_cloud::cmd_space_update_registered_agent_avatar,
            space_cloud::registered_agents::cmd_space_revoke_registered_agent,
            space_cloud::registered_agents::cmd_space_list_local_agents,
            space_cloud::delivery::cmd_space_poll_dispatches,
            space_cloud::delivery::cmd_space_mark_dispatch_delivered,
            space_cloud::delivery::cmd_space_poll_deliveries,
            space_cloud::delivery::cmd_space_mark_delivery_delivered,
            space_cloud::delivery::cmd_space_wake_connector,
            space_cloud::delivery::cmd_space_process_deliveries_once,
            space_cloud::delivery::cmd_space_process_dispatches_once,
            space_cloud::skills::cmd_space_install_skill,
            space_cloud::skills::cmd_space_cleanup_skill_export_packages,
            space_cloud::skills::cmd_space_export_skill_from_url,
            space_cloud::skills::cmd_space_inspect_skill_source,
            space_cloud::skills::cmd_space_list_local_skills,
            space_cloud::skills::cmd_space_upload_skill,
            space_cloud::tools::cmd_space_publish_tool,
            space_cloud::tools::cmd_space_update_tool,
            space_cloud::attachments::cmd_space_upload_issue_attachments,
            space_cloud::attachments::cmd_space_inspect_attachment_drafts,
            space_cloud::attachments::cmd_space_create_issue_with_attachments,
            space_cloud::attachments::cmd_space_comment_issue_with_attachments,
            space_cloud::cmd_space_download_attachment,
            space_cloud::skills::cmd_space_download_skill_zip,
            // PRD 0.2.35 — global "always-on" wake-lock toggle
            wake_lock::cmd_set_force_wake_lock,
        ])
        .setup(move |app| {
            // Initialize logging before acquire_lock() and cleanup_stale_sidecars()
            // because those paths need a logger backend for log::warn!/info! calls.
            use tauri_plugin_log::{Target, TargetKind};

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    // Builder defaults already contain Stdout + LogDir. Clear
                    // them before declaring our targets or every native record
                    // is dispatched twice (#473).
                    .clear_targets()
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;

            // Initialize global AppHandle for unified logging (IM module etc.)
            logger::init_app_handle(app.handle().clone());

            // Pattern 6: spawn the buffered writer task so subsequent
            // ulog_*! calls go through the bounded mpsc → BufWriter path
            // instead of opening/appending/closing per line. Pre-init
            // calls (extremely early startup) fall back to a synchronous
            // append protected by a mutex.
            logger::init_buffered_writer();
            let analytics_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut milestones = record_analytics::subscribe();
                loop {
                    match milestones.recv().await {
                        Ok(milestone) => {
                            if let Err(error) =
                                analytics_handle.emit(record_analytics::TAURI_EVENT, milestone)
                            {
                                ulog_warn!(
                                    "[analytics] failed to emit Record milestone: {}",
                                    error
                                );
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            ulog_warn!(
                                "[analytics] Record milestone bridge lagged; skipped {} events",
                                skipped
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            let record_store = app.state::<record::ManagedRecordStore>().inner().clone();
            let record_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut changes = record_store.subscribe_changes();
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            if let Err(error) = record_handle.emit("record:changed", change) {
                                ulog_warn!("[record] failed to emit state change: {}", error);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            ulog_warn!(
                                "[record] UI event bridge lagged; skipped {} state changes",
                                skipped
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            let recording_manager = app
                .state::<recording::ManagedRecordingManager>()
                .inner()
                .clone();
            let recording_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut changes = recording_manager.subscribe_changes();
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            tray::set_recording_projection(
                                &recording_handle,
                                change.snapshot.as_ref().map(|snapshot| snapshot.record_id.clone()),
                            );
                            if let Err(error) = recording_handle.emit("recording:changed", change) {
                                ulog_warn!("[recording] failed to emit state change: {}", error);
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            ulog_warn!(
                                "[recording] UI event bridge lagged; skipped {} state changes",
                                skipped
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            // Only users who completed the explicit first install have opted
            // into Browser resources. Future app-locked revisions maintain
            // themselves in the background; a never-installed app stays idle.
            browser_resource::start_automatic_maintenance();
            #[cfg(target_os = "macos")]
            if let Err(error) =
                notification::install_macos_notification_delegate(app.handle())
            {
                ulog_warn!(
                    "[Notification] Failed to install UserNotifications delegate: {}",
                    error
                );
            }
            let notification_center = app
                .state::<space_cloud::notifications::ManagedNotificationCenter>()
                .inner()
                .clone();
            space_cloud::notifications::start(app.handle().clone(), notification_center);
            let deep_link_queue = app.state::<app_route::ManagedAppRouteQueue>().inner().clone();
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    app_route::enqueue_deep_link(
                        &deep_link_handle,
                        &deep_link_queue,
                        url.as_str(),
                    );
                }
                tray::show_main_window(&deep_link_handle);
            });
            match app.deep_link().get_current() {
                Ok(Some(urls)) => {
                    let queue = app.state::<app_route::ManagedAppRouteQueue>().inner().clone();
                    for url in urls {
                        app_route::enqueue_deep_link(app.handle(), &queue, url.as_str());
                    }
                }
                Ok(None) => {}
                Err(error) => ulog_warn!("[AppRoute] failed to inspect startup links: {}", error),
            }
            // The app bundle owns CLI business code. HOME only contains
            // deterministic launchers pointing back to this executable. A
            // failure must not brick the Desktop; Sidecar admission retries
            // this same reconciler and fails closed before any Agent starts.
            tauri::async_runtime::spawn_blocking(|| match cli::ensure_launcher() {
                Ok(true) => ulog_info!("[cli] Reconciled HOME launchers"),
                Ok(false) => ulog_info!("[cli] HOME launchers already current"),
                Err(error) => ulog_error!("[cli] Startup launcher preflight failed: {}", error),
            });
            // Tauri is the only process guaranteed to exist for the whole app
            // lifetime, so it owns shared crash-artifact cleanup. The first
            // sweep handles upgrade backlog without requiring any Sidecar.
            crash_artifact_retention::start_crash_artifact_retention_owner();
            tauri::async_runtime::spawn(grok_auth::reconcile_provider_projection());
            let space_sidecar_state = app.state::<sidecar::ManagedSidecarManager>().inner().clone();
            space_cloud::delivery::start_space_connector(
                app.handle().clone(),
                space_sidecar_state,
            );

            // Main window: programmatic creation so we can attach
            // `on_navigation` to block external top-frame navigation. The
            // native WKWebView context menu's "Open Link" entry triggers a
            // direct top-frame navigation that bypasses React `onClick`
            // handlers — without this gate the entire app gets replaced by
            // the linked page with no way back (bug: right-click → 软件报废).
            //
            // Why programmatic instead of config: Tauri 2.x has no setter for
            // `on_navigation` on an already-created window. So
            // `tauri.conf.json` has `windows: []` and we build here. All other
            // original config is replicated below; macOS traffic-light layout
            // is installed against the built NSWindow after this chain.
            //
            // Order: must be BEFORE macos_arrow_filter::install_arrow_key_filter
            // because the filter looks up the WryWebView ObjC class which is
            // only registered after the first webview is constructed.
            let theme_bootstrap_selection = app_dirs::myagents_data_dir()
                .map(|dir| config_io::read_theme_bootstrap_selection(&dir.join("config.json")))
                .unwrap_or_default();
            let preferred_native_theme = match theme_bootstrap_selection.appearance_mode.as_str() {
                "light" => Some(Theme::Light),
                "dark" => Some(Theme::Dark),
                _ => None,
            };
            // The system scheme is only knowable from the native window after
            // creation. Keep it hidden for those few synchronous instructions,
            // then project the resolved `window.theme()` into the flat startup
            // surface before the first visible frame.
            let initial_paper = preferred_native_theme
                .map(theme_bootstrap_paper)
                .unwrap_or(THEME_BOOTSTRAP_LIGHT_PAPER);
            let theme_bootstrap_run_id = uuid::Uuid::new_v4().to_string();
            let main_window_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::default(),
            )
            .scroll_bar_style(crate::webview_policy::scroll_bar_style())
            .title("MyAgents")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .fullscreen(false)
            .center()
            .decorations(true)
            .visible(false)
            .background_color(initial_paper)
            .initialization_script(theme_bootstrap_script(
                &theme_bootstrap_selection,
                &theme_bootstrap_run_id,
                "main",
            ))
            .on_page_load(|window, payload| {
                let stage = match payload.event() {
                    PageLoadEvent::Started => "native-page-load-started",
                    PageLoadEvent::Finished => "native-page-load-finished",
                };
                ulog_info!(
                    "[boot] stage={} window={} url={}",
                    stage,
                    window.label(),
                    payload.url()
                );
            })
            // `transparent(false)` is the default in Tauri and the setter is
            // gated behind `macos-private-api` on macOS, so we omit it (the
            // original config field was effectively a no-op).
            // `on_navigation` blocks external top-frame navigation. The native
            // WKWebView context menu's "Open Link" entry triggers a direct
            // top-frame navigation that bypasses React `onClick` handlers —
            // without this gate the entire app gets replaced by the linked page
            // with no way back (bug: right-click → 软件报废). NOTE: in this
            // WKWebView the callback ALSO fires for sub-frame (iframe)
            // navigations — so the Generative-UI widget's `about:srcdoc`
            // sandbox iframe must be allowed here too (see classify_navigation).
            .on_navigation(|url: &Url| match classify_navigation(url) {
                NavDecision::Allow => true,
                NavDecision::OpenExternally => {
                    ulog_info!(
                        "[main-window] BLOCKED external nav → system browser: {}",
                        url
                    );
                    browser::spawn_external_open(url.as_str());
                    false
                }
                NavDecision::BlockSilently => {
                    ulog_warn!(
                        "[main-window] BLOCKED nav with scheme {}: {}",
                        url.scheme(),
                        url
                    );
                    false
                }
            });

            // Overlay chrome gets one continuous positioning owner after the
            // NSWindow exists. Do not seed Wry's separate draw-time inset here.
            #[cfg(target_os = "macos")]
            let main_window_builder = main_window_builder
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay);

            let main_window = main_window_builder
                .build()
                .map_err(|e| {
                    ulog_error!("[App] Failed to build main window: {}", e);
                    e
                })?;

            // x=15 gives the native cluster a conventional leading inset and
            // leaves the same optical gap before the fixed toggle slot. The
            // shared sidebar/titlebar surface means the cluster no longer has
            // to stay geometrically centered inside the 64px rail. y=20 keeps
            // the established vertical alignment. Install the owner before
            // the first visible frame.
            #[cfg(target_os = "macos")]
            if let Err(e) = macos_traffic_light::install_native_layout_owner(
                &main_window,
                MAIN_TRAFFIC_LIGHT_X,
                MAIN_TRAFFIC_LIGHT_Y,
            ) {
                ulog_warn!(
                    "[main-window] Failed to install traffic-light layout owner: {}",
                    e
                );
            }

            let resolved_native_theme = preferred_native_theme
                .or_else(|| main_window.theme().ok())
                .unwrap_or(Theme::Light);
            if let Err(error) = main_window
                .set_background_color(Some(theme_bootstrap_paper(resolved_native_theme)))
            {
                ulog_warn!("[main-window] Failed to set Theme startup surface: {}", error);
            }
            main_window.show().map_err(|error| {
                ulog_error!("[main-window] Failed to reveal startup window: {}", error);
                error
            })?;
            if let Err(error) = main_window.set_focus() {
                ulog_warn!("[main-window] Failed to focus startup window: {}", error);
            }

            // macOS WKWebView function-key tofu workaround. Must run AFTER
            // the main window is built so the WryWebView ObjC class is
            // registered with the runtime (the class is created lazily on
            // first webview construction). ObjC method lookup is dynamic, so
            // adding methods here affects the already-created instance before
            // the user can type.
            #[cfg(target_os = "macos")]
            macos_arrow_filter::install_arrow_key_filter();

            // Acquire PID lock — kills any stale instance that macOS auto-restarted
            // (e.g., after build_dev.sh pkill). Must run before cleanup_stale_sidecars
            // so we don't kill sidecars belonging to an instance we're about to replace.
            // The single-instance plugin handles the "user double-clicked" case via IPC;
            // this lock handles the "build script killed + macOS restarted" case via PID.
            let lock_state = app_dirs::acquire_lock();
            let had_prior_instance = lock_state.had_prior_instance();
            let spill_manager = app
                .state::<Arc<proxy_spill::ProxySpillManager>>()
                .inner()
                .clone();

            // Stale sidecar cleanup:
            //   1. Run the fast preamble (remove stale port file) synchronously
            //      so CLI / admin-api see a consistent state immediately.
            //   2. Hoist the heavy scan onto a blocking worker. Previously this
            //      ran synchronously on the main thread and blocked Tauri
            //      `setup()` for 5–15 s on Windows (PowerShell/WMI cold
            //      start × 6 patterns), which directly caused the
            //      "frontend freezes on first launch" user report. The new
            //      `process_cleanup` module uses native `sysinfo` (no
            //      subprocess spawn) and completes in ~10–200 ms.
            //   3. Only after every prior writer is confirmed stopped, run
            //      the one startup ref inventory. Sidecar birth waits on the
            //      same barrier, so a new Node writer cannot race the scan.
            //   4. Cleanup residual/panic leaves proxy inventory incomplete
            //      and Rust spill fail-closed for this run. No runtime rescan
            //      is allowed because it could delete a live Node `.part`.
            init_startup_cleanup_barrier();
            cleanup_stale_sidecars_preamble();
            tauri::async_runtime::spawn(async move {
                let cleanup_result = tauri::async_runtime::spawn_blocking(move || {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        cleanup_stale_sidecars(had_prior_instance)
                    }))
                })
                .await;

                let writers_quiesced = match cleanup_result {
                    Ok(Ok(writers_quiesced)) => writers_quiesced,
                    Ok(Err(panic)) => {
                        let msg = panic
                            .downcast_ref::<&'static str>()
                            .map(|s| s.to_string())
                            .or_else(|| panic.downcast_ref::<String>().cloned())
                            .unwrap_or_else(|| "<non-string panic payload>".to_string());
                        ulog_error!(
                            "[sidecar] cleanup_stale_sidecars panicked: {} — proxy spill remains fail-closed",
                            msg
                        );
                        false
                    }
                    Err(error) => {
                        ulog_error!(
                            "[sidecar] cleanup_stale_sidecars worker failed: {} — proxy spill remains fail-closed",
                            error
                        );
                        false
                    }
                };

                match recover_proxy_spills_after_startup_cleanup(
                    spill_manager.as_ref(),
                    writers_quiesced,
                )
                .await
                {
                    Ok(removed) if removed > 0 => {
                        ulog_info!("[proxy] Removed {} incomplete ref files at startup", removed)
                    }
                    Ok(_) => {}
                    Err(error) => ulog_warn!("{}", error),
                }

                // The process-start barrier is always released. On failure,
                // the separate proxy inventory fact remains false, so only
                // Rust spill admission is denied for this run.
                sidecar::mark_startup_cleanup_done();
            });

            // ── Boot Banner: single-line consolidated diagnostics for AI grep ──
            {
                let pkg = app.package_info();
                let version = pkg.version.to_string();
                let build_mode = if cfg!(debug_assertions) { "debug" } else { "release" };
                let os = std::env::consts::OS;
                let arch = std::env::consts::ARCH;
                let data_dir = app_dirs::myagents_data_dir();
                let dir_str = data_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "?".into());

                // Read config.json for counts (best-effort)
                let (mut provider, mut mcp, mut agents, mut channels, mut scheduled_tasks, mut proxy) =
                    ("?".to_string(), 0u32, 0u32, 0u32, 0u32, false);
                if let Some(ref dir) = data_dir {
                    if let Ok(c) = std::fs::read_to_string(dir.join("config.json"))
                        .ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).ok_or(()) {
                        // won't reach — see below
                        let _ = c;
                    }
                    // Simpler: parse as Value directly. strip_bom tolerates a
                    // Windows-editor-prepended UTF-8 BOM (issue #170 #6) so the
                    // boot log reflects real config values instead of "?".
                    if let Ok(cfg) = std::fs::read_to_string(dir.join("config.json"))
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&s)).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))) {
                        provider = cfg.get("defaultProviderId").and_then(|v| v.as_str()).unwrap_or("none").to_string();
                        mcp = cfg.get("mcpEnabledServers").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0);
                        if let Some(ags) = cfg.get("agents").and_then(|v| v.as_array()) {
                            agents = ags.len() as u32;
                            for a in ags { channels += a.get("channels").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0); }
                        }
                        proxy = cfg.get("proxySettings").and_then(|v| v.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
                    }
                    if let Ok(s) = std::fs::read_to_string(dir.join("tasks.jsonl")) {
                        scheduled_tasks = crate::utils::bom::strip_bom(&s)
                            .lines()
                            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                            .filter(|task| {
                                task.get("status").and_then(|value| value.as_str()) == Some("running")
                                    && matches!(
                                        task.get("executionMode").and_then(|value| value.as_str()),
                                        Some("scheduled" | "recurring")
                                    )
                            })
                            .count() as u32;
                    }
                }

                ulog_info!("[boot] v={} build={} os={}-{} provider={} mcp={} agents={} channels={} scheduled_tasks={} proxy={} dir={}", version, build_mode, os, arch, provider, mcp, agents, channels, scheduled_tasks, proxy, dir_str);
            }

            // Setup system tray. setup_tray() ALSO registers `TrayMenuHandles` as
            // app state — `wake_lock::init_from_disk` below depends on it being
            // present so the initial tray check matches the OS lock.
            if let Err(e) = tray::setup_tray(app) {
                ulog_error!("[App] Failed to setup system tray: {}", e);
            }

            // PRD 0.2.35 — boot-time hydrate the user's force wake-lock intent
            // from disk. If `forceWakeLock: true`, acquire the OS assertion now.
            // Disk → OS lock; the tray's initial `checked` was set inside
            // setup_tray() reading the same field. Crash / kill releases the
            // assertion automatically (process-bound API).
            wake_lock::init_from_disk(app.handle());

            // Register global summon shortcut from config (PRD 0.2.16).
            // Failures are non-fatal — they surface in the Settings panel.
            global_shortcut::setup_on_startup(app.handle());

            // Frontend confirms exit (from X button → ConfirmDialog → "退出" button).
            // Delegate to `AppHandle::exit(0)` and let `RunEvent::ExitRequested` run
            // cleanup on the main run-loop thread. Running cleanup inline here would
            // deadlock/panic: this callback fires from within the `plugin:event|emit`
            // async command (a Tokio worker), and `tauri::async_runtime::block_on`
            // inside a Tokio worker panics with "Cannot start a runtime from within
            // a runtime" — the panic is swallowed and `exit(0)` never runs, which is
            // why X-button close silently failed before.
            let app_handle_for_tray = app.handle().clone();
            app.listen("tray:confirm-exit", move |_| {
                ulog_info!("[App] Frontend confirmed exit, delegating to run-loop cleanup");
                frontend_exit_confirmed_for_setup
                    .store(true, std::sync::atomic::Ordering::Release);
                app_handle_for_tray.exit(0);
            });

            // Open DevTools in debug builds
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // macOS: Custom menu — replace native "Close Window" (Cmd+W) with a custom
            // menu item that emits window:cmd-w to the frontend. This separates the
            // Cmd+W path (overlay → tab → launcher → stop) from the X button path
            // (CloseRequested → tray/exit). Without this, Cmd+W triggers CloseRequested
            // which hides the window before JS can handle it.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem, WINDOW_SUBMENU_ID};

                let app_name = app.package_info().name.clone();
                let app_handle = app.handle();

                let close_tab = MenuItemBuilder::with_id("cmd-w-close", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app_handle)?;

                let app_menu = SubmenuBuilder::new(app_handle, &app_name)
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                // NOTE: deliberately NO `.select_all()` here. The predefined
                // Select All item registers ⌘A as a menu key-equivalent, which
                // macOS dispatches as the native `selectAll:` selector in
                // `performKeyEquivalent:` — BEFORE the WebView ever delivers a
                // JS `keydown`. Unlike `copy:`/`cut:`/`paste:`/`undo:` (which
                // WebKit translates into DOM clipboard / `beforeinput` events
                // that Monaco listens to), `selectAll:` has no DOM-event
                // equivalent, so Monaco's own ⌘A keybinding never fires and the
                // workspace tree's keyboard ⌘A is pre-empted too. Net effect:
                // ⌘A silently does nothing in every custom WebView editor while
                // "working" by accident only in plain <textarea>/<input> (where
                // WKWebView routes `selectAll:` to the native field).
                //
                // The fix is to leave ⌘A OUT of the native menu so the keydown
                // reaches the WebView — the correct owner — exactly like ⌘T/⌘Y
                // /⌘U/⌘1-9 already do. There Monaco's built-in selectAll, the
                // tree's resolveTreeKeyAction, and WebKit's textarea default all
                // pick it up. Keep cut/copy/paste/undo/redo: those map to DOM
                // events Monaco honours, so removing them would gain nothing and
                // risk the clipboard paths. (Long-standing since the custom menu
                // landed in 11a35a25 / Tauri's default menu before that.)
                let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .build()?;

                // Use `WINDOW_SUBMENU_ID` (the magic Tauri 2 constant) so
                // `init_app_menu` calls `NSApp.setWindowsMenu(menu)` — i.e.
                // marks this submenu as macOS's official Window menu (used
                // for the open-window tracking list, "Bring All to Front",
                // etc.). Tauri's default Window menu uses the same ID; we
                // mirror that pattern when supplying our own.
                let window_menu = SubmenuBuilder::with_id(app_handle, WINDOW_SUBMENU_ID, "Window")
                    .item(&close_tab)
                    .item(&PredefinedMenuItem::minimize(app_handle, None)?)
                    .item(&PredefinedMenuItem::maximize(app_handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app_handle, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app_handle)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&window_menu)
                    .build()?;

                app.set_menu(menu)?;
                // Note: the matching `on_menu_event` handler lives at Builder
                // level at the top of `run()`.
            }

            // Windows: Remove system decorations for custom title bar
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    ulog_info!("[App] Windows: Disabled system decorations for custom title bar");
                }
            }

            // Inject IM/Agent/Sidecar state into management API (for /api/im/wake endpoint etc.)
            management_api::set_im_bots_state(im_state_for_management);
            management_api::set_agent_state(agent_state_for_management);
            management_api::set_sidecar_state(sidecar_state_for_management);

            // The Desktop App owns one global document queue and at most one
            // isolated Worker. Initialize it before the Management API starts
            // so every Sidecar observes the same durable job authority.
            let compute_coordinator = local_inference::LocalComputeCoordinator::new();
            if let Err(error) = local_inference::set_global_compute_coordinator(
                compute_coordinator.clone(),
            ) {
                ulog_error!("[local-inference] Failed to register compute coordinator: {}", error);
            } else {
                app.manage(compute_coordinator.clone());
            }
            match app.path().resource_dir() {
                Ok(resource_dir) => {
                    let resource_dir = sidecar::normalize_external_path(resource_dir);
                    let runtime_registry =
                        local_inference::LocalInferenceRuntimeRegistry::initialize(&resource_dir);
                    if let Err(error) = local_inference::set_global_runtime_registry(
                        runtime_registry.clone(),
                    ) {
                        ulog_error!(
                            "[local-inference] Failed to register runtime registry: {}",
                            error
                        );
                    } else {
                        app.manage(runtime_registry.clone());
                    }
                    match app_dirs::myagents_data_dir() {
                        Some(data_dir) => {
                            match document_processing::DocumentProcessingManager::initialize(
                                data_dir.clone(),
                                resource_dir.clone(),
                                runtime_registry.clone(),
                                compute_coordinator.clone(),
                            ) {
                                Ok(manager) => {
                                    if let Err(error) =
                                        document_processing::set_global(manager.clone())
                                    {
                                        ulog_error!(
                                            "[document] Failed to register manager: {}",
                                            error
                                        );
                                    } else {
                                        app.manage(manager);
                                    }
                                }
                                Err(error) => {
                                    ulog_error!(
                                        "[document] Failed to initialize manager: {}",
                                        error
                                    );
                                }
                            }
                            match speech_recognition::SpeechRecognitionManager::initialize(
                                data_dir,
                                resource_dir,
                                runtime_registry.clone(),
                                compute_coordinator.clone(),
                                record::get_record_store()
                                    .expect("RecordStore initialized before Tauri setup")
                                    .clone(),
                            ) {
                                Ok(manager) => {
                                    if let Err(error) =
                                        speech_recognition::set_global(manager.clone())
                                    {
                                        ulog_error!(
                                            "[speech] Failed to register manager: {}",
                                            error
                                        );
                                    } else {
                                        app.manage(manager);
                                    }
                                }
                                Err(error) => {
                                    ulog_error!(
                                        "[speech] Failed to initialize manager: {}",
                                        error
                                    );
                                }
                            }
                        }
                        None => {
                            ulog_error!(
                                "[document] Failed to resolve private application data directory"
                            );
                        }
                    }
                }
                Err(error) => {
                    ulog_error!("[document] Failed to resolve resource directory: {}", error);
                }
            }

            // Recovery runs after speech registration so a capture that had
            // already admitted live transcription can enqueue its exact
            // permanent-audio backfill. Historical recordings that never
            // started transcription remain untouched.
            let recording_manager = app
                .state::<recording::ManagedRecordingManager>()
                .inner()
                .clone();
            tauri::async_runtime::spawn(async move {
                recording_manager.recover_interrupted().await;
            });

            // Subscribe before automation recovery can create or release a
            // Session Sidecar. The receiver buffers the short gap until its
            // forwarding task starts.
            let terminal_event_rx = match sidecar_state_for_terminal_forwarder.lock() {
                Ok(manager) => Some(manager.subscribe_terminal_events()),
                Err(error) => {
                    ulog_error!(
                        "[sidecar] terminal-event forwarder failed to subscribe: {}",
                        error
                    );
                    None
                }
            };

            // Arm the App-level persisted Session observer before scheduling
            // startup writers. The watcher also emits a broad readiness
            // invalidation after its OS watches and baseline are established,
            // closing the unavoidable background-thread startup interval.
            session_metadata::spawn_session_metadata_watcher(app.handle().clone());

            // Start the internal control plane before any backend automation can
            // create a Sidecar that needs MYAGENTS_MANAGEMENT_PORT.
            let automation_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let port = match management_api::start_management_api().await {
                    Ok(port) => port,
                    Err(error) => {
                        ulog_error!("[App] Failed to start management API: {}", error);
                        return;
                    }
                };
                ulog_info!("[App] Management API started on port {}", port);

                // Startup convergence is intentionally serial: legacy data must
                // become Task authority before timers rebuild, and Goal recovery
                // starts only after the shared control plane/timers are ready.
                cron_task::initialize_cron_manager(automation_app_handle.clone()).await;
                session_goal::initialize_session_goal_manager(automation_app_handle).await;
            });
            ulog_info!("[App] Automation control-plane initialization scheduled");

            // Bridge `SidecarManager::terminal_events` → `session:sidecar-terminal`
            // Tauri event. Renderer's App.tsx listens and resets `tab.sessionId`
            // bindings whose underlying sidecar has been definitively released
            // (no owners remained at removal → no auto-restart will revive it).
            // Without this bridge, voluntary-release leaves stale Tab.sessionId
            // values which `planSessionOpen` then "jump-to-tab"s into → empty
            // UI + sidecar-not-running errors. See `forward_terminal_events_to_renderer`
            // doc-comment for the full rationale.
            //
            // The receiver was subscribed before automation recovery above, so
            // startup removals cannot fall into a no-subscriber gap.
            if let Some(terminal_event_rx) = terminal_event_rx {
                let app_handle_for_terminal_forwarder = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    sidecar::forward_terminal_events_to_renderer(
                        app_handle_for_terminal_forwarder,
                        sidecar_state_for_terminal_forwarder,
                        cleanup_done_for_terminal_forwarder,
                        terminal_event_rx,
                    )
                    .await;
                });
                ulog_info!("[App] Sidecar terminal-event forwarder spawned");
            }

            // Initialize SearchEngine (full-text search)
            if let Some(data_dir) = app_dirs::myagents_data_dir() {
                match search::SearchEngine::new(data_dir) {
                    Ok(engine) => {
                        engine.start_background_indexing(app.handle().clone());
                        app.manage(Arc::new(engine));
                        ulog_info!("[App] SearchEngine initialized");
                    }
                    Err(e) => {
                        ulog_error!("[App] Failed to create SearchEngine: {}", e);
                    }
                }
            }

            // Auto-start IM Bot if previously enabled (3s delay)
            im::schedule_auto_start(app.handle().clone());
            ulog_info!("[App] IM Bot auto-start scheduled");

            // Auto-start Agent channels (4s delay, after IM bots)
            im::schedule_agent_auto_start(app.handle().clone());
            ulog_info!("[App] Agent auto-start scheduled");

            // Floating ball (PRD 0.2.35): bring the ball up at launch when the
            // developer gate + ball toggle are both enabled in config.
            floating_ball::setup_on_startup(app.handle());

            // Start Global Sidecar health monitor
            // Periodically checks if the Global Sidecar is alive and auto-restarts it
            // This prevents the "all network broken" state on Windows when the window
            // is minimized to tray and the OS kills child processes
            let app_handle_for_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_global_sidecar(
                    app_handle_for_monitor,
                    sidecar_state_for_monitor,
                    cleanup_done_for_monitor,
                ).await;
            });
            ulog_info!("[App] Global sidecar health monitor spawned");

            // Start Session Sidecar health monitor (20s initial delay)
            let app_handle_for_session_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_session_sidecars(
                    app_handle_for_session_monitor,
                    sidecar_state_for_session_monitor,
                    cleanup_done_for_session_monitor,
                ).await;
            });
            ulog_info!("[App] Session sidecar health monitor spawned");

            // Start the turn wake-lock monitor: holds a system wake-lock (prevents
            // idle sleep) while ANY sidecar has an in-flight AI turn, so a long
            // interactive/cron turn isn't killed when the Mac idle-sleeps and drops
            // the SDK's HTTPS stream. Cron already had per-execution coverage; this
            // generalizes it to interactive turns. (Pairs with the suspension-aware
            // watchdog, which handles the unpreventable lid-close case.)
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_turn_wake_lock(
                    sidecar_state_for_wakelock_monitor,
                    cleanup_done_for_wakelock_monitor,
                ).await;
            });
            ulog_info!("[App] Turn wake-lock monitor spawned");

            // Start Agent Channel health monitor (15s initial delay)
            let app_handle_for_agent_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                im::monitor_agent_channels(
                    app_handle_for_agent_monitor,
                    cleanup_done_for_agent_monitor,
                ).await;
            });
            ulog_info!("[App] Agent channel health monitor spawned");

            // Start background update check (60s delay, then stale updater temp cleanup)
            ulog_info!("[App] Setup complete, spawning background update check task...");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ulog_info!("[App] Background update task started, waiting 60 seconds before stale Windows updater temp cleanup and update check...");
                updater::check_update_on_startup(app_handle).await;
                ulog_info!("[App] Background update task completed");
            });
            ulog_info!("[App] Background update task spawned successfully");

            // LiteLLM model-data cache: startup conditional check + 24h interval
            // (gated by config.liteLLMModelDataRefresh, default on). Single owner
            // lives in the Tauri process; the sidecar reads the cached file. See
            // litellm_cache.rs.
            tauri::async_runtime::spawn(async move {
                litellm_cache::start_periodic_refresh().await;
            });
            ulog_info!("[App] LiteLLM model-data refresh task spawned");

            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Handle window close request (X button) - minimize to tray instead
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Check if minimize to tray is enabled
                    // Emit event to frontend to check config and decide
                    ulog_info!("[App] Window close requested, emitting event to frontend");
                    let _ = window.emit("window:close-requested", ());
                    // Prevent default close behavior - let frontend decide
                    api.prevent_close();
                }
                tauri::WindowEvent::Focused(focused) => {
                    let label = window.label();
                    if label == "main" || label.starts_with("fb-") {
                        let visible = window.is_visible().unwrap_or(false);
                        ulog_info!(
                            "[App] WindowEvent::Focused label={} focused={} visible={}",
                            label,
                            focused,
                            visible
                        );
                        if label == "fb-companion" {
                            let _ = window.emit(
                                "fb:native-focus",
                                serde_json::json!({
                                    "focused": focused,
                                    "visible": visible,
                                }),
                            );
                        }
                        if label == "main" && *focused {
                            space_cloud::notifications::wake(
                                &notification_center_for_window_events,
                            );
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    // A window owns only its WebView. Auxiliary windows are
                    // routinely destroyed while the application and every
                    // Session Sidecar remain live; app-wide teardown belongs
                    // exclusively to RunEvent::ExitRequested/update shutdown.
                    ulog_info!(
                        "[App] window_lifecycle event=destroyed label={} app_cleanup=false",
                        window.label()
                    );
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to catch Cmd+Q, Dock quit, and Dock click
    app.run(move |_app_handle, event| {
        match event {
            tauri::RunEvent::Ready => {
                if let (Some(runtime_registry), Some(compute_coordinator)) = (
                    local_inference::global_runtime_registry(),
                    local_inference::global_compute_coordinator(),
                ) {
                    runtime_registry
                        .start_background_verification(Arc::clone(compute_coordinator));
                }
                if let Some(manager) = document_processing::global() {
                    manager.start_background_resource_validation();
                }
                if let Some(manager) = speech_recognition::global() {
                    manager.start_background_resource_validation();
                }
            }
            // Handle app exit events (Cmd+Q, Dock right-click quit, etc.)
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if should_request_exit_confirmation(
                    code,
                    frontend_exit_confirmed_for_exit
                        .load(std::sync::atomic::Ordering::Acquire),
                ) {
                    api.prevent_exit();
                    tray::show_main_window(_app_handle);
                    if let Err(error) = _app_handle.emit("tray:exit-requested", ()) {
                        ulog_error!(
                            "[App] failed to route native exit request to the frontend: {}",
                            error
                        );
                    }
                    return;
                }
                if let Err(error) = tauri::async_runtime::block_on(
                    recording_state_for_exit.stop_for_app_exit(),
                ) {
                    ulog_error!(
                        "[recording] app exit blocked because capture finalization is not durable: {}",
                        error
                    );
                    api.prevent_exit();
                    return;
                }
                // Only cleanup once (Relaxed is sufficient for simple flag)
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_exit.swap(true, Relaxed) {
                    let shutdown_reason = if code == Some(tauri::RESTART_EXIT_CODE) {
                        "app-restart"
                    } else {
                        "app-exit"
                    };
                    ulog_info!(
                        "[App] app_lifecycle event=exit_requested code={:?} reason={} app_cleanup=begin",
                        code,
                        shutdown_reason
                    );
                    // Close birth admission before draining owner registries.
                    // Every admitted creation lease spans process/resource
                    // birth through managed-state registration, so this wait
                    // prevents a late ChildTree from appearing after the
                    // termination settlement barrier.
                    let creation_gate_ok = match begin_app_exit_shutdown() {
                        Ok(()) => true,
                        Err(error) => {
                            ulog_error!(
                                "[App] app_lifecycle cleanup=creation_gate status=error reason={} error={}",
                                shutdown_reason,
                                error
                            );
                            false
                        }
                    };
                    if let Some(manager) = document_processing::global() {
                        if let Err(error) = manager.shutdown() {
                            ulog_error!(
                                "[document] shutdown failed reason={} error={}",
                                shutdown_reason,
                                error
                            );
                        }
                    }
                    if let Some(manager) = speech_recognition::global() {
                        if let Err(error) = manager.shutdown() {
                            ulog_error!(
                                "[speech] shutdown failed reason={} error={}",
                                shutdown_reason,
                                error
                            );
                        }
                    }
                    // Record a deliberate-quit marker so the next boot starts
                    // fresh instead of restoring the session (Issue #309), UNLESS
                    // this is an update-restart. Both update paths — plugin
                    // `relaunch()` and `AppHandle::request_restart` — fire ExitRequested
                    // with `code == RESTART_EXIT_CODE`; a deliberate quit carries
                    // `None` (Cmd+Q / Dock) or `Some(0)` (tray "Exit"). Gating on
                    // the code keeps "offer restore after an update" working on
                    // every platform/path without a forgettable flag.
                    app_dirs::record_clean_exit(code == Some(tauri::RESTART_EXIT_CODE));
                    im::signal_all_agents_shutdown(&agent_state_for_exit);
                    im::signal_all_bots_shutdown(&im_state_for_exit);
                    tauri::async_runtime::block_on(
                        task_scheduler::get_task_scheduler().shutdown_all(),
                    );
                    let sidecar_cleanup_ok = match stop_all_sidecars(
                        &sidecar_state_for_exit,
                        shutdown_reason,
                    ) {
                        Ok(()) => true,
                        Err(error) => {
                            ulog_error!(
                                "[App] app_lifecycle cleanup=sidecars status=error reason={} error={}",
                                shutdown_reason,
                                error
                            );
                            false
                        }
                    };
                    process_cmd::settle_pending_tree_terminations();
                    // Clean up terminal PTY sessions
                    let ts = terminal_state_for_exit.clone();
                    tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                    // Clean up browser webviews
                    let bs = browser_state_for_exit.clone();
                    tauri::async_runtime::block_on(browser::close_all_browsers(&bs, _app_handle));
                    app_dirs::release_lock();
                    ulog_info!(
                        "[App] app_lifecycle event=cleanup_complete reason={} creation_gate_ok={} sidecars_ok={}",
                        shutdown_reason,
                        creation_gate_ok,
                        sidecar_cleanup_ok
                    );
                }
            }
            // Handle Dock icon click on macOS (Reopen event)
            // This is triggered when user clicks the Dock icon while app is running but window is hidden
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                ulog_info!("[App] Dock icon clicked (Reopen), showing main window");
                tray::show_main_window(_app_handle);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod nav_guard_tests {
    use super::{
        classify_navigation, should_request_exit_confirmation, theme_bootstrap_paper,
        theme_bootstrap_script, NavDecision, THEME_BOOTSTRAP_APPEARANCE_MARKER,
        THEME_BOOTSTRAP_RUN_ID_MARKER, THEME_BOOTSTRAP_WINDOW_LABEL_MARKER,
    };
    use crate::config_io::ThemeBootstrapSelection;
    use tauri::{utils::config::Color, Theme, Url};

    fn decide(s: &str) -> NavDecision {
        classify_navigation(&Url::parse(s).expect("parse url"))
    }

    #[test]
    fn native_exit_requires_the_shared_frontend_confirmation_except_for_restart() {
        assert!(should_request_exit_confirmation(None, false));
        assert!(should_request_exit_confirmation(Some(0), false));
        assert!(!should_request_exit_confirmation(None, true));
        assert!(!should_request_exit_confirmation(
            Some(tauri::RESTART_EXIT_CODE),
            false
        ));
    }

    #[test]
    fn allows_widget_srcdoc_iframe() {
        // The desktop-only widget-blank bug: on_navigation fires for the
        // sandbox iframe's about:srcdoc nav; it MUST be allowed or the widget
        // renders blank.
        assert_eq!(decide("about:srcdoc"), NavDecision::Allow);
        assert_eq!(decide("about:blank"), NavDecision::Allow);
    }

    #[test]
    fn allows_internal_and_local_schemes() {
        assert_eq!(decide("tauri://localhost/"), NavDecision::Allow);
        assert_eq!(decide("asset://localhost/x"), NavDecision::Allow);
        assert_eq!(decide("ipc://localhost/"), NavDecision::Allow);
        assert_eq!(
            decide("myagents-resource://attachment/x/y"),
            NavDecision::Allow
        );
        assert_eq!(decide("http://localhost:5173/"), NavDecision::Allow);
        assert_eq!(decide("https://tauri.localhost/"), NavDecision::Allow);
        assert_eq!(decide("http://127.0.0.1:1420/"), NavDecision::Allow);
        assert_eq!(
            decide("myagents://attachment/x/y"),
            NavDecision::BlockSilently
        );
    }

    #[test]
    fn still_blocks_top_frame_attack_schemes() {
        // These must STAY blocked — a top-frame data:/blob:/javascript: nav
        // would run attacker HTML in the privileged app origin.
        assert_eq!(
            decide("data:text/html,<script>alert(1)</script>"),
            NavDecision::BlockSilently
        );
        assert_eq!(
            decide("blob:tauri://localhost/abc-123"),
            NavDecision::BlockSilently
        );
        assert_eq!(decide("javascript:alert(1)"), NavDecision::BlockSilently);
        assert_eq!(decide("file:///etc/passwd"), NavDecision::BlockSilently);
    }

    #[test]
    fn routes_external_urls_to_os_browser() {
        assert_eq!(
            decide("https://evil.example.com/"),
            NavDecision::OpenExternally
        );
        assert_eq!(decide("mailto:a@b.com"), NavDecision::OpenExternally);
        assert_eq!(decide("tel:+123"), NavDecision::OpenExternally);
    }

    #[test]
    fn native_bootstrap_surface_tracks_canonical_theme_paper_tokens() {
        let css = include_str!("../../src/renderer/theme/themes/myagents-default.css");

        fn paper_color(css: &str, scheme: &str) -> Color {
            let selector = format!("html[data-color-scheme='{scheme}'],");
            let block = css
                .split_once(&selector)
                .and_then(|(_, tail)| tail.split_once('}'))
                .map(|(block, _)| block)
                .expect("canonical scheme block");
            let value = block
                .split_once("--paper:")
                .and_then(|(_, tail)| tail.split_once(';'))
                .map(|(value, _)| value.trim())
                .expect("canonical --paper value");
            let hex = value.strip_prefix('#').expect("hex --paper value");
            assert_eq!(hex.len(), 6, "canonical --paper must be #rrggbb");
            Color(
                u8::from_str_radix(&hex[0..2], 16).expect("red channel"),
                u8::from_str_radix(&hex[2..4], 16).expect("green channel"),
                u8::from_str_radix(&hex[4..6], 16).expect("blue channel"),
                255,
            )
        }

        assert_eq!(
            theme_bootstrap_paper(Theme::Light),
            paper_color(css, "light")
        );
        assert_eq!(theme_bootstrap_paper(Theme::Dark), paper_color(css, "dark"));
    }

    #[test]
    fn native_bootstrap_script_injects_only_the_normalized_appearance() {
        let script = theme_bootstrap_script(
            &ThemeBootstrapSelection {
                appearance_mode: "dark".to_owned(),
            },
            "run\");globalThis.pwned=true;//",
            "main",
        );
        assert!(script.contains("if (themeSelectionExplicit) themeId = storedThemeId"));
        assert!(script.contains("let themeId = 'myagents-light'"));
        assert!(script.contains("appearanceMode: \"dark\""));
        assert!(!script.contains(THEME_BOOTSTRAP_APPEARANCE_MARKER));
        assert!(!script.contains(THEME_BOOTSTRAP_RUN_ID_MARKER));
        assert!(!script.contains(THEME_BOOTSTRAP_WINDOW_LABEL_MARKER));
        assert!(!script.contains("\"run\");globalThis.pwned=true;//\""));
        assert!(script.contains("cmd_record_renderer_boot_event"));
        assert!(script.contains("report('native-init-script')"));
        assert!(script.contains("report('renderer-uncaught-error'"));
        assert!(script.contains("report('renderer-unhandled-rejection'"));
    }

    #[test]
    fn window_destruction_never_owns_application_cleanup() {
        let source = include_str!("lib.rs");
        let window_handler = source
            .split_once(".on_window_event")
            .and_then(|(_, tail)| tail.split_once(".build(tauri::generate_context!())"))
            .map(|(handler, _)| handler)
            .expect("window event handler source");

        for forbidden in [
            "stop_all_sidecars(",
            "signal_all_agents_shutdown(",
            "signal_all_bots_shutdown(",
            "close_all_terminals(",
            "close_all_browsers(",
            "release_lock()",
        ] {
            assert!(
                !window_handler.contains(forbidden),
                "window lifecycle must not perform app cleanup via {forbidden}"
            );
        }

        let exit_handler = source
            .split_once("tauri::RunEvent::ExitRequested { code, api, .. } => {")
            .and_then(|(_, tail)| tail.split_once("// Handle Dock icon click on macOS"))
            .map(|(handler, _)| handler)
            .expect("app exit handler source");
        assert!(exit_handler.contains("stop_all_sidecars("));
        assert!(exit_handler.contains("&sidecar_state_for_exit"));
        assert!(exit_handler.contains("begin_app_exit_shutdown()"));
        assert!(exit_handler.contains("process_cmd::settle_pending_tree_terminations()"));
        assert!(exit_handler.contains("app_dirs::release_lock()"));

        let updater = include_str!("updater.rs");
        let restart_command = updater
            .split_once("pub fn restart_app")
            .and_then(|(_, tail)| tail.split_once("pub fn check_pending_update"))
            .map(|(command, _)| command)
            .expect("restart command source");
        assert!(restart_command.contains("app.request_restart()"));
        assert!(!restart_command.contains("app.restart()"));
    }
}
