//! Workspace path resolution and traversal protection.
//!
//! All workspace file commands take an absolute `workspace_path` (the directory
//! the user is currently working inside) and a `relative` path or `target_dir`
//! the operation should affect. This module is the single chokepoint that turns
//! that pair into a validated absolute path that:
//!
//! 1. Resolves `..` and `.` components (no traversal escape).
//! 2. Stays inside `workspace_path` (no escape via symlink-aware canonicalization
//!    where the file already exists; for new paths we walk component-by-component).
//! 3. Passes the same system / credential directory blacklist used everywhere
//!    else in the app — see `commands::validate_file_path`.
//!
//! Centralizing these rules means a future "ah, also block X" only happens once.
//! Callers MUST go through `resolve_inside_workspace`; bypassing it is a bug.
//!
//! Symlink note (Phase D + Phase D.5):
//! - **Lexical resolve** (`resolve_inside_workspace`): for write-side commands
//!   (`new_file`, `new_folder`, `rename`, `move`, gitignore append, etc.) the
//!   target may not exist yet, so we resolve `..`/`.` lexically and check
//!   `starts_with(workspace_root)`. A symlink inside the workspace pointing
//!   outside is reachable — consistent with the prior sidecar behavior and
//!   with what users expect when they put a symlink in their own project.
//! - **Canonical resolve** (`resolve_existing_inside_workspace`): for read-side
//!   commands (`read_preview`, `download_file`) we canonicalize the resolved
//!   path AND the workspace root, then re-check `starts_with`. This blocks
//!   the "malicious repo with `evil_link → /etc/passwd`" attack: cloning a
//!   repo means the workspace root is trusted, but individual symlinks
//!   inside it are not. Read-only commands have no legitimate need to follow
//!   them outside.
//!
//! The same canonicalize trick can't apply to write-side commands because
//! `fs::canonicalize` fails on paths that don't exist yet.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use crate::commands::validate_file_path as system_blacklist_check;

/// Errors are stringly-typed because Tauri commands serialize errors as strings
/// to the frontend; matching the existing error style avoids a translation layer.
pub type WfResult<T> = Result<T, String>;

/// Validate the workspace root itself: must be absolute, must not target a
/// blacklisted system / credential directory, must currently exist.
///
/// We require existence here (unlike validate_file_path which is read-only) so
/// that an invalid workspace_path can never silently create files in `/`.
pub fn validate_workspace_root(workspace_path: &str) -> WfResult<PathBuf> {
    let resolved = system_blacklist_check(workspace_path)?;
    if !resolved.is_dir() {
        return Err(format!(
            "Workspace path is not a directory or does not exist: {}",
            workspace_path
        ));
    }
    let canonical = fs::canonicalize(&resolved)
        .map_err(|e| format!("Workspace root canonicalize failed: {}", e))?;
    let canonical = crate::commands::normalize_security_path(canonical);
    let canonical_str = canonical
        .to_str()
        .ok_or_else(|| "Workspace path is not valid UTF-8".to_string())?;
    system_blacklist_check(canonical_str)?;
    Ok(canonical)
}

/// Resolve a `relative` path inside `workspace_root`. The relative segment may
/// also be empty / "." — in which case the workspace root itself is returned.
///
/// Rules:
/// - `relative` MUST be relative (no leading `/` or drive letter).
/// - `..` is allowed inside the segment but cannot escape `workspace_root`.
/// - Resulting path is checked against the system blacklist as a final guard
///   (defense-in-depth in case the workspace itself sits next to a blacklisted
///   dir and the relative includes `../...`).
pub fn resolve_inside_workspace(workspace_root: &Path, relative: &str) -> WfResult<PathBuf> {
    if Path::new(relative).is_absolute() {
        return Err("Path must be relative to workspace root".to_string());
    }

    let mut resolved = workspace_root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::ParentDir => {
                if resolved == *workspace_root {
                    return Err("Path escapes workspace root".to_string());
                }
                resolved.pop();
            }
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            Component::Prefix(_) | Component::RootDir => {
                return Err("Absolute / drive-letter components not allowed".to_string());
            }
        }
    }

    if !resolved.starts_with(workspace_root) {
        return Err("Path escapes workspace root".to_string());
    }

    // Final blacklist check — covers the case where the workspace itself is
    // adjacent to a sensitive dir and a malicious `relative` walked into it.
    if let Some(s) = resolved.to_str() {
        let _ = system_blacklist_check(s)?;
    }

    Ok(resolved)
}

/// Validate that an arbitrary absolute path (e.g. a file the user dragged from
/// Finder) is safe to read from. Used by `read_files_b64` and `copy_paths`.
///
/// Cross-review 0.2.33 (Codex Critical): the lexical blacklist alone is
/// defeated by an intermediate symlink component — `~/Downloads/lure/key`
/// where `lure → ~/.ssh` doesn't start with any blacklisted prefix, but the
/// read that follows traverses the link and exfiltrates credential bytes into
/// the AI-readable workspace. Canonicalize and re-run the blacklist on the
/// REAL path. This mirrors the fix `copy_internal_one` already got (5b72e25a);
/// before this, the two sibling copy commands had divergent trust models.
///
/// Returns the LEXICAL path (not the canonical one) so callers keep their
/// leaf-symlink semantics: `files_b64` rejects symlink leaves outright (its
/// extension allow-list checks the *name*, not the target) and `copy_paths`
/// reports them as unsupported — returning the canonical path would silently
/// resolve the leaf and re-open that hole.
///
/// A path that does NOT exist passes on the lexical check alone: the
/// symlink-escape defense is only meaningful for paths that resolve (a
/// non-existent path can't be read; `transfer`/`files_b64` stat it right
/// after and fail their own way), and `slash.rs` depends on validating a
/// brand-new workspace root that hasn't been created yet — failing here
/// would break the launcher's slash-command scan for new workspaces.
pub fn validate_external_read_path(absolute_path: &str) -> WfResult<PathBuf> {
    let lexical = system_blacklist_check(absolute_path)?;
    if let Ok(canonical) = fs::canonicalize(&lexical) {
        if let Some(s) = canonical.to_str() {
            let _ = system_blacklist_check(s)?;
        }
    }
    Ok(lexical)
}

/// Stricter variant of `resolve_inside_workspace` for **read-side** commands:
/// resolves any symlinks via `fs::canonicalize` and verifies the canonical
/// path is still inside the canonical workspace root — OR inside a trusted
/// MyAgents-managed directory (see `is_trusted_managed_target`). Blocks the
/// "malicious `evil_link → /etc/passwd` checked into a repo" attack from
/// leaking content out of the workspace, while still allowing the
/// junctions / symlinks MyAgents projects from `~/.myagents/skills` etc.
/// into `<workspace>/.claude/skills/` (see Node `syncProjectUserConfigFiles`).
///
/// Behavior:
/// - If the resolved path doesn't exist, returns `Err("File not found")` (the
///   read command was going to error anyway — surfacing the same error here
///   makes the failure mode uniform regardless of whether the path is missing
///   or rejected for being a symlink escape).
/// - If the path exists but resolves outside the workspace via symlink AND
///   isn't under a trusted MyAgents-managed root, returns
///   `Err("Path escapes workspace root via symlink")`.
/// - If the workspace root itself isn't canonicalizable (rare — race with
///   directory deletion), returns `Err("Workspace root canonicalize failed")`
///   rather than silently downgrading to lexical-only.
///
/// **Do not** use for write/create commands — `fs::canonicalize` fails on
/// paths that don't exist, so `new_file`/`new_folder` etc. must use the
/// lexical helper.
pub fn resolve_existing_inside_workspace(
    workspace_root: &Path,
    relative: &str,
) -> WfResult<PathBuf> {
    // Lexical pre-check first — same `..`/absolute/blacklist rules.
    let lexical = resolve_inside_workspace(workspace_root, relative)?;

    // Canonicalize the workspace root once. If this fails the workspace was
    // moved/deleted under us — fail closed rather than fall through.
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|_| "Workspace root canonicalize failed".to_string())?;

    // Canonicalize the candidate. Failure means the path doesn't exist (or is
    // unreadable for permission reasons) — the caller would surface an error
    // either way, so collapse this branch into a uniform "not found".
    let canonical = fs::canonicalize(&lexical).map_err(|_| "File not found".to_string())?;

    if !canonical.starts_with(&canonical_root)
        && !is_trusted_managed_target(&canonical, &trusted_managed_roots())
    {
        return Err("Path escapes workspace root via symlink".to_string());
    }

    Ok(canonical)
}

