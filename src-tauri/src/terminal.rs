//! Embedded terminal module — PTY management for split-panel terminal.
//!
//! Each Chat Tab can own one terminal instance. The terminal lifecycle is tied
//! to the Tab, not the panel visibility (hiding the panel keeps the PTY alive).
//!
//! Uses `portable-pty` (wezterm's PTY library) for cross-platform PTY support:
//! - macOS/Linux: `forkpty()` (POSIX PTY)
//! - Windows: ConPTY (Windows 10 1809+)
//!
//! Data flow:
//!   User keypress → invoke(cmd_terminal_write) → PTY master write
//!   PTY master read → emit(terminal:data:{id}) → xterm.js render
//!
//! NOTE: This module does NOT use `process_cmd::new()` — portable-pty manages
//! process creation internally via `CommandBuilder` + `slave.spawn_command()`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

use crate::{ulog_error, ulog_info};

/// A single terminal session with its PTY pair and reader task.
struct TerminalSession {
    /// Writer end of the PTY master — receives user keystrokes.
    writer: Box<dyn Write + Send>,
    /// The PTY master handle — used for resize operations.
    /// Wrapped in a Mutex because `resize()` requires `&self` but we need
    /// shared access from the resize command while writer is also held.
    master: Arc<std::sync::Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Shell child process handle (Child is not Sync, use std Mutex).
    child: Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send>>>,
    // NOTE: portable_pty::Child does not implement Sync, so we must not
    // require Sync on the Box. The std::sync::Mutex handles thread safety.
    /// Background task that reads PTY output and emits Tauri events.
    reader_task: JoinHandle<()>,
}

/// Manages all terminal sessions across Tabs.
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

#[derive(Debug, Default)]
pub struct TerminalCleanupReport {
    pub closed: usize,
    pub residual: Vec<String>,
}

impl TerminalManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
        })
    }
    /// PTY owner has no authoritative idle-command protocol. An open terminal
    /// therefore requires the user to finish/close it before confirmed update.
    pub(crate) async fn has_open_sessions(&self) -> bool {
        !self.sessions.lock().await.is_empty()
    }
}

/// Create a new terminal instance. Returns `terminal_id`.
#[tauri::command]
pub async fn cmd_terminal_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<TerminalManager>>,
    sidecars: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    workspace_path: String,
    rows: u16,
    cols: u16,
    session_id: Option<String>,
    terminal_id: Option<String>,
) -> Result<String, String> {
    let _lifecycle_spawn_permit = crate::sidecar::begin_lifecycle_spawn_permit()?;
    // Use frontend-provided ID if given (allows pre-registering listeners before creation),
    // otherwise generate one server-side.
    let id = terminal_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Reject duplicate IDs to prevent orphaning an existing session
    if state.sessions.lock().await.contains_key(&id) {
        return Err(format!("Terminal {} already exists", id));
    }

    // The embedded terminal advertises the same official `myagents` command
    // as Agent runtimes. Startup reconciliation is intentionally best-effort,
    // so terminal creation is its fail-closed admission boundary.
    tauri::async_runtime::spawn_blocking(crate::cli::ensure_launcher)
        .await
        .map_err(|error| format!("CLI launcher admission task failed: {error:?}"))??;

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build shell command — start as login shell (like iTerm2/VS Code Terminal).
    // Login shell reads /etc/zprofile + ~/.zprofile, shows "Last login" message,
    // and prevents the zsh PROMPT_EOL_MARK (%) on the first line.
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    #[cfg(all(unix, not(myagents_updater_qa)))]
    cmd.args(&["-l"]);
    cmd.cwd(&workspace_path);

    let sidecar_port = session_id.as_deref().and_then(|session_id| {
        sidecars
            .lock()
            .ok()
            .and_then(|mut manager| manager.get_session_port(session_id))
    });

    // Inject environment: bundled runtimes PATH + proxy config + manager-owned sidecar port
    inject_terminal_env(&mut cmd, &app, sidecar_port);

    // Spawn shell on the slave end
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", shell, e))?;

    // Drop slave — we only interact via master
    drop(pair.slave);

    // Get reader from master (clone before moving master)
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Get writer from master
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    // Wrap master and child for shared access
    let master = Arc::new(std::sync::Mutex::new(pair.master));
    let child: Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send>>> =
        Arc::new(std::sync::Mutex::new(child));

    // Spawn background reader task — passes manager Arc for self-cleanup on EOF
    let emit_id = id.clone();
    let app_clone = app.clone();
    let manager_for_reader: Arc<TerminalManager> = state.inner().clone();
    // Use `tauri::async_runtime::spawn_blocking` so the returned handle's type
    // matches the struct field (`tauri::async_runtime::JoinHandle<()>`); see
    // `clippy.toml` for the project-wide async-spawn rule.
    let reader_task = tauri::async_runtime::spawn_blocking(move || {
        terminal_read_loop(reader, &emit_id, &app_clone, manager_for_reader);
    });

    let session = TerminalSession {
        writer,
        master,
        child,
        reader_task,
    };

    state.sessions.lock().await.insert(id.clone(), session);

    ulog_info!(
        "[terminal] Created terminal {} (shell={}, cwd={})",
        id,
        shell,
        workspace_path
    );

    Ok(id)
}

