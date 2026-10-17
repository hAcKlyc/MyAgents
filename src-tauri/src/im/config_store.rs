use super::*;
use crate::mcp_selection::normalize_config_mcp_selections;

// ===== Auto-start on app launch =====

/// Config shape from ~/.myagents/config.json (only what we need)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    /// Legacy single-bot config (for migration)
    im_bot_config: Option<PartialBotEntry>,
    /// Multi-bot configs (v0.1.19+)
    im_bot_configs: Option<Vec<PartialBotEntry>>,
    /// Agent configs (v0.1.41)
    #[serde(default)]
    agents: Vec<AgentConfigRust>,
    /// API keys keyed by provider ID (for migrating providerEnvJson)
    #[serde(default)]
    provider_api_keys: std::collections::HashMap<String, String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialBotEntry {
    id: Option<String>,
    #[serde(flatten)]
    config: ImConfig,
}

#[derive(Default)]
struct ArchivedAgentWorkspaces {
    agent_ids: std::collections::HashSet<String>,
    paths: std::collections::HashSet<String>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialProjectEntry {
    id: Option<String>,
    agent_id: Option<String>,
    path: Option<String>,
    archived_at: Option<String>,
}

fn read_projects_for_agent_projection() -> Vec<PartialProjectEntry> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let path = home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("projects.json");
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<PartialProjectEntry>>(strip_bom(&content)) {
        Ok(projects) => projects,
        Err(error) => {
            ulog_warn!(
                "[agent] projects.json parse failed while resolving Agent workspaces: {}",
                error
            );
            Vec::new()
        }
    }
}

pub(super) fn project_id_for_agent(agent_id: &str) -> Option<String> {
    let mut matches = read_projects_for_agent_projection()
        .into_iter()
        .filter(|project| project.agent_id.as_deref() == Some(agent_id))
        .filter_map(|project| project.id)
        .filter(|id| !id.is_empty());
    let project_id = matches.next()?;
    matches.next().is_none().then_some(project_id)
}

fn agent_claim_conflict(projects: &[PartialProjectEntry], agent_id: &str) -> Option<String> {
    let claims: Vec<_> = projects
        .iter()
        .filter(|project| project.agent_id.as_deref() == Some(agent_id))
        .collect();
    (claims.len() > 1).then(|| format!(
        "[AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS] Agent '{}' is claimed by multiple workspaces: {}. Open Settings → Chatbots to choose its workspace.",
        agent_id,
        claims.iter().map(|project| format!("{} ({})", project.path.as_deref().unwrap_or("?"), project.id.as_deref().unwrap_or("?"))).collect::<Vec<_>>().join(", ")
    ))
}

/// Stopping owns durable channel identities even when workspace projection fails.
/// Otherwise an in-flight start omitted from ManagedAgents could evade the stop locks.
pub(super) fn read_agent_channel_ids_from_disk(agent_id: &str) -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");
    let value = crate::config_io::read_config_json(&config_path)?;
    Ok(agent_channel_ids_from_value(&value, agent_id))
}

fn agent_channel_ids_from_value(value: &serde_json::Value, agent_id: &str) -> Vec<String> {
    value
        .get("agents")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|agent| agent.get("id").and_then(serde_json::Value::as_str) == Some(agent_id))
        .flat_map(|agent| {
            agent
                .get("channels")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|channel| {
            channel
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

pub(crate) fn agent_id_for_project(project_id: &str) -> Option<String> {
    let mut matches = read_projects_for_agent_projection()
        .into_iter()
        .filter(|project| project.id.as_deref() == Some(project_id))
        .filter_map(|project| project.agent_id)
        .filter(|id| !id.is_empty());
    let agent_id = matches.next()?;
    matches.next().is_none().then_some(agent_id)
}

/// The only Rust compatibility reader for historical agents[].workspacePath.
fn read_legacy_agent_workspace_paths(
    value: &serde_json::Value,
) -> std::collections::HashMap<String, String> {
    value
        .get("agents")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|agent| {
            let id = agent.get("id")?.as_str()?.trim();
            let path = agent.get("workspacePath")?.as_str()?.trim();
            (!id.is_empty() && !path.is_empty()).then(|| (id.to_string(), path.to_string()))
        })
        .collect()
}

fn project_agent_workspaces(
    value: &serde_json::Value,
    agents: Vec<AgentConfigRust>,
) -> Vec<AgentConfigRust> {
    let projects = read_projects_for_agent_projection();
    project_agent_workspaces_with(value, &projects, agents)
}

fn project_agent_workspaces_with(
    value: &serde_json::Value,
    projects: &[PartialProjectEntry],
    agents: Vec<AgentConfigRust>,
) -> Vec<AgentConfigRust> {
    let legacy_paths = read_legacy_agent_workspace_paths(value);

    let mut claims = std::collections::HashMap::<String, Vec<usize>>::new();
    let mut projects_by_path = std::collections::HashMap::<String, Option<usize>>::new();
    let mut conflicted_project_indices = std::collections::HashSet::<usize>::new();
    for (index, project) in projects.iter().enumerate() {
        if let Some(agent_id) = project.agent_id.as_deref().filter(|id| !id.is_empty()) {
            claims.entry(agent_id.to_string()).or_default().push(index);
        }
        if let Some(path) = project.path.as_deref().filter(|path| !path.is_empty()) {
            let identity = crate::cron_task::normalize_path(path);
            if let Some(existing) = projects_by_path.get(&identity) {
                if let Some(existing_index) = existing {
                    conflicted_project_indices.insert(*existing_index);
                }
                conflicted_project_indices.insert(index);
                projects_by_path.insert(identity, None);
            } else {
                projects_by_path.insert(identity, Some(index));
            }
        }
    }

    agents
        .into_iter()
        .filter_map(|mut agent| {
            if let Some(project_claims) = claims.get(&agent.id) {
                if project_claims.len() > 1 {
                    ulog_warn!(
                        "[agent] Agent {} is claimed by multiple Projects; skipping this target",
                        agent.id
                    );
                    return None;
                }
                if conflicted_project_indices.contains(&project_claims[0]) {
                    ulog_warn!(
                        "[agent] Agent {} belongs to a duplicate Project workspace; skipping this target",
                        agent.id
                    );
                    return None;
                }
                if let Some(path) = projects[project_claims[0]]
                    .path
                    .as_deref()
                    .filter(|path| !path.is_empty())
                {
                    agent.resolved_workspace_path = path.to_string();
                    return Some(agent);
                }
            }

            let legacy_path = legacy_paths.get(&agent.id)?;
            let identity = crate::cron_task::normalize_path(legacy_path);
            agent.resolved_workspace_path = projects_by_path
                .get(&identity)
                .and_then(|index| index.map(|index| projects[index].path.clone()))
                .flatten()
                .unwrap_or_else(|| legacy_path.clone());
            Some(agent)
        })
        .collect()
}

fn read_archived_agent_workspaces_from_disk() -> ArchivedAgentWorkspaces {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return ArchivedAgentWorkspaces::default(),
    };
    let path = home.join(crate::app_dirs::APP_DATA_DIR_NAME).join("projects.json");
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return ArchivedAgentWorkspaces::default(),
    };
    let projects = match serde_json::from_str::<Vec<PartialProjectEntry>>(strip_bom(&content)) {
        Ok(p) => p,
        Err(e) => {
            ulog_warn!(
                "[agent] projects.json parse failed while checking archives: {}",
                e
            );
            return ArchivedAgentWorkspaces::default();
        }
    };

    let mut archived = ArchivedAgentWorkspaces::default();
    for project in projects {
        if project.archived_at.as_deref().unwrap_or("").is_empty() {
            continue;
        }
        if let Some(agent_id) = project.agent_id.filter(|id| !id.is_empty()) {
            archived.agent_ids.insert(agent_id);
        }
        if let Some(path) = project.path.filter(|p| !p.is_empty()) {
            archived
                .paths
                .insert(crate::cron_task::normalize_path(&path));
        }
    }
    archived
}

fn is_agent_workspace_archived_with(
    agent_cfg: &types::AgentConfigRust,
    archived: &ArchivedAgentWorkspaces,
) -> bool {
    archived.agent_ids.contains(&agent_cfg.id)
        || archived.paths.contains(&crate::cron_task::normalize_path(
            &agent_cfg.resolved_workspace_path,
        ))
}

pub(crate) fn is_agent_workspace_archived(agent_cfg: &types::AgentConfigRust) -> bool {
    let archived = read_archived_agent_workspaces_from_disk();
    is_agent_workspace_archived_with(agent_cfg, &archived)
}

fn has_non_empty(value: Option<&String>) -> bool {
    value.map(|s| !s.is_empty()).unwrap_or(false)
}

fn im_config_has_start_credentials(config: &ImConfig) -> bool {
    match &config.platform {
        ImPlatform::Telegram => !config.bot_token.is_empty(),
        ImPlatform::Feishu => {
            has_non_empty(config.feishu_app_id.as_ref())
                && has_non_empty(config.feishu_app_secret.as_ref())
        }
        ImPlatform::Dingtalk => {
            has_non_empty(config.dingtalk_client_id.as_ref())
                && has_non_empty(config.dingtalk_client_secret.as_ref())
        }
        ImPlatform::OpenClaw(_) => has_non_empty(config.openclaw_plugin_id.as_ref()),
    }
}

pub(super) fn missing_configured_channel_status(
    persisted_status: &types::ImStatus,
) -> types::ImStatus {
    if matches!(persisted_status, types::ImStatus::Error) {
        return types::ImStatus::Error;
    }
    types::ImStatus::Connecting
}

fn agent_channel_has_start_credentials(
    agent_cfg: &types::AgentConfigRust,
    channel_cfg: &types::ChannelConfigRust,
) -> bool {
    let im_config = channel_cfg.to_im_config(agent_cfg);
    im_config.enabled && im_config_has_start_credentials(&im_config)
}

static GENERAL_PROXY_RECONNECT_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
static GENERAL_PROXY_RECONCILE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Queue transport restarts after the general proxy key changes. Each channel
/// stays live until its existing ReplyRouter has no active request; then the
/// standard stop/start lifecycle applies the new process environment. A newer
/// generation cancels older waiters before they touch channel state.
pub(crate) async fn schedule_general_proxy_channel_reconnects<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_state: &ManagedAgents,
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
) -> u32 {
    use std::sync::atomic::Ordering;

    let generation = GENERAL_PROXY_RECONNECT_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    let agent_count = {
        let agents = agent_state.lock().await;
        agents
            .values()
            .map(|agent| agent.channels.len() as u32)
            .sum::<u32>()
    };
    let legacy_count = im_state.lock().await.len() as u32;
    let scheduled = agent_count + legacy_count;
    let app_handle = app_handle.clone();
    let agent_state = Arc::clone(agent_state);
    let im_state = Arc::clone(im_state);
    let sidecar_manager = Arc::clone(sidecar_manager);
    tauri::async_runtime::spawn(async move {
        let _reconcile_guard = GENERAL_PROXY_RECONCILE_LOCK.lock().await;
        if generation != GENERAL_PROXY_RECONNECT_GENERATION.load(Ordering::Acquire) {
            ulog_info!(
                "[proxy_config] Skipping superseded IM reconnect generation {}",
                generation
            );
            return;
        }
        reconcile_channels_after_general_proxy_change(
            &app_handle,
            &agent_state,
            &im_state,
            &sidecar_manager,
            generation,
        )
        .await;
    });

    ulog_info!(
        "[proxy_config] Scheduled {} IM/Agent transport reconnect(s), generation={}",
        scheduled,
        generation
    );
    scheduled
}

pub(super) fn current_agent_channel_start_config(
    agent_id: &str,
    channel_id: &str,
) -> Result<(AgentConfigRust, ChannelConfigRust, ImConfig), String> {
    if let Some(error) = agent_claim_conflict(&read_projects_for_agent_projection(), agent_id) {
        return Err(error);
    }
    let agent = read_agent_configs_from_disk()
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| {
            format!(
                "Agent '{}' has no resolvable workspace configuration",
                agent_id
            )
        })?;
    if is_agent_workspace_archived(&agent) {
        return Err(format!("Agent '{}' workspace is archived", agent_id));
    }
    let channel = agent
        .channels
        .iter()
        .find(|channel| channel.id == channel_id && channel.enabled)
        .ok_or_else(|| format!("Agent channel '{}' is missing or disabled", channel_id))?
        .clone();
    let mut config = channel.to_im_config(&agent);
    config.heartbeat_config = Some(types::HeartbeatConfig {
        enabled: false,
        ..types::HeartbeatConfig::default()
    });
    if !im_config_has_start_credentials(&config) {
        return Err(format!(
            "Agent channel '{}' has incomplete credentials",
            channel_id
        ));
    }
    Ok((agent, channel, config))
}

fn current_agent_channel_config(agent_id: &str, channel_id: &str) -> Option<ImConfig> {
    current_agent_channel_start_config(agent_id, channel_id)
        .ok()
        .map(|(_, _, config)| config)
}

fn current_legacy_bot_config(bot_id: &str) -> Option<ImConfig> {
    read_im_configs_from_disk()
        .into_iter()
        .find(|(id, config)| {
            id == bot_id && config.enabled && im_config_has_start_credentials(config)
        })
        .map(|(_, config)| config)
}

