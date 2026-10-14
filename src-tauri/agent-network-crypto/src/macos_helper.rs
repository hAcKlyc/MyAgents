//! Private signed credential reader (fixed MoXBots component or legacy same-executable helper). Secret bytes never enter argv,
//! environment, logs or files; a stuck Security IPC is killed with its child.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use core_foundation::base::TCFType;
use keyring::macos::{MacCredential, MacKeychainDomain};
use security_framework::os::macos::code_signing::{
    Flags, GuestAttributes, SecCode, SecRequirement,
};
use security_framework_sys::code_signing::{SecCodeRef, SecRequirementRef};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    os::fd::{AsRawFd, RawFd},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const FLAG: &str = "--internal-moxbots-credential-reader-v1";
const INPUT_LIMIT: usize = 4096;
const SESSION_LIMIT: usize = 256 * 1024;
const KEY_LIMIT: usize = 4096;
const HEADER: usize = 9;
const DEADLINE: Duration = Duration::from_secs(5);
const AUTHORIZATION_DEADLINE: Duration = Duration::from_secs(180);
static NOT_CANCELLED: AtomicBool = AtomicBool::new(false);
const CONCURRENT: usize = 4;
static READERS: AtomicUsize = AtomicUsize::new(0);
static HELPER_MODE: AtomicBool = AtomicBool::new(false);
// An unconfirmed killed child keeps a capacity slot until a later nonblocking
// reap succeeds. Never forget ownership or create an unbounded reaper thread.
static QUARANTINED: Mutex<Vec<Child>> = Mutex::new(Vec::new());

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecCodeCopyDesignatedRequirement(
        code: SecCodeRef,
        flags: u32,
        requirement: *mut SecRequirementRef,
    ) -> i32;
}
extern "C" {
    fn csops(pid: libc::pid_t, ops: u32, useraddr: *mut libc::c_void, usersize: usize) -> i32;
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReadMode {
    Background,
    Authorize,
}
impl ReadMode {
    fn deadline(self) -> Duration {
        match self {
            Self::Background => DEADLINE,
            Self::Authorize => AUTHORIZATION_DEADLINE,
        }
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Operation {
    #[default]
    Read,
    Write,
    Delete,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    mode: ReadMode,
    #[cfg_attr(not(feature = "fixed-macos-reader"), serde(default))]
    operation: Operation,
    service: String,
    account: String,
    domain: String,
}
impl Request {
    fn validate(&self) -> Option<usize> {
        if self.version != 1
            || self.domain != "User"
            || (self.mode == ReadMode::Authorize && self.operation != Operation::Read)
        {
            return None;
        }
        let (hash, limit) = match self.service.as_str() {
            "com.myagents.owned-agentnet.v1" => (
                self.account
                    .strip_prefix("session:")
                    .or_else(|| self.account.strip_prefix("pending:"))?,
                SESSION_LIMIT,
            ),
            "MyAgents.AgentNetwork.v1" => (self.account.as_str(), KEY_LIMIT),
            _ => return None,
        };
        let decoded = URL_SAFE_NO_PAD.decode(hash).ok()?;
        (decoded.len() == 32 && hash.len() == 43 && URL_SAFE_NO_PAD.encode(decoded) == hash)
            .then_some(limit)
    }
}

pub(super) fn unavailable() -> keyring::Error {
    keyring::macos::decode_error(security_framework::base::Error::from(-25291))
}
struct ReaderSlot;
impl ReaderSlot {
    fn acquire() -> Option<Self> {
        let mut quarantined = QUARANTINED
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        quarantined.retain_mut(|child| child.try_wait().ok().flatten().is_none());
        let retained = quarantined.len();
        READERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count + retained < CONCURRENT).then_some(count + 1)
            })
            .ok()?;
        Some(Self)
    }
}
impl Drop for ReaderSlot {
    fn drop(&mut self) {
        READERS.fetch_sub(1, Ordering::AcqRel);
    }
}

#[allow(clippy::disallowed_methods)] // macOS-only neutral crate; no Windows console or desktop process_cmd dependency.
pub(super) fn read(credential: &MacCredential) -> keyring::Result<Vec<u8>> {
    read_with_mode(credential, ReadMode::Background, &NOT_CANCELLED)
}

pub(super) fn read_authorized(
    credential: &MacCredential,
    cancelled: &AtomicBool,
) -> keyring::Result<Vec<u8>> {
    read_with_mode(credential, ReadMode::Authorize, cancelled)
}

#[allow(clippy::disallowed_methods)] // Same authenticated macOS-only child transport.
fn read_with_mode(
    credential: &MacCredential,
    mode: ReadMode,
    cancelled: &AtomicBool,
) -> keyring::Result<Vec<u8>> {
    operation_with_mode(credential, mode, Operation::Read, &[], cancelled)
}

#[cfg(feature = "fixed-macos-reader")]
pub(super) fn write(credential: &MacCredential, secret: &[u8]) -> keyring::Result<()> {
    operation_with_mode(
        credential,
        ReadMode::Background,
        Operation::Write,
        secret,
        &NOT_CANCELLED,
    )
    .map(|_| ())
}
#[cfg(feature = "fixed-macos-reader")]
pub(super) fn delete(credential: &MacCredential) -> keyring::Result<()> {
    operation_with_mode(
        credential,
        ReadMode::Background,
        Operation::Delete,
        &[],
        &NOT_CANCELLED,
    )
    .map(|_| ())
}

