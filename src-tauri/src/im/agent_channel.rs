use super::router::peer_binding_source_requires_freeze;
use super::*;
use crate::sidecar::{release_session_sidecar, SidecarOwner};

static CHANNEL_LIFECYCLE_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn short_session_id(value: &str) -> String {
    value.chars().take(8).collect()
}

/// One serialization boundary per durable channel identity. Weak entries keep
/// the registry from becoming another lifecycle owner.
fn lifecycle_lock(key: String) -> Arc<Mutex<()>> {
    let mut locks = CHANNEL_LIFECYCLE_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

pub(super) fn agent_channel_lifecycle_lock(agent_id: &str, channel_id: &str) -> Arc<Mutex<()>> {
    lifecycle_lock(format!("agent:{agent_id}:channel:{channel_id}"))
}

pub(super) fn legacy_bot_lifecycle_lock(bot_id: &str) -> Arc<Mutex<()>> {
    lifecycle_lock(format!("legacy:{bot_id}"))
}

fn agent_channel_ids_for_stop(
    durable_ids: impl IntoIterator<Item = String>,
    live_ids: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let mut channel_ids = durable_ids.into_iter().chain(live_ids).collect::<Vec<_>>();
    channel_ids.sort();
    channel_ids.dedup();
    channel_ids
}

async fn lock_agent_channels_for_stop(
    agent_id: &str,
    channel_ids: &[String],
) -> Vec<tokio::sync::OwnedMutexGuard<()>> {
    let locks = channel_ids
        .iter()
        .map(|channel_id| agent_channel_lifecycle_lock(agent_id, channel_id))
        .collect::<Vec<_>>();
    let mut guards = Vec::with_capacity(locks.len());
    for lock in locks {
        guards.push(lock.lock_owned().await);
    }
    guards
}

/// Execute IM `/new` as one owner-scoped binding transaction. The Router and
/// its health projection remain the only binding authorities; the transition
/// snapshot exists solely for exact in-memory/disk rollback on failure.
async fn rotate_peer_binding_for_new_command(
    session_key: &str,
    runtime: &str,
    router: &Arc<Mutex<SessionRouter>>,
    health: &Arc<HealthManager>,
    manager: &ManagedSidecarManager,
    target_session_id: &str,
    consumers: &ImConsumers,
) -> Result<String, String> {
    rotate_peer_binding_for_new_command_with_metadata_lookup(
        session_key,
        runtime,
        router,
        health,
        manager,
        |session_id| crate::sidecar::resolve_session_runtime_identity_full(session_id).is_some(),
        Some((target_session_id, consumers)),
    )
    .await
}

async fn rotate_peer_binding_for_new_command_with_metadata_lookup<F>(
    session_key: &str,
    runtime: &str,
    router: &Arc<Mutex<SessionRouter>>,
    health: &Arc<HealthManager>,
    manager: &ManagedSidecarManager,
    metadata_exists: F,
    prepared: Option<(&str, &ImConsumers)>,
) -> Result<String, String>
where
    F: FnOnce(&str) -> bool,
{
    // Match every other active-session projection lock order: projection ->
    // Router -> per-Session lifecycle. The caller already holds the per-peer
    // message lock, so no ordinary IM turn can race this mutation.
    let prior = router.lock().await.peer_session_snapshot(session_key);
    let metadata_disposition = router
        .lock()
        .await
        .classify_peer_session_metadata_for_binding_rotation_with_lookup(
            session_key,
            metadata_exists,
        );

    let _session_lifecycle = if let Some(peer) = prior.as_ref() {
        let guard = crate::sidecar::acquire_session_lifecycle(&[&peer.session_id]).await;
        if crate::sidecar::has_persisted_session_owner(&peer.session_id).await? {
            return Err(
                "Cannot start a new conversation while a persistent Goal or task owns this Session"
                    .to_string(),
            );
        }
        let admissible = manager
            .lock()
            .map_err(|error| error.to_string())?
            .agent_binding_rotation_is_admissible(&peer.session_id, session_key);
        if !admissible {
            return Err(format!(
                "Agent owner no longer controls Session {}",
                short_session_id(&peer.session_id)
            ));
        }
        if peer_binding_source_requires_freeze(metadata_disposition) {
            // This detached Router is only a transport helper; it never owns bindings.
            let transport = { router.lock().await.http_client().clone() };
            if peer.sidecar_port > 0 {
                let response = transport.post(format!("http://127.0.0.1:{}/api/session/freeze-current", peer.sidecar_port))
                    .json(&json!({"metadataBirthPending":peer.metadata_birth_pending,"metadataIndexed":peer.metadata_indexed}))
                    .send().await.map_err(|e| format!("Failed to freeze old Session: {e}"))?;
                if !response.status().is_success() {
                    return Err("Failed to freeze old Session".into());
                }
            } else {
                runtime_change::freeze_via_file_lock_status(&peer.session_id)
                    .await
                    .map_err(|error| format!("Failed to preserve old Session: {error}"))?;
            }
        } else {
            ulog_info!(
                "[im-router] Skipping freeze for unmaterialized source before /new: session_key={} session={} disposition={:?}",
                session_key,
                short_session_id(&peer.session_id),
                metadata_disposition,
            );
        }
        Some(guard)
    } else {
        None
    };

    drop(_session_lifecycle);
    let _projection = health.lock_active_sessions_projection().await;
    let mut router_guard = router.lock().await;
    if router_guard
        .peer_session_snapshot(session_key)
        .as_ref()
        .map(|p| p.session_id.as_str())
        != prior.as_ref().map(|p| p.session_id.as_str())
    {
        return Err("Conversation binding changed; retry /new".into());
    }
    let transition = match prepared {
        Some((id, _)) => router_guard.stage_materialized_session_binding(session_key, id),
        None => router_guard.stage_new_session_binding(session_key),
    };
    let new_session_id = transition.target_session_id().to_string();
    let old_session_id = transition.old_session_id().map(str::to_string);

    if let Err(error) = health
        .persist_active_sessions_snapshot(router_guard.active_sessions())
        .await
    {
        let rolled_back = router_guard.rollback_peer_binding_transition(&transition);
        ulog_error!(
            "[im-router] operation=im_binding_rotation stage=persist result=failed session_key={} old={} new={} rollback={} durable_state=unchanged error={}",
            session_key,
            old_session_id.as_deref().map(short_session_id).unwrap_or_else(|| "none".to_string()),
            short_session_id(&new_session_id),
            rolled_back,
            error
        );
        return Err(format!("Failed to save new conversation binding: {error}"));
    }

    drop(router_guard);
    drop(_projection);
    if let Some((_, consumers)) = prepared {
        enqueue::retire_im_consumer(consumers, manager, session_key).await;
    }
    if let Some(old_session_id) = old_session_id.as_deref() {
        let owner = SidecarOwner::Agent(session_key.to_string());
        if let Err(error) = release_session_sidecar(manager, old_session_id, &owner).await {
            // Binding is committed. A teardown failure must not rebind to an already-retired consumer.
            let rolled_back = false;
            let rollback_persisted = false;
            ulog_error!(
                "[im-router] operation=im_binding_rotation stage=owner-transfer result=failed session_key={} old={} new={} rollback={} rollback_persisted={} error={}",
                session_key,
                short_session_id(old_session_id),
                short_session_id(&new_session_id),
                rolled_back,
                rollback_persisted,
                error
            );
            return Err(format!("新会话绑定已保存，但旧会话资源释放失败：{error}"));
        }
    }

    ulog_info!(
        "[im-router] operation=im_binding_rotation result=committed session_key={} runtime={} old={} new={} materialization=pending",
        session_key,
        runtime,
        old_session_id.as_deref().map(short_session_id).unwrap_or_else(|| "none".to_string()),
        short_session_id(&new_session_id)
    );
    Ok(new_session_id)
}

/// Stop one exact Agent Channel runtime through its lifecycle owner.
///
/// The durable config writer must commit deletion/disablement first. Acquiring
/// the same lifecycle lock as start/restart after that commit prevents the
/// monitor from resurrecting a Channel from an older config snapshot.
pub(crate) async fn stop_agent_channel_runtime(
    app_handle: &AppHandle,
    agent_state: &ManagedAgents,
    sidecar_manager: &ManagedSidecarManager,
    agent_id: &str,
    channel_id: &str,
) -> Result<bool, String> {
    let lifecycle_lock = agent_channel_lifecycle_lock(agent_id, channel_id);
    let _lifecycle_guard = lifecycle_lock.lock().await;

    stop_agent_channel_with_lock_held(
        app_handle,
        agent_state,
        sidecar_manager,
        agent_id,
        channel_id,
    )
    .await
}

/// Caller holds the exact Channel lifecycle lock, including durable intent.
pub(super) async fn stop_agent_channel_with_lock_held(
    app_handle: &AppHandle,
    agent_state: &ManagedAgents,
    sidecar_manager: &ManagedSidecarManager,
    agent_id: &str,
    channel_id: &str,
) -> Result<bool, String> {
    let (bot_instance, heartbeat_handle) = {
        let mut agents_guard = agent_state.lock().await;
        if let Some(agent) = agents_guard.get_mut(agent_id) {
            let instance = agent
                .channels
                .remove(channel_id)
                .map(|channel| channel.bot_instance);
            let heartbeat = if agent.channels.is_empty() {
                agent.heartbeat_wake_tx = None;
                agent.heartbeat_config = None;
                agent.memory_evolution_config = None;
                agent.heartbeat_handle.take()
            } else {
                None
            };
            (instance, heartbeat)
        } else {
            (None, None)
        }
    };

    if let Some(handle) = heartbeat_handle {
        handle.abort();
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
    }

    let stopped = bot_instance.is_some();
    if let Some(instance) = bot_instance {
        shutdown_bot_instance(instance, sidecar_manager, channel_id).await?;
    } else {
        ulog_debug!(
            "[agent] Channel {} not found in agent {}",
            channel_id,
            agent_id
        );
    }

    let _ = app_handle.emit(
        "agent:status-changed",
        json!({ "agentId": agent_id, "event": "channel_stopped" }),
    );
    Ok(stopped)
}

/// Stop all running channels and the heartbeat runner for one Agent runtime.
/// Durable channel identities are included in the lock set so a start that is
/// still creating (and therefore not yet published in `ManagedAgents`) cannot
/// appear after disable/archive has reported success.
pub(crate) async fn stop_agent_channels_runtime(
    agent_state: &ManagedAgents,
    sidecar_manager: &ManagedSidecarManager,
    agent_id: &str,
) -> Result<usize, String> {
    let durable_ids = super::config_store::read_agent_channel_ids_from_disk(agent_id)?;
    let live_ids = {
        let guard = agent_state.lock().await;
        guard
            .get(agent_id)
            .map(|agent| {
                agent
                    .config
                    .channels
                    .iter()
                    .map(|channel| channel.id.clone())
                    .chain(agent.channels.keys().cloned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let channel_ids = agent_channel_ids_for_stop(durable_ids, live_ids);
    let _lifecycle_guards = lock_agent_channels_for_stop(agent_id, &channel_ids).await;

    let maybe_agent = {
        let mut guard = agent_state.lock().await;
        guard.remove(agent_id)
    };

    let Some(mut agent) = maybe_agent else {
        return Ok(0);
    };

    if let Some(handle) = agent.heartbeat_handle.take() {
        handle.abort();
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
    }

    let mut stopped = 0usize;
    let mut failures = Vec::new();
    for (channel_id, channel) in agent.channels {
        if let Err(err) =
            shutdown_bot_instance(channel.bot_instance, sidecar_manager, &channel_id).await
        {
            ulog_warn!(
                "[im] Agent shutdown: channel {} of agent {} graceful shutdown failed: {}",
                channel_id,
                agent_id,
                err
            );
            failures.push(format!("{}: {}", channel_id, err));
        }
        stopped += 1;
    }

    if failures.is_empty() {
        Ok(stopped)
    } else {
        Err(format!(
            "Failed to stop {} channel(s) for Agent {}: {}",
            failures.len(),
            agent_id,
            failures.join("; ")
        ))
    }
}

fn uses_openclaw_reply_protocol(msg: &ImMessage) -> bool {
    !msg.request_id.is_empty()
        && msg.delivery_protocol == Some(types::ImDeliveryProtocol::OpenClawReply)
}

/// Finish an inline Rust-owned response through the request's established
/// renderer. Native/legacy messages keep their direct adapter path; an
/// OpenClaw dispatcher request must not be left pending or silently switch
/// renderers when Rust handles a command or admission decision without a turn.
async fn send_immediate_reply<A: adapter::ImStreamAdapter>(
    adapter: &A,
    msg: &ImMessage,
    text: &str,
) -> adapter::AdapterResult<()> {
    if uses_openclaw_reply_protocol(msg) {
        let payloads = adapter::split_message(text, adapter.max_message_length())
            .into_iter()
            .map(|chunk| json!({"text":chunk}))
            .collect::<Vec<_>>();
        return adapter
            .complete_reply_dispatch(&msg.request_id, &json!(payloads))
            .await;
    }
    for chunk in adapter::split_message(text, adapter.max_message_length()) {
        adapter.send_message(&msg.chat_id, &chunk).await?;
    }
    Ok(())
}

async fn complete_immediate_without_reply<A: adapter::ImStreamAdapter>(
    adapter: &A,
    msg: &ImMessage,
) {
    if !uses_openclaw_reply_protocol(msg) {
        return;
    }
    if let Err(error) = adapter
        .complete_reply_dispatch(&msg.request_id, &serde_json::Value::Array(Vec::new()))
        .await
    {
        ulog_error!(
            "[im] Could not settle no-reply OpenClaw admission requestId={}: {}",
            msg.request_id,
            error
        );
    }
}

async fn abort_immediate_reply<A: adapter::ImStreamAdapter>(
    adapter: &A,
    msg: &ImMessage,
    reason: &str,
    text: &str,
) -> adapter::AdapterResult<()> {
    if uses_openclaw_reply_protocol(msg) {
        return adapter
            .abort_reply_dispatch(
                &msg.request_id,
                reason,
                &json!({ "text": text, "isError": true }),
            )
            .await;
    }
    adapter.send_message(&msg.chat_id, text).await
}

fn question_answer_key(question: &AskUserQuestionItem, idx: usize) -> String {
    question.id.clone().unwrap_or_else(|| idx.to_string())
}

fn normalize_question_answer(
    question: &AskUserQuestionItem,
    raw: &str,
) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return if question.required {
            Err("必填问题不能为空".to_string())
        } else {
            Ok(None)
        };
    }
    if question.options.is_empty() {
        return Ok(Some(raw.to_string()));
    }

    let parse_one = |part: &str| -> Option<String> {
        let p = part.trim();
        if p.is_empty() {
            return None;
        }
        if let Ok(index) = p.parse::<usize>() {
            if index > 0 && index <= question.options.len() {
                return Some(question.options[index - 1].label.clone());
            }
        }
        question
            .options
            .iter()
            .find(|opt| opt.label == p)
            .map(|opt| opt.label.clone())
    };

    if question.multi_select {
        let mut labels = Vec::new();
        for part in trimmed.split([',', '，']) {
            match parse_one(part) {
                Some(label) => labels.push(label),
                None => return Err("多选答案请使用选项编号或完整选项名，并用逗号分隔".to_string()),
            }
        }
        if labels.is_empty() && question.required {
            return Err("必填问题不能为空".to_string());
        }
        return Ok(Some(labels.join(",")));
    }

    parse_one(trimmed)
        .map(Some)
        .ok_or_else(|| "答案请使用选项编号或完整选项名".to_string())
}

fn parse_question_text_answers(
    questions: &[AskUserQuestionItem],
    _source_type: &ImSourceType,
    text: &str,
) -> Result<Option<HashMap<String, String>>, String> {
    if text.trim().eq_ignore_ascii_case("cancel") || matches!(text.trim(), "取消" | "退出") {
        return Ok(None);
    }
    if questions.iter().any(|q| q.is_secret) {
        return Ok(None);
    }

    let mut answers = HashMap::new();
    if questions.len() == 1 {
        if let Some(answer) = normalize_question_answer(&questions[0], text)? {
            answers.insert(question_answer_key(&questions[0], 0), answer);
        }
        return Ok(Some(answers));
    }

    let lines = text.lines().collect::<Vec<_>>();
    for (idx, question) in questions.iter().enumerate() {
        let raw = lines.get(idx).copied().unwrap_or("");
        if let Some(answer) = normalize_question_answer(question, raw)? {
            answers.insert(question_answer_key(question, idx), answer);
        }
    }
    Ok(Some(answers))
}

/// Shutdown a single bot instance (extracted from stop_im_bot for reuse by agent commands).
/// Does NOT lock any global state — caller is responsible for removing the instance first.
pub(super) async fn shutdown_bot_instance(
    instance: ImBotInstance,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: &str,
) -> Result<(), String> {
    ulog_info!("[im] Stopping bot instance {}...", bot_id);

    // Signal shutdown to all loops
    let _ = instance.shutdown_tx.send(true);

    // Abort poll_handle to cancel in-flight long-poll HTTP request immediately
    instance.poll_handle.abort();

    // Wait for in-flight messages to finish (graceful: up to 10s)
    match tokio::time::timeout(std::time::Duration::from_secs(10), instance.process_handle).await {
        Ok(_) => ulog_info!("[im] Processing loop exited gracefully"),
        Err(_) => {
            ulog_warn!("[im] Processing loop did not exit within 10s, proceeding with shutdown")
        }
    }

    // Wait for auxiliary tasks
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.approval_handle).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.question_handle).await;
    if let Some(hb) = instance.heartbeat_handle {
        // abort() the heartbeat task to ensure prompt shutdown.
        // Heartbeat may be blocked in create_sidecar_blocking (Phase 2, up to 5 min)
        // or in the heartbeat HTTP call itself. abort() cancels at the next .await point.
        hb.abort();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), hb).await;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.health_handle).await;

    // Sidecar-stop subscriber: shutdown_tx.send(true) above already signals
    // `changed()` so the task self-exits, but abort() is belt-and-suspenders
    // against a stuck recv() (broadcast wakes are async and may not arrive
    // immediately under load). Tokio JoinHandle drop does NOT cancel the
    // task — without abort() a hung subscriber would outlive the bot.
    instance.sidecar_stop_handle.abort();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        instance.sidecar_stop_handle,
    )
    .await;

    // Persist remaining buffered messages to disk
    if let Err(e) = instance.buffer.lock().await.save_to_disk() {
        ulog_warn!("[im] Failed to persist buffer on shutdown: {}", e);
    }

    // Flush dedup cache to disk (Feishu only)
    if let AnyAdapter::Feishu(ref feishu) = *instance.adapter {
        feishu.flush_dedup_cache().await;
    }

    // Kill bridge process and unregister sender (OpenClaw only)
    if let Some(bp_mutex) = instance.bridge_process {
        let mut bp = bp_mutex.lock().await;
        bp.kill().await?;
        bridge::unregister_bridge_sender(bot_id).await;
    }

    // Persist active sessions in health state before releasing Sidecars
    let _ = health::persist_router_active_sessions(
        &instance.health,
        &instance.router,
        "shutdown-before-release",
    )
    .await;

    // Release all Sidecar sessions
    instance
        .router
        .lock()
        .await
        .release_all(sidecar_manager)
        .await?;

    // Final health state: mark as Stopped and persist
    instance.health.set_status(ImStatus::Stopped).await;
    let _ = instance.health.persist().await;

    ulog_info!("[im] Bot instance {} stopped", bot_id);
    Ok(())
}

