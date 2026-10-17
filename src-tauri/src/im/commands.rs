use super::*;

// ===== Tauri Commands =====

#[deprecated(note = "Use cmd_start_agent_channel instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_start_im_bot(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
    botToken: String,
    allowedUsers: Vec<String>,
    permissionMode: String,
    workspacePath: String,
    model: Option<String>,
    providerEnvJson: Option<String>,
    mcpServersJson: Option<String>,
    platform: Option<String>,
    feishuAppId: Option<String>,
    feishuAppSecret: Option<String>,
    dingtalkClientId: Option<String>,
    dingtalkClientSecret: Option<String>,
    dingtalkUseAiCard: Option<bool>,
    dingtalkCardTemplateId: Option<String>,
    telegramUseDraft: Option<bool>,
    heartbeatConfigJson: Option<String>,
    botName: Option<String>,
    openclawPluginId: Option<String>,
    openclawNpmSpec: Option<String>,
    openclawPluginConfig: Option<serde_json::Value>,
) -> Result<ImBotStatus, String> {
    ulog_warn!("[im] Deprecated cmd_start_im_bot called for bot={}", botId);
    let im_platform = match platform.as_deref() {
        Some("feishu") => ImPlatform::Feishu,
        Some("dingtalk") => ImPlatform::Dingtalk,
        Some(p) if p.starts_with("openclaw:") => {
            let channel_id = p.strip_prefix("openclaw:").unwrap_or("").to_string();
            ImPlatform::OpenClaw(channel_id)
        }
        _ => ImPlatform::Telegram,
    };
    let heartbeat_config = heartbeatConfigJson
        .as_deref()
        .filter(|s| !s.is_empty() && *s != "null")
        .and_then(|s| serde_json::from_str::<types::HeartbeatConfig>(s).ok());
    // Load persisted group fields from disk so manual start/restart doesn't lose approvals
    let existing_configs = read_im_configs_from_disk();
    let existing = existing_configs
        .iter()
        .find(|(id, _)| id == &botId)
        .map(|(_, c)| c);

    let config = ImConfig {
        platform: im_platform,
        name: botName,
        bot_token: botToken,
        allowed_users: allowedUsers,
        permission_mode: permissionMode,
        default_workspace_path: Some(workspacePath),
        enabled: true,
        feishu_app_id: feishuAppId,
        feishu_app_secret: feishuAppSecret,
        dingtalk_client_id: dingtalkClientId,
        dingtalk_client_secret: dingtalkClientSecret,
        dingtalk_use_ai_card: dingtalkUseAiCard,
        dingtalk_card_template_id: dingtalkCardTemplateId,
        telegram_use_draft: telegramUseDraft,
        provider_id: None, // Not needed here — frontend passes providerEnvJson directly
        model,
        provider_env_json: providerEnvJson,
        mcp_servers_json: mcpServersJson,
        runtime: None,
        runtime_config: None,
        heartbeat_config,
        group_permissions: existing
            .map(|c| c.group_permissions.clone())
            .unwrap_or_default(),
        group_activation: existing.and_then(|c| c.group_activation.clone()),
        group_tools_deny: existing
            .map(|c| c.group_tools_deny.clone())
            .unwrap_or_default(),
        openclaw_plugin_id: openclawPluginId,
        openclaw_npm_spec: openclawNpmSpec,
        openclaw_plugin_config: openclawPluginConfig,
        openclaw_enabled_tool_groups: None, // Legacy bot path — tool groups set via Agent channel config
    };

    start_im_bot(&app_handle, &imState, &sidecarManager, botId, config).await
}

#[deprecated(note = "Use cmd_stop_agent_channel instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_stop_im_bot(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
) -> Result<(), String> {
    ulog_warn!("[im] Deprecated cmd_stop_im_bot called for bot={}", botId);
    stop_im_bot(&imState, &sidecarManager, &botId).await?;
    let _ = app_handle.emit("im:status-changed", json!({ "event": "stopped" }));
    Ok(())
}

#[deprecated(note = "Use cmd_agent_channel_status instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_im_bot_status(
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
) -> Result<ImBotStatus, String> {
    // First check legacy ManagedImBots
    let status = get_im_bot_status(&imState, &botId).await;
    if status.status != types::ImStatus::Stopped {
        return Ok(status);
    }

    // Fallback: check ManagedAgents (bot may have been moved there by cmd_start_agent_channel)
    let agents_guard = agentState.lock().await;
    for (_agent_id, agent) in agents_guard.iter() {
        if let Some(ch) = agent.channels.get(&botId) {
            let health_state = ch.bot_instance.health.get_state().await;

            // Compute bind_url/bind_code like get_im_bot_status does
            let (bind_url, bind_code) = match ch.bot_instance.platform {
                types::ImPlatform::Telegram => {
                    let url = health_state
                        .bot_username
                        .as_ref()
                        .map(|u| format!("https://t.me/{}?start={}", u, ch.bot_instance.bind_code));
                    (url, None)
                }
                types::ImPlatform::Feishu => (None, Some(ch.bot_instance.bind_code.clone())),
                types::ImPlatform::Dingtalk => (None, Some(ch.bot_instance.bind_code.clone())),
                _ => (None, None),
            };

            return Ok(types::ImBotStatus {
                bot_username: health_state.bot_username,
                status: health_state.status,
                uptime_seconds: ch.bot_instance.started_at.elapsed().as_secs(),
                last_message_at: health_state.last_message_at,
                active_sessions: ch.bot_instance.router.lock().await.active_sessions(),
                error_message: health_state.error_message,
                restart_count: health_state.restart_count,
                buffered_messages: ch.bot_instance.buffer.lock().await.len(),
                bind_url,
                bind_code,
            });
        }
    }

    Ok(status)
}

