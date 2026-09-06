// Tauri IPC commands for sidecar management and app operations
// Supports both legacy single-instance and new multi-instance APIs

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::logger;
use crate::perf_trace::{elapsed_ms, emit_perf_trace, trace_start, PerfTrace, PerfTraceName};
#[cfg(not(target_os = "windows"))]
use crate::sidecar::{begin_update_shutdown, shutdown_for_update_verified};
use crate::sidecar::{
    check_process_alive,
    ensure_sidecar_running,
    // Legacy exports
    get_sidecar_status,
    get_tab_server_url,
    get_tab_sidecar_status,
    restart_sidecar,
    start_global_sidecar,
    start_sidecar,
    // New multi-instance exports
    start_tab_sidecar,
    stop_all_sidecars,
    stop_sidecar,
    stop_tab_sidecar,
    LegacySidecarConfig,
    ManagedSidecar,
    SidecarStatus,
    GLOBAL_SIDECAR_ID,
};
use crate::{ulog_error, ulog_info, ulog_warn};

const NETWORK_PROBE_USER_AGENT: &str = "MyAgents-Network-Probe/1.0";
const PROXY_CONNECTIVITY_TEST_URL: &str = "https://www.google.com/generate_204";

// ============= Legacy Commands (for backward compatibility) =============

/// Command: Start the sidecar for a project (legacy single-instance)
#[tauri::command]
pub async fn cmd_start_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    agent_dir: String,
    initial_prompt: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(
        &app_handle,
        format!("[sidecar] Starting for project: {}", agent_dir),
    );

    let config = LegacySidecarConfig {
        port: find_available_port().unwrap_or(31415),
        agent_dir: PathBuf::from(&agent_dir),
        initial_prompt,
    };

    let manager = state.inner().clone();
    let start_app_handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        start_sidecar(&start_app_handle, &manager, config)?;
        get_sidecar_status(&manager)
    })
    .await
    .map_err(|error| format!("Sidecar start task failed: {error:?}"))?;

    match result {
        Ok(status) => {
            logger::info(
                &app_handle,
                format!("[sidecar] Started on port {}", status.port),
            );
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Failed to start: {}", e));
            Err(e)
        }
    }
}

/// Command: Stop the sidecar (legacy)
#[tauri::command]
pub async fn cmd_stop_sidecar(state: State<'_, ManagedSidecar>) -> Result<(), String> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_sidecar(&manager))
        .await
        .map_err(|error| format!("Sidecar stop task failed: {error:?}"))?
}

/// Command: Get sidecar status (legacy)
#[tauri::command]
pub async fn cmd_get_sidecar_status(
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    get_sidecar_status(&state)
}

/// Command: Get the backend server URL (legacy)
#[tauri::command]
pub async fn cmd_get_server_url(state: State<'_, ManagedSidecar>) -> Result<String, String> {
    let status = get_sidecar_status(&state)?;
    if status.running {
        Ok(format!("http://127.0.0.1:{}", status.port))
    } else {
        Err("Sidecar is not running".to_string())
    }
}

/// Command: Restart the sidecar (legacy)
#[tauri::command]
pub async fn cmd_restart_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Restart requested".to_string());

    let manager = state.inner().clone();
    let restart_app_handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let port = restart_sidecar(&restart_app_handle, &manager)?;
        let status = get_sidecar_status(&manager)?;
        Ok::<_, String>((port, status))
    })
    .await
    .map_err(|error| format!("Sidecar restart task failed: {error:?}"))?;

    match result {
        Ok((port, status)) => {
            logger::info(&app_handle, format!("[sidecar] Restarted on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Restart failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Ensure sidecar is running (legacy)
#[tauri::command]
pub async fn cmd_ensure_sidecar_running<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    let manager = state.inner().clone();
    let ensure_app_handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let port = ensure_sidecar_running(&ensure_app_handle, &manager)?;
        let status = get_sidecar_status(&manager)?;
        Ok::<_, String>((port, status))
    })
    .await
    .map_err(|error| format!("Sidecar ensure task failed: {error:?}"))?;

    match result {
        Ok((port, status)) => {
            logger::debug(
                &app_handle,
                format!("[sidecar] Ensured running on port {}", port),
            );
            Ok(status)
        }
        Err(e) => {
            logger::error(
                &app_handle,
                format!("[sidecar] Ensure running failed: {}", e),
            );
            Err(e)
        }
    }
}

/// Command: Check if sidecar process is alive (legacy)
#[tauri::command]
pub async fn cmd_check_sidecar_alive(state: State<'_, ManagedSidecar>) -> Result<bool, String> {
    check_process_alive(&state)
}

// ============= New Multi-instance Commands =============

/// Command: Start a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_start_tab_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
    agent_dir: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(
        &app_handle,
        format!(
            "[sidecar] Starting for tab {}, agent_dir: {:?}",
            tab_id, agent_dir
        ),
    );

    let agent_path = agent_dir.map(PathBuf::from);

    match start_tab_sidecar(&app_handle, &state, &tab_id, agent_path) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, &tab_id)?;
            logger::info(
                &app_handle,
                format!("[sidecar] Tab {} started on port {}", tab_id, port),
            );
            Ok(status)
        }
        Err(e) => {
            logger::error(
                &app_handle,
                format!("[sidecar] Tab {} failed to start: {}", tab_id, e),
            );
            Err(e)
        }
    }
}

/// Command: Stop a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_stop_tab_sidecar(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<(), String> {
    logger::info(&app_handle, format!("[sidecar] Stopping tab {}", tab_id));
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_tab_sidecar(&manager, &tab_id))
        .await
        .map_err(|error| format!("Sidecar stop task failed: {error:?}"))?
}

/// Command: Get server URL for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_server_url(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<String, String> {
    get_tab_server_url(&state, &tab_id)
}

/// Command: Get sidecar status for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_sidecar_status(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<SidecarStatus, String> {
    get_tab_sidecar_status(&state, &tab_id)
}

/// Command: Start the global sidecar (for Settings page)
#[tauri::command]
pub async fn cmd_start_global_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Starting global sidecar".to_string());

    let manager = state.inner().clone();
    let start_app_handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let port = start_global_sidecar(&start_app_handle, &manager)?;
        let status = get_tab_sidecar_status(&manager, GLOBAL_SIDECAR_ID)?;
        Ok::<_, String>((port, status))
    })
    .await
    .map_err(|error| format!("Global Sidecar start task failed: {error:?}"))?;

    match result {
        Ok((port, status)) => {
            logger::info(
                &app_handle,
                format!("[sidecar] Global sidecar started on port {}", port),
            );
            Ok(status)
        }
        Err(e) => {
            logger::error(
                &app_handle,
                format!("[sidecar] Global sidecar failed: {}", e),
            );
            Err(e)
        }
    }
}

/// Command: Get global sidecar server URL
#[tauri::command]
pub async fn cmd_get_global_server_url(state: State<'_, ManagedSidecar>) -> Result<String, String> {
    get_tab_server_url(&state, GLOBAL_SIDECAR_ID)
}

/// Command: Explicit IPC/debug stop; application lifecycle cleanup is owned by ExitRequested.
#[tauri::command]
pub async fn cmd_stop_all_sidecars(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Stopping all instances".to_string());
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The debug/admin stop is live-app reachable, so it must close process
        // birth while old generations drain. Update/app-exit callers already
        // own the same lifecycle gate before calling stop_all_sidecars.
        let _shutdown_guard = crate::sidecar::begin_update_shutdown()?;
        stop_all_sidecars(&manager, "ipc-command")
    })
    .await
    .map_err(|error| format!("Sidecar stop-all task failed: {error:?}"))?
}

/// Command: Shutdown for update — blocks until all child processes are fully terminated.
/// Must be called before relaunch() to prevent NSIS installer file-lock errors on Windows.
#[tauri::command]
pub async fn cmd_shutdown_for_update(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = state;
        logger::info(
            &app_handle,
            "[sidecar] Windows cmd_shutdown_for_update rejected; use install_pending_update"
                .to_string(),
        );
        return Err("USE_INSTALL_PENDING_UPDATE_ON_WINDOWS".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        logger::info(
            &app_handle,
            "[sidecar] Shutdown for update requested".to_string(),
        );
        let _guard = begin_update_shutdown()?;
        shutdown_for_update_verified(&app_handle, &state)
    }
}

// ============= Utility Functions =============

/// Find an available port
fn find_available_port() -> Option<u16> {
    let preferred = [31415, 31416, 31417, 31418, 31419];

    for &port in &preferred {
        if is_port_available(port) {
            return Some(port);
        }
    }

    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

// ============= Platform & Device Info Commands =============

/// Command: Get platform identifier (matches build target naming)
/// Returns: darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64, etc.
#[tauri::command]
pub fn cmd_get_platform() -> String {
    crate::device_identity::platform_identifier()
}

/// Command: Get or create device ID
/// Stored in ~/.myagents/device_id to persist across app reinstalls
/// Only regenerates if the file is deleted by user
#[tauri::command]
pub fn cmd_get_device_id() -> Result<String, String> {
    crate::device_identity::get_or_create_device_id()
}

/// Command: Get the full local device identity used by analytics and Space.
#[tauri::command]
pub fn cmd_get_device_identity() -> Result<crate::device_identity::DeviceIdentity, String> {
    crate::device_identity::current_device_identity()
}

// ============= Bundled Workspace Commands =============

#[derive(serde::Serialize)]
pub struct InitBundledWorkspaceResult {
    pub path: String,
    pub is_new: bool,
}

const BUNDLED_WORKSPACE_TEMPLATES_DIR: &str = "bundled-workspaces";
const DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID: &str = "mino";

/// Resolve one immutable workspace template shipped with the current app.
///
/// The bundled template is the only authority for creating a fresh builtin
/// workspace. A user-owned copy under `~/.myagents/projects/` must never be
/// used as a fallback source because it may already contain private identity,
/// memory, credentials references, or other user customizations.
fn resolve_bundled_workspace_template_at(
    resource_dir: &Path,
    template_id: &str,
) -> Result<PathBuf, String> {
    validate_template_id(template_id)?;
    let template_src = resource_dir
        .join(BUNDLED_WORKSPACE_TEMPLATES_DIR)
        .join(template_id);
    if !template_src.is_dir() || !template_src.join("CLAUDE.md").is_file() {
        return Err(format!(
            "Bundled workspace template '{}' not found or incomplete: {:?}",
            template_id, template_src
        ));
    }
    template_src
        .canonicalize()
        .map_err(|e| format!("Failed to resolve bundled workspace template: {}", e))
}

fn resolve_bundled_workspace_template<R: Runtime>(
    app_handle: &AppHandle<R>,
    template_id: &str,
) -> Result<PathBuf, String> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    resolve_bundled_workspace_template_at(&resource_dir, template_id)
}

