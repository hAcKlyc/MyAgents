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
    pub binding_id: String,
    pub connection_id: String,
    pub device_id: String,
    pub session_bound: bool,
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
    /// The owned login binds its token to a per-account device. Physical host
    /// metadata remains shared, while official and legacy identities stay global.
    pub(crate) fn device_identity(
        &self,
    ) -> Result<crate::device_identity::DeviceIdentity, NetworkError> {
        self.device_identity_with(crate::device_identity::current_device_identity)
    }
    fn device_identity_with<E>(
        &self,
        physical: impl FnOnce() -> Result<crate::device_identity::DeviceIdentity, E>,
    ) -> Result<crate::device_identity::DeviceIdentity, NetworkError> {
        let owned_device = match self {
            Self::Owned(account) => {
                if uuid::Uuid::parse_str(&account.device_id)
                    .map(|id| id.to_string())
                    .as_deref()
                    != Ok(account.device_id.as_str())
                {
                    return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
                }
                Some(account.device_id.as_str())
            }
            Self::Official(_) | Self::Selfhost(_) => None,
        };
        let mut device = physical().map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        if let Some(device_id) = owned_device {
            device.device_id = device_id.to_owned();
        }
        Ok(device)
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
    pub(crate) async fn community_request(
        &self,
        scope: &super::community::CommunityScope,
        request: &super::community::CommunityRequest,
    ) -> Result<Value, NetworkError> {
        self.ensure_current()?;
        let Self::Owned(account) = self else {
            return Err(NetworkError::new("OWNED_SERVICE_UNAVAILABLE"));
        };
        if !scope.matches(
            &account.connection_id,
            &account.session.principal_id,
            &account.binding_id,
        ) {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        // Validate before discovery; a renderer cannot turn this into arbitrary HTTP.
        request.route()?;
        let (client, current) = super::owned_login::OwnedClient::discover(
            &account.descriptor.issuer,
            account.public_tls_ca.as_deref(),
        )
        .await?;
        account.descriptor.ensure_same_trust(&current)?;
        self.ensure_current()?;
        let result = client
            .community_request(request, &account.session.access_token)
            .await;
        self.ensure_current()?;
        result
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
    fn owned_account(device_id: &str, principal_id: &str) -> NetworkAccountSession {
        let d = sample();
        NetworkAccountSession::Owned(Arc::new(OwnedAccount {
            binding_id: "test-binding".into(),
            connection_id: "owned-test".into(),
            device_id: device_id.into(),
            session_bound: false,
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
                principal_id: principal_id.into(),
                network_id: d.network_id,
            },
            public_tls_ca: None,
            join_authorized: AtomicBool::new(false),
            guard: Arc::new(|| Ok(())),
        }))
    }
    fn physical_device() -> crate::device_identity::DeviceIdentity {
        crate::device_identity::DeviceIdentity {
            device_id: "legacy-installation-id".into(),
            device_name: Some("Fixture Mac".into()),
            platform: "darwin-aarch64".into(),
            os_version: Some("fixture-os".into()),
            app_version: "fixture-version".into(),
        }
    }
    #[test]
    fn owned_accounts_use_login_devices_while_legacy_keeps_the_installation_device() {
        let first = owned_account(
            "00000000-0000-4000-8000-000000000004",
            "00000000-0000-4000-8000-000000000005",
        );
        let second = owned_account(
            "00000000-0000-4000-8000-000000000006",
            "00000000-0000-4000-8000-000000000007",
        );
        for (account, expected_device) in [
            (&first, "00000000-0000-4000-8000-000000000004"),
            (&second, "00000000-0000-4000-8000-000000000006"),
        ] {
            let device = account
                .device_identity_with(|| Ok::<_, ()>(physical_device()))
                .unwrap();
            assert_eq!(device.device_id, expected_device);
            let physical = physical_device();
            assert_eq!(device.device_name, physical.device_name);
            assert_eq!(device.platform, physical.platform);
            assert_eq!(device.os_version, physical.os_version);
            assert_eq!(device.app_version, physical.app_version);
        }
        let legacy = NetworkAccountSession::Selfhost(Arc::new(SelfhostAccount {
            connection_id: "legacy-fixture".into(),
            descriptor: sample(),
            active: Arc::new(AtomicBool::new(true)),
            enrollment_key: None,
        }));
        let device = legacy
            .device_identity_with(|| Ok::<_, ()>(physical_device()))
            .unwrap();
        assert_eq!(device.device_id, physical_device().device_id);
    }
    #[test]
    fn malformed_owned_device_fails_before_loading_physical_metadata() {
        for device_id in ["", "not-a-device", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] {
            let account = owned_account(device_id, "00000000-0000-4000-8000-000000000005");
            let result = account.device_identity_with::<()>(|| {
                panic!("invalid login device must not use the installation identity")
            });
            assert_eq!(result.err().unwrap().code, "IDENTITY_SCOPE_MISMATCH");
        }
    }
    #[test]
    fn physical_identity_failure_does_not_fall_back_to_another_account() {
        let account = owned_account(
            "00000000-0000-4000-8000-000000000004",
            "00000000-0000-4000-8000-000000000005",
        );
        let result = account.device_identity_with(|| Err(()));
        assert_eq!(result.err().unwrap().code, "DEVICE_ID_UNAVAILABLE");
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
        let owned = owned_account(
            "00000000-0000-4000-8000-000000000004",
            "00000000-0000-4000-8000-000000000005",
        );
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
