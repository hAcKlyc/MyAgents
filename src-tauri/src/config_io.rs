//! Shared `~/.myagents/config.json` read-modify-write helper.
//!
//! The renderer, Node sidecar, and Rust commands coordinate on the same
//! `config.json.lock` directory. Directory creation is atomic across processes
//! on supported app filesystems and is available from all three runtimes without
//! adding a platform-specific dependency.
//!
//! Pattern 5 (Single-Writer Invariant) — lock acquisition + stale-recovery now
//! lives in `crate::utils::file_lock`; this module just composes it.

use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::utils::bom::strip_bom;
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeBootstrapSelection {
    pub appearance_mode: String,
}

impl Default for ThemeBootstrapSelection {
    fn default() -> Self {
        Self {
            appearance_mode: "system".to_owned(),
        }
    }
}

fn normalize_theme_fields(config: &mut serde_json::Value) {
    let Some(object) = config.as_object_mut() else {
        return;
    };

    let current_mode = object
        .get("appearanceMode")
        .and_then(serde_json::Value::as_str)
        .filter(|value| matches!(*value, "system" | "light" | "dark"));
    let legacy_mode = object
        .get("theme")
        .and_then(serde_json::Value::as_str)
        .filter(|value| matches!(*value, "system" | "light" | "dark"));
    let appearance_mode = current_mode.or(legacy_mode).unwrap_or("system").to_owned();

    let stored_theme_id = object
        .get("themeId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let theme_selection_explicit = stored_theme_id.as_ref().is_some_and(|theme_id| {
        object
            .get("themeSelectionExplicit")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(theme_id != "myagents-default")
    });
    let theme_id = if theme_selection_explicit {
        stored_theme_id.unwrap_or_else(|| "myagents-light".to_owned())
    } else {
        "myagents-light".to_owned()
    };

    object.insert(
        "appearanceMode".to_owned(),
        serde_json::Value::String(appearance_mode),
    );
    object.insert("themeId".to_owned(), serde_json::Value::String(theme_id));
    object.insert(
        "themeSelectionExplicit".to_owned(),
        serde_json::Value::Bool(theme_selection_explicit),
    );
    object.remove("theme");
}

pub(crate) fn read_config_json(config_path: &Path) -> Result<serde_json::Value, String> {
    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = fs::read_to_string(config_path)
        .map_err(|e| format!("[config-io] Cannot read config.json: {}", e))?;
    // Tolerate UTF-8 BOM (U+FEFF) prepended by Windows editors — without this
    // a manually-edited config.json would fail to parse with "expected value
    // at line 1 column 1" and the caller would fall back to .bak (issue #170 #6).
    serde_json::from_str(strip_bom(&content))
        .map_err(|e| format!("[config-io] Cannot parse config.json: {}", e))
}

/// Read only the non-sensitive Theme selection needed before the main WebView
/// exists. This follows the same in-memory normalization as every config write,
/// but deliberately does not heal disk on the read boundary.
pub fn read_theme_bootstrap_selection(config_path: &Path) -> ThemeBootstrapSelection {
    let mut config = read_config_json(config_path).unwrap_or_else(|_| serde_json::json!({}));
    normalize_theme_fields(&mut config);
    ThemeBootstrapSelection {
        appearance_mode: config
            .get("appearanceMode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("system")
            .to_owned(),
    }
}

fn write_all_synced(path: &Path, content: &str) -> Result<(), String> {
    // Pattern 5 fix #12: explicitly request 0o600 on Unix so cross-process
    // writers (Node sidecar / Rust commands / renderer) all produce config.json
    // files with the same user-private permissions. Without this, Rust
    // inherited the default umask (often 0o644) while Node enforced 0o600
    // directly — leaving the file readable to other users.
    #[cfg(unix)]
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("[config-io] Cannot open tmp config: {}", e))?;
    #[cfg(not(unix))]
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("[config-io] Cannot open tmp config: {}", e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("[config-io] Cannot write tmp config: {}", e))?;
    file.sync_all()
        .map_err(|e| format!("[config-io] Cannot fsync tmp config: {}", e))?;
    Ok(())
}