/// Command: Initialize bundled workspace (mino) on first launch
/// Copies from the immutable app template to ~/.myagents/projects/mino/.
/// An existing user-owned workspace is never overwritten.
#[tauri::command]
pub fn cmd_initialize_bundled_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let mino_dest = home_dir.join(".myagents").join("projects").join("mino");

    // NOTE: Path::exists() follows symlinks, so a dangling
    // ~/.myagents/projects/mino link returns false here and we'd fall
    // through to copy_dir_recursive — which fails on EEXIST and surfaces
    // a workspace-init error to the user every launch until they clear
    // the link by hand. Same family as the cpSync crash fixed in
    // seedBundledSkills / cmd_sync_system_skills (CLAUDE.md red-line:
    // "用 existsSync / Path::exists() 当存在性探针"). Single fixed path
    // and graceful error → not crashing in production, so left as TODO
    // to avoid scope creep on the v0.2.6 hotfix.
    if mino_dest.exists() {
        return Ok(InitBundledWorkspaceResult {
            path: mino_dest.to_string_lossy().to_string(),
            is_new: false,
        });
    }

    let mino_src =
        resolve_bundled_workspace_template(&app_handle, DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID)?;

    ulog_info!(
        "[workspace] Initializing bundled workspace from {:?}",
        mino_src
    );
    copy_dir_recursive(&mino_src, &mino_dest)
        .map_err(|e| format!("Failed to copy mino workspace: {}", e))?;

    // Validate the copy produced a valid workspace
    if !mino_dest.join("CLAUDE.md").exists() {
        let _ = fs::remove_dir_all(&mino_dest);
        return Err("Bundled mino copy produced incomplete workspace".to_string());
    }

    Ok(InitBundledWorkspaceResult {
        path: mino_dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Create a dedicated workspace for an IM Bot by copying the bundled mino template.
/// Sanitizes the name for path safety and auto-appends numeric suffix on collision.
/// Returns the created workspace path.
#[tauri::command]
pub fn cmd_create_bot_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
    workspace_name: String,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".myagents").join("projects");

    // Sanitize name: remove @, replace non-alphanumeric (except CJK) with dash, trim
    let sanitized = sanitize_workspace_name(&workspace_name);
    if sanitized.is_empty() {
        return Err("Workspace name is empty after sanitization".to_string());
    }

    // Find available path (handle collisions with numeric suffix)
    let dest = find_available_workspace_path(&projects_dir, &sanitized);

    let mino_src =
        resolve_bundled_workspace_template(&app_handle, DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID)?;
    ulog_info!(
        "[workspace] Copying bundled mino from {:?} to {:?}",
        mino_src,
        dest
    );
    copy_dir_recursive(&mino_src, &dest)
        .map_err(|e| format!("Failed to copy workspace template: {}", e))?;

    // Validate: CLAUDE.md must exist in destination (marker file for a valid mino template)
    if !dest.join("CLAUDE.md").exists() {
        let _ = fs::remove_dir_all(&dest);
        return Err("Bundled mino copy produced incomplete workspace".to_string());
    }

    ulog_info!("[workspace] Bot workspace created: {:?}", dest);
    Ok(InitBundledWorkspaceResult {
        path: dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Remove a workspace directory created by `cmd_create_bot_workspace`.
/// Safety: only allows deleting directories under `~/.myagents/projects/`.
#[tauri::command]
pub fn cmd_remove_bot_workspace(workspace_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".myagents").join("projects");

    let target = PathBuf::from(&workspace_path);
    // Canonicalize both paths to prevent traversal attacks
    let canon_projects = projects_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve projects dir: {}", e))?;
    let canon_target = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    if !canon_target.starts_with(&canon_projects) || canon_target == canon_projects {
        return Err("Refusing to delete: path is not inside ~/.myagents/projects/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove workspace directory: {}", e))?;

    Ok(())
}

/// Command: Remove a template directory from ~/.myagents/templates/.
/// Safety: only allows deleting directories under ~/.myagents/templates/.
#[tauri::command]
pub fn cmd_remove_template_folder(template_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".myagents").join("templates");

    if !templates_dir.exists() {
        return Err("Templates directory does not exist".to_string());
    }

    let target = PathBuf::from(&template_path);

    // If the folder no longer exists, treat as success (already cleaned up)
    if !target.exists() {
        ulog_info!("[template] Template folder already removed: {:?}", target);
        return Ok(());
    }

    let canon_templates = templates_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
    let canon_target = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve template path: {}", e))?;

    if !canon_target.starts_with(&canon_templates) || canon_target == canon_templates {
        return Err("Refusing to delete: path is not inside ~/.myagents/templates/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove template directory: {}", e))?;

    ulog_info!("[template] Removed template folder: {:?}", canon_target);
    Ok(())
}

/// Sanitize a workspace name for use as a directory name.
/// Keeps alphanumeric, CJK characters, hyphens, and underscores.
fn sanitize_workspace_name(name: &str) -> String {
    let result: String = name
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else if c == ' ' || c == '@' || c == '/' || c == '\\' {
                Some('-')
            } else if c > '\u{2E7F}' {
                // Keep CJK and other non-ASCII characters
                Some(c)
            } else {
                None
            }
        })
        .collect();

    // Trim leading/trailing dashes and collapse consecutive dashes
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in result.chars() {
        if c == '-' {
            if !prev_dash && !collapsed.is_empty() {
                collapsed.push(c);
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    collapsed.trim_end_matches('-').to_string()
}

/// Find an available workspace path, appending numeric suffix on collision.
fn find_available_workspace_path(projects_dir: &Path, base_name: &str) -> PathBuf {
    let first = projects_dir.join(base_name);
    if !first.exists() {
        return first;
    }
    for i in 2..=100 {
        let candidate = projects_dir.join(format!("{}-{}", base_name, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Extremely unlikely fallback
    projects_dir.join(format!(
        "{}-{}",
        base_name,
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("x")
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // Skip .git and node_modules
        if name == ".git" || name == "node_modules" {
            continue;
        }
        // Skip symlinks to avoid circular copies and unexpected data
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let dest = dst.join(name);
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(&entry.path(), &dest)?;
        }
    }
    Ok(())
}

// ============= Workspace Template Commands =============

/// Command: Create a workspace from a user template (copy source dir to dest dir).
/// Reuses copy_dir_recursive which skips .git and node_modules.
/// Safety: source_path must be under ~/.myagents/templates/.
/// The dest_path parent must exist; the dest_path itself must NOT exist.
#[tauri::command]
pub fn cmd_create_workspace_from_template(
    source_path: String,
    dest_path: String,
) -> Result<(), String> {
    let src = PathBuf::from(&source_path);
    let dst = PathBuf::from(&dest_path);

    if !src.exists() {
        return Err(format!("Template source not found: {}", source_path));
    }

    // Validate source is under ~/.myagents/templates/
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".myagents").join("templates");
    if templates_dir.exists() {
        let canon_templates = templates_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
        let canon_src = src
            .canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        if !canon_src.starts_with(&canon_templates) {
            return Err("Source path must be inside ~/.myagents/templates/".to_string());
        }
    } else {
        return Err("Templates directory does not exist".to_string());
    }

    if dst.exists() {
        return Err(format!("Destination already exists: {}", dest_path));
    }
    // Ensure parent directory exists
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    ulog_info!("[template] Copying template from {:?} to {:?}", src, dst);
    copy_dir_recursive(&src, &dst).map_err(|e| format!("Failed to copy template: {}", e))?;

    Ok(())
}

/// Command: Create a workspace from a bundled (preset) template.
/// Copies from app resources/bundled-workspaces/<template_id> to dest_path.
/// Safety: template_id is sanitized to prevent path traversal.
#[tauri::command]
pub fn cmd_create_workspace_from_bundled_template<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: String,
    dest_path: String,
) -> Result<(), String> {
    // Sanitize template_id (single source of truth in `validate_template_id`).
    validate_template_id(&template_id)?;

    let dst = PathBuf::from(&dest_path);
    if dst.exists() {
        return Err(format!("Destination already exists: {}", dest_path));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    let template_src = resolve_bundled_workspace_template(&app_handle, &template_id)?;
    ulog_info!(
        "[template] Copying bundled template '{}' from {:?} to {:?}",
        template_id,
        template_src,
        dst
    );
    copy_dir_recursive(&template_src, &dst)
        .map_err(|e| format!("Failed to copy bundled template: {}", e))?;
    Ok(())
}

/// Validate a bundled template_id — rejects path separators, traversal, and empty IDs.
/// Single source of truth so all template-using commands inherit the same rules.
fn validate_template_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("Invalid template ID".to_string());
    }
    Ok(())
}

/// Validate a workspace destination path for template apply. Reuses `validate_file_path`'s
/// system/credential blacklist (so we can't accidentally write template files into `~/.ssh`,
/// `/etc`, or other protected dirs) AND requires the path to exist as a real directory.
/// Returns the resolved (`..`-free) absolute path so the caller uses a single canonical form.
fn validate_workspace_dest(dest_path: &str) -> Result<PathBuf, String> {
    let resolved = validate_file_path(dest_path)?;
    if !resolved.exists() {
        return Err(format!("Workspace does not exist: {}", dest_path));
    }
    if !resolved.is_dir() {
        return Err(format!("Workspace path is not a directory: {}", dest_path));
    }
    Ok(resolved)
}

/// Resolve a template source directory from either a bundled template_id or a user
/// template source_path. Returns the CANONICAL path (symlinks resolved) — callers must
/// use this exact path for any subsequent reads/copies, otherwise a TOCTOU window opens
/// where an attacker could replace the validated source with a symlink to elsewhere
/// between this validation and the later read.
fn resolve_template_source<R: Runtime>(
    app_handle: &AppHandle<R>,
    template_id: Option<String>,
    source_path: Option<String>,
) -> Result<PathBuf, String> {
    if let Some(id) = template_id.as_deref() {
        return resolve_bundled_workspace_template(app_handle, id);
    }
    if let Some(p) = source_path.as_deref() {
        let src = PathBuf::from(p);
        if !src.exists() {
            return Err(format!("Template source not found: {}", p));
        }
        let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
        let templates_dir = home_dir.join(".myagents").join("templates");
        if !templates_dir.exists() {
            return Err("Templates directory does not exist".to_string());
        }
        let canon_templates = templates_dir
            .canonicalize()
            .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
        let canon_src = src
            .canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        if !canon_src.starts_with(&canon_templates) {
            return Err("Source path must be inside ~/.myagents/templates/".to_string());
        }
        // Return canonical path (not the original `src`) — closes the TOCTOU between
        // validation and consumption, since the caller will read from canon_src directly.
        return Ok(canon_src);
    }
    Err("Either template_id or source_path is required".to_string())
}

/// Walk a template directory and collect relative file paths (skipping .git / node_modules /
/// symlinks). Used by the preview command to compute overwrite vs add classifications.
fn list_template_files_rel(src: &Path) -> std::io::Result<Vec<PathBuf>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let p = entry.path();
            if file_type.is_dir() {
                walk(root, &p, out)?;
            } else if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(src, src, &mut out)?;
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct TemplateApplyPreview {
    pub overwrite: Vec<String>,
    pub add: Vec<String>,
}

/// Command: Preview which files a template would overwrite vs add when applied to an
/// existing workspace. Used to drive the confirmation UI before the destructive merge.
/// Either `template_id` (bundled) or `source_path` (user template) must be provided.
#[tauri::command]
pub fn cmd_template_apply_preview<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: Option<String>,
    source_path: Option<String>,
    dest_path: String,
) -> Result<TemplateApplyPreview, String> {
    // `validate_workspace_dest` forbids system/credential paths (mirroring the
    // file-read/write commands' blacklist) so a misbehaving renderer can't redirect a
    // template apply at e.g. `~/.ssh` or `/etc`.
    let dst = validate_workspace_dest(&dest_path)?;
    let src = resolve_template_source(&app_handle, template_id, source_path)?;
    let files =
        list_template_files_rel(&src).map_err(|e| format!("Failed to walk template: {}", e))?;
    let mut overwrite = Vec::new();
    let mut add = Vec::new();
    for rel in files {
        let target = dst.join(&rel);
        validate_template_target(&target)?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if target.exists() {
            overwrite.push(rel_str);
        } else {
            add.push(rel_str);
        }
    }
    overwrite.sort();
    add.sort();
    Ok(TemplateApplyPreview { overwrite, add })
}

/// Command: Apply a template to an EXISTING workspace by merging files (same-name overwrite,
/// other files preserved). This is the destructive counterpart to `cmd_template_apply_preview`
/// — callers should always preview + confirm with the user before invoking apply.
#[tauri::command]
pub fn cmd_apply_template_to_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: Option<String>,
    source_path: Option<String>,
    dest_path: String,
) -> Result<(), String> {
    let dst = validate_workspace_dest(&dest_path)?;
    let src = resolve_template_source(&app_handle, template_id, source_path)?;
    ulog_info!(
        "[template] Merging template from {:?} into existing workspace {:?}",
        src,
        dst
    );
    merge_dir_recursive_validated(&src, &dst)?;
    Ok(())
}

/// Command: Copy a local folder into the templates library (~/.myagents/templates/<name>/).
/// Returns the destination path.
#[tauri::command]
pub fn cmd_copy_folder_to_templates(
    source_path: String,
    template_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() || !src.is_dir() {
        return Err(format!("Source folder not found: {}", source_path));
    }

    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".myagents").join("templates");
    fs::create_dir_all(&templates_dir)
        .map_err(|e| format!("Failed to create templates dir: {}", e))?;

    // Sanitize name and find available path
    let sanitized = sanitize_workspace_name(&template_name);
    if sanitized.is_empty() {
        return Err("Template name is empty after sanitization".to_string());
    }
    let dest = find_available_workspace_path(&templates_dir, &sanitized);

    // Prevent overlapping source/destination (would cause infinite recursion)
    let canon_src = src
        .canonicalize()
        .map_err(|e| format!("Failed to resolve source: {}", e))?;
    let canon_templates = templates_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
    if canon_src.starts_with(&canon_templates) {
        return Err("Source folder is already inside the templates directory".to_string());
    }

    ulog_info!(
        "[template] Copying folder {:?} to template library {:?}",
        src,
        dest
    );
    copy_dir_recursive(&src, &dest)
        .map_err(|e| format!("Failed to copy to template library: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

// ============= Admin Agent Sync =============

const ADMIN_AGENT_VERSION: &str = "27";

/// Helper-bundled paths (relative to `~/.myagents/`) that previous versions
/// shipped but that have since been retired.
///
/// `merge_dir_recursive` is overwrite-only ("never deletes"), so a file
/// removed from the bundle would persist on upgraders' disks indefinitely
/// — letting a retired skill keep loading inside the helper agent and
/// silently diverge fresh-install from upgrade behavior. Each retire
/// MUST also append the relative path here so the next sync removes it.
///
/// Once `~/.myagents/.admin-agent-version` has rolled past the version
/// that introduced the retire, the entry is harmless to keep (it just
/// no-ops on absent paths).
const RETIRED_ADMIN_PATHS: &[&str] = &[
    // v16: /self-config promoted to global system skill /myagents-cli
    ".claude/skills/self-config",
];

/// Merge bundled admin agent files into ~/.myagents/
/// Version-gated: only runs when ADMIN_AGENT_VERSION changes.
#[tauri::command]
pub async fn cmd_sync_admin_agent<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || sync_admin_agent_blocking(app_handle))
        .await
        .map_err(|e| format!("admin-agent sync task failed: {}", e))?
}

