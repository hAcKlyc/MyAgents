//! QR-based credential provisioning for IM Channel setup.
//!
//! This is deliberately separate from Plugin Bridge runtime QR login. Providers
//! such as WeCom and Feishu create a new bot/application and return credentials;
//! the existing Channel config owner persists those credentials afterwards.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ulog_info, ulog_warn};

const FEISHU_REGISTRATION_URL: &str = "https://accounts.feishu.cn/oauth/v1/app/registration";
const LARK_REGISTRATION_URL: &str = "https://accounts.larksuite.com/oauth/v1/app/registration";
const DEFAULT_FEISHU_POLL_INTERVAL_MS: u64 = 5_000;
const DEFAULT_FEISHU_EXPIRES_IN_MS: u64 = 600_000;
const DEFAULT_WECOM_POLL_INTERVAL_MS: u64 = 3_000;
const DEFAULT_WECOM_EXPIRES_IN_MS: u64 = 600_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CredentialQrProvider {
    Wecom,
    Feishu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FeishuRegistrationDomain {
    Feishu,
    Lark,
}

impl FeishuRegistrationDomain {
    fn from_session_value(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("feishu") {
            "feishu" => Ok(Self::Feishu),
            "lark" => Ok(Self::Lark),
            _ => Err("Unsupported Feishu registration domain".to_string()),
        }
    }

    fn registration_url(self) -> &'static str {
        match self {
            Self::Feishu => FEISHU_REGISTRATION_URL,
            Self::Lark => LARK_REGISTRATION_URL,
        }
    }

    fn session_value(self) -> &'static str {
        match self {
            Self::Feishu => "feishu",
            Self::Lark => "lark",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialQrStartResult {
    pub session_key: String,
    pub qr_url: String,
    pub session_domain: Option<String>,
    pub poll_interval_ms: u64,
    pub expires_in_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialQrPollResult {
    /// waiting | success | expired | cancelled | denied
    pub status: String,
    pub config_values: Option<BTreeMap<String, String>>,
    pub allowed_user_id: Option<String>,
    pub session_domain: Option<String>,
    pub next_poll_interval_ms: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
struct FeishuBeginResult {
    device_code: String,
    qr_url: String,
    poll_interval_ms: u64,
    expires_in_ms: u64,
}

/// Provider-generated handles are opaque. Validate bounds without changing
/// their identity; the transport must encode them as one query/form value.
pub(crate) fn validate_session_key(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 2_048 || value.chars().any(char::is_control) {
        return Err("Invalid QR provisioning session".to_string());
    }
    Ok(())
}

fn validated_qr_url(raw: &str, allowed_hosts: &[&str]) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid QR provisioning URL".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !url
            .host_str()
            .is_some_and(|host| allowed_hosts.contains(&host))
    {
        return Err("Untrusted QR provisioning URL".to_string());
    }
    Ok(url.to_string())
}

fn parse_feishu_begin(value: &Value) -> Result<FeishuBeginResult, String> {
    let device_code = value
        .get("device_code")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Feishu QR response is missing a device code".to_string())?
        .to_string();
    validate_session_key(&device_code)?;

    let raw_qr_url = value
        .get("verification_uri_complete")
        .and_then(Value::as_str)
        .ok_or_else(|| "Feishu QR response is missing a verification URL".to_string())?;
    let trusted_qr_url = validated_qr_url(
        raw_qr_url,
        &[
            "accounts.feishu.cn",
            "accounts.larksuite.com",
            "open.feishu.cn",
            "open.larksuite.com",
        ],
    )?;
    let mut qr_url = reqwest::Url::parse(&trusted_qr_url)
        .map_err(|_| "Invalid Feishu QR verification URL".to_string())?;
    // Match the official onboarding package. This identifies the QR as an
    // application-onboarding flow on the provider page.
    qr_url.query_pairs_mut().append_pair("from", "onboard");

    let poll_interval_ms = value
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_FEISHU_POLL_INTERVAL_MS / 1_000)
        .clamp(1, 60)
        * 1_000;
    let expires_in_ms = value
        .get("expires_in")
        .or_else(|| value.get("expire_in"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_FEISHU_EXPIRES_IN_MS / 1_000)
        .clamp(30, 3_600)
        * 1_000;

    Ok(FeishuBeginResult {
        device_code,
        qr_url: qr_url.to_string(),
        poll_interval_ms,
        expires_in_ms,
    })
}

fn response_requests_lark(value: &Value) -> bool {
    value
        .pointer("/user_info/tenant_brand")
        .and_then(Value::as_str)
        == Some("lark")
}

fn parse_feishu_poll(
    value: &Value,
    domain: FeishuRegistrationDomain,
    current_poll_interval_ms: u64,
) -> Result<CredentialQrPollResult, String> {
    let has_credential_fields =
        value.get("client_id").is_some() || value.get("client_secret").is_some();
    if has_credential_fields {
        let app_id = value
            .get("client_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Feishu QR response returned incomplete credentials".to_string())?;
        let app_secret = value
            .get("client_secret")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Feishu QR response returned incomplete credentials".to_string())?;
        let allowed_user_id = value
            .pointer("/user_info/open_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Feishu QR response is missing the scanning user identity".to_string()
            })?;

        let mut config_values = BTreeMap::new();
        config_values.insert("appId".to_string(), app_id.to_string());
        config_values.insert("appSecret".to_string(), app_secret.to_string());
        config_values.insert("domain".to_string(), domain.session_value().to_string());
        return Ok(CredentialQrPollResult {
            status: "success".to_string(),
            config_values: Some(config_values),
            allowed_user_id: Some(allowed_user_id.to_string()),
            session_domain: Some(domain.session_value().to_string()),
            next_poll_interval_ms: None,
        });
    }

    let error = value.get("error").and_then(Value::as_str);
    let (status, next_poll_interval_ms) = match error {
        None | Some("authorization_pending") => ("waiting", None),
        Some("slow_down") => (
            "waiting",
            Some(current_poll_interval_ms.saturating_add(5_000).min(60_000)),
        ),
        Some("access_denied") => ("denied", None),
        Some("expired_token") => ("expired", None),
        Some(other) => {
            return Err(format!("Feishu QR poll failed: {other}"));
        }
    };
    Ok(CredentialQrPollResult {
        status: status.to_string(),
        config_values: None,
        allowed_user_id: None,
        session_domain: Some(domain.session_value().to_string()),
        next_poll_interval_ms,
    })
}

fn normalize_wecom_poll(
    status: String,
    bot_id: Option<String>,
    secret: Option<String>,
) -> Result<CredentialQrPollResult, String> {
    let has_credential_fields = bot_id.is_some() || secret.is_some();
    let config_values = if status == "success" {
        let bot_id = bot_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "WeCom QR response returned incomplete credentials".to_string())?;
        let secret = secret
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "WeCom QR response returned incomplete credentials".to_string())?;
        Some(BTreeMap::from([
            ("botId".to_string(), bot_id.to_string()),
            ("secret".to_string(), secret.to_string()),
        ]))
    } else if has_credential_fields {
        return Err("WeCom QR response returned credentials before success".to_string());
    } else {
        None
    };

    Ok(CredentialQrPollResult {
        status,
        config_values,
        allowed_user_id: None,
        session_domain: None,
        next_poll_interval_ms: None,
    })
}