#[allow(clippy::disallowed_methods)] // macOS private fixed component or legacy same-App helper.
fn operation_with_mode(
    credential: &MacCredential,
    mode: ReadMode,
    operation: Operation,
    secret: &[u8],
    cancelled: &AtomicBool,
) -> keyring::Result<Vec<u8>> {
    if cancelled.load(Ordering::Acquire)
        || HELPER_MODE.load(Ordering::Acquire)
        || credential.domain != MacKeychainDomain::User
    {
        return Err(unavailable());
    }
    let request = Request {
        version: 1,
        mode,
        operation,
        service: credential.service.clone(),
        account: credential.account.clone(),
        domain: "User".into(),
    };
    let limit = request.validate().ok_or_else(unavailable)?;
    if secret.len() > limit
        || (operation == Operation::Write && secret.is_empty())
        || (operation != Operation::Write && !secret.is_empty())
    {
        return Err(unavailable());
    }
    let _slot = ReaderSlot::acquire().ok_or_else(unavailable)?;
    let bytes = Zeroizing::new(serde_json::to_vec(&request).map_err(|_| unavailable())?);
    if bytes.len() > INPUT_LIMIT {
        return Err(unavailable());
    }
    let mut input = Zeroizing::new((bytes.len() as u32).to_be_bytes().to_vec());
    input.extend_from_slice(&bytes);
    #[cfg(feature = "fixed-macos-reader")]
    {
        input.extend_from_slice(&(secret.len() as u32).to_be_bytes());
        input.extend_from_slice(secret);
    }
    #[cfg(not(feature = "fixed-macos-reader"))]
    if operation != Operation::Read {
        return Err(unavailable());
    }
    let deadline = Instant::now() + mode.deadline();
    #[cfg(not(feature = "fixed-macos-reader"))]
    let executable = std::env::current_exe().map_err(|_| unavailable())?;
    #[cfg(feature = "fixed-macos-reader")]
    let executable = verified_broker_for_parent().ok_or_else(unavailable)?;
    let child = Command::new(executable)
        .arg(FLAG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| unavailable())?;
    exchange_operation(
        child,
        &input,
        limit,
        deadline.saturating_duration_since(Instant::now()),
        cancelled,
        operation,
    )
}