async fn wait_for_channel_idle(
    consumers: ImConsumers,
    model_work_gate: Arc<ChannelModelWorkGate>,
    generation: u64,
) -> bool {
    loop {
        if generation
            != GENERAL_PROXY_RECONNECT_GENERATION.load(std::sync::atomic::Ordering::Acquire)
        {
            return false;
        }
        let replies_idle = reply_slots_idle(&consumers).await;
        if replies_idle && model_work_gate.active() == 0 {
            if !model_work_gate.try_close() {
                return false;
            }
            let still_current = generation
                == GENERAL_PROXY_RECONNECT_GENERATION.load(std::sync::atomic::Ordering::Acquire);
            let replies_still_idle = reply_slots_idle(&consumers).await;
            if still_current && replies_still_idle && model_work_gate.active() == 0 {
                return true;
            }
            model_work_gate.reopen();
            if !still_current {
                return false;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn reply_slots_idle(consumers: &ImConsumers) -> bool {
    let routers = consumers
        .lock()
        .await
        .values()
        .map(|handle| Arc::clone(&handle.reply_router))
        .collect::<Vec<_>>();
    for router in routers {
        if router.lock().await.slot_count() > 0 {
            return false;
        }
    }
    true
}

async fn reconcile_channels_after_general_proxy_change<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_state: &ManagedAgents,
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    generation: u64,
) {
    let agent_keys: Vec<(String, String)> = {
        let agents = agent_state.lock().await;
        agents
            .iter()
            .flat_map(|(agent_id, agent)| {
                agent
                    .channels
                    .keys()
                    .map(|channel_id| (agent_id.clone(), channel_id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    };
    let legacy_ids: Vec<String> = im_state.lock().await.keys().cloned().collect();
    let mut reconnected = 0_u32;
    let mut failed = 0_u32;

    for (agent_id, channel_id) in agent_keys {
        if generation
            != GENERAL_PROXY_RECONNECT_GENERATION.load(std::sync::atomic::Ordering::Acquire)
        {
            return;
        }
        let Some(_) = current_agent_channel_config(&agent_id, &channel_id) else {
            continue;
        };
        let idle_state = {
            let agents = agent_state.lock().await;
            agents
                .get(&agent_id)
                .and_then(|agent| agent.channels.get(&channel_id))
                .map(|channel| {
                    (
                        Arc::clone(&channel.bot_instance.im_consumers),
                        Arc::clone(&channel.bot_instance.model_work_gate),
                    )
                })
        };
        let Some((consumers, model_work_gate)) = idle_state else {
            continue;
        };
        if !wait_for_channel_idle(consumers, Arc::clone(&model_work_gate), generation).await {
            return;
        }
        // Config may have been disabled/deleted while the active reply drained.
        let Some(_) = current_agent_channel_config(&agent_id, &channel_id) else {
            model_work_gate.reopen();
            ulog_info!(
                "[proxy_config] Channel {} no longer enabled after reconnect boundary",
                channel_id
            );
            failed += 1;
            continue;
        };

        match restart_agent_channel_instance(
            app_handle,
            agent_state,
            sidecar_manager,
            &agent_id,
            &channel_id,
        )
        .await
        {
            Ok(true) => reconnected += 1,
            Ok(false) => {
                model_work_gate.reopen();
            }
            Err(err) => {
                // The agent monitor owns retry/recovery from the durable config.
                failed += 1;
                ulog_warn!(
                    "[proxy_config] Channel {} transport reconnect failed; monitor will retry: {}",
                    channel_id,
                    err
                );
            }
        }
    }

    for bot_id in legacy_ids {
        if generation
            != GENERAL_PROXY_RECONNECT_GENERATION.load(std::sync::atomic::Ordering::Acquire)
        {
            return;
        }
        let Some(_) = current_legacy_bot_config(&bot_id) else {
            continue;
        };
        let idle_state = im_state.lock().await.get(&bot_id).map(|instance| {
            (
                Arc::clone(&instance.im_consumers),
                Arc::clone(&instance.model_work_gate),
            )
        });
        let Some((consumers, model_work_gate)) = idle_state else {
            continue;
        };
        if !wait_for_channel_idle(consumers, Arc::clone(&model_work_gate), generation).await {
            return;
        }
        let Some(config) = current_legacy_bot_config(&bot_id) else {
            model_work_gate.reopen();
            failed += 1;
            continue;
        };

        match start_im_bot(
            app_handle,
            im_state,
            sidecar_manager,
            bot_id.clone(),
            config,
        )
        .await
        {
            Ok(_) => {
                reconnected += 1;
            }
            Err(err) => {
                failed += 1;
                ulog_warn!(
                    "[proxy_config] Legacy channel {} transport reconnect failed: {}",
                    bot_id,
                    err
                );
            }
        }
    }

    ulog_info!(
        "[proxy_config] IM reconnect generation {} complete: {} reconnected, {} failed",
        generation,
        reconnected,
        failed
    );
    let _ = app_handle.emit(
        "agent:status-changed",
        json!({
            "event": "general_proxy_changed",
            "reconnected": reconnected,
            "failed": failed,
        }),
    );
}

pub(super) fn should_report_missing_configured_channel(
    agent_cfg: &types::AgentConfigRust,
    channel_cfg: &types::ChannelConfigRust,
) -> bool {
    channel_cfg.enabled && agent_channel_has_start_credentials(agent_cfg, channel_cfg)
}

fn find_missing_startable_agent_channels(
    agent_configs: &[types::AgentConfigRust],
    running_channel_keys: &std::collections::HashSet<(String, String)>,
    recovering_channels: &[(String, String)],
    archived_workspaces: &ArchivedAgentWorkspaces,
) -> Vec<(String, String)> {
    let mut missing = Vec::new();
    for agent_cfg in agent_configs {
        if is_agent_workspace_archived_with(agent_cfg, archived_workspaces) {
            continue;
        }
        for channel_cfg in &agent_cfg.channels {
            if !channel_cfg.enabled {
                continue;
            }
            let key = (agent_cfg.id.clone(), channel_cfg.id.clone());
            if running_channel_keys.contains(&key)
                || recovering_channels
                    .iter()
                    .any(|(aid, cid)| aid == &agent_cfg.id && cid == &channel_cfg.id)
            {
                continue;
            }
            let im_config = channel_cfg.to_im_config(agent_cfg);
            if im_config.enabled && im_config_has_start_credentials(&im_config) {
                missing.push(key);
            }
        }
    }
    missing
}

#[cfg(test)]
mod workspace_projection_tests {
    use super::*;
    use crate::mcp_selection::normalize_mcp_selection_field;

    #[test]
    fn mcp_selection_compatibility_matches_typescript_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/__fixtures__/mcpSelection.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let mut holder = fixture["input"].clone();
            normalize_mcp_selection_field(&mut holder);
            assert_eq!(holder, fixture["expected"], "{}", fixture["name"]);
            assert!(!normalize_mcp_selection_field(&mut holder));
        }
    }

    #[test]
    fn mcp_selection_keeps_legacy_agent_available_and_heals_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut value = serde_json::json!({
            "agentChannelIndependenceMigrationV1": true,
            "mcpEnabledServers": "[]",
            "agents": [{
                "id": "legacy", "name": "Legacy", "enabled": false,
                "workspacePath": "C:/isolated/workspace", "channels": [],
                "mcpEnabledServers": "[playwright,tavily-search]",
                "mcpServersJson": "[]"
            }]
        });
        std::fs::write(&path, value.to_string()).unwrap();
        assert!(normalize_stringified_json_value(&mut value));
        let agents = agents_from(&value);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "legacy");
        assert_eq!(
            agents[0].mcp_enabled_servers,
            Some(vec!["playwright".into(), "tavily-search".into()])
        );
        assert_eq!(value["agents"][0]["mcpServersJson"], "[]");
        assert_eq!(value["mcpEnabledServers"], serde_json::json!([]));
        persist_agent_config_read_heal(&path, "MCP selection test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let persisted: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert_eq!(agents_from(&persisted).len(), 1);
        assert_eq!(
            persisted["agents"][0]["mcpEnabledServers"],
            value["agents"][0]["mcpEnabledServers"]
        );
        let backup_path = path.with_file_name("config.json.bak");
        let backup = std::fs::read_to_string(&backup_path).unwrap();
        persist_agent_config_read_heal(&path, "MCP selection test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(std::fs::read_to_string(&backup_path).unwrap(), backup);
    }

    fn agents_from(value: &serde_json::Value) -> Vec<AgentConfigRust> {
        salvage_agents_from_value(value, &std::collections::HashMap::new())
            .expect("valid Agent fixture")
    }

    #[test]
    fn matches_the_cross_language_compatibility_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/shared/fixtures/agent-workspace-compatibility.json"
        ))
        .expect("valid shared compatibility fixture");
        let projects = fixture["projects"]
            .as_array()
            .expect("projects array")
            .iter()
            .map(|project| PartialProjectEntry {
                id: project["id"].as_str().map(str::to_owned),
                agent_id: project["agentId"].as_str().map(str::to_owned),
                path: project["path"].as_str().map(str::to_owned),
                archived_at: None,
            })
            .collect::<Vec<_>>();
        let projected = project_agent_workspaces_with(&fixture, &projects, agents_from(&fixture));
        let actual = projected
            .iter()
            .map(|agent| {
                serde_json::json!({
                    "agentId": agent.id,
                    "workspacePath": agent.resolved_workspace_path,
                })
            })
            .collect::<Vec<_>>();
        let expected = fixture["expectedProjections"]
            .as_array()
            .expect("expected projections")
            .iter()
            .map(|projection| {
                serde_json::json!({
                    "agentId": projection["agentId"],
                    "workspacePath": projection["workspacePath"],
                })
            })
            .collect::<Vec<_>>();

        assert_eq!(actual, expected);
    }

    #[test]
    fn claim_conflict_reports_paths_and_stop_retains_unprojectable_channel_ids() {
        let projects: Vec<PartialProjectEntry> = serde_json::from_value(serde_json::json!([
            {"id":"one", "path":"/one", "agentId":"shared"},
            {"id":"hidden", "path":"/hidden", "agentId":"shared", "hidden":true},
            {"id":"healthy", "path":"/healthy", "agentId":"healthy"}
        ]))
        .unwrap();
        let error = agent_claim_conflict(&projects, "shared").unwrap();
        assert!(error.contains("AGENT_ASSIGNED_TO_MULTIPLE_PROJECTS"));
        assert!(error.contains("/one") && error.contains("/hidden"));
        assert!(agent_claim_conflict(&projects, "healthy").is_none());
        let value = serde_json::json!({"agents":[
            {"id":"shared", "channels":[{"id":"pending"}, {"id":"disabled", "enabled":false}]},
            {"id":"healthy", "channels":[{"id":"untouched"}]}
        ]});
        assert_eq!(
            agent_channel_ids_from_value(&value, "shared"),
            vec!["pending", "disabled"]
        );
    }

    #[test]
    fn exact_project_link_uses_project_path_and_keeps_legacy_extra_accessible() {
        let value = serde_json::json!({
            "agents": [
                { "id": "selected", "name": "Selected", "enabled": true, "workspacePath": "/repo/old" },
                { "id": "extra", "name": "Extra", "enabled": true, "workspacePath": "/repo/current" }
            ]
        });
        let projects = vec![PartialProjectEntry {
            id: None,
            agent_id: Some("selected".to_string()),
            path: Some("/repo/current".to_string()),
            archived_at: None,
        }];

        let projected = project_agent_workspaces_with(&value, &projects, agents_from(&value));

        assert_eq!(projected[0].resolved_workspace_path, "/repo/current");
        assert_eq!(projected[1].resolved_workspace_path, "/repo/current");
        assert!(serde_json::to_value(&projected[0])
            .unwrap()
            .get("workspacePath")
            .is_none());
    }

    #[test]
    fn orphan_keeps_legacy_path_and_duplicate_claim_only_skips_that_target() {
        let value = serde_json::json!({
            "agents": [
                { "id": "conflict", "name": "Conflict", "enabled": true, "workspacePath": "/repo/old" },
                { "id": "orphan", "name": "Orphan", "enabled": true, "workspacePath": "/repo/orphan" }
            ]
        });
        let projects = vec![
            PartialProjectEntry {
                id: None,
                agent_id: Some("conflict".to_string()),
                path: Some("/repo/a".to_string()),
                archived_at: None,
            },
            PartialProjectEntry {
                id: None,
                agent_id: Some("conflict".to_string()),
                path: Some("/repo/b".to_string()),
                archived_at: None,
            },
        ];

        let projected = project_agent_workspaces_with(&value, &projects, agents_from(&value));

        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].id, "orphan");
        assert_eq!(projected[0].resolved_workspace_path, "/repo/orphan");
    }

    #[test]
    fn duplicate_project_workspace_skips_exact_claims_but_keeps_healthy_targets() {
        let value = serde_json::json!({
            "agents": [
                { "id": "conflict-a", "name": "A", "enabled": true },
                { "id": "conflict-b", "name": "B", "enabled": true },
                { "id": "healthy", "name": "Healthy", "enabled": true }
            ]
        });
        let projects = vec![
            PartialProjectEntry {
                id: None,
                agent_id: Some("conflict-a".to_string()),
                path: Some("C:\\Repo".to_string()),
                archived_at: None,
            },
            PartialProjectEntry {
                id: None,
                agent_id: Some("conflict-b".to_string()),
                path: Some("c:/repo/".to_string()),
                archived_at: None,
            },
            PartialProjectEntry {
                id: None,
                agent_id: Some("healthy".to_string()),
                path: Some("/repo/healthy".to_string()),
                archived_at: None,
            },
        ];

        let projected = project_agent_workspaces_with(&value, &projects, agents_from(&value));

        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].id, "healthy");
        assert_eq!(projected[0].resolved_workspace_path, "/repo/healthy");
    }

    #[test]
    fn pathless_new_agent_runs_from_its_exact_project() {
        let value = serde_json::json!({
            "agents": [{ "id": "new", "name": "New", "enabled": true }]
        });
        let projects = vec![PartialProjectEntry {
            id: None,
            agent_id: Some("new".to_string()),
            path: Some("/repo/new".to_string()),
            archived_at: None,
        }];

        let projected = project_agent_workspaces_with(&value, &projects, agents_from(&value));
        assert_eq!(projected[0].resolved_workspace_path, "/repo/new");
    }
}

#[cfg(test)]
mod agent_monitor_tests {
    use super::*;

    #[test]
    fn channel_independence_migration_projects_disabled_master_once() {
        let mut config = serde_json::json!({
            "agents": [{
                "id": "disabled-agent",
                "name": "Disabled",
                "enabled": false,
                "heartbeat": { "enabled": true, "intervalMinutes": 48 },
                "memoryAutoUpdate": {
                    "enabled": true,
                    "intervalHours": 72,
                    "queryThreshold": 9,
                    "updateWindowStart": "20:00",
                    "updateWindowEnd": "08:00",
                    "lastBatchSessionCount": 7
                },
                "memoryEvolution": {
                    "enabled": true,
                    "lastGardenerStatus": "completed"
                },
                "channels": [{
                    "id": "channel-1",
                    "type": "telegram",
                    "enabled": true,
                    "botToken": "secret-is-preserved"
                }]
            }]
        });

        assert!(migrate_agent_channel_independence_value(&mut config).unwrap());
        assert_eq!(config[AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1], true);
        assert_eq!(config["agents"][0]["heartbeat"]["enabled"], false);
        assert_eq!(config["agents"][0]["heartbeat"]["intervalMinutes"], 48);
        assert_eq!(
            config["agents"][0]["memoryAutoUpdate"]["lastBatchSessionCount"],
            7
        );
        assert_eq!(
            config["agents"][0]["memoryEvolution"]["lastGardenerStatus"],
            "completed"
        );
        assert_eq!(config["agents"][0]["channels"][0]["enabled"], false);
        assert_eq!(
            config["agents"][0]["channels"][0]["botToken"],
            "secret-is-preserved"
        );

        let migrated = config.clone();
        assert!(!migrate_agent_channel_independence_value(&mut config).unwrap());
        assert_eq!(config, migrated);
    }

    #[test]
    fn channel_independence_migration_enables_children_and_preserves_channels() {
        let mut config = serde_json::json!({
            "agents": [{
                "id": "enabled-agent",
                "name": "Enabled",
                "enabled": true,
                "memoryEvolution": { "enabled": false, "lastMoltStatus": "error" },
                "channels": [
                    { "id": "on", "type": "telegram", "enabled": true },
                    { "id": "off", "type": "telegram", "enabled": false }
                ]
            }]
        });

        assert!(migrate_agent_channel_independence_value(&mut config).unwrap());
        assert_eq!(config["agents"][0]["heartbeat"]["enabled"], true);
        assert_eq!(config["agents"][0]["memoryAutoUpdate"]["enabled"], true);
        assert_eq!(config["agents"][0]["memoryEvolution"]["enabled"], true);
        assert_eq!(
            config["agents"][0]["memoryEvolution"]["lastMoltStatus"],
            "error"
        );
        assert_eq!(config["agents"][0]["channels"][0]["enabled"], true);
        assert_eq!(config["agents"][0]["channels"][1]["enabled"], false);
    }

    #[test]
    fn channel_independence_migration_is_transactional_for_malformed_agents() {
        let mut config = serde_json::json!({
            "agents": [
                { "id": "healthy", "name": "Healthy", "enabled": false, "channels": [] },
                { "id": "malformed", "enabled": "yes" }
            ]
        });
        let original = config.clone();

        assert!(migrate_agent_channel_independence_value(&mut config).is_err());
        assert_eq!(config, original);
        assert!(config
            .get(AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1)
            .is_none());
    }