#[deprecated(note = "Use cmd_all_agents_status instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_im_all_bots_status(
    imState: tauri::State<'_, ManagedImBots>,
) -> Result<HashMap<String, ImBotStatus>, String> {
    ulog_warn!("[im] Deprecated cmd_im_all_bots_status called");
    Ok(get_all_bots_status(&imState).await)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_conversations(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
) -> Result<Vec<ImConversation>, String> {
    let im_guard = imState.lock().await;

    if let Some(instance) = im_guard.get(&botId) {
        let sessions = instance.router.lock().await.active_sessions();
        let conversations: Vec<ImConversation> = sessions
            .iter()
            .map(|s| {
                let (source_type, source_id) = router::parse_session_key(&s.session_key);

                ImConversation {
                    session_id: String::new(), // Could be fetched from PeerSession
                    session_key: s.session_key.clone(),
                    source_type,
                    source_id,
                    workspace_path: s.workspace_path.clone(),
                    message_count: s.message_count,
                    last_active: s.last_active.clone(),
                }
            })
            .collect();
        Ok(conversations)
    } else {
        Ok(Vec::new())
    }
}

// ===== Unified Config Commands (v0.1.26) =====

/// Persist a partial patch to a single bot's entry in `~/.myagents/config.json`.
/// Uses the shared config lock. `None` = no change, `Some("")` = clear.
pub(super) fn persist_bot_config_patch(bot_id: &str, patch: &BotConfigPatch) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[im] Home dir not found")?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");
    with_config_lock(&config_path, true, |config| {
        // Find the bot/channel entry: search legacy imBotConfigs first, then agents[].channels[] (v0.1.42)
        // Use JSON Pointer path to locate the entry, then get a mutable reference.
        enum BotLocation {
            Legacy(usize),
            AgentChannel(usize, usize),
        }
        let location = {
            let mut found: Option<BotLocation> = None;
            if let Some(bots) = config.get("imBotConfigs").and_then(|v| v.as_array()) {
                for (i, b) in bots.iter().enumerate() {
                    if b.get("id").and_then(|v| v.as_str()) == Some(bot_id) {
                        found = Some(BotLocation::Legacy(i));
                        break;
                    }
                }
            }
            if found.is_none() {
                if let Some(agents) = config.get("agents").and_then(|v| v.as_array()) {
                    'search: for (ai, agent) in agents.iter().enumerate() {
                        if let Some(channels) = agent.get("channels").and_then(|v| v.as_array()) {
                            for (ci, ch) in channels.iter().enumerate() {
                                if ch.get("id").and_then(|v| v.as_str()) == Some(bot_id) {
                                    found = Some(BotLocation::AgentChannel(ai, ci));
                                    break 'search;
                                }
                            }
                        }
                    }
                }
            }
            found.ok_or_else(|| format!("[im] Bot {} not found in config.json", bot_id))?
        };
        let is_channel = matches!(location, BotLocation::AgentChannel(_, _));
        let bot = match location {
            BotLocation::Legacy(i) => &mut config["imBotConfigs"][i],
            BotLocation::AgentChannel(ai, ci) => &mut config["agents"][ai]["channels"][ci],
        };

        // Helper: apply optional string field (None=skip, Some("")=remove, Some(val)=set)
        fn apply_opt(target: &mut serde_json::Value, key: &str, val: &Option<String>) {
            if let Some(ref v) = *val {
                if v.is_empty() {
                    if let Some(o) = target.as_object_mut() {
                        o.remove(key);
                    }
                } else {
                    target[key] = serde_json::json!(v);
                }
            }
        }

        // Transport edits preserve legacy execution data without granting write authority.
        if patch.model.is_some()
            || patch.provider_id.is_some()
            || patch.provider_env_json.is_some()
            || patch.permission_mode.is_some()
            || patch.mcp_servers_json.is_some()
            || patch.mcp_enabled_servers.is_some()
        {
            return Err(
                "Channel execution overrides are no longer supported; update the Agent or Session"
                    .into(),
            );
        }

        // Platform-specific fields → always at channel/bot root
        apply_opt(bot, "defaultWorkspacePath", &patch.default_workspace_path);
        apply_opt(bot, "name", &patch.name);
        apply_opt(bot, "botToken", &patch.bot_token);
        apply_opt(bot, "feishuAppId", &patch.feishu_app_id);
        apply_opt(bot, "feishuAppSecret", &patch.feishu_app_secret);
        apply_opt(bot, "dingtalkClientId", &patch.dingtalk_client_id);
        apply_opt(bot, "dingtalkClientSecret", &patch.dingtalk_client_secret);
        apply_opt(
            bot,
            "dingtalkCardTemplateId",
            &patch.dingtalk_card_template_id,
        );

        // dingtalk_use_ai_card → boolean field
        if let Some(val) = patch.dingtalk_use_ai_card {
            bot["dingtalkUseAiCard"] = serde_json::json!(val);
        }

        // telegram_use_draft → boolean field
        if let Some(val) = patch.telegram_use_draft {
            bot["telegramUseDraft"] = serde_json::json!(val);
        }

        // mcp_enabled_servers → persisted as "mcpEnabledServers"
        if let Some(ref servers) = patch.mcp_enabled_servers {
            bot["mcpEnabledServers"] = serde_json::json!(servers);
        }

        // mcp_servers_json → persisted as "mcpServersJson" (resolved definitions for auto-start)
        if let Some(ref json) = patch.mcp_servers_json {
            if json.is_empty() {
                if let Some(o) = bot.as_object_mut() {
                    o.remove("mcpServersJson");
                }
            } else {
                bot["mcpServersJson"] = serde_json::json!(json);
            }
        }

        // allowed_users → persisted as "allowedUsers"
        if let Some(ref users) = patch.allowed_users {
            bot["allowedUsers"] = serde_json::json!(users);
        }

        // heartbeat_config_json → deserialized and written as "heartbeat" object
        if let Some(ref hcj) = patch.heartbeat_config_json {
            if hcj.is_empty() || hcj == "null" {
                if let Some(o) = bot.as_object_mut() {
                    o.remove("heartbeat");
                }
            } else if let Ok(hb) = serde_json::from_str::<serde_json::Value>(hcj) {
                bot["heartbeat"] = hb;
            }
        }

        // enabled / setup_completed → boolean fields
        if let Some(val) = patch.enabled {
            bot["enabled"] = serde_json::json!(val);
        }
        if let Some(val) = patch.setup_completed {
            bot["setupCompleted"] = serde_json::json!(val);
        }

        // OpenClaw plugin config (v0.1.38)
        if let Some(ref val) = patch.openclaw_plugin_config {
            if val.is_null() {
                if let Some(o) = bot.as_object_mut() {
                    o.remove("openclawPluginConfig");
                }
            } else {
                bot["openclawPluginConfig"] = val.clone();
            }
        }

        // Group chat fields (v0.1.28)
        if let Some(ref perms) = patch.group_permissions {
            bot["groupPermissions"] = serde_json::json!(perms);
        }
        if let Some(ref activation) = patch.group_activation {
            if activation.is_empty() {
                if let Some(o) = bot.as_object_mut() {
                    o.remove("groupActivation");
                }
            } else {
                bot["groupActivation"] = serde_json::json!(activation);
            }
        }
        if let Some(ref tools) = patch.group_tools_deny {
            // For channels: toolsDeny lives in overrides (ChannelOverrides.tools_deny)
            // For legacy: groupToolsDeny at root
            if is_channel {
                if bot["overrides"].is_null() {
                    bot["overrides"] = serde_json::json!({});
                }
                bot["overrides"]["toolsDeny"] = serde_json::json!(tools);
                // Clean up stale root-level field
                if let Some(obj) = bot.as_object_mut() {
                    obj.remove("groupToolsDeny");
                }
            } else {
                bot["groupToolsDeny"] = serde_json::json!(tools);
            }
        }

        Ok(())
    })?;

    Ok(())
}

/// Transport configuration update: disk → hot projection → emit.
async fn update_bot_config_internal<R: Runtime>(
    app: &AppHandle<R>,
    im_state: &ManagedImBots,
    bot_id: &str,
    patch: &BotConfigPatch,
) -> Result<(), String> {
    // 1. Persist to disk (blocking I/O)
    let bid = bot_id.to_string();
    let patch_model = patch.model.clone();
    let patch_provider_id = patch.provider_id.clone();
    let patch_provider_env = patch.provider_env_json.clone();
    let patch_perm = patch.permission_mode.clone();
    let patch_mcp_json = patch.mcp_servers_json.clone();
    let patch_mcp_enabled = patch.mcp_enabled_servers.clone();
    let patch_workspace = patch.default_workspace_path.clone();
    let patch_hb_json = patch.heartbeat_config_json.clone();
    let patch_allowed = patch.allowed_users.clone();
    let patch_enabled = patch.enabled;
    let patch_setup = patch.setup_completed;
    let patch_name = patch.name.clone();
    let patch_bot_token = patch.bot_token.clone();
    let patch_feishu_id = patch.feishu_app_id.clone();
    let patch_feishu_secret = patch.feishu_app_secret.clone();
    let patch_dingtalk_id = patch.dingtalk_client_id.clone();
    let patch_dingtalk_secret = patch.dingtalk_client_secret.clone();
    let patch_dingtalk_ai_card = patch.dingtalk_use_ai_card;
    let patch_dingtalk_template = patch.dingtalk_card_template_id.clone();
    let patch_telegram_draft = patch.telegram_use_draft;
    let patch_group_perms = patch.group_permissions.clone();
    let patch_group_activation = patch.group_activation.clone();
    let patch_group_tools_deny = patch.group_tools_deny.clone();

    let disk_patch = BotConfigPatch {
        model: patch_model.clone(),
        provider_id: patch_provider_id.clone(),
        provider_env_json: patch_provider_env.clone(),
        permission_mode: patch_perm.clone(),
        mcp_servers_json: patch_mcp_json.clone(), // Persisted for auto-start reconstruction
        mcp_enabled_servers: patch_mcp_enabled,
        allowed_users: patch_allowed.clone(),
        default_workspace_path: patch_workspace.clone(),
        heartbeat_config_json: patch_hb_json.clone(),
        name: patch_name,
        bot_token: patch_bot_token,
        feishu_app_id: patch_feishu_id,
        feishu_app_secret: patch_feishu_secret,
        dingtalk_client_id: patch_dingtalk_id,
        dingtalk_client_secret: patch_dingtalk_secret,
        dingtalk_use_ai_card: patch_dingtalk_ai_card,
        dingtalk_card_template_id: patch_dingtalk_template,
        telegram_use_draft: patch_telegram_draft,
        enabled: patch_enabled,
        setup_completed: patch_setup,
        group_permissions: patch_group_perms.clone(),
        group_activation: patch_group_activation.clone(),
        group_tools_deny: patch_group_tools_deny.clone(),
        openclaw_plugin_config: patch.openclaw_plugin_config.clone(),
        openclaw_enabled_tool_groups: patch.openclaw_enabled_tool_groups.clone(),
    };
    let bid_for_disk = bid.clone();
    tokio::task::spawn_blocking(move || persist_bot_config_patch(&bid_for_disk, &disk_patch))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))??;

    // 2. Update Arc fields if bot is running
    {
        let bots = im_state.lock().await;
        if let Some(inst) = bots.get(&bid) {
            if let Some(ref m) = patch_model {
                *inst.current_model.write().await =
                    if m.is_empty() { None } else { Some(m.clone()) };
            }
            if let Some(ref s) = patch_provider_env {
                if s.is_empty() {
                    *inst.current_provider_env.write().await = None;
                } else {
                    *inst.current_provider_env.write().await = serde_json::from_str(s).ok();
                }
            }
            if let Some(ref pm) = patch_perm {
                *inst.permission_mode.write().await = pm.clone();
            }
            if let Some(ref mj) = patch_mcp_json {
                *inst.mcp_servers_json.write().await = if mj.is_empty() {
                    None
                } else {
                    Some(mj.clone())
                };
            }
            if let Some(ref users) = patch_allowed {
                *inst.allowed_users.write().await = users.clone();
            }
            if let Some(ref hcj) = patch_hb_json {
                if let Some(ref config_arc) = inst.heartbeat_config {
                    if let Ok(hb) = serde_json::from_str::<types::HeartbeatConfig>(hcj) {
                        *config_arc.write().await = hb;
                        // Wake heartbeat runner to pick up new interval immediately
                        if let Some(ref tx) = inst.heartbeat_wake_tx {
                            let _ =
                                tx.try_send(types::HeartbeatWake::new(types::WakeReason::Interval));
                        }
                    }
                }
            }

            // Group chat fields (v0.1.28)
            if let Some(ref perms) = patch_group_perms {
                *inst.group_permissions.write().await = perms.clone();
            }
            if let Some(ref act) = patch_group_activation {
                let activation = match act.as_str() {
                    "always" => GroupActivation::Always,
                    _ => GroupActivation::Mention,
                };
                *inst.group_activation.write().await = activation;
            }
            if let Some(ref tools) = patch_group_tools_deny {
                *inst.group_tools_deny.write().await = tools.clone();
            }

            // Workspace is a future-session template, never an existing Session mutation.
            if let Some(ref wp) = patch_workspace {
                if !wp.is_empty() {
                    inst.router
                        .lock()
                        .await
                        .set_default_workspace(PathBuf::from(wp));
                }
            }
        }
    }

    // 3. Emit event so frontend can refreshConfig()
    let _ = app.emit("im:bot-config-changed", json!({ "botId": bid }));

    Ok(())
}

