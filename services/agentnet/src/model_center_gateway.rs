//! Bounded protocol-preserving transport. No external key is exposed to a Host.
use super::{model_center_store::ModelCenterStore, model_center_types::*};
use axum::{
    body::Body,
    http::{HeaderMap, Response, StatusCode, header},
};
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use url::Url;
const REQUEST_LIMIT: usize = 1_048_576;
const OUTPUT_LIMIT: usize = 8_388_608;
const EVENT_LIMIT: usize = 262_144;
const PROBE_LIMIT: usize = 262_144;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// The HTTP owner must recheck current identity, deployment grant and captured-model authority.
/// Desired assignment/revision changes do not invalidate the captured Session model.
pub type LiveCheck = Arc<dyn Fn(&SessionLease) -> Result<ValidatedBot> + Send + Sync>;
#[derive(Clone, Default)]
pub struct ModelCenterGateway {
    #[cfg(test)]
    test_address: Option<SocketAddr>,
}
impl ModelCenterGateway {
    pub fn new() -> Self {
        Self::default()
    }
    #[cfg(test)]
    pub(crate) fn for_test(address: SocketAddr) -> Self {
        Self {
            test_address: Some(address),
        }
    }
    /// Fetch the provider's model catalog without inference, forwarding bodies or storing secrets.
    pub async fn probe(&self, store: Arc<ModelCenterStore>, provider_id: &str) -> Result<Value> {
        tokio::time::timeout(PROBE_TIMEOUT, self.probe_inner(store, provider_id))
            .await
            .map_err(|_| ModelCenterError::Timeout)?
    }
    async fn probe_inner(&self, store: Arc<ModelCenterStore>, provider_id: &str) -> Result<Value> {
        let (provider, secret) = store.provider_secret_for_probe(provider_id)?;
        let secret = std::str::from_utf8(&secret).map_err(|_| ModelCenterError::Storage)?;
        let path = if provider.api_protocol == ApiProtocol::Anthropic {
            "v1/models"
        } else {
            "models"
        };
        let (client, url) = self
            .client_with_path(&provider, path, PROBE_TIMEOUT)
            .await?;
        let request = apply_auth(
            client.get(url).header(header::ACCEPT, "application/json"),
            &provider,
            secret,
        );
        let upstream = request.send().await.map_err(|e| {
            if e.is_timeout() {
                ModelCenterError::Timeout
            } else {
                ModelCenterError::Upstream
            }
        })?;
        if !upstream.status().is_success() {
            return Err(ModelCenterError::Upstream);
        }
        if upstream
            .content_length()
            .is_some_and(|size| size > PROBE_LIMIT as u64)
        {
            return Err(ModelCenterError::OutputLimit);
        }
        if !upstream
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
        {
            return Err(ModelCenterError::Upstream);
        }
        let mut bytes = Vec::new();
        let mut stream = upstream.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                if e.is_timeout() {
                    ModelCenterError::Timeout
                } else {
                    ModelCenterError::Upstream
                }
            })?;
            if bytes.len() + chunk.len() > PROBE_LIMIT {
                return Err(ModelCenterError::OutputLimit);
            }
            bytes.extend_from_slice(&chunk);
        }
        let raw: Value = serde_json::from_slice(&bytes).map_err(|_| ModelCenterError::Upstream)?;
        if raw.get("error").is_some() {
            return Err(ModelCenterError::Upstream);
        }
        let catalog = raw
            .get("data")
            .and_then(Value::as_array)
            .ok_or(ModelCenterError::Upstream)?;
        let mut models = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for item in catalog {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if id.is_empty()
                || id.len() > 256
                || id.chars().any(char::is_control)
                || !seen.insert(id)
            {
                continue;
            }
            let label = item
                .get("display_name")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            if id.contains(secret) || label.contains(secret) {
                return Err(ModelCenterError::Upstream);
            }
            let label = label
                .chars()
                .filter(|c| !c.is_control())
                .take(128)
                .collect::<String>();
            models.push(serde_json::json!({"id":id,"label":label}));
            if models.len() == 100 {
                break;
            }
        }
        Ok(
            serde_json::json!({"provider_id":provider.id,"provider_revision":provider.revision,"checked_at":super::model_center_store::now(),"models":models}),
        )
    }
    #[cfg(test)]
    pub async fn invoke(
        &self,
        store: Arc<ModelCenterStore>,
        bearer: String,
        request_id: String,
        payload: Value,
        live_check: LiveCheck,
    ) -> Result<Response<Body>> {
        self.invoke_with_headers(
            store,
            bearer,
            request_id,
            payload,
            live_check,
            HeaderMap::new(),
        )
        .await
    }
    /// Only Anthropic beta flags cross this boundary. All credentials/version/routing
    /// headers are built internally; caller Authorization, Host and cookies are ignored.
    pub async fn invoke_with_headers(
        &self,
        store: Arc<ModelCenterStore>,
        bearer: String,
        request_id: String,
        mut payload: Value,
        live_check: LiveCheck,
        incoming_headers: HeaderMap,
    ) -> Result<Response<Body>> {
        let beta = anthropic_beta(&incoming_headers)?;
        let lease = store.authenticate_session(&bearer)?;
        validate_live(&lease, &live_check)?;
        let original_size = serde_json::to_vec(&payload)
            .map_err(|_| ModelCenterError::Invalid)?
            .len();
        if original_size > REQUEST_LIMIT {
            return Err(ModelCenterError::Invalid);
        }
        let object = payload.as_object_mut().ok_or(ModelCenterError::Invalid)?;
        // User supplied model and output fields cannot escape this immutable lease.
        if object
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|m| m != lease.model.config.model_id)
        {
            return Err(ModelCenterError::Unauthorized);
        }
        object.insert(
            "model".into(),
            Value::String(lease.model.config.model_id.clone()),
        );
        let param = &lease.provider.max_output_tokens_param_name;
        let output = object
            .get(param)
            .map(|v| v.as_u64().ok_or(ModelCenterError::Invalid))
            .transpose()?
            .unwrap_or(lease.max_output_tokens);
        if output == 0 || output > lease.max_output_tokens {
            return Err(ModelCenterError::Invalid);
        }
        for key in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
            if key != param && object.contains_key(key) {
                return Err(ModelCenterError::Invalid);
            }
        }
        object.insert(param.clone(), Value::from(output));
        let streaming = object
            .get("stream")
            .map(|v| v.as_bool().ok_or(ModelCenterError::Invalid))
            .transpose()?
            .unwrap_or(false);
        if streaming
            && lease.provider.api_protocol == ApiProtocol::Openai
            && lease.provider.upstream_format == UpstreamFormat::ChatCompletions
        {
            let opts = object
                .entry("stream_options")
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
                .ok_or(ModelCenterError::Invalid)?;
            opts.insert("include_usage".into(), Value::Bool(true));
        }
        // Remote URL/image references make token reservation unknowable and can expose provider-side SSRF.
        if contains_remote_payload(&payload) {
            return Err(ModelCenterError::Invalid);
        }
        let (client, url) = self.client(&lease.provider).await?;
        // Resolve/validate before reservation; transport never redirects or uses ambient proxy variables.
        let live_bot = live_check(&lease)?;
        store.reserve_with_limits(
            &bearer,
            &request_id,
            (original_size as u64) + 1024,
            output,
            &live_bot,
        )?;
        let mut guard = SettlementGuard {
            store: store.clone(),
            lease: lease.clone(),
            request_id: request_id.clone(),
            settled: false,
        };
        let secret = store.provider_secret(&lease)?;
        let secret = std::str::from_utf8(&secret).map_err(|_| ModelCenterError::Storage)?;
        let mut request = client
            .post(url)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&payload);
        request = apply_auth(request, &lease.provider, secret);
        if lease.provider.api_protocol == ApiProtocol::Anthropic
            && let Some(beta) = beta
        {
            request = request.header("anthropic-beta", beta);
        }

        let upstream = match request.send().await {
            Ok(v) => v,
            Err(e) => {
                let outcome = if e.is_timeout() {
                    "timeout"
                } else {
                    "upstream_error"
                };
                guard.finish(None, outcome)?;
                return Err(if e.is_timeout() {
                    ModelCenterError::Timeout
                } else {
                    ModelCenterError::Upstream
                });
            }
        };
        if !upstream.status().is_success() {
            guard.finish(
                None,
                if upstream.status().is_server_error() {
                    "upstream_error"
                } else {
                    "upstream_rejected"
                },
            )?;
            return Err(ModelCenterError::Upstream);
        }
        let content_type = upstream
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if streaming {
            if !content_type.starts_with("text/event-stream") {
                guard.finish(None, "upstream_error")?;
                return Err(ModelCenterError::Upstream);
            }
            let state = StreamState {
                upstream: Box::pin(upstream.bytes_stream()),
                guard,
                live_check,
                bearer,
                pending: Vec::new(),
                total: 0,
                usage: UsageParser::default(),
                deadline: tokio::time::Instant::now() + CALL_TIMEOUT,
                finished: false,
            };
            let stream = futures_util::stream::unfold(state, |mut state| async move {
                if state.finished {
                    return None;
                }
                if state
                    .guard
                    .store
                    .authenticate_session(&state.bearer)
                    .is_err()
                    || validate_live(&state.guard.lease, &state.live_check).is_err()
                {
                    let _ = state.guard.finish(None, "revoked");
                    state.finished = true;
                    return Some((
                        Err(std::io::Error::other("MODEL_CENTER_CREDENTIAL_REJECTED")),
                        state,
                    ));
                }
                match tokio::time::timeout_at(state.deadline, state.upstream.next()).await {
                    Ok(Some(Ok(bytes))) => {
                        state.total = state.total.saturating_add(bytes.len());
                        if state.total > OUTPUT_LIMIT {
                            let _ = state.guard.finish(None, "output_limit");
                            state.finished = true;
                            return Some((
                                Err(std::io::Error::other("MODEL_CENTER_OUTPUT_LIMIT")),
                                state,
                            ));
                        }
                        // Inspect complete SSE frames before sending them; provider error payloads never pass through.
                        state.pending.extend_from_slice(&bytes);
                        let mut forward = Vec::new();
                        while let Some((end, delimiter)) = frame_end(&state.pending) {
                            let frame = state.pending.drain(..end + delimiter).collect::<Vec<_>>();
                            if frame.len() > EVENT_LIMIT
                                || !state.usage.feed_sse(
                                    &frame,
                                    state.guard.lease.provider.api_protocol,
                                    state.guard.lease.provider.upstream_format,
                                )
                            {
                                let _ = state.guard.finish(None, "upstream_error");
                                state.finished = true;
                                return Some((
                                    Err(std::io::Error::other("MODEL_CENTER_UPSTREAM_REJECTED")),
                                    state,
                                ));
                            }
                            forward.extend_from_slice(&frame);
                            if state.usage.terminal {
                                state.pending.clear();
                                break;
                            }
                        }
                        if state.pending.len() > EVENT_LIMIT {
                            let _ = state.guard.finish(None, "output_limit");
                            state.finished = true;
                            return Some((
                                Err(std::io::Error::other("MODEL_CENTER_OUTPUT_LIMIT")),
                                state,
                            ));
                        }
                        if state.usage.terminal {
                            let usage = state.usage.final_usage();
                            let _ = state.guard.finish(usage, "success");
                            state.finished = true;
                        }
                        Some((
                            Ok::<_, std::io::Error>(axum::body::Bytes::from(forward)),
                            state,
                        ))
                    }
                    Ok(None) => {
                        // EOF without protocol terminal is an interrupted result, even if usage appeared earlier.
                        let outcome = if state.usage.terminal && state.pending.is_empty() {
                            "success"
                        } else {
                            "interrupted"
                        };
                        let usage = state.usage.final_usage();
                        let _ = state.guard.finish(usage, outcome);
                        state.finished = true;
                        if outcome == "success" {
                            None
                        } else {
                            Some((
                                Err(std::io::Error::other("MODEL_CENTER_UPSTREAM_INTERRUPTED")),
                                state,
                            ))
                        }
                    }
                    Ok(Some(Err(_))) => {
                        let _ = state.guard.finish(None, "interrupted");
                        state.finished = true;
                        Some((
                            Err(std::io::Error::other("MODEL_CENTER_UPSTREAM_INTERRUPTED")),
                            state,
                        ))
                    }
                    Err(_) => {
                        let _ = state.guard.finish(None, "timeout");
                        state.finished = true;
                        Some((
                            Err(std::io::Error::other("MODEL_CENTER_UPSTREAM_TIMEOUT")),
                            state,
                        ))
                    }
                }
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from_stream(stream))
                .map_err(|_| ModelCenterError::Storage)
        } else {
            if !content_type.starts_with("application/json") {
                guard.finish(None, "upstream_error")?;
                return Err(ModelCenterError::Upstream);
            }
            let mut bytes = Vec::new();
            let mut stream = upstream.bytes_stream();
            let deadline = tokio::time::Instant::now() + CALL_TIMEOUT;
            loop {
                match tokio::time::timeout_at(deadline, stream.next()).await {
                    Ok(Some(Ok(chunk))) => {
                        if bytes.len() + chunk.len() > OUTPUT_LIMIT {
                            guard.finish(None, "output_limit")?;
                            return Err(ModelCenterError::OutputLimit);
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Ok(Some(Err(_))) => {
                        guard.finish(None, "interrupted")?;
                        return Err(ModelCenterError::Upstream);
                    }
                    Err(_) => {
                        guard.finish(None, "timeout")?;
                        return Err(ModelCenterError::Timeout);
                    }
                }
            }
            let response: Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(_) => {
                    guard.finish(None, "upstream_error")?;
                    return Err(ModelCenterError::Upstream);
                }
            };
            if response.get("error").is_some() {
                guard.finish(None, "upstream_error")?;
                return Err(ModelCenterError::Upstream);
            }
            guard.finish(
                parse_usage(
                    &response,
                    lease.provider.api_protocol,
                    lease.provider.upstream_format,
                ),
                "success",
            )?;
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(bytes))
                .map_err(|_| ModelCenterError::Storage)
        }
    }
    async fn client(&self, p: &Provider) -> Result<(reqwest::Client, Url)> {
        let path = match (p.api_protocol, p.upstream_format) {
            (ApiProtocol::Anthropic, _) => "v1/messages",
            (ApiProtocol::Openai, UpstreamFormat::ChatCompletions) => "chat/completions",
            (ApiProtocol::Openai, UpstreamFormat::Responses) => "responses",
        };
        self.client_with_path(p, path, CALL_TIMEOUT).await
    }
    async fn client_with_path(
        &self,
        p: &Provider,
        path: &str,
        request_timeout: Duration,
    ) -> Result<(reqwest::Client, Url)> {
        let mut url = validate_base_url(&p.base_url)?;
        url.set_path(&format!("{}/{path}", url.path().trim_end_matches('/')));
        let host = url
            .host_str()
            .ok_or(ModelCenterError::UnsafeUpstream)?
            .to_owned();
        #[cfg(test)]
        if let Some(addr) = self.test_address {
            url.set_scheme("http")
                .map_err(|_| ModelCenterError::UnsafeUpstream)?;
            url.set_port(Some(addr.port()))
                .map_err(|_| ModelCenterError::UnsafeUpstream)?;
            let c = client_builder()
                .timeout(request_timeout)
                .resolve(&host, addr)
                .build()
                .map_err(|_| ModelCenterError::Storage)?;
            return Ok((c, url));
        }
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 443))
            .await
            .map_err(|_| ModelCenterError::UnsafeUpstream)?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(ModelCenterError::UnsafeUpstream);
        }
        let client = client_builder()
            .timeout(request_timeout)
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| ModelCenterError::Storage)?;
        Ok((client, url))
    }
}
fn anthropic_beta(headers: &HeaderMap) -> Result<Option<String>> {
    let values = headers.get_all("anthropic-beta").iter().collect::<Vec<_>>();
    match values.as_slice() {
        [] => Ok(None),
        [value] => {
            let flags = value.to_str().map_err(|_| ModelCenterError::Invalid)?;
            if flags.is_empty() || flags.len() > 1024 {
                return Err(ModelCenterError::Invalid);
            }
            let tokens = flags
                .split(',')
                .map(|token| token.trim_matches([' ', '\t']))
                .collect::<Vec<_>>();
            if tokens.iter().any(|token| {
                token.is_empty()
                    || !token
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            }) {
                return Err(ModelCenterError::Invalid);
            }
            Ok(Some(tokens.join(",")))
        }
        _ => Err(ModelCenterError::Invalid),
    }
}
fn apply_auth(
    request: reqwest::RequestBuilder,
    provider: &Provider,
    secret: &str,
) -> reqwest::RequestBuilder {
    match (provider.api_protocol, provider.auth_type) {
        (ApiProtocol::Anthropic, AuthType::ApiKey) => request
            .header("x-api-key", secret)
            .header("anthropic-version", "2023-06-01"),
        (ApiProtocol::Anthropic, AuthType::AuthToken) => request
            .bearer_auth(secret)
            .header("anthropic-version", "2023-06-01"),
        (ApiProtocol::Openai, _) => request.bearer_auth(secret),
    }
}
fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(CALL_TIMEOUT)
        .pool_max_idle_per_host(0)
}
pub fn validate_base_url(base: &str) -> Result<Url> {
    let url = Url::parse(base).map_err(|_| ModelCenterError::UnsafeUpstream)?;
    let host = url.host_str().ok_or(ModelCenterError::UnsafeUpstream)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|p| p != 443)
        || host.parse::<IpAddr>().is_ok()
        || !host.contains('.')
        || host.ends_with('.')
        || host.len() > 253
        || base.len() > 2048
        || url.path().contains('%')
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.to_ascii_lowercase().ends_with(".local")
    {
        return Err(ModelCenterError::UnsafeUpstream);
    }
    Ok(url)
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            !a.is_private()
                && !a.is_loopback()
                && !a.is_link_local()
                && !a.is_multicast()
                && !a.is_broadcast()
                && !a.is_documentation()
                && o[0] != 0
                && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 198 && (o[1] == 18 || o[1] == 19))
                && !(o[0] == 192 && o[1] == 0 && o[2] == 0)
                && !(o[0] == 192 && o[1] == 88 && o[2] == 99)
        }
        IpAddr::V6(a) => {
            let s = a.segments();
            s[0] & 0xe000 == 0x2000
                && s[0] != 0x3fff
                && s[0] != 0x2002
                && !(s[0] == 0x2001
                    && (s[1] == 0x0db8
                        || s[1] == 2
                        || s[1] == 0
                        || s[1] & 0xfff0 == 0x10
                        || s[1] & 0xfff0 == 0x20))
        }
    }
}
fn validate_live(lease: &SessionLease, check: &LiveCheck) -> Result<()> {
    let live = check(lease)?;
    if live.bot_id != lease.bot.bot_id
        || live.owner_id != lease.bot.owner_id
        || live.host_id != lease.bot.host_id
        || live.host_key_generation != lease.bot.host_key_generation
        || live.identity_binding_id != lease.bot.identity_binding_id
    {
        return Err(ModelCenterError::Unauthorized);
    }
    Ok(())
}
fn contains_remote_payload(value: &Value) -> bool {
    match value {
        Value::String(_) => false,
        Value::Array(a) => a.iter().any(contains_remote_payload),
        Value::Object(o) => o.iter().any(|(k, v)| {
            [
                "image_url",
                "file_url",
                "file_id",
                "previous_response_id",
                "conversation",
                "service_tier",
            ]
            .contains(&k.as_str())
                || (k == "store" || k == "background") && v != &Value::Bool(false)
                || (k == "type"
                    && v.as_str().is_some_and(|s| {
                        ["image", "document", "input_image", "input_file"].contains(&s)
                    }))
                || contains_remote_payload(v)
        }),
        _ => false,
    }
}
struct SettlementGuard {
    store: Arc<ModelCenterStore>,
    lease: SessionLease,
    request_id: String,
    settled: bool,
}
impl SettlementGuard {
    fn finish(&mut self, usage: Option<TokenUsage>, outcome: &str) -> Result<()> {
        self.store
            .settle(&self.lease, &self.request_id, usage, outcome)?;
        self.settled = true;
        Ok(())
    }
}
impl Drop for SettlementGuard {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self
                .store
                .settle(&self.lease, &self.request_id, None, "disconnected");
        }
    }
}
struct StreamState {
    upstream: std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = std::result::Result<axum::body::Bytes, reqwest::Error>>
                + Send,
        >,
    >,
    guard: SettlementGuard,
    live_check: LiveCheck,
    bearer: String,
    pending: Vec<u8>,
    total: usize,
    usage: UsageParser,
    deadline: tokio::time::Instant,
    finished: bool,
}
fn frame_end(b: &[u8]) -> Option<(usize, usize)> {
    let a = b.windows(2).position(|v| v == b"\n\n").map(|n| (n, 2));
    let c = b.windows(4).position(|v| v == b"\r\n\r\n").map(|n| (n, 4));
    match (a, c) {
        (Some(x), Some(y)) => Some(if x.0 < y.0 { x } else { y }),
        (x, None) => x,
        (None, y) => y,
    }
}
#[derive(Default)]
struct UsageParser {
    input: Option<u64>,
    output: Option<u64>,
    terminal: bool,
    unknown_cache: bool,
}
impl UsageParser {
    fn feed_sse(&mut self, frame: &[u8], protocol: ApiProtocol, format: UpstreamFormat) -> bool {
        let Ok(text) = std::str::from_utf8(frame) else {
            return false;
        };
        if text
            .lines()
            .filter_map(|line| line.strip_prefix("event:"))
            .any(|event| ["error", "response.failed", "response.error"].contains(&event.trim()))
        {
            return false;
        }
        let data = text
            .lines()
            .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            return true;
        }
        if data == "[DONE]" {
            if protocol == ApiProtocol::Openai && format == UpstreamFormat::ChatCompletions {
                self.terminal = true;
                return true;
            }
            return false;
        }
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            return false;
        };
        if event.get("error").is_some()
            || event.get("type").and_then(Value::as_str) == Some("error")
        {
            return false;
        }
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match (protocol, format) {
            (ApiProtocol::Anthropic, _) => {
                let u = if kind == "message_start" {
                    event.get("message").and_then(|m| m.get("usage"))
                } else {
                    event.get("usage")
                };
                if let Some(u) = u {
                    self.input = u.get("input_tokens").and_then(Value::as_u64).or(self.input);
                    self.output = u
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .or(self.output);
                    self.unknown_cache |= has_cache(u);
                }
                if kind == "message_stop" {
                    self.terminal = true;
                }
            }
            (ApiProtocol::Openai, UpstreamFormat::ChatCompletions) => {
                if let Some(u) = event.get("usage") {
                    self.input = u
                        .get("prompt_tokens")
                        .and_then(Value::as_u64)
                        .or(self.input);
                    self.output = u
                        .get("completion_tokens")
                        .and_then(Value::as_u64)
                        .or(self.output);
                }
            }
            (ApiProtocol::Openai, UpstreamFormat::Responses) => {
                if kind == "response.failed" || kind == "response.error" {
                    return false;
                }
                if ["response.completed", "response.incomplete"].contains(&kind) {
                    if let Some(r) = event.get("response") {
                        if r.get("error").is_some_and(|v| !v.is_null()) {
                            return false;
                        }
                        if let Some(u) = r.get("usage") {
                            self.input = u.get("input_tokens").and_then(Value::as_u64);
                            self.output = u.get("output_tokens").and_then(Value::as_u64);
                        }
                    }
                    self.terminal = true;
                }
            }
        }
        true
    }
    fn final_usage(&self) -> Option<TokenUsage> {
        if self.unknown_cache {
            return None;
        }
        Some(TokenUsage {
            input: self.input?,
            output: self.output?,
        })
    }
}
fn has_cache(u: &Value) -> bool {
    ["cache_creation_input_tokens", "cache_read_input_tokens"]
        .iter()
        .any(|k| u.get(k).and_then(Value::as_u64).is_some_and(|v| v > 0))
}
fn parse_usage(
    response: &Value,
    protocol: ApiProtocol,
    format: UpstreamFormat,
) -> Option<TokenUsage> {
    let u = response.get("usage")?;
    if protocol == ApiProtocol::Anthropic && has_cache(u) {
        return None;
    }
    let (input, output) = match (protocol, format) {
        (ApiProtocol::Openai, UpstreamFormat::ChatCompletions) => {
            ("prompt_tokens", "completion_tokens")
        }
        _ => ("input_tokens", "output_tokens"),
    };
    Some(TokenUsage {
        input: u.get(input)?.as_u64()?,
        output: u.get(output)?.as_u64()?,
    })
}

