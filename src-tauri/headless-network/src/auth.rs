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
    let u = url::Url::parse(v).map_err(|_| NetworkError::new("AUTH_URL_INVALID"))?;
    if u.origin().ascii_serialization() != ORIGIN
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err(NetworkError::new("AUTH_URL_INVALID"));
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
}
