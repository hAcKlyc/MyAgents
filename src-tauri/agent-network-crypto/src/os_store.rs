use crate::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope};
use zeroize::Zeroizing;

/// The caller serializes these operations with the App's keyed lifecycle gate
/// and invokes them on spawn_blocking. Constructing the concrete backend avoids
/// keyring's process-global default override and its mock fallback entirely.
pub struct OsIdentityStore;
impl OsIdentityStore {
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

    pub fn load(scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let secret = Self::entry(scope)?
            .get_secret()
            .map_err(|error| match error {
                keyring::Error::NoEntry => CryptoError::CredentialMissing,
                _ => CryptoError::CredentialUnavailable,
            })?;
        DevicePrivateKey::from_der(Zeroizing::new(secret))
    }
    pub fn save_pending(scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        let entry = Self::entry(scope)?;
        match entry.get_secret() {
            Ok(existing) => {
                let existing = DevicePrivateKey::from_der(Zeroizing::new(existing))?;
                if existing.public_fingerprint()? != key.public_fingerprint()? {
                    return Err(CryptoError::CredentialConflict);
                }
                return Ok(());
            }
            Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(CryptoError::CredentialUnavailable),
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
