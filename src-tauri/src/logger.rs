// Unified logger for Rust - sends logs to frontend AND persists to file
//
// Usage:
//   emit_log!(app, LogLevel::Info, "Message {}", arg);
//
// Features:
// - Sends to frontend via "log:rust" Tauri event
// - Persists to ~/.myagents/logs/unified-{YYYY-MM-DD}.log
// - Same format as Bun's UnifiedLogger

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};

/// Log level enum
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Debug,
}

impl LogLevel {
    fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
            LogLevel::Debug => "DEBUG",
        }
    }
}

/// Log entry sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub source: &'static str,
    pub level: LogLevel,
    pub message: String,
    pub timestamp: String,
}

/// Get logs directory path (~/.myagents/logs/)
fn get_logs_dir() -> PathBuf {
    static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();
    LOGS_DIR
        .get_or_init(|| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(".myagents").join("logs")
        })
        .clone()
}

/// Ensure logs directory exists
fn ensure_logs_dir() -> std::io::Result<()> {
    let logs_dir = get_logs_dir();
    if !logs_dir.exists() {
        fs::create_dir_all(&logs_dir)?;
    }
    Ok(())
}

/// Get today's unified log file path
fn get_log_file_path() -> PathBuf {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    get_logs_dir().join(format!("unified-{}.log", today))
}

/// Append log entry to unified log file
fn persist_log(entry: &LogEntry) {
    if let Err(e) = ensure_logs_dir() {
        log::error!("Failed to create logs directory: {}", e);
        return;
    }

    let path = get_log_file_path();
    let line = format!(
        "{} [RUST ] [{}] {}\n",
        entry.timestamp,
        entry.level.as_str(),
        entry.message
    );

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(line.as_bytes()) {
                log::error!("Failed to write to log file: {}", e);
            }
        }
        Err(e) => {
            log::error!("Failed to open log file: {}", e);
        }
    }
}

/// Create a log entry with current timestamp
pub fn create_log_entry(level: LogLevel, message: String) -> LogEntry {
    LogEntry {
        source: "rust",
        level,
        message,
        timestamp: chrono::Utc::now().to_rfc3339(),
    }
}

/// Send a log entry to the frontend and persist to file
pub fn emit_log<R: Runtime>(app: &AppHandle<R>, level: LogLevel, message: String) {
    let entry = create_log_entry(level, message.clone());

    // 1. Log to Rust's log system (stdout)
    match level {
        LogLevel::Info => log::info!("{}", message),
        LogLevel::Warn => log::warn!("{}", message),
        LogLevel::Error => log::error!("{}", message),
        LogLevel::Debug => log::debug!("{}", message),
    }

    // 2. Persist to unified log file
    persist_log(&entry);

    // 3. Send to frontend for UI display
    if let Err(e) = app.emit("log:rust", &entry) {
        log::error!("Failed to emit log to frontend: {}", e);
    }
}

/// Macro for convenient logging with format strings
#[macro_export]
macro_rules! emit_log {
    ($app:expr, $level:expr, $($arg:tt)*) => {{
        $crate::logger::emit_log($app, $level, format!($($arg)*));
    }};
}

/// Convenience functions
pub fn info<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Info, message.into());
}

pub fn warn<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Warn, message.into());
}

pub fn error<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Error, message.into());
}

pub fn debug<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Debug, message.into());
}
