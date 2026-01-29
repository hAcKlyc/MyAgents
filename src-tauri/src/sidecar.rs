// Sidecar process management module
// Handles spawning, monitoring, and shutting down multiple Bun backend server instances
// Supports per-Tab isolation with independent Sidecar processes

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

// Ensure file descriptor limit is increased only once
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
                        log::info!(
                            "[sidecar] Increased file descriptor limit: {} -> {} (hard limit: {})",
                            old_soft, target, hard_limit
                        );
                    } else {
                        log::warn!(
                            "[sidecar] Failed to increase file descriptor limit (current: {}, target: {})",
                            old_soft, target
                        );
                    }
                } else {
                    log::info!(
                        "[sidecar] File descriptor limit already sufficient: {} (hard: {})",
                        old_soft, hard_limit
                    );
                }
            } else {
                log::warn!("[sidecar] Failed to get current file descriptor limit");
            }
        }
    });
}

#[cfg(not(unix))]
fn ensure_high_file_descriptor_limit() {
    // No-op on non-Unix systems
}

// Configuration constants
const BASE_PORT: u16 = 31415;
// Health check: 60 attempts × 100ms = 6 seconds total (optimized for faster startup)
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 60;
const HEALTH_CHECK_DELAY_MS: u64 = 100;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 100;
const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 5;
// Port range: 500 ports (31415-31914)
const PORT_RANGE: u16 = 500;
// Special identifier for global sidecar (used by Settings page)
pub const GLOBAL_SIDECAR_ID: &str = "__global__";
// Process identification marker (used to identify our sidecar processes)
// This marker is added to all sidecar commands for reliable process identification
const SIDECAR_MARKER: &str = "--myagents-sidecar";

/// Cleanup stale sidecar processes from previous app instances
/// This should be called on app startup before creating the SidecarManager
/// Cleans up:
/// 1. Bun sidecar processes (identified by SIDECAR_MARKER)
/// 2. SDK child processes (claude-agent-sdk/cli.js)
/// 3. MCP child processes (~/.myagents/mcp/)
pub fn cleanup_stale_sidecars() {
    log::info!("[sidecar] Cleaning up stale sidecar processes...");

    #[cfg(unix)]
    {
        // 1. Clean up bun sidecar processes (our main sidecar)
        kill_processes_by_pattern("sidecar", SIDECAR_MARKER, true);

        // 2. Clean up SDK child processes
        // These are spawned by SDK and don't have our marker
        // Pattern matches: bun .../claude-agent-sdk/cli.js
        kill_processes_by_pattern("SDK", "claude-agent-sdk/cli.js", true);

        // 3. Clean up MCP child processes from our installation
        // Pattern matches: bun ~/.myagents/mcp/.../cli.js
        // This is specific to our MCP installation path, won't affect other apps
        kill_processes_by_pattern("MCP", ".myagents/mcp/", true);
    }

    #[cfg(windows)]
    {
        // Windows: use wmic to find processes with our marker (more precise than taskkill)
        // This only kills bun processes that have our marker in their command line
        if let Ok(output) = Command::new("wmic")
            .args(["process", "where", &format!("commandline like '%{}%'", SIDECAR_MARKER), "get", "processid"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines().skip(1) {
                if let Ok(pid) = line.trim().parse::<u32>() {
                    let _ = Command::new("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .output();
                }
            }
        }
        thread::sleep(Duration::from_millis(200));
        log::info!("[sidecar] Windows cleanup complete");
    }
}

/// Find PIDs by command line pattern, excluding current process
#[cfg(unix)]
fn find_pids_by_pattern(pattern: &str) -> Vec<i32> {
    let current_pid = std::process::id() as i32;

    Command::new("pgrep")
        .args(["-f", pattern])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<i32>().ok())
                // Exclude current process to avoid self-kill
                .filter(|&pid| pid != current_pid)
                .collect()
        })
        .unwrap_or_default()
}