fn nonblocking(fd: RawFd) -> std::io::Result<()> {
    // SAFETY: fcntl only changes flags on our owned pipe descriptor.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
fn exchange(
    child: Child,
    input: &[u8],
    limit: usize,
    timeout: Duration,
) -> keyring::Result<Vec<u8>> {
    exchange_cancellable(child, input, limit, timeout, &NOT_CANCELLED)
}

#[cfg(test)]
fn exchange_cancellable(
    child: Child,
    input: &[u8],
    limit: usize,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> keyring::Result<Vec<u8>> {
    exchange_operation(child, input, limit, timeout, cancelled, Operation::Read)
}

fn exchange_operation(
    mut child: Child,
    input: &[u8],
    limit: usize,
    timeout: Duration,
    cancelled: &AtomicBool,
    operation: Operation,
) -> keyring::Result<Vec<u8>> {
    let outcome = (|| {
        let mut stdin = Some(child.stdin.take().ok_or_else(unavailable)?);
        let mut stdout = child.stdout.take().ok_or_else(unavailable)?;
        nonblocking(stdin.as_ref().unwrap().as_raw_fd()).map_err(|_| unavailable())?;
        nonblocking(stdout.as_raw_fd()).map_err(|_| unavailable())?;
        let deadline = Instant::now() + timeout;
        let mut written = 0;
        let mut eof = false;
        let mut output = Zeroizing::new(Vec::new());
        loop {
            if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(unavailable());
            }
            if let Some(pipe) = stdin.as_mut() {
                match pipe.write(&input[written..]) {
                    Ok(0) => return Err(unavailable()),
                    Ok(count) => {
                        written += count;
                        if written == input.len() {
                            stdin.take();
                        }
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => return Err(unavailable()),
                }
            }
            let mut buffer = Zeroizing::new([0_u8; 4096]);
            loop {
                match stdout.read(&mut *buffer) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(count) => {
                        if output.len() + count > limit + HEADER {
                            return Err(unavailable());
                        }
                        output.extend_from_slice(&buffer[..count]);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(_) => return Err(unavailable()),
                }
                if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
                    return Err(unavailable());
                }
            }
            if let Some(status) = child.try_wait().map_err(|_| unavailable())? {
                if eof {
                    if !status.success() {
                        return Err(unavailable());
                    }
                    return decode_operation(&output, limit, operation);
                }
            }
            let mut polls = [libc::pollfd {
                fd: stdout.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            }];
            // SAFETY: poll points at one initialized descriptor, with a bounded wait.
            if unsafe { libc::poll(polls.as_mut_ptr(), 1, 10) } < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
            {
                return Err(unavailable());
            }
        }
    })()
    .map(Zeroizing::new);
    // Never block on wait(): a rare unconfirmed SIGKILL retains ownership and
    // consumes capacity, while the caller receives a fixed unavailable error.
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let cleanup_deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if child.try_wait().ok().flatten().is_some() {
            if cancelled.load(Ordering::Acquire) {
                return Err(unavailable());
            }
            return outcome.map(|mut secret| std::mem::take(&mut *secret));
        }
        if Instant::now() >= cleanup_deadline {
            QUARANTINED
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(child);
            return Err(unavailable());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
fn decode(bytes: &[u8], limit: usize) -> keyring::Result<Vec<u8>> {
    decode_operation(bytes, limit, Operation::Read)
}
fn decode_operation(bytes: &[u8], limit: usize, operation: Operation) -> keyring::Result<Vec<u8>> {
    if bytes.len() < HEADER || &bytes[..4] != b"MCR1" {
        return Err(unavailable());
    }
    let length = u32::from_be_bytes(bytes[5..9].try_into().map_err(|_| unavailable())?) as usize;
    if length > limit || bytes.len() != HEADER + length {
        return Err(unavailable());
    }
    match (bytes[4], length) {
        (0, length)
            if (operation == Operation::Read && length > 0)
                || (operation != Operation::Read && length == 0) =>
        {
            Ok(bytes[HEADER..].to_vec())
        }
        (1, 0) if operation != Operation::Write => Err(keyring::Error::NoEntry),
        (2, 0) => Err(keyring::macos::decode_error(
            security_framework::base::Error::from(-25308),
        )),
        _ => Err(unavailable()),
    }
}

fn anonymous_pipe(fd: RawFd) -> bool {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat initializes metadata on success; F_GETPATH receives a full buffer.
    unsafe {
        if libc::fstat(fd, metadata.as_mut_ptr()) != 0 {
            return false;
        }
        if metadata.assume_init().st_mode & libc::S_IFMT != libc::S_IFIFO {
            return false;
        }
        let mut path = [0_u8; libc::MAXPATHLEN as usize];
        libc::fcntl(fd, libc::F_GETPATH, path.as_mut_ptr()) < 0
    }
}

fn running_hash(pid: i32) -> Option<[u8; 20]> {
    // Apple XNU bsd/sys/codesign.h: CS_OPS_CDHASH=5;
    // osfmk/kern/cs_blobs.h: CS_CDHASH_LEN=20 (larger hashes truncated).
    // https://github.com/apple-oss-distributions/xnu
    let mut hash = [0_u8; 20];
    // SAFETY: the kernel writes at most the supplied 20-byte buffer.
    (unsafe { csops(pid, 5, hash.as_mut_ptr().cast(), hash.len()) } == 0
        && hash.iter().any(|byte| *byte != 0))
    .then_some(hash)
}

fn kernel_executable(pid: i32) -> Option<PathBuf> {
    let mut path = [0_u8; libc::MAXPATHLEN as usize];
    // SAFETY: proc_pidpath receives the whole initialized buffer and its size.
    if unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) } <= 0 {
        return None;
    }
    let end = path.iter().position(|byte| *byte == 0)?;
    Path::new(std::ffi::OsStr::from_bytes(&path[..end]))
        .canonicalize()
        .ok()
}

fn expected_app_root(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (executable.is_absolute()
        && macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app")
        .then_some(app)
}

#[cfg(any(not(feature = "fixed-macos-reader"), test))]
fn matching_paths(
    executable: &Path,
    self_executable: &Path,
    parent_executable: &Path,
    self_code: &Path,
    parent_code: &Path,
) -> bool {
    expected_app_root(executable).is_some_and(|root| {
        self_executable == executable
            && parent_executable == executable
            && self_code == root
            && parent_code == root
    })
}

fn parent_is_not_helper(pid: i32) -> bool {
    // Kernel-provided arguments are inspected only for the private role flag,
    // never logged or persisted. A malformed/oversized snapshot fails closed.
    let mut bytes = Zeroizing::new(vec![0_u8; 16 * 1024]);
    let mut length = bytes.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let status = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 || length > bytes.len() {
        return false;
    }
    nonhelper_arguments(&bytes[..length])
}

fn nonhelper_arguments(bytes: &[u8]) -> bool {
    let Some(header) = bytes.get(..4) else {
        return false;
    };
    let argc = i32::from_ne_bytes(header.try_into().expect("four-byte header"));
    if !(1..=64).contains(&argc) {
        return false;
    }
    let Some(path_end) = bytes[4..].iter().position(|byte| *byte == 0) else {
        return false;
    };
    let mut cursor = 4 + path_end;
    while bytes.get(cursor) == Some(&0) {
        cursor += 1;
    }
    for _ in 0..argc {
        let Some(tail) = bytes.get(cursor..) else {
            return false;
        };
        let Some(end) = tail.iter().position(|byte| *byte == 0) else {
            return false;
        };
        if tail[..end].starts_with(FLAG.as_bytes()) {
            return false;
        }
        cursor += end + 1;
    }
    true
}

#[cfg(feature = "fixed-macos-reader")]
mod fixed {
    use super::*;
    use core_foundation::{
        array::CFArray,
        base::CFType,
        data::CFData,
        dictionary::CFDictionary,
        number::CFNumber,
        string::{CFString, CFStringRef},
        url::CFURL,
    };
    use security_framework::{certificate::SecCertificate, os::macos::code_signing::SecStaticCode};
    use security_framework_sys::code_signing::SecStaticCodeRef;
    use sha2::{Digest, Sha256};
    use std::{
        fs::{File, OpenOptions},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    const BROKER: &str = "Contents/Helpers/moxbots-credential-reader";
    const MANIFEST: &str = "Contents/Resources/credential-reader-manifest.json";
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCodeCopySigningInformation(
            code: SecStaticCodeRef,
            flags: u32,
            information: *mut core_foundation::dictionary::CFDictionaryRef,
        ) -> i32;
        static kSecCodeInfoIdentifier: CFStringRef;
        static kSecCodeInfoUnique: CFStringRef;
        static kSecCodeInfoCertificates: CFStringRef;
        static kSecCodeInfoFlags: CFStringRef;
    }
    #[derive(Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub(super) struct Manifest {
        version: u8,
        protocol_version: u8,
        identifier: String,
        parent_identifier: String,
        executable: String,
        sha256: String,
        cdhash: String,
        signing_certificate_sha256: String,
    }
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
    fn hex_valid(value: &str, length: usize) -> bool {
        value.len() == length
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }
    impl Manifest {
        fn valid(&self) -> bool {
            self.version == 1
                && self.protocol_version == 1
                && self.identifier == "com.moxbot.credential-reader"
                && self.parent_identifier == "com.moxbot.app"
                && self.executable == BROKER
                && hex_valid(&self.sha256, 64)
                && hex_valid(&self.cdhash, 40)
                && hex_valid(&self.signing_certificate_sha256, 64)
        }
    }
    struct Signing {
        identifier: String,
        cdhash: Vec<u8>,
        certificate: Vec<u8>,
    }
    fn information(code: &SecStaticCode) -> Option<Signing> {
        let mut result = std::ptr::null();
        // SAFETY: this framework call returns a retained dictionary on success.
        let info: CFDictionary<CFString, CFType> = unsafe {
            if SecCodeCopySigningInformation(code.as_concrete_TypeRef(), 1 << 1, &mut result) != 0
                || result.is_null()
            {
                return None;
            }
            CFDictionary::wrap_under_create_rule(result)
        };
        let get = |key: CFStringRef| -> Option<CFType> {
            info.find(unsafe { CFString::wrap_under_get_rule(key) })
                .map(|value| (*value).clone())
        };
        let flags = get(unsafe { kSecCodeInfoFlags })?
            .downcast::<CFNumber>()?
            .to_i64()?;
        if flags & 2 != 0 {
            return None;
        } // kSecCodeSignatureAdhoc
        let identifier = get(unsafe { kSecCodeInfoIdentifier })?
            .downcast::<CFString>()?
            .to_string();
        let hash = get(unsafe { kSecCodeInfoUnique })?
            .downcast::<CFData>()?
            .bytes()
            .to_vec();
        if hash.len() != 20 {
            return None;
        }
        let raw_certificates = get(unsafe { kSecCodeInfoCertificates })?.downcast::<CFArray>()?;
        // SAFETY: the runtime array type was checked; each element is downcast separately.
        let certificates: CFArray<CFType> =
            unsafe { CFArray::wrap_under_get_rule(raw_certificates.as_concrete_TypeRef()) };
        let leaf = certificates.get(0)?.downcast::<SecCertificate>()?.to_der();
        Some(Signing {
            identifier,
            cdhash: hash,
            certificate: leaf,
        })
    }
    fn checked_code(path: &Path, dynamic: &SecCode, pid: i32) -> Option<Signing> {
        let code = SecStaticCode::from_path(
            &CFURL::from_path(path, path.extension().is_some_and(|e| e == "app"))?,
            Flags::NONE,
        )
        .ok()?;
        let mut requirement = std::ptr::null_mut();
        let requirement = unsafe {
            if SecCodeCopyDesignatedRequirement(
                code.as_concrete_TypeRef().cast(),
                0,
                &mut requirement,
            ) != 0
                || requirement.is_null()
            {
                return None;
            }
            SecRequirement::wrap_under_create_rule(requirement)
        };
        let flags = Flags::STRICT_VALIDATE | Flags::NO_NETWORK_ACCESS;
        code.check_validity(flags, &requirement).ok()?;
        dynamic.check_validity(flags, &requirement).ok()?;
        let info = information(&code)?;
        if running_hash(pid)?.as_slice() != info.cdhash {
            return None;
        }
        Some(info)
    }
    // Open immutable component inputs without following links or blocking on a FIFO.
    fn safe_file(root: &Path, relative: &str, cap: u64) -> Option<File> {
        let uid = unsafe { libc::geteuid() };
        let mut directory = root.to_path_buf();
        for component in Path::new(relative).parent()?.components() {
            let meta = std::fs::symlink_metadata(&directory).ok()?;
            if !meta.is_dir() || meta.mode() & 0o7022 != 0 || (meta.uid() != 0 && meta.uid() != uid)
            {
                return None;
            }
            directory.push(component);
        }
        let meta = std::fs::symlink_metadata(&directory).ok()?;
        if !meta.is_dir() || meta.mode() & 0o7022 != 0 || (meta.uid() != 0 && meta.uid() != uid) {
            return None;
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join(relative))
            .ok()?;
        let meta = file.metadata().ok()?;
        if !meta.is_file()
            || meta.nlink() != 1
            || meta.len() == 0
            || meta.len() > cap
            || meta.mode() & 0o7022 != 0
            || (meta.uid() != 0 && meta.uid() != uid)
        {
            return None;
        }
        Some(file)
    }
    fn verified_manifest(root: &Path) -> Option<Manifest> {
        let mut bytes = Vec::new();
        safe_file(root, MANIFEST, 4096)?
            .take(4097)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 4096 {
            return None;
        }
        let manifest: Manifest = serde_json::from_slice(&bytes).ok()?;
        manifest.valid().then_some(manifest)
    }
    fn broker_static(root: &Path, manifest: &Manifest) -> Option<Signing> {
        let mut file = safe_file(root, BROKER, 64 * 1024 * 1024)?;
        let before = file.metadata().ok()?;
        let mut hasher = Sha256::new();
        let mut bytes = [0_u8; 16384];
        let mut count = 0_u64;
        loop {
            let length = file.read(&mut bytes).ok()?;
            if length == 0 {
                break;
            }
            count += length as u64;
            if count > 64 * 1024 * 1024 {
                return None;
            }
            hasher.update(&bytes[..length]);
        }
        let after = file.metadata().ok()?;
        let namespace = std::fs::symlink_metadata(root.join(BROKER)).ok()?;
        if before.ino() != after.ino()
            || before.dev() != after.dev()
            || before.len() != count
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || namespace.ino() != after.ino()
            || namespace.dev() != after.dev()
            || !namespace.is_file()
            || hex(&hasher.finalize()) != manifest.sha256
        {
            return None;
        }
        let code =
            SecStaticCode::from_path(&CFURL::from_path(root.join(BROKER), false)?, Flags::NONE)
                .ok()?;
        let mut requirement = std::ptr::null_mut();
        let requirement = unsafe {
            if SecCodeCopyDesignatedRequirement(
                code.as_concrete_TypeRef().cast(),
                0,
                &mut requirement,
            ) != 0
                || requirement.is_null()
            {
                return None;
            }
            SecRequirement::wrap_under_create_rule(requirement)
        };
        code.check_validity(
            Flags::STRICT_VALIDATE | Flags::NO_NETWORK_ACCESS,
            &requirement,
        )
        .ok()?;
        let info = information(&code)?;
        (info.identifier == manifest.identifier
            && hex(&info.cdhash) == manifest.cdhash
            && hex(&Sha256::digest(&info.certificate)) == manifest.signing_certificate_sha256)
            .then_some(info)
    }
    pub(super) fn for_parent() -> Option<PathBuf> {
        let executable = std::env::current_exe().ok()?.canonicalize().ok()?;
        let pid = unsafe { libc::getpid() };
        if kernel_executable(pid)? != executable {
            return None;
        }
        let root = expected_app_root(&executable)?;
        if executable != root.join("Contents/MacOS/myagents") {
            return None;
        }
        let current = SecCode::for_self(Flags::NONE).ok()?;
        if current
            .path(Flags::NONE)
            .ok()?
            .to_path()?
            .canonicalize()
            .ok()?
            != root
        {
            return None;
        }
        let parent = checked_code(root, &current, pid)?;
        if parent.identifier != "com.moxbot.app" {
            return None;
        }
        let manifest = verified_manifest(root)?;
        let broker = broker_static(root, &manifest)?;
        if broker.certificate != parent.certificate {
            return None;
        }
        // Revalidate the enclosing seal and closed manifest after component reads.
        let after = checked_code(root, &current, pid)?;
        if after.cdhash != parent.cdhash
            || after.certificate != parent.certificate
            || verified_manifest(root)? != manifest
        {
            return None;
        }
        Some(root.join(BROKER))
    }
    fn roles_match(
        parent_exe: &Path,
        broker_exe: &Path,
        parent_code: &Path,
        broker_code: &Path,
    ) -> bool {
        expected_app_root(parent_exe).is_some_and(|root| {
            parent_exe == root.join("Contents/MacOS/myagents")
                && broker_exe == root.join(BROKER)
                && parent_code == root
                && broker_code == broker_exe
        })
    }
    pub(super) fn trusted() -> bool {
        trusted_inner().is_some()
    }
    fn trusted_inner() -> Option<()> {
        if !anonymous_pipe(0) || !anonymous_pipe(1) {
            return None;
        }
        let (pid, uid, real_uid) = unsafe { (libc::getppid(), libc::geteuid(), libc::getuid()) };
        if pid <= 1 || uid == 0 || uid != real_uid {
            return None;
        }
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        if unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size as i32,
            )
        } != size as i32
        {
            return None;
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid as u32 || info.pbi_uid != uid || info.pbi_ruid != real_uid {
            return None;
        }
        let own = kernel_executable(unsafe { libc::getpid() })?;
        if own != std::env::current_exe().ok()?.canonicalize().ok()? {
            return None;
        }
        let parent_exe = kernel_executable(pid)?;
        let root = expected_app_root(&parent_exe)?;
        if parent_exe != root.join("Contents/MacOS/myagents")
            || own != root.join(BROKER)
            || !parent_is_not_helper(pid)
        {
            return None;
        }
        let current = SecCode::for_self(Flags::NONE).ok()?;
        let mut attributes = GuestAttributes::new();
        attributes.set_pid(pid);
        let parent = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE).ok()?;
        if !roles_match(
            &parent_exe,
            &own,
            &parent
                .path(Flags::NONE)
                .ok()?
                .to_path()?
                .canonicalize()
                .ok()?,
            &current
                .path(Flags::NONE)
                .ok()?
                .to_path()?
                .canonicalize()
                .ok()?,
        ) {
            return None;
        }
        let parent_info = checked_code(root, &parent, pid)?;
        if parent_info.identifier != "com.moxbot.app" {
            return None;
        }
        let manifest = verified_manifest(root)?;
        let disk = broker_static(root, &manifest)?;
        let actual = checked_code(&own, &current, unsafe { libc::getpid() })?;
        if actual.identifier != manifest.identifier
            || actual.cdhash != disk.cdhash
            || actual.certificate != disk.certificate
            || actual.certificate != parent_info.certificate
            || unsafe { libc::getppid() } != pid
        {
            return None;
        }
        let after = checked_code(root, &parent, pid)?;
        if after.cdhash != parent_info.cdhash
            || after.certificate != parent_info.certificate
            || verified_manifest(root)? != manifest
        {
            return None;
        }
        Some(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn fixed_component_does_not_fallback_to_the_current_test_executable() {
            assert!(for_parent().is_none());
        }
        #[test]
        fn component_roles_are_distinct_same_app_not_same_executable() {
            let parent = Path::new("/Applications/Isolated.app/Contents/MacOS/myagents");
            let broker =
                Path::new("/Applications/Isolated.app/Contents/Helpers/moxbots-credential-reader");
            let root = Path::new("/Applications/Isolated.app");
            assert!(roles_match(parent, broker, root, broker));
            assert!(!roles_match(
                Path::new("/usr/bin/node"),
                broker,
                root,
                broker
            ));
            assert!(!roles_match(
                parent,
                Path::new("/Applications/Other.app/Contents/Helpers/moxbots-credential-reader"),
                root,
                broker
            ));
            assert!(!roles_match(parent, parent, root, root));
        }
        #[test]
        fn manifest_is_closed_and_never_redirects_component_or_publisher() {
            let value = serde_json::json!({"version":1,"protocolVersion":1,"identifier":"com.moxbot.credential-reader","parentIdentifier":"com.moxbot.app","executable":BROKER,"sha256":"a".repeat(64),"cdhash":"b".repeat(40),"signingCertificateSha256":"c".repeat(64)});
            assert!(serde_json::from_value::<Manifest>(value.clone())
                .unwrap()
                .valid());
            for key in [
                "identifier",
                "parentIdentifier",
                "executable",
                "sha256",
                "cdhash",
                "signingCertificateSha256",
            ] {
                let mut invalid = value.clone();
                invalid[key] = serde_json::json!("other");
                assert!(!serde_json::from_value::<Manifest>(invalid).unwrap().valid());
            }
            let mut extra = value.clone();
            extra["extra"] = serde_json::json!(true);
            assert!(serde_json::from_value::<Manifest>(extra).is_err());
            let full = serde_json::to_string(&value).unwrap();
            let duplicate = format!("{{\"version\":1,{}", &full[1..]);
            assert!(serde_json::from_str::<Manifest>(&duplicate).is_err());
        }
        #[test]
        fn input_files_reject_symlinks_fifo_hardlinks_and_writable_modes() {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let directory = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(directory.path().join("Contents/Resources")).unwrap();
            let path = directory.path().join(MANIFEST);
            std::fs::write(&path, b"isolated").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert!(safe_file(directory.path(), MANIFEST, 4096).is_some());
            std::fs::hard_link(&path, directory.path().join("other")).unwrap();
            assert!(safe_file(directory.path(), MANIFEST, 4096).is_none());
            std::fs::remove_file(directory.path().join("other")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o622)).unwrap();
            assert!(safe_file(directory.path(), MANIFEST, 4096).is_none());
            std::fs::remove_file(&path).unwrap();
            symlink("missing", &path).unwrap();
            assert!(safe_file(directory.path(), MANIFEST, 4096).is_none());
            std::fs::remove_file(&path).unwrap();
            let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
            let started = Instant::now();
            assert!(safe_file(directory.path(), MANIFEST, 4096).is_none());
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }
}
#[cfg(feature = "fixed-macos-reader")]
fn verified_broker_for_parent() -> Option<PathBuf> {
    fixed::for_parent()
}
#[cfg(feature = "fixed-macos-reader")]
fn trusted_broker_parent() -> bool {
    fixed::trusted()
}

