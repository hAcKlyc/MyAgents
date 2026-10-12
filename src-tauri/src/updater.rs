// MyAgents Auto-Updater Module
// Provides silent background update checking, downloading, and installation
//
// Flow:
// 1. App starts → wait 60s → cleanup stale Windows updater temp dirs → check for update
// 2. If update available → silently download and persist in background
// 3. Download complete → emit event to show "Restart to Update" button in titlebar
// 4. User clicks button → restart and apply update
// 5. Or next app launch → pending update is offered again
//
// Windows/macOS deferred install:
// - Installing while the app is still in use either exits immediately (Windows)
//   or replaces the running .app bundle (macOS). Both must happen only after
//   explicit user action.
// - We split download/install:
//   download() saves bytes to disk, install() only runs on user action
// - On next startup, check_pending_update detects saved bytes and prompts user

use crate::logger;
use crate::proxy_config;
use crate::ulog_info;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "windows", test))]
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::sidecar::ManagedSidecar;

/// Global flag to prevent concurrent update checks/downloads
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

// Linux is distributed as deb; the AppImage updater cannot install it.
fn update_disabled_reason(is_debug_build: bool, platform: &str) -> Option<&'static str> {
    if crate::app_dirs::IS_MOXBOT {
        Some("UPDATER_DISABLED_FOR_MOXBOT")
    } else if platform == "linux" {
        Some("UPDATER_MANUAL_INSTALL_REQUIRED")
    } else if is_debug_build {
        Some("UPDATER_DISABLED_IN_DEVELOPMENT")
    } else {
        None
    }
}

#[cfg(any(target_os = "windows", test))]
const WINDOWS_UPDATER_TEMP_DIR_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

/// Track the version of the latest downloaded update (latest-wins: skip re-download if same)
static DOWNLOADED_VERSION: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Cache the most recent `Update` object obtained via `updater.check()`.
///
/// **Why this exists:** Tauri's `Update::install(bytes)` is a method on `Update`,
/// but the only public way to obtain an `Update` is `updater.check().await`,
/// which makes a fresh HTTPS round-trip to `download.myagents.io`. On Windows
/// (where the install path is split across download → click → install), this
/// extra round-trip at click-time means a flaky/blocked network silently kills
/// the install — the user sees the "重启更新" button do nothing.
///
/// By caching the `Update` object every time `check()` succeeds during the
/// session, we eliminate the network requirement on the install path: the
/// click-handler can just reuse the cached `Update` and call `install(bytes)`.
/// The bytes themselves were signature-verified at download time, so this is
/// strictly safer than a network call (which can be intercepted/timed-out).
///
/// Falls back to a fresh `check()` when the cache is empty (e.g., user
/// clicked the startup pending-update dialog before the startup background check
/// had a chance to populate the cache).
static LATEST_UPDATE: std::sync::Mutex<Option<Update>> = std::sync::Mutex::new(None);

fn cache_update(update: Update) {
    if let Ok(mut guard) = LATEST_UPDATE.lock() {
        *guard = Some(update);
    }
}

/// Return a clone of the cached `Update` if its version matches `wanted`.
/// Returns None if cache is empty or version differs (stale cache).
///
/// Used by the deferred Windows/macOS install path.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn cached_update_for(wanted: &str) -> Option<Update> {
    let guard = LATEST_UPDATE.lock().ok()?;
    let cached = guard.as_ref()?;
    if cached.version == wanted {
        Some(cached.clone())
    } else {
        None
    }
}

/// Metadata persisted to disk alongside the update binary
#[cfg(any(target_os = "windows", target_os = "macos"))]
#[derive(Serialize, serde::Deserialize)]
struct PendingUpdateMeta {
    version: String,
}

/// Get the ~/.myagents/ directory path
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn get_myagents_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.join(crate::app_dirs::APP_DATA_DIR_NAME))
}

/// Atomically save pending update bytes + metadata to disk
/// Writes to .tmp first, then renames to avoid partial files
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn save_pending_update_to_disk(version: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = get_myagents_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let bin_path = dir.join("pending_update.bin");
    let bin_tmp = dir.join("pending_update.bin.tmp");
    let meta_path = dir.join("pending_update.json");

    // Write binary atomically: tmp → rename
    std::fs::write(&bin_tmp, bytes).map_err(|e| format!("Failed to write update binary: {}", e))?;
    std::fs::rename(&bin_tmp, &bin_path)
        .map_err(|e| format!("Failed to rename update binary: {}", e))?;

    // Write metadata
    let meta = PendingUpdateMeta {
        version: version.to_string(),
    };
    let json =
        serde_json::to_string(&meta).map_err(|e| format!("Failed to serialize metadata: {}", e))?;
    std::fs::write(&meta_path, json).map_err(|e| format!("Failed to write metadata: {}", e))?;

    Ok(())
}

