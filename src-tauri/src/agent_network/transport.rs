//! Fixed signed network origin, public TLS + device DPoP and App proxy.
//! No user account credential ever enters this client.
use super::crypto::{external_tls_config_with_ca, DevicePrivateKey};
use super::NetworkError;
use crate::network_diagnostics::{
    error_category, response_request_id, safe_request_id, RequestDiagnostic,
};
use myagents_agent_network_protocol::{budget, validate_metadata, MetadataKind};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_tungstenite::{
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
    },
    WebSocketStream,
};

pub(crate) type NetworkSocket = WebSocketStream<reqwest::Upgraded>;
pub(crate) struct NetworkTransport {
    memory: super::memory::MemoryBudget,
    origin: url::Url,
    client: reqwest::Client,
    key: Arc<DevicePrivateKey>,
    nonce: Mutex<Option<String>>,
}
impl NetworkTransport {
    pub(crate) fn new(
        origin: &str,
        key: Arc<DevicePrivateKey>,
        memory: super::memory::MemoryBudget,
    ) -> Result<Self, NetworkError> {
        Self::new_with_public_ca(origin, key, memory, None)
    }
    pub(crate) fn new_with_public_ca(
        origin: &str,
        key: Arc<DevicePrivateKey>,
        memory: super::memory::MemoryBudget,
        public_ca: Option<&str>,
    ) -> Result<Self, NetworkError> {
        let endpoint =
            url::Url::parse(origin).map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        if endpoint.scheme() != "https" || endpoint.origin().ascii_serialization() != origin {
            return Err(NetworkError::new("NETWORK_ENDPOINT_INVALID"));
        }
        // External HTTPS endpoint with standard public platform verification.
        // The inner device CA is intentionally absent from this trust store.
        #[allow(clippy::disallowed_methods)]
        let builder = reqwest::Client::builder()
            .http1_only()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .tls_backend_preconfigured(external_tls_config_with_ca(public_ca)?);
        let client = crate::proxy_config::build_client_with_proxy(builder)
            .map_err(|_| NetworkError::new("NETWORK_PROXY_INVALID"))?;
        Ok(Self {
            memory,
            origin: endpoint,
            client,
            key,
            nonce: Mutex::new(None),
        })
    }
    async fn authenticated(
        &self,
        request: reqwest::RequestBuilder,
        method: &reqwest::Method,
        url: &url::Url,
        token: &str,
        diagnostic: &RequestDiagnostic,
    ) -> Result<reqwest::Response, NetworkError> {
        for attempt in 0..2 {
            let nonce = self
                .nonce
                .lock()
                .map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))?
                .clone();
            let mut proof = HeaderValue::from_str(&self.key.dpop(
                method.as_str(),
                url,
                token,
                nonce.as_deref(),
            )?)
            .map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))?;
            proof.set_sensitive(true);
            let response = diagnostic
                .send(
                    request
                        .try_clone()
                        .ok_or_else(|| NetworkError::new("NETWORK_REQUEST_INVALID"))?
                        .header(AUTHORIZATION, bearer(token)?)
                        .header("DPoP", proof),
                )
                .await
                .map_err(|_| NetworkError::new("NETWORK_TRANSPORT_FAILED"))?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                if let Some(nonce) = response
                    .headers()
                    .get("DPoP-Nonce")
                    .and_then(|n| n.to_str().ok())
                    .filter(|n| !n.is_empty() && n.len() <= 256)
                {
                    *self
                        .nonce
                        .lock()
                        .map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))? =
                        Some(nonce.to_owned());
                    // The nonce challenge precedes dispatch; no uncertain
                    // application mutation or failed transport is retried.
                    continue;
                }
            }
            return Ok(response);
        }
        Err(NetworkError::new("NETWORK_PROOF_INVALID"))
    }
    /// Owned registration is not a fabricated fixed-protocol metadata variant.
    pub(crate) async fn register_device(
        &self,
        token: &str,
        device: &crate::device_identity::DeviceIdentity,
    ) -> Result<(), NetworkError> {
        let body = serde_json::json!({"deviceName":device.device_name.as_deref().unwrap_or(&device.device_id),
            "platform":device.platform,"osVersion":device.os_version.as_deref().unwrap_or("unknown"),
            "appVersion":device.app_version});
        let bytes = serde_json::to_vec(&body)
            .map_err(|_| NetworkError::new("DEVICE_REGISTRATION_INVALID"))?;
        if bytes.len() > 8192 {
            return Err(NetworkError::new("DEVICE_REGISTRATION_INVALID"));
        }
        let method = reqwest::Method::POST;
        let path = "/api/agent-network/device/registration";
        let url = self
            .origin
            .join(path)
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let request = self
            .client
            .post(url.clone())
            .header("Content-Type", "application/json")
            .body(bytes);
        let diagnostic = RequestDiagnostic::new("agent-network", &method, path);
        let mut response = self
            .authenticated(request, &method, &url, token, &diagnostic)
            .await?;
        let status = response.status();
        let retry_after = super::reconnect::retry_after(&response);
        let mut request_id = response_request_id(&response);
        let mut allocation = self.memory.reserve(0)?;
        let bytes = read_response_body(&mut response, &mut allocation, &diagnostic).await?;
        let value = decode_response(status, &bytes, retry_after, &mut request_id)?;
        if value != serde_json::json!({"registered":true,"deviceId":device.device_id}) {
            return Err(NetworkError::new("DEVICE_REGISTRATION_INVALID"));
        }
        Ok(())
    }
    pub(crate) async fn json(
        &self,
        route: NetworkRoute<'_>,
        token: &str,
        body: Option<Value>,
    ) -> Result<Value, NetworkError> {
        Ok(self.json_owned(route, token, body).await?.0)
    }
    pub(crate) async fn json_owned(
        &self,
        route: NetworkRoute<'_>,
        token: &str,
        body: Option<Value>,
    ) -> Result<(Value, super::memory::Allocation), NetworkError> {
        let mut allocation = self.memory.reserve(0)?;
        let (method, path) = route.path()?;
        let url = self
            .origin
            .join(&path)
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let mut request = self.client.request(method.clone(), url.clone());
        if let Some(body) = body {
            allocation.resize(super::memory::measure(&body)?.0 * 2)?;
            let bytes = serde_json::to_vec(&body)
                .map_err(|_| NetworkError::new("NETWORK_REQUEST_INVALID"))?;
            if bytes.len() > budget("catalogBytes") {
                return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
            }
            request = request
                .header("Content-Type", "application/json")
                .body(bytes);
        }
        let diagnostic = RequestDiagnostic::new("agent-network", &method, &path);
        let mut response = self
            .authenticated(request, &method, &url, token, &diagnostic)
            .await?;
        allocation.resize(0)?;
        let status = response.status();
        let retry_after = super::reconnect::retry_after(&response);
        let mut request_id = response_request_id(&response);
        let bytes = read_response_body(&mut response, &mut allocation, &diagnostic).await?;
        let value =
            decode_response(status, &bytes, retry_after, &mut request_id).inspect_err(|error| {
                diagnostic.failure(
                    "decode",
                    if error.code == "NETWORK_RESPONSE_INVALID" {
                        "decode"
                    } else {
                        "http"
                    },
                    Some(status.as_u16()),
                    request_id.as_deref(),
                );
            })?;
        validate_metadata(route.response_kind(), &value).map_err(|_| {
            diagnostic.failure(
                "schema",
                "decode",
                Some(status.as_u16()),
                request_id.as_deref(),
            );
            NetworkError::new("NETWORK_RESPONSE_INVALID")
        })?;
        Ok((value, allocation))
    }
    pub(crate) fn execution_origin_matches(&self, issuer: &str) -> bool {
        self.origin.origin().ascii_serialization() == issuer
    }
    /// Independent finite execution DTOs, never vendor MetadataKind. Caller
    /// keeps the allocation alive for the decoded response's entire lifetime.
    pub(crate) async fn execution_json<T: serde::de::DeserializeOwned>(
        &self,
        route: ExecutionRoute,
        token: &str,
        body: &impl serde::Serialize,
    ) -> Result<(T, super::memory::Allocation), NetworkError> {
        let size = super::memory::measure(body)?.0;
        let request_limit = if route == ExecutionRoute::Observe {
            EXECUTION_REQUEST_BYTES + 1024
        } else {
            EXECUTION_REQUEST_BYTES
        };
        if size == 0 || size > request_limit {
            return Err(NetworkError::new("BOT_EXECUTION_REQUEST_TOO_LARGE"));
        }
        let mut allocation = self.memory.reserve(size.saturating_mul(2))?;
        let bytes = serde_json::to_vec(body)
            .map_err(|_| NetworkError::new("BOT_EXECUTION_REQUEST_INVALID"))?;
        let method = reqwest::Method::POST;
        let path = route.path();
        let url = self
            .origin
            .join(path)
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let request = self
            .client
            .post(url.clone())
            .header("Content-Type", "application/json")
            .body(bytes);
        let diagnostic = RequestDiagnostic::new("bot-execution", &method, path);
        let mut response = self
            .authenticated(request, &method, &url, token, &diagnostic)
            .await?;
        allocation.resize(0)?;
        let status = response.status();
        let retry_after = super::reconnect::retry_after(&response);
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NetworkError::new("BOT_EXECUTION_TRANSPORT_UNCONFIRMED"))?
        {
            let length = bytes
                .len()
                .checked_add(chunk.len())
                .filter(|n| *n <= EXECUTION_RESPONSE_BYTES)
                .ok_or_else(|| NetworkError::new("BOT_EXECUTION_RESPONSE_TOO_LARGE"))?;
            allocation.resize(length.saturating_mul(3))?;
            bytes
                .try_reserve_exact(chunk.len())
                .map_err(|_| NetworkError::new("CONNECTOR_CAPACITY"))?;
            bytes.extend_from_slice(&chunk);
        }
        let value = decode_execution_response(status.as_u16(), &bytes, retry_after)?;
        Ok((value, allocation))
    }
    pub(crate) async fn websocket(&self, token: &str) -> Result<NetworkSocket, NetworkError> {
        let key = generate_key();
        let url = self
            .origin
            .join("/v1/ws")
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let request = self
            .client
            .get(url.clone())
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Key", &key)
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Protocol", "myagents-agent-network.v1");
        let diagnostic = RequestDiagnostic::new("agent-network", &reqwest::Method::GET, "/v1/ws");
        let response = self
            .authenticated(request, &reqwest::Method::GET, &url, token, &diagnostic)
            .await?;
        let headers = response.headers();
        let retry_after = super::reconnect::retry_after(&response);
        let get = |key: &str| headers.get(key).and_then(|value| value.to_str().ok());
        if response.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS
            || response.version() != reqwest::Version::HTTP_11
            || !get("Upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
            || !get("Connection").is_some_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
            || get("Sec-WebSocket-Accept") != Some(derive_accept_key(key.as_bytes()).as_str())
            || get("Sec-WebSocket-Protocol") != Some("myagents-agent-network.v1")
            || headers.contains_key("Sec-WebSocket-Extensions")
        {
            diagnostic.failure("upgrade", "http", Some(response.status().as_u16()), None);
            let mut error =
                NetworkError::cloud("NETWORK_UPGRADE_REJECTED", response.status().as_u16());
            error.retry_after = retry_after;
            return Err(error);
        }
        let stream = response.upgrade().await.map_err(|error| {
            diagnostic.failure("upgrade", error_category(&error), None, None);
            NetworkError::new("NETWORK_UPGRADE_REJECTED")
        })?;
        let config = WebSocketConfig {
            write_buffer_size: 0,
            max_write_buffer_size: budget("socketQueueBytes"),
            max_message_size: Some(budget("controlBytes") + 22),
            max_frame_size: Some(budget("controlBytes") + 22),
            accept_unmasked_frames: false,
            ..Default::default()
        };
        Ok(WebSocketStream::from_raw_socket(stream, Role::Client, Some(config)).await)
    }
}
fn body_failure(
    status: reqwest::StatusCode,
    retry_after: Option<Duration>,
    successful_response_error: NetworkError,
) -> NetworkError {
    let mut error = if status.is_success() {
        successful_response_error
    } else {
        NetworkError::cloud("NETWORK_HTTP_FAILED", status.as_u16())
    };
    error.retry_after = retry_after;
    error
}
async fn read_response_body(
    response: &mut reqwest::Response,
    allocation: &mut super::memory::Allocation,
    diagnostic: &RequestDiagnostic,
) -> Result<Vec<u8>, NetworkError> {
    let status = response.status();
    let retry_after = super::reconnect::retry_after(response);
    let request_id = response_request_id(response);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        diagnostic.failure(
            "body",
            error_category(&error),
            Some(status.as_u16()),
            request_id.as_deref(),
        );
        body_failure(
            status,
            retry_after,
            NetworkError::new("NETWORK_TRANSPORT_FAILED"),
        )
    })? {
        if bytes.len() + chunk.len() > budget("catalogBytes") {
            diagnostic.failure("body", "size", Some(status.as_u16()), request_id.as_deref());
            return Err(body_failure(
                status,
                retry_after,
                NetworkError::new("MESSAGE_TOO_LARGE"),
            ));
        }
        allocation
            .resize((bytes.len() + chunk.len()) * 2)
            .map_err(|error| {
                diagnostic.failure(
                    "body",
                    "capacity",
                    Some(status.as_u16()),
                    request_id.as_deref(),
                );
                body_failure(status, retry_after, error)
            })?;
        bytes.try_reserve_exact(chunk.len()).map_err(|_| {
            diagnostic.failure(
                "body",
                "capacity",
                Some(status.as_u16()),
                request_id.as_deref(),
            );
            body_failure(status, retry_after, NetworkError::new("CONNECTOR_CAPACITY"))
        })?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_response(
    status: reqwest::StatusCode,
    bytes: &[u8],
    retry_after: Option<Duration>,
    request_id: &mut Option<String>,
) -> Result<Value, NetworkError> {
    #[derive(Deserialize)]
    struct Envelope {
        ok: bool,
        data: Option<Value>,
        error: Option<Failure>,
        #[serde(rename = "requestId")]
        request_id: Option<Value>,
    }
    #[derive(Deserialize)]
    struct Failure {
        code: String,
        retryable: bool,
        details: Option<Value>,
    }
    let fallback = || {
        let mut error = if status.is_success() {
            NetworkError::new("NETWORK_RESPONSE_INVALID")
        } else {
            NetworkError::cloud("NETWORK_HTTP_FAILED", status.as_u16())
        };
        error.retry_after = retry_after;
        error
    };
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| fallback())?;
    if let Some(id) = safe_request_id(envelope.request_id.as_ref().and_then(Value::as_str)) {
        *request_id = Some(id.to_owned());
    }
    if !status.is_success() || !envelope.ok {
        let failure = envelope.error.ok_or_else(fallback)?;
        let mut error = NetworkError::cloud(&failure.code, status.as_u16());
        error.retryable = failure.retryable && (status.as_u16() == 429 || status.is_server_error());
        error.details = failure.details;
        error.retry_after = retry_after;
        return Err(error);
    }
    envelope.data.ok_or_else(fallback)
}