/// Write data to a terminal (user keystrokes).
#[tauri::command]
pub async fn cmd_terminal_write(
    state: tauri::State<'_, Arc<TerminalManager>>,
    terminal_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

    session
        .writer
        .write_all(&data)
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;

    // Flush to ensure data is sent immediately (important for single keystrokes)
    session
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;

    Ok(())
}

/// Resize a terminal (when split panel is resized or window changes).
#[tauri::command]
pub async fn cmd_terminal_resize(
    state: tauri::State<'_, Arc<TerminalManager>>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

    let master = session
        .master
        .lock()
        .map_err(|e| format!("Failed to lock PTY master: {}", e))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {}", e))?;

    Ok(())
}

/// Close a terminal and kill its shell process.
#[tauri::command]
pub async fn cmd_terminal_close(
    state: tauri::State<'_, Arc<TerminalManager>>,
    terminal_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&terminal_id) {
        cleanup_session(session, &terminal_id, None);
    }
    Ok(())
}

/// Close all terminals. Called on app exit alongside `stop_all_sidecars()`.
pub async fn close_all_terminals(state: &Arc<TerminalManager>) -> TerminalCleanupReport {
    let drained: Vec<(String, TerminalSession)> = {
        let mut sessions = state.sessions.lock().await;
        sessions.drain().collect()
    };

    let mut report = TerminalCleanupReport {
        closed: drained.len(),
        residual: Vec::new(),
    };
    for (id, session) in drained {
        if let Some(residual) =
            cleanup_session(session, &id, Some(std::time::Duration::from_secs(2)))
        {
            report.residual.push(residual);
        }
    }
    if report.closed > 0 {
        ulog_info!(
            "[terminal] Closed {} terminal(s) on shutdown (residual={})",
            report.closed,
            report.residual.len()
        );
    }
    report
}

/// Clean up a single terminal session: kill child, abort reader task.
fn cleanup_session(
    session: TerminalSession,
    terminal_id: &str,
    wait_timeout: Option<std::time::Duration>,
) -> Option<String> {
    let mut residual = None;
    // Kill the shell process
    if let Ok(mut child) = session.child.lock() {
        let pid = child.process_id();
        let _ = child.kill();
        if let Some(timeout) = wait_timeout {
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if start.elapsed() < timeout => {
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    }
                    Ok(None) => {
                        residual = Some(match pid {
                            Some(pid) => format!("terminal={} pid={}", terminal_id, pid),
                            None => format!("terminal={} pid=<unknown>", terminal_id),
                        });
                        break;
                    }
                    Err(err) => {
                        residual = Some(match pid {
                            Some(pid) => {
                                format!("terminal={} pid={} wait_error={}", terminal_id, pid, err)
                            }
                            None => {
                                format!("terminal={} pid=<unknown> wait_error={}", terminal_id, err)
                            }
                        });
                        break;
                    }
                }
            }
        }
    }
    // Note: reader_task is a spawn_blocking task — abort() marks it for cancellation
    // but won't interrupt a blocked read(). The kill() above closes the PTY slave,
    // which causes read() to return EOF, naturally ending the reader loop.
    session.reader_task.abort();
    // Writer and master are dropped automatically
    ulog_info!("[terminal] Closed terminal {}", terminal_id);
    residual
}

/// Background loop: reads PTY output and emits Tauri events.
/// Self-cleans the session from `TerminalManager` on EOF/error so dead sessions
/// don't leak even if the frontend misses the exit event.
fn terminal_read_loop(
    mut reader: Box<dyn Read + Send>,
    terminal_id: &str,
    app: &AppHandle,
    manager: Arc<TerminalManager>,
) {
    let mut buf = [0u8; 4096];
    let event_data = format!("terminal:data:{}", terminal_id);
    let event_exit = format!("terminal:exit:{}", terminal_id);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // PTY closed (shell exited)
                let _ = app.emit(&event_exit, ());
                ulog_info!("[terminal] Shell exited for terminal {}", terminal_id);
                break;
            }
            Ok(n) => {
                // Send raw bytes to frontend as Vec<u8> (Tauri serializes to JSON array)
                let _ = app.emit(&event_data, buf[..n].to_vec());
            }
            Err(e) => {
                ulog_error!("[terminal] Read error for {}: {}", terminal_id, e);
                let _ = app.emit(&event_exit, ());
                break;
            }
        }
    }

    // Self-clean: remove dead session from TerminalManager.
    // This prevents leaked sessions when the frontend misses the exit event.
    // Use try_current() — Handle::current() panics if runtime is shutting down (app exit).
    let id = terminal_id.to_string();
    let Some(handle) = tokio::runtime::Handle::try_current().ok() else {
        return;
    };
    handle.spawn(async move {
        let mut map = manager.sessions.lock().await;
        if let Some(session) = map.remove(&id) {
            // Kill child process if still running
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            ulog_info!("[terminal] Self-cleaned dead session {}", id);
        }
    });
}