/// Canonicalized roots of MyAgents-managed directories that we sync into
/// workspaces via junctions/symlinks. Targets under any of these roots are
/// safe to follow from in-workspace links because MyAgents owns the source —
/// users can edit them through the Settings UI but they're not attacker-
/// controlled like an arbitrary file in a cloned repo.
///
/// Non-existent subdirs are skipped (some users won't have `agents/` etc.
/// yet). Result is recomputed each call rather than cached so newly-created
/// dirs become trusted without a sidecar restart; the work is three
/// `fs::canonicalize` calls, dwarfed by the file read that follows.
fn trusted_managed_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let myagents = home.join(crate::app_dirs::APP_DATA_DIR_NAME);
    ["skills", "commands", "agents"]
        .iter()
        .filter_map(|sub| fs::canonicalize(myagents.join(sub)).ok())
        .collect()
}

/// Returns `true` iff `canonical` is inside one of the trusted roots. Pure
/// function so tests can inject their own root set via [`trusted_managed_roots`]
/// or a literal `Vec<PathBuf>`.
fn is_trusted_managed_target(canonical: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| canonical.starts_with(root))
}

const MANAGED_GLOBAL_SKILL_READ_ONLY: &str =
    "MANAGED_GLOBAL_SKILL_READ_ONLY: workspace Skill projections are read-only; edit the global Skill from Settings";

/// Reject mutations whose target is a MyAgents-managed projection of
/// `~/.myagents/skills`. Reads deliberately keep using the broader trusted
/// resolver above; this guard is mutation-only so copy-out and previews remain
/// available while workspace writes cannot flow through a junction into the
/// single global source of truth.
///
/// The component walk matters for create destinations: the leaf may not exist,
/// but its closest existing ancestor can itself be a managed junction. We also
/// inspect the link payload lexically so a broken junction/symlink targeting a
/// currently missing global Skill remains protected.
pub fn reject_managed_global_skill_mutation(
    workspace_root: &Path,
    lexical_target: &Path,
) -> WfResult<()> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    reject_managed_global_skill_mutation_with_root(
        workspace_root,
        lexical_target,
        &home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("skills"),
    )
}

fn reject_managed_global_skill_mutation_with_root(
    workspace_root: &Path,
    lexical_target: &Path,
    global_skills_root: &Path,
) -> WfResult<()> {
    let canonical_global_root = fs::canonicalize(global_skills_root).ok();
    if path_is_inside_managed_skill_root(
        lexical_target,
        global_skills_root,
        canonical_global_root.as_deref(),
    ) {
        return Err(MANAGED_GLOBAL_SKILL_READ_ONLY.to_string());
    }

    let Ok(relative) = lexical_target.strip_prefix(workspace_root) else {
        return Ok(());
    };
    let mut current = workspace_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        current.push(part);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => break,
        };

        if metadata_is_link_like(&metadata) {
            if let Ok(link_target) = fs::read_link(&current) {
                let resolved_target = if link_target.is_absolute() {
                    link_target
                } else {
                    current.parent().unwrap_or(workspace_root).join(link_target)
                };
                if path_is_inside_managed_skill_root(
                    &resolved_target,
                    global_skills_root,
                    canonical_global_root.as_deref(),
                ) {
                    return Err(MANAGED_GLOBAL_SKILL_READ_ONLY.to_string());
                }
            }
        }

        if let Ok(canonical_current) = fs::canonicalize(&current) {
            if path_is_inside_managed_skill_root(
                &canonical_current,
                global_skills_root,
                canonical_global_root.as_deref(),
            ) {
                return Err(MANAGED_GLOBAL_SKILL_READ_ONLY.to_string());
            }
        }
    }
    Ok(())
}

fn path_is_inside_managed_skill_root(
    candidate: &Path,
    lexical_root: &Path,
    canonical_root: Option<&Path>,
) -> bool {
    let candidate = crate::commands::normalize_lexical_security_path(candidate.to_path_buf());
    let lexical_root = crate::commands::normalize_lexical_security_path(lexical_root.to_path_buf());
    if crate::commands::path_starts_with_identity(&candidate, &lexical_root) {
        return true;
    }
    let Some(canonical_root) = canonical_root else {
        return false;
    };
    fs::canonicalize(&candidate)
        .map(crate::commands::normalize_security_path)
        .map(|canonical| {
            crate::commands::path_starts_with_identity(
                &canonical,
                &crate::commands::normalize_security_path(canonical_root.to_path_buf()),
            )
        })
        .unwrap_or(false)
}

pub(crate) fn metadata_is_link_like(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

/// Reject filenames that would break on Windows or hide the file (`.`, `..`,
/// names beginning with whitespace, names containing path separators, NTFS
/// reserved names, and the Windows reserved character set).
///
/// This is the Rust equivalent of the sidecar's `isValidItemName`.
pub fn validate_item_name(name: &str) -> WfResult<()> {
    if name.is_empty() || name.trim().is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name != name.trim() {
        return Err("Name cannot start or end with whitespace".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Name cannot contain path separators or '..'".to_string());
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err("Name contains invalid characters".to_string());
    }
    if name.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
        return Err("Name contains control characters".to_string());
    }
    if name.chars().all(|c| c == '.') {
        return Err("Name cannot be only dots".to_string());
    }
    if is_windows_reserved_name(name) {
        return Err(format!("'{}' is a reserved Windows filename", name));
    }
    Ok(())
}

fn is_windows_reserved_name(name: &str) -> bool {
    // Windows silently strips trailing dots and spaces from filenames during
    // normalization, so `CON.`, `CON `, `CON. ` all resolve to the device
    // `CON`. Strip them before comparing the stem. (NUL bytes / control chars
    // in the stem are caught earlier by `validate_item_name`.)
    let stem_raw = name.split_once('.').map(|(s, _)| s).unwrap_or(name);
    let stem = stem_raw
        .trim_end_matches(|c: char| c == ' ' || c == '.')
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Atomically write `bytes` to `target`. Writes a same-directory temp file
/// first, then `fs::rename`s it onto the target — `rename` is atomic on
/// POSIX (and Windows handles the dir-local case correctly). The temp name
/// is unique per process via a monotonic counter; `pid + counter` is enough
/// for the only realistic concurrency (one save modal per tab; AI CLAUDE.md
/// edits are sequential).
///
/// The target's parent must already exist (callers are responsible for
/// `create_dir_all` if their UX needs implicit-dir-create — `save_file.rs`
/// requires the file to exist anyway, so its parent does too).
pub fn atomic_write_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_file_inner(target, bytes, None)
}

/// Atomically write `bytes` only if the current target bytes still match
/// `expected_current`. The comparison runs after the tmp file is written and
/// immediately before the final rename, keeping stale autosaves from committing
/// over a newer external edit in the normal UI/AI interleaving.
pub fn atomic_write_file_if_current(
    target: &Path,
    bytes: &[u8],
    expected_current: &[u8],
) -> Result<(), String> {
    atomic_write_file_inner(target, bytes, Some(expected_current))
}

fn atomic_write_file_inner(
    target: &Path,
    bytes: &[u8],
    expected_current: Option<&[u8]>,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Cannot determine filename".to_string())?
        .to_string_lossy()
        .to_string();

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".{}.myagents-{}-{}.tmp", file_name, std::process::id(), n);
    let tmp_path = parent.join(&tmp_name);

    {
        let mut tmp_file =
            fs::File::create(&tmp_path).map_err(|e| format!("Failed to create tmp file: {}", e))?;
        tmp_file
            .write_all(bytes)
            .map_err(|e| format!("Failed to write tmp file: {}", e))?;
        // Drop the file handle before rename — Windows requires this.
    }

    if let Some(expected) = expected_current {
        let current = match read_prefix(target, expected.len().saturating_add(1)) {
            Ok(current) => current,
            Err(err) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(err);
            }
        };
        if current != expected {
            let _ = fs::remove_file(&tmp_path);
            return Err("File changed externally".to_string());
        }
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        // Best-effort cleanup so a failed rename doesn't leak a tmp file.
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to commit write: {}", e));
    }
    Ok(())
}

fn read_prefix(target: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(target).map_err(|_| "File not found".to_string())?;
    let mut current = Vec::with_capacity(max_bytes.min(64 * 1024));
    file.take(max_bytes as u64)
        .read_to_end(&mut current)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(current)
}

