//! Shared proxy configuration module — one of four "pit of success" modules alongside
//! `local_http` (localhost HTTP clients), `process_cmd` (subprocess GUI flags),
//! and `system_binary` (system tool lookup).
//!
//! This module provides unified proxy configuration for:
//! 1. Tauri updater and app-owned signed runtime downloads (`build_client_with_proxy`)
//! 2. Bun Sidecar / Plugin Bridge → subprocess env injection (`apply_to_subprocess`)
//!
//! **All** child processes that may use `fetch()` or HTTP clients MUST call
//! `proxy_config::apply_to_subprocess()` before spawning. This ensures:
//! - User-configured proxy is injected when enabled for that request owner
//! - System proxy is inherited when not configured (like other normal apps)
//! - `NO_PROXY` always protects localhost (Bun's `fetch()` honors `HTTP_PROXY`)
//!
//! Configuration is read from `~/.myagents/config.json` and can be enabled/disabled
//! via Settings > General > Network Proxy.

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::{env, fs};

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

/// Default proxy protocol (when not specified in config)
const DEFAULT_PROXY_PROTOCOL: &str = "http";
/// Default proxy host (when not specified in config)
const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
/// Default proxy port (when not specified in config)
const DEFAULT_PROXY_PORT: u16 = 7890;

/// Comprehensive NO_PROXY list for all subprocess types.
/// Bun's `fetch()` honors HTTP_PROXY env vars — without this, inherited system
/// proxy would break internal localhost calls (admin-api, cron-tool, bridge, etc.).
/// Public so that `terminal.rs` can reuse the same constant (portable-pty uses
/// `CommandBuilder` instead of `std::process::Command`, so `apply_to_subprocess`
/// can't be called directly).
pub const LOCALHOST_NO_PROXY: &str = "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1";

pub const PROXY_INJECTED_MARKER_ENV: &str = "MYAGENTS_PROXY_INJECTED";
pub const PROXY_INHERITED_ENV_JSON: &str = "MYAGENTS_PROXY_INHERITED_ENV_JSON";

const PROXY_ENV_KEYS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];

/// Proxy settings from `~/.myagents/config.json`
///
/// # Example JSON
/// ```json
/// {
///   "proxySettings": {
///     "enabled": true,
///     "protocol": "http",
///     "host": "127.0.0.1",
///     "port": 7890
///   }
/// }
/// ```
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    /// Whether proxy is enabled
    pub enabled: bool,
    /// Proxy protocol: "http", "https", or "socks5"
    pub protocol: Option<String>,
    /// Proxy host (IP or domain)
    pub host: Option<String>,
    /// Proxy port (1-65535)
    pub port: Option<u16>,
    /// Optional general/provider scope. Missing scope means legacy "all".
    pub scope: Option<ProxyScopeSettings>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "mode")]
pub enum ProxyScopeSettings {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "custom")]
    Custom {
        /// Missing in legacy custom scopes means general requests used the app
        /// proxy. `Option` preserves field presence so a historical empty
        /// custom scope can still be distinguished from a new explicit zero
        /// selection.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "generalRequests"
        )]
        general_requests: Option<bool>,
        #[serde(default, rename = "providerIds")]
        provider_ids: Vec<String>,
    },
}

/// Partial app config for reading proxy settings
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    proxy_settings: Option<ProxySettings>,
}

fn read_proxy_settings_from_disk() -> Option<ProxySettings> {
    let home = dirs::home_dir()?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");

    // Read config file
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // File not existing is normal (first run or no proxy configured)
            return None;
        }
        Err(e) => {
            ulog_warn!(
                "[proxy_config] Failed to read config file {:?}: {}. \
                 Check file permissions.",
                config_path,
                e
            );
            return None;
        }
    };

    // Strip UTF-8 BOM if present (Windows editors inject BOM into config.json).
    // Helper centralized in utils/bom.rs (issue #170 #6).
    let content = strip_bom(&content);

    // Parse JSON
    let config: PartialAppConfig = match serde_json::from_str(content) {
        Ok(c) => c,
        Err(e) => {
            ulog_error!(
                "[proxy_config] Invalid JSON in {:?}: {}. \
                 Please check the configuration file format.",
                config_path,
                e
            );
            return None;
        }
    };

    config.proxy_settings
}

/// Read raw proxy settings from ~/.myagents/config.json.
/// Returns settings even when `enabled=false` so callers that propagate config
/// to sidecars can preserve scope and the disabled state.
pub fn read_raw_proxy_settings() -> Option<ProxySettings> {
    read_proxy_settings_from_disk()
}

