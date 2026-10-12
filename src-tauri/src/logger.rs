// This module IS the unified logger — `ulog_*!` macros internally route
// through the unified emit path which delegates to `log::*` for env_logger /
// stdout compat. Calling `ulog_*!` from inside this file would recurse, so
// raw `log::*` is intentional here. clippy.toml bans `log::*` everywhere
// else; this file-level allow is the single legitimate exception.
#![allow(clippy::disallowed_macros)]

// Unified logger for Rust — Pattern 6 (Observability + Correlation IDs).
//
// Two usage modes (unchanged from v0.1.x — all existing call sites keep working):
//
// 1. With explicit AppHandle:
//      emit_log!(app, LogLevel::Info, "Message {}", arg);
//
// 2. Via global handle:
//      ulog_info!("[feishu] Connected");
//      ulog_warn!("[im] Timeout: {}", err);
//
// Pattern 6 additions (backward-compatible):
//   - Optional kv-pair syntax on `ulog_*!` macros:
//       ulog_info!("[claude-code] turn done", session_id = sid, turn_id = tid);
//     The kv pairs are read after a `;` separator. Existing call sites that
//     don't use the separator continue to work via the `format!` arm.
//   - `LogEntry` carries optional `session_id / tab_id / owner_id /
//     request_id / turn_id / runtime` fields. Populated either explicitly
//     (kv pairs above) or implicitly from `LogContext::current()`
//     (`tokio::task_local!` set by the HTTP handler before calling
//     downstream code — see `local_http.rs` request entry).
//   - Buffered async writer: one tokio task owns a `BufWriter<File>` and
//     drains a bounded `mpsc` channel (capacity 1024). Replaces the old
//     "open / append / close per line" pattern (Audit G P2 finding).
//     Drop counter on overflow, periodic warning every 60s, exit-time
//     synchronous flush so we don't lose lines on crash.

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

/// Log level enum
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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

/// Log entry sent to frontend.
///
/// Pattern 6: `session_id / tab_id / owner_id / request_id / turn_id /
/// runtime` are optional correlation fields populated either by explicit
/// kv pairs on `ulog_*!` invocations or by `LogContext::current()`.
#[derive(Debug, Clone, Serialize, Default)]
pub struct LogEntry {
    pub source: &'static str,
    pub level: LogLevel,
    pub message: String,
    pub timestamp: String,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "tabId", skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(rename = "ownerId", skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

impl Default for LogLevel {
    fn default() -> Self {
        LogLevel::Info
    }
}

const RENDERER_BOOT_STAGES: &[&str] = &[
    "native-init-script",
    "theme-native-bootstrap-skipped",
    "theme-native-bootstrap-complete",
    "theme-native-bootstrap-failed",
    "renderer-uncaught-error",
    "renderer-unhandled-rejection",
    "renderer-entry-evaluated",
    "theme-renderer-bootstrap-complete",
    "theme-renderer-bootstrap-failed",
    "react-root-created",
    "react-commit",
];

fn format_renderer_boot_event(
    stage: &str,
    window_label: &str,
    detail: Option<&str>,
) -> Result<(LogLevel, String), String> {
    if !RENDERER_BOOT_STAGES.contains(&stage) {
        return Err(format!("Unknown renderer boot stage: {stage}"));
    }
    if window_label.is_empty()
        || window_label.len() > 64
        || !window_label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Invalid renderer window label".to_owned());
    }
    let detail = detail.map(|value| {
        value
            .chars()
            .take(2_000)
            .collect::<String>()
            .replace(['\r', '\n'], " ")
    });
    let level =
        if stage.contains("failed") || stage.contains("error") || stage.contains("rejection") {
            LogLevel::Error
        } else {
            LogLevel::Info
        };
    let message = match detail.filter(|value| !value.is_empty()) {
        Some(detail) => format!("[boot] stage={stage} window={window_label} detail={detail}"),
        None => format!("[boot] stage={stage} window={window_label}"),
    };
    Ok((level, message))
}

/// Pre-App renderer diagnostics ingress. It is deliberately stage-limited so
/// initialization scripts can persist boot evidence through the canonical
/// unified logger without exposing a second general-purpose logging surface.
#[tauri::command]
pub fn cmd_record_renderer_boot_event(
    stage: String,
    window_label: String,
    detail: Option<String>,
) -> Result<(), String> {
    let (level, message) = format_renderer_boot_event(&stage, &window_label, detail.as_deref())?;
    unified_log(level, message);
    Ok(())
}

// ── Pattern 6: tokio task_local correlation context ────────────────────
//
// Wrap an async unit-of-work with `LOG_CONTEXT.scope(LogContext { ... },
// async { ... }).await` and any nested `ulog_*!` call inside picks up
// those fields automatically. Used by the HTTP request handler in
// `local_http.rs` to propagate `X-MyAgents-Request-Id /
// X-MyAgents-Session-Id / X-MyAgents-Tab-Id` from inbound headers.

#[derive(Debug, Clone, Default)]
pub struct LogContext {
    pub session_id: Option<String>,
    pub tab_id: Option<String>,
    pub owner_id: Option<String>,
    pub request_id: Option<String>,
    pub turn_id: Option<String>,
    pub runtime: Option<String>,
}

impl LogContext {
    /// Read the current context from the surrounding `task_local` scope,
    /// or `None` if called outside any `LOG_CONTEXT.scope(...)` frame.
    /// Falls back to a thread-local for non-async (sync) call sites.
    pub fn current() -> Option<LogContext> {
        // task_local access can fail with `AccessError` outside a scope —
        // that's not an error, it just means "no context". Prefer task_local
        // when in async; fall through to the sync TLS otherwise.
        let from_task = LOG_CONTEXT.try_with(|c| c.clone()).ok();
        if from_task.is_some() {
            return from_task;
        }
        SYNC_LOG_CONTEXT.with(|c| c.borrow().clone())
    }