/// Kill processes by pattern with optional SIGKILL fallback
/// - name: descriptive name for logging
/// - pattern: command line pattern to match
/// - force_kill: if true, use SIGKILL for processes that don't respond to SIGTERM
#[cfg(unix)]
fn kill_processes_by_pattern(name: &str, pattern: &str, force_kill: bool) {
    let pids = find_pids_by_pattern(pattern);
    if pids.is_empty() {
        return;
    }

    log::info!("[sidecar] Found {} {} processes, sending SIGTERM...", pids.len(), name);

    // First try SIGTERM for graceful shutdown
    for pid in &pids {
        unsafe {
            libc::kill(*pid, libc::SIGTERM);
        }
    }

    if !force_kill {
        return;
    }

    // Wait briefly for graceful shutdown
    thread::sleep(Duration::from_millis(300));

    // Check if any processes survived, use SIGKILL if needed
    let remaining = find_pids_by_pattern(pattern);
    if !remaining.is_empty() {
        log::warn!(
            "[sidecar] {} {} processes didn't respond to SIGTERM, using SIGKILL...",
            remaining.len(), name
        );
        for pid in &remaining {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }

    let final_remaining = find_pids_by_pattern(pattern);
    let killed_count = pids.len() - final_remaining.len();
    log::info!("[sidecar] {} cleanup complete, killed {}/{} processes", name, killed_count, pids.len());
}



/// Single Sidecar instance
pub struct SidecarInstance {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Agent directory (None for global sidecar)
    pub agent_dir: Option<PathBuf>,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Whether this is a global sidecar (uses temp directory)
    pub is_global: bool,
}

impl SidecarInstance {
    /// Check if the sidecar process is still running
    /// This actively checks the process rather than just relying on the healthy flag
    pub fn is_running(&mut self) -> bool {
        if !self.healthy {
            return false;
        }
        
        // Try to check if process has exited
        match self.process.try_wait() {
            Ok(Some(_)) => {
                // Process has exited
                self.healthy = false;
                false
            }
            Ok(None) => true, // Still running
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }
}

/// Ensure Bun process is killed when SidecarInstance is dropped
impl Drop for SidecarInstance {
    fn drop(&mut self) {
        log::info!("[sidecar] Drop: killing process on port {}", self.port);
        let _ = kill_process(&mut self.process);
        
        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                log::info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Multi-instance Sidecar Manager
/// Manages multiple Sidecar processes, one per Tab
pub struct SidecarManager {
    /// Tab ID -> Sidecar Instance
    instances: HashMap<String, SidecarInstance>,
    /// Port counter for allocation (starts from BASE_PORT)
    port_counter: AtomicU16,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            instances: HashMap::new(),
            port_counter: AtomicU16::new(BASE_PORT),
        }
    }

    /// Get the next available port with max attempts to prevent infinite loop
    fn allocate_port(&self) -> Result<u16, String> {
        const MAX_ATTEMPTS: u32 = 200;
        
        for _ in 0..MAX_ATTEMPTS {
            let port = self.port_counter.fetch_add(1, Ordering::SeqCst);
            
            // Reset counter if we've gone past the range
            if port > BASE_PORT + PORT_RANGE {
                self.port_counter.store(BASE_PORT, Ordering::SeqCst);
            }
            
            if is_port_available(port) {
                return Ok(port);
            }
        }
        
        Err(format!("No available port found after {} attempts", MAX_ATTEMPTS))
    }

    /// Check if a Tab has a running instance
    #[allow(dead_code)]
    pub fn has_instance(&self, tab_id: &str) -> bool {
        self.instances.contains_key(tab_id)
    }

    /// Get instance status for a Tab
    pub fn get_instance(&self, tab_id: &str) -> Option<&SidecarInstance> {
        self.instances.get(tab_id)
    }

    /// Get mutable instance reference
    pub fn get_instance_mut(&mut self, tab_id: &str) -> Option<&mut SidecarInstance> {
        self.instances.get_mut(tab_id)
    }

    /// Insert a new instance
    pub fn insert_instance(&mut self, tab_id: String, instance: SidecarInstance) {
        self.instances.insert(tab_id, instance);
    }

    /// Remove and return an instance (will be dropped, killing the process)
    pub fn remove_instance(&mut self, tab_id: &str) -> Option<SidecarInstance> {
        self.instances.remove(tab_id)
    }

    /// Get all Tab IDs
    #[allow(dead_code)]
    pub fn tab_ids(&self) -> Vec<String> {
        self.instances.keys().cloned().collect()
    }

    /// Stop all instances
    pub fn stop_all(&mut self) {
        log::info!("[sidecar] Stopping all {} instances", self.instances.len());
        self.instances.clear(); // Drop will kill each process
    }
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Ensure all processes are killed when manager is dropped
impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Thread-safe managed state wrapper
pub type ManagedSidecarManager = Arc<Mutex<SidecarManager>>;

/// Create a new managed sidecar manager
pub fn create_sidecar_manager() -> ManagedSidecarManager {
    Arc::new(Mutex::new(SidecarManager::new()))
}

// ============= Legacy compatibility types =============
// These are kept for backward compatibility during migration
// 
// TODO(PRD 0.1.0): Remove legacy API after confirming all frontend code
// uses the new multi-instance API (startTabSidecar, stopTabSidecar, etc.)
// 
// Legacy functions to remove:
// - start_sidecar, stop_sidecar, get_sidecar_status
// - restart_sidecar, ensure_sidecar_running, check_process_alive
// - cmd_start_sidecar, cmd_stop_sidecar, cmd_get_sidecar_status
// - cmd_get_server_url, cmd_restart_sidecar, cmd_ensure_sidecar_running
// - cmd_check_sidecar_alive

/// Legacy sidecar status (still used by existing commands)
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: u16,
    pub agent_dir: String,
}

/// Legacy managed sidecar type alias
pub type ManagedSidecar = ManagedSidecarManager;

/// Legacy function: create_sidecar_state -> create_sidecar_manager
pub fn create_sidecar_state() -> ManagedSidecar {
    create_sidecar_manager()
}

/// Legacy SidecarConfig with required agent_dir
#[derive(Debug, Clone)]
pub struct LegacySidecarConfig {
    #[allow(dead_code)]
    pub port: u16,
    pub agent_dir: PathBuf,
    #[allow(dead_code)]
    pub initial_prompt: Option<String>,
}

// ============= Core Functions =============

/// Kill a child process gracefully, then forcefully
fn kill_process(child: &mut Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = child.kill();
    }

    // Wait for graceful shutdown
    let timeout = Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS);
    let start = std::time::Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if start.elapsed() > timeout {
                    log::warn!("[sidecar] Force killing process");
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        }
    }
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Find the bun executable path
fn find_bun_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // First, try to find bundled bun in Contents/MacOS/
    // externalBin produces files with platform suffix: bun-aarch64-apple-darwin
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        if let Some(contents_dir) = resource_dir.parent() {
            // externalBin places binaries in MacOS/ with platform suffix
            #[cfg(target_os = "macos")]
            {
                #[cfg(target_arch = "aarch64")]
                let macos_bun = contents_dir.join("MacOS").join("bun-aarch64-apple-darwin");
                #[cfg(target_arch = "x86_64")]
                let macos_bun = contents_dir.join("MacOS").join("bun-x86_64-apple-darwin");

                if macos_bun.exists() {
                    log::info!("Using bundled bun from MacOS: {:?}", macos_bun);
                    return Some(macos_bun);
                }

                // Also check without suffix (for backward compatibility)
                let macos_bun_simple = contents_dir.join("MacOS").join("bun");
                if macos_bun_simple.exists() {
                    log::info!("Using bundled bun from MacOS (simple): {:?}", macos_bun_simple);
                    return Some(macos_bun_simple);
                }
            }
        }

        // Check in resource_dir/binaries/ for development mode
        let bundled_bun = resource_dir.join("binaries").join("bun");
        if bundled_bun.exists() {
            log::info!("Using bundled bun: {:?}", bundled_bun);
            return Some(bundled_bun);
        }

        #[cfg(target_os = "macos")]
        {
            #[cfg(target_arch = "aarch64")]
            let platform_bun = resource_dir.join("binaries").join("bun-aarch64-apple-darwin");
            #[cfg(target_arch = "x86_64")]
            let platform_bun = resource_dir.join("binaries").join("bun-x86_64-apple-darwin");

            if platform_bun.exists() {
                log::info!("Using bundled platform bun: {:?}", platform_bun);
                return Some(platform_bun);
            }
        }
    }


    // Fallback: system locations
    let candidates = [
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
        &format!(
            "{}/.bun/bin/bun",
            std::env::var("HOME").unwrap_or_default()
        ),
        "bun",
    ];

    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if path.exists() || which::which(candidate).is_ok() {
            log::info!("Using system bun: {:?}", path);
            return Some(path);
        }
    }

    which::which("bun").ok()
}