/// Read proxy settings from ~/.myagents/config.json
/// Returns Some(ProxySettings) if proxy is enabled, None otherwise
/// Logs errors for invalid configuration to help users debug
pub fn read_proxy_settings() -> Option<ProxySettings> {
    read_proxy_settings_from_disk().filter(|p| p.enabled)
}

/// Get proxy URL string from settings with validation
/// Returns Result to ensure configuration is valid
pub fn get_proxy_url(settings: &ProxySettings) -> Result<String, String> {
    // Validate protocol
    let protocol = settings
        .protocol
        .as_deref()
        .unwrap_or(DEFAULT_PROXY_PROTOCOL);
    if !["http", "https", "socks5"].contains(&protocol) {
        return Err(format!(
            "Invalid proxy protocol '{}'. Supported: http, https, socks5",
            protocol
        ));
    }

    // Validate port
    let port = settings.port.unwrap_or(DEFAULT_PROXY_PORT);
    if port == 0 {
        return Err(format!(
            "Invalid proxy port: {}. Port must be between 1 and 65535",
            port
        ));
    }

    let host = settings.host.as_deref().unwrap_or(DEFAULT_PROXY_HOST);

    Ok(format!("{}://{}:{}", protocol, host, port))
}

pub fn normalized_proxy_scope(settings: &ProxySettings) -> ProxyScopeSettings {
    match &settings.scope {
        Some(ProxyScopeSettings::Custom {
            general_requests,
            provider_ids,
        }) => {
            let mut seen = std::collections::HashSet::new();
            let mut cleaned = Vec::new();
            for raw in provider_ids {
                let id = raw.trim();
                if id.is_empty() || !seen.insert(id.to_string()) {
                    continue;
                }
                cleaned.push(id.to_string());
            }
            if cleaned.is_empty() && general_requests.is_none() {
                ulog_warn!(
                    "[proxy_config] Empty custom proxy scope found; falling back to all providers"
                );
                ProxyScopeSettings::All
            } else {
                ProxyScopeSettings::Custom {
                    general_requests: Some(general_requests.unwrap_or(true)),
                    provider_ids: cleaned,
                }
            }
        }
        _ => ProxyScopeSettings::All,
    }
}

pub fn proxy_enabled_for_general_requests(settings: &ProxySettings) -> bool {
    if !settings.enabled {
        return false;
    }
    match normalized_proxy_scope(settings) {
        ProxyScopeSettings::All => true,
        ProxyScopeSettings::Custom {
            general_requests, ..
        } => general_requests.unwrap_or(true),
    }
}

pub fn proxy_enabled_for_provider(settings: &ProxySettings, provider_id: &str) -> bool {
    if !settings.enabled {
        return false;
    }
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return false;
    }
    match normalized_proxy_scope(settings) {
        ProxyScopeSettings::All => true,
        ProxyScopeSettings::Custom { provider_ids, .. } => {
            provider_ids.iter().any(|id| id == provider_id)
        }
    }
}

pub fn read_proxy_settings_for_general_requests() -> Option<ProxySettings> {
    read_proxy_settings().filter(proxy_enabled_for_general_requests)
}

pub fn read_proxy_settings_for_provider(provider_id: &str) -> Option<ProxySettings> {
    read_proxy_settings().filter(|settings| proxy_enabled_for_provider(settings, provider_id))
}

/// Snapshot proxy env vars before MyAgents overwrites them for a child process.
/// Node sidecar uses this to restore the real inherited baseline for providers
/// excluded by a custom proxy scope.
pub fn inherited_proxy_env_json() -> String {
    let mut snapshot = serde_json::Map::new();
    for key in PROXY_ENV_KEYS {
        if let Ok(value) = env::var(key) {
            snapshot.insert((*key).to_string(), serde_json::Value::String(value));
        }
    }
    serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".to_string())
}

/// Preserve inherited bypass rules while adding MyAgents' mandatory localhost
/// exclusions. Lowercase follows the precedence used by Undici/curl when both
/// casings are present.
pub fn inherited_no_proxy_with_localhost() -> String {
    let inherited = env::var("no_proxy")
        .ok()
        .or_else(|| env::var("NO_PROXY").ok());
    merge_no_proxy_with_localhost(inherited.as_deref())
}

