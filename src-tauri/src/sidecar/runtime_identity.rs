use super::*;

// ─── Agent Runtime resolution (v0.1.59) ───

// BOM-stripping moved to crate::utils::bom (issue #170 #6) so all JSON-
// reading sites share a single helper.
use crate::utils::bom::strip_bom;

const CODEX_SUBSCRIPTION_PROVIDER_ID: &str = "codex-sub";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID: &str = "anthropic-sub";
#[cfg(test)]
const ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID: &str = "antigravity-sub";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeIdentity {
    pub runtime: String,
    pub runtime_source: Option<String>,
    pub runtime_binding_json: Option<String>,
    pub compatibility_error: Option<String>,
}

impl RuntimeIdentity {
    pub fn new(runtime: Option<&str>, runtime_source: Option<&str>) -> Self {
        // managed-provider is the product-owned Codex runtime source. Older
        // metadata may contain the impossible builtin/managed-provider pair;
        // canonicalize before any spawn/reuse decision reads it.
        let runtime = if runtime_source == Some("managed-provider") {
            "codex".to_string()
        } else {
            normalize_runtime_name(runtime).to_string()
        };
        let normalized_source = normalize_runtime_source_name(&runtime, runtime_source);
        Self {
            runtime,
            runtime_source: if normalized_source == "builtin" {
                None
            } else {
                Some(normalized_source.to_string())
            },
            runtime_binding_json: None,
            compatibility_error: None,
        }
    }

    pub(super) fn with_binding(mut self, binding: &serde_json::Value) -> Self {
        self.runtime_binding_json = Some(binding.to_string());
        self
    }

    pub(super) fn incompatible(message: impl Into<String>) -> Self {
        Self {
            runtime: "incompatible".to_string(),
            runtime_source: None,
            runtime_binding_json: None,
            compatibility_error: Some(message.into()),
        }
    }

    pub fn runtime_for_env(&self) -> Option<&str> {
        if self.runtime == "builtin" {
            None
        } else {
            Some(self.runtime.as_str())
        }
    }

    pub fn runtime_source_for_env(&self) -> Option<&str> {
        self.runtime_for_env()?;
        Some(self.runtime_source.as_deref().unwrap_or("system-cli"))
    }

    pub fn runtime_source_label(&self) -> &str {
        normalize_runtime_source_name(&self.runtime, self.runtime_source.as_deref())
    }
}

pub(super) fn distribution_default_runtime_identity() -> RuntimeIdentity {
    let policy = crate::runtime_distribution_policy::policy();
    let configured = dirs::home_dir()
        .and_then(|home| {
            std::fs::read_to_string(
                home.join(crate::app_dirs::APP_DATA_DIR_NAME)
                    .join("config.json"),
            )
            .ok()
        })
        .and_then(|content| serde_json::from_str::<serde_json::Value>(strip_bom(&content)).ok());
    configured
        .as_ref()
        .map(|cfg| configured_distribution_default_runtime_identity_for(cfg, policy))
        .unwrap_or_else(|| distribution_default_runtime_identity_for(policy))
}

fn distribution_default_runtime_identity_for(
    policy: &crate::runtime_distribution_policy::RuntimeDistributionPolicy,
) -> RuntimeIdentity {
    RuntimeIdentity::new(Some(policy.default_runtime()), None)
}

fn configured_distribution_default_runtime_identity_for(
    cfg: &serde_json::Value,
    policy: &crate::runtime_distribution_policy::RuntimeDistributionPolicy,
) -> RuntimeIdentity {
    let configured_default = cfg
        .get("defaultIntegratedRuntime")
        .and_then(serde_json::Value::as_str);
    RuntimeIdentity::new(
        Some(policy.default_runtime_for_override(configured_default)),
        None,
    )
}

pub(super) fn admit_runtime_identity(identity: RuntimeIdentity) -> RuntimeIdentity {
    admit_runtime_identity_for(identity, crate::runtime_distribution_policy::policy())
}