    #[test]
    fn normalize_coerces_object_stringified_json_fields() {
        let fixture = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/__fixtures__/dirtyConfig301.json"
        ));
        let mut value: serde_json::Value = serde_json::from_str(fixture).unwrap();

        // Before: the strict parse of the dirty agent fails (the #301 symptom).
        assert!(
            serde_json::from_value::<types::AgentConfigRust>(value["agents"][0].clone()).is_err(),
            "fixture's dirty agent should fail a strict parse before normalization"
        );

        assert!(normalize_stringified_json_value(&mut value));

        // After: the object fields are strings that round-trip to the original JSON.
        let dirty = &value["agents"][0];
        assert!(dirty["providerEnvJson"].is_string());
        assert!(dirty["mcpServersJson"].is_string());
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(dirty["providerEnvJson"].as_str().unwrap())
                .unwrap(),
            serde_json::json!({
                "baseUrl": "https://api.example.com",
                "apiKey": "sk-agent-test",
                "authType": "auth_token"
            })
        );
        assert!(dirty["channels"][0]["overrides"]["providerEnvJson"].is_string());

        // And the strict parse now succeeds.
        assert!(
            serde_json::from_value::<types::AgentConfigRust>(value["agents"][0].clone()).is_ok(),
            "strict parse should succeed after normalization"
        );

        // Idempotent on a clean config, and already-stringified values are untouched.
        assert!(!normalize_stringified_json_value(&mut value));
        assert_eq!(
            value["agents"][1]["providerEnvJson"].as_str().unwrap(),
            "{\"baseUrl\":\"https://clean.example.com\",\"apiKey\":\"sk-clean\"}"
        );
    }

    /// Non-string scalar values are dropped, matching the TS twin
    /// `coerceJsonStringField` (which `delete`s number/bool). Keeps the two
    /// normalizers in sync per the "MUST stay in sync" contract.
    #[test]
    fn normalize_drops_non_string_scalar_fields() {
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a", "name": "A", "enabled": true, "workspacePath": "/w",
                "providerEnvJson": 42,
                "mcpServersJson": true
            }]
        });
        assert!(normalize_stringified_json_value(&mut value));
        let agent = &value["agents"][0];
        assert!(agent.get("providerEnvJson").is_none());
        assert!(agent.get("mcpServersJson").is_none());
        // String / absent are untouched → second pass is a no-op.
        assert!(!normalize_stringified_json_value(&mut value));
    }

    /// Issue #398: the Agent settings UI can leave a selected remote HTTP/SSE
    /// MCP definition only in `agents[].mcpServersJson`. Agent channel cold-start
    /// self-resolve reads the global registry, so the Rust reader must heal the
    /// same split as the renderer load boundary before auto-start.
    #[test]
    fn promote_agent_mcp_json_to_global_recovers_selected_custom_definition() {
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w",
                "mcpEnabledServers": ["remote-http"],
                "mcpServersJson": serde_json::json!([{
                    "id": "remote-http",
                    "name": "Remote HTTP",
                    "type": "http",
                    "url": "https://mcp.example.com/mcp",
                    "headers": { "Authorization": "Bearer token" },
                    "isBuiltin": false
                }]).to_string()
            }],
            "mcpServers": [],
            "mcpEnabledServers": []
        });

        assert!(promote_agent_mcp_json_to_global_value(&mut value));
        assert_eq!(value["mcpServers"][0]["id"], "remote-http");
        assert_eq!(value["mcpServers"][0]["isBuiltin"], false);
        assert_eq!(
            value["mcpEnabledServers"],
            serde_json::json!(["remote-http"])
        );
        assert!(!promote_agent_mcp_json_to_global_value(&mut value));
    }

    #[test]
    fn promote_agent_mcp_json_to_global_does_not_reenable_known_disabled_server() {
        let remote = serde_json::json!({
            "id": "remote-sse",
            "name": "Remote SSE",
            "type": "sse",
            "url": "https://mcp.example.com/sse",
            "isBuiltin": false
        });
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w",
                "mcpEnabledServers": ["remote-sse"],
                "mcpServersJson": serde_json::json!([remote.clone()]).to_string()
            }],
            "mcpServers": [remote],
            "mcpEnabledServers": []
        });

        assert!(!promote_agent_mcp_json_to_global_value(&mut value));
        assert_eq!(value["mcpEnabledServers"], serde_json::json!([]));
    }

    #[test]
    fn promote_agent_mcp_json_to_global_skips_malformed_or_non_remote_definitions() {
        let mut value = serde_json::json!({
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w",
                "mcpEnabledServers": ["remote-without-url", "agent-stdio"],
                "mcpServersJson": serde_json::json!([
                    {
                        "id": "remote-without-url",
                        "name": "Remote Missing URL",
                        "type": "http",
                        "isBuiltin": false
                    },
                    {
                        "id": "agent-stdio",
                        "name": "Agent Stdio",
                        "type": "stdio",
                        "command": "node",
                        "isBuiltin": false
                    }
                ]).to_string()
            }],
            "mcpServers": [],
            "mcpEnabledServers": []
        });

        assert!(!promote_agent_mcp_json_to_global_value(&mut value));
        assert_eq!(value["mcpServers"], serde_json::json!([]));
        assert_eq!(value["mcpEnabledServers"], serde_json::json!([]));
    }

    /// Issue #316: missing providerEnvJson was rebuilt only on the typed clone
    /// returned by `read_agent_configs_from_disk`, so status polling re-read the
    /// still-missing disk config every 5s and logged the migration repeatedly.
    /// The raw Value migration is what can be persisted once under config lock.
    #[test]
    fn agent_provider_env_value_migration_is_idempotent() {
        let keys = std::collections::HashMap::from([
            ("siliconflow".to_string(), "sk-sf-test".to_string()),
            ("zenmux".to_string(), "sk-zen-test".to_string()),
        ]);
        let mut value = serde_json::json!({
            "providerApiKeys": {
                "siliconflow": "sk-sf-test",
                "zenmux": "sk-zen-test"
            },
            "agents": [{
                "id": "agent-1",
                "name": "Agent",
                "enabled": true,
                "workspacePath": "/tmp/project",
                "providerId": "siliconflow",
                "channels": [{
                    "id": "ch-1",
                    "type": "telegram",
                    "enabled": true,
                    "botToken": "bot-token",
                    "overrides": {
                        "providerId": "zenmux"
                    }
                }]
            }]
        });

        assert!(migrate_agent_provider_env_value(&mut value, &keys, false));
        assert!(value["agents"][0]["providerEnvJson"].is_string());
        assert!(value["agents"][0]["channels"][0]["overrides"]["providerEnvJson"].is_string());

        let agents = salvage_agents_from_value(&value, &keys).expect("agent should parse");
        assert!(agents[0].provider_env_json.is_some());
        assert!(agents[0].channels[0]
            .overrides
            .as_ref()
            .and_then(|ov| ov.provider_env_json.as_ref())
            .is_some());

        assert!(!migrate_agent_provider_env_value(&mut value, &keys, false));
    }

    fn temp_config_path(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "myagents-im-{}-{}-{}",
            name,
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn openclaw_lark_streaming_value_migration_is_typed_and_idempotent() {
        let mut value = serde_json::json!({
            "agents": [{
                "channels": [
                    {
                        "id": "lark-agent",
                        "type": "openclaw:openclaw-lark",
                        "openclawPluginId": "openclaw-lark",
                        "openclawPluginConfig": { "streaming": "true" }
                    },
                    {
                        "id": "type-only",
                        "type": "openclaw:openclaw-lark",
                        "openclawPluginConfig": { "streaming": "true" }
                    },
                    {
                        "type": "openclaw:other",
                        "openclawPluginConfig": { "streaming": "true" }
                    },
                    {
                        "openclawPluginId": "openclaw-lark",
                        "openclawPluginConfig": { "streaming": "unknown" }
                    },
                    {
                        "openclawPluginId": "openclaw-lark",
                        "openclawPluginConfig": { "streaming": "TRUE" }
                    }
                ]
            }],
            "imBotConfigs": [{
                "id": "lark-legacy",
                "openclawPluginId": "openclaw-lark",
                "openclawPluginConfig": { "streaming": "false" }
            }, {
                "id": "npm-only",
                "openclawNpmSpec": "@larksuite/openclaw-lark@2026.6.10",
                "openclawPluginConfig": { "streaming": "false" }
            }]
        });

        assert_eq!(
            migrate_openclaw_lark_streaming_value(&mut value),
            vec!["lark-agent".to_string(), "lark-legacy".to_string()]
        );
        assert_eq!(
            value["agents"][0]["channels"][0]["openclawPluginConfig"]["streaming"],
            serde_json::Value::Bool(true)
        );
        assert_eq!(
            value["imBotConfigs"][0]["openclawPluginConfig"]["streaming"],
            serde_json::Value::Bool(false)
        );
        assert_eq!(
            value["agents"][0]["channels"][1]["openclawPluginConfig"]["streaming"],
            "true"
        );
        assert_eq!(
            value["agents"][0]["channels"][2]["openclawPluginConfig"]["streaming"],
            "true"
        );
        assert_eq!(
            value["agents"][0]["channels"][3]["openclawPluginConfig"]["streaming"],
            "unknown"
        );
        assert_eq!(
            value["agents"][0]["channels"][4]["openclawPluginConfig"]["streaming"],
            "TRUE"
        );
        assert_eq!(
            value["imBotConfigs"][1]["openclawPluginConfig"]["streaming"],
            "false"
        );
        assert!(migrate_openclaw_lark_streaming_value(&mut value).is_empty());
    }

    #[test]
    fn openclaw_lark_streaming_read_heal_persists_once_under_config_lock() {
        let path = temp_config_path("lark-streaming-heal");
        let dir = path.parent().unwrap().to_path_buf();
        std::fs::write(
            &path,
            serde_json::json!({
                "agents": [{
                    "id": "agent-1",
                    "name": "Agent",
                    "enabled": true,
                    "workspacePath": "/tmp/project",
                    "channels": [{
                        "id": "lark",
                        "type": "openclaw:openclaw-lark",
                        "enabled": true,
                        "openclawPluginId": "openclaw-lark",
                        "openclawPluginConfig": { "streaming": "true" }
                    }]
                }],
                "imBotConfigs": [{
                    "id": "legacy-lark",
                    "openclawPluginId": "openclaw-lark",
                    "openclawPluginConfig": { "streaming": "false" }
                }]
            })
            .to_string(),
        )
        .unwrap();

        persist_agent_config_read_heal(&path, "test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let healed_value: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert_eq!(
            healed_value["agents"][0]["channels"][0]["openclawPluginConfig"]["streaming"],
            true
        );
        assert_eq!(
            healed_value["imBotConfigs"][0]["openclawPluginConfig"]["streaming"],
            false
        );
        let backup_after_first = std::fs::read_to_string(path.with_file_name("config.json.bak"))
            .expect("first heal should keep a backup of the pre-heal config");

        persist_agent_config_read_heal(&path, "test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup_after_first
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn channel_independence_read_heal_persists_marker_and_backup_once() {
        let path = temp_config_path("channel-independence-heal");
        let dir = path.parent().unwrap().to_path_buf();
        let original = serde_json::json!({
            "agents": [{
                "id": "agent-1",
                "name": "Agent",
                "enabled": false,
                "workspacePath": "/tmp/project",
                "heartbeat": { "enabled": true, "intervalMinutes": 30 },
                "memoryAutoUpdate": { "enabled": true },
                "memoryEvolution": { "enabled": true },
                "channels": [{
                    "id": "telegram-1",
                    "type": "telegram",
                    "enabled": true,
                    "botToken": "preserved-secret"
                }]
            }]
        })
        .to_string();
        std::fs::write(&path, &original).unwrap();

        persist_agent_config_read_heal(&path, "test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let healed_value: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert_eq!(healed_value[AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1], true);
        assert_eq!(healed_value["agents"][0]["heartbeat"]["enabled"], false);
        assert_eq!(
            healed_value["agents"][0]["memoryAutoUpdate"]["enabled"],
            false
        );
        assert_eq!(
            healed_value["agents"][0]["memoryEvolution"]["enabled"],
            false
        );
        assert_eq!(healed_value["agents"][0]["channels"][0]["enabled"], false);
        assert_eq!(
            healed_value["agents"][0]["channels"][0]["botToken"],
            "preserved-secret"
        );
        let backup_path = path.with_file_name("config.json.bak");
        assert_eq!(std::fs::read_to_string(&backup_path).unwrap(), original);

        persist_agent_config_read_heal(&path, "test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(std::fs::read_to_string(&backup_path).unwrap(), original);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn channel_independence_read_heal_failure_leaves_marker_uncommitted() {
        let path = temp_config_path("channel-independence-heal-failure");
        let dir = path.parent().unwrap().to_path_buf();
        let original = serde_json::json!({
            "agents": [{
                "id": "agent-1",
                "name": "Agent",
                "enabled": true,
                "channels": [{ "id": "channel-1", "type": "telegram", "enabled": true }]
            }]
        })
        .to_string();
        std::fs::write(&path, &original).unwrap();
        // Block the atomic temp-file write without changing the source file.
        std::fs::create_dir(path.with_file_name("config.json.tmp.rust")).unwrap();

        persist_agent_config_read_heal(&path, "injected write failure");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let persisted: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(!agent_channel_independence_migration_complete(&persisted));
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            original
        );

        let mut agents = salvage_agents_from_value(&persisted, &std::collections::HashMap::new())
            .expect("valid Agent fixture");
        fail_closed_agent_channels(&mut agents);
        assert!(!agents[0].channels[0].enabled);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_provider_env_read_heal_persists_once_for_usable_main_config() {
        let path = temp_config_path("provider-env-heal-ok");
        let dir = path.parent().unwrap().to_path_buf();
        std::fs::write(
            &path,
            serde_json::json!({
                "providerApiKeys": {
                    "siliconflow": "sk-sf-test"
                },
                "agents": [{
                    "id": "agent-1",
                    "name": "Agent",
                    "enabled": true,
                    "workspacePath": "/tmp/project",
                    "providerId": "siliconflow",
                    "channels": []
                }]
            })
            .to_string(),
        )
        .unwrap();

        persist_agent_config_read_heal(&path, "test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let healed_value: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert!(healed_value["agents"][0]["providerEnvJson"].is_string());
        let backup_after_first = std::fs::read_to_string(path.with_file_name("config.json.bak"))
            .expect("first heal should keep a backup of the pre-heal config");

        persist_agent_config_read_heal(&path, "test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup_after_first,
            "second idempotent heal must not rewrite config or rotate backup"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_provider_env_read_heal_skips_unusable_main_config() {
        let path = temp_config_path("provider-env-heal-bad-main");
        let dir = path.parent().unwrap().to_path_buf();
        let bad_main = serde_json::json!({
            "providerApiKeys": {
                "siliconflow": "sk-sf-test"
            },
            "agents": [{
                "providerId": "siliconflow"
            }]
        })
        .to_string();
        let backup = "{\"agents\":[{\"id\":\"fallback\"}]}";
        std::fs::write(&path, &bad_main).unwrap();
        std::fs::write(path.with_file_name("config.json.bak"), backup).unwrap();

        persist_agent_config_read_heal(&path, "test");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), bad_main);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup,
            "read-time heal must not clobber fallback backup when main agents[] is unusable"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_mcp_read_heal_persists_promoted_global_registry_once() {
        let path = temp_config_path("mcp-heal-ok");
        let dir = path.parent().unwrap().to_path_buf();
        let remote = serde_json::json!({
            "id": "remote-http",
            "name": "Remote HTTP",
            "type": "http",
            "url": "https://mcp.example.com/mcp",
            "isBuiltin": false
        });
        std::fs::write(
            &path,
            serde_json::json!({
                "agents": [{
                    "id": "agent-1",
                    "name": "Agent",
                    "enabled": true,
                    "workspacePath": "/tmp/project",
                    "mcpEnabledServers": ["remote-http"],
                    "mcpServersJson": serde_json::json!([remote]).to_string(),
                    "channels": []
                }],
                "mcpServers": [],
                "mcpEnabledServers": []
            })
            .to_string(),
        )
        .unwrap();

        persist_agent_config_read_heal(&path, "test");
        let healed = std::fs::read_to_string(&path).unwrap();
        let healed_value: serde_json::Value = serde_json::from_str(&healed).unwrap();
        assert_eq!(healed_value["mcpServers"][0]["id"], "remote-http");
        assert_eq!(
            healed_value["mcpEnabledServers"],
            serde_json::json!(["remote-http"])
        );
        let backup_after_first = std::fs::read_to_string(path.with_file_name("config.json.bak"))
            .expect("first heal should keep a backup of the pre-heal config");

        persist_agent_config_read_heal(&path, "test");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), healed);
        assert_eq!(
            std::fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
            backup_after_first,
            "second idempotent heal must not rewrite config or rotate backup"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// `salvage_agents_from_value` signals recovery (`None`) only when the
    /// `agents` value is present-but-unusable, and salvages valid entries from a
    /// mixed array.
    #[test]
    fn salvage_agents_signals_recovery_correctly() {
        let keys = std::collections::HashMap::new();
        let valid = serde_json::json!({
            "id": "a", "name": "A", "enabled": true, "workspacePath": "/w"
        });
        let malformed = serde_json::json!({ "id": "b" }); // missing required fields

        // Absent / empty array → Some([]) (legitimately no agents; do NOT recover).
        assert_eq!(
            salvage_agents_from_value(&serde_json::json!({}), &keys).map(|v| v.len()),
            Some(0)
        );
        assert_eq!(
            salvage_agents_from_value(&serde_json::json!({ "agents": [] }), &keys).map(|v| v.len()),
            Some(0)
        );

        // Mixed array → salvage the valid one.
        let mixed = serde_json::json!({ "agents": [valid.clone(), malformed.clone()] });
        assert_eq!(
            salvage_agents_from_value(&mixed, &keys).map(|v| v.len()),
            Some(1)
        );

        // Every entry malformed → None (recover).
        let all_bad = serde_json::json!({ "agents": [malformed.clone(), malformed.clone()] });
        assert!(salvage_agents_from_value(&all_bad, &keys).is_none());

        // `agents` present but not an array → None (recover).
        let non_array = serde_json::json!({ "agents": { "oops": true } });
        assert!(salvage_agents_from_value(&non_array, &keys).is_none());
    }

    #[test]
    fn salvage_agents_projects_the_root_runtime_default_without_persisting_it_per_agent() {
        let keys = std::collections::HashMap::new();
        let value = serde_json::json!({
            "defaultIntegratedRuntime": "dsh",
            "agents": [{
                "id": "a",
                "name": "A",
                "enabled": true,
                "workspacePath": "/w"
            }]
        });

        let agents = salvage_agents_from_value(&value, &keys).expect("valid Agent");
        assert!(agents[0].runtime_selection_available);
        assert_eq!(agents[0].default_integrated_runtime.as_deref(), Some("dsh"));
        assert!(serde_json::to_value(&agents[0])
            .expect("serialized Agent")
            .get("defaultIntegratedRuntime")
            .is_none());
    }

    fn agent_config_with_weixin_channel(enabled: bool) -> Vec<types::AgentConfigRust> {
        serde_json::from_value(json!([{
            "id": "agent-1",
            "name": "Agent",
            "enabled": true,
            "workspacePath": "/tmp/project",
            "channels": [{
                "id": "weixin",
                "type": "openclaw:weixin",
                "enabled": enabled,
                "openclawPluginId": "openclaw-weixin"
            }]
        }]))
        .unwrap()
    }

    #[test]
    fn monitor_reconcile_finds_enabled_channel_missing_from_runtime_state() {
        let agents = agent_config_with_weixin_channel(true);
        let running = std::collections::HashSet::new();

        let archived = ArchivedAgentWorkspaces::default();
        let missing = find_missing_startable_agent_channels(&agents, &running, &[], &archived);

        assert_eq!(missing, vec![("agent-1".to_string(), "weixin".to_string())]);
    }

    #[test]
    fn monitor_reconcile_keeps_channels_startable_when_proactive_agent_is_off() {
        let mut agents = agent_config_with_weixin_channel(true);
        agents[0].enabled = false;

        let missing = find_missing_startable_agent_channels(
            &agents,
            &std::collections::HashSet::new(),
            &[],
            &ArchivedAgentWorkspaces::default(),
        );

        assert_eq!(missing, vec![("agent-1".to_string(), "weixin".to_string())]);
        assert!(should_report_missing_configured_channel(
            &agents[0],
            &agents[0].channels[0],
        ));
    }

    #[test]
    fn monitor_reconcile_skips_running_or_disabled_channels() {
        let agents = agent_config_with_weixin_channel(true);
        let running =
            std::collections::HashSet::from([("agent-1".to_string(), "weixin".to_string())]);

        let archived = ArchivedAgentWorkspaces::default();
        assert!(
            find_missing_startable_agent_channels(&agents, &running, &[], &archived).is_empty()
        );

        let disabled_agents = agent_config_with_weixin_channel(false);
        assert!(find_missing_startable_agent_channels(
            &disabled_agents,
            &std::collections::HashSet::new(),
            &[],
            &archived,
        )
        .is_empty());
    }

    #[test]
    fn monitor_and_status_skip_runtime_incompatible_channels() {
        let mut agents = agent_config_with_weixin_channel(true);
        agents[0].runtime_selection_available = true;
        agents[0].runtime_preference = Some(types::RuntimePreferenceRust {
            family: "integrated".to_string(),
            id: "future-runtime".to_string(),
        });
        let channel = &agents[0].channels[0];

        assert!(!channel.to_im_config(&agents[0]).enabled);
        assert!(!should_report_missing_configured_channel(
            &agents[0], channel,
        ));
        assert!(find_missing_startable_agent_channels(
            &agents,
            &std::collections::HashSet::new(),
            &[],
            &ArchivedAgentWorkspaces::default(),
        )
        .is_empty());
    }

    #[test]
    fn missing_configured_channel_reports_connecting_when_enabled_and_startable() {
        let status = missing_configured_channel_status(&types::ImStatus::Stopped);

        assert_eq!(status, types::ImStatus::Connecting);
    }

    #[test]
    fn missing_configured_channel_preserves_error_for_enabled_startable_channel() {
        assert_eq!(
            missing_configured_channel_status(&types::ImStatus::Error),
            types::ImStatus::Error
        );
    }

    fn hb_peer(session_key: &str, age_millis: u64) -> crate::im::router::HeartbeatPeerTarget {
        crate::im::router::HeartbeatPeerTarget {
            session_key: session_key.to_string(),
            source: "test_private".to_string(),
            source_id: session_key.to_string(),
            last_active: std::time::Instant::now()
                .checked_sub(std::time::Duration::from_millis(age_millis))
                .unwrap(),
        }
    }

    fn hb_candidate(
        channel_id: &str,
        explicit_private_target: Option<crate::im::router::HeartbeatPeerTarget>,
        last_active_private_target: Option<crate::im::router::HeartbeatPeerTarget>,
        latest_private_target: Option<crate::im::router::HeartbeatPeerTarget>,
    ) -> HeartbeatTargetCandidate {
        HeartbeatTargetCandidate {
            channel_id: channel_id.to_string(),
            status: types::ImStatus::Online,
            explicit_private_target,
            last_active_private_target,
            latest_private_target,
        }
    }

    #[test]
    fn heartbeat_target_uses_explicit_private_target_over_other_latest_private() {
        let private_target = types::LastActivePrivateTarget {
            channel_id: "weixin".to_string(),
            session_key: "current-private".to_string(),
            last_active_at: "2026-07-06T10:00:00".to_string(),
        };
        let candidates = vec![
            hb_candidate(
                "weixin",
                Some(hb_peer("current-private", 10_000)),
                None,
                Some(hb_peer("current-private", 10_000)),
            ),
            hb_candidate("feishu", None, None, Some(hb_peer("old-private", 0))),
        ];

        let target =
            resolve_heartbeat_target_from_candidates(Some(&private_target), None, &candidates)
                .unwrap();

        assert_eq!(target.channel_id, "weixin");
        assert_eq!(target.session_key, "current-private");
    }

    #[test]
    fn heartbeat_target_skips_when_explicit_private_target_is_stale() {
        let private_target = types::LastActivePrivateTarget {
            channel_id: "weixin".to_string(),
            session_key: "stale-private".to_string(),
            last_active_at: "2026-07-06T10:00:00".to_string(),
        };
        let candidates = vec![hb_candidate(
            "weixin",
            None,
            None,
            Some(hb_peer("old-private", 0)),
        )];

        assert!(
            resolve_heartbeat_target_from_candidates(Some(&private_target), None, &candidates)
                .is_none()
        );
    }

    #[test]
    fn heartbeat_target_does_not_fallback_when_last_active_channel_is_group() {
        let lac = LastActiveChannel {
            channel_id: "weixin".to_string(),
            session_key: "group-session".to_string(),
            last_active_at: "2026-07-06T10:00:00".to_string(),
        };
        let candidates = vec![hb_candidate(
            "weixin",
            None,
            None,
            Some(hb_peer("old-private", 0)),
        )];

        assert!(resolve_heartbeat_target_from_candidates(None, Some(&lac), &candidates).is_none());
    }

    #[test]
    fn heartbeat_target_migrates_private_last_active_channel() {
        let lac = LastActiveChannel {
            channel_id: "weixin".to_string(),
            session_key: "current-private".to_string(),
            last_active_at: "2026-07-06T10:00:00".to_string(),
        };
        let candidates = vec![hb_candidate(
            "weixin",
            None,
            Some(hb_peer("current-private", 100)),
            Some(hb_peer("old-private", 0)),
        )];

        let target =
            resolve_heartbeat_target_from_candidates(None, Some(&lac), &candidates).unwrap();

        assert_eq!(target.channel_id, "weixin");
        assert_eq!(target.session_key, "current-private");
    }

    #[test]
    fn heartbeat_target_bootstraps_latest_private_without_history() {
        let candidates = vec![
            hb_candidate("weixin", None, None, Some(hb_peer("weixin-private", 50))),
            hb_candidate("feishu", None, None, Some(hb_peer("feishu-private", 0))),
        ];

        let target = resolve_heartbeat_target_from_candidates(None, None, &candidates).unwrap();

        assert_eq!(target.channel_id, "feishu");
        assert_eq!(target.session_key, "feishu-private");
    }

    #[test]
    fn heartbeat_target_does_not_fallback_when_last_active_channel_is_stopped() {
        let lac = LastActiveChannel {
            channel_id: "weixin".to_string(),
            session_key: "group-session".to_string(),
            last_active_at: "2026-07-06T10:00:00".to_string(),
        };
        let mut candidates = vec![hb_candidate(
            "weixin",
            None,
            None,
            Some(hb_peer("old-private", 0)),
        )];
        candidates[0].status = types::ImStatus::Stopped;

        assert!(resolve_heartbeat_target_from_candidates(None, Some(&lac), &candidates).is_none());
    }

    #[test]
    fn missing_configured_channel_is_only_reported_when_startable() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let mut channel = agent.channels[0].clone();

        assert!(should_report_missing_configured_channel(&agent, &channel));

        channel.enabled = false;
        assert!(!should_report_missing_configured_channel(&agent, &channel));

        let mut missing_plugin = agent.channels[0].clone();
        missing_plugin.openclaw_plugin_id = None;
        assert!(!should_report_missing_configured_channel(
            &agent,
            &missing_plugin
        ));
    }

    #[test]
    fn configured_channel_status_from_state_reports_startable_missing_channel() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let channel = agent.channels[0].clone();

        let status = super::commands::configured_channel_status_from_state(
            &agent,
            &channel,
            types::ImHealthState::default(),
            false,
        )
        .expect("startable missing channel should be reported");

        assert_eq!(status.channel_id, "weixin");
        assert_eq!(status.status, types::ImStatus::Connecting);
        assert!(status.error_message.is_none());
    }

    #[test]
    fn configured_channel_status_from_state_skips_disabled_or_uncredentialed_channel() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let mut channel = agent.channels[0].clone();

        channel.enabled = false;
        assert!(super::commands::configured_channel_status_from_state(
            &agent,
            &channel,
            types::ImHealthState::default(),
            false,
        )
        .is_none());

        let mut missing_plugin = agent.channels[0].clone();
        missing_plugin.openclaw_plugin_id = None;
        assert!(super::commands::configured_channel_status_from_state(
            &agent,
            &missing_plugin,
            types::ImHealthState::default(),
            false,
        )
        .is_none());
    }

    #[test]
    fn configured_channel_status_from_state_preserves_startable_error() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let channel = agent.channels[0].clone();
        let mut health_state = types::ImHealthState::default();
        health_state.status = types::ImStatus::Error;
        health_state.error_message = Some("bridge failed".to_string());

        let status = super::commands::configured_channel_status_from_state(
            &agent,
            &channel,
            health_state,
            false,
        )
        .expect("startable missing channel error should be reported");

        assert_eq!(status.status, types::ImStatus::Error);
        assert_eq!(status.error_message.as_deref(), Some("bridge failed"));
    }

    #[test]
    fn configured_channel_status_does_not_synthesize_archived_channel() {
        let mut agents = agent_config_with_weixin_channel(true);
        let agent = agents.remove(0);
        let channel = agent.channels[0].clone();

        assert!(super::commands::configured_channel_status_from_state(
            &agent,
            &channel,
            types::ImHealthState::default(),
            true,
        )
        .is_none());
    }
}

/// Auto-start all enabled IM Bots.
/// Called from Tauri `setup` with a short delay to let the app initialize.
pub fn schedule_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize (Sidecar manager, etc.)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let configs = read_im_configs_from_disk();
        if configs.is_empty() {
            return;
        }

        use tauri::Manager;
        let im_state = app_handle.state::<ManagedImBots>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        for (bot_id, config) in configs {
            let has_credentials = im_config_has_start_credentials(&config);
            if config.enabled && has_credentials {
                ulog_info!("[im] Auto-starting bot: {}", bot_id);
                match start_im_bot(
                    &app_handle,
                    &im_state,
                    &sidecar_manager,
                    bot_id.clone(),
                    config,
                )
                .await
                {
                    Ok(_) => ulog_info!("[im] Auto-start succeeded for bot {}", bot_id),
                    Err(e) => ulog_warn!("[im] Auto-start failed for bot {}: {}", bot_id, e),
                }
            }
        }
    });
}