/// Remove pending update files from disk AND reset the related in-memory
/// trackers (DOWNLOADED_VERSION + LATEST_UPDATE cache).
///
/// All three are bound by the same invariant — they describe "the bytes
/// currently waiting to be installed". Resetting only one when the others
/// are still set lets stale latest-wins decisions or stale cache hits
/// re-introduce the cache==disk inconsistency this whole module is trying
/// to prevent. Bundle the reset so callers can't forget.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn clear_pending_update_from_disk() {
    if let Ok(dir) = get_myagents_dir() {
        let _ = std::fs::remove_file(dir.join("pending_update.bin"));
        let _ = std::fs::remove_file(dir.join("pending_update.bin.tmp"));
        let _ = std::fs::remove_file(dir.join("pending_update.json"));
    }
    *DOWNLOADED_VERSION.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Ok(mut guard) = LATEST_UPDATE.lock() {
        *guard = None;
    }
}

/// Read the version of the pending update from disk metadata (None if not present or corrupt)
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn read_pending_update_version() -> Option<String> {
    let dir = get_myagents_dir().ok()?;
    let meta_path = dir.join("pending_update.json");
    let bin_path = dir.join("pending_update.bin");
    if !meta_path.exists() || !bin_path.exists() {
        return None;
    }
    let json = std::fs::read_to_string(&meta_path).ok()?;
    let meta: PendingUpdateMeta = serde_json::from_str(&json).ok()?;
    Some(meta.version)
}

/// Compare semver-like version strings: returns true if `remote` > `current`
fn is_version_greater(remote: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .filter_map(|s| s.parse::<u64>().ok())
            .collect()
    };
    let r = parse(remote);
    let c = parse(current);
    for i in 0..r.len().max(c.len()) {
        let rv = r.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if rv > cv {
            return true;
        }
        if rv < cv {
            return false;
        }
    }
    false // equal
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Default, PartialEq, Eq)]
struct UpdaterTempCleanupStats {
    matched: usize,
    removed: usize,
    skipped_fresh: usize,
    skipped_non_dir: usize,
    skipped_reparse_or_symlink: usize,
    failed: usize,
}

#[cfg(any(target_os = "windows", test))]
fn is_semver_like(version: &str) -> bool {
    fn is_numeric_identifier(part: &str) -> bool {
        !part.is_empty()
            && part.chars().all(|c| c.is_ascii_digit())
            && (part.len() == 1 || !part.starts_with('0'))
    }

    fn is_valid_identifier(part: &str, allow_numeric_leading_zero: bool) -> bool {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return false;
        }
        allow_numeric_leading_zero
            || !part.chars().all(|c| c.is_ascii_digit())
            || is_numeric_identifier(part)
    }

    let (without_build, build) = match version.split_once('+') {
        Some((base, build)) => (base, Some(build)),
        None => (version, None),
    };
    if build.is_some_and(|build| {
        build.is_empty()
            || build
                .split('.')
                .any(|part| !is_valid_identifier(part, true))
    }) {
        return false;
    }

    let (core, prerelease) = match without_build.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (without_build, None),
    };
    if prerelease.is_some_and(|prerelease| {
        prerelease.is_empty()
            || prerelease
                .split('.')
                .any(|part| !is_valid_identifier(part, false))
    }) {
        return false;
    }

    let mut parts = core.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    [major, minor, patch]
        .iter()
        .all(|part| is_numeric_identifier(part))
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_updater_temp_dir_version<'a>(name: &'a str, app_name: &str) -> Option<&'a str> {
    let rest = name.strip_prefix(app_name)?.strip_prefix('-')?;
    let (version, suffix) = rest.split_once("-updater-")?;
    if suffix.is_empty() || !is_semver_like(version) {
        return None;
    }
    Some(version)
}

#[cfg(any(target_os = "windows", test))]
fn metadata_is_reparse_or_symlink(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(any(target_os = "windows", test))]
fn cleanup_stale_windows_updater_temp_dirs_in(
    temp_root: &std::path::Path,
    app_name: &str,
    now: SystemTime,
    grace: Duration,
) -> Result<UpdaterTempCleanupStats, String> {
    let entries = std::fs::read_dir(temp_root)
        .map_err(|e| format!("Failed to read temp dir '{}': {}", temp_root.display(), e))?;
    let mut stats = UpdaterTempCleanupStats::default();

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => {
                stats.failed += 1;
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(_version) = parse_windows_updater_temp_dir_version(name, app_name) else {
            continue;
        };
        stats.matched += 1;

        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                stats.failed += 1;
                continue;
            }
        };
        if metadata_is_reparse_or_symlink(&metadata) {
            stats.skipped_reparse_or_symlink += 1;
            continue;
        }
        if !metadata.is_dir() {
            stats.skipped_non_dir += 1;
            continue;
        }

        let modified = metadata.modified().or_else(|_| metadata.created());
        let Ok(modified) = modified else {
            stats.failed += 1;
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            stats.skipped_fresh += 1;
            continue;
        };
        if age < grace {
            stats.skipped_fresh += 1;
            continue;
        }

        match std::fs::remove_dir_all(&path) {
            Ok(()) => stats.removed += 1,
            Err(_) => stats.failed += 1,
        }
    }

    Ok(stats)
}

