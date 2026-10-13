use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};
#[path = "src/resource_signature_core.rs"]
mod resource_signature;
mod build_cliproxy;
#[path = "src/cliproxy_policy.rs"]
mod cliproxy_policy;

const SPACE_BUILD_ENV_KEYS: &[&str] = &[
    "MYAGENTS_SPACE_ENABLED",
    "MYAGENTS_SPACE_BASE_URL",
    "MYAGENTS_SPACE_DEV_BASE_URL",
    "MYAGENTS_SPACE_PUBLIC_CLIENT_ID",
    "MYAGENTS_SPACE_CLIENT_ID",
    "MYAGENTS_AGENT_NETWORK_SERVICE_ID",
    "MYAGENTS_AGENT_NETWORK_DEV_SERVICE_ID",
];
const MANAGED_CODEX_RUNTIME_LOCK_PATH: &str = "../src/shared/managed-codex-runtime.json";
const MANAGED_BROWSER_RUNTIME_LOCK_PATH: &str = "../src/shared/managed-browser-runtime.json";
const DSH_RELEASE_LOCK_PATH: &str = "../src/shared/integrated-runtimes/dsh-lock.json";
const DSH_BUILD_SELECTION_PATH: &str = "resources/integrated-runtimes/dsh-build-selection-v1.json";

fn expose_app_build_profile() {
    println!("cargo:rerun-if-env-changed=MYAGENTS_BUILD_PROFILE");
    println!("cargo:rustc-check-cfg=cfg(myagents_moxbot)");
    let profile = match env::var("MYAGENTS_BUILD_PROFILE").as_deref() {
        Err(env::VarError::NotPresent) | Ok("myagents") => "myagents",
        Ok("moxbot") => {
            println!("cargo:rustc-cfg=myagents_moxbot");
            "moxbot"
        }
        _ => panic!("MYAGENTS_BUILD_PROFILE must be myagents or moxbot"),
    };
    let target_os =
        env::var("CARGO_CFG_TARGET_OS").expect("Cargo must provide CARGO_CFG_TARGET_OS");
    let reader_enabled = env::var_os("CARGO_FEATURE_MOXBOT_CREDENTIAL_READER").is_some();
    if target_os == "macos" && profile == "moxbot" && !reader_enabled {
        panic!(
            "macOS MoXBots builds require the moxbot-credential-reader feature; use scripts/build-moxbot.mjs with the verified reader artifact"
        );
    }
}

fn main() {
    expose_app_build_profile();
    // Build-script executables can outlive their compilation checkout. Cargo's
    // invocation environment owns the inputs for the build running now.
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR is required");
    let package_path = manifest_dir.join("../package.json");
    println!("cargo:rerun-if-changed={}", package_path.display());
    let package: serde_json::Value = serde_json::from_str(&fs::read_to_string(package_path).expect("package.json")).expect("package.json JSON");
    let sdk = package["dependencies"]["@anthropic-ai/claude-agent-sdk"].as_str().expect("pinned Claude SDK version");
    println!("cargo:rustc-env=MYAGENTS_CLAUDE_SDK_VERSION={sdk}");
    build_cliproxy::verify_bundle(package["version"].as_str().expect("App version"));
    expose_managed_codex_runtime_lock();
    expose_managed_browser_runtime_lock();
    expose_dsh_build_lock();
    expose_space_build_env();
    prepare_incremental_tauri_resource_output();
    tauri_build::build()
}

fn expose_dsh_build_lock() {
    let root = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR is required");
    let release_path = root.join(DSH_RELEASE_LOCK_PATH);
    let selection_path = root.join(DSH_BUILD_SELECTION_PATH);
    println!("cargo:rerun-if-changed={}", release_path.display());
    println!("cargo:rerun-if-changed={}", selection_path.display());
    let lock: serde_json::Value = if selection_path.exists() {
        let selection: serde_json::Value = serde_json::from_slice(
            &fs::read(&selection_path).expect("DSH build selection"),
        ).expect("DSH build selection JSON");
        selection.get("lock").cloned().expect("DSH build selection lock")
    } else {
        serde_json::from_slice(&fs::read(release_path).expect("DSH release lock"))
            .expect("DSH release lock JSON")
    };
    println!("cargo:rustc-env=MYAGENTS_DSH_EFFECTIVE_LOCK_JSON={lock}");
}

