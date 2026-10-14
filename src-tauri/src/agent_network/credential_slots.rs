//! Desktop-only credential entry routing. Protocol scopes NEVER leave this module mapped.
//! Callers run blocking operations under their existing binding/cancellation lifecycle gate.
#![cfg_attr(test, allow(dead_code))]
use super::crypto::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope, OsIdentityStore};
#[cfg(unix)]
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::collections::BTreeMap;
#[cfg(all(test, unix))]
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
/// New publisher-lineage physical identity slot. Keep `local_scope` byte-for-byte
/// compatible with the v1 route; only the OS item namespace changes here.
pub(crate) fn developer_id_scope(scope: &KeyScope) -> Result<KeyScope, CryptoError> {
    let material = serde_json::to_vec(&(
        "moxbots.fixed-reader.credential-slots.developer-id-v2",
        ".moxbot",
        "identity",
        scope,
    ))
    .map_err(|_| CryptoError::InvalidKey)?;
    validate_scope(scope)?;
    let bytes = Sha256::digest(material);
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
pub(crate) fn developer_id_session_hash(legacy43: &str) -> Result<String, CryptoError> {
    if !canonical_hash(legacy43) {
        return Err(CryptoError::InvalidKey);
    }
    Ok(hash43(
        &serde_json::to_vec(&(
            "moxbots.fixed-reader.credential-slots.developer-id-v2",
            ".moxbot",
            "account",
            legacy43,
        ))
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
#[cfg(unix)]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LedgerDataV2 {
    version: u32,
    routes: Vec<LedgerRoute>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RouteFamily {
    LocalV1,
    DeveloperIdV2,
    Deleted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RouteSelection {
    Legacy,
    LocalV1,
    DeveloperIdV2,
    Deleted,
}
fn parse_writer_family(value: &str) -> Result<RouteFamily, CryptoError> {
    match value {
        "local-v1" => Ok(RouteFamily::LocalV1),
        "developer-id-v2" => Ok(RouteFamily::DeveloperIdV2),
        _ => Err(unavailable()),
    }
}
fn selected_writer_family() -> Result<RouteFamily, CryptoError> {
    match option_env!("MOXBOTS_CREDENTIAL_WRITER_FAMILY") {
        Some(value) => parse_writer_family(value),
        #[cfg(myagents_moxbot)]
        None => Err(unavailable()),
        #[cfg(all(test, not(myagents_moxbot)))]
        None => Ok(RouteFamily::DeveloperIdV2),
        #[cfg(all(not(test), not(myagents_moxbot)))]
        None => Ok(RouteFamily::LocalV1),
    }
}
pub(crate) fn selected_writer_selection() -> Result<RouteSelection, CryptoError> {
    selected_writer_family().map(selection_from_family)
}
pub(crate) fn identity_scope_for_selection(
    selection: RouteSelection,
    scope: &KeyScope,
) -> Result<KeyScope, CryptoError> {
    match selection {
        RouteSelection::Legacy => Ok(scope.clone()),
        RouteSelection::LocalV1 => local_scope(scope),
        RouteSelection::DeveloperIdV2 => developer_id_scope(scope),
        RouteSelection::Deleted => Err(CryptoError::CredentialMissing),
    }
}
#[cfg(unix)]
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LedgerRoute {
    id: String,
    family: RouteFamily,
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
    fn read(&self, dir: &File) -> Result<BTreeMap<String, RouteFamily>, CryptoError> {
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
                Ok(BTreeMap::new())
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
        let header: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        let version = header
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(unavailable)?;
        let routes = match version {
            1 => {
                let data: LedgerData = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
                if data.version != 1
                    || data.routes.len() > MAX_ROUTES
                    || data.routes.iter().any(|r| !valid_route(r))
                {
                    return Err(unavailable());
                }
                let mut routes = BTreeMap::new();
                for id in &data.routes {
                    if routes.insert(id.clone(), RouteFamily::LocalV1).is_some() {
                        return Err(unavailable());
                    }
                }
                if data.routes.iter().ne(routes.keys()) {
                    return Err(unavailable());
                }
                routes
            }
            2 => {
                let data: LedgerDataV2 =
                    serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
                if data.version != 2
                    || data.routes.len() > MAX_ROUTES
                    || data.routes.iter().any(|r| !valid_route(&r.id))
                {
                    return Err(unavailable());
                }
                let mut routes = BTreeMap::new();
                for route in &data.routes {
                    if routes.insert(route.id.clone(), route.family).is_some() {
                        return Err(unavailable());
                    }
                }
                if data.routes.iter().map(|route| &route.id).ne(routes.keys()) {
                    return Err(unavailable());
                }
                routes
            }
            _ => return Err(unavailable()),
        };
        // Decode only the exact closed v1/v2 shapes above; serialization is
        // canonical and the route arrays must already be sorted and unique.
        let encoded = serde_json::to_vec(&LedgerDataV2 {
            version: 2,
            routes: routes
                .iter()
                .map(|(id, family)| LedgerRoute {
                    id: id.clone(),
                    family: *family,
                })
                .collect(),
        })
        .map_err(|_| unavailable())?;
        if encoded.len() > MAX_BYTES {
            return Err(unavailable());
        }
        Ok(routes)
    }
    fn write(&self, dir: &File, routes: BTreeMap<String, RouteFamily>) -> Result<(), CryptoError> {
        let bytes = encode_routes(&routes)?;
        if routes.len() > MAX_ROUTES || bytes.len() > MAX_BYTES {
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
    fn ensure_route_capacity(
        &self,
        routes: &BTreeMap<String, RouteFamily>,
        id: &str,
        target: RouteFamily,
    ) -> Result<(), CryptoError> {
        if routes.get(id) == Some(&target) {
            return Ok(());
        }
        let mut candidate = routes.clone();
        candidate.insert(id.to_owned(), target);
        if candidate.len() > MAX_ROUTES || encode_routes(&candidate)?.len() > MAX_BYTES {
            return Err(unavailable());
        }
        Ok(())
    }
    fn persist_after_family(
        &self,
        id: &str,
        target: RouteFamily,
        action: impl FnOnce(RouteSelection) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            let mut routes = self.read(dir)?;
            self.ensure_route_capacity(&routes, id, target)?;
            let current = routes
                .get(id)
                .copied()
                .map(selection_from_family)
                .unwrap_or(RouteSelection::Legacy);
            action(current)?;
            if routes.get(id).copied() != Some(target) {
                routes.insert(id.into(), target);
                self.write(dir, routes)?;
            }
            Ok(())
        })
    }
    fn persist_after(
        &self,
        id: &str,
        action: impl FnOnce(bool) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        self.persist_after_family(id, selected_writer_family()?, |selection| {
            action(selection != RouteSelection::Legacy)
        })
    }
    fn barrier_then(
        &self,
        id: &str,
        action: impl FnOnce(RouteSelection) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            let mut routes = self.read(dir)?;
            let current = routes
                .get(id)
                .copied()
                .map(selection_from_family)
                .unwrap_or(RouteSelection::Legacy);
            self.ensure_route_capacity(&routes, id, RouteFamily::Deleted)?;
            if routes.get(id) != Some(&RouteFamily::Deleted) {
                routes.insert(id.into(), RouteFamily::Deleted);
                self.write(dir, routes)?;
            }
            action(current)
        })
    }
    fn route(&self, id: &str) -> Result<bool, CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| Ok(self.read(dir)?.contains_key(id)))
    }
    fn set_selection(&self, id: &str, family: RouteFamily) -> Result<(), CryptoError> {
        self.persist_after_family(id, family, |_| Ok(()))
    }
    fn commit(&self, id: &str) -> Result<(), CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            let mut routes = self.read(dir)?;
            if routes.contains_key(id) {
                return Ok(());
            }
            self.ensure_route_capacity(&routes, id, selected_writer_family()?)?;
            routes.insert(id.into(), selected_writer_family()?);
            self.write(dir, routes)
        })
    }
    fn selection(&self, id: &str) -> Result<RouteSelection, CryptoError> {
        if !valid_route(id) {
            return Err(CryptoError::InvalidKey);
        }
        self.transaction(|dir| {
            Ok(self
                .read(dir)?
                .get(id)
                .copied()
                .map(selection_from_family)
                .unwrap_or(RouteSelection::Legacy))
        })
    }
}
#[cfg(unix)]
fn encode_routes(routes: &BTreeMap<String, RouteFamily>) -> Result<Vec<u8>, CryptoError> {
    serde_json::to_vec(&LedgerDataV2 {
        version: 2,
        routes: routes
            .iter()
            .map(|(id, family)| LedgerRoute {
                id: id.clone(),
                family: *family,
            })
            .collect(),
    })
    .map_err(|_| unavailable())
}
fn selection_from_family(family: RouteFamily) -> RouteSelection {
    match family {
        RouteFamily::LocalV1 => RouteSelection::LocalV1,
        RouteFamily::DeveloperIdV2 => RouteSelection::DeveloperIdV2,
        RouteFamily::Deleted => RouteSelection::Deleted,
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
    fn selection(&self, _: &str) -> Result<RouteSelection, CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
    fn set_selection(&self, _: &str, _: RouteFamily) -> Result<(), CryptoError> {
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
    fn persist_after_family(
        &self,
        _: &str,
        _: RouteFamily,
        _: impl FnOnce(RouteSelection) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
    fn barrier_then(
        &self,
        _: &str,
        _: impl FnOnce(RouteSelection) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        Err(CryptoError::UnsupportedPlatform)
    }
}
pub(crate) fn route(id: &str) -> Result<bool, CryptoError> {
    Ledger::production()?.route(id)
}
pub(crate) fn selection(id: &str) -> Result<RouteSelection, CryptoError> {
    Ledger::production()?.selection(id)
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
    action: impl FnOnce(RouteSelection) -> Result<(), E>,
) -> Result<(), E> {
    let target = selected_writer_family().map_err(E::from)?;
    committed_route_selection(&Ledger::production().map_err(E::from)?, id, target, action)
}
fn committed_route_selection<E: From<CryptoError>>(
    ledger: &Ledger,
    id: &str,
    target: RouteFamily,
    action: impl FnOnce(RouteSelection) -> Result<(), E>,
) -> Result<(), E> {
    let mut original = None;
    let result = ledger.persist_after_family(id, target, |selection| match action(selection) {
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
#[cfg(all(test, unix))]
fn committed_route<E: From<CryptoError>>(
    ledger: &Ledger,
    id: &str,
    action: impl FnOnce(bool) -> Result<(), E>,
) -> Result<(), E> {
    committed_route_selection(ledger, id, selected_writer_family()?, |selection| {
        action(selection != RouteSelection::Legacy)
    })
}

/// Caller constructs/reads the physical slot directly from the supplied route.
/// None/predicate error cannot commit; Some is fenced durably before deletion.
/// Neither callback may recursively acquire the route lock or await.
pub(crate) fn with_deleted_route<E: From<CryptoError>, T>(
    id: &str,
    select: impl FnOnce(bool) -> Result<Option<T>, E>,
    delete: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    with_deleted_route_family(
        id,
        |selected| select(selected != RouteSelection::Legacy),
        delete,
    )
}
pub(crate) fn with_deleted_route_family<E: From<CryptoError>, T>(
    id: &str,
    select: impl FnOnce(RouteSelection) -> Result<Option<T>, E>,
    delete: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    deleted_route_selection(&Ledger::production().map_err(E::from)?, id, select, delete)
}
#[cfg(unix)]
fn deleted_route_selection<E: From<CryptoError>, T>(
    ledger: &Ledger,
    id: &str,
    select: impl FnOnce(RouteSelection) -> Result<Option<T>, E>,
    delete: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    if !valid_route(id) {
        return Err(E::from(CryptoError::InvalidKey));
    }
    let mut original = None;
    let result = ledger.transaction(|dir| {
        let mut routes = ledger.read(dir)?;
        ledger.ensure_route_capacity(&routes, id, RouteFamily::Deleted)?;
        let current = routes
            .get(id)
            .copied()
            .map(selection_from_family)
            .unwrap_or(RouteSelection::Legacy);
        let selected = match select(current) {
            Ok(value) => value,
            Err(error) => {
                original = Some(error);
                return Err(unavailable());
            }
        };
        let Some(value) = selected else {
            return Ok(false);
        };
        if routes.get(id) != Some(&RouteFamily::Deleted) {
            routes.insert(id.into(), RouteFamily::Deleted);
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
#[cfg(all(test, unix))]
fn deleted_route<E: From<CryptoError>, T>(
    ledger: &Ledger,
    id: &str,
    select: impl FnOnce(bool) -> Result<Option<T>, E>,
    delete: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    deleted_route_selection(
        ledger,
        id,
        |selection| select(selection != RouteSelection::Legacy),
        delete,
    )
}

#[cfg(not(unix))]
fn deleted_route_selection<E: From<CryptoError>, T>(
    _: &Ledger,
    _: &str,
    _: impl FnOnce(RouteSelection) -> Result<Option<T>, E>,
    _: impl FnOnce(T) -> Result<(), E>,
) -> Result<bool, E> {
    Err(E::from(CryptoError::UnsupportedPlatform))
}

struct VersionedStore {
    ledger: Ledger,
    backend: Arc<dyn IdentityStore>,
}
impl VersionedStore {
    fn save_pending_for_family(
        &self,
        scope: &KeyScope,
        key: &DevicePrivateKey,
        target: RouteFamily,
    ) -> Result<(), CryptoError> {
        let id = identity_route_id(scope)?;
        let mapped = identity_scope_for_selection(selection_from_family(target), scope)?;
        self.ledger.persist_after_family(&id, target, |selection| {
            match selection {
                RouteSelection::Legacy => {}
                RouteSelection::Deleted => return Err(CryptoError::CredentialMissing),
                current if current == selection_from_family(target) => {
                    let existing = self.backend.load(&mapped)?;
                    return if existing.public_fingerprint()? == key.public_fingerprint()? {
                        Ok(())
                    } else {
                        Err(CryptoError::CredentialConflict)
                    };
                }
                _ => return Err(CryptoError::CredentialConflict),
            }
            self.backend.save_pending(&mapped, key)?;
            let confirmed = self.backend.load(&mapped)?;
            if confirmed.public_fingerprint()? != key.public_fingerprint()? {
                return Err(CryptoError::CredentialConflict);
            }
            Ok(())
        })
    }
}
impl IdentityStore for VersionedStore {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let id = identity_route_id(scope)?;
        let physical = match self.ledger.selection(&id)? {
            RouteSelection::Legacy => scope.clone(),
            RouteSelection::LocalV1 => local_scope(scope)?,
            RouteSelection::DeveloperIdV2 => developer_id_scope(scope)?,
            RouteSelection::Deleted => return Err(CryptoError::CredentialMissing),
        };
        self.backend.load(&physical)
    }
    fn save_pending(&self, scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        self.save_pending_for_family(scope, key, selected_writer_family()?)
    }
    fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError> {
        // Commit FIRST. Partial/unconfirmed deletion can never re-enable legacy.
        let id = identity_route_id(scope)?;
        self.ledger.barrier_then(&id, |selected| {
            let physical = match selected {
                RouteSelection::Legacy => scope.clone(),
                RouteSelection::LocalV1 => local_scope(scope)?,
                RouteSelection::DeveloperIdV2 => developer_id_scope(scope)?,
                RouteSelection::Deleted => return Ok(()),
            };
            self.backend.delete(&physical)
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
/// Complete an explicitly authorized source read without reading that source a
/// second time in the background. The caller has already obtained `key` from
/// `authorize_existing` and verified its pinned fingerprint. Route selection is
/// rechecked while holding the ledger transaction lock before any destination
/// write; the caller fence is checked before writing and before route commit.
#[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
pub(crate) fn promote_authorized_key<E: From<CryptoError>>(
    scope: &KeyScope,
    expected_fingerprint: &str,
    cancelled: &AtomicBool,
    before_commit: impl Fn() -> Result<(), E>,
) -> Result<(KeyScope, Arc<dyn IdentityStore>, RouteSelection), E> {
    let ledger = Ledger::production().map_err(E::from)?;
    let backend = OsIdentityStore;
    promote_authorized_with(
        &ledger,
        &backend,
        scope,
        expected_fingerprint,
        selected_writer_family().map_err(E::from)?,
        cancelled,
        |source_scope| {
            let reader = OsIdentityStore::authorize_existing(source_scope, cancelled)?;
            let key = reader.load(source_scope)?;
            Ok((key, reader))
        },
        before_commit,
    )
}

fn promote_authorized_with<E: From<CryptoError>>(
    ledger: &Ledger,
    backend: &dyn IdentityStore,
    scope: &KeyScope,
    expected_fingerprint: &str,
    target: RouteFamily,
    cancelled: &AtomicBool,
    authorize_source: impl FnOnce(&KeyScope) -> Result<(DevicePrivateKey, Arc<dyn IdentityStore>), E>,
    before_commit: impl Fn() -> Result<(), E>,
) -> Result<(KeyScope, Arc<dyn IdentityStore>, RouteSelection), E> {
    let id = identity_route_id(scope).map_err(E::from)?;
    let target_selection = selection_from_family(target);
    let target_scope = identity_scope_for_selection(target_selection, scope).map_err(E::from)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(unavailable().into());
    }
    let mut authorize_source = Some(authorize_source);
    let mut authorized_store = None;
    let mut original = None;
    let result = ledger.persist_after_family(&id, target, |selection| {
        let mut action = || -> Result<(), E> {
            if cancelled.load(Ordering::Acquire) {
                return Err(unavailable().into());
            }
            let source_scope = match selection {
                RouteSelection::Legacy | RouteSelection::LocalV1 | RouteSelection::DeveloperIdV2 => {
                    identity_scope_for_selection(selection, scope).map_err(E::from)?
                }
                RouteSelection::Deleted => return Err(CryptoError::CredentialMissing.into()),
            };
            #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
            crate::ulog_info!("[credential-migration] stage=identity-source-read outcome=start");
            before_commit()?;
            let source_result = authorize_source
                .take()
                .expect("single route transaction")(&source_scope);
            #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
            crate::ulog_info!(
                "[credential-migration] stage=identity-source-read outcome={}",
                if source_result.is_ok() { "ok" } else { "failed" }
            );
            let (key, reader) = source_result?;
            if cancelled.load(Ordering::Acquire) {
                return Err(unavailable().into());
            }
            if key.public_fingerprint().map_err(E::from)? != expected_fingerprint {
                return Err(CryptoError::CredentialConflict.into());
            }
            #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
            crate::ulog_info!("[credential-migration] stage=identity-source-read outcome=validated");
            if selection != target_selection {
                #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                crate::ulog_info!("[credential-migration] stage=identity-destination-read outcome=start");
                let target_read = backend.load(&target_scope);
                match target_read {
                    Ok(existing) if existing.public_fingerprint().map_err(E::from)? == expected_fingerprint => {
                        #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                        crate::ulog_info!("[credential-migration] stage=identity-destination-read outcome=match");
                    }
                    Ok(_) => return Err(CryptoError::CredentialConflict.into()),
                    Err(CryptoError::CredentialMissing) => {
                        #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                        crate::ulog_info!("[credential-migration] stage=identity-destination-read outcome=missing");
                        if cancelled.load(Ordering::Acquire) {
                            return Err(unavailable().into());
                        }
                        #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                        crate::ulog_info!("[credential-migration] stage=identity-destination-write outcome=start");
                        let write = backend.save_pending(&target_scope, &key);
                        #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                        crate::ulog_info!(
                            "[credential-migration] stage=identity-destination-write outcome={}",
                            if write.is_ok() { "ok" } else { "failed" }
                        );
                        write.map_err(E::from)?;
                    }
                    Err(error) => {
                        #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                        crate::ulog_info!("[credential-migration] stage=identity-destination-read outcome=failed");
                        return Err(E::from(error));
                    }
                }
                if cancelled.load(Ordering::Acquire) {
                    return Err(unavailable().into());
                }
                #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                crate::ulog_info!("[credential-migration] stage=identity-confirm outcome=start");
                let confirmed = backend.load(&target_scope);
                #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                crate::ulog_info!(
                    "[credential-migration] stage=identity-confirm outcome={}",
                    if confirmed.is_ok() { "read" } else { "failed" }
                );
                let confirmed = confirmed.map_err(E::from)?;
                if confirmed.public_fingerprint().map_err(E::from)? != expected_fingerprint {
                    return Err(CryptoError::CredentialConflict.into());
                }
                #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
                crate::ulog_info!("[credential-migration] stage=identity-confirm outcome=ok");
            }
            if cancelled.load(Ordering::Acquire) {
                return Err(unavailable().into());
            }
            before_commit()?;
            authorized_store = Some((source_scope, reader, target_selection));
            Ok(())
        };
        match action() {
            Ok(()) => Ok(()),
            Err(error) => {
                original = Some(error);
                Err(unavailable())
            }
        }
    });
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
    crate::ulog_info!(
        "[credential-migration] stage=identity-route-commit outcome={}",
        if original.is_none() && result.is_ok() {
            "ok"
        } else {
            "failed"
        }
    );
    match original {
        Some(error) => Err(error),
        None => {
            result.map_err(E::from)?;
            authorized_store.ok_or_else(|| E::from(unavailable()))
        }
    }
}
fn promote(
    ledger: &Ledger,
    backend: &dyn IdentityStore,
    scope: &KeyScope,
    key: &DevicePrivateKey,
    cancelled: &AtomicBool,
) -> Result<(), CryptoError> {
    promote_to_family(
        ledger,
        backend,
        scope,
        key,
        cancelled,
        selected_writer_family()?,
    )
}
fn promote_to_family(
    ledger: &Ledger,
    backend: &dyn IdentityStore,
    scope: &KeyScope,
    key: &DevicePrivateKey,
    cancelled: &AtomicBool,
    target: RouteFamily,
) -> Result<(), CryptoError> {
    let id = identity_route_id(scope)?;
    let target_selection = selection_from_family(target);
    let mapped = identity_scope_for_selection(target_selection, scope)?;
    if cancelled.load(Ordering::Acquire) {
        return Err(unavailable());
    }
    let result = ledger.persist_after_family(&id, target, |selection| {
        if cancelled.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let source = match selection {
            RouteSelection::Legacy => scope.clone(),
            RouteSelection::LocalV1 => local_scope(scope)?,
            RouteSelection::DeveloperIdV2 => developer_id_scope(scope)?,
            RouteSelection::Deleted => return Err(CryptoError::CredentialMissing),
        };
        let verified_source = backend.load(&source)?;
        let expected_fingerprint = key.public_fingerprint()?;
        if verified_source.public_fingerprint()? != expected_fingerprint {
            return Err(CryptoError::CredentialConflict);
        }
        if selection != target_selection {
            match backend.load(&mapped) {
                Ok(existing) if existing.public_fingerprint()? == expected_fingerprint => {}
                Ok(_) => return Err(CryptoError::CredentialConflict),
                Err(CryptoError::CredentialMissing) => {
                    backend.save_pending(&mapped, &verified_source)?;
                }
                Err(error) => return Err(error),
            }
        }
        let loaded = backend.load(&mapped);
        #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
        crate::ulog_info!(
            "[credential-migration] stage=identity-confirm outcome={}",
            if loaded.is_ok() { "read" } else { "failed" }
        );
        let confirmed = loaded?;
        if confirmed.public_fingerprint()? != expected_fingerprint {
            return Err(CryptoError::CredentialConflict);
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        Ok(())
    });
    #[cfg(all(target_os = "macos", myagents_moxbot, not(test)))]
    crate::ulog_info!(
        "[credential-migration] stage=identity-route outcome={} cancelled={}",
        if result.is_ok() { "ok" } else { "failed" },
        cancelled.load(Ordering::Acquire)
    );
    result
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
        let selection = self.ledger.selection(&identity_route_id(s)?)?;
        let physical = match selection {
            RouteSelection::Legacy => s.clone(),
            RouteSelection::LocalV1 => local_scope(s)?,
            RouteSelection::DeveloperIdV2 => developer_id_scope(s)?,
            RouteSelection::Deleted => {
                self.reset(&mut state);
                return Err(CryptoError::CredentialMissing);
            }
        };
        if state
            .route
            .as_ref()
            .is_some_and(|(_, old_physical)| !same_scope(old_physical, &physical))
        {
            self.reset(&mut state);
        }
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
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicUsize;
    struct Backend {
        disk: EncryptedIdentityStore,
        cache: Mutex<Option<KeyScope>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        fail_write: AtomicBool,
        fail_delete: AtomicBool,
        cancel_on_write: Mutex<Option<Arc<AtomicBool>>>,
        deny_load_scope: Mutex<Option<KeyScope>>,
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
                deny_load_scope: Mutex::new(None),
            }
        }
    }
    impl IdentityStore for Backend {
        fn load(&self, s: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
            if self
                .deny_load_scope
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|denied| same_scope(denied, s))
            {
                return Err(CryptoError::CredentialUnavailable);
            }
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
    fn write_ledger_fixture(ledger: &Ledger, bytes: &[u8]) {
        let path = ledger.root.join(NAME);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn promote_dev(
        ledger: &Ledger,
        backend: &dyn IdentityStore,
        scope: &KeyScope,
        key: &DevicePrivateKey,
        cancelled: &AtomicBool,
    ) -> Result<(), CryptoError> {
        promote_to_family(
            ledger,
            backend,
            scope,
            key,
            cancelled,
            RouteFamily::DeveloperIdV2,
        )
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
        assert_ne!(
            session_hash(&legacy).unwrap(),
            developer_id_session_hash(&legacy).unwrap()
        );
        assert_ne!(
            local_scope(&scope()).unwrap().service_id,
            developer_id_scope(&scope()).unwrap().service_id
        );
        assert!(session_hash(&"x".repeat(43)).is_err());
    }
    #[test]
    fn writer_family_parser_is_closed_and_preserves_local_v1_mapping() {
        assert_eq!(
            parse_writer_family("local-v1").unwrap(),
            RouteFamily::LocalV1
        );
        assert_eq!(
            parse_writer_family("developer-id-v2").unwrap(),
            RouteFamily::DeveloperIdV2
        );
        for invalid in ["", "legacy", "Local-v1", "developer-id-v3", "__proto__"] {
            assert!(parse_writer_family(invalid).is_err());
        }
        let logical = scope();
        let selected = identity_scope_for_selection(RouteSelection::LocalV1, &logical).unwrap();
        assert_eq!(
            selected.service_id,
            local_scope(&logical).unwrap().service_id
        );
        assert_eq!(selected.issuer, logical.issuer);
    }

    #[test]
    fn strict_v1_route_selects_local_family_and_keeps_logical_id_stable() {
        let (_dir, ledger, _) = fixture();
        let scope = scope();
        let id = identity_route_id(&scope).unwrap();
        let bytes = serde_json::to_vec(&LedgerData {
            version: 1,
            routes: vec![id.clone()],
        })
        .unwrap();
        write_ledger_fixture(&ledger, &bytes);
        assert_eq!(ledger.selection(&id).unwrap(), RouteSelection::LocalV1);
        ledger
            .set_selection(&id, RouteFamily::DeveloperIdV2)
            .unwrap();
        assert_eq!(identity_route_id(&scope).unwrap(), id);
        assert_eq!(
            ledger.selection(&id).unwrap(),
            RouteSelection::DeveloperIdV2
        );
        let data: LedgerDataV2 =
            serde_json::from_slice(&fs::read(ledger.root.join(NAME)).unwrap()).unwrap();
        assert_eq!(data.version, 2);
        assert_eq!(data.routes.len(), 1);
        assert_eq!(data.routes[0].id, id);
        assert_eq!(data.routes[0].family, RouteFamily::DeveloperIdV2);
    }
    #[test]
    fn missing_v1_selected_item_never_falls_back_to_legacy_material() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&s, &key).unwrap();
        let id = identity_route_id(&s).unwrap();
        write_ledger_fixture(
            &ledger,
            &serde_json::to_vec(&LedgerData {
                version: 1,
                routes: vec![id.clone()],
            })
            .unwrap(),
        );
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        assert_eq!(ledger.selection(&id).unwrap(), RouteSelection::LocalV1);
        assert!(matches!(
            store.load(&s),
            Err(CryptoError::CredentialMissing)
        ));
        assert!(matches!(
            promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)),
            Err(CryptoError::CredentialMissing)
        ));
        assert!(backend.disk.load(&s).is_ok());
        assert_eq!(ledger.selection(&id).unwrap(), RouteSelection::LocalV1);
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
        promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)).unwrap();
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
        let writes = backend.writes.load(Ordering::Relaxed);
        let other = DevicePrivateKey::generate().unwrap();
        assert!(matches!(
            promote_dev(
                &ledger,
                backend.as_ref(),
                &s,
                &other,
                &AtomicBool::new(false)
            ),
            Err(CryptoError::CredentialConflict)
        ));
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
        backend
            .disk
            .delete(&developer_id_scope(&s).unwrap())
            .unwrap();
        assert!(matches!(
            restarted.load(&s),
            Err(CryptoError::CredentialMissing)
        ));
        assert!(backend.disk.load(&s).is_ok());
        assert!(matches!(
            promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)),
            Err(CryptoError::CredentialMissing)
        ));
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
        assert!(backend.disk.load(&developer_id_scope(&s).unwrap()).is_err());
        assert!(ledger.route(&identity_route_id(&s).unwrap()).unwrap());
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
    }
    #[test]
    fn publisher_migration_reads_selected_v1_source_and_never_touches_legacy_target_name() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        let old = local_scope(&s).unwrap();
        backend.disk.save_pending(&old, &key).unwrap();
        let id = identity_route_id(&s).unwrap();
        write_ledger_fixture(
            &ledger,
            &serde_json::to_vec(&LedgerData {
                version: 1,
                routes: vec![id.clone()],
            })
            .unwrap(),
        );
        let destination = developer_id_scope(&s).unwrap();
        assert_ne!(old.service_id, destination.service_id);
        promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            ledger.selection(&id).unwrap(),
            RouteSelection::DeveloperIdV2
        );
        assert_eq!(
            backend
                .disk
                .load(&destination)
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            key.public_fingerprint().unwrap()
        );
        assert_eq!(
            backend
                .disk
                .load(&old)
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            key.public_fingerprint().unwrap()
        );
    }
    #[test]
    fn release_selected_local_family_migrates_v2_source_without_changing_logical_route() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        let id = identity_route_id(&s).unwrap();
        let source = developer_id_scope(&s).unwrap();
        let destination = local_scope(&s).unwrap();
        backend.disk.save_pending(&source, &key).unwrap();
        ledger
            .set_selection(&id, RouteFamily::DeveloperIdV2)
            .unwrap();

        promote_to_family(
            &ledger,
            backend.as_ref(),
            &s,
            &key,
            &AtomicBool::new(false),
            RouteFamily::LocalV1,
        )
        .unwrap();

        assert_eq!(ledger.selection(&id).unwrap(), RouteSelection::LocalV1);
        assert_eq!(
            VersionedStore {
                ledger: ledger.clone(),
                backend: backend.clone(),
            }
            .load(&s)
            .unwrap()
            .public_fingerprint()
            .unwrap(),
            key.public_fingerprint().unwrap()
        );
        assert_ne!(source.service_id, destination.service_id);
        assert_eq!(identity_route_id(&s).unwrap(), id);
    }
    #[test]
    fn fresh_save_uses_new_family_without_reading_or_overwriting_old_partial_item() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let old = local_scope(&s).unwrap();
        let stale = DevicePrivateKey::generate().unwrap();
        let fresh = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&old, &stale).unwrap();
        *backend.deny_load_scope.lock().unwrap() = Some(old.clone());
        backend.reads.store(0, Ordering::Relaxed);
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        store
            .save_pending_for_family(&s, &fresh, RouteFamily::DeveloperIdV2)
            .unwrap();
        assert_eq!(
            ledger.selection(&identity_route_id(&s).unwrap()).unwrap(),
            RouteSelection::DeveloperIdV2
        );
        assert_eq!(backend.reads.load(Ordering::Relaxed), 1); // v2 readback only
        assert_eq!(
            backend
                .disk
                .load(&old)
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            stale.public_fingerprint().unwrap()
        );
        assert_eq!(
            store.load(&s).unwrap().public_fingerprint().unwrap(),
            fresh.public_fingerprint().unwrap()
        );
    }
    #[test]
    fn save_pending_is_same_key_idempotent_but_never_crosses_family_or_tombstone() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        let other = DevicePrivateKey::generate().unwrap();
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        store
            .save_pending_for_family(&s, &key, RouteFamily::DeveloperIdV2)
            .unwrap();
        let writes = backend.writes.load(Ordering::Relaxed);
        store
            .save_pending_for_family(&s, &key, RouteFamily::DeveloperIdV2)
            .unwrap();
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
        assert!(matches!(
            store.save_pending_for_family(&s, &other, RouteFamily::DeveloperIdV2),
            Err(CryptoError::CredentialConflict)
        ));
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);

        store.delete(&s).unwrap();
        assert!(matches!(
            store.save_pending_for_family(&s, &key, RouteFamily::DeveloperIdV2),
            Err(CryptoError::CredentialMissing)
        ));
        assert_eq!(
            ledger.selection(&identity_route_id(&s).unwrap()).unwrap(),
            RouteSelection::Deleted
        );
        assert_eq!(backend.writes.load(Ordering::Relaxed), writes);
    }

    #[test]
    fn authorized_identity_migration_reads_selected_source_once_and_commits_after_target_readback()
    {
        let (_dir, ledger, backend) = fixture();
        let scope = scope();
        let source = local_scope(&scope).unwrap();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&source, &key).unwrap();
        let route = identity_route_id(&scope).unwrap();
        ledger.set_selection(&route, RouteFamily::LocalV1).unwrap();
        let expected = key.public_fingerprint().unwrap();
        let authorized_reads = AtomicUsize::new(0);
        let reader: Arc<dyn IdentityStore> = backend.clone();

        let (authorized_scope, returned_reader, selected) = promote_authorized_with(
            &ledger,
            backend.as_ref(),
            &scope,
            &expected,
            RouteFamily::DeveloperIdV2,
            &AtomicBool::new(false),
            |physical| {
                assert!(same_scope(physical, &source));
                authorized_reads.fetch_add(1, Ordering::Relaxed);
                Ok((backend.load(physical)?, reader.clone()))
            },
            || Ok::<_, CryptoError>(()),
        )
        .unwrap();

        assert!(same_scope(&authorized_scope, &source));
        assert_eq!(selected, RouteSelection::DeveloperIdV2);
        assert_eq!(authorized_reads.load(Ordering::Relaxed), 1);
        assert_eq!(
            ledger.selection(&route).unwrap(),
            RouteSelection::DeveloperIdV2
        );
        assert_eq!(
            returned_reader
                .load(&source)
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            expected
        );
        assert_eq!(
            backend
                .disk
                .load(&source)
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            expected
        );
        assert_eq!(
            backend
                .disk
                .load(&developer_id_scope(&scope).unwrap())
                .unwrap()
                .public_fingerprint()
                .unwrap(),
            expected
        );
    }

    #[test]
    fn authorized_identity_migration_fences_before_authorization_and_keeps_route_on_cancel() {
        let (_dir, ledger, backend) = fixture();
        let scope = scope();
        let source = local_scope(&scope).unwrap();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&source, &key).unwrap();
        let route = identity_route_id(&scope).unwrap();
        ledger.set_selection(&route, RouteFamily::LocalV1).unwrap();
        let expected = key.public_fingerprint().unwrap();
        let auth_reads = AtomicUsize::new(0);
        let denied = promote_authorized_with(
            &ledger,
            backend.as_ref(),
            &scope,
            &expected,
            RouteFamily::DeveloperIdV2,
            &AtomicBool::new(false),
            |_| {
                auth_reads.fetch_add(1, Ordering::Relaxed);
                Err(CryptoError::CredentialAuthorizationRequired)
            },
            || Err::<(), _>(CryptoError::CredentialUnavailable),
        );
        assert!(denied.is_err());
        assert_eq!(auth_reads.load(Ordering::Relaxed), 0);
        assert_eq!(ledger.selection(&route).unwrap(), RouteSelection::LocalV1);

        let cancelled = Arc::new(AtomicBool::new(false));
        *backend.cancel_on_write.lock().unwrap() = Some(cancelled.clone());
        let result = promote_authorized_with(
            &ledger,
            backend.as_ref(),
            &scope,
            &expected,
            RouteFamily::DeveloperIdV2,
            &cancelled,
            |physical| Ok((backend.load(physical)?, backend.clone())),
            || Ok::<_, CryptoError>(()),
        );
        assert!(matches!(result, Err(CryptoError::CredentialUnavailable)));
        assert_eq!(ledger.selection(&route).unwrap(), RouteSelection::LocalV1);
    }
    #[test]
    fn concurrent_same_key_save_pending_commits_once_and_is_idempotent() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = Arc::new(DevicePrivateKey::generate().unwrap());
        let store = Arc::new(VersionedStore {
            ledger,
            backend: backend.clone(),
        });
        let first_store = store.clone();
        let first_scope = s.clone();
        let first_key = key.clone();
        let first = std::thread::spawn(move || {
            first_store.save_pending_for_family(
                &first_scope,
                &first_key,
                RouteFamily::DeveloperIdV2,
            )
        });
        let second_store = store.clone();
        let second_scope = s.clone();
        let second_key = key.clone();
        let second = std::thread::spawn(move || {
            second_store.save_pending_for_family(
                &second_scope,
                &second_key,
                RouteFamily::DeveloperIdV2,
            )
        });
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
        assert_eq!(backend.writes.load(Ordering::Relaxed), 1);
        assert_eq!(
            store.load(&s).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
    }
    #[test]
    fn cancelled_and_unconfirmed_writes_never_commit_or_adopt_new_slot() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        backend.disk.save_pending(&s, &key).unwrap();
        assert!(promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(true)).is_err());
        assert_eq!(backend.writes.load(Ordering::Relaxed), 0);
        backend.fail_write.store(true, Ordering::Release);
        assert!(promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)).is_err());
        assert!(!ledger.route(&identity_route_id(&s).unwrap()).unwrap());
        assert!(backend.disk.load(&developer_id_scope(&s).unwrap()).is_ok());
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        assert_eq!(
            store.load(&s).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
        // Cancellation must happen on an actual destination write. The failed
        // attempt above intentionally left an uncommitted orphan, so retrying
        // the same scope would only confirm that item and never call write.
        let (_cancel_dir, cancel_ledger, cancel_backend) = fixture();
        let cancel_scope = scope();
        let cancel_key = DevicePrivateKey::generate().unwrap();
        cancel_backend
            .disk
            .save_pending(&cancel_scope, &cancel_key)
            .unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        *cancel_backend.cancel_on_write.lock().unwrap() = Some(flag.clone());
        assert!(promote_dev(
            &cancel_ledger,
            cancel_backend.as_ref(),
            &cancel_scope,
            &cancel_key,
            &flag,
        )
        .is_err());
        assert!(flag.load(Ordering::Acquire));
        assert!(!cancel_ledger
            .route(&identity_route_id(&cancel_scope).unwrap())
            .unwrap());
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
    fn deleting_v1_selected_item_keeps_tombstone_and_never_falls_back_to_legacy() {
        let (_dir, ledger, backend) = fixture();
        let s = scope();
        let key = DevicePrivateKey::generate().unwrap();
        let local = local_scope(&s).unwrap();
        backend.disk.save_pending(&s, &key).unwrap();
        backend.disk.save_pending(&local, &key).unwrap();
        let id = identity_route_id(&s).unwrap();
        write_ledger_fixture(
            &ledger,
            &serde_json::to_vec(&LedgerData {
                version: 1,
                routes: vec![id.clone()],
            })
            .unwrap(),
        );
        let store = VersionedStore {
            ledger: ledger.clone(),
            backend: backend.clone(),
        };
        store.delete(&s).unwrap();
        assert_eq!(ledger.selection(&id).unwrap(), RouteSelection::Deleted);
        assert!(matches!(
            store.load(&s),
            Err(CryptoError::CredentialMissing)
        ));
        assert!(backend.disk.load(&s).is_ok());
        assert!(matches!(
            promote_dev(&ledger, backend.as_ref(), &s, &key, &AtomicBool::new(false)),
            Err(CryptoError::CredentialMissing)
        ));
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
        let next = DevicePrivateKey::generate().unwrap();
        backend
            .disk
            .save_pending(&developer_id_scope(&s).unwrap(), &next)
            .unwrap();
        ledger
            .set_selection(&identity_route_id(&s).unwrap(), RouteFamily::DeveloperIdV2)
            .unwrap();
        cache.load(&s).unwrap();
        cache.load(&s).unwrap();
        // Cache must notice family change and reload the newly selected slot.
        assert_eq!(backend.reads.load(Ordering::Relaxed), 2);
        cache.delete(&s).unwrap();
        assert!(cache.load(&s).is_err());
        assert!(cache.state.lock().unwrap().route.is_none());
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
            format!(r#"{{"version":2,"routes":[{{"id":"{id}","family":"future"}}]}}"#),
            format!(
                r#"{{"version":2,"routes":[{{"id":"{id}","family":"developer-id-v2","extra":true}}]}}"#
            ),
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
        write_ledger_fixture(&ledger, &bytes);
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
        write_ledger_fixture(&ledger, b"{broken}");
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
                    let data: LedgerDataV2 =
                        serde_json::from_slice(&fs::read(ledger.root.join(NAME)).unwrap()).unwrap();
                    assert!(data
                        .routes
                        .iter()
                        .any(|r| r.id == absent && r.family == RouteFamily::Deleted));
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
    #[test]
    fn deletion_preflights_capacity_before_selector_side_effects() {
        let (_dir, ledger, _) = fixture();
        let mut routes = BTreeMap::new();
        for i in 0..MAX_ROUTES {
            let id = format!("session:{}", hash43(format!("full-{i}").as_bytes()));
            let mut candidate = routes.clone();
            candidate.insert(id, RouteFamily::DeveloperIdV2);
            if encode_routes(&candidate).unwrap().len() > MAX_BYTES {
                break;
            }
            routes = candidate;
        }
        assert!(routes.len() < MAX_ROUTES);
        ledger
            .transaction(|dir| ledger.write(dir, routes.clone()))
            .unwrap();
        let called = AtomicBool::new(false);
        let id = format!("session:{}", hash43(b"absent-capacity"));
        assert!(!routes.contains_key(&id));
        assert!(ledger
            .ensure_route_capacity(&routes, &id, RouteFamily::Deleted)
            .is_err());
        assert!(deleted_route(
            &ledger,
            &id,
            |_| {
                called.store(true, Ordering::Release);
                Ok::<_, CryptoError>(Some(()))
            },
            |_| { panic!("capacity rejection must not call delete") }
        )
        .is_err());
        assert!(!called.load(Ordering::Acquire));
    }

    #[test]
    fn uncommitted_orphan_cleanup_is_confirmed_before_delete_barrier() {
        #[derive(Debug, PartialEq)]
        enum Error {
            Storage,
            Cleanup,
            Delete,
        }
        impl From<CryptoError> for Error {
            fn from(_: CryptoError) -> Self {
                Self::Storage
            }
        }
        for mode in [
            "success",
            "cleanup-error",
            "cleanup-unconfirmed",
            "old-delete-error",
            "wrong-binding",
        ] {
            let (_dir, ledger, _) = fixture();
            let id = format!("session:{}", hash43(mode.as_bytes()));
            let old = ledger.root.join("legacy.synthetic");
            let fresh = ledger.root.join("fresh.synthetic");
            fs::write(&old, b"expected-binding").unwrap();
            fs::write(&fresh, b"orphan-binding").unwrap();
            let delete_called = AtomicBool::new(false);
            let result = deleted_route(
                &ledger,
                &id,
                |committed| {
                    assert!(!committed);
                    assert!(ledger
                        .root
                        .join(LOCK_PARENT)
                        .join(LOCK)
                        .join("owner")
                        .is_file());
                    let expected: &[u8] = if mode == "wrong-binding" {
                        b"other-binding"
                    } else {
                        b"expected-binding"
                    };
                    if fs::read(&old).map_err(|_| Error::Storage)?.as_slice() != expected {
                        return Ok(None);
                    }
                    if mode == "cleanup-error" {
                        return Err(Error::Cleanup);
                    }
                    if mode != "cleanup-unconfirmed" {
                        fs::remove_file(&fresh).map_err(|_| Error::Cleanup)?;
                    }
                    match fs::read(&fresh) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                        _ => return Err(Error::Cleanup),
                    }
                    Ok(Some(old.clone()))
                },
                |selected| {
                    delete_called.store(true, Ordering::Release);
                    assert!(ledger
                        .root
                        .join(LOCK_PARENT)
                        .join(LOCK)
                        .join("owner")
                        .is_file());
                    let data: LedgerDataV2 =
                        serde_json::from_slice(&fs::read(ledger.root.join(NAME)).unwrap()).unwrap();
                    assert!(data
                        .routes
                        .iter()
                        .any(|route| route.id == id && route.family == RouteFamily::Deleted));
                    assert!(!fresh.exists());
                    if mode == "old-delete-error" {
                        return Err(Error::Delete);
                    }
                    fs::remove_file(selected).map_err(|_| Error::Delete)
                },
            );
            match mode {
                "success" => {
                    assert_eq!(result, Ok(true));
                    assert!(ledger.route(&id).unwrap());
                    assert!(!old.exists());
                    assert!(!fresh.exists());
                }
                "old-delete-error" => {
                    assert_eq!(result, Err(Error::Delete));
                    assert!(ledger.route(&id).unwrap());
                    assert!(old.exists());
                    assert!(!fresh.exists());
                }
                "wrong-binding" => {
                    assert_eq!(result, Ok(false));
                    assert!(!ledger.route(&id).unwrap());
                    assert!(old.exists());
                    assert!(fresh.exists());
                    assert!(!delete_called.load(Ordering::Acquire));
                }
                _ => {
                    assert_eq!(result, Err(Error::Cleanup));
                    assert!(!ledger.route(&id).unwrap());
                    assert!(old.exists());
                    assert!(fresh.exists());
                    assert!(!delete_called.load(Ordering::Acquire));
                }
            }
        }
    }
}
