//! Dynamic encrypted key records. The read-only systemd credential supplies
//! only the KEK; generation records remain owned by this non-root Rust owner.
use crate::{CryptoError, DevicePrivateKey, IdentityStore, KeyScope};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
#[cfg(any(test, target_os = "linux"))]
use std::path::Component;
use std::path::Path;
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"MAIDKEY1";
const MAX_RECORD: usize = 8 + 12 + 4096 + 16;
pub struct EncryptedIdentityStore {
    directory: File,
    kek: Zeroizing<[u8; 32]>,
}

fn unavailable(_: std::io::Error) -> CryptoError {
    CryptoError::CredentialUnavailable
}
fn uncertain(_: std::io::Error) -> CryptoError {
    CryptoError::CredentialPersistenceUnconfirmed
}
fn name(value: &str) -> Result<CString, CryptoError> {
    CString::new(value).map_err(|_| CryptoError::CredentialUnsafePath)
}

/// Walk every component without following symlinks and retain the final object.
#[cfg(any(test, target_os = "linux"))]
fn directory(path: &Path) -> Result<File, CryptoError> {
    if !path.is_absolute() {
        return Err(CryptoError::CredentialUnsafePath);
    }
    let mut handle = open_at(
        libc::AT_FDCWD,
        &name("/")?,
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    for part in path.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(value) => {
                use std::os::unix::ffi::OsStrExt;
                let component = CString::new(value.as_bytes())
                    .map_err(|_| CryptoError::CredentialUnsafePath)?;
                handle = open_at(
                    handle.as_raw_fd(),
                    &component,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                )?;
            }
            _ => return Err(CryptoError::CredentialUnsafePath),
        }
    }
    Ok(handle)
}