/// Add a new bot entry to `~/.myagents/config.json`.
fn add_bot_config_to_disk(bot_config: &serde_json::Value) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[im] Home dir not found")?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");
    with_config_lock(&config_path, true, |config| {
        // Ensure imBotConfigs array exists
        if config.get("imBotConfigs").is_none() {
            config["imBotConfigs"] = serde_json::json!([]);
        }
        let bots = config
            .get_mut("imBotConfigs")
            .unwrap()
            .as_array_mut()
            .unwrap();

        // Upsert: if bot with same id exists, replace it; otherwise append
        let bot_id = bot_config.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(pos) = bots
            .iter()
            .position(|b| b.get("id").and_then(|v| v.as_str()) == Some(bot_id))
        {
            bots[pos] = bot_config.clone();
        } else {
            bots.push(bot_config.clone());
        }
        Ok(())
    })?;

    Ok(())
}

/// Remove a bot entry from `~/.myagents/config.json`.
fn remove_bot_config_from_disk(bot_id: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[im] Home dir not found")?;
    let config_path = home
        .join(crate::app_dirs::APP_DATA_DIR_NAME)
        .join("config.json");
    with_config_lock(&config_path, true, |config| {
        if let Some(bots) = config
            .get_mut("imBotConfigs")
            .and_then(|v| v.as_array_mut())
        {
            bots.retain(|b| b.get("id").and_then(|v| v.as_str()) != Some(bot_id));
        }
        Ok(())
    })?;

    Ok(())
}

/// Read `availableProvidersJson` from the top-level field of `~/.myagents/config.json`.

/// Unified config update command: replaces all 6 old hot-update commands.
#[deprecated(note = "Use cmd_update_agent_config instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_update_im_bot_config(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    patch: BotConfigPatch,
) -> Result<(), String> {
    update_bot_config_internal(&app_handle, &imState, &botId, &patch).await
}

/// Read runtime config snapshot from a running bot's Arc fields.
/// Returns the hot-reloadable config as a JSON object; returns null fields if bot is not running.
#[deprecated(note = "Use cmd_agent_channel_status or cmd_agent_status instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_get_im_bot_runtime_config(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
) -> Result<serde_json::Value, String> {
    let im_guard = imState.lock().await;
    if let Some(instance) = im_guard.get(&botId) {
        let model = instance.current_model.read().await.clone();
        let provider_env = instance.current_provider_env.read().await.clone();
        let permission_mode = instance.permission_mode.read().await.clone();
        let mcp_servers_json = instance.mcp_servers_json.read().await.clone();
        let runtime = instance.runtime.read().await.clone();
        let runtime_config = instance.runtime_config.read().await.clone();
        let allowed_users = instance.allowed_users.read().await.clone();
        Ok(json!({
            "running": true,
            "model": model,
            "providerEnv": provider_env,
            "permissionMode": permission_mode,
            "mcpServersJson": mcp_servers_json,
            "runtime": runtime,
            "runtimeConfig": runtime_config,
            "allowedUsers": allowed_users,
        }))
    } else {
        Ok(json!({ "running": false }))
    }
}

/// Add a new bot config to disk.
#[deprecated(note = "Use addAgentConfig on the frontend instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_add_im_bot_config(
    app_handle: AppHandle,
    botConfig: serde_json::Value,
) -> Result<(), String> {
    let config_clone = botConfig.clone();
    tokio::task::spawn_blocking(move || add_bot_config_to_disk(&config_clone))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))??;
    let bot_id = botConfig
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": bot_id }));
    ulog_info!("[im] Bot config added: {}", bot_id);
    Ok(())
}

