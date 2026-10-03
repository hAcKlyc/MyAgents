//! CLI mode and launcher authority for the `myagents` binary.
//!
//! The app bundle is the only owner of CLI business code. The files under
//! `~/.myagents/bin/` are deterministic thin launchers that re-enter the
//! current MyAgents executable with [`CLI_BOOTSTRAP_ARG`]; this module then
//! runs the bundled Node.js runtime against the bundled `cli/myagents.cjs`.
//! No CLI business payload is copied into the user's home directory.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(not(test))]
use std::sync::{Mutex, OnceLock};

/// Private launcher → app-binary marker. It is stripped before Node sees argv.
pub const CLI_BOOTSTRAP_ARG: &str = "--myagents-cli-entry";

/// CLI subcommands retained for backwards-compatible direct app-binary calls.
///
/// The canonical `myagents` launcher uses [`CLI_BOOTSTRAP_ARG`], so adding a new
/// business group no longer depends on mirroring it here. This list only keeps
/// previously published `MyAgents <group> ...` invocations working.
const CLI_COMMANDS: &[&str] = &[
    "mcp", "vision", "model", "agent", "runtime", "config", "status", "reload", "version", "cron",
    "goal", "plugin", "skill", "task", "thought", "im", "session", "widget", "space", "diagnose",
    "tool",
];

#[cfg(not(test))]
static LAUNCHER_RECONCILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static LAUNCHER_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CliPlatform {
    Macos,
    Windows,
    Linux,
}

impl CliPlatform {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliRuntimePaths {
    node: PathBuf,
    script: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliBootstrapError {
    code: &'static str,
    stage: &'static str,
    path: Option<PathBuf>,
    message: String,
}

impl CliBootstrapError {
    fn new(
        code: &'static str,
        stage: &'static str,
        path: Option<PathBuf>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            stage,
            path,
            message: message.into(),
        }
    }
}

impl fmt::Display for CliBootstrapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        const ACTION: &str = "Confirm the install path exists, close processes holding the launcher, then retry or restart MyAgents; reinstall if bundled resources are missing";
        let path = self
            .path
            .as_ref()
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "-".to_string());
        write!(
            formatter,
            "CLI_BOOTSTRAP_FAILED code={} stage={} path={:?} message={:?} action={:?}",
            self.code, self.stage, path, self.message, ACTION,
        )
    }
}

/// Check if the given args indicate CLI mode.
pub fn is_cli_mode(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == CLI_BOOTSTRAP_ARG)
        || args.iter().any(|arg| {
            CLI_COMMANDS.contains(&arg.as_str())
                || arg == "--help"
                || arg == "-h"
                || arg == "--version"
        })
}

fn forwarded_cli_args(args: &[String]) -> &[String] {
    if args.first().is_some_and(|arg| arg == CLI_BOOTSTRAP_ARG) {
        &args[1..]
    } else {
        args
    }
}