fn sync_admin_agent_blocking<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let dest = home.join(".myagents");

    // Version gate
    let ver_file = dest.join(".admin-agent-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == ADMIN_AGENT_VERSION {
            return Ok(false);
        }
    }

    // Source: app resources
    let res = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let src = res.join("bundled-agents").join("myagents_helper");
    if !src.exists() {
        return Err(format!("Admin agent not found: {:?}", src));
    }

    // Pre-merge: remove retired paths so they don't linger on upgraders'
    // disks. Use symlink_metadata (not Path::exists) for symlink-trap
    // safety, mirroring cmd_sync_system_skills.
    for rel in RETIRED_ADMIN_PATHS {
        let target = dest.join(rel);
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                let removed = if meta.file_type().is_symlink() || meta.is_file() {
                    fs::remove_file(&target)
                } else {
                    fs::remove_dir_all(&target)
                };
                if let Err(e) = removed {
                    ulog_warn!(
                        "[admin-agent] failed to clear retired path {}: {} — continuing",
                        rel,
                        e
                    );
                } else {
                    ulog_info!("[admin-agent] retired {}", rel);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Already absent — fresh install or already cleaned.
            }
            Err(e) => {
                ulog_warn!(
                    "[admin-agent] symlink_metadata({}) failed: {} — continuing",
                    rel,
                    e
                );
            }
        }
    }

    // Merge into ~/.myagents/
    merge_dir_recursive(&src, &dest).map_err(|e| format!("Merge failed: {}", e))?;

    fs::write(&ver_file, ADMIN_AGENT_VERSION)
        .map_err(|e| format!("Version write failed: {}", e))?;

    ulog_info!("[admin-agent] Synced v{}", ADMIN_AGENT_VERSION);
    Ok(true)
}

// ============= System Skills Sync =============
//
// A distinct tier from the "seed once" bundled-skills behaviour
// (src/server/index.ts::seedBundledSkills). Those are open-ended utility
// skills users are encouraged to customise — we copy them in on first
// launch and then never touch them again.
//
// System skills are different: they encode flow-level contracts that
// must evolve in lockstep with Rust / CLI / shape changes. Example:
// `/task-implement` used to call `myagents task update-progress <id>
// "..."`; when we removed that CLI in v0.1.69+ the skill had to update
// in the same release, else existing users' AI calls would fail with
// "unknown command". The seed-once path can't deliver updates — we
// need version-gated force-overwrite, same pattern as ADMIN_AGENT
// and CLI above.
//
// To add a new system skill: put the folder in bundled-skills/, append
// its name to SYSTEM_SKILLS below, and bump SYSTEM_SKILLS_VERSION. The
// matching exclusion list in src/server/index.ts::seedBundledSkills
// MUST be kept in sync (comment there points back here).

const SYSTEM_SKILLS_VERSION: &str = "57";

/// One process-wide transaction owner for the versioned system-skill
/// snapshot. Startup automation and ConfigProvider may request convergence at
/// the same time; both must join this lock before any remove/copy/version
/// operation so a Runtime can never scan a half-replaced directory tree.
static SYSTEM_SKILLS_SYNC_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// Skills that ship with the app and MUST stay at the bundled version —
/// the app's flows depend on them, users are not meant to customise.
/// Keep in sync with the exclusion list in Bun's `seedBundledSkills()`.
const SYSTEM_SKILLS: &[&str] = &[
    // Complete Skill+CLI; content updates with the app, user may disable discovery.
    "cuse",
    // v51: one product-owned Task discussion workflow replaces the former
    // alignment/executor pair. Ordinary dispatch now hands task.md directly
    // to the Runtime, so execution no longer depends on a Skill name.
    "myagents-task-alignment",
    // v10: ultra-research removed — not generic enough to ship as system
    // skill. Existing installs retain the dir at ~/.myagents/skills/
    // ultra-research/ until the user deletes it (no orphan cleanup logic).
    "download-anything",
    // v52: myagents-cli documents physical local directory/.zip/.skill
    // installs and the CLI-owned explicit-relative cwd boundary.
    // v9: myagents-cli promoted from helper-bundled skill (was at
    // bundled-agents/myagents_helper/.claude/skills/self-config/) to a
    // global system skill. Every AI session inside MyAgents — Chat / IM Bot
    // / Cron / Helper — should be able to drive the product's own
    // capabilities (cron, task center, MCP, Provider, channels, plugins,
    // skills, Cloud Space, widgets) through the CLI. SKILL.md changes track CLI surface
    // changes, so it must force-overwrite on version bumps.
    "myagents-cli",
    // v49: progressively disclosed contract for the bundled local document
    // converter. It is required because every Runtime must discover the same
    // App-owned job surface without an always-on prompt section.
    "myagents-anydoc",
    // v54: progressive instructions for the Session-scoped local attachment
    // transcription CLI. Identity stays product-injected; the Skill exposes
    // only the public job and artifact contract.
    "myagents-speech-recognition",
    // v53: Task automation documents the stable Agent-facing receipt,
    // idempotent run semantics, and existing result channels. Command
    // Detector protocol remains a progressive reference, not a competing
    // Sensor product entry.
    "myagents-task-automation",
    // v35: product-use knowledge shared by every MyAgents session. It owns
    // stable user-facing concepts, feature relationships, prerequisites and
    // expected behaviour; live state/actions stay in myagents-cli and the
    // helper-local support skill owns diagnosis.
    "myagents-docs",
    // v18: tool-creator — meta-skill for the CLI tool registry (PRD 0.2.36
    // cli_first_tool_registry). Teaches AI to author standards-compliant
    // Agent-CLI tools (tool.json + entry + readme/--help contract) and
    // register them via `myagents tool add`. System skill because its
    // contract must track the registry's server-side validation (800-char
    // description cap, reserved names) in lockstep.
    "tool-creator",
    // v33: MyAgents memory maintenance skills. These are managed flow
    // targets, so their bundled contracts must stay in lockstep with the
    // hidden scheduler, injected-turn prompt, and rule-substrate templates.
    "myagents-memory-update",
    "myagents-memory-gardener",
    "myagents-memory-molt",
    // v50: skill-creator promoted from utility → system skill. Its authoring
    // and evaluation workflow evolves with the bundled scripts, so existing
    // installs must receive updates instead of retaining the seed-once copy.
    "skill-creator",
    // v29: prompt-writer promoted from utility → system skill. It is pure
    // methodology (no product-surface coupling), but as a utility skill the
    // seed-once path meant existing installs never received content
    // improvements. System status trades user customisation (overwritten on
    // every version bump) for keeping the methodology current.
    "prompt-writer",
];

/// Product-owned system skills whose former independent workflow must not
/// survive an upgrade. These directories were force-overwritten by MyAgents,
/// so removing the exact retired names cannot delete a user-owned skill.
const RETIRED_SYSTEM_SKILLS: &[&str] = &["myagents-sensor", "task-alignment", "task-implement"];

/// Force-sync every system skill from the app bundle to
/// `~/.myagents/skills/<name>/`. Runs once per `SYSTEM_SKILLS_VERSION`
/// bump — idempotent otherwise. User edits to these directories will
/// be overwritten when the version changes, by design (see module
/// comment above).
///
/// async + spawn_blocking (cross-review 0.2.32): this command recursively
/// deletes/copies skill directories and is invoked during config load
/// (ConfigProvider). As a synchronous command it ran on the main thread —
/// on macOS that's WKWebView's UI thread, so a version bump or a slow disk
/// froze the whole WebView for the duration of the sweep (same class as the
/// 0.2.31 cmd_ensure_session_sidecar freeze). The healthy-install fast path
/// (version stamp + per-skill SKILL.md stat) is also disk I/O, so the entire
/// body moves off-thread, not just the copy loop.
#[tauri::command]
pub async fn cmd_sync_system_skills<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    sync_system_skills_for_startup(app_handle).await
}

/// Force-sync and then verify the complete versioned system-skill snapshot.
///
/// This is shared by the renderer command and Rust startup automation so
/// hidden maintenance tasks never depend on ConfigProvider having mounted.
pub(crate) async fn sync_system_skills_for_startup<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    let sync_lock = SYSTEM_SKILLS_SYNC_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _transaction = sync_lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let changed = sync_system_skills_blocking(app_handle)?;
        ensure_system_skills_installation_current()?;
        Ok(changed)
    })
    .await
    .map_err(|e| format!("system-skills sync task failed: {}", e))?
}

fn ensure_system_skills_installation_current() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    ensure_system_skills_installation_current_at(&home.join(".myagents"))
}

fn ensure_system_skills_installation_current_at(myagents_dir: &Path) -> Result<(), String> {
    let version_path = myagents_dir.join(".system-skills-version");
    let installed_version = fs::read_to_string(&version_path).map_err(|e| {
        format!(
            "system skills are not ready: failed to read {}: {}",
            version_path.display(),
            e
        )
    })?;
    if installed_version.trim() != SYSTEM_SKILLS_VERSION {
        return Err(format!(
            "system skills are not ready: installed version {:?}, expected {}",
            installed_version.trim(),
            SYSTEM_SKILLS_VERSION
        ));
    }

    let skills_dir = myagents_dir.join("skills");
    if !all_installed_system_skills_complete(&skills_dir) {
        return Err(format!(
            "system skills are not ready: one or more required SKILL.md files are missing under {}",
            skills_dir.display()
        ));
    }
    if !retired_system_skills_absent(&skills_dir) {
        return Err(format!(
            "system skills are not ready: retired product skills remain under {}",
            skills_dir.display()
        ));
    }
    Ok(())
}

fn sync_system_skills_blocking<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let myagents_dir = home.join(".myagents");
    let skills_dir = myagents_dir.join("skills");

    let res = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let bundled_skills_dir = res.join("bundled-skills");
    // The independent Cuse release can change without a hand-edited Skill stamp.
    // Compare actual app bytes, including Developer ID signatures, before skipping.
    let cuse_current = !crate::cuse_skill::supported()
        || crate::cuse_skill::matches_bundle(
            &bundled_skills_dir.join("cuse"),
            &skills_dir.join("cuse"),
        );

    // Version gate — skip the whole sweep if we've already landed
    // SYSTEM_SKILLS_VERSION AND every system skill is actually present on disk.
    //
    // The version stamp alone is NOT proof the install is healthy (issue #321):
    // the old destructive sync could write the version after leaving empty
    // `~/.myagents/skills/<name>/` dirs, freezing that broken state forever.
    // Validating the on-disk result here makes the gate self-healing — a frozen
    // or incomplete install re-runs the (now non-destructive) sync regardless of
    // whether the version happened to be bumped. Healthy installs still
    // early-return after the cheap per-skill SKILL.md stat.
    let ver_file = myagents_dir.join(".system-skills-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == SYSTEM_SKILLS_VERSION
            && cuse_current
            && all_installed_system_skills_complete(&skills_dir)
            && retired_system_skills_absent(&skills_dir)
        {
            return Ok(false);
        }
    }

    if !bundled_skills_dir.exists() {
        return Err(format!(
            "bundled-skills not found: {:?}",
            bundled_skills_dir
        ));
    }

    fs::create_dir_all(&skills_dir).map_err(|e| format!("Failed to create skills dir: {}", e))?;

    let mut synced = Vec::new();
    let mut missing = Vec::new();
    let mut incomplete = Vec::new();
    for skill_name in SYSTEM_SKILLS {
        if *skill_name == "cuse" && !crate::cuse_skill::supported() {
            continue;
        }
        let src = bundled_skills_dir.join(skill_name);
        let dst = skills_dir.join(skill_name);
        match sync_one_system_skill(&src, &dst)
            .map_err(|e| format!("sync {}: {}", skill_name, e))?
        {
            SystemSkillSync::Synced => synced.push(*skill_name),
            SystemSkillSync::SkippedMissingSource => {
                // Packaging miss — skill listed in SYSTEM_SKILLS but absent
                // from the bundle. Log and continue so one missing skill
                // doesn't block the rest.
                ulog_warn!("[system-skills] bundled skill missing: {}", skill_name);
                missing.push(skill_name.to_string());
            }
            SystemSkillSync::SkippedIncompleteSource => {
                // Packaging miss — the bundled source dir exists but has no
                // SKILL.md (issue #321: the Windows resource tree shipped some
                // system skills empty). `sync_one_system_skill` left any
                // existing good copy untouched. Don't advance the version gate
                // below so a corrected bundle re-syncs on the next launch.
                ulog_warn!(
                    "[system-skills] bundled skill incomplete (no SKILL.md), preserved existing copy: {}",
                    skill_name
                );
                incomplete.push(skill_name.to_string());
            }
        }
    }

    // Do not retire the old product entry until its unified replacement is
    // actually installed. This preserves the existing non-destructive sync
    // guarantee when a bundle is incomplete, while still removing the exact
    // obsolete workflow before the new version stamp is committed.
    let retired = if skill_dir_is_complete(&skills_dir.join("myagents-task-automation")) {
        remove_retired_system_skills(&skills_dir)?
    } else {
        Vec::new()
    };

    // Only advance the version gate when every system skill actually landed.
    // A missing/incomplete bundled source is a packaging defect; freezing the
    // version on a partial sweep would make the broken state permanent (the
    // old behavior that produced empty `~/.myagents/skills/<name>` dirs on
    // Windows — issue #321). Leaving the version unwritten retries next launch
    // and keeps the warnings above visible.
    let complete =
        missing.is_empty() && incomplete.is_empty() && retired_system_skills_absent(&skills_dir);
    if complete {
        fs::write(&ver_file, SYSTEM_SKILLS_VERSION)
            .map_err(|e| format!("version write failed: {}", e))?;
    }

    ulog_info!(
        "[system-skills] Synced v{} (complete={}) — ok: {:?}, retired: {:?}, missing: {:?}, incomplete: {:?}",
        SYSTEM_SKILLS_VERSION,
        complete,
        synced,
        retired,
        missing,
        incomplete
    );
    Ok(complete)
}

