// MyAgents Tauri Application
// Main entry point with sidecar lifecycle management

mod commands;
pub mod logger;
mod sidecar;
mod sse_proxy;
mod updater;

use sidecar::{cleanup_stale_sidecars, create_sidecar_state, stop_all_sidecars};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // IMPORTANT: Clean up stale sidecar processes from previous app instances
    // This prevents "No available port found" errors caused by orphaned processes
    cleanup_stale_sidecars();

    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();
    let sidecar_state_for_window = sidecar_state.clone();
    let sidecar_state_for_exit = sidecar_state.clone();

    // Track if cleanup has been performed to avoid duplicate cleanup
    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_done_for_window = cleanup_done.clone();
    let cleanup_done_for_exit = cleanup_done.clone();

    // Create SSE proxy state
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());

    // Build the app first, then run with event handler
    // This allows us to handle RunEvent::ExitRequested for Cmd+Q and Dock quit
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sidecar_state)
        .manage(sse_proxy_state)
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
            // SSE proxy commands (multi-instance)
            sse_proxy::start_sse_proxy,
            sse_proxy::stop_sse_proxy,
            sse_proxy::stop_all_sse_proxies,
            sse_proxy::proxy_http_request,
            // Updater commands
            updater::check_and_download_update,
            updater::restart_app,
            updater::test_update_connectivity,
        ])
        .setup(|app| {
            // Initialize logging for all builds
            // Debug builds: DEBUG level for verbose output including third-party crates
            // Production builds: INFO level for important events only
            use tauri_plugin_log::{Target, TargetKind};

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;

            // Open DevTools in debug builds
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Start background update check (5 second delay to let app initialize)
            log::info!("[App] Setup complete, spawning background update check task...");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                log::info!("[App] Background update task started, waiting 5 seconds...");
                updater::check_update_on_startup(app_handle).await;
                log::info!("[App] Background update task completed");
            });
            log::info!("[App] Background update task spawned successfully");

            Ok(())
        })
        .on_window_event(move |_window, event| {
            // Clean up when main window is destroyed (X button, Cmd+W)
            if let tauri::WindowEvent::Destroyed = event {
                // Only cleanup once (Relaxed is sufficient for simple flag)
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_window.swap(true, Relaxed) {
                    log::info!("[App] Window destroyed, cleaning up sidecars...");
                    let _ = stop_all_sidecars(&sidecar_state_for_window);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to catch Cmd+Q and Dock quit
    app.run(move |_app_handle, event| {
        // Handle app exit events (Cmd+Q, Dock right-click quit, etc.)
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Only cleanup once (Relaxed is sufficient for simple flag)
            use std::sync::atomic::Ordering::Relaxed;
            if !cleanup_done_for_exit.swap(true, Relaxed) {
                log::info!("[App] Exit requested (Cmd+Q or Dock quit), cleaning up sidecars...");
                let _ = stop_all_sidecars(&sidecar_state_for_exit);
            }
        }
    });
}