/// Remove a bot config from disk (stops the bot first if running).
#[deprecated(note = "Use removeAgentConfig on the frontend instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_remove_im_bot_config(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
) -> Result<(), String> {
    // Stop bot if running
    stop_im_bot(&imState, &sidecarManager, &botId).await?;

    let bid = botId.clone();
    tokio::task::spawn_blocking(move || {
        remove_bot_config_from_disk(&bid)?;
        health::cleanup_bot_data(&bid);
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Bot config removed: {}", botId);
    Ok(())
}

// ===== Group Permission Commands (v0.1.28) =====
// Pattern: extract Arc clones under the ManagedImBots lock, drop the lock,
// then do I/O (disk persist, network send) to avoid blocking other Tauri commands.
//
// v0.1.41+: Channels may live in ManagedAgents instead of ManagedImBots.
// Helper resolves from both containers.

/// Resolve group-related Arcs from either ManagedImBots (legacy) or ManagedAgents (v0.1.41+).
/// Returns (group_permissions, group_history, adapter, platform_str) or "Bot not running" error.
async fn resolve_group_context(
    im_state: &ManagedImBots,
    agent_state: &ManagedAgents,
    bot_id: &str,
) -> Result<
    (
        Arc<tokio::sync::RwLock<Vec<GroupPermission>>>,
        Arc<Mutex<GroupHistoryBuffer>>,
        Arc<AnyAdapter>,
        String,
    ),
    String,
> {
    // 1. Check ManagedAgents first (new Agent architecture)
    {
        let agents = agent_state.lock().await;
        for (_agent_id, agent) in agents.iter() {
            if let Some(ch) = agent.channels.get(bot_id) {
                let inst = &ch.bot_instance;
                return Ok((
                    Arc::clone(&inst.group_permissions),
                    Arc::clone(&inst.group_history),
                    Arc::clone(&inst.adapter),
                    inst.platform.to_string(),
                ));
            }
        }
    }
    // 2. Fallback: legacy ManagedImBots
    {
        let bots = im_state.lock().await;
        let inst = bots
            .get(bot_id)
            .ok_or_else(|| "Bot not running".to_string())?;
        Ok((
            Arc::clone(&inst.group_permissions),
            Arc::clone(&inst.group_history),
            Arc::clone(&inst.adapter),
            inst.platform.to_string(),
        ))
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_approve_group(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
    groupId: String,
) -> Result<(), String> {
    use adapter::ImAdapter;

    let (group_perms, _group_history, adapter, _platform) =
        resolve_group_context(&imState, &agentState, &botId).await?;

    // Update permission status to Approved
    {
        let mut perms = group_perms.write().await;
        if let Some(p) = perms.iter_mut().find(|p| p.group_id == groupId) {
            p.status = GroupPermissionStatus::Approved;
        } else {
            return Err(format!("Group {} not found in permissions", groupId));
        }
    }

    // Persist (lock-free)
    let new_perms = group_perms.read().await.clone();
    let bid = botId.clone();
    let gid = groupId.clone();
    tokio::task::spawn_blocking(move || {
        let patch = BotConfigPatch {
            group_permissions: Some(new_perms),
            ..Default::default()
        };
        persist_bot_config_patch(&bid, &patch)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))??;

    // Send confirmation message to group (lock-free)
    if let Err(e) = adapter
        .send_message(&groupId, "✅ 群聊已授权！所有成员现在可以 @我 提问互动。")
        .await
    {
        ulog_warn!("[im-cmd] send_message (group approved) failed: {}", e);
    }

    let _ = app_handle.emit(
        "im:group-permission-changed",
        json!({ "botId": botId, "event": "approved" }),
    );
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Group approved: {} for bot {}", gid, botId);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_reject_group(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
    groupId: String,
) -> Result<(), String> {
    let (group_perms, group_history, _adapter, platform) =
        resolve_group_context(&imState, &agentState, &botId).await?;

    // Remove pending permission
    {
        let mut perms = group_perms.write().await;
        perms.retain(|p| p.group_id != groupId);
    }

    // Clean up group history buffer
    let session_key = format!("im:{}:group:{}", platform, groupId);
    group_history.lock().await.clear(&session_key);

    // Persist (lock-free)
    let new_perms = group_perms.read().await.clone();
    let bid = botId.clone();
    tokio::task::spawn_blocking(move || {
        let patch = BotConfigPatch {
            group_permissions: Some(new_perms),
            ..Default::default()
        };
        persist_bot_config_patch(&bid, &patch)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit(
        "im:group-permission-changed",
        json!({ "botId": botId, "event": "rejected" }),
    );
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Group rejected: {} for bot {}", groupId, botId);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_remove_group(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
    groupId: String,
) -> Result<(), String> {
    let (group_perms, group_history, _adapter, platform) =
        resolve_group_context(&imState, &agentState, &botId).await?;

    // Remove approved permission
    {
        let mut perms = group_perms.write().await;
        perms.retain(|p| p.group_id != groupId);
    }

    // Clean up group history buffer
    let session_key = format!("im:{}:group:{}", platform, groupId);
    group_history.lock().await.clear(&session_key);

    // Persist (lock-free)
    let new_perms = group_perms.read().await.clone();
    let bid = botId.clone();
    tokio::task::spawn_blocking(move || {
        let patch = BotConfigPatch {
            group_permissions: Some(new_perms),
            ..Default::default()
        };
        persist_bot_config_patch(&bid, &patch)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit(
        "im:group-permission-changed",
        json!({ "botId": botId, "event": "removed" }),
    );
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Group removed: {} for bot {}", groupId, botId);
    Ok(())
}

// ===== OpenClaw Channel Plugin Commands =====

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_install_openclaw_plugin(
    app_handle: AppHandle,
    npmSpec: String,
) -> Result<serde_json::Value, String> {
    bridge::install_openclaw_plugin(&app_handle, &npmSpec).await
}

#[tauri::command]
pub async fn cmd_list_openclaw_plugins() -> Result<Vec<serde_json::Value>, String> {
    bridge::list_openclaw_plugins().await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_uninstall_openclaw_plugin(pluginId: String) -> Result<(), String> {
    bridge::uninstall_openclaw_plugin(&pluginId).await
}

/// Helper: get bridge port from agent channel.
/// Both the outer (ManagedAgents) and inner (BridgeProcess) locks are held briefly
/// to extract the port value, then released before the actual HTTP call.
async fn get_bridge_port(
    agent_state: &ManagedAgents,
    agent_id: &str,
    channel_id: &str,
) -> Result<u16, String> {
    let agents_guard = agent_state.lock().await;
    let agent = agents_guard
        .get(agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;
    let ch = agent
        .channels
        .get(channel_id)
        .ok_or_else(|| format!("Channel '{}' not found on agent '{}'", channel_id, agent_id))?;
    let bp_mutex = ch
        .bot_instance
        .bridge_process
        .as_ref()
        .ok_or_else(|| "Channel has no Bridge process (not an OpenClaw plugin)".to_string())?;
    let port = bp_mutex.lock().await.port;
    drop(agents_guard);
    Ok(port)
}

/// QR login: start QR code generation via Bridge.
/// The channel must already be started (Bridge process running).
/// Returns { ok, qrDataUrl?, message, sessionKey? }.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_plugin_qr_login_start(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
) -> Result<serde_json::Value, String> {
    let port = get_bridge_port(&agentState, &agentId, &channelId).await?;
    bridge::qr_login_start(port, None).await
}

/// QR login: wait for user to scan QR code via Bridge.
/// Long-polls (up to 60s). Returns { ok, connected, message }.
/// `sessionKey` is returned by `cmd_plugin_qr_login_start` and MUST be forwarded here
/// (WeChat plugin uses it to track the active login session).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_plugin_qr_login_wait(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
    sessionKey: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = get_bridge_port(&agentState, &agentId, &channelId).await?;
    bridge::qr_login_wait(port, None, sessionKey.as_deref()).await
}

/// Restart the gateway after QR login success.
/// Re-resolves credentials and starts the plugin's message listener.
/// `accountId` is returned by the plugin during QR login (e.g. WeChat's ilink_bot_id)
/// and is REQUIRED for `resolveAccount()` to find the newly-saved credentials.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_plugin_restart_gateway(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
    accountId: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = get_bridge_port(&agentState, &agentId, &channelId).await?;
    bridge::restart_gateway(port, accountId.as_deref()).await
}

/// Restart all running channels that use the given OpenClaw plugin.
/// Called after a plugin update to reload the new plugin code.
/// Returns `{ restarted, failed }` so the frontend can show appropriate feedback.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_restart_channels_using_plugin(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    pluginId: String,
) -> Result<serde_json::Value, String> {
    let running_bot_ids = bridge::get_bot_ids_using_plugin(&pluginId).await;
    if running_bot_ids.is_empty() {
        return Ok(json!({ "restarted": 0, "failed": 0 }));
    }

    ulog_info!(
        "[agent] Restarting {} channel(s) using plugin {}",
        running_bot_ids.len(),
        pluginId
    );

    let mut restarted = 0u32;
    let mut failed = 0u32;

    for bot_id in &running_bot_ids {
        // Find the agent_id for this bot in ManagedAgents
        let found = {
            let agents = agentState.lock().await;
            agents
                .iter()
                .find(|(_, agent)| agent.channels.contains_key(bot_id))
                .map(|(agent_id, _)| agent_id.clone())
        };

        let agent_id = match found {
            Some(id) => id,
            None => {
                ulog_warn!(
                    "[agent] Bot {} not found in ManagedAgents, skipping restart",
                    bot_id
                );
                continue;
            }
        };

        match restart_agent_channel_instance(
            &app_handle,
            &agentState,
            &sidecarManager,
            &agent_id,
            bot_id,
        )
        .await
        {
            Ok(true) => {
                restarted += 1;
                ulog_info!("[agent] Channel {} restarted successfully", bot_id);
            }
            Ok(false) => {}
            Err(e) => {
                ulog_warn!("[agent] Failed to restart channel {}: {}", bot_id, e);
                failed += 1;
            }
        }
    }

    // Always emit status change when channels were touched
    let _ = app_handle.emit("agent:status-changed", ());

    Ok(json!({ "restarted": restarted, "failed": failed }))
}

// ===== Agent Tauri Commands (v0.1.41) =====

/// Start a single channel within an agent.
/// Creates an ImBotInstance directly via create_bot_instance and inserts into ManagedAgents.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_start_agent_channel(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    channelId: String,
    workspacePath: String,
    agentConfig: AgentConfigRust,
    channelConfig: ChannelConfigRust,
) -> Result<ChannelStatus, String> {
    let lifecycle_lock = agent_channel_lifecycle_lock(&agentId, &channelId);
    let _lifecycle_guard = lifecycle_lock.lock().await;

    let _ = (&agentConfig, &channelConfig);
    start_agent_channel_with_lock_held(
        &app_handle,
        agentState.inner(),
        sidecarManager.inner(),
        agentId,
        channelId,
        Some(workspacePath),
    )
    .await
}

#[allow(non_snake_case)]
async fn start_agent_channel_with_lock_held(
    app_handle: &AppHandle,
    agentState: &ManagedAgents,
    sidecarManager: &ManagedSidecarManager,
    agentId: String,
    channelId: String,
    workspacePath: Option<String>,
) -> Result<ChannelStatus, String> {
    let (agentConfig, channelConfig, mut im_config) =
        config_store::current_agent_channel_start_config(&agentId, &channelId)?;
    if workspacePath.as_ref().is_some_and(|path| {
        crate::workspace_path::normalize_workspace_path_identity(
            &agentConfig.resolved_workspace_path,
        ) != crate::workspace_path::normalize_workspace_path_identity(path)
    }) {
        return Err(format!(
            "Agent '{}' workspace changed before channel start; refresh and retry",
            agentId
        ));
    }

    // Dedup: check if channel is already running in agent state.
    // If channel exists but is in Error/Stopped state, remove it to allow restart.
    {
        let mut agents_guard = agentState.lock().await;
        if let Some(agent) = agents_guard.get_mut(&agentId) {
            if agent.channels.contains_key(&channelId) {
                let is_dead = {
                    let ch = agent.channels.get(&channelId).unwrap();
                    let health_state = ch.bot_instance.health.get_state().await;
                    matches!(
                        health_state.status,
                        types::ImStatus::Error | types::ImStatus::Stopped
                    )
                };
                if is_dead {
                    ulog_info!(
                        "[agent] Channel {} in agent {} is dead, removing to allow restart",
                        channelId,
                        agentId
                    );
                    agent.channels.remove(&channelId);
                } else {
                    ulog_warn!(
                        "[agent] Channel {} already running in agent {}, skipping start",
                        channelId,
                        agentId
                    );
                    let ch = agent.channels.get(&channelId).ok_or_else(|| {
                        format!(
                            "[agent] Channel {} disappeared from agent {}",
                            channelId, agentId
                        )
                    })?;
                    let health_state = ch.bot_instance.health.get_state().await;
                    let active_sessions = ch.bot_instance.router.lock().await.active_sessions();
                    return Ok(ChannelStatus {
                        channel_id: channelId,
                        channel_type: ch.bot_instance.config.platform.clone(),
                        name: ch.bot_instance.config.name.clone(),
                        status: health_state.status,
                        bot_username: health_state.bot_username,
                        uptime_seconds: ch.bot_instance.started_at.elapsed().as_secs(),
                        last_message_at: health_state.last_message_at,
                        active_sessions,
                        error_message: health_state.error_message,
                        restart_count: health_state.restart_count,
                        buffered_messages: health_state.buffered_messages,
                        bind_url: None,
                        bind_code: Some(ch.bot_instance.bind_code.clone()),
                    });
                }
            }
        }
    } // agents_guard dropped

    let agent_channel_permission_mode = im_config.permission_mode.clone();
    // Suppress per-channel heartbeat interval — agent-level heartbeat controls timing
    im_config.heartbeat_config = Some(types::HeartbeatConfig {
        enabled: false,
        ..types::HeartbeatConfig::default()
    });

    // Create bot instance directly (no transit through ManagedImBots)
    let creation_permit = crate::sidecar::begin_lifecycle_spawn_permit()?;
    let (bot_instance, bot_status) = create_bot_instance(
        &app_handle,
        &sidecarManager,
        channelId.clone(),
        im_config,
        Some(agentId.clone()),
        &creation_permit,
    )
    .await?;

    // Insert directly into agent state
    let mut agents_guard = agentState.lock().await;
    let agent_instance = agents_guard
        .entry(agentId.clone())
        .or_insert_with(|| AgentInstance {
            agent_id: agentId.clone(),
            config: agentConfig.clone(),
            channels: HashMap::new(),
            last_active_channel: Arc::new(RwLock::new(agentConfig.last_active_channel.clone())),
            last_active_private_target: Arc::new(RwLock::new(
                agentConfig.last_active_private_target.clone(),
            )),
            heartbeat_handle: None,
            heartbeat_wake_tx: None,
            heartbeat_config: None,
            current_model: Arc::new(RwLock::new(agentConfig.model.clone())),
            current_provider_env: Arc::new(RwLock::new(
                agentConfig
                    .provider_env_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok()),
            )),
            permission_mode: Arc::new(RwLock::new(agent_channel_permission_mode.clone())),
            mcp_servers_json: Arc::new(RwLock::new(agentConfig.mcp_servers_json.clone())),
            runtime_config: Arc::new(RwLock::new(agentConfig.runtime_config.clone())),
            memory_evolution_config: None,
        });

    // Set agent_link so the processing loop can update lastActiveChannel
    let link = AgentChannelLink {
        channel_id: channelId.clone(),
        agent_id: agentId.clone(),
        last_active_channel: Arc::clone(&agent_instance.last_active_channel),
        last_active_private_target: Arc::clone(&agent_instance.last_active_private_target),
    };
    *bot_instance.agent_link.write().await = Some(link);

    agent_instance.channels.insert(
        channelId.clone(),
        ChannelInstance {
            channel_id: channelId.clone(),
            bot_instance,
        },
    );

    // Start agent-level heartbeat if not already running
    let needs_heartbeat =
        agent_instance.heartbeat_handle.is_none() && !agent_instance.channels.is_empty();
    if needs_heartbeat {
        let hb_config = agentConfig.effective_heartbeat();
        let agent_id_hb = agentId.clone();
        let agent_label = agentConfig.name.clone();
        let agent_state_for_hb = Arc::clone(&*agentState);
        let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
        let hb_config_arc = Arc::new(RwLock::new(hb_config));
        let hb_config_for_loop = Arc::clone(&hb_config_arc);

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
                {
                    let cfg = hb_config_for_loop.read().await;
                    let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                    if desired != interval.period() {
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
                    continue;
                }

                if !is_high_priority {
                    if let Some(ref active_hours) = config.active_hours {
                        if !is_in_active_hours(active_hours) {
                            continue;
                        }
                    }
                }

                if !route_agent_heartbeat_once(&agent_state_for_hb, &agent_id_hb, reason.clone())
                    .await
                {
                    break;
                }

                if is_high_priority {
                    interval.reset();
                }
            }

            ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
        });

        agent_instance.heartbeat_handle = Some(hb_handle);
        agent_instance.heartbeat_wake_tx = Some(wake_tx);
        agent_instance.heartbeat_config = Some(hb_config_arc);
    }

    drop(agents_guard);

    // Convert ImBotStatus to ChannelStatus
    let channel_status = ChannelStatus {
        channel_id: channelId,
        channel_type: channelConfig.channel_type,
        name: channelConfig.name,
        status: bot_status.status,
        bot_username: bot_status.bot_username,
        uptime_seconds: bot_status.uptime_seconds,
        last_message_at: bot_status.last_message_at,
        active_sessions: bot_status.active_sessions,
        error_message: bot_status.error_message,
        restart_count: bot_status.restart_count,
        buffered_messages: bot_status.buffered_messages,
        bind_url: bot_status.bind_url,
        bind_code: bot_status.bind_code,
    };

    let _ = app_handle.emit(
        "agent:status-changed",
        json!({ "agentId": agentId, "event": "channel_started" }),
    );

    Ok(channel_status)
}

/// User intent and runtime settlement share the existing Channel lifecycle.
#[tauri::command]
pub async fn cmd_set_agent_channel_enabled(
    app_handle: AppHandle,
    agent_state: tauri::State<'_, ManagedAgents>,
    sidecar_manager: tauri::State<'_, ManagedSidecarManager>,
    agent_id: String,
    channel_id: String,
    enabled: bool,
) -> Result<(), String> {
    let lifecycle_lock = agent_channel_lifecycle_lock(&agent_id, &channel_id);
    let _guard = lifecycle_lock.lock().await;
    config_store::persist_agent_channel_enabled(&agent_id, &channel_id, enabled)?;
    if enabled {
        start_agent_channel_with_lock_held(
            &app_handle,
            agent_state.inner(),
            sidecar_manager.inner(),
            agent_id,
            channel_id,
            None,
        )
        .await?;
    } else {
        agent_channel::stop_agent_channel_with_lock_held(
            &app_handle,
            agent_state.inner(),
            sidecar_manager.inner(),
            &agent_id,
            &channel_id,
        )
        .await?;
    }
    Ok(())
}

/// Stop a single channel within an agent.
/// Directly removes from ManagedAgents and shuts down — no transit through ManagedImBots.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_stop_agent_channel(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    channelId: String,
) -> Result<(), String> {
    stop_agent_channel_runtime(
        &app_handle,
        agentState.inner(),
        sidecarManager.inner(),
        &agentId,
        &channelId,
    )
    .await
    .map(|_| ())
}

/// Snapshot of channel refs needed for status collection (clone-then-drop pattern).
struct ChannelStatusRef {
    channel_id: String,
    channel_type: ImPlatform,
    name: Option<String>,
    health: Arc<HealthManager>,
    router: Arc<Mutex<SessionRouter>>,
    started_at: Instant,
    bind_code: String,
}

/// Collect channel status from pre-cloned refs (no Mutex held).
async fn collect_channel_statuses(refs: Vec<ChannelStatusRef>) -> Vec<ChannelStatus> {
    let mut out = Vec::with_capacity(refs.len());
    for r in refs {
        let health_state = r.health.get_state().await;
        let active_sessions = r.router.lock().await.active_sessions();
        out.push(ChannelStatus {
            channel_id: r.channel_id,
            channel_type: r.channel_type,
            name: r.name,
            status: health_state.status,
            bot_username: health_state.bot_username,
            uptime_seconds: r.started_at.elapsed().as_secs(),
            last_message_at: health_state.last_message_at,
            active_sessions,
            error_message: health_state.error_message,
            restart_count: health_state.restart_count,
            buffered_messages: health_state.buffered_messages,
            bind_url: None,
            bind_code: Some(r.bind_code),
        });
    }
    out
}

pub(super) fn configured_channel_status_from_state(
    agent_cfg: &AgentConfigRust,
    channel_cfg: &ChannelConfigRust,
    health_state: types::ImHealthState,
    workspace_archived: bool,
) -> Option<ChannelStatus> {
    if workspace_archived || !should_report_missing_configured_channel(agent_cfg, channel_cfg) {
        return None;
    }
    let status = missing_configured_channel_status(&health_state.status);
    let is_error = matches!(status, types::ImStatus::Error);

    Some(ChannelStatus {
        channel_id: channel_cfg.id.clone(),
        channel_type: channel_cfg.channel_type.clone(),
        name: channel_cfg.name.clone(),
        status,
        bot_username: health_state.bot_username,
        uptime_seconds: 0,
        last_message_at: health_state.last_message_at,
        active_sessions: health_state.active_sessions,
        error_message: if is_error {
            health_state.error_message
        } else {
            None
        },
        restart_count: health_state.restart_count,
        buffered_messages: health_state.buffered_messages,
        bind_url: None,
        bind_code: None,
    })
}

async fn configured_channel_status_from_disk(
    agent_cfg: &AgentConfigRust,
    channel_cfg: &ChannelConfigRust,
) -> Option<ChannelStatus> {
    let workspace_archived = is_agent_workspace_archived(agent_cfg);
    if workspace_archived || !should_report_missing_configured_channel(agent_cfg, channel_cfg) {
        return None;
    }
    let health = HealthManager::new(health::agent_channel_health_path(
        &agent_cfg.id,
        &channel_cfg.id,
    ));
    configured_channel_status_from_state(
        agent_cfg,
        channel_cfg,
        health.get_state().await,
        workspace_archived,
    )
}

async fn merge_configured_channel_statuses(
    agent_cfg: &AgentConfigRust,
    runtime_statuses: Vec<ChannelStatus>,
) -> Vec<ChannelStatus> {
    let configured_ids: std::collections::HashSet<&str> =
        agent_cfg.channels.iter().map(|ch| ch.id.as_str()).collect();
    let mut runtime_by_id: HashMap<String, ChannelStatus> = HashMap::new();
    let mut extras = Vec::new();

    for status in runtime_statuses {
        if configured_ids.contains(status.channel_id.as_str()) {
            runtime_by_id.insert(status.channel_id.clone(), status);
        } else {
            extras.push(status);
        }
    }

    let mut out = Vec::with_capacity(agent_cfg.channels.len() + extras.len());
    for channel_cfg in &agent_cfg.channels {
        if let Some(status) = runtime_by_id.remove(&channel_cfg.id) {
            out.push(status);
        } else if let Some(status) =
            configured_channel_status_from_disk(agent_cfg, channel_cfg).await
        {
            out.push(status);
        }
    }
    out.extend(extras);
    out
}

/// Get status for a single agent channel.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_agent_channel_status(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
) -> Result<Option<ChannelStatus>, String> {
    let snapshot = {
        let agents_guard = agentState.lock().await;
        agents_guard.get(&agentId).and_then(|agent| {
            agent
                .channels
                .get(&channelId)
                .map(|ch_inst| ChannelStatusRef {
                    channel_id: channelId.clone(),
                    channel_type: ch_inst.bot_instance.config.platform.clone(),
                    name: ch_inst.bot_instance.config.name.clone(),
                    health: Arc::clone(&ch_inst.bot_instance.health),
                    router: Arc::clone(&ch_inst.bot_instance.router),
                    started_at: ch_inst.bot_instance.started_at,
                    bind_code: ch_inst.bot_instance.bind_code.clone(),
                })
        })
    }; // agents_guard dropped

    if let Some(r) = snapshot {
        let statuses = collect_channel_statuses(vec![r]).await;
        Ok(statuses.into_iter().next())
    } else {
        let agent_configs = read_agent_configs_from_disk();
        let disk_channel = agent_configs
            .iter()
            .find(|agent| agent.id == agentId)
            .and_then(|agent| {
                agent
                    .channels
                    .iter()
                    .find(|channel| channel.id == channelId)
                    .map(|channel| (agent, channel))
            });
        if let Some((agent, channel)) = disk_channel {
            Ok(configured_channel_status_from_disk(agent, channel).await)
        } else {
            Ok(None)
        }
    }
}