/// Outcome of syncing one system skill from the app bundle into
/// `~/.myagents/skills/`.
enum SystemSkillSync {
    /// Source was valid and copied over `dst`.
    Synced,
    /// Source directory does not exist in the bundle at all.
    SkippedMissingSource,
    /// Source directory exists but is not a valid skill (no SKILL.md). The
    /// existing `dst`, if any, was left untouched.
    SkippedIncompleteSource,
}

/// A skill directory is "complete" iff it carries a top-level `SKILL.md` — the
/// one file every SKILL.md-gated scanner (Settings panel, slash picker, SDK
/// runtime) requires to recognize a skill. An empty / SKILL.md-less directory
/// is a packaging defect, not a skill. Applies equally to a bundled source dir
/// and an installed `~/.myagents/skills/<name>` dir.
fn skill_dir_is_complete(dir: &Path) -> bool {
    if dir.file_name().is_some_and(|name| name == "cuse") {
        return crate::cuse_skill::complete(dir);
    }
    dir.join("SKILL.md").is_file()
}

/// True iff every system skill has a valid SKILL.md on disk under `skills_dir`.
/// Used to bypass the version fast-path so a frozen/incomplete install (issue
/// #321) self-heals instead of trusting the version stamp.
fn all_installed_system_skills_complete(skills_dir: &Path) -> bool {
    SYSTEM_SKILLS.iter().all(|name| {
        (*name == "cuse" && !crate::cuse_skill::supported())
            || skill_dir_is_complete(&skills_dir.join(name))
    })
}

fn retired_system_skills_absent(skills_dir: &Path) -> bool {
    RETIRED_SYSTEM_SKILLS.iter().all(|name| {
        fs::symlink_metadata(skills_dir.join(name))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn remove_retired_system_skills(skills_dir: &Path) -> Result<Vec<&'static str>, String> {
    let mut removed = Vec::new();
    for name in RETIRED_SYSTEM_SKILLS {
        let path = skills_dir.join(name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "failed to inspect retired system skill {}: {}",
                    path.display(),
                    error
                ));
            }
        };
        let result = if metadata.file_type().is_symlink() || metadata.is_file() {
            fs::remove_file(&path)
        } else {
            fs::remove_dir_all(&path)
        };
        result.map_err(|error| {
            format!(
                "failed to remove retired system skill {}: {}",
                path.display(),
                error
            )
        })?;
        removed.push(*name);
    }
    Ok(removed)
}

/// Sync one system skill `src` → `dst`. Refuses to clear an existing good
/// `dst` unless the source is a complete skill, so a packaging miss can never
/// replace a working installed copy with an empty directory (issue #321: the
/// old path did `remove_dir_all(dst)` BEFORE merging, so an empty bundled
/// source destroyed the user's copy and then wrote the version file, making
/// the empty state permanent and invisible to every panel/scan).
fn sync_one_system_skill(src: &Path, dst: &Path) -> Result<SystemSkillSync, String> {
    if !src.exists() {
        return Ok(SystemSkillSync::SkippedMissingSource);
    }
    if !skill_dir_is_complete(src) {
        return Ok(SystemSkillSync::SkippedIncompleteSource);
    }
    // Source is a valid skill — safe to replace the existing target wholesale.
    // SYSTEM_SKILLS_VERSION bumps mean "the whole skill snapshot is new".
    //
    // Path::exists() follows symlinks → returns false for broken links, so a
    // dangling `~/.myagents/skills/<name>` left by the user (e.g. pointing at
    // a moved repo) would slip past and then trip `fs::create_dir_all` in
    // `merge_dir_recursive` with EEXIST, failing the whole startup sync.
    // symlink_metadata() does NOT follow, so it's the right probe for "is
    // there anything at this path, even a dangling link?".
    match fs::symlink_metadata(dst) {
        Ok(meta) => {
            let removed = if meta.file_type().is_symlink() || meta.is_file() {
                fs::remove_file(dst)
            } else {
                fs::remove_dir_all(dst)
            };
            if let Err(e) = removed {
                ulog_warn!(
                    "[system-skills] failed to clear {}: {} — falling back to merge",
                    dst.display(),
                    e
                );
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Nothing there, fresh seed below.
        }
        Err(e) => {
            ulog_warn!(
                "[system-skills] symlink_metadata({}) failed: {} — falling back to merge",
                dst.display(),
                e
            );
        }
    }
    merge_dir_recursive(src, dst).map_err(|e| e.to_string())?;
    Ok(SystemSkillSync::Synced)
}

/// Merge src/ into dst/ recursively. Creates missing dirs, overwrites files, never deletes.
fn merge_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            continue;
        }
        let d = dst.join(&name);
        if ft.is_dir() {
            merge_dir_recursive(&entry.path(), &d)?;
        } else {
            fs::copy(&entry.path(), &d)?;
        }
    }
    Ok(())
}

/// Merge a renderer-selected template into a workspace while validating every
/// final output path. Validating only the workspace root is insufficient when
/// the blacklist contains an exact file such as Managed Codex `auth.json`.
fn merge_dir_recursive_validated(src: &Path, dst: &Path) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Failed to get home dir")?;
    merge_dir_recursive_validated_with_home(src, dst, &home)
}

fn merge_dir_recursive_validated_with_home(
    src: &Path,
    dst: &Path,
    home: &Path,
) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create template directory: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read template: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read template entry: {e}"))?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" {
            continue;
        }
        let ft = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect template entry: {e}"))?;
        if ft.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        validate_template_target_with_home(&target, home)?;
        if ft.is_dir() {
            merge_dir_recursive_validated_with_home(&entry.path(), &target, home)?;
        } else {
            fs::copy(entry.path(), &target)
                .map_err(|e| format!("Failed to copy template file: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod bundled_workspace_template_tests {
    use super::{
        resolve_bundled_workspace_template_at, BUNDLED_WORKSPACE_TEMPLATES_DIR,
        DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID,
    };
    use std::path::Path;

    #[test]
    fn committed_mino_template_is_complete_and_resolves_from_resource_root() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri must live under the repository root");

        let resolved =
            resolve_bundled_workspace_template_at(repo_root, DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID)
                .expect("committed mino template must resolve");

        assert!(resolved.join("CLAUDE.md").is_file());
        assert!(resolved.ends_with(
            Path::new(BUNDLED_WORKSPACE_TEMPLATES_DIR).join(DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID)
        ));
    }

    #[test]
    fn bundled_template_resolver_rejects_traversal_and_incomplete_sources() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri must live under the repository root");

        assert_eq!(
            resolve_bundled_workspace_template_at(repo_root, "../mino").unwrap_err(),
            "Invalid template ID"
        );
        assert!(
            resolve_bundled_workspace_template_at(repo_root, "missing-template")
                .unwrap_err()
                .contains("not found or incomplete")
        );
    }
}

#[cfg(test)]
mod system_skills_tests {
    use super::{
        all_installed_system_skills_complete, ensure_system_skills_installation_current_at,
        remove_retired_system_skills, retired_system_skills_absent, skill_dir_is_complete,
        sync_one_system_skill, SystemSkillSync, ADMIN_AGENT_VERSION, RETIRED_SYSTEM_SKILLS,
        SYSTEM_SKILLS, SYSTEM_SKILLS_VERSION,
    };
    use crate::workspace_files::skills_config::REQUIRED_SYSTEM_SKILLS;
    use std::fs;

    // Issue #321: a Windows install shipped some system-skill source dirs
    // empty (no SKILL.md). The old sync removed the user's good copy, merged
    // the empty source, then wrote the version file — freezing an empty,
    // panel-invisible directory permanently. These tests pin the invariant
    // that an incomplete source can never destroy a working copy, and that the
    // version gate validates on-disk state rather than trusting the stamp.