fn open_at(parent: i32, component: &CString, flags: i32) -> Result<File, CryptoError> {
    let fd = unsafe {
        libc::openat(
            parent,
            component.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        return Err(match error.raw_os_error() {
            Some(libc::ENOENT) => CryptoError::CredentialMissing,
            Some(libc::EEXIST) => CryptoError::CredentialConflict,
            Some(libc::ELOOP) | Some(libc::ENOTDIR) => CryptoError::CredentialUnsafePath,
            _ => CryptoError::CredentialUnavailable,
        });
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn private_file(file: &File) -> Result<(), CryptoError> {
    let meta = file.metadata().map_err(unavailable)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != 0o600
        || meta.nlink() != 1
    {
        return Err(CryptoError::CredentialUnsafePath);
    }
    Ok(())
}

impl EncryptedIdentityStore {
    /// The sole production constructor. No environment/CLI plaintext KEK and
    /// no regular-file fallback. The caller has an explicit independent unit.
    pub fn from_systemd(root: &Path, unit: &str, credential: &str) -> Result<Self, CryptoError> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (root, unit, credential);
            Err(CryptoError::UnsupportedPlatform)
        }
        #[cfg(target_os = "linux")]
        {
            if unsafe { libc::geteuid() } == 0
                || unit.len() > 255
                || !unit.ends_with(".service")
                || !unit
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.@-".contains(&b))
                || credential.is_empty()
                || credential.len() > 64
                || !credential
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err(CryptoError::CredentialUnsafePath);
            }
            let projection = format!("/run/credentials/{unit}");
            if std::env::var_os("CREDENTIALS_DIRECTORY").as_deref()
                != Some(std::ffi::OsStr::new(&projection))
            {
                return Err(CryptoError::CredentialUnavailable);
            }
            let prerequisite = |error| {
                if error == CryptoError::CredentialMissing {
                    CryptoError::CredentialUnavailable
                } else {
                    error
                }
            };
            let dir = directory(Path::new(&projection)).map_err(prerequisite)?;
            let meta = dir.metadata().map_err(unavailable)?;
            if meta.uid() != 0
                || meta.gid() != 0
                || meta.mode() & 0o027 != 0
                || meta.mode() & 0o7000 != 0
            {
                return Err(CryptoError::CredentialUnsafePath);
            }
            let mounted = std::fs::read_to_string("/proc/self/mountinfo")
                .map_err(unavailable)?
                .lines()
                .any(|line| {
                    let Some((left, right)) = line.split_once(" - ") else {
                        return false;
                    };
                    let fields: Vec<_> = left.split_whitespace().collect();
                    fields.get(4) == Some(&projection.as_str())
                        && fields
                            .get(5)
                            .is_some_and(|options| options.split(',').any(|value| value == "ro"))
                        && matches!(right.split_whitespace().next(), Some("tmpfs" | "ramfs"))
                });
            if !mounted {
                return Err(CryptoError::CredentialUnsafePath);
            }
            let mut file = open_at(dir.as_raw_fd(), &name(credential)?, libc::O_RDONLY)
                .map_err(prerequisite)?;
            let meta = file.metadata().map_err(unavailable)?;
            if !meta.is_file()
                || meta.uid() != 0
                || meta.gid() != 0
                || meta.nlink() != 1
                || !matches!(meta.mode() & 0o7777, 0o400 | 0o440)
                || meta.len() != 32
            {
                return Err(CryptoError::CredentialUnsafePath);
            }
            let mut kek = Zeroizing::new([0; 32]);
            file.read_exact(&mut *kek).map_err(unavailable)?;
            Self::with_kek(root, kek)
        }
    }

    #[cfg(any(test, target_os = "linux"))]
    fn with_kek(root: &Path, kek: Zeroizing<[u8; 32]>) -> Result<Self, CryptoError> {
        let directory = directory(root).map_err(|error| {
            if error == CryptoError::CredentialMissing {
                CryptoError::CredentialUnavailable
            } else {
                error
            }
        })?;
        let meta = directory.metadata().map_err(unavailable)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o7777 != 0o700 {
            return Err(CryptoError::CredentialUnsafePath);
        }
        Ok(Self { directory, kek })
    }
    /// A bounded dynamic secret record, separate from immutable key generations.
    /// Namespace is authenticated; returned plaintext stays inside the Rust owner.
    fn state_names(namespace: &str) -> Result<(CString, CString, Vec<u8>), CryptoError> {
        use sha2::{Digest, Sha256};
        if namespace.is_empty()
            || namespace.len() > 256
            || !namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            return Err(CryptoError::CredentialUnsafePath);
        }
        let digest = Sha256::digest(namespace.as_bytes());
        let hash = digest
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        Ok((
            name(&format!("state-{hash}.sealed"))?,
            name(&format!("state-{hash}.lock"))?,
            format!("MASTATE1:{namespace}").into_bytes(),
        ))
    }
    fn state_load_locked(
        &self,
        record: &CString,
        aad: &[u8],
    ) -> Result<Option<Zeroizing<Vec<u8>>>, CryptoError> {
        let file = match open_at(self.directory.as_raw_fd(), record, libc::O_RDONLY) {
            Err(CryptoError::CredentialMissing) => {
                self.directory.sync_all().map_err(uncertain)?;
                return Ok(None);
            }
            other => other?,
        };
        private_file(&file)?;
        let mut bytes = Zeroizing::new(Vec::new());
        (&file)
            .take(65536 + 37)
            .read_to_end(&mut bytes)
            .map_err(unavailable)?;
        if bytes.len() < 36 || bytes.len() > 65536 + 36 || &bytes[..8] != b"MASTATE1" {
            return Err(CryptoError::CredentialCorrupt);
        }
        let nonce = aead::Nonce::try_assume_unique_for_key(&bytes[8..20])
            .map_err(|_| CryptoError::CredentialCorrupt)?;
        let plain = self
            .cipher()?
            .open_in_place(nonce, aead::Aad::from(aad), &mut bytes[20..])
            .map_err(|_| CryptoError::CredentialCorrupt)?;
        let result = Zeroizing::new(plain.to_vec());
        file.sync_all().map_err(uncertain)?;
        self.directory.sync_all().map_err(uncertain)?;
        Ok(Some(result))
    }
    pub fn load_state(&self, namespace: &str) -> Result<Option<Zeroizing<Vec<u8>>>, CryptoError> {
        let (record, lock, aad) = Self::state_names(namespace)?;
        let _guard = self.lock(&lock)?;
        self.state_load_locked(&record, &aad)
    }
    /// Exact plaintext CAS under a kernel lock. All visible writes are followed
    /// by file/directory durability barriers and authenticated readback.
    pub fn compare_exchange_state(
        &self,
        namespace: &str,
        expected: Option<&[u8]>,
        next: &[u8],
    ) -> Result<(), CryptoError> {
        if next.len() > 65536 {
            return Err(CryptoError::CredentialCorrupt);
        }
        let (record, lock, aad) = Self::state_names(namespace)?;
        let _guard = self.lock(&lock)?;
        let current = self.state_load_locked(&record, &aad)?;
        if current.as_deref().map(|v| v.as_slice()) != expected {
            return Err(CryptoError::CredentialConflict);
        }
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        let mut bytes = Zeroizing::new(next.to_vec());
        self.cipher()?
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(&aad),
                &mut *bytes,
            )
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        let temporary = name(&format!(".pending-state-{}", uuid::Uuid::new_v4()))?;
        let mut file = open_at(
            self.directory.as_raw_fd(),
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        let result = (|| {
            private_file(&file)?;
            file.write_all(b"MASTATE1").map_err(uncertain)?;
            file.write_all(&nonce).map_err(uncertain)?;
            file.write_all(&bytes).map_err(uncertain)?;
            file.sync_all().map_err(uncertain)?;
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    temporary.as_ptr(),
                    self.directory.as_raw_fd(),
                    record.as_ptr(),
                )
            } != 0
            {
                return Err(CryptoError::CredentialPersistenceUnconfirmed);
            }
            self.directory.sync_all().map_err(uncertain)?;
            let loaded = self
                .state_load_locked(&record, &aad)?
                .ok_or(CryptoError::CredentialPersistenceUnconfirmed)?;
            if loaded.as_slice() != next {
                return Err(CryptoError::CredentialPersistenceUnconfirmed);
            }
            Ok(())
        })();
        unsafe {
            libc::unlinkat(self.directory.as_raw_fd(), temporary.as_ptr(), 0);
        }
        result
    }
    fn names(scope: &KeyScope) -> Result<(CString, CString, Vec<u8>), CryptoError> {
        let hash = scope.credential_name()?;
        let mut aad = MAGIC.to_vec();
        aad.extend(serde_json::to_vec(scope).map_err(|_| CryptoError::InvalidKey)?);
        Ok((
            name(&format!("key-{hash}.sealed"))?,
            name(&format!("key-{hash}.lock"))?,
            aad,
        ))
    }
    fn lock(&self, lock_name: &CString) -> Result<File, CryptoError> {
        let meta = self.directory.metadata().map_err(unavailable)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o7777 != 0o700 {
            return Err(CryptoError::CredentialUnsafePath);
        }
        let file = match open_at(
            self.directory.as_raw_fd(),
            lock_name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
        ) {
            Ok(file) => file,
            Err(CryptoError::CredentialConflict) => {
                open_at(self.directory.as_raw_fd(), lock_name, libc::O_RDWR).map_err(|error| {
                    if error == CryptoError::CredentialMissing {
                        CryptoError::CredentialUnavailable
                    } else {
                        error
                    }
                })?
            }
            Err(CryptoError::CredentialMissing) => return Err(CryptoError::CredentialUnavailable),
            Err(error) => return Err(error),
        };
        private_file(&file)?;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(CryptoError::CredentialUnavailable);
        }
        // A waiter may have opened a removed/replaced lock object. Never proceed
        // under a lock whose current name no longer refers to that same inode.
        let current =
            open_at(self.directory.as_raw_fd(), lock_name, libc::O_RDONLY).map_err(|error| {
                if error == CryptoError::CredentialMissing {
                    CryptoError::CredentialUnavailable
                } else {
                    error
                }
            })?;
        private_file(&current)?;
        let a = file.metadata().map_err(unavailable)?;
        let b = current.metadata().map_err(unavailable)?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err(CryptoError::CredentialConflict);
        }
        Ok(file)
    }
    fn cipher(&self) -> Result<aead::LessSafeKey, CryptoError> {
        aead::UnboundKey::new(&aead::AES_256_GCM, &*self.kek)
            .map(aead::LessSafeKey::new)
            .map_err(|_| CryptoError::InvalidKey)
    }
    fn load_locked(&self, record: &CString, aad: &[u8]) -> Result<DevicePrivateKey, CryptoError> {
        let file = match open_at(self.directory.as_raw_fd(), record, libc::O_RDONLY) {
            Err(CryptoError::CredentialMissing) => {
                // Confirm a prior delete before reporting absence.
                self.directory.sync_all().map_err(uncertain)?;
                return Err(CryptoError::CredentialMissing);
            }
            other => other?,
        };
        private_file(&file)?;
        let size = file.metadata().map_err(unavailable)?.len();
        if !(37..=MAX_RECORD as u64).contains(&size) {
            return Err(CryptoError::CredentialCorrupt);
        }
        let mut bytes = Zeroizing::new(Vec::new());
        (&file)
            .take(MAX_RECORD as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(unavailable)?;
        if bytes.len() != size as usize || &bytes[..8] != MAGIC {
            return Err(CryptoError::CredentialCorrupt);
        }
        let nonce = aead::Nonce::try_assume_unique_for_key(&bytes[8..20])
            .map_err(|_| CryptoError::CredentialCorrupt)?;
        let plaintext = self
            .cipher()?
            .open_in_place(nonce, aead::Aad::from(aad), &mut bytes[20..])
            .map_err(|_| CryptoError::CredentialCorrupt)?;
        let key = DevicePrivateKey::from_der(Zeroizing::new(plaintext.to_vec()))
            .map_err(|_| CryptoError::CredentialCorrupt)?;
        // This is also the recovery barrier for a previous uncertain publication.
        file.sync_all().map_err(uncertain)?;
        self.directory.sync_all().map_err(uncertain)?;
        Ok(key)
    }
    fn publish(&self, temporary: &CString, record: &CString) -> Result<(), CryptoError> {
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                self.directory.as_raw_fd(),
                temporary.as_ptr(),
                self.directory.as_raw_fd(),
                record.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                self.directory.as_raw_fd(),
                temporary.as_ptr(),
                self.directory.as_raw_fd(),
                record.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        return Err(CryptoError::UnsupportedPlatform);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if result != 0 {
            return Err(
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
                    CryptoError::CredentialConflict
                } else {
                    CryptoError::CredentialPersistenceUnconfirmed
                },
            );
        }
        Ok(())
    }
    fn save_impl(
        &self,
        scope: &KeyScope,
        key: &DevicePrivateKey,
        mut barrier: impl FnMut(&str) -> Result<(), CryptoError>,
    ) -> Result<(), CryptoError> {
        let (record, lock_name, aad) = Self::names(scope)?;
        let _lock = self.lock(&lock_name)?;
        match self.load_locked(&record, &aad) {
            Ok(existing) => {
                return if existing.public_fingerprint()? == key.public_fingerprint()? {
                    Ok(())
                } else {
                    Err(CryptoError::CredentialConflict)
                }
            }
            Err(CryptoError::CredentialMissing) => {}
            Err(error) => return Err(error),
        }
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        let mut ciphertext = Zeroizing::new(key.der.to_vec());
        self.cipher()?
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(&aad),
                &mut *ciphertext,
            )
            .map_err(|_| CryptoError::CredentialUnavailable)?;
        let temporary = name(&format!(".pending-{}", uuid::Uuid::new_v4()))?;
        let mut file = open_at(
            self.directory.as_raw_fd(),
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
        .map_err(|_| CryptoError::CredentialPersistenceUnconfirmed)?;
        let result = (|| {
            private_file(&file)?;
            file.write_all(MAGIC)
                .and_then(|_| file.write_all(&nonce))
                .and_then(|_| file.write_all(&ciphertext))
                .map_err(uncertain)?;
            file.sync_all().map_err(uncertain)?;
            barrier("before-publish")?;
            self.publish(&temporary, &record)?;
            barrier("after-publish")?;
            self.directory.sync_all().map_err(uncertain)?;
            let persisted = self.load_locked(&record, &aad)?;
            if persisted.public_fingerprint()? != key.public_fingerprint()? {
                return Err(CryptoError::CredentialConflict);
            }
            Ok(())
        })();
        // Cleanup only our unpublished ciphertext, never the generation record.
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), temporary.as_ptr(), 0) } == 0 {
            self.directory.sync_all().map_err(uncertain)?;
        }
        result
    }
}

