//! Private IM model choices are addressed to one Product Session, never a Channel template.
use super::adapter::ImAdapter;
use super::*;
use tauri::Manager;

#[derive(Clone)]
pub(super) struct ModelMenu {
    pub session_id: Option<String>,
    pub snapshot_at: Option<String>,
    pub observation: Option<String>,
    pub options: Vec<serde_json::Value>,
}

pub(super) fn management_command(text: &str) -> Option<&str> {
    let name = text.split_whitespace().next()?.split('@').next()?;
    match name {
        "/new" | "/model" | "/provider" | "/mode" | "/status" | "/help" | "/start" => Some(name),
        _ => None,
    }
}

pub(super) fn global_port(manager: &ManagedSidecarManager) -> Result<u16, String> {
    manager
        .lock()
        .map_err(|_| "Sidecar manager unavailable".to_string())?
        .global_process_binding()
        .map(|(port, _)| port)
        .ok_or_else(|| "Global Sidecar 暂未就绪，请稍后重试".to_string())
}

async fn call(
    client: &Client,
    port: u16,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let response = match body {
        Some(body) => client.post(url).json(body).send().await,
        None => client.get(url).send().await,
    }
    .map_err(|_| "请求未确认，请重新查看当前会话状态".to_string())?;
    let status = response.status();
    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "响应未确认，请重新查看当前会话状态".to_string())?;
    // A saved Session with a failed runtime apply is a committed partial result:
    // callers still settle what was saved (e.g. the Team AI peer profile).
    if !status.is_success()
        && result.get("requiresNewSession") != Some(&json!(true))
        && result.get("sessionConfig") != Some(&json!("saved"))
    {
        return Err(result
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("模型操作失败")
            .to_string());
    }
    Ok(result)
}

pub(super) async fn create_birth(
    client: &Client,
    manager: &ManagedSidecarManager,
    birth: &serde_json::Value,
) -> Result<String, String> {
    birth_session_id(&create_birth_value(client, manager, birth).await?)
}

/// Full `POST /sessions` response, for callers that need birth outcomes beyond the id.
pub(super) async fn create_birth_value(
    client: &Client,
    manager: &ManagedSidecarManager,
    birth: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    call(client, global_port(manager)?, "/sessions", Some(birth)).await
}

pub(super) fn birth_session_id(value: &serde_json::Value) -> Result<String, String> {
    value["session"]["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "新会话创建结果未确认，请查看当前状态".to_string())
}

pub(super) async fn read_menu(
    client: &Client,
    manager: &ManagedSidecarManager,
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<(ModelMenu, String), String> {
    let active_port = session_id.and_then(|id| manager.lock().ok()?.get_session_port(id));
    let port = match active_port {
        Some(port) => port,
        None => global_port(manager)?,
    };
    let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}/api/im/model-options"))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("agentId", agent_id);
    if let Some(session_id) = session_id {
        url.query_pairs_mut().append_pair("sessionId", session_id);
    }
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法读取模型列表".to_string())?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "模型列表无效".to_string())?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("无法读取模型列表")
            .to_string());
    }
    let menu = ModelMenu {
        session_id: value["sessionId"].as_str().map(str::to_string),
        snapshot_at: value["configSnapshotAt"].as_str().map(str::to_string),
        observation: value["snapshotObservation"].as_str().map(str::to_string),
        options: value["options"].as_array().cloned().unwrap_or_default(),
    };
    let mut text = format!(
        "当前会话模型：{}\n",
        value["currentModel"].as_str().unwrap_or("默认")
    );
    let mut previous_group = String::new();
    for (index, option) in menu.options.iter().enumerate() {
        let group = option["group"].as_str().unwrap_or("模型");
        if group != previous_group {
            text.push_str(&format!("\n{group}\n"));
            previous_group = group.to_string();
        }
        let suffix = if option["requiresNewSession"].as_bool().unwrap_or(false) {
            "（会启用新会话）"
        } else {
            ""
        };
        text.push_str(&format!(
            "{}. {}{}{}\n",
            index + 1,
            option["name"].as_str().unwrap_or("模型"),
            suffix,
            if option["isCurrent"].as_bool().unwrap_or(false) {
                " ✓ 当前"
            } else {
                ""
            }
        ));
    }
    text.push_str(if super::config_store::agent_is_team_ai(agent_id) {
        "\n发送 /model 序号 切换模型，之后这个私聊的新会话也会使用它。\n发送 /new 开始新会话。"
    } else {
        "\n发送 /model 序号 切换模型，同时更新 Agent 默认模型。\n发送 /new 使用最新默认设置开始新会话。"
    });
    Ok((menu, text))
}

