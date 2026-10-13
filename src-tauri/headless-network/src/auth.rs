use crate::{
    agent_network::{account_operation::AccountOperation, NetworkError},
    network_diagnostics::RequestDiagnostic,
    state::{Account, Owner, PendingLogin, ORIGIN, SERVICE_ID},
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use zeroize::Zeroizing;
#[derive(Clone)]
pub(crate) struct OfficialAccountSession {
    owner: Arc<Owner>,
    binding: String,
    principal: String,
    token: Arc<Zeroizing<String>>,
}
impl OfficialAccountSession {
    pub fn capture() -> Result<Self, NetworkError> {
        let owner = Owner::current()?;
        let (s, _) = owner.read()?;
        let a = s
            .account
            .as_ref()
            .ok_or_else(|| NetworkError::new("SPACE_REAUTH_REQUIRED"))?;
        owner.ensure_binding(&a.binding)?;
        Ok(Self {
            owner: owner.clone(),
            binding: a.binding.clone(),
            principal: a.principal.clone(),
            token: Arc::new(Zeroizing::new(a.token.clone())),
        })
    }
    pub fn binding_id(&self) -> &str {
        &self.binding
    }
    pub fn issuer(&self) -> &str {
        ORIGIN
    }
    pub fn principal_id(&self) -> Result<&str, NetworkError> {
        Ok(&self.principal)
    }
    pub fn environment(&self) -> &str {
        "production"
    }
    pub fn service_id(&self) -> Result<&str, NetworkError> {
        Ok(SERVICE_ID)
    }
    pub fn ensure_current(&self) -> Result<(), NetworkError> {
        self.owner.ensure_binding(&self.binding)
    }
    pub async fn upsert_device(&self) -> Result<(), NetworkError> {
        self.ensure_current()?;
        let d = crate::device_identity::current_device_identity()
            .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        request(reqwest::Method::POST,"/api/devices/upsert",Some(json!({"deviceId":d.device_id,"deviceName":d.device_name,"platform":d.platform,"osVersion":d.os_version,"appVersion":d.app_version})),Some(self.token.as_str())).await?;
        self.ensure_current()?;
        Ok(())
    }
    pub async fn request(
        &self,
        op: AccountOperation,
        body: Option<Value>,
    ) -> Result<Value, NetworkError> {
        self.ensure_current()?;
        let (method, path, authenticated) = op.request()?;
        let value = request(
            method,
            &path,
            body,
            authenticated.then_some(self.token.as_str()),
        )
        .await;
        self.ensure_current()?;
        if value.as_ref().is_err_and(|e| {
            ["SPACE_REAUTH_REQUIRED", "NOT_AUTHENTICATED"].contains(&e.code.as_str())
        }) {
            self.owner.invalidate(&self.binding)?;
        }
        value
    }
}
fn client() -> Result<reqwest::Client, NetworkError> {
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never());
    crate::proxy_config::build_client_with_proxy(builder)
        .map_err(|_| NetworkError::new("NETWORK_PROXY_INVALID"))
}
pub(crate) async fn read_account_response_body(
    response: &mut reqwest::Response,
    diagnostic: &RequestDiagnostic,
) -> Result<Vec<u8>, NetworkError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NetworkError::new("NETWORK_ACCOUNT_UNAVAILABLE"))?
    {
        if bytes.len() + chunk.len() > 65536 {
            diagnostic.failure("body", "capacity", Some(response.status().as_u16()), None);
            return Err(NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn request(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, NetworkError> {
    let device = crate::device_identity::current_device_identity()
        .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
    if !path.starts_with("/api/") {
        return Err(NetworkError::new("NETWORK_ISSUER_INVALID"));
    }
    let diagnostic = RequestDiagnostic::new("headless-account", &method, path);
    let mut req = client()?
        .request(method, format!("{ORIGIN}{path}"))
        .header(
            "User-Agent",
            format!("MyAgents/{} ({})", device.app_version, device.platform),
        )
        .header("Accept", "application/json")
        .header("X-MyAgents-Client-Version", device.app_version)
        .header("X-MyAgents-Platform", device.platform)
        .header("X-MyAgents-Device-Id", device.device_id)
        .header("Accept-Language", "zh-CN");
    if let Some(id) = option_env!("MYAGENTS_SPACE_PUBLIC_CLIENT_ID").filter(|v| !v.is_empty()) {
        req = req.header("X-MyAgents-Space-Client-Id", id);
    }
    if let Some(token) = token {
        let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| NetworkError::new("ACCOUNT_TOKEN_INVALID"))?;
        header.set_sensitive(true);
        req = req.header(reqwest::header::AUTHORIZATION, header);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let mut response = diagnostic
        .send(req)
        .await
        .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?;
    let status = response.status();
    let retry_after = crate::agent_network::reconnect::retry_after(&response);
    let bytes = Zeroizing::new(read_account_response_body(&mut response, &diagnostic).await?);
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", status.as_u16()))?;
    if !status.is_success() || value["success"] != true {
        let mut error = NetworkError::cloud(
            value["code"]
                .as_str()
                .unwrap_or("NETWORK_ACCOUNT_UNAVAILABLE"),
            status.as_u16(),
        );
        error.retry_after = retry_after;
        return Err(error);
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"))
}
fn text(v: &Value, k: &str) -> Result<String, NetworkError> {
    v[k].as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16384)
        .map(str::to_owned)
        .ok_or_else(|| NetworkError::new("AUTH_RESPONSE_INVALID"))
}
fn authorization_url(v: &str) -> Result<(), NetworkError> {
    let invalid = || NetworkError::new("AUTH_URL_INVALID");
    let u = url::Url::parse(v).map_err(|_| invalid())?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err(invalid());
    }
    if u.origin().ascii_serialization() == ORIGIN {
        return Ok(());
    }
    if u.origin().ascii_serialization() != "https://accounts.google.com"
        || u.path() != "/o/oauth2/v2/auth"
    {
        return Err(invalid());
    }
    let mut query = std::collections::HashMap::new();
    for (key, value) in u.query_pairs() {
        if ![
            "client_id",
            "redirect_uri",
            "response_type",
            "scope",
            "state",
            "prompt",
        ]
        .contains(&key.as_ref())
            || query.insert(key.into_owned(), value.into_owned()).is_some()
        {
            return Err(invalid());
        }
    }
    if query.get("response_type").map(String::as_str) != Some("code")
        || query.get("redirect_uri").map(String::as_str)
            != Some("https://space.myagents.io/api/auth/google/callback")
    {
        return Err(invalid());
    }
    let client = query
        .get("client_id")
        .and_then(|v| v.strip_suffix(".apps.googleusercontent.com"))
        .ok_or_else(invalid)?;
    if client.is_empty()
        || client.len() > 256
        || !client
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        return Err(invalid());
    }
    let state = query.get("state").ok_or_else(invalid)?;
    if state.is_empty()
        || state.len() > 2048
        || !state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(invalid());
    }
    let scope = query.get("scope").ok_or_else(invalid)?;
    if scope.is_empty()
        || scope.len() > 2048
        || !scope.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
    {
        return Err(invalid());
    }
    if query.get("prompt").is_some_and(|v| {
        v.is_empty()
            || v.len() > 128
            || !v
                .split(' ')
                .all(|p| ["none", "consent", "select_account"].contains(&p))
            || v.split(' ').any(|p| p == "none") && v != "none"
    }) {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) async fn start(owner: &Owner) -> Result<Value, NetworkError> {
    // Invalidate prior account before issuing a new flow. Failure cannot revive it.
    owner.cancel()?;
    let (mut s, raw) = owner.read()?;
    let revision = s.revision.clone();
    let mut value = request(reqwest::Method::POST, "/api/auth/desktop/start", None, None).await?;
    let token = text(&value, "loginToken")?;
    let url = text(&value, "authorizationUrl")?;
    authorization_url(&url)?;
    let lifetime = value["expiresInSeconds"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 3600)
        .ok_or_else(|| NetworkError::new("AUTH_EXPIRY_INVALID"))?;
    let expires_at = jsonwebtoken::get_current_timestamp() + lifetime;
    s.pending = Some(PendingLogin {
        generation: revision,
        token,
        expires_at,
    });
    owner.commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
    if let Some(Value::String(mut token)) =
        value.as_object_mut().and_then(|v| v.remove("loginToken"))
    {
        use zeroize::Zeroize;
        token.zeroize();
    }
    Ok(json!({"authorizationUrl":url,"expiresAt":expires_at}))
}
pub(crate) async fn wait(owner: &Owner) -> Result<(), NetworkError> {
    let initial = owner
        .read()?
        .0
        .pending
        .as_ref()
        .ok_or_else(|| NetworkError::new("AUTH_NOT_PENDING"))?
        .generation
        .clone();
    loop {
        let (mut s, raw) = owner.read()?;
        let pending = s
            .pending
            .as_ref()
            .ok_or_else(|| NetworkError::new("AUTH_NOT_PENDING"))?;
        if pending.generation != initial {
            return Err(NetworkError::new("AUTH_CANCELLED"));
        }
        if pending.expires_at <= jsonwebtoken::get_current_timestamp() {
            s.pending = None;
            s.account = None;
            owner.commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
            return Err(NetworkError::new("AUTH_EXPIRED"));
        }
        let generation = pending.generation.clone();
        let login = Zeroizing::new(pending.token.clone());
        let path = format!(
            "/api/auth/desktop/poll?token={}",
            url::form_urlencoded::byte_serialize(login.as_bytes()).collect::<String>()
        );
        let data = tokio::select! {r=request(reqwest::Method::GET,&path,None,None)=>r?,_=crate::shutdown()=>{s.pending=None;s.account=None;owner.commit(raw.as_deref().map(|v|v.as_slice()),&s)?;return Err(NetworkError::new("AUTH_CANCELLED"));}};
        if s.pending.as_ref().is_none_or(|p| {
            p.generation != generation || p.expires_at <= jsonwebtoken::get_current_timestamp()
        }) {
            return Err(NetworkError::new("AUTH_CANCELLED"));
        }
        match data["status"].as_str() {
            Some("pending") => {}
            Some("done") => {
                let token = text(&data, "sessionToken")?;
                let principal = data["user"]["id"]
                    .as_str()
                    .filter(|v| !v.is_empty() && v.len() <= 256)
                    .ok_or_else(|| NetworkError::new("AUTH_PRINCIPAL_INVALID"))?
                    .to_owned();
                let expires = chrono::DateTime::parse_from_rfc3339(&text(&data, "expiresAt")?)
                    .map_err(|_| NetworkError::new("AUTH_EXPIRY_INVALID"))?
                    .timestamp();
                if expires <= jsonwebtoken::get_current_timestamp() as i64 {
                    return Err(NetworkError::new("AUTH_EXPIRED"));
                }
                s.account = Some(Account {
                    binding: uuid::Uuid::new_v4().to_string(),
                    principal,
                    token,
                    expires_at: expires as u64,
                });
                s.pending = None;
                s.revision = uuid::Uuid::new_v4().to_string();
                // Exact CAS rejects late completion after auth-cancel/new auth-start.
                owner.commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
                request(
                    reqwest::Method::POST,
                    "/api/auth/desktop/ack",
                    Some(json!({"token":login.as_str()})),
                    None,
                )
                .await?;
                return Ok(());
            }
            Some("expired" | "cancelled" | "denied") => {
                s.pending = None;
                s.account = None;
                owner.commit(raw.as_deref().map(|v| v.as_slice()), &s)?;
                return Err(NetworkError::new("AUTH_REJECTED"));
            }
            _ => return Err(NetworkError::new("AUTH_RESPONSE_INVALID")),
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(2))=>{},_=crate::shutdown()=>{s.pending=None;s.account=None;owner.commit(raw.as_deref().map(|v|v.as_slice()),&s)?;return Err(NetworkError::new("AUTH_CANCELLED"));}};
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorization_is_fixed_origin_and_never_redirects_to_other_account_services() {
        assert!(authorization_url("https://space.myagents.io/login?token=opaque").is_ok());
        for v in [
            "http://space.myagents.io/login",
            "https://attacker.invalid/login",
            "https://user@space.myagents.io/login",
            "https://space.myagents.io/login#token=x",
        ] {
            assert!(authorization_url(v).is_err());
        }
    }
    fn google_url() -> url::Url {
        let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
        url.query_pairs_mut().extend_pairs([
            (
                "client_id",
                "1234567890-isolated.apps.googleusercontent.com",
            ),
            (
                "redirect_uri",
                "https://space.myagents.io/api/auth/google/callback",
            ),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("state", "isolated-state_1234567890"),
            ("prompt", "select_account"),
        ]);
        url
    }
    fn google_parameter(key: &str, value: Option<&str>) -> url::Url {
        let mut url = google_url();
        let pairs = url
            .query_pairs()
            .filter(|(k, _)| k != key)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(pairs);
        if let Some(value) = value {
            url.query_pairs_mut().append_pair(key, value);
        }
        url
    }
    #[test]
    fn google_oauth_accepts_only_fixed_callback_and_closed_parameters() {
        assert!(authorization_url(google_url().as_str()).is_ok());
        assert!(authorization_url(google_parameter("prompt", None).as_str()).is_ok());
        for (key, value) in [
            (
                "redirect_uri",
                "https://attacker.invalid/api/auth/google/callback",
            ),
            (
                "redirect_uri",
                "https://space.myagents.io/api/auth/google/callback?next=evil",
            ),
            (
                "redirect_uri",
                "https://space.myagents.io/api/auth/google/callback#x",
            ),
            (
                "redirect_uri",
                "https://user@space.myagents.io/api/auth/google/callback",
            ),
            (
                "redirect_uri",
                "https://space.myagents.io/api/auth/google/callback/",
            ),
            ("response_type", "token"),
            ("client_id", "attacker.example"),
            ("client_id", ".apps.googleusercontent.com"),
            (
                "client_id",
                "evil.apps.googleusercontent.com.attacker.invalid",
            ),
            ("state", ""),
            ("state", "a b"),
            ("state", "a\nb"),
            ("scope", ""),
            ("prompt", "none consent"),
            ("untrusted", "x"),
        ] {
            assert!(
                authorization_url(google_parameter(key, Some(value)).as_str()).is_err(),
                "{key}"
            );
        }
        for key in [
            "client_id",
            "redirect_uri",
            "response_type",
            "scope",
            "state",
        ] {
            assert!(authorization_url(google_parameter(key, None).as_str()).is_err());
        }
        assert!(
            authorization_url(google_parameter("state", Some(&"x".repeat(2049))).as_str()).is_err()
        );
    }
    #[test]
    fn google_oauth_rejects_duplicate_parameters_and_other_endpoints() {
        for key in [
            "client_id",
            "redirect_uri",
            "response_type",
            "scope",
            "state",
            "prompt",
        ] {
            let mut url = google_url();
            let value = url
                .query_pairs()
                .find(|(k, _)| k == key)
                .unwrap()
                .1
                .into_owned();
            url.query_pairs_mut().append_pair(key, &value);
            assert!(authorization_url(url.as_str()).is_err());
        }
        let encoded_duplicate = format!("{}&st%61te=second", google_url());
        assert!(authorization_url(&encoded_duplicate).is_err());
        for origin in [
            "http://accounts.google.com",
            "https://accounts.google.com:444",
            "https://accounts.google.com.attacker.invalid",
            "https://user@accounts.google.com",
        ] {
            let mut url = google_url();
            let other = url::Url::parse(origin).unwrap();
            url.set_scheme(other.scheme()).unwrap();
            url.set_host(other.host_str()).unwrap();
            url.set_port(other.port()).unwrap();
            url.set_username(other.username()).unwrap();
            assert!(authorization_url(url.as_str()).is_err());
        }
        let mut url = google_url();
        url.set_fragment(Some("secret"));
        assert!(authorization_url(url.as_str()).is_err());
        for path in [
            "/o/oauth2/auth",
            "/o/oauth2/v2/auth/",
            "/login",
            "/o/oauth2/v2/auth%2f",
        ] {
            let mut url = google_url();
            url.set_path(path);
            assert!(authorization_url(url.as_str()).is_err());
        }
    }
}
