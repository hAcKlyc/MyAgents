//! The QA binary and its existing env-cleared reader share one compiled HOME.
//! This validates metadata only; it never creates/unlocks/selects a Keychain.
use std::{
    env,
    ffi::c_void,
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const READER_FLAG: &str = "--internal-moxbots-credential-reader-v1";
type Checked<T> = Result<T, &'static str>;

fn select_home<'a>(compiled: &'a str, runtime: Option<&str>, args: &[String]) -> Checked<&'a str> {
    let suffix = compiled
        .strip_prefix("/private/tmp/moxbots-modelqa-")
        .unwrap_or("");
    if suffix.is_empty()
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("invalid compiled QA HOME");
    }
    let helper = args.len() == 1 && args[0] == READER_FLAG;
    if args.iter().any(|arg| arg.starts_with(READER_FLAG)) && !helper {
        return Err("invalid private helper arguments");
    }
    match runtime {
        Some(value) if value == compiled => Ok(compiled),
        None if helper => Ok(compiled),
        _ => Err("QA HOME does not match this artifact"),
    }
}

fn physical(path: &Path, directory: bool, owner: u32) -> Checked<fs::Metadata> {
    let meta = fs::symlink_metadata(path).map_err(|_| "missing private metadata")?;
    if meta.file_type().is_symlink()
        || meta.uid() != owner
        || (directory && (!meta.is_dir() || meta.mode() & 0o077 != 0))
        || (!directory && (!meta.is_file() || meta.nlink() != 1 || meta.mode() & 0o077 != 0))
        || fs::canonicalize(path).map_err(|_| "noncanonical private path")? != path
    {
        return Err("unsafe private metadata");
    }
    Ok(meta)
}

