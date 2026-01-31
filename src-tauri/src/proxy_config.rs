//! Shared proxy configuration module
//!
//! This module provides unified proxy configuration for:
//! 1. Tauri updater → CDN downloads
//! 2. Bun Sidecar → Claude Agent SDK → Anthropic API
//!
//! Configuration is read from `~/.myagents/config.json` and can be enabled/disabled
//! via Settings > About > Developer Mode > Proxy Settings.
//!
//! Note: Localhost connections always bypass proxy (NO_PROXY is automatically set).

use serde::Deserialize;
use std::fs;

/// Default proxy protocol (when not specified in config)
const DEFAULT_PROXY_PROTOCOL: &str = "http";
/// Default proxy host (when not specified in config)
const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
/// Default proxy port (when not specified in config)
const DEFAULT_PROXY_PORT: u16 = 7890;

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
}

/// Partial app config for reading proxy settings
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    proxy_settings: Option<ProxySettings>,
}

/// Read proxy settings from ~/.myagents/config.json
/// Returns Some(ProxySettings) if proxy is enabled, None otherwise
/// Logs errors for invalid configuration to help users debug
pub fn read_proxy_settings() -> Option<ProxySettings> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".myagents").join("config.json");

    // Read config file
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // File not existing is normal (first run or no proxy configured)
            return None;
        }
        Err(e) => {
            log::warn!(
                "[proxy_config] Failed to read config file {:?}: {}. \
                 Check file permissions.",
                config_path, e
            );
            return None;
        }
    };

    // Parse JSON
    let config: PartialAppConfig = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(e) => {
            log::error!(
                "[proxy_config] Invalid JSON in {:?}: {}. \
                 Please check the configuration file format.",
                config_path, e
            );
            return None;
        }
    };

    config.proxy_settings.filter(|p| p.enabled)
}

/// Get proxy URL string from settings with validation
/// Returns Result to ensure configuration is valid
pub fn get_proxy_url(settings: &ProxySettings) -> Result<String, String> {
    // Validate protocol
    let protocol = settings.protocol.as_deref().unwrap_or(DEFAULT_PROXY_PROTOCOL);
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

/// Build a reqwest client with user's proxy configuration
/// - If proxy is enabled in config, use it for external requests
/// - Always exclude localhost/127.0.0.1/::1 from proxy
pub fn build_client_with_proxy(
    builder: reqwest::ClientBuilder
) -> Result<reqwest::Client, String> {
    let final_builder = if let Some(proxy_settings) = read_proxy_settings() {
        let proxy_url = get_proxy_url(&proxy_settings)?;
        log::info!("[proxy_config] Using proxy for external requests: {}", proxy_url);

        // Configure proxy but exclude localhost and all loopback addresses
        // Comprehensive NO_PROXY list for maximum compatibility:
        // - localhost, localhost.localdomain (common DNS names)
        // - 127.0.0.1, 127.0.0.0/8 (IPv4 loopback range)
        // - ::1, [::1] (IPv6 loopback with/without brackets)
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("[proxy_config] Failed to create proxy: {}", e))?
            .no_proxy(reqwest::NoProxy::from_string(
                "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]"
            ));

        builder.proxy(proxy)
    } else {
        // No user proxy configured, disable all proxies (including system proxy)
        log::info!("[proxy_config] No proxy configured, using direct connection");
        builder.no_proxy()
    };

    final_builder.build()
        .map_err(|e| format!("[proxy_config] Failed to build HTTP client: {}", e))
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
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "https://proxy.example.com:443");
    }
}