    #[test]
    fn complete_requires_skill_md() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("foo");
        fs::create_dir_all(&dir).unwrap();
        assert!(!skill_dir_is_complete(&dir), "empty dir is not a skill");
        fs::write(dir.join("SKILL.md"), "x").unwrap();
        assert!(skill_dir_is_complete(&dir), "dir with SKILL.md is a skill");
    }

    #[test]
    fn v57_keeps_cuse_and_product_skills_aligned() {
        assert_eq!(SYSTEM_SKILLS_VERSION, "57");
        assert!(SYSTEM_SKILLS.contains(&"cuse"));
        assert!(!REQUIRED_SYSTEM_SKILLS.contains(&"cuse"));
        assert!(SYSTEM_SKILLS.contains(&"myagents-task-alignment"));
        assert!(RETIRED_SYSTEM_SKILLS.contains(&"task-alignment"));
        assert!(RETIRED_SYSTEM_SKILLS.contains(&"task-implement"));
        assert!(SYSTEM_SKILLS.contains(&"skill-creator"));
        let bundled = include_str!("../../bundled-skills/myagents-cli/SKILL.md");
        let anydoc = include_str!("../../bundled-skills/myagents-anydoc/SKILL.md");
        let speech = include_str!("../../bundled-skills/myagents-speech-recognition/SKILL.md");
        let description = bundled
            .split("---")
            .nth(1)
            .expect("myagents-cli frontmatter");
        assert!(!description.to_ascii_lowercase().contains("anydoc"));
        assert!(bundled.contains("AnyDoc"));
        assert!(bundled.contains("myagents anydoc --help"));
        assert!(bundled.contains("/myagents-anydoc"));
        assert!(anydoc.contains("myagents anydoc convert --file <input>"));
        assert!(bundled.contains("/myagents-speech-recognition"));
        assert!(speech.contains("myagents speech transcribe --file <input>"));
        assert!(!speech.contains("--session-id"));
        assert!(bundled.contains("myagents space list --json"));
        assert!(bundled.contains("myagents space whoami --space <slug> --json"));
        assert!(bundled.contains("myagents space goal list --space <slug> --json"));
        assert!(bundled.contains("myagents space issue update <issueId>"));
        assert!(bundled.contains("--clear-goal"));
        assert!(bundled.contains("只有精确 leaf help 明确声明支持的命令才使用 `--dry-run`"));
        assert!(bundled.contains("所有 Space 业务命令都必须带 `--space <slug>`"));
        assert!(bundled.contains("myagents goal create --objective-file goal-objective.txt"));
        assert!(bundled.contains("workspace 或系统 temp 均可"));
        assert!(bundled.contains("--max-executions <正整数>"));
        assert!(bundled.contains("myagents-task-automation"));
        assert!(bundled.contains("myagents task start <taskId>"));
        assert!(bundled.contains("myagents agent current --json"));
        assert!(bundled.contains("enabled/runtime/runtimeConfig/providerId/model/permissionMode"));
        assert!(bundled.contains("--providerId X --model X"));
        assert!(bundled.contains("--query X --limit N"));
        assert!(bundled.contains("myagents record create"));
        assert!(bundled.contains("--sourceRecordId X"));
        assert!(!bundled.contains("myagents thought create '...'"));
        assert!(!bundled.contains("--sourceThoughtId X"));
        assert!(bundled.contains("没有 30 天恢复或 undelete 承诺"));
        assert!(!bundled.contains("myagents-sensor"));

        let automation = include_str!("../../bundled-skills/myagents-task-automation/SKILL.md");
        assert!(automation.contains("Task 与立即执行/Record/Goal 的边界"));
        assert!(!automation.contains("Task 与立即执行/Thought/Goal 的边界"));
        assert!(automation.contains("references/command-detector.md"));
        assert!(automation.contains("--startAt"));
        assert!(automation.contains("默认在 `run` 后约 2 秒"));
        assert!(automation.contains("没有 30 天恢复承诺"));
        assert!(automation.contains("myagents task readme"));
        assert!(automation.contains("--maxExecutions 1"));
        assert!(automation.contains("`data.receipt`"));
        assert!(automation.contains("`changed: false`"));
        assert!(SYSTEM_SKILLS.contains(&"myagents-task-automation"));

        let memory_update = include_str!("../../bundled-skills/myagents-memory-update/SKILL.md");
        assert!(memory_update.contains("author: MyAgents"));
        assert!(memory_update
            .contains("仅当系统或用户明确指定完整名称 `myagents-memory-update` 时使用"));
        assert!(memory_update.contains("不要根据任务语义或相似表述自行触发"));
        assert!(memory_update.contains("错误的长期记忆通常比暂时缺失更有害"));
        assert!(memory_update.contains("无法说明未来判断或行动差异的信息，不写"));
        assert!(memory_update.contains("不置可否、忽略、换话题、未纠正或简单接受"));
        assert!(memory_update.contains("明确限定为“本次/这次/单次”"));
        assert!(memory_update.contains("不从已有 topic 名称或工作区结构猜测事件归属"));
        assert!(memory_update.contains("不要落盘“未升级偏好”"));
        assert!(memory_update.contains("commit 后 push 当前分支"));
        assert!(SYSTEM_SKILLS.contains(&"myagents-memory-update"));

        let gardener = include_str!("../../bundled-skills/myagents-memory-gardener/SKILL.md");
        assert!(gardener.contains("已有的未提交改动不阻断记忆维护"));
        assert!(gardener.contains("只暂存并提交本次记忆维护产生的改动"));
        assert!(!gardener.contains("存在非本次任务的未提交改动时，只做只读体检"));

        let product_docs = include_str!("../../bundled-skills/myagents-docs/SKILL.md");
        assert!(product_docs.contains("name: myagents-docs"));
        assert!(product_docs.contains("author: MyAgents"));
        assert!(product_docs.contains("它面向软件使用而非源码开发"));
        assert!(product_docs.contains("随后加载 `/myagents-cli`"));
        assert!(product_docs.contains("在内置小助理里加载 `/support`"));
        assert!(product_docs.contains("Record / Task / Cron / Goal"));
        assert!(SYSTEM_SKILLS.contains(&"myagents-docs"));

        for content in [
            include_str!("../../bundled-skills/myagents-memory-gardener/SKILL.md"),
            include_str!("../../bundled-skills/myagents-memory-molt/SKILL.md"),
        ] {
            assert!(content.contains("author: MyAgents"));
        }
    }

    #[test]
    fn required_system_skills_are_versioned_bundle_skills() {
        for name in REQUIRED_SYSTEM_SKILLS {
            assert!(
                SYSTEM_SKILLS.contains(name),
                "required system skill {name} must use the versioned bundle sync path"
            );
        }
    }

    #[test]
    fn system_skill_sync_removes_only_the_retired_product_owned_sensor_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join("skills");
        let retired = skills.join("myagents-sensor");
        let user = skills.join("user-sensor-helper");
        fs::create_dir_all(&retired).unwrap();
        fs::create_dir_all(&user).unwrap();
        fs::write(retired.join("SKILL.md"), "old product skill").unwrap();
        fs::write(user.join("SKILL.md"), "user skill").unwrap();

        assert!(!retired_system_skills_absent(&skills));
        assert_eq!(
            remove_retired_system_skills(&skills).unwrap(),
            vec!["myagents-sensor"]
        );
        assert!(retired_system_skills_absent(&skills));
        assert!(!retired.exists());
        assert!(user.join("SKILL.md").is_file());
    }

    #[test]
    fn myagents_authored_bundle_frontmatter_uses_standard_metadata_map() {
        for (name, content) in [
            (
                "download-anything",
                include_str!("../../bundled-skills/download-anything/SKILL.md"),
            ),
            (
                "myagents-cli",
                include_str!("../../bundled-skills/myagents-cli/SKILL.md"),
            ),
            (
                "myagents-docs",
                include_str!("../../bundled-skills/myagents-docs/SKILL.md"),
            ),
            (
                "myagents-memory-gardener",
                include_str!("../../bundled-skills/myagents-memory-gardener/SKILL.md"),
            ),
            (
                "myagents-memory-molt",
                include_str!("../../bundled-skills/myagents-memory-molt/SKILL.md"),
            ),
            (
                "myagents-memory-update",
                include_str!("../../bundled-skills/myagents-memory-update/SKILL.md"),
            ),
            (
                "myagents-task-automation",
                include_str!("../../bundled-skills/myagents-task-automation/SKILL.md"),
            ),
            (
                "prompt-writer",
                include_str!("../../bundled-skills/prompt-writer/SKILL.md"),
            ),
            (
                "myagents-task-alignment",
                include_str!("../../bundled-skills/myagents-task-alignment/SKILL.md"),
            ),
        ] {
            let yaml = content
                .strip_prefix("---\n")
                .and_then(|rest| rest.split_once("\n---"))
                .map(|(frontmatter, _)| frontmatter)
                .unwrap_or_else(|| panic!("{name} must have YAML frontmatter"));
            let value: serde_yaml::Value = serde_yaml::from_str(yaml)
                .unwrap_or_else(|error| panic!("{name} frontmatter must be valid YAML: {error}"));
            let mapping = value
                .as_mapping()
                .unwrap_or_else(|| panic!("{name} frontmatter must be a mapping"));
            assert!(
                !mapping.contains_key(&serde_yaml::Value::String("author".into())),
                "{name} must not use legacy top-level author"
            );
            let metadata = mapping
                .get(&serde_yaml::Value::String("metadata".into()))
                .and_then(serde_yaml::Value::as_mapping)
                .unwrap_or_else(|| panic!("{name} must have a metadata map"));
            assert_eq!(
                metadata
                    .get(&serde_yaml::Value::String("author".into()))
                    .and_then(serde_yaml::Value::as_str),
                Some("MyAgents"),
                "{name} must publish metadata.author"
            );
        }
    }

    #[test]
    fn v27_helper_routes_product_knowledge_diagnosis_and_tool_install() {
        assert_eq!(ADMIN_AGENT_VERSION, "27");
        let helper = include_str!("../../bundled-agents/myagents_helper/CLAUDE.md");
        let support =
            include_str!("../../bundled-agents/myagents_helper/.claude/skills/support/SKILL.md");
        let tool_install = include_str!(
            "../../bundled-agents/myagents_helper/.claude/skills/tool-install/SKILL.md"
        );
        assert!(helper.contains("`/myagents-docs`"));
        assert!(helper.contains("Record、Task、定时调度和 Goal"));
        assert!(!helper.contains("Thought、Task、定时调度和 Goal"));
        assert!(helper.contains("`/myagents-cli`"));
        assert!(helper.contains("`/support`"));
        assert!(helper.contains("`/tool-install`"));
        assert!(support.contains("先用 `/myagents-docs` 确认正确产品预期"));
        assert!(support.contains("不读取 `~/.myagents/credentials/`"));
        assert!(tool_install.contains("MYAGENTS_NPM_GLOBAL_PREFIX"));
        assert!(tool_install.contains("不写 Agent-CLI Registry"));
    }

    #[test]
    fn bundled_product_and_support_reference_closures_are_complete() {
        fn assert_reference_closure(skill_dir: &str) {
            let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri must live under the repository root");
            let skill_dir = repo_root.join(skill_dir);
            let index = fs::read_to_string(skill_dir.join("SKILL.md")).expect("skill index");
            let routed: std::collections::BTreeSet<String> = index
                .split('`')
                .filter_map(|token| token.strip_prefix("references/"))
                .filter(|token| token.ends_with(".md"))
                .map(str::to_owned)
                .collect();
            let references_dir = skill_dir.join("references");
            let bundled: std::collections::BTreeSet<String> = fs::read_dir(&references_dir)
                .expect("references directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("md"))
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect();

            assert!(
                !routed.is_empty(),
                "skill must route at least one reference"
            );
            assert_eq!(
                routed, bundled,
                "SKILL.md routes and bundled references drifted"
            );
            for name in routed {
                let content = fs::read_to_string(references_dir.join(&name))
                    .unwrap_or_else(|error| panic!("missing reference {name}: {error}"));
                assert!(
                    content.starts_with("# "),
                    "{name} must contain reference content"
                );
            }
        }

        assert_reference_closure("bundled-skills/myagents-docs");
        assert_reference_closure("bundled-skills/myagents-task-automation");
        assert_reference_closure("bundled-agents/myagents_helper/.claude/skills/support");

        let redactor_cli = include_str!(
            "../../bundled-agents/myagents_helper/.claude/skills/support/scripts/redact-log-output.mjs"
        );
        let redactor_core = include_str!(
            "../../bundled-agents/myagents_helper/.claude/skills/support/scripts/redact-log-core.mjs"
        );
        assert!(redactor_cli.contains("./redact-log-core.mjs"));
        assert!(redactor_cli.contains("runCli().catch"));
        assert!(redactor_core.contains("<redacted-token>"));
    }

    #[test]
    fn rust_and_node_system_skill_lists_match() {
        let node = include_str!("../../src/server/index.ts");
        let body = node
            .split_once("const SYSTEM_SKILLS: readonly string[] = [")
            .expect("Node SYSTEM_SKILLS declaration")
            .1
            .split_once("];")
            .expect("Node SYSTEM_SKILLS terminator")
            .0;
        let node_skills: Vec<&str> = body
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let rest = line.strip_prefix('\'')?;
                rest.split_once('\'').map(|(name, _)| name)
            })
            .collect();

        assert_eq!(node_skills, SYSTEM_SKILLS);

        let shared_contract = include_str!("../../src/shared/systemSkills.ts");
        assert!(shared_contract.contains(&format!(
            "export const SYSTEM_SKILLS_VERSION = '{}';",
            SYSTEM_SKILLS_VERSION
        )));
    }

    #[test]
    fn all_memory_skill_descriptions_require_the_exact_full_name() {
        for (name, content) in [
            (
                "myagents-memory-update",
                include_str!("../../bundled-skills/myagents-memory-update/SKILL.md"),
            ),
            (
                "myagents-memory-gardener",
                include_str!("../../bundled-skills/myagents-memory-gardener/SKILL.md"),
            ),
            (
                "myagents-memory-molt",
                include_str!("../../bundled-skills/myagents-memory-molt/SKILL.md"),
            ),
        ] {
            assert!(
                content.contains(&format!("仅当系统或用户明确指定完整名称 `{name}` 时使用")),
                "{name} must use the exact-name-only trigger contract"
            );
            assert!(
                content.contains("不要根据任务语义或相似表述自行触发"),
                "{name} must reject semantic or similar-phrase auto-triggering"
            );
        }
    }

    #[test]
    fn automation_startup_sync_precedes_task_scheduler_recovery() {
        let source = include_str!("cron_task/init_recovery.rs");
        let sync = source
            .find("sync_system_skills_for_startup")
            .expect("startup system-skill sync");
        let scheduler = source
            .find("get_task_scheduler()")
            .expect("task scheduler recovery");
        assert!(sync < scheduler);
    }

    #[test]
    fn sync_readiness_requires_current_version_and_complete_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let myagents_dir = tmp.path();
        let skills_dir = myagents_dir.join("skills");
        for name in SYSTEM_SKILLS {
            let dir = skills_dir.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), "x").unwrap();
            if *name == "cuse" {
                crate::cuse_skill::tests::fixture(&dir);
            }
        }

        fs::write(
            myagents_dir.join(".system-skills-version"),
            SYSTEM_SKILLS_VERSION,
        )
        .unwrap();
        ensure_system_skills_installation_current_at(myagents_dir)
            .expect("current complete snapshot is ready");

        fs::write(myagents_dir.join(".system-skills-version"), "32").unwrap();
        assert!(ensure_system_skills_installation_current_at(myagents_dir).is_err());

        fs::write(
            myagents_dir.join(".system-skills-version"),
            SYSTEM_SKILLS_VERSION,
        )
        .unwrap();
        fs::remove_file(skills_dir.join("myagents-memory-update").join("SKILL.md")).unwrap();
        assert!(ensure_system_skills_installation_current_at(myagents_dir).is_err());
    }

    #[test]
    fn version_gate_validation_detects_frozen_install() {
        // Lay down every system skill WITH a SKILL.md → gate may early-return.
        // Then blank one out → gate must bypass so the (non-destructive)
        // re-sync runs and self-heals.
        let tmp = tempfile::tempdir().unwrap();
        let skills_dir = tmp.path().join("skills");
        for name in SYSTEM_SKILLS {
            let d = skills_dir.join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("SKILL.md"), "x").unwrap();
            if *name == "cuse" {
                crate::cuse_skill::tests::fixture(&d);
            }
        }
        assert!(
            all_installed_system_skills_complete(&skills_dir),
            "all SKILL.md present → install is complete"
        );

        // Freeze one into the empty-dir state seen in #321.
        let victim = SYSTEM_SKILLS
            .iter()
            .find(|name| **name != "cuse")
            .expect("at least one common system skill");
        fs::remove_file(skills_dir.join(victim).join("SKILL.md")).unwrap();
        assert!(
            !all_installed_system_skills_complete(&skills_dir),
            "a SKILL.md-less system skill must fail the gate so sync re-runs"
        );
    }

    #[test]
    #[ignore = "explicit native acceptance against a prepared Cuse bundle; no user directories"]
    fn cuse_prepared_bundle_native_smoke() {
        let source = std::env::var_os("MYAGENTS_CUSE_SMOKE_SOURCE")
            .map(std::path::PathBuf::from)
            .expect("set MYAGENTS_CUSE_SMOKE_SOURCE to the prepared cuse directory");
        let tmp = tempfile::tempdir().unwrap();
        let installed = tmp.path().join("cuse");
        assert!(matches!(
            sync_one_system_skill(&source, &installed).unwrap(),
            SystemSkillSync::Synced
        ));
        assert!(crate::cuse_skill::matches_bundle(&source, &installed));
        let binary = installed.join(if cfg!(target_os = "windows") {
            "scripts/cuse.exe"
        } else {
            "scripts/cuse"
        });
        let output = crate::process_cmd::new(&binary)
            .arg("--version")
            .output()
            .unwrap();
        assert!(output.status.success());
        let metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(installed.join("package.json")).unwrap()).unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            format!("cuse {}", metadata["version"].as_str().unwrap())
        );
        for args in [vec!["--help"], vec!["readme"], vec!["readme", "setup"]] {
            let result = crate::process_cmd::new(&binary)
                .args(args)
                .output()
                .unwrap();
            assert!(result.status.success());
            assert!(!result.stdout.is_empty());
        }
    }

    #[test]
    fn cuse_sync_replaces_complete_payload_preserves_disable_and_rejects_incomplete_source() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("bundle/cuse");
        let installed = tmp.path().join("skills/cuse");
        crate::cuse_skill::tests::fixture(&source);
        crate::cuse_skill::tests::fixture(&installed);
        let config = tmp.path().join("skills-config.json");
        let disabled = r#"{"disabled":["cuse"],"seeded":["user-skill"]}"#;
        fs::write(&config, disabled).unwrap();
        fs::write(source.join("SKILL.md"), "new bundled instructions").unwrap();
        assert!(!crate::cuse_skill::matches_bundle(&source, &installed));
        assert!(matches!(
            sync_one_system_skill(&source, &installed).unwrap(),
            SystemSkillSync::Synced
        ));
        assert!(crate::cuse_skill::matches_bundle(&source, &installed));
        assert_eq!(fs::read_to_string(&config).unwrap(), disabled);
        fs::remove_file(source.join("package.json")).unwrap();
        assert!(matches!(
            sync_one_system_skill(&source, &installed).unwrap(),
            SystemSkillSync::SkippedIncompleteSource
        ));
        assert_eq!(
            fs::read_to_string(installed.join("SKILL.md")).unwrap(),
            "new bundled instructions"
        );
    }

    #[test]
    fn missing_source_reports_missing_and_leaves_dst() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src/skill"); // never created
        let dst = tmp.path().join("dst/skill");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "good").unwrap();
        let outcome = sync_one_system_skill(&src, &dst).unwrap();
        assert!(matches!(outcome, SystemSkillSync::SkippedMissingSource));
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "good");
    }

    #[test]
    fn incomplete_source_preserves_existing_good_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src/skill");
        fs::create_dir_all(&src).unwrap(); // source exists but has NO SKILL.md
        fs::write(src.join("README.md"), "noise").unwrap();
        let dst = tmp.path().join("dst/skill");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "good").unwrap();

        let outcome = sync_one_system_skill(&src, &dst).unwrap();
        assert!(matches!(outcome, SystemSkillSync::SkippedIncompleteSource));
        assert!(
            dst.join("SKILL.md").exists(),
            "an incomplete bundled source must NOT destroy the installed copy"
        );
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "good");
    }

    #[test]
    fn valid_source_replaces_dst_wholesale() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src/skill");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "new").unwrap();
        let dst = tmp.path().join("dst/skill");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "old").unwrap();
        // A stale file under dst must be gone after a wholesale replace.
        fs::write(dst.join("stale.txt"), "stale").unwrap();

        let outcome = sync_one_system_skill(&src, &dst).unwrap();
        assert!(matches!(outcome, SystemSkillSync::Synced));
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "new");
        assert!(
            !dst.join("stale.txt").exists(),
            "wholesale replace drops stale files"
        );
    }
}