#[cfg(test)]
mod tests {
    use super::super::model_center_store::tests::{Fixture, fixture, id};
    use super::*;
    use axum::{Json, Router, extract::State, routing::post};
    use std::sync::Mutex;
    #[derive(Clone)]
    struct Upstream {
        protocol: ApiProtocol,
        format: UpstreamFormat,
        mode: &'static str,
        captured: Arc<Mutex<Option<(String, axum::http::HeaderMap, Value)>>>,
    }
    async fn handler(
        State(s): State<Upstream>,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
        Json(payload): Json<Value>,
    ) -> Response<Body> {
        *s.captured.lock().unwrap() = Some((uri.path().into(), headers, payload.clone()));
        if s.mode == "redirect" {
            return Response::builder()
                .status(302)
                .header("location", "http://127.0.0.1:1/steal")
                .body(Body::empty())
                .unwrap();
        }
        if s.mode == "oversized" {
            return Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    "{{\"content\":\"{}\"}}",
                    "x".repeat(OUTPUT_LIMIT)
                )))
                .unwrap();
        }
        if s.mode == "error" {
            return Response::builder()
                .status(401)
                .header("x-api-key", "fixture-secret-do-not-persist")
                .body(Body::from(
                    "fixture-secret-do-not-persist upstream private error",
                ))
                .unwrap();
        }
        if !payload
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let body = if s.mode == "unknown" {
                serde_json::json!({"id":"fixture","content":"synthetic reply"})
            } else {
                match (s.protocol, s.format) {
                    (ApiProtocol::Openai, UpstreamFormat::ChatCompletions) => {
                        serde_json::json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}})
                    }
                    _ => {
                        serde_json::json!({"content":[],"usage":{"input_tokens":5,"output_tokens":7}})
                    }
                }
            };
            return Response::builder()
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
        }
        let body = if s.mode == "sse_error" {
            "data: {\"type\":\"error\",\"error\":{\"message\":\"fixture-secret-do-not-persist\"}}\n\n".into()
        } else {
            match(s.protocol,s.format){
            (ApiProtocol::Anthropic,_)=>format!("data: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":5,\"output_tokens\":0}}}}}}\n\ndata: {{\"type\":\"message_delta\",\"usage\":{{\"output_tokens\":7}}}}\n\n{}",if s.mode=="interrupt"{""}else{"data: {\"type\":\"message_stop\"}\n\n"}),
            (ApiProtocol::Openai,UpstreamFormat::ChatCompletions)=>"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":7}}\n\ndata: [DONE]\n\n".into(),
            (ApiProtocol::Openai,UpstreamFormat::Responses)=>"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":5,\"output_tokens\":7}}}\n\n".into(),
        }
        };
        Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(body))
            .unwrap()
    }
    async fn upstream(
        f: &Fixture,
        mode: &'static str,
    ) -> (ModelCenterGateway, Upstream, tokio::task::JoinHandle<()>) {
        let state = Upstream {
            protocol: f.lease.provider.api_protocol,
            format: f.lease.provider.upstream_format,
            mode,
            captured: Arc::new(Mutex::new(None)),
        };
        let router = Router::new()
            .fallback(post(handler))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = ModelCenterGateway::for_test(listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (gateway, state, handle)
    }
    fn live(f: &Fixture) -> LiveCheck {
        let bot = f.bot.clone();
        Arc::new(move |_| Ok(bot.clone()))
    }
    fn payload(f: &Fixture, stream: bool) -> Value {
        let mut p = serde_json::json!({"model":"fixture-model","stream":stream});
        p[&f.lease.provider.max_output_tokens_param_name] = Value::from(32);
        if f.lease.provider.upstream_format == UpstreamFormat::Responses {
            p["input"] = serde_json::json!([{"role":"user","content":"synthetic fixture prompt"}]);
            p["store"] = Value::Bool(false);
        } else {
            p["messages"] =
                serde_json::json!([{"role":"user","content":"synthetic fixture prompt"}]);
        }
        p
    }
    #[tokio::test]
    async fn protocol_transport_auth_path_output_and_usage() {
        for (protocol, auth, format, path) in [
            (
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                "/v1/messages",
            ),
            (
                ApiProtocol::Anthropic,
                AuthType::AuthToken,
                UpstreamFormat::ChatCompletions,
                "/v1/messages",
            ),
            (
                ApiProtocol::Openai,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                "/v1/chat/completions",
            ),
            (
                ApiProtocol::Openai,
                AuthType::ApiKey,
                UpstreamFormat::Responses,
                "/v1/responses",
            ),
        ] {
            for stream in [false, true] {
                let f = fixture(protocol, auth, format, 10000, 2);
                let (gateway, state, handle) = upstream(&f, "success").await;
                let response = gateway
                    .invoke(
                        f.store.clone(),
                        f.bearer.clone(),
                        id(),
                        payload(&f, stream),
                        live(&f),
                    )
                    .await
                    .unwrap();
                let bytes = axum::body::to_bytes(response.into_body(), OUTPUT_LIMIT)
                    .await
                    .unwrap();
                assert!(!bytes.is_empty());
                let capture = state.captured.lock().unwrap();
                let (p, h, b) = capture.as_ref().unwrap();
                assert_eq!(p, path);
                assert_eq!(b[&f.lease.provider.max_output_tokens_param_name], 32);
                assert_eq!(b["model"], "fixture-model");
                if auth == AuthType::ApiKey && protocol == ApiProtocol::Anthropic {
                    assert_eq!(h["x-api-key"], "fixture-secret-do-not-persist");
                    assert!(!h.contains_key("authorization"));
                } else {
                    assert_eq!(h["authorization"], "Bearer fixture-secret-do-not-persist");
                    assert!(!h.contains_key("x-api-key"));
                }
                drop(capture);
                let records = f.store.usage(10).unwrap();
                assert_eq!(records[0].charged_tokens, 12);
                assert!(records[0].usage_known);
                assert_eq!(records[0].cost_microusd, Some(52));
                assert!(
                    !serde_json::to_string(&records)
                        .unwrap()
                        .contains("synthetic fixture prompt")
                );
                handle.abort();
            }
        }
    }
    #[tokio::test]
    async fn interrupted_sse_keeps_reservation_and_blocks_request_replay() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            2,
        );
        let (gateway, _, handle) = upstream(&f, "interrupt").await;
        let request = id();
        let response = gateway
            .invoke(
                f.store.clone(),
                f.bearer.clone(),
                request.clone(),
                payload(&f, true),
                live(&f),
            )
            .await
            .unwrap();
        assert!(
            axum::body::to_bytes(response.into_body(), OUTPUT_LIMIT)
                .await
                .is_err()
        );
        let record = f.store.usage(1).unwrap().remove(0);
        assert_eq!(record.outcome, "interrupted");
        assert_eq!(record.charged_tokens, record.reserved_tokens);
        assert!(!record.usage_known);
        assert!(matches!(
            gateway
                .invoke(
                    f.store.clone(),
                    f.bearer.clone(),
                    request,
                    payload(&f, true),
                    live(&f)
                )
                .await,
            Err(ModelCenterError::Unauthorized)
        ));
        handle.abort();
    }
    #[tokio::test]
    async fn errors_and_redirects_never_expose_upstream_credentials() {
        for mode in ["error", "redirect", "sse_error"] {
            let f = fixture(
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                10000,
                2,
            );
            let (gateway, _, handle) = upstream(&f, mode).await;
            let result = gateway
                .invoke(
                    f.store.clone(),
                    f.bearer.clone(),
                    id(),
                    payload(&f, mode == "sse_error"),
                    live(&f),
                )
                .await;
            if mode == "sse_error" {
                let response = result.unwrap();
                let err = axum::body::to_bytes(response.into_body(), OUTPUT_LIMIT)
                    .await
                    .unwrap_err();
                assert!(!err.to_string().contains("fixture-secret"));
            } else {
                assert!(matches!(result, Err(ModelCenterError::Upstream)));
            }
            assert_eq!(
                f.store.usage(1).unwrap()[0].outcome,
                if mode == "sse_error" {
                    "upstream_error"
                } else {
                    "upstream_rejected"
                }
            );
            handle.abort();
        }
    }
    #[tokio::test]
    async fn unknown_usage_and_consumer_disconnect_keep_conservative_charge() {
        for (stream, mode) in [(false, "unknown"), (true, "success")] {
            let f = fixture(
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                10000,
                2,
            );
            let (gateway, _, handle) = upstream(&f, mode).await;
            let response = gateway
                .invoke(
                    f.store.clone(),
                    f.bearer.clone(),
                    id(),
                    payload(&f, stream),
                    live(&f),
                )
                .await
                .unwrap();
            drop(response);
            let r = f.store.usage(1).unwrap().remove(0);
            assert!(!r.usage_known);
            assert_eq!(r.charged_tokens, r.reserved_tokens);
            assert_eq!(r.outcome, if stream { "disconnected" } else { "success" });
            assert_eq!(f.store.status().unwrap()["active_calls"], 0);
            handle.abort();
        }
    }
    #[tokio::test]
    async fn captured_assignment_survives_desired_revision_change_and_owner_change_fails() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            2,
        );
        let (gateway, _, handle) = upstream(&f, "success").await;
        let mut changed = f.bot.clone();
        changed.model_ref = id();
        changed.binding_revision += 1;
        let check: LiveCheck = Arc::new(move |_| Ok(changed.clone()));
        assert!(
            gateway
                .invoke(
                    f.store.clone(),
                    f.bearer.clone(),
                    id(),
                    payload(&f, false),
                    check
                )
                .await
                .is_ok()
        );
        let mut changed = f.bot.clone();
        changed.owner_id = id();
        let check: LiveCheck = Arc::new(move |_| Ok(changed.clone()));
        assert!(matches!(
            gateway
                .invoke(
                    f.store.clone(),
                    f.bearer.clone(),
                    id(),
                    payload(&f, false),
                    check
                )
                .await,
            Err(ModelCenterError::Unauthorized)
        ));
        handle.abort();
    }
    #[test]
    fn upstream_ssrf_validation_rejects_private_and_rebinding_targets() {
        for value in [
            "http://api.example/v1",
            "https://127.0.0.1/v1",
            "https://[::1]/v1",
            "https://api.example:444/v1",
            "https://u:p@api.example/v1",
            "https://api.example/v1?api_key=secret",
            "https://local/v1",
            "https://foo.local/v1",
            "https://api.example/v1%2ffoo",
        ] {
            assert!(validate_base_url(value).is_err(), "{value}");
        }
        for value in [
            "127.0.0.1",
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.0.1",
            "192.0.0.10",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "::ffff:8.8.8.8",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "3fff::1",
            "2002:7f00:1::1",
        ] {
            assert!(!public_ip(value.parse().unwrap()), "{value}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[tokio::test]
    async fn revoked_stream_and_oversized_output_fail_closed() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            2,
        );
        let (gateway, _, handle) = upstream(&f, "success").await;
        let response = gateway
            .invoke(
                f.store.clone(),
                f.bearer.clone(),
                id(),
                payload(&f, true),
                live(&f),
            )
            .await
            .unwrap();
        f.store.revoke_session(&f.lease.session_id).unwrap();
        assert!(
            axum::body::to_bytes(response.into_body(), OUTPUT_LIMIT)
                .await
                .is_err()
        );
        assert_eq!(f.store.usage(1).unwrap()[0].outcome, "revoked");
        handle.abort();
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            2,
        );
        let (gateway, _, handle) = upstream(&f, "oversized").await;
        assert!(matches!(
            gateway
                .invoke(
                    f.store.clone(),
                    f.bearer.clone(),
                    id(),
                    payload(&f, false),
                    live(&f)
                )
                .await,
            Err(ModelCenterError::OutputLimit)
        ));
        let r = f.store.usage(1).unwrap().remove(0);
        assert_eq!(r.outcome, "output_limit");
        assert_eq!(r.charged_tokens, r.reserved_tokens);
        assert!(!r.usage_known);
        handle.abort();
    }
    #[test]
    fn cache_usage_and_error_events_cannot_be_claimed_as_known_zero() {
        let mut parser = UsageParser::default();
        assert!(parser.feed_sse(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":10,\"output_tokens\":0}}}\n\n",ApiProtocol::Anthropic,UpstreamFormat::ChatCompletions));
        assert!(parser.feed_sse(
            b"data: {\"type\":\"message_stop\"}\n\n",
            ApiProtocol::Anthropic,
            UpstreamFormat::ChatCompletions
        ));
        assert_eq!(parser.final_usage().map(|u| u.input), None);
        assert!(!parser.feed_sse(
            b"event: error\ndata: {\"message\":\"private-upstream-token\"}\n\n",
            ApiProtocol::Anthropic,
            UpstreamFormat::ChatCompletions
        ));
    }
    #[tokio::test]
    async fn beta_header_is_preserved_and_caller_credentials_are_never_forwarded() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            2,
        );
        let (gateway, state, handle) = upstream(&f, "success").await;
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            "interleaved-thinking-2025-05-14, context-1m-2025-08-07"
                .parse()
                .unwrap(),
        );
        headers.insert("x-stainless-retry-count", "0".parse().unwrap());
        headers.insert("x-stainless-lang", "js".parse().unwrap());
        headers.insert("anthropic-version", "forged-version".parse().unwrap());
        headers.insert(
            "authorization",
            "Bearer forged-caller-auth".parse().unwrap(),
        );
        headers.insert("x-api-key", "forged-caller-key".parse().unwrap());
        headers.insert("host", "forged.invalid".parse().unwrap());
        headers.insert("cookie", "private=forged-cookie".parse().unwrap());
        headers.insert("x-custom-private", "forged-custom-value".parse().unwrap());
        let response = gateway
            .invoke_with_headers(
                f.store.clone(),
                f.bearer.clone(),
                id(),
                payload(&f, false),
                live(&f),
                headers,
            )
            .await
            .unwrap();
        assert!(
            axum::body::to_bytes(response.into_body(), OUTPUT_LIMIT)
                .await
                .is_ok()
        );
        {
            let capture = state.captured.lock().unwrap();
            let (_, headers, _) = capture.as_ref().unwrap();
            assert_eq!(
                headers["anthropic-beta"],
                "interleaved-thinking-2025-05-14,context-1m-2025-08-07"
            );
            assert_eq!(headers["anthropic-version"], "2023-06-01");
            assert_eq!(headers["x-api-key"], "fixture-secret-do-not-persist");
            assert!(!headers.contains_key("authorization"));
            assert_ne!(headers["host"], "forged.invalid");
            assert!(!headers.contains_key("cookie"));
            assert!(!headers.contains_key("x-custom-private"));
            assert!(!headers.contains_key("x-stainless-retry-count"));
            assert!(!headers.contains_key("x-stainless-lang"));
        }
        handle.abort();
    }
    #[tokio::test]
    async fn malformed_beta_rejected_before_admission_or_upstream_request() {
        let f = fixture(
            ApiProtocol::Anthropic,
            AuthType::ApiKey,
            UpstreamFormat::ChatCompletions,
            10000,
            2,
        );
        let (gateway, state, handle) = upstream(&f, "success").await;
        let mut cases = vec![
            "".to_string(),
            "flag one".into(),
            "flag_one".into(),
            "flag,;authorization".into(),
            ",flag".into(),
            "flag,,another".into(),
            "flag,".into(),
            "a".repeat(1025),
        ];
        for value in cases.drain(..) {
            let mut headers = HeaderMap::new();
            headers.insert("anthropic-beta", value.parse().unwrap());
            assert!(matches!(
                gateway
                    .invoke_with_headers(
                        f.store.clone(),
                        f.bearer.clone(),
                        id(),
                        payload(&f, false),
                        live(&f),
                        headers
                    )
                    .await,
                Err(ModelCenterError::Invalid)
            ));
        }
        let mut duplicated = HeaderMap::new();
        duplicated.append("anthropic-beta", "flag-one".parse().unwrap());
        duplicated.append("anthropic-beta", "flag-two".parse().unwrap());
        assert!(matches!(
            gateway
                .invoke_with_headers(
                    f.store.clone(),
                    f.bearer.clone(),
                    id(),
                    payload(&f, false),
                    live(&f),
                    duplicated
                )
                .await,
            Err(ModelCenterError::Invalid)
        ));
        assert!(f.store.usage(10).unwrap().is_empty());
        assert!(state.captured.lock().unwrap().is_none());
        assert!(f.store.authenticate_session(&f.bearer).is_ok());
        handle.abort();
    }
}

