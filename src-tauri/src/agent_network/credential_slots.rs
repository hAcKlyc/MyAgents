//! Desktop-only credential entry routing. Protocol scopes NEVER leave this module mapped.
//! Callers run blocking operations under their existing binding/cancellation lifecycle gate.
#![cfg_attr(test, allow(dead_code))]
use super::crypto::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope, OsIdentityStore};
#[cfg(unix)]
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
#[cfg(unix)]
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::collections::BTreeSet;
#[cfg(unix)]
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
#[cfg(all(test, unix))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(unix)]
const NAME: &str = "credential-slot-routes-v1.json";
#[cfg(unix)]
const LOCK: &str = "credential-slot-routes-v1.lock";
#[cfg(unix)]
const LOCK_PARENT: &str = "credential-slot-locks-v1";
#[cfg(unix)]
const MAX_BYTES: usize = 256 * 1024;
#[cfg(unix)]
const MAX_ROUTES: usize = 4096;
const DOMAIN: &str = "moxbots.fixed-reader.credential-slots.v1";
fn unavailable() -> CryptoError {
    CryptoError::CredentialUnavailable
}
fn hash43(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}
fn canonical_hash(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|v| v.len() == 32 && URL_SAFE_NO_PAD.encode(v) == value)
}
fn valid_route(value: &str) -> bool {
    value.split_once(':').is_some_and(|(kind, h)| {
        matches!(kind, "session" | "pending" | "identity") && canonical_hash(h)
    })
}
fn validate_scope(s: &KeyScope) -> Result<(), CryptoError> {
    let url = url::Url::parse(&s.issuer).map_err(|_| CryptoError::InvalidKey)?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != s.issuer
        || !matches!(s.environment.as_str(), "production" | "development")
        || s.principal_id.is_empty()
        || s.principal_id.len() > 256
        || !(1..=9_007_199_254_740_991).contains(&s.key_generation)
        || uuid::Uuid::parse_str(&s.service_id)
            .map(|v| v.to_string())
            .as_deref()
            != Ok(s.service_id.as_str())
        || uuid::Uuid::parse_str(&s.device_id)
            .map(|v| v.to_string())
            .as_deref()
            != Ok(s.device_id.as_str())
    {
        return Err(CryptoError::InvalidKey);
    }
    Ok(())
}
fn scope_material(s: &KeyScope) -> Result<Vec<u8>, CryptoError> {
    validate_scope(s)?;
    serde_json::to_vec(&(DOMAIN, ".moxbot", "identity", s)).map_err(|_| CryptoError::InvalidKey)
}
pub(crate) fn identity_route_id(s: &KeyScope) -> Result<String, CryptoError> {
    Ok(format!("identity:{}", hash43(&scope_material(s)?)))
}
pub(crate) fn local_scope(scope: &KeyScope) -> Result<KeyScope, CryptoError> {
    let bytes = Sha256::digest(scope_material(scope)?);
    let mut uuid = [0u8; 16];
    uuid.copy_from_slice(&bytes[..16]);
    uuid[6] = (uuid[6] & 0x0f) | 0x80;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;
    let mut mapped = scope.clone();
    mapped.service_id = uuid::Uuid::from_bytes(uuid).to_string();
    Ok(mapped)
}
pub(crate) fn session_hash(legacy43: &str) -> Result<String, CryptoError> {
    if !canonical_hash(legacy43) {
        return Err(CryptoError::InvalidKey);
    }
    Ok(hash43(
        &serde_json::to_vec(&(DOMAIN, ".moxbot", "account", legacy43))
            .map_err(|_| CryptoError::InvalidKey)?,
    ))
}
#[cfg(unix)]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LedgerData {
    version: u32,
    routes: Vec<String>,
}
#[derive(Clone)]
struct Ledger {
    root: PathBuf,
}
#[cfg(unix)]
impl Ledger {
    fn production() -> Result<Self, CryptoError> {
        let root = crate::app_dirs::myagents_data_dir().ok_or_else(unavailable)?;
        if root.file_name().and_then(|v| v.to_str()) != Some(".moxbot") {
            return Err(unavailable());
        }
        Ok(Self { root })
    }
    fn ancestors_safe(&self) -> Result<(), CryptoError> {
        if !self.root.is_absolute() {
            return Err(unavailable());
        }
        let uid = unsafe { libc::geteuid() };
        let mut prefix = PathBuf::new();
        for component in self.root.parent().ok_or_else(unavailable)?.components() {
            prefix.push(component.as_os_str());
            let m = fs::symlink_metadata(&prefix).map_err(|_| unavailable())?;
            let trusted_sticky = m.uid() == 0 && m.mode() & 0o7000 == 0o1000;
            if !m.is_dir()
                || (m.uid() != 0 && m.uid() != uid)
                || (!trusted_sticky && (m.mode() & 0o7022 != 0))
            {
                return Err(unavailable());
            }
        }
        Ok(())
    }
    fn directory(&self) -> Result<File, CryptoError> {
        self.ancestors_safe()?;
        match fs::symlink_metadata(&self.root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&self.root)
                    .map_err(|_| unavailable())?;
                File::open(self.root.parent().ok_or_else(unavailable)?)
                    .and_then(|f| f.sync_all())
                    .map_err(|_| unavailable())?;
            }
            Err(_) => return Err(unavailable()),
            Ok(_) => {}
        }
        let f = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&self.root)
            .map_err(|_| unavailable())?;
        let m = f.metadata().map_err(|_| unavailable())?;
        if !m.is_dir()
            || m.uid() != unsafe { libc::geteuid() }
            || m.mode() & 0o7022 != 0
            || self.root.canonicalize().map_err(|_| unavailable())? != self.root
        {
            return Err(unavailable());
        }
        Ok(f)
    }
    fn same_directory(&self, f: &File) -> bool {
        fs::symlink_metadata(&self.root)
            .ok()
            .zip(f.metadata().ok())
            .is_some_and(|(a, b)| a.is_dir() && a.dev() == b.dev() && a.ino() == b.ino())
    }
    fn lock_directory(&self, root: &File) -> Result<(PathBuf, File), CryptoError> {
        let name = std::ffi::CString::new(LOCK_PARENT).map_err(|_| unavailable())?;
        let created = unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } == 0;
        if !created && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
            return Err(unavailable());
        }
        let fd = unsafe {
            libc::openat(
                root.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(unavailable());
        }
        let dir = unsafe { File::from_raw_fd(fd) };
        let m = dir.metadata().map_err(|_| unavailable())?;
        if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7777 != 0o700 {
            return Err(unavailable());
        }
        if created {
            root.sync_all().map_err(|_| unavailable())?;
        }
        Ok((self.root.join(LOCK_PARENT), dir))
    }
    fn lock_preflight(&self, lock: &std::path::Path, owned: bool) -> Result<(), CryptoError> {
        match fs::symlink_metadata(lock) {
            Err(e) if !owned && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(unavailable()),
            Ok(m) => {
                if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o7022 != 0 {
                    return Err(unavailable());
                }
                let owner = lock.join("owner");
                match fs::symlink_metadata(&owner) {
                    Ok(m)
                        if m.is_file()
                            && m.nlink() == 1
                            && m.uid() == unsafe { libc::geteuid() }
                            && m.mode() & 0o7022 == 0
                            && m.len() <= 256 =>
                    {
                        let file = OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                            .open(owner);
                        let mut file = match file {
                            Ok(file) => file,
                            Err(e) if !owned && e.kind() == std::io::ErrorKind::NotFound => {
                                return Ok(())
                            }
                            Err(_) => return Err(unavailable()),
                        };
                        let current = file.metadata().map_err(|_| unavailable())?;
                        if !owned && current.nlink() == 0 {
                            return Ok(());
                        }
                        if !current.is_file()
                            || current.nlink() != 1
                            || current.uid() != unsafe { libc::geteuid() }
                            || current.mode() & 0o7022 != 0
                        {
                            return Err(unavailable());
                        }
                        let mut token = String::new();
                        (&mut file)
                            .take(257)
                            .read_to_string(&mut token)
                            .map_err(|_| unavailable())?;
                        let token = token.trim_ascii();
                        if !owned && token.is_empty() {
                            return Ok(());
                        }
                        let fields: Vec<_> = token.split(':').collect();
                        if fields.len() != 3
                            || fields[0] != "rust"
                            || fields[1].parse::<i32>().is_err()
                            || fields[1].parse::<i32>().is_ok_and(|pid| {
                                pid <= 0 || (owned && pid as u32 != std::process::id())
                            })
                            || fields[2].parse::<u64>().is_err()
                            || fields[1..]
                                .iter()
                                .any(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
                        {
                            return Err(unavailable());
                        }
                        Ok(())
                    }
                    Err(e) if !owned && e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    _ => Err(unavailable()),
                }
            }
        }
    }
    fn transaction<T>(
        &self,
        op: impl FnOnce(&File) -> Result<T, CryptoError>,
    ) -> Result<T, CryptoError> {
        let dir = self.directory()?;
        let (lock_parent, lock_parent_fd) = self.lock_directory(&dir)?;
        let lock = lock_parent.join(LOCK);
        self.lock_preflight(&lock, false)?;
        with_file_lock_blocking(&lock, FileLockOptions::default(), || {
            if !self.same_directory(&dir) {
                return Err(FileLockError::Io(std::io::Error::other(
                    "credential routes unavailable",
                )));
            }
            let actual = fs::symlink_metadata(&lock_parent).map_err(FileLockError::Io)?;
            let pinned = lock_parent_fd.metadata().map_err(FileLockError::Io)?;
            if !actual.is_dir() || actual.dev() != pinned.dev() || actual.ino() != pinned.ino() {
                return Err(FileLockError::Io(std::io::Error::other(
                    "credential routes unavailable",
                )));
            }
            self.lock_preflight(&lock, true).map_err(|_| {
                FileLockError::Io(std::io::Error::other("credential routes unavailable"))
            })?;
            Ok(op(&dir))
        })
        .map_err(|_| unavailable())?
    }
    fn read(&self, dir: &File) -> Result<BTreeSet<String>, CryptoError> {
        let name = std::ffi::CString::new(NAME).map_err(|_| unavailable())?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(BTreeSet::new())
            } else {
                Err(unavailable())
            };
        }
        let mut f = unsafe { File::from_raw_fd(fd) };
        let m = f.metadata().map_err(|_| unavailable())?;
        if !m.is_file()
            || m.uid() != unsafe { libc::geteuid() }
            || m.nlink() != 1
            || m.mode() & 0o7777 != 0o600
            || m.len() > MAX_BYTES as u64
        {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        (&mut f)
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() > MAX_BYTES {
            return Err(unavailable());
        }
        let data: LedgerData = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if data.version != 1
            || data.routes.len() > MAX_ROUTES
            || data.routes.iter().any(|r| !valid_route(r))
        {
            return Err(unavailable());
        }
        let routes: BTreeSet<_> = data.routes.into_iter().collect();
        // Strict sorted unique representation; never accept an ambiguous authority.
        let encoded = serde_json::to_vec(&LedgerData {
            version: 1,
            routes: routes.iter().cloned().collect(),
        })
        .map_err(|_| unavailable())?;
        let original: LedgerData = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if original.routes.len() != routes.len() || original.routes.iter().ne(routes.iter()) {
            return Err(unavailable());
        }
        if encoded.len() > MAX_BYTES {
            return Err(unavailable());
        }
        Ok(routes)
    }
    fn write(&self, dir: &File, routes: BTreeSet<String>) -> Result<(), CryptoError> {
        let bytes = serde_json::to_vec(&LedgerData {
            version: 1,
            routes: routes.into_iter().collect(),
        })
        .map_err(|_| unavailable())?;
        if bytes.len() > MAX_BYTES {
            return Err(unavailable());
        }
        let tmp = std::ffi::CString::new(format!(
            ".credential-slot-routes.{}.tmp",
            uuid::Uuid::new_v4()
        ))
        .map_err(|_| unavailable())?;
        let name = std::ffi::CString::new(NAME).map_err(|_| unavailable())?;
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                tmp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(unavailable());
        }
        let mut f = unsafe { File::from_raw_fd(fd) };
        let result = (|| {
            // umask cannot make the required mode ambiguous.
            if unsafe { libc::fchmod(f.as_raw_fd(), 0o600) } != 0 {
                return Err(unavailable());
            }
            f.write_all(&bytes)
                .and_then(|_| f.sync_all())
                .map_err(|_| unavailable())?;
            if !self.same_directory(dir) {
                return Err(unavailable());
            }
            if unsafe {
                libc::renameat(
                    dir.as_raw_fd(),
                    tmp.as_ptr(),
                    dir.as_raw_fd(),
                    name.as_ptr(),
                )
            } != 0
            {
                return Err(unavailable());
            }
            dir.sync_all().map_err(|_| unavailable())?;
            Ok(())
        })();
        if result.is_err() {
            unsafe { libc::unlinkat(dir.as_raw_fd(), tmp.as_ptr(), 0) };
        }
        result
    }
    fn persist_after(
        &self,
        id: &str,
        action: impl FnOnce(bool) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            let mut routes = self.read(dir)?;
            if !routes.contains(id) && routes.len() >= MAX_ROUTES {
                return Err(unavailable());
            }
            action(routes.contains(id))?;
            if routes.insert(id.into()) {
                self.write(dir, routes)?;
            }
            Ok(())
        })
    }
    fn barrier_then(
        &self,
        id: &str,
        action: impl FnOnce() -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            let mut routes = self.read(dir)?;
            if !routes.contains(id) {
                if routes.len() >= MAX_ROUTES {
                    return Err(unavailable());
                }
                routes.insert(id.into());
                self.write(dir, routes)?;
            }
            action()
        })
    }
    fn route(&self, id: &str) -> Result<bool, CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| Ok(self.read(dir)?.contains(id)))
    }
    fn commit(&self, id: &str) -> Result<(), CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            let mut routes = self.read(dir)?;
            if routes.contains(id) {
                return Ok(());
            }
            if routes.len() >= MAX_ROUTES {
                return Err(unavailable());
            }
            routes.insert(id.into());
            self.write(dir, routes)
        })
    }
}
#[cfg(not(unix))]
impl Ledger {
    fn production() -> Result<Self, CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
    fn route(&self, _: &str) -> Result<bool, CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
    fn commit(&self, _: &str) -> Result<(), CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
    fn persist_after(
        &self,
        _: &str,
        _: impl FnOnce(bool) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
    fn barrier_then(
        &self,
        _: &str,
        _: impl FnOnce() -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
}
pub(crate) fn route(id: &str) -> Result<bool, CryptoError> {
    Ledger::production()?.route(id)
}
pub(crate) fn commit(id: &str) -> Result<(), CryptoError> {
    Ledger::production()?.commit(id)
}
/// Serialize caller-owned session write/readback/fence with route authority.
/// The callback receives the route read under the same lock, before any write.
/// It must not recursively call route/commit and must not await.
/// Preserve its typed error; the fixed internal carrier contains no details.
pub(crate) fn with_committed_route<E: From<CryptoError>>(
    id: &str,
    action: impl FnOnce(bool) -> Result<(), E>,
) -> Result<(), E> {
    committed_route(&Ledger::production().map_err(E::from)?, id, action)
}
fn committed_route<E: From<CryptoError>>(
    ledger: &Ledger,
    id: &str,
    action: impl FnOnce(bool) -> Result<(), E>,
) -> Result<(), E> {
    let mut original = None;
    let result = ledger.persist_after(id, |already_committed| match action(already_committed) {
        Ok(()) => Ok(()),
        Err(error) => {
            original = Some(error);
            Err(unavailable())
        }
    });
    match original {
        Some(error) => Err(error),
        None => result.map_err(E::from),
    }
}

/// Caller constructs/reads the physical slot directly from the supplied route.
/// None/predicate error cannot commit; Some is fenced durably before deletion.
/// Neither callback may recursively acquire the route lock or await.
pub(crate) fn with_deleted_route<E: From<CryptoError>, T>(
    id: &str,
    select: impl FnOnce(bool) -> Result<Option<T>, E>,
    delete: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    deleted_route(&Ledger::production().map_err(E::from)?, id, select, delete)
}
#[cfg(unix)]
fn deleted_route<E: From<CryptoError>, T>(
    ledger: &Ledger,
    id: &str,
    select: impl FnOnce(bool) -> Result<Option<T>, E>,
    delete: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    if !valid_route(id) {
        return Err(E::from(CryptoError::InvalidKey));
    }
    let mut original = None;
    let result = ledger.transaction(|dir| {
        let mut routes = ledger.read(dir)?;
        let selected = match select(routes.contains(id)) {
            Ok(value) => value,
            Err(error) => {
                original = Some(error);
                return Err(unavailable());
            }
        };
        let Some(value) = selected else {
            return Ok(false);
        };
        if !routes.contains(id) {
            if routes.len() >= MAX_ROUTES {
                return Err(unavailable());
            }
            routes.insert(id.into());
            ledger.write(dir, routes)?;
        }
        match delete(value) {
            Ok(()) => Ok(true),
            Err(error) => {
                original = Some(error);
                Err(unavailable())
            }
        }
    });
    match original {
        Some(error) => Err(error),
        None => result.map_err(E::from),
    }
}

#[cfg(not(unix))]
fn deleted_route<E: From<CryptoError>, T>(
    _: &Ledger,
    _: &str,
    _: impl FnOnce(bool) -> Result<Option<T>, E>,
    _: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    Err(E::from(CryptoError::UnsupportedPlatform))
}

struct VersionedStore {
    ledger: Ledger,
    backend: Arc<dyn IdentityStore>,
}
impl IdentityStore for VersionedStore {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let id = identity_route_id(scope)?;
        let physical = if self.ledger.route(&id)? {
            local_scope(scope)?
        } else {
            scope.clone()
        };
        self.backend.load(&physical)
    }
    fn save_pending(&self, scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        let id = identity_route_id(scope)?;
        let mapped = local_scope(scope)?;
        self.ledger.persist_after(&id, |_| {
            self.backend.save_pending(&mapped, key)?;
            let confirmed = self.backend.load(&mapped)?;
            if confirmed.public_fingerprint()? != key.public_fingerprint()? {
                return Err(CryptoError::CredentialConflict);
            }
            Ok(())
        })
    }
    fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError> {
        // Commit FIRST. Partial/unconfirmed deletion can never re-enable legacy.
        let mapped = local_scope(scope)?;
        self.ledger.barrier_then(&identity_route_id(scope)?, || {
            let newer = self.backend.delete(&mapped);
            let older = self.backend.delete(scope);
            newer.and(older)
        })
    }
}
pub(crate) fn desktop_store() -> Arc<dyn IdentityStore> {
    Arc::new(ProductionStore)
}
struct ProductionStore;
impl IdentityStore for ProductionStore {
    fn load(&self, s: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        VersionedStore {
            ledger: Ledger::production()?,
            backend: Arc::new(OsIdentityStore),
        }
        .load(s)
    }
    fn save_pending(&self, s: &KeyScope, k: &DevicePrivateKey) -> Result<(), CryptoError> {
        VersionedStore {
            ledger: Ledger::production()?,
            backend: Arc::new(OsIdentityStore),
        }
        .save_pending(s, k)
    }
    fn delete(&self, s: &KeyScope) -> Result<(), CryptoError> {
        VersionedStore {
            ledger: Ledger::production()?,
            backend: Arc::new(OsIdentityStore),
        }
        .delete(s)
    }
}
pub(crate) fn promote_key(
    scope: &KeyScope,
    key: &DevicePrivateKey,
    cancelled: &AtomicBool,
) -> Result<(), CryptoError> {
    promote(
        &Ledger::production()?,
        &OsIdentityStore,
        scope,
        key,
        cancelled,
    )
}
fn promote(
    ledger: &Ledger,
    backend: &dyn IdentityStore,
    scope: &KeyScope,
    key: &DevicePrivateKey,
    cancelled: &AtomicBool,
) -> Result<(), CryptoError> {
    let id = identity_route_id(scope)?;
    let mapped = local_scope(scope)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(unavailable());
    }
    ledger.persist_after(&id, |already_committed| {
        if cancelled.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        // A committed deletion barrier cannot recreate a key from a cached
        // legacy value. Existing current key must still confirm the fingerprint.
        if !already_committed {
            backend.save_pending(&mapped, key)?;
        }
        let confirmed = backend.load(&mapped)?;
        if confirmed.public_fingerprint()? != key.public_fingerprint()? {
            return Err(CryptoError::CredentialConflict);
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        Ok(())
    })
}
/// Pin the selected physical route under ORIGINAL protocol scope. The existing
/// crypto cache owns key cloning/zeroization; no DER API or second key cache.
type BackendFactory = Arc<dyn Fn() -> Arc<dyn IdentityStore> + Send + Sync>;
struct CachedState {
    route: Option<(KeyScope, KeyScope)>,
    backend: Arc<dyn IdentityStore>,
}
struct CachedStore {
    ledger: Ledger,
    factory: BackendFactory,
    state: Mutex<CachedState>,
}
impl CachedStore {
    fn new(ledger: Ledger, factory: BackendFactory) -> Self {
        let backend = factory();
        Self {
            ledger,
            factory,
            state: Mutex::new(CachedState {
                route: None,
                backend,
            }),
        }
    }
    fn reset(&self, state: &mut CachedState) {
        state.route = None;
        state.backend = (self.factory)();
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
impl IdentityStore for CachedStore {
    fn load(&self, s: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if state
            .route
            .as_ref()
            .is_some_and(|(old, _)| !same_scope(old, s))
        {
            self.reset(&mut state);
        }
        validate_scope(s)?;
        let physical = if let Some((_, physical)) = state.route.as_ref() {
            physical.clone()
        } else if self.ledger.route(&identity_route_id(s)?)? {
            local_scope(s)?
        } else {
            s.clone()
        };
        let result = state.backend.load(&physical);
        match result {
            Ok(key) => {
                state.route = Some((s.clone(), physical));
                Ok(key)
            }
            Err(error) => {
                self.reset(&mut state);
                Err(error)
            }
        }
    }
    fn save_pending(&self, s: &KeyScope, k: &DevicePrivateKey) -> Result<(), CryptoError> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        self.reset(&mut state);
        let result = VersionedStore {
            ledger: self.ledger.clone(),
            backend: state.backend.clone(),
        }
        .save_pending(s, k);
        self.reset(&mut state);
        result
    }
    fn delete(&self, s: &KeyScope) -> Result<(), CryptoError> {
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        self.reset(&mut state);
        let result = VersionedStore {
            ledger: self.ledger.clone(),
            backend: state.backend.clone(),
        }
        .delete(s);
        self.reset(&mut state);
        result
    }
}
struct UnavailableStore;
impl IdentityStore for UnavailableStore {
    fn load(&self, _: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        Err(unavailable())
    }
    fn save_pending(&self, _: &KeyScope, _: &DevicePrivateKey) -> Result<(), CryptoError> {
        Err(unavailable())
    }
    fn delete(&self, _: &KeyScope) -> Result<(), CryptoError> {
        Err(unavailable())
    }
}
pub(crate) fn connection_cache() -> Arc<dyn IdentityStore> {
    match Ledger::production() {
        Ok(ledger) => Arc::new(CachedStore::new(
            ledger,
            Arc::new(OsIdentityStore::connection_cache),
        )),
        Err(_) => Arc::new(UnavailableStore),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::crypto::EncryptedIdentityStore;
    use super::*;
    use std::sync::atomic::AtomicUsize;
    struct Backend {
        disk: EncryptedIdentityStore,
        cache: Mutex<Option<KeyScope>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        fail_write: AtomicBool,
        fail_delete: AtomicBool,
        cancel_on_write: Mutex<Option<Arc<AtomicBool>>>,
    }
    impl Backend {
        fn new(path: &Path) -> Self {
            fs::DirBuilder::new().mode(0o700).create(path).unwrap();
            let path = path.canonicalize().unwrap();
            Self {
                disk: EncryptedIdentityStore::for_test(&path, &[7; 32]).unwrap(),
                cache: Mutex::new(None),
                reads: AtomicUsize::new(0),
                writes: AtomicUsize::new(0),
                fail_write: AtomicBool::new(false),
                fail_delete: AtomicBool::new(false),
                cancel_on_write: Mutex::new(None),
            }
        }
    }
    impl IdentityStore for Backend {
        fn load(&self, s: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
            let mut cached = self.cache.lock().unwrap();
            if cached.as_ref().is_none_or(|old| !same_scope(old, s)) {
                self.reads.fetch_add(1, Ordering::Relaxed);
            }
            // This is a synthetic encrypted store, never OS credentials. The
            // cache counter models existing crypto cache's physical-scope API;
            // actual DER/key cache behavior remains in its own frozen tests.
            let key = self.disk.load(s)?;
            *cached = Some(s.clone());
            Ok(key)
        }
        fn save_pending(&self, s: &KeyScope, k: &DevicePrivateKey) -> Result<(), CryptoError> {
            *self.cache.lock().unwrap() = None;
            self.writes.fetch_add(1, Ordering::Relaxed);
            self.disk.save_pending(s, k)?;
            if let Some(flag) = self.cancel_on_write.lock().unwrap().as_ref() {
                flag.store(true, Ordering::Release);
            }
            if self.fail_write.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            Ok(())
        }
        fn delete(&self, s: &KeyScope) -> Result<(), CryptoError> {
            *self.cache.lock().unwrap() = None;
            if self.fail_delete.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            self.disk.delete(s)
        }
    }
    fn scope() -> KeyScope {
        KeyScope {
            issuer: "https://isolated.invalid".into(),
            environment: "development".into(),
            service_id: "00000000-0000-4000-8000-000000000001".into(),
            principal_id: "isolated".into(),
            device_id: "00000000-0000-4000-8000-000000000002".into(),
            key_generation: 1,
        }
    }
    fn fixture() -> (tempfile::TempDir, Ledger, Arc<Backend>) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("routes");
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let ledger = Ledger { root };
        let backend = Arc::new(Backend::new(&dir.path().join("keys")));
        (dir, ledger, backend)
    }
    #[test]
    fn structured_mapping_is_local_validates_original_and_isolates_all_fields() {
        let original = scope();
        let mapped = local_scope(&original).unwrap();
        assert_ne!(mapped.service_id, original.service_id);
        assert_eq!(
            uuid::Uuid::parse_str(&mapped.service_id)
                .unwrap()
                .get_version_num(),
            8
        );
        assert_eq!(mapped.issuer, original.issuer);
        assert_eq!(original.service_id, scope().service_id);
        let mut variants = Vec::new();
        let mut v = original.clone();
        v.issuer = "https://other.invalid".into();
        variants.push(v);
        let mut v = original.clone();
        v.environment = "production".into();
        variants.push(v);
        let mut v = original.clone();
        v.service_id = "00000000-0000-4000-8000-000000000003".into();
        variants.push(v);
        let mut v = original.clone();
        v.principal_id = "other".into();
        variants.push(v);
        let mut v = original.clone();
        v.device_id = "00000000-0000-4000-8000-000000000004".into();
        variants.push(v);
        let mut v = original.clone();
        v.key_generation = 2;
        variants.push(v);
        let mut ids = BTreeSet::new();
        ids.insert(identity_route_id(&original).unwrap());
        for v in variants {
            assert_ne!(local_scope(&v).unwrap().service_id, mapped.service_id);
            assert!(ids.insert(identity_route_id(&v).unwrap()));
        }
        let mut invalid = original;
        invalid.service_id = "invalid-service".into();
        assert!(matches!(
            local_scope(&invalid),
            Err(CryptoError::InvalidKey)
        ));
        let legacy = hash43(b"isolated session");
        assert!(canonical_hash(&session_hash(&legacy).unwrap()));
        assert_ne!(session_hash(&legacy).unwrap(), legacy);
        assert!(session_hash(&"x".repeat(43)).is_err());
    }
    #[test]
    fn promotion_confirmed_then_restart_uses_new_and_missing_never_falls_back() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&s, &key).unwrap();
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        assert_eq!(
            store.load(&s).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
        promote(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)).unwrap();
        let restarted = VersionedStore {
            ledger: Ledger {
                root: ledger.root.clone(),
            },
            backend: backend.clone(),
        };
        assert_eq!(
            restarted.load(&s).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
        backend.disk.delete(&local_scope(&s).unwrap()).unwrap();
        assert!(matches!(
            restarted.load(&s),
            Err(CryptoError::CredentialMissing)
        ));
        assert!(backend.disk.load(&s).is_ok());
        let writes = backend.writes.load(Ordering::Relaxed);
        assert!(matches!(
            promote(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)),
            Err(CryptoError::CredentialMissing)
        ));
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
        assert!(backend.disk.load(&local_scope(&s).unwrap()).is_err());
        assert!(ledger.route(&identity_route_id(&s).unwrap()).unwrap());
        // A different extant current key also cannot be overwritten by a stale
        // migration. Identical confirmation performs no OS write.
        let other = DevicePrivateKey::generate().unwrap();
        backend
            .disk
            .save_pending(&local_scope(&s).unwrap(), &other)
            .unwrap();
        assert!(matches!(
            promote(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)),
            Err(CryptoError::CredentialConflict)
        ));
        promote(
            &ledger,
            backend.as_ref(),
            &s,
            &other,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
    }
    #[test]
    fn cancelled_and_unconfirmed_writes_never_commit_or_adopt_new_slot() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        assert!(promote(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(true)).is_err());
        assert_eq!(backend.writes.load(Ordering::Relaxed), 0);
        backend.fail_write.store(true, Ordering::Release);
        assert!(promote(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)).is_err());
        assert!(!ledger.route(&identity_route_id(&s).unwrap()).unwrap());
        assert!(backend.disk.load(&local_scope(&s).unwrap()).is_ok());
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        assert!(matches!(
            store.load(&s),
            Err(CryptoError::CredentialMissing)
        ));
        backend.fail_write.store(false, Ordering::Release);
        let flag = Arc::new(AtomicBool::new(false));
        *backend.cancel_on_write.lock().unwrap() = Some(flag.clone());
        assert!(promote(&ledger, backend.as_ref(), &s, &key, &flag).is_err());
        assert!(!ledger.route(&identity_route_id(&s).unwrap()).unwrap());
    }
    #[test]
    fn delete_barrier_survives_offline_partial_failure_and_retry() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&s, &key).unwrap();
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        backend.fail_delete.store(true, Ordering::Release);
        assert!(store.delete(&s).is_err());
        assert!(ledger.route(&identity_route_id(&s).unwrap()).unwrap());
        assert!(backend.disk.load(&s).is_ok());
        assert!(matches!(
            store.load(&s),
            Err(CryptoError::CredentialMissing)
        ));
        backend.fail_delete.store(false, Ordering::Release);
        store.delete(&s).unwrap();
        assert!(ledger.route(&identity_route_id(&s).unwrap()).unwrap());
    }
    #[test]
    fn cached_original_scope_pins_route_and_mutations_invalidate() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&s, &key).unwrap();
        let captured = backend.clone();
        let cache = CachedStore::new(
            ledger.clone(),
            Arc::new(move || {
                *captured.cache.lock().unwrap() = None;
                captured.clone()
            }),
        );
        cache.load(&s).unwrap();
        ledger.commit(&identity_route_id(&s).unwrap()).unwrap();
        // Same actor keeps already selected legacy route, rather than alternating
        // physical scopes and causing repeated cold backend reads.
        cache.load(&s).unwrap();
        cache.load(&s).unwrap();
        assert_eq!(backend.reads.load(Ordering::Relaxed), 1);
        cache.save_pending(&s, &key).unwrap();
        cache.load(&s).unwrap();
        // Confirmation is one cold read; mutation retires its cache, then
        // the first subsequent load is one cold read and later loads are hot.
        assert_eq!(backend.reads.load(Ordering::Relaxed), 3);
        cache.load(&s).unwrap();
        assert_eq!(backend.reads.load(Ordering::Relaxed), 3);
        cache.delete(&s).unwrap();
        assert!(cache.load(&s).is_err());
    }
    #[test]
    fn ledger_closed_permissions_paths_duplicates_and_corruption_fail_before_store_write() {
        let (_dir, ledger, backend) = fixture();
        let id = format!("session:{}", hash43(b"session"));
        ledger.commit(&id).unwrap();
        let file = ledger.root.join(NAME);
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o7777, 0o600);
        for body in [
            format!(r#"{{"version":1,"routes":["{id}"],"secret":"unexpected"}}"#),
            format!(r#"{{"version":1,"routes":["{id}","{id}"]}}"#),
            r#"{"version":1,"routes":["bad"]}"#.into(),
            r#"{"version":1,"version":1,"routes":[]}"#.into(),
        ] {
            fs::write(&file, body).unwrap();
            assert!(ledger.route(&id).is_err());
            let store = VersionedStore {
                ledger: ledger.clone(),
                backend: backend.clone(),
            };
            assert!(store
                .save_pending(&scope(), &DevicePrivateKey::generate().unwrap())
                .is_err());
            assert_eq!(backend.writes.load(Ordering::Relaxed), 0);
        }
        fs::remove_file(&file).unwrap();
        let outside = ledger.root.join("outside");
        fs::write(&outside, b"{}").unwrap();
        std::os::unix::fs::symlink(&outside, &file).unwrap();
        assert!(ledger.route(&id).is_err());
        fs::remove_file(&file).unwrap();
        fs::hard_link(&outside, &file).unwrap();
        assert!(ledger.route(&id).is_err());
        fs::remove_file(&file).unwrap();
        ledger.commit(&id).unwrap();
        fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
        assert!(ledger.route(&id).is_err());
    }
    #[test]
    fn concurrent_distinct_commits_preserve_all_routes() {
        let (_dir, ledger, _backend) = fixture();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let ledger = ledger.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let id = format!("session:{}", hash43(format!("isolated-{i}").as_bytes()));
                    ledger.commit(&id).unwrap();
                    id
                })
            })
            .collect();
        for thread in threads {
            assert!(ledger.route(&thread.join().unwrap()).unwrap());
        }
    }
    #[test]
    fn existing_owned_755_parent_is_preserved_and_lock_symlink_or_unknown_token_rejected() {
        let (_dir, ledger, _) = fixture();
        fs::set_permissions(
            &ledger.root,
            std::os::unix::fs::PermissionsExt::from_mode(0o755),
        )
        .unwrap();
        let id = format!("session:{}", hash43(b"parent"));
        ledger.commit(&id).unwrap();
        assert_eq!(fs::metadata(&ledger.root).unwrap().mode() & 0o777, 0o755);
        let outside = ledger.root.join("outside-lock");
        fs::DirBuilder::new().mode(0o700).create(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, ledger.root.join(LOCK_PARENT).join(LOCK)).unwrap();
        assert!(ledger.route(&id).is_err());
        fs::remove_file(ledger.root.join(LOCK_PARENT).join(LOCK)).unwrap();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(ledger.root.join(LOCK_PARENT).join(LOCK))
            .unwrap();
        fs::write(
            ledger.root.join(LOCK_PARENT).join(LOCK).join("owner"),
            b"unexpected-private-field",
        )
        .unwrap();
        assert!(ledger.route(&id).is_err());
    }
    #[test]
    fn capacity_rejects_before_backend_write_and_namespace_change_never_commits() {
        let (_dir, ledger, backend) = fixture();
        let first = format!("session:{}", hash43(b"first"));
        ledger.commit(&first).unwrap();
        let routes: BTreeSet<_> = (0..MAX_ROUTES)
            .map(|i| format!("session:{}", hash43(format!("bound-{i}").as_bytes())))
            .collect();
        let bytes = serde_json::to_vec(&LedgerData {
            version: 1,
            routes: routes.iter().cloned().collect(),
        })
        .unwrap();
        fs::write(ledger.root.join(NAME), &bytes).unwrap();
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        assert!(store
            .save_pending(&scope(), &DevicePrivateKey::generate().unwrap())
            .is_err());
        assert_eq!(backend.writes.load(Ordering::Relaxed), 0);
        assert_eq!(fs::read(ledger.root.join(NAME)).unwrap(), bytes);
        fs::remove_file(ledger.root.join(NAME)).unwrap();
        let old = ledger.root.with_file_name("retired-routes");
        assert!(ledger
            .persist_after(&first, |_| {
                fs::rename(&ledger.root, &old).unwrap();
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&ledger.root)
                    .unwrap();
                Ok(())
            })
            .is_err());
        assert!(!ledger.root.join(NAME).exists());
        assert!(!old.join(NAME).exists());
    }
    #[test]
    #[ignore = "private subprocess entry; parent test supplies only its isolated TempDir"]
    fn process_commit_helper() {
        let root = PathBuf::from(std::env::var_os("MOXBOTS_SLOT_TEST_ROOT").unwrap());
        let id = std::env::var("MOXBOTS_SLOT_TEST_ROUTE").unwrap();
        assert!(root
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("mah-credential-slots-process-"));
        Ledger { root }.commit(&id).unwrap();
    }
    #[test]
    fn real_process_commits_serialize_without_losing_routes() {
        let dir = tempfile::Builder::new()
            .prefix("mah-credential-slots-process-")
            .tempdir()
            .unwrap();
        let root = dir.path().canonicalize().unwrap().join("routes");
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        struct ChildSet(Vec<std::process::Child>);
        impl Drop for ChildSet {
            fn drop(&mut self) {
                for child in &mut self.0 {
                    if child.try_wait().ok().flatten().is_none() {
                        let _ = child.kill();
                    }
                }
                let end = std::time::Instant::now() + std::time::Duration::from_secs(1);
                while std::time::Instant::now() < end {
                    if self
                        .0
                        .iter_mut()
                        .all(|c| c.try_wait().ok().flatten().is_some())
                    {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
        let mut children = ChildSet(Vec::new());
        let mut ids = Vec::new();
        for i in 0..4 {
            let id = format!("session:{}", hash43(format!("process-{i}").as_bytes()));
            let child = crate::process_cmd::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "agent_network::credential_slots::tests::process_commit_helper",
                    "--ignored",
                ])
                .env("MOXBOTS_SLOT_TEST_ROOT", &root)
                .env("MOXBOTS_SLOT_TEST_ROUTE", &id)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            children.0.push(child);
            ids.push(id);
        }
        let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
        for index in 0..children.0.len() {
            loop {
                if let Some(status) = children.0[index].try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                if std::time::Instant::now() >= end {
                    panic!("isolated route helper deadline");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let ledger = Ledger { root };
        for id in ids {
            assert!(ledger.route(&id).unwrap());
        }
    }
    #[test]
    fn committed_session_route_preflights_preserves_typed_error_and_serializes_action() {
        #[derive(Debug, PartialEq)]
        enum Error {
            Storage,
            Cancelled,
        }
        impl From<CryptoError> for Error {
            fn from(_: CryptoError) -> Self {
                Self::Storage
            }
        }
        let (_dir, ledger, _) = fixture();
        let id = format!("session:{}", hash43(b"session transaction"));
        let called = AtomicBool::new(false);
        assert_eq!(
            committed_route(&ledger, &id, |already_committed| {
                assert!(!already_committed);
                called.store(true, Ordering::Release);
                Err(Error::Cancelled)
            }),
            Err(Error::Cancelled)
        );
        assert!(called.load(Ordering::Acquire));
        assert!(!ledger.route(&id).unwrap());
        ledger
            .commit(&format!("session:{}", hash43(b"initial")))
            .unwrap();
        fs::write(ledger.root.join(NAME), b"{broken}").unwrap();
        called.store(false, Ordering::Release);
        assert_eq!(
            committed_route(&ledger, &id, |already_committed| {
                assert!(!already_committed);
                called.store(true, Ordering::Release);
                Ok::<_, Error>(())
            }),
            Err(Error::Storage)
        );
        assert!(!called.load(Ordering::Acquire));
        fs::remove_file(ledger.root.join(NAME)).unwrap();
        committed_route(&ledger, &id, |already_committed| {
            assert!(!already_committed);
            // The real owner token exists while the caller action executes.
            assert!(ledger
                .root
                .join(LOCK_PARENT)
                .join(LOCK)
                .join("owner")
                .is_file());
            Ok::<_, Error>(())
        })
        .unwrap();
        assert!(ledger.route(&id).unwrap());
        let bytes = fs::read(ledger.root.join(NAME)).unwrap();
        assert_eq!(
            committed_route(&ledger, &id, |already_committed| {
                assert!(already_committed);
                Err(Error::Cancelled)
            }),
            Err(Error::Cancelled)
        );
        assert_eq!(fs::read(ledger.root.join(NAME)).unwrap(), bytes);
        committed_route(&ledger, &id, |already_committed| {
            assert!(already_committed);
            Ok::<_, Error>(())
        })
        .unwrap();
        assert_eq!(fs::read(ledger.root.join(NAME)).unwrap(), bytes);
    }
    #[test]
    fn typed_delete_reselects_new_binding_and_preserves_error_barrier_order() {
        #[derive(Debug, PartialEq)]
        enum Error {
            Storage,
            Predicate,
            Delete,
        }
        impl From<CryptoError> for Error {
            fn from(_: CryptoError) -> Self {
                Self::Storage
            }
        }
        let (_dir, ledger, _) = fixture();
        let id = format!("session:{}", hash43(b"delete binding"));
        let legacy = ledger.root.join("legacy.synthetic");
        let current = ledger.root.join("new.synthetic");
        fs::write(&legacy, b"old-binding").unwrap();
        // A second owner commits a new physical binding BEFORE the old remover
        // enters the transaction. The selector must see new=true and reread it.
        let other = ledger.clone();
        let other_id = id.clone();
        let new_path = current.clone();
        std::thread::spawn(move || {
            committed_route(&other, &other_id, |already_committed| {
                assert!(!already_committed);
                fs::write(new_path, b"new-binding").map_err(|_| Error::Storage)
            })
            .unwrap()
        })
        .join()
        .unwrap();
        let deleted = AtomicBool::new(false);
        let result = deleted_route(
            &ledger,
            &id,
            |is_new| {
                assert!(is_new);
                let path = if is_new {
                    current.clone()
                } else {
                    legacy.clone()
                };
                let binding = fs::read(&path).map_err(|_| Error::Storage)?;
                Ok(if binding == b"old-binding" {
                    Some(path)
                } else {
                    None
                })
            },
            |path| {
                deleted.store(true, Ordering::Release);
                fs::remove_file(path).map_err(|_| Error::Delete)
            },
        )
        .unwrap();
        assert!(!result);
        assert!(!deleted.load(Ordering::Acquire));
        assert_eq!(fs::read(&current).unwrap(), b"new-binding");
        let absent = format!("session:{}", hash43(b"uncommitted delete"));
        assert_eq!(
            deleted_route(
                &ledger,
                &absent,
                |_| Err::<Option<()>, _>(Error::Predicate),
                |_| Ok::<_, Error>(())
            ),
            Err(Error::Predicate)
        );
        assert!(!ledger.route(&absent).unwrap());
        assert!(!deleted_route(
            &ledger,
            &absent,
            |_| Ok::<_, Error>(None::<()>),
            |_| Ok::<_, Error>(())
        )
        .unwrap());
        assert!(!ledger.route(&absent).unwrap());
        let snapshot = Mutex::new(None);
        assert_eq!(
            deleted_route(
                &ledger,
                &absent,
                |new| {
                    assert!(!new);
                    *snapshot.lock().unwrap() = Some(new);
                    Ok(Some(()))
                },
                |_| {
                    // Direct read-only inspection avoids recursive API/lock entry. This
                    // proves the barrier file exists BEFORE the unknown delete result.
                    let data: LedgerData =
                        serde_json::from_slice(&fs::read(ledger.root.join(NAME)).unwrap()).unwrap();
                    assert!(data.routes.contains(&absent));
                    Err::<(), _>(Error::Delete)
                }
            ),
            Err(Error::Delete)
        );
        assert!(ledger.route(&absent).unwrap());
        assert_eq!(*snapshot.lock().unwrap(), Some(false));
        assert!(deleted_route(
            &ledger,
            &absent,
            |new| {
                assert!(new);
                Ok::<_, Error>(Some(()))
            },
            |_| Ok::<_, Error>(())
        )
        .unwrap());
    }
}