/// Run the bundled CLI and return its process exit code.
pub fn run(args: &[String]) -> i32 {
    // On Windows, re-attach to the parent console so CLI stdout/stderr are visible.
    #[cfg(windows)]
    {
        extern "system" {
            fn AttachConsole(dw_process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    let runtime = match resolve_cli_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Error: {error}");
            return 1;
        }
    };

    let node_path = crate::sidecar::normalize_external_path(runtime.node);
    let script_path = crate::sidecar::normalize_external_path(runtime.script);

    // Preserve an explicit Session port. Only terminal-style invocations with
    // no inherited port may fall back to the Global Sidecar port file.
    let inherited_port = std::env::var("MYAGENTS_PORT").ok();
    let inherited_session = std::env::var("MYAGENTS_SESSION_ID").ok();
    let global_port =
        should_inject_global_port(inherited_port.as_deref(), inherited_session.as_deref())
            .then(discover_sidecar_port)
            .flatten();

    match run_node(
        &node_path,
        &script_path,
        forwarded_cli_args(args),
        global_port.as_deref(),
    ) {
        Ok(code) => code,
        Err(error) => {
            eprintln!(
                "Error: {}",
                CliBootstrapError::new(
                    "CLI_PROCESS_SPAWN_FAILED",
                    "spawn",
                    Some(node_path),
                    error.to_string(),
                )
            );
            1
        }
    }
}

#[cfg(not(windows))]
fn run_node(
    node: &Path,
    script: &Path,
    args: &[String],
    global_port: Option<&str>,
) -> std::io::Result<i32> {
    #[allow(clippy::disallowed_methods)]
    let mut command = Command::new(node);
    command.arg(script).args(args);
    command.stdin(Stdio::inherit());
    command.stdout(Stdio::inherit());
    command.stderr(Stdio::inherit());
    if let Some(port) = global_port {
        command.env("MYAGENTS_PORT", port);
    }
    command.env("NO_PROXY", crate::proxy_config::LOCALHOST_NO_PROXY);
    command.env("no_proxy", crate::proxy_config::LOCALHOST_NO_PROXY);
    command.status().map(|status| status.code().unwrap_or(1))
}

#[cfg(windows)]
fn run_node(
    node: &Path,
    script: &Path,
    args: &[String],
    global_port: Option<&str>,
) -> std::io::Result<i32> {
    windows_process::run(node, script, args, global_port)
}

#[cfg(windows)]
#[path = "cli/windows_process.rs"]
mod windows_process;

fn should_inject_global_port(
    inherited_port: Option<&str>,
    inherited_session: Option<&str>,
) -> bool {
    inherited_session.is_none()
        && !matches!(inherited_port, Some(value) if !value.trim().is_empty())
}

/// Reconcile the product-owned CLI launchers against the current app binary.
///
/// This validates the bundled runtime first, so an incomplete installation can
/// never publish a launcher that would fall back to HOME or a system Node.js.
pub(crate) fn ensure_launcher() -> Result<bool, String> {
    // Rust unit tests exercise the pure locator/reconciler cores with temp
    // directories. Sidecar lifecycle tests must never mutate the developer's
    // real ~/.myagents directory merely because they cross this admission.
    #[cfg(test)]
    return Ok(false);

    #[cfg(not(test))]
    {
        resolve_cli_runtime().map_err(|error| error.to_string())?;
        let executable = std::env::current_exe().map_err(|error| {
            CliBootstrapError::new(
                "CLI_EXECUTABLE_RESOLVE_FAILED",
                "resolve",
                None,
                error.to_string(),
            )
            .to_string()
        })?;
        let executable = fs::canonicalize(&executable).map_err(|error| {
            CliBootstrapError::new(
                "CLI_EXECUTABLE_CANONICALIZE_FAILED",
                "resolve",
                Some(executable),
                error.to_string(),
            )
            .to_string()
        })?;
        let data_dir = crate::app_dirs::myagents_data_dir().ok_or_else(|| {
            CliBootstrapError::new(
                "CLI_DATA_DIR_UNAVAILABLE",
                "resolve",
                None,
                "cannot determine the MyAgents data directory",
            )
            .to_string()
        })?;

        let _guard = LAUNCHER_RECONCILE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|error| {
                CliBootstrapError::new(
                    "CLI_LAUNCHER_LOCK_FAILED",
                    "install",
                    None,
                    error.to_string(),
                )
                .to_string()
            })?;
        reconcile_launchers(&data_dir, &executable, CliPlatform::current())
            .map_err(|error| error.to_string())
    }
}