/// Restart one Agent channel through the same full shutdown/start path used by
/// explicit lifecycle commands. Callers decide when the boundary is safe and
/// provide the authoritative config to use for the replacement.
pub(super) async fn restart_agent_channel_instance<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_state: &ManagedAgents,
    sidecar_manager: &ManagedSidecarManager,
    agent_id: &str,
    channel_id: &str,
) -> Result<bool, String> {
    let lifecycle_lock = agent_channel_lifecycle_lock(agent_id, channel_id);
    let _lifecycle_guard = lifecycle_lock.lock().await;

    let Ok((_, _, config)) =
        super::config_store::current_agent_channel_start_config(agent_id, channel_id)
    else {
        return Ok(false);
    };

    let old = {
        let mut agents = agent_state.lock().await;
        agents
            .get_mut(agent_id)
            .and_then(|agent| agent.channels.remove(channel_id))
    };
    let Some(old) = old else {
        return Ok(false);
    };

    let pending_cron_events = Arc::clone(&old.bot_instance.pending_cron_events);

    if let Err(err) = shutdown_bot_instance(old.bot_instance, sidecar_manager, channel_id).await {
        // The instance has already been removed and shutdown consumes it. Keep
        // the established lifecycle behavior: attempt a clean replacement so
        // the monitor does not have to recover an avoidable missing channel.
        ulog_warn!(
            "[agent] Failed to fully shutdown channel {} before restart: {}",
            channel_id,
            err
        );
    }
    let creation_permit = crate::sidecar::begin_lifecycle_spawn_permit()?;
    let (new_instance, _) = create_bot_instance_with_pending_cron_events(
        app_handle,
        sidecar_manager,
        channel_id.to_string(),
        config,
        Some(agent_id.to_string()),
        Some(pending_cron_events),
        &creation_permit,
    )
    .await?;

    let link = {
        let agents = agent_state.lock().await;
        agents.get(agent_id).map(|agent| AgentChannelLink {
            channel_id: channel_id.to_string(),
            agent_id: agent_id.to_string(),
            last_active_channel: Arc::clone(&agent.last_active_channel),
            last_active_private_target: Arc::clone(&agent.last_active_private_target),
        })
    };
    let Some(link) = link else {
        shutdown_bot_instance(new_instance, sidecar_manager, channel_id).await?;
        return Ok(false);
    };
    *new_instance.agent_link.write().await = Some(link);
    let mut agents = agent_state.lock().await;
    let Some(agent) = agents.get_mut(agent_id) else {
        drop(agents);
        shutdown_bot_instance(new_instance, sidecar_manager, channel_id).await?;
        return Ok(false);
    };
    if agent.channels.contains_key(channel_id) {
        drop(agents);
        shutdown_bot_instance(new_instance, sidecar_manager, channel_id).await?;
        return Ok(false);
    }
    agent.channels.insert(
        channel_id.to_string(),
        ChannelInstance {
            channel_id: channel_id.to_string(),
            bot_instance: new_instance,
        },
    );
    Ok(true)
}

/// Create a bot instance without locking or inserting into any global container.
/// Core logic extracted from start_im_bot for reuse by agent channel commands.
/// `agent_id` controls:
///   - Router session key format (TD-2: `agent:` prefix vs legacy `im:`)
///   - Health file path (TD-3: `agents/{id}/channels/` vs `im_bots/`)
pub(super) async fn create_bot_instance<R: Runtime>(
    app_handle: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: String,
    config: ImConfig,
    agent_id: Option<String>,
    creation_permit: &crate::sidecar::LifecycleSpawnPermit,
) -> Result<(ImBotInstance, ImBotStatus), String> {
    create_bot_instance_with_pending_cron_events(
        app_handle,
        sidecar_manager,
        bot_id,
        config,
        agent_id,
        None,
        creation_permit,
    )
    .await
}

