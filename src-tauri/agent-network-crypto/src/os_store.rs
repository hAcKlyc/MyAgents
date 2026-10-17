use crate::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use zeroize::Zeroizing;

/// The caller serializes these operations with the App's keyed lifecycle gate
/// and invokes them on spawn_blocking. Constructing the concrete backend avoids
/// keyring's process-global default override and its mock fallback entirely.
pub struct OsIdentityStore;
impl OsIdentityStore {
    /// One actor/binding/generation owns this cache; never share it globally.
    pub fn connection_cache() -> Arc<dyn IdentityStore> {
        Arc::new(ConnectionCache::new(Arc::new(Self)))
    }
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
        #[cfg(target_os = "macos")]
        let written = crate::write_secret_noninteractive(&entry, &key.der);
        #[cfg(not(target_os = "macos"))]
        let written = entry.set_secret(&key.der);
        written.map_err(Self::read_error)?;
        // Confirm persistence before allowing issuer activation. Failure never
        // falls back to a file or an in-memory replacement identity.
        let persisted = Self::load(scope)?;
        if persisted.public_fingerprint()? != key.public_fingerprint()? {
            return Err(CryptoError::CredentialConflict);
        }
        Ok(())
    }
    pub fn delete(scope: &KeyScope) -> Result<(), CryptoError> {
        let entry = Self::entry(scope)?;
        #[cfg(target_os = "macos")]
        let deleted = crate::delete_secret_noninteractive(&entry);
        #[cfg(not(target_os = "macos"))]
        let deleted = entry.delete_credential();
        match deleted {
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

fn same_scope(a: &KeyScope, b: &KeyScope) -> bool {
    a.issuer == b.issuer
        && a.environment == b.environment
        && a.service_id == b.service_id
        && a.principal_id == b.principal_id
        && a.device_id == b.device_id
        && a.key_generation == b.key_generation
}
struct ConnectionCache {
    backend: Arc<dyn IdentityStore>,
    cached: Mutex<Option<(KeyScope, DevicePrivateKey)>>,
}
impl ConnectionCache {
    fn new(backend: Arc<dyn IdentityStore>) -> Self {
        Self {
            backend,
            cached: Mutex::new(None),
        }
    }
}
impl IdentityStore for ConnectionCache {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        scope.credential_name()?;
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        if cached
            .as_ref()
            .is_some_and(|(stored, _)| !same_scope(stored, scope))
        {
            *cached = None;
        }
        if let Some((_, key)) = &*cached {
            return DevicePrivateKey::from_der(Zeroizing::new(key.der.to_vec()));
        }
        let key = self.backend.load(scope)?;
        let returned = DevicePrivateKey::from_der(Zeroizing::new(key.der.to_vec()))?;
        *cached = Some((scope.clone(), key));
        Ok(returned)
    }
    fn save_pending(&self, scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        // An unconfirmed mutation must not leave an optimistic cached identity.
        *cached = None;
        self.backend.save_pending(scope, key)
    }
    fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        *cached = None;
        self.backend.delete(scope)
    }
}