/// Tauri copies bundle resources beside the binary without removing files that
/// disappeared from a prior inventory. It also preserves the sealed handoff's
/// read-only permissions. Reset only the generated integrated-runtime copy so
/// every build starts from the exact current inventory. Never mutate the
/// accepted handoff itself.
fn prepare_incremental_tauri_resource_output() {
    let Some(out_dir) = env::var_os("OUT_DIR") else {
        return;
    };
    // tauri-build copies bundle resources beside the debug/release binary,
    // three levels above Cargo's package-specific OUT_DIR.
    let out_dir = PathBuf::from(out_dir);
    let Some(target_dir) = out_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
    else {
        return;
    };
    let generated_runtime_root = target_dir.join("integrated-runtimes");
    if !generated_runtime_root.exists() {
        return;
    }
    make_generated_tree_owner_writable(&generated_runtime_root).unwrap_or_else(|error| {
        panic!(
            "Failed to prepare generated integrated-runtime resources {}: {error}",
            generated_runtime_root.display()
        )
    });
    fs::remove_dir_all(&generated_runtime_root).unwrap_or_else(|error| {
        panic!(
            "Failed to reset generated integrated-runtime resources {}: {error}",
            generated_runtime_root.display()
        )
    });
}

fn make_generated_tree_owner_writable(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            make_generated_tree_owner_writable(&entry?.path())?;
        }
    }

    let mut permissions = metadata.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let required = if metadata.is_dir() { 0o700 } else { 0o200 };
        permissions.set_mode(permissions.mode() | required);
    }
    #[cfg(windows)]
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