fn reconcile_launchers(
    data_dir: &Path,
    executable: &Path,
    platform: CliPlatform,
) -> Result<bool, CliBootstrapError> {
    let bin_dir = data_dir.join("bin");
    ensure_launcher_directory(&bin_dir)?;

    let normalized_executable = crate::sidecar::normalize_external_path(executable.to_path_buf());
    let executable_text = normalized_executable.to_str().ok_or_else(|| {
        CliBootstrapError::new(
            "CLI_EXECUTABLE_ENCODING_UNSUPPORTED",
            "validate",
            Some(normalized_executable.clone()),
            "app executable path is not valid Unicode",
        )
    })?;
    let posix = build_posix_launcher(executable_text, platform);
    let windows = build_windows_launcher(executable_text);

    // Install the extensionless entry first. If the second rename fails, an
    // old Windows .cmd will try to parse this shell launcher as JavaScript and
    // fail closed instead of executing the old business payload.
    let mut changed = install_launcher(&bin_dir.join("myagents"), posix.as_bytes(), true)?;
    changed |= install_launcher(&bin_dir.join("myagents.cmd"), windows.as_bytes(), false)?;

    let retired_marker = data_dir.join(".cli-version");
    match fs::symlink_metadata(&retired_marker) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            return Err(CliBootstrapError::new(
                "CLI_RETIRED_MARKER_INVALID",
                "install",
                Some(retired_marker),
                "retired marker path is a directory",
            ));
        }
        Ok(_) => {
            fs::remove_file(&retired_marker).map_err(|error| {
                CliBootstrapError::new(
                    "CLI_RETIRED_MARKER_REMOVE_FAILED",
                    "install",
                    Some(retired_marker.clone()),
                    error.to_string(),
                )
            })?;
            changed = true;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CliBootstrapError::new(
                "CLI_RETIRED_MARKER_INSPECT_FAILED",
                "validate",
                Some(retired_marker),
                error.to_string(),
            ));
        }
    }

    Ok(changed)
}

fn ensure_launcher_directory(bin_dir: &Path) -> Result<(), CliBootstrapError> {
    match fs::symlink_metadata(bin_dir) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            return Ok(());
        }
        Ok(_) => {
            return Err(CliBootstrapError::new(
                "CLI_LAUNCHER_DIR_UNSAFE",
                "validate",
                Some(bin_dir.to_path_buf()),
                "launcher directory exists but is not a real directory",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CliBootstrapError::new(
                "CLI_LAUNCHER_DIR_INSPECT_FAILED",
                "validate",
                Some(bin_dir.to_path_buf()),
                error.to_string(),
            ));
        }
    }

    fs::create_dir_all(bin_dir).map_err(|error| {
        CliBootstrapError::new(
            "CLI_LAUNCHER_DIR_CREATE_FAILED",
            "install",
            Some(bin_dir.to_path_buf()),
            error.to_string(),
        )
    })?;

    let metadata = fs::symlink_metadata(bin_dir).map_err(|error| {
        CliBootstrapError::new(
            "CLI_LAUNCHER_DIR_INSPECT_FAILED",
            "validate",
            Some(bin_dir.to_path_buf()),
            error.to_string(),
        )
    })?;
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(CliBootstrapError::new(
            "CLI_LAUNCHER_DIR_UNSAFE",
            "validate",
            Some(bin_dir.to_path_buf()),
            "launcher directory changed identity during creation",
        ))
    }
}

fn build_posix_launcher(executable: &str, platform: CliPlatform) -> String {
    let mut executable = executable.to_string();
    if platform == CliPlatform::Windows {
        executable = executable.replace('\\', "/");
    }
    format!(
        "#!/bin/sh\n# Generated by MyAgents; this is a thin launcher, not CLI business code.\nexec {} {} \"$@\"\n",
        shell_quote(&executable),
        shell_quote(CLI_BOOTSTRAP_ARG),
    )
}

