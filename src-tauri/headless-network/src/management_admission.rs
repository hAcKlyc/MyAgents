//! Durable operator opt-in for the reverse management listener.
//! The grant is scoped to one encrypted owned-account binding and is never
//! silently replaced when a later login uses the same host profile.
use crate::{
    agent_network::{account::NetworkAccountSession, NetworkError},
    owned_state::{Owner, Scope},
};
use myagents_agent_network_crypto::EncryptedIdentityStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantRecord {
    version: u8,
    scope: Scope,
    principal_id: String,
    account_binding: String,
}

fn namespace(scope: &Scope) -> Result<String, NetworkError> {
    scope.validate()?;
    // One local device/profile has one grant. Changing the service or network
    // must hit the existing record and require operator reauthorization;
    // it must not select an empty namespace and silently mint another grant.
    let bytes = scope.device_id.as_bytes();
    Ok(format!(
        "owned-management-grant:{:x}",
        Sha256::digest(bytes)
    ))
}

#[derive(Clone)]
pub(crate) struct ManagementBinding {
    store: Arc<EncryptedIdentityStore>,
    record: GrantRecord,
}

impl ManagementBinding {
    pub(crate) fn verify(&self) -> Result<(), NetworkError> {
        let bytes = self
            .store
            .load_state(&namespace(&self.record.scope)?)?
            .ok_or_else(|| NetworkError::new("HOST_MANAGEMENT_GRANT_MISSING"))?;
        let stored: GrantRecord = serde_json::from_slice(&bytes)
            .map_err(|_| NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"))?;
        if stored != self.record {
            return Err(NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED"));
        }
        Ok(())
    }
    pub(crate) fn account_binding(&self) -> &str {
        &self.record.account_binding
    }
}

fn pin_record(
    store: Arc<EncryptedIdentityStore>,
    record: GrantRecord,
) -> Result<ManagementBinding, NetworkError> {
    let key = namespace(&record.scope)?;
    match store.load_state(&key)? {
        Some(bytes) => {
            let stored: GrantRecord = serde_json::from_slice(&bytes)
                .map_err(|_| NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"))?;
            if stored != record {
                return Err(NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED"));
            }
        }
        None => {
            let bytes = Zeroizing::new(
                serde_json::to_vec(&record)
                    .map_err(|_| NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"))?,
            );
            store
                .compare_exchange_state(&key, None, &bytes)
                .map_err(|_| NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED"))?;
        }
    }
    let binding = ManagementBinding { store, record };
    binding.verify()?;
    Ok(binding)
}

/// Persist the first explicit local operator enablement. Subsequent starts
/// must match this exact authenticated principal and encrypted login binding.
/// Rebinding is intentionally a separate operator workflow and is not implicit.
pub(crate) fn authorize(
    owner: &Owner,
    account: &NetworkAccountSession,
) -> Result<ManagementBinding, NetworkError> {
    account.ensure_current()?;
    let crate::agent_network::account::NetworkAccountSession::Owned(owned) = account else {
        return Err(NetworkError::new("HOST_MANAGEMENT_OWNED_ACCOUNT_REQUIRED"));
    };
    let scope = &owner.scope;
    if owned.descriptor.issuer != scope.issuer
        || owned.descriptor.service_id != scope.service_id
        || owned.descriptor.environment != scope.environment
        || owned.session.network_id != scope.network_id
    {
        return Err(NetworkError::new("HOST_MANAGEMENT_SCOPE_INVALID"));
    }
    let record = GrantRecord {
        version: 1,
        scope: scope.clone(),
        principal_id: owned.session.principal_id.clone(),
        account_binding: owned.connection_id.clone(),
    };
    let binding = pin_record(owner.store.clone(), record)?;
    account.ensure_current()?;
    Ok(binding)
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn validate_grant(record: &GrantRecord) -> Result<(), NetworkError> {
    if record.version != 1
        || !canonical_uuid(&record.principal_id)
        || !canonical_uuid(&record.account_binding)
        || record.scope.validate().is_err()
    {
        return Err(NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"));
    }
    Ok(())
}

/// Explicit local operator renewal only. Never creates a missing grant or changes
/// its authority scope; the caller must retain the profile daemon run lock.
pub(crate) fn renew(owner: &Owner, account: &NetworkAccountSession) -> Result<bool, NetworkError> {
    account.ensure_current()?;
    let NetworkAccountSession::Owned(owned) = account else {
        return Err(NetworkError::new("HOST_MANAGEMENT_OWNED_ACCOUNT_REQUIRED"));
    };
    if owned.descriptor.issuer != owner.scope.issuer
        || owned.descriptor.service_id != owner.scope.service_id
        || owned.descriptor.environment != owner.scope.environment
        || owned.session.network_id != owner.scope.network_id
    {
        return Err(NetworkError::new("HOST_MANAGEMENT_SCOPE_INVALID"));
    }
    let desired = GrantRecord {
        version: 1,
        scope: owner.scope.clone(),
        principal_id: owned.session.principal_id.clone(),
        account_binding: owned.connection_id.clone(),
    };
    renew_record(&owner.store, &desired, || account.ensure_current())
}

fn renew_record(
    store: &EncryptedIdentityStore,
    desired: &GrantRecord,
    fence: impl Fn() -> Result<(), NetworkError>,
) -> Result<bool, NetworkError> {
    validate_grant(desired)?;
    let key = namespace(&desired.scope)?;
    let bytes = store
        .load_state(&key)?
        .ok_or_else(|| NetworkError::new("HOST_MANAGEMENT_GRANT_MISSING"))?;
    renew_snapshot(
        desired,
        &bytes,
        fence,
        |expected, next| store.compare_exchange_state(&key, Some(expected), next),
        || store.load_state(&key),
    )
}

fn renew_snapshot(
    desired: &GrantRecord,
    bytes: &[u8],
    fence: impl Fn() -> Result<(), NetworkError>,
    compare_exchange: impl FnOnce(&[u8], &[u8]) -> Result<(), crate::agent_network::crypto::CryptoError>,
    load: impl FnOnce() -> Result<Option<Zeroizing<Vec<u8>>>, crate::agent_network::crypto::CryptoError>,
) -> Result<bool, NetworkError> {
    validate_grant(desired)?;
    let previous: GrantRecord = serde_json::from_slice(bytes)
        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"))?;
    validate_grant(&previous)?;
    if previous.scope != desired.scope || previous.principal_id != desired.principal_id {
        return Err(NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED"));
    }
    fence()?;
    let changed = previous.account_binding != desired.account_binding;
    let next = Zeroizing::new(
        serde_json::to_vec(desired)
            .map_err(|_| NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"))?,
    );
    if changed {
        compare_exchange(bytes, &next).map_err(|error| {
            if error == crate::agent_network::crypto::CryptoError::CredentialConflict {
                NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED")
            } else {
                NetworkError::new("HOST_MANAGEMENT_RENEW_UNCONFIRMED")
            }
        })?;
    }
    let confirm = || -> Result<(), NetworkError> {
        fence()?;
        let persisted =
            load()?.ok_or_else(|| NetworkError::new("HOST_MANAGEMENT_GRANT_MISSING"))?;
        let actual: GrantRecord = serde_json::from_slice(&persisted)
            .map_err(|_| NetworkError::new("HOST_MANAGEMENT_GRANT_CORRUPT"))?;
        if actual != *desired {
            return Err(NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED"));
        }
        fence()
    };
    confirm().map_err(|error| {
        if changed {
            NetworkError::new("HOST_MANAGEMENT_RENEW_UNCONFIRMED")
        } else {
            error
        }
    })?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_scope() -> Scope {
        Scope {
            issuer: "https://isolated.invalid".into(),
            service_id: uuid::Uuid::new_v4().to_string(),
            environment: "development".into(),
            network_id: uuid::Uuid::new_v4().to_string(),
            device_id: uuid::Uuid::new_v4().to_string(),
        }
    }
    fn store(root: &Path) -> Arc<EncryptedIdentityStore> {
        Arc::new(EncryptedIdentityStore::for_test(root, &[44; 32]).unwrap())
    }
    fn record(scope: Scope, principal: &str, binding: &str) -> GrantRecord {
        GrantRecord {
            version: 1,
            scope,
            principal_id: principal.into(),
            account_binding: binding.into(),
        }
    }

    #[test]
    fn encrypted_operator_grant_survives_restart_and_rejects_account_replacement() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let scope = test_scope();
        let original = record(
            scope.clone(),
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        );
        let first = store(&root);
        let first_binding = pin_record(first, original.clone()).unwrap();
        first_binding.verify().unwrap();
        let restored = pin_record(store(&root), original.clone()).unwrap();
        restored.verify().unwrap();

        let mut switched_instance = original.clone();
        switched_instance.scope.service_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            pin_record(store(&root), switched_instance)
                .err()
                .unwrap()
                .code,
            "HOST_MANAGEMENT_REBIND_REQUIRED"
        );
        let mut switched_network = original.clone();
        switched_network.scope.network_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            pin_record(store(&root), switched_network)
                .err()
                .unwrap()
                .code,
            "HOST_MANAGEMENT_REBIND_REQUIRED"
        );

        let switched_principal = record(
            scope.clone(),
            &uuid::Uuid::new_v4().to_string(),
            &original.account_binding,
        );
        assert_eq!(
            pin_record(store(&root), switched_principal)
                .err()
                .unwrap()
                .code,
            "HOST_MANAGEMENT_REBIND_REQUIRED"
        );
        let switched_binding = record(
            scope,
            &original.principal_id,
            &uuid::Uuid::new_v4().to_string(),
        );
        assert_eq!(
            pin_record(store(&root), switched_binding)
                .err()
                .unwrap()
                .code,
            "HOST_MANAGEMENT_REBIND_REQUIRED"
        );
        restored.verify().unwrap();
    }
    fn renewal_fixture() -> (tempfile::TempDir, Arc<EncryptedIdentityStore>, GrantRecord) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let disk = store(&root);
        let old = record(
            test_scope(),
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        );
        (dir, disk, old)
    }
    fn bytes(record: &GrantRecord) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(serde_json::to_vec(record).unwrap())
    }
    #[test]
    fn renewal_changes_only_existing_binding_and_is_durable_idempotent() {
        let (dir, disk, old) = renewal_fixture();
        pin_record(disk.clone(), old.clone()).unwrap();
        let mut next = old.clone();
        next.account_binding = uuid::Uuid::new_v4().to_string();
        assert!(renew_record(&disk, &next, || Ok(())).unwrap());
        let loaded: GrantRecord = serde_json::from_slice(
            &disk
                .load_state(&namespace(&old.scope).unwrap())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(loaded == next);
        assert!(loaded.scope == old.scope);
        assert_eq!(loaded.principal_id, old.principal_id);
        assert!(!renew_record(
            &store(&dir.path().canonicalize().unwrap()),
            &next,
            || Ok(())
        )
        .unwrap());
        assert_eq!(
            pin_record(disk, old).err().unwrap().code,
            "HOST_MANAGEMENT_REBIND_REQUIRED"
        );
    }
    #[test]
    fn renewal_missing_corrupt_and_every_scope_or_principal_change_is_rejected() {
        let (_dir, disk, old) = renewal_fixture();
        assert_eq!(
            renew_record(&disk, &old, || Ok(())).unwrap_err().code,
            "HOST_MANAGEMENT_GRANT_MISSING"
        );
        let key = namespace(&old.scope).unwrap();
        disk.compare_exchange_state(&key, None, b"{broken}")
            .unwrap();
        assert_eq!(
            renew_record(&disk, &old, || Ok(())).unwrap_err().code,
            "HOST_MANAGEMENT_GRANT_CORRUPT"
        );
        for field in 0..8 {
            let mut bad = old.clone();
            match field {
                0 => bad.scope.issuer = "https://other.invalid".into(),
                1 => bad.scope.service_id = uuid::Uuid::new_v4().to_string(),
                2 => bad.scope.environment = "production".into(),
                3 => bad.scope.network_id = uuid::Uuid::new_v4().to_string(),
                4 => bad.scope.device_id = uuid::Uuid::new_v4().to_string(),
                5 => bad.principal_id = uuid::Uuid::new_v4().to_string(),
                6 => bad.version = 2,
                _ => bad.account_binding = "invalid".into(),
            }
            let error = renew_snapshot(
                &old,
                &bytes(&bad),
                || Ok(()),
                |_, _| panic!("must reject before CAS"),
                || panic!("must reject before confirm"),
            )
            .unwrap_err();
            assert_eq!(
                error.code,
                if field >= 6 {
                    "HOST_MANAGEMENT_GRANT_CORRUPT"
                } else {
                    "HOST_MANAGEMENT_REBIND_REQUIRED"
                }
            );
        }
        let mut extra = serde_json::to_value(&old).unwrap();
        extra["extra"] = serde_json::json!(true);
        assert_eq!(
            renew_snapshot(
                &old,
                &serde_json::to_vec(&extra).unwrap(),
                || Ok(()),
                |_, _| panic!(),
                || panic!()
            )
            .unwrap_err()
            .code,
            "HOST_MANAGEMENT_GRANT_CORRUPT"
        );
    }
    #[test]
    fn renewal_expiry_or_replaced_session_fence_never_claims_success() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (_dir, disk, old) = renewal_fixture();
        pin_record(disk.clone(), old.clone()).unwrap();
        let mut next = old.clone();
        next.account_binding = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            renew_record(&disk, &next, || Err(NetworkError::new(
                "ACCOUNT_SESSION_EXPIRED"
            )))
            .unwrap_err()
            .code,
            "ACCOUNT_SESSION_EXPIRED"
        );
        assert!(
            disk.load_state(&namespace(&old.scope).unwrap())
                .unwrap()
                .unwrap()
                .as_slice()
                == bytes(&old).as_slice()
        );
        let calls = AtomicUsize::new(0);
        assert_eq!(
            renew_record(&disk, &next, || {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"))
                }
            })
            .unwrap_err()
            .code,
            "HOST_MANAGEMENT_RENEW_UNCONFIRMED"
        );
        // A post-CAS invalidation leaves durable evidence, never rolls back.
        assert!(
            disk.load_state(&namespace(&old.scope).unwrap())
                .unwrap()
                .unwrap()
                .as_slice()
                == bytes(&next).as_slice()
        );
    }
    #[test]
    fn concurrent_renewal_uses_exact_old_bytes_and_only_one_cas_wins() {
        let (_dir, disk, old) = renewal_fixture();
        pin_record(disk.clone(), old.clone()).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let disk = disk.clone();
                let old = old.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut next = old.clone();
                    next.account_binding = uuid::Uuid::new_v4().to_string();
                    let key = namespace(&old.scope).unwrap();
                    renew_snapshot(
                        &next,
                        &bytes(&old),
                        || Ok(()),
                        |expected, next| {
                            barrier.wait();
                            disk.compare_exchange_state(&key, Some(expected), next)
                        },
                        || disk.load_state(&key),
                    )
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| matches!(r, Ok(true))).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| r
                    .as_ref()
                    .is_err_and(|e| e.code == "HOST_MANAGEMENT_REBIND_REQUIRED"))
                .count(),
            1
        );
    }
    #[test]
    fn renewal_unknown_write_and_changed_readback_are_not_success_or_rollback() {
        use crate::agent_network::crypto::CryptoError;
        let (_dir, disk, old) = renewal_fixture();
        pin_record(disk.clone(), old.clone()).unwrap();
        let mut next = old.clone();
        next.account_binding = uuid::Uuid::new_v4().to_string();
        let key = namespace(&old.scope).unwrap();
        let error = renew_snapshot(
            &next,
            &bytes(&old),
            || Ok(()),
            |expected, value| {
                disk.compare_exchange_state(&key, Some(expected), value)?;
                Err(CryptoError::CredentialPersistenceUnconfirmed)
            },
            || panic!("unknown write must not be retried or claimed confirmed"),
        )
        .unwrap_err();
        assert_eq!(error.code, "HOST_MANAGEMENT_RENEW_UNCONFIRMED");
        assert!(disk.load_state(&key).unwrap().unwrap().as_slice() == bytes(&next).as_slice());
        assert_eq!(
            renew_snapshot(
                &next,
                &bytes(&old),
                || Ok(()),
                |_, _| Ok(()),
                || Ok(Some(bytes(&old)))
            )
            .unwrap_err()
            .code,
            "HOST_MANAGEMENT_RENEW_UNCONFIRMED"
        );
    }
    #[test]
    fn renew_checks_actual_owned_session_expiry_before_touching_grant() {
        use crate::agent_network::{
            account::OwnedAccount,
            owned_login::{OwnedInstance, OwnedSession},
        };
        use std::sync::atomic::AtomicBool;
        let (_dir, disk, old) = renewal_fixture();
        pin_record(disk.clone(), old.clone()).unwrap();
        let descriptor: OwnedInstance = serde_json::from_value(serde_json::json!({
            "version":1, "profile":"owned-device-relay-v1", "serviceId":old.scope.service_id,
            "environment":old.scope.environment, "networkId":old.scope.network_id,
            "name":"isolated unit fixture", "issuer":old.scope.issuer,
            "loginIssuer":"https://isolated.invalid/dex", "protocol":1,
            "capabilities":["tls13-mtls"], "rootCertificate":"unit fixture; never sent or trusted", "jwks":{}
        })).unwrap();
        // This tests only the real in-memory expiry fence, not server login or TLS.
        let account = NetworkAccountSession::Owned(Arc::new(OwnedAccount {
            connection_id: uuid::Uuid::new_v4().to_string(),
            device_id: old.scope.device_id.clone(),
            session_bound: false,
            descriptor,
            active: Arc::new(AtomicBool::new(true)),
            session: OwnedSession {
                access_token: "a".repeat(43),
                expires_at: jsonwebtoken::get_current_timestamp(),
                principal_id: old.principal_id.clone(),
                network_id: old.scope.network_id.clone(),
            },
            public_tls_ca: None,
            join_authorized: AtomicBool::new(false),
            guard: Arc::new(|| {
                panic!("expired session must reject before invoking persisted guard")
            }),
        }));
        let owner = Owner {
            store: disk.clone(),
            scope: old.scope.clone(),
            trust_fingerprint: "00".repeat(32),
        };
        assert_eq!(
            renew(&owner, &account).unwrap_err().code,
            "OWNED_SESSION_INVALID"
        );
        assert!(
            disk.load_state(&namespace(&old.scope).unwrap())
                .unwrap()
                .unwrap()
                .as_slice()
                == bytes(&old).as_slice()
        );
    }
}