/// Read IM bot configs from ~/.myagents/config.json
/// Returns (bot_id, config) pairs for all enabled bots.
///
/// Recovery chain (mirrors frontend safeLoadJson):
///   1. config.json — current version
///   2. config.json.bak — previous known-good version
///   3. config.json.tmp — in-progress write
pub(super) fn read_im_configs_from_disk() -> Vec<(String, ImConfig)> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(crate::app_dirs::APP_DATA_DIR_NAME);
    let main_path = config_dir.join("config.json");

    // Try main → .bak → .tmp (same order as frontend safeLoadJson)
    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let label = ["main", "bak", "tmp"][i];
        // Repair stringified-JSON fields persisted as raw objects (issue #301)
        // before the strict parse — PartialAppConfig also deserializes
        // `agents: Vec<AgentConfigRust>`, so an object `providerEnvJson` on any
        // agent would otherwise fail this whole parse too.
        let app_config: PartialAppConfig =
            match serde_json::from_str::<serde_json::Value>(strip_bom(&content))
                .map_err(|e| e.to_string())
                .and_then(|mut value| {
                    normalize_stringified_json_value(&mut value);
                    serde_json::from_value::<PartialAppConfig>(value).map_err(|e| e.to_string())
                }) {
                Ok(c) => c,
                Err(e) => {
                    ulog_warn!("[im] Config {} file corrupted, trying next: {}", label, e);
                    continue;
                }
            };

        if i > 0 {
            ulog_warn!("[im] Recovered config from {} file", label);
        }

        return parse_bot_entries(app_config);
    }

    Vec::new()
}

/// Extract (bot_id, config) pairs from parsed config.
/// Migrates missing `provider_env_json` from `provider_api_keys` + preset baseUrl map.
/// Skips bots whose IDs also appear as agent channel IDs (to prevent double auto-start).
fn parse_bot_entries(app_config: PartialAppConfig) -> Vec<(String, ImConfig)> {
    // Build set of channel IDs owned by agents — these will be started by schedule_agent_auto_start
    let agent_channel_ids: std::collections::HashSet<String> = app_config
        .agents
        .iter()
        .flat_map(|a| a.channels.iter().map(|ch| ch.id.clone()))
        .collect();

    let api_keys = app_config.provider_api_keys;
    let mut entries: Vec<(String, ImConfig)> = if let Some(bots) = app_config.im_bot_configs {
        bots.into_iter()
            .filter_map(|entry| {
                let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if agent_channel_ids.contains(&id) {
                    ulog_debug!("[im] Skipping legacy bot {} (owned by agent)", id);
                    None
                } else {
                    Some((id, entry.config))
                }
            })
            .collect()
    } else if let Some(entry) = app_config.im_bot_config {
        let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if agent_channel_ids.contains(&id) {
            Vec::new()
        } else {
            vec![(id, entry.config)]
        }
    } else {
        Vec::new()
    };

    // Migration: rebuild providerEnvJson for bots that have providerId but no providerEnvJson
    for (_id, config) in &mut entries {
        migrate_provider_env(config, &api_keys);
    }

    entries
}