fn build_windows_launcher(executable: &str) -> String {
    // `%` is variable syntax in cmd.exe even inside quotes. Doubling it keeps
    // a literal percent sign in an otherwise valid Windows path.
    let executable = executable.replace('%', "%%");
    format!(
        "@echo off\r\n\
         :: Generated by MyAgents; this is a thin launcher, not CLI business code.\r\n\
         setlocal DisableDelayedExpansion\r\n\
         \"{}\" {} %*\r\n\
         exit /b %ERRORLEVEL%\r\n",
        executable, CLI_BOOTSTRAP_ARG,
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn launcher_is_current(path: &Path, expected: &[u8], _executable: bool) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    let Ok(actual) = fs::read(path) else {
        return false;
    };
    if actual != expected {
        return false;
    }

    #[cfg(unix)]
    if _executable {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }

    true
}

fn install_launcher(
    path: &Path,
    contents: &[u8],
    executable: bool,
) -> Result<bool, CliBootstrapError> {
    if launcher_is_current(path, contents, executable) {
        return Ok(false);
    }

    let parent = path.parent().ok_or_else(|| {
        CliBootstrapError::new(
            "CLI_LAUNCHER_PARENT_MISSING",
            "install",
            Some(path.to_path_buf()),
            "launcher target has no parent directory",
        )
    })?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("myagents");
    let (mut file, temp_path) = create_launcher_temp(parent, file_name)?;

    let install_result = (|| -> Result<(), CliBootstrapError> {
        file.write_all(contents).map_err(|error| {
            CliBootstrapError::new(
                "CLI_LAUNCHER_TEMP_WRITE_FAILED",
                "install",
                Some(temp_path.clone()),
                error.to_string(),
            )
        })?;

        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o755))
                .map_err(|error| {
                    CliBootstrapError::new(
                        "CLI_LAUNCHER_PERMISSION_FAILED",
                        "install",
                        Some(temp_path.clone()),
                        error.to_string(),
                    )
                })?;
        }

        file.sync_all().map_err(|error| {
            CliBootstrapError::new(
                "CLI_LAUNCHER_TEMP_SYNC_FAILED",
                "install",
                Some(temp_path.clone()),
                error.to_string(),
            )
        })?;
        drop(file);

        rename_launcher_with_retry(&temp_path, path).map_err(|error| {
            CliBootstrapError::new(
                "CLI_LAUNCHER_RENAME_FAILED",
                "install",
                Some(path.to_path_buf()),
                error.to_string(),
            )
        })?;

        #[cfg(unix)]
        {
            let directory = fs::File::open(parent).map_err(|error| {
                CliBootstrapError::new(
                    "CLI_LAUNCHER_DIR_SYNC_OPEN_FAILED",
                    "install",
                    Some(parent.to_path_buf()),
                    error.to_string(),
                )
            })?;
            directory.sync_all().map_err(|error| {
                CliBootstrapError::new(
                    "CLI_LAUNCHER_DIR_SYNC_FAILED",
                    "install",
                    Some(parent.to_path_buf()),
                    error.to_string(),
                )
            })?;
        }

        Ok(())
    })();

    if install_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    install_result.map(|()| true)
}

fn create_launcher_temp(
    parent: &Path,
    file_name: &str,
) -> Result<(fs::File, PathBuf), CliBootstrapError> {
    for _ in 0..16 {
        let sequence = LAUNCHER_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{}.{}.{}.tmp",
            file_name,
            std::process::id(),
            sequence,
        ));
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CliBootstrapError::new(
                    "CLI_LAUNCHER_TEMP_OPEN_FAILED",
                    "install",
                    Some(path),
                    error.to_string(),
                ));
            }
        }
    }

    Err(CliBootstrapError::new(
        "CLI_LAUNCHER_TEMP_COLLISION",
        "install",
        Some(parent.to_path_buf()),
        "could not reserve a no-follow temporary launcher path",
    ))
}

fn rename_launcher_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let mut last_error = None;
        for attempt in 0..4 {
            match fs::rename(from, to) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let code = error.raw_os_error().unwrap_or_default();
                    if (code == 5 || code == 32) && attempt < 3 {
                        std::thread::sleep(std::time::Duration::from_millis(25u64 << attempt));
                        last_error = Some(error);
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| std::io::Error::other("rename retries exhausted")))
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)
    }
}

fn resolve_cli_runtime() -> Result<CliRuntimePaths, CliBootstrapError> {
    let executable = std::env::current_exe().map_err(|error| {
        CliBootstrapError::new(
            "CLI_EXECUTABLE_RESOLVE_FAILED",
            "resolve",
            None,
            error.to_string(),
        )
    })?;
    #[cfg(debug_assertions)]
    let dev_resources = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    #[cfg(not(debug_assertions))]
    let dev_resources: Option<PathBuf> = None;

    resolve_cli_runtime_from_executable(
        &executable,
        CliPlatform::current(),
        dev_resources.as_deref(),
    )
}