fn expose_managed_browser_runtime_lock() {
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR is required");
    let lock_path = manifest_dir.join(MANAGED_BROWSER_RUNTIME_LOCK_PATH);
    println!("cargo:rerun-if-changed={}", lock_path.display());
    let content = fs::read_to_string(&lock_path).unwrap_or_else(|error| {
        panic!(
            "Failed to read Browser runtime lock {}: {error}",
            lock_path.display()
        )
    });
    let lock: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|error| {
        panic!(
            "Invalid Browser runtime lock {}: {error}",
            lock_path.display()
        )
    });
    if lock
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(2)
    {
        panic!(
            "Browser runtime lock {} requires schemaVersion 2",
            lock_path.display()
        );
    }
    let runtime_set = required_runtime_lock_string(&lock, "runtimeSet", &lock_path);
    let revision = required_runtime_lock_string(&lock, "chromiumRevision", &lock_path);
    let browser_version = required_runtime_lock_string(&lock, "chromiumBrowserVersion", &lock_path);
    let playwright_mcp_version =
        required_runtime_lock_string(&lock, "playwrightMcpVersion", &lock_path);
    let playwright_core_version =
        required_runtime_lock_string(&lock, "playwrightCoreVersion", &lock_path);
    if !runtime_set
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        panic!("Browser runtimeSet contains unsupported characters: {runtime_set:?}");
    }
    if !revision.bytes().all(|byte| byte.is_ascii_digit()) {
        panic!("Browser chromiumRevision must be numeric: {revision:?}");
    }
    let artifacts = lock
        .get("officialArtifacts")
        .and_then(serde_json::Value::as_object)
        .unwrap_or_else(|| {
            panic!(
                "Browser runtime lock {} requires officialArtifacts",
                lock_path.display()
            )
        });
    let supported_platforms = [
        "darwin-arm64",
        "darwin-x64",
        "win32-x64",
        "linux-x64",
        "linux-arm64",
    ];
    if artifacts.len() != supported_platforms.len() {
        panic!(
            "Browser runtime lock {} must contain exactly the supported official artifacts",
            lock_path.display()
        );
    }
    for platform in supported_platforms {
        let artifact = artifacts.get(platform).unwrap_or_else(|| {
            panic!(
                "Browser runtime lock {} is missing official artifact {platform}",
                lock_path.display()
            )
        });
        validate_browser_official_artifact(
            artifact,
            platform,
            browser_version,
            revision,
            &lock_path,
        );
    }
    let target_platform = match (
        env::var("CARGO_CFG_TARGET_OS").as_deref(),
        env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
    ) {
        (Ok("macos"), Ok("aarch64")) => Some("darwin-arm64"),
        (Ok("macos"), Ok("x86_64")) => Some("darwin-x64"),
        (Ok("windows"), Ok("x86_64")) => Some("win32-x64"),
        (Ok("linux"), Ok("x86_64")) => Some("linux-x64"),
        (Ok("linux"), Ok("aarch64")) => Some("linux-arm64"),
        _ => None,
    };
    let target_artifact = target_platform.and_then(|platform| artifacts.get(platform));
    let artifact_string = |key: &str| {
        target_artifact
            .and_then(|artifact| artifact.get(key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
    };
    let archive_size = target_artifact
        .and_then(|artifact| artifact.get("archiveSizeBytes"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let unpacked_size = target_artifact
        .and_then(|artifact| artifact.get("unpackedSizeBytes"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let entry_count = target_artifact
        .and_then(|artifact| artifact.get("entryCount"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    println!("cargo:rustc-env=MYAGENTS_BROWSER_RUNTIME_SET={runtime_set}");
    println!("cargo:rustc-env=MYAGENTS_BROWSER_REVISION={revision}");
    println!("cargo:rustc-env=MYAGENTS_BROWSER_VERSION={browser_version}");
    println!("cargo:rustc-env=MYAGENTS_BROWSER_PLAYWRIGHT_MCP_VERSION={playwright_mcp_version}");
    println!("cargo:rustc-env=MYAGENTS_BROWSER_PLAYWRIGHT_CORE_VERSION={playwright_core_version}");
    println!(
        "cargo:rustc-env=MYAGENTS_BROWSER_ARTIFACT_SOURCE_URL={}",
        artifact_string("sourceUrl")
    );
    println!(
        "cargo:rustc-env=MYAGENTS_BROWSER_ARTIFACT_URL={}",
        artifact_string("url")
    );
    println!(
        "cargo:rustc-env=MYAGENTS_BROWSER_ARTIFACT_SHA256={}",
        artifact_string("sha256")
    );
    println!("cargo:rustc-env=MYAGENTS_BROWSER_ARTIFACT_SIZE={archive_size}");
    println!("cargo:rustc-env=MYAGENTS_BROWSER_UNPACKED_SIZE={unpacked_size}");
    println!("cargo:rustc-env=MYAGENTS_BROWSER_ENTRY_COUNT={entry_count}");
    println!(
        "cargo:rustc-env=MYAGENTS_BROWSER_ARCHIVE_ROOT={}",
        artifact_string("archiveRoot")
    );
    println!(
        "cargo:rustc-env=MYAGENTS_BROWSER_EXECUTABLE_RELATIVE_PATH={}",
        artifact_string("executableRelativePath")
    );
}

fn validate_browser_official_artifact(
    artifact: &serde_json::Value,
    platform: &str,
    browser_version: &str,
    revision: &str,
    lock_path: &Path,
) {
    let field = |key: &str| {
        artifact
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                panic!(
                    "Browser runtime lock {} artifact {platform} requires {key}",
                    lock_path.display()
                )
            })
    };
    let source_url = field("sourceUrl");
    let url = field("url");
    let sha256 = field("sha256");
    let archive_root = field("archiveRoot");
    let executable = field("executableRelativePath");
    let archive_size = artifact
        .get("archiveSizeBytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let unpacked_size = artifact
        .get("unpackedSizeBytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let entry_count = artifact
        .get("entryCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let (expected_suffix, expected_root, expected_executable) = match platform {
        "darwin-arm64" => (
            "mac-arm64/chrome-mac-arm64.zip",
            "chrome-mac-arm64",
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        "darwin-x64" => (
            "mac-x64/chrome-mac-x64.zip",
            "chrome-mac-x64",
            "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
        "win32-x64" => (
            "win64/chrome-win64.zip",
            "chrome-win64",
            "chrome-win64/chrome.exe",
        ),
        "linux-x64" => (
            "linux64/chrome-linux64.zip",
            "chrome-linux64",
            "chrome-linux64/chrome",
        ),
        "linux-arm64" => (
            "chromium-linux-arm64.zip",
            "chrome-linux",
            "chrome-linux/chrome",
        ),
        _ => unreachable!("supported Browser platform"),
    };
    let official_source = source_url.starts_with("https://cdn.playwright.dev/")
        && if platform == "linux-arm64" {
            source_url.contains(&format!("/builds/chromium/{revision}/"))
        } else {
            source_url.contains(&format!("/builds/cft/{browser_version}/"))
        };
    let official_download = url
        .starts_with("https://storage.googleapis.com/chrome-for-testing-public/")
        || url.starts_with("https://playwright.download.prss.microsoft.com/")
        || url.starts_with("https://cdn.playwright.dev/builds/chromium/");
    let locked_download_version = if platform == "linux-arm64" {
        url.contains(&format!("/builds/chromium/{revision}/"))
    } else {
        url.contains(&format!("/{browser_version}/"))
    };
    if !official_source
        || !official_download
        || !locked_download_version
        || !source_url.ends_with(expected_suffix)
        || !url.ends_with(expected_suffix)
        || sha256.len() != 64
        || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || archive_size == 0
        || archive_size > 512 * 1024 * 1024
        || unpacked_size == 0
        || unpacked_size > 1024 * 1024 * 1024
        || entry_count == 0
        || entry_count > 6000
        || archive_root.contains('/')
        || archive_root.contains('\\')
        || archive_root != expected_root
        || executable != expected_executable
        || executable.contains("..")
        || executable.contains('\\')
    {
        panic!(
            "Browser runtime lock {} has invalid official artifact {platform}",
            lock_path.display()
        );
    }
}

fn expose_managed_codex_runtime_lock() {
    let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .expect("CARGO_MANIFEST_DIR is required");
    let lock_path = manifest_dir.join(MANAGED_CODEX_RUNTIME_LOCK_PATH);
    println!("cargo:rerun-if-changed={}", lock_path.display());

    let content = fs::read_to_string(&lock_path).unwrap_or_else(|error| {
        panic!(
            "Failed to read Managed Codex runtime lock {}: {error}",
            lock_path.display()
        )
    });
    let lock: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|error| {
        panic!(
            "Invalid Managed Codex runtime lock {}: {error}",
            lock_path.display()
        )
    });
    let version = required_runtime_lock_string(&lock, "version", &lock_path);

    if !is_canonical_runtime_version(version) {
        panic!("Managed Codex version must be canonical semver without surrounding whitespace: {version:?}");
    }
    let runtime_set = format!("codex-{version}");

    println!("cargo:rustc-env=MYAGENTS_MANAGED_CODEX_VERSION={version}");
    println!("cargo:rustc-env=MYAGENTS_MANAGED_CODEX_RUNTIME_SET={runtime_set}");
}

fn is_canonical_runtime_version(version: &str) -> bool {
    if version.is_empty() || version.trim() != version {
        return false;
    }
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let mut core_parts = core.split('.');
    let core_valid = (0..3).all(|_| {
        core_parts
            .next()
            .map(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .unwrap_or(false)
    }) && core_parts.next().is_none();
    let prerelease_valid = prerelease
        .map(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        })
        .unwrap_or(true);
    core_valid && prerelease_valid
}

fn required_runtime_lock_string<'a>(
    lock: &'a serde_json::Value,
    key: &str,
    path: &Path,
) -> &'a str {
    lock.get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            panic!(
                "Managed Codex runtime lock {} requires non-empty string field {key}",
                path.display()
            )
        })
}

fn expose_space_build_env() {
    for key in SPACE_BUILD_ENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let root_env_path = env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .and_then(|manifest_dir| manifest_dir.parent().map(|root| root.join(".env")));

    let file_env = root_env_path
        .as_ref()
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            read_space_env_file(path)
        })
        .unwrap_or_default();

    let mut resolved_env = SPACE_BUILD_ENV_KEYS
        .iter()
        .filter_map(|key| {
            env::var(key)
                .ok()
                .or_else(|| file_env.get(*key).cloned())
                .map(|value| ((*key).to_string(), value))
        })
        .collect::<HashMap<_, _>>();

    // Public deployment identities, never credentials. Keep official builds
    // usable without requiring a new local .env entry on every developer/CI.
    resolved_env.entry("MYAGENTS_AGENT_NETWORK_SERVICE_ID".to_string())
        .or_insert_with(|| "98b5376a-4750-49e6-ae82-c5de39b7afef".to_string());
    resolved_env.entry("MYAGENTS_AGENT_NETWORK_DEV_SERVICE_ID".to_string())
        .or_insert_with(|| "c25f1f29-8ac8-4da8-9f7b-c16c9d6c5ac5".to_string());

    if env::var("PROFILE").as_deref() == Ok("release") {
        // An inherited process env is visible to `option_env!` even when it is
        // absent from our resolved map. Emit an explicit empty value so a
        // release rustc invocation cannot accidentally bake in the Dev origin.
        resolved_env.insert("MYAGENTS_SPACE_DEV_BASE_URL".to_string(), String::new());
        resolved_env.insert("MYAGENTS_AGENT_NETWORK_DEV_SERVICE_ID".to_string(), String::new());
    } else if resolved_env
        .get("MYAGENTS_SPACE_DEV_BASE_URL")
        .map(|value| value.trim().is_empty())
        .unwrap_or(false)
    {
        resolved_env.remove("MYAGENTS_SPACE_DEV_BASE_URL");
    }

    normalize_space_build_env(&mut resolved_env);

    for key in SPACE_BUILD_ENV_KEYS {
        if let Some(value) = resolved_env.get(*key) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn read_space_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    content
        .lines()
        .filter_map(parse_space_env_line)
        .collect::<HashMap<_, _>>()
}

fn parse_space_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let trimmed = trimmed
        .strip_prefix("export ")
        .unwrap_or(trimmed)
        .trim_start();
    let (key, value) = trimmed.split_once('=')?;
    let key = key.trim();
    if !SPACE_BUILD_ENV_KEYS.contains(&key) {
        return None;
    }

    Some((key.to_string(), parse_env_value(value)))
}

fn parse_env_value(value: &str) -> String {
    let value = strip_unquoted_comment(value.trim()).trim();
    if let Some(unquoted) = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
    {
        return unquoted.to_string();
    }
    if let Some(unquoted) = value
        .strip_prefix('\'')
        .and_then(|inner| inner.strip_suffix('\''))
    {
        return unquoted.to_string();
    }

    value.to_string()
}

fn strip_unquoted_comment(value: &str) -> &str {
    let mut quote: Option<char> = None;
    for (index, ch) in value.char_indices() {
        match ch {
            '"' | '\'' if quote == Some(ch) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(ch),
            '#' if quote.is_none() => return value[..index].trim_end(),
            _ => {}
        }
    }
    value
}

fn normalize_space_build_env(values: &mut HashMap<String, String>) {
    let enabled = values
        .get("MYAGENTS_SPACE_ENABLED")
        .map(String::as_str)
        .map(space_enabled_flag)
        .unwrap_or(false);
    if !enabled {
        return;
    }

    let base_url = values
        .get("MYAGENTS_SPACE_BASE_URL")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    match normalize_space_base_url("MYAGENTS_SPACE_BASE_URL", base_url) {
        Ok(normalized) => {
            values.insert("MYAGENTS_SPACE_BASE_URL".to_string(), normalized);
        }
        Err(error) => panic!("Invalid Space build configuration: {error}"),
    }

    if let Some(dev_url) = values
        .get("MYAGENTS_SPACE_DEV_BASE_URL")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match normalize_space_base_url("MYAGENTS_SPACE_DEV_BASE_URL", dev_url) {
            Ok(normalized) => {
                values.insert("MYAGENTS_SPACE_DEV_BASE_URL".to_string(), normalized);
            }
            Err(error) => panic!("Invalid Space Dev build configuration: {error}"),
        }
    }
}

fn space_enabled_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn normalize_space_base_url(key: &str, raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err(format!(
            "{key} is required when MYAGENTS_SPACE_ENABLED=true"
        ));
    }
    let mut url = url::Url::parse(raw).map_err(|error| format!("Invalid {key}: {error}"))?;
    if url.scheme() != "https" {
        return Err(format!("{key} must use https"));
    }
    if url.host_str().is_none() {
        return Err(format!("{key} must include a host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{key} must not include credentials"));
    }
    if url.path() != "/" {
        return Err(format!("{key} must not include a path"));
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}