// Path-safety blacklist (single source for validate_file_path + the cross-check
// test). cfg-gated so each platform compiles only its own list. MUST stay in
// sync with Node path-safety.ts and the shared fixture
// src/shared/path-safety-blacklist.json — see path_safety_crosscheck_tests.
#[cfg(windows)]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "C:\\Recovery",
    "C:\\$Recycle.Bin",
];
#[cfg(all(not(windows), not(target_os = "macos")))]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "/etc", "/var", "/usr", "/bin", "/sbin", "/boot", "/root", "/sys", "/proc", "/dev",
];
// macOS symlinks /etc → /private/etc and /var → /private/var; block the canonical
// /private targets too so a literal /private/etc path can't slip the lexical check.
#[cfg(target_os = "macos")]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/root",
    "/sys",
    "/proc",
    "/dev",
    "/private/etc",
    "/private/var",
];
const CREDENTIAL_PATHS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".config/op",
    ".myagents/codex/auth.json",
    ".myagents/credentials",
];
#[cfg(target_os = "macos")]
const MAC_SENSITIVE_SUBDIRS: &[&str] = &[
    "Library/Keychains",
    "Library/Cookies",
    "Library/Mail",
    "Library/Messages",
    "Library/Safari",
];
#[cfg(windows)]
const WIN_SENSITIVE_SUBDIRS: &[&str] = &["AppData/Local/Microsoft"];

/// Validate that a file path does not target sensitive system or credential paths.
/// Resolves `..` components to prevent path traversal. Mirrors `isSafeReadPath()` in Bun.
///
/// `pub(crate)` so workspace_files::path_safety can reuse the exact same blacklist —
/// duplicating it would be a pit-of-failure (two places to update for new credential paths).
#[cfg(any(windows, test))]
fn normalize_windows_security_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let windows = raw.replace('/', r"\");
    let folded = windows.to_lowercase();
    if folded.starts_with(r"\\?\unc\") {
        return PathBuf::from(format!(r"\\{}", &windows[8..]));
    }
    if folded.starts_with(r"\\?\") {
        return PathBuf::from(&windows[4..]);
    }
    path.to_path_buf()
}

pub(crate) fn normalize_security_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        return normalize_windows_security_path(&path);
    }
    #[cfg(not(windows))]
    {
        path
    }
}

pub(crate) fn normalize_lexical_security_path(path: PathBuf) -> PathBuf {
    let path = normalize_security_path(path);
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::CurDir => {}
            _ => resolved.push(component),
        }
    }
    resolved
}

#[cfg(any(windows, test))]
fn normalize_windows_path_identity(path: &Path) -> String {
    normalize_windows_security_path(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

pub(crate) fn path_starts_with_identity(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = normalize_windows_path_identity(path);
        let root = normalize_windows_path_identity(root);
        return candidate == root
            || candidate
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with('/'));
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

fn reject_blacklisted_path_with_home(resolved: &Path, home: &Path) -> Result<(), String> {
    for dir in FORBIDDEN_SYSTEM_DIRS {
        if path_starts_with_identity(resolved, Path::new(dir)) {
            return Err("Access denied: protected system directory".to_string());
        }
    }

    if !home.as_os_str().is_empty() {
        for name in CREDENTIAL_PATHS {
            if path_starts_with_identity(resolved, &home.join(name)) {
                return Err("Access denied: protected credential path".to_string());
            }
        }

        #[cfg(target_os = "macos")]
        for name in MAC_SENSITIVE_SUBDIRS {
            if path_starts_with_identity(resolved, &home.join(name)) {
                return Err("Access denied: protected system directory".to_string());
            }
        }

        #[cfg(windows)]
        for name in WIN_SENSITIVE_SUBDIRS {
            if path_starts_with_identity(resolved, &home.join(name)) {
                return Err("Access denied: protected system directory".to_string());
            }
        }
    }

    Ok(())
}

fn resolve_nearest_existing_path_identity(path: &Path) -> Option<PathBuf> {
    let mut ancestor = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        if let Ok(canonical) = fs::canonicalize(&ancestor) {
            let mut resolved = normalize_security_path(canonical);
            for component in suffix.iter().rev() {
                resolved.push(component);
            }
            return Some(resolved);
        }
        let name = ancestor.file_name()?.to_os_string();
        suffix.push(name);
        ancestor = ancestor.parent()?.to_path_buf();
    }
}

fn validate_file_path_with_home(raw_path: &str, home: &Path) -> Result<PathBuf, String> {
    let path = normalize_security_path(PathBuf::from(raw_path));

    if !path.is_absolute() {
        return Err("Path must be absolute".to_string());
    }

    // Resolve .. and . components without requiring the file to exist.
    let resolved = normalize_lexical_security_path(path);

    reject_blacklisted_path_with_home(&resolved, home)?;
    if let Some(real_identity) = resolve_nearest_existing_path_identity(&resolved) {
        reject_blacklisted_path_with_home(&real_identity, home)?;
    }

    Ok(resolved)
}

pub(crate) fn validate_file_path(raw_path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().unwrap_or_default();
    validate_file_path_with_home(raw_path, &home)
}

fn validate_template_target_with_home(target: &Path, home: &Path) -> Result<(), String> {
    validate_file_path_with_home(&target.to_string_lossy(), home)
        .map(|_| ())
        .map_err(|e| format!("Template target rejected: {e}"))
}

fn validate_template_target(target: &Path) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Failed to get home dir")?;
    validate_template_target_with_home(target, &home)
}

#[cfg(test)]
mod path_safety_crosscheck_tests {
    use super::{
        merge_dir_recursive_validated_with_home, normalize_windows_path_identity,
        validate_file_path_with_home, CREDENTIAL_PATHS, FORBIDDEN_SYSTEM_DIRS,
    };
    use serde_json::Value;
    use std::{fs, path::Path};