#[cfg(target_os = "windows")]
async fn cleanup_stale_windows_updater_temp_dirs(app: &AppHandle) {
    let app_name = app.package_info().name.clone();
    let temp_root = std::env::temp_dir();
    let temp_root_for_cleanup = temp_root.clone();
    let cleanup_result = tauri::async_runtime::spawn_blocking(move || {
        cleanup_stale_windows_updater_temp_dirs_in(
            &temp_root_for_cleanup,
            &app_name,
            SystemTime::now(),
            WINDOWS_UPDATER_TEMP_DIR_GRACE,
        )
    })
    .await;

    match cleanup_result {
        Ok(Ok(stats)) => {
            if stats.matched > 0 || stats.failed > 0 {
                logger::info(
                    app,
                    format!(
                        "[Updater] Windows temp GC scanned '{}': matched={}, removed={}, fresh={}, non_dir={}, reparse_or_symlink={}, failed={}",
                        temp_root.display(),
                        stats.matched,
                        stats.removed,
                        stats.skipped_fresh,
                        stats.skipped_non_dir,
                        stats.skipped_reparse_or_symlink,
                        stats.failed
                    ),
                );
            }
        }
        Ok(Err(e)) => {
            logger::error(app, format!("[Updater] Windows temp GC skipped: {}", e));
        }
        Err(e) => {
            logger::error(app, format!("[Updater] Windows temp GC task failed: {}", e));
        }
    }
}

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

/// Download progress sent to the frontend during download
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    /// Bytes downloaded so far
    pub downloaded: u64,
    /// Total file size (None if server didn't provide Content-Length)
    pub total: Option<u64>,
    /// Progress percentage 0-100 (None if total is unknown)
    pub percent: Option<u32>,
}

/// Build an updater with user's proxy configuration applied.
/// Reads proxy settings from ~/.myagents/config.json:
/// - Proxy enabled → `.proxy(url)`
/// - No proxy configured → inherit system network behavior (respect system proxy)
fn build_updater_with_proxy(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let target = get_update_target();
    // 15s per-request timeout. Without this, a blackholed connection (TCP SYN
    // with no response) leaves the install retry loop hung — defeats the
    // entire point of the 3-attempt fallback in `resolve_update_with_retries`.
    let mut builder = app
        .updater_builder()
        .target(target.to_string())
        .timeout(std::time::Duration::from_secs(15));

    if let Some(proxy_settings) = proxy_config::read_proxy_settings_for_general_requests() {
        let proxy_url = proxy_config::get_proxy_url(&proxy_settings)?;
        ulog_info!("[Updater] Using proxy for update requests: {}", proxy_url);
        let url = reqwest::Url::parse(&proxy_url)
            .map_err(|e| format!("Invalid proxy URL '{}': {}", proxy_url, e))?;
        builder = builder.proxy(url);
    } else {
        ulog_info!("[Updater] General requests inherit system network behavior");
        // Don't call .no_proxy() — let the updater respect system proxy settings
        // (Clash TUN, global proxy, etc.) just like other normal applications.
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))
}

