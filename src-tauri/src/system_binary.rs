//! Centralized system binary discovery for GUI applications.
//!
//! **All** system binary lookups MUST use `system_binary::find()` instead of
//! raw `which::which()`. Tauri apps launched from Finder/launchd don't inherit
//! shell PATH (no `/opt/homebrew/bin`, `/usr/local/bin`, etc.), so bare
//! `which::which("npm")` fails even when npm is installed.
//!
//! This follows the same "pit of success" pattern as [`crate::local_http`]
//! and [`crate::process_cmd`]: the correct behavior is the default — callers
//! don't need to remember platform-specific PATH augmentation.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::system_binary;
//!
//! if let Some(npm) = system_binary::find("npm") {
//!     let mut cmd = process_cmd::new(&npm);
//!     cmd.arg("install").arg("some-package");
//! }
//! ```

use std::path::PathBuf;

/// Common binary directories that may be missing from the GUI process PATH.
/// macOS: Finder launch inherits only `/usr/bin:/bin:/usr/sbin:/sbin`.
/// These entries are appended (not prepended) to preserve existing PATH priority.
#[cfg(not(target_os = "windows"))]
const EXTRA_SEARCH_DIRS: &[&str] = &[
    "/opt/homebrew/bin", // macOS Apple Silicon homebrew
    "/opt/homebrew/sbin",
    "/usr/local/bin", // macOS Intel homebrew / Linux manual installs
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
];

/// User-relative directories that require $HOME expansion at runtime.
/// e.g., `~/.local/bin` is where `claude` (Claude Code CLI) is installed globally.
#[cfg(not(target_os = "windows"))]
const USER_RELATIVE_DIRS: &[&str] = &[
    ".local/bin", // Claude Code CLI global install (`claude`)
    ".bun/bin",   // Bun global installs
];

/// Find a system binary by name, searching both the process PATH and common
/// system directories that GUI apps may miss.
///
/// Returns the full path to the binary, or `None` if not found anywhere.
pub fn find(binary_name: &str) -> Option<PathBuf> {
    // Preserve user shell selection before common discovery fallbacks.
    let search_path = augmented_path();

    which::which_in(binary_name, Some(&search_path), ".").ok()
}

/// Build an augmented PATH string that includes common system binary directories.
/// Useful when spawning subprocesses that need the full search path.
pub fn augmented_path() -> std::ffi::OsString {
    let system_path = std::env::var("PATH").unwrap_or_default();
    // mut needed on non-Windows (EXTRA_SEARCH_DIRS / USER_RELATIVE_DIRS push below)
    #[allow(unused_mut)]
    let mut parts: Vec<String> = Vec::new();

    append_app_local_runtime_dirs(&mut parts);

    #[cfg(not(target_os = "windows"))]
    {
        // Static system directories
        for dir in EXTRA_SEARCH_DIRS {
            push_path_part(&mut parts, PathBuf::from(*dir));
        }

        // User-relative directories (expand $HOME)
        if let Some(home) = dirs::home_dir() {
            push_path_part(
                &mut parts,
                home.join(crate::app_dirs::APP_DATA_DIR_NAME)
                    .join("npm-global")
                    .join("bin"),
            );
            push_path_part(
                &mut parts,
                home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("bin"),
            );
            for rel in USER_RELATIVE_DIRS {
                push_path_part(&mut parts, home.join(rel));
            }
        }
    }

    #[cfg(target_os = "windows")]
    append_windows_runtime_dirs(&mut parts);

    #[cfg(not(target_os = "windows"))]
    let shell_path = detect_shell_path();
    #[cfg(target_os = "windows")]
    let shell_path: Option<String> = None;
    std::env::join_paths(merge_search_paths(
        &system_path,
        shell_path.as_deref(),
        &parts,
        cfg!(windows),
    ))
    .unwrap_or_default()
}

/// Same precedence as Node shell.ts; shared fixtures keep the two entry points
/// aligned without adding another process or environment-discovery protocol.
fn merge_search_paths(
    inherited_path: &str,
    shell_path: Option<&str>,
    fallback_paths: &[String],
    windows: bool,
) -> Vec<String> {
    let separator = if windows { ';' } else { ':' };
    let mut parts: Vec<String> = Vec::new();
    for dir in shell_path
        .unwrap_or_default()
        .split(separator)
        .chain(inherited_path.split(separator))
        .chain(fallback_paths.iter().map(String::as_str))
    {
        if dir.is_empty() {
            continue;
        }
        let exists = parts.iter().any(|p| {
            if windows {
                p.eq_ignore_ascii_case(dir)
            } else {
                p == dir
            }
        });
        if !exists {
            parts.push(dir.to_string());
        }
    }
    parts
}

fn normalize_external_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn push_path_string(parts: &mut Vec<String>, value: String) {
    if value.is_empty() {
        return;
    }
    #[cfg(target_os = "windows")]
    let exists = parts.iter().any(|p| p.eq_ignore_ascii_case(&value));
    #[cfg(not(target_os = "windows"))]
    let exists = parts.iter().any(|p| p == &value);
    if !exists {
        parts.push(value);
    }
}

fn push_path_part(parts: &mut Vec<String>, path: PathBuf) {
    let normalized = normalize_external_path(path);
    push_path_string(parts, normalized.to_string_lossy().to_string());
}