fn trusted_parent() -> bool {
    #[cfg(feature = "fixed-macos-reader")]
    {
        trusted_broker_parent()
    }
    #[cfg(not(feature = "fixed-macos-reader"))]
    {
        legacy_trusted_parent()
    }
}
#[cfg(not(feature = "fixed-macos-reader"))]
fn legacy_trusted_parent() -> bool {
    if !anonymous_pipe(0) || !anonymous_pipe(1) {
        return false;
    }
    // SAFETY: process IDs/UIDs are copied from the kernel, never caller input.
    let (pid, uid, real_uid) = unsafe { (libc::getppid(), libc::geteuid(), libc::getuid()) };
    if pid <= 1 || uid == 0 || uid != real_uid {
        return false;
    }
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let result = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if result != size as i32 {
        return false;
    }
    let info = unsafe { info.assume_init() };
    if info.pbi_pid != pid as u32 || info.pbi_uid != uid || info.pbi_ruid != real_uid {
        return false;
    }
    let Ok(executable) = std::env::current_exe().and_then(|p| p.canonicalize()) else {
        return false;
    };
    let Some(self_executable) = kernel_executable(unsafe { libc::getpid() }) else {
        return false;
    };
    let Some(parent_executable) = kernel_executable(pid) else {
        return false;
    };
    let Ok(current) = SecCode::for_self(Flags::NONE) else {
        return false;
    };
    let mut attributes = GuestAttributes::new();
    attributes.set_pid(pid);
    let Ok(parent) = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE) else {
        return false;
    };
    let Some(parent_path) = parent
        .path(Flags::NONE)
        .ok()
        .and_then(|p| p.to_path())
        .and_then(|p| p.canonicalize().ok())
    else {
        return false;
    };
    let Some(self_path) = current
        .path(Flags::NONE)
        .ok()
        .and_then(|p| p.to_path())
        .and_then(|p| p.canonicalize().ok())
    else {
        return false;
    };
    if !matching_paths(
        &executable,
        &self_executable,
        &parent_executable,
        &self_path,
        &parent_path,
    ) {
        return false;
    }
    let mut requirement = std::ptr::null_mut();
    // SAFETY: Security returns a retained requirement for the actual running code.
    let requirement = unsafe {
        if SecCodeCopyDesignatedRequirement(current.as_concrete_TypeRef(), 0, &mut requirement) != 0
            || requirement.is_null()
        {
            return false;
        }
        SecRequirement::wrap_under_create_rule(requirement)
    };
    let flags = Flags::STRICT_VALIDATE | Flags::NO_NETWORK_ACCESS;
    if current.check_validity(flags, &requirement).is_err()
        || parent.check_validity(flags, &requirement).is_err()
    {
        return false;
    }
    let (Some(current_hash), Some(parent_hash)) =
        (running_hash(unsafe { libc::getpid() }), running_hash(pid))
    else {
        return false;
    };
    current_hash == parent_hash && parent_is_not_helper(pid) && unsafe { libc::getppid() } == pid
}