async fn create_bot_instance_with_pending_cron_events<R: Runtime>(
    app_handle: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: String,
    config: ImConfig,
    agent_id: Option<String>,
    carried_pending_cron_events: Option<Arc<Mutex<Vec<types::PendingCronEvent>>>>,
    creation_permit: &crate::sidecar::LifecycleSpawnPermit,
) -> Result<(ImBotInstance, ImBotStatus), String> {
    ulog_info!(
        "[im] Starting IM Bot {} (configured workspace: {:?})",
        bot_id,
        config.default_workspace_path,
    );

    // Migrate legacy files to per-bot paths on first start
    health::migrate_legacy_files(&bot_id);

    // TD-3: Migrate bot data to agent path if this is an agent channel
    if let Some(ref aid) = agent_id {
        health::migrate_bot_data_to_agent(&bot_id, aid);
    }

    // Determine default workspace (filter empty strings from frontend)
    // Fallback chain: configured path → bundled mino → home dir
    let default_workspace = config
        .default_workspace_path
        .as_ref()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Try bundled mino workspace first
            dirs::home_dir()
                .map(|home| {
                    home.join(crate::app_dirs::APP_DATA_DIR_NAME)
                        .join("projects")
                        .join("mino")
                })
                .filter(|p| p.exists())
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        });

    ulog_info!("[im] Resolved workspace: {}", default_workspace.display());
    let default_workspace_str = default_workspace.to_string_lossy().to_string();

    // Initialize components (TD-3: agent channels use agent-scoped paths)
    let health_path = match &agent_id {
        Some(aid) => health::agent_channel_health_path(aid, &bot_id),
        None => health::bot_health_path(&bot_id),
    };
    let health = Arc::new(HealthManager::new(health_path));
    health.set_status(ImStatus::Connecting).await;

    let buffer_path = match &agent_id {
        Some(aid) => health::agent_channel_buffer_path(aid, &bot_id),
        None => health::bot_buffer_path(&bot_id),
    };
    let buffer = Arc::new(Mutex::new(MessageBuffer::load_from_disk(&buffer_path)));

    // TD-2: Agent channels use new_for_agent() for agent-scoped session keys
    let router = {
        let mut r = match &agent_id {
            Some(aid) => SessionRouter::new_for_agent(default_workspace, aid.clone()),
            None => SessionRouter::new(default_workspace),
        };
        // Restore peer→session mapping from previous run's im_state.json
        let prev_sessions = health.get_state().await.active_sessions;
        r.restore_sessions(&prev_sessions).await;
        Arc::new(Mutex::new(r))
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Shared mutable whitelist — updated when a user binds via QR code
    let allowed_users = Arc::new(tokio::sync::RwLock::new(config.allowed_users.clone()));

    // Hot Agent template projection; established Sessions own their execution settings.
    let current_model = Arc::new(tokio::sync::RwLock::new(config.model.clone()));

    // Generate bind code for QR code binding flow
    let bind_code = format!("BIND_{}", &uuid::Uuid::new_v4().to_string()[..8]);

    // Create approval channel for permission request callbacks
    let (approval_tx, mut approval_rx) = mpsc::channel::<ApprovalCallback>(32);
    let pending_approvals: PendingApprovals = Arc::new(Mutex::new(HashMap::new()));
    let (question_tx, mut question_rx) = mpsc::channel::<QuestionCallback>(32);
    let pending_questions: PendingQuestions = Arc::new(Mutex::new(HashMap::new()));

    // Create group event channel for bot added/removed from groups
    let (group_event_tx, mut group_event_rx) = mpsc::channel::<GroupEvent>(32);

    // Initialize group chat state from config (loaded from disk)
    let initial_activation = match config.group_activation.as_deref() {
        Some("always") => GroupActivation::Always,
        _ => GroupActivation::Mention,
    };
    let group_permissions: Arc<tokio::sync::RwLock<Vec<GroupPermission>>> =
        Arc::new(tokio::sync::RwLock::new(config.group_permissions.clone()));
    let group_activation: Arc<tokio::sync::RwLock<GroupActivation>> =
        Arc::new(tokio::sync::RwLock::new(initial_activation));
    let group_tools_deny: Arc<tokio::sync::RwLock<Vec<String>>> =
        Arc::new(tokio::sync::RwLock::new(config.group_tools_deny.clone()));
    let group_history: Arc<Mutex<GroupHistoryBuffer>> =
        Arc::new(Mutex::new(GroupHistoryBuffer::new()));

    // Create platform adapter (implements ImAdapter + ImStreamAdapter traits)
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel(256);
    let msg_tx_for_reinjection = msg_tx.clone(); // For media group merge re-injection
    let mut bridge_process_handle: Option<bridge::BridgeProcess> = None;
    let adapter: Arc<AnyAdapter> = match config.platform {
        ImPlatform::Telegram => Arc::new(AnyAdapter::Telegram(Arc::new(TelegramAdapter::new(
            &config,
            msg_tx.clone(),
            Arc::clone(&allowed_users),
            approval_tx.clone(),
            group_event_tx.clone(),
        )))),
        ImPlatform::Feishu => {
            let dedup_path = Some(match &agent_id {
                Some(aid) => health::agent_channel_dedup_path(aid, &bot_id),
                None => health::bot_dedup_path(&bot_id),
            });
            Arc::new(AnyAdapter::Feishu(Arc::new(FeishuAdapter::new(
                &config,
                msg_tx.clone(),
                Arc::clone(&allowed_users),
                approval_tx.clone(),
                question_tx.clone(),
                dedup_path,
                group_event_tx.clone(),
            ))))
        }
        ImPlatform::Dingtalk => {
            let dedup_path = Some(match &agent_id {
                Some(aid) => health::agent_channel_dedup_path(aid, &bot_id),
                None => health::bot_dedup_path(&bot_id),
            });
            Arc::new(AnyAdapter::Dingtalk(Arc::new(DingtalkAdapter::new(
                &config,
                msg_tx.clone(),
                Arc::clone(&allowed_users),
                approval_tx.clone(),
                dedup_path,
                group_event_tx.clone(),
            ))))
        }
        ImPlatform::OpenClaw(ref channel_id) => {
            // Allocate port for bridge process
            let port_allocator = sidecar_manager.lock().unwrap().port_allocator();
            let bridge_port = crate::sidecar::allocate_sidecar_port(&port_allocator)?;

            let rust_port = crate::management_api::get_management_port();
            let plugin_id = config.openclaw_plugin_id.as_deref().unwrap_or(channel_id);

            let plugin_dir = dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(crate::app_dirs::APP_DATA_DIR_NAME)
                .join("openclaw-plugins")
                .join(plugin_id);
            let bridge_state_dir = match &agent_id {
                Some(aid) => health::agent_channel_data_dir(aid, &bot_id).join("openclaw-state"),
                None => health::bot_data_dir(&bot_id).join("openclaw-state"),
            };

            let bp = bridge::spawn_plugin_bridge(
                app_handle,
                &plugin_dir.to_string_lossy(),
                &bridge_state_dir,
                bridge_port,
                rust_port,
                &bot_id,
                config.openclaw_plugin_config.as_ref(),
                creation_permit,
            )
            .await?;

            // Register bridge sender for inbound message routing
            bridge::register_bridge_sender(&bot_id, &channel_id, msg_tx.clone()).await;

            let mut bridge_adapter = BridgeAdapter::new(channel_id.clone(), bp.port);
            bridge_adapter.sync_capabilities().await;
            // Override with user-configured tool groups (if set in channel config).
            // Auto-merge: any new groups from the plugin that aren't in the user's
            // list get appended so they're available during this channel session.
            // The merge runs on every channel startup (idempotent, not persisted to disk).
            if let Some(ref groups) = config.openclaw_enabled_tool_groups {
                if !groups.is_empty() {
                    let plugin_groups = bridge_adapter.all_tool_groups();
                    let mut merged = groups.clone();
                    let mut new_count = 0usize;
                    for g in plugin_groups {
                        if !merged.contains(g) {
                            merged.push(g.clone());
                            new_count += 1;
                        }
                    }
                    if new_count > 0 {
                        ulog_info!(
                            "[im] Auto-merged {} new tool group(s) from plugin into enabled list",
                            new_count
                        );
                    }
                    bridge_adapter.set_enabled_tool_groups(merged);
                }
            }
            let adapter = Arc::new(AnyAdapter::Bridge(Arc::new(bridge_adapter)));
            bridge_process_handle = Some(bp);
            adapter
        }
    };

    // Verify bot connection via ImAdapter + ImStreamAdapter traits
    use adapter::ImAdapter;
    use adapter::ImStreamAdapter;
    match adapter.verify_connection().await {
        Ok(display_name) => {
            // Map "" → None so any historical dirty bot_username (e.g.
            // "wecom/wecom-openclaw-plugin" written by old BridgeAdapter
            // versions, then loaded back from im_<botId>_state.json on
            // restart) gets explicitly cleared. Renderer falls back to
            // platform label when bot_username is None.
            //
            // Non-empty: Telegram returns "@username" (strip @), Feishu /
            // OpenClaw bridge resolvers return plain name (no prefix).
            let username = if display_name.is_empty() {
                None
            } else {
                Some(
                    display_name
                        .strip_prefix('@')
                        .map(String::from)
                        .unwrap_or(display_name),
                )
            };
            ulog_info!(
                "[im] Bot verified: {}",
                username.as_deref().unwrap_or("<no display name>")
            );
            health.set_bot_username(username).await;
            health.set_status(ImStatus::Online).await;
            health.set_error(None).await;
            // Emit appropriate event based on whether this is an agent channel or legacy bot
            if agent_id.is_some() {
                let _ = app_handle.emit("agent:status-changed", json!({ "event": "online" }));
            } else {
                let _ = app_handle.emit("im:status-changed", json!({ "event": "online" }));
            }
        }
        Err(e) => {
            let err_msg = format!("Bot connection verification failed: {}", e);
            ulog_error!("[im] {}", err_msg);
            // Clean up bridge process if it was spawned (OpenClaw only)
            if let Some(mut bp) = bridge_process_handle.take() {
                match bp.kill_sync() {
                    Ok(()) => bridge::unregister_bridge_sender(&bot_id).await,
                    Err(kill_error) => {
                        ulog_error!(
                            "[im] Failed to terminate Plugin Bridge after verification error: {}",
                            kill_error
                        );
                    }
                }
            }
            // Also clear bot_username on the error path. Otherwise a historical
            // dirty value (pre-v0.2.10 bridge wrote `pluginName` like
            // "wecom/wecom-openclaw-plugin" here) loaded from disk would
            // survive verify failures and continue rendering in the channel
            // list. v0.2.10 invariant: bot_username is the source of truth
            // ONLY when verify_connection succeeds; on any failure it MUST be
            // None so the renderer falls back to platform label.
            health.set_bot_username(None).await;
            health.set_status(ImStatus::Error).await;
            health.set_error(Some(err_msg.clone())).await;
            let _ = health.persist().await;
            return Err(err_msg);
        }
    }

    // Register platform commands via ImAdapter trait
    if let Err(e) = adapter.register_commands().await {
        ulog_warn!("[im] Failed to register bot commands: {}", e);
    }

    // Start health persist loop
    let health_handle = health.start_persist_loop(shutdown_rx.clone());

    // Start platform listen loop (long-poll for Telegram, health watchdog for Bridge)
    let adapter_clone = Arc::clone(&adapter);
    let poll_shutdown_rx = shutdown_rx.clone();
    let poll_handle = tauri::async_runtime::spawn(async move {
        adapter_clone.listen_loop(poll_shutdown_rx).await;
    });

    // Watch for unexpected listen_loop exit (e.g., Bridge health check failures).
    // If listen_loop ends but shutdown was not signalled, mark bot as error.
    {
        let health_for_watcher = health.clone();
        let mut watcher_shutdown_rx = shutdown_rx.clone();
        // `abort_handle` lives on the inner `tokio::task::JoinHandle`; the
        // tauri wrapper exposes `inner()` for cases like this.
        let poll_handle_watcher = poll_handle.inner().abort_handle();
        let bot_id_for_watcher = bot_id.clone();
        let shutdown_tx_for_watcher = shutdown_tx.clone();
        tauri::async_runtime::spawn(async move {
            // Wait until either shutdown is signalled or the poll task finishes
            loop {
                tokio::select! {
                    _ = watcher_shutdown_rx.changed() => {
                        if *watcher_shutdown_rx.borrow() { return; } // Normal shutdown
                    }
                    _ = async { while !poll_handle_watcher.is_finished() { tokio::time::sleep(Duration::from_secs(2)).await; } } => {
                        // poll_handle finished without shutdown signal — bridge/adapter died
                        ulog_error!("[im] Listen loop for bot {} exited unexpectedly, marking as error", bot_id_for_watcher);
                        health_for_watcher.set_status(ImStatus::Error).await;
                        health_for_watcher.set_error(Some("Platform connection lost (listen loop exited)".to_string())).await;
                        // Signal shutdown so the processing loop also stops cleanly
                        let _ = shutdown_tx_for_watcher.send(true);
                        return;
                    }
                }
            }
        });
    }

    // Start approval callback handler
    let pending_approvals_for_handler = Arc::clone(&pending_approvals);
    let adapter_for_approval = Arc::clone(&adapter);
    let approval_client = crate::local_http::json_client(std::time::Duration::from_secs(30));
    let mut approval_shutdown_rx = shutdown_rx.clone();
    let approval_handle = tauri::async_runtime::spawn(async move {
        loop {
            let cb = tokio::select! {
                msg = approval_rx.recv() => match msg {
                    Some(cb) => cb,
                    None => break, // Channel closed
                },
                _ = approval_shutdown_rx.changed() => {
                    if *approval_shutdown_rx.borrow() { break; }
                    continue;
                }
            };

            let pending = pending_approvals_for_handler
                .lock()
                .await
                .remove(&cb.request_id);
            if let Some(p) = pending {
                // POST decision to Sidecar
                let url = format!(
                    "http://127.0.0.1:{}/api/im/permission-response",
                    p.sidecar_port
                );
                let result = approval_client
                    .post(&url)
                    .json(&json!({
                        "requestId": cb.request_id,
                        "decision": cb.decision,
                    }))
                    .send()
                    .await;
                match result {
                    Ok(resp) if resp.status().is_success() => {
                        ulog_info!(
                            "[im] Approval forwarded: rid={}, decision={}",
                            &cb.request_id[..cb.request_id.len().min(16)],
                            cb.decision
                        );
                    }
                    Ok(resp) => {
                        ulog_error!("[im] Approval forward failed: HTTP {}", resp.status());
                    }
                    Err(e) => {
                        ulog_error!("[im] Approval forward error: {}", e);
                    }
                }
                // Update card to show result (skip if card send had failed)
                if !p.card_message_id.is_empty() {
                    let status_text = if cb.decision == "deny" {
                        "denied"
                    } else {
                        "approved"
                    };
                    let _ = adapter_for_approval
                        .update_approval_status(&p.chat_id, &p.card_message_id, status_text)
                        .await;
                }
            } else {
                ulog_warn!(
                    "[im] Approval callback for unknown request_id: {}",
                    &cb.request_id[..cb.request_id.len().min(16)]
                );
            }
        }
        ulog_info!("[im] Approval handler exited");
    });

    let pending_questions_for_handler = Arc::clone(&pending_questions);
    let adapter_for_question = Arc::clone(&adapter);
    let question_client = crate::local_http::json_client(std::time::Duration::from_secs(30));
    let mut question_shutdown_rx = shutdown_rx.clone();
    let question_handle = tauri::async_runtime::spawn(async move {
        loop {
            let cb = tokio::select! {
                msg = question_rx.recv() => match msg {
                    Some(cb) => cb,
                    None => break,
                },
                _ = question_shutdown_rx.changed() => {
                    if *question_shutdown_rx.borrow() { break; }
                    continue;
                }
            };

            let pending = {
                let guard = pending_questions_for_handler.lock().await;
                let Some(p) = guard.get(&cb.request_id) else {
                    ulog_warn!(
                        "[im] AskUserQuestion callback for unknown request_id: {}",
                        &cb.request_id[..cb.request_id.len().min(16)]
                    );
                    continue;
                };
                if matches!(p.source_type, ImSourceType::Group)
                    && p.requester_user_id
                        .as_deref()
                        .is_some_and(|id| id != cb.user_id)
                {
                    ulog_warn!(
                        "[im] Ignoring AskUserQuestion callback from non-requester rid={}",
                        &cb.request_id[..cb.request_id.len().min(16)]
                    );
                    continue;
                }
                p.clone()
            };

            let p = pending;
            let url = format!(
                "http://127.0.0.1:{}/api/ask-user-question/respond",
                p.sidecar_port
            );
            let result = question_client
                .post(&url)
                .json(&json!({
                    "requestId": cb.request_id,
                    "answers": cb.answers,
                }))
                .send()
                .await;
            let forwarded = match result {
                Ok(resp) => {
                    let status = resp.status();
                    match resp.json::<serde_json::Value>().await {
                        Ok(body)
                            if status.is_success()
                                && body.get("success").and_then(serde_json::Value::as_bool)
                                    == Some(true) =>
                        {
                            ulog_info!(
                                "[im] AskUserQuestion response forwarded: rid={}",
                                &cb.request_id[..cb.request_id.len().min(16)]
                            );
                            true
                        }
                        Ok(body) => {
                            ulog_error!(
                                "[im] AskUserQuestion response forward failed: HTTP {} body={}",
                                status,
                                body
                            );
                            false
                        }
                        Err(e) => {
                            ulog_error!(
                                "[im] AskUserQuestion response forward returned invalid JSON: {}",
                                e
                            );
                            false
                        }
                    }
                }
                Err(e) => {
                    ulog_error!("[im] AskUserQuestion response forward error: {}", e);
                    false
                }
            };
            if forwarded {
                {
                    let mut guard = pending_questions_for_handler.lock().await;
                    guard.remove(&cb.request_id);
                }
                if !p.card_message_id.is_empty() {
                    let status_text = if cb.answers.is_some() {
                        "submitted"
                    } else {
                        "cancelled"
                    };
                    let _ = adapter_for_question
                        .update_question_status(&p.chat_id, &p.card_message_id, status_text)
                        .await;
                }
            } else {
                let _ = crate::im::adapter::ImAdapter::send_message(
                    adapter_for_question.as_ref(),
                    &p.chat_id,
                    "提交失败，请稍后重试，或再次点击卡片/重新回复答案。",
                )
                .await;
            }
        }
        ulog_info!("[im] AskUserQuestion handler exited");
    });

    // Per-peer locks: shared between the processing loop and heartbeat runner.
    // Pattern C (IM Pipeline v2): scope was reduced to ms-level — covers only
    // the enqueue phase (Session identity check + ensure_sidecar + POST /api/im/enqueue).
    // The reply event stream now flows through `event_consumer.rs` long-poll,
    // independent of the lock.
    let peer_locks: PeerLocks = Arc::new(Mutex::new(HashMap::new()));

    // Start message processing loop
    //
    // Concurrency model:
    //   Commands are handled inline (fast, no I/O to Sidecar).
    //   Regular messages are spawned as per-message tasks via JoinSet.
    //
    //   Lock ordering (per task):
    //     1. Per-peer lock — serializes the enqueue phase per session_key
    //        (Session identity check + ensure_sidecar + POST /api/im/enqueue, ~ms).
    //        Heartbeat runner also acquires this lock to keep the enqueue
    //        phase ordered (Pattern C/D).
    //     2. Global semaphore — limits total concurrent Sidecar I/O across all peers.
    //        Acquired AFTER the peer lock so queued same-peer tasks don't hold permits
    //        while waiting, which would starve other peers.
    //     3. Router lock — held briefly for data ops (ensure_sidecar, record_response),
    //        never during the HTTP POST itself.
    let router_clone = Arc::clone(&router);
    let buffer_clone = Arc::clone(&buffer);
    let health_clone = Arc::clone(&health);
    let adapter_for_reply = Arc::clone(&adapter);
    let app_clone = app_handle.clone();
    let manager_clone = Arc::clone(sidecar_manager);
    let permission_mode = Arc::new(tokio::sync::RwLock::new(config.permission_mode.clone()));
    let runtime = Arc::new(tokio::sync::RwLock::new(normalize_runtime_type(
        config.runtime.as_deref(),
    )));
    let runtime_config = Arc::new(tokio::sync::RwLock::new(config.runtime_config.clone()));
    // Parse provider env from config (for per-message forwarding to Sidecar)
    // Hot template projection for future IM Session births.
    let provider_env: Option<serde_json::Value> = config
        .provider_env_json
        .as_ref()
        .and_then(|json_str| serde_json::from_str(json_str).ok());
    let current_provider_env = Arc::new(tokio::sync::RwLock::new(provider_env));
    // MCP servers JSON — hot-reloadable
    let mcp_servers_json = Arc::new(tokio::sync::RwLock::new(config.mcp_servers_json.clone()));
    let bot_name_for_loop = config.name.clone();
    let bind_code_for_loop = bind_code.clone();
    let bot_id_for_loop = bot_id.clone();
    let allowed_users_for_loop = Arc::clone(&allowed_users);
    let runtime_for_loop = Arc::clone(&runtime);
    let pending_approvals_for_loop = Arc::clone(&pending_approvals);
    let pending_questions_for_loop = Arc::clone(&pending_questions);
    let approval_tx_for_loop = approval_tx.clone();
    let question_tx_for_loop = question_tx.clone();
    let group_permissions_for_loop = Arc::clone(&group_permissions);
    let group_activation_for_loop = Arc::clone(&group_activation);
    let group_tools_deny_for_loop = Arc::clone(&group_tools_deny);
    let group_history_for_loop = Arc::clone(&group_history);
    let group_event_tx_for_loop = group_event_tx.clone();
    let mut process_shutdown_rx = shutdown_rx.clone();

    // Concurrency primitives (live outside the router for lock-free access)
    let global_semaphore = Arc::new(Semaphore::new(GLOBAL_CONCURRENCY));
    // peer_locks is created in start_im_bot() and shared with heartbeat runner;
    // the Arc is cloned here for the processing loop.
    let peer_locks_for_loop = Arc::clone(&peer_locks);
    let stream_client = create_sidecar_stream_client();
    // Pattern C: per-peer-session ImEventConsumer + ReplyRouter registry. One
    // entry per session_key; lazy-spawn on first /api/im/enqueue, cancel on
    // session reset / Sidecar shutdown.
    let im_consumers: ImConsumers = Arc::new(Mutex::new(HashMap::new()));
    let im_consumers_for_loop = Arc::clone(&im_consumers);
    let model_work_gate = ChannelModelWorkGate::new();
    let model_work_gate_for_loop = Arc::clone(&model_work_gate);

    // Subscribe to sidecar-stop broadcast and cancel matching consumers in
    // lockstep. Without this, when the IM Agent owner is released and the
    // sidecar shuts down (Owner model: last owner → kill), the long-poll
    // ImEventConsumer kept reconnecting to the dead port forever (only the
    // 60s idle collector or app shutdown would notice — and only if the
    // router-level last_active also crossed the idle threshold). Subscribe
    // once per IM bot; tokio broadcast handles fan-out to multiple bots.
    //
    // Match on (session_id, generation) — generation distinguishes a fresh
    // sidecar from a previous instance bound to the same session_id (e.g.
    // idle collector preserves session_id, next message rebuilds with a
    // bumped generation). Without this, a stale stop event would kill the
    // freshly-recreated consumer.
    let im_consumers_for_sidecar_stop = Arc::clone(&im_consumers);
    let sidecar_manager_for_sidecar_stop = Arc::clone(sidecar_manager);
    let mut sidecar_stop_rx = sidecar_manager.lock().unwrap().subscribe_stop_events();
    let mut sidecar_stop_shutdown_rx = shutdown_rx.clone();
    let sidecar_stop_handle = tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                evt = sidecar_stop_rx.recv() => {
                    match evt {
                        Ok((stopped_session_id, stopped_gen)) => {
                            let mut guard = im_consumers_for_sidecar_stop.lock().await;
                            // Sweep registry for consumers bound to this *specific*
                            // sidecar instance — both session_id and generation must
                            // match. Multiple peer_session_keys can share a single
                            // sidecar (e.g. cross-runtime fork transitions briefly
                            // overlap), so we collect all matches and cancel each.
                            let to_remove: Vec<String> = guard.iter()
                                .filter(|(_, h)| {
                                    h.sidecar_session_id == stopped_session_id
                                        && h.sidecar_generation == stopped_gen
                                })
                                .map(|(k, _)| k.clone())
                                .collect();
                            for key in to_remove {
                                if let Some(handle) = guard.remove(&key) {
                                    handle.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                                    ulog_info!(
                                        "[im] Cancelled ImEventConsumer for {} (sidecar {}@gen{} stopped)",
                                        key, stopped_session_id, stopped_gen
                                    );
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            // Capacity 64 is enough for normal operation; bursty
                            // shutdowns (many sidecars stopping at once) can exceed
                            // it. Without compensation, those skipped events leak
                            // consumers permanently — the exact bug we're fixing.
                            // Reconcile: any consumer entry whose (session_id, gen)
                            // is no longer in the manager's live set must be cancelled.
                            //
                            // Lock order matters here: take the consumers lock FIRST,
                            // then snapshot live set under the manager lock. Reverse
                            // ordering would race — between snapshot and consumers
                            // lock, a fresh ensure_im_consumer could insert a new
                            // entry whose (sid, gen) is in `live` but missing from
                            // our snapshot, and we'd false-positive cancel it. By
                            // holding the consumers lock during snapshot, any
                            // concurrent ensure_im_consumer is blocked from
                            // inserting until we release.
                            ulog_warn!(
                                "[im] sidecar-stop subscriber lagged by {} events — reconciling against live set",
                                n
                            );
                            let mut guard = im_consumers_for_sidecar_stop.lock().await;
                            let live = sidecar_manager_for_sidecar_stop.lock().unwrap().live_sidecar_set();
                            let to_remove: Vec<String> = guard.iter()
                                .filter(|(_, h)| {
                                    !live.contains(&(h.sidecar_session_id.clone(), h.sidecar_generation))
                                })
                                .map(|(k, _)| k.clone())
                                .collect();
                            for key in to_remove {
                                if let Some(handle) = guard.remove(&key) {
                                    handle.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                                    ulog_info!(
                                        "[im] Cancelled ImEventConsumer for {} (lag-reconcile: sidecar not in live set)",
                                        key
                                    );
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
                res = sidecar_stop_shutdown_rx.changed() => {
                    // Both `Ok(_) where borrow()==true` (graceful shutdown signaled)
                    // AND `Err(_)` (sender dropped — bot was force-dropped without a
                    // graceful shutdown) must exit the loop. Without handling the Err
                    // case explicitly, a closed watch with last value=false would have
                    // `changed()` return Err repeatedly and the `if borrow()` guard
                    // would never break the loop, leaking the task forever.
                    match res {
                        Ok(()) if *sidecar_stop_shutdown_rx.borrow() => break,
                        Ok(()) => continue,
                        Err(_) => break,
                    }
                }
            }
        }
    });
    let platform_for_loop = config.platform.clone();
    // Agent link — starts as None; set after bot is moved into AgentInstance.
    // The processing loop holds a clone of this Arc and checks it after each message.
    let agent_link: SharedAgentLink = Arc::new(RwLock::new(None));
    let agent_link_for_loop = Arc::clone(&agent_link);

    let process_handle = tauri::async_runtime::spawn(async move {
        let mut in_flight: JoinSet<()> = JoinSet::new();

        // Media group buffering (Telegram albums)
        struct MediaGroupEntry {
            messages: Vec<ImMessage>,
            first_received: Instant,
        }
        let mut media_groups: HashMap<String, MediaGroupEntry> = HashMap::new();
        let mut model_menus: HashMap<String, model_commands::ModelMenu> = HashMap::new();
        const MEDIA_GROUP_TIMEOUT: Duration = Duration::from_millis(500);
        const MEDIA_GROUP_CHECK_INTERVAL: Duration = Duration::from_millis(100);

        /// Merge buffered media group messages into one combined message
        fn merge_media_group(mut messages: Vec<ImMessage>) -> ImMessage {
            messages.sort_by_key(|m| m.message_id.parse::<i64>().unwrap_or(0));
            let mut base = messages.remove(0);
            // Use first non-empty text as caption
            if base.text.is_empty() {
                if let Some(msg_with_text) = messages.iter().find(|m| !m.text.is_empty()) {
                    base.text = msg_with_text.text.clone();
                }
            }
            // Merge all attachments
            for msg in messages {
                base.attachments.extend(msg.attachments);
            }
            base.media_group_id = None; // Already merged
            base
        }

        /// Process attachments: save File types to workspace, encode Image types to base64.
        /// This is async to use non-blocking file I/O.
        async fn process_attachments(
            msg: &mut ImMessage,
            workspace_path: &std::path::Path,
        ) -> Vec<serde_json::Value> {
            /// Maximum image size for base64 encoding (10 MB)
            const MAX_IMAGE_ENCODE_SIZE: usize = 10 * 1024 * 1024;

            let mut file_refs: Vec<String> = Vec::new();
            let mut image_payloads: Vec<serde_json::Value> = Vec::new();

            for attachment in &msg.attachments {
                match attachment.attachment_type {
                    ImAttachmentType::File => {
                        let target_dir = workspace_path.join("myagents_files");
                        if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
                            ulog_error!("[im] Failed to create myagents_files dir: {}", e);
                            continue;
                        }
                        let target_path = target_dir.join(&attachment.file_name);
                        let final_path = auto_rename_path(&target_path);
                        if let Err(e) = tokio::fs::write(&final_path, &attachment.data).await {
                            ulog_error!("[im] Failed to save file: {}", e);
                            continue;
                        }
                        let relative = format!(
                            "myagents_files/{}",
                            final_path.file_name().unwrap().to_string_lossy()
                        );
                        file_refs.push(format!("@{}", relative));
                        ulog_info!(
                            "[im] Saved file attachment: {} ({} bytes)",
                            relative,
                            attachment.data.len()
                        );
                    }
                    ImAttachmentType::Image => {
                        if attachment.data.len() > MAX_IMAGE_ENCODE_SIZE {
                            ulog_warn!(
                                "[im] Image too large for base64 encoding: {} ({} bytes, max {})",
                                attachment.file_name,
                                attachment.data.len(),
                                MAX_IMAGE_ENCODE_SIZE
                            );
                            continue;
                        }
                        use base64::Engine;
                        let b64 =
                            base64::engine::general_purpose::STANDARD.encode(&attachment.data);
                        image_payloads.push(json!({
                            "name": attachment.file_name,
                            "mimeType": attachment.mime_type,
                            "data": b64,
                        }));
                        ulog_info!(
                            "[im] Encoded image attachment: {} ({} bytes)",
                            attachment.file_name,
                            attachment.data.len()
                        );
                    }
                }
            }

            // Append @path references to message text
            if !file_refs.is_empty() {
                let refs_text = file_refs.join(" ");
                if msg.text.is_empty() {
                    msg.text = refs_text;
                } else {
                    msg.text = format!("{}\n{}", msg.text, refs_text);
                }
            }

            image_payloads
        }

        loop {
            // Determine flush timeout for media groups
            let flush_timeout = if media_groups.is_empty() {
                Duration::from_secs(3600)
            } else {
                MEDIA_GROUP_CHECK_INTERVAL
            };

            tokio::select! {
                Some(msg) = msg_rx.recv() => {
                    // Buffer media group messages
                    if let Some(ref group_id) = msg.media_group_id {
                        media_groups
                            .entry(group_id.clone())
                            .or_insert_with(|| MediaGroupEntry {
                                messages: Vec::new(),
                                first_received: Instant::now(),
                            })
                            .messages
                            .push(msg);
                        continue;
                    }
                    let session_key = {
                        let r = router_clone.lock().await;
                        r.session_key(&msg)
                    };
                    let chat_id = msg.chat_id.clone();
                    let message_id = msg.message_id.clone();
                    let text = msg.text.trim().to_string();

                    // ── Bot command dispatch (inline — fast, no Sidecar I/O) ──

                    // QR code binding: /start BIND_xxxx
                    // Bind code handling: Telegram uses "/start BIND_xxx", Feishu uses plain "BIND_xxx"
                    let is_telegram_bind = text.starts_with("/start BIND_");
                    let is_feishu_bind = text.starts_with("BIND_") && msg.platform == ImPlatform::Feishu;
                    let is_dingtalk_bind = text.starts_with("BIND_") && msg.platform == ImPlatform::Dingtalk;
                    let is_openclaw_bind = text.starts_with("BIND_") && matches!(msg.platform, ImPlatform::OpenClaw(_));
                    if is_telegram_bind || is_feishu_bind || is_dingtalk_bind || is_openclaw_bind {
                        // If sender is already bound, silently ignore stale BIND_ messages
                        // (Feishu may re-deliver old messages after bot restart clears dedup cache)
                        let already_bound = {
                            let users = allowed_users_for_loop.read().await;
                            users.contains(&msg.sender_id)
                        };
                        if already_bound {
                            ulog_debug!("[im] Ignoring stale BIND message from already-bound user {}", msg.sender_id);
                            complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                            continue;
                        }

                        let code = if is_telegram_bind {
                            text.strip_prefix("/start ").unwrap_or("")
                        } else {
                            text.as_str()
                        };
                        if code == bind_code_for_loop {
                            // Valid bind — add user to whitelist
                            let user_id_str = msg.sender_id.clone();
                            let display = msg.sender_name.clone().unwrap_or_else(|| user_id_str.clone());

                            {
                                let mut users = allowed_users_for_loop.write().await;
                                if !users.contains(&user_id_str) {
                                    users.push(user_id_str.clone());
                                    ulog_info!("[im] User bound via QR: {} ({})", display, user_id_str);
                                }
                            }

                            // Persist to config.json directly (doesn't rely on frontend being mounted)
                            {
                                let bid = bot_id_for_loop.clone();
                                let new_users = allowed_users_for_loop.read().await.clone();
                                tokio::task::spawn_blocking(move || {
                                    let patch = BotConfigPatch {
                                        allowed_users: Some(new_users),
                                        ..Default::default()
                                    };
                                    if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                        ulog_warn!("[im] Failed to persist bound user: {}", e);
                                    }
                                });
                            }

                            let reply = format!("✅ 绑定成功！你好 {}，现在可以直接和我聊天了。", display);
                            if let Err(e) = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &reply).await {
                                ulog_warn!("[im-cmd] send_message (bind success) failed: {}", e);
                            }

                            // Emit Tauri events so frontend can update UI
                            let _ = app_clone.emit(
                                "im:user-bound",
                                serde_json::json!({
                                    "botId": bot_id_for_loop,
                                    "userId": user_id_str,
                                    "username": msg.sender_name,
                                }),
                            );
                            let _ = app_clone.emit(
                                "im:bot-config-changed",
                                serde_json::json!({ "botId": bot_id_for_loop }),
                            );
                        } else {
                            if let Err(e) = send_immediate_reply(
                                adapter_for_reply.as_ref(),
                                &msg,
                                "❌ 绑定码无效或已过期，请在 MyAgents 设置中重新获取二维码。",
                            ).await {
                                ulog_warn!("[im-cmd] send_message (bind invalid) failed: {}", e);
                            }
                        }
                        continue;
                    }

                    let command = model_commands::management_command(&text);
                    if msg.source_type == ImSourceType::Group && command.is_some() {
                        complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                        continue;
                    }
                    if command.is_some() && !matches!(command, Some("/start" | "/help"))
                        && !allowed_users_for_loop.read().await.contains(&msg.sender_id) {
                        complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                        continue;
                    }
                    if matches!(command, Some("/provider" | "/mode")) {
                        let reply = if command == Some("/provider") { "/provider 已移除，请发送 /model 按供应商查看并选择模型。" } else { "/mode 已移除，IM 会话使用无需审批的权限策略。" };
                        let _ = send_immediate_reply(adapter_for_reply.as_ref(), &msg, reply).await;
                        continue;
                    }

                    // Handle plain /start (first-time interaction, not a bind)
                    if command == Some("/start") {
                        if let Err(e) = send_immediate_reply(
                            adapter_for_reply.as_ref(),
                            &msg,
                            "👋 你好！我是 MyAgents Bot。\n\n\
                             可用命令：\n\
                             /help — 查看所有命令\n\
                             /new — 开始新对话\n\
                             /model — 查看和切换模型\n\
                             /status — 查看状态\n\n\
                             直接发消息即可开始对话。",
                        ).await {
                            ulog_warn!("[im-cmd] send_message (/start) failed: {}", e);
                        }
                        continue;
                    }

                    if command == Some("/help") {
                        let (client, session_id) = {
                            let router = router_clone.lock().await;
                            (router.http_client().clone(), router.get_peer_session(&session_key)
                                .filter(|peer| peer.metadata_indexed).map(|peer| peer.session_id.clone()))
                        };
                        let model_line = model_commands::model_help_line(&client, &manager_clone, session_id.as_deref()).await;
                        let mut help = format!(
                            "📖 私聊命令\n\n直接发送消息即可开始对话。\n\n\
                             /new — 使用最新 Agent 默认设置开始新对话，历史仍保留\n\
                             /model — {model_line}\n\
                             /model <序号> — 选择模型，并更新 Agent 默认设置\n\
                             /status — 查看当前会话状态\n\
                             /help — 查看帮助"
                        );
                        // Append plugin commands if available (translate English descriptions to Chinese)
                        if let AnyAdapter::Bridge(ref bridge) = *adapter_for_reply {
                            let cmds = bridge.get_commands();
                            if !cmds.is_empty() {
                                help.push_str("\n\n📦 插件命令\n");
                                for (name, desc) in cmds {
                                    let cn_desc = translate_plugin_command_desc(name, desc);
                                    help.push_str(&format!("/{} — {}\n", name, cn_desc));
                                }
                            }
                        }
                        help.push_str("\n\nAgent 默认设置变化不会自动修改已有对话。\n以上管理命令仅支持私聊。");
                        if let Err(e) = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &help).await {
                            ulog_warn!("[im-cmd] send_message (/help) failed: {}", e);
                        }
                        continue;
                    }

                    if command == Some("/new") {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let peer_lock = {
                            let mut locks = peer_locks_for_loop.lock().await;
                            locks
                                .entry(session_key.clone())
                                .or_insert_with(|| Arc::new(Mutex::new(())))
                                .clone()
                        };
                        let _peer_guard = peer_lock.lock().await;
                        let runtime = runtime_for_loop.read().await.clone();
                        let (client, workspace) = { let router = router_clone.lock().await; (router.http_client().clone(), router.peer_session_workspace(&session_key).unwrap_or_else(|| router.default_workspace_path())) };
                        let result = match model_commands::create_birth(&client, &manager_clone, &json!({ "agentDir": workspace, "seedMaxPermission": true, "origin": { "kind": "agent-channel", "surface": "channel_message" } })).await {
                            Ok(target_id) => rotate_peer_binding_for_new_command(&session_key, &runtime, &router_clone, &health_clone, &manager_clone, &target_id, &im_consumers_for_loop).await,
                            Err(error) => Err(error),
                        };
                        model_menus.remove(&session_key);
                        drop(_peer_guard);
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        match result {
                            Ok(new_id) => {
                                // The transition is committed before transient
                                // context is cleared. A failed `/new` keeps A
                                // fully usable, including its pending group history.
                                group_history_for_loop.lock().await.clear(&session_key);
                                enqueue::retire_im_consumer(&im_consumers_for_loop, &manager_clone, &session_key).await;
                                let reply = format!(
                                    "✅ 已创建新对话 ({})",
                                    short_session_id(&new_id)
                                );
                                if let Err(e) = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &reply).await {
                                    ulog_warn!("[im-cmd] send_message (/new success) failed: {}", e);
                                }
                            }
                            Err(e) => {
                                if let Err(e2) = send_immediate_reply(
                                    adapter_for_reply.as_ref(),
                                    &msg,
                                    &format!("❌ 创建失败: {}", e),
                                ).await {
                                    ulog_warn!("[im-cmd] send_message (/new error) failed: {}", e2);
                                }
                            }
                        }
                        continue;
                    }

                    if command == Some("/status") {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let (peer, client) = { let router = router_clone.lock().await; (router.peer_session_snapshot(&session_key), router.http_client().clone()) };
                        let reply = match peer {
                            Some(peer) => model_commands::read_status(&client, &manager_clone, &peer).await.unwrap_or_else(|error| format!("无法读取当前会话状态：{error}")),
                            None => "当前尚未建立会话。发送消息开始对话，或发送 /model 选择模型。".into(),
                        };
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        if let Err(e) = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &reply).await {
                            ulog_warn!("[im-cmd] send_message (/status) failed: {}", e);
                        }
                        continue;
                    }

                    if command == Some("/model") {
                        let arg = text.split_once(char::is_whitespace).map(|(_, arg)| arg.trim()).unwrap_or("");
                        let link = agent_link_for_loop.read().await.clone();
                        let Some(link) = link else {
                            let _ = send_immediate_reply(adapter_for_reply.as_ref(), &msg, "当前渠道未绑定 Agent，无法选择模型。").await;
                            continue;
                        };
                        let (client, session_id, workspace) = {
                            let router = router_clone.lock().await;
                            (router.http_client().clone(), router.get_peer_session(&session_key).filter(|peer| peer.metadata_indexed).map(|peer| peer.session_id.clone()), router.peer_session_workspace(&session_key).unwrap_or_else(|| router.default_workspace_path()).to_string_lossy().to_string())
                        };
                        if arg.is_empty() {
                            if session_id.is_some() {
                                let lock = { let mut locks = peer_locks_for_loop.lock().await; locks.entry(session_key.clone()).or_insert_with(|| Arc::new(Mutex::new(()))).clone() };
                                let fence = lock.lock().await;
                                let result = model_commands::ensure_peer_snapshot(&router_clone, &health_clone, &manager_clone, &session_key).await;
                                drop(fence);
                                if let Err(error) = result {
                                    let _ = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &error).await;
                                    continue;
                                }
                            }
                            match model_commands::read_menu(&client, &manager_clone, &link.agent_id, session_id.as_deref()).await {
                                Ok((menu, reply)) => {
                                    if send_immediate_reply(adapter_for_reply.as_ref(), &msg, &reply).await.is_ok() { model_menus.insert(session_key.clone(), menu); }
                                }
                                Err(error) => { let _ = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &error).await; }
                            }
                        } else {
                            let result = match model_menus.get(&session_key).cloned() {
                                Some(menu) => match model_commands::resolve_menu_option(&menu, arg) {
                                    Ok(option) => model_commands::select_model(model_commands::SelectionContext {
                                        app: &app_clone, manager: &manager_clone, router: &router_clone, health: &health_clone,
                                        peer_locks: &peer_locks_for_loop, session_key: &session_key, agent_id: &link.agent_id,
                                        channel_id: &link.channel_id, workspace: &workspace,
                                    }, &menu, &option).await,
                                    Err(error) => Err(error),
                                },
                                None => Err("请先发送 /model 查看列表，再按序号选择模型。".to_string()),
                            };
                            model_menus.remove(&session_key);
                            let reply = result.unwrap_or_else(|error| format!("模型操作未完全成功：{error}"));
                            let _ = send_immediate_reply(adapter_for_reply.as_ref(), &msg, &reply).await;
                        }
                        continue;
                    }

                    // ── Text-based approval commands (fallback for platforms without card callbacks) ──
                    let approval_decision = match text.as_str() {
                        "允许" | "同意" | "approve" => Some("allow_once"),
                        "始终允许" | "始终同意" | "always approve" => Some("always_allow"),
                        "拒绝" | "deny" => Some("deny"),
                        _ => None,
                    };
                    if let Some(decision) = approval_decision {
                        // Find the most recent pending approval for this chat
                        let pending_rid = {
                            let guard = pending_approvals_for_loop.lock().await;
                            guard.iter()
                                .find(|(_, p)| p.chat_id == chat_id)
                                .map(|(rid, _)| rid.clone())
                        };
                        if let Some(request_id) = pending_rid {
                            ulog_info!("[im] Text approval command: decision={}, rid={}", decision, &request_id[..request_id.len().min(16)]);
                            let _ = approval_tx_for_loop.send(ApprovalCallback {
                                request_id,
                                decision: decision.to_string(),
                                user_id: msg.sender_id.clone(),
                            }).await;
                            complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                            continue;
                        }
                        // No pending approval — fall through to regular message handling
                    }

                    // ── Text-based AskUserQuestion answers (fallback for free text / multi question) ──
                    let pending_question = {
                        let guard = pending_questions_for_loop.lock().await;
                        let mut matches = guard
                            .iter()
                            .filter(|(_, p)| {
                                p.chat_id == chat_id
                                    && !(matches!(p.source_type, ImSourceType::Group)
                                        && p.requester_user_id
                                            .as_deref()
                                            .is_some_and(|id| id != msg.sender_id))
                            })
                            .collect::<Vec<_>>();
                        matches.sort_by_key(|(_, p)| p.created_at);
                        if matches.len() > 1 {
                            ulog_warn!(
                                "[im] Multiple pending AskUserQuestion prompts in chat {}; routing text fallback to newest",
                                chat_id
                            );
                        }
                        matches.last().map(|(rid, p)| {
                            (rid.to_string(), p.questions.clone(), p.source_type.clone())
                        })
                    };
                    if let Some((request_id, questions, pending_source_type)) = pending_question {
                        match parse_question_text_answers(&questions, &pending_source_type, &text) {
                            Ok(answers) => {
                                let has_secret = questions.iter().any(|q| q.is_secret);
                                if has_secret {
                                    let _ = send_immediate_reply(
                                        adapter_for_reply.as_ref(),
                                        &msg,
                                        "本次提问包含敏感输入，IM 渠道暂不支持安全收集，已取消。请在桌面端继续。",
                                    )
                                    .await;
                                } else {
                                    complete_immediate_without_reply(
                                        adapter_for_reply.as_ref(),
                                        &msg,
                                    )
                                    .await;
                                }
                                let _ = question_tx_for_loop
                                    .send(QuestionCallback {
                                        request_id,
                                        answers,
                                        user_id: msg.sender_id.clone(),
                                    })
                                    .await;
                                continue;
                            }
                            Err(e) => {
                                let _ = send_immediate_reply(
                                    adapter_for_reply.as_ref(),
                                    &msg,
                                    &format!("答案格式不正确：{}\n请重新回复，或回复「取消」结束本次提问。", e),
                                )
                                .await;
                                continue;
                            }
                        }
                    }

                    // ── Access control ──────────
                    // All platforms (including Bridge/OpenClaw) go through the Rust
                    // whitelist. Bridge plugins use dmPolicy=open at the plugin level;
                    // actual access control is enforced here via BIND_xxx + allowedUsers.
                    let is_bridge_platform = matches!(msg.platform, ImPlatform::OpenClaw(_));

                    // Private message whitelist check for Bridge platforms
                    // (Bridge plugins use dmPolicy=open, access control is at Rust layer)
                    if msg.source_type == ImSourceType::Private && is_bridge_platform {
                        let is_allowed = {
                            let users = allowed_users_for_loop.read().await;
                            users.is_empty() || users.contains(&msg.sender_id)
                        };
                        if !is_allowed {
                            ulog_info!("[im] Bridge private message from {} blocked (not in allowedUsers)", msg.sender_id);
                            complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                            continue;
                        }
                    }

                    if msg.source_type == ImSourceType::Group {
                        // Bridge group auto-discovery: when a Bridge plugin delivers a group
                        // message for an unknown group, auto-create a Pending permission entry.
                        // Native adapters discover groups via platform events (my_chat_member etc.),
                        // but Bridge/OpenClaw plugins have no equivalent lifecycle event.
                        if is_bridge_platform {
                            // Match by group_id OR group_name (handles chatId format migration:
                            // old records have group_id=ou_xxx, new format uses oc_xxx)
                            let known = group_permissions_for_loop.read().await
                                .iter().any(|g| g.group_id == msg.chat_id || g.group_name == msg.chat_id);
                            if !known {
                                ulog_info!("[im] Bridge group auto-discovery: {} ({})", msg.chat_id, msg.hint_group_name.as_deref().unwrap_or("?"));
                                // try_send (not send().await) — sender and receiver share the same
                                // select! loop; .await could deadlock if the channel is full.
                                let _ = group_event_tx_for_loop.try_send(GroupEvent::BotAdded {
                                    chat_id: msg.chat_id.clone(),
                                    chat_title: msg.hint_group_name.clone()
                                        .unwrap_or_else(|| msg.chat_id.clone()),
                                    platform: msg.platform.clone(),
                                    added_by_name: msg.sender_name.clone(),
                                });
                            }
                        }

                        // Check if sender is a whitelisted user OR group is approved
                        let is_allowed_user = {
                            let users = allowed_users_for_loop.read().await;
                            users.contains(&msg.sender_id)
                        };
                        let group_approved = {
                            let perms = group_permissions_for_loop.read().await;
                            perms.iter().any(|g| g.group_id == msg.chat_id && g.status == GroupPermissionStatus::Approved)
                        };

                        if !is_allowed_user && !group_approved {
                            // Buffer history even for unapproved groups so AI has context
                            // when the group is eventually approved or an allowedUser @triggers.
                            // Log so operators can tell this from a silent route drop.
                            ulog_info!(
                                "[im] Group message buffered (unapproved group, sender not in allowedUsers): chat_id={}, sender={}, platform={:?}",
                                msg.chat_id, msg.sender_id, msg.platform,
                            );
                            group_history_for_loop.lock().await.push(
                                &session_key,
                                GroupHistoryEntry {
                                    sender_name: msg.sender_name.clone().unwrap_or_else(|| msg.sender_id.clone()),
                                    text: msg.text.clone(),
                                    timestamp: chrono::Local::now(),
                                },
                            );
                            complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                            continue;
                        }

                        // Trigger check: in Mention mode, non-triggered messages go to history buffer
                        // Exception: plugin slash commands bypass mention gate (like built-in /help /model)
                        let is_plugin_command = is_bridge_platform && matches!(
                            adapter_for_reply.as_ref(),
                            AnyAdapter::Bridge(bridge) if bridge.match_command(&text).is_some()
                        );
                        let activation = group_activation_for_loop.read().await.clone();
                        if activation == GroupActivation::Mention && !msg.is_mention && !is_plugin_command {
                            // Mention-mode gate: log so a missing IsMention from a bridge
                            // plugin (the 0.2.16 wecom group bug) is diagnosable from
                            // unified-log alone instead of requiring source dives.
                            ulog_info!(
                                "[im] Group message buffered (Mention mode, not @-mentioned): chat_id={}, sender={}, platform={:?}, is_mention={}",
                                msg.chat_id, msg.sender_id, msg.platform, msg.is_mention,
                            );
                            group_history_for_loop.lock().await.push(
                                &session_key,
                                GroupHistoryEntry {
                                    sender_name: msg.sender_name.clone().unwrap_or_else(|| msg.sender_id.clone()),
                                    text: msg.text.clone(),
                                    timestamp: chrono::Local::now(),
                                },
                            );
                            complete_immediate_without_reply(adapter_for_reply.as_ref(), &msg).await;
                            continue;
                        }
                    }

                    // ── Regular message → spawn concurrent task ──────────
                    ulog_info!(
                        "[im] Routing message from {} to Sidecar (session_key={}, {} chars)",
                        msg.sender_name.as_deref().unwrap_or("?"),
                        session_key,
                        text.len(),
                    );

                    // Bridge plugin commands: check if text matches a registered command
                    // Must be checked AFTER standard commands (/help, /model, etc.)
                    if is_bridge_platform {
                        if let AnyAdapter::Bridge(ref bridge) = *adapter_for_reply {
                            if let Some((cmd_name, cmd_args)) = bridge.match_command(&text) {
                                ulog_info!("[im] Plugin command /{} from {} (args: {:?})", cmd_name, msg.sender_id, cmd_args);
                                let bridge_clone = adapter_for_reply.clone();
                                let chat_id_clone = chat_id.clone();
                                let sender_id = msg.sender_id.clone();
                                let command_msg = msg.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let AnyAdapter::Bridge(ref b) = *bridge_clone {
                                        match b.execute_command(&cmd_name, &cmd_args, &sender_id, &chat_id_clone).await {
                                            Ok(result) => {
                                                let _ = send_immediate_reply(
                                                    bridge_clone.as_ref(),
                                                    &command_msg,
                                                    &result,
                                                ).await;
                                            }
                                            Err(e) => {
                                                let _ = send_immediate_reply(
                                                    bridge_clone.as_ref(),
                                                    &command_msg,
                                                    &format!("❌ 命令执行失败: {}", e),
                                                ).await;
                                            }
                                        }
                                    }
                                });
                                continue;
                            }
                        }
                    }

                    let Some(active_work_guard) = model_work_gate_for_loop.try_enter() else {
                        let _ = abort_immediate_reply(
                            adapter_for_reply.as_ref(),
                            &msg,
                            "admission_closed",
                            "网络设置正在应用，请稍后重新发送。",
                        )
                        .await;
                        continue;
                    };

                    // Clone shared state for the spawned task
                    let task_router = Arc::clone(&router_clone);
                    let task_adapter = Arc::clone(&adapter_for_reply);
                    let task_app = app_clone.clone();
                    let task_manager = Arc::clone(&manager_clone);
                    let task_buffer = Arc::clone(&buffer_clone);
                    let task_health = Arc::clone(&health_clone);
                    let task_stream_client = stream_client.clone();
                    let task_sem = Arc::clone(&global_semaphore);
                    let task_locks = Arc::clone(&peer_locks_for_loop);
                    let task_pending_approvals = Arc::clone(&pending_approvals_for_loop);
                    let task_pending_questions = Arc::clone(&pending_questions_for_loop);
                    let task_bot_id = bot_id_for_loop.clone();
                    let task_bot_name = bot_name_for_loop.clone();
                    let task_group_history = Arc::clone(&group_history_for_loop);
                    let task_group_activation = Arc::clone(&group_activation_for_loop);
                    let task_group_tools_deny = Arc::clone(&group_tools_deny_for_loop);
                    let task_group_permissions = Arc::clone(&group_permissions_for_loop);
                    let task_agent_link = Arc::clone(&agent_link_for_loop);
                    let task_allowed_users = Arc::clone(&allowed_users_for_loop);
                    // Pattern C: per-peer-session ImEventConsumer + ReplyRouter registry
                    let task_consumers = Arc::clone(&im_consumers_for_loop);
                    let task_model_work_gate = Arc::clone(&model_work_gate_for_loop);

                    in_flight.spawn(async move {
                        let _active_work_guard = active_work_guard;
                        // Pattern A — Per-Request Identity: assign request_id at the dispatch
                        // boundary so every log line and downstream RPC carries the same trace
                        // ID. Empty default from adapters means "not yet assigned"; generate
                        // here. Buffered replays also start with empty → fresh ID per attempt
                        // (each retry is its own logical request).
                        let mut msg = msg;
                        if msg.request_id.is_empty() {
                            msg.request_id = uuid::Uuid::new_v4().to_string();
                        }
                        let request_id = msg.request_id.clone();
                        ulog_info!(
                            "[im] Dispatch requestId={} session_key={} sender={} chars={}",
                            request_id,
                            session_key,
                            msg.sender_name.as_deref().unwrap_or("?"),
                            msg.text.len(),
                        );

                        // 1. Acquire per-peer lock FIRST (serialize requests to same Sidecar).
                        let peer_lock = {
                            let mut locks = task_locks.lock().await;
                            locks
                                .entry(session_key.clone())
                                .or_insert_with(|| Arc::new(Mutex::new(())))
                                .clone()
                        };
                        let _peer_guard = peer_lock.lock().await;

                        // 2. Acquire global semaphore (rate limit across all peers)
                        let _permit = match task_sem.clone().acquire_owned().await {
                            Ok(p) => p,
                            Err(_) => {
                                ulog_error!("[im] Semaphore closed");
                                let _ = abort_immediate_reply(
                                    task_adapter.as_ref(),
                                    &msg,
                                    "admission_failed",
                                    "消息处理暂不可用，请稍后重试。",
                                )
                                .await;
                                return;
                            }
                        };

                        // 3. ACK + typing indicator
                        task_adapter.ack_processing(&chat_id, &message_id).await;
                        task_adapter.send_typing(&chat_id).await;


                        if let Err(error) = model_commands::ensure_peer_snapshot(&task_router, &task_health, &task_manager, &session_key).await {
                            let _ = abort_immediate_reply(task_adapter.as_ref(), &msg, "session_snapshot_unavailable", &error).await;
                            return;
                        }

                        // 4. Ensure Sidecar is running (brief router lock)
                        let (port, _is_new_sidecar) = match task_router
                            .lock()
                            .await
                            .ensure_sidecar_with_runtime_identity(
                                &session_key,
                                &task_app,
                                &task_manager,
                                None,
                                None,
                            )
                            .await
                        {
                            Ok(result) => result,
                            Err(e) => {
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                let _ = abort_immediate_reply(
                                    task_adapter.as_ref(),
                                    &msg,
                                    "sidecar_start_failed",
                                    &format!("⚠️ {}", e),
                                )
                                .await;
                                return;
                            }
                        };
                        {
                            let mut router_guard = task_router.lock().await;
                            router_guard.update_peer_metadata_from_message(&session_key, &msg);
                        }
                        let _ = health::persist_router_active_sessions(
                            &task_health,
                            &task_router,
                            "message-ensure-sidecar",
                        )
                        .await;

                        // C2 fix order: build on_terminal + ensure_im_consumer FIRST so the
                        // consumer is established with the real callback. Buffer drain (Pattern E)
                        // and the current-message register/enqueue then reuse this consumer
                        // — no risk of a no-op `on_terminal` poisoning the peer-session.
                        let sidecar_session_id_initial = task_router
                            .lock()
                            .await
                            .get_peer_session(&session_key)
                            .map(|p| p.session_id.clone())
                            .unwrap_or_else(|| session_key.clone());
                        // Capture the sidecar generation at this exact moment so
                        // ensure_im_consumer can detect drift (sidecar removed +
                        // recreated under same session_id between here and the
                        // consumer-insert step). Generation is the global
                        // monotonic instance ID — `None` means no sidecar is
                        // currently bound to this session_id (unexpected since
                        // ensure_sidecar just succeeded, but possible under a
                        // tight race). We pass 0 in that case which can never
                        // match `is_live()`, so ensure_im_consumer aborts and
                        // the next message retries.
                        let sidecar_generation_initial = task_manager
                            .lock()
                            .unwrap()
                            .generation_for(&sidecar_session_id_initial)
                            .unwrap_or(0);
                        let on_terminal: Arc<dyn Fn(String, reply_router::TerminalOutcome) + Send + Sync> = {
                            let router = Arc::clone(&task_router);
                            let app = task_app.clone();
                            let health = Arc::clone(&task_health);
                            let agent_link = Arc::clone(&task_agent_link);
                            let session_key_cap = session_key.clone();
                            let admitted_session_id = sidecar_session_id_initial.clone();
                            let source_type_cap = msg.source_type.clone();
                            let model_work_gate = Arc::clone(&task_model_work_gate);
                            Arc::new(move |req_id: String, _outcome: reply_router::TerminalOutcome| {
                                let terminal_work_guard = model_work_gate.begin_handoff();
                                let router = Arc::clone(&router);
                                let app = app.clone();
                                let health = Arc::clone(&health);
                                let agent_link = Arc::clone(&agent_link);
                                let session_key = session_key_cap.clone();
                                let admitted_session_id = admitted_session_id.clone();
                                let source_type = source_type_cap.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _terminal_work_guard = terminal_work_guard;
                                    {
                                        let mut router_g = router.lock().await;
                                        if !router_g.record_response_if_bound(
                                            &session_key,
                                            &admitted_session_id,
                                        ) {
                                            ulog_info!(
                                                "[im] Ignored stale terminal for peer {} admitted_session={} after binding rotation",
                                                session_key,
                                                short_session_id(&admitted_session_id),
                                            );
                                        }
                                    }
                                    health.set_last_message_at(chrono::Utc::now().to_rfc3339()).await;
                                    let _ = health::persist_router_active_sessions(
                                        &health,
                                        &router,
                                        "message-terminal",
                                    )
                                    .await;
                                    {
                                        let link_guard = agent_link.read().await;
                                        if link_guard.is_some() {
                                            let _ = app.emit("agent:status-changed", json!({ "event": "sessions_updated" }));
                                        } else {
                                            let _ = app.emit("im:status-changed", json!({ "event": "sessions_updated" }));
                                        }
                                    }
                                    {
                                        let link_guard = agent_link.read().await;
                                        if let Some(ref link) = *link_guard {
                                            let now_str = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                                            let new_lac = LastActiveChannel {
                                                channel_id: link.channel_id.clone(),
                                                session_key: session_key.clone(),
                                                last_active_at: now_str.clone(),
                                            };
                                            *link.last_active_channel.write().await = Some(new_lac);
                                            if source_type == ImSourceType::Private {
                                                let new_private_target = LastActivePrivateTarget {
                                                    channel_id: link.channel_id.clone(),
                                                    session_key: session_key.clone(),
                                                    last_active_at: now_str.clone(),
                                                };
                                                *link.last_active_private_target.write().await =
                                                    Some(new_private_target);
                                                ulog_debug!(
                                                    "[agent] Updated lastActivePrivateTarget: agent={}, channel={}, session={} requestId={}",
                                                    link.agent_id, link.channel_id, session_key, req_id,
                                                );
                                            }
                                            ulog_debug!(
                                                "[agent] Updated lastActiveChannel: agent={}, channel={}, session={} requestId={}",
                                                link.agent_id, link.channel_id, session_key, req_id,
                                            );
                                        }
                                    }
                                });
                            })
                        };
                        let reply_router_arc = match ensure_im_consumer(
                            &task_consumers,
                            &task_manager,
                            &session_key,
                            port,
                            &sidecar_session_id_initial,
                            sidecar_generation_initial,
                            request_id.clone(),
                            Arc::clone(&task_adapter),
                            Arc::clone(&task_pending_approvals),
                            Arc::clone(&task_pending_questions),
                            task_stream_client.clone(),
                            on_terminal,
                        )
                        .await
                        {
                            Some(router) => router,
                            None => {
                                // Sidecar identity captured by this task is no
                                // longer live (removed during the gap, or
                                // upgrade_session_id rotated the key). Buffer the
                                // current message so the next round-trip — which
                                // will run a fresh ensure_sidecar +
                                // ensure_im_consumer with the new identity —
                                // can replay it. Re-buffering is the correct
                                // recovery: we have an in-hand IM message but no
                                // working consumer registry entry to attach a
                                // ReplySlot to; proceeding with register+enqueue
                                // would either leak the slot (if enqueue happened
                                // to succeed against a recreated sidecar that no
                                // consumer is listening to) or surface a
                                // confusing "send failed" to the user when the
                                // sidecar is actually fine.
                                ulog_warn!(
                                    "[im] Re-buffering message for session_key={} requestId={} — sidecar identity drift detected at consumer-ensure",
                                    session_key, request_id,
                                );
                                if uses_openclaw_reply_protocol(&msg) {
                                    let _ = abort_immediate_reply(
                                        task_adapter.as_ref(),
                                        &msg,
                                        "consumer_identity_changed",
                                        "会话连接已变化，请重新发送。",
                                    )
                                    .await;
                                } else {
                                    task_buffer.lock().await.push(&msg);
                                }
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                return;
                            }
                        };

                        // Pattern E: drain previously-buffered messages for this session_key
                        // before processing the current one. Now reuses the consumer
                        // established above — buffer-replayed requests get the same
                        // on_terminal callback as live ones.
                        {
                            let drain_count = task_buffer.lock().await.len_for_session(&session_key);
                            for _ in 0..drain_count {
                                let buffered = match task_buffer.lock().await.pop_for_session(&session_key) {
                                    Some(b) => b,
                                    None => break,
                                };
                                let mut buf_msg = buffered.to_im_message();
                                if buf_msg.request_id.is_empty() {
                                    buf_msg.request_id = uuid::Uuid::new_v4().to_string();
                                }
                                let buf_chat_id = buf_msg.chat_id.clone();
                                let buf_message_id = buf_msg.message_id.clone();
                                let buf_request_id = buf_msg.request_id.clone();
                                let allowed_snapshot_buf = task_allowed_users.read().await.clone();
                                let bridge_ctx_buf = task_adapter.bridge_context();

                                reply_router_arc.lock().await.register(
                                    buf_request_id.clone(),
                                    buf_chat_id.clone(),
                                    buf_message_id.clone(),
                                    buf_msg.source_type.clone(),
                                    Some(buf_msg.sender_id.clone()),
                                    None,
                                    buf_msg.delivery_protocol.clone(),
                                );

                                let buf_metadata_birth_pending = task_router
                                    .lock()
                                    .await
                                    .metadata_birth_pending(&session_key);
                                let result = enqueue_to_sidecar(
                                    &task_stream_client,
                                    port,
                                    &buf_msg,
                                    None,
                                    Some(&task_bot_id),
                                    task_bot_name.as_deref(),
                                    None,
                                    buf_metadata_birth_pending,
                                    Some(&allowed_snapshot_buf),
                                    bridge_ctx_buf,
                                )
                                .await;
                                match result {
                                    Ok(_) => {
                                        let birth_consumed = {
                                            let mut router_guard = task_router.lock().await;
                                            router_guard.mark_metadata_birth_consumed_if_session(
                                                &session_key,
                                                &sidecar_session_id_initial,
                                            )
                                        };
                                        if birth_consumed {
                                            let _ = health::persist_router_active_sessions(
                                                &task_health,
                                                &task_router,
                                                "buffer-replay-birth-consumed",
                                            )
                                            .await;
                                        }
                                        ulog_info!(
                                            "[im] Replayed buffered requestId={} session_key={}",
                                            buf_request_id, session_key,
                                        );
                                    }
                                    Err(e) => {
                                        ulog_warn!(
                                            "[im] Buffer replay failed requestId={} session_key={} err={}",
                                            buf_request_id, session_key, e,
                                        );
                                        reply_router_arc.lock().await.unregister(&buf_request_id);
                                        if e.should_buffer() {
                                            task_buffer.lock().await.push(&buf_msg);
                                        }
                                        break;
                                    }
                                }
                            }
                        }

                        // 4c. Process attachments (File → save to workspace, Image → base64)
                        // (msg is already declared `mut` at spawn entry for request_id assignment)
                        let workspace_path = {
                            let router = task_router.lock().await;
                            router
                                .peer_session_workspace(&session_key)
                                .unwrap_or_else(|| router.default_workspace().clone())
                        };
                        let image_payloads = if !msg.attachments.is_empty() {
                            process_attachments(&mut msg, &workspace_path).await
                        } else {
                            Vec::new()
                        };

                        // 4d. Group context injection (v0.1.28)
                        let group_ctx = if msg.source_type == ImSourceType::Group {
                            // Drain pending history
                            let history = task_group_history.lock().await.drain(&session_key);
                            let pending_history = GroupHistoryBuffer::format_as_context(&history);
                            // Check if this is the first turn for this group session
                            let (is_first_turn, message_count) = {
                                let router = task_router.lock().await;
                                let ps = router.get_peer_session(&session_key);
                                (ps.map_or(true, |p| p.message_count == 0),
                                 ps.map_or(0, |p| p.message_count))
                            };
                            let activation = task_group_activation.read().await.clone();
                            let tools_deny = task_group_tools_deny.read().await.clone();
                            // Get group name: 1) group_permissions config, 2) Bridge hint, 3) chat_id fallback
                            let group_name = {
                                let perms = task_group_permissions.read().await;
                                perms.iter()
                                    .find(|g| g.group_id == msg.chat_id)
                                    .map(|g| g.group_name.clone())
                                    .or_else(|| msg.hint_group_name.clone())
                                    .unwrap_or_else(|| msg.chat_id.clone())
                            };
                            Some(GroupStreamContext {
                                group_name,
                                platform: msg.platform.clone(),
                                activation,
                                is_first_turn,
                                pending_history,
                                tools_deny,
                                is_mention: msg.is_mention,
                                message_count,
                            })
                        } else {
                            None
                        };

                        // 5. Pre-register the ReplySlot for this requestId. Consumer was
                        //    already established earlier (before buffer drain) with the
                        //    real on_terminal callback; we just reuse `reply_router_arc`.
                        {
                            let mut router_guard = reply_router_arc.lock().await;
                            router_guard.register(
                                request_id.clone(),
                            chat_id.clone(),
                            message_id.clone(),
                            msg.source_type.clone(),
                            Some(msg.sender_id.clone()),
                            group_ctx.as_ref(),
                            msg.delivery_protocol.clone(),
                        );
                        }

                        // 7. POST /api/im/enqueue — sync ACK, ms-level. peer_lock drops at end
                        //    of spawn, so concurrent same-chat messages no longer wait on each
                        //    other through the entire turn.
                        let images = if image_payloads.is_empty() {
                            None
                        } else {
                            Some(&image_payloads)
                        };
                        let metadata_birth_pending = task_router
                            .lock()
                            .await
                            .metadata_birth_pending(&session_key);
                        let allowed_snapshot = task_allowed_users.read().await.clone();
                        let bridge_ctx = task_adapter.bridge_context();
                        match enqueue_to_sidecar(
                            &task_stream_client,
                            port,
                            &msg,
                            images,
                            Some(&task_bot_id),
                            task_bot_name.as_deref(),
                            group_ctx.as_ref(),
                            metadata_birth_pending,
                            Some(&allowed_snapshot),
                            bridge_ctx,
                        )
                        .await
                        {
                            Ok(_session_hint) => {
                                let birth_consumed = {
                                    let mut router_guard = task_router.lock().await;
                                    router_guard.mark_metadata_birth_consumed_if_session(
                                        &session_key,
                                        &sidecar_session_id_initial,
                                    )
                                };
                                if birth_consumed {
                                    let _ = health::persist_router_active_sessions(
                                        &task_health,
                                        &task_router,
                                        "message-birth-consumed",
                                    )
                                    .await;
                                }
                                ulog_info!(
                                    "[im] Enqueued requestId={} session_key={}",
                                    request_id, session_key,
                                );
                            }
                            Err(e) => {
                                ulog_error!(
                                    "[im] Enqueue failed requestId={} session_key={} err={}",
                                    request_id, session_key, e,
                                );
                                // Clean up reply slot — no events will arrive for this request
                                reply_router_arc.lock().await.unregister(&request_id);
                                // Buffer for retry on transient errors
                                if e.should_buffer() && !uses_openclaw_reply_protocol(&msg) {
                                    task_buffer.lock().await.push(&msg);
                                }
                                let e_str = format!("{}", e);
                                let user_msg = if e_str.starts_with("Sidecar returned ") {
                                    let inner = e_str.splitn(2, ": ").nth(1).unwrap_or(&e_str);
                                    format!("⚠️ {}", inner)
                                } else {
                                    format!("⚠️ {}", e)
                                };
                                let _ = abort_immediate_reply(
                                    task_adapter.as_ref(),
                                    &msg,
                                    "sidecar_enqueue_failed",
                                    &user_msg,
                                )
                                .await;
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                drop(_permit);
                                drop(_peer_guard);
                                drop(peer_lock);
                                return;
                            }
                        };

                        // Update buffer count snapshot for health (cheap; no replay loop now)
                        task_health
                            .set_buffered_messages(task_buffer.lock().await.len())
                            .await;

                        // 8. Cleanup: release guards. peer_lock release here means concurrent
                        //    same-chat messages can now interleave — Bug 1 (60min serialization)
                        //    is gone. Stale peer_lock entries get reaped lazily.
                        drop(_permit);
                        drop(_peer_guard);
                        drop(peer_lock);
                        {
                            let mut locks = task_locks.lock().await;
                            if let Some(lock_arc) = locks.get(&session_key) {
                                if Arc::strong_count(lock_arc) == 1 {
                                    locks.remove(&session_key);
                                }
                            }
                        }
                    });
                }
                // Handle group lifecycle events (bot added/removed from groups)
                Some(event) = group_event_rx.recv() => {
                    match event {
                        GroupEvent::BotAdded { chat_id, chat_title, platform, added_by_name } => {
                            ulog_info!("[im] Group event: BotAdded to {} ({})", chat_title, chat_id);
                            // Create pending GroupPermission
                            let perm = GroupPermission {
                                group_id: chat_id.clone(),
                                group_name: chat_title.clone(),
                                platform: platform.clone(),
                                status: GroupPermissionStatus::Pending,
                                discovered_at: chrono::Utc::now().to_rfc3339(),
                                added_by: added_by_name.clone(),
                            };
                            {
                                let mut perms = group_permissions_for_loop.write().await;
                                // Dedup: skip if group already known (Approved or Pending).
                                // Also match by group_name to handle the chatId format migration
                                // (pre-fix: group_id=ou_xxx from ctx.From, post-fix: group_id=oc_xxx from ctx.To).
                                if let Some(existing) = perms.iter_mut().find(|g| g.group_id == chat_id || g.group_name == chat_id) {
                                    // If found by group_name (old format), update group_id to the correct value
                                    if existing.group_id != chat_id {
                                        ulog_info!("[im] Group {} migrating group_id: {} -> {}", chat_title, existing.group_id, chat_id);
                                        existing.group_id = chat_id.clone();
                                    } else {
                                        ulog_info!("[im] Group {} already known, skipping BotAdded", chat_id);
                                    }
                                    continue;
                                }
                                perms.push(perm.clone());
                            }
                            // Persist to config.json
                            let bid = bot_id_for_loop.clone();
                            let new_perms = group_permissions_for_loop.read().await.clone();
                            tokio::task::spawn_blocking(move || {
                                let patch = BotConfigPatch {
                                    group_permissions: Some(new_perms),
                                    ..Default::default()
                                };
                                if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                    ulog_warn!("[im] Failed to persist group permission: {}", e);
                                }
                            });
                            // Send prompt message to group
                            let bot_name = health_clone.get_state().await.bot_username
                                .unwrap_or_else(|| "AI 助手".to_string());
                            let prompt_msg = format!(
                                "👋 你好！我是 {}。\n群聊授权申请已发送至管理员，授权后即可使用。\n已绑定的用户可直接 @我 提问。",
                                bot_name,
                            );
                            if let Err(e) = adapter_for_reply.send_message(&chat_id, &prompt_msg).await {
                                ulog_warn!("[im-cmd] send_message (group auth prompt) failed: {}", e);
                            }
                            // Emit Tauri events
                            let _ = app_clone.emit("im:group-permission-changed", json!({
                                "botId": bot_id_for_loop,
                                "event": "added",
                                "groupName": chat_title,
                            }));
                            let _ = app_clone.emit("im:bot-config-changed", json!({
                                "botId": bot_id_for_loop,
                            }));
                        }
                        GroupEvent::BotRemoved { chat_id, platform: _ } => {
                            ulog_info!("[im] Group event: BotRemoved from {}", chat_id);
                            // Remove group permission record
                            {
                                let mut perms = group_permissions_for_loop.write().await;
                                perms.retain(|g| g.group_id != chat_id);
                            }
                            // Clean up group history
                            {
                                let session_key = format!("im:{}:group:{}", platform_for_loop, chat_id);
                                group_history_for_loop.lock().await.clear(&session_key);
                            }
                            // Persist
                            let bid = bot_id_for_loop.clone();
                            let new_perms = group_permissions_for_loop.read().await.clone();
                            tokio::task::spawn_blocking(move || {
                                let patch = BotConfigPatch {
                                    group_permissions: Some(new_perms),
                                    ..Default::default()
                                };
                                if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                    ulog_warn!("[im] Failed to persist group removal: {}", e);
                                }
                            });
                            let _ = app_clone.emit("im:group-permission-changed", json!({
                                "botId": bot_id_for_loop,
                                "event": "removed",
                            }));
                            let _ = app_clone.emit("im:bot-config-changed", json!({
                                "botId": bot_id_for_loop,
                            }));
                        }
                    }
                }
                // Drain completed tasks (handle panics)
                Some(result) = in_flight.join_next(), if !in_flight.is_empty() => {
                    if let Err(e) = result {
                        ulog_error!("[im] Message task panicked: {}", e);
                    }
                }
                // Flush expired media groups
                _ = tokio::time::sleep(flush_timeout) => {
                    let expired_keys: Vec<String> = media_groups
                        .iter()
                        .filter(|(_, entry)| entry.first_received.elapsed() >= MEDIA_GROUP_TIMEOUT)
                        .map(|(k, _)| k.clone())
                        .collect();

                    for group_id in expired_keys {
                        if let Some(entry) = media_groups.remove(&group_id) {
                            let merged = merge_media_group(entry.messages);
                            ulog_info!(
                                "[im] Flushed media group {} ({} attachments)",
                                group_id,
                                merged.attachments.len(),
                            );
                            // Re-inject merged message into the channel
                            if msg_tx_for_reinjection.send(merged).await.is_err() {
                                ulog_error!("[im] Failed to re-inject merged media group");
                            }
                        }
                    }
                }
                _ = process_shutdown_rx.changed() => {
                    if *process_shutdown_rx.borrow() {
                        ulog_info!(
                            "[im] Processing loop shutting down, waiting for {} in-flight task(s)",
                            in_flight.len(),
                        );
                        // C3 fix: cancel all ImEventConsumer tasks before exiting.
                        // Tokio JoinHandles don't auto-cancel on drop — without
                        // explicitly flipping `cancel: AtomicBool`, the long-poll
                        // loops would keep reconnecting against a dead Sidecar port.
                        {
                            let consumers = im_consumers_for_loop.lock().await;
                            for (key, handle) in consumers.iter() {
                                handle.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                                ulog_debug!("[im] Cancelled ImEventConsumer for {} on shutdown", key);
                            }
                        }
                        // Drain remaining in-flight tasks before exiting
                        while let Some(result) = in_flight.join_next().await {
                            if let Err(e) = result {
                                ulog_error!("[im] Task panicked during shutdown: {}", e);
                            }
                        }
                        break;
                    }
                }
            }
        }
    });

    // Start idle session collector
    let router_for_idle = Arc::clone(&router);
    let manager_for_idle = Arc::clone(sidecar_manager);
    let app_for_idle = app_handle.clone();
    let mut idle_shutdown_rx = shutdown_rx.clone();
    let agent_id_for_idle = agent_id.clone();
    let consumers_for_idle = Arc::clone(&im_consumers);

    let _idle_handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let collected_keys = router_for_idle
                        .lock()
                        .await
                        .collect_idle_sessions(&manager_for_idle)
                        .await;
                    // C3 fix: cancel ImEventConsumer for each collected session.
                    // The Sidecar port has been released to 0; the long-poll loop
                    // would otherwise hammer the dead port until backoff cap.
                    for key in &collected_keys {
                        drop_im_consumer(&consumers_for_idle, key).await;
                    }
                    let collected = collected_keys.len();
                    if collected > 0 {
                        // Notify UI — agent channels emit agent event, legacy emit im event
                        if agent_id_for_idle.is_some() {
                            let _ = app_for_idle.emit("agent:status-changed", json!({ "event": "sessions_collected" }));
                        } else {
                            let _ = app_for_idle.emit("im:status-changed", json!({ "event": "sessions_collected" }));
                        }
                    }
                }
                _ = idle_shutdown_rx.changed() => {
                    if *idle_shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });

    let started_at = Instant::now();

    // Build status (include bind URL for QR code flow / bind code for text bind)
    let bot_username_for_url = health.get_state().await.bot_username.clone();
    let (bind_url, bind_code_for_status) = match config.platform {
        ImPlatform::Telegram => {
            let url = bot_username_for_url
                .as_ref()
                .map(|u| format!("https://t.me/{}?start={}", u, bind_code));
            (url, None)
        }
        ImPlatform::Feishu => (None, Some(bind_code.clone())),
        ImPlatform::Dingtalk => (None, Some(bind_code.clone())),
        ImPlatform::OpenClaw(_) => (None, Some(bind_code.clone())),
    };

    let status = ImBotStatus {
        bot_username: bot_username_for_url.clone(),
        status: ImStatus::Online,
        uptime_seconds: 0,
        last_message_at: None,
        active_sessions: Vec::new(),
        error_message: None,
        restart_count: 0,
        buffered_messages: buffer.lock().await.len(),
        bind_url,
        bind_code: bind_code_for_status,
    };

    // ===== Cron event pending vec (v0.2.4) =====
    // Truth source for cron→IM hand-off (see ImBotInstance.pending_cron_events
    // doc). Initialized empty; populated by `deliver_cron_result_to_bot`,
    // drained by the heartbeat runner once IM push succeeds. Both sides hold
    // the same Arc — the runner gets a clone below, the bot instance keeps
    // its own clone for cron-deliver lookups.
    let pending_cron_events =
        carried_pending_cron_events.unwrap_or_else(|| Arc::new(Mutex::new(Vec::new())));

    // ===== Heartbeat Runner (v0.1.21) =====
    let (heartbeat_handle, heartbeat_wake_tx, heartbeat_config_arc) = {
        let hb_config = config.heartbeat_config.clone().unwrap_or_default();
        let hb_bot_label = bot_username_for_url
            .clone()
            .unwrap_or_else(|| bot_id.to_string());
        // Build the wake channel BEFORE the runner so we can hand the runner a
        // clone of the sender (used for self-cascade when more cron events
        // remain after a single-event run_once cycle).
        let (wake_tx, wake_rx) = mpsc::channel::<types::HeartbeatWake>(64);
        let (runner, config_arc) = heartbeat::HeartbeatRunner::new(
            hb_config,
            hb_bot_label,
            types::HostInteractionCapability::for_platform(&config.platform),
            Arc::clone(&pending_cron_events),
            Arc::clone(&model_work_gate),
            wake_tx.clone(),
        );

        let hb_shutdown_rx = shutdown_rx.clone();
        let hb_router = Arc::clone(&router);
        let hb_sidecar = Arc::clone(sidecar_manager);
        let hb_adapter = Arc::clone(&adapter);
        let hb_app = app_handle.clone();
        let hb_peer_locks = Arc::clone(&peer_locks);
        let hb_health = Arc::clone(&health);
        let hb_agent_id = agent_id.clone().unwrap_or_else(|| bot_id.to_string());
        let hb_workspace = default_workspace_str.clone();
        let handle = tauri::async_runtime::spawn(async move {
            runner
                .run_loop(
                    hb_shutdown_rx,
                    wake_rx,
                    hb_router,
                    hb_sidecar,
                    hb_adapter,
                    hb_app,
                    hb_peer_locks,
                    hb_health,
                    hb_agent_id,
                    hb_workspace,
                )
                .await;
        });

        // A reconnect carries the pending queue but replaces the old wake
        // channel. Seed the new runner so queued cron delivery cannot wait for
        // a disabled interval heartbeat.
        if let Some(wake) = pending_cron_events
            .lock()
            .await
            .first()
            .map(heartbeat::wake_for_pending_cron_event)
        {
            let _ = wake_tx.try_send(wake);
        }

        ulog_info!("[im] Heartbeat runner spawned for bot {}", bot_id);
        (Some(handle), Some(wake_tx), Some(config_arc))
    };

    // Build instance (caller is responsible for inserting into the appropriate container)
    let instance_platform = config.platform.clone();
    let instance = ImBotInstance {
        bot_id,
        platform: instance_platform,
        shutdown_tx,
        health: Arc::clone(&health),
        router,
        peer_locks,
        im_consumers,
        model_work_gate,
        buffer,
        started_at,
        process_handle,
        poll_handle,
        approval_handle,
        question_handle,
        health_handle,
        bind_code,
        config,
        heartbeat_handle,
        heartbeat_wake_tx,
        heartbeat_config: heartbeat_config_arc,
        pending_cron_events,
        adapter: Arc::clone(&adapter),
        // Hot-reloadable config (Arc clones shared with processing loop)
        current_model,
        current_provider_env,
        permission_mode,
        mcp_servers_json,
        runtime,
        runtime_config,
        allowed_users,
        // Group Chat (v0.1.28)
        group_permissions,
        group_activation,
        group_tools_deny,
        group_history,
        // OpenClaw Bridge process
        bridge_process: bridge_process_handle.map(tokio::sync::Mutex::new),
        // Sidecar-stop subscriber loop — held to bot lifecycle, exits when
        // shutdown_rx flips or broadcast Sender drops.
        sidecar_stop_handle,
        // Agent link (set after moving into AgentInstance)
        agent_link,
    };

    Ok((instance, status))
}