#[cfg(test)]
mod connection_cache_tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;
    struct Counting {
        keys: Mutex<HashMap<String, Zeroizing<Vec<u8>>>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        deletes: AtomicUsize,
        failed: AtomicBool,
        dropped: Arc<AtomicBool>,
    }
    impl Drop for Counting {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::Release);
        }
    }
    impl IdentityStore for Counting {
        fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
            self.reads.fetch_add(1, Ordering::Relaxed);
            if self.failed.load(Ordering::Acquire) {
                return Err(CryptoError::CredentialUnavailable);
            }
            let keys = self.keys.lock().unwrap();
            DevicePrivateKey::from_der(Zeroizing::new(
                keys.get(&scope.credential_name()?)
                    .ok_or(CryptoError::CredentialMissing)?
                    .to_vec(),
            ))
        }
        fn save_pending(
            &self,
            scope: &KeyScope,
            key: &DevicePrivateKey,
        ) -> Result<(), CryptoError> {
            self.writes.fetch_add(1, Ordering::Relaxed);
            if self.failed.load(Ordering::Acquire) {
                return Err(CryptoError::CredentialPersistenceUnconfirmed);
            }
            self.keys
                .lock()
                .unwrap()
                .insert(scope.credential_name()?, Zeroizing::new(key.der.to_vec()));
            Ok(())
        }
        fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError> {
            self.deletes.fetch_add(1, Ordering::Relaxed);
            self.keys.lock().unwrap().remove(&scope.credential_name()?);
            Ok(())
        }
    }
    fn backend() -> Arc<Counting> {
        Arc::new(Counting {
            keys: Mutex::new(HashMap::new()),
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            deletes: AtomicUsize::new(0),
            failed: AtomicBool::new(false),
            dropped: Arc::new(AtomicBool::new(false)),
        })
    }
    fn scope() -> KeyScope {
        KeyScope {
            issuer: "https://isolated.invalid".into(),
            environment: "development".into(),
            service_id: "123e4567-e89b-42d3-a456-426614174001".into(),
            principal_id: "isolated".into(),
            device_id: "123e4567-e89b-42d3-a456-426614174000".into(),
            key_generation: 1,
        }
    }
    #[test]
    fn same_actor_concurrent_reads_share_one_valid_key_and_scope_change_evicts() {
        let backend = backend();
        let scope = scope();
        let key = DevicePrivateKey::generate().unwrap();
        backend.save_pending(&scope, &key).unwrap();
        let cache = Arc::new(ConnectionCache::new(backend.clone()));
        let barrier = std::sync::Barrier::new(4);
        std::thread::scope(|threads| {
            for _ in 0..4 {
                let cache = cache.clone();
                let scope = &scope;
                let barrier = &barrier;
                let key = &key;
                threads.spawn(move || {
                    barrier.wait();
                    assert_eq!(
                        cache.load(scope).unwrap().public_fingerprint().unwrap(),
                        key.public_fingerprint().unwrap()
                    );
                });
            }
        });
        assert_eq!(backend.reads.load(Ordering::Relaxed), 1);
        let mut next = scope.clone();
        next.key_generation = 2;
        assert!(matches!(
            cache.load(&next),
            Err(CryptoError::CredentialMissing)
        ));
        cache.load(&scope).unwrap();
        assert_eq!(backend.reads.load(Ordering::Relaxed), 3);
        next = scope.clone();
        next.principal_id = "other".into();
        assert!(cache.load(&next).is_err());
        cache.load(&scope).unwrap();
        assert_eq!(backend.reads.load(Ordering::Relaxed), 5);
    }
    #[test]
    fn missing_and_errors_are_not_cached_and_mutations_invalidate() {
        let backend = backend();
        let scope = scope();
        let cache = ConnectionCache::new(backend.clone());
        for _ in 0..2 {
            assert!(matches!(
                cache.load(&scope),
                Err(CryptoError::CredentialMissing)
            ));
        }
        backend.failed.store(true, Ordering::Release);
        for _ in 0..2 {
            assert!(matches!(
                cache.load(&scope),
                Err(CryptoError::CredentialUnavailable)
            ));
        }
        assert_eq!(backend.reads.load(Ordering::Relaxed), 4);
        backend.failed.store(false, Ordering::Release);
        let key = DevicePrivateKey::generate().unwrap();
        cache.save_pending(&scope, &key).unwrap();
        cache.load(&scope).unwrap();
        cache.load(&scope).unwrap();
        assert_eq!(backend.reads.load(Ordering::Relaxed), 5);
        cache.save_pending(&scope, &key).unwrap();
        cache.load(&scope).unwrap();
        assert_eq!(backend.reads.load(Ordering::Relaxed), 6);
        backend.failed.store(true, Ordering::Release);
        assert_eq!(
            cache.save_pending(&scope, &key),
            Err(CryptoError::CredentialPersistenceUnconfirmed)
        );
        assert!(cache.load(&scope).is_err());
        assert_eq!(backend.reads.load(Ordering::Relaxed), 7);
        backend.failed.store(false, Ordering::Release);
        cache.load(&scope).unwrap();
        cache.delete(&scope).unwrap();
        assert!(matches!(
            cache.load(&scope),
            Err(CryptoError::CredentialMissing)
        ));
        assert_eq!(backend.writes.load(Ordering::Relaxed), 3);
        assert_eq!(backend.deletes.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn actor_local_cache_drop_releases_backend_and_zeroizing_owned_key() {
        let backend = backend();
        let dropped = backend.dropped.clone();
        let weak = Arc::downgrade(&backend);
        let scope = scope();
        backend
            .save_pending(&scope, &DevicePrivateKey::generate().unwrap())
            .unwrap();
        let cache = ConnectionCache::new(backend.clone());
        cache.load(&scope).unwrap();
        drop(backend);
        assert!(weak.upgrade().is_some());
        drop(cache);
        assert!(weak.upgrade().is_none());
        assert!(dropped.load(Ordering::Acquire));
    }
}