fn read_input(input: &mut impl Read) -> Option<(Request, Zeroizing<Vec<u8>>)> {
    let mut header = [0_u8; 4];
    input.read_exact(&mut header).ok()?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > INPUT_LIMIT {
        return None;
    }
    let mut body = Zeroizing::new(vec![0; length]);
    input.read_exact(&mut body).ok()?;
    let request: Request = serde_json::from_slice(&body).ok()?;
    let limit = request.validate()?;
    #[cfg(not(feature = "fixed-macos-reader"))]
    let _ = limit;
    let payload = {
        #[cfg(feature = "fixed-macos-reader")]
        {
            let mut length = [0_u8; 4];
            input.read_exact(&mut length).ok()?;
            let length = u32::from_be_bytes(length) as usize;
            if length > limit
                || (request.operation == Operation::Write && length == 0)
                || (request.operation != Operation::Write && length != 0)
            {
                return None;
            }
            let mut payload = Zeroizing::new(vec![0; length]);
            input.read_exact(&mut payload).ok()?;
            payload
        }
        #[cfg(not(feature = "fixed-macos-reader"))]
        {
            if request.operation != Operation::Read {
                return None;
            }
            Zeroizing::new(Vec::<u8>::new())
        }
    };
    if input.read(&mut [0_u8; 1]).ok()? != 0 {
        return None;
    }
    Some((request, payload))
}