/// Get status for a single agent (all channels).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_agent_status(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
) -> Result<AgentStatus, String> {
    let agent_configs = read_agent_configs_from_disk();
    let disk_agent = agent_configs.iter().find(|agent| agent.id == agentId);

    // Clone refs inside lock, then drop lock before any .await work
    let snapshot = {
        let agents_guard = agentState.lock().await;
        agents_guard.get(&agentId).map(|agent| {
            let ch_refs: Vec<ChannelStatusRef> = agent
                .channels
                .iter()
                .map(|(ch_id, ch_inst)| ChannelStatusRef {
                    channel_id: ch_id.clone(),
                    channel_type: ch_inst.bot_instance.config.platform.clone(),
                    name: ch_inst.bot_instance.config.name.clone(),
                    health: Arc::clone(&ch_inst.bot_instance.health),
                    router: Arc::clone(&ch_inst.bot_instance.router),
                    started_at: ch_inst.bot_instance.started_at,
                    bind_code: ch_inst.bot_instance.bind_code.clone(),
                })
                .collect();
            (
                agent.agent_id.clone(),
                agent.config.name.clone(),
                agent.config.enabled,
                ch_refs,
            )
        })
    }; // agents_guard dropped here

    if let Some((aid, aname, enabled, ch_refs)) = snapshot {
        let channels = collect_channel_statuses(ch_refs).await;
        let channels = if let Some(agent_cfg) = disk_agent {
            merge_configured_channel_statuses(agent_cfg, channels).await
        } else {
            channels
        };
        Ok(AgentStatus {
            agent_id: disk_agent.map(|a| a.id.clone()).unwrap_or(aid),
            agent_name: disk_agent.map(|a| a.name.clone()).unwrap_or(aname),
            enabled: disk_agent.map(|a| a.enabled).unwrap_or(enabled),
            channels,
        })
    } else if let Some(agent_cfg) = disk_agent {
        Ok(AgentStatus {
            agent_id: agent_cfg.id.clone(),
            agent_name: agent_cfg.name.clone(),
            enabled: agent_cfg.enabled,
            channels: merge_configured_channel_statuses(agent_cfg, Vec::new()).await,
        })
    } else {
        Ok(AgentStatus {
            agent_id: agentId,
            agent_name: String::new(),
            enabled: false,
            channels: Vec::new(),
        })
    }
}