    /// Apply this context's fields onto a `LogEntry`. Explicit kv pairs on
    /// the macro invocation win — this only fills fields that are still
    /// `None` after macro-level population.
    pub fn fill(&self, entry: &mut LogEntry) {
        if entry.session_id.is_none() {
            entry.session_id = self.session_id.clone();
        }
        if entry.tab_id.is_none() {
            entry.tab_id = self.tab_id.clone();
        }
        if entry.owner_id.is_none() {
            entry.owner_id = self.owner_id.clone();
        }
        if entry.request_id.is_none() {
            entry.request_id = self.request_id.clone();
        }
        if entry.turn_id.is_none() {
            entry.turn_id = self.turn_id.clone();
        }
        if entry.runtime.is_none() {
            entry.runtime = self.runtime.clone();
        }
    }
}

tokio::task_local! {
    pub static LOG_CONTEXT: LogContext;
}

thread_local! {
    /// Sync fallback for code paths that don't run on a tokio task (e.g. the
    /// few `std::thread::spawn` worker threads in cron/file-watcher init).
    /// Set via `with_sync_log_context`.
    static SYNC_LOG_CONTEXT: std::cell::RefCell<Option<LogContext>> =
        const { std::cell::RefCell::new(None) };
}

/// Run a synchronous closure with `ctx` set as the ambient log context.
/// Restores the previous value (typically `None`) on return — exception-safe.
pub fn with_sync_log_context<R>(ctx: LogContext, f: impl FnOnce() -> R) -> R {
    SYNC_LOG_CONTEXT.with(|c| {
        let prev = c.borrow().clone();
        *c.borrow_mut() = Some(ctx);
        let r = f();
        *c.borrow_mut() = prev;
        r
    })
}

/// Get logs directory path (~/.myagents/logs/)
fn get_logs_dir() -> PathBuf {
    static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();
    LOGS_DIR
        .get_or_init(|| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("logs")
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

// ── Buffered writer (Pattern 6 §6.3.3) ─────────────────────────────────
//
// One tokio task owns the `BufWriter<File>`; all `ulog_*!` calls send a
// pre-formatted `String` over a bounded mpsc channel. The writer task
// flushes on a 200ms tick or when the channel hits a high-water mark.
// On overflow we increment a drop counter and emit a warning every 60s.

const WRITER_CHANNEL_CAPACITY: usize = 1024;
const WRITER_FLUSH_INTERVAL_MS: u64 = 200;

static WRITER_SENDER: OnceLock<tokio::sync::mpsc::Sender<String>> = OnceLock::new();
static SYNC_WRITE_FALLBACK: Mutex<()> = Mutex::new(());
static DROPPED: AtomicU64 = AtomicU64::new(0);
static LAST_DROP_WARN_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Initialize the buffered writer task. Idempotent — safe to call multiple
/// times; only the first call actually spawns.
///
/// MUST use `tauri::async_runtime::spawn` — this is called from Tauri's
/// `.setup()` callback which runs on the main thread without a Tokio reactor.
/// `tokio::spawn` would panic and, because `.setup()` is invoked through an
/// ObjC callback on macOS, the panic cannot unwind across the FFI boundary
/// and aborts the process (`panic_cannot_unwind` in `did_finish_launching`).
/// (Same pattern as `search/mod.rs::start_background_indexing`.)
pub fn init_buffered_writer() {
    if WRITER_SENDER.get().is_some() {
        return;
    }
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(WRITER_CHANNEL_CAPACITY);
    if WRITER_SENDER.set(tx).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Open the current day's file. Re-open on day rollover.
        let mut current_path = get_log_file_path();
        let mut writer: Option<BufWriter<std::fs::File>> = None;
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(WRITER_FLUSH_INTERVAL_MS));

        loop {
            tokio::select! {
                maybe_line = rx.recv() => {
                    let Some(line) = maybe_line else { break }; // channel closed
                    let path = get_log_file_path();
                    if writer.is_none() || path != current_path {
                        if let Err(e) = ensure_logs_dir() {
                            log::error!("Failed to create logs directory: {}", e);
                            continue;
                        }
                        current_path = path.clone();
                        writer = OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&current_path)
                            .ok()
                            .map(BufWriter::new);
                    }
                    if let Some(w) = writer.as_mut() {
                        if let Err(e) = w.write_all(line.as_bytes()) {
                            log::error!("Failed to write to log file: {}", e);
                        }
                    }
                }
                _ = interval.tick() => {
                    if let Some(w) = writer.as_mut() {
                        let _ = w.flush();
                    }
                    // Periodic drop-counter warning (Pattern 6 §6.3.5).
                    let dropped = DROPPED.swap(0, Ordering::Relaxed);
                    if dropped > 0 {
                        let now = now_ms();
                        let last = LAST_DROP_WARN_MS.load(Ordering::Relaxed);
                        if now.saturating_sub(last) >= 60_000 {
                            LAST_DROP_WARN_MS.store(now, Ordering::Relaxed);
                            log::warn!(
                                "[unified-logger] dropped {} log entries (writer queue saturated)",
                                dropped
                            );
                        } else {
                            // Re-add for the next interval so we don't lose count.
                            DROPPED.fetch_add(dropped, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
        if let Some(mut w) = writer {
            let _ = w.flush();
        }
    });
}

/// Append a formatted line to the unified log file. Non-blocking: enqueues
/// to the writer task. If the queue is saturated, increment the drop counter
/// and return. If called before `init_buffered_writer()` (e.g. very early in
/// startup) or from a non-async context, falls back to a synchronous append
/// guarded by a mutex.
fn enqueue_or_sync_append(line: String) {
    if let Some(tx) = WRITER_SENDER.get() {
        match tx.try_send(line.clone()) {
            Ok(_) => return,
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                DROPPED.fetch_add(1, Ordering::Relaxed);
                return;
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                // Writer task gone (shutdown) — fall through to sync.
            }
        }
    }
    // Sync fallback (used pre-init and at shutdown). Held briefly.
    let _guard = SYNC_WRITE_FALLBACK.lock();
    let _ = ensure_logs_dir();
    let path = get_log_file_path();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn format_line(entry: &LogEntry) -> String {
    // Compose correlation-tag suffix in a fixed order so log diffs stay stable.
    let mut tags: Vec<String> = Vec::new();
    if let Some(ref v) = entry.session_id {
        tags.push(format!("sid={}", v));
    }
    if let Some(ref v) = entry.turn_id {
        tags.push(format!("turn={}", v));
    }
    if let Some(ref v) = entry.request_id {
        tags.push(format!("req={}", v));
    }
    if let Some(ref v) = entry.tab_id {
        tags.push(format!("tab={}", v));
    }
    if let Some(ref v) = entry.runtime {
        tags.push(format!("rt={}", v));
    }
    if let Some(ref v) = entry.owner_id {
        tags.push(format!("owner={}", v));
    }
    let tag_suffix = if tags.is_empty() {
        String::new()
    } else {
        format!(" [{}]", tags.join(" "))
    };
    format!(
        "{} [RUST ] [{}]{} {}\n",
        entry.timestamp,
        entry.level.as_str(),
        tag_suffix,
        entry.message
    )
}

/// Append log entry to unified log file (via buffered writer).
const fn should_persist_logs() -> bool {
    // Rust unit tests share the developer's real HOME by default. Persisting
    // their synthetic failures into ~/.myagents/logs makes production triage
    // indistinguishable from test activity. Test output still reaches the
    // normal Rust log capture; only the user-owned unified file sink is off.
    !cfg!(test)
}

fn persist_log(entry: &LogEntry) {
    if !should_persist_logs() {
        return;
    }
    enqueue_or_sync_append(format_line(entry));
}

/// Create a log entry with current timestamp.
///
/// Pattern 6: also fills correlation fields from `LogContext::current()`
/// (task_local first, sync TLS fallback). Explicit kv pairs on the macro
/// invocation override these (the macros pre-populate the entry before
/// calling this function via `create_log_entry_with_ctx`).
pub fn create_log_entry(level: LogLevel, message: String) -> LogEntry {
    let mut entry = LogEntry {
        source: "rust",
        level,
        message,
        timestamp: chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string(),
        ..Default::default()
    };
    if let Some(ctx) = LogContext::current() {
        ctx.fill(&mut entry);
    }
    entry
}

/// Create a log entry pre-populated with correlation fields, then merge any
/// remaining undef'd fields from `LogContext::current()`. This is the entry
/// point used by the kv-pair form of `ulog_*!`.
pub fn create_log_entry_with_correlation(
    level: LogLevel,
    message: String,
    session_id: Option<String>,
    tab_id: Option<String>,
    owner_id: Option<String>,
    request_id: Option<String>,
    turn_id: Option<String>,
    runtime: Option<String>,
) -> LogEntry {
    let mut entry = LogEntry {
        source: "rust",
        level,
        message,
        timestamp: chrono::Local::now()
            .format("%Y-%m-%d %H:%M:%S%.3f")
            .to_string(),
        session_id,
        tab_id,
        owner_id,
        request_id,
        turn_id,
        runtime,
    };
    if let Some(ctx) = LogContext::current() {
        ctx.fill(&mut entry);
    }
    entry
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

    // 2. Persist to unified log file (buffered)
    persist_log(&entry);

    // 3. Send to frontend for UI display
    if let Err(e) = app.emit("log:rust", &entry) {
        log::error!("Failed to emit log to frontend: {}", e);
    }
}

/// Macro for convenient logging with format strings (requires AppHandle)
#[macro_export]
macro_rules! emit_log {
    ($app:expr, $level:expr, $($arg:tt)*) => {{
        $crate::logger::emit_log($app, $level, format!($($arg)*));
    }};
}

/// Convenience functions (require AppHandle)
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

// ── Global AppHandle for modules without direct access ──────────────

/// Global AppHandle stored at app startup.
/// Enables unified logging from any Rust module without threading AppHandle through every struct.
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Initialize the global AppHandle. Call once during app setup.
pub fn init_app_handle(app: AppHandle) {
    if GLOBAL_APP_HANDLE.set(app).is_err() {
        log::warn!("Global AppHandle already initialized");
    }
}

/// Retrieve the global AppHandle (returns None if not yet initialized).
pub fn get_app_handle() -> Option<&'static AppHandle> {
    GLOBAL_APP_HANDLE.get()
}

/// Log via the global AppHandle — writes to stdout, unified log file, and frontend.
/// Falls back to stdout-only if called before init_app_handle().
pub fn unified_log(level: LogLevel, message: String) {
    unified_log_entry(create_log_entry(level, message));
}

/// Lower-level entry: caller has already constructed the LogEntry (used by
/// the kv-pair form of `ulog_*!` macros so explicit correlation values on
/// the call site take precedence over `LogContext::current()`).
pub fn unified_log_entry(entry: LogEntry) {
    // 1. log crate (stdout)
    match entry.level {
        LogLevel::Info => log::info!("{}", entry.message),
        LogLevel::Warn => log::warn!("{}", entry.message),
        LogLevel::Error => log::error!("{}", entry.message),
        LogLevel::Debug => log::debug!("{}", entry.message),
    }
    // 2. persist (buffered)
    persist_log(&entry);
    // 3. frontend emit
    if let Some(app) = GLOBAL_APP_HANDLE.get() {
        if let Err(e) = app.emit("log:rust", &entry) {
            log::error!("Failed to emit log to frontend: {}", e);
        }
    }
}

/// Internal helper used by the kv-pair form of `ulog_*!`. Builds an entry
/// with explicit correlation fields and emits it.
#[doc(hidden)]
pub fn ulog_with_correlation(
    level: LogLevel,
    message: String,
    session_id: Option<String>,
    tab_id: Option<String>,
    owner_id: Option<String>,
    request_id: Option<String>,
    turn_id: Option<String>,
    runtime: Option<String>,
) {
    let entry = create_log_entry_with_correlation(
        level, message, session_id, tab_id, owner_id, request_id, turn_id, runtime,
    );
    unified_log_entry(entry);
}

/// Global unified log macros — no AppHandle needed.
///
/// Two forms supported (Pattern 6):
///   ulog_info!("[module] message {}", arg);                                  // legacy
///   ulog_info!("[module] turn done", session_id = sid, turn_id = tid);       // with kv
///
/// The legacy form continues to compile against all 932 existing call sites.
/// The kv form lets new code attach correlation values explicitly. Either
/// way, fields not set on the call site are filled from `LogContext::current()`.
#[macro_export]
macro_rules! ulog_info {
    // kv form: format string + args, separated by `;` from key=value pairs.
    ($fmt:expr, $($arg:expr),* ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Info, format!($fmt, $($arg),*), $($key = $val),+);
    }};
    // kv form without format args: literal string + key=value pairs.
    ($fmt:expr ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Info, ($fmt).to_string(), $($key = $val),+);
    }};
    // Legacy form: plain format!.
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Info, format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! ulog_warn {
    ($fmt:expr, $($arg:expr),* ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Warn, format!($fmt, $($arg),*), $($key = $val),+);
    }};
    ($fmt:expr ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Warn, ($fmt).to_string(), $($key = $val),+);
    }};
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Warn, format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! ulog_error {
    ($fmt:expr, $($arg:expr),* ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Error, format!($fmt, $($arg),*), $($key = $val),+);
    }};
    ($fmt:expr ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Error, ($fmt).to_string(), $($key = $val),+);
    }};
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Error, format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! ulog_debug {
    ($fmt:expr, $($arg:expr),* ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Debug, format!($fmt, $($arg),*), $($key = $val),+);
    }};
    ($fmt:expr ; $($key:ident = $val:expr),+ $(,)?) => {{
        $crate::__ulog_impl!($crate::logger::LogLevel::Debug, ($fmt).to_string(), $($key = $val),+);
    }};
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Debug, format!($($arg)*));
    }};
}

