// MyAgents Tauri Application
// Main entry point with sidecar lifecycle management

mod commands;
pub mod logger;
mod sidecar;
mod sse_proxy;
mod updater;

use sidecar::{cleanup_stale_sidecars, create_sidecar_state, stop_all_sidecars};
use std::sync::Arc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // IMPORTANT: Clean up stale sidecar processes from previous app instances
    // This prevents "No available port found" errors caused by orphaned processes
    cleanup_stale_sidecars();
    
    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();
    let sidecar_state_cleanup = sidecar_state.clone();
    
    // Create SSE proxy state
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());

    tauri::Builder::default()
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
            // Initialize logging in debug mode
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Open DevTools in debug builds
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Start background update check (5 second delay to let app initialize)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                updater::check_update_on_startup(app_handle).await;
            });

            Ok(())
        })
        .on_window_event(move |_window, event| {
            // Clean up ALL sidecar instances when main window closes
            if let tauri::WindowEvent::Destroyed = event {
                let _ = stop_all_sidecars(&sidecar_state_cleanup);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