/// fsync the directory holding `path` so a fresh tmp+rename is durable across
/// crashes. POSIX-only — Windows' `FlushFileBuffers` on a directory handle is
/// a documented no-op (and would require `FILE_FLAG_BACKUP_SEMANTICS` just to
/// open the handle), so the platform's own NTFS journaling is what we rely on
/// there. Splitting unix/non-unix into two functions instead of cfg-gating the
/// body keeps `path` from being flagged as unused on Windows.
#[cfg(unix)]
fn fsync_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let dir = OpenOptions::new()
            .read(true)
            .open(parent)
            .map_err(|e| format!("[config-io] Cannot open config dir for fsync: {}", e))?;
        dir.sync_all()
            .map_err(|e| format!("[config-io] Cannot fsync config dir: {}", e))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn fsync_parent_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Per-platform OpenOptions for the fsync handler — Windows needs
/// `GENERIC_WRITE` for `FlushFileBuffers`, Unix is fine with read-only
/// (`fsync(2)` accepts a read-only fd).
fn opts_for_fsync() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(windows)]
    opts.write(true);
    opts
}

/// Re-read `config.json` under lock, apply `mutator`, and atomically publish it.
///
/// `keep_backup` preserves existing `.bak` behavior for call sites that already
/// created one before this helper was introduced.
pub fn with_config_lock<F>(
    config_path: &Path,
    keep_backup: bool,
    mutator: F,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[config-io] Cannot create config dir: {}", e))?;
    }

    let lock_path = config_path.with_file_name("config.json.lock");
    let config_path_owned: PathBuf = config_path.to_path_buf();

    // Borrow checker: the mutator + post-write logic capture environment by
    // value via the closure passed to `with_file_lock_blocking`. The error
    // helper converts our String errors into FileLockError::Io.
    fn to_io_err(msg: String) -> FileLockError {
        FileLockError::Io(std::io::Error::other(msg))
    }

    let result = with_file_lock_blocking(
        &lock_path,
        FileLockOptions::default(),
        move || -> Result<serde_json::Value, FileLockError> {
            let mut config = read_config_json(&config_path_owned).map_err(to_io_err)?;
            normalize_theme_fields(&mut config);
            let before = config.clone();
            mutator(&mut config).map_err(to_io_err)?;
            normalize_theme_fields(&mut config);

            if config == before {
                return Ok(config);
            }

            let content = serde_json::to_string_pretty(&config)
                .map_err(|e| to_io_err(format!("[config-io] Cannot serialize config: {}", e)))?;
            let tmp_path = config_path_owned.with_file_name("config.json.tmp.rust");
            let bak_path = config_path_owned.with_file_name("config.json.bak");

            write_all_synced(&tmp_path, &content).map_err(to_io_err)?;

            if keep_backup && config_path_owned.exists() {
                let _ = fs::copy(&config_path_owned, bak_path);
            }

            // Rust ≥1.81 (our MSRV) documents `fs::rename` as atomic
            // replace-on-existing across all platforms; the previous
            // `atomic_replace` shim that called MoveFileExW directly is no
            // longer needed.
            fs::rename(&tmp_path, &config_path_owned)
                .map_err(|e| to_io_err(format!("[config-io] Cannot rename tmp config: {}", e)))?;
            fsync_parent_dir(&config_path_owned).map_err(to_io_err)?;

            Ok(config)
        },
    );

    result.map_err(|e| match e {
        FileLockError::Busy { .. } => e.to_string(),
        FileLockError::Io(io_err) => format!("[config-io] {}", io_err),
    })
}