/// Open one explicit regular file without following a symlink/reparse-point
/// leaf. Workspace-contained reads need the stronger relative parent walk in
/// `read_workspace_file_no_follow`; this helper is the shared leaf primitive
/// for user-selected local files such as avatars and Skill packages.
pub fn open_regular_file_no_follow(path: &Path, label: &str) -> WfResult<fs::File> {
    let file = open_regular_file_no_follow_platform(path, label)?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened {}: {}", label, e))?;
    if !metadata.is_file() {
        return Err(format!("{} path must be a regular file", label));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_regular_file_no_follow_platform(path: &Path, label: &str) -> WfResult<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options
        .open(path)
        .map_err(|e| format!("Failed to open {}: {}", label, e))
}

#[cfg(windows)]
fn open_regular_file_no_follow_platform(path: &Path, label: &str) -> WfResult<fs::File> {
    open_windows_regular_file_handle(path, label)
}

#[cfg(all(not(unix), not(windows)))]
fn open_regular_file_no_follow_platform(path: &Path, label: &str) -> WfResult<fs::File> {
    fs::File::open(path).map_err(|e| format!("Failed to open {}: {}", label, e))
}

/// Read a regular file beneath `workspace_root` without following any path
/// component while it is opened. The returned bytes are bounded during the
/// read, so a file that grows after inspection cannot exhaust memory or cross
/// the caller's upload limit.
pub fn read_workspace_file_no_follow(
    workspace_root: &Path,
    requested: &str,
    max_bytes: u64,
) -> WfResult<(PathBuf, Vec<u8>)> {
    let (canonical, mut file) =
        open_workspace_regular_file_no_follow(workspace_root, requested, "attachment")?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened attachment: {}", e))?;
    if metadata.len() > max_bytes {
        return Err(format!("Attachment exceeds {} bytes", max_bytes));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    (&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read attachment: {}", e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Attachment exceeds {} bytes", max_bytes));
    }
    Ok((canonical, bytes))
}

/// Open a regular file beneath the exact Workspace root without following a
/// symlink/reparse-point leaf or any component during the final open. Callers
/// that need to stream large inputs can retain the returned handle rather than
/// buffering the file or reopening an attacker-swappable path.
pub fn open_workspace_regular_file_no_follow(
    workspace_root: &Path,
    requested: &str,
    label: &str,
) -> WfResult<(PathBuf, fs::File)> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let lexical = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        resolve_inside_workspace(&canonical_root, requested)?
    };
    let lexical_metadata =
        fs::symlink_metadata(&lexical).map_err(|e| format!("Attachment not found: {}", e))?;
    if lexical_metadata.file_type().is_symlink() {
        return Err("Attachment path must not be a symlink".to_string());
    }
    if !lexical_metadata.is_file() {
        return Err("Attachment path must be a regular file".to_string());
    }
    let canonical =
        fs::canonicalize(&lexical).map_err(|e| format!("Attachment not found: {}", e))?;
    let relative = canonical
        .strip_prefix(&canonical_root)
        .map_err(|_| "Attachment path escapes the current workspace".to_string())?;
    if relative.as_os_str().is_empty() {
        return Err("Attachment path must be a regular file".to_string());
    }

    #[cfg(unix)]
    let file = open_relative_file_no_follow(&canonical_root, relative, false)?;
    #[cfg(windows)]
    let (file, opened_parent) = open_windows_workspace_file_no_follow(&canonical_root, relative)?;
    #[cfg(all(not(unix), not(windows)))]
    let file = {
        let metadata = fs::symlink_metadata(&canonical)
            .map_err(|e| format!("Failed to inspect attachment: {}", e))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Attachment path must be a regular, non-symlink file".to_string());
        }
        fs::File::open(&canonical).map_err(|e| format!("Failed to open attachment: {}", e))?
    };
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened {}: {}", label, e))?;
    if !metadata.is_file() {
        return Err(format!("{} path must be a regular file", label));
    }
    #[cfg(windows)]
    verify_windows_workspace_parent(
        &canonical_root,
        relative.parent().unwrap_or_else(|| Path::new("")),
        &opened_parent,
    )?;
    Ok((canonical, file))
}

/// Create/open a directory beneath the Workspace one component at a time,
/// rejecting symlink/reparse-point ancestors. The retained directory handle
/// lets long-running owners bind later publication to the exact directory
/// admitted here.
pub fn ensure_workspace_directory_no_follow(
    workspace_root: &Path,
    requested: &str,
) -> WfResult<(PathBuf, fs::File)> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let lexical = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        resolve_inside_workspace(&canonical_root, requested)?
    };
    let relative = lexical
        .strip_prefix(&canonical_root)
        .map_err(|_| "Output path escapes the current workspace".to_string())?;

    #[cfg(unix)]
    let directory = open_relative_directory_no_follow_unix(&canonical_root, relative, true)?;
    #[cfg(windows)]
    let directory = resolve_windows_workspace_parent(&canonical_root, relative, true)?;
    #[cfg(all(not(unix), not(windows)))]
    let directory = {
        let canonical = resolve_portable_destination_parent(&canonical_root, relative)?;
        fs::File::open(&canonical).map_err(|e| format!("Failed to open output directory: {}", e))?
    };

    let canonical = fs::canonicalize(&lexical)
        .map_err(|e| format!("Failed to resolve output directory: {}", e))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Output path escapes the current workspace".to_string());
    }
    Ok((canonical, directory))
}

#[cfg(unix)]
fn open_relative_directory_no_follow_unix(
    root: &Path,
    relative: &Path,
    create: bool,
) -> WfResult<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut root_options = fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut current = root_options
        .open(root)
        .map_err(|e| format!("Failed to open workspace root: {}", e))?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe output path component".to_string());
        };
        let name = component_cstring(name)?;
        let mut fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0
            && create
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
        {
            let created = unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o755) };
            if created < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(format!(
                    "Failed to create output directory: {}",
                    std::io::Error::last_os_error()
                ));
            }
            fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(format!(
                "Output path contains an inaccessible or symlinked directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        current = unsafe { fs::File::from_raw_fd(fd) };
    }
    Ok(current)
}

/// Atomically write bytes beneath `workspace_root`. Parent components are
/// opened/created relative to verified directory handles without following
/// symlinks/reparse points; the temp file is exclusive and the final rename
/// is relative to the same parent handle on both Unix and Windows.
pub fn write_workspace_file_no_follow(
    workspace_root: &Path,
    relative: &str,
    bytes: &[u8],
) -> WfResult<PathBuf> {
    write_workspace_file_no_follow_mode(workspace_root, relative, bytes, true)
}

/// Stable collision result for callers that allocate a unique user filename.
pub const WORKSPACE_FILE_EXISTS: &str = "Workspace destination already exists";

/// Publish a complete new file without replacing an existing directory entry.
/// Uses the same verified directory handles as the replacing writer.
pub fn create_workspace_file_no_follow(
    workspace_root: &Path,
    relative: &str,
    bytes: &[u8],
) -> WfResult<PathBuf> {
    write_workspace_file_no_follow_mode(workspace_root, relative, bytes, false)
}

fn write_workspace_file_no_follow_mode(
    workspace_root: &Path,
    relative: &str,
    bytes: &[u8],
    replace: bool,
) -> WfResult<PathBuf> {
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let target = resolve_inside_workspace(&canonical_root, relative)?;
    let relative_path = target
        .strip_prefix(&canonical_root)
        .map_err(|_| "Path escapes workspace root".to_string())?;
    if relative_path.as_os_str().is_empty() || relative_path.file_name().is_none() {
        return Err("Destination filename is invalid".to_string());
    }

    #[cfg(unix)]
    {
        write_relative_file_no_follow_unix(&canonical_root, relative_path, bytes, replace)?;
    }
    #[cfg(not(unix))]
    {
        write_relative_file_no_follow_portable(&canonical_root, relative_path, bytes, replace)?;
    }
    Ok(target)
}

#[cfg(unix)]
fn component_cstring(component: &std::ffi::OsStr) -> WfResult<CString> {
    CString::new(component.as_bytes()).map_err(|_| "Path contains a NUL byte".to_string())
}