fn private_directories(home: &Path) -> Checked<()> {
    // SAFETY: geteuid has no arguments or memory ownership requirements.
    let owner = unsafe { libc::geteuid() };
    for path in [
        home.to_path_buf(),
        home.join("Library"),
        home.join("Library/Preferences"),
        home.join("Library/Keychains"),
    ] {
        physical(&path, true, owner)?;
    }
    let prefs = home.join("Library/Preferences/com.apple.security.plist");
    match fs::symlink_metadata(&prefs) {
        Ok(meta)
            if meta.file_type().is_symlink()
                || !meta.is_file()
                || meta.uid() != owner
                || meta.nlink() != 1
                || meta.mode() & 0o022 != 0 =>
        {
            return Err("unsafe private preferences")
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("unreadable private preferences"),
    }
    Ok(())
}

fn check_default(home: &Path, resolve: impl FnOnce() -> Checked<PathBuf>) -> Checked<()> {
    private_directories(home)?;
    let path = resolve()?;
    if path.parent() != Some(home.join("Library/Keychains").as_path()) {
        return Err("QA default Keychain escaped private HOME");
    }
    // SAFETY: geteuid only returns the calling process's effective UID.
    physical(&path, false, unsafe { libc::geteuid() })?;
    Ok(())
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainCopyDomainDefault(domain: i32, keychain: *mut *mut c_void) -> i32;
    fn SecKeychainGetPath(keychain: *mut c_void, length: *mut u32, path: *mut u8) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const c_void);
}
struct DefaultKeychain(*mut c_void);
impl Drop for DefaultKeychain {
    fn drop(&mut self) {
        // SAFETY: this owns the retained non-null result of CopyDomainDefault.
        unsafe { CFRelease(self.0) };
    }
}
fn actual_user_default() -> Checked<PathBuf> {
    let mut handle = std::ptr::null_mut();
    // SAFETY: User domain is 0; the output pointer is valid and exclusively owned.
    if unsafe { SecKeychainCopyDomainDefault(0, &mut handle) } != 0 || handle.is_null() {
        return Err("private user default Keychain unavailable");
    }
    let handle = DefaultKeychain(handle);
    let mut buffer = [0u8; 4096];
    let mut length = buffer.len() as u32;
    // SAFETY: handle is retained; buffer and length outlive the bounded call.
    if unsafe { SecKeychainGetPath(handle.0, &mut length, buffer.as_mut_ptr()) } != 0 {
        return Err("private default Keychain path unavailable");
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("invalid Keychain path")?;
    let text = std::str::from_utf8(&buffer[..end]).map_err(|_| "invalid Keychain path")?;
    Ok(PathBuf::from(text))
}

/// Called before every QA parent credential mutation as well as helper startup.
pub fn assert_private_default() -> Checked<()> {
    let runtime = env::var("HOME").map_err(|_| "QA HOME missing")?;
    let home = select_home(env!("MOXBOTS_MODELQA_HOME"), Some(&runtime), &[])?;
    check_default(Path::new(home), actual_user_default)
}

/// Called once, while main is still single-threaded, before the existing reader.
pub fn prepare_startup(args: &[String]) -> Checked<()> {
    let runtime = match env::var("HOME") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid QA HOME encoding"),
    };
    let home = select_home(env!("MOXBOTS_MODELQA_HOME"), runtime.as_deref(), args)?;
    private_directories(Path::new(home))?;
    if runtime.is_none() {
        // Only the exact existing reader may restore the compiled HOME. No
        // threads, Security calls, CLI or GUI have started in this process yet.
        env::set_var("HOME", home);
    }
    assert_private_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::atomic::{AtomicUsize, Ordering},
    };
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("moxbots-modelqa-guard-")
            .tempdir_in("/private/tmp")
            .unwrap();
        for path in [
            dir.path().to_path_buf(),
            dir.path().join("Library"),
            dir.path().join("Library/Preferences"),
            dir.path().join("Library/Keychains"),
        ] {
            if !path.exists() {
                fs::create_dir(&path).unwrap();
            }
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let keychain = dir.path().join("Library/Keychains/synthetic.keychain-db");
        fs::write(&keychain, b"synthetic; never a credential").unwrap();
        fs::set_permissions(&keychain, fs::Permissions::from_mode(0o600)).unwrap();
        (dir, keychain)
    }
    #[test]
    fn only_exact_helper_with_missing_home_can_restore_compiled_home() {
        let h = "/private/tmp/moxbots-modelqa-unit";
        assert_eq!(select_home(h, None, &[READER_FLAG.into()]), Ok(h));
        assert_eq!(select_home(h, Some(h), &[]), Ok(h));
        for args in [
            vec![],
            vec!["--help".into()],
            vec![format!("{READER_FLAG}-suffix")],
            vec![READER_FLAG.into(), "extra".into()],
        ] {
            assert!(select_home(h, None, &args).is_err());
        }
        for value in ["", "/Users/daily", "/private/tmp/moxbots-modelqa-other"] {
            assert!(select_home(h, Some(value), &[READER_FLAG.into()]).is_err());
        }
        for compiled in [
            "",
            "/Users/daily",
            "/private/tmp/moxbots-modelqa-x/../y",
            "/private/tmp/moxbots-modelqa-x\ncargo:injected",
            "/private/tmp/moxbots-modelqa-x\0",
        ] {
            assert!(select_home(compiled, Some(compiled), &[]).is_err());
        }
    }
    #[test]
    fn real_default_metadata_rejects_escape_missing_links_mode_and_owner() {
        let (dir, path) = fixture();
        assert!(check_default(dir.path(), || Ok(path.clone())).is_ok());
        assert!(check_default(dir.path(), || Err("no default")).is_err());
        assert!(check_default(dir.path(), || Ok(PathBuf::from(
            "/Users/daily/Library/Keychains/login.keychain-db"
        )))
        .is_err());
        let link = path.with_file_name("linked.keychain-db");
        symlink(&path, &link).unwrap();
        assert!(check_default(dir.path(), || Ok(link)).is_err());
        let hard = path.with_file_name("hard.keychain-db");
        fs::hard_link(&path, &hard).unwrap();
        assert!(check_default(dir.path(), || Ok(path.clone())).is_err());
        fs::remove_file(hard).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(check_default(dir.path(), || Ok(path.clone())).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(physical(&path, false, unsafe { libc::geteuid() } + 1).is_err());
        fs::set_permissions(
            dir.path().join("Library"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(check_default(dir.path(), || Ok(path)).is_err());
    }
    #[test]
    fn default_drift_is_rejected_again_before_a_parent_mutation() {
        let (dir, path) = fixture();
        let writes = AtomicUsize::new(0);
        check_default(dir.path(), || Ok(path)).unwrap();
        let result = check_default(dir.path(), || {
            Ok(PathBuf::from(
                "/Users/daily/Library/Keychains/login.keychain-db",
            ))
        });
        if result.is_ok() {
            writes.fetch_add(1, Ordering::Relaxed);
        }
        assert!(result.is_err());
        assert_eq!(writes.load(Ordering::Relaxed), 0);
    }
}