/// Check for updates on startup and silently download if available
/// This is the main entry point called from setup hook
pub async fn check_update_on_startup(app: AppHandle) {
    if let Some(reason) = update_disabled_reason(cfg!(debug_assertions), std::env::consts::OS) {
        logger::info(
            &app,
            format!("[Updater] Automatic updates disabled: {reason}"),
        );
        return;
    }

    // Wait 60 seconds before checking — startup is heavy enough without an
    // updater HTTPS round-trip racing the user's first action. Periodic
    // checks (every 30 min) catch up after this initial window.
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;

    #[cfg(target_os = "windows")]
    cleanup_stale_windows_updater_temp_dirs(&app).await;

    logger::info(&app, "[Updater] Starting background update check...");

    // Check and download silently
    match check_and_download_silently(&app).await {
        Ok(Some(version)) => {
            logger::info(
                &app,
                format!(
                    "[Updater] Update v{} downloaded and ready to install",
                    version
                ),
            );
        }
        Ok(None) => {
            logger::info(
                &app,
                "[Updater] No update available, already on latest version",
            );
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

    // Build updater with user's proxy configuration
    let updater = build_updater_with_proxy(app)?;
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
            logger::info(
                app,
                "[Updater] Server returned no update (current version is latest or newer)",
            );
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

    // Invariant: LATEST_UPDATE cache must only hold an Update whose `version`
    // matches what's currently on disk in pending_update.bin/json. Otherwise a
    // user click during the silent-download window (cache=NEW, disk=OLD) hits
    // `cached_update_for(disk_version)` → miss → falls back to a fresh
    // updater.check() → server returns NEW → version mismatch → install path
    // CLEARS the OLD disk bytes, killing the user's pending install before
    // the NEW download has even finished writing. Pre-replace clicks must
    // install whatever's on disk.
    //
    // So: do NOT cache here. Cache only at the points where we've confirmed
    // disk and Update.version are aligned (each early-return branch + after
    // save_pending_update_to_disk succeeds).
    let version = update.version.clone();

    // Defensive guard: reject downgrades even if server/CDN returns a stale version.
    // Tauri's check() should handle this, but CDN caching or proxy issues can slip through.
    if !is_version_greater(&version, &current_version) {
        logger::info(
            app,
            format!(
                "[Updater] Ignoring stale update v{} (current v{} is same or newer)",
                version, current_version
            ),
        );
        return Ok(None);
    }

    // Latest-wins: skip re-download if we already have this exact version ready.
    // A newer version (e.g., 0.1.61 after 0.1.60) WILL be downloaded and replace the old one.
    {
        let downloaded_ver = DOWNLOADED_VERSION.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref dv) = *downloaded_ver {
            if dv == &version {
                logger::info(
                    app,
                    format!(
                        "[Updater] v{} already downloaded, skipping re-download",
                        version
                    ),
                );
                // DOWNLOADED_VERSION is set only after save_pending_update_to_disk
                // succeeds (line 440), so disk == version here. Cache aligned.
                cache_update(update.clone());
                return Ok(None);
            }
            if !is_version_greater(&version, dv) {
                logger::info(
                    app,
                    format!(
                        "[Updater] v{} not newer than already downloaded v{}, skipping",
                        version, dv
                    ),
                );
                // Disk holds `dv`, server returned `version` (older/equal). The
                // Update object we have describes `version`, NOT `dv` — caching
                // it here would violate the cache==disk invariant. Leave any
                // pre-existing cache for `dv` alone.
                return Ok(None);
            }
            logger::info(
                app,
                format!(
                    "[Updater] Newer v{} available (replacing downloaded v{})",
                    version, dv
                ),
            );
        }
    }

    logger::info(
        app,
        format!(
            "[Updater] Found update v{}, starting silent download...",
            version
        ),
    );

    // Download with progress events to frontend
    let app_clone = app.clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_emitted_percent = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let downloaded_clone = downloaded.clone();
    let last_emitted_clone = last_emitted_percent.clone();

    let on_chunk = move |chunk_length: usize, content_length: Option<u64>| {
        let new_downloaded = downloaded_clone
            .fetch_add(chunk_length as u64, std::sync::atomic::Ordering::SeqCst)
            + chunk_length as u64;

        if let Some(total) = content_length.filter(|&t| t > 0) {
            let percent = ((new_downloaded as f64 / total as f64 * 100.0) as u32).min(100);
            let last = last_emitted_clone.load(std::sync::atomic::Ordering::SeqCst);

            // Emit event every 2% and log every 25%
            if percent >= last + 2 || (percent == 100 && last != 100) {
                last_emitted_clone.store(percent, std::sync::atomic::Ordering::SeqCst);

                let _ = app_clone.emit(
                    "updater:download-progress",
                    DownloadProgress {
                        downloaded: new_downloaded,
                        total: Some(total),
                        percent: Some(percent),
                    },
                );

                // Log at 25% intervals (less verbose)
                if percent / 25 > last / 25 {
                    logger::info(
                        &app_clone,
                        format!("[Updater] Download progress: {}%", percent),
                    );
                }
            }
        } else {
            // No Content-Length: emit byte count every 5MB
            let mb = new_downloaded / (5 * 1024 * 1024);
            let prev_mb = (new_downloaded - chunk_length as u64) / (5 * 1024 * 1024);
            if mb > prev_mb {
                let _ = app_clone.emit(
                    "updater:download-progress",
                    DownloadProgress {
                        downloaded: new_downloaded,
                        total: None,
                        percent: None,
                    },
                );
            }
        }
    };

    // Windows/macOS: download and persist only. Installing on macOS replaces
    // the running .app bundle; doing that in the background leaves macOS TCC
    // unable to resolve the executable path until restart, so permission
    // prompts silently fail. Installation belongs to the explicit restart
    // action on both platforms.
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        // Skip download if we already have this version cached on disk
        if let Some(cached_version) = read_pending_update_version() {
            if cached_version == version {
                logger::info(
                    app,
                    format!(
                        "[Updater] v{} already cached on disk, skipping re-download",
                        version
                    ),
                );
                // Disk == version; safe to align cache.
                cache_update(update.clone());
                emit_update_ready(app, &version);
                return Ok(Some(version));
            }
        }

        // Tell the renderer we're entering the actual download phase. The
        // titlebar / Settings "重启更新" button hides while this is in flight
        // because the version that the button claims is "ready" may be about
        // to be replaced. Clicking install mid-download lands on inconsistent
        // cache/disk state — better to hide. The button reappears on
        // `updater:ready-to-restart` (new bytes committed) or
        // `updater:download-failed` (kept old bytes, no replacement).
        let _ = app.emit(
            "updater:download-started",
            UpdateReadyInfo {
                version: version.clone(),
            },
        );

        let bytes = match update.download(on_chunk, || {}).await {
            Ok(b) => b,
            Err(e) => {
                let _ = app.emit(
                    "updater:download-failed",
                    UpdateReadyInfo {
                        version: version.clone(),
                    },
                );
                return Err(format!("Silent download failed: {}", e));
            }
        };

        logger::info(
            app,
            format!(
                "[Updater] Downloaded {} bytes for v{}, saving to disk...",
                bytes.len(),
                version
            ),
        );

        // Save to disk — install_pending_update will read from here
        if let Err(e) = save_pending_update_to_disk(&version, &bytes) {
            logger::error(
                app,
                format!("[Updater] Failed to save update to disk: {}", e),
            );
            let _ = app.emit(
                "updater:download-failed",
                UpdateReadyInfo {
                    version: version.clone(),
                },
            );
            return Err(format!("Failed to persist update: {}", e));
        }

        // CRITICAL: align cache only AFTER disk write commits. The atomic
        // tmp+rename inside save_pending_update_to_disk means
        // read_pending_update_version() now sees `version`, so cached
        // `Update` for the same `version` is safe. Doing this BEFORE
        // save_pending_update_to_disk (or before the download) is the bug
        // we're avoiding: it widens the cache=NEW/disk=OLD window so a
        // pre-replace install click would re-fetch and DELETE the OLD bytes.
        cache_update(update.clone());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app.emit(
            "updater:download-started",
            UpdateReadyInfo {
                version: version.clone(),
            },
        );

        if let Err(e) = update.download_and_install(on_chunk, || {}).await {
            let _ = app.emit(
                "updater:download-failed",
                UpdateReadyInfo {
                    version: version.clone(),
                },
            );
            return Err(format!("Silent download failed: {}", e));
        }
    }

    // Track this version as the latest downloaded (latest-wins protocol)
    *DOWNLOADED_VERSION.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.clone());

    // The function that emits download-started also owns its terminal event.
    // This matters for callers such as the pending-update cache warmup, which
    // intentionally ignore the return value and previously left the renderer
    // stuck in `preparing` after a successful replacement download.
    emit_update_ready(app, &version);

    Ok(Some(version))
}