/// Internal helper macro: builds an `Option<String>` from each kv pair and
/// dispatches to `ulog_with_correlation`. Recognised keys are
/// `session_id`, `tab_id`, `owner_id`, `request_id`, `turn_id`, `runtime`.
/// Unrecognised keys cause a compile error (so a typo doesn't silently lose
/// the value).
#[doc(hidden)]
#[macro_export]
macro_rules! __ulog_impl {
    ($level:expr, $msg:expr, $($key:ident = $val:expr),+ $(,)?) => {{
        let mut __session_id: Option<String> = None;
        let mut __tab_id: Option<String> = None;
        let mut __owner_id: Option<String> = None;
        let mut __request_id: Option<String> = None;
        let mut __turn_id: Option<String> = None;
        let mut __runtime: Option<String> = None;
        $(
            $crate::__ulog_assign!($key, $val,
                __session_id, __tab_id, __owner_id, __request_id, __turn_id, __runtime);
        )+
        $crate::logger::ulog_with_correlation(
            $level,
            $msg,
            __session_id,
            __tab_id,
            __owner_id,
            __request_id,
            __turn_id,
            __runtime,
        );
    }};
}

/// Internal helper: dispatch a single kv pair to its target Option<String>.
/// Using a separate macro keeps the per-key match logic out of the main one.
#[doc(hidden)]
#[macro_export]
macro_rules! __ulog_assign {
    (session_id, $val:expr, $sid:ident, $tid:ident, $oid:ident, $rid:ident, $turn:ident, $rt:ident) => {
        $sid = Some(::std::string::ToString::to_string(&$val));
    };
    (tab_id, $val:expr, $sid:ident, $tid:ident, $oid:ident, $rid:ident, $turn:ident, $rt:ident) => {
        $tid = Some(::std::string::ToString::to_string(&$val));
    };
    (owner_id, $val:expr, $sid:ident, $tid:ident, $oid:ident, $rid:ident, $turn:ident, $rt:ident) => {
        $oid = Some(::std::string::ToString::to_string(&$val));
    };
    (request_id, $val:expr, $sid:ident, $tid:ident, $oid:ident, $rid:ident, $turn:ident, $rt:ident) => {
        $rid = Some(::std::string::ToString::to_string(&$val));
    };
    (turn_id, $val:expr, $sid:ident, $tid:ident, $oid:ident, $rid:ident, $turn:ident, $rt:ident) => {
        $turn = Some(::std::string::ToString::to_string(&$val));
    };
    (runtime, $val:expr, $sid:ident, $tid:ident, $oid:ident, $rid:ident, $turn:ident, $rt:ident) => {
        $rt = Some(::std::string::ToString::to_string(&$val));
    };
}

#[cfg(test)]
mod renderer_boot_tests {
    use super::{format_renderer_boot_event, should_persist_logs, LogLevel};

    #[test]
    fn unit_tests_never_persist_into_the_users_unified_log() {
        assert!(!should_persist_logs());
    }

    #[test]
    fn renderer_boot_ingress_is_stage_limited_and_single_line() {
        let (level, message) = format_renderer_boot_event(
            "renderer-uncaught-error",
            "main",
            Some("Error: boom\nstack line"),
        )
        .expect("known boot event");
        assert_eq!(level, LogLevel::Error);
        assert_eq!(
            message,
            "[boot] stage=renderer-uncaught-error window=main detail=Error: boom stack line"
        );
        assert!(format_renderer_boot_event("arbitrary-log", "main", None).is_err());
        assert!(format_renderer_boot_event("react-commit", "bad label", None).is_err());
    }
}