#[cfg(unix)]
fn open_relative_file_no_follow(
    root: &Path,
    relative: &Path,
    create_parents: bool,
) -> WfResult<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut root_options = fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let root_file = root_options
        .open(root)
        .map_err(|e| format!("Failed to open workspace root: {}", e))?;
    let mut opened_dirs = vec![root_file];
    let components = relative.components().collect::<Vec<_>>();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        let Component::Normal(name) = component else {
            return Err("Unsafe workspace path component".to_string());
        };
        let name = component_cstring(name)?;
        let parent_fd = opened_dirs
            .last()
            .expect("workspace root handle exists")
            .as_raw_fd();
        let mut fd = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0
            && create_parents
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
        {
            let created = unsafe { libc::mkdirat(parent_fd, name.as_ptr(), 0o755) };
            if created < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(format!(
                    "Failed to create destination directory: {}",
                    std::io::Error::last_os_error()
                ));
            }
            fd = unsafe {
                libc::openat(
                    parent_fd,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(format!(
                "Workspace path contains an inaccessible or symlinked directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        opened_dirs.push(unsafe { fs::File::from_raw_fd(fd) });
    }
    let Some(Component::Normal(file_name)) = components.last() else {
        return Err("Destination filename is invalid".to_string());
    };
    let file_name = component_cstring(file_name)?;
    let fd = unsafe {
        libc::openat(
            opened_dirs
                .last()
                .expect("workspace parent handle exists")
                .as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "Failed to open attachment: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn write_relative_file_no_follow_unix(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    replace: bool,
) -> WfResult<()> {
    use std::os::unix::fs::OpenOptionsExt;

    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    let mut root_options = fs::OpenOptions::new();
    root_options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let root_file = root_options
        .open(root)
        .map_err(|e| format!("Failed to open workspace root: {}", e))?;
    let mut opened_dirs = vec![root_file];
    for component in parent_relative.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe destination path component".to_string());
        };
        let name = component_cstring(name)?;
        let parent_fd = opened_dirs.last().expect("root handle exists").as_raw_fd();
        let mut fd = unsafe {
            libc::openat(
                parent_fd,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            let created = unsafe { libc::mkdirat(parent_fd, name.as_ptr(), 0o755) };
            if created < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(format!(
                    "Failed to create destination directory: {}",
                    std::io::Error::last_os_error()
                ));
            }
            fd = unsafe {
                libc::openat(
                    parent_fd,
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(format!(
                "Destination path contains a symlink or non-directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        opened_dirs.push(unsafe { fs::File::from_raw_fd(fd) });
    }
    let parent_fd = opened_dirs
        .last()
        .expect("parent handle exists")
        .as_raw_fd();
    verify_opened_workspace_parent(root, parent_relative, parent_fd)?;
    let leaf = component_cstring(relative.file_name().expect("leaf validated"))?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let stat_result = unsafe {
        libc::fstatat(
            parent_fd,
            leaf.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if stat_result == 0 && !replace {
        return Err(WORKSPACE_FILE_EXISTS.to_string());
    }
    if stat_result == 0 && (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err("Destination must not be a symlink or directory".to_string());
    }
    if stat_result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
        return Err(format!(
            "Failed to inspect destination: {}",
            std::io::Error::last_os_error()
        ));
    }

    for nonce in 0..100u32 {
        let temp_name = CString::new(format!(
            ".{}.myagents-{}-{}.tmp",
            relative
                .file_name()
                .expect("leaf validated")
                .to_string_lossy(),
            std::process::id(),
            nonce
        ))
        .map_err(|_| "Invalid destination filename".to_string())?;
        let fd = unsafe {
            libc::openat(
                parent_fd,
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
                continue;
            }
            return Err(format!(
                "Failed to create attachment temp file: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut temp = unsafe { fs::File::from_raw_fd(fd) };
        let write_result = temp.write_all(bytes).and_then(|_| temp.sync_all());
        drop(temp);
        if let Err(error) = write_result {
            unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
            return Err(format!("Failed to write attachment: {}", error));
        }
        if let Err(error) = verify_opened_workspace_parent(root, parent_relative, parent_fd) {
            unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
            return Err(error);
        }
        let renamed = if replace {
            unsafe { libc::renameat(parent_fd, temp_name.as_ptr(), parent_fd, leaf.as_ptr()) }
        } else {
            #[cfg(target_os = "macos")]
            {
                unsafe {
                    libc::renameatx_np(
                        parent_fd,
                        temp_name.as_ptr(),
                        parent_fd,
                        leaf.as_ptr(),
                        libc::RENAME_EXCL,
                    )
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let result = unsafe {
                    libc::linkat(parent_fd, temp_name.as_ptr(), parent_fd, leaf.as_ptr(), 0)
                };
                if result == 0 {
                    unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
                }
                result
            }
        };
        if renamed < 0 {
            let error = std::io::Error::last_os_error();
            unsafe { libc::unlinkat(parent_fd, temp_name.as_ptr(), 0) };
            if !replace && error.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(WORKSPACE_FILE_EXISTS.to_string());
            }
            return Err(format!("Failed to finalize attachment: {}", error));
        }
        return Ok(());
    }
    Err("Failed to allocate attachment temp file".to_string())
}

#[cfg(unix)]
fn verify_opened_workspace_parent(root: &Path, relative: &Path, fd: libc::c_int) -> WfResult<()> {
    use std::os::unix::fs::MetadataExt;

    let current = fs::canonicalize(root.join(relative))
        .map_err(|e| format!("Destination parent changed while writing: {}", e))?;
    if !current.starts_with(root) {
        return Err("Destination parent escaped the workspace while writing".to_string());
    }
    let current_metadata = fs::metadata(&current)
        .map_err(|e| format!("Failed to inspect destination parent: {}", e))?;
    let mut opened: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut opened) } < 0 {
        return Err(format!(
            "Failed to inspect opened destination parent: {}",
            std::io::Error::last_os_error()
        ));
    }
    if current_metadata.dev() != opened.st_dev as u64
        || current_metadata.ino() != opened.st_ino as u64
    {
        return Err("Destination parent changed while writing".to_string());
    }
    Ok(())
}

#[cfg(all(not(unix), not(windows)))]
fn resolve_portable_destination_parent(root: &Path, relative_parent: &Path) -> WfResult<PathBuf> {
    let mut current = root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe workspace path component".to_string());
        };
        let verified_current = fs::canonicalize(&current)
            .map_err(|e| format!("Failed to resolve destination parent: {}", e))?;
        if !verified_current.starts_with(root) {
            return Err("Destination path escapes workspace via junction".to_string());
        }
        let candidate = current.join(name);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(
                        "Destination parent must contain only regular directories".to_string()
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Create one component only after its parent has been verified.
                // `create_dir_all` here would traverse an unchecked junction and
                // could mutate a directory outside the workspace before rejection.
                fs::create_dir(&candidate)
                    .map_err(|e| format!("Failed to create destination directory: {}", e))?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect destination directory: {}",
                    error
                ));
            }
        }
        let canonical_candidate = fs::canonicalize(&candidate)
            .map_err(|e| format!("Failed to resolve destination parent: {}", e))?;
        if !canonical_candidate.starts_with(root) {
            return Err("Destination path escapes workspace via junction".to_string());
        }
        current = candidate;
    }
    fs::canonicalize(&current).map_err(|e| format!("Failed to resolve destination parent: {}", e))
}

#[cfg(all(not(unix), not(windows)))]
fn verify_portable_destination_parent(
    root: &Path,
    lexical_parent: &Path,
    expected: &Path,
) -> WfResult<()> {
    let current = fs::canonicalize(lexical_parent)
        .map_err(|e| format!("Destination parent changed while writing: {}", e))?;
    if !current.starts_with(root) || current != expected {
        return Err(
            "Destination parent changed or escaped the workspace while writing".to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_root_directory(path: &Path) -> WfResult<fs::File> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
        OPEN_EXISTING, SYNCHRONIZE,
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Failed to open workspace root directory: {}",
            std::io::Error::last_os_error()
        ));
    }
    let file = unsafe { fs::File::from_raw_handle(handle as _) };
    validate_windows_directory_handle(&file)?;
    Ok(file)
}

#[cfg(windows)]
fn windows_ntstatus_error(status: windows_sys::Win32::Foundation::NTSTATUS) -> std::io::Error {
    let code = unsafe { windows_sys::Win32::Foundation::RtlNtStatusToDosError(status) };
    std::io::Error::from_raw_os_error(code as i32)
}

#[cfg(windows)]
fn open_windows_relative_handle(
    parent: &fs::File,
    name: &std::ffi::OsStr,
    desired_access: u32,
    share_access: u32,
    create_disposition: u32,
    create_options: u32,
    file_attributes: u32,
) -> std::io::Result<fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::NtCreateFile;
    use windows_sys::Win32::Foundation::{HANDLE, UNICODE_STRING};
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    let mut wide = name.encode_wide().collect::<Vec<_>>();
    let byte_len = wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .filter(|length| *length <= u16::MAX as usize)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Windows path component is too long",
            )
        })?;
    if wide.is_empty() || wide.iter().any(|value| *value == 0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Windows path component is empty or contains NUL",
        ));
    }
    let unicode = UNICODE_STRING {
        Length: byte_len as u16,
        MaximumLength: byte_len as u16,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle() as HANDLE,
        ObjectName: &unicode,
        // OBJ_CASE_INSENSITIVE. Windows file opens are ordinarily
        // case-insensitive; preserving that contract avoids a surprising
        // divergence from CreateFileW while still anchoring resolution to the
        // verified parent handle.
        Attributes: 0x40,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut io_status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let mut handle: HANDLE = std::ptr::null_mut();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &attributes,
            &mut io_status,
            std::ptr::null(),
            file_attributes,
            share_access,
            create_disposition,
            create_options,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(windows_ntstatus_error(status));
    }
    if handle.is_null() {
        return Err(std::io::Error::other(
            "NtCreateFile succeeded without returning a handle",
        ));
    }
    Ok(unsafe { fs::File::from_raw_handle(handle as _) })
}