/// Start the IM Bot (thin wrapper over create_bot_instance for legacy callers).
pub async fn start_im_bot<R: Runtime>(
    app_handle: &AppHandle<R>,
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: String,
    config: ImConfig,
) -> Result<ImBotStatus, String> {
    let lifecycle_lock = legacy_bot_lifecycle_lock(&bot_id);
    let _lifecycle_guard = lifecycle_lock.lock().await;

    // Gracefully stop existing instance for this bot_id if running
    let existing = {
        let mut im_guard = im_state.lock().await;
        im_guard.remove(&bot_id)
    };
    let carried_pending_cron_events = existing
        .as_ref()
        .map(|instance| Arc::clone(&instance.pending_cron_events));
    if let Some(instance) = existing {
        ulog_info!("[im] Stopping existing IM Bot {} before restart", bot_id);
        let _ = shutdown_bot_instance(instance, sidecar_manager, &bot_id).await;
    }

    let creation_permit = crate::sidecar::begin_lifecycle_spawn_permit()?;
    let (instance, status) = create_bot_instance_with_pending_cron_events(
        app_handle,
        sidecar_manager,
        bot_id.clone(),
        config,
        None,
        carried_pending_cron_events,
        &creation_permit,
    )
    .await?;

    let mut im_guard = im_state.lock().await;
    im_guard.insert(bot_id, instance);

    Ok(status)
}

