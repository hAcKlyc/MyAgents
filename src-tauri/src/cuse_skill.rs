//! Cuse is an optional, versioned system Skill whose payload includes native code.
//! Download integrity belongs to build preparation. At startup the signed app
//! resource is authority (Developer ID signing changes upstream binary hashes).
use std::{collections::BTreeMap, fs, path::Path};

pub(crate) fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

fn files(root: &Path) -> Option<BTreeMap<String, Vec<u8>>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> Option<()> {
        let metadata = fs::symlink_metadata(dir).ok()?;
        if !metadata.is_dir() || metadata.is_symlink() {
            return None;
        }
        for entry in fs::read_dir(dir).ok()? {
            let path = entry.ok()?.path();
            let meta = fs::symlink_metadata(&path).ok()?;
            if meta.is_symlink() {
                return None;
            }
            if meta.is_dir() {
                walk(root, &path, out)?;
            } else if meta.is_file() && meta.len() <= 64 * 1024 * 1024 {
                let name = path.strip_prefix(root).ok()?.to_str()?.replace('\\', "/");
                out.insert(name, fs::read(&path).ok()?);
            } else {
                return None;
            }
        }
        Some(())
    }
    let mut payload = BTreeMap::new();
    walk(root, root, &mut payload)?;
    let meta: serde_json::Value = serde_json::from_slice(payload.get("package.json")?).ok()?;
    let (platform, entry) = if cfg!(target_os = "windows") {
        ("windows-x64", "scripts/cuse.exe")
    } else {
        ("macos-universal", "scripts/cuse")
    };
    if meta["schema_version"] != 1
        || meta["name"] != "cuse"
        || meta["kind"] != "skill"
        || meta["platform"] != platform
        || meta["entrypoint"] != entry
        || !meta["args"].as_array()?.is_empty()
        || meta["version"].as_str()?.is_empty()
        || meta["source_commit"].as_str()?.len() != 40
    {
        return None;
    }
    let declared = meta["files"].as_object()?;
    if payload.len() != declared.len() + 1
        || declared.keys().any(|name| !payload.contains_key(name))
        || ["SKILL.md", "LICENSE", entry]
            .iter()
            .any(|name| !declared.contains_key(*name))
        || payload.values().any(Vec::is_empty)
    {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(root.join(entry)).ok()?.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(payload)
}

pub(crate) fn complete(root: &Path) -> bool {
    files(root).is_some()
}

pub(crate) fn matches_bundle(source: &Path, installed: &Path) -> bool {
    match (files(source), files(installed)) {
        (Some(source), Some(installed)) => source == installed,
        _ => false,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn fixture(root: &Path) {
        fs::create_dir_all(root.join("scripts")).unwrap();
        let entry = if cfg!(target_os = "windows") {
            "scripts/cuse.exe"
        } else {
            "scripts/cuse"
        };
        let platform = if cfg!(target_os = "windows") {
            "windows-x64"
        } else {
            "macos-universal"
        };
        let payload = [
            ("SKILL.md", "skill"),
            ("LICENSE", "license"),
            (entry, "native code"),
        ];
        let mut declared = serde_json::Map::new();
        for (name, content) in payload {
            fs::write(root.join(name), content).unwrap();
            declared.insert(
                name.into(),
                serde_json::json!({"size": content.len(), "sha256": "0".repeat(64)}),
            );
        }
        fs::write(
            root.join("package.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema_version": 1, "name": "cuse", "kind": "skill", "version": "0.3.0",
                "platform": platform, "source_commit": "a".repeat(40), "entrypoint": entry,
                "args": [], "files": declared
            }))
            .unwrap(),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join(entry), fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn compares_actual_app_payload_and_detects_missing_or_changed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("source");
        let installed = tmp.path().join("installed");
        fixture(&source);
        fixture(&installed);
        assert!(matches_bundle(&source, &installed));
        let entry = if cfg!(target_os = "windows") {
            "scripts/cuse.exe"
        } else {
            "scripts/cuse"
        };
        // Signing may change bytes without changing upstream version/metadata.
        fs::write(source.join(entry), "signed app binary").unwrap();
        assert!(complete(&source));
        assert!(!matches_bundle(&source, &installed));
        fs::write(installed.join(entry), "signed app binary").unwrap();
        assert!(matches_bundle(&source, &installed));
        fs::remove_file(installed.join(entry)).unwrap();
        assert!(!complete(&installed));
        assert!(!matches_bundle(&source, &installed));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_lost_executable_mode_and_symlink_payloads() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let tmp = tempfile::tempdir().unwrap();
        fixture(tmp.path());
        let binary = tmp.path().join("scripts/cuse");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!complete(tmp.path()));
        fs::remove_file(&binary).unwrap();
        symlink("../SKILL.md", binary).unwrap();
        assert!(!complete(tmp.path()));
    }
}