fn external_client(timeout: Duration) -> Result<reqwest::Client, String> {
    // These are external provider hosts, so the user's general proxy applies.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(timeout)
        // Never replay registration POST bodies or device codes to a redirect
        // target. The provider URLs above are the complete trust boundary.
        .redirect(reqwest::redirect::Policy::none());
    crate::proxy_config::build_client_with_proxy(builder)
}

async fn post_feishu_registration(
    client: &reqwest::Client,
    domain: FeishuRegistrationDomain,
    form: &[(&str, &str)],
) -> Result<Value, String> {
    let response = client
        .post(domain.registration_url())
        .form(form)
        .send()
        .await
        .map_err(|error| format!("Feishu QR request failed: {error}"))?;
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Feishu QR response parse failed: {error}"))
}

async fn start_feishu_provisioning() -> Result<CredentialQrStartResult, String> {
    let client = external_client(Duration::from_secs(10))?;
    let domain = FeishuRegistrationDomain::Feishu;
    let init = post_feishu_registration(&client, domain, &[("action", "init")]).await?;
    let supports_client_secret = init
        .get("supported_auth_methods")
        .and_then(Value::as_array)
        .is_some_and(|methods| {
            methods
                .iter()
                .any(|method| method.as_str() == Some("client_secret"))
        });
    if !supports_client_secret {
        return Err(
            "This Feishu account does not support QR bot creation; use manual setup".to_string(),
        );
    }

    let begin = post_feishu_registration(
        &client,
        domain,
        &[
            ("action", "begin"),
            ("archetype", "PersonalAgent"),
            ("auth_method", "client_secret"),
            ("request_user_info", "open_id"),
        ],
    )
    .await?;
    let parsed = parse_feishu_begin(&begin)?;
    ulog_info!("[credential-qr] Feishu registration session started");
    Ok(CredentialQrStartResult {
        session_key: parsed.device_code,
        qr_url: parsed.qr_url,
        session_domain: Some(domain.session_value().to_string()),
        poll_interval_ms: parsed.poll_interval_ms,
        expires_in_ms: parsed.expires_in_ms,
    })
}