pub(super) fn resolve_menu_option(
    menu: &ModelMenu,
    arg: &str,
) -> Result<serde_json::Value, String> {
    if let Ok(index) = arg.parse::<usize>() {
        return index
            .checked_sub(1)
            .and_then(|index| menu.options.get(index))
            .cloned()
            .ok_or_else(|| "无效序号，请发送 /model 查看列表".to_string());
    }
    let matches = menu
        .options
        .iter()
        .filter(|option| option["selection"]["model"].as_str() == Some(arg))
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        Ok(matches[0].clone())
    } else {
        Err("模型 ID 不唯一或不可用，请使用 /model 查看列表后按序号选择".to_string())
    }
}

pub(super) struct SelectionContext<'a, R: Runtime> {
    pub app: &'a AppHandle<R>,
    pub manager: &'a ManagedSidecarManager,
    pub router: &'a Arc<Mutex<SessionRouter>>,
    pub health: &'a Arc<HealthManager>,
    pub peer_locks: &'a PeerLocks,
    pub session_key: &'a str,
    pub agent_id: &'a str,
    pub channel_id: &'a str,
    pub workspace: &'a str,
}

pub(super) async fn select_model<R: Runtime>(
    context: SelectionContext<'_, R>,
    menu: &ModelMenu,
    option: &serde_json::Value,
) -> Result<String, String> {
    let lock = {
        let mut locks = context.peer_locks.lock().await;
        locks
            .entry(context.session_key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let mut fence = lock.lock_owned().await;
    // Team AI peers own their choice: Session + peer profile, never the Agent default.
    let team_ai = super::config_store::agent_is_team_ai(context.agent_id);
    let selection_path = if team_ai {
        "/api/im/session-model-selection"
    } else {
        "/api/im/model-selection"
    };
    let (client, prior) = {
        let router = context.router.lock().await;
        (
            router.http_client().clone(),
            router.peer_session_snapshot(context.session_key),
        )
    };
    let current_id = prior
        .as_ref()
        .filter(|peer| peer.metadata_indexed)
        .map(|peer| peer.session_id.as_str());
    if current_id != menu.session_id.as_deref() {
        return Err("会话已变化，请重新发送 /model".to_string());
    }
    let mut transferred = false;
    let mut final_session = current_id.map(str::to_string);
    let result = if let Some(session_id) = current_id {
        let port = ensure_sidecar_port_for_command(
            context.router,
            context.session_key,
            "builtin",
            None,
            context.app,
            context.manager,
            context.health,
        )
        .await?;
        call(&client, port, selection_path, Some(&json!({ "agentId": context.agent_id, "sessionId": session_id, "configSnapshotAt": menu.snapshot_at, "snapshotObservation": menu.observation, "selection": option["selection"], "allowNewSession": option["requiresNewSession"].as_bool().unwrap_or(false) }))).await?
    } else {
        let plan = call(
            &client,
            global_port(context.manager)?,
            "/api/im/model-options",
            Some(&json!({ "agentId": context.agent_id, "selection": option["selection"] })),
        )
        .await?;
        json!({ "requiresNewSession": true, "birth": plan["birth"] })
    };
    let result = if result["requiresNewSession"].as_bool().unwrap_or(false) {
        let target_id = create_birth(&client, context.manager, &result["birth"]).await?;
        let expected_source = if let Some(prior) = prior {
            prior.session_id
        } else {
            let mut router = context.router.lock().await;
            let transition = router.stage_new_session_binding(context.session_key);
            transition.target_session_id().to_string()
        };
        let (handover, returned_fence, _, _) = handover::handover_session_to_channel(
            context.app.clone(),
            target_id.clone(),
            context.agent_id.to_string(),
            context.channel_id.to_string(),
            context.workspace.to_string(),
            Some(context.session_key.to_string()),
            Some((context.session_key.to_string(), fence)),
            Some(expected_source),
        )
        .await?;
        fence = returned_fence;
        if !handover.state_persisted {
            return Err("当前会话已接管，但绑定保存失败，请查看当前状态".to_string());
        }
        transferred = true;
        let (target_menu, _) =
            read_menu(&client, context.manager, context.agent_id, Some(&target_id)).await?;
        let port = context
            .router
            .lock()
            .await
            .get_peer_session(context.session_key)
            .map(|peer| peer.sidecar_port)
            .ok_or_else(|| "绑定结果未确认".to_string())?;
        let selected = call(&client, port, selection_path, Some(&json!({ "agentId": context.agent_id, "sessionId": target_id, "configSnapshotAt": target_menu.snapshot_at, "snapshotObservation": target_menu.observation, "selection": option["selection"] }))).await?;
        final_session = Some(target_id);
        selected
    } else {
        result
    };
    let profile_saved = match (team_ai, final_session.as_deref()) {
        (true, Some(session_id)) if result["sessionConfig"] == "saved" => Some(
            super::team_ai::sync_peer_profile(
                context.manager,
                context.agent_id,
                context.channel_id,
                context.session_key,
                session_id,
            )
            .await
            .map_err(|error| ulog_warn!("[im] /model peer profile not saved: {}", error))
            .is_ok(),
        ),
        _ => None,
    };
    drop(fence);
    if let Some(patch) = result.get("reloadPatch").filter(|value| value.is_object()) {
        let patch: AgentConfigPatch = serde_json::from_value(patch.clone())
            .map_err(|_| "默认已保存，但刷新参数无效".to_string())?;
        let state = context
            .app
            .try_state::<ManagedAgents>()
            .ok_or_else(|| "Agent state unavailable".to_string())?;
        reload_agent_config_from_disk(
            context.app,
            state.inner(),
            context.manager,
            context.agent_id.to_string(),
            patch,
        )
        .await?;
    }
    if result["success"].as_bool() != Some(true) {
        return Err(result["error"]
            .as_str()
            .unwrap_or("当前会话已修改，默认模型保存失败")
            .to_string());
    }
    let prefix = if transferred {
        "已创建并接管新会话"
    } else if result["runtimeApply"] == "pending-next-turn" {
        "模型将在下一轮生效"
    } else {
        "当前会话模型已更新"
    };
    let scope = match profile_saved {
        Some(true) => "之后这个私聊的新会话也会使用该模型。",
        Some(false) => "当前会话已修改，但这个私聊的专属设置保存失败。",
        None if team_ai => "",
        None => "Agent 默认模型已更新。",
    };
    Ok(format!(
        "{prefix}：{}\n{scope}",
        option["name"].as_str().unwrap_or("模型")
    )
    .trim_end()
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn management_commands_are_exact_and_include_private_welcome() {
        assert_eq!(management_command("/model 2"), Some("/model"));
        assert_eq!(management_command("/new@my_bot"), Some("/new"));
        assert_eq!(management_command("/modelXYZ"), None);
        assert_eq!(management_command("please /model 2"), None);
        assert_eq!(management_command("/start"), Some("/start"));
    }
    fn peer(id: &str, source: ImSourceType) -> types::PeerSession {
        types::PeerSession {
            session_key: format!("peer-{id}"),
            session_id: format!("session-{id}"),
            sidecar_port: 0,
            workspace_path: std::path::PathBuf::from("/workspace"),
            source_type: source,
            source_id: id.into(),
            source_display_name: None,
            last_sender_name: None,
            message_count: 1,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: std::time::Instant::now() - std::time::Duration::from_secs(86400 * 300),
        }
    }
    fn defaults() -> ImConfig {
        serde_json::from_value(
            json!({"botToken":"", "allowedUsers":[], "permissionMode":"fullAgency", "enabled":true,
            "runtime":"builtin", "providerId":"alpha", "model":"new"}),
        )
        .unwrap()
    }
    #[test]
    fn notifications_include_idle_private_peers_and_exclude_groups_and_unindexed_bindings() {
        let mut unindexed = peer("pending", ImSourceType::Private);
        unindexed.metadata_indexed = false;
        let peers = private_notice_peers(
            vec![
                peer("one", ImSourceType::Private),
                peer("two", ImSourceType::Private),
                peer("one", ImSourceType::Private),
                peer("group", ImSourceType::Group),
                unindexed,
            ]
            .into_iter(),
            &Default::default(),
        );
        assert_eq!(
            peers
                .iter()
                .map(|peer| peer.source_id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert!(peers.iter().all(|peer| peer.sidecar_port == 0));
    }

    #[test]
    fn notifications_skip_team_ai_peers_that_own_their_settings() {
        let profiled = peer("own", ImSourceType::Private);
        let skip = std::iter::once(profiled.session_key.clone()).collect();
        let peers = private_notice_peers(
            vec![profiled, peer("follows", ImSourceType::Private)].into_iter(),
            &skip,
        );
        assert_eq!(
            peers.iter().map(|peer| peer.source_id.as_str()).collect::<Vec<_>>(),
            vec!["follows"]
        );
    }
    #[test]
    fn notice_uses_current_session_model_and_skips_the_peer_already_on_the_default() {
        let snapshot = json!({"configSnapshotAt":"snapshot", "runtime":"builtin", "providerId":"alpha", "model":"old"});
        let text = default_change_notice(&snapshot, &defaults())
            .unwrap()
            .unwrap();
        assert!(text.contains("仍然是 old"));
        assert!(text.contains("/new"));
        assert!(text.contains("/model"));
        assert_eq!(
            default_change_notice(
                &json!({"configSnapshotAt":"snapshot", "runtime":"builtin", "providerId":"alpha", "model":"new"}),
                &defaults()
            ),
            Some(None)
        );
        assert_eq!(
            default_change_notice(&json!({"model":"unknown"}), &defaults()),
            None
        );
    }
    #[test]
    fn native_cli_notice_comparison_ignores_dormant_provider_defaults() {
        let mut defaults = defaults();
        defaults.runtime = Some("codex".into());
        defaults.provider_id = Some("codex-sub".into());
        defaults.runtime_config = Some(json!({"source":"system-cli", "model":"native"}));
        assert_eq!(
            default_change_notice(
                &json!({"configSnapshotAt":"snapshot", "runtime":"codex", "runtimeSource":"system-cli", "model":"native"}),
                &defaults
            ),
            Some(None)
        );
    }

    #[test]
    fn menu_numbers_are_stable_and_duplicate_ids_cannot_guess_provider() {
        let menu = ModelMenu {
            session_id: Some("s".into()),
            snapshot_at: None,
            observation: None,
            options: vec![
                json!({"selection":{"kind":"product-provider","providerId":"a","model":"same"}}),
                json!({"selection":{"kind":"product-provider","providerId":"b","model":"same"}}),
            ],
        };
        assert_eq!(
            resolve_menu_option(&menu, "2").unwrap()["selection"]["providerId"],
            "b"
        );
        assert!(resolve_menu_option(&menu, "same").is_err());
        assert!(resolve_menu_option(&menu, "0").is_err());
    }
    #[tokio::test]
    async fn status_reads_a_live_session_without_global_host_or_nested_manager_lock() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let received = socket.read(&mut request).await.unwrap();
            assert!(received > 0);
            let body = r#"{"session":{"configSnapshotAt":"owned","model":"session-model"}}"#;
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
        });
        let manager =
            std::sync::Arc::new(std::sync::Mutex::new(crate::sidecar::SidecarManager::new()));
        let peer = peer("status", ImSourceType::Private);
        manager.lock().unwrap().insert_test_ready_frontend_sidecar(
            &peer.session_id,
            port,
            crate::sidecar::SidecarOwner::Agent(peer.session_key.clone()),
        );
        let client = crate::local_http::json_client(Duration::from_secs(2));
        let text = read_status(&client, &manager, &peer).await.unwrap();
        assert!(text.contains("session-model"));
        server.await.unwrap();
    }
}

/// Caller holds the peer fence. Freeze a live legacy Session or publish a complete birth.
pub(super) async fn ensure_peer_snapshot(
    router: &Arc<Mutex<SessionRouter>>,
    health: &Arc<HealthManager>,
    manager: &ManagedSidecarManager,
    session_key: &str,
) -> Result<(), String> {
    let (client, prior, workspace, owner) = {
        let router = router.lock().await;
        (
            router.http_client().clone(),
            router.peer_session_snapshot(session_key),
            router
                .peer_session_workspace(session_key)
                .unwrap_or_else(|| router.default_workspace_path()),
            router
                .channel_owner()
                .map(|(agent, channel)| (agent.to_string(), channel.to_string())),
        )
    };
    if let Some(peer) = prior.as_ref() {
        let response = client
            .get(format!(
                "http://127.0.0.1:{}/sessions/{}",
                global_port(manager)?,
                peer.session_id
            ))
            .send()
            .await
            .map_err(|_| "无法读取会话快照".to_string())?;
        if response.status().is_success() {
            let value: serde_json::Value = response
                .json()
                .await
                .map_err(|_| "会话快照无效".to_string())?;
            if value["session"]["configSnapshotAt"].is_string() {
                mark_owned_peer(router, health, session_key, &peer.session_id).await?;
                return Ok(());
            }
            let port = manager
                .lock()
                .map_err(|e| e.to_string())?
                .get_session_port(&peer.session_id)
                .ok_or_else(|| {
                    "旧会话的执行配置无法可靠恢复，请发送 /new 开始新会话。历史记录会保留。"
                        .to_string()
                })?;
            call(&client, port, "/api/session/freeze-current", Some(&json!({"metadataBirthPending":peer.metadata_birth_pending,"metadataIndexed":peer.metadata_indexed}))).await?;
            mark_owned_peer(router, health, session_key, &peer.session_id).await?;
            return Ok(());
        }
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            return Err("无法确认旧会话状态，请稍后重试".to_string());
        }
    }
    let target = super::team_ai::birth_for_peer(
        &client,
        manager,
        &workspace.to_string_lossy(),
        owner.as_ref().map(|(a, c)| (a.as_str(), c.as_str())),
        session_key,
    )
    .await?;
    let _projection = health.lock_active_sessions_projection().await;
    let mut router = router.lock().await;
    if router
        .peer_session_snapshot(session_key)
        .as_ref()
        .map(|p| p.session_id.as_str())
        != prior.as_ref().map(|p| p.session_id.as_str())
    {
        return Err("会话绑定已变化".to_string());
    }
    let transition = router.stage_materialized_session_binding(session_key, &target);
    if let Err(error) = health
        .persist_active_sessions_snapshot(router.active_sessions(), router.peer_history())
        .await
    {
        router.rollback_peer_binding_transition(&transition);
        return Err(format!("会话绑定保存失败：{error}"));
    }
    drop(router);
    drop(_projection);
    if let Some(peer) = prior {
        // An unmaterialized legacy binding cannot keep an invisible Sidecar owner.
        crate::sidecar::release_session_sidecar(
            manager,
            &peer.session_id,
            &crate::sidecar::SidecarOwner::Agent(session_key.to_string()),
        )
        .await?;
    }
    Ok(())
}

async fn mark_owned_peer(
    router: &Arc<Mutex<SessionRouter>>,
    health: &Arc<HealthManager>,
    session_key: &str,
    session_id: &str,
) -> Result<(), String> {
    let _projection = health.lock_active_sessions_projection().await;
    let mut router = router.lock().await;
    let prior = router
        .peer_session_snapshot(session_key)
        .ok_or("会话绑定已变化")?;
    if prior.session_id != session_id {
        return Err("会话绑定已变化".into());
    }
    if prior.metadata_indexed && !prior.metadata_birth_pending {
        return Ok(());
    }
    let mut owned = prior.clone();
    owned.metadata_indexed = true;
    owned.metadata_birth_pending = false;
    router.upsert_peer_session(owned);
    if let Err(error) = health
        .persist_active_sessions_snapshot(router.active_sessions(), router.peer_history())
        .await
    {
        router.upsert_peer_session(prior);
        return Err(format!("会话绑定保存失败：{error}"));
    }
    Ok(())
}

pub(super) async fn notify_default_change(
    client: &Client,
    manager: &ManagedSidecarManager,
    agent_id: &str,
    peer: &types::PeerSession,
    adapter: &AnyAdapter,
) -> Result<(), String> {
    // Only read Session metadata. Notifications must not query model catalogs or start runtimes.
    let active_port = manager
        .lock()
        .map_err(|e| e.to_string())?
        .get_session_port(&peer.session_id);
    let port = match active_port {
        Some(port) => port,
        None => global_port(manager)?,
    };
    let value = call(
        client,
        port,
        &format!("/sessions/{}?limit=1", peer.session_id),
        None,
    )
    .await?;
    let snapshot = &value["session"];
    if !snapshot["configSnapshotAt"].is_string() {
        return Err("历史会话尚未可靠固化，不能猜测其当前模型".to_string());
    }
    let config = super::read_agent_configs_from_disk()
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .ok_or_else(|| "Agent unavailable".to_string())?;
    let channel = config
        .channels
        .first()
        .ok_or_else(|| "Channel unavailable".to_string())?;
    let defaults = channel.to_im_config(&config);
    let text = default_change_notice(snapshot, &defaults).ok_or("历史会话尚未可靠固化")?;
    let Some(text) = text else {
        return Ok(());
    };
    adapter
        .send_message(&peer.source_id, &text)
        .await
        .map(|_| ())
        .map_err(|_| "默认模型提醒未送达".to_string())
}

/// No freshness/port filter: every established private binding is a notification target.
/// Team AI peers in `follows_own_profile` own their settings and are not notified of Agent default changes.
pub(super) fn private_notice_peers(
    peers: impl Iterator<Item = types::PeerSession>,
    follows_own_profile: &std::collections::HashSet<String>,
) -> Vec<types::PeerSession> {
    let mut targets = std::collections::HashSet::new();
    peers
        .filter(|peer| peer.source_type == ImSourceType::Private && peer.metadata_indexed)
        .filter(|peer| !follows_own_profile.contains(&peer.session_key))
        .filter(|peer| targets.insert(peer.source_id.clone()))
        .collect()
}

fn default_change_notice(
    snapshot: &serde_json::Value,
    defaults: &ImConfig,
) -> Option<Option<String>> {
    if !snapshot["configSnapshotAt"].is_string() {
        return None;
    }
    let identity = defaults.runtime_identity();
    let product_provider = identity.runtime == "builtin"
        || identity.runtime == "dsh"
        || identity.runtime_source.as_deref() == Some("managed-provider");
    let provider = if product_provider {
        defaults.provider_id.as_deref()
    } else {
        None
    };
    let model = if is_external_runtime_type(&identity.runtime) {
        defaults
            .runtime_config
            .as_ref()
            .and_then(|value| value.get("model"))
            .and_then(|value| value.as_str())
    } else {
        defaults.model.as_deref()
    };
    let same = snapshot["providerId"].as_str() == provider
        && snapshot["model"].as_str() == model
        && snapshot["runtime"].as_str().unwrap_or("builtin") == identity.runtime
        && snapshot["runtimeSource"].as_str().unwrap_or("builtin")
            == identity.runtime_source.as_deref().unwrap_or("builtin");
    if same {
        return Some(None);
    }
    let runtime = match (
        identity.runtime.as_str(),
        identity.runtime_source.as_deref(),
    ) {
        ("codex", Some("managed-provider")) => "Managed Codex",
        ("codex", _) => "Codex CLI",
        ("claude-code", _) => "Claude Code",
        ("dsh", _) => "DeepSeek Harness",
        _ => "MyAgents",
    };
    Some(Some(format!("当前 Agent 默认模型发生变化：{}（{}）。当前对话的模型仍然是 {}。\n如需变更，可发送 /new 创建新会话，或发送 /model 调整模型。", model.unwrap_or("默认模型"), runtime, snapshot["model"].as_str().unwrap_or("默认模型"))))
}

/// Help is a metadata read, without catalog discovery or Runtime wake-up.
pub(super) async fn model_help_line(
    client: &Client,
    manager: &ManagedSidecarManager,
    session_id: Option<&str>,
) -> &'static str {
    if let Some(id) = session_id {
        if let Ok(port) = global_port(manager) {
            if let Ok(value) = call(client, port, &format!("/sessions/{id}?limit=1"), None).await {
                let snapshot = &value["session"];
                if matches!(snapshot["runtime"].as_str(), Some("codex" | "claude-code" | "antigravity"))
                    && snapshot["runtimeSource"].as_str() != Some("managed-provider")
                {
                    return "查看当前 CLI 可用模型";
                }
            }
        }
    }
    "按供应商查看当前会话可用模型"
}

pub(super) async fn read_status(
    client: &Client,
    manager: &ManagedSidecarManager,
    peer: &types::PeerSession,
) -> Result<String, String> {
    let active_port = manager
        .lock()
        .map_err(|e| e.to_string())?
        .get_session_port(&peer.session_id);
    // Drop the manager guard before resolving a fallback through the same owner.
    let port = match active_port {
        Some(port) => port,
        None => global_port(manager)?,
    };
    let value = call(
        client,
        port,
        &format!("/sessions/{}?limit=1", peer.session_id),
        None,
    )
    .await?;
    let snapshot = &value["session"];
    if !snapshot["configSnapshotAt"].is_string() {
        return Ok(
            "历史会话的执行配置尚未可靠固化，请发送 /new 开始新会话。历史记录会保留。".into(),
        );
    }
    Ok(format!(
        "当前会话：{}\n当前模型：{}\n发送 /model 调整模型，或 /new 使用最新默认设置开始新会话。",
        peer.session_id.chars().take(8).collect::<String>(),
        snapshot["model"].as_str().unwrap_or("默认模型")
    ))
}