/// Find the server script path
fn find_server_script<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // 1. First check for bundled server-dist.js (Production)
    // Modified: Only check bundled script in Release mode, so Dev mode uses source
    #[cfg(debug_assertions)]
    log::info!("[sidecar] Debug mode detected, SKIPPING bundled script check (forcing source usage)");

    #[cfg(not(debug_assertions))]
    if let Ok(resource_dir) = _app_handle.path().resource_dir() {
        let bundled_script = resource_dir.join("server-dist.js");
        if bundled_script.exists() {
            log::info!("Using bundled server script (bundled): {:?}", bundled_script);
            return Some(bundled_script);
        }

        // 2. Legacy check: Check for server/index.ts (Development / Legacy)
        let legacy_script = resource_dir.join("server").join("index.ts");
        if legacy_script.exists() {
             log::info!("Using bundled server script (legacy): {:?}", legacy_script);
             return Some(legacy_script);
        }
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("server").join("index.ts"));

        if let Some(ref path) = dev_path {
            if path.exists() {
                log::info!("Using development server script: {:?}", path);
                return dev_path;
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("src").join("server").join("index.ts");
            if cwd_path.exists() {
                log::info!("Using cwd server script: {:?}", cwd_path);
                return Some(cwd_path);
            }
        }
    }

    log::error!("Server script not found in any location");
    None
}

