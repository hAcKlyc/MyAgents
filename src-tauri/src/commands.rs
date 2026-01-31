// Tauri IPC commands for sidecar management and app operations
// Supports both legacy single-instance and new multi-instance APIs

use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

use crate::sidecar::{
    // Legacy exports
    get_sidecar_status, start_sidecar, stop_sidecar, restart_sidecar,
    ensure_sidecar_running, check_process_alive,
    ManagedSidecar, LegacySidecarConfig, SidecarStatus,
    // New multi-instance exports
    start_tab_sidecar, stop_tab_sidecar, get_tab_server_url, get_tab_sidecar_status,
    start_global_sidecar, stop_all_sidecars, GLOBAL_SIDECAR_ID,
};
use crate::logger;

// ============= Legacy Commands (for backward compatibility) =============

/// Command: Start the sidecar for a project (legacy single-instance)
#[tauri::command]
pub async fn cmd_start_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    agent_dir: String,
    initial_prompt: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, format!("[sidecar] Starting for project: {}", agent_dir));

    let config = LegacySidecarConfig {
        port: find_available_port().unwrap_or(31415),
        agent_dir: PathBuf::from(&agent_dir),
        initial_prompt,
    };

    match start_sidecar(&app_handle, &state, config) {
        Ok(_) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Started on port {}", status.port));
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
    stop_sidecar(&state)
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

    match restart_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
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
    match ensure_sidecar_running(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::debug(&app_handle, format!("[sidecar] Ensured running on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Ensure running failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Check if sidecar process is alive (legacy)
#[tauri::command]
pub async fn cmd_check_sidecar_alive(
    state: State<'_, ManagedSidecar>,
) -> Result<bool, String> {
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
        format!("[sidecar] Starting for tab {}, agent_dir: {:?}", tab_id, agent_dir),
    );

    let agent_path = agent_dir.map(PathBuf::from);

    match start_tab_sidecar(&app_handle, &state, &tab_id, agent_path) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, &tab_id)?;
            logger::info(&app_handle, format!("[sidecar] Tab {} started on port {}", tab_id, port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Tab {} failed to start: {}", tab_id, e));
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
    stop_tab_sidecar(&state, &tab_id)
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

    match start_global_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, GLOBAL_SIDECAR_ID)?;
            logger::info(&app_handle, format!("[sidecar] Global sidecar started on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Global sidecar failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Get global sidecar server URL
#[tauri::command]
pub async fn cmd_get_global_server_url(
    state: State<'_, ManagedSidecar>,
) -> Result<String, String> {
    get_tab_server_url(&state, GLOBAL_SIDECAR_ID)
}

/// Command: Stop all sidecar instances (for app exit)
#[tauri::command]
pub async fn cmd_stop_all_sidecars(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Stopping all instances".to_string());
    stop_all_sidecars(&state)
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
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64".to_string();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64".to_string();

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unknown".to_string();
}

/// Command: Get or create device ID
/// Stored in ~/.myagents/device_id to persist across app reinstalls
/// Only regenerates if the file is deleted by user
#[tauri::command]
pub fn cmd_get_device_id() -> Result<String, String> {
    use std::fs;
    use uuid::Uuid;

    // Get home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;

    // ~/.myagents/ directory
    let myagents_dir = home_dir.join(".myagents");
    let device_id_file = myagents_dir.join("device_id");

    // Try to read existing device_id
    if device_id_file.exists() {
        match fs::read_to_string(&device_id_file) {
            Ok(id) => {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Ok(id);
                }
            }
            Err(_) => {
                // File exists but can't read, will regenerate
            }
        }
    }

    // Generate new UUID
    let new_id = Uuid::new_v4().to_string();

    // Ensure directory exists
    if !myagents_dir.exists() {
        fs::create_dir_all(&myagents_dir)
            .map_err(|e| format!("Failed to create ~/.myagents directory: {}", e))?;
    }

    // Write device_id to file
    fs::write(&device_id_file, &new_id)
        .map_err(|e| format!("Failed to write device_id file: {}", e))?;

    Ok(new_id)
}