async fn poll_feishu_provisioning(
    session_key: &str,
    session_domain: Option<&str>,
    current_poll_interval_ms: u64,
    poll_index: u32,
) -> Result<CredentialQrPollResult, String> {
    validate_session_key(session_key)?;
    let client = external_client(Duration::from_secs(10))?;
    let mut domain = FeishuRegistrationDomain::from_session_value(session_domain)?;
    let mut response = post_feishu_registration(
        &client,
        domain,
        &[("action", "poll"), ("device_code", session_key)],
    )
    .await?;

    // The official installer begins on Feishu and switches to the Lark account
    // host once the scanned tenant identifies itself as Lark.
    if domain == FeishuRegistrationDomain::Feishu && response_requests_lark(&response) {
        domain = FeishuRegistrationDomain::Lark;
        response = post_feishu_registration(
            &client,
            domain,
            &[("action", "poll"), ("device_code", session_key)],
        )
        .await?;
    }

    let result = parse_feishu_poll(&response, domain, current_poll_interval_ms)?;
    if result.status == "success" {
        ulog_info!(
            "[credential-qr] Feishu bot credentials provisioned (poll #{})",
            poll_index
        );
    } else if result.status != "waiting" {
        ulog_warn!(
            "[credential-qr] Feishu provisioning ended with status={} (poll #{})",
            result.status,
            poll_index
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn cmd_channel_credential_qr_start(
    provider: CredentialQrProvider,
) -> Result<CredentialQrStartResult, String> {
    match provider {
        CredentialQrProvider::Wecom => {
            let result = crate::commands::cmd_wecom_qr_generate().await?;
            let qr_url = validated_qr_url(&result.auth_url, &["work.weixin.qq.com"])?;
            Ok(CredentialQrStartResult {
                session_key: result.scode,
                qr_url,
                session_domain: None,
                poll_interval_ms: DEFAULT_WECOM_POLL_INTERVAL_MS,
                expires_in_ms: DEFAULT_WECOM_EXPIRES_IN_MS,
            })
        }
        CredentialQrProvider::Feishu => start_feishu_provisioning().await,
    }
}

#[tauri::command]
pub async fn cmd_channel_credential_qr_poll(
    provider: CredentialQrProvider,
    session_key: String,
    session_domain: Option<String>,
    poll_interval_ms: Option<u64>,
    poll_index: Option<u32>,
) -> Result<CredentialQrPollResult, String> {
    let poll_index = poll_index.unwrap_or_default();
    match provider {
        CredentialQrProvider::Wecom => {
            let result = crate::commands::cmd_wecom_qr_poll(session_key, Some(poll_index)).await?;
            normalize_wecom_poll(result.status, result.bot_id, result.secret)
        }
        CredentialQrProvider::Feishu => {
            poll_feishu_provisioning(
                &session_key,
                session_domain.as_deref(),
                poll_interval_ms.unwrap_or(DEFAULT_FEISHU_POLL_INTERVAL_MS),
                poll_index,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn qr_session_keys_are_opaque_provider_values() {
        for value in ["legacyABC123", "code_with-dash", "code+/=%&?# 汉字"] {
            assert!(validate_session_key(value).is_ok(), "rejected {value}");
        }
        for value in ["", "bad\ncode", "bad\0code", &"x".repeat(2_049)] {
            assert!(validate_session_key(value).is_err());
        }
    }

    #[test]
    fn qr_url_validation_rejects_non_https_credentials_and_unknown_hosts() {
        assert!(validated_qr_url(
            "https://accounts.feishu.cn/oauth/device?code=ok",
            &["accounts.feishu.cn"]
        )
        .is_ok());
        assert!(validated_qr_url(
            "http://accounts.feishu.cn/oauth/device?code=ok",
            &["accounts.feishu.cn"]
        )
        .is_err());
        assert!(validated_qr_url(
            "https://user:pass@accounts.feishu.cn/oauth/device",
            &["accounts.feishu.cn"]
        )
        .is_err());
        assert!(validated_qr_url(
            "https://accounts.feishu.cn.evil.example/oauth/device",
            &["accounts.feishu.cn"]
        )
        .is_err());
    }

    #[test]
    fn feishu_begin_uses_provider_timing_and_onboard_marker() {
        let parsed = parse_feishu_begin(&json!({
            "device_code": "device-code_123",
            "verification_uri_complete": "https://open.feishu.cn/oauth/device?code=abc",
            "interval": 7,
            "expires_in": 480
        }))
        .expect("valid begin response");

        assert_eq!(parsed.device_code, "device-code_123");
        assert_eq!(parsed.poll_interval_ms, 7_000);
        assert_eq!(parsed.expires_in_ms, 480_000);
        assert!(parsed.qr_url.contains("from=onboard"));
    }

    #[test]
    fn feishu_poll_maps_credentials_domain_and_scanning_user() {
        let result = parse_feishu_poll(
            &json!({
                "client_id": "cli_app",
                "client_secret": "secret-value",
                "user_info": { "open_id": "ou_scanner" }
            }),
            FeishuRegistrationDomain::Lark,
            5_000,
        )
        .expect("valid poll response");

        assert_eq!(result.status, "success");
        assert_eq!(result.allowed_user_id.as_deref(), Some("ou_scanner"));
        let values = result.config_values.expect("credentials");
        assert_eq!(values.get("appId").map(String::as_str), Some("cli_app"));
        assert_eq!(
            values.get("appSecret").map(String::as_str),
            Some("secret-value")
        );
        assert_eq!(values.get("domain").map(String::as_str), Some("lark"));
    }

    #[test]
    fn feishu_poll_maps_pending_slowdown_and_terminal_errors() {
        let pending = parse_feishu_poll(
            &json!({ "error": "authorization_pending" }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .expect("pending response");
        assert_eq!(pending.status, "waiting");
        assert_eq!(pending.next_poll_interval_ms, None);

        let slow = parse_feishu_poll(
            &json!({ "error": "slow_down" }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .expect("slow-down response");
        assert_eq!(slow.status, "waiting");
        assert_eq!(slow.next_poll_interval_ms, Some(10_000));

        let denied = parse_feishu_poll(
            &json!({ "error": "access_denied" }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .expect("denied response");
        assert_eq!(denied.status, "denied");

        let expired = parse_feishu_poll(
            &json!({ "error": "expired_token" }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .expect("expired response");
        assert_eq!(expired.status, "expired");
    }

    #[test]
    fn feishu_poll_rejects_blank_credentials_or_missing_scanning_user() {
        assert!(parse_feishu_poll(
            &json!({
                "client_id": "  ",
                "client_secret": "secret",
                "user_info": { "open_id": "ou_scanner" }
            }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .is_err());
        assert!(parse_feishu_poll(
            &json!({
                "client_id": "cli_app",
                "client_secret": "secret"
            }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .is_err());
        assert!(parse_feishu_poll(
            &json!({
                "client_id": "cli_app",
                "client_secret": "secret",
                "user_info": { "open_id": "  " }
            }),
            FeishuRegistrationDomain::Feishu,
            5_000,
        )
        .is_err());
    }

    #[test]
    fn wecom_success_requires_complete_non_blank_credentials() {
        assert!(normalize_wecom_poll(
            "success".to_string(),
            Some("bot".to_string()),
            Some("secret".to_string()),
        )
        .is_ok());
        assert!(normalize_wecom_poll("success".to_string(), None, None).is_err());
        assert!(normalize_wecom_poll(
            "success".to_string(),
            Some("  ".to_string()),
            Some("secret".to_string()),
        )
        .is_err());
        assert!(normalize_wecom_poll(
            "waiting".to_string(),
            Some("bot".to_string()),
            Some("secret".to_string()),
        )
        .is_err());
    }

    #[test]
    fn feishu_registration_domain_is_closed_to_known_values() {
        assert_eq!(
            FeishuRegistrationDomain::from_session_value(Some("lark")),
            Ok(FeishuRegistrationDomain::Lark)
        );
        assert!(
            FeishuRegistrationDomain::from_session_value(Some("https://attacker.example")).is_err()
        );
        assert!(response_requests_lark(&json!({
            "user_info": { "tenant_brand": "lark" }
        })));
    }

    #[test]
    fn tauri_results_use_the_renderer_camel_case_contract() {
        let value = serde_json::to_value(CredentialQrStartResult {
            session_key: "session".to_string(),
            qr_url: "https://open.feishu.cn/qr".to_string(),
            session_domain: Some("feishu".to_string()),
            poll_interval_ms: 5_000,
            expires_in_ms: 600_000,
        })
        .expect("serialize start result");

        assert_eq!(
            value.get("sessionKey").and_then(Value::as_str),
            Some("session")
        );
        assert_eq!(
            value.get("pollIntervalMs").and_then(Value::as_u64),
            Some(5_000)
        );
        assert!(value.get("session_key").is_none());
    }
}