/// Backward-compat migration: if a bot has `provider_id` set but `provider_env_json` is missing,
/// reconstruct it from `providerApiKeys` + preset provider baseUrl map.
/// This handles existing configs created before providerEnvJson persistence was added.
fn migrate_provider_env(
    config: &mut ImConfig,
    api_keys: &std::collections::HashMap<String, String>,
) {
    if config.provider_env_json.is_some() {
        return; // Already set
    }
    let provider_id = match &config.provider_id {
        Some(id) if !id.is_empty() && !id.contains("sub") => id.clone(),
        _ => return, // Subscription or no provider
    };
    let api_key = match api_keys.get(&provider_id) {
        Some(key) if !key.is_empty() => key,
        _ => return, // No API key available
    };
    let meta = match preset_provider_meta(&provider_id) {
        Some(m) => m,
        None => {
            ulog_warn!(
                "[im] Cannot migrate providerEnvJson for unknown provider '{}' — manual restart required",
                provider_id
            );
            return;
        }
    };
    let mut env = serde_json::json!({
        "baseUrl": meta.base_url,
        "apiKey": api_key,
        "authType": meta.auth_type,
    });
    if let Some(proto) = meta.api_protocol {
        env["apiProtocol"] = serde_json::json!(proto);
    }
    config.provider_env_json = Some(env.to_string());
    ulog_info!(
        "[im] Migrated providerEnvJson for provider '{}' from providerApiKeys",
        provider_id
    );
}

fn provider_env_json_for_provider(
    provider_id: &str,
    api_keys: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if provider_id.is_empty() || provider_id.contains("sub") {
        return None;
    }
    let api_key = api_keys.get(provider_id).filter(|k| !k.is_empty())?;
    let meta = preset_provider_meta(provider_id)?;
    let mut env = serde_json::json!({
        "baseUrl": meta.base_url,
        "apiKey": api_key,
        "authType": meta.auth_type,
    });
    if let Some(proto) = meta.api_protocol {
        env["apiProtocol"] = serde_json::json!(proto);
    }
    Some(env.to_string())
}

/// Backward-compat migration for Agent configs: rebuild missing `provider_env_json`
/// on both the agent level and each channel's overrides.
/// Uses the same preset baseUrl map as `migrate_provider_env`.
fn migrate_agent_provider_env(
    agent: &mut AgentConfigRust,
    api_keys: &std::collections::HashMap<String, String>,
) {
    // 1. Migrate agent-level providerEnvJson
    if agent.provider_env_json.is_none() {
        if let Some(ref pid) = agent.provider_id {
            if let Some(env) = provider_env_json_for_provider(pid, api_keys) {
                agent.provider_env_json = Some(env);
                ulog_info!(
                    "[agent] Migrated agent-level providerEnvJson for provider '{}'",
                    pid
                );
            }
        }
    }

    // 2. Migrate each channel's overrides.providerEnvJson
    for ch in &mut agent.channels {
        if let Some(ref mut ov) = ch.overrides {
            if ov.provider_env_json.is_none() {
                if let Some(ref pid) = ov.provider_id {
                    if let Some(env) = provider_env_json_for_provider(pid, api_keys) {
                        ov.provider_env_json = Some(env);
                        ulog_info!(
                            "[agent] Migrated channel override providerEnvJson for provider '{}'",
                            pid
                        );
                    }
                }
            }
        }
    }
}

fn provider_env_json_missing(
    obj: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> bool {
    !matches!(obj.get(field), Some(serde_json::Value::String(s)) if !s.is_empty())
}

fn migrate_provider_env_json_field(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    provider_field: &str,
    env_field: &str,
    api_keys: &std::collections::HashMap<String, String>,
    emit_logs: bool,
    log_prefix: &str,
) -> bool {
    if !provider_env_json_missing(obj, env_field) {
        return false;
    }
    let Some(provider_id) = obj
        .get(provider_field)
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return false;
    };
    let Some(env) = provider_env_json_for_provider(&provider_id, api_keys) else {
        return false;
    };

    obj.insert(env_field.to_string(), serde_json::Value::String(env));
    if emit_logs {
        ulog_info!(
            "[agent] Migrated {} providerEnvJson for provider '{}'",
            log_prefix,
            provider_id
        );
    }
    true
}

/// Rebuild missing Agent `providerEnvJson` fields at the raw JSON layer.
///
/// The typed fallback in `migrate_agent_provider_env()` keeps old callers safe,
/// but doing the migration on `serde_json::Value` lets `read_agent_configs_from_disk`
/// persist the healed config once. Without this, status polling re-read the same
/// missing fields every 5s and logged the migration thousands of times.
fn migrate_agent_provider_env_value(
    value: &mut serde_json::Value,
    api_keys: &std::collections::HashMap<String, String>,
    emit_logs: bool,
) -> bool {
    let mut changed = false;
    if let Some(agents) = value.get_mut("agents").and_then(|v| v.as_array_mut()) {
        for agent in agents.iter_mut() {
            let Some(obj) = agent.as_object_mut() else {
                continue;
            };
            changed |= migrate_provider_env_json_field(
                obj,
                "providerId",
                "providerEnvJson",
                api_keys,
                emit_logs,
                "agent-level",
            );

            if let Some(channels) = obj.get_mut("channels").and_then(|v| v.as_array_mut()) {
                for ch in channels.iter_mut() {
                    if let Some(ov) = ch.get_mut("overrides").and_then(|v| v.as_object_mut()) {
                        changed |= migrate_provider_env_json_field(
                            ov,
                            "providerId",
                            "providerEnvJson",
                            api_keys,
                            emit_logs,
                            "channel override",
                        );
                    }
                }
            }
        }
    }
    changed
}

/// Preset provider metadata for migration: (baseUrl, authType, apiProtocol).
/// Must match PRESET_PROVIDERS in src/renderer/config/types.ts.
struct PresetProviderMeta {
    base_url: &'static str,
    auth_type: &'static str,
    api_protocol: Option<&'static str>, // None = anthropic (default), Some("openai") = OpenAI bridge
}