/// Wait for a sidecar to become healthy
fn wait_for_health(port: u16) -> Result<(), String> {
    let delay = Duration::from_millis(HEALTH_CHECK_DELAY_MS);

    for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        ) {
            Ok(_) => {
                log::info!("[sidecar] Healthy after {} attempts on port {}", attempt, port);
                return Ok(());
            }
            Err(_) => {
                if attempt < HEALTH_CHECK_MAX_ATTEMPTS {
                    thread::sleep(delay);
                }
            }
        }
    }

    Err(format!(
        "Sidecar failed to become healthy after {} attempts",
        HEALTH_CHECK_MAX_ATTEMPTS
    ))
}

// ============= Tab-based Multi-instance Commands =============

/// Start a Sidecar for a specific Tab
pub fn start_tab_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
) -> Result<u16, String> {
    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Check if already running for this tab
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            log::info!("[sidecar] Tab {} already has running instance on port {}", tab_id, instance.port);
            return Ok(instance.port);
        }
    }

    // Remove stale instance if exists
    manager_guard.remove_instance(tab_id);

    // Find executables
    let bun_path = find_bun_executable(app_handle)
        .ok_or_else(|| "Bun executable not found".to_string())?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    log::info!(
        "[sidecar] Starting for tab {} on port {}, agent_dir: {:?}",
        tab_id, port, agent_dir
    );

    // Build command - 直接用 bun <script> 而非 bun run <script>（更稳定）
    // Add SIDECAR_MARKER for reliable process identification and cleanup
    let mut cmd = Command::new(&bun_path);
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER);

    // Determine if this is a global sidecar and handle agent directory
    let is_global = agent_dir.is_none();
    let effective_agent_dir = if let Some(ref dir) = agent_dir {
        cmd.arg("--agent-dir").arg(dir);
        Some(dir.clone())
    } else {
        // Global sidecar: use temp directory
        let temp_dir = std::env::temp_dir().join(format!("myagents-global-{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).ok();
        cmd.arg("--agent-dir").arg(&temp_dir);
        Some(temp_dir)
    };

    // Set working directory to script's parent directory
    // This is crucial for bun to find relative imports
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
        log::info!("[sidecar] Working directory set to: {:?}", script_dir);
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // 关键诊断日志：打印当前可执行文件路径，确认运行的是正确版本
    log::info!("[sidecar] current_exe = {:?}", std::env::current_exe().ok());

    log::info!(
        "[sidecar] Spawning: bun={:?}, script={:?}, port={}, is_global={}",
        bun_path, script_path, port, is_global
    );

    // Spawn
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("[sidecar] Failed to spawn: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    log::info!("[sidecar] Process spawned with pid: {:?}", child.id());

    // 启动线程捕获 stdout
    if let Some(stdout) = child.stdout.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                log::info!("[bun-out][{}] {}", tab_id_clone, line);
            }
        });
    }

    // 启动线程捕获 stderr（关键：这里会打印 Bun 的错误信息）
    if let Some(stderr) = child.stderr.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::error!("[bun-err][{}] {}", tab_id_clone, line);
            }
        });
    }

    // Brief wait to let stdout/stderr threads capture initial output
    // Reduced from 500ms to 50ms for faster startup
    thread::sleep(Duration::from_millis(50));
    if let Ok(Some(status)) = child.try_wait() {
        // Process exited immediately, wait a bit for stderr thread to capture output
        thread::sleep(Duration::from_millis(100));
        log::error!("[sidecar] Process exited immediately with status: {:?}", status);
        return Err(format!("Bun process exited immediately with status: {:?}", status));
    }

    // Create instance (not yet healthy)
    let instance = SidecarInstance {
        process: child,
        port,
        agent_dir: effective_agent_dir,
        healthy: false,
        is_global,
    };

    manager_guard.insert_instance(tab_id.to_string(), instance);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Wait for health
    match wait_for_health(port) {
        Ok(()) => {
            // Mark as healthy
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                instance.healthy = true;
            }
            Ok(port)
        }
        Err(e) => {
            // Health check failed - try to get process output for debugging
            log::error!("[sidecar] Health check failed: {}", e);
            
            // Try to get the instance and check if process is still running
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                // Check if process has exited
                match instance.process.try_wait() {
                    Ok(Some(status)) => {
                        log::error!("[sidecar] Process exited with status: {:?}", status);
                    }
                    Ok(None) => {
                        log::error!("[sidecar] Process still running but not healthy");
                    }
                    Err(wait_err) => {
                        log::error!("[sidecar] Failed to check process status: {}", wait_err);
                    }
                }
                
                // Try to read stderr if available
                if let Some(ref mut stderr) = instance.process.stderr.take() {
                    use std::io::Read;
                    let mut output = String::new();
                    if stderr.read_to_string(&mut output).is_ok() && !output.is_empty() {
                        log::error!("[sidecar] Process stderr: {}", output);
                    }
                }
            }
            
            // Remove the failed instance
            manager_guard.remove_instance(tab_id);
            
            Err(e)
        }
    }
}

