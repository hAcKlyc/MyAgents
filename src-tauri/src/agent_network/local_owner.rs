//! Only fixed, internal business adapters are reachable. The dispatch lease is
//! acquired from the real Global owner and retained through bounded decoding.
use super::NetworkError;
use crate::sidecar::ManagedSidecarManager;
use myagents_agent_network_protocol::{budget, Invocation, Operation, Outcome, VerifiedCaller};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

enum Route {
    Precheck,
    Read,
    WatchProjection,
    Discovery,
}
async fn request(
    manager: &ManagedSidecarManager,
    route: Route,
    body: Value,
) -> Result<Value, NetworkError> {
    Ok(
        request_owned(manager, route, body, super::memory::MemoryBudget::default())
            .await?
            .0,
    )
}
async fn request_owned(
    manager: &ManagedSidecarManager,
    route: Route,
    body: Value,
    memory: super::memory::MemoryBudget,
) -> Result<(Value, super::memory::Allocation), NetworkError> {
    let dispatch = manager
        .lock()
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?
        .acquire_global_dispatch()
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?;
    let path = match route {
        Route::Precheck => "/api/admin/agent/network-precheck",
        Route::Read => "/api/admin/agent/network-read",
        Route::WatchProjection => "/api/admin/agent/network-watch-result",
        Route::Discovery => "/api/admin/agent/discovery",
    };
    let mut response = crate::local_http::json_client(Duration::from_secs(20))
        .post(
            dispatch
                .url_for_path(path)
                .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?,
        )
        .header(
            crate::external_cli::INTERNAL_TOKEN_HEADER,
            crate::external_cli::internal_token(),
        )
        .json(&body)
        .send()
        .await
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?;
    let limit = match route {
        Route::Read | Route::WatchProjection => budget("objectBytes"),
        Route::Discovery => budget("catalogBytes"),
        _ => budget("controlBytes"),
    };
    let mut allocation = memory.reserve(0)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
        }
        allocation.resize((bytes.len() + chunk.len()) * 2)?;
        bytes
            .try_reserve_exact(chunk.len())
            .map_err(|_| NetworkError::new("CONNECTOR_CAPACITY"))?;
        bytes.extend_from_slice(&chunk);
    }
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if value["success"] != true {
        let code = value["code"].as_str().unwrap_or("TARGET_OWNER_UNAVAILABLE");
        return Err(NetworkError::cloud(code, response.status().as_u16()));
    }
    drop(dispatch);
    Ok((value["data"].take(), allocation))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TargetIdentity {
    pub local_agent_id: String,
    pub workspace_path: String,
    pub local_session_id: Option<String>,
}
pub(crate) struct PreparedTarget {
    pub identity: TargetIdentity,
    pub fresh: Option<crate::inbox::deliver::PreparedFreshSession>,
    pub send: Option<crate::inbox::deliver::PreparedDelivery>,
}
pub(crate) async fn prepare(
    app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    invocation: &Invocation,
) -> Result<PreparedTarget, Outcome> {
    let mut identity = precheck(manager, &invocation.operation)
        .await
        .map_err(super::incoming::error_outcome)?;
    let fresh = if let Operation::Start(params) = &invocation.operation {
        let (source_kind, from_session_id, from_label) = match &invocation.caller {
            VerifiedCaller::Internal {
                source_session_id,
                label,
                ..
            } => (
                crate::inbox::InboxSourceKind::InternalSession,
                Some(source_session_id.clone()),
                label.clone(),
            ),
            VerifiedCaller::External { label } => (
                crate::inbox::InboxSourceKind::ExternalCli,
                None,
                label.clone(),
            ),
        };
        let request = crate::inbox::deliver::FreshSessionStartRequest {
            agent_id: identity.local_agent_id.clone(),
            workspace_path: identity.workspace_path.clone(),
            source_kind,
            from_session_id,
            from_label,
            prompt: params.prompt.clone(),
            reply_back: params.reply_back,
        };
        let mut prepared = crate::inbox::deliver::prepare_fresh_session(
            app,
            manager,
            request,
            Some(params.message_id.clone()),
        )
        .await
        .map_err(start_outcome)?;
        identity.local_session_id = Some(prepared.session_id().into());
        // No Session lifecycle lock crosses a remote permit round trip.
        prepared.release_lifecycle_for_network();
        Some(prepared)
    } else {
        None
    };
    let send = if let Operation::Send(params) = &invocation.operation {
        let mut message = match &invocation.caller {
            VerifiedCaller::Internal {
                source_session_id,
                label,
                ..
            } => crate::inbox::types::PendingInboxMessage::new_request(
                source_session_id.clone(),
                label.clone(),
                params.local_session_id.clone(),
                params.prompt.clone(),
                params.reply_back,
            ),
            VerifiedCaller::External { .. } => {
                crate::inbox::types::PendingInboxMessage::new_external_request(
                    params.local_session_id.clone(),
                    params.prompt.clone(),
                )
            }
        };
        message.message_id = params.message_id.clone();
        let mut prepared = crate::inbox::deliver::prepare_existing_delivery(
            app,
            manager,
            message,
            identity.workspace_path.clone().into(),
        )
        .await
        .map_err(|outcome| send_outcome(params, outcome))?;
        prepared.release_lifecycle_for_network();
        Some(prepared)
    } else {
        None
    };
    Ok(PreparedTarget {
        identity,
        fresh,
        send,
    })
}
pub(crate) fn start_outcome(outcome: crate::inbox::deliver::FreshSessionStartOutcome) -> Outcome {
    let mut result = json!({"accepted":outcome.status=="accepted","asynchronous":true,
        "agentId":outcome.agent_id,"sessionId":outcome.session_id,"messageId":outcome.message_id,"replyBack":outcome.reply_back});
    if outcome.status == "unconfirmed" {
        result["accepted"] = Value::Null;
        result["unconfirmed"] = json!(true);
    }
    if outcome.reply_back {
        result["resultDelivery"] = json!("send.result");
    }
    if outcome.reason.is_some() {
        result["error"] = json!({"code":if outcome.status=="unconfirmed" {"ADMISSION_UNCONFIRMED"} else {"TARGET_ADMISSION_REJECTED"},"message":"Target admission was not confirmed"});
    }
    Outcome::Start { result }
}
pub(crate) fn send_outcome(
    params: &myagents_agent_network_protocol::SendParams,
    outcome: crate::inbox::deliver::DeliverOutcome,
) -> Outcome {
    use crate::inbox::deliver::DeliverOutcome;
    let mut result = json!({"delivered":matches!(&outcome,DeliverOutcome::Delivered {..}),"messageId":params.message_id,"replyBack":params.reply_back});
    if matches!(&outcome, DeliverOutcome::Unconfirmed { .. }) {
        result["unconfirmed"] = json!(true);
    }
    if !matches!(&outcome, DeliverOutcome::Delivered { .. }) {
        result["error"] = json!({"code":if matches!(&outcome,DeliverOutcome::Unconfirmed {..}){"ADMISSION_UNCONFIRMED"}else{"TARGET_ADMISSION_REJECTED"},"message":"Target admission was not confirmed"});
    }
    Outcome::Send { result }
}
pub(crate) async fn precheck(
    manager: &ManagedSidecarManager,
    operation: &Operation,
) -> Result<TargetIdentity, NetworkError> {
    let session = match operation {
        Operation::Get(params) => Some(&params.local_session_id),
        Operation::State(params) => Some(&params.local_session_id),
        Operation::Send(params) => Some(&params.local_session_id),
        Operation::Watch(params) => Some(&params.local_session_id),
        _ => None,
    };
    let mut body = json!({"localAgentId":operation.agent_id()});
    if let Some(session) = session {
        body["localSessionId"] = json!(session);
    }
    let value = request(manager, Route::Precheck, body).await?;
    let identity: TargetIdentity =
        serde_json::from_value(value).map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if identity.local_agent_id != operation.agent_id()
        || identity.local_session_id.as_ref() != session
    {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    Ok(identity)
}
pub(crate) async fn read(
    manager: &ManagedSidecarManager,
    operation: &Operation,
    memory: super::memory::MemoryBudget,
) -> Result<(Outcome, super::memory::Allocation), NetworkError> {
    if !matches!(
        operation,
        Operation::Show(_) | Operation::List(_) | Operation::Get(_) | Operation::State(_)
    ) {
        return Err(NetworkError::new("READ_OPERATION_REQUIRED"));
    }
    let (value, mut allocation) = request_owned(
        manager,
        Route::Read,
        serde_json::to_value(operation).map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?,
        memory,
    )
    .await?;
    // Validate the whole original owner's outcome against the shared wire DTO.
    // Validation briefly holds a second Value; reserve actual bytes only.
    allocation.resize(super::memory::measure(&value)?.0 * 3)?;
    let mut response = json!({"version":1,"kind":"response","senderSequence":1,
        "opId":"00000000-0000-0000-0000-000000000001","requestId":"00000000-0000-0000-0000-000000000002","outcome":null});
    response["outcome"] = value;
    myagents_agent_network_protocol::validate_business(&response)
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    let outcome: Outcome = serde_json::from_value(response["outcome"].take())
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    let method = match &outcome {
        Outcome::Show { .. } => "agent.show",
        Outcome::List { .. } => "session.list",
        Outcome::Get { .. } => "session.get",
        Outcome::State { .. } => "session.state",
        _ => return Err(NetworkError::new("TARGET_RECEIPT_INVALID")),
    };
    if method != operation.method() {
        return Err(NetworkError::new("TARGET_RECEIPT_INVALID"));
    }
    allocation.resize(super::memory::measure(&outcome)?.0 * 2)?;
    Ok((outcome, allocation))
}

/// The original caller's Agent/Session owner resolves the local path again.
/// Remote event fields are never workspace or Session creation authority.
/// A local transport outcome, never a claim that the remote turn failed.
pub(crate) async fn deliver_return_unavailable(
    app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    intent: super::returns::ReturnIntent,
    reason: &str,
) {
    let event = return_unavailable_event(&intent, reason);
    let settlement = deliver_return(app, manager, intent, event).await;
    crate::ulog_info!(
        "[agent-network/return] stage=source_unavailable settlement={}",
        match settlement {
            myagents_agent_network_protocol::ReturnSettlement::Delivered => "delivered",
            myagents_agent_network_protocol::ReturnSettlement::Unconfirmed => "unconfirmed",
            myagents_agent_network_protocol::ReturnSettlement::Dropped => "dropped",
        }
    );
}
fn return_unavailable_event(intent: &super::returns::ReturnIntent, reason: &str) -> Value {
    let mut event = json!({"version":2,"type":"network.return_unavailable",
        "eventId":uuid::Uuid::new_v4().to_string(),"createdAt":chrono::Utc::now().to_rfc3339(),
        "targetSessionId":intent.source_session,"sourceLabel":"Agent Network",
        "reason":super::NetworkError::cloud(reason,400).code,
        "payload":"Automatic result delivery is no longer available for the original remote request. The remote task may still be running or may have completed. When the connection is available, inspect the original remote session with session state/get; do not resend the accepted request just to retrieve its result."});
    if let Some(session) = &intent.target_session {
        event["sourceSessionId"] = json!(session);
    }
    match &intent.correlation {
        super::returns::Correlation::Reply(id) => event["requestEventId"] = json!(id),
        super::returns::Correlation::Watch(id) => event["watchId"] = json!(id),
    }
    event
}

pub(crate) async fn deliver_return(
    app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    intent: super::returns::ReturnIntent,
    mut event: Value,
) -> myagents_agent_network_protocol::ReturnSettlement {
    use crate::inbox::{
        deliver::DeliverOutcome,
        types::{InboxMessageKind, PendingInboxMessage},
    };
    use myagents_agent_network_protocol::{GetParams, ReturnSettlement};
    let operation = Operation::Get(GetParams {
        local_agent_id: intent.source_agent,
        local_session_id: intent.source_session.clone(),
        limit: 1,
        before: None,
    });
    let Ok(target) = precheck(manager, &operation).await else {
        return ReturnSettlement::Dropped;
    };
    if let Some(agent) = intent.target_agent.as_ref() {
        if let Some(session) = event["sourceSessionId"].as_str() {
            let Ok(selector) = (myagents_agent_network_protocol::SessionReference {
                agent: agent.clone(),
                local_session_id: session.into(),
            })
            .encode() else {
                return ReturnSettlement::Dropped;
            };
            event["sourceSessionId"] = json!(selector);
        } else if event["type"] != "network.return_unavailable" {
            return ReturnSettlement::Dropped;
        }
    }
    let Some(event_id) = event["eventId"].as_str().map(str::to_owned) else {
        return ReturnSettlement::Dropped;
    };
    let from = event["sourceSessionId"].as_str().map(str::to_owned);
    if from.is_none() && event["type"] != "network.return_unavailable" {
        return ReturnSettlement::Dropped;
    }
    let text = event["payload"]
        .as_str()
        .or_else(|| event["latestResult"].as_str())
        .unwrap_or("")
        .into();
    let from_label = if let Some((agent, device)) = &intent.peer_label {
        event["sourceAgentName"] = json!(agent);
        event["sourceDeviceName"] = json!(device);
        format!(
            "{} @ {} · {}",
            agent,
            device,
            event["sourceLabel"].as_str().unwrap_or("Session")
        )
    } else {
        event["sourceLabel"].as_str().unwrap_or("Agent").into()
    };
    let message = PendingInboxMessage {
        message_id: event_id.into(),
        from_session_id: from.map(Into::into),
        source_kind: crate::inbox::InboxSourceKind::InternalSession,
        from_label,
        to_session_id: intent.source_session,
        text,
        reply_back: false,
        timestamp_ms: chrono::Utc::now().timestamp_millis(),
        kind: if event["type"] != "network.return_unavailable"
            && matches!(intent.correlation, super::returns::Correlation::Reply(_))
        {
            InboxMessageKind::Reply
        } else {
            InboxMessageKind::Event
        },
        in_reply_to: event["requestEventId"].as_str().map(str::to_owned),
        session_event: Some(event),
        network_return: None,
    };
    let prepared = crate::inbox::deliver::prepare_existing_delivery(
        app,
        manager,
        message,
        target.workspace_path.into(),
    )
    .await;
    let outcome = match prepared {
        Ok(prepared) => prepared.admit_network(app, None, || Ok(())).await,
        Err(outcome) => outcome,
    };
    match outcome {
        DeliverOutcome::Delivered { .. } => ReturnSettlement::Delivered,
        DeliverOutcome::Unconfirmed { .. } => ReturnSettlement::Unconfirmed,
        _ => ReturnSettlement::Dropped,
    }
}

pub(crate) async fn watch<G: Fn() -> Result<(), String> + Send + 'static>(
    app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    invocation: &Invocation,
    memory: super::memory::MemoryBudget,
    connection_id: String,
    return_alive: std::sync::Arc<std::sync::atomic::AtomicBool>,
    guard: G,
) -> (Outcome, Option<super::memory::Allocation>) {
    let Operation::Watch(params) = &invocation.operation else {
        return (
            super::incoming::error_outcome(NetworkError::new("WATCH_OPERATION_REQUIRED")),
            None,
        );
    };
    let VerifiedCaller::Internal {
        source_session_id, ..
    } = &invocation.caller
    else {
        return (
            super::incoming::error_outcome(NetworkError::new("EXTERNAL_CLI_CAPABILITY_NOT_OPEN")),
            None,
        );
    };
    // Original local Agent/Session ownership is current at the final handoff.
    if let Err(error) = precheck(manager, &invocation.operation).await {
        return (super::incoming::error_outcome(error), None);
    }
    if let Err(reason) = guard() {
        return (
            super::incoming::error_outcome(NetworkError::cloud(&reason, 409)),
            None,
        );
    }
    let reference = crate::inbox::types::NetworkReturnReference {
        connection_id: Some(connection_id),
        op_id: uuid::Uuid::parse_str(&invocation.op_id).expect("validated op"),
        return_route_id: uuid::Uuid::parse_str(
            invocation.return_route_id.as_deref().expect("permit route"),
        )
        .expect("validated route"),
    };
    let app = app.clone();
    let owned_manager = manager.clone();
    let target = params.local_session_id.clone();
    let watch_id = params.watch_id.clone();
    let watcher = source_session_id.clone();
    let label = params.local_agent_id.clone();
    let observer_scope = format!(
        "{}:{}:{}:{}",
        invocation.source.service_id,
        invocation.source.network_id,
        invocation.source.device_id,
        invocation.source.key_generation
    );
    // Admission requires the current connection. Once handed off, the logical
    // return owner decides cleanup: a temporary socket loss is not cancellation.
    let result = tauri::async_runtime::spawn(async move {
        let result = crate::inbox::watch::register_session_watch(
            app,
            owned_manager.clone(),
            crate::inbox::watch::SessionWatchRequest {
                watch_id: watch_id.clone(),
                watcher_session_id: watcher,
                watcher_resume_workspace_path: None,
                target_session_id: target.clone(),
                target_label: label,
                network_return: Some(reference.clone()),
                observer_scope: Some(observer_scope),
            },
        )
        .await;
        if !return_alive.load(std::sync::atomic::Ordering::Acquire) {
            crate::inbox::watch::remove_network_watch(
                &owned_manager,
                &target,
                &watch_id,
                &reference,
            )
            .await;
        }
        result
    })
    .await;
    let Ok(result) = result else {
        return (
            super::incoming::error_outcome(NetworkError::new("ADMISSION_UNCONFIRMED")),
            None,
        );
    };
    match request_owned(manager,Route::WatchProjection,json!({"localAgentId":params.local_agent_id,"localSessionId":params.local_session_id,
        "sourceSessionId":source_session_id,"targetReference":myagents_agent_network_protocol::AgentReference {service_id:invocation.source.service_id.clone(),network_id:invocation.source.network_id.clone(),mount_id:invocation.target_mount_id.clone()}.encode().map_err(|_|NetworkError::new("INVALID_REFERENCE")).unwrap_or_default(),"result":result}),memory).await {
        Ok((mut value,allocation))=> {
            let outcome:Result<Outcome,_>=serde_json::from_value(value["outcome"].take());
            (outcome.unwrap_or_else(|_|super::incoming::error_outcome(NetworkError::new("TARGET_RECEIPT_INVALID"))),Some(allocation))
        },Err(error)=>(super::incoming::error_outcome(error),None),
    }
}

pub(crate) async fn discovery(
    manager: &ManagedSidecarManager,
    local_only: bool,
) -> Result<Value, NetworkError> {
    request(manager, Route::Discovery, json!({"localOnly":local_only})).await
}
