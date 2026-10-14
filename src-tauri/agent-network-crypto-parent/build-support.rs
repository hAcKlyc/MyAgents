//! Closed, source-pinned parent-only transformations. Never modifies reader v1.
pub const PATCH_VERSION: &str = "moxbot-parent-policy-v1";
pub const INPUTS: &[(&str, &str)] = &[
    (
        "Cargo.toml",
        "f0058e874e0d7a4ea8d51d43de75ab9cb27ec8bfaa4fbb729c446f8488098bb1",
    ),
    (
        "src/lib.rs",
        "c9421dcaa0000f44b4c63a651f4f28066b58120e849c31e1face1899b4beee42",
    ),
    (
        "src/os_store.rs",
        "c4de0b530dd2da52aa4f41bc48eda4058e86e708da03cf93ae8cfdae1481b1ad",
    ),
    (
        "src/macos_credential.rs",
        "f9980d42bb12694262ed6126a92bc98ce9eae6ebe4424809ab71e4ead0ae5229",
    ),
    (
        "src/macos_helper.rs",
        "3f866d704c54c06bd09d287b2874defb6d36bc7a5b111d51a90dd496eeca4f85",
    ),
    (
        "src/encrypted_store.rs",
        "3d1088a26d8f7c647619b5fedffa4458027c875865a73a4f9aefbf4bbc25b58c",
    ),
];

pub fn verified_inputs(
    mut read: impl FnMut(&str) -> std::io::Result<Vec<u8>>,
) -> Result<std::collections::BTreeMap<&'static str, Vec<u8>>, &'static str> {
    use sha2::{Digest, Sha256};
    let mut snapshot = std::collections::BTreeMap::new();
    for &(relative, expected) in INPUTS {
        let bytes = read(relative).map_err(|_| "pinned reader source input missing")?;
        if format!("{:x}", Sha256::digest(&bytes)) != expected {
            return Err("pinned reader source input changed");
        }
        snapshot.insert(relative, bytes);
    }
    Ok(snapshot)
}

fn once(source: &str, from: &str, to: &str) -> Result<String, &'static str> {
    if source.matches(from).count() != 1 {
        return Err("parent policy source pattern changed");
    }
    Ok(source.replacen(from, to, 1))
}

pub fn helper(source: &str) -> Result<String, &'static str> {
    let source = once(
        source,
        "const DEADLINE: Duration = Duration::from_secs(5);",
        "const DEADLINE: Duration = Duration::from_secs(30);",
    )?;
    let source = once(
        &source,
        "assert_eq!(ReadMode::Background.deadline(), Duration::from_secs(5));",
        "assert_eq!(ReadMode::Background.deadline(), Duration::from_secs(30));",
    )?;
    let source = once(
        &source,
        "    let deadline = Instant::now() + mode.deadline();",
        "    let started = Instant::now();\n    let deadline = started + mode.deadline();",
    )?;
    let source = once(
        &source,
        "    let executable = verified_broker_for_parent().ok_or_else(unavailable)?;",
        r#"    let executable = match verified_broker_for_parent() {
        Some(executable) => {
            diagnostic("verification", "ok", mode, operation, started);
            executable
        }
        None => {
            diagnostic("verification", "rejected", mode, operation, started);
            return Err(unavailable());
        }
    };
    if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
        diagnostic("verification", "cancelled-or-expired", mode, operation, started);
        return Err(unavailable());
    }"#,
    )?;
    let source = once(&source,
        "    exchange_operation(\n        child,\n        &input,\n        limit,\n        deadline.saturating_duration_since(Instant::now()),\n        cancelled,\n        operation,\n    )",
        r#"    let result = exchange_operation(
        child,
        &input,
        limit,
        deadline.saturating_duration_since(Instant::now()),
        cancelled,
        operation,
    );
    let outcome = match &result {
        Ok(_) => "ok",
        Err(keyring::Error::NoEntry) => "missing",
        Err(_) if cancelled.load(Ordering::Acquire) => "cancelled",
        Err(_) if Instant::now() >= deadline => "expired",
        Err(error) if super::macos_credential::credential_authorization_required(error) => "authorization-required",
        Err(_) => "failed",
    };
    diagnostic("exchange", outcome, mode, operation, started);
    result"#)?;
    Ok(format!("{source}\n{DIAGNOSTICS}"))
}