fn resolve_cli_runtime_from_executable(
    executable: &Path,
    platform: CliPlatform,
    dev_resources: Option<&Path>,
) -> Result<CliRuntimePaths, CliBootstrapError> {
    let executable_dir = executable.parent().ok_or_else(|| {
        CliBootstrapError::new(
            "CLI_EXECUTABLE_PARENT_MISSING",
            "resolve",
            Some(executable.to_path_buf()),
            "current executable has no parent directory",
        )
    })?;
    // Each candidate carries the installation boundary it is allowed to live
    // under. Canonicalizing only the candidate would still accept an
    // intermediate symlink/junction that redirects the bundle outside the
    // current installation tree.
    let mut resource_roots = Vec::new();

    match platform {
        CliPlatform::Macos => {
            if let Some(contents) = executable_dir.parent() {
                push_unique_root(
                    &mut resource_roots,
                    contents.join("Resources"),
                    contents.to_path_buf(),
                );
            }
            push_unique_root(
                &mut resource_roots,
                executable_dir.join("Resources"),
                executable_dir.to_path_buf(),
            );
        }
        CliPlatform::Windows => {
            push_unique_root(
                &mut resource_roots,
                executable_dir.join("resources"),
                executable_dir.to_path_buf(),
            );
            push_unique_root(
                &mut resource_roots,
                executable_dir.to_path_buf(),
                executable_dir.to_path_buf(),
            );
        }
        CliPlatform::Linux => {
            let install_root = executable_dir.join("..");
            push_unique_root(
                &mut resource_roots,
                executable_dir.join("..").join("lib").join("MyAgents"),
                install_root,
            );
            push_unique_root(
                &mut resource_roots,
                executable_dir.join("resources"),
                executable_dir.to_path_buf(),
            );
            push_unique_root(
                &mut resource_roots,
                executable_dir.to_path_buf(),
                executable_dir.to_path_buf(),
            );
        }
    }
    if let Some(dev_resources) = dev_resources {
        push_unique_root(
            &mut resource_roots,
            dev_resources.to_path_buf(),
            dev_resources.to_path_buf(),
        );
    }

    let mut unsafe_resource = None;
    for (root, install_boundary) in &resource_roots {
        let node = node_path_in_resources(root, platform);
        let script = root.join("cli").join("myagents.cjs");
        if is_executable_regular_file(&node, platform) && is_regular_file(&script) {
            let canonicalize = |path: &Path| {
                fs::canonicalize(path).map_err(|error| {
                    CliBootstrapError::new(
                        "CLI_BUNDLE_ROOT_RESOLVE_FAILED",
                        "resolve",
                        Some(path.to_path_buf()),
                        error.to_string(),
                    )
                })
            };
            let canonical_boundary = canonicalize(install_boundary)?;
            let canonical_root = canonicalize(root)?;
            let canonical_node = canonicalize(&node)?;
            let canonical_script = canonicalize(&script)?;

            if !canonical_root.starts_with(&canonical_boundary)
                || !canonical_node.starts_with(&canonical_root)
                || !canonical_script.starts_with(&canonical_root)
            {
                unsafe_resource.get_or_insert_with(|| canonical_root.clone());
                continue;
            }

            return Ok(CliRuntimePaths {
                node: canonical_node,
                script: canonical_script,
            });
        }
    }

    if let Some(path) = unsafe_resource {
        return Err(CliBootstrapError::new(
            "CLI_BUNDLE_RESOURCES_UNSAFE",
            "validate",
            Some(path),
            "bundled Node.js or cli/myagents.cjs resolves outside the current installation tree",
        ));
    }

    Err(CliBootstrapError::new(
        "CLI_BUNDLE_RESOURCES_MISSING",
        "validate",
        Some(executable.to_path_buf()),
        format!(
            "bundled Node.js and cli/myagents.cjs were not both present under any resource root: {}",
            resource_roots
                .iter()
                .map(|(path, _)| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}

fn push_unique_root(paths: &mut Vec<(PathBuf, PathBuf)>, root: PathBuf, boundary: PathBuf) {
    if !paths.iter().any(|(existing, _)| existing == &root) {
        paths.push((root, boundary));
    }
}

fn node_path_in_resources(resources: &Path, platform: CliPlatform) -> PathBuf {
    if platform == CliPlatform::Windows {
        resources.join("nodejs").join("node.exe")
    } else {
        resources.join("nodejs").join("bin").join("node")
    }
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn is_executable_regular_file(path: &Path, _platform: CliPlatform) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    #[cfg(unix)]
    if _platform != CliPlatform::Windows {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    true
}

/// Read the Global Sidecar port from the product data directory.
fn discover_sidecar_port() -> Option<String> {
    let port_file = crate::app_dirs::myagents_data_dir()?.join("sidecar.port");
    let port = fs::read_to_string(port_file).ok()?.trim().to_string();
    let parsed = port.parse::<u16>().ok()?;
    (parsed != 0).then_some(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_runtime(root: &Path, platform: CliPlatform) {
        let node = node_path_in_resources(root, platform);
        fs::create_dir_all(node.parent().unwrap()).unwrap();
        fs::create_dir_all(root.join("cli")).unwrap();
        fs::write(node, b"node").unwrap();
        #[cfg(unix)]
        if platform != CliPlatform::Windows {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                node_path_in_resources(root, platform),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        fs::write(root.join("cli").join("myagents.cjs"), b"cli").unwrap();
    }

    #[test]
    fn private_marker_is_the_canonical_cli_entry_and_is_not_forwarded() {
        let args = vec![
            CLI_BOOTSTRAP_ARG.to_string(),
            "space".to_string(),
            "list".to_string(),
        ];
        assert!(is_cli_mode(&args));
        assert_eq!(forwarded_cli_args(&args), &["space", "list"]);
    }

    #[test]
    fn direct_binary_groups_remain_backwards_compatible() {
        assert!(is_cli_mode(&["--version".to_string()]));
        assert!(is_cli_mode(&["mcp".to_string(), "list".to_string()]));
        assert!(!is_cli_mode(&["myagents://open".to_string()]));
    }

    #[test]
    fn session_port_prevents_global_port_injection() {
        assert!(!should_inject_global_port(Some("31417"), None));
        assert!(should_inject_global_port(Some("  "), None));
        assert!(should_inject_global_port(None, None));
        assert!(!should_inject_global_port(None, Some("session-a")));
        assert!(!should_inject_global_port(Some(""), Some("session-a")));
        assert!(!should_inject_global_port(
            Some("invalid"),
            Some("session-a")
        ));
        assert!(!should_inject_global_port(None, Some("")));
    }

    #[test]
    fn launchers_only_reenter_the_app_binary() {
        let executable = Path::new("/Applications/My Agents.app/Contents/MacOS/MyAgents");
        let posix = build_posix_launcher(executable.to_str().unwrap(), CliPlatform::Macos);
        let windows = build_windows_launcher(r"C:\Program Files\MyAgents 100%\MyAgents.exe");

        assert!(posix.contains("exec '/Applications/My Agents.app/Contents/MacOS/MyAgents'"));
        assert!(posix.contains(CLI_BOOTSTRAP_ARG));
        assert!(!posix.contains("node"));
        assert!(windows.contains(r#""C:\Program Files\MyAgents 100%%\MyAgents.exe""#));
        assert!(windows.contains(CLI_BOOTSTRAP_ARG));
        assert!(!windows.contains("node.exe"));
        assert!(windows.contains(" %*\r\n"));
        assert!(windows.contains("exit /b %ERRORLEVEL%"));
    }

    #[cfg(unix)]
    #[test]
    fn posix_launcher_preserves_argv_stdio_cwd_env_and_exit_code() {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable_dir = temp.path().join("My Agent's 应用");
        fs::create_dir_all(&executable_dir).unwrap();
        let executable = executable_dir.join("MyAgents");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf 'arg=<%s>\\n' \"$@\"\nprintf 'cwd=<%s>\\n' \"$PWD\"\nprintf 'env=<%s>\\n' \"$MYAGENTS_TEST_ENV\"\nIFS= read -r line\nprintf 'stdin=<%s>\\n' \"$line\"\nprintf 'stderr-line\\n' >&2\nexit 23\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let launcher = temp.path().join("myagents");
        fs::write(
            &launcher,
            build_posix_launcher(executable.to_str().unwrap(), CliPlatform::Macos),
        )
        .unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755)).unwrap();
        let cwd = temp.path().join("working dir");
        fs::create_dir(&cwd).unwrap();

        #[allow(clippy::disallowed_methods)]
        let mut child = Command::new(&launcher)
            .args(["", "space value", "你好", r"trailing\", "double\"quote"])
            .current_dir(&cwd)
            .env("MYAGENTS_TEST_ENV", "环境 value")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all("input with spaces\n".as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();

        assert_eq!(output.status.code(), Some(23));
        assert!(stdout.contains(&format!("arg=<{CLI_BOOTSTRAP_ARG}>")));
        for expected in [
            "arg=<>",
            "arg=<space value>",
            "arg=<你好>",
            r"arg=<trailing\>",
            "arg=<double\"quote>",
        ] {
            assert!(
                stdout.contains(expected),
                "missing {expected:?} in {stdout:?}"
            );
        }
        let canonical_cwd = fs::canonicalize(&cwd).unwrap();
        assert!(stdout.contains(&format!("cwd=<{}>", canonical_cwd.display())));
        assert!(stdout.contains("env=<环境 value>"));
        assert!(stdout.contains("stdin=<input with spaces>"));
        assert_eq!(String::from_utf8(output.stderr).unwrap(), "stderr-line\n");
    }

    #[test]
    fn resource_locator_covers_packaged_platform_layouts() {
        let temp = tempfile::tempdir().unwrap();

        let mac_executable = temp.path().join("MyAgents.app/Contents/MacOS/MyAgents");
        let mac_resources = temp.path().join("MyAgents.app/Contents/Resources");
        fs::create_dir_all(mac_executable.parent().unwrap()).unwrap();
        write_runtime(&mac_resources, CliPlatform::Macos);
        assert_eq!(
            resolve_cli_runtime_from_executable(&mac_executable, CliPlatform::Macos, None)
                .unwrap()
                .script,
            fs::canonicalize(&mac_resources)
                .unwrap()
                .join("cli/myagents.cjs"),
        );

        let windows_executable = temp.path().join("Program Files/MyAgents/MyAgents.exe");
        let windows_resources = windows_executable.parent().unwrap().join("resources");
        fs::create_dir_all(windows_executable.parent().unwrap()).unwrap();
        write_runtime(&windows_resources, CliPlatform::Windows);
        assert_eq!(
            resolve_cli_runtime_from_executable(&windows_executable, CliPlatform::Windows, None,)
                .unwrap()
                .node,
            fs::canonicalize(&windows_resources)
                .unwrap()
                .join("nodejs/node.exe"),
        );

        let appdir = temp.path().join("appimage-mount");
        let linux_executable = appdir.join("usr/bin/myagents");
        let linux_resources = appdir.join("usr/lib/MyAgents");
        fs::create_dir_all(linux_executable.parent().unwrap()).unwrap();
        write_runtime(&linux_resources, CliPlatform::Linux);
        assert_eq!(
            resolve_cli_runtime_from_executable(&linux_executable, CliPlatform::Linux, None,)
                .unwrap()
                .script,
            fs::canonicalize(&linux_resources)
                .unwrap()
                .join("cli/myagents.cjs"),
        );
    }

    #[cfg(unix)]
    #[test]
    fn resource_locator_rejects_install_tree_escape_through_parent_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let install_root = temp.path().join("appimage-mount/usr");
        let executable = install_root.join("bin/myagents");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir_all(install_root.join("lib")).unwrap();

        let external_root = temp.path().join("external-runtime");
        write_runtime(&external_root, CliPlatform::Linux);
        symlink(&external_root, install_root.join("lib/MyAgents")).unwrap();

        let error =
            resolve_cli_runtime_from_executable(&executable, CliPlatform::Linux, None).unwrap_err();
        assert_eq!(error.code, "CLI_BUNDLE_RESOURCES_UNSAFE");
    }

    #[cfg(unix)]
    #[test]
    fn resource_locator_rejects_nested_runtime_escape() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let install_root = temp.path().join("appimage-mount/usr");
        let executable = install_root.join("bin/myagents");
        let resources = install_root.join("lib/MyAgents");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir_all(resources.join("cli")).unwrap();
        fs::write(resources.join("cli/myagents.cjs"), b"cli").unwrap();

        let external_root = temp.path().join("external-runtime");
        write_runtime(&external_root, CliPlatform::Linux);
        symlink(external_root.join("nodejs"), resources.join("nodejs")).unwrap();

        let error =
            resolve_cli_runtime_from_executable(&executable, CliPlatform::Linux, None).unwrap_err();
        assert_eq!(error.code, "CLI_BUNDLE_RESOURCES_UNSAFE");
    }

    #[test]
    fn legacy_payload_and_truthy_marker_converge_without_a_version_gate() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join(".myagents");
        let bin_dir = data_dir.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::write(
            bin_dir.join("myagents"),
            b"#!/usr/bin/env node\n// stale CLI business payload",
        )
        .unwrap();
        fs::write(bin_dir.join("myagents.cmd"), b"node old-cli.js %*").unwrap();
        fs::write(data_dir.join(".cli-version"), b"50").unwrap();
        fs::write(bin_dir.join(".myagents.tmp.new"), b"partial legacy write").unwrap();

        let executable = Path::new("/Applications/MyAgents.app/Contents/MacOS/MyAgents");
        assert!(reconcile_launchers(&data_dir, executable, CliPlatform::Macos).unwrap());
        assert!(!data_dir.join(".cli-version").exists());
        let launcher = fs::read_to_string(bin_dir.join("myagents")).unwrap();
        assert!(launcher.contains(CLI_BOOTSTRAP_ARG));
        assert!(!launcher.contains("stale CLI business payload"));
        assert_eq!(
            fs::read(bin_dir.join(".myagents.tmp.new")).unwrap(),
            b"partial legacy write",
        );
        assert!(!reconcile_launchers(&data_dir, executable, CliPlatform::Macos).unwrap());
    }

    #[test]
    fn launcher_installation_failure_is_retryable_without_a_marker() {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join(".myagents");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join("bin"), b"not a directory").unwrap();

        let executable = Path::new("/Applications/MyAgents.app/Contents/MacOS/MyAgents");
        let error = reconcile_launchers(&data_dir, executable, CliPlatform::Macos).unwrap_err();
        assert_eq!(error.code, "CLI_LAUNCHER_DIR_UNSAFE");
        assert!(!data_dir.join(".cli-version").exists());

        fs::remove_file(data_dir.join("bin")).unwrap();
        assert!(reconcile_launchers(&data_dir, executable, CliPlatform::Macos).unwrap());
    }

    #[test]
    fn missing_bundle_resources_fail_closed_and_can_be_repaired() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("usr/bin/myagents");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();

        let error =
            resolve_cli_runtime_from_executable(&executable, CliPlatform::Linux, None).unwrap_err();
        assert_eq!(error.code, "CLI_BUNDLE_RESOURCES_MISSING");

        let resources = temp.path().join("usr/lib/MyAgents");
        write_runtime(&resources, CliPlatform::Linux);
        assert!(resolve_cli_runtime_from_executable(&executable, CliPlatform::Linux, None).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn launcher_reconcile_replaces_symlink_without_writing_through_it() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join(".myagents");
        let bin_dir = data_dir.join("bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let external = temp.path().join("external-cli");
        fs::write(&external, b"do not change").unwrap();
        symlink(&external, bin_dir.join("myagents")).unwrap();

        reconcile_launchers(
            &data_dir,
            Path::new("/Applications/MyAgents.app/Contents/MacOS/MyAgents"),
            CliPlatform::Macos,
        )
        .unwrap();

        assert_eq!(fs::read(&external).unwrap(), b"do not change");
        assert!(fs::symlink_metadata(bin_dir.join("myagents"))
            .unwrap()
            .file_type()
            .is_file());
    }

    #[cfg(unix)]
    #[test]
    fn launcher_reconcile_rejects_a_symlinked_bin_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join(".myagents");
        let external_bin = temp.path().join("external-bin");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&external_bin).unwrap();
        symlink(&external_bin, data_dir.join("bin")).unwrap();

        let error = reconcile_launchers(
            &data_dir,
            Path::new("/Applications/MyAgents.app/Contents/MacOS/MyAgents"),
            CliPlatform::Macos,
        )
        .unwrap_err();

        assert_eq!(error.code, "CLI_LAUNCHER_DIR_UNSAFE");
        assert!(fs::read_dir(external_bin).unwrap().next().is_none());
    }
}