fn merge_no_proxy_with_localhost(inherited: Option<&str>) -> String {
    let Some(raw) = inherited.map(str::trim).filter(|value| !value.is_empty()) else {
        return LOCALHOST_NO_PROXY.to_string();
    };
    if raw == "*" {
        return "*".to_string();
    }
    let mut entries = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && !entry.eq_ignore_ascii_case("[::1]"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut seen = entries
        .iter()
        .map(|entry| entry.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    for localhost in LOCALHOST_NO_PROXY.split(',') {
        if seen.insert(localhost.to_ascii_lowercase()) {
            entries.push(localhost.to_string());
        }
    }
    entries.join(",")
}

fn mark_proxy_injected(cmd: &mut Command) {
    cmd.env(PROXY_INJECTED_MARKER_ENV, "1");
    cmd.env(PROXY_INHERITED_ENV_JSON, inherited_proxy_env_json());
}

/// Apply MyAgents proxy policy to a child process `Command`.
///
/// This is the **only** approved way to configure proxy env vars for subprocesses.
/// Using manual `cmd.env("HTTP_PROXY", ...)` or `cmd.env_remove(...)` is forbidden —
/// it will silently break when the proxy policy changes.
///
/// Behavior:
/// - **Proxy enabled for general requests**: injects HTTP_PROXY/HTTPS_PROXY + NO_PROXY + marker flag
/// - **Proxy config invalid**: strips all proxy vars (fail-safe)
/// - **No general app proxy selected**: inherits system env + injects NO_PROXY to protect localhost
///
/// Returns `true` if explicit proxy was injected (for TypeScript-side snapshot logic).
pub fn apply_to_subprocess(cmd: &mut Command) -> bool {
    if let Some(proxy_settings) = read_proxy_settings_for_general_requests() {
        match get_proxy_url(&proxy_settings) {
            Ok(proxy_url) => {
                ulog_info!("[proxy_config] owner=general path=myagents-proxy");
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("NO_PROXY", LOCALHOST_NO_PROXY);
                cmd.env("no_proxy", LOCALHOST_NO_PROXY);
                // Issue #194 — `ALL_PROXY` (curl-style "use proxy for everything")
                // takes precedence over HTTP_PROXY/HTTPS_PROXY in many HTTP stacks
                // (reqwest, openssl, curl). If the launching env has an inherited
                // `ALL_PROXY` (Tauri started from a shell that exported it), it
                // would shadow the proxy we injected here, sending traffic via
                // the wrong upstream. Strip both casings.
                cmd.env_remove("ALL_PROXY");
                cmd.env_remove("all_proxy");
                // Flag + pre-injection baseline so TypeScript can distinguish
                // explicit MyAgents proxy injection from inherited system env.
                mark_proxy_injected(cmd);
                true
            }
            Err(e) => {
                ulog_error!(
                    "[proxy_config] Invalid proxy configuration: {}. \
                     Please check Settings > General > Network Proxy. \
                     Subprocess will start without proxy.",
                    e
                );
                for &var in PROXY_ENV_KEYS {
                    cmd.env_remove(var);
                }
                false
            }
        }
    } else {
        // No MyAgents proxy configured: inherit system network behavior.
        // CRITICAL: Still inject NO_PROXY to protect Bun's localhost fetch calls
        // from being routed through any inherited system proxy.
        ulog_debug!("[proxy_config] owner=general path=inherited");
        let no_proxy = inherited_no_proxy_with_localhost();
        cmd.env("NO_PROXY", &no_proxy);
        cmd.env("no_proxy", &no_proxy);
        false
    }
}

/// Provider-aware variant for provider-owned subprocesses. It injects the
/// MyAgents proxy only when the selected provider is in scope; otherwise it
/// leaves inherited system proxy behavior intact and only protects localhost.
pub fn apply_to_subprocess_for_provider(cmd: &mut Command, provider_id: &str) -> bool {
    if let Some(proxy_settings) = read_proxy_settings_for_provider(provider_id) {
        match get_proxy_url(&proxy_settings) {
            Ok(proxy_url) => {
                ulog_info!(
                    "[proxy_config] owner=provider providerId={} path=myagents-proxy",
                    provider_id
                );
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("NO_PROXY", LOCALHOST_NO_PROXY);
                cmd.env("no_proxy", LOCALHOST_NO_PROXY);
                cmd.env_remove("ALL_PROXY");
                cmd.env_remove("all_proxy");
                mark_proxy_injected(cmd);
                true
            }
            Err(e) => {
                ulog_error!(
                    "[proxy_config] Invalid proxy configuration for provider {}: {}. \
                     Provider subprocess will start without MyAgents proxy.",
                    provider_id,
                    e
                );
                for &var in PROXY_ENV_KEYS {
                    cmd.env_remove(var);
                }
                false
            }
        }
    } else {
        ulog_debug!(
            "[proxy_config] owner=provider providerId={} path=inherited",
            provider_id
        );
        let no_proxy = inherited_no_proxy_with_localhost();
        cmd.env("NO_PROXY", &no_proxy);
        cmd.env("no_proxy", &no_proxy);
        false
    }
}

/// Build a reqwest client with user's proxy configuration
/// - If proxy is enabled in config, use it for external requests (localhost excluded via NO_PROXY)
/// - If no proxy configured, inherit system network behavior (reqwest default proxy detection)
/// NOTE: This function is for OUTGOING requests only (CDN, IM APIs). Localhost
/// communication MUST use `local_http` module which unconditionally bypasses proxy.
pub fn build_client_with_proxy(builder: reqwest::ClientBuilder) -> Result<reqwest::Client, String> {
    let final_builder = if let Some(proxy_settings) = read_proxy_settings_for_general_requests() {
        let proxy_url = get_proxy_url(&proxy_settings)?;
        ulog_info!("[proxy_config] owner=general path=myagents-proxy");

        // Configure proxy but exclude localhost and all loopback addresses
        // Comprehensive NO_PROXY list for maximum compatibility:
        // - localhost, localhost.localdomain (common DNS names)
        // - 127.0.0.1, 127.0.0.0/8 (IPv4 loopback range)
        // - ::1 (IPv6 loopback; NO_PROXY uses host tokens, not URL brackets)
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("[proxy_config] Failed to create proxy: {}", e))?
            .no_proxy(reqwest::NoProxy::from_string(LOCALHOST_NO_PROXY));

        builder.proxy(proxy)
    } else {
        // No user proxy configured — inherit system network behavior.
        // Let reqwest use its default proxy detection (env vars + macOS system proxy).
        // This ensures the app respects system-level proxy (Clash TUN, global proxy, etc.)
        // just like other normal applications.
        ulog_info!("[proxy_config] owner=general path=inherited");
        builder
    };

    final_builder
        .build()
        .map_err(|e| format!("[proxy_config] Failed to build HTTP client: {}", e))
}

pub fn build_client_with_proxy_for_provider(
    builder: reqwest::ClientBuilder,
    provider_id: &str,
) -> Result<reqwest::Client, String> {
    let final_builder = if let Some(proxy_settings) = read_proxy_settings_for_provider(provider_id)
    {
        let proxy_url = get_proxy_url(&proxy_settings)?;
        ulog_info!(
            "[proxy_config] owner=provider providerId={} path=myagents-proxy",
            provider_id
        );
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("[proxy_config] Failed to create proxy: {}", e))?
            .no_proxy(reqwest::NoProxy::from_string(LOCALHOST_NO_PROXY));
        builder.proxy(proxy)
    } else {
        ulog_info!(
            "[proxy_config] owner=provider providerId={} path=inherited",
            provider_id
        );
        builder
    };

    final_builder
        .build()
        .map_err(|e| format!("[proxy_config] Failed to build HTTP client: {}", e))
}