/// Get status for all agents.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_all_agents_status(
    agentState: tauri::State<'_, ManagedAgents>,
) -> Result<HashMap<String, AgentStatus>, String> {
    let agent_configs = read_agent_configs_from_disk();
    let agent_config_by_id: HashMap<&str, &AgentConfigRust> = agent_configs
        .iter()
        .map(|agent| (agent.id.as_str(), agent))
        .collect();

    // Clone refs inside lock, then drop lock before any .await work
    let snapshots: Vec<_> = {
        let agents_guard = agentState.lock().await;
        agents_guard
            .iter()
            .map(|(agent_id, agent)| {
                let ch_refs: Vec<ChannelStatusRef> = agent
                    .channels
                    .iter()
                    .map(|(ch_id, ch_inst)| ChannelStatusRef {
                        channel_id: ch_id.clone(),
                        channel_type: ch_inst.bot_instance.config.platform.clone(),
                        name: ch_inst.bot_instance.config.name.clone(),
                        health: Arc::clone(&ch_inst.bot_instance.health),
                        router: Arc::clone(&ch_inst.bot_instance.router),
                        started_at: ch_inst.bot_instance.started_at,
                        bind_code: ch_inst.bot_instance.bind_code.clone(),
                    })
                    .collect();
                (
                    agent_id.clone(),
                    agent.agent_id.clone(),
                    agent.config.name.clone(),
                    agent.config.enabled,
                    ch_refs,
                )
            })
            .collect()
    }; // agents_guard dropped here

    let mut result = HashMap::new();
    for (key, aid, aname, enabled, ch_refs) in snapshots {
        let channels = collect_channel_statuses(ch_refs).await;
        let disk_agent = agent_config_by_id.get(aid.as_str()).copied();
        let channels = if let Some(agent_cfg) = disk_agent {
            merge_configured_channel_statuses(agent_cfg, channels).await
        } else {
            channels
        };
        result.insert(
            key,
            AgentStatus {
                agent_id: disk_agent.map(|a| a.id.clone()).unwrap_or(aid),
                agent_name: disk_agent.map(|a| a.name.clone()).unwrap_or(aname),
                enabled: disk_agent.map(|a| a.enabled).unwrap_or(enabled),
                channels,
            },
        );
    }
    for agent_cfg in &agent_configs {
        if result.contains_key(&agent_cfg.id) {
            continue;
        }
        let channels = merge_configured_channel_statuses(agent_cfg, Vec::new()).await;
        if channels.is_empty() {
            continue;
        }
        result.insert(
            agent_cfg.id.clone(),
            AgentStatus {
                agent_id: agent_cfg.id.clone(),
                agent_name: agent_cfg.name.clone(),
                enabled: agent_cfg.enabled,
                channels,
            },
        );
    }
    Ok(result)
}

