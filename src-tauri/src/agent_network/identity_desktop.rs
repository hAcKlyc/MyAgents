//! Desktop explicitly selects the OS credential backend.
use super::{
    account::NetworkAccountSession,
    account::OwnedAccount,
    crypto::{DevicePrivateKey, IdentityStore, KeyScope, OsIdentityStore},
    identity::{load_key_with_store, NetworkIdentity},
    NetworkError,
};
use myagents_agent_network_protocol::{validate_identity_state, IdentityState};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
impl NetworkIdentity {
    pub(crate) async fn initialize(
        account: NetworkAccountSession,
        retired_generation: Option<u64>,
    ) -> Result<Self, NetworkError> {
        Self::initialize_with_store(account, retired_generation, Arc::new(OsIdentityStore)).await
    }
}
pub(crate) async fn load_key(
    scope: &KeyScope,
) -> Result<Option<Arc<DevicePrivateKey>>, NetworkError> {
    load_key_with_store(scope, Arc::new(OsIdentityStore)).await
}

fn authorized_scope_from_state(
    account: &NetworkAccountSession,
    device_id: &str,
    value: Value,
) -> Result<(KeyScope, String), NetworkError> {
    validate_identity_state(&value).map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
    let state: IdentityState =
        serde_json::from_value(value).map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
    let service_id = account.service_id()?.to_owned();
    let principal_id = account.principal_id()?.to_owned();
    let generation = state
        .key_generation
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
        .ok_or_else(|| NetworkError::new("IDENTITY_STATE_INVALID"))?;
    let fingerprint = state
        .key_fingerprint
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or_else(|| NetworkError::new("IDENTITY_STATE_INVALID"))?;
    if state.service_id != service_id
        || state.environment != account.environment()
        || state.device_id != device_id
    {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    Ok((
        KeyScope {
            issuer: account.issuer().to_owned(),
            environment: account.environment().to_owned(),
            service_id,
            principal_id,
            device_id: device_id.to_owned(),
            key_generation: generation,
        },
        fingerprint,
    ))
}

/// Explicitly authorize reading an already-enrolled device key. This path is
/// read-only: it never initializes, rotates, enrolls, or deletes an identity.
pub(crate) async fn authorize_owned_identity(
    account: Arc<OwnedAccount>,
    expected_device: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Arc<dyn IdentityStore>, NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    let account_session = NetworkAccountSession::Owned(account);
    account_session.ensure_current()?;
    account_session.validate_instance().await?;
    let current_device = crate::device_identity::current_device_identity()
        .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
    if current_device.device_id != expected_device {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    let state_value = account_session
        .request(
            crate::space_cloud::agent_network::AccountOperation::IdentityState(
                expected_device.to_owned(),
            ),
            None,
        )
        .await?;
    let (scope, expected_fingerprint) =
        authorized_scope_from_state(&account_session, expected_device, state_value)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }

    let authorization_cancelled = cancelled.clone();
    let authorization_scope = scope.clone();
    let authorization = tokio::task::spawn_blocking(move || {
        OsIdentityStore::authorize_existing(&authorization_scope, &authorization_cancelled)
    })
    .await;
    let authorized_store = match authorization {
        Ok(result) => result,
        Err(_) if cancelled.load(Ordering::Acquire) => {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        Err(_) => return Err(NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE")),
    };
    let store = match authorized_store {
        Ok(store) => store,
        Err(_) if cancelled.load(Ordering::Acquire) => {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        Err(error) => return Err(error.into()),
    };
    let key = store.load(&scope)?;
    if key.public_fingerprint()? != expected_fingerprint {
        return Err(NetworkError::new("IDENTITY_KEY_MISMATCH"));
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    account_session.ensure_current()?;
    Ok(store)
}

#[cfg(test)]
mod authorization_tests {
    use super::*;
    use serde_json::json;

    fn account() -> NetworkAccountSession {
        NetworkAccountSession::Owned(Arc::new(OwnedAccount {
            connection_id: "connection".into(),
            descriptor: crate::agent_network::owned_login::OwnedInstance {
                version: 1,
                profile: "owned-device-relay-v1".into(),
                service_id: "00000000-0000-4000-8000-000000000001".into(),
                environment: "development".into(),
                network_id: "00000000-0000-4000-8000-000000000002".into(),
                name: "test".into(),
                issuer: "https://owned.example".into(),
                login_issuer: "https://login.example/dex".into(),
                protocol: 1,
                capabilities: vec!["tls13-mtls".into()],
                root_certificate: "root".into(),
                jwks: json!({"keys": []}),
            },
            active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            session: crate::agent_network::owned_login::OwnedSession {
                access_token: "a".repeat(43),
                expires_at: jsonwebtoken::get_current_timestamp() + 600,
                principal_id: "00000000-0000-4000-8000-000000000003".into(),
                network_id: "00000000-0000-4000-8000-000000000002".into(),
            },
            public_tls_ca: None,
            join_authorized: std::sync::atomic::AtomicBool::new(false),
            guard: Arc::new(|| Ok(())),
        }))
    }

    fn state(service: &str, environment: &str, device: &str) -> Value {
        json!({
            "serviceId": service,
            "environment": environment,
            "deviceId": device,
            "keyGeneration": 2,
            "keyFingerprint": "verified-fingerprint"
        })
    }

    #[test]
    fn authorized_identity_scope_requires_matching_current_owned_state() {
        let account = account();
        let device = "00000000-0000-4000-8000-000000000004";
        let valid = state(
            "00000000-0000-4000-8000-000000000001",
            "development",
            device,
        );
        let (scope, fingerprint) = authorized_scope_from_state(&account, device, valid).unwrap();
        assert_eq!(scope.issuer, "https://owned.example");
        assert_eq!(scope.key_generation, 2);
        assert_eq!(fingerprint, "verified-fingerprint");

        for invalid in [
            state(
                "00000000-0000-4000-8000-000000000099",
                "development",
                device,
            ),
            state("00000000-0000-4000-8000-000000000001", "production", device),
            state(
                "00000000-0000-4000-8000-000000000001",
                "development",
                "00000000-0000-4000-8000-000000000099",
            ),
            json!({
                "serviceId":"00000000-0000-4000-8000-000000000001",
                "environment":"development",
                "deviceId":device,
                "keyGeneration":null,
                "keyFingerprint":null
            }),
        ] {
            assert!(authorized_scope_from_state(&account, device, invalid).is_err());
        }
    }
}