    // Rust side of the Node↔Rust blacklist cross-check (PRD 0.2.15 §7.2). Asserts
    // the lists THIS platform compiled equal the shared fixture; the Node test
    // (path-safety-crosscheck.unit.test.ts) covers every platform's list. Change
    // a list without the fixture → one of the two sides fails.
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../src/shared/path-safety-blacklist.json"))
            .expect("path-safety-blacklist.json parses")
    }
    fn arr(v: &Value, key: &str) -> Vec<String> {
        v[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixture.{key} must be an array"))
            .iter()
            .map(|x| x.as_str().expect("fixture entry is a string").to_string())
            .collect()
    }

    #[test]
    fn credential_paths_match_fixture() {
        let owned: Vec<String> = CREDENTIAL_PATHS.iter().map(|s| s.to_string()).collect();
        assert_eq!(owned, arr(&fixture(), "credentialPaths"));
    }

    #[test]
    fn managed_codex_blacklist_protects_only_auth_file() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/controlled-test-home");
        assert!(validate_file_path_with_home(
            &home.join(".myagents/codex/auth.json").to_string_lossy(),
            &home,
        )
        .is_err());
        assert!(validate_file_path_with_home(
            &home
                .join(".myagents/codex/generated_images/thread/call.png")
                .to_string_lossy(),
            &home,
        )
        .is_ok());
        assert!(validate_file_path_with_home(
            &home.join(".myagents/codex/config.toml").to_string_lossy(),
            &home,
        )
        .is_ok());
    }

    #[test]
    fn template_merge_cannot_overwrite_managed_codex_auth() {
        let target_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        fs::create_dir_all(&target_dir).unwrap();
        let tmp = tempfile::Builder::new()
            .prefix("managed-codex-template-test-")
            .tempdir_in(target_dir)
            .unwrap();
        let home = tmp.path().join("home");
        let src = tmp.path().join("template");
        let dst = home.join(".myagents/codex");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("auth.json"), "replacement").unwrap();
        fs::write(dst.join("auth.json"), "original").unwrap();

        let result = merge_dir_recursive_validated_with_home(&src, &dst, &home);

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(dst.join("auth.json")).unwrap(),
            "original"
        );
    }

    #[test]
    fn system_dirs_match_fixture_for_this_platform() {
        let f = fixture();
        #[cfg(windows)]
        let expected = arr(&f, "systemDirsWindows");
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let expected = arr(&f, "systemDirsPosix");
        #[cfg(target_os = "macos")]
        let expected = {
            let mut v = arr(&f, "systemDirsPosix");
            v.extend(arr(&f, "systemDirsMacosExtra"));
            v
        };
        let owned: Vec<String> = FORBIDDEN_SYSTEM_DIRS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(owned, expected);
    }

    #[test]
    fn windows_path_identity_strips_verbatim_prefix_and_folds_case() {
        assert_eq!(
            normalize_windows_path_identity(std::path::Path::new(r"\\?\c:\WINDOWS\System32\")),
            "c:/windows/system32"
        );
        assert_eq!(
            normalize_windows_path_identity(std::path::Path::new(
                r"\\?\UNC\Server\Share\Users\Alice\.ssh\id_ed25519"
            )),
            "//server/share/users/alice/.ssh/id_ed25519"
        );
    }

    #[cfg(unix)]
    #[test]
    fn blacklist_rechecks_symlinked_existing_ancestor_identity() {
        let parent =
            crate::workspace_files::test_support::make_test_workspace("commands_path_alias");
        let alias = parent.join("system-alias");
        std::os::unix::fs::symlink("/etc", &alias).unwrap();

        assert!(super::validate_file_path(&alias.join("passwd").to_string_lossy()).is_err());
        assert!(
            super::validate_file_path(&alias.join("not-created-yet").to_string_lossy()).is_err()
        );

        let _ = std::fs::remove_file(alias);
        let _ = std::fs::remove_dir_all(parent);
    }

    #[cfg(windows)]
    #[test]
    fn windows_blacklist_rejects_case_and_verbatim_aliases() {
        assert!(super::validate_file_path(r"c:\windows\System32").is_err());
        assert!(super::validate_file_path(r"\\?\C:\WINDOWS\System32").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_sensitive_subdirs_match_fixture() {
        let owned: Vec<String> = super::MAC_SENSITIVE_SUBDIRS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(owned, arr(&fixture(), "macSensitiveSubdirs"));
    }

    #[cfg(windows)]
    #[test]
    fn win_sensitive_subdirs_match_fixture() {
        let owned: Vec<String> = super::WIN_SENSITIVE_SUBDIRS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(owned, arr(&fixture(), "winSensitiveSubdirs"));
    }
}

/// Read a workspace text file. Returns content if exists, null if not.
/// Bypasses Tauri fs plugin scope (which only covers ~/.myagents).
#[tauri::command]
pub async fn cmd_read_workspace_file(path: String) -> Result<Option<String>, String> {
    let resolved = validate_file_path(&path)?;
    match tokio::fs::read_to_string(&resolved).await {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read {}: {}", path, e)),
    }
}

/// Write content to a workspace text file, creating parent directories if needed.
/// Bypasses Tauri fs plugin scope (which only covers ~/.myagents).
#[tauri::command]
pub async fn cmd_write_workspace_file(path: String, content: String) -> Result<(), String> {
    let resolved = validate_file_path(&path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    tokio::fs::write(&resolved, content)
        .await
        .map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Delete a workspace file. Returns true if deleted, false if not found.
/// Bypasses Tauri fs plugin scope (which only covers ~/.myagents).
#[tauri::command]
pub async fn cmd_delete_workspace_file(path: String) -> Result<bool, String> {
    let resolved = validate_file_path(&path)?;
    match tokio::fs::remove_file(&resolved).await {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Failed to delete {}: {}", path, e)),
    }
}

/// Read a local file and return its contents as base64.
/// Used by the audio player to create blob URLs without asset protocol scope issues.
#[tauri::command]
pub async fn cmd_read_file_base64(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    let resolved = validate_file_path(&path)?;
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(BASE64.encode(&bytes))
}

/// Open a local file with the system default application.
/// Bypasses shell plugin URL-only scope restriction.
#[tauri::command]
pub async fn cmd_open_file(path: String) -> Result<(), String> {
    // Validate: path must resolve to an existing file (prevents opening arbitrary commands)
    let canonical = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
    if !canonical.is_file() {
        return Err(format!("Not a file: {}", canonical.display()));
    }
    let safe_path = canonical.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        crate::process_cmd::new("open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    #[cfg(target_os = "windows")]
    {
        // Use explorer.exe instead of cmd /C start to avoid shell metacharacter injection
        crate::process_cmd::new("explorer")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    #[cfg(target_os = "linux")]
    {
        crate::process_cmd::new("xdg-open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WeCom QR Code — generate & poll for bot credentials
// Uses the public WeCom QR API (same flow as @wecom/wecom-openclaw-cli).
// These are external HTTPS requests — use proxy_config for outbound proxy.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct WecomQrGenerateResult {
    pub scode: String,
    pub auth_url: String,
}

/// Generate a WeCom QR code for one-click bot creation.
/// Returns scode (for polling) and auth_url (to render as QR image).
#[tauri::command]
pub async fn cmd_wecom_qr_generate() -> Result<WecomQrGenerateResult, String> {
    let plat = if cfg!(target_os = "macos") {
        1
    } else if cfg!(target_os = "windows") {
        2
    } else {
        3
    };
    let url = format!(
        "https://work.weixin.qq.com/ai/qc/generate?source=myagents&plat={}",
        plat
    );

    // External host (work.weixin.qq.com) — system proxy is wanted here.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;

    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WeCom QR generate request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("WeCom QR generate parse failed: {}", e))?;

    // Check for API-level errors (same pattern as poll)
    let errcode = resp["errcode"].as_i64().unwrap_or(0);
    if errcode != 0 {
        let errmsg = resp["errmsg"].as_str().unwrap_or("unknown error");
        return Err(format!(
            "WeCom QR generate API error {}: {}",
            errcode, errmsg
        ));
    }

    let data = resp.get("data").ok_or("WeCom QR response missing 'data'")?;
    let scode = data["scode"]
        .as_str()
        .ok_or("WeCom QR response missing 'scode'")?
        .to_string();
    let auth_url = data["auth_url"]
        .as_str()
        .ok_or("WeCom QR response missing 'auth_url'")?
        .to_string();

    let scode_preview: String = scode.chars().take(8).collect();
    ulog_info!("[wecom-qr] Generated QR code, scode={}", scode_preview);
    Ok(WecomQrGenerateResult { scode, auth_url })
}

#[derive(serde::Serialize)]
pub struct WecomQrPollResult {
    /// "waiting" — user hasn't scanned yet; "success" — bot created, credentials available
    pub status: String,
    pub bot_id: Option<String>,
    pub secret: Option<String>,
}

/// Poll the WeCom QR scan result. Call repeatedly until status is "success".
/// `poll_index` is used for periodic logging (log every 10th poll to reduce noise).
#[tauri::command]
pub async fn cmd_wecom_qr_poll(
    scode: String,
    poll_index: Option<u32>,
) -> Result<WecomQrPollResult, String> {
    // Sanitize scode: only allow alphanumeric (defense-in-depth against URL injection)
    let safe_scode: String = scode.chars().filter(|c| c.is_alphanumeric()).collect();
    let url = format!(
        "https://work.weixin.qq.com/ai/qc/query_result?scode={}",
        safe_scode
    );

    // External host — system proxy wanted.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;

    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WeCom QR poll failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("WeCom QR poll parse failed: {}", e))?;

    // Check for API-level errors first
    let errcode = resp["errcode"].as_i64().unwrap_or(0);
    if errcode != 0 {
        let errmsg = resp["errmsg"].as_str().unwrap_or("unknown error");
        ulog_error!("[wecom-qr] Poll API error {}: {}", errcode, errmsg);
        return Err(format!("WeCom QR poll API error {}: {}", errcode, errmsg));
    }

    let status_str = resp["data"]["status"].as_str().unwrap_or("waiting");
    let idx = poll_index.unwrap_or(0);

    match status_str {
        "success" => {
            let bot_info = &resp["data"]["bot_info"];
            let bot_id = bot_info["botid"].as_str().map(String::from);
            let secret = bot_info["secret"].as_str().map(String::from);
            if bot_id.is_some() && secret.is_some() {
                ulog_info!("[wecom-qr] QR scan success, bot created (poll #{})", idx);
                Ok(WecomQrPollResult {
                    status: "success".into(),
                    bot_id,
                    secret,
                })
            } else {
                ulog_error!(
                    "[wecom-qr] Poll #{} status=success but bot_info is incomplete",
                    idx
                );
                Err("WeCom QR scan succeeded but bot_info is incomplete".into())
            }
        }
        "expired" | "cancelled" | "denied" => {
            ulog_info!("[wecom-qr] Poll #{} terminal status: {}", idx, status_str);
            Ok(WecomQrPollResult {
                status: status_str.into(),
                bot_id: None,
                secret: None,
            })
        }
        _ => {
            // Periodic logging: first poll, then every 10th
            if idx == 0 || idx % 10 == 0 {
                let scode_preview: String = safe_scode.chars().take(8).collect();
                ulog_info!(
                    "[wecom-qr] Poll #{} scode={} status={}",
                    idx,
                    scode_preview,
                    status_str
                );
            }
            Ok(WecomQrPollResult {
                status: "waiting".into(),
                bot_id: None,
                secret: None,
            })
        }
    }
}

// ============= Network Diagnostics =============

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProbeResult {
    pub ok: bool,
    pub stage: String,
    pub kind: String,
    pub message: String,
    pub detail: Option<String>,
    pub http_status: Option<u16>,
    pub url: String,
}

fn network_probe_result(
    ok: bool,
    stage: &str,
    kind: &str,
    message: impl Into<String>,
    detail: Option<String>,
    http_status: Option<u16>,
    url: impl Into<String>,
) -> NetworkProbeResult {
    NetworkProbeResult {
        ok,
        stage: stage.to_string(),
        kind: kind.to_string(),
        message: message.into(),
        detail,
        http_status,
        url: url.into(),
    }
}

fn is_loopback_http_url(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(host) => {
            let normalized = host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_ascii_lowercase();
            if normalized == "localhost"
                || normalized == "localhost.localdomain"
                || normalized.ends_with(".localhost")
            {
                return true;
            }
            normalized
                .parse::<std::net::IpAddr>()
                .map(|ip| ip.is_loopback())
                .unwrap_or(false)
        }
        None => false,
    }
}

#[cfg(test)]
mod network_probe_tests {
    use super::is_loopback_http_url;

    fn parsed(url: &str) -> reqwest::Url {
        reqwest::Url::parse(url).expect("test URL parses")
    }

    #[test]
    fn detects_loopback_provider_urls() {
        assert!(is_loopback_http_url(&parsed("http://localhost:11434/v1")));
        assert!(is_loopback_http_url(&parsed("https://127.0.0.1:8443/v1")));
        assert!(is_loopback_http_url(&parsed("http://[::1]:8080/v1")));
        assert!(is_loopback_http_url(&parsed(
            "http://lmstudio.localhost:1234"
        )));
    }

    #[test]
    fn leaves_external_provider_urls_on_proxy_path() {
        assert!(!is_loopback_http_url(&parsed("https://api.example.com/v1")));
        assert!(!is_loopback_http_url(&parsed("http://192.168.1.2:8080/v1")));
    }
}

fn classify_reqwest_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        return "timeout";
    }

    let text = error.to_string().to_lowercase();
    if text.contains("dns") || text.contains("resolve") || text.contains("name or service") {
        return "dns_error";
    }
    if text.contains("certificate") || text.contains("tls") || text.contains("ssl") {
        return "tls_error";
    }
    if text.contains("proxy") || text.contains("socks") {
        return "proxy_error";
    }
    if error.is_connect() {
        return "connect_error";
    }
    if error.is_builder() {
        return "invalid_url";
    }

    "network_error"
}

async fn send_probe_request(
    client: &reqwest::Client,
    url: &str,
    stage: &str,
    failure_message: &str,
) -> NetworkProbeResult {
    match client
        .get(url)
        .header(reqwest::header::USER_AGENT, NETWORK_PROBE_USER_AGENT)
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            network_probe_result(
                true,
                stage,
                "http_reachable",
                "网络连接正常",
                None,
                Some(status.as_u16()),
                url,
            )
        }
        Err(error) => network_probe_result(
            false,
            stage,
            classify_reqwest_error(&error),
            failure_message,
            Some(error.to_string()),
            None,
            url,
        ),
    }
}

/// Probe whether a provider base URL is reachable through the same proxy policy
/// used by external Rust HTTP requests. Any HTTP status means the network path
/// reached the provider; API-key validity is verified by the SDK in the next step.
#[tauri::command]
pub async fn cmd_probe_provider_network(
    url: String,
    provider_id: String,
) -> Result<NetworkProbeResult, String> {
    let parsed = match reqwest::Url::parse(&url) {
        Ok(parsed) if parsed.scheme() == "http" || parsed.scheme() == "https" => parsed,
        Ok(_) => {
            return Ok(network_probe_result(
                false,
                "provider_http",
                "invalid_url",
                "供应商 Base URL 必须使用 http 或 https",
                None,
                None,
                url,
            ));
        }
        Err(error) => {
            return Ok(network_probe_result(
                false,
                "provider_http",
                "invalid_url",
                "供应商 Base URL 无效",
                Some(error.to_string()),
                None,
                url,
            ));
        }
    };

    let target_url = parsed.to_string();
    ulog_info!(
        "[network-probe] Probing provider URL {} provider={}",
        target_url,
        provider_id
    );

    let client = if is_loopback_http_url(&parsed) {
        match crate::local_http::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return Ok(network_probe_result(
                    false,
                    "provider_http",
                    "network_error",
                    "本地供应商探测客户端创建失败",
                    Some(error.to_string()),
                    None,
                    target_url,
                ));
            }
        }
    } else {
        #[allow(clippy::disallowed_methods)]
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::limited(5));
        match crate::proxy_config::build_client_with_proxy_for_provider(builder, &provider_id) {
            Ok(client) => client,
            Err(error) => {
                return Ok(network_probe_result(
                    false,
                    "provider_http",
                    "proxy_config_error",
                    "网络代理配置无效，请检查代理设置",
                    Some(error),
                    None,
                    target_url,
                ));
            }
        }
    };

    Ok(send_probe_request(
        &client,
        &target_url,
        "provider_http",
        "当前网络无法连接供应商，请检查网络或配置代理",
    )
    .await)
}

/// Probe the proxy settings currently shown in Settings. This intentionally
/// accepts explicit values instead of reading disk config so the UI can test
/// the user's latest committed protocol / host / port immediately.
#[tauri::command]
pub async fn cmd_probe_proxy(
    protocol: String,
    host: String,
    port: u16,
) -> Result<NetworkProbeResult, String> {
    let protocol = protocol.trim().to_lowercase();
    let host = host.trim().to_string();
    let proxy_url = format!("{}://{}:{}", protocol, host, port);

    if !matches!(protocol.as_str(), "http" | "https" | "socks5") {
        return Ok(network_probe_result(
            false,
            "local_proxy",
            "invalid_proxy",
            "代理协议无效，请选择 HTTP、HTTPS 或 SOCKS5",
            None,
            None,
            proxy_url,
        ));
    }
    if host.is_empty() || port == 0 {
        return Ok(network_probe_result(
            false,
            "local_proxy",
            "invalid_proxy",
            "代理地址或端口无效",
            None,
            None,
            proxy_url,
        ));
    }

    ulog_info!(
        "[network-probe] Probing proxy {} via {}",
        proxy_url,
        PROXY_CONNECTIVITY_TEST_URL
    );

    match tokio::time::timeout(
        Duration::from_millis(1500),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    {
        Ok(Ok(_stream)) => {}
        Ok(Err(error)) => {
            return Ok(network_probe_result(
                false,
                "local_proxy",
                "proxy_unreachable",
                "当前代理地址或端口没有检测到可用代理，请确认端口号与本地代理软件一致",
                Some(error.to_string()),
                None,
                proxy_url,
            ));
        }
        Err(_) => {
            return Ok(network_probe_result(
                false,
                "local_proxy",
                "timeout",
                "当前代理地址或端口连接超时，请确认端口号与本地代理软件一致",
                None,
                None,
                proxy_url,
            ));
        }
    }

    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5));
    let proxy = match reqwest::Proxy::all(&proxy_url) {
        Ok(proxy) => proxy.no_proxy(reqwest::NoProxy::from_string(
            crate::proxy_config::LOCALHOST_NO_PROXY,
        )),
        Err(error) => {
            return Ok(network_probe_result(
                false,
                "local_proxy",
                "invalid_proxy",
                "代理配置无效，请检查协议、地址和端口",
                Some(error.to_string()),
                None,
                proxy_url,
            ));
        }
    };
    let client = match builder.proxy(proxy).build() {
        Ok(client) => client,
        Err(error) => {
            return Ok(network_probe_result(
                false,
                "local_proxy",
                "invalid_proxy",
                "代理客户端创建失败，请检查代理配置",
                Some(error.to_string()),
                None,
                proxy_url,
            ));
        }
    };

    let result = send_probe_request(
        &client,
        PROXY_CONNECTIVITY_TEST_URL,
        "external_http",
        "已检测到本地代理，但无法访问全球互联网，请检查代理软件节点或规则",
    )
    .await;

    if result.ok {
        Ok(network_probe_result(
            true,
            "external_http",
            "http_reachable",
            "代理可用，已能访问全球互联网",
            result.detail,
            result.http_status,
            PROXY_CONNECTIVITY_TEST_URL,
        ))
    } else {
        Ok(result)
    }
}