#[cfg(windows)]
fn validate_windows_handle_component(name: &std::ffi::OsStr) -> WfResult<()> {
    let text = name
        .to_str()
        .ok_or_else(|| "Windows path component is not valid Unicode".to_string())?;
    if text.is_empty() || matches!(text, "." | "..") {
        return Err("Unsafe Windows path component".to_string());
    }
    if text
        .chars()
        .any(|value| matches!(value, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        || text
            .chars()
            .any(|value| (value as u32) < 0x20 || value == '\x7f')
        || text.ends_with('.')
        || text.ends_with(' ')
        || is_windows_reserved_name(text)
    {
        return Err(format!("Unsafe Windows path component: {}", text));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_handle_information(
    file: &fs::File,
) -> WfResult<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(format!(
            "Failed to inspect opened workspace path: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(info)
}

#[cfg(windows)]
fn validate_windows_directory_handle(file: &fs::File) -> WfResult<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    let info = windows_handle_information(file)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(
            "Destination parent must be a regular directory, not a junction or reparse point"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn validate_windows_regular_file_handle(file: &fs::File, label: &str) -> WfResult<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    let info = windows_handle_information(file)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err(format!(
            "{} path must be a regular, non-reparse file",
            label
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_regular_file_handle(path: &Path, label: &str) -> WfResult<fs::File> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Failed to open {}: {}",
            label,
            std::io::Error::last_os_error()
        ));
    }
    let file = unsafe { fs::File::from_raw_handle(handle as _) };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(format!(
            "Failed to inspect opened {}: {}",
            label,
            std::io::Error::last_os_error()
        ));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return Err(format!(
            "{} path must be a regular, non-reparse file",
            label
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn resolve_windows_workspace_parent(
    root: &Path,
    relative_parent: &Path,
    create_missing: bool,
) -> WfResult<fs::File> {
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
        FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, SYNCHRONIZE,
    };

    // RootDirectory makes every lookup relative to the already-open parent
    // file object. A concurrent path rename, delete/recreate, or in-place
    // reparse mutation can change the *name* in the namespace, but cannot
    // redirect the child open to a different directory object.
    let mut current = open_windows_root_directory(root)?;
    for component in relative_parent.components() {
        let Component::Normal(name) = component else {
            return Err("Unsafe workspace path component".to_string());
        };
        validate_windows_handle_component(name)?;
        let open = || {
            open_windows_relative_handle(
                &current,
                name,
                FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN,
                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                FILE_ATTRIBUTE_DIRECTORY,
            )
        };
        let child = match open() {
            Ok(child) => child,
            Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
                match open_windows_relative_handle(
                    &current,
                    name,
                    FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    FILE_CREATE,
                    FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                    FILE_ATTRIBUTE_DIRECTORY,
                ) {
                    Ok(child) => child,
                    // Another writer may have created the same component.
                    // Re-open with FILE_OPEN_REPARSE_POINT so a junction that
                    // won the race is inspected and rejected, never followed.
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open()
                        .map_err(|error| {
                            format!("Failed to open destination directory: {}", error)
                        })?,
                    Err(error) => {
                        return Err(format!("Failed to create destination directory: {}", error));
                    }
                }
            }
            Err(error) => {
                return Err(format!("Failed to open destination directory: {}", error));
            }
        };
        validate_windows_directory_handle(&child)?;
        current = child;
    }
    Ok(current)
}

#[cfg(windows)]
fn windows_handle_identity(file: &fs::File) -> WfResult<(u32, u32, u32)> {
    let info = windows_handle_information(file)?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

#[cfg(windows)]
fn verify_windows_workspace_parent(
    root: &Path,
    relative_parent: &Path,
    opened_parent: &fs::File,
) -> WfResult<()> {
    let current = resolve_windows_workspace_parent(root, relative_parent, false)?;
    if windows_handle_identity(&current)? != windows_handle_identity(opened_parent)? {
        return Err("Destination parent changed while accessing workspace file".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_workspace_file_no_follow(
    root: &Path,
    relative: &Path,
) -> WfResult<(fs::File, fs::File)> {
    open_windows_workspace_file_no_follow_impl(root, relative, || {})
}

#[cfg(windows)]
fn open_windows_workspace_file_no_follow_impl<F: FnOnce()>(
    root: &Path,
    relative: &Path,
    after_parent_opened: F,
) -> WfResult<(fs::File, fs::File)> {
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
    };

    let leaf = relative
        .file_name()
        .ok_or_else(|| "Attachment filename is invalid".to_string())?;
    let relative_parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent = resolve_windows_workspace_parent(root, relative_parent, false)?;
    // Test hook models namespace replacement after the trusted parent file
    // object is open. The leaf open below is relative to `parent`, so it never
    // re-resolves the attacker-controlled path.
    after_parent_opened();
    let file = open_windows_relative_handle(
        &parent,
        leaf,
        FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
    )
    .map_err(|error| format!("Failed to open attachment: {}", error))?;
    validate_windows_regular_file_handle(&file, "attachment")?;
    Ok((file, parent))
}

#[cfg(all(not(unix), not(windows)))]
fn replace_portable_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn delete_windows_file_by_handle(file: &fs::File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };

    let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as _,
            FileDispositionInfo,
            &disposition as *const _ as *const _,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn rename_windows_file_relative(
    file: &fs::File,
    parent: &fs::File,
    target_name: &std::ffi::OsStr,
    replace: bool,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Wdk::Storage::FileSystem::{
        FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    let target_wide = target_name.encode_wide().collect::<Vec<_>>();
    let target_bytes = target_wide
        .len()
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Windows target filename is too long",
            )
        })?;
    let buffer_bytes = std::mem::size_of::<FILE_RENAME_INFORMATION>()
        .checked_add(target_bytes)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Windows rename buffer is too large",
            )
        })?;
    if buffer_bytes > u32::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Windows rename buffer is too large",
        ));
    }

    // FILE_RENAME_INFORMATION ends with a counted WCHAR array. Allocate in
    // machine words so the header cast keeps its required HANDLE alignment.
    // Include the full structure plus name bytes, including its tail padding.
    let word = std::mem::size_of::<usize>();
    let mut storage = vec![0usize; buffer_bytes.div_ceil(word)];
    let info = storage.as_mut_ptr() as *mut FILE_RENAME_INFORMATION;
    unsafe {
        (*info).Anonymous.ReplaceIfExists = u8::from(replace);
        (*info).RootDirectory = parent.as_raw_handle() as _;
        (*info).FileNameLength = target_bytes as u32;
        std::ptr::copy_nonoverlapping(
            target_wide.as_ptr(),
            (*info).FileName.as_mut_ptr(),
            target_wide.len(),
        );
    }
    // Keep publication relative to the verified directory object, just like
    // NtCreateFile above. The Win32 FileRenameInfo wrapper applies DOS path
    // conversion to the name; it cannot preserve this native counted-relative
    // contract reliably (issue #641). Do not fall back to an absolute path:
    // that would re-resolve a parent which may have become a junction.
    let mut io_status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let status = unsafe {
        NtSetInformationFile(
            file.as_raw_handle() as _,
            &mut io_status,
            info as *const _,
            buffer_bytes as u32,
            FileRenameInformation,
        )
    };
    if status < 0 {
        return Err(windows_ntstatus_error(status));
    }
    Ok(())
}

#[cfg(windows)]
fn write_relative_file_no_follow_portable(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    replace: bool,
) -> WfResult<()> {
    write_relative_file_no_follow_windows_mode(root, relative, bytes, || {}, replace)
}

#[cfg(all(windows, test))]
fn write_relative_file_no_follow_windows_impl<F: FnOnce()>(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    after_parent_opened: F,
) -> WfResult<()> {
    write_relative_file_no_follow_windows_mode(root, relative, bytes, after_parent_opened, true)
}