fn emit_update_ready(app: &AppHandle, version: &str) {
    logger::info(
        app,
        format!("[Updater] Update v{} is ready; notifying frontend", version),
    );
    if let Err(e) = app.emit(
        "updater:ready-to-restart",
        UpdateReadyInfo {
            version: version.to_string(),
        },
    ) {
        logger::error(app, format!("[Updater] Failed to emit ready event: {}", e));
    }
}

/// Command: Manual check and silent download (for periodic checks from frontend)
/// Returns true if an update was downloaded and is ready
#[tauri::command]
pub async fn check_and_download_update(app: AppHandle) -> Result<bool, String> {
    logger::info(&app, "[Updater] Manual update check requested");

    if let Some(reason) = update_disabled_reason(cfg!(debug_assertions), std::env::consts::OS) {
        return Err(reason.to_string());
    }

    match check_and_download_silently(&app).await {
        Ok(Some(version)) => {
            logger::info(
                &app,
                format!("[Updater] Update v{} downloaded and ready", version),
            );
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Command: Restart the application to apply the update.
///
/// `request_restart` reliably routes through `RunEvent::ExitRequested`, whose
/// app lifecycle owner closes IM agents, Sidecars, terminals, browsers, and the
/// process lock before Tauri relaunches.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    logger::info(&app, "[Updater] Restarting application to apply update...");
    app.request_restart();
}

/// Command: Check if a deferred update exists on disk (Windows/macOS startup prompt)
/// Returns the version string if a pending update is ready AND newer than current, None otherwise
#[tauri::command]
pub fn check_pending_update(app: AppHandle) -> Option<String> {
    if let Some(reason) = update_disabled_reason(cfg!(debug_assertions), std::env::consts::OS) {
        logger::info(
            &app,
            format!("[Updater] Pending update install disabled: {reason}"),
        );
        return None;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app;
        return None;
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        match read_pending_update_version() {
            Some(version) => {
                // Reject stale pending updates (e.g., user manually upgraded past the cached version)
                let current = app.package_info().version.to_string();
                if !is_version_greater(&version, &current) {
                    logger::info(
                        &app,
                        format!(
                            "[Updater] Clearing stale pending update v{} (current v{})",
                            version, current
                        ),
                    );
                    clear_pending_update_from_disk();
                    return None;
                }
                // Pending update exists → warm the LATEST_UPDATE cache in the
                // background so a click on the startup pending dialog can hit
                // the network-free install path. Without this, the user would
                // race the `check_update_on_startup` delay and a fast click
                // would still hit `resolve_update_with_retries`.
                let app_for_warmup = app.clone();
                tauri::async_runtime::spawn(async move {
                    if LATEST_UPDATE.lock().map(|g| g.is_some()).unwrap_or(false) {
                        return; // already warm
                    }
                    logger::info(
                        &app_for_warmup,
                        "[Updater] Warming LATEST_UPDATE cache for pending install",
                    );
                    let _ = check_and_download_silently(&app_for_warmup).await;
                });
                Some(version)
            }
            None => {
                // If metadata is corrupt/missing but bin exists, clean up
                clear_pending_update_from_disk();
                None
            }
        }
    }
}

/// Command: Install a previously downloaded update (Windows/macOS).
///
/// Resolves the `Update` object (preferring an in-memory cache populated during
/// background `check()` calls, falling back to a fresh `check()` with retries),
/// Windows then enters the update-quiesce gate, shuts down process-owning
/// surfaces, verifies update-blocking processes/files are gone, and launches
/// NSIS. macOS installs the already-verified local bytes only after this
/// explicit action and immediately requests a managed restart; this avoids
/// unlinking the live app bundle during background download and breaking TCC.
///
/// **Why the cache matters:** on a flaky/blocked network the legacy code path
/// — which always required `updater.check().await` — silently failed because
/// the JS side only `console.warn`-ed. Worse, the renderer had already called
/// `cmd_shutdown_for_update` first, so a network failure left the user with
/// dead sidecars and a "button doesn't do anything" UX. Now we (a) try the
/// cache first (zero network), (b) retry the network fallback, (c) only tear
/// down owners once we're committed to running the installer.
#[tauri::command]
pub async fn install_pending_update(
    app: AppHandle,
    state: State<'_, ManagedSidecar>,
    im_state: State<'_, crate::im::ManagedImBots>,
    agent_state: State<'_, crate::im::ManagedAgents>,
    terminal_state: State<'_, std::sync::Arc<crate::terminal::TerminalManager>>,
    browser_state: State<'_, std::sync::Arc<crate::browser::BrowserManager>>,
) -> Result<(), String> {
    if let Some(reason) = update_disabled_reason(cfg!(debug_assertions), std::env::consts::OS) {
        return Err(reason.to_string());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app;
        let _ = state;
        let _ = im_state;
        let _ = agent_state;
        let _ = terminal_state;
        let _ = browser_state;
        return Err("install_pending_update is unsupported on this platform".to_string());
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        logger::info(&app, "[Updater] install_pending_update called");

        // Step 1: Read update bytes and version from disk
        let dir = get_myagents_dir()?;
        let bin_path = dir.join("pending_update.bin");
        let meta_path = dir.join("pending_update.json");

        let bytes = std::fs::read(&bin_path)
            .map_err(|e| format!("Failed to read pending update from disk: {}", e))?;

        let json = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read pending update metadata: {}", e))?;
        let meta: PendingUpdateMeta = serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse pending update metadata: {}", e))?;
        let pending_version = meta.version;

        logger::info(
            &app,
            format!(
                "[Updater] Read {} bytes for v{} from disk",
                bytes.len(),
                pending_version
            ),
        );

        // Step 2: Resolve the Update object. Cache hit → zero network.
        // Cache miss → retry the HTTPS check up to 3 times to ride out
        // transient flakiness (DNS hiccups, proxy reconnect, captive portal).
        let update = if let Some(cached) = cached_update_for(&pending_version) {
            logger::info(
                &app,
                format!(
                    "[Updater] Using cached Update for v{} (no network needed)",
                    pending_version
                ),
            );
            cached
        } else {
            logger::info(
                &app,
                format!(
                    "[Updater] No cached Update for v{}, falling back to network check",
                    pending_version
                ),
            );
            resolve_update_with_retries(&app, &pending_version, 3).await?
        };

        // Step 3: Version match check — if server has newer version than our cached bytes, discard
        if update.version != pending_version {
            logger::info(
                &app,
                format!(
                    "[Updater] Version mismatch: pending={}, server={}. Clearing stale update.",
                    pending_version, update.version
                ),
            );
            clear_pending_update_from_disk();
            return Err("VERSION_MISMATCH".to_string());
        }

        #[cfg(target_os = "macos")]
        {
            // Installing replaces the on-disk .app. Keep the current bundle
            // intact until the user's explicit restart action, then restart
            // immediately after the local install succeeds so the process is
            // never left interactively running from an unlinked executable.
            let _ = state;
            let _ = im_state;
            let _ = agent_state;
            let _ = terminal_state;
            let _ = browser_state;
            logger::info(
                &app,
                format!("[Updater] Installing macOS update v{}...", pending_version),
            );
            update
                .install(bytes)
                .map_err(|e| format!("Installation failed: {}", e))?;
            logger::info(&app, "[Updater] macOS update installed; restarting now");
            app.request_restart();
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            // Step 4: Now we're committed to installing. Enter update-quiesce and
            // shut down every owner before NSIS is allowed to overwrite Node.js /
            // SDK / bridge resources. This was previously done from
            // the renderer BEFORE step 2, which meant a network failure would kill
            // the user's session for nothing. Doing it here keeps the user's state
            // intact on every failure path above.
            let _update_shutdown_guard = crate::sidecar::begin_update_shutdown()?;
            logger::info(
                &app,
                "[Updater] Quiescing app owners before NSIS install...",
            );
            crate::im::shutdown_all_channels_for_update(&im_state, &agent_state, &state).await;
            let terminal_report =
                crate::terminal::close_all_terminals(terminal_state.inner()).await;
            if !terminal_report.residual.is_empty() {
                return Err(format!(
                    "UPDATE_TERMINALS_STILL_RUNNING: {}",
                    terminal_report.residual.join(" | ")
                ));
            }
            crate::browser::close_all_browsers(browser_state.inner(), &app).await;
            crate::cliproxy::quiesce_for_update()
                .await
                .map_err(|error| error.message)?;
            crate::sidecar::shutdown_for_update_verified(&app, &state)?;

            // Step 5: Install — spawns NSIS installer and calls exit(0).
            // This function will NOT return on success.
            //
            // Do NOT clear pending_update.bin / pending_update.json before this
            // call: if `install()` fails (e.g., extract/temp-write error after
            // the bytes were written to disk), we want to keep the bytes around
            // so the user can retry without re-downloading. On the success path
            // the new app version replaces the old one and the next startup's
            // `check_pending_update` clears stale-by-version entries automatically.
            logger::info(
                &app,
                format!("[Updater] Installing v{}...", pending_version),
            );
            update
                .install(bytes)
                .map_err(|e| format!("Installation failed: {}", e))?;

            // Unreachable on success (install_inner exit(0)s the process).
            Ok(())
        }
    }
}

/// Build an `Update` via `updater.check()` with retries — used as the fallback
/// when no cached Update is available (e.g., user clicked startup pending dialog
/// before the startup background check populated the cache).
///
/// Each attempt uses the user's proxy config. Retries with 1s linear backoff.
/// Maps tauri-plugin-updater errors to caller-friendly strings:
/// - All attempts network-failed → `"NETWORK_ERROR"`
/// - Server returned no update → `"VERSION_MISMATCH"` (and clears disk cache)
#[cfg(any(target_os = "windows", target_os = "macos"))]
async fn resolve_update_with_retries(
    app: &AppHandle,
    expected_version: &str,
    attempts: u32,
) -> Result<Update, String> {
    let mut last_err: Option<String> = None;
    for attempt in 1..=attempts {
        let updater = build_updater_with_proxy(app)?;
        match updater.check().await {
            Ok(Some(update)) => {
                cache_update(update.clone());
                logger::info(
                    app,
                    format!(
                        "[Updater] Network check succeeded on attempt {}/{} (server v{})",
                        attempt, attempts, update.version
                    ),
                );
                return Ok(update);
            }
            Ok(None) => {
                // Server explicitly says nothing newer than current_version is
                // available. Our cached bytes are stale — the user must have
                // upgraded by other means, or the CDN regressed to an old JSON.
                logger::info(
                    app,
                    format!("[Updater] Server returned no update on attempt {}/{}; clearing stale pending v{}", attempt, attempts, expected_version),
                );
                clear_pending_update_from_disk();
                return Err("VERSION_MISMATCH".to_string());
            }
            Err(e) => {
                let msg = format!("attempt {}/{}: {}", attempt, attempts, e);
                logger::error(app, format!("[Updater] Network check failed ({})", msg));
                last_err = Some(msg);
                if attempt < attempts {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }
    logger::error(
        app,
        format!(
            "[Updater] All {} network check attempts failed for v{}: {}",
            attempts,
            expected_version,
            last_err.as_deref().unwrap_or("unknown"),
        ),
    );
    Err("NETWORK_ERROR".to_string())
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
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    {
        "unknown"
    }
}

/// Command: Test HTTP connectivity to update server (diagnostic)
/// This bypasses tauri-plugin-updater to test raw HTTP connectivity
#[tauri::command]
pub async fn test_update_connectivity(app: AppHandle) -> Result<String, String> {
    // Keep read-only diagnostics available in macOS/Windows debug builds.
    if let Some(reason) = update_disabled_reason(false, std::env::consts::OS) {
        return Err(reason.to_string());
    }
    // Detect architecture
    let target = get_update_target();

    let url = format!("https://download.myagents.io/update/{}.json", target);
    logger::info(
        &app,
        format!("[Updater] Testing HTTP connectivity to: {}", url),
    );

    // Build a reqwest client with user's proxy configuration. Updater talks
    // to R2 — external host, system proxy wanted.
    let current_version = app.package_info().version.to_string();
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .user_agent(format!("MyAgents-Updater/{}", current_version))
        .timeout(std::time::Duration::from_secs(30));

    let client = proxy_config::build_client_with_proxy(builder)
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    // Make the request
    let response = client.get(&url).send().await.map_err(|e| {
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
        if body.len() > 800 {
            &body[..800]
        } else {
            &body
        }
    );

    logger::info(&app, format!("[Updater] Test result:\n{}", result));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_require_a_supported_release_package() {
        for is_debug in [false, true] {
            assert_eq!(
                update_disabled_reason(is_debug, "linux"),
                Some("UPDATER_MANUAL_INSTALL_REQUIRED")
            );
        }
        for platform in ["macos", "windows"] {
            assert_eq!(
                update_disabled_reason(true, platform),
                Some("UPDATER_DISABLED_IN_DEVELOPMENT")
            );
            assert_eq!(update_disabled_reason(false, platform), None);
        }
    }

    #[test]
    fn parses_windows_updater_temp_dir_names() {
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-0.2.27-updater-abcd", "MyAgents"),
            Some("0.2.27")
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version(
                "MyAgents-1.2.3-beta.1+build.7-updater-random",
                "MyAgents"
            ),
            Some("1.2.3-beta.1+build.7")
        );

        assert_eq!(
            parse_windows_updater_temp_dir_version("Other-0.2.27-updater-abcd", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-0.2-updater-abcd", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-01.2.3-updater-abcd", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-0.2.27-updater-", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-1.2.3--updater-abcd", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-1.2.3+-updater-abcd", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-1.2.3-01-updater-abcd", "MyAgents"),
            None
        );
        assert_eq!(
            parse_windows_updater_temp_dir_version("MyAgents-0.2.27", "MyAgents"),
            None
        );
    }

    #[test]
    fn cleanup_removes_only_stale_owned_updater_dirs() {
        let root = tempfile::tempdir().unwrap();
        let owned_dir = root.path().join("MyAgents-0.2.9-updater-old");
        let owned_file = root.path().join("MyAgents-0.2.10-updater-file");
        let other_dir = root.path().join("Other-0.2.9-updater-old");
        std::fs::create_dir(&owned_dir).unwrap();
        std::fs::write(&owned_file, b"not a dir").unwrap();
        std::fs::create_dir(&other_dir).unwrap();

        let stats = cleanup_stale_windows_updater_temp_dirs_in(
            root.path(),
            "MyAgents",
            SystemTime::now() + Duration::from_secs(25 * 60 * 60),
            WINDOWS_UPDATER_TEMP_DIR_GRACE,
        )
        .unwrap();

        assert_eq!(stats.matched, 2);
        assert_eq!(stats.removed, 1);
        assert_eq!(stats.skipped_non_dir, 1);
        assert!(!owned_dir.exists());
        assert!(owned_file.exists());
        assert!(other_dir.exists());
    }

    #[test]
    fn cleanup_keeps_fresh_owned_updater_dirs() {
        let root = tempfile::tempdir().unwrap();
        let fresh_dir = root.path().join("MyAgents-0.2.9-updater-fresh");
        std::fs::create_dir(&fresh_dir).unwrap();

        let stats = cleanup_stale_windows_updater_temp_dirs_in(
            root.path(),
            "MyAgents",
            SystemTime::now(),
            WINDOWS_UPDATER_TEMP_DIR_GRACE,
        )
        .unwrap();

        assert_eq!(stats.matched, 1);
        assert_eq!(stats.removed, 0);
        assert_eq!(stats.skipped_fresh, 1);
        assert!(fresh_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_skips_symlinked_updater_dirs() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let link = root.path().join("MyAgents-0.2.9-updater-link");
        std::fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let stats = cleanup_stale_windows_updater_temp_dirs_in(
            root.path(),
            "MyAgents",
            SystemTime::now() + Duration::from_secs(25 * 60 * 60),
            WINDOWS_UPDATER_TEMP_DIR_GRACE,
        )
        .unwrap();

        assert_eq!(stats.matched, 1);
        assert_eq!(stats.removed, 0);
        assert_eq!(stats.skipped_reparse_or_symlink, 1);
        assert!(std::fs::symlink_metadata(&link).is_ok());
        assert!(target.exists());
    }
}