fn bearer(token: &str) -> Result<HeaderValue, NetworkError> {
    if token.len() > 32_768 {
        return Err(NetworkError::new("NETWORK_TOKEN_INVALID"));
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| NetworkError::new("NETWORK_TOKEN_INVALID"))?;
    value.set_sensitive(true);
    Ok(value)
}
fn uuid(value: &str) -> Result<&str, NetworkError> {
    if uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .as_deref()
        != Ok(value)
    {
        return Err(NetworkError::new("NETWORK_REFERENCE_INVALID"));
    }
    Ok(value)
}
fn page(cursor: Option<&str>, limit: usize) -> Result<String, NetworkError> {
    if limit == 0 || limit > budget("pageMax") {
        return Err(NetworkError::new("PAGE_LIMIT_INVALID"));
    }
    Ok(match cursor {
        Some(cursor) => format!("?limit={limit}&cursor={}", uuid(cursor)?),
        None => format!("?limit={limit}"),
    })
}
pub(crate) const EXECUTION_REQUEST_BYTES: usize = 64 * 1024;
pub(crate) const EXECUTION_RESPONSE_BYTES: usize = 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionRoute {
    Observe,
    Pull,
    Lease,
    Receipt,
}
impl ExecutionRoute {
    fn path(self) -> &'static str {
        match self {
            Self::Observe => "/execution/self/observe",
            Self::Pull => "/execution/self/pull",
            Self::Lease => "/execution/self/lease",
            Self::Receipt => "/execution/self/receipt",
        }
    }
}
fn decode_execution_response<T: serde::de::DeserializeOwned>(
    status: u16,
    bytes: &[u8],
    retry_after: Option<Duration>,
) -> Result<T, NetworkError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope<T> {
        ok: bool,
        data: Option<T>,
        code: Option<String>,
    }
    let response: Envelope<T> = serde_json::from_slice(bytes)
        .map_err(|_| NetworkError::new("BOT_EXECUTION_RESPONSE_INVALID"))?;
    if (200..300).contains(&status) && response.ok && response.code.is_none() {
        return response
            .data
            .ok_or_else(|| NetworkError::new("BOT_EXECUTION_RESPONSE_INVALID"));
    }
    if (200..300).contains(&status) || response.ok || response.data.is_some() {
        return Err(NetworkError::new("BOT_EXECUTION_RESPONSE_INVALID"));
    }
    let code = response
        .code
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        })
        .ok_or_else(|| NetworkError::new("BOT_EXECUTION_RESPONSE_INVALID"))?;
    let mut error = NetworkError::cloud(&code, status);
    error.retry_after = retry_after;
    Err(error)
}
pub(crate) enum NetworkRoute<'a> {
    Network,
    Devices {
        cursor: Option<&'a str>,
        limit: usize,
    },
    Agents {
        device_id: &'a str,
        cursor: Option<&'a str>,
        limit: usize,
    },
    /// Device-scoped projection available before the public Agent catalog is Ready.
    /// It deliberately has no target-device parameter and is only selected by owned policy hydration.
    OwnedSelfPolicy {
        cursor: Option<&'a str>,
        limit: usize,
    },
    Callable {
        network_id: &'a str,
        cursor: Option<&'a str>,
        limit: usize,
    },
    Catalog,
    Resolve {
        network_id: &'a str,
        mount_id: &'a str,
    },
    Membership {
        network_id: &'a str,
        device_id: &'a str,
        joined: bool,
    },
    Mount {
        network_id: &'a str,
        mount_id: &'a str,
    },
    Receipt {
        mutation_id: &'a str,
    },
    DeviceName {
        network_id: &'a str,
        device_id: &'a str,
        write: bool,
    },
}
impl NetworkRoute<'_> {
    fn response_kind(&self) -> MetadataKind {
        match self {
            Self::Network => MetadataKind::Network,
            Self::Devices { .. } => MetadataKind::Devices,
            Self::Agents { .. } | Self::OwnedSelfPolicy { .. } => MetadataKind::Agents,
            Self::Callable { .. } => MetadataKind::Callable,
            Self::Catalog => MetadataKind::Catalog,
            Self::Membership { .. } => MetadataKind::Membership,
            Self::Resolve { .. } => MetadataKind::CallableAgent,
            Self::Mount { .. } => MetadataKind::Mount,
            Self::Receipt { .. } => MetadataKind::Receipt,
            Self::DeviceName { .. } => MetadataKind::DeviceName,
        }
    }
    fn path(&self) -> Result<(reqwest::Method, String), NetworkError> {
        Ok(match self {
            Self::Network => (reqwest::Method::GET, "/v1/me/network".into()),
            Self::Devices { cursor, limit } => (
                reqwest::Method::GET,
                format!("/v1/devices{}", page(*cursor, *limit)?),
            ),
            Self::Agents {
                device_id,
                cursor,
                limit,
            } => (
                reqwest::Method::GET,
                format!(
                    "/v1/devices/{}/agents{}",
                    uuid(device_id)?,
                    page(*cursor, *limit)?
                ),
            ),
            Self::OwnedSelfPolicy { cursor, limit } => (
                reqwest::Method::GET,
                format!("/api/agent-network/policy/self{}", page(*cursor, *limit)?),
            ),
            Self::Callable {
                network_id,
                cursor,
                limit,
            } => (
                reqwest::Method::GET,
                format!(
                    "/v1/networks/{}/callable-agents{}",
                    uuid(network_id)?,
                    page(*cursor, *limit)?
                ),
            ),
            Self::Catalog => (reqwest::Method::PUT, "/v1/devices/self/catalog".into()),
            Self::Resolve {
                network_id,
                mount_id,
            } => (
                reqwest::Method::GET,
                format!(
                    "/v1/networks/{}/callable-agents/{}",
                    uuid(network_id)?,
                    uuid(mount_id)?
                ),
            ),
            Self::Membership {
                network_id,
                device_id,
                joined,
            } => (
                reqwest::Method::POST,
                format!(
                    "/v1/networks/{}/devices/{}/{}",
                    uuid(network_id)?,
                    uuid(device_id)?,
                    if *joined { "join" } else { "leave" }
                ),
            ),
            Self::Mount {
                network_id,
                mount_id,
            } => (
                reqwest::Method::PATCH,
                format!(
                    "/v1/networks/{}/mounts/{}",
                    uuid(network_id)?,
                    uuid(mount_id)?
                ),
            ),
            Self::Receipt { mutation_id } => (
                reqwest::Method::GET,
                format!("/v1/mutations/{}", uuid(mutation_id)?),
            ),
            Self::DeviceName {
                network_id,
                device_id,
                write,
            } => (
                if *write {
                    reqwest::Method::PATCH
                } else {
                    reqwest::Method::GET
                },
                format!(
                    "/v1/networks/{}/devices/{}/name",
                    uuid(network_id)?,
                    uuid(device_id)?
                ),
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_names_use_scoped_id_routes_for_both_read_and_write() {
        let network = "11111111-1111-4111-8111-111111111111";
        let device = "22222222-2222-4222-8222-222222222222";
        for (write, method) in [
            (false, reqwest::Method::GET),
            (true, reqwest::Method::PATCH),
        ] {
            let (actual_method, path) = NetworkRoute::DeviceName {
                network_id: network,
                device_id: device,
                write,
            }
            .path()
            .unwrap();
            assert_eq!(actual_method, method);
            assert_eq!(
                path,
                format!("/v1/networks/{network}/devices/{device}/name")
            );
        }
        assert!(NetworkRoute::DeviceName {
            network_id: network,
            device_id: "家里 Windows",
            write: true
        }
        .path()
        .is_err());
    }
    #[test]
    fn owned_self_policy_has_fixed_scoped_route_and_agents_schema() {
        let route = NetworkRoute::OwnedSelfPolicy {
            cursor: Some("11111111-1111-4111-8111-111111111111"),
            limit: 50,
        };
        let (method, path) = route.path().unwrap();
        assert_eq!(method, reqwest::Method::GET);
        assert_eq!(
            path,
            "/api/agent-network/policy/self?limit=50&cursor=11111111-1111-4111-8111-111111111111"
        );
        assert!(matches!(&route, NetworkRoute::OwnedSelfPolicy { .. }));
        assert!(matches!(route.response_kind(), MetadataKind::Agents));
        let valid_page = serde_json::json!({"items":[],"nextCursor":null,"complete":true});
        assert!(validate_metadata(route.response_kind(), &valid_page).is_ok());
        let with_unknown_field = serde_json::json!({"items":[],"nextCursor":null,"complete":true,"scope":"other-device"});
        assert!(validate_metadata(route.response_kind(), &with_unknown_field).is_err());
        assert!(NetworkRoute::OwnedSelfPolicy {
            cursor: Some("not-a-canonical-uuid"),
            limit: 50,
        }
        .path()
        .is_err());
    }
    fn decode_response(
        status: reqwest::StatusCode,
        bytes: &[u8],
        retry_after: Option<Duration>,
    ) -> Result<Value, NetworkError> {
        super::decode_response(status, bytes, retry_after, &mut None)
    }
    #[test]
    fn envelope_request_id_is_projected_once_and_rejects_unsafe_metadata() {
        for (value, expected) in [
            (serde_json::json!("req-123_abc"), Some("req-123_abc")),
            (serde_json::json!("https://secret/path?token=private"), None),
            (serde_json::json!("line\nnext"), None),
            (serde_json::json!("x".repeat(129)), None),
            (serde_json::json!({"secret":"body"}), None),
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({"ok":false,"requestId":value,"error":{"code":"RATE_LIMITED","retryable":true}})).unwrap();
            let mut request_id = None;
            let error = super::decode_response(
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                &bytes,
                None,
                &mut request_id,
            )
            .unwrap_err();
            assert_eq!(error.code, "RATE_LIMITED");
            assert_eq!(request_id.as_deref(), expected);
        }
    }
    #[tokio::test]
    async fn bounded_body_reader_preserves_edge_status_and_delay() {
        let diagnostic =
            RequestDiagnostic::new("agent-network", &reqwest::Method::GET, "/v1/me/network");
        for status in [429, 503, 200] {
            for oversized in [false, true] {
                let bytes = if oversized {
                    vec![b'x'; budget("catalogBytes") + 1]
                } else {
                    b"truncated".to_vec()
                };
                let (mut response, server) =
                    crate::network_diagnostics::test_response(status, bytes, !oversized).await;
                let memory = super::super::memory::MemoryBudget::default();
                let mut allocation = memory.reserve(0).unwrap();
                let error = read_response_body(&mut response, &mut allocation, &diagnostic)
                    .await
                    .unwrap_err();
                drop(response);
                server.join().unwrap();
                // Even the rejected over-limit chunk cannot charge beyond the
                // response cap; releasing the reader restores the whole budget.
                let remainder = memory
                    .reserve(budget("connectorBytes") - 2 * budget("catalogBytes"))
                    .unwrap();
                drop(remainder);
                drop(allocation);
                assert!(memory.reserve(budget("connectorBytes")).is_ok());
                if status == 200 {
                    assert_eq!(
                        error.code,
                        if oversized {
                            "MESSAGE_TOO_LARGE"
                        } else {
                            "NETWORK_TRANSPORT_FAILED"
                        }
                    );
                    assert!(!error.retryable);
                    assert_eq!(error.retry_after, None);
                } else {
                    assert_eq!(error.code, "NETWORK_HTTP_FAILED");
                    assert!(error.retryable);
                    assert_eq!(error.retry_after, Some(Duration::from_secs(45)));
                }
            }
        }
    }

    #[tokio::test]
    async fn body_reader_accepts_exact_limit_and_preserves_status_on_memory_limit() {
        let diagnostic =
            RequestDiagnostic::new("agent-network", &reqwest::Method::GET, "/v1/me/network");
        let (mut response, server) = crate::network_diagnostics::test_response(
            200,
            vec![b'x'; budget("catalogBytes")],
            false,
        )
        .await;
        let memory = super::super::memory::MemoryBudget::default();
        let mut allocation = memory.reserve(0).unwrap();
        assert_eq!(
            read_response_body(&mut response, &mut allocation, &diagnostic)
                .await
                .unwrap()
                .len(),
            budget("catalogBytes")
        );
        server.join().unwrap();
        drop(allocation);
        for status in [429, 503] {
            let held = memory.reserve(budget("connectorBytes")).unwrap();
            let mut allocation = memory.reserve(0).unwrap();
            let (mut response, server) =
                crate::network_diagnostics::test_response(status, b"error".to_vec(), false).await;
            let error = read_response_body(&mut response, &mut allocation, &diagnostic)
                .await
                .unwrap_err();
            assert_eq!(error.code, "NETWORK_HTTP_FAILED");
            assert!(error.retryable);
            assert_eq!(error.retry_after, Some(Duration::from_secs(45)));
            drop(response);
            server.join().unwrap();
            drop(held);
        }
    }
    #[test]
    fn edge_http_failures_keep_status_retryability_and_retry_after() {
        for status in [429, 500, 502, 503, 504] {
            for bytes in [
                b"".as_slice(),
                b"<html>edge error</html>".as_slice(),
                br#"{"ok":false}"#.as_slice(),
            ] {
                let error = decode_response(
                    reqwest::StatusCode::from_u16(status).unwrap(),
                    bytes,
                    Some(Duration::from_secs(45)),
                )
                .unwrap_err();
                assert_eq!(error.code, "NETWORK_HTTP_FAILED");
                assert!(error.retryable);
                assert_eq!(error.retry_after, Some(Duration::from_secs(45)));
            }
        }
        assert!(
            !decode_response(reqwest::StatusCode::UNAUTHORIZED, b"", None)
                .unwrap_err()
                .retryable
        );
        for bytes in [
            b"".as_slice(),
            b"<html>bad</html>".as_slice(),
            br#"{"ok":true}"#.as_slice(),
        ] {
            assert_eq!(
                decode_response(reqwest::StatusCode::OK, bytes, None)
                    .unwrap_err()
                    .code,
                "NETWORK_RESPONSE_INVALID"
            );
        }
    }
    #[test]
    fn structured_cloud_failure_preserves_protocol_fields() {
        let error = decode_response(reqwest::StatusCode::TOO_MANY_REQUESTS, br#"{"ok":false,"error":{"code":"RATE_LIMITED","retryable":true,"details":{"limit":2}}}"#, Some(Duration::from_secs(5))).unwrap_err();
        assert_eq!(error.code, "RATE_LIMITED");
        assert!(error.retryable);
        assert_eq!(error.details, Some(serde_json::json!({"limit":2})));
    }
}

#[cfg(test)]
mod execution_transport_tests {
    use super::*;
    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Data {
        value: u64,
    }
    #[test]
    fn execution_has_fixed_routes_and_closed_separate_envelope() {
        assert_eq!(ExecutionRoute::Observe.path(), "/execution/self/observe");
        assert_eq!(ExecutionRoute::Pull.path(), "/execution/self/pull");
        assert_eq!(ExecutionRoute::Lease.path(), "/execution/self/lease");
        assert_eq!(ExecutionRoute::Receipt.path(), "/execution/self/receipt");
        assert_eq!(
            decode_execution_response::<Data>(200, br#"{"ok":true,"data":{"value":1}}"#, None)
                .unwrap()
                .value,
            1
        );
        for b in [
            br#"{"ok":true,"ok":false,"data":{"value":1}}"#.as_slice(),
            br#"{"ok":true,"data":{"value":1,"unexpected":0}}"#,
            br#"{"ok":true,"data":{"value":1},"token":"forbidden"}"#,
            br#"{"ok":true,"data":{"value":1},"code":"ANY"}"#,
        ] {
            assert!(decode_execution_response::<Data>(200, b, None).is_err());
        }
        let e = decode_execution_response::<Data>(
            403,
            br#"{"ok":false,"code":"SESSION_REJECTED"}"#,
            None,
        )
        .unwrap_err();
        assert_eq!(e.code, "SESSION_REJECTED");
        assert!(!e.retryable);
        assert_eq!(
            decode_execution_response::<Data>(
                500,
                br#"{"ok":false,"code":"unsafe-token value"}"#,
                None
            )
            .unwrap_err()
            .code,
            "BOT_EXECUTION_RESPONSE_INVALID"
        );
    }
}