fn preset_provider_meta(provider_id: &str) -> Option<PresetProviderMeta> {
    match provider_id {
        "anthropic-api" => Some(PresetProviderMeta {
            base_url: "https://api.anthropic.com",
            auth_type: "both",
            api_protocol: None,
        }),
        "deepseek" => Some(PresetProviderMeta {
            base_url: "https://api.deepseek.com/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "moonshot" => Some(PresetProviderMeta {
            base_url: "https://api.moonshot.cn/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "zhipu" => Some(PresetProviderMeta {
            base_url: "https://open.bigmodel.cn/api/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "minimax" => Some(PresetProviderMeta {
            base_url: "https://api.minimaxi.com/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "google-gemini" => Some(PresetProviderMeta {
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
            auth_type: "api_key",
            api_protocol: Some("openai"),
        }),
        "volcengine" => Some(PresetProviderMeta {
            base_url: "https://ark.cn-beijing.volces.com/api/coding",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "volcengine-api" => Some(PresetProviderMeta {
            base_url: "https://ark.cn-beijing.volces.com/api/compatible",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "siliconflow" => Some(PresetProviderMeta {
            base_url: "https://api.siliconflow.cn/",
            auth_type: "api_key",
            api_protocol: None,
        }),
        "zenmux" => Some(PresetProviderMeta {
            base_url: "https://zenmux.ai/api/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "aliyun-bailian-coding" => Some(PresetProviderMeta {
            base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "openrouter" => Some(PresetProviderMeta {
            base_url: "https://openrouter.ai/api",
            auth_type: "auth_token_clear_api_key",
            api_protocol: None,
        }),
        _ => None,
    }
}

// ===== Agent Config Disk Read/Write (v0.1.41) =====

/// Coerce "stringified JSON" config fields (`providerEnvJson`, `mcpServersJson`)
/// that were persisted as raw JSON objects/arrays back into strings, at the
/// `serde_json::Value` level, BEFORE strict typed deserialization.
///
/// `AgentConfigRust` declares these as `Option<String>` (they hold a *serialized*
/// JSON blob). A legacy write path or a hand-edit can leave one as an object,
/// which makes a strict parse fail with `invalid type: map, expected a string`
/// (issue #301) — that single bad field would otherwise blank the WHOLE config
/// parse and stop ALL agent channels from auto-starting. Stringifying the object
/// is lossless: it is exactly what the string is meant to contain.
///
/// MUST stay in sync with the TypeScript twin `normalizeStringifiedJsonFields`
/// (`src/renderer/config/services/configNormalize.ts`). Shared regression
/// fixture: `src/shared/__fixtures__/dirtyConfig301.json`.
fn normalize_stringified_json_value(value: &mut serde_json::Value) -> bool {
    // Object/array → stringify (the field's intended serialized form);
    // other non-string scalars (number/bool) → drop (not a valid blob, and
    // feeding a bogus string to a downstream parse just moves the failure).
    // String / null / absent → leave untouched. Mirrors the TS twin's
    // `coerceJsonStringField` exactly.
    fn coerce(obj: &mut serde_json::Map<String, serde_json::Value>, field: &str) -> bool {
        // Compute the action while the immutable borrow from `get` is live, then
        // mutate after it ends (the bool result holds no borrow).
        if matches!(
            obj.get(field),
            Some(serde_json::Value::Object(_)) | Some(serde_json::Value::Array(_))
        ) {
            let stringified = obj.get(field).unwrap().to_string();
            obj.insert(field.to_string(), serde_json::Value::String(stringified));
            true
        } else if matches!(
            obj.get(field),
            Some(serde_json::Value::Number(_)) | Some(serde_json::Value::Bool(_))
        ) {
            obj.remove(field);
            true
        } else {
            false
        }
    }

    let mut changed = normalize_config_mcp_selections(value);
    if let Some(agents) = value.get_mut("agents").and_then(|v| v.as_array_mut()) {
        for agent in agents.iter_mut() {
            let Some(obj) = agent.as_object_mut() else {
                continue;
            };
            changed |= coerce(obj, "providerEnvJson");
            changed |= coerce(obj, "mcpServersJson");
            if let Some(channels) = obj.get_mut("channels").and_then(|v| v.as_array_mut()) {
                for ch in channels.iter_mut() {
                    if let Some(ov) = ch.get_mut("overrides").and_then(|v| v.as_object_mut()) {
                        changed |= coerce(ov, "providerEnvJson");
                    }
                }
            }
        }
    }
    changed
}

/// Promote selected custom MCP definitions stranded in `agents[].mcpServersJson`
/// into the global `mcpServers` registry.
///
/// Agent channel self-resolve treats the global registry + global enabled list
/// as the authoritative MCP catalogue. The Agent's `mcpEnabledServers` is only
/// a per-Agent subset. A legacy renderer path could persist the subset and a
/// stringified per-Agent runtime payload without adding the remote HTTP/SSE
/// definition to the global layer, so cold-start saw `mcp=none` even though the
/// Agent row looked enabled (issue #398).
///
/// Mirrors the TypeScript twin `promoteAgentMcpJsonToGlobal`. We only enable IDs
/// recovered into the global catalogue in this pass; if a known global server is
/// disabled globally, this load-boundary heal must not silently re-enable it.
fn promote_agent_mcp_json_to_global_value(value: &mut serde_json::Value) -> bool {
    let Some(agents) = value.get("agents").and_then(|v| v.as_array()) else {
        return false;
    };

    let mut known_ids: std::collections::HashSet<String> = value
        .get("mcpServers")
        .and_then(|v| v.as_array())
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| {
                    server
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut global_enabled: std::collections::HashSet<String> = value
        .get("mcpEnabledServers")
        .and_then(|v| v.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut recovered_servers = Vec::new();
    let mut recovered_enabled_ids = Vec::new();

    for agent in agents {
        let Some(agent_obj) = agent.as_object() else {
            continue;
        };
        let Some(agent_enabled) = agent_obj
            .get("mcpEnabledServers")
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        let selected_ids: std::collections::HashSet<String> = agent_enabled
            .iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect();
        if selected_ids.is_empty() {
            continue;
        }

        let Some(raw_servers) = agent_obj.get("mcpServersJson").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_servers) else {
            continue;
        };
        let Some(servers) = parsed.as_array() else {
            continue;
        };

        for server in servers {
            let Some(server_obj) = server.as_object() else {
                continue;
            };
            let Some(id) = server_obj.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(server_type) = server_obj.get("type").and_then(|v| v.as_str()) else {
                continue;
            };
            let has_required_shape = server_obj.get("name").and_then(|v| v.as_str()).is_some()
                && matches!(server_type, "http" | "sse")
                && server_obj
                    .get("url")
                    .and_then(|v| v.as_str())
                    .is_some_and(|url| !url.is_empty());
            if !has_required_shape
                || !selected_ids.contains(id)
                || known_ids.contains(id)
                || server_obj
                    .get("isBuiltin")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            {
                continue;
            }

            let id = id.to_string();
            let mut normalized = server.clone();
            if let Some(obj) = normalized.as_object_mut() {
                obj.insert("isBuiltin".to_string(), serde_json::Value::Bool(false));
            }
            recovered_servers.push(normalized);
            known_ids.insert(id.clone());
            if global_enabled.insert(id.clone()) {
                recovered_enabled_ids.push(id);
            }
        }
    }

    if recovered_servers.is_empty() {
        return false;
    }

    let Some(root) = value.as_object_mut() else {
        return false;
    };
    let servers_value = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !servers_value.is_array() {
        *servers_value = serde_json::Value::Array(Vec::new());
    }
    if let Some(servers) = servers_value.as_array_mut() {
        servers.extend(recovered_servers);
    }

    let enabled_value = root
        .entry("mcpEnabledServers".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !enabled_value.is_array() {
        *enabled_value = serde_json::Value::Array(Vec::new());
    }
    if let Some(enabled) = enabled_value.as_array_mut() {
        for id in recovered_enabled_ids {
            enabled.push(serde_json::Value::String(id));
        }
    }

    true
}

/// Parse `agents[]` from an already-normalized config Value into typed
/// `AgentConfigRust`, salvaging individually-valid entries so one malformed
/// agent can't blank the whole fleet's auto-start (the failure class that made
/// #301 severe).
///
/// Returns:
///   - `Some(vec)` — the agents to use. `vec` is empty when `agents` is absent
///     or an empty array (legitimately "no agents"; the caller should NOT fall
///     through to a recovery candidate — that matches legacy behaviour).
///   - `None` — `agents` is present but unusable (not an array, or every entry
///     failed a strict parse). The caller should try the next recovery candidate
///     (.bak/.tmp) rather than accept an empty fleet.
fn salvage_agents_from_value(
    value: &serde_json::Value,
    api_keys: &std::collections::HashMap<String, String>,
) -> Option<Vec<AgentConfigRust>> {
    let runtime_selection_available =
        crate::runtime_distribution_policy::policy().selector_available();
    let default_integrated_runtime = value
        .get("defaultIntegratedRuntime")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    match value.get("agents") {
        // Absent → no agents configured; nothing to recover.
        None => Some(Vec::new()),
        Some(serde_json::Value::Array(arr)) => {
            if arr.is_empty() {
                return Some(Vec::new());
            }
            let mut agents: Vec<AgentConfigRust> = Vec::with_capacity(arr.len());
            for (ai, a) in arr.iter().enumerate() {
                match serde_json::from_value::<AgentConfigRust>(a.clone()) {
                    Ok(mut agent) => {
                        agent.runtime_selection_available = runtime_selection_available;
                        agent.default_integrated_runtime = default_integrated_runtime.clone();
                        // Rebuild providerEnvJson for agents/channels that have a
                        // providerId but no providerEnvJson (same as
                        // parse_bot_entries does for legacy bots).
                        migrate_agent_provider_env(&mut agent, api_keys);
                        agents.push(agent);
                    }
                    Err(e) => {
                        ulog_warn!("[agent] Skipping malformed agent[{}]: {}", ai, e);
                    }
                }
            }
            // Every entry failed → treat this candidate as unusable so the caller
            // can fall through to a recovery file.
            if agents.is_empty() {
                None
            } else {
                Some(agents)
            }
        }
        // `agents` present but not an array → corrupt shape → recover.
        Some(_) => None,
    }
}

fn migrate_openclaw_lark_streaming_value(value: &mut serde_json::Value) -> Vec<String> {
    fn migrate_channel(channel: &mut serde_json::Value) -> Option<String> {
        let Some(channel) = channel.as_object_mut() else {
            return None;
        };
        if channel.get("openclawPluginId").and_then(|v| v.as_str()) != Some("openclaw-lark") {
            return None;
        }
        let channel_id = channel
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>")
            .to_string();
        let Some(config) = channel
            .get_mut("openclawPluginConfig")
            .and_then(serde_json::Value::as_object_mut)
        else {
            return None;
        };
        let Some(raw) = config.get_mut("streaming") else {
            return None;
        };
        let parsed = match raw.as_str() {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        };
        let Some(parsed) = parsed else {
            return None;
        };
        *raw = serde_json::Value::Bool(parsed);
        Some(channel_id)
    }

    let mut migrated_channel_ids = Vec::new();
    if let Some(agents) = value
        .get_mut("agents")
        .and_then(serde_json::Value::as_array_mut)
    {
        for agent in agents {
            if let Some(channels) = agent
                .get_mut("channels")
                .and_then(serde_json::Value::as_array_mut)
            {
                for channel in channels {
                    if let Some(channel_id) = migrate_channel(channel) {
                        migrated_channel_ids.push(channel_id);
                    }
                }
            }
        }
    }
    if let Some(bots) = value
        .get_mut("imBotConfigs")
        .and_then(serde_json::Value::as_array_mut)
    {
        for bot in bots {
            if let Some(channel_id) = migrate_channel(bot) {
                migrated_channel_ids.push(channel_id);
            }
        }
    }
    migrated_channel_ids
}

const AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1: &str = "agentChannelIndependenceMigrationV1";

fn proactive_child_default(key: &str) -> serde_json::Value {
    match key {
        "heartbeat" => serde_json::to_value(types::HeartbeatConfig::default()),
        "memoryAutoUpdate" => serde_json::to_value(types::MemoryAutoUpdateConfig::default()),
        "memoryEvolution" => serde_json::to_value(types::MemoryEvolutionConfig::default()),
        _ => unreachable!("unknown proactive child config"),
    }
    .expect("default proactive config must serialize")
}

/// One-shot compatibility migration for the split between Proactive Agent and
/// Agent Channels. The old master switch used to gate both products, so the
/// pre-migration master value is projected into every child switch and (only
/// when disabled) every Channel. Once the marker is persisted, later user
/// customisation is never touched again.
fn migrate_agent_channel_independence_value(value: &mut serde_json::Value) -> Result<bool, String> {
    let mut migrated = value.clone();
    let changed = migrate_agent_channel_independence_value_in_place(&mut migrated)?;
    if changed {
        *value = migrated;
    }
    Ok(changed)
}

fn migrate_agent_channel_independence_value_in_place(
    value: &mut serde_json::Value,
) -> Result<bool, String> {
    if value
        .get(AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1)
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return Ok(false);
    }

    let root = value
        .as_object_mut()
        .ok_or_else(|| "config root is not an object".to_string())?;
    let agents = match root.get_mut("agents") {
        None => None,
        Some(serde_json::Value::Array(agents)) => Some(agents),
        Some(_) => return Err("agents is not an array".to_string()),
    };

    if let Some(agents) = agents {
        for (agent_index, agent) in agents.iter_mut().enumerate() {
            let agent = agent
                .as_object_mut()
                .ok_or_else(|| format!("agent[{agent_index}] is not an object"))?;
            let enabled = agent
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| format!("agent[{agent_index}].enabled is not a boolean"))?;

            for key in ["heartbeat", "memoryAutoUpdate", "memoryEvolution"] {
                let child = agent
                    .entry(key.to_string())
                    .or_insert_with(|| proactive_child_default(key));
                if child.is_null() {
                    *child = proactive_child_default(key);
                }
                let child = child
                    .as_object_mut()
                    .ok_or_else(|| format!("agent[{agent_index}].{key} is not an object"))?;
                child.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
            }

            if !enabled {
                match agent.get_mut("channels") {
                    None | Some(serde_json::Value::Null) => {}
                    Some(serde_json::Value::Array(channels)) => {
                        for (channel_index, channel) in channels.iter_mut().enumerate() {
                            let channel = channel.as_object_mut().ok_or_else(|| {
                                format!(
                                    "agent[{agent_index}].channels[{channel_index}] is not an object"
                                )
                            })?;
                            channel.insert("enabled".to_string(), serde_json::Value::Bool(false));
                        }
                    }
                    Some(_) => {
                        return Err(format!("agent[{agent_index}].channels is not an array"));
                    }
                }
            }
        }
    }

    root.insert(
        AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1.to_string(),
        serde_json::Value::Bool(true),
    );
    Ok(true)
}

fn agent_channel_independence_migration_complete(value: &serde_json::Value) -> bool {
    value
        .get(AGENT_CHANNEL_INDEPENDENCE_MIGRATION_V1)
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

fn fail_closed_agent_channels(agents: &mut [AgentConfigRust]) {
    for agent in agents {
        for channel in &mut agent.channels {
            channel.enabled = false;
        }
    }
}

fn persist_agent_config_read_heal(config_path: &Path, reason: &str) {
    let mut changed_under_lock = false;
    let mut migrated_lark_channel_ids = Vec::new();
    let result = with_config_lock(config_path, true, |config| {
        let mut healed = config.clone();
        let normalized = normalize_stringified_json_value(&mut healed);
        let api_keys: std::collections::HashMap<String, String> = config
            .get("providerApiKeys")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let migrated_provider_env = migrate_agent_provider_env_value(&mut healed, &api_keys, false);
        let promoted_mcp = promote_agent_mcp_json_to_global_value(&mut healed);
        let lark_channel_ids = migrate_openclaw_lark_streaming_value(&mut healed);
        let migrated_channel_independence =
            match migrate_agent_channel_independence_value(&mut healed) {
                Ok(changed) => changed,
                Err(error) => {
                    ulog_warn!(
                        "[agent] Skipped Agent Channel independence migration: {}",
                        error
                    );
                    false
                }
            };
        if !(normalized
            || migrated_provider_env
            || promoted_mcp
            || !lark_channel_ids.is_empty()
            || migrated_channel_independence)
        {
            return Ok(());
        }

        if salvage_agents_from_value(&healed, &api_keys).is_none() {
            ulog_warn!(
                "[agent] Skipped config read-time heal because main agents[] is unusable: {}",
                reason
            );
            return Ok(());
        }

        if migrated_channel_independence && config_path.exists() {
            std::fs::copy(config_path, config_path.with_file_name("config.json.bak"))
                .map_err(|error| format!("Agent Channel migration backup failed: {error}"))?;
        }

        *config = healed;
        migrated_lark_channel_ids = lark_channel_ids;
        changed_under_lock = true;
        Ok(())
    });

    match result {
        Ok(_) if changed_under_lock => {
            ulog_info!("[agent] Persisted config read-time heal: {}", reason);
            if !migrated_lark_channel_ids.is_empty() {
                ulog_info!(
                    "[agent] Migrated OpenClaw Lark streaming type: count={} channelIds={}",
                    migrated_lark_channel_ids.len(),
                    migrated_lark_channel_ids.join(",")
                );
            }
        }
        Ok(_) => {}
        Err(e) => {
            ulog_warn!(
                "[agent] Failed to persist config read-time heal ({}): {}",
                reason,
                e
            );
        }
    }
}

/// Read Agent configs from disk. Falls back to reading imBotConfigs and converting.
pub(crate) fn read_agent_configs_from_disk() -> Vec<AgentConfigRust> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(crate::app_dirs::APP_DATA_DIR_NAME);
    let main_path = config_dir.join("config.json");

    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let label = ["main", "bak", "tmp"][i];
        // Parse loosely first so we can repair stringified-JSON fields persisted
        // as raw objects (issue #301) BEFORE the strict typed parse below.
        let mut value: serde_json::Value = match serde_json::from_str(strip_bom(&content)) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!(
                    "[agent] Config {} file corrupted (invalid JSON), trying next: {}",
                    label,
                    e
                );
                continue;
            }
        };
        let normalized = normalize_stringified_json_value(&mut value);

        let api_keys: std::collections::HashMap<String, String> = value
            .get("providerApiKeys")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let migrated_provider_env = migrate_agent_provider_env_value(&mut value, &api_keys, true);
        let promoted_mcp = promote_agent_mcp_json_to_global_value(&mut value);
        let migrated_lark_streaming = migrate_openclaw_lark_streaming_value(&mut value);
        let migrated_channel_independence =
            match migrate_agent_channel_independence_value(&mut value) {
                Ok(changed) => changed,
                Err(error) => {
                    ulog_warn!(
                    "[agent] Agent Channel independence migration unavailable for {} config: {}",
                    label,
                    error
                );
                    false
                }
            };

        match salvage_agents_from_value(&value, &api_keys) {
            Some(agents) => {
                let mut agents = project_agent_workspaces(&value, agents);
                if i == 0
                    && (normalized
                        || migrated_provider_env
                        || promoted_mcp
                        || !migrated_lark_streaming.is_empty()
                        || migrated_channel_independence)
                {
                    let mut reasons = Vec::new();
                    if normalized {
                        reasons.push("stringified JSON normalization");
                    }
                    if migrated_provider_env {
                        reasons.push("providerEnvJson migration");
                    }
                    if promoted_mcp {
                        reasons.push("Agent MCP global registry promotion");
                    }
                    if !migrated_lark_streaming.is_empty() {
                        reasons.push("OpenClaw Lark typed streaming migration");
                    }
                    if migrated_channel_independence {
                        reasons.push("Agent Channel independence migration");
                    }
                    let reason = reasons.join(" + ");
                    persist_agent_config_read_heal(&main_path, &reason);
                }
                let migration_persisted = std::fs::read_to_string(&main_path)
                    .ok()
                    .and_then(|content| {
                        serde_json::from_str::<serde_json::Value>(strip_bom(&content)).ok()
                    })
                    .is_some_and(|config| agent_channel_independence_migration_complete(&config));
                if !migration_persisted {
                    // A migrated in-memory view is safe for status/config reads,
                    // but no Channel may start until the one-shot disk commit
                    // succeeds. Every subsequent read retries the same heal.
                    fail_closed_agent_channels(&mut agents);
                    ulog_warn!(
                        "[agent] Agent Channels remain stopped until the compatibility migration is persisted"
                    );
                }
                if i > 0 {
                    ulog_warn!("[agent] Recovered config from {} file", label);
                }
                return agents;
            }
            None => {
                // `agents` is present but unusable (not an array, or every entry
                // failed a strict parse). Fall through to the next recovery
                // candidate (.bak/.tmp), mirroring the pre-#301 behaviour.
                ulog_warn!(
                    "[agent] {} config has no usable agents, trying next candidate",
                    label
                );
                continue;
            }
        }
    }

    Vec::new()
}

pub(super) fn persist_agent_channel_enabled(
    agent_id: &str,
    channel_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");
    persist_agent_channel_enabled_at_path(
        &config_path,
        &read_archived_agent_workspaces_from_disk(),
        agent_id,
        channel_id,
        enabled,
    )
}

fn persist_agent_channel_enabled_at_path(
    config_path: &std::path::Path,
    archived: &ArchivedAgentWorkspaces,
    agent_id: &str,
    channel_id: &str,
    enabled: bool,
) -> Result<(), String> {
    with_config_lock(config_path, true, |config| {
        let agent = config
            .get_mut("agents")
            .and_then(|v| v.as_array_mut())
            .and_then(|agents| {
                agents
                    .iter_mut()
                    .find(|agent| agent["id"].as_str() == Some(agent_id))
            })
            .ok_or_else(|| format!("Agent {agent_id} not found"))?;
        if enabled {
            let parsed: types::AgentConfigRust =
                serde_json::from_value(agent.clone()).map_err(|e| e.to_string())?;
            let channel = parsed
                .channels
                .iter()
                .find(|channel| channel.id == channel_id)
                .ok_or_else(|| format!("Channel {channel_id} not found"))?;
            if is_agent_workspace_archived_with(&parsed, archived) {
                return Err("Agent workspace is archived".into());
            }
            if !agent_channel_has_start_credentials(&parsed, channel) {
                return Err("Channel is missing required credentials".into());
            }
        }
        let channel = agent
            .get_mut("channels")
            .and_then(|v| v.as_array_mut())
            .and_then(|channels| {
                channels
                    .iter_mut()
                    .find(|channel| channel["id"].as_str() == Some(channel_id))
            })
            .ok_or_else(|| format!("Channel {channel_id} not found"))?;
        channel["enabled"] = serde_json::json!(enabled);
        Ok(())
    })?;
    Ok(())
}

/// Persist a partial patch to a single agent's entry in `~/.myagents/config.json`.
#[allow(dead_code)] // Kept for potential future use; disk persistence now done by TypeScript service
pub(super) fn persist_agent_config_patch(
    agent_id: &str,
    patch: &AgentConfigPatch,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[agent] Home dir not found")?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");

    with_config_lock(&config_path, true, |config| {
        let agents = config
            .get_mut("agents")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| "[agent] No agents[] in config.json".to_string())?;
        let agent = agents
            .iter_mut()
            .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(agent_id))
            .ok_or_else(|| format!("[agent] Agent {} not found in config.json", agent_id))?;

        // Apply patch fields
        macro_rules! apply_field {
            ($field:ident, $key:expr) => {
                if let Some(ref val) = patch.$field {
                    agent[$key] = serde_json::json!(val);
                }
            };
        }
        apply_field!(name, "name");
        apply_field!(icon, "icon");
        apply_field!(enabled, "enabled");
        apply_field!(provider_id, "providerId");
        apply_field!(model, "model");
        apply_field!(provider_env_json, "providerEnvJson");
        apply_field!(permission_mode, "permissionMode");
        apply_field!(mcp_enabled_servers, "mcpEnabledServers");
        apply_field!(runtime, "runtime");
        apply_field!(setup_completed, "setupCompleted");

        if let Some(ref runtime_preference) = patch.runtime_preference {
            match runtime_preference {
                Some(value) => {
                    agent["runtimePreference"] = serde_json::to_value(value).map_err(|e| {
                        format!("[agent] Failed to serialize Runtime preference: {}", e)
                    })?;
                }
                None => {
                    if let Some(obj) = agent.as_object_mut() {
                        obj.remove("runtimePreference");
                    }
                }
            }
        }

        if let Some(ref runtime_config) = patch.runtime_config {
            match runtime_config {
                Some(value) => agent["runtimeConfig"] = value.clone(),
                None => {
                    if let Some(obj) = agent.as_object_mut() {
                        obj.remove("runtimeConfig");
                    }
                }
            }
        }

        if let Some(ref channels) = patch.channels {
            agent["channels"] = serde_json::to_value(channels)
                .map_err(|e| format!("[agent] Failed to serialize channels: {}", e))?;
        }

        if let Some(ref hb_json) = patch.heartbeat_config_json {
            if !hb_json.is_empty() && hb_json != "null" {
                if let Ok(hb) = serde_json::from_str::<serde_json::Value>(hb_json) {
                    agent["heartbeat"] = hb;
                }
            }
        }
        Ok(())
    })?;

    ulog_info!("[agent] Persisted config patch for agent {}", agent_id);
    Ok(())
}

#[derive(Debug, Clone)]
pub(super) struct HeartbeatTargetCandidate {
    channel_id: String,
    status: ImStatus,
    explicit_private_target: Option<crate::im::router::HeartbeatPeerTarget>,
    last_active_private_target: Option<crate::im::router::HeartbeatPeerTarget>,
    latest_private_target: Option<crate::im::router::HeartbeatPeerTarget>,
}

fn is_online_candidate(candidate: &HeartbeatTargetCandidate) -> bool {
    candidate.status == ImStatus::Online
}

