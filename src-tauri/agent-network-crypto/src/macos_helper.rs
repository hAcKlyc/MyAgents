//! Private same-executable credential reader. Secret bytes never enter argv,
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    mode: ReadMode,
    service: String,
    account: String,
    domain: String,
}
impl Request {
    fn validate(&self) -> Option<usize> {
        if self.version != 1 || self.domain != "User" {
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
    if cancelled.load(Ordering::Acquire)
        || HELPER_MODE.load(Ordering::Acquire)
        || credential.domain != MacKeychainDomain::User
    {
        return Err(unavailable());
    }
    let request = Request {
        version: 1,
        mode,
        service: credential.service.clone(),
        account: credential.account.clone(),
        domain: "User".into(),
    };
    let limit = request.validate().ok_or_else(unavailable)?;
    let _slot = ReaderSlot::acquire().ok_or_else(unavailable)?;
    let bytes = Zeroizing::new(serde_json::to_vec(&request).map_err(|_| unavailable())?);
    if bytes.len() > INPUT_LIMIT {
        return Err(unavailable());
    }
    let mut input = Zeroizing::new((bytes.len() as u32).to_be_bytes().to_vec());
    input.extend_from_slice(&bytes);
    let deadline = Instant::now() + mode.deadline();
    let executable = std::env::current_exe().map_err(|_| unavailable())?;
    let child = Command::new(executable)
        .arg(FLAG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| unavailable())?;
    exchange_cancellable(
        child,
        &input,
        limit,
        deadline.saturating_duration_since(Instant::now()),
        cancelled,
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

fn exchange_cancellable(
    mut child: Child,
    input: &[u8],
    limit: usize,
    timeout: Duration,
    cancelled: &AtomicBool,
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
                    return decode(&output, limit);
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

fn decode(bytes: &[u8], limit: usize) -> keyring::Result<Vec<u8>> {
    if bytes.len() < HEADER || &bytes[..4] != b"MCR1" {
        return Err(unavailable());
    }
    let length = u32::from_be_bytes(bytes[5..9].try_into().map_err(|_| unavailable())?) as usize;
    if length > limit || bytes.len() != HEADER + length {
        return Err(unavailable());
    }
    match (bytes[4], length) {
        (0, length) if length > 0 => Ok(bytes[HEADER..].to_vec()),
        (1, 0) => Err(keyring::Error::NoEntry),
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

fn trusted_parent() -> bool {
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
        let mut input = std::io::stdin().lock();
        let mut header = [0_u8; 4];
        input.read_exact(&mut header).ok()?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > INPUT_LIMIT {
            return None;
        }
        let mut body = Zeroizing::new(vec![0; length]);
        input.read_exact(&mut body).ok()?;
        if input.read(&mut [0_u8; 1]).ok()? != 0 {
            return None;
        }
        let request: Request = serde_json::from_slice(&body).ok()?;
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
        let result = super::macos_credential::read_direct(&credential, request.mode);
        let (status, secret) = match result {
            Ok(secret) => {
                let secret = Zeroizing::new(secret);
                if !secret.is_empty() && secret.len() <= limit {
                    (0, secret)
                } else {
                    (3, Zeroizing::new(Vec::new()))
                }
            }
            Err(keyring::Error::NoEntry) => (1, Zeroizing::new(Vec::new())),
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
    fn request() -> Request {
        Request {
            version: 1,
            mode: ReadMode::Background,
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
