// MyAgents Auto-Updater Module
// Provides silent background update checking, downloading, and installation
//
// Flow:
// 1. App starts → wait 5s → check for update
// 2. If update available → silently download in background (user unaware)
// 3. Download complete → emit event to show "Restart to Update" button in titlebar
// 4. User clicks button → restart and apply update
// 5. Or next app launch → update is automatically applied

use crate::logger;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Global flag to prevent concurrent update checks/downloads
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// RAII guard to reset UPDATE_IN_PROGRESS on drop
struct UpdateGuard;

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Update information sent to the frontend (only when download is complete)
#[derive(Clone, Serialize)]
pub struct UpdateReadyInfo {
    pub version: String,
}

/// Check for updates on startup and silently download if available
/// This is the main entry point called from setup hook
pub async fn check_update_on_startup(app: AppHandle) {
    // Wait 5 seconds before checking to let the app fully initialize
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    logger::info(&app, "[Updater] Starting background update check...");

    // Check and download silently
    match check_and_download_silently(&app).await {
        Ok(Some(version)) => {
            logger::info(
                &app,
                format!("[Updater] Update v{} downloaded and ready to install", version),
            );
            // Only notify frontend when download is complete
            let info = UpdateReadyInfo {
                version: version.clone(),
            };
            logger::info(&app, "[Updater] Emitting 'updater:ready-to-restart' event to frontend...");
            match app.emit("updater:ready-to-restart", info) {
                Ok(_) => {
                    logger::info(&app, format!("[Updater] Event emitted successfully for v{}", version));
                }
                Err(e) => {
                    logger::error(&app, format!("[Updater] Failed to emit ready event: {}", e));
                }
            }
        }
        Ok(None) => {
            logger::info(&app, "[Updater] No update available, already on latest version");
        }
        Err(e) => {
            logger::error(&app, format!("[Updater] Background update failed: {}", e));
        }
    }
}

/// Silently check for updates and download if available
/// Returns the version string if an update was downloaded, None if no update
/// Protected against concurrent calls
async fn check_and_download_silently(app: &AppHandle) -> Result<Option<String>, String> {
    // Prevent concurrent update checks
    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        logger::info(app, "[Updater] Update check already in progress, skipping");
        return Ok(None);
    }

    // RAII guard ensures flag is reset even if function panics/errors
    let _guard = UpdateGuard;

    // Get platform target (e.g., "darwin-aarch64", "darwin-x86_64")
    let target = get_update_target();
    let current_version = app.package_info().version.to_string();

    // Build updater with explicit target to override {{target}} template variable
    // Without this, tauri-plugin-updater only uses OS name (e.g., "darwin" instead of "darwin-aarch64")
    let updater = app
        .updater_builder()
        .target(target.to_string())
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))?;
    logger::info(
        app,
        format!(
            "[Updater] Checking for updates... Current: v{}, Target: {}, Endpoint: https://download.myagents.io/update/{}.json",
            current_version, target, target
        ),
    );

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            logger::info(app, "[Updater] Server returned no update (current version is latest or newer)");
            return Ok(None);
        }
        Err(e) => {
            // Log the full error details
            let error_debug = format!("{:?}", e);
            let error_display = format!("{}", e);
            logger::error(
                app,
                format!(
                    "[Updater] Check failed!\n  Display: {}\n  Debug: {}\n  Note: Use 'Test Update Connectivity' in Settings > About > Developer for detailed diagnostics",
                    error_display, error_debug
                ),
            );
            return Err(format!("Update check failed: {}", e));
        }
    };

    let version = update.version.clone();
    logger::info(
        app,
        format!("[Updater] Found update v{}, starting silent download...", version),
    );

    // Silent download - only log progress, no UI events
    let app_clone = app.clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_logged_percent = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let downloaded_clone = downloaded.clone();
    let last_logged_clone = last_logged_percent.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                let new_downloaded = downloaded_clone.fetch_add(
                    chunk_length as u64,
                    std::sync::atomic::Ordering::SeqCst,
                ) + chunk_length as u64;

                // Log progress at 25% intervals (less verbose for silent download)
                if let Some(total) = content_length {
                    let percent = (new_downloaded as f64 / total as f64 * 100.0) as u32;
                    let last_percent = last_logged_clone.load(std::sync::atomic::Ordering::SeqCst);
                    let current_bucket = percent / 25;
                    let last_bucket = last_percent / 25;
                    if current_bucket > last_bucket {
                        last_logged_clone.store(percent, std::sync::atomic::Ordering::SeqCst);
                        logger::info(
                            &app_clone,
                            format!("[Updater] Silent download progress: {}%", current_bucket * 25),
                        );
                    }
                }
            },
            || {
                // No-op: we handle completion after download_and_install returns
            },
        )
        .await
        .map_err(|e| format!("Silent download failed: {}", e))?;

    Ok(Some(version))
}