/// Stop the IM Bot (thin wrapper over shutdown_bot_instance).
pub async fn stop_im_bot(
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: &str,
) -> Result<(), String> {
    let lifecycle_lock = legacy_bot_lifecycle_lock(bot_id);
    let _lifecycle_guard = lifecycle_lock.lock().await;

    let instance = {
        let mut im_guard = im_state.lock().await;
        im_guard.remove(bot_id)
    };

    if let Some(instance) = instance {
        shutdown_bot_instance(instance, sidecar_manager, bot_id).await
    } else {
        ulog_debug!("[im] IM Bot {} was not running", bot_id);
        Ok(())
    }
}

/// Get current IM Bot status for a specific bot
pub async fn get_im_bot_status(im_state: &ManagedImBots, bot_id: &str) -> ImBotStatus {
    let im_guard = im_state.lock().await;

    if let Some(instance) = im_guard.get(bot_id) {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let (bind_url, bind_code_opt) = match instance.platform {
            ImPlatform::Telegram => {
                let url = status
                    .bot_username
                    .as_ref()
                    .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));
                (url, None)
            }
            ImPlatform::Feishu => (None, Some(instance.bind_code.clone())),
            ImPlatform::Dingtalk => (None, Some(instance.bind_code.clone())),
            ImPlatform::OpenClaw(_) => (None, Some(instance.bind_code.clone())),
        };

        ImBotStatus {
            bot_username: status.bot_username,
            status: status.status,
            uptime_seconds: status.uptime_seconds,
            last_message_at: status.last_message_at,
            active_sessions: status.active_sessions,
            error_message: status.error_message,
            restart_count: status.restart_count,
            buffered_messages: status.buffered_messages,
            bind_url,
            bind_code: bind_code_opt,
        }
    } else {
        ImBotStatus::default()
    }
}

