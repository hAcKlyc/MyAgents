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
/// The versioned route is a local credential lookup only; protocol Scope is unchanged.
pub(crate) fn selected_store() -> Arc<dyn IdentityStore> {
    #[cfg(myagents_updater_qa)]
    { return Arc::new(UpdaterQaDeniedIdentityStore); }
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    {
        super::credential_slots::desktop_store()
    }
    #[cfg(all(not(myagents_updater_qa), not(all(target_os = "macos", myagents_moxbot, not(test)))))]
    {
        Arc::new(OsIdentityStore)
    }
}
pub(crate) fn connection_cache() -> Arc<dyn IdentityStore> {
    #[cfg(myagents_updater_qa)]
    { return Arc::new(UpdaterQaDeniedIdentityStore); }
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    {
        super::credential_slots::connection_cache()
    }
    #[cfg(all(not(myagents_updater_qa), not(all(target_os = "macos", myagents_moxbot, not(test)))))]
    {
        OsIdentityStore::connection_cache()
    }
}

#[cfg(any(test, all(target_os = "macos", myagents_moxbot)))]
struct ReadOnlyScopeStore {
    scope: KeyScope,
    authorized_scope: KeyScope,
    route_selection: super::credential_slots::RouteSelection,
    inner: Arc<dyn IdentityStore>,
}
#[cfg(any(test, all(target_os = "macos", myagents_moxbot)))]
impl IdentityStore for ReadOnlyScopeStore {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, super::crypto::CryptoError> {
        if self.scope.issuer != scope.issuer
            || self.scope.environment != scope.environment
            || self.scope.service_id != scope.service_id
            || self.scope.principal_id != scope.principal_id
            || self.scope.device_id != scope.device_id
            || self.scope.key_generation != scope.key_generation
        {
            return Err(super::crypto::CryptoError::CredentialConflict);
        }
        #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
        {
            let current = super::credential_slots::selection(
                &super::credential_slots::identity_route_id(scope)?,
            )?;
            if current == super::credential_slots::RouteSelection::Deleted {
                return Err(super::crypto::CryptoError::CredentialMissing);
            }
            if current != self.route_selection {
                return Err(super::crypto::CryptoError::CredentialConflict);
            }
        }
        self.inner.load(&self.authorized_scope)
    }
    fn save_pending(
        &self,
        _: &KeyScope,
        _: &DevicePrivateKey,
    ) -> Result<(), super::crypto::CryptoError> {
        Err(super::crypto::CryptoError::CredentialUnavailable)
    }
    fn delete(&self, _: &KeyScope) -> Result<(), super::crypto::CryptoError> {
        Err(super::crypto::CryptoError::CredentialUnavailable)
    }
}

impl NetworkIdentity {
    pub(crate) async fn initialize(
        account: NetworkAccountSession,
        retired_generation: Option<u64>,
    ) -> Result<Self, NetworkError> {
        initialize_selected(account, retired_generation, selected_store()).await
    }
}
/// Keep storage migration after the issuer has verified the original key.
pub(crate) async fn initialize_selected(
    account: NetworkAccountSession,
    retired_generation: Option<u64>,
    store: Arc<dyn IdentityStore>,
) -> Result<NetworkIdentity, NetworkError> {
    if crate::app_dirs::IS_UPDATER_QA { return Err(NetworkError::new("UPDATER_QA_CREDENTIALS_DISABLED")); }
    let identity =
        NetworkIdentity::initialize_with_store(account, retired_generation, store).await?;
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    {
        identity.account.ensure_current()?;
        if super::credential_slots::selection(&super::credential_slots::identity_route_id(
            &identity.scope,
        )?)? != super::credential_slots::selected_writer_selection()?
        {
            let scope = identity.scope.clone();
            let key = identity.device_key();
            tokio::task::spawn_blocking(move || {
                super::credential_slots::promote_key(&scope, &key, &AtomicBool::new(false))
            })
            .await
            .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))??;
            identity.account.ensure_current()?;
        }
        if let NetworkAccountSession::Owned(owned) = &identity.account {
            let owned = owned.clone();
            let device = identity.scope.device_id.clone();
            tokio::task::spawn_blocking(move || {
                super::owned_account_desktop::promote_current_account(
                    &owned,
                    &device,
                    &AtomicBool::new(false),
                )
            })
            .await
            .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))??;
            identity.account.ensure_current()?;
        }
    }
    Ok(identity)
}

