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
/// Owned-service extension. This is a current route, never a write grant.
#[derive(Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceAddress {
    pub version: u8,
    pub scope: myagents_agent_network_protocol::DeviceScope,
    pub connection_epoch: String,
    pub membership_revision: u64,
    pub signed_binding: String,
}
impl DeviceAddress {
    pub(crate) fn validate(
        &self,
        local: &myagents_agent_network_protocol::DeviceScope,
        device: &str,
    ) -> Result<(), NetworkError> {
        let canonical = |s: &str| uuid::Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s);
        if self.version != 1
            || !canonical(device)
            || self.scope.device_id != device
            || device == local.device_id
            || self.scope.service_id != local.service_id
            || self.scope.environment != local.environment
            || self.scope.network_id != local.network_id
            || self.scope.principal_id != local.principal_id
            || self.scope.key_generation == 0
            || self.scope.key_generation > 9_007_199_254_740_991
            || !canonical(&self.connection_epoch)
            || self.membership_revision == 0
            || self.membership_revision > 9_007_199_254_740_991
            || self.signed_binding.is_empty()
            || self.signed_binding.len() > myagents_agent_network_protocol::budget("controlBytes")
        {
            return Err(NetworkError::new("HOST_ADDRESS_INVALID"));
        }
        Ok(())
    }
}
fn decode_device_address(
    bytes: &[u8],
    local: &myagents_agent_network_protocol::DeviceScope,
    device: &str,
) -> Result<DeviceAddress, NetworkError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        ok: bool,
        data: DeviceAddress,
    }
    // Decode bytes directly, preserving duplicate-field rejection at every layer.
    let response: Envelope =
        serde_json::from_slice(bytes).map_err(|_| NetworkError::new("HOST_ADDRESS_INVALID"))?;
    if !response.ok {
        return Err(NetworkError::new("HOST_ADDRESS_INVALID"));
    }
    response.data.validate(local, device)?;
    Ok(response.data)
}
const PRESERVATION_PATH: &str = "/api/agent-network/catalog/self-preservation";
fn decode_catalog_preservation(bytes: &[u8]) -> Result<bool, NetworkError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Data {
        empty: bool,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        ok: bool,
        data: Data,
    }
    let response: Envelope =
        serde_json::from_slice(bytes).map_err(|_| NetworkError::new("SOURCE_CATALOG_INVALID"))?;
    if !response.ok {
        return Err(NetworkError::new("SOURCE_CATALOG_INVALID"));
    }
    Ok(response.data.empty)
}
pub(crate) struct NetworkTransport {
    memory: super::memory::MemoryBudget,
    origin: url::Url,
    client: reqwest::Client,
    key: Arc<DevicePrivateKey>,
    nonce: Mutex<Option<String>>,
}
impl NetworkTransport {
    /// Owned-only device-scoped preservation proof, not vendor metadata or a write grant.
    pub(crate) async fn catalog_self_preservation(
        &self,
        token: &str,
    ) -> Result<bool, NetworkError> {
        let method = reqwest::Method::GET;
        let url = self
            .origin
            .join(PRESERVATION_PATH)
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let diagnostic = RequestDiagnostic::new("agent-network", &method, PRESERVATION_PATH);
        let mut response = self
            .authenticated(
                self.client.get(url.clone()),
                &method,
                &url,
                token,
                &diagnostic,
            )
            .await?;
        let status = response.status();
        let retry_after = super::reconnect::retry_after(&response);
        let mut request_id = response_request_id(&response);
        let mut allocation = self.memory.reserve(0)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NetworkError::new("NETWORK_TRANSPORT_FAILED"))?
        {
            let size = bytes
                .len()
                .checked_add(chunk.len())
                .filter(|size| *size <= 8192)
                .ok_or_else(|| NetworkError::new("SOURCE_CATALOG_INVALID"))?;
            allocation.resize(size.saturating_mul(2))?;
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            return decode_response(status, &bytes, retry_after, &mut request_id)
                .and_then(|_| Err(NetworkError::new("SOURCE_CATALOG_INVALID")));
        }
        decode_catalog_preservation(&bytes)
    }
    pub(crate) async fn device_address(
        &self,
        token: &str,
        local: &myagents_agent_network_protocol::DeviceScope,
        device: &str,
    ) -> Result<DeviceAddress, NetworkError> {
        if !uuid::Uuid::parse_str(device).is_ok_and(|id| id.to_string() == device) {
            return Err(NetworkError::new("HOST_ADDRESS_INVALID"));
        }
        let path = format!("/api/agent-network/devices/{device}/address");
        let method = reqwest::Method::GET;
        let url = self
            .origin
            .join(&path)
            .map_err(|_| NetworkError::new("NETWORK_ENDPOINT_INVALID"))?;
        let diagnostic = RequestDiagnostic::new("agent-network", &method, &path);
        let mut response = self
            .authenticated(
                self.client.get(url.clone()),
                &method,
                &url,
                token,
                &diagnostic,
            )
            .await?;
        let status = response.status();
        let retry_after = super::reconnect::retry_after(&response);
        let mut request_id = response_request_id(&response);
        let mut allocation = self.memory.reserve(0)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| NetworkError::new("NETWORK_TRANSPORT_FAILED"))?
        {
            let size = bytes
                .len()
                .checked_add(chunk.len())
                .filter(|n| *n <= budget("controlBytes"))
                .ok_or_else(|| NetworkError::new("HOST_ADDRESS_INVALID"))?;
            allocation.resize(size.saturating_mul(2))?;
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() > myagents_agent_network_protocol::budget("controlBytes") {
            return Err(NetworkError::new("HOST_ADDRESS_INVALID"));
        }
        if !status.is_success() {
            return decode_response(status, &bytes, retry_after, &mut request_id)
                .and_then(|_| Err(NetworkError::new("HOST_ADDRESS_INVALID")));
        }
        decode_device_address(&bytes, local, device)
    }
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
mod device_address_tests {
    use super::*;
    fn fixture() -> (myagents_agent_network_protocol::DeviceScope, DeviceAddress) {
        let local = myagents_agent_network_protocol::DeviceScope {
            service_id: "test.service".into(),
            environment: "development".into(),
            network_id: uuid::Uuid::new_v4().to_string(),
            principal_id: uuid::Uuid::new_v4().to_string(),
            device_id: uuid::Uuid::new_v4().to_string(),
            key_generation: 1,
        };
        let address = DeviceAddress {
            version: 1,
            scope: myagents_agent_network_protocol::DeviceScope {
                device_id: uuid::Uuid::new_v4().to_string(),
                ..local.clone()
            },
            connection_epoch: uuid::Uuid::new_v4().to_string(),
            membership_revision: 1,
            signed_binding: "public-test-binding".into(),
        };
        (local, address)
    }
    #[test]
    fn address_bytes_are_closed_including_duplicates() {
        let (local, address) = fixture();
        let data = serde_json::to_string(&address).unwrap();
        assert!(decode_device_address(
            format!("{{\"ok\":true,\"data\":{data}}}").as_bytes(),
            &local,
            &address.scope.device_id
        )
        .is_ok());
        for raw in [
            format!("{{\"ok\":true,\"ok\":true,\"data\":{data}}}"),
            format!("{{\"ok\":true,\"data\":{data},\"grant\":true}}"),
            format!(
                "{{\"ok\":true,\"data\":{}}}",
                data.replacen("\"version\":1", "\"version\":1,\"version\":1", 1)
            ),
        ] {
            assert!(
                decode_device_address(raw.as_bytes(), &local, &address.scope.device_id).is_err()
            );
        }
    }
    #[test]
    fn address_rejects_foreign_scope_invalid_epoch_and_generation() {
        let (local, address) = fixture();
        for field in [
            "principalId",
            "networkId",
            "environment",
            "deviceId",
            "connectionEpoch",
            "signedBinding",
        ] {
            let mut value = serde_json::to_value(&address).unwrap();
            if field == "connectionEpoch" || field == "signedBinding" {
                value[field] = serde_json::json!("");
            } else {
                value["scope"][field] = serde_json::json!("foreign");
            }
            let raw = serde_json::to_vec(&serde_json::json!({"ok":true,"data":value})).unwrap();
            assert!(decode_device_address(&raw, &local, &address.scope.device_id).is_err());
        }
        for generation in [0, 9_007_199_254_740_992u64] {
            let mut bad = address.clone();
            bad.scope.key_generation = generation;
            assert!(bad.validate(&local, &bad.scope.device_id).is_err());
        }
    }
}

#[cfg(test)]
mod preservation_tests {
    use super::*;
    #[test]
    fn preservation_is_closed_bool_on_fixed_self_route() {
        assert_eq!(
            PRESERVATION_PATH,
            "/api/agent-network/catalog/self-preservation"
        );
        assert!(decode_catalog_preservation(br#"{"ok":true,"data":{"empty":true}}"#).unwrap());
        assert!(!decode_catalog_preservation(br#"{"ok":true,"data":{"empty":false}}"#).unwrap());
        for bytes in [
            br#"{"ok":true,"data":{"empty":true,"token":"unexpected"}}"#.as_slice(),
            br#"{"ok":true,"data":{"empty":true,"empty":false}}"#,
            br#"{"ok":true,"data":{"empty":"true"}}"#,
            br#"{"ok":false,"data":{"empty":true}}"#,
            br#"{"ok":true,"data":{}}"#,
            br#"{"ok":true,"data":{"empty":true},"scope":{}}"#,
        ] {
            assert!(decode_catalog_preservation(bytes).is_err());
        }
    }
}
