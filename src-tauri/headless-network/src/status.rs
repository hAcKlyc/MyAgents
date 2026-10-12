use crate::agent_network::NetworkError;
use serde::{Deserialize, Serialize};
use std::{
    ffi::CString,
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Component, Path},
    sync::LazyLock,
};
static INSTANCE: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status<'a> {
    pub state: &'a str,
    pub device_id: &'a str,
    pub network_id: Option<&'a str>,
    pub ready: bool,
    pub error_code: Option<&'a str>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Projection {
    state: String,
    device_id: String,
    network_id: Option<String>,
    ready: bool,
    error_code: Option<String>,
    updated_at: u64,
    pid: u32,
    instance_id: String,
}
fn directory(path: &Path) -> Result<File, NetworkError> {
    if !path.is_absolute() {
        return Err(NetworkError::new("STATUS_PATH_UNSAFE"));
    }
    let mut handle = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if handle < 0 {
        return Err(NetworkError::new("STATUS_UNAVAILABLE"));
    }
    let mut file = unsafe { File::from_raw_fd(handle) };
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(value) => {
                let name = CString::new(value.as_bytes())
                    .map_err(|_| NetworkError::new("STATUS_PATH_UNSAFE"))?;
                handle = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if handle < 0 {
                    return Err(NetworkError::new("STATUS_PATH_UNSAFE"));
                }
                file = unsafe { File::from_raw_fd(handle) };
            }
            _ => return Err(NetworkError::new("STATUS_PATH_UNSAFE")),
        }
    }
    Ok(file)
}
pub(crate) fn write(path: Option<&Path>, status: &Status<'_>) -> Result<(), NetworkError> {
    let Some(path) = path else {
        return Ok(());
    };
    let parent = path
        .parent()
        .ok_or_else(|| NetworkError::new("STATUS_PATH_UNSAFE"))?;
    let directory = directory(parent)?;
    let m = directory
        .metadata()
        .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
    if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o027 != 0 {
        return Err(NetworkError::new("STATUS_PATH_UNSAFE"));
    }
    let name = CString::new(
        path.file_name()
            .ok_or_else(|| NetworkError::new("STATUS_PATH_UNSAFE"))?
            .as_bytes(),
    )
    .map_err(|_| NetworkError::new("STATUS_PATH_UNSAFE"))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(NetworkError::new("STATUS_PATH_UNSAFE"));
    }
    let old = unsafe { File::from_raw_fd(fd) };
    let m = old
        .metadata()
        .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o7777 != 0o640
        || m.nlink() != 1
    {
        return Err(NetworkError::new("STATUS_PATH_UNSAFE"));
    }
    let data = Projection {
        state: status.state.into(),
        device_id: status.device_id.into(),
        network_id: status.network_id.map(str::to_owned),
        ready: status.ready,
        error_code: status.error_code.map(str::to_owned),
        updated_at: jsonwebtoken::get_current_timestamp(),
        pid: std::process::id(),
        instance_id: INSTANCE.clone(),
    };
    let bytes = serde_json::to_vec(&data).map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
    if bytes.len() > 2048 {
        return Err(NetworkError::new("STATUS_UNAVAILABLE"));
    }
    let tmp = CString::new(format!(".status-{}", uuid::Uuid::new_v4())).unwrap();
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            tmp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o640,
        )
    };
    if fd < 0 {
        return Err(NetworkError::new("STATUS_UNAVAILABLE"));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        let temporary_meta = file
            .metadata()
            .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
        if temporary_meta.uid() != unsafe { libc::geteuid() }
            || temporary_meta.gid() != m.gid()
            || unsafe { libc::fchmod(fd, 0o640) } != 0
        {
            return Err(NetworkError::new("STATUS_UNAVAILABLE"));
        }
        file.write_all(&bytes)
            .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
        file.sync_all()
            .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
        if unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                tmp.as_ptr(),
                directory.as_raw_fd(),
                name.as_ptr(),
            )
        } != 0
        {
            return Err(NetworkError::new("STATUS_UNAVAILABLE"));
        }
        directory
            .sync_all()
            .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))
    })();
    unsafe {
        libc::unlinkat(directory.as_raw_fd(), tmp.as_ptr(), 0);
    }
    result
}
pub(crate) fn read(path: &Path) -> Result<serde_json::Value, NetworkError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
    let mut bytes = Vec::new();
    file.take(2049)
        .read_to_end(&mut bytes)
        .map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
    if bytes.len() > 2048 {
        return Err(NetworkError::new("STATUS_UNAVAILABLE"));
    }
    let mut value: Projection =
        serde_json::from_slice(&bytes).map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))?;
    let now = jsonwebtoken::get_current_timestamp();
    if value.updated_at > now + 5 || now.saturating_sub(value.updated_at) > 30 {
        value.ready = false;
        value.state = "stale".into();
        value.error_code = Some("STATUS_STALE".into());
    }
    serde_json::to_value(value).map_err(|_| NetworkError::new("STATUS_UNAVAILABLE"))
}
pub(crate) fn run_lock(root: &Path) -> Result<File, NetworkError> {
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root.join("connector.lock"))
        .map_err(|_| NetworkError::new("OWNER_LOCK_UNAVAILABLE"))?;
    let m = f
        .metadata()
        .map_err(|_| NetworkError::new("OWNER_LOCK_UNAVAILABLE"))?;
    if !m.is_file()
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
    {
        return Err(NetworkError::new("OWNER_LOCK_UNSAFE"));
    }
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(NetworkError::new("OWNER_ALREADY_RUNNING"));
    }
    Ok(f)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn atomic_nonsecret_projection_has_freshness_and_rejects_secret_shape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o750)).unwrap();
        let path = root.join("status.json");
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let old = std::fs::metadata(&path).unwrap().ino();
        let s = Status {
            state: "ready",
            device_id: "53a286cf-bfa4-41e9-a14d-4cb5b7f19224",
            network_id: Some("11111111-1111-4111-8111-111111111111"),
            ready: true,
            error_code: None,
        };
        write(Some(&path), &s).unwrap();
        assert_ne!(std::fs::metadata(&path).unwrap().ino(), old);
        let v = read(&path).unwrap();
        assert_eq!(v["ready"], true);
        assert!(v["updatedAt"].is_u64());
        assert_eq!(v["pid"], std::process::id());
        assert!(uuid::Uuid::parse_str(v["instanceId"].as_str().unwrap()).is_ok());
        let mut projection: Projection = serde_json::from_value(v).unwrap();
        projection.updated_at = 1;
        std::fs::write(&path, serde_json::to_vec(&projection).unwrap()).unwrap();
        assert_eq!(read(&path).unwrap()["ready"], false);
        std::fs::write(&path, br#"{"token":"must-not-escape"}"#).unwrap();
        assert_eq!(read(&path).unwrap_err().code, "STATUS_UNAVAILABLE");
    }
    #[test]
    fn status_and_owner_lock_reject_unsafe_permissions_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o750)).unwrap();
        let path = root.join("status.json");
        let target = root.join("target.json");
        std::fs::write(&target, b"{}").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let s = Status {
            state: "stopped",
            device_id: "x",
            network_id: None,
            ready: false,
            error_code: None,
        };
        assert!(write(Some(&path), &s).is_err());
        let lock = run_lock(&root).unwrap();
        assert_eq!(run_lock(&root).unwrap_err().code, "OWNER_ALREADY_RUNNING");
        drop(lock);
        assert!(run_lock(&root).is_ok());
    }
}