fn admit_runtime_identity_for(
    identity: RuntimeIdentity,
    policy: &crate::runtime_distribution_policy::RuntimeDistributionPolicy,
) -> RuntimeIdentity {
    if identity.compatibility_error.is_some() {
        return identity;
    }
    if policy.allows_runtime(&identity.runtime, identity.runtime_source.as_deref()) {
        identity
    } else {
        RuntimeIdentity::incompatible(format!(
            "Runtime {}/{} is not included in this distribution",
            identity.runtime,
            identity.runtime_source_label(),
        ))
    }
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn runtime_identity_from_binding(binding: &serde_json::Value) -> Result<RuntimeIdentity, String> {
    let family =
        non_empty_string(binding.get("family")).ok_or("runtimeBinding.family is missing")?;
    let id = non_empty_string(binding.get("id")).ok_or("runtimeBinding.id is missing")?;

    let identity = match (family, id) {
        ("integrated", "claude-agent-sdk") => {
            non_empty_string(binding.get("implementationVersion"))
                .ok_or("runtimeBinding.implementationVersion is missing")?;
            RuntimeIdentity::new(Some("builtin"), None)
        }
        ("integrated", "dsh") => {
            for field in [
                "implementationVersion",
                "protocolVersion",
                "protocolSchemaSha256",
                "runtimeArtifactSha256",
                "compatibilityManifestSha256",
                "sessionFormat",
                "platformTarget",
            ] {
                non_empty_string(binding.get(field))
                    .ok_or_else(|| format!("runtimeBinding.{field} is missing"))?;
            }
            RuntimeIdentity::new(Some("dsh"), Some("integrated"))
        }
        ("managed-provider", "managed-codex")
            if non_empty_string(binding.get("providerId"))
                == Some(CODEX_SUBSCRIPTION_PROVIDER_ID) =>
        {
            non_empty_string(binding.get("implementationVersion"))
                .ok_or("runtimeBinding.implementationVersion is missing")?;
            RuntimeIdentity::new(Some("codex"), Some("managed-provider"))
        }
        ("external", runtime @ ("claude-code" | "codex")) => {
            RuntimeIdentity::new(Some(runtime), Some("system-cli"))
        }
        _ => return Err(format!("unsupported runtimeBinding {family}/{id}")),
    };
    Ok(identity.with_binding(binding))
}

fn runtime_identity_from_preference(
    preference: &serde_json::Value,
) -> Result<RuntimeIdentity, String> {
    let family =
        non_empty_string(preference.get("family")).ok_or("runtimePreference.family is missing")?;
    let id = non_empty_string(preference.get("id")).ok_or("runtimePreference.id is missing")?;
    match (family, id) {
        ("integrated", "claude-agent-sdk") => Ok(RuntimeIdentity::new(Some("builtin"), None)),
        ("integrated", "dsh") => Ok(RuntimeIdentity::new(Some("dsh"), Some("integrated"))),
        ("external", runtime @ ("claude-code" | "codex")) => {
            Ok(RuntimeIdentity::new(Some(runtime), Some("system-cli")))
        }
        _ => Err(format!("unsupported runtimePreference {family}/{id}")),
    }
}

fn runtime_identity_from_legacy_agent(
    agent: &serde_json::Value,
) -> Result<RuntimeIdentity, String> {
    let runtime = match agent.get("runtime") {
        None => "builtin",
        Some(value) => non_empty_string(Some(value)).ok_or("legacy Agent runtime is invalid")?,
    };
    let runtime_source = agent
        .get("runtimeConfig")
        .and_then(serde_json::Value::as_object)
        .and_then(|config| config.get("source"))
        .and_then(serde_json::Value::as_str);
    let provider_id = agent.get("providerId").and_then(serde_json::Value::as_str);

    match runtime {
        "builtin" if runtime_source.is_none() => Ok(RuntimeIdentity::new(Some("builtin"), None)),
        "codex"
            if runtime_source == Some("managed-provider")
                && provider_id == Some(CODEX_SUBSCRIPTION_PROVIDER_ID) =>
        {
            // This is the historical projection of the Provider constraint,
            // not an explicit user-managed Codex preference.
            Ok(RuntimeIdentity::new(Some("builtin"), None))
        }
        runtime @ ("claude-code" | "codex") => {
            Ok(RuntimeIdentity::new(Some(runtime), Some("system-cli")))
        }
        "dsh" if runtime_source.is_none() || runtime_source == Some("integrated") => {
            Ok(RuntimeIdentity::new(Some("dsh"), Some("integrated")))
        }
        _ => Err(format!("unsupported legacy Agent Runtime shape: {runtime}")),
    }
}

/// Look up the `runtime` field from the agent config in ~/.myagents/config.json
/// matching the given workspace path. Returns None for "builtin" (the default).
/// Used for NEW sessions (the agent config decides the default runtime for new conversations)
/// and for IM/Agent sidecar paths that don't have a session_id yet.
pub(crate) fn resolve_agent_runtime_identity_from_config(
    workspace_path: &std::path::Path,
) -> Option<RuntimeIdentity> {
    let config_dir = dirs::home_dir()?.join(crate::app_dirs::APP_DATA_DIR_NAME);
    let config_path = config_dir.join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;
    let projects_content = std::fs::read_to_string(config_dir.join("projects.json")).ok()?;
    let projects: serde_json::Value = serde_json::from_str(strip_bom(&projects_content)).ok()?;
    resolve_agent_runtime_identity_from_values(&cfg, &projects, workspace_path)
}

pub(crate) fn resolve_agent_runtime_identity_by_id_from_config(
    agent_id: &str,
) -> Option<RuntimeIdentity> {
    let config_path = dirs::home_dir()?
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");
    let content = std::fs::read_to_string(config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;
    resolve_agent_runtime_identity_by_id_from_value(&cfg, agent_id)
}

fn resolve_agent_runtime_identity_from_values(
    cfg: &serde_json::Value,
    projects: &serde_json::Value,
    workspace_path: &std::path::Path,
) -> Option<RuntimeIdentity> {
    let matching_projects = projects
        .as_array()?
        .iter()
        .filter(|project| {
            project
                .get("path")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|path| workspace_paths_match(path, workspace_path))
        })
        .collect::<Vec<_>>();
    if matching_projects.len() != 1 {
        return None;
    }
    let agent_id = matching_projects[0].get("agentId")?.as_str()?;
    let claim_count = projects
        .as_array()?
        .iter()
        .filter(|project| {
            project.get("agentId").and_then(serde_json::Value::as_str) == Some(agent_id)
        })
        .count();
    if claim_count != 1 {
        return None;
    }

    resolve_agent_runtime_identity_by_id_from_value(cfg, agent_id)
        .filter(|identity| identity.runtime != "builtin")
}

fn resolve_agent_runtime_identity_by_id_from_value(
    cfg: &serde_json::Value,
    agent_id: &str,
) -> Option<RuntimeIdentity> {
    resolve_agent_runtime_identity_by_id_with_policy(
        cfg,
        agent_id,
        crate::runtime_distribution_policy::policy(),
    )
}

fn resolve_agent_runtime_identity_by_id_with_policy(
    cfg: &serde_json::Value,
    agent_id: &str,
    policy: &crate::runtime_distribution_policy::RuntimeDistributionPolicy,
) -> Option<RuntimeIdentity> {
    let agent = cfg
        .get("agents")?
        .as_array()?
        .iter()
        .find(|agent| agent.get("id").and_then(serde_json::Value::as_str) == Some(agent_id))?;
    let runtime = agent
        .get("runtime")
        .and_then(|value| value.as_str())
        .unwrap_or("builtin");
    let runtime_source = agent
        .get("runtimeConfig")
        .and_then(|value| value.as_object())
        .and_then(|config| config.get("source"))
        .and_then(|value| value.as_str());
    let selection_available = policy.selector_available();
    let preference = if selection_available {
        match agent.get("runtimePreference") {
            Some(preference) => runtime_identity_from_preference(preference).map(Some),
            None if agent.get("runtime").is_none_or(serde_json::Value::is_null) => {
                Ok(Some(configured_distribution_default_runtime_identity_for(
                    cfg, policy,
                )))
            }
            None => runtime_identity_from_legacy_agent(agent).map(Some),
        }
    } else {
        Ok(Some(configured_distribution_default_runtime_identity_for(
            cfg, policy,
        )))
    };
    let preference = match preference {
        Ok(preference) => preference,
        Err(error) => return Some(RuntimeIdentity::incompatible(error)),
    };

    // An explicitly selected External Runtime wins over dormant integrated or
    // managed Provider template fields.
    if let Some(preference) = preference.as_ref().filter(|identity| {
        matches!(
            identity.runtime.as_str(),
            "claude-code" | "codex"
        )
    }) {
        return Some(admit_runtime_identity_for(preference.clone(), policy));
    }

    let provider_id = agent.get("providerId").and_then(|value| value.as_str());
    if provider_id == Some(CODEX_SUBSCRIPTION_PROVIDER_ID) {
        return Some(if managed_codex_provider_ready(cfg) {
            admit_runtime_identity_for(
                RuntimeIdentity::new(Some("codex"), Some("managed-provider")),
                policy,
            )
        } else {
            RuntimeIdentity::incompatible("codex-sub requires a ready managed Codex Runtime")
        });
    }
    if matches!(
        provider_id,
        Some(
            ANTHROPIC_SUBSCRIPTION_PROVIDER_ID | "anthropic-api"
        )
    ) {
        return Some(admit_runtime_identity_for(
            RuntimeIdentity::new(Some("builtin"), None),
            policy,
        ));
    }
    if let Some(preference) = preference {
        return Some(admit_runtime_identity_for(preference, policy));
    }
    if runtime != "builtin" {
        // Only the readable legacy Managed Codex shape may retain this source.
        // Other explicit runtimes win over dormant provider/source fields,
        // matching the renderer/server Agent-template projection.
        let explicit_runtime_source = runtime_source.filter(|source| *source != "managed-provider");
        return Some(admit_runtime_identity_for(
            RuntimeIdentity::new(Some(runtime), explicit_runtime_source),
            policy,
        ));
    }
    Some(admit_runtime_identity_for(
        configured_distribution_default_runtime_identity_for(cfg, policy),
        policy,
    ))
}

fn managed_codex_provider_ready(cfg: &serde_json::Value) -> bool {
    let install = cfg.get("managedCodexRuntimeInstall");
    let auth = cfg.get("managedCodexAuth");
    let runtime_usable = install
        .and_then(|value| value.get("usable"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let provider_disabled = cfg
        .get("disabledProviderIds")
        .and_then(|v| v.as_array())
        .map(|ids| {
            ids.iter()
                .any(|id| id.as_str() == Some(CODEX_SUBSCRIPTION_PROVIDER_ID))
        })
        .unwrap_or(false);
    cfg.get("managedCodexProviderDevGate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && !provider_disabled
        && runtime_usable
        && auth.and_then(|v| v.get("status")).and_then(|v| v.as_str()) == Some("valid")
        && matches!(
            auth.and_then(|v| v.get("authMethod"))
                .and_then(|v| v.as_str()),
            Some("chatgpt") | Some("access-token")
        )
}

fn workspace_paths_match(agent_path: &str, workspace_path: &std::path::Path) -> bool {
    crate::cron_task::normalize_path(agent_path)
        == crate::cron_task::normalize_path(&workspace_path.to_string_lossy())
}

/// Look up the `runtime` field from session metadata in ~/.myagents/sessions.json.
/// Returns Some("builtin") for builtin/missing-runtime sessions that are found,
/// and None only when no authoritative session metadata is available.
///
/// This is the authoritative source for EXISTING sessions — the session's own metadata
/// records which runtime created it, regardless of the current agent config.
/// Agent config (resolve_agent_runtime_identity_from_config) decides the default for NEW sessions
/// using explicit preference or the root default; session metadata is stable once
/// created so an existing runtime-A history is never reopened as
/// runtime B under the same MyAgents session_id.
#[allow(dead_code)]
pub fn resolve_session_runtime_identity(session_id: &str) -> Option<String> {
    resolve_session_runtime_identity_full(session_id).map(|identity| identity.runtime)
}

pub fn resolve_session_runtime_identity_full(session_id: &str) -> Option<RuntimeIdentity> {
    let sessions_path = dirs::home_dir()?
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("sessions.json");
    let content = std::fs::read_to_string(&sessions_path).ok()?;
    resolve_session_runtime_identity_full_from_json(session_id, &content)
}

/// Session binding validation for workspace-scoped owners such as Tasks.
/// `sessions.json` owns the persisted Session identity, including the
/// workspace in which that Session was created; callers must not bind an
/// existing Session to a Task executing in a different workspace.
pub fn session_metadata_matches_workspace(session_id: &str, workspace_path: &str) -> bool {
    let Some(sessions_path) = dirs::home_dir().map(|home| {
        home.join(crate::app_dirs::APP_DATA_DIR_NAME)
            .join("sessions.json")
    })
    else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(sessions_path) else {
        return false;
    };
    session_metadata_matches_workspace_from_json(session_id, workspace_path, &content)
}

fn session_metadata_matches_workspace_from_json(
    session_id: &str,
    workspace_path: &str,
    content: &str,
) -> bool {
    let Ok(sessions) = serde_json::from_str::<serde_json::Value>(strip_bom(content)) else {
        return false;
    };
    sessions.as_array().is_some_and(|sessions| {
        sessions.iter().any(|session| {
            session.get("id").and_then(|value| value.as_str()) == Some(session_id)
                && session
                    .get("agentDir")
                    .and_then(|value| value.as_str())
                    .is_some_and(|agent_dir| {
                        crate::cron_task::normalize_path(agent_dir)
                            == crate::cron_task::normalize_path(workspace_path)
                    })
        })
    })
}

fn legacy_session_has_managed_codex_proof(session: &serde_json::Value) -> bool {
    if session
        .get("providerId")
        .and_then(serde_json::Value::as_str)
        == Some(CODEX_SUBSCRIPTION_PROVIDER_ID)
    {
        return true;
    }
    let Some(identity) = session
        .get("providerExecutionIdentity")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    identity.get("kind").and_then(serde_json::Value::as_str) == Some("runtime-backed-provider")
        && identity
            .get("providerId")
            .and_then(serde_json::Value::as_str)
            == Some(CODEX_SUBSCRIPTION_PROVIDER_ID)
        && identity.get("runtime").and_then(serde_json::Value::as_str) == Some("codex")
        && identity
            .get("runtimeSource")
            .and_then(serde_json::Value::as_str)
            == Some("managed-provider")
}

fn runtime_identity_from_legacy_session(
    session: &serde_json::Value,
) -> Result<RuntimeIdentity, String> {
    let runtime = match session.get("runtime") {
        None => "builtin",
        Some(value) => non_empty_string(Some(value)).ok_or("legacy Session runtime is invalid")?,
    };
    let source = match session.get("runtimeSource") {
        None => None,
        Some(value) => {
            Some(non_empty_string(Some(value)).ok_or("legacy Session runtimeSource is invalid")?)
        }
    };
    let managed_codex_proof = legacy_session_has_managed_codex_proof(session);

    match (runtime, source) {
        ("builtin", None) if managed_codex_proof => Ok(RuntimeIdentity::new(
            Some("codex"),
            Some("managed-provider"),
        )),
        ("builtin", None) => Ok(RuntimeIdentity::new(Some("builtin"), None)),
        ("builtin", Some("managed-provider")) if !managed_codex_proof => {
            Err("legacy builtin/managed-provider Session has no managed Codex proof".to_string())
        }
        ("codex", Some("managed-provider")) => Ok(RuntimeIdentity::new(
            Some("codex"),
            Some("managed-provider"),
        )),
        (runtime @ ("claude-code" | "codex"), None | Some("system-cli")) => {
            Ok(RuntimeIdentity::new(Some(runtime), Some("system-cli")))
        }
        ("dsh", None | Some("integrated")) => {
            Ok(RuntimeIdentity::new(Some("dsh"), Some("integrated")))
        }
        ("builtin", Some(source)) => Err(format!(
            "legacy builtin Session cannot use runtimeSource {source}"
        )),
        (runtime @ ("claude-code" | "codex"), Some(source)) => Err(format!(
            "legacy {runtime} Session cannot use runtimeSource {source}"
        )),
        ("dsh", Some(source)) => Err(format!(
            "legacy dsh Session cannot use runtimeSource {source}"
        )),
        (runtime, _) => Err(format!("unknown legacy Session Runtime {runtime}")),
    }
}

#[cfg(test)]
pub(super) fn resolve_session_runtime_identity_from_json(
    session_id: &str,
    content: &str,
) -> Option<String> {
    resolve_session_runtime_identity_full_from_json(session_id, content)
        .map(|identity| identity.runtime)
}

pub(super) fn resolve_session_runtime_identity_full_from_json(
    session_id: &str,
    content: &str,
) -> Option<RuntimeIdentity> {
    let sessions: serde_json::Value = serde_json::from_str(strip_bom(content)).ok()?;
    let sessions_arr = sessions.as_array()?;

    for session in sessions_arr {
        if session.get("id").and_then(|v| v.as_str()) == Some(session_id) {
            if let Some(binding) = session.get("runtimeBinding") {
                return Some(match runtime_identity_from_binding(binding) {
                    Ok(identity) => admit_runtime_identity(identity),
                    Err(error) => RuntimeIdentity::incompatible(error),
                });
            }
            if let Some(compatibility) = session.get("runtimeBindingCompatibility") {
                let code = compatibility
                    .get("code")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                return Some(RuntimeIdentity::incompatible(format!(
                    "Session Runtime binding is quarantined: {code}"
                )));
            }
            return Some(match runtime_identity_from_legacy_session(session) {
                Ok(identity) => admit_runtime_identity(identity),
                Err(error) => RuntimeIdentity::incompatible(error),
            });
        }
    }
    None
}

/// Lazy validation for tab restore (Issue #232 / PRD 0.2.25).
///
/// A restored "cold" chat tab is only activatable if (a) its session still
/// exists in `~/.myagents/sessions.json` and (b) its workspace directory still
/// exists on disk. This is read-only and reads the disk directly — it does NOT
/// depend on the global sidecar being up (which is async + flaky on startup),
/// matching the PRD's "validate lazily at first activation, decoupled from
/// global sidecar readiness" decision.
///
/// Returns false (drop the tab) on any miss: deleted session, moved/deleted
/// workspace, or unreadable index.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_can_restore_session(sessionId: String, agentDir: String) -> bool {
    // Validate the workspace through the project's canonical chokepoint
    // (system blacklist + must be an existing directory), same as every other
    // workspace command — NOT a bare `is_dir()`, which would accept relative /
    // credential / system paths. Catches moved/deleted workspaces that would
    // otherwise become a cold-start sidecar-spawn failure on click.
    if crate::workspace_files::path_safety::validate_workspace_root(&agentDir).is_err() {
        return false;
    }
    let Some(sessions_path) = dirs::home_dir().map(|home| {
        home.join(crate::app_dirs::APP_DATA_DIR_NAME)
            .join("sessions.json")
    }) else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(&sessions_path) else {
        return false;
    };
    let Ok(sessions) = serde_json::from_str::<serde_json::Value>(strip_bom(&content)) else {
        return false;
    };
    let Some(arr) = sessions.as_array() else {
        return false;
    };
    // The session must exist AND belong to this workspace. Cross-checking
    // agentDir prevents a corrupted/stale localStorage entry from restoring
    // session A under workspace B (which would apply the wrong workspace / MCP /
    // model config to an existing conversation). Both agentDir values originate
    // from the same launch path (persisted tab vs session metadata), so a raw
    // string compare is correct.
    arr.iter().any(|s| {
        s.get("id").and_then(|v| v.as_str()) == Some(&sessionId)
            && s.get("agentDir").and_then(|v| v.as_str()) == Some(&agentDir)
    })
}

/// v0.1.69 T13: Runtime invariant check on Sidecar reuse.
///
/// The expected identity is resolved once per ensure attempt from the
/// owner-aware priority chain. For an existing Session that includes immutable
/// Session metadata; for a metadata creator it uses the requested override or
/// Agent default. Reuse and spawn MUST consume that same identity snapshot.
///
/// If we detect a mismatch on a reuse path, it indicates either:
///   (a) T12's new-tab gate missed a case
///   (b) Session metadata was mutated post-creation (shouldn't happen)
///   (c) Two sessions with different runtimes ended up sharing a sidecar entry
///
/// We log loudly with `[sidecar][runtime-drift-on-reuse]` and return an error
/// to the reuse path. For runtimeSource-aware Codex, reusing the wrong source
/// means using the wrong binary, CODEX_HOME, and auth owner, so the correct
/// recovery is to reject reuse and let ensure create a fresh sidecar for the
/// session identity.
pub(super) fn validate_sidecar_runtime_invariant(
    session_id: &str,
    expected_identity: &RuntimeIdentity,
    sidecar_runtime: Option<&str>,
    sidecar_runtime_source: Option<&str>,
    site: &str,
) -> Result<(), String> {
    if let Some(error) = &expected_identity.compatibility_error {
        return Err(error.clone());
    }
    let sidecar_rt = normalize_runtime_name(sidecar_runtime);
    let sidecar_source = normalize_runtime_source_name(sidecar_rt, sidecar_runtime_source);
    let expected_runtime = expected_identity.runtime.as_str();
    let expected_source = expected_identity.runtime_source_label();
    if sidecar_rt != expected_runtime || sidecar_source != expected_source {
        let message = format!(
            "session={} site={} sidecar_runtime={} sidecar_runtime_source={} expected_runtime={} expected_runtime_source={}",
            session_id, site, sidecar_rt, sidecar_source, expected_runtime, expected_source
        );
        ulog_error!(
            "[sidecar][runtime-drift-on-reuse] {} — rejecting reuse",
            message
        );
        return Err(message);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_codex_provider_ready_requires_explicit_gate_install_and_chatgpt_auth() {
        let missing_gate = serde_json::json!({
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "usable": true,
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(!managed_codex_provider_ready(&missing_gate));

        let ready = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "usable": true,
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(managed_codex_provider_ready(&ready));

        let stale_but_usable = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "status": "downloading",
                "usable": true,
                "installedVersion": "0.0.0-previous"
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(managed_codex_provider_ready(&stale_but_usable));

        let gate_off = serde_json::json!({
            "managedCodexProviderDevGate": false,
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(!managed_codex_provider_ready(&gate_off));

        let api_key_auth = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "api-key"
            }
        });
        assert!(!managed_codex_provider_ready(&api_key_auth));

        let disabled = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "disabledProviderIds": [CODEX_SUBSCRIPTION_PROVIDER_ID],
            "managedCodexRuntimeInstall": {
                "status": "installed",
                "installedVersion": crate::managed_codex::REQUIRED_VERSION
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            }
        });
        assert!(!managed_codex_provider_ready(&disabled));
    }

    #[test]
    fn workspace_path_match_reuses_canonical_workspace_identity() {
        assert!(workspace_paths_match(
            r"C:\Users\me\Project\",
            std::path::Path::new("C:/Users/me/Project")
        ));
        assert!(workspace_paths_match(
            r"\\Server\Share\Project\",
            std::path::Path::new("//server/share/project")
        ));
        assert!(!workspace_paths_match(
            r"/tmp/a\b",
            std::path::Path::new("/tmp/a/b")
        ));
    }

    #[test]
    fn project_agent_id_selects_runtime_even_when_legacy_agent_path_disagrees() {
        let config = serde_json::json!({
            "agents": [
                { "id": "extra", "workspacePath": "/repo/current", "runtime": "claude-code" },
                { "id": "selected", "workspacePath": "/repo/old", "runtime": "codex" }
            ]
        });
        let projects = serde_json::json!([
            { "id": "project", "path": "/repo/current", "agentId": "selected" }
        ]);
        let identity = resolve_agent_runtime_identity_from_values(
            &config,
            &projects,
            std::path::Path::new("/repo/current"),
        )
        .expect("Project.agentId should select the Agent config");
        assert_eq!(identity.runtime, "codex");
    }

    #[test]
    fn exact_agent_id_selects_extra_or_orphan_runtime_without_project_guessing() {
        let config = serde_json::json!({
            "agents": [
                { "id": "project-agent", "runtime": "claude-code" },
                { "id": "extra", "workspacePath": "/repo/current", "runtime": "codex" },
                { "id": "orphan", "workspacePath": "/repo/orphan", "runtime": "claude-code" }
            ]
        });

        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "extra")
                .expect("extra Agent runtime")
                .runtime,
            "codex"
        );
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "orphan")
                .expect("orphan Agent runtime")
                .runtime,
            "claude-code"
        );
    }

    #[test]
    fn exact_builtin_agent_id_overrides_another_agents_external_workspace_runtime() {
        let config = serde_json::json!({
            "agents": [
                { "id": "project-agent", "runtime": "codex" },
                { "id": "extra-builtin", "workspacePath": "/repo/current", "runtime": "builtin" }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "extra-builtin")
            .expect("exact builtin identity must remain explicit");
        assert_eq!(identity.runtime, "builtin");
        assert_eq!(identity.runtime_source, None);
    }

    #[test]
    fn managed_codex_provider_only_owns_managed_compatible_agent_shapes() {
        let config = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "usable": true
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            },
            "agents": [
                { "id": "current", "runtime": "builtin", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID },
                {
                    "id": "legacy",
                    "runtime": "codex",
                    "runtimeConfig": { "source": "managed-provider" },
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                },
                { "id": "system-codex", "runtime": "codex", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID },
                { "id": "claude-code", "runtime": "claude-code", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID },
                {
                    "id": "other-external",
                    "runtime": "claude-code",
                    "runtimeConfig": { "source": "managed-provider" },
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                },
                { "id": "ordinary-provider", "runtime": "claude-code", "providerId": "anthropic-api" }
            ]
        });

        for agent_id in ["current", "legacy"] {
            let identity = resolve_agent_runtime_identity_by_id_from_value(&config, agent_id)
                .expect("managed Agent identity");
            assert_eq!(identity.runtime, "codex");
            assert_eq!(identity.runtime_source.as_deref(), Some("managed-provider"));
        }

        for (agent_id, expected_runtime) in [
            ("system-codex", "codex"),
            ("claude-code", "claude-code"),
            ("other-external", "claude-code"),
            ("ordinary-provider", "claude-code"),
        ] {
            let identity = resolve_agent_runtime_identity_by_id_from_value(&config, agent_id)
                .expect("explicit external Agent identity");
            assert_eq!(identity.runtime, expected_runtime);
            assert_eq!(identity.runtime_source.as_deref(), Some("system-cli"));
        }
    }

    #[test]
    fn explicit_external_choice_wins_over_dormant_managed_provider() {
        let config = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "usable": true
            },
            "managedCodexAuth": {
                "status": "valid",
                "authMethod": "chatgpt"
            },
            "agents": [
                { "id": "claude-code", "runtime": "claude-code", "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "claude-code")
            .expect("managed provider identity");
        assert_eq!(identity.runtime, "claude-code");
        assert_eq!(identity.runtime_source.as_deref(), Some("system-cli"));
    }

    #[test]
    fn unset_agent_uses_configured_integrated_default() {
        let config = serde_json::json!({
            "defaultIntegratedRuntime": "dsh",
            "agents": [
                {
                    "id": "ordinary",
                    "providerId": "deepseek"
                }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "ordinary")
            .expect("configured default identity");
        assert_eq!(identity.runtime, "dsh");
        assert_eq!(identity.runtime_source.as_deref(), Some("integrated"));
    }

    #[test]
    fn explicit_integrated_choices_win_over_the_root_default() {
        let config = serde_json::json!({
            "defaultIntegratedRuntime": "dsh",
            "agents": [
                { "id": "sdk", "runtime": "builtin", "providerId": "deepseek" },
                { "id": "sdk-preference", "runtimePreference": { "family": "integrated", "id": "claude-agent-sdk" } },
                { "id": "fixed-provider", "providerId": "anthropic-api" }
            ]
        });
        for id in ["sdk", "sdk-preference", "fixed-provider"] {
            assert_eq!(
                resolve_agent_runtime_identity_by_id_from_value(&config, id).unwrap().runtime,
                "builtin"
            );
        }
        let config = serde_json::json!({
            "defaultIntegratedRuntime": "claude-agent-sdk",
            "agents": [{ "id": "dsh", "runtimePreference": { "family": "integrated", "id": "dsh" } }]
        });
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "dsh").unwrap().runtime,
            "dsh"
        );
    }

    #[test]
    fn legacy_managed_codex_shape_does_not_bypass_provider_readiness() {
        let config = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": {
                "usable": true
            },
            "managedCodexAuth": {
                "status": "invalid",
                "authMethod": "chatgpt"
            },
            "agents": [
                {
                    "id": "legacy",
                    "runtime": "codex",
                    "runtimeConfig": { "source": "managed-provider" },
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                }
            ]
        });

        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "legacy")
            .expect("unready managed provider compatibility identity");
        assert_eq!(identity.runtime, "incompatible");
        assert_eq!(identity.runtime_source, None);
        assert!(identity.compatibility_error.is_some());
    }

    #[test]
    fn integrated_preferences_and_provider_constraints_follow_central_precedence() {
        let config = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": { "usable": true },
            "managedCodexAuth": { "status": "valid", "authMethod": "chatgpt" },
            "agents": [
                {
                    "id": "dsh",
                    "runtimePreference": { "family": "integrated", "id": "dsh" }
                },
                {
                    "id": "anthropic-sub",
                    "providerId": ANTHROPIC_SUBSCRIPTION_PROVIDER_ID,
                    "runtimePreference": { "family": "integrated", "id": "dsh" }
                },
                {
                    "id": "antigravity",
                    "providerId": ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
                    "runtimePreference": { "family": "integrated", "id": "dsh" }
                },
                {
                    "id": "anthropic-api",
                    "providerId": "anthropic-api",
                    "runtimePreference": { "family": "integrated", "id": "dsh" }
                },
                {
                    "id": "managed",
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID,
                    "runtimePreference": { "family": "integrated", "id": "dsh" }
                },
                {
                    "id": "external-wins",
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID,
                    "runtimePreference": { "family": "external", "id": "claude-code" }
                }
            ]
        });

        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "dsh")
                .expect("DSH identity")
                .runtime,
            "dsh"
        );
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "anthropic-sub")
                .expect("Claude constraint")
                .runtime,
            "builtin"
        );
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "antigravity")
                .expect("Antigravity API route")
                .runtime,
            "dsh"
        );
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "anthropic-api")
                .expect("Claude API constraint")
                .runtime,
            "builtin"
        );
        let managed = resolve_agent_runtime_identity_by_id_from_value(&config, "managed")
            .expect("managed Codex constraint");
        assert_eq!(managed.runtime, "codex");
        assert_eq!(managed.runtime_source.as_deref(), Some("managed-provider"));
        assert_eq!(
            resolve_agent_runtime_identity_by_id_from_value(&config, "external-wins")
                .expect("explicit External preference")
                .runtime,
            "claude-code"
        );
    }

    #[test]
    fn dsh_only_policy_drives_real_agent_birth_and_rejects_incompatible_routes() {
        let policy = crate::runtime_distribution_policy::RuntimeDistributionPolicy::parse(
            r#"{
                "schemaVersion": 1,
                "allowedIntegratedRuntimes": ["dsh"],
                "allowedExternalRuntimes": [],
                "defaultIntegratedRuntime": "dsh",
                "selectorAvailability": "hidden"
            }"#,
        )
        .expect("valid DSH-only policy");
        let config = serde_json::json!({
            "managedCodexProviderDevGate": true,
            "managedCodexRuntimeInstall": { "usable": true },
            "managedCodexAuth": { "status": "valid", "authMethod": "chatgpt" },
            "agents": [
                {
                    "id": "ordinary",
                    "runtimePreference": { "family": "external", "id": "codex" }
                },
                {
                    "id": "claude-subscription",
                    "providerId": ANTHROPIC_SUBSCRIPTION_PROVIDER_ID
                },
                {
                    "id": "antigravity-subscription",
                    "providerId": ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID
                },
                {
                    "id": "claude-api",
                    "providerId": "anthropic-api"
                },
                {
                    "id": "managed-codex",
                    "providerId": CODEX_SUBSCRIPTION_PROVIDER_ID
                }
            ]
        });

        let ordinary =
            resolve_agent_runtime_identity_by_id_with_policy(&config, "ordinary", &policy)
                .expect("ordinary Agent identity");
        assert_eq!(ordinary.runtime, "dsh");
        assert_eq!(ordinary.runtime_source.as_deref(), Some("integrated"));
        assert_eq!(
            resolve_agent_runtime_identity_by_id_with_policy(&config, "antigravity-subscription", &policy)
                .expect("portable Provider identity")
                .runtime,
            "dsh"
        );

        for agent_id in [
            "claude-subscription",
            "claude-api",
            "managed-codex",
        ] {
            let identity =
                resolve_agent_runtime_identity_by_id_with_policy(&config, agent_id, &policy)
                    .expect("incompatible Provider identity");
            assert_eq!(identity.runtime, "incompatible");
            assert!(identity.compatibility_error.is_some());
        }

        let frozen_claude =
            admit_runtime_identity_for(RuntimeIdentity::new(Some("builtin"), None), &policy);
        assert_eq!(frozen_claude.runtime, "incompatible");
        assert!(frozen_claude.compatibility_error.is_some());
    }

    #[test]
    fn invalid_authoritative_agent_preference_fails_closed_when_selector_is_available() {
        let config = serde_json::json!({
            "agents": [{
                "id": "future",
                "runtime": "builtin",
                "runtimePreference": { "family": "integrated", "id": "pi" }
            }]
        });
        let identity = resolve_agent_runtime_identity_by_id_from_value(&config, "future")
            .expect("compatibility identity");
        assert_eq!(identity.runtime, "incompatible");
        assert!(identity.compatibility_error.is_some());
    }

    #[test]
    fn authoritative_session_binding_wins_over_legacy_projection() {
        let binding = serde_json::json!({
            "family": "integrated",
            "id": "dsh",
            "implementationVersion": "0.0.0",
            "protocolVersion": "2.0.0",
            "protocolSchemaSha256": "schema",
            "runtimeArtifactSha256": "artifact",
            "compatibilityManifestSha256": "compatibility",
            "sessionFormat": "dsh-session-events-v1",
            "platformTarget": "darwin-arm64"
        });
        let content = serde_json::json!([{
            "id": "dsh-session",
            "runtime": "builtin",
            "runtimeBinding": binding
        }])
        .to_string();

        let identity = resolve_session_runtime_identity_full_from_json("dsh-session", &content)
            .expect("DSH binding identity");
        assert_eq!(identity.runtime, "dsh");
        assert_eq!(identity.runtime_source.as_deref(), Some("integrated"));
        assert!(identity.runtime_binding_json.is_some());
        assert_eq!(identity.compatibility_error, None);
    }

    #[test]
    fn external_binding_allows_an_unpinned_system_cli_version() {
        let content = serde_json::json!([{
            "id": "external",
            "runtimeBinding": { "family": "external", "id": "codex" }
        }])
        .to_string();
        let identity = resolve_session_runtime_identity_full_from_json("external", &content)
            .expect("External binding identity");
        assert_eq!(identity.runtime, "codex");
        assert_eq!(identity.runtime_source.as_deref(), Some("system-cli"));
        assert_eq!(identity.compatibility_error, None);
    }

    #[test]
    fn invalid_binding_and_explicit_compatibility_state_block_execution() {
        let content = serde_json::json!([
            {
                "id": "invalid-binding",
                "runtime": "builtin",
                "runtimeBinding": {
                    "family": "integrated",
                    "id": "dsh",
                    "implementationVersion": "0.0.0"
                }
            },
            {
                "id": "quarantined",
                "runtime": "builtin",
                "runtimeBindingCompatibility": {
                    "state": "incompatible",
                    "code": "unknown-legacy-runtime"
                }
            }
        ])
        .to_string();

        for session_id in ["invalid-binding", "quarantined"] {
            let identity = resolve_session_runtime_identity_full_from_json(session_id, &content)
                .expect("compatibility identity");
            assert_eq!(identity.runtime, "incompatible");
            assert!(identity.compatibility_error.is_some());
        }
    }

    #[test]
    fn duplicate_project_claim_is_target_local_failure() {
        let config = serde_json::json!({
            "agents": [{ "id": "selected", "runtime": "codex" }]
        });
        let projects = serde_json::json!([
            { "id": "a", "path": "/repo/a", "agentId": "selected" },
            { "id": "b", "path": "/repo/b", "agentId": "selected" }
        ]);
        assert!(resolve_agent_runtime_identity_from_values(
            &config,
            &projects,
            std::path::Path::new("/repo/a"),
        )
        .is_none());
    }

    #[test]
    fn session_workspace_match_uses_persisted_session_identity() {
        let sessions = serde_json::json!([
            { "id": "session-a", "agentDir": "/repo/a", "runtime": "builtin" },
            { "id": "session-b", "agentDir": "/repo/b", "runtime": "codex" }
        ])
        .to_string();

        assert!(session_metadata_matches_workspace_from_json(
            "session-a",
            "/repo/a/",
            &sessions,
        ));
        assert!(!session_metadata_matches_workspace_from_json(
            "session-a",
            "/repo/b",
            &sessions,
        ));
        assert!(!session_metadata_matches_workspace_from_json(
            "missing", "/repo/a", &sessions,
        ));
    }
}