pub(super) fn resolve_heartbeat_target_from_candidates(
    private_target: Option<&types::LastActivePrivateTarget>,
    last_active_channel: Option<&LastActiveChannel>,
    candidates: &[HeartbeatTargetCandidate],
) -> Option<types::HeartbeatTarget> {
    if let Some(target) = private_target {
        return candidates
            .iter()
            .find(|candidate| candidate.channel_id == target.channel_id)
            .filter(|candidate| is_online_candidate(candidate))
            .and_then(|candidate| candidate.explicit_private_target.as_ref())
            .map(|peer| types::HeartbeatTarget {
                channel_id: target.channel_id.clone(),
                session_key: peer.session_key.clone(),
            });
    }

    if let Some(lac) = last_active_channel {
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.channel_id == lac.channel_id)
            .filter(|candidate| is_online_candidate(candidate))?;
        if let Some(peer) = candidate.last_active_private_target.as_ref() {
            return Some(types::HeartbeatTarget {
                channel_id: lac.channel_id.clone(),
                session_key: peer.session_key.clone(),
            });
        }
        return None;
    }

    candidates
        .iter()
        .filter(|candidate| is_online_candidate(candidate))
        .filter_map(|candidate| {
            candidate
                .latest_private_target
                .as_ref()
                .map(|peer| (candidate, peer))
        })
        .max_by_key(|(_, peer)| peer.last_active)
        .map(|(candidate, peer)| types::HeartbeatTarget {
            channel_id: candidate.channel_id.clone(),
            session_key: peer.session_key.clone(),
        })
}

pub(crate) struct AgentHeartbeatRoute {
    pub target: types::HeartbeatTarget,
    pub wake_tx: Option<mpsc::Sender<types::HeartbeatWake>>,
    pub pending_cron_events: Arc<Mutex<Vec<types::PendingCronEvent>>>,
    pub model_work_gate: Arc<ChannelModelWorkGate>,
    pub router: Arc<Mutex<SessionRouter>>,
}

type HeartbeatRouteResources = (
    Option<mpsc::Sender<types::HeartbeatWake>>,
    Arc<Mutex<Vec<types::PendingCronEvent>>>,
    Arc<ChannelModelWorkGate>,
    Arc<Mutex<SessionRouter>>,
);

pub(crate) enum AgentHeartbeatRouteResolution {
    AgentMissing,
    NoPrivateTarget,
    Target(AgentHeartbeatRoute),
}

pub(crate) async fn resolve_agent_heartbeat_route(
    agent_state: &ManagedAgents,
    agent_id: &str,
) -> AgentHeartbeatRouteResolution {
    let (channel_refs, private_target_arc, last_active_channel_arc) = {
        let agents_guard = agent_state.lock().await;
        let agent = match agents_guard.get(agent_id) {
            Some(agent) => agent,
            None => {
                ulog_debug!("[agent-heartbeat] Agent {} not found, stopping", agent_id);
                return AgentHeartbeatRouteResolution::AgentMissing;
            }
        };
        let refs: Vec<_> = agent
            .channels
            .iter()
            .map(|(ch_id, ch_inst)| {
                (
                    ch_id.clone(),
                    Arc::clone(&ch_inst.bot_instance.health),
                    Arc::clone(&ch_inst.bot_instance.router),
                    ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                    Arc::clone(&ch_inst.bot_instance.pending_cron_events),
                    Arc::clone(&ch_inst.bot_instance.model_work_gate),
                )
            })
            .collect();
        (
            refs,
            Arc::clone(&agent.last_active_private_target),
            Arc::clone(&agent.last_active_channel),
        )
    };

    let private_target_snapshot = private_target_arc.read().await.clone();
    let last_active_channel_snapshot = last_active_channel_arc.read().await.clone();

    let mut candidates = Vec::with_capacity(channel_refs.len());
    let mut routes: HashMap<String, HeartbeatRouteResources> = HashMap::new();
    for (ch_id, health, router, wake_tx, pending_cron_events, model_work_gate) in &channel_refs {
        let health_state = health.get_state().await;
        let (explicit_private_target, last_active_private_target, latest_private_target) = {
            let router_guard = router.lock().await;
            let explicit_private_target = private_target_snapshot
                .as_ref()
                .filter(|target| target.channel_id == *ch_id)
                .and_then(|target| {
                    router_guard.get_private_peer_session_target(&target.session_key)
                });
            let last_active_private_target = last_active_channel_snapshot
                .as_ref()
                .filter(|lac| lac.channel_id == *ch_id)
                .and_then(|lac| router_guard.get_private_peer_session_target(&lac.session_key));
            let latest_private_target = router_guard.latest_private_peer_session_target();
            (
                explicit_private_target,
                last_active_private_target,
                latest_private_target,
            )
        };

        candidates.push(HeartbeatTargetCandidate {
            channel_id: ch_id.clone(),
            status: health_state.status,
            explicit_private_target,
            last_active_private_target,
            latest_private_target,
        });
        routes.insert(
            ch_id.clone(),
            (
                wake_tx.clone(),
                Arc::clone(pending_cron_events),
                Arc::clone(model_work_gate),
                Arc::clone(router),
            ),
        );
    }

    let target = match resolve_heartbeat_target_from_candidates(
        private_target_snapshot.as_ref(),
        last_active_channel_snapshot.as_ref(),
        &candidates,
    ) {
        Some(target) => target,
        None => {
            ulog_debug!(
                "[agent-heartbeat] No private heartbeat target for agent {}",
                agent_id
            );
            return AgentHeartbeatRouteResolution::NoPrivateTarget;
        }
    };

    if private_target_snapshot.is_none() {
        let seeded = types::LastActivePrivateTarget {
            channel_id: target.channel_id.clone(),
            session_key: target.session_key.clone(),
            last_active_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        };
        *private_target_arc.write().await = Some(seeded.clone());
        let mut agents_guard = agent_state.lock().await;
        if let Some(agent) = agents_guard.get_mut(agent_id) {
            agent.config.last_active_private_target = Some(seeded);
        }
    }

    match routes.remove(&target.channel_id) {
        Some((wake_tx, pending_cron_events, model_work_gate, router)) => {
            AgentHeartbeatRouteResolution::Target(AgentHeartbeatRoute {
                target,
                wake_tx,
                pending_cron_events,
                model_work_gate,
                router,
            })
        }
        None => AgentHeartbeatRouteResolution::NoPrivateTarget,
    }
}

pub(super) async fn route_agent_heartbeat_once(
    agent_state: &ManagedAgents,
    agent_id: &str,
    reason: types::WakeReason,
) -> bool {
    let route = match resolve_agent_heartbeat_route(agent_state, agent_id).await {
        AgentHeartbeatRouteResolution::AgentMissing => return false,
        AgentHeartbeatRouteResolution::NoPrivateTarget => return true,
        AgentHeartbeatRouteResolution::Target(route) => route,
    };

    let delegated_reason = if reason.is_high_priority() {
        reason
    } else {
        types::WakeReason::Manual
    };
    if let Some(wake_tx) = route.wake_tx {
        let wake =
            types::HeartbeatWake::targeted(delegated_reason, route.target.session_key.clone());
        if let Err(e) = wake_tx.send(wake).await {
            ulog_warn!(
                "[agent-heartbeat] Failed to route heartbeat to channel {} for agent {}: {}",
                route.target.channel_id,
                agent_id,
                e
            );
            return true;
        }
        ulog_debug!(
            "[agent-heartbeat] Routed heartbeat to channel {} session {} for agent {}",
            route.target.channel_id,
            route.target.session_key,
            agent_id
        );
        true
    } else {
        ulog_debug!(
            "[agent-heartbeat] Channel {} has no heartbeat runner, skipping",
            route.target.channel_id
        );
        true
    }
}

/// Build channel statuses from a running AgentInstance (async helper for heartbeat).
/// Build channel statuses using clone-then-collect pattern (caller should NOT hold ManagedAgents lock).
/// Auto-start all enabled Agent channels.
/// Called from schedule_auto_start after the legacy IM bot startup.
pub fn schedule_agent_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;

        let agents = read_agent_configs_from_disk();
        if agents.is_empty() {
            return;
        }

        use tauri::Manager;
        let agent_state = app_handle.state::<ManagedAgents>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        let archived_workspaces = read_archived_agent_workspaces_from_disk();

        for agent_config in agents {
            if is_agent_workspace_archived_with(&agent_config, &archived_workspaces) {
                ulog_info!(
                    "[agent] Skipping auto-start for archived agent workspace {}",
                    agent_config.id
                );
                continue;
            }

            let mut started_channel_ids: Vec<String> = Vec::new();
            let mut started_agent_config: Option<AgentConfigRust> = None;

            for channel in &agent_config.channels {
                if !channel.enabled {
                    continue;
                }
                let bot_id = channel.id.clone();
                let lifecycle_lock = agent_channel_lifecycle_lock(&agent_config.id, &bot_id);
                let _lifecycle_guard = lifecycle_lock.lock().await;
                let Ok((fresh_agent_config, fresh_channel, im_config)) =
                    current_agent_channel_start_config(&agent_config.id, &bot_id)
                else {
                    continue;
                };
                let agent_channel_permission_mode = im_config.permission_mode.clone();
                // Dedup: skip if channel already running (and healthy) in agent state.
                // If channel exists but is Error/Stopped, remove it to allow restart.
                {
                    let mut agents_guard = agent_state.lock().await;
                    if let Some(agent) = agents_guard.get_mut(&agent_config.id) {
                        if agent.channels.contains_key(&bot_id) {
                            let is_dead = {
                                let ch = agent.channels.get(&bot_id).unwrap();
                                let health_state = ch.bot_instance.health.get_state().await;
                                matches!(
                                    health_state.status,
                                    types::ImStatus::Error | types::ImStatus::Stopped
                                )
                            };
                            if is_dead {
                                ulog_info!("[agent] Channel {} in agent {} is dead, removing for auto-restart", bot_id, agent_config.id);
                                agent.channels.remove(&bot_id);
                            } else {
                                ulog_info!("[agent] Channel {} already running in agent {}, skipping auto-start", bot_id, agent_config.id);
                                continue;
                            }
                        }
                    }
                }
                ulog_info!(
                    "[agent] Auto-starting channel {} of agent {}",
                    bot_id,
                    agent_config.id
                );
                // Create bot instance directly (no transit through ManagedImBots)
                let creation_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
                    Ok(permit) => permit,
                    Err(error) => {
                        ulog_warn!(
                            "[agent] Auto-start admission closed for channel {}: {}",
                            bot_id,
                            error
                        );
                        continue;
                    }
                };
                match create_bot_instance(
                    &app_handle,
                    &sidecar_manager,
                    bot_id.clone(),
                    im_config,
                    Some(agent_config.id.clone()),
                    &creation_permit,
                )
                .await
                {
                    Ok((bot_instance, _bot_status)) => {
                        ulog_info!("[agent] Auto-start succeeded for channel {}", bot_id);
                        // Register channel directly in agent state
                        let mut agents_guard = agent_state.lock().await;
                        let agent_instance = agents_guard
                            .entry(agent_config.id.clone())
                            .or_insert_with(|| AgentInstance {
                                agent_id: fresh_agent_config.id.clone(),
                                config: fresh_agent_config.clone(),
                                channels: HashMap::new(),
                                last_active_channel: Arc::new(RwLock::new(
                                    fresh_agent_config.last_active_channel.clone(),
                                )),
                                last_active_private_target: Arc::new(RwLock::new(
                                    fresh_agent_config.last_active_private_target.clone(),
                                )),
                                heartbeat_handle: None,
                                heartbeat_wake_tx: None,
                                heartbeat_config: None,
                                current_model: Arc::new(RwLock::new(
                                    fresh_agent_config.model.clone(),
                                )),
                                current_provider_env: Arc::new(RwLock::new(
                                    fresh_agent_config
                                        .provider_env_json
                                        .as_ref()
                                        .and_then(|s| serde_json::from_str(s).ok()),
                                )),
                                permission_mode: Arc::new(RwLock::new(
                                    agent_channel_permission_mode.clone(),
                                )),
                                mcp_servers_json: Arc::new(RwLock::new(
                                    fresh_agent_config.mcp_servers_json.clone(),
                                )),
                                runtime_config: Arc::new(RwLock::new(
                                    fresh_agent_config.runtime_config.clone(),
                                )),
                                memory_evolution_config: None,
                            });
                        // Set agent_link so the processing loop can update lastActiveChannel
                        let link = AgentChannelLink {
                            channel_id: fresh_channel.id.clone(),
                            agent_id: fresh_agent_config.id.clone(),
                            last_active_channel: Arc::clone(&agent_instance.last_active_channel),
                            last_active_private_target: Arc::clone(
                                &agent_instance.last_active_private_target,
                            ),
                        };
                        *bot_instance.agent_link.write().await = Some(link);

                        agent_instance.channels.insert(
                            fresh_channel.id.clone(),
                            ChannelInstance {
                                channel_id: fresh_channel.id.clone(),
                                bot_instance,
                            },
                        );
                        started_channel_ids.push(fresh_channel.id.clone());
                        started_agent_config = Some(fresh_agent_config);
                        drop(agents_guard);
                    }
                    Err(e) => {
                        ulog_warn!("[agent] Auto-start failed for channel {}: {}", bot_id, e)
                    }
                }
            }

            // Start agent-level heartbeat if configured and at least one channel started
            if !started_channel_ids.is_empty() {
                let agent_config = started_agent_config
                    .expect("a successfully started channel records its fresh agent config");
                let hb_config = agent_config.effective_heartbeat();
                let agent_id = agent_config.id.clone();
                let agent_label = agent_config.name.clone();
                let agent_state_for_hb = Arc::clone(&*agent_state);
                let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
                let hb_config_arc = Arc::new(RwLock::new(hb_config));
                let hb_config_for_loop = Arc::clone(&hb_config_arc);
                let evo_config_arc = Arc::new(RwLock::new(agent_config.memory_evolution.clone()));

                let hb_handle = tauri::async_runtime::spawn(async move {
                    use heartbeat::is_in_active_hours;

                    let initial_interval = {
                        let cfg = hb_config_for_loop.read().await;
                        Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
                    };
                    let mut interval = tokio::time::interval(initial_interval);
                    interval.tick().await; // skip first immediate tick

                    ulog_info!(
                        "[agent-heartbeat] Runner started for agent {} (interval={}min)",
                        agent_label,
                        initial_interval.as_secs() / 60
                    );

                    loop {
                        // Check if interval needs updating
                        {
                            let cfg = hb_config_for_loop.read().await;
                            let desired =
                                Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                            if desired != interval.period() {
                                ulog_info!(
                                    "[agent-heartbeat] Interval changed to {}min",
                                    desired.as_secs() / 60
                                );
                                interval = tokio::time::interval(desired);
                                interval.tick().await;
                            }
                        }

                        let reason = tokio::select! {
                            _ = interval.tick() => types::WakeReason::Interval,
                            Some(reason) = wake_rx.recv() => {
                                // Coalesce: drain additional signals within 250ms
                                let mut reasons = vec![reason];
                                tokio::time::sleep(Duration::from_millis(250)).await;
                                while let Ok(r) = wake_rx.try_recv() {
                                    reasons.push(r);
                                }
                                reasons.into_iter()
                                    .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                                    .unwrap_or(types::WakeReason::Interval)
                            }
                        };

                        let is_high_priority = reason.is_high_priority();

                        // Gate: heartbeat enabled check
                        let config = hb_config_for_loop.read().await.clone();
                        if !config.enabled {
                            ulog_debug!("[agent-heartbeat] Skipped: disabled");
                            continue;
                        }

                        // Gate: active hours (high-priority wakes skip)
                        if !is_high_priority {
                            if let Some(ref active_hours) = config.active_hours {
                                if !is_in_active_hours(active_hours) {
                                    ulog_debug!("[agent-heartbeat] Skipped: outside active hours");
                                    continue;
                                }
                            }
                        }

                        if !route_agent_heartbeat_once(
                            &agent_state_for_hb,
                            &agent_id,
                            reason.clone(),
                        )
                        .await
                        {
                            break;
                        }

                        // Reset interval after wake
                        if is_high_priority {
                            interval.reset();
                        }
                    }

                    ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
                });

                // Store heartbeat handles on the agent instance
                let mut agents_guard = agent_state.lock().await;
                if let Some(agent_instance) = agents_guard.get_mut(&agent_config.id) {
                    agent_instance.heartbeat_handle = Some(hb_handle);
                    agent_instance.heartbeat_wake_tx = Some(wake_tx);
                    agent_instance.heartbeat_config = Some(hb_config_arc);
                    agent_instance.memory_evolution_config = Some(evo_config_arc);
                    ulog_info!(
                        "[agent] Agent-level heartbeat started for {}",
                        agent_config.id
                    );
                }
                drop(agents_guard);
            }
        }
    });
}