/// Command: Manual check and silent download (for periodic checks from frontend)
/// Returns true if an update was downloaded and is ready
#[tauri::command]
pub async fn check_and_download_update(app: AppHandle) -> Result<bool, String> {
    logger::info(&app, "[Updater] Manual update check requested");

    match check_and_download_silently(&app).await {
        Ok(Some(version)) => {
            logger::info(
                &app,
                format!("[Updater] Update v{} downloaded and ready", version),
            );
            // Notify frontend
            let info = UpdateReadyInfo {
                version: version.clone(),
            };
            if let Err(e) = app.emit("updater:ready-to-restart", info) {
                logger::error(&app, format!("[Updater] Failed to emit event: {}", e));
            }
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Command: Restart the application to apply the update
/// Note: This function never returns as app.restart() terminates the process
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    logger::info(&app, "[Updater] Restarting application to apply update...");
    app.restart();
}

/// Expected JSON structure for Tauri v2 updater (per-platform file)
/// Reference: https://v2.tauri.app/plugin/updater/
/// Required fields: version, signature, url
/// Optional fields: notes, pub_date
#[derive(Clone, Serialize, serde::Deserialize, Debug)]
struct UpdateJsonFormat {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    signature: String,
    url: String,
}

/// Get the update target string for the current platform
/// Supports macOS (ARM/Intel) and Windows (x64/ARM)
fn get_update_target() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "darwin-aarch64" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "darwin-x86_64" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "windows-x86_64" }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { "windows-aarch64" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    { "unknown" }
}

/// Command: Test HTTP connectivity to update server (diagnostic)
/// This bypasses tauri-plugin-updater to test raw HTTP connectivity
#[tauri::command]
pub async fn test_update_connectivity(app: AppHandle) -> Result<String, String> {
    // Detect architecture
    let target = get_update_target();

    let url = format!("https://download.myagents.io/update/{}.json", target);
    logger::info(&app, format!("[Updater] Testing HTTP connectivity to: {}", url));

    // Build a reqwest client with detailed configuration
    let current_version = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .user_agent(format!("MyAgents-Updater/{}", current_version))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    // Make the request
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!(
                "HTTP request failed: {} (is_connect: {}, is_timeout: {}, is_request: {})",
                e,
                e.is_connect(),
                e.is_timeout(),
                e.is_request()
            );
            logger::error(&app, format!("[Updater] {}", error_msg));
            error_msg
        })?;

    let status = response.status();
    let headers = response.headers().clone();

    logger::info(&app, format!("[Updater] Response status: {}", status));

    // Try to get the body
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Try to parse as expected JSON format
    let json_parse_result = match serde_json::from_str::<UpdateJsonFormat>(&body) {
        Ok(parsed) => {
            format!(
                "✓ JSON valid!\n  version: {}\n  url: {}\n  signature length: {} chars",
                parsed.version,
                parsed.url,
                parsed.signature.len()
            )
        }
        Err(e) => format!("✗ JSON parse error: {}", e),
    };

    let result = format!(
        "=== Update Connectivity Test ===\n\
         URL: {}\n\
         Target: {}\n\
         Status: {}\n\
         Content-Type: {:?}\n\
         Body length: {} bytes\n\
         \n\
         === JSON Validation ===\n\
         {}\n\
         \n\
         === Raw Body ===\n\
         {}",
        url,
        target,
        status,
        headers.get("content-type"),
        body.len(),
        json_parse_result,
        if body.len() > 800 { &body[..800] } else { &body }
    );

    logger::info(&app, format!("[Updater] Test result:\n{}", result));

    Ok(result)
}