/// Fsync a file or directory path for renderer-side atomic writes.
///
/// Cross-platform note: `File::sync_all()` calls `fsync(2)` on Unix and
/// `FlushFileBuffers` on Windows. The two have **different access
/// requirements** — `fsync` accepts a read-only fd, but `FlushFileBuffers`
/// requires `GENERIC_WRITE`. Pre-fix this command opened the file via
/// `File::open()` (read-only by default), so on Windows every renderer-side
/// save (project list, launcher last-used, runtime config) failed with
/// `os error 5: 拒绝访问 (Access is denied)`. Open with write access on
/// Windows; keep read-only on Unix where it works and avoids requiring
/// write perms we don't otherwise need.
#[tauri::command]
pub async fn cmd_fsync_path(path: String, directory: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(path);
        if directory {
            #[cfg(unix)]
            {
                let dir = OpenOptions::new()
                    .read(true)
                    .open(&p)
                    .map_err(|e| format!("[config-io] Cannot open dir for fsync: {}", e))?;
                dir.sync_all()
                    .map_err(|e| format!("[config-io] Cannot fsync dir: {}", e))?;
            }
            // Windows has no equivalent to fsync(2) on directories;
            // FlushFileBuffers on a directory handle is a no-op. Skip.
            Ok(())
        } else {
            // Build the OpenOptions per platform: Windows requires write
            // access for FlushFileBuffers; Unix's fsync(2) is happy with
            // read-only. Constructing one OpenOptions and branching on
            // `.write(...)` keeps the import set minimal (no `File`).
            //
            // Windows AV / search-indexer race (review-by-cc H3): a process
            // we can't see — Defender real-time scan, OneDrive syncer,
            // Backblaze indexer — sometimes opens a file we just wrote
            // with `FILE_SHARE_NONE` for a brief window. Our open then
            // returns `ERROR_SHARING_VIOLATION` (os error 32) or
            // `ERROR_ACCESS_DENIED` (5). The contended window is ms-scale,
            // so a small backoff loop transparently rides through it. Unix
            // doesn't have this class of failure (fcntl LOCK_EX would, but
            // we don't take it).
            let open_with_retry = || -> std::io::Result<std::fs::File> {
                #[cfg(windows)]
                {
                    let mut last: Option<std::io::Error> = None;
                    for attempt in 0..4 {
                        match opts_for_fsync().open(&p) {
                            Ok(f) => return Ok(f),
                            Err(e) => {
                                let code = e.raw_os_error().unwrap_or(0);
                                let transient = code == 32 || code == 5;
                                if transient && attempt < 3 {
                                    std::thread::sleep(std::time::Duration::from_millis(
                                        25u64 << attempt, // 25, 50, 100ms
                                    ));
                                    last = Some(e);
                                    continue;
                                }
                                return Err(e);
                            }
                        }
                    }
                    Err(last
                        .unwrap_or_else(|| std::io::Error::other("fsync open: exhausted retries")))
                }
                #[cfg(not(windows))]
                {
                    opts_for_fsync().open(&p)
                }
            };
            let file = open_with_retry()
                .map_err(|e| format!("[config-io] Cannot open file for fsync: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("[config-io] Cannot fsync file: {}", e))
        }
    })
    .await
    .map_err(|e| format!("[config-io] fsync task failed: {}", e))?
}

#[cfg(test)]
mod theme_tests {
    use super::{normalize_theme_fields, read_theme_bootstrap_selection};
    use serde_json::json;
    use std::fs;

    #[test]
    fn migrates_legacy_theme_without_overwriting_other_fields() {
        let mut config = json!({ "theme": "dark", "other": 42 });
        normalize_theme_fields(&mut config);
        assert_eq!(
            config,
            json!({
                "themeId": "myagents-light",
                "themeSelectionExplicit": false,
                "appearanceMode": "dark",
                "other": 42
            })
        );
    }

    #[test]
    fn current_fields_win_and_invalid_values_normalize() {
        let mut current = json!({
            "theme": "dark",
            "themeId": " partner-theme ",
            "appearanceMode": "light"
        });
        normalize_theme_fields(&mut current);
        assert_eq!(current["appearanceMode"], "light");
        assert_eq!(current["themeId"], "partner-theme");
        assert_eq!(current["themeSelectionExplicit"], true);
        assert!(current.get("theme").is_none());

        let mut invalid = json!({ "theme": "sepia", "themeId": "" });
        normalize_theme_fields(&mut invalid);
        assert_eq!(invalid["appearanceMode"], "system");
        assert_eq!(invalid["themeId"], "myagents-light");
        assert_eq!(invalid["themeSelectionExplicit"], false);

        let mut explicit_canonical = json!({
            "themeId": "myagents-default",
            "themeSelectionExplicit": true
        });
        normalize_theme_fields(&mut explicit_canonical);
        assert_eq!(explicit_canonical["themeId"], "myagents-default");
        assert_eq!(explicit_canonical["themeSelectionExplicit"], true);
    }

    #[test]
    fn bootstrap_read_normalizes_without_mutating_disk() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config.json");
        let original = r#"{"theme":"dark","themeId":" partner-theme "}"#;
        fs::write(&path, original).expect("write config");

        let selection = read_theme_bootstrap_selection(&path);

        assert_eq!(selection.appearance_mode, "dark");
        assert_eq!(fs::read_to_string(path).expect("read config"), original);
    }
}