/// Stop a Sidecar for a specific Tab
pub fn stop_tab_sidecar(manager: &ManagedSidecarManager, tab_id: &str) -> Result<(), String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    
    if let Some(instance) = manager_guard.remove_instance(tab_id) {
        log::info!("[sidecar] Stopped instance for tab {} on port {}", tab_id, instance.port);
        // Instance is dropped here, killing the process
    }
    
    Ok(())
}

/// Get the server URL for a specific Tab
pub fn get_tab_server_url(manager: &ManagedSidecarManager, tab_id: &str) -> Result<String, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            return Ok(format!("http://127.0.0.1:{}", instance.port));
        }
    }
    
    Err(format!("No running sidecar for tab {}", tab_id))
}

/// Get status for a Tab's sidecar
pub fn get_tab_sidecar_status(manager: &ManagedSidecarManager, tab_id: &str) -> Result<SidecarStatus, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        Ok(SidecarStatus {
            running: instance.is_running(),
            port: instance.port,
            agent_dir: instance.agent_dir.as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        })
    } else {
        Ok(SidecarStatus {
            running: false,
            port: 0,
            agent_dir: String::new(),
        })
    }
}

/// Start the global sidecar (for Settings page)
pub fn start_global_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<u16, String> {
    start_tab_sidecar(app_handle, manager, GLOBAL_SIDECAR_ID, None)
}

