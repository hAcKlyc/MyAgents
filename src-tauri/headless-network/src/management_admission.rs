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
}