const DIAGNOSTICS: &str = r#"
/// Only closed labels and durations; no credential, scope, path or raw error.
#[derive(Clone, Copy, Debug)]
pub struct ParentDiagnostic {
    pub stage: &'static str,
    pub outcome: &'static str,
    pub mode: &'static str,
    pub operation: &'static str,
    pub elapsed_ms: u64,
    pub budget_ms: u64,
}
static DIAGNOSTIC_SINK: std::sync::OnceLock<fn(ParentDiagnostic)> = std::sync::OnceLock::new();
pub fn set_parent_diagnostic_sink(sink: fn(ParentDiagnostic)) -> bool {
    DIAGNOSTIC_SINK.set(sink).is_ok()
}
fn diagnostic(stage: &'static str, outcome: &'static str, mode: ReadMode, operation: Operation, started: Instant) {
    if let Some(sink) = DIAGNOSTIC_SINK.get() {
        sink(ParentDiagnostic {
            stage, outcome,
            mode: match mode { ReadMode::Background => "background", ReadMode::Authorize => "authorize" },
            operation: match operation { Operation::Read => "read", Operation::Write => "write", Operation::Delete => "delete" },
            elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            budget_ms: mode.deadline().as_millis().min(u64::MAX as u128) as u64,
        });
    }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    const SOURCE: &str = include_str!("../agent-network-crypto/src/macos_helper.rs");
    #[test]
    fn patches_only_parent_budget_and_closed_observation_points() {
        let derived = helper(SOURCE).unwrap();
        assert!(derived.contains("const DEADLINE: Duration = Duration::from_secs(30);"));
        assert!(
            derived.contains("const AUTHORIZATION_DEADLINE: Duration = Duration::from_secs(180);")
        );
        assert!(derived.contains("fn trusted_inner() -> Option<()>"));
        assert!(derived.contains("deadline.saturating_duration_since(Instant::now())"));
        assert!(derived.contains("pub budget_ms: u64"));
        assert!(!DIAGNOSTICS.contains("request."));
        assert!(!DIAGNOSTICS.contains("secret"));
        assert_eq!(INPUTS.len(), 6);
        assert_eq!(PATCH_VERSION, "moxbot-parent-policy-v1");
    }
    #[test]
    fn rejects_missing_or_ambiguous_pinned_pattern() {
        assert!(helper("").is_err());
        let duplicated = format!("{SOURCE}\nconst DEADLINE: Duration = Duration::from_secs(5);");
        assert!(helper(&duplicated).is_err());
        assert!(
            helper(&SOURCE.replace("Duration::from_secs(5);", "Duration::from_secs(6);")).is_err()
        );
    }

    #[test]
    fn source_change_after_read_cannot_change_verified_snapshot() {
        let original = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("agent-network-crypto");
        let tmp = tempfile::tempdir().unwrap();
        for &(relative, _) in INPUTS {
            let dest = tmp.path().join(relative);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::copy(original.join(relative), dest).unwrap();
        }
        let snapshot = verified_inputs(|relative| {
            let path = tmp.path().join(relative);
            let bytes = std::fs::read(&path)?;
            if relative == "src/lib.rs" {
                std::fs::write(&path, b"tampered after verified read")?;
            }
            Ok(bytes)
        })
        .unwrap();
        assert_eq!(
            snapshot["src/lib.rs"],
            std::fs::read(original.join("src/lib.rs")).unwrap()
        );
        assert_ne!(
            snapshot["src/lib.rs"],
            std::fs::read(tmp.path().join("src/lib.rs")).unwrap()
        );
        assert!(verified_inputs(|relative| std::fs::read(tmp.path().join(relative))).is_err());
    }
}
