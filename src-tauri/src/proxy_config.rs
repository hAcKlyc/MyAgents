// Shared proxy configuration reading from ~/.myagents/config.json
use serde::Deserialize;
use std::fs;

const DEFAULT_PROXY_PROTOCOL: &str = "http";
const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
const DEFAULT_PROXY_PORT: u16 = 7890;

/// Proxy settings from ~/.myagents/config.json
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub enabled: bool,
    pub protocol: Option<String>,  // "http" or "socks5"
    pub host: Option<String>,
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
pub fn read_proxy_settings() -> Option<ProxySettings> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".myagents").join("config.json");

    let content = fs::read_to_string(&config_path).ok()?;
    let config: PartialAppConfig = serde_json::from_str(&content).ok()?;

    config.proxy_settings.filter(|p| p.enabled)
}

/// Get proxy URL string from settings
pub fn get_proxy_url(settings: &ProxySettings) -> String {
    let protocol = settings.protocol.as_deref().unwrap_or(DEFAULT_PROXY_PROTOCOL);
    let host = settings.host.as_deref().unwrap_or(DEFAULT_PROXY_HOST);
    let port = settings.port.unwrap_or(DEFAULT_PROXY_PORT);

    format!("{}://{}:{}", protocol, host, port)
}

/// Build a reqwest client with user's proxy configuration
/// - If proxy is enabled in config, use it for external requests
/// - Always exclude localhost/127.0.0.1/::1 from proxy
pub fn build_client_with_proxy(
    builder: reqwest::ClientBuilder
) -> Result<reqwest::Client, reqwest::Error> {
    let final_builder = if let Some(proxy_settings) = read_proxy_settings() {
        let proxy_url = get_proxy_url(&proxy_settings);
        log::info!("[proxy_config] Using proxy for external requests: {}", proxy_url);

        // Configure proxy but exclude localhost
        let proxy = reqwest::Proxy::all(&proxy_url)?
            .no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1"));

        builder.proxy(proxy)
    } else {
        // No user proxy configured, disable all proxies (including system proxy)
        log::info!("[proxy_config] No proxy configured, using direct connection");
        builder.no_proxy()
    };

    final_builder.build()
}
