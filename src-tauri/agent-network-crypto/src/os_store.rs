use crate::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use zeroize::Zeroizing;

/// The caller serializes these operations with the App's keyed lifecycle gate
/// and invokes them on spawn_blocking. Constructing the concrete backend avoids
/// keyring's process-global default override and its mock fallback entirely.
pub struct OsIdentityStore;
impl OsIdentityStore {
    fn read(entry: &keyring::Entry) -> keyring::Result<Vec<u8>> {
        #[cfg(target_os = "macos")]
        {
            crate::read_secret_noninteractive(entry)
        }
        #[cfg(not(target_os = "macos"))]
        {
            entry.get_secret()
        }
    }
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    fn entry(scope: &KeyScope) -> Result<keyring::Entry, CryptoError> {
        let user = scope.credential_name()?;
        #[cfg(target_os = "macos")]
        let builder = keyring::macos::default_credential_builder();
        #[cfg(target_os = "windows")]
        let builder = keyring::windows::default_credential_builder();
        #[cfg(target_os = "linux")]
        let builder = keyring::secret_service::default_credential_builder();
        let credential = builder
            .build(None, "MyAgents.AgentNetwork.v1", &user)
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        Ok(keyring::Entry::new_with_credential(credential))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    fn entry(_scope: &KeyScope) -> Result<keyring::Entry, CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }

    fn read_error(error: keyring::Error) -> CryptoError {
        #[cfg(target_os = "macos")]
        if crate::credential_authorization_required(&error) {
            return CryptoError::CredentialAuthorizationRequired;
        }
        match error {
            keyring::Error::NoEntry => CryptoError::CredentialMissing,
            _ => CryptoError::CredentialUnavailable,
        }
    }

    /// Explicit user-authorized read; the resulting actor-local store cannot mutate OS state.
    pub fn authorize_existing(
        scope: &KeyScope,
        cancelled: &AtomicBool,
    ) -> Result<Arc<dyn IdentityStore>, CryptoError> {
        scope.credential_name()?;
        if cancelled.load(Ordering::Acquire) {
            return Err(CryptoError::CredentialUnavailable);
        }
        #[cfg(target_os = "macos")]
        {
            let secret = Zeroizing::new(
                crate::read_secret_authorized(&Self::entry(scope)?, cancelled)
                    .map_err(Self::read_error)?,
            );
            let key = DevicePrivateKey::from_der(secret)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(CryptoError::CredentialUnavailable);
            }
            Ok(Arc::new(AuthorizedIdentityStore {
                scope: scope.clone(),
                key,
            }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(CryptoError::UnsupportedPlatform)
        }
    }

    pub fn load(scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let secret = Self::read(&Self::entry(scope)?).map_err(Self::read_error)?;
        DevicePrivateKey::from_der(Zeroizing::new(secret))
    }
    pub fn save_pending(scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        let entry = Self::entry(scope)?;
        match Self::read(&entry) {
            Ok(existing) => {
                let existing = DevicePrivateKey::from_der(Zeroizing::new(existing))?;
                if existing.public_fingerprint()? != key.public_fingerprint()? {
                    return Err(CryptoError::CredentialConflict);
                }
                return Ok(());
            }
            Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(Self::read_error(error)),
        }
        entry
            .set_secret(&key.der)
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        // Confirm persistence before allowing issuer activation. Failure never
        // falls back to a file or an in-memory replacement identity.
        let persisted = Self::load(scope)?;
        if persisted.public_fingerprint()? != key.public_fingerprint()? {
            return Err(CryptoError::CredentialConflict);
        }
        Ok(())
    }
    pub fn delete(scope: &KeyScope) -> Result<(), CryptoError> {
        match Self::entry(scope)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CryptoError::CredentialUnavailable),
        }
    }
}

impl IdentityStore for OsIdentityStore {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        Self::load(scope)
    }
    fn save_pending(&self, scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        Self::save_pending(scope, key)
    }
    fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError> {
        Self::delete(scope)
    }
}

#[cfg(any(target_os = "macos", test))]
struct AuthorizedIdentityStore {
    scope: KeyScope,
    key: DevicePrivateKey,
}
#[cfg(any(target_os = "macos", test))]
impl IdentityStore for AuthorizedIdentityStore {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        scope.credential_name()?;
        if self.scope.issuer != scope.issuer
            || self.scope.environment != scope.environment
            || self.scope.service_id != scope.service_id
            || self.scope.principal_id != scope.principal_id
            || self.scope.device_id != scope.device_id
            || self.scope.key_generation != scope.key_generation
        {
            return Err(CryptoError::CredentialConflict);
        }
        DevicePrivateKey::from_der(Zeroizing::new(self.key.der.to_vec()))
    }
    fn save_pending(&self, _: &KeyScope, _: &DevicePrivateKey) -> Result<(), CryptoError> {
        Err(CryptoError::CredentialUnavailable)
    }
    fn delete(&self, _: &KeyScope) -> Result<(), CryptoError> {
        Err(CryptoError::CredentialUnavailable)
    }
}

#[cfg(test)]
mod authorization_tests {
    use super::*;
    #[test]
    fn cancelled_authorization_fails_before_any_os_read() {
        let scope = KeyScope {
            issuer: "https://isolated.invalid".into(),
            environment: "development".into(),
            service_id: "123e4567-e89b-42d3-a456-426614174001".into(),
            principal_id: "isolated".into(),
            device_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            key_generation: 1,
        };
        assert!(matches!(
            OsIdentityStore::authorize_existing(&scope, &AtomicBool::new(true)),
            Err(CryptoError::CredentialUnavailable)
        ));
        #[cfg(target_os = "macos")]
        for status in [-25308, -25293] {
            assert_eq!(
                OsIdentityStore::read_error(keyring::macos::decode_error(
                    security_framework::base::Error::from(status)
                )),
                CryptoError::CredentialAuthorizationRequired
            );
        }
        assert_eq!(
            OsIdentityStore::read_error(keyring::Error::NoEntry),
            CryptoError::CredentialMissing
        );
    }
    #[test]
    fn authorized_seed_is_scope_bound_repeatable_and_read_only() {
        let scope = KeyScope {
            issuer: "https://isolated.invalid".into(),
            environment: "development".into(),
            service_id: "123e4567-e89b-42d3-a456-426614174001".into(),
            principal_id: "isolated".into(),
            device_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            key_generation: 1,
        };
        let key = DevicePrivateKey::generate().unwrap();
        let fingerprint = key.public_fingerprint().unwrap();
        let store = AuthorizedIdentityStore {
            scope: scope.clone(),
            key,
        };
        for _ in 0..2 {
            assert_eq!(
                store.load(&scope).unwrap().public_fingerprint().unwrap(),
                fingerprint
            );
        }
        let mut other = scope.clone();
        other.key_generation = 2;
        assert!(matches!(
            store.load(&other),
            Err(CryptoError::CredentialConflict)
        ));
        other = scope.clone();
        other.issuer = "https://other.invalid".into();
        assert!(matches!(
            store.load(&other),
            Err(CryptoError::CredentialConflict)
        ));
        assert_eq!(
            store.save_pending(&scope, &store.load(&scope).unwrap()),
            Err(CryptoError::CredentialUnavailable)
        );
        assert_eq!(
            store.delete(&scope),
            Err(CryptoError::CredentialUnavailable)
        );
        assert_eq!(
            CryptoError::CredentialAuthorizationRequired.to_string(),
            "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED"
        );
    }
}