/// Select the default shell for the current platform.
fn default_shell() -> String {
    #[cfg(all(unix, myagents_updater_qa))]
    {
        // QA terminals must never source the user's login shell configuration.
        "/bin/sh".into()
    }
    #[cfg(all(unix, not(myagents_updater_qa)))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 → PowerShell 5.1 → cmd.exe
        // PowerShell supports Unix-like aliases (ls, pwd, clear, cat, etc.),
        // giving users a familiar experience. cmd.exe lacks these entirely.
        // Use system_binary::find() instead of bare which::which() (pit_of_success.md#system_binary)
        if crate::system_binary::find("pwsh").is_some() {
            "pwsh".into()
        } else if crate::system_binary::find("powershell").is_some() {
            "powershell".into()
        } else {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        }
    }
}

/// Inject environment variables into the terminal shell process.
///
/// This ensures the terminal has access to:
/// 1. App-owned CLI launchers and registered tool shims
/// 2. Proxy configuration (NO_PROXY protects localhost)
/// 3. Bundled Bun and Node.js (same PATH as SDK subprocesses)
fn inject_terminal_env(cmd: &mut CommandBuilder, app: &AppHandle, sidecar_port: Option<u16>) {
    if crate::app_dirs::IS_UPDATER_QA {
        if let Some(root) = crate::app_dirs::myagents_data_dir() {
            let home = root.join("terminal-home");
            let _ = std::fs::create_dir_all(&home);
            inject_updater_qa_terminal_env(cmd, &home, app.path().resource_dir().ok().as_deref(), sidecar_port);
        } else {
            cmd.env_clear();
        }
        return;
    }
    // 1. Build PATH. Product-owned launchers must win over stale
    // npm/AppData/inherited commands with the same name.
    let mut extra_paths: Vec<String> = Vec::new();

    // ~/.myagents/bin (CLI launchers and registered tools)
    if let Some(home) = dirs::home_dir() {
        let cli_bin = home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("bin");
        extra_paths.push(cli_bin.to_string_lossy().into());
    }

    // Bundled Bun directory
    if let Ok(resource_dir) = app.path().resource_dir() {
        // #229 (same bug class): on Windows resource_dir() may carry the `\\?\`
        // extended-length prefix. cmd.exe / PowerShell don't honor `\\?\` entries
        // in PATH lookups, so a prefixed nodejs/binaries dir would be invisible to
        // the embedded terminal. Strip it before these paths cross into the shell.
        let resource_dir = crate::sidecar::normalize_external_path(resource_dir);

        #[cfg(target_os = "macos")]
        {
            if let Some(contents_dir) = resource_dir.parent() {
                let macos_dir = contents_dir.join("MacOS");
                if macos_dir.exists() {
                    extra_paths.push(macos_dir.to_string_lossy().into_owned());
                }
            }
        }
        let binaries_dir = resource_dir.join("binaries");
        if binaries_dir.exists() {
            extra_paths.push(binaries_dir.to_string_lossy().into_owned());
        }

        // Bundled Node.js directory
        #[cfg(target_os = "windows")]
        let node_dir = resource_dir.join("nodejs");
        #[cfg(not(target_os = "windows"))]
        let node_dir = resource_dir.join("nodejs").join("bin");
        if node_dir.exists() {
            extra_paths.push(node_dir.to_string_lossy().into_owned());
        }
    }

    if !extra_paths.is_empty() {
        let current_path = std::env::var("PATH").unwrap_or_default();
        #[cfg(unix)]
        let new_path = format!("{}:{}", extra_paths.join(":"), current_path);
        #[cfg(windows)]
        let new_path = format!("{};{}", extra_paths.join(";"), current_path);
        cmd.env("PATH", new_path);
    }

    // 2. General proxy baseline — new PTYs follow the current general scope.
    //    We can't call proxy_config::apply_to_subprocess() directly because it takes
    //    &mut std::process::Command, not CommandBuilder. Apply the same logic manually,
    //    matching the error handling of the canonical apply_to_subprocess().
    let using_app_proxy = if let Some(proxy) =
        crate::proxy_config::read_proxy_settings_for_general_requests()
    {
        match crate::proxy_config::get_proxy_url(&proxy) {
            Ok(proxy_url) => {
                // CommandBuilder inherits the parent environment. Remove generic
                // SOCKS fallbacks so they cannot outrank the selected app HTTP(S)
                // proxy in child tools that prefer ALL_PROXY.
                cmd.env_remove("ALL_PROXY");
                cmd.env_remove("all_proxy");
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env(crate::proxy_config::PROXY_INJECTED_MARKER_ENV, "1");
                cmd.env(
                    crate::proxy_config::PROXY_INHERITED_ENV_JSON,
                    crate::proxy_config::inherited_proxy_env_json(),
                );
                true
            }
            Err(e) => {
                ulog_error!(
                    "[terminal] Invalid proxy configuration: {}. Terminal will start without proxy.",
                    e
                );
                // Don't inject proxy vars — let terminal inherit system network behavior
                false
            }
        }
    } else {
        false
    };
    let no_proxy = if using_app_proxy {
        crate::proxy_config::LOCALHOST_NO_PROXY.to_string()
    } else {
        // Preserve corporate/system bypass rules while adding mandatory
        // localhost protection on the inherited baseline.
        crate::proxy_config::inherited_no_proxy_with_localhost()
    };
    cmd.env("NO_PROXY", &no_proxy);
    cmd.env("no_proxy", &no_proxy);

    // 3. Sidecar port — lets `myagents` CLI talk to the Tab's session sidecar
    if let Some(port) = sidecar_port {
        cmd.env("MYAGENTS_PORT", port.to_string());
    }
    crate::external_cli::inject_internal_token_builder(cmd);

    // 4. Suppress zsh PROMPT_EOL_MARK (%) — the partial-line indicator that appears
    //    when zsh thinks the cursor is not at column 0 on startup. Previous fixes
    //    (login shell -l, xterm.reset()) were insufficient because the PTY initial
    //    state can still trigger zsh's detection. Setting PROMPT_EOL_MARK="" is the
    //    definitive fix, used by embedded terminal implementations (VS Code, etc.).
    cmd.env("PROMPT_EOL_MARK", "");

    // 5. Terminal type — CRITICAL: without this, shell doesn't know terminal capabilities,
    //    causing broken delete key, missing colors, and broken cursor movement.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "MyAgents");

    // 6. Locale — preserve system locale or default to UTF-8
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    // 7. Terminal indicator (so scripts can detect they're in MyAgents terminal)
    cmd.env("MYAGENTS_TERMINAL", "1");
}