fn append_app_local_runtime_dirs(parts: &mut Vec<String>) {
    let Ok(exe_path) = std::env::current_exe() else {
        return;
    };
    let Some(exe_dir) = exe_path.parent() else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        if let Some(contents_dir) = exe_dir.parent() {
            push_path_part(
                parts,
                contents_dir.join("Resources").join("nodejs").join("bin"),
            );
        }
        push_path_part(parts, exe_dir.join("nodejs").join("bin"));
    }

    #[cfg(target_os = "windows")]
    {
        push_path_part(parts, exe_dir.join("resources").join("nodejs"));
        push_path_part(parts, exe_dir.join("nodejs"));
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        push_path_part(parts, exe_dir.join("resources").join("nodejs").join("bin"));
        push_path_part(parts, exe_dir.join("nodejs").join("bin"));
    }
}

#[cfg(target_os = "windows")]
fn push_env_dir(parts: &mut Vec<String>, key: &str, rel: &[&str]) {
    if let Some(value) = std::env::var_os(key) {
        let mut path = PathBuf::from(value);
        for segment in rel {
            path.push(segment);
        }
        push_path_part(parts, path);
    }
}

#[cfg(target_os = "windows")]
fn append_windows_runtime_dirs(parts: &mut Vec<String>) {
    if let Some(home) = dirs::home_dir() {
        push_path_part(
            parts,
            home.join(crate::app_dirs::APP_DATA_DIR_NAME)
                .join("npm-global"),
        );
        push_path_part(
            parts,
            home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("bin"),
        );
        push_path_part(parts, home.join(".bun").join("bin"));
        push_path_part(parts, home.join("AppData").join("Roaming").join("npm"));
    }

    push_env_dir(parts, "LOCALAPPDATA", &["MyAgents", "nodejs"]);
    push_env_dir(parts, "LOCALAPPDATA", &["Volta", "bin"]);
    push_env_dir(parts, "LOCALAPPDATA", &["bun", "bin"]);
    push_env_dir(parts, "LOCALAPPDATA", &["Programs", "Git", "cmd"]);
    push_env_dir(parts, "APPDATA", &["npm"]);
    push_env_dir(parts, "PROGRAMFILES", &["nodejs"]);
    push_env_dir(parts, "PROGRAMFILES", &["Git", "cmd"]);
    push_env_dir(parts, "PROGRAMFILES(X86)", &["nodejs"]);
    push_env_dir(parts, "PROGRAMFILES(X86)", &["Git", "cmd"]);

    if let Some(nvm_symlink) = std::env::var_os("NVM_SYMLINK") {
        push_path_part(parts, PathBuf::from(nvm_symlink));
    }
    if let Some(fnm_path) = std::env::var_os("FNM_MULTISHELL_PATH") {
        push_path_part(parts, PathBuf::from(fnm_path));
    }
}

/// Detect the user's full shell PATH by spawning an interactive login shell.
///
/// GUI apps (Tauri/Finder) inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).
/// Tools installed via NVM, fnm, app bundles (e.g., `/Applications/Codex.app/...`),
/// or custom PATH entries in .zshrc are invisible to the hardcoded directory list.
///
/// This mirrors the TypeScript `getShellPath()` in `src/server/utils/shell.ts`:
/// spawns `$SHELL -i -l -c 'echo $PATH'` with marker extraction to handle
/// noisy .zshrc output (p10k, oh-my-zsh banners, conda, etc.).
///
/// Cached via `OnceLock` — only spawns once per process lifetime.
#[cfg(not(target_os = "windows"))]
fn detect_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHED: OnceLock<Option<String>> = OnceLock::new();

    CACHED
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let marker = format!("__MYAGENTS_PATH_{}__", std::process::id());
            // NOTE: ${PATH} (braced) is required — unbraced $PATH__MARKER__ would be
            // parsed as a single variable name because underscores are valid identifiers.
            let script = format!("echo \"{marker}${{PATH}}{marker}\"");

            // Spawn with timeout to guard against .zshrc that launches tmux/screen.
            let mut child = match crate::process_cmd::new(&shell)
                .args(["-i", "-l", "-c", &script])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => return None,
            };

            // Same five-second discovery budget as Node shell.ts.
            let output = {
                use std::time::{Duration, Instant};
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break child.wait_with_output(),
                        Ok(None) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            return None;
                        }
                    }
                }
            };

            match output {
                Ok(out) if out.status.success() => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    // Extract PATH from between markers (immune to noisy shell output)
                    let start_tag = &marker;
                    let end_tag = &marker;
                    if let Some(start) = stdout.find(start_tag) {
                        let after_start = start + start_tag.len();
                        if let Some(end) = stdout[after_start..].find(end_tag) {
                            let path = &stdout[after_start..after_start + end];
                            if path.len() > 10 {
                                return Some(path.to_string());
                            }
                        }
                    }
                    None
                }
                _ => None,
            }
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::merge_search_paths;

    #[test]
    fn user_path_precedence_matches_sidecar() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/shared/fixtures/runtime-search-path.json"
        ))
        .unwrap();
        for case in fixtures.as_array().unwrap() {
            let windows = case["platform"] == "win32";
            let fallbacks: Vec<String> = case["fallbackPaths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            let paths = merge_search_paths(
                case["inheritedPath"].as_str().unwrap(),
                case["shellPath"].as_str(),
                &fallbacks,
                windows,
            );
            assert_eq!(
                paths.join(if windows { ";" } else { ":" }),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