#[cfg(windows)]
fn write_relative_file_no_follow_windows_mode<F: FnOnce()>(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    after_parent_opened: F,
    replace: bool,
) -> WfResult<()> {
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
        FILE_SYNCHRONOUS_IO_NONALERT, FILE_WRITE_THROUGH,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_WRITE_DATA, SYNCHRONIZE,
    };

    let relative_parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let leaf = relative
        .file_name()
        .ok_or_else(|| "Destination filename is invalid".to_string())?;
    validate_windows_handle_component(leaf)?;
    let parent = resolve_windows_workspace_parent(root, relative_parent, true)?;
    after_parent_opened();
    verify_windows_workspace_parent(root, relative_parent, &parent)?;

    match open_windows_relative_handle(
        &parent,
        leaf,
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        FILE_ATTRIBUTE_NORMAL,
    ) {
        Ok(_) if !replace => return Err(WORKSPACE_FILE_EXISTS.to_string()),
        Ok(existing) => validate_windows_regular_file_handle(&existing, "destination")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("Failed to inspect destination: {}", error));
        }
    }

    // A same-process writer may hold the previous temp with write/delete sharing
    // disabled. FILE_CREATE may report access denial rather than a name
    // collision, so every concurrent writer needs its own candidate.
    static ATTACHMENT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    for _ in 0..100u32 {
        let nonce = ATTACHMENT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp_name = format!(
            ".{}.myagents-attachment-{}-{}.tmp",
            leaf.to_string_lossy(),
            std::process::id(),
            nonce
        );
        let mut file = match open_windows_relative_handle(
            &parent,
            std::ffi::OsStr::new(&temp_name),
            FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE
                | FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | FILE_WRITE_THROUGH,
            FILE_ATTRIBUTE_NORMAL,
        ) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create attachment temp file: {}", error)),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            let _ = delete_windows_file_by_handle(&file);
            return Err(format!("Failed to write attachment: {}", error));
        }
        if let Err(error) = verify_windows_workspace_parent(root, relative_parent, &parent) {
            let _ = delete_windows_file_by_handle(&file);
            return Err(error);
        }
        if let Err(error) = rename_windows_file_relative(&file, &parent, leaf, replace) {
            let _ = delete_windows_file_by_handle(&file);
            if !replace && error.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(WORKSPACE_FILE_EXISTS.to_string());
            }
            return Err(format!("Failed to finalize attachment: {}", error));
        }
        // Rename already published the destination. Any subsequent failure is
        // an uncertain receipt, not proof that a retry may create another file.
        file.sync_all().map_err(|error| {
            format!(
                "Workspace write status unknown after publication: {}",
                error
            )
        })?;
        verify_windows_workspace_parent(root, relative_parent, &parent).map_err(|error| {
            format!(
                "Workspace write status unknown after publication: {}",
                error
            )
        })?;
        return Ok(());
    }
    Err("Failed to allocate attachment temp file".to_string())
}

#[cfg(all(not(unix), not(windows)))]
fn write_relative_file_no_follow_portable(
    root: &Path,
    relative: &Path,
    bytes: &[u8],
    replace: bool,
) -> WfResult<()> {
    let target = root.join(relative);
    let lexical_parent = target
        .parent()
        .ok_or_else(|| "Destination parent is invalid".to_string())?;
    let relative_parent = lexical_parent
        .strip_prefix(root)
        .map_err(|_| "Destination parent escapes workspace root".to_string())?;
    let canonical_parent = resolve_portable_destination_parent(root, relative_parent)?;
    let canonical_target = canonical_parent.join(target.file_name().expect("leaf validated"));
    if let Ok(metadata) = fs::symlink_metadata(&canonical_target) {
        if !replace {
            return Err(WORKSPACE_FILE_EXISTS.to_string());
        }
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Destination must be a regular, non-symlink file".to_string());
        }
    }
    for nonce in 0..100u32 {
        verify_portable_destination_parent(root, lexical_parent, &canonical_parent)?;
        let temp = canonical_parent.join(format!(
            ".{}.myagents-{}-{}.tmp",
            target
                .file_name()
                .expect("leaf validated")
                .to_string_lossy(),
            std::process::id(),
            nonce
        ));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create attachment temp file: {}", error)),
        };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to write attachment: {}", error));
        }
        drop(file);
        if let Err(error) =
            verify_portable_destination_parent(root, lexical_parent, &canonical_parent).and_then(
                |_| {
                    let result = if replace {
                        replace_portable_file(&temp, &canonical_target)
                    } else {
                        fs::hard_link(&temp, &canonical_target)
                    };
                    result.map_err(|e| {
                        if !replace && e.kind() == std::io::ErrorKind::AlreadyExists {
                            WORKSPACE_FILE_EXISTS.to_string()
                        } else {
                            format!("Failed to finalize attachment: {}", e)
                        }
                    })
                },
            )
        {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        if !replace {
            let _ = fs::remove_file(&temp);
        }
        return Ok(());
    }
    Err("Failed to allocate attachment temp file".to_string())
}