/// Update an agent's config (hot-reload where possible, persist to disk).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_agent_config(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    patch: AgentConfigPatch,
) -> Result<(), String> {
    reload_agent_config_from_disk(
        &app_handle,
        agentState.inner(),
        sidecarManager.inner(),
        agentId,
        patch,
    )
    .await
}

/// Re-read the authoritative Agent record from disk and project the selected
/// fields into running Agent/IM instances. Shared by the Tauri command and the
/// loopback Management API used by `myagents agent set`.
pub(crate) async fn reload_agent_config_from_disk<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_state: &ManagedAgents,
    sidecar_manager: &ManagedSidecarManager,
    agent_id: String,
    patch: AgentConfigPatch,
) -> Result<(), String> {
    let updates_channel_runtime = patch.runtime.is_some()
        || patch.runtime_preference.is_some()
        || patch.runtime_config.is_some()
        || patch.provider_id.is_some()
        || patch.model.is_some()
        || patch.provider_env_json.is_some()
        || patch.permission_mode.is_some()
        || patch.mcp_servers_json.is_some()
        || patch.channels.is_some();
    let mut channel_ids = if updates_channel_runtime {
        read_agent_configs_from_disk()
            .into_iter()
            .find(|agent| agent.id == agent_id)
            .map(|agent| {
                agent
                    .channels
                    .into_iter()
                    .map(|channel| channel.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if updates_channel_runtime {
        let agents = agent_state.lock().await;
        if let Some(agent) = agents.get(&agent_id) {
            channel_ids.extend(agent.channels.keys().cloned());
        }
    }
    channel_ids.sort();
    channel_ids.dedup();
    let lifecycle_locks = channel_ids
        .iter()
        .map(|channel_id| agent_channel_lifecycle_lock(&agent_id, channel_id))
        .collect::<Vec<_>>();
    let mut _lifecycle_guards = Vec::with_capacity(lifecycle_locks.len());
    for lock in &lifecycle_locks {
        _lifecycle_guards.push(lock.lock().await);
    }

    // Freeze only live legacy peers using their Session owner before replacing templates.
    // Capture references under ManagedAgents, then do HTTP/per-peer work outside it.
    let live_channels = {
        let agents = agent_state.lock().await;
        agents
            .get(&agent_id)
            .map(|agent| {
                agent
                    .channels
                    .values()
                    .map(|channel| {
                        (
                            channel.bot_instance.router.clone(),
                            channel.bot_instance.peer_locks.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    // This read is only an optimization: a failed projection read still lets the
    // actual Session owner decide whether a live legacy snapshot needs freezing.
    let owned_sessions = if live_channels.is_empty() {
        std::collections::HashSet::new()
    } else {
        crate::session_metadata::cmd_list_session_metadata(None)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|session| session["configSnapshotAt"].is_string())
            .filter_map(|session| session["id"].as_str().map(str::to_string))
            .collect::<std::collections::HashSet<_>>()
    };
    let compatibility_client = crate::local_http::json_client(Duration::from_secs(5));
    for (router, locks) in live_channels {
        let peers = router
            .lock()
            .await
            .peer_sessions_iter()
            .cloned()
            .collect::<Vec<_>>();
        for peer in peers {
            if !peer.metadata_indexed || owned_sessions.contains(&peer.session_id) {
                continue;
            }
            let lock = {
                let mut locks = locks.lock().await;
                locks
                    .entry(peer.session_key.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(())))
                    .clone()
            };
            let _guard = lock.lock().await;
            let port = sidecar_manager
                .lock()
                .map_err(|error| error.to_string())?
                .get_session_port(&peer.session_id);
            if let Some(port) = port {
                match compatibility_client
                    .post(format!(
                        "http://127.0.0.1:{port}/api/session/freeze-current"
                    ))
                    .json(&json!({ "metadataIndexed":true, "metadataBirthPending":false }))
                    .send()
                    .await
                {
                    Ok(response) if response.status().is_success() => {}
                    _ => ulog_warn!(
                        "[im] Legacy peer snapshot could not be confirmed during template refresh"
                    ),
                }
            }
        }
    }
    let mut notifications = Vec::new();

    // Hot-reload running instance if present (runtime only — disk persistence
    // is handled by the TypeScript patchAgentConfig service)
    let mut agents_guard = agent_state.lock().await;
    if let Some(agent) = agents_guard.get_mut(&agent_id) {
        // Disk is the config authority. Renderer writes are serialized, while
        // invokes may arrive out of order. Serialize hot-state updates first,
        // then read disk: a newer write's invoke must run after this lock and
        // will re-read that newer Agent + ChannelOverrides, so stale invokes
        // cannot become the final in-memory state.
        let updated_agent = read_agent_configs_from_disk()
            .into_iter()
            .find(|candidate| candidate.id == agent_id)
            .ok_or_else(|| format!("Agent {} not found in persisted config", agent_id))?;
        let runtime_identity_patch_present = patch.runtime.is_some()
            || patch.runtime_preference.is_some()
            || patch.runtime_config.is_some()
            || patch.provider_id.is_some()
            || patch.model.is_some()
            || patch.channels.is_some();
        let should_refresh_channel_permission = patch.permission_mode.is_some()
            || patch.provider_id.is_some()
            || patch.model.is_some()
            || patch.runtime.is_some()
            || patch.runtime_preference.is_some()
            || patch.runtime_config.is_some()
            || patch.channels.is_some();
        let should_refresh_effective_channel = runtime_identity_patch_present
            || patch.provider_env_json.is_some()
            || patch.permission_mode.is_some();

        // A raw Agent default is provider-facing configuration, not an
        // execution identity. Derive both sides at the Channel owner: old from
        // its live hot state, new from the full config that was just persisted.
        let mut channel_updates = Vec::new();
        if should_refresh_effective_channel {
            for (channel_id, channel_instance) in &agent.channels {
                let Some(channel_config) = updated_agent
                    .channels
                    .iter()
                    .find(|channel| channel.id == *channel_id)
                else {
                    ulog_warn!(
                        "[agent] Running channel {} missing from updated config for agent {}; keeping its live runtime",
                        channel_id,
                        agent_id
                    );
                    continue;
                };
                let next_config = channel_config.to_im_config(&updated_agent);
                let old_runtime = channel_instance.bot_instance.runtime.read().await.clone();
                let old_runtime_config = channel_instance
                    .bot_instance
                    .runtime_config
                    .read()
                    .await
                    .clone();
                let old_identity = types::ImRuntimeIdentity::from_runtime_config(
                    &old_runtime,
                    old_runtime_config.as_ref(),
                );
                let new_identity = next_config.runtime_identity();
                let old_provider_id =
                    agent
                        .config
                        .channels
                        .iter()
                        .find(|channel| channel.id == *channel_id)
                        .map(|channel| channel.to_im_config(&agent.config).provider_id)
                        .unwrap_or_else(|| {
                            agent.config.provider_id.clone().or_else(|| {
                                channel_instance.bot_instance.config.provider_id.clone()
                            })
                        });
                let old_model = channel_instance
                    .bot_instance
                    .current_model
                    .read()
                    .await
                    .clone();
                // Native CLI selection ignores dormant Product Provider/model fields.
                let old_product = old_identity.runtime == "builtin"
                    || old_identity.runtime == "dsh"
                    || old_identity.runtime_source.as_deref() == Some("managed-provider");
                let next_product = new_identity.runtime == "builtin"
                    || new_identity.runtime == "dsh"
                    || new_identity.runtime_source.as_deref() == Some("managed-provider");
                let old_model = if is_external_runtime_type(&old_identity.runtime) {
                    old_runtime_config
                        .as_ref()
                        .and_then(|value| value.get("model"))
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                } else {
                    old_model
                };
                let next_model = if is_external_runtime_type(&new_identity.runtime) {
                    next_config
                        .runtime_config
                        .as_ref()
                        .and_then(|value| value.get("model"))
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                } else {
                    next_config.model.clone()
                };
                let old_choice = (
                    old_identity.clone(),
                    if old_product { old_provider_id } else { None },
                    old_model,
                );
                let next_choice = (
                    new_identity.clone(),
                    if next_product {
                        next_config.provider_id.clone()
                    } else {
                        None
                    },
                    next_model,
                );
                if old_choice != next_choice {
                    notifications.push((
                        channel_instance.bot_instance.adapter.clone(),
                        channel_instance.bot_instance.router.clone(),
                    ));
                }
                channel_updates.push((channel_id.clone(), next_config, old_identity, new_identity));
            }
        }

        if patch.provider_id.is_some() {
            agent.config.provider_id = updated_agent.provider_id.clone();
        }
        if patch.model.is_some() {
            agent.config.model = updated_agent.model.clone();
            *agent.current_model.write().await = updated_agent.model.clone();
        }
        if patch.provider_env_json.is_some() {
            agent.config.provider_env_json = updated_agent.provider_env_json.clone();
            *agent.current_provider_env.write().await = updated_agent
                .provider_env_json
                .as_deref()
                .filter(|value| !value.is_empty())
                .and_then(|value| serde_json::from_str(value).ok());
        }
        if should_refresh_channel_permission {
            let (_, projected_runtime_config) = types::project_runtime_for_provider(
                updated_agent.provider_id.as_deref(),
                updated_agent.model.as_deref(),
                updated_agent.runtime.clone(),
                updated_agent.runtime_config.clone(),
            );
            let permission_provider_id = if projected_runtime_config
                .as_ref()
                .and_then(|value| value.get("source"))
                .and_then(|value| value.as_str())
                == Some("managed-provider")
            {
                updated_agent.provider_id.as_deref()
            } else {
                None
            };
            let agent_permission = types::project_permission_for_provider(
                permission_provider_id,
                updated_agent.permission_mode.clone(),
            );
            agent.config.permission_mode = updated_agent.permission_mode.clone();
            *agent.permission_mode.write().await = agent_permission;
        }
        if let Some(ref mcp) = patch.mcp_servers_json {
            *agent.mcp_servers_json.write().await = Some(mcp.clone());
            for (_ch_id, ch_inst) in &agent.channels {
                *ch_inst.bot_instance.mcp_servers_json.write().await = Some(mcp.clone());
            }
        }
        if runtime_identity_patch_present {
            agent.config.runtime = updated_agent.runtime.clone();
            agent.config.runtime_config = updated_agent.runtime_config.clone();
            *agent.runtime_config.write().await = updated_agent.runtime_config.clone();
        }
        for (channel_id, next_config, _old_identity, new_identity) in channel_updates {
            let Some(channel_instance) = agent.channels.get(&channel_id) else {
                continue;
            };
            *channel_instance.bot_instance.current_model.write().await = next_config.model.clone();
            *channel_instance
                .bot_instance
                .current_provider_env
                .write()
                .await = next_config
                .provider_env_json
                .as_deref()
                .filter(|value| !value.is_empty())
                .and_then(|value| serde_json::from_str(value).ok());
            *channel_instance.bot_instance.permission_mode.write().await =
                next_config.permission_mode.clone();
            *channel_instance.bot_instance.runtime.write().await = new_identity.runtime.clone();
            *channel_instance.bot_instance.runtime_config.write().await =
                next_config.runtime_config.clone();
        }
        if patch.enabled.is_some() {
            agent.config.enabled = updated_agent.enabled;
        }
        // Hot-reload the effective heartbeat gate whenever either the master
        // or child config changes. Disk remains authoritative for both fields.
        if patch.heartbeat_config_json.is_some() || patch.enabled.is_some() {
            agent.config.heartbeat = updated_agent.heartbeat.clone();
            if let Some(ref hb_arc) = agent.heartbeat_config {
                *hb_arc.write().await = updated_agent.effective_heartbeat();
            }
            // Wake the heartbeat runner so it adopts the new gate/interval now.
            if let Some(ref tx) = agent.heartbeat_wake_tx {
                let _ = tx.try_send(types::WakeReason::Interval);
            }
        }
        // Hot-reload memory auto-update config (v0.1.43)
        if let Some(ref mau_json) = patch.memory_auto_update_config_json {
            agent.config.memory_auto_update = if mau_json.is_empty() || mau_json == "null" {
                None
            } else {
                serde_json::from_str(mau_json).ok()
            };
        }
        // Hot-reload long-term memory evolution config (v0.2.49)
        if let Some(ref evo_json) = patch.memory_evolution_config_json {
            agent.config.memory_evolution = if evo_json.is_empty() || evo_json == "null" {
                None
            } else {
                serde_json::from_str(evo_json).ok()
            };
            if let Some(ref evo_arc) = agent.memory_evolution_config {
                *evo_arc.write().await = agent.config.memory_evolution.clone();
            }
        }

        // Hot-reload per-channel group settings when a channel patch is signaled.
        // Disk is authoritative: renderer invokes can arrive out of order, so
        // never project the invoke payload into live state.
        if patch.channels.is_some() {
            agent.config.channels = updated_agent.channels.clone();
            for ch_config in &updated_agent.channels {
                if let Some(ch_inst) = agent.channels.get(&ch_config.id) {
                    // groupActivation
                    if let Some(ref act) = ch_config.group_activation {
                        let activation = match act.as_str() {
                            "always" => GroupActivation::Always,
                            _ => GroupActivation::Mention,
                        };
                        *ch_inst.bot_instance.group_activation.write().await = activation;
                    }
                    // groupPermissions — always overwrite (the full channels array is sent,
                    // so empty Vec means "no permissions", not "field absent")
                    *ch_inst.bot_instance.group_permissions.write().await =
                        ch_config.group_permissions.clone();
                    *ch_inst.bot_instance.group_tools_deny.write().await = ch_config
                        .overrides
                        .as_ref()
                        .and_then(|overrides| overrides.tools_deny.clone())
                        .unwrap_or_default();
                }
            }
        }
    }
    drop(agents_guard);
    drop(_lifecycle_guards);
    // Platform delivery owns no lifecycle, peer, Router or ManagedAgents lock.
    for (adapter, router) in notifications {
        let peers = super::model_commands::private_notice_peers(
            router.lock().await.peer_sessions_iter().cloned(),
        );
        let manager = sidecar_manager.clone();
        let notice_agent_id = agent_id.clone();
        // One best-effort delivery task per changed Channel. Platform latency
        // must not delay an already committed /model or desktop config update.
        tauri::async_runtime::spawn(async move {
            let client = crate::local_http::json_client(Duration::from_secs(5));
            for peer in peers {
                if let Err(error) = super::model_commands::notify_default_change(
                    &client,
                    &manager,
                    &notice_agent_id,
                    &peer,
                    adapter.as_ref(),
                )
                .await
                {
                    ulog_warn!("[im] Default-change notice delivery failed: {}", error);
                }
            }
        });
    }

    if patch.enabled.is_some()
        || patch.memory_auto_update_config_json.is_some()
        || patch.memory_evolution_config_json.is_some()
    {
        let updated_agent = read_agent_configs_from_disk()
            .into_iter()
            .find(|candidate| candidate.id == agent_id)
            .ok_or_else(|| format!("Agent {} not found in persisted config", agent_id))?;
        let archived = is_agent_workspace_archived(&updated_agent);

        if patch.enabled.is_some() || patch.memory_auto_update_config_json.is_some() {
            let mut memory_auto_update = updated_agent.memory_auto_update.clone();
            if let Some(config) = memory_auto_update.as_mut() {
                config.enabled = updated_agent.enabled && config.enabled && !archived;
            }
            crate::memory_auto_update::configure_memory_auto_update_task(
                crate::memory_auto_update::ConfigureMemoryAutoUpdateTaskRequest {
                    agent_id: updated_agent.id.clone(),
                    workspace_path: updated_agent.resolved_workspace_path.clone(),
                    memory_auto_update,
                    heartbeat: updated_agent.heartbeat.clone(),
                },
            )
            .await?;
        }

        if patch.enabled.is_some() || patch.memory_evolution_config_json.is_some() {
            let evolution_enabled = updated_agent.enabled
                && updated_agent
                    .memory_evolution
                    .as_ref()
                    .is_some_and(|config| config.enabled)
                && !archived;
            let workspace_id = config_store::project_id_for_agent(&updated_agent.id)
                .unwrap_or_else(|| updated_agent.id.clone());
            crate::memory_evolution::configure_memory_evolution_tasks(
                crate::memory_evolution::ConfigureMemoryEvolutionTasksRequest {
                    agent_id: updated_agent.id.clone(),
                    workspace_id,
                    workspace_path: updated_agent.resolved_workspace_path.clone(),
                    runtime: updated_agent.runtime.clone(),
                    runtime_config: updated_agent.runtime_config.clone(),
                    mcp_enabled_servers: updated_agent.mcp_enabled_servers.clone(),
                    memory_auto_update: updated_agent.memory_auto_update.clone(),
                    heartbeat: updated_agent.heartbeat.clone(),
                    enabled: evolution_enabled,
                },
            )
            .await?;
        }
    }

    let _ = app_handle.emit("agent:config-changed", json!({}));
    Ok(())
}