/// Called before normal App/CLI startup. A private flag never falls through to
/// GUI startup, even if malformed or called by an untrusted process.
pub fn run_private_credential_helper(args: &[String]) -> Option<i32> {
    if !args.iter().any(|arg| arg.starts_with(FLAG)) {
        return None;
    }
    HELPER_MODE.store(true, Ordering::Release);
    if args.len() != 1 || args[0] != FLAG || !trusted_parent() {
        return Some(2);
    }
    let execute = || -> Option<()> {
        let (request, payload) = read_input(&mut std::io::stdin().lock())?;
        #[cfg(not(feature = "fixed-macos-reader"))]
        let _ = &payload;
        let limit = request.validate()?;
        // The global switch is confined to this private child and never restored
        // into a main-process state. All child paths terminate immediately.
        if unsafe {
            security_framework_sys::keychain::SecKeychainSetUserInteractionAllowed(u8::from(
                request.mode == ReadMode::Authorize,
            ))
        } != 0
        {
            return None;
        }
        let credential =
            MacCredential::new_with_target(Some("User"), &request.service, &request.account)
                .ok()?;
        let result = match request.operation {
            Operation::Read => super::macos_credential::read_direct(&credential, request.mode),
            #[cfg(feature = "fixed-macos-reader")]
            Operation::Write => {
                super::macos_credential::write_direct(&credential, &payload).map(|_| Vec::new())
            }
            #[cfg(feature = "fixed-macos-reader")]
            Operation::Delete => {
                super::macos_credential::delete_direct(&credential).map(|_| Vec::new())
            }
            #[cfg(not(feature = "fixed-macos-reader"))]
            _ => Err(unavailable()),
        };
        let (status, secret) = match result {
            Ok(secret) => {
                let secret = Zeroizing::new(secret);
                if secret.len() <= limit
                    && ((request.operation == Operation::Read && !secret.is_empty())
                        || (request.operation != Operation::Read && secret.is_empty()))
                {
                    (0, secret)
                } else {
                    (3, Zeroizing::new(Vec::new()))
                }
            }
            Err(keyring::Error::NoEntry) if request.operation != Operation::Write => {
                (1, Zeroizing::new(Vec::new()))
            }
            Err(error) if super::macos_credential::credential_authorization_required(&error) => {
                (2, Zeroizing::new(Vec::new()))
            }
            _ => (3, Zeroizing::new(Vec::new())),
        };
        let mut output = std::io::stdout().lock();
        output.write_all(b"MCR1").ok()?;
        output.write_all(&[status]).ok()?;
        output
            .write_all(&(secret.len() as u32).to_be_bytes())
            .ok()?;
        output.write_all(&secret).ok()?;
        output.flush().ok()?;
        Some(())
    };
    Some(if execute().is_some() { 0 } else { 2 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_code_root_and_kernel_executable_are_distinct_required_projections() {
        let executable = Path::new("/Applications/Isolated.app/Contents/MacOS/Isolated");
        let root = Path::new("/Applications/Isolated.app");
        assert!(matching_paths(
            executable, executable, executable, root, root
        ));
        assert!(!matching_paths(
            executable, executable, executable, executable, executable
        ));
        assert!(!matching_paths(
            executable,
            executable,
            Path::new("/usr/bin/node"),
            root,
            root
        ));
        assert!(!matching_paths(
            executable,
            executable,
            executable,
            root,
            Path::new("/Applications/Other.app")
        ));
        assert!(expected_app_root(Path::new("/tmp/Isolated")).is_none());
        let pid = unsafe { libc::getpid() };
        assert_eq!(
            kernel_executable(pid),
            Some(std::env::current_exe().unwrap().canonicalize().unwrap())
        );
    }
    #[test]
    fn explicit_authorization_is_closed_and_cancel_kills_owned_child() {
        let mut value = serde_json::to_value(request()).unwrap();
        value["mode"] = serde_json::json!("authorize");
        assert!(serde_json::from_value::<Request>(value.clone()).is_ok());
        value["mode"] = serde_json::json!("allowAll");
        assert!(serde_json::from_value::<Request>(value).is_err());
        assert_eq!(ReadMode::Background.deadline(), Duration::from_secs(5));
        assert_eq!(ReadMode::Authorize.deadline(), Duration::from_secs(180));
        let cancelled = AtomicBool::new(false);
        let process = child("/bin/sleep", &["10"]);
        let pid = process.id() as libc::pid_t;
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(60));
                cancelled.store(true, Ordering::Release);
            });
            assert!(exchange_cancellable(
                process,
                b"input",
                32,
                Duration::from_secs(180),
                &cancelled
            )
            .is_err());
        });
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    #[cfg(feature = "fixed-macos-reader")]
    #[test]
    fn actual_input_decoder_bounds_payload_and_authorization_is_read_only() {
        fn input(request: &Request, secret: &[u8]) -> Vec<u8> {
            let json = serde_json::to_vec(request).unwrap();
            let mut bytes = (json.len() as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(&json);
            bytes.extend_from_slice(&(secret.len() as u32).to_be_bytes());
            bytes.extend_from_slice(secret);
            bytes
        }
        let mut value = request();
        value.operation = Operation::Write;
        let payload = [0, 255, 1, 2];
        let bytes = input(&value, &payload);
        let (decoded, actual) = read_input(&mut std::io::Cursor::new(bytes.clone())).unwrap();
        assert!(decoded.operation == Operation::Write);
        assert_eq!(*actual, payload);
        assert!(read_input(&mut std::io::Cursor::new(input(&value, &[]))).is_none());
        value.mode = ReadMode::Authorize;
        assert!(read_input(&mut std::io::Cursor::new(input(&value, &payload))).is_none());
        value.mode = ReadMode::Background;
        value.operation = Operation::Read;
        assert!(read_input(&mut std::io::Cursor::new(input(&value, &payload))).is_none());
        let mut extra = input(&value, &[]);
        extra.push(0);
        assert!(read_input(&mut std::io::Cursor::new(extra)).is_none());
        assert!(read_input(&mut std::io::Cursor::new(&bytes[..bytes.len() - 1])).is_none());
        value.operation = Operation::Write;
        value.service = "MyAgents.AgentNetwork.v1".into();
        value.account = URL_SAFE_NO_PAD.encode([1; 32]);
        assert!(read_input(&mut std::io::Cursor::new(input(
            &value,
            &vec![0; KEY_LIMIT + 1]
        )))
        .is_none());
    }
    #[test]
    fn mutation_ack_requires_empty_complete_frame_and_successful_exit() {
        assert!(decode_operation(&frame(0, &[]), 32, Operation::Write).is_ok());
        assert!(matches!(
            decode_operation(&frame(1, &[]), 32, Operation::Read),
            Err(keyring::Error::NoEntry)
        ));
        assert!(!matches!(
            decode_operation(&frame(1, &[]), 32, Operation::Write),
            Err(keyring::Error::NoEntry)
        ));
        assert!(decode_operation(&frame(0, &[]), 32, Operation::Read).is_err());
        assert!(decode_operation(&frame(0, b"unexpected"), 32, Operation::Write).is_err());
        let successful = child(
            "/bin/sh",
            &[
                "-c",
                "cat >/dev/null; printf 'MCR1\\000\\000\\000\\000\\000'",
            ],
        );
        assert!(exchange_operation(
            successful,
            &[0, 255, 1],
            32,
            Duration::from_secs(2),
            &NOT_CANCELLED,
            Operation::Write
        )
        .is_ok());
        let incomplete = child("/bin/sh", &["-c", "printf 'MCR1'; exit 0"]);
        assert!(exchange_operation(
            incomplete,
            &[0],
            32,
            Duration::from_secs(2),
            &NOT_CANCELLED,
            Operation::Write
        )
        .is_err());
        let failed = child(
            "/bin/sh",
            &["-c", "printf 'MCR1\\000\\000\\000\\000\\000'; exit 1"],
        );
        assert!(exchange_operation(
            failed,
            &[0],
            32,
            Duration::from_secs(2),
            &NOT_CANCELLED,
            Operation::Write
        )
        .is_err());
    }
    fn request() -> Request {
        Request {
            version: 1,
            mode: ReadMode::Background,
            operation: Operation::Read,
            service: "com.myagents.owned-agentnet.v1".into(),
            account: format!("session:{}", URL_SAFE_NO_PAD.encode([1_u8; 32])),
            domain: "User".into(),
        }
    }
    fn frame(status: u8, bytes: &[u8]) -> Vec<u8> {
        let mut result = b"MCR1".to_vec();
        result.push(status);
        result.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        result.extend_from_slice(bytes);
        result
    }
    #[allow(clippy::disallowed_methods)] // macOS-only owned test children, with no desktop crate dependency.
    fn child(program: &str, args: &[&str]) -> Child {
        Command::new(program)
            .args(args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    #[test]
    fn request_scope_is_closed_and_hash_is_canonical() {
        let mut value = request();
        assert_eq!(value.validate(), Some(SESSION_LIMIT));
        value.service = "other.secret.owner".into();
        assert_eq!(value.validate(), None);
        value.service = "MyAgents.AgentNetwork.v1".into();
        value.account = URL_SAFE_NO_PAD.encode([2_u8; 32]);
        assert_eq!(value.validate(), Some(KEY_LIMIT));
        value.domain = "System".into();
        assert_eq!(value.validate(), None);
        value.domain = "User".into();
        value.account.push('=');
        assert_eq!(value.validate(), None);
        let encoded = serde_json::to_string(&request()).unwrap();
        let extra = encoded.replace(
            "\"version\":1",
            "\"version\":1,\"credential\":\"untrusted\"",
        );
        assert!(serde_json::from_str::<Request>(&extra).is_err());
        let duplicate = encoded.replace("\"version\":1", "\"version\":1,\"version\":1");
        assert!(serde_json::from_str::<Request>(&duplicate).is_err());
    }
    #[test]
    fn response_errors_and_truncation_never_become_missing() {
        assert_eq!(
            decode(&frame(0, b"isolated-fixture"), 32).unwrap(),
            b"isolated-fixture"
        );
        assert!(matches!(
            decode(&frame(1, b""), 32),
            Err(keyring::Error::NoEntry)
        ));
        assert!(
            super::super::macos_credential::credential_authorization_required(
                &decode(&frame(2, b""), 32).unwrap_err()
            )
        );
        for bytes in [
            frame(0, b""),
            frame(0, &[0; 33]),
            frame(9, b""),
            frame(1, b"not-empty"),
            b"MCR1".to_vec(),
        ] {
            assert!(!matches!(decode(&bytes, 32), Err(keyring::Error::NoEntry)));
            assert!(decode(&bytes, 32).is_err());
        }
        let mut truncated = frame(0, b"payload");
        truncated.pop();
        assert!(decode(&truncated, 32).is_err());
    }
    #[test]
    fn stuck_child_is_killed_and_reaped_on_deadline() {
        let child = child("/bin/sleep", &["10"]);
        let pid = child.id();
        let started = Instant::now();
        assert!(exchange(child, b"input", 32, Duration::from_millis(100)).is_err());
        assert!(started.elapsed() >= Duration::from_millis(100));
        // SAFETY: signal 0 only checks liveness; no signal is delivered.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    #[test]
    fn full_output_pipe_is_drained_and_over_capacity_child_reaped() {
        let producer = child("/usr/bin/yes", &["isolated-fixture"]);
        let pid = producer.id();
        assert!(exchange(producer, b"input", 32, Duration::from_secs(2)).is_err());
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        // A frame bigger than the pipe capacity must not deadlock wait-before-read.
        let producer = child(
            "/bin/sh",
            &[
                "-c",
                "printf 'MCR1\\000\\000\\001\\000\\000'; /usr/bin/head -c 65536 /dev/zero",
            ],
        );
        assert_eq!(
            exchange(producer, b"input", SESSION_LIMIT, Duration::from_secs(2))
                .unwrap()
                .len(),
            65536
        );
    }
    #[test]
    fn truncated_child_output_fails_closed() {
        let producer = child("/bin/sh", &["-c", "printf 'MCR1'"]);
        assert!(!matches!(
            exchange(producer, b"input", 32, Duration::from_secs(2)),
            Err(keyring::Error::NoEntry)
        ));
    }
    #[test]
    fn complete_input_is_closed_before_waiting_for_a_response() {
        let producer = child(
            "/bin/sh",
            &[
                "-c",
                "/bin/cat >/dev/null; printf 'MCR1\\000\\000\\000\\000\\006sample'",
            ],
        );
        assert_eq!(
            exchange(
                producer,
                b"complete bounded input",
                32,
                Duration::from_secs(2)
            )
            .unwrap(),
            b"sample"
        );
    }
    #[test]
    fn reader_queue_is_bounded_without_spawning() {
        let slots: Vec<_> = (0..CONCURRENT)
            .map(|_| ReaderSlot::acquire().unwrap())
            .collect();
        assert!(ReaderSlot::acquire().is_none());
        drop(slots);
        assert!(ReaderSlot::acquire().is_some());
    }
    #[test]
    fn helper_parent_role_is_rejected_from_closed_kernel_argument_snapshot() {
        let snapshot = |args: &[&str]| {
            let mut bytes = (args.len() as i32).to_ne_bytes().to_vec();
            bytes.extend_from_slice(b"/isolated/App.app/Contents/MacOS/App\0\0");
            for arg in args {
                bytes.extend_from_slice(arg.as_bytes());
                bytes.push(0);
            }
            bytes
        };
        assert!(nonhelper_arguments(&snapshot(&["App"])));
        assert!(!nonhelper_arguments(&snapshot(&["App", FLAG])));
        assert!(!nonhelper_arguments(&snapshot(&[
            "App",
            &format!("{FLAG}=invalid")
        ])));
        let mut truncated = snapshot(&["App"]);
        truncated.pop();
        assert!(!nonhelper_arguments(&truncated));
    }
    #[test]
    fn private_flag_cannot_fall_through_or_accept_test_binary_parent() {
        assert_eq!(run_private_credential_helper(&["ordinary".into()]), None);
        assert_eq!(
            run_private_credential_helper(&[FLAG.into(), "extra".into()]),
            Some(2)
        );
        assert_eq!(
            run_private_credential_helper(&[format!("{FLAG}=invalid")]),
            Some(2)
        );
        assert_eq!(run_private_credential_helper(&[FLAG.into()]), Some(2));
        HELPER_MODE.store(false, Ordering::Release);
    }
}