async fn ensure_agent_level_runners_started<R: Runtime>(
    _app_handle: AppHandle<R>,
    agent_state: ManagedAgents,
    _sidecar_manager: ManagedSidecarManager,
    agent_config: AgentConfigRust,
) {
    let should_start = {
        let agents_guard = agent_state.lock().await;
        agents_guard
            .get(&agent_config.id)
            .map(|agent| agent.heartbeat_handle.is_none() && !agent.channels.is_empty())
            .unwrap_or(false)
    };
    if !should_start {
        return;
    }

    let hb_config = agent_config.effective_heartbeat();
    let agent_id = agent_config.id.clone();
    let agent_label = agent_config.name.clone();
    let agent_state_for_hb = Arc::clone(&agent_state);
    let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
    let hb_config_arc = Arc::new(RwLock::new(hb_config));
    let hb_config_for_loop = Arc::clone(&hb_config_arc);

    let evo_config_arc = Arc::new(RwLock::new(agent_config.memory_evolution.clone()));

    let hb_handle = tauri::async_runtime::spawn(async move {
        use heartbeat::is_in_active_hours;

        let initial_interval = {
            let cfg = hb_config_for_loop.read().await;
            Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
        };
        let mut interval = tokio::time::interval(initial_interval);
        interval.tick().await;

        ulog_info!(
            "[agent-heartbeat] Runner started for agent {} (interval={}min)",
            agent_label,
            initial_interval.as_secs() / 60
        );

        loop {
            {
                let cfg = hb_config_for_loop.read().await;
                let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                if desired != interval.period() {
                    ulog_info!(
                        "[agent-heartbeat] Interval changed to {}min",
                        desired.as_secs() / 60
                    );
                    interval = tokio::time::interval(desired);
                    interval.tick().await;
                }
            }

            let reason = tokio::select! {
                _ = interval.tick() => types::WakeReason::Interval,
                Some(reason) = wake_rx.recv() => {
                    let mut reasons = vec![reason];
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    while let Ok(r) = wake_rx.try_recv() {
                        reasons.push(r);
                    }
                    reasons.into_iter()
                        .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                        .unwrap_or(types::WakeReason::Interval)
                }
            };

            let is_high_priority = reason.is_high_priority();

            let config = hb_config_for_loop.read().await.clone();
            if !config.enabled {
                ulog_debug!("[agent-heartbeat] Skipped: disabled");
                continue;
            }

            if !is_high_priority {
                if let Some(ref active_hours) = config.active_hours {
                    if !is_in_active_hours(active_hours) {
                        ulog_debug!("[agent-heartbeat] Skipped: outside active hours");
                        continue;
                    }
                }
            }

            if !route_agent_heartbeat_once(&agent_state_for_hb, &agent_id, reason.clone()).await {
                break;
            }

            if is_high_priority {
                interval.reset();
            }
        }

        ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
    });

    let mut agents_guard = agent_state.lock().await;
    if let Some(agent_instance) = agents_guard.get_mut(&agent_config.id) {
        if agent_instance.heartbeat_handle.is_none() && !agent_instance.channels.is_empty() {
            agent_instance.heartbeat_handle = Some(hb_handle);
            agent_instance.heartbeat_wake_tx = Some(wake_tx);
            agent_instance.heartbeat_config = Some(hb_config_arc);
            agent_instance.memory_evolution_config = Some(evo_config_arc);
            ulog_info!(
                "[agent] Agent-level heartbeat started for {}",
                agent_config.id
            );
        } else {
            hb_handle.abort();
        }
    } else {
        hb_handle.abort();
    }
}

/// Monitor agent channels and auto-restart dead ones (Error/Stopped).
/// Periodically scans all agent channels, restarts dead ones using the same
/// dedup + create_bot_instance pattern as schedule_agent_auto_start.
pub async fn monitor_agent_channels(
    app_handle: AppHandle,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 30;
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    const BACKOFF_BASE_SECS: u64 = 30;
    const MAX_BACKOFF_SECS: u64 = 300;

    // Initial delay: let auto-start finish first
    tokio::time::sleep(Duration::from_secs(15)).await;
    ulog_info!("[agent-monitor] Agent channel health monitor started");

    // Track per (agent_id, channel_id): consecutive failures + next retry timestamp.
    // Keyed by the full pair — runtime identity is (agent_id, channel_id) everywhere
    // else in this loop (dead_channels, running_channel_keys, find_missing_*), so the
    // bookkeeping maps must match: a channel_id reused across two agents (imported /
    // manually-edited config) would otherwise cross-contaminate backoff/orphan state.
    // Keys persist across cycles even if the channel is removed from agent_state during
    // a failed restart — this prevents orphaned channels from being lost to monitoring.
    let mut failure_counts: HashMap<(String, String), u32> = HashMap::new();
    let mut next_retry: HashMap<(String, String), tokio::time::Instant> = HashMap::new();
    // Orphaned channels: (agent_id, channel_id) for channels removed from agent_state
    // during a failed restart. Merged into dead_channels on each cycle so they get retried.
    let mut orphaned: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }

        use tauri::Manager;
        let agent_state = app_handle.state::<ManagedAgents>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        // Phase 1: Find dead channels — snapshot health refs under lock, check outside.
        // Also keep the running key set so the monitor can reconcile enabled
        // channels that never made it into ManagedAgents during startup.
        let channel_health_refs: Vec<(String, String, Arc<crate::im::health::HealthManager>)> = {
            let agents_guard = agent_state.lock().await;
            let mut refs = Vec::new();
            for (agent_id, agent) in agents_guard.iter() {
                for (channel_id, channel) in agent.channels.iter() {
                    refs.push((
                        agent_id.clone(),
                        channel_id.clone(),
                        Arc::clone(&channel.bot_instance.health),
                    ));
                }
            }
            refs
            // lock dropped here
        };
        let running_channel_keys: std::collections::HashSet<(String, String)> = channel_health_refs
            .iter()
            .map(|(agent_id, channel_id, _)| (agent_id.clone(), channel_id.clone()))
            .collect();

        let mut dead_channels: Vec<(String, String)> = Vec::new();
        for (agent_id, channel_id, health) in &channel_health_refs {
            let state = health.get_state().await;
            if matches!(
                state.status,
                types::ImStatus::Error | types::ImStatus::Stopped
            ) {
                dead_channels.push((agent_id.clone(), channel_id.clone()));
            }
        }

        // Phase 2: Read configs from disk for restart and missing-channel reconcile.
        let agent_configs = read_agent_configs_from_disk();
        let archived_workspaces = read_archived_agent_workspaces_from_disk();
        dead_channels.extend(find_missing_startable_agent_channels(
            &agent_configs,
            &running_channel_keys,
            &dead_channels,
            &archived_workspaces,
        ));

        // Merge orphaned channels (failed restart last cycle, no longer in agent_state)
        for (agent_id, channel_id) in &orphaned {
            if !dead_channels
                .iter()
                .any(|(aid, cid)| aid == agent_id && cid == channel_id)
            {
                dead_channels.push((agent_id.clone(), channel_id.clone()));
            }
        }

        if dead_channels.is_empty() {
            failure_counts.clear();
            next_retry.clear();
            continue;
        }

        if agent_configs.is_empty() {
            continue;
        }

        let now = tokio::time::Instant::now();

        for (agent_id, channel_id) in &dead_channels {
            if shutdown.load(Relaxed) {
                break;
            }

            let key = (agent_id.clone(), channel_id.clone());
            let count = failure_counts.entry(key.clone()).or_insert(0);
            if *count >= MAX_CONSECUTIVE_FAILURES {
                continue;
            }

            // Skip if backoff hasn't elapsed yet (non-blocking)
            if let Some(&retry_at) = next_retry.get(&key) {
                if now < retry_at {
                    continue;
                }
            }

            // Find matching config from disk
            let agent_cfg = match agent_configs.iter().find(|a| a.id == *agent_id) {
                Some(c) => c,
                None => continue,
            };
            if is_agent_workspace_archived_with(agent_cfg, &archived_workspaces) {
                continue;
            }
            let channel_cfg = match agent_cfg.channels.iter().find(|c| c.id == *channel_id) {
                Some(c) => c,
                None => continue,
            };
            if !channel_cfg.enabled {
                continue;
            }

            let lifecycle_lock = agent_channel_lifecycle_lock(agent_id, channel_id);
            let _lifecycle_guard = lifecycle_lock.lock().await;

            let current_health = {
                let agents_guard = agent_state.lock().await;
                agents_guard
                    .get(agent_id)
                    .and_then(|agent| agent.channels.get(channel_id))
                    .map(|channel| Arc::clone(&channel.bot_instance.health))
            };
            if let Some(health) = current_health {
                let status = health.get_state().await.status;
                if !matches!(status, types::ImStatus::Error | types::ImStatus::Stopped) {
                    failure_counts.remove(&key);
                    next_retry.remove(&key);
                    orphaned.remove(&key);
                    continue;
                }
            }

            // Re-read after acquiring the same lifecycle boundary used by
            // commands and proxy reconciliation. Disabled/deleted channels
            // must not be resurrected from the monitor's earlier snapshot.
            let Some(im_config) = current_agent_channel_config(agent_id, channel_id) else {
                continue;
            };
            let agent_channel_permission_mode = im_config.permission_mode.clone();

            // Remove dead channel — shut down old instance properly first
            let old_instance: Option<ImBotInstance> = {
                let mut agents_guard = agent_state.lock().await;
                if let Some(agent) = agents_guard.get_mut(agent_id) {
                    agent.channels.remove(channel_id).map(|ch| ch.bot_instance)
                } else {
                    None
                }
            };
            let was_missing = old_instance.is_none();
            if let Some(instance) = old_instance {
                let _ = shutdown_bot_instance(instance, &sidecar_manager, channel_id).await;
            }

            if was_missing {
                ulog_info!(
                    "[agent-monitor] Auto-starting missing channel {} of agent {}",
                    channel_id,
                    agent_id
                );
            } else {
                ulog_info!(
                    "[agent-monitor] Auto-restarting channel {} of agent {}",
                    channel_id,
                    agent_id
                );
            }

            let creation_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
                Ok(permit) => permit,
                Err(error) => {
                    ulog_warn!(
                        "[agent-monitor] Restart admission closed for channel {}: {}",
                        channel_id,
                        error
                    );
                    continue;
                }
            };
            match create_bot_instance(
                &app_handle,
                &sidecar_manager,
                channel_id.clone(),
                im_config,
                Some(agent_id.clone()),
                &creation_permit,
            )
            .await
            {
                Ok((bot_instance, _status)) => {
                    failure_counts.remove(&key);
                    next_retry.remove(&key);
                    orphaned.remove(&key);

                    // Re-insert into agent state. If startup missed this channel
                    // completely, create the AgentInstance from disk config so
                    // future monitor cycles can see it.
                    let mut agents_guard = agent_state.lock().await;
                    let agent =
                        agents_guard
                            .entry(agent_id.clone())
                            .or_insert_with(|| AgentInstance {
                                agent_id: agent_id.clone(),
                                config: agent_cfg.clone(),
                                channels: HashMap::new(),
                                last_active_channel: Arc::new(RwLock::new(
                                    agent_cfg.last_active_channel.clone(),
                                )),
                                last_active_private_target: Arc::new(RwLock::new(
                                    agent_cfg.last_active_private_target.clone(),
                                )),
                                heartbeat_handle: None,
                                heartbeat_wake_tx: None,
                                heartbeat_config: None,
                                current_model: Arc::new(RwLock::new(agent_cfg.model.clone())),
                                current_provider_env: Arc::new(RwLock::new(
                                    agent_cfg
                                        .provider_env_json
                                        .as_ref()
                                        .and_then(|s| serde_json::from_str(s).ok()),
                                )),
                                permission_mode: Arc::new(RwLock::new(
                                    agent_channel_permission_mode.clone(),
                                )),
                                mcp_servers_json: Arc::new(RwLock::new(
                                    agent_cfg.mcp_servers_json.clone(),
                                )),
                                runtime_config: Arc::new(RwLock::new(
                                    agent_cfg.runtime_config.clone(),
                                )),
                                memory_evolution_config: None,
                            });
                    let link = AgentChannelLink {
                        channel_id: channel_id.clone(),
                        agent_id: agent_id.clone(),
                        last_active_channel: Arc::clone(&agent.last_active_channel),
                        last_active_private_target: Arc::clone(&agent.last_active_private_target),
                    };
                    *bot_instance.agent_link.write().await = Some(link);

                    agent.channels.insert(
                        channel_id.clone(),
                        ChannelInstance {
                            channel_id: channel_id.clone(),
                            bot_instance,
                        },
                    );
                    drop(agents_guard);

                    ensure_agent_level_runners_started(
                        app_handle.clone(),
                        Arc::clone(&*agent_state),
                        Arc::clone(&*sidecar_manager),
                        agent_cfg.clone(),
                    )
                    .await;

                    ulog_info!(
                        "[agent-monitor] Channel {} is running after monitor recovery",
                        channel_id
                    );
                    let _ = app_handle.emit(
                        "agent:status-changed",
                        serde_json::json!({
                            "agentId": agent_id,
                            "event": "channel_auto_restarted",
                            "channelId": channel_id,
                        }),
                    );
                }
                Err(e) => {
                    *count += 1;
                    // Track as orphaned so next cycle retries even though
                    // the channel was removed from agent_state
                    orphaned.insert(key.clone());
                    // Schedule next retry with exponential backoff
                    let backoff = std::cmp::min(
                        BACKOFF_BASE_SECS.saturating_mul(2u64.saturating_pow(*count - 1)),
                        MAX_BACKOFF_SECS,
                    );
                    next_retry.insert(key.clone(), now + Duration::from_secs(backoff));
                    ulog_error!(
                        "[agent-monitor] Failed to restart channel {} (attempt {}, next retry in {}s): {}",
                        channel_id,
                        count,
                        backoff,
                        e
                    );
                }
            }
        }

        // Clean up: remove entries for channels that recovered or were manually stopped
        // Keep entries that are in orphaned (awaiting retry) or in dead_channels
        let tracked: std::collections::HashSet<(String, String)> = dead_channels
            .iter()
            .cloned()
            .chain(orphaned.iter().cloned())
            .collect();
        failure_counts.retain(|k, _| tracked.contains(k));
        next_retry.retain(|k, _| tracked.contains(k));
    }
}

#[cfg(test)]
mod enabled_intent_tests {
    use super::*;

    #[test]
    fn channel_intent_preserves_latest_config_and_rejects_invalid_enable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = serde_json::json!({"themeId":"latest-theme", "appearanceMode":"system", "themeSelectionExplicit":true, "agents":[{
            "id":"a", "name":"Latest name", "enabled":true, "model":"latest-model",
            "channels":[{"id":"c", "type":"telegram", "enabled":true}]
        }]});
        std::fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        let archived = ArchivedAgentWorkspaces::default();
        persist_agent_channel_enabled_at_path(&path, &archived, "a", "c", false).unwrap();
        let actual: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut expected = config;
        expected["agents"][0]["channels"][0]["enabled"] = false.into();
        assert_eq!(actual, expected);
        assert!(persist_agent_channel_enabled_at_path(&path, &archived, "a", "c", true).is_err());
        assert!(
            persist_agent_channel_enabled_at_path(&path, &archived, "a", "missing", false).is_err()
        );
        let actual: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(actual, expected);
    }
}