pub(crate) async fn load_key(
    scope: &KeyScope,
) -> Result<Option<Arc<DevicePrivateKey>>, NetworkError> {
    load_key_with_store(scope, selected_store()).await
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

/// Explicitly authorize reading an already-enrolled device key.
/// It never initializes, rotates, enrolls, or deletes an identity. Fixed-reader
/// migration copies the verified key into a local slot before returning a
/// read-only seed bound to exactly the authorized protocol Scope.
pub(crate) async fn authorize_owned_identity(
    account: Arc<OwnedAccount>,
    expected_device: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Arc<dyn IdentityStore>, NetworkError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    if crate::app_dirs::IS_UPDATER_QA { return Err(NetworkError::new("UPDATER_QA_CREDENTIALS_DISABLED")); }
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

    crate::ulog_info!("[agent-network] credential recovery stage=device-key-read");
    if cancelled.load(Ordering::Acquire) {
        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
    }
    account_session.ensure_current()?;
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa)))]
    {
        let migration_scope = scope.clone();
        let migration_fingerprint = expected_fingerprint.clone();
        let migration_cancelled = cancelled.clone();
        let migration_account = account_session.clone();
        let authorized = tokio::task::spawn_blocking(move || -> Result<_, NetworkError> {
            super::credential_slots::promote_authorized_key(
                &migration_scope,
                &migration_fingerprint,
                &migration_cancelled,
                || {
                    if migration_cancelled.load(Ordering::Acquire) {
                        return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
                    }
                    migration_account.ensure_current()
                },
            )
        })
        .await
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))??;
        if cancelled.load(Ordering::Acquire) {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        account_session.ensure_current()?;
        let (authorized_scope, authorized_store, route_selection) = authorized;
        crate::ulog_info!("[agent-network] credential recovery stage=device-key-validated");
        return Ok(Arc::new(ReadOnlyScopeStore {
            scope,
            authorized_scope,
            route_selection,
            inner: authorized_store,
        }));
    }
    #[cfg(not(all(target_os = "macos", myagents_moxbot, not(test), not(myagents_updater_qa))))]
    {
        let authorization_scope = scope.clone();
        let authorization_cancelled = cancelled.clone();
        let (store, key) = tokio::task::spawn_blocking(move || {
            let store = OsIdentityStore::authorize_existing(
                &authorization_scope,
                &authorization_cancelled,
            )?;
            let key = store.load(&authorization_scope)?;
            Ok::<_, super::crypto::CryptoError>((store, key))
        })
        .await
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))??;
        if key.public_fingerprint()? != expected_fingerprint {
            return Err(NetworkError::new("IDENTITY_KEY_MISMATCH"));
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(NetworkError::new("OWNED_LOGIN_CANCELLED"));
        }
        account_session.ensure_current()?;
        crate::ulog_info!("[agent-network] credential recovery stage=device-key-validated");
        Ok(store)
    }
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
            "keyFingerprint": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        })
    }

    #[test]
    fn restored_seed_remains_read_only_and_bound_to_all_original_scope_fields() {
        use std::sync::atomic::AtomicUsize;
        struct Counting(AtomicUsize);
        impl IdentityStore for Counting {
            fn load(
                &self,
                _: &KeyScope,
            ) -> Result<DevicePrivateKey, super::super::crypto::CryptoError> {
                self.0.fetch_add(1, Ordering::Relaxed);
                DevicePrivateKey::generate()
            }
            fn save_pending(
                &self,
                _: &KeyScope,
                _: &DevicePrivateKey,
            ) -> Result<(), super::super::crypto::CryptoError> {
                panic!("readonly seed must never delegate writes")
            }
            fn delete(&self, _: &KeyScope) -> Result<(), super::super::crypto::CryptoError> {
                panic!("readonly seed must never delegate deletion")
            }
        }
        let scope = KeyScope {
            issuer: "https://owned.example".into(),
            environment: "development".into(),
            service_id: "00000000-0000-4000-8000-000000000001".into(),
            principal_id: "owner".into(),
            device_id: "00000000-0000-4000-8000-000000000004".into(),
            key_generation: 2,
        };
        let backend = Arc::new(Counting(AtomicUsize::new(0)));
        let store = ReadOnlyScopeStore {
            scope: scope.clone(),
            authorized_scope: scope.clone(),
            route_selection: crate::agent_network::credential_slots::RouteSelection::Legacy,
            inner: backend.clone(),
        };
        let key = store.load(&scope).unwrap();
        for field in 0..6 {
            let mut other = scope.clone();
            match field {
                0 => other.issuer = "https://other.example".into(),
                1 => other.environment = "production".into(),
                2 => other.service_id = "00000000-0000-4000-8000-000000000009".into(),
                3 => other.principal_id = "other".into(),
                4 => other.device_id = "00000000-0000-4000-8000-000000000009".into(),
                _ => other.key_generation = 3,
            }
            assert!(matches!(
                store.load(&other),
                Err(super::super::crypto::CryptoError::CredentialConflict)
            ));
        }
        assert!(store.save_pending(&scope, &key).is_err());
        assert!(store.delete(&scope).is_err());
        assert_eq!(backend.0.load(Ordering::Relaxed), 1);
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
        assert_eq!(fingerprint, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

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

#[cfg(myagents_updater_qa)]
struct UpdaterQaDeniedIdentityStore;
#[cfg(myagents_updater_qa)]
impl IdentityStore for UpdaterQaDeniedIdentityStore {
    fn load(&self, _: &KeyScope) -> Result<DevicePrivateKey, super::crypto::CryptoError> { Err(super::crypto::CryptoError::CredentialUnavailable) }
    fn save_pending(&self, _: &KeyScope, _: &DevicePrivateKey) -> Result<(), super::crypto::CryptoError> { Err(super::crypto::CryptoError::CredentialUnavailable) }
    fn delete(&self, _: &KeyScope) -> Result<(), super::crypto::CryptoError> { Err(super::crypto::CryptoError::CredentialUnavailable) }
}

#[cfg(all(test, myagents_updater_qa))]
mod updater_qa_identity_tests {
    #[test]
    fn qa_identity_store_and_connection_cache_reject_all_credential_operations() {
        use super::super::crypto::{CryptoError, DevicePrivateKey, KeyScope};
        let scope = KeyScope { issuer: "https://fixture.invalid".to_owned(), environment: "development".to_owned(), service_id: "qa".to_owned(), principal_id: "synthetic".to_owned(), device_id: "fixture".to_owned(), key_generation: 1 };
        for store in [super::selected_store(), super::connection_cache()] {
            assert!(matches!(store.load(&scope), Err(CryptoError::CredentialUnavailable)));
            assert!(matches!(store.save_pending(&scope, &DevicePrivateKey::generate().unwrap()), Err(CryptoError::CredentialUnavailable)));
            assert!(matches!(store.delete(&scope), Err(CryptoError::CredentialUnavailable)));
        }
    }
}
