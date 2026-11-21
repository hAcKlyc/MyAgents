use std::{collections::HashSet, sync::OnceLock};

use serde::Deserialize;

const POLICY_JSON: &str =
    include_str!("../../src/shared/integrated-runtimes/distribution-policy.json");

const INTEGRATED_RUNTIME_IDS: &[&str] = &["claude-agent-sdk", "dsh"];
const EXTERNAL_RUNTIME_IDS: &[&str] = &["claude-code", "codex", "antigravity"];

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeDistributionPolicy {
    schema_version: u8,
    allowed_integrated_runtimes: Vec<String>,
    allowed_external_runtimes: Vec<String>,
    default_integrated_runtime: String,
    selector_availability: String,
}

impl RuntimeDistributionPolicy {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        let policy: Self = serde_json::from_str(value)
            .map_err(|error| format!("invalid Runtime distribution policy JSON: {error}"))?;
        policy.validate()?;
        Ok(policy)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("Runtime distribution policy schemaVersion must be 1".to_string());
        }
        if self.allowed_integrated_runtimes.is_empty()
            || has_duplicates(&self.allowed_integrated_runtimes)
            || self
                .allowed_integrated_runtimes
                .iter()
                .any(|id| !INTEGRATED_RUNTIME_IDS.contains(&id.as_str()))
        {
            return Err("Runtime distribution policy has invalid Integrated Runtimes".to_string());
        }
        if has_duplicates(&self.allowed_external_runtimes)
            || self
                .allowed_external_runtimes
                .iter()
                .any(|id| !EXTERNAL_RUNTIME_IDS.contains(&id.as_str()))
        {
            return Err("Runtime distribution policy has invalid External Runtimes".to_string());
        }
        if !self
            .allowed_integrated_runtimes
            .contains(&self.default_integrated_runtime)
        {
            return Err("Default Integrated Runtime must be allowed".to_string());
        }
        if !matches!(
            self.selector_availability.as_str(),
            "always" | "hidden"
        ) {
            return Err("Runtime distribution policy has invalid selectorAvailability".to_string());
        }
        Ok(())
    }

    pub(crate) fn selector_available(&self) -> bool {
        self.selector_availability == "always"
    }

    pub(crate) fn default_runtime(&self) -> &'static str {
        self.default_runtime_for_override(None)
    }

    pub(crate) fn default_runtime_for_override(
        &self,
        configured_default: Option<&str>,
    ) -> &'static str {
        let default = configured_default
            .filter(|id| self.allows_integrated(id))
            .unwrap_or(&self.default_integrated_runtime);
        match default {
            "claude-agent-sdk" => "builtin",
            "dsh" => "dsh",
            // Validation makes this unreachable. Keep the match exhaustive at
            // the legacy Runtime projection boundary rather than silently
            // inventing a default for a future Integrated Runtime.
            other => panic!("unsupported default Integrated Runtime {other}"),
        }
    }

    pub(crate) fn allows_runtime(&self, runtime: &str, runtime_source: Option<&str>) -> bool {
        match (runtime, runtime_source) {
            ("builtin", _) => self.allows_integrated("claude-agent-sdk"),
            ("dsh", _) => self.allows_integrated("dsh"),
            // The current policy schema has no independent managed-runtime
            // allowlist. Managed Codex belongs to the general product profile
            // carried by the Claude-SDK-capable distribution; a DSH-only
            // edition must leave incompatible Provider routes unavailable.
            ("codex", Some("managed-provider")) => self.allows_integrated("claude-agent-sdk"),
            (runtime @ ("claude-code" | "codex" | "antigravity"), _) => self.allows_external(runtime),
            _ => false,
        }
    }

    pub(crate) fn allows_integrated(&self, id: &str) -> bool {
        self.allowed_integrated_runtimes
            .iter()
            .any(|allowed| allowed == id)
    }

    pub(crate) fn allows_external(&self, id: &str) -> bool {
        self.allowed_external_runtimes
            .iter()
            .any(|allowed| allowed == id)
    }
}

fn has_duplicates(values: &[String]) -> bool {
    let mut unique = HashSet::with_capacity(values.len());
    values.iter().any(|value| !unique.insert(value))
}

static POLICY: OnceLock<RuntimeDistributionPolicy> = OnceLock::new();

pub(crate) fn policy() -> &'static RuntimeDistributionPolicy {
    POLICY.get_or_init(|| {
        RuntimeDistributionPolicy::parse(POLICY_JSON).unwrap_or_else(|error| panic!("{error}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_policy_is_valid_and_admits_its_default() {
        let policy = policy();
        assert_eq!(policy.schema_version, 1);
        assert!(policy
            .allowed_integrated_runtimes
            .contains(&policy.default_integrated_runtime));
        assert!(policy.allows_runtime(policy.default_runtime(), Some("integrated")));
    }

    #[test]
    fn dsh_only_distribution_has_a_hidden_dsh_default() {
        let policy = RuntimeDistributionPolicy::parse(
            r#"{
                "schemaVersion": 1,
                "allowedIntegratedRuntimes": ["dsh"],
                "allowedExternalRuntimes": [],
                "defaultIntegratedRuntime": "dsh",
                "selectorAvailability": "hidden"
            }"#,
        )
        .expect("valid DSH-only policy");

        assert_eq!(policy.default_runtime(), "dsh");
        assert!(!policy.selector_available());
        assert!(policy.allows_runtime("dsh", Some("integrated")));
        assert!(!policy.allows_runtime("builtin", None));
        assert!(!policy.allows_runtime("codex", Some("system-cli")));
        assert!(!policy.allows_runtime("codex", Some("managed-provider")));
        assert_eq!(
            policy.default_runtime_for_override(Some("claude-agent-sdk")),
            "dsh"
        );
    }

    #[test]
    fn developer_default_override_must_be_allowed_by_the_distribution() {
        let policy = policy();
        assert_eq!(policy.default_runtime_for_override(Some("dsh")), "dsh");
        assert_eq!(
            policy.default_runtime_for_override(Some("future-runtime")),
            "builtin"
        );
    }

    #[test]
    fn invalid_policy_fails_closed() {
        for invalid in [
            r#"{"schemaVersion":1,"allowedIntegratedRuntimes":[],"allowedExternalRuntimes":[],"defaultIntegratedRuntime":"dsh","selectorAvailability":"hidden"}"#,
            r#"{"schemaVersion":1,"allowedIntegratedRuntimes":["dsh"],"allowedExternalRuntimes":[],"defaultIntegratedRuntime":"claude-agent-sdk","selectorAvailability":"hidden"}"#,
            r#"{"schemaVersion":1,"allowedIntegratedRuntimes":["dsh"],"allowedExternalRuntimes":["pi"],"defaultIntegratedRuntime":"dsh","selectorAvailability":"hidden"}"#,
            r#"{"schemaVersion":1,"allowedIntegratedRuntimes":["dsh"],"allowedExternalRuntimes":["gemini"],"defaultIntegratedRuntime":"dsh","selectorAvailability":"hidden"}"#,
        ] {
            assert!(RuntimeDistributionPolicy::parse(invalid).is_err());
        }
        assert!(!policy().allows_runtime("gemini", Some("system-cli")));
    }
}