/// Blocking twin of [`build_client_with_proxy_for_provider`].
///
/// OAuth refresh is intentionally executed while the cross-process credential
/// file lock is held so a rotating refresh token has exactly one consumer.
/// `with_file_lock` runs that closure on a blocking worker; this helper keeps
/// the same provider-scoped proxy semantics without open-coding proxy policy in
/// the Grok auth owner.
pub fn build_blocking_client_with_proxy_for_provider(
    builder: reqwest::blocking::ClientBuilder,
    provider_id: &str,
) -> Result<reqwest::blocking::Client, String> {
    let final_builder = if let Some(proxy_settings) = read_proxy_settings_for_provider(provider_id)
    {
        let proxy_url = get_proxy_url(&proxy_settings)?;
        ulog_info!(
            "[proxy_config] owner=provider providerId={} path=myagents-proxy blocking=true",
            provider_id
        );
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("[proxy_config] Failed to create proxy: {}", e))?
            .no_proxy(reqwest::NoProxy::from_string(LOCALHOST_NO_PROXY));
        builder.proxy(proxy)
    } else {
        ulog_info!(
            "[proxy_config] owner=provider providerId={} path=inherited blocking=true",
            provider_id
        );
        builder
    };

    final_builder
        .build()
        .map_err(|e| format!("[proxy_config] Failed to build blocking HTTP client: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_proxy_url_with_defaults() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: None,
            scope: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "http://127.0.0.1:7890");
    }

    #[test]
    fn test_get_proxy_url_with_custom_values() {
        let settings = ProxySettings {
            enabled: true,
            protocol: Some("socks5".to_string()),
            host: Some("192.168.1.1".to_string()),
            port: Some(1080),
            scope: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "socks5://192.168.1.1:1080");
    }

    #[test]
    fn test_get_proxy_url_invalid_protocol() {
        let settings = ProxySettings {
            enabled: true,
            protocol: Some("ftp".to_string()),
            host: None,
            port: None,
            scope: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid proxy protocol"));
    }

    #[test]
    fn test_get_proxy_url_zero_port() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: Some(0),
            scope: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid proxy port"));
    }

    #[test]
    fn test_get_proxy_url_https_protocol() {
        let settings = ProxySettings {
            enabled: true,
            protocol: Some("https".to_string()),
            host: Some("proxy.example.com".to_string()),
            port: Some(443),
            scope: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "https://proxy.example.com:443");
    }

    #[test]
    fn test_provider_scope_defaults_to_all() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: None,
            scope: None,
        };

        assert!(proxy_enabled_for_provider(&settings, "deepseek"));
    }

    #[test]
    fn test_provider_scope_custom_filters_by_provider() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: None,
            scope: Some(ProxyScopeSettings::Custom {
                general_requests: None,
                provider_ids: vec!["codex-sub".to_string(), "deepseek".to_string()],
            }),
        };

        assert!(proxy_enabled_for_provider(&settings, "codex-sub"));
        assert!(!proxy_enabled_for_provider(&settings, "anthropic-sub"));
    }

    #[test]
    fn test_provider_scope_deserializes_camel_case_provider_ids() {
        let settings: ProxySettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "scope": { "mode": "custom", "providerIds": ["codex-sub"] }
        }))
        .unwrap();

        assert!(proxy_enabled_for_provider(&settings, "codex-sub"));
        assert!(!proxy_enabled_for_provider(&settings, "deepseek"));
        assert_eq!(
            serde_json::to_value(settings.scope.unwrap()).unwrap(),
            serde_json::json!({ "mode": "custom", "providerIds": ["codex-sub"] })
        );
    }

    #[test]
    fn test_empty_custom_provider_scope_falls_back_to_all() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: None,
            scope: Some(ProxyScopeSettings::Custom {
                general_requests: None,
                provider_ids: vec![],
            }),
        };

        assert!(proxy_enabled_for_provider(&settings, "deepseek"));
    }

    #[test]
    fn test_general_scope_legacy_custom_defaults_to_enabled() {
        let settings: ProxySettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "scope": { "mode": "custom", "providerIds": ["codex-sub"] }
        }))
        .unwrap();

        assert!(proxy_enabled_for_general_requests(&settings));
        assert_eq!(
            serde_json::to_value(normalized_proxy_scope(&settings)).unwrap(),
            serde_json::json!({
                "mode": "custom",
                "generalRequests": true,
                "providerIds": ["codex-sub"]
            })
        );
    }

    #[test]
    fn test_general_and_provider_scope_are_independent() {
        let settings: ProxySettings = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "scope": {
                "mode": "custom",
                "generalRequests": false,
                "providerIds": ["codex-sub"]
            }
        }))
        .unwrap();

        assert!(!proxy_enabled_for_general_requests(&settings));
        assert!(proxy_enabled_for_provider(&settings, "codex-sub"));
        assert!(!proxy_enabled_for_provider(&settings, "deepseek"));
    }

    #[test]
    fn test_explicit_empty_custom_scope_is_preserved() {
        for general_requests in [true, false] {
            let settings: ProxySettings = serde_json::from_value(serde_json::json!({
                "enabled": true,
                "scope": {
                    "mode": "custom",
                    "generalRequests": general_requests,
                    "providerIds": []
                }
            }))
            .unwrap();

            assert_eq!(
                normalized_proxy_scope(&settings),
                ProxyScopeSettings::Custom {
                    general_requests: Some(general_requests),
                    provider_ids: vec![],
                }
            );
            assert_eq!(
                proxy_enabled_for_general_requests(&settings),
                general_requests
            );
            assert!(!proxy_enabled_for_provider(&settings, "deepseek"));
        }
    }

    #[test]
    fn test_inherited_no_proxy_keeps_existing_entries_and_localhost() {
        let merged = merge_no_proxy_with_localhost(Some(".corp.local,localhost,[::1]"));
        assert!(merged.split(',').any(|entry| entry == ".corp.local"));
        assert!(merged.split(',').any(|entry| entry == "127.0.0.0/8"));
        assert!(merged.split(',').any(|entry| entry == "::1"));
        assert!(!merged.split(',').any(|entry| entry == "[::1]"));
        assert_eq!(merge_no_proxy_with_localhost(Some("*")), "*");
    }
}