impl IdentityStore for EncryptedIdentityStore {
    fn load(&self, scope: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let (record, lock_name, aad) = Self::names(scope)?;
        let _lock = self.lock(&lock_name)?;
        self.load_locked(&record, &aad)
    }
    fn save_pending(&self, scope: &KeyScope, key: &DevicePrivateKey) -> Result<(), CryptoError> {
        self.save_impl(scope, key, |_| Ok(()))
    }
    fn delete(&self, scope: &KeyScope) -> Result<(), CryptoError> {
        let (record, lock_name, aad) = Self::names(scope)?;
        let _lock = self.lock(&lock_name)?;
        match self.load_locked(&record, &aad) {
            Ok(_) => {}
            Err(CryptoError::CredentialMissing) => return Ok(()),
            Err(error) => return Err(error),
        }
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), record.as_ptr(), 0) } != 0 {
            return Err(CryptoError::CredentialPersistenceUnconfirmed);
        }
        self.directory.sync_all().map_err(uncertain)?;
        match self.load_locked(&record, &aad) {
            Err(CryptoError::CredentialMissing) => Ok(()),
            _ => Err(CryptoError::CredentialPersistenceUnconfirmed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::time::{Duration, Instant};

    fn scope() -> KeyScope {
        KeyScope {
            issuer: "https://isolated-storage.myagents.invalid".into(),
            environment: "development".into(),
            service_id: "00000000-0000-4000-8000-000000000001".into(),
            principal_id: "isolated-storage-test".into(),
            device_id: "00000000-0000-4000-8000-000000000002".into(),
            key_generation: 1,
        }
    }
    fn fixture() -> (tempfile::TempDir, EncryptedIdentityStore) {
        let tmp = tempfile::tempdir().unwrap();
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let canonical = fs::canonicalize(tmp.path()).unwrap();
        let store = EncryptedIdentityStore::with_kek(&canonical, Zeroizing::new([42; 32])).unwrap();
        (tmp, store)
    }
    fn record(tmp: &tempfile::TempDir) -> std::path::PathBuf {
        let (record, _, _) = EncryptedIdentityStore::names(&scope()).unwrap();
        tmp.path().join(record.to_str().unwrap())
    }

    #[test]
    fn encrypted_generation_is_idempotent_and_survives_a_new_owner() {
        let (tmp, store) = fixture();
        let scope = scope();
        let key = DevicePrivateKey::generate().unwrap();
        assert!(matches!(
            store.load(&scope),
            Err(CryptoError::CredentialMissing)
        ));
        store.save_pending(&scope, &key).unwrap();
        store.save_pending(&scope, &key).unwrap();
        assert_eq!(
            store.load(&scope).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
        assert_eq!(
            store.save_pending(&scope, &DevicePrivateKey::generate().unwrap()),
            Err(CryptoError::CredentialConflict)
        );
        let stored = fs::read(record(&tmp)).unwrap();
        assert!(!stored.windows(key.der.len()).any(|bytes| bytes == *key.der));
        assert_eq!(fs::metadata(record(&tmp)).unwrap().mode() & 0o777, 0o600);
        drop(store);
        let restored = EncryptedIdentityStore::with_kek(
            &fs::canonicalize(tmp.path()).unwrap(),
            Zeroizing::new([42; 32]),
        )
        .unwrap();
        assert_eq!(
            restored.load(&scope).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
        restored.delete(&scope).unwrap();
        restored.delete(&scope).unwrap();
        assert!(matches!(
            restored.load(&scope),
            Err(CryptoError::CredentialMissing)
        ));
    }

    #[test]
    fn authentication_is_bound_to_full_scope_and_never_overwrites_corruption() {
        let (tmp, store) = fixture();
        let scope = scope();
        let key = DevicePrivateKey::generate().unwrap();
        store.save_pending(&scope, &key).unwrap();
        let bytes = fs::read(record(&tmp)).unwrap();
        let mut other = scope.clone();
        other.key_generation = 2;
        assert!(matches!(
            store.load(&other),
            Err(CryptoError::CredentialMissing)
        ));
        let (new_name, _, _) = EncryptedIdentityStore::names(&other).unwrap();
        let path = tmp.path().join(new_name.to_str().unwrap());
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(
            store.load(&other),
            Err(CryptoError::CredentialCorrupt)
        ));
        assert_eq!(
            store.save_pending(&other, &key),
            Err(CryptoError::CredentialCorrupt)
        );
        assert_eq!(store.delete(&other), Err(CryptoError::CredentialCorrupt));
        let wrong = EncryptedIdentityStore::with_kek(
            &fs::canonicalize(tmp.path()).unwrap(),
            Zeroizing::new([43; 32]),
        )
        .unwrap();
        assert!(matches!(
            wrong.load(&scope),
            Err(CryptoError::CredentialCorrupt)
        ));
        assert_eq!(wrong.delete(&scope), Err(CryptoError::CredentialCorrupt));
        let mut damaged = bytes.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        fs::write(record(&tmp), &damaged).unwrap();
        assert!(matches!(
            store.load(&scope),
            Err(CryptoError::CredentialCorrupt)
        ));
        assert_eq!(
            store.save_pending(&scope, &key),
            Err(CryptoError::CredentialCorrupt)
        );
        for oversized in [vec![], vec![0; MAX_RECORD + 1]] {
            fs::write(record(&tmp), oversized).unwrap();
            assert!(matches!(
                store.load(&scope),
                Err(CryptoError::CredentialCorrupt)
            ));
        }
    }

    #[test]
    fn scope_and_generation_records_are_isolated() {
        let (_tmp, store) = fixture();
        let first = scope();
        let key = DevicePrivateKey::generate().unwrap();
        store.save_pending(&first, &key).unwrap();
        let mut scopes = Vec::new();
        let mut second = first.clone();
        second.key_generation = 2;
        scopes.push(second);
        let mut second = first.clone();
        second.principal_id = "other-owner".into();
        scopes.push(second);
        let mut second = first.clone();
        second.environment = "production".into();
        scopes.push(second);
        let mut second = first.clone();
        second.issuer = "https://isolated-other.invalid".into();
        scopes.push(second);
        let mut second = first.clone();
        second.device_id = uuid::Uuid::new_v4().to_string();
        scopes.push(second);
        let mut second = first.clone();
        second.service_id = uuid::Uuid::new_v4().to_string();
        scopes.push(second);
        for other in scopes {
            assert!(matches!(
                store.load(&other),
                Err(CryptoError::CredentialMissing)
            ));
            let other_key = DevicePrivateKey::generate().unwrap();
            store.save_pending(&other, &other_key).unwrap();
            assert_eq!(
                store.load(&other).unwrap().public_fingerprint().unwrap(),
                other_key.public_fingerprint().unwrap()
            );
            assert_ne!(
                store.load(&first).unwrap().public_fingerprint().unwrap(),
                other_key.public_fingerprint().unwrap()
            );
        }
        let mut invalid = first;
        invalid.key_generation = 0;
        assert!(matches!(store.load(&invalid), Err(CryptoError::InvalidKey)));
    }

    #[test]
    fn permissions_symlinks_and_hardlinks_fail_closed() {
        let (tmp, store) = fixture();
        let scope = scope();
        let key = DevicePrivateKey::generate().unwrap();
        store.save_pending(&scope, &key).unwrap();
        let path = record(&tmp);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(matches!(
            store.load(&scope),
            Err(CryptoError::CredentialUnsafePath)
        ));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = tmp.path().join("extra-link");
        fs::hard_link(&path, &link).unwrap();
        assert!(matches!(
            store.load(&scope),
            Err(CryptoError::CredentialUnsafePath)
        ));
        fs::remove_file(&link).unwrap();
        fs::rename(&path, &link).unwrap();
        symlink(&link, &path).unwrap();
        assert!(matches!(
            store.load(&scope),
            Err(CryptoError::CredentialUnsafePath)
        ));
        fs::remove_file(&path).unwrap();
        fs::rename(link, path).unwrap();
        let parent = tempfile::tempdir().unwrap();
        let dir_link = fs::canonicalize(parent.path()).unwrap().join("dir-link");
        symlink(fs::canonicalize(tmp.path()).unwrap(), &dir_link).unwrap();
        assert!(matches!(
            EncryptedIdentityStore::with_kek(&dir_link, Zeroizing::new([42; 32])),
            Err(CryptoError::CredentialUnsafePath)
        ));
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o750)).unwrap();
        assert!(matches!(
            store.load(&scope),
            Err(CryptoError::CredentialUnsafePath)
        ));
        assert!(matches!(
            EncryptedIdentityStore::with_kek(
                &fs::canonicalize(tmp.path()).unwrap(),
                Zeroizing::new([42; 32])
            ),
            Err(CryptoError::CredentialUnsafePath)
        ));
        fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn actual_publication_faults_have_readable_recovery_outcomes() {
        let (_tmp, store) = fixture();
        let scope = scope();
        let key = DevicePrivateKey::generate().unwrap();
        for stage in ["before-publish", "after-publish"] {
            assert_eq!(
                store.save_impl(&scope, &key, |current| if current == stage {
                    Err(CryptoError::CredentialPersistenceUnconfirmed)
                } else {
                    Ok(())
                }),
                Err(CryptoError::CredentialPersistenceUnconfirmed)
            );
            if stage == "before-publish" {
                assert!(matches!(
                    store.load(&scope),
                    Err(CryptoError::CredentialMissing)
                ));
            } else {
                assert_eq!(
                    store.load(&scope).unwrap().public_fingerprint().unwrap(),
                    key.public_fingerprint().unwrap()
                );
                store.save_pending(&scope, &key).unwrap();
            }
        }
    }

    #[test]
    fn dynamic_secret_cas_is_durable_scope_bound_and_rejects_late_results() {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(
            root.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let owner = EncryptedIdentityStore::with_kek(
            &fs::canonicalize(root.path()).unwrap(),
            Zeroizing::new([42; 32]),
        )
        .unwrap();
        assert!(owner
            .load_state("official-headless-account-v1")
            .unwrap()
            .is_none());
        let pending = br#"{"revision":"flow1","loginToken":"isolated-placeholder"}"#;
        owner
            .compare_exchange_state("official-headless-account-v1", None, pending)
            .unwrap();
        assert_eq!(
            owner
                .load_state("official-headless-account-v1")
                .unwrap()
                .unwrap()
                .as_slice(),
            pending
        );
        let cancelled = br#"{"revision":"flow2","account":null}"#;
        owner
            .compare_exchange_state("official-headless-account-v1", Some(pending), cancelled)
            .unwrap();
        assert_eq!(
            owner
                .compare_exchange_state(
                    "official-headless-account-v1",
                    Some(pending),
                    b"late-account"
                )
                .unwrap_err(),
            CryptoError::CredentialConflict
        );
        let restarted = EncryptedIdentityStore::with_kek(
            &fs::canonicalize(root.path()).unwrap(),
            Zeroizing::new([42; 32]),
        )
        .unwrap();
        assert_eq!(
            restarted
                .load_state("official-headless-account-v1")
                .unwrap()
                .unwrap()
                .as_slice(),
            cancelled
        );
        assert!(restarted
            .load_state("other-device-state")
            .unwrap()
            .is_none());
        let wrong = EncryptedIdentityStore::with_kek(
            &fs::canonicalize(root.path()).unwrap(),
            Zeroizing::new([41; 32]),
        )
        .unwrap();
        assert_eq!(
            wrong
                .load_state("official-headless-account-v1")
                .unwrap_err(),
            CryptoError::CredentialCorrupt
        );
        assert_eq!(
            wrong
                .compare_exchange_state("official-headless-account-v1", None, b"overwrite")
                .unwrap_err(),
            CryptoError::CredentialCorrupt
        );
        let (record, _, _) =
            EncryptedIdentityStore::state_names("official-headless-account-v1").unwrap();
        let record = root.path().join(record.to_str().unwrap());
        let bytes = std::fs::read(&record).unwrap();
        assert!(!bytes.windows(cancelled.len()).any(|v| v == cancelled));
        assert_eq!(std::fs::metadata(&record).unwrap().mode() & 0o7777, 0o600);
        std::fs::write(&record, b"corrupt").unwrap();
        assert_eq!(
            restarted
                .load_state("official-headless-account-v1")
                .unwrap_err(),
            CryptoError::CredentialCorrupt
        );
    }

    // Private test-only constructor and fixed isolated KEK stay out of the
    // production binary/API. Subprocesses use the real file/AEAD/flock code.
    #[test]
    #[ignore = "subprocess entry invoked by the concurrency test"]
    fn process_worker() {
        let root = std::env::var_os("ISOLATED_STORE_TEST_ROOT").unwrap();
        let root = Path::new(&root);
        let operation = std::env::var("ISOLATED_STORE_TEST_OP").unwrap();
        let store = EncryptedIdentityStore::with_kek(root, Zeroizing::new([42; 32])).unwrap();
        let index = std::env::var("ISOLATED_STORE_TEST_INDEX").unwrap();
        fs::write(root.join(format!("ready-{index}")), []).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("start").exists() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let scope = scope();
        let key = if operation == "same" {
            store.load(&scope).unwrap()
        } else {
            DevicePrivateKey::generate().unwrap()
        };
        match store.save_pending(&scope, &key) {
            Ok(()) => println!(
                "STORE_RESULT persisted {}",
                key.public_fingerprint().unwrap()
            ),
            Err(CryptoError::CredentialConflict) => println!("STORE_RESULT conflict"),
            Err(error) => panic!("unexpected fixed store error: {error}"),
        }
    }

    fn spawn_process(
        root: &Path,
        operation: &str,
        index: usize,
    ) -> (libc::pid_t, std::path::PathBuf) {
        use std::os::unix::ffi::OsStrExt;
        let executable =
            CString::new(std::env::current_exe().unwrap().as_os_str().as_bytes()).unwrap();
        let arguments = [
            executable.clone(),
            name("--exact").unwrap(),
            name("encrypted_store::tests::process_worker").unwrap(),
            name("--ignored").unwrap(),
            name("--nocapture").unwrap(),
        ];
        // Deliberately pass only these public test inputs, no parent credentials.
        let environment = [
            CString::new([b"ISOLATED_STORE_TEST_ROOT=", root.as_os_str().as_bytes()].concat())
                .unwrap(),
            name(&format!("ISOLATED_STORE_TEST_OP={operation}")).unwrap(),
            name(&format!("ISOLATED_STORE_TEST_INDEX={index}")).unwrap(),
        ];
        let mut argv: Vec<_> = arguments
            .iter()
            .map(|s| s.as_ptr() as *mut libc::c_char)
            .collect();
        argv.push(std::ptr::null_mut());
        let mut envp: Vec<_> = environment
            .iter()
            .map(|s| s.as_ptr() as *mut libc::c_char)
            .collect();
        envp.push(std::ptr::null_mut());
        let output = root.join(format!("result-{index}"));
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&output)
            .unwrap();
        // Unix-only short-lived test executables; no GUI process or descendants.
        let mut actions = std::mem::MaybeUninit::<libc::posix_spawn_file_actions_t>::uninit();
        let mut pid = 0;
        unsafe {
            assert_eq!(libc::posix_spawn_file_actions_init(actions.as_mut_ptr()), 0);
            let mut actions = actions.assume_init();
            assert_eq!(
                libc::posix_spawn_file_actions_adddup2(&mut actions, file.as_raw_fd(), 1),
                0
            );
            assert_eq!(
                libc::posix_spawn_file_actions_adddup2(&mut actions, file.as_raw_fd(), 2),
                0
            );
            let result = libc::posix_spawn(
                &mut pid,
                executable.as_ptr(),
                &actions,
                std::ptr::null(),
                argv.as_ptr(),
                envp.as_ptr(),
            );
            libc::posix_spawn_file_actions_destroy(&mut actions);
            assert_eq!(result, 0);
        }
        (pid, output)
    }

    fn processes(root: &Path, operation: &str) -> Vec<String> {
        let _ = fs::remove_file(root.join("start"));
        let mut children = Vec::new();
        for index in 0..4 {
            let _ = fs::remove_file(root.join(format!("ready-{index}")));
            children.push(spawn_process(root, operation, index));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !(0..4).all(|index| root.join(format!("ready-{index}")).exists()) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(root.join("start"), []).unwrap();
        children
            .into_iter()
            .map(|(pid, path)| {
                let mut status = 0;
                loop {
                    let result = unsafe { libc::waitpid(pid, &mut status, 0) };
                    if result == pid {
                        break;
                    }
                    assert_eq!(
                        std::io::Error::last_os_error().raw_os_error(),
                        Some(libc::EINTR)
                    );
                }
                let output = fs::read_to_string(path).unwrap();
                assert!(
                    libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0,
                    "{output}"
                );
                output
                    .lines()
                    .find(|line| line.starts_with("STORE_RESULT "))
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn independent_processes_serialize_generation_and_reload_identical_key() {
        let (tmp, store) = fixture();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let outcomes = processes(&root, "init");
        assert_eq!(
            outcomes
                .iter()
                .filter(|line| line.contains("persisted"))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|line| line.contains("conflict"))
                .count(),
            3
        );
        let fingerprint = store.load(&scope()).unwrap().public_fingerprint().unwrap();
        let outcomes = processes(&root, "same");
        assert!(outcomes
            .iter()
            .all(|line| line == &format!("STORE_RESULT persisted {fingerprint}")));
    }

    #[test]
    fn ordinary_path_cannot_be_a_systemd_projection() {
        let (tmp, _store) = fixture();
        assert!(
            EncryptedIdentityStore::from_systemd(tmp.path(), "../escape.service", "kek").is_err()
        );
        assert!(
            EncryptedIdentityStore::from_systemd(tmp.path(), "isolated.service", "../kek").is_err()
        );
        assert!(
            EncryptedIdentityStore::from_systemd(tmp.path(), "isolated.service", "kek").is_err()
        );
    }
}
