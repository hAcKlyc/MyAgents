use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: Option<String>,
    pub platform: String,
    pub os_version: Option<String>,
    pub app_version: String,
}

pub fn get_or_create_device_id() -> Result<String, String> {
    get_or_create_device_id_at(device_id_path()?)
}

fn get_or_create_device_id_at(device_id_file: PathBuf) -> Result<String, String> {
    if let Some(id) = read_existing_device_id(&device_id_file) {
        return Ok(id);
    }

    let lock_path = device_id_file.with_file_name("device_id.lock");
    crate::utils::file_lock::with_file_lock_blocking(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        || {
            if let Some(id) = read_existing_device_id(&device_id_file) {
                return Ok(id);
            }

            let new_id = uuid::Uuid::new_v4().to_string();
            if let Some(parent) = device_id_file.parent() {
                fs::create_dir_all(parent).map_err(crate::utils::file_lock::FileLockError::Io)?;
            }
            fs::write(&device_id_file, &new_id)
                .map_err(crate::utils::file_lock::FileLockError::Io)?;
            Ok(new_id)
        },
    )
    .map_err(String::from)
}

fn read_existing_device_id(path: &Path) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(id) => {
            let id = id.trim().to_string();
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        }
        Err(_) => {
            // Regenerate below. This matches the legacy command behavior.
            None
        }
    }
}

pub fn current_device_identity() -> Result<DeviceIdentity, String> {
    Ok(DeviceIdentity {
        device_id: get_or_create_device_id()?,
        device_name: local_device_name(),
        platform: platform_identifier(),
        os_version: os_version(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

pub fn platform_identifier() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64".to_string();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64".to_string();

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unknown".to_string();
}

pub fn local_device_name() -> Option<String> {
    normalize_device_name(sysinfo::System::host_name())
        .or_else(|| normalize_device_name(std::env::var("COMPUTERNAME").ok()))
        .or_else(|| normalize_device_name(std::env::var("HOSTNAME").ok()))
}

fn device_id_path() -> Result<PathBuf, String> {
    let home_dir = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    Ok(home_dir.join(crate::app_dirs::APP_DATA_DIR_NAME).join("device_id"))
}

fn normalize_device_name(value: Option<String>) -> Option<String> {
    value
        .map(|name| name.trim().trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty())
}

fn os_version() -> Option<String> {
    sysinfo::System::long_os_version()
        .or_else(sysinfo::System::os_version)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use super::*;

    #[test]
    fn concurrent_first_creation_returns_one_stable_device_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("device_id");
        let barrier = Arc::new(Barrier::new(12));
        let handles = (0..12)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let path = path.clone();
                thread::spawn(move || {
                    barrier.wait();
                    get_or_create_device_id_at(path).expect("device id")
                })
            })
            .collect::<Vec<_>>();

        let ids = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread"))
            .collect::<Vec<_>>();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(
            fs::read_to_string(dir.path().join("device_id"))
                .expect("written device_id")
                .trim(),
            ids[0]
        );
    }
}