#[cfg(test)]
mod probe_and_retry_tests {
    use super::super::model_center_store::tests::{Fixture, fixture, id};
    use super::*;
    use axum::{Router, extract::State, routing::get};
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    #[derive(Clone)]
    struct Mock {
        mode: &'static str,
        count: Arc<AtomicUsize>,
        capture: Arc<Mutex<Option<(String, axum::http::HeaderMap)>>>,
    }
    async fn handler(
        State(mock): State<Mock>,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
    ) -> Response<Body> {
        mock.count.fetch_add(1, Ordering::SeqCst);
        *mock.capture.lock().unwrap() = Some((uri.path().into(), headers));
        match mock.mode {
            "503"=>Response::builder().status(503).body(Body::from("fixture-secret-do-not-persist private upstream error")).unwrap(),
            "rejected"=>Response::builder().status(400).body(Body::from("fixture-secret-do-not-persist private upstream error")).unwrap(),
            "redirect"=>Response::builder().status(302).header("location","http://127.0.0.1:1/private").body(Body::empty()).unwrap(),
            "disconnect"=>Response::builder().header(header::CONTENT_TYPE,"application/json").body(Body::from_stream(futures_util::stream::once(async{Err::<axum::body::Bytes,_>(std::io::Error::other("fixture transport interrupted"))}))).unwrap(),
            "oversized"=>Response::builder().header(header::CONTENT_TYPE,"application/json").body(Body::from("x".repeat(PROBE_LIMIT+1))).unwrap(),
            "secret_in_label"=>Response::builder().header(header::CONTENT_TYPE,"application/json").body(Body::from(serde_json::json!({"data":[{"id":"safe","display_name":"fixture-secret-do-not-persist"}]}).to_string())).unwrap(),
            "success_unknown"=>Response::builder().header(header::CONTENT_TYPE,"application/json").body(Body::from("{\"id\":\"confirmed-result\",\"content\":[]}")).unwrap(),
            _=>{let models=(0..150).map(|index|serde_json::json!({"id":format!("model-{index}"),"display_name":format!("Display {index}"),"api_key":"fixture-secret-do-not-persist","private_metadata":"discarded"})).collect::<Vec<_>>();Response::builder().header(header::CONTENT_TYPE,"application/json").body(Body::from(serde_json::json!({"data":models,"private":"discarded"}).to_string())).unwrap()},
        }
    }
    async fn mock(mode: &'static str) -> (ModelCenterGateway, Mock, tokio::task::JoinHandle<()>) {
        let state = Mock {
            mode,
            count: Arc::new(AtomicUsize::new(0)),
            capture: Arc::new(Mutex::new(None)),
        };
        let router = Router::new()
            .fallback(get(handler).post(handler))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = ModelCenterGateway::for_test(listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (gateway, state, handle)
    }
    fn live(f: &Fixture) -> LiveCheck {
        let bot = f.bot.clone();
        Arc::new(move |_| Ok(bot.clone()))
    }
    fn payload() -> Value {
        serde_json::json!({"model":"fixture-model","messages":[{"role":"user","content":"fixture prompt"}],"max_tokens":32})
    }
    #[tokio::test]
    async fn catalog_probe_uses_protocol_auth_and_only_returns_bounded_public_models() {
        for (protocol, auth, format) in [
            (
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
            ),
            (
                ApiProtocol::Anthropic,
                AuthType::AuthToken,
                UpstreamFormat::ChatCompletions,
            ),
            (
                ApiProtocol::Openai,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
            ),
            (
                ApiProtocol::Openai,
                AuthType::ApiKey,
                UpstreamFormat::Responses,
            ),
        ] {
            let f = fixture(protocol, auth, format, 10000, 2);
            let (gateway, state, handle) = mock("catalog").await;
            let result = gateway
                .probe(f.store.clone(), &f.lease.provider.id)
                .await
                .unwrap();
            assert_eq!(result["models"].as_array().unwrap().len(), 100);
            assert_eq!(
                result["models"][0],
                serde_json::json!({"id":"model-0","label":"Display 0"})
            );
            assert_eq!(result["provider_revision"], 1);
            assert!(!result.to_string().contains("fixture-secret"));
            assert!(!result.to_string().contains("private_metadata"));
            assert!(f.store.usage(10).unwrap().is_empty());
            {
                let captured = state.capture.lock().unwrap();
                let (path, headers) = captured.as_ref().unwrap();
                assert_eq!(path, "/v1/models");
                if protocol == ApiProtocol::Anthropic && auth == AuthType::ApiKey {
                    assert_eq!(headers["x-api-key"], "fixture-secret-do-not-persist");
                    assert!(!headers.contains_key("authorization"));
                } else {
                    assert_eq!(
                        headers["authorization"],
                        "Bearer fixture-secret-do-not-persist"
                    );
                }
            }
            assert_eq!(state.count.load(Ordering::SeqCst), 1);
            handle.abort();
        }
    }
    #[tokio::test]
    async fn catalog_probe_rejects_errors_redirects_large_or_secret_catalogs() {
        for mode in ["503", "redirect", "oversized", "secret_in_label"] {
            let f = fixture(
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                10000,
                2,
            );
            let (gateway, state, handle) = mock(mode).await;
            let error = gateway
                .probe(f.store.clone(), &f.lease.provider.id)
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("fixture-secret"));
            assert_eq!(state.count.load(Ordering::SeqCst), 1);
            assert!(f.store.usage(10).unwrap().is_empty());
            handle.abort();
        }
    }
    #[tokio::test]
    async fn unknown_result_quarantines_same_lease_for_distinct_request_ids() {
        for mode in ["503", "disconnect"] {
            let f = fixture(
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                10000,
                2,
            );
            let (gateway, state, handle) = mock(mode).await;
            let first_request = id();
            assert!(
                gateway
                    .invoke(
                        f.store.clone(),
                        f.bearer.clone(),
                        first_request.clone(),
                        payload(),
                        live(&f)
                    )
                    .await
                    .is_err()
            );
            assert!(matches!(
                gateway
                    .invoke(f.store.clone(), f.bearer.clone(), id(), payload(), live(&f))
                    .await,
                Err(ModelCenterError::Unauthorized)
            ));
            assert_eq!(state.count.load(Ordering::SeqCst), 1);
            let rows = f.store.usage(10).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].charged_tokens, rows[0].reserved_tokens);
            let credential = f.store.issue_bot_credential(&f.bot, 900).unwrap();
            let fresh = f
                .store
                .issue_session(&credential.bearer, &f.bot, &id(), 900)
                .unwrap();
            assert!(matches!(
                gateway
                    .invoke(
                        f.store.clone(),
                        fresh.bearer.clone(),
                        first_request,
                        payload(),
                        live(&f)
                    )
                    .await,
                Err(ModelCenterError::Replay)
            ));
            assert_eq!(state.count.load(Ordering::SeqCst), 1);
            assert!(
                gateway
                    .invoke(f.store.clone(), fresh.bearer, id(), payload(), live(&f))
                    .await
                    .is_err()
            );
            assert_eq!(state.count.load(Ordering::SeqCst), 2);
            handle.abort();
        }
    }
    #[tokio::test]
    async fn confirmed_success_without_usage_and_explicit_rejection_allow_next_prompt() {
        for mode in ["success_unknown", "rejected"] {
            let f = fixture(
                ApiProtocol::Anthropic,
                AuthType::ApiKey,
                UpstreamFormat::ChatCompletions,
                10000,
                2,
            );
            let (gateway, state, handle) = mock(mode).await;
            for _ in 0..2 {
                let result = gateway
                    .invoke(f.store.clone(), f.bearer.clone(), id(), payload(), live(&f))
                    .await;
                if mode == "success_unknown" {
                    assert!(result.is_ok());
                } else {
                    assert!(matches!(result, Err(ModelCenterError::Upstream)));
                }
            }
            assert_eq!(state.count.load(Ordering::SeqCst), 2);
            let rows = f.store.usage(10).unwrap();
            assert_eq!(rows.len(), 2);
            for row in rows {
                assert!(!row.usage_known);
                assert_eq!(row.charged_tokens, row.reserved_tokens);
            }
            assert!(f.store.authenticate_session(&f.bearer).is_ok());
            handle.abort();
        }
    }
}