fn inject_updater_qa_terminal_env(cmd: &mut CommandBuilder, home: &std::path::Path, resources: Option<&std::path::Path>, port: Option<u16>) {
    cmd.env_clear();
    let mut paths = vec![];
    if let Some(resources) = resources {
        paths.push(resources.join("nodejs/bin").to_string_lossy().into_owned());
    }
    paths.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(str::to_owned));
    cmd.env("PATH", paths.join(":"));
    cmd.env("HOME", home);
    cmd.env("CODEX_HOME", home.join(".codex"));
    cmd.env("CLAUDE_CONFIG_DIR", home.join(".claude"));
    cmd.env("SHELL", "/bin/sh");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "MoXBots Updater QA");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("MYAGENTS_TERMINAL", "1");
    cmd.env("NO_PROXY", "127.0.0.1,localhost");
    if let Some(port) = port { cmd.env("MYAGENTS_PORT", port.to_string()); }
}

#[cfg(test)]
mod updater_qa_terminal_environment_tests {
    #[test]
    fn qa_terminal_discards_credentials_user_path_and_shell_startup_environment() {
        let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
        for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "ENV", "BASH_ENV", "ZDOTDIR"] {
            cmd.env(key, "synthetic-user-value");
        }
        cmd.env("PATH", "/synthetic/user/tools");
        super::inject_updater_qa_terminal_env(&mut cmd, std::path::Path::new("/qa/terminal-home"), Some(std::path::Path::new("/qa/app/Contents/Resources")), Some(33415));
        for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "ENV", "BASH_ENV", "ZDOTDIR"] { assert!(cmd.get_env(key).is_none()); }
        assert_eq!(cmd.get_env("PATH").unwrap(), "/qa/app/Contents/Resources/nodejs/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        assert_eq!(cmd.get_env("CODEX_HOME").unwrap(), "/qa/terminal-home/.codex");
        assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR").unwrap(), "/qa/terminal-home/.claude");
    }
}