/// Get status of all running bots
pub async fn get_all_bots_status(im_state: &ManagedImBots) -> HashMap<String, ImBotStatus> {
    let im_guard = im_state.lock().await;
    let mut result = HashMap::new();

    for (bot_id, instance) in im_guard.iter() {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let (bind_url, bind_code_opt) = match instance.platform {
            ImPlatform::Telegram => {
                let url = status
                    .bot_username
                    .as_ref()
                    .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));
                (url, None)
            }
            ImPlatform::Feishu => (None, Some(instance.bind_code.clone())),
            ImPlatform::Dingtalk => (None, Some(instance.bind_code.clone())),
            ImPlatform::OpenClaw(_) => (None, Some(instance.bind_code.clone())),
        };

        result.insert(
            bot_id.clone(),
            ImBotStatus {
                bot_username: status.bot_username,
                status: status.status,
                uptime_seconds: status.uptime_seconds,
                last_message_at: status.last_message_at,
                active_sessions: status.active_sessions,
                error_message: status.error_message,
                restart_count: status.restart_count,
                buffered_messages: status.buffered_messages,
                bind_url,
                bind_code: bind_code_opt,
            },
        );
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::im::types::{AskUserQuestionOption, PeerSession};
    use axum::{routing::post, Json, Router as AxumRouter};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn rotation_peer(session_key: &str, session_id: &str, sidecar_port: u16) -> PeerSession {
        let (source_type, source_id) = super::router::parse_session_key(session_key);
        PeerSession {
            session_key: session_key.to_string(),
            session_id: session_id.to_string(),
            sidecar_port,
            workspace_path: PathBuf::from("/tmp/workspace"),
            source_type,
            source_id,
            source_display_name: None,
            last_sender_name: None,
            message_count: 3,
            metadata_birth_pending: false,
            metadata_indexed: true,
            last_active: Instant::now(),
        }
    }

    #[test]
    fn all_stop_lock_set_unions_durable_and_live_channel_ids() {
        let channel_ids = agent_channel_ids_for_stop(
            vec!["starting".to_string(), "shared".to_string()],
            vec!["running".to_string(), "shared".to_string()],
        );

        assert_eq!(channel_ids, vec!["running", "shared", "starting"]);
    }

    #[tokio::test]
    async fn all_stop_waits_for_a_durable_channel_start_lock() {
        let agent_id = "issue-496-start-race";
        let channel_id = "starting-channel";
        let start_lock = agent_channel_lifecycle_lock(agent_id, channel_id);
        let start_guard = start_lock.lock().await;
        let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();

        let stop_waiter = tauri::async_runtime::spawn({
            let channel_ids = vec![channel_id.to_string()];
            async move {
                let _guards = lock_agent_channels_for_stop(agent_id, &channel_ids).await;
                let _ = acquired_tx.send(());
            }
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            matches!(
                acquired_rx.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ),
            "all-stop must wait until an in-flight start publishes its runtime"
        );

        drop(start_guard);
        tokio::time::timeout(Duration::from_secs(1), stop_waiter)
            .await
            .expect("all-stop should acquire the start lock after publication")
            .expect("lock waiter should not panic");
    }

    #[test]
    fn proxy_restart_admission_gate_counts_preexisting_enqueue_work() {
        let gate = ChannelModelWorkGate::new();

        let guard = gate.try_enter().expect("initial work should be admitted");
        assert_eq!(gate.active(), 1);

        assert!(gate.try_close());
        assert!(gate.try_enter().is_none());
        assert_eq!(gate.active(), 1);

        drop(guard);
        assert_eq!(gate.active(), 0);
    }

    #[tokio::test]
    async fn new_command_skips_only_missing_sources_and_commits_one_fresh_binding() {
        let freeze_calls = Arc::new(AtomicUsize::new(0));
        let app = AxumRouter::new().route(
            "/api/session/freeze-current",
            post({
                let freeze_calls = Arc::clone(&freeze_calls);
                move || {
                    let freeze_calls = Arc::clone(&freeze_calls);
                    async move {
                        freeze_calls.fetch_add(1, Ordering::SeqCst);
                        Json(serde_json::json!({ "success": true }))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind freeze server");
        let port = listener.local_addr().expect("freeze server addr").port();
        let server = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let manager = crate::sidecar::create_sidecar_manager();

        let missing_key = "agent:a:openclaw:weixin:private:missing";
        let missing_id = uuid::Uuid::new_v4().to_string();
        let missing_router = Arc::new(Mutex::new(SessionRouter::new_for_agent(
            PathBuf::from("/tmp/workspace"),
            "a".to_string(),
        )));
        missing_router
            .lock()
            .await
            .upsert_peer_session(rotation_peer(missing_key, &missing_id, port));
        let missing_dir = tempfile::tempdir().expect("missing health tempdir");
        let missing_health = Arc::new(HealthManager::new(missing_dir.path().join("state.json")));

        let fresh_id = rotate_peer_binding_for_new_command_with_metadata_lookup(
            missing_key,
            "builtin",
            &missing_router,
            &missing_health,
            &manager,
            |_| false,
            None,
        )
        .await
        .expect("missing source should rotate without freeze");

        assert_eq!(freeze_calls.load(Ordering::SeqCst), 0);
        assert_ne!(fresh_id, missing_id);
        let fresh = missing_router
            .lock()
            .await
            .peer_session_snapshot(missing_key)
            .expect("fresh binding committed");
        assert_eq!(fresh.session_id, fresh_id);
        assert_eq!(fresh.sidecar_port, 0);
        assert!(fresh.metadata_birth_pending);
        assert!(!fresh.metadata_indexed);
        let durable = missing_health.get_state().await.active_sessions;
        assert_eq!(durable.len(), 1);
        assert_eq!(durable[0].session_id, fresh_id);

        let indexed_key = "agent:a:openclaw:weixin:private:indexed";
        let indexed_id = uuid::Uuid::new_v4().to_string();
        let indexed_router = Arc::new(Mutex::new(SessionRouter::new_for_agent(
            PathBuf::from("/tmp/workspace"),
            "a".to_string(),
        )));
        indexed_router
            .lock()
            .await
            .upsert_peer_session(rotation_peer(indexed_key, &indexed_id, port));
        let indexed_dir = tempfile::tempdir().expect("indexed health tempdir");
        let indexed_health = Arc::new(HealthManager::new(indexed_dir.path().join("state.json")));

        rotate_peer_binding_for_new_command_with_metadata_lookup(
            indexed_key,
            "builtin",
            &indexed_router,
            &indexed_health,
            &manager,
            |_| true,
            None,
        )
        .await
        .expect("indexed source should freeze then rotate");
        assert_eq!(freeze_calls.load(Ordering::SeqCst), 1);

        server.abort();
    }

    #[tokio::test]
    async fn new_command_restores_the_exact_source_when_projection_persist_fails() {
        let session_key = "agent:a:openclaw:weixin:private:persist-failure";
        let session_id = uuid::Uuid::new_v4().to_string();
        let source = rotation_peer(session_key, &session_id, 0);
        let router = Arc::new(Mutex::new(SessionRouter::new_for_agent(
            PathBuf::from("/tmp/workspace"),
            "a".to_string(),
        )));
        router.lock().await.upsert_peer_session(source.clone());
        let tempdir = tempfile::tempdir().expect("health tempdir");
        let blocked_parent = tempdir.path().join("not-a-directory");
        std::fs::write(&blocked_parent, b"block mkdir").expect("create blocked parent");
        let health = Arc::new(HealthManager::new(blocked_parent.join("state.json")));
        let manager = crate::sidecar::create_sidecar_manager();

        let error = rotate_peer_binding_for_new_command_with_metadata_lookup(
            session_key,
            "builtin",
            &router,
            &health,
            &manager,
            |_| false,
            None,
        )
        .await
        .expect_err("projection persist must fail");

        assert!(error.contains("Failed to save new conversation binding"));
        let restored = router
            .lock()
            .await
            .peer_session_snapshot(session_key)
            .expect("source binding restored");
        assert_eq!(restored.session_id, source.session_id);
        assert_eq!(restored.sidecar_port, source.sidecar_port);
        assert_eq!(restored.message_count, source.message_count);
        assert_eq!(
            restored.metadata_birth_pending,
            source.metadata_birth_pending
        );
        assert_eq!(restored.metadata_indexed, source.metadata_indexed);
    }

    #[test]
    fn reconnect_wake_preserves_pending_cron_target() {
        let wake = heartbeat::wake_for_pending_cron_event(&types::PendingCronEvent {
            target_session_key: Some("agent:a:private:user-1".to_string()),
            event: "cron_complete".to_string(),
            task_id: "task-1".to_string(),
            content: "finished".to_string(),
            timestamp: 1,
            from_session_id: None,
            from_label: None,
        });

        assert!(wake.is_high_priority());
        assert_eq!(
            wake.target_session_key.as_deref(),
            Some("agent:a:private:user-1")
        );
        assert!(matches!(
            wake.reason,
            types::WakeReason::CronComplete { task_id, summary }
                if task_id == "task-1" && summary == "finished"
        ));
    }

    fn question(
        id: &str,
        options: Vec<&str>,
        multi_select: bool,
        required: bool,
        is_secret: bool,
    ) -> AskUserQuestionItem {
        AskUserQuestionItem {
            id: Some(id.to_string()),
            header: id.to_string(),
            question: format!("Question {id}"),
            options: options
                .into_iter()
                .map(|label| AskUserQuestionOption {
                    label: label.to_string(),
                    description: String::new(),
                    preview: None,
                })
                .collect(),
            multi_select,
            required,
            is_secret,
        }
    }

    #[test]
    fn question_text_keeps_free_text_commas() {
        let questions = vec![question("notes", vec![], false, true, false)];
        let answers = parse_question_text_answers(
            &questions,
            &ImSourceType::Private,
            "custom text, with comma",
        )
        .expect("valid")
        .expect("not cancelled");

        assert_eq!(
            answers.get("notes").map(String::as_str),
            Some("custom text, with comma"),
        );
    }

    #[test]
    fn question_text_joins_multi_select_labels_with_commas() {
        let questions = vec![question(
            "choices",
            vec!["Alpha", "Beta", "Gamma"],
            true,
            true,
            false,
        )];
        let answers = parse_question_text_answers(&questions, &ImSourceType::Private, "1, Gamma")
            .expect("valid")
            .expect("not cancelled");

        assert_eq!(
            answers.get("choices").map(String::as_str),
            Some("Alpha,Gamma")
        );
    }

    #[test]
    fn optional_question_can_be_skipped() {
        let questions = vec![
            question("required", vec![], false, true, false),
            question("optional", vec![], false, false, false),
        ];
        let answers = parse_question_text_answers(&questions, &ImSourceType::Private, "hello\n")
            .expect("valid")
            .expect("not cancelled");

        assert_eq!(answers.get("required").map(String::as_str), Some("hello"));
        assert!(!answers.contains_key("optional"));
    }

    #[test]
    fn secret_question_cancels_without_answers_in_any_im_chat() {
        let questions = vec![question("token", vec![], false, true, true)];
        let answers =
            parse_question_text_answers(&questions, &ImSourceType::Group, "secret, value")
                .expect("group secret is handled as cancel");

        assert!(answers.is_none());

        let answers =
            parse_question_text_answers(&questions, &ImSourceType::Private, "secret, value")
                .expect("private secret is handled as cancel");

        assert!(answers.is_none());
    }
}