/// Stop all sidecar instances and clean up child processes
/// This should be called when the app is closing
pub fn stop_all_sidecars(manager: &ManagedSidecarManager) -> Result<(), String> {
    log::info!("[sidecar] Stopping all sidecars and cleaning up child processes...");

    // 1. Stop all managed sidecar instances (kills bun sidecars via Drop)
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    manager_guard.stop_all();
    drop(manager_guard);

    // 2. Clean up any orphaned child processes (SDK and MCP)
    // This is necessary because SDK spawns child processes that don't die
    // when the parent bun sidecar is killed
    cleanup_child_processes();

    Ok(())
}

/// Clean up SDK and MCP child processes
/// Called on app shutdown to ensure no orphaned processes remain
#[cfg(unix)]
fn cleanup_child_processes() {
    // Clean up SDK child processes (with SIGKILL fallback for app shutdown)
    kill_processes_by_pattern("SDK", "claude-agent-sdk/cli.js", true);

    // Clean up MCP child processes (with SIGKILL fallback for app shutdown)
    kill_processes_by_pattern("MCP", ".myagents/mcp/", true);
}

#[cfg(not(unix))]
fn cleanup_child_processes() {
    // Windows cleanup is handled by process termination cascading
    // TODO: Implement Windows-specific cleanup if needed
}

// ============= Legacy Compatibility Functions =============
// These wrap the new multi-instance API to support existing code

/// Legacy: Start sidecar (uses "__legacy__" as tab ID)
pub fn start_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
    config: LegacySidecarConfig,
) -> Result<u16, String> {
    // Use legacy tab ID
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Stop any existing legacy instance
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);
    
    // Start new instance
    start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(config.agent_dir))
}

/// Legacy: Stop sidecar
pub fn stop_sidecar(state: &ManagedSidecar) -> Result<(), String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    stop_tab_sidecar(state, LEGACY_TAB_ID)
}

/// Legacy: Get sidecar status
pub fn get_sidecar_status(state: &ManagedSidecar) -> Result<SidecarStatus, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    get_tab_sidecar_status(state, LEGACY_TAB_ID)
}

/// Legacy: Check if process is alive
pub fn check_process_alive(state: &ManagedSidecar) -> Result<bool, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
    
    if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
        Ok(instance.is_running())
    } else {
        Ok(false)
    }
}

/// Legacy: Restart sidecar
pub fn restart_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Get current config
    let agent_dir = {
        let manager_guard = state.lock().map_err(|e| e.to_string())?;
        manager_guard.get_instance(LEGACY_TAB_ID)
            .and_then(|i| i.agent_dir.clone())
    };
    
    // Stop and restart
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);
    
    if let Some(dir) = agent_dir {
        start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(dir))
    } else {
        Err("No previous agent_dir to restart with".to_string())
    }
}

/// Legacy: Ensure sidecar is running
pub fn ensure_sidecar_running<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Check if already running
    {
        let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
            if instance.is_running() {
                return Ok(instance.port);
            }
        }
    }
    
    // Need to restart
    restart_sidecar(app_handle, state)
}
