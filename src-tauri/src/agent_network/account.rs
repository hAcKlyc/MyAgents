//! Identity issuer context: official login or a pinned standalone instance.
//! Credentials and validity remain App-owned; no selected UI state controls this context.
use super::NetworkError;
use crate::network_diagnostics::RequestDiagnostic;
use crate::space_cloud::agent_network::{
    read_account_response_body, AccountOperation, OfficialAccountSession,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelfhostDescriptor {
    pub service_id: String,
    pub environment: String,
    pub principal_id: String,
    pub network_id: String,
    pub name: String,
    pub issuer: String,
    pub protocol: u8,
    pub capabilities: Vec<String>,
    pub root_certificate: String,
    pub jwks: Value,
}
impl SelfhostDescriptor {
    pub(crate) fn ensure_same_trust(&self, current: &Self) -> Result<(), NetworkError> {
        if self.service_id != current.service_id
            || self.environment != current.environment
            || self.principal_id != current.principal_id
            || self.network_id != current.network_id
            || self.issuer != current.issuer
            || self.root_certificate != current.root_certificate
            || self.jwks != current.jwks
        {
            return Err(NetworkError::new("NETWORK_TRUST_CHANGED"));
        }
        Ok(())
    }
    pub(crate) fn ensure_bootstrap(
        &self,
        root: &str,
        network_url: &str,
    ) -> Result<(), NetworkError> {
        if root != self.root_certificate || network_url != self.issuer {
            return Err(NetworkError::new("NETWORK_TRUST_CHANGED"));
        }
        Ok(())
    }
    pub(crate) fn validate(&self, origin: &str) -> Result<(), NetworkError> {
        if self.issuer != origin
            || self.protocol != 1
            || !["production", "development"].contains(&self.environment.as_str())
            || self.name.is_empty()
            || self.name.len() > 512
            || self.root_certificate.len() > 20000
            || self.root_certificate.is_empty()
        {
            return Err(NetworkError::new("NETWORK_DESCRIPTOR_INVALID"));
        }
        for id in [&self.service_id, &self.principal_id, &self.network_id] {
            if uuid::Uuid::parse_str(id).map(|x| x.to_string()).as_deref() != Ok(id.as_str()) {
                return Err(NetworkError::new("NETWORK_DESCRIPTOR_INVALID"));
            }
        }
        if ["tls13-mtls", "typed-rpc", "permit-v1", "return-v1"]
            .iter()
            .any(|c| !self.capabilities.iter().any(|v| v == c))
        {
            return Err(NetworkError::new("NETWORK_PROTOCOL_UNSUPPORTED"));
        }
        super::jwt::checked_jwks(self.jwks.clone())?;
        Ok(())
    }
}
pub(crate) struct SelfhostAccount {
    pub connection_id: String,
    pub descriptor: SelfhostDescriptor,
    pub active: Arc<AtomicBool>,
    pub enrollment_key: Option<Zeroizing<String>>,
}
pub(crate) struct OwnedAccount {
    pub connection_id: String,
    pub descriptor: super::owned_login::OwnedInstance,
    pub active: Arc<AtomicBool>,
    pub session: super::owned_login::OwnedSession,
    pub public_tls_ca: Option<String>,
    pub join_authorized: AtomicBool,
    pub guard: Arc<dyn Fn() -> Result<(), NetworkError> + Send + Sync>,
}
#[derive(Clone)]
pub(crate) enum NetworkAccountSession {
    Official(OfficialAccountSession),
    Owned(Arc<OwnedAccount>),
    Selfhost(Arc<SelfhostAccount>),
}
impl NetworkAccountSession {
    pub(crate) fn capture() -> Result<Self, NetworkError> {
        OfficialAccountSession::capture().map(Self::Official)
    }
    pub(crate) fn binding_id(&self) -> &str {
        match self {
            Self::Official(a) => a.binding_id(),
            Self::Selfhost(a) => &a.connection_id,
            Self::Owned(a) => &a.connection_id,
        }
    }
    pub(crate) fn issuer(&self) -> &str {
        match self {
            Self::Official(a) => a.issuer(),
            Self::Selfhost(a) => &a.descriptor.issuer,
            Self::Owned(a) => &a.descriptor.issuer,
        }
    }
    pub(crate) fn principal_id(&self) -> Result<&str, NetworkError> {
        match self {
            Self::Official(a) => a.principal_id(),
            Self::Selfhost(a) => Ok(&a.descriptor.principal_id),
            Self::Owned(a) => Ok(&a.session.principal_id),
        }
    }
    pub(crate) fn environment(&self) -> &str {
        match self {
            Self::Official(a) => a.environment(),
            Self::Selfhost(a) => &a.descriptor.environment,
            Self::Owned(a) => &a.descriptor.environment,
        }
    }
    pub(crate) fn service_id(&self) -> Result<&str, NetworkError> {
        match self {
            Self::Official(a) => a.service_id(),
            Self::Selfhost(a) => Ok(&a.descriptor.service_id),
            Self::Owned(a) => Ok(&a.descriptor.service_id),
        }
    }
    pub(crate) fn is_selfhost(&self) -> bool {
        matches!(self, Self::Selfhost(_) | Self::Owned(_))
    }
    pub(crate) fn has_enrollment_key(&self) -> bool {
        matches!(self,Self::Selfhost(a) if a.enrollment_key.is_some())
            || matches!(self, Self::Owned(_))
    }
    /// Only legacy enrollment-key owners need a revoked-device replacement probe.
    /// Owned sessions prove the current key through the normal consumed challenge;
    /// probing first would leave an unused challenge on every initialization.
    pub(crate) fn requires_revocation_probe(&self, key_generation: Option<u64>) -> bool {
        match self {
            Self::Selfhost(a) => a.enrollment_key.is_some() && key_generation.is_some(),
            Self::Official(_) | Self::Owned(_) => false,
        }
    }
    pub(crate) fn is_management_only(&self) -> bool {
        matches!(self, Self::Owned(_))
    }
    pub(crate) fn public_tls_ca(&self) -> Option<&str> {
        match self {
            Self::Owned(a) => a.public_tls_ca.as_deref(),
            _ => None,
        }
    }
    pub(crate) fn deactivate(&self) {
        match self {
            Self::Owned(a) => a.active.store(false, Ordering::Release),
            Self::Selfhost(a) => a.active.store(false, Ordering::Release),
            _ => {}
        }
    }
    pub(crate) fn ensure_bootstrap(&self, root: &str, url: &str) -> Result<(), NetworkError> {
        match self {
            Self::Selfhost(a) => a.descriptor.ensure_bootstrap(root, url),
            Self::Owned(a) => a.descriptor.ensure_bootstrap(root, url),
            _ => Ok(()),
        }
    }
    pub(crate) fn ensure_current(&self) -> Result<(), NetworkError> {
        match self {
            Self::Official(a) => a.ensure_current(),
            Self::Owned(a) => {
                if !a.active.load(Ordering::Acquire) {
                    return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
                }
                a.session.validate(&a.descriptor)?;
                (a.guard)()
            }
            Self::Selfhost(a) => {
                if a.active.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"))
                }
            }
        }
    }
    pub(crate) async fn request(
        &self,
        operation: AccountOperation,
        body: Option<Value>,
    ) -> Result<Value, NetworkError> {
        self.ensure_current()?;
        match self {
            Self::Official(a) => a.request(operation, body).await,
            Self::Owned(a) => {
                let (method, path, _) = operation.request()?;
                let (client, current) = super::owned_login::OwnedClient::discover(
                    &a.descriptor.issuer,
                    a.public_tls_ca.as_deref(),
                )
                .await?;
                a.descriptor.ensure_same_trust(&current)?;
                let value = client
                    .identity_request(method, &path, body, &a.session.access_token)
                    .await?;
                if matches!(operation, AccountOperation::Jwks) && value != a.descriptor.jwks {
                    return Err(NetworkError::new("NETWORK_TRUST_CHANGED"));
                }
                self.ensure_current()?;
                Ok(value)
            }
            Self::Selfhost(a) => {
                let (method, path, _) = operation.request()?;
                let key = if matches!(operation, AccountOperation::Identity) {
                    a.enrollment_key.as_deref().map(|s| s.as_str())
                } else {
                    None
                };
                let value = request_json(&a.descriptor.issuer, method, &path, body, key).await?;
                if matches!(operation, AccountOperation::Jwks) && value != a.descriptor.jwks {
                    return Err(NetworkError::new("NETWORK_TRUST_CHANGED"));
                }
                self.ensure_current()?;
                Ok(value)
            }
        }
    }
    pub(crate) async fn validate_instance(&self) -> Result<(), NetworkError> {
        if let Self::Owned(a) = self {
            let (_, current) = super::owned_login::OwnedClient::discover(
                &a.descriptor.issuer,
                a.public_tls_ca.as_deref(),
            )
            .await?;
            a.descriptor.ensure_same_trust(&current)?;
            self.ensure_current()?;
        }

        if let Self::Selfhost(a) = self {
            let current = descriptor(&a.descriptor.issuer).await?;
            // Presentation name may change; stable instance and pinned trust may not.
            a.descriptor.ensure_same_trust(&current)?;
        }
        Ok(())
    }
}
pub(crate) fn origin(value: &str) -> Result<String, NetworkError> {
    let u = url::Url::parse(value.trim()).map_err(|_| NetworkError::new("NETWORK_URL_INVALID"))?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(NetworkError::new("NETWORK_URL_INVALID"));
    }
    Ok(u.origin().ascii_serialization())
}
pub(crate) async fn descriptor(value: &str) -> Result<SelfhostDescriptor, NetworkError> {
    let origin = origin(value)?;
    let value = request_json(
        &origin,
        reqwest::Method::GET,
        "/api/agent-network/descriptor",
        None,
        None,
    )
    .await?;
    let d: SelfhostDescriptor = serde_json::from_value(value)
        .map_err(|_| NetworkError::new("NETWORK_DESCRIPTOR_INVALID"))?;
    d.validate(&origin)?;
    Ok(d)
}
pub(crate) async fn request_json(
    origin: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    key: Option<&str>,
) -> Result<Value, NetworkError> {
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    let client = crate::proxy_config::build_client_with_proxy(builder)
        .map_err(|_| NetworkError::new("NETWORK_PROXY_INVALID"))?;
    let diagnostic = RequestDiagnostic::new("network-account", &method, path);
    let mut request = client.request(method, format!("{origin}{path}"));
    if let Some(key) = key {
        request = request.header("x-agenthub-key", key);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = diagnostic
        .send(request)
        .await
        .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?;
    let status = response.status();
    let retry_after = super::reconnect::retry_after(&response);
    let bytes = read_account_response_body(&mut response, &diagnostic).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> SelfhostDescriptor {
        let mut jwk = super::super::crypto::DevicePrivateKey::generate()
            .unwrap()
            .public_jwk()
            .unwrap();
        jwk["kid"] = serde_json::json!("test");
        jwk["alg"] = serde_json::json!("ES256");
        jwk["use"] = serde_json::json!("sig");
        SelfhostDescriptor {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            principal_id: "00000000-0000-0000-0000-000000000002".into(),
            network_id: "00000000-0000-0000-0000-000000000003".into(),
            name: "Team".into(),
            issuer: "https://hub.example.test".into(),
            protocol: 1,
            capabilities: vec![
                "tls13-mtls".into(),
                "typed-rpc".into(),
                "permit-v1".into(),
                "return-v1".into(),
            ],
            root_certificate: "test-root".into(),
            jwks: serde_json::json!({"keys":[jwk]}),
        }
    }
    #[test]
    fn revocation_probe_is_exclusive_to_committed_legacy_enrollment_key_owner() {
        for enrollment_key in [None, Some(Zeroizing::new("test-enrollment".into()))] {
            let eligible = enrollment_key.is_some();
            let legacy = NetworkAccountSession::Selfhost(Arc::new(SelfhostAccount {
                connection_id: "legacy-test".into(),
                descriptor: sample(),
                active: Arc::new(AtomicBool::new(true)),
                enrollment_key,
            }));
            assert!(!legacy.requires_revocation_probe(None));
            assert_eq!(legacy.requires_revocation_probe(Some(1)), eligible);
            assert_eq!(legacy.has_enrollment_key(), eligible);
        }
        let d = sample();
        let owned = NetworkAccountSession::Owned(Arc::new(OwnedAccount {
            connection_id: "owned-test".into(),
            descriptor: super::super::owned_login::OwnedInstance {
                version: 1,
                profile: "owned-device-relay-v1".into(),
                service_id: d.service_id,
                environment: d.environment,
                network_id: d.network_id.clone(),
                name: d.name,
                issuer: d.issuer,
                login_issuer: "https://login.example.test".into(),
                protocol: 1,
                capabilities: vec!["tls13-mtls".into()],
                root_certificate: d.root_certificate,
                jwks: d.jwks,
            },
            active: Arc::new(AtomicBool::new(true)),
            session: super::super::owned_login::OwnedSession {
                access_token: "x".repeat(43),
                expires_at: jsonwebtoken::get_current_timestamp() + 600,
                principal_id: d.principal_id,
                network_id: d.network_id,
            },
            public_tls_ca: None,
            join_authorized: AtomicBool::new(false),
            guard: Arc::new(|| Ok(())),
        }));
        // Preserve enrollment/management policy while excluding the legacy probe.
        assert!(owned.has_enrollment_key());
        assert!(owned.is_selfhost());
        assert!(owned.is_management_only());
        for generation in [None, Some(1), Some(9_007_199_254_740_991)] {
            assert!(!owned.requires_revocation_probe(generation));
        }
    }
    #[test]
    fn url_contains_only_https_origin_without_credentials_or_redirect_paths() {
        assert_eq!(
            origin(" https://hub.example.test/ ").unwrap(),
            "https://hub.example.test"
        );
        for url in [
            "http://hub.example.test",
            "https://user:key@hub.example.test",
            "https://hub.example.test/manage",
            "https://hub.example.test/?key=secret",
            "https://hub.example.test/#ticket=secret",
        ] {
            assert!(origin(url).is_err());
        }
    }
    #[test]
    fn identity_trust_is_stable_across_display_rename_but_not_key_or_instance_change() {
        let d = sample();
        d.validate(&d.issuer).unwrap();
        let mut rename = d.clone();
        rename.name = "Renamed".into();
        d.ensure_same_trust(&rename).unwrap();
        for field in [
            "serviceId",
            "environment",
            "principalId",
            "networkId",
            "issuer",
            "rootCertificate",
            "jwks",
        ] {
            let mut value = serde_json::to_value(&d).unwrap();
            value[field] = if field == "jwks" {
                serde_json::json!({"keys":[]})
            } else {
                serde_json::json!("changed")
            };
            let next: SelfhostDescriptor = serde_json::from_value(value).unwrap();
            assert_eq!(
                d.ensure_same_trust(&next).unwrap_err().code,
                "NETWORK_TRUST_CHANGED"
            );
        }
        d.ensure_bootstrap(&d.root_certificate, &d.issuer).unwrap();
        assert!(d.ensure_bootstrap("different-root", &d.issuer).is_err());
        assert!(d
            .ensure_bootstrap(&d.root_certificate, "https://other.test")
            .is_err());
    }
}