/// Sanitize a filename for filesystem write — strips Windows-illegal chars by
/// replacing them with `_`. Different from `validate_item_name`, which rejects
/// rather than fixes (used at the API boundary for explicit user-typed names).
/// This one is for "user uploaded a file called `foo<bar>.pdf`" — fix not reject.
pub fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    trimmed
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else if (c as u32) < 0x20 || c == '\x7f' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("path_safety")
    }

    #[test]
    fn rejects_relative_workspace_root() {
        assert!(validate_workspace_root("relative/path").is_err());
    }

    #[test]
    fn accepts_existing_dir() {
        let ws = make_tmp_workspace();
        let resolved = validate_workspace_root(ws.to_str().unwrap()).unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_blacklisted_dir() {
        // /etc exists on macOS/Linux; on Windows fall back to C:\Windows
        #[cfg(not(windows))]
        let blacklisted = "/etc";
        #[cfg(windows)]
        let blacklisted = "C:\\Windows";
        assert!(validate_workspace_root(blacklisted).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_workspace_root_symlink_to_blacklisted_directory() {
        let parent = make_tmp_workspace();
        let linked_root = parent.join("linked-root");
        std::os::unix::fs::symlink("/etc", &linked_root).unwrap();

        assert!(validate_workspace_root(linked_root.to_str().unwrap()).is_err());

        let _ = fs::remove_file(&linked_root);
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn resolve_simple_relative() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "sub/file.txt").unwrap();
        assert_eq!(resolved, ws.join("sub").join("file.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_dot_returns_root() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "").unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_absolute_relative() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_traversal_escape() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "../etc").is_err());
        assert!(resolve_inside_workspace(&ws, "a/../../etc").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn allows_internal_traversal() {
        let ws = make_tmp_workspace();
        // a/b/.. == a — legal
        let resolved = resolve_inside_workspace(&ws, "a/b/../c").unwrap();
        assert_eq!(resolved, ws.join("a").join("c"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validate_item_name_allows_unicode() {
        assert!(validate_item_name("说明.md").is_ok());
        assert!(validate_item_name("file_1-2.txt").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_separators() {
        assert!(validate_item_name("a/b").is_err());
        assert!(validate_item_name("a\\b").is_err());
        assert!(validate_item_name("..").is_err());
    }

    #[test]
    fn validate_item_name_rejects_windows_reserved() {
        assert!(validate_item_name("CON").is_err());
        assert!(validate_item_name("con.txt").is_err());
        assert!(validate_item_name("LPT1.log").is_err());
    }

    // Cross-review regression guard: Windows normalizes `CON.`, `CON `,
    // `COM1   . ` etc. to the underlying device. The reserved-name check
    // must trim trailing dots/spaces before comparing the stem, otherwise a
    // user-typed name slips past validation but still resolves to the
    // device on Windows.
    #[test]
    fn validate_item_name_rejects_windows_reserved_with_trailing_chars() {
        assert!(validate_item_name("CON.").is_err());
        assert!(validate_item_name("CON ").is_err());
        assert!(validate_item_name("COM1.").is_err());
        assert!(validate_item_name("PRN. .").is_err());
        // Make sure regular names with trailing dot in stem still pass the
        // reserved-name gate (other rules may still reject them, but not
        // this one). `foo.txt` has stem "foo" which trims to "foo".
        // `foo.` has stem "foo" too — should pass reserved-name gate.
        assert!(validate_item_name("foo.").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_control_chars() {
        assert!(validate_item_name("a\x00b").is_err());
        assert!(validate_item_name("\tfoo").is_err());
    }

    // validate_external_read_path: the canonical re-check only applies to
    // paths that EXIST. A non-existent path passes lexically — slash.rs
    // validates brand-new workspace roots before they're created (launcher
    // slash-command scan), and read flows stat right after anyway. The
    // 0.2.33 symlink hardening must not break that contract (caught by
    // align-docs reading the slash.rs caller comment).
    #[test]
    fn external_read_path_allows_nonexistent_path_lexically() {
        // NOT env::temp_dir(): on macOS that's /var/folders/… and the LEXICAL
        // blacklist rejects /var outright — use a non-existent child of a
        // real test workspace instead.
        let ws = make_tmp_workspace();
        let missing = ws.join("does_not_exist_yet");
        assert!(!missing.exists());
        assert!(validate_external_read_path(&missing.to_string_lossy()).is_ok());
        let _ = fs::remove_dir_all(&ws);
    }

    // …but an EXISTING path whose symlink chain lands in a blacklisted dir
    // is rejected on the canonical form (cross-review 0.2.33, Codex
    // Critical — the per-command test lives in transfer.rs).
    #[cfg(unix)]
    #[test]
    fn external_read_path_rejects_existing_symlink_into_blacklisted_dir() {
        use std::os::unix::fs::symlink;
        let staging = make_tmp_workspace();
        symlink("/etc", staging.join("lure")).unwrap();
        let evil = staging.join("lure").join("hosts");
        assert!(validate_external_read_path(&evil.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(&staging);
    }

    // Rust side of the Rust↔renderer name-rule crosscheck (cross-review
    // 0.2.33, architecture review). The renderer's `workspace-tree/
    // nameValidation.ts` hand-mirrors this module's `validate_item_name` for
    // live editor feedback; both sides assert against the shared fixture so
    // a rule change on either side breaks one of the two suites — same
    // pattern as path-safety-blacklist.json (PRD 0.2.15 §7.2).
    #[test]
    fn validate_item_name_matches_shared_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/item-name-validation-cases.json"
        ))
        .expect("item-name-validation-cases.json parses");
        let names = |key: &str| -> Vec<String> {
            fixture[key]
                .as_array()
                .unwrap_or_else(|| panic!("fixture.{key} must be an array"))
                .iter()
                .map(|v| v.as_str().expect("fixture entry is a string").to_string())
                .collect()
        };
        for name in names("valid") {
            assert!(
                validate_item_name(&name).is_ok(),
                "fixture says {:?} is valid but validate_item_name rejected it",
                name
            );
        }
        for name in names("invalid") {
            assert!(
                validate_item_name(&name).is_err(),
                "fixture says {:?} is invalid but validate_item_name accepted it",
                name
            );
        }
    }

    #[test]
    fn sanitize_strips_illegal_chars() {
        assert_eq!(sanitize_filename("foo<bar>.pdf"), "foo_bar_.pdf");
        assert_eq!(sanitize_filename("a:b/c"), "a_b_c");
    }

    #[test]
    fn sanitize_falls_back_to_untitled() {
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(sanitize_filename("   "), "untitled");
    }

    #[test]
    fn atomic_write_if_current_cleans_tmp_when_current_read_fails() {
        let ws = make_tmp_workspace();
        let target = ws.join("missing.md");

        let res = atomic_write_file_if_current(&target, b"new content", b"old content");

        assert!(res.is_err());
        let leftovers: Vec<String> = fs::read_dir(&ws)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".myagents-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);
        let _ = fs::remove_dir_all(&ws);
    }

    // ── resolve_existing_inside_workspace — Phase D.5 symlink hardening ──

    #[test]
    fn resolve_existing_finds_real_file() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("foo.txt"), "x").unwrap();
        let resolved = resolve_existing_inside_workspace(&ws, "foo.txt").unwrap();
        // Both should canonicalize to the same path.
        assert_eq!(resolved, fs::canonicalize(ws.join("foo.txt")).unwrap());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_existing_rejects_missing() {
        let ws = make_tmp_workspace();
        let res = resolve_existing_inside_workspace(&ws, "nope.txt");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("File not found"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_existing_rejects_traversal() {
        let ws = make_tmp_workspace();
        let res = resolve_existing_inside_workspace(&ws, "../etc");
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // The headline regression guard: a malicious symlink inside the
    // workspace pointing outside (e.g. cloned repo with `evil_link → /etc`)
    // must be rejected by read-side commands. Lexical resolve passes — the
    // link IS at `<ws>/evil_link` which starts_with workspace — so we rely
    // on the canonicalize check to catch the escape.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        // Target outside the workspace.
        let outside_dir = make_test_workspace("path_safety_outside");
        let outside_file = outside_dir.join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        // Symlink inside ws → outside file.
        symlink(&outside_file, ws.join("evil_link")).unwrap();

        let res = resolve_existing_inside_workspace(&ws, "evil_link");
        assert!(res.is_err());
        assert!(
            res.unwrap_err().contains("symlink"),
            "expected symlink-escape error"
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    // Symlinks INSIDE the workspace pointing to other files INSIDE the
    // workspace should still be allowed — they're a legitimate user pattern
    // (e.g. linking `current → builds/v3`). Canonicalize collapses them but
    // both ends remain inside the canonical root.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_allows_internal_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        fs::write(ws.join("real.txt"), "ok").unwrap();
        symlink(ws.join("real.txt"), ws.join("link.txt")).unwrap();
        let resolved = resolve_existing_inside_workspace(&ws, "link.txt").unwrap();
        // Should resolve to the real file (canonicalize follows the link).
        assert_eq!(resolved, fs::canonicalize(ws.join("real.txt")).unwrap());
        let _ = fs::remove_dir_all(&ws);
    }

    // Broken symlink inside workspace — canonicalize fails → "File not found".
    // This is the right behavior: the read commands would error on read
    // anyway, and surfacing it here is uniform.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_handles_broken_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        symlink("/nonexistent/target", ws.join("broken")).unwrap();
        let res = resolve_existing_inside_workspace(&ws, "broken");
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn no_follow_workspace_io_rejects_symlink_ancestors_and_leafs() {
        use std::os::unix::fs::symlink;

        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_outside_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, ws.join("linked")).unwrap();

        assert!(read_workspace_file_no_follow(&ws, "linked/secret.txt", 1024).is_err());
        assert!(write_workspace_file_no_follow(&ws, "linked/result.txt", b"blocked").is_err());
        assert!(!outside.join("result.txt").exists());

        symlink(outside.join("missing.txt"), ws.join("broken.txt")).unwrap();
        assert!(write_workspace_file_no_follow(&ws, "broken.txt", b"blocked").is_err());
        assert!(!outside.join("missing.txt").exists());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn streaming_workspace_handles_create_safe_directories_and_reject_links() {
        use std::os::unix::fs::symlink;

        let ws = make_tmp_workspace();
        fs::write(ws.join("meeting.wav"), b"audio").unwrap();
        let (source_path, mut source) =
            open_workspace_regular_file_no_follow(&ws, "meeting.wav", "speech source").unwrap();
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes).unwrap();
        assert_eq!(
            source_path,
            fs::canonicalize(ws.join("meeting.wav")).unwrap()
        );
        assert_eq!(bytes, b"audio");

        let (output_path, output) =
            ensure_workspace_directory_no_follow(&ws, "myagents_files/speech").unwrap();
        assert_eq!(
            output_path,
            fs::canonicalize(ws.join("myagents_files/speech")).unwrap()
        );
        assert!(output.metadata().unwrap().is_dir());

        let outside = make_test_workspace("speech_output_outside");
        symlink(&outside, ws.join("linked-output")).unwrap();
        assert!(ensure_workspace_directory_no_follow(&ws, "linked-output/jobs").is_err());
        assert!(open_workspace_regular_file_no_follow(
            &ws,
            outside.join("secret.wav").to_string_lossy().as_ref(),
            "speech source",
        )
        .is_err());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn no_follow_workspace_writer_skips_precreated_temp_symlinks() {
        use std::os::unix::fs::symlink;

        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_temp_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        let victim = outside.join("victim.txt");
        fs::write(&victim, "untouched").unwrap();
        let predictable = ws.join(format!(".result.txt.myagents-{}-0.tmp", std::process::id()));
        symlink(&victim, predictable).unwrap();

        write_workspace_file_no_follow(&ws, "result.txt", b"safe").unwrap();
        assert_eq!(fs::read(ws.join("result.txt")).unwrap(), b"safe");
        assert_eq!(fs::read(victim).unwrap(), b"untouched");
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn no_follow_workspace_writer_atomically_replaces_an_existing_download() {
        let ws = make_tmp_workspace();
        write_workspace_file_no_follow(&ws, "downloads/result.txt", b"first").unwrap();
        write_workspace_file_no_follow(&ws, "downloads/result.txt", b"second").unwrap();
        assert_eq!(
            fs::read(ws.join("downloads/result.txt")).unwrap(),
            b"second"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_workspace_writer_supports_one_code_unit_filename() {
        let ws = make_tmp_workspace();
        write_workspace_file_no_follow(&ws, "a", b"first").unwrap();
        write_workspace_file_no_follow(&ws, "a", b"second").unwrap();
        assert_eq!(fs::read(ws.join("a")).unwrap(), b"second");
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(windows)]
    #[test]
    fn windows_publication_stays_anchored_and_preserves_collision_semantics() {
        use windows_sys::Wdk::Storage::FileSystem::{
            FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_WRITE_DATA, SYNCHRONIZE,
        };

        let ws = make_tmp_workspace();
        let outside = make_test_workspace("windows_publish_outside");
        let safe = ws.join("safe");
        let moved = ws.join("safe-original");
        fs::create_dir(&safe).unwrap();
        let parent = resolve_windows_workspace_parent(
            &fs::canonicalize(&ws).unwrap(),
            Path::new("safe"),
            false,
        )
        .unwrap();

        // Swap the namespace while the verified directory handle is retained.
        // Move it before opening a child: Windows cannot rename a directory
        // containing open file handles. Temp creation and publication must
        // still use the original object rather than the replacement junction.
        fs::rename(&safe, &moved).unwrap();
        junction::create(&outside, &safe).unwrap();
        fs::write(moved.join("result.txt"), b"original").unwrap();
        fs::write(outside.join("result.txt"), b"outside").unwrap();
        let mut file = open_windows_relative_handle(
            &parent,
            std::ffi::OsStr::new("pending.tmp"),
            FILE_WRITE_DATA | DELETE | SYNCHRONIZE,
            FILE_SHARE_READ,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            FILE_ATTRIBUTE_NORMAL,
        )
        .unwrap();
        file.write_all(b"new").unwrap();
        file.sync_all().unwrap();

        let target = std::ffi::OsStr::new("result.txt");
        let err = rename_windows_file_relative(&file, &parent, target, false).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(moved.join("result.txt")).unwrap(), b"original");
        rename_windows_file_relative(&file, &parent, target, true).unwrap();
        assert_eq!(fs::read(moved.join("result.txt")).unwrap(), b"new");
        assert_eq!(fs::read(outside.join("result.txt")).unwrap(), b"outside");
        assert!(!moved.join("pending.tmp").exists());

        drop(file);
        drop(parent);
        junction::delete(&safe).unwrap();
        fs::remove_dir_all(ws).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_workspace_writer_rejects_windows_junction_ancestors() {
        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_windows_junction_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        junction::create(&outside, ws.join("linked")).unwrap();

        assert!(write_workspace_file_no_follow(&ws, "linked/result.txt", b"blocked").is_err());
        assert!(!outside.join("result.txt").exists());
        let _ = junction::delete(ws.join("linked"));
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_workspace_reader_rejects_windows_junction_ancestors() {
        let ws = make_tmp_workspace();
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_windows_read_junction_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "outside").unwrap();
        junction::create(&outside, ws.join("linked")).unwrap();

        assert!(read_workspace_file_no_follow(&ws, "linked/secret.txt", 1024).is_err());
        let _ = junction::delete(ws.join("linked"));
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_workspace_reader_opens_leaf_relative_to_verified_parent() {
        let ws = make_tmp_workspace();
        let safe = ws.join("safe");
        let moved = ws.join("safe-original");
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_windows_swap_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&safe).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(safe.join("value.txt"), "inside").unwrap();
        fs::write(outside.join("value.txt"), "outside").unwrap();

        let canonical_ws = fs::canonicalize(&ws).unwrap();
        let (mut file, opened_parent) = open_windows_workspace_file_no_follow_impl(
            &fs::canonicalize(&ws).unwrap(),
            Path::new("safe/value.txt"),
            || {
                fs::rename(&safe, &moved).unwrap();
                junction::create(&outside, &safe).unwrap();
            },
        )
        .unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();
        assert_eq!(content, "inside");
        assert!(
            verify_windows_workspace_parent(&canonical_ws, Path::new("safe"), &opened_parent)
                .is_err(),
            "namespace replacement must be detected even though the anchored read stays safe"
        );

        drop(file);
        drop(opened_parent);
        let _ = junction::delete(&safe);
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn no_follow_workspace_writer_rejects_parent_replacement_after_open() {
        let ws = make_tmp_workspace();
        let safe = ws.join("safe");
        let moved = ws.join("safe-original");
        let outside = std::env::temp_dir().join(format!(
            "space_attachment_windows_write_swap_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&safe).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let result = write_relative_file_no_follow_windows_impl(
            &fs::canonicalize(&ws).unwrap(),
            Path::new("safe/result.txt"),
            b"blocked",
            || {
                fs::rename(&safe, &moved).unwrap();
                junction::create(&outside, &safe).unwrap();
            },
        );

        assert!(result.is_err());
        assert!(!outside.join("result.txt").exists());
        assert!(!moved.join("result.txt").exists());
        let _ = junction::delete(&safe);
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside);
    }

    // ── is_trusted_managed_target — Phase E skill-junction whitelist ──

    #[test]
    fn trusted_target_matches_root() {
        let root = std::env::temp_dir().join(format!("trusted_root_{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let child = canonical_root.join("baoyu-imagine").join("SKILL.md");
        assert!(is_trusted_managed_target(&child, &[canonical_root.clone()]));
        // Sibling-of-prefix must NOT match — `starts_with` works on path
        // components, so `/tmp/trusted` does not pretend to contain
        // `/tmp/trusted_evil` even though the string starts the same.
        let evil = canonical_root.parent().unwrap().join(format!(
            "{}_evil",
            canonical_root.file_name().unwrap().to_string_lossy()
        ));
        assert!(!is_trusted_managed_target(&evil, &[canonical_root]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trusted_target_empty_roots_rejects_everything() {
        // Defence: if `trusted_managed_roots()` returns empty (no `.myagents`
        // dir yet), the whitelist degrades closed — `is_trusted_managed_target`
        // returns false for any path so the original symlink-escape rejection
        // still fires.
        let p = Path::new("/anywhere");
        assert!(!is_trusted_managed_target(p, &[]));
    }

    #[test]
    fn managed_skill_mutation_guard_allows_ordinary_workspace_paths() {
        let ws = make_tmp_workspace();
        let managed = make_test_workspace("mutation_guard_managed");
        fs::create_dir_all(ws.join("ordinary")).unwrap();
        fs::create_dir_all(&managed).unwrap();
        assert!(reject_managed_global_skill_mutation_with_root(
            &ws,
            &ws.join("ordinary/new.md"),
            &managed,
        )
        .is_ok());
        assert!(reject_managed_global_skill_mutation_with_root(
            &ws,
            &managed.join("skill/SKILL.md"),
            &managed,
        )
        .unwrap_err()
        .starts_with("MANAGED_GLOBAL_SKILL_READ_ONLY"));
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&managed);
    }

    #[cfg(unix)]
    #[test]
    fn managed_skill_mutation_guard_rejects_link_leaf_descendant_and_broken_link() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        let managed = make_test_workspace("mutation_guard_link_managed");
        let skill = managed.join("pdf");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "pdf").unwrap();
        let links = ws.join(".claude/skills");
        fs::create_dir_all(&links).unwrap();
        let link = links.join("pdf");
        symlink(&skill, &link).unwrap();

        let existing_child = link.join("SKILL.md");
        let missing_child = link.join("new.md");
        for target in [&link, &existing_child, &missing_child] {
            let error = reject_managed_global_skill_mutation_with_root(&ws, target, &managed)
                .expect_err("managed Skill mutation must fail");
            assert!(error.starts_with("MANAGED_GLOBAL_SKILL_READ_ONLY"));
        }

        let broken = links.join("missing");
        symlink(managed.join("missing"), &broken).unwrap();
        assert!(
            reject_managed_global_skill_mutation_with_root(&ws, &broken, &managed)
                .unwrap_err()
                .starts_with("MANAGED_GLOBAL_SKILL_READ_ONLY")
        );

        let broken_relative = links.join("missing-relative");
        let relative_target = PathBuf::from("../../..")
            .join(managed.file_name().unwrap())
            .join("missing-relative");
        symlink(relative_target, &broken_relative).unwrap();
        assert!(
            reject_managed_global_skill_mutation_with_root(&ws, &broken_relative, &managed)
                .unwrap_err()
                .starts_with("MANAGED_GLOBAL_SKILL_READ_ONLY")
        );

        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&managed);
    }

    // Headline whitelist test: a junction-like symlink in the workspace
    // pointing into a trusted root MUST resolve successfully even though the
    // target is outside the canonical workspace. This unblocks Windows users
    // hitting "文件预览失败" on user-level skill links synced by
    // Node `syncProjectUserConfigFiles`.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_allows_symlink_into_trusted_root() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        // Stand in for `~/.myagents/skills/`.
        let managed = make_test_workspace("path_safety_managed");
        let managed_skill = managed.join("baoyu-imagine");
        fs::create_dir_all(&managed_skill).unwrap();
        let real_md = managed_skill.join("SKILL.md");
        fs::write(&real_md, "skill content").unwrap();

        // Mirror the prod symlink shape: `<ws>/.claude/skills/baoyu-imagine`
        // points at the managed skill dir.
        let link_parent = ws.join(".claude").join("skills");
        fs::create_dir_all(&link_parent).unwrap();
        symlink(&managed_skill, link_parent.join("baoyu-imagine")).unwrap();

        let canonical_managed = fs::canonicalize(&managed).unwrap();

        // Direct: bypass `trusted_managed_roots()` (which reads real
        // `~/.myagents/`) and inject our tmp root via the pure helper.
        let lexical =
            resolve_inside_workspace(&ws, ".claude/skills/baoyu-imagine/SKILL.md").unwrap();
        let canonical = fs::canonicalize(&lexical).unwrap();
        assert!(
            is_trusted_managed_target(&canonical, &[canonical_managed]),
            "skill target under managed root should be trusted: {:?}",
            canonical
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&managed);
    }
}