// ============= Model Discovery =============

/// Fetch provider model list via external API.
/// Returns raw JSON response — parsing is done in the frontend.
#[tauri::command]
pub async fn cmd_fetch_provider_models(
    url: String,
    provider_id: String,
    auth_header_name: Option<String>,
    auth_header_value: Option<String>,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    ulog_info!(
        "[model-discovery] Fetching models from {} provider={}",
        url,
        provider_id
    );

    // Determine if URL points to localhost — if so, use local_http (no proxy)
    // to avoid the system-proxy-intercepts-localhost bug. Otherwise, use the
    // provider-aware proxy client for external APIs.
    let parsed_url =
        reqwest::Url::parse(&url).map_err(|e| format!("Invalid model list URL: {}", e))?;
    let is_localhost = is_loopback_http_url(&parsed_url);

    let client = if is_localhost {
        crate::local_http::json_client(std::time::Duration::from_secs(15))
    } else {
        // External host branch — system proxy wanted.
        #[allow(clippy::disallowed_methods)]
        let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
        crate::proxy_config::build_client_with_proxy_for_provider(builder, &provider_id)?
    };

    let mut request = client.get(&url);
    if let (Some(name), Some(value)) = (auth_header_name, auth_header_value) {
        request = request.header(name, value);
    }

    if let Some(headers) = extra_headers {
        for (key, value) in headers {
            request = request.header(key, value);
        }
    }

    if provider_id == "tokendance" {
        // Attribution is fixed by the native provider boundary; extra headers
        // cannot change it, and no credentials are needed for the public list.
        request = request.headers(crate::tokendance::attribution_headers());
    }

    let response = request.send().await.map_err(|e| {
        ulog_error!("[model-discovery] Network error for {}: {}", url, e);
        format!("Network error: {}", e)
    })?;

    let status = response.status();
    if !status.is_success() {
        // Limit error body to ~2KB to avoid unbounded allocation (char-boundary safe for UTF-8)
        let body = response.text().await.unwrap_or_default();
        let truncated = match body.char_indices().nth(2048) {
            Some((byte_pos, _)) => &body[..byte_pos],
            None => &body,
        };
        ulog_error!("[model-discovery] HTTP {} from {}", status.as_u16(), url);
        return Err(format!("HTTP {}: {}", status.as_u16(), truncated));
    }

    let result = response.json::<serde_json::Value>().await.map_err(|e| {
        ulog_error!("[model-discovery] Invalid JSON from {}: {}", url, e);
        format!("Invalid JSON response: {}", e)
    })?;

    ulog_info!("[model-discovery] Success from {}", url);
    Ok(result)
}

// ============= Agent Runtime Detection (v0.1.59) =============

/// Runtime detection result for a single CLI
#[derive(serde::Serialize, Clone)]
pub struct RuntimeDetectionResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Clone)]
struct RuntimeDetectionCache {
    detected_at: Instant,
    results: HashMap<String, RuntimeDetectionResult>,
}

const RUNTIME_DETECTION_CACHE_TTL: Duration = Duration::from_secs(30);
const RUNTIME_DETECTION_VERSION_TIMEOUT: Duration = Duration::from_secs(2);

struct RuntimeDetectionState {
    cache: Option<RuntimeDetectionCache>,
    in_progress: bool,
}

struct RuntimeDetectionGate {
    state: Mutex<RuntimeDetectionState>,
    done: Condvar,
}

enum RuntimeDetectionGateDecision {
    CacheHit(HashMap<String, RuntimeDetectionResult>),
    JoinInFlight,
    RunDetection,
}

static RUNTIME_DETECTION_GATE: OnceLock<RuntimeDetectionGate> = OnceLock::new();

fn should_use_runtime_detection_cache(now: Instant, cached_at: Instant, ttl: Duration) -> bool {
    now.saturating_duration_since(cached_at) < ttl
}

fn clone_runtime_detection_cache_results(
    cache: &RuntimeDetectionCache,
) -> HashMap<String, RuntimeDetectionResult> {
    cache.results.clone()
}

fn runtime_detection_gate() -> &'static RuntimeDetectionGate {
    RUNTIME_DETECTION_GATE.get_or_init(|| RuntimeDetectionGate {
        state: Mutex::new(RuntimeDetectionState {
            cache: None,
            in_progress: false,
        }),
        done: Condvar::new(),
    })
}

fn runtime_detection_gate_decision(
    gate: &RuntimeDetectionGate,
    now: Instant,
    ttl: Duration,
) -> RuntimeDetectionGateDecision {
    let mut state = match gate.state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(cache) = state.cache.as_ref() {
        if should_use_runtime_detection_cache(now, cache.detected_at, ttl) {
            return RuntimeDetectionGateDecision::CacheHit(clone_runtime_detection_cache_results(
                cache,
            ));
        }
    }

    if state.in_progress {
        RuntimeDetectionGateDecision::JoinInFlight
    } else {
        state.in_progress = true;
        RuntimeDetectionGateDecision::RunDetection
    }
}

fn wait_for_runtime_detection_result(
    gate: &RuntimeDetectionGate,
) -> HashMap<String, RuntimeDetectionResult> {
    let mut state = match gate.state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };

    while state.in_progress {
        state = match gate.done.wait(state) {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
    }

    state
        .cache
        .as_ref()
        .map(clone_runtime_detection_cache_results)
        .unwrap_or_else(run_runtime_detection)
}

fn finish_runtime_detection(
    gate: &RuntimeDetectionGate,
    detected_at: Instant,
    results: &HashMap<String, RuntimeDetectionResult>,
) {
    let mut state = match gate.state.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    };
    state.cache = Some(RuntimeDetectionCache {
        detected_at,
        results: results.clone(),
    });
    state.in_progress = false;
    gate.done.notify_all();
}

fn run_runtime_detection() -> HashMap<String, RuntimeDetectionResult> {
    let mut results = HashMap::new();

    // Builtin is always available
    results.insert(
        "builtin".to_string(),
        RuntimeDetectionResult {
            installed: true,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            path: None,
        },
    );

    // Claude Code CLI
    results.insert("claude-code".to_string(), detect_cli("claude"));

    // Codex CLI
    results.insert("codex".to_string(), detect_cli("codex"));

    // Gemini CLI (v0.1.66)
    results.insert("gemini".to_string(), detect_cli("gemini"));

    results
}

/// Detect whether external Agent Runtime CLIs are installed.
///
/// async + spawn_blocking is LOAD-BEARING (not a perf tweak): detection spawns
/// `<cli> --version` per installed runtime (blocking process spawns — ~hundreds of
/// ms each for the JS CLIs), and the in-flight-join branch blocks waiting on the
/// running detection. A sync command runs all of that on the MAIN thread = the
/// WKWebView UI thread on macOS, freezing the UI ~0.5–1.5s on Launcher/Chat/Settings
/// mount for multi-runtime users. Same class as cmd_ensure_session_sidecar — see the
/// CLAUDE.md red-line "同步 Tauri 命令阻塞 → 冻结 WKWebView". The cache /
/// in-flight-join gate is preserved inside the blocking helper.
#[tauri::command]
pub async fn cmd_detect_runtimes() -> HashMap<String, RuntimeDetectionResult> {
    tauri::async_runtime::spawn_blocking(detect_runtimes_blocking)
        .await
        // spawn_blocking only errors if the task panics — fall back to empty
        // detections (renderer's default is all-not-installed) rather than crash.
        .unwrap_or_else(|_| HashMap::new())
}

fn detect_runtimes_blocking() -> HashMap<String, RuntimeDetectionResult> {
    let now = Instant::now();
    let gate = runtime_detection_gate();
    match runtime_detection_gate_decision(gate, now, RUNTIME_DETECTION_CACHE_TTL) {
        RuntimeDetectionGateDecision::CacheHit(results) => {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::Runtime, "detect_cache_hit")
                    .status("ok")
                    .count(results.len() as u64),
            );
            return results;
        }
        RuntimeDetectionGateDecision::JoinInFlight => {
            let start = trace_start();
            emit_perf_trace(PerfTrace::new(PerfTraceName::Runtime, "detect_join"));
            let results = wait_for_runtime_detection_result(gate);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::Runtime, "detect_join_done")
                    .duration_ms(elapsed_ms(start))
                    .status("ok")
                    .count(results.len() as u64),
            );
            return results;
        }
        RuntimeDetectionGateDecision::RunDetection => {}
    }

    let start = trace_start();
    emit_perf_trace(PerfTrace::new(PerfTraceName::Runtime, "detect_start"));

    let results = run_runtime_detection();

    emit_perf_trace(
        PerfTrace::new(PerfTraceName::Runtime, "detect_done")
            .duration_ms(elapsed_ms(start))
            .status("ok")
            .count(results.len() as u64),
    );

    finish_runtime_detection(gate, now, &results);

    results
}

fn detect_cli(binary_name: &str) -> RuntimeDetectionResult {
    match crate::system_binary::find(binary_name) {
        Some(path) => {
            let version = detect_cli_version(&path);
            RuntimeDetectionResult {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        None => RuntimeDetectionResult {
            installed: false,
            version: None,
            path: None,
        },
    }
}

fn detect_cli_version(path: &Path) -> Option<String> {
    // MUST use process_cmd::new() to prevent Windows console flash.
    let mut cmd = crate::process_cmd::new(path);
    cmd.arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    crate::proxy_config::apply_to_subprocess(&mut cmd);

    let start = Instant::now();
    let mut child = cmd.spawn().ok()?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child.wait_with_output().ok()?;
                if status.success() {
                    return String::from_utf8(output.stdout)
                        .ok()
                        .map(|s| s.trim().to_string());
                }
                return None;
            }
            Ok(None) => {
                if start.elapsed() >= RUNTIME_DETECTION_VERSION_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod runtime_detection_cache_tests {
    use super::*;

    #[test]
    fn runtime_detection_cache_hit_within_ttl() {
        let cached_at = Instant::now();
        let now = cached_at + Duration::from_secs(29);
        assert!(should_use_runtime_detection_cache(
            now,
            cached_at,
            Duration::from_secs(30),
        ));
    }

    #[test]
    fn runtime_detection_cache_miss_after_ttl() {
        let cached_at = Instant::now();
        let now = cached_at + Duration::from_secs(30);
        assert!(!should_use_runtime_detection_cache(
            now,
            cached_at,
            Duration::from_secs(30),
        ));
    }

    #[test]
    fn runtime_detection_cache_returns_clone_not_shared_map() {
        let mut results = HashMap::new();
        results.insert(
            "codex".to_string(),
            RuntimeDetectionResult {
                installed: true,
                version: Some("1".to_string()),
                path: Some("/bin/codex".to_string()),
            },
        );
        let cache = RuntimeDetectionCache {
            detected_at: Instant::now(),
            results,
        };

        let mut cloned = clone_runtime_detection_cache_results(&cache);
        cloned.insert(
            "gemini".to_string(),
            RuntimeDetectionResult {
                installed: false,
                version: None,
                path: None,
            },
        );

        assert!(cache.results.contains_key("codex"));
        assert!(!cache.results.contains_key("gemini"));
    }

    fn test_gate() -> RuntimeDetectionGate {
        RuntimeDetectionGate {
            state: Mutex::new(RuntimeDetectionState {
                cache: None,
                in_progress: false,
            }),
            done: Condvar::new(),
        }
    }

    fn test_detection_result() -> RuntimeDetectionResult {
        RuntimeDetectionResult {
            installed: true,
            version: Some("1.0.0".to_string()),
            path: Some("/bin/codex".to_string()),
        }
    }

    #[test]
    fn runtime_detection_gate_first_miss_runs_detection() {
        let gate = test_gate();
        match runtime_detection_gate_decision(&gate, Instant::now(), Duration::from_secs(30)) {
            RuntimeDetectionGateDecision::RunDetection => {}
            _ => panic!("expected first cold miss to run detection"),
        }
        let state = gate.state.lock().unwrap();
        assert!(state.in_progress);
    }

    #[test]
    fn runtime_detection_gate_concurrent_miss_joins_in_flight_detection() {
        let gate = test_gate();
        assert!(matches!(
            runtime_detection_gate_decision(&gate, Instant::now(), Duration::from_secs(30)),
            RuntimeDetectionGateDecision::RunDetection
        ));
        assert!(matches!(
            runtime_detection_gate_decision(&gate, Instant::now(), Duration::from_secs(30)),
            RuntimeDetectionGateDecision::JoinInFlight
        ));
    }

    #[test]
    fn runtime_detection_gate_cache_hit_returns_clone() {
        let gate = test_gate();
        let mut results = HashMap::new();
        results.insert("codex".to_string(), test_detection_result());
        finish_runtime_detection(&gate, Instant::now(), &results);

        match runtime_detection_gate_decision(&gate, Instant::now(), Duration::from_secs(30)) {
            RuntimeDetectionGateDecision::CacheHit(mut cached) => {
                cached.remove("codex");
                let state = gate.state.lock().unwrap();
                assert!(state.cache.as_ref().unwrap().results.contains_key("codex"));
            }
            _ => panic!("expected cache hit"),
        }
    }
}
