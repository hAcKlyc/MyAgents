// Session Inbox 跨 sidecar 投递 (PRD 0.2.18)
//
// 入口:`cmd_inbox_deliver` Tauri command + `deliver_with_resume` 异步函数(由
// management API `/api/inbox/deliver` handler 调用)。流程:
//
//   1. 找 target_session_id 对应的 SessionSidecar(SidecarManager 查询)
//   2. 如果不存在或 unhealthy:
//      - 有 resume_workspace_path → spawn 临时 owner + ensure_session_sidecar
//        唤起,投递结束后**显式 release**(避免 owner 永久泄漏)
//      - 无 resume_workspace_path → 返回 SessionNotFound
//   3. HTTP POST `/api/inbox/drain` (via local_http) body 携带 message
//   4. HTTP 2xx + drain accepted → Delivered
//   5. 显式 accepted=false → Rejected；无法确认 ACK → Unconfirmed(External CLI)
//
// fire-and-forget 设计:失败由 caller AI 自决重试,不做 at-least-once 重试,
// 不在 sidecar 上保留队列(早期版本里 SessionSidecar.pending_inbox_messages
// 是 reinvention,已删除——push/pop 没有 consumer,反而是 leak surface)。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sidecar::{ManagedSidecarManager, SidecarOwner};
use crate::{ulog_error, ulog_info, ulog_warn};

use super::types::{InboxSourceKind, PendingInboxMessage};

/// Drain handler 投递结果(对应 sidecar /api/inbox/drain 的响应)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainResponse {
    /// Whether the sidecar accepted the messages (e.g., enqueueUserMessage returned queued)
    pub accepted: bool,
    /// Optional reason if accepted=false (e.g., 'external_busy', 'queue_full')
    #[serde(default)]
    pub reason: Option<String>,
}

/// `cmd_inbox_deliver` 的响应:可能 success(投递成功)或 error(失败原因)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum DeliverOutcome {
    /// 投递成功:HTTP POST 拿到 2xx + accepted=true
    Delivered { message_id: String },
    /// Target session 不存在或不健康(sidecar 没起 / dead state)
    SessionNotFound,
    /// HTTP 投递失败(网络/sidecar 5xx 等)
    DeliveryFailed { reason: String },
    /// Request may have reached the target, but no valid acknowledgement was read.
    Unconfirmed { reason: String },
    /// Target sidecar 拒绝接收(例如 external runtime busy)
    Rejected { reason: String },
}

#[cfg(test)]
fn drain_outcome(message_id: &str, response: Result<DrainResponse, String>) -> DeliverOutcome {
    match response {
        Ok(response) if response.accepted => DeliverOutcome::Delivered {
            message_id: message_id.to_string(),
        },
        Ok(response) => DeliverOutcome::Rejected {
            reason: response.reason.unwrap_or_else(|| "unknown".to_string()),
        },
        Err(error) => DeliverOutcome::DeliveryFailed {
            reason: format!("invalid drain acknowledgement: {error}"),
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBirthOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshSessionStartRequest {
    pub agent_id: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_session_id: Option<String>,
    #[serde(default)]
    pub source_kind: InboxSourceKind,
    pub from_label: String,
    pub prompt: String,
    pub reply_back: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth_overrides: Option<SessionBirthOverrides>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshSessionStartOutcome {
    pub status: String,
    pub agent_id: String,
    pub session_id: String,
    pub message_id: String,
    pub reply_back: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreshStartTargetResponse {
    accepted: Option<bool>,
    #[serde(default)]
    reason: Option<String>,
}

/// Tauri command 接收 inbox message 并投递到 target sidecar。
///
/// 命名 snake_case 是因为 Tauri 自动会把命令名按 generate_handler! 时的写法
/// 暴露给前端(我们 ts 端实际不调用此命令——它由 sidecar admin handler 通过
/// management API 投递,见 `crate::management_api::inbox_deliver_handler`)。
///
/// 留出 #[tauri::command] 仍允许将来手动 invoke 用于排查。
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_inbox_deliver(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    message: PendingInboxMessage,
) -> Result<DeliverOutcome, String> {
    Ok(deliver_with_resume(&app_handle, &state, message, None).await)
}

/// HTTP POST the message to target sidecar's `/api/inbox/drain`.
async fn http_post_drain(port: u16, message: &PendingInboxMessage, network_handoff: bool) -> DeliverOutcome {
    let url = format!("http://127.0.0.1:{}/api/inbox/drain", port);
    let client = crate::local_http::json_client(Duration::from_secs(30));
    let message_id = message.message_id.clone();

    match client
        .post(&url)
        .header(
            crate::external_cli::INTERNAL_TOKEN_HEADER,
            crate::external_cli::internal_token(),
        )
        .json(&serde_json::json!({ "messages": [message] }))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            let acknowledgement = resp
                .json::<DrainResponse>()
                .await
                .map_err(|error| error.to_string());
            let outcome = drain_ack_outcome_for_handoff(message, status.as_u16(), acknowledgement, network_handoff);
            match &outcome {
                DeliverOutcome::Delivered { .. } => ulog_info!("[inbox] delivered msg_id={} (port {})", message_id, port),
                DeliverOutcome::Rejected { reason } => ulog_warn!("[inbox] target rejected message {} with HTTP {}: {}", message_id, status.as_u16(), reason),
                DeliverOutcome::Unconfirmed { reason } | DeliverOutcome::DeliveryFailed { reason } => ulog_warn!("[inbox] {} (msg_id={})", reason, message_id),
                DeliverOutcome::SessionNotFound => {}
            }
            outcome
        }
        Err(e) => {
            let reason = format!("network error: {}", e);
            ulog_error!(
                "[inbox] HTTP POST to {} failed: {} (msg_id={})",
                url,
                e,
                message_id
            );
            ambiguous_handoff_outcome(message, reason, network_handoff)
        }
    }
}

#[cfg(test)]
fn ambiguous_delivery_outcome(message: &PendingInboxMessage, reason: String) -> DeliverOutcome {
    ambiguous_handoff_outcome(message, reason, false)
}

fn ambiguous_handoff_outcome(message: &PendingInboxMessage, reason: String, network_handoff: bool) -> DeliverOutcome {
    let channel_handoff = message.session_event.as_ref().is_some_and(|event|
        event["type"] == "send.request" && event["channelHandoff"].is_object());
    if network_handoff || channel_handoff || message.source_kind == InboxSourceKind::ExternalCli {
        DeliverOutcome::Unconfirmed { reason }
    } else {
        DeliverOutcome::DeliveryFailed { reason }
    }
}

#[cfg(test)]
fn drain_ack_outcome(
    message: &PendingInboxMessage,
    status: u16,
    acknowledgement: Result<DrainResponse, String>,
) -> DeliverOutcome {
    drain_ack_outcome_for_handoff(message, status, acknowledgement, false)
}

fn drain_ack_outcome_for_handoff(message: &PendingInboxMessage, status: u16, acknowledgement: Result<DrainResponse, String>, network_handoff: bool) -> DeliverOutcome {
    match acknowledgement {
        Ok(DrainResponse {
            accepted: false,
            reason,
        }) => DeliverOutcome::Rejected {
            reason: reason.unwrap_or_else(|| "unknown".to_string()),
        },
        Ok(DrainResponse { accepted: true, .. }) if (200..300).contains(&status) => {
            DeliverOutcome::Delivered {
                message_id: message.message_id.clone(),
            }
        }
        Ok(_) | Err(_) => ambiguous_handoff_outcome(
            message,
            format!("delivery acknowledgement was not confirmed (HTTP {status})"),
            network_handoff,
        ),
    }
}

async fn http_post_fresh_start(
    port: u16,
    agent_id: &str,
    message: &PendingInboxMessage,
    birth_overrides: Option<&SessionBirthOverrides>,
) -> Result<FreshStartTargetResponse, String> {
    let url = format!("http://127.0.0.1:{}/api/inbox/start", port);
    let client = crate::local_http::json_client(Duration::from_secs(30));
    let mut payload = serde_json::json!({
        "agentId": agent_id,
        "message": message
    });
    if let Some(overrides) = birth_overrides {
        payload["birthOverrides"] = serde_json::to_value(overrides)
            .map_err(|error| format!("failed to serialize birthOverrides: {error}"))?;
    }
    let response = client
        .post(&url)
        .header(
            crate::external_cli::INTERNAL_TOKEN_HEADER,
            crate::external_cli::internal_token(),
        )
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("admission acknowledgement was not confirmed: {error}"))?;
    let status = response.status();
    let parsed = response
        .json::<FreshStartTargetResponse>()
        .await
        .map_err(|error| {
            format!(
                "admission acknowledgement was not confirmed (HTTP {}): {error}",
                status.as_u16()
            )
        })?;
    Ok(parsed)
}

/// Start a new Session under one Agent and wait only for target dispatch
/// acceptance. The lifecycle fence spans ID birth, ensure, admission,
/// BackgroundCompletion handoff, and transient-owner release.
pub async fn start_fresh_session(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    request: FreshSessionStartRequest,
) -> FreshSessionStartOutcome {
    match prepare_fresh_session(app_handle, manager, request, None).await {
        Ok(prepared) => prepared.admit(app_handle, None, || Ok(())).await,
        Err(outcome) => outcome,
    }
}

/// Cold preparation belongs to the original Inbox/Session lifecycle owner.
/// Network callers release its lock while requesting remote permission and
/// reacquire it before the final local handoff. The owner token stays scoped to
/// this object and is released even if the connector future is cancelled.
pub(crate) struct PreparedFreshSession {
    request: FreshSessionStartRequest,
    session_id: String,
    message: PendingInboxMessage,
    port: u16,
    process_generation: u64,
    manager: ManagedSidecarManager,
    owner: Option<SidecarOwner>,
    lifecycle: Option<std::sync::Arc<crate::sidecar::SessionLifecycleGuard>>,
}
impl Drop for PreparedFreshSession {
    fn drop(&mut self) {
        // Never schedule an owner release while retaining the lifecycle lock.
        self.lifecycle.take();
        if let Some(owner) = self.owner.take() {
            crate::sidecar::schedule_release_session_sidecar(
                self.manager.clone(),
                self.session_id.clone(),
                owner,
            );
        }
    }
}
impl PreparedFreshSession {
    pub(crate) fn release_lifecycle_for_network(&mut self) {
        self.lifecycle.take();
    }
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }
    fn outcome(&self, status: &str, reason: Option<String>) -> FreshSessionStartOutcome {
        FreshSessionStartOutcome {
            status: status.into(),
            reason,
            agent_id: self.request.agent_id.clone(),
            session_id: self.session_id.clone(),
            message_id: self.message.message_id.clone(),
            reply_back: self.request.reply_back,
        }
    }
    pub(crate) async fn admit<G: FnOnce() -> Result<(), String>>(
        mut self,
        app_handle: &AppHandle,
        network_return: Option<super::types::NetworkReturnReference>,
        guard: G,
    ) -> FreshSessionStartOutcome {
        if self.lifecycle.is_none() {
            self.lifecycle = Some(std::sync::Arc::new(
                crate::sidecar::acquire_session_lifecycle(&[&self.session_id]).await,
            ));
        }
        self.message.network_return = network_return;
        let current = self
            .manager
            .lock()
            .is_ok_and(|manager| manager.is_live(&self.session_id, self.process_generation));
        if !current {
            return self.outcome("rejected", Some("TARGET_GENERATION_CHANGED".into()));
        }
        if let Err(reason) = guard() {
            return self.outcome("rejected", Some(reason));
        }
        // This is the final local handoff. The original Inbox owner must read
        // the real acknowledgement and attach BackgroundCompletion even when
        // its caller disconnects while the HTTP admission is in flight.
        let unconfirmed = self.outcome("unconfirmed", Some("ADMISSION_UNCONFIRMED".into()));
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move { self.complete_admission(&app_handle).await })
            .await
            .unwrap_or(unconfirmed)
    }
    async fn complete_admission(mut self, app_handle: &AppHandle) -> FreshSessionStartOutcome {
        let outcome = |status: &str, reason: Option<String>| self.outcome(status, reason);
        let target = http_post_fresh_start(
            self.port,
            &self.request.agent_id,
            &self.message,
            self.request.birth_overrides.as_ref(),
        )
        .await;
        let result = match target {
            Ok(response) if response.accepted == Some(true) => {
                if start_headless_completion(app_handle, &self.manager, &self.session_id) {
                    outcome("accepted", None)
                } else {
                    outcome(
                    "unconfirmed",
                    Some(
                        "dispatch was accepted but background completion ownership was not confirmed"
                            .to_string(),
                    ),
                )
                }
            }
            Ok(response) if response.accepted == Some(false) => outcome(
                "rejected",
                Some(
                    response
                        .reason
                        .unwrap_or_else(|| "target rejected admission".to_string()),
                ),
            ),
            Ok(response) => {
                // ACK ambiguity deliberately has no durable retry protocol. Reuse
                // the existing headless completion owner when possible, return the
                // allocated IDs, and let callers inspect history without resending.
                let _ = start_headless_completion(app_handle, &self.manager, &self.session_id);
                outcome(
                    "unconfirmed",
                    Some(response.reason.unwrap_or_else(|| {
                        "target could not confirm Runtime dispatch acceptance".to_string()
                    })),
                )
            }
            Err(reason) => {
                let _ = start_headless_completion(app_handle, &self.manager, &self.session_id);
                outcome("unconfirmed", Some(reason))
            }
        };
        // The ordinary BackgroundCompletion owner now covers accepted work.
        if let Some(owner) = self.owner.take() {
            release_transient_owner(&self.manager, &self.session_id, &owner).await;
        }
        self.lifecycle.take();
        result
    }
}

fn resolve_fresh_start_runtime_identity(
    birth_overrides: Option<&SessionBirthOverrides>,
    agent_runtime: Option<String>,
    agent_runtime_source: Option<String>,
) -> (Option<String>, Option<String>) {
    if let Some(overrides) = birth_overrides {
        if let Some(runtime) = overrides.runtime.clone() {
            let source = overrides.runtime_source.clone().or_else(|| {
                match runtime.as_str() {
                    "builtin" => None,
                    "dsh" => Some("integrated".to_string()),
                    _ => Some("system-cli".to_string()),
                }
            });
            return (Some(runtime), source);
        }
    }
    (agent_runtime, agent_runtime_source)
}

pub(crate) async fn prepare_fresh_session(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    mut request: FreshSessionStartRequest,
    network_message_id: Option<String>,
) -> Result<PreparedFreshSession, FreshSessionStartOutcome> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut message = if request.source_kind == InboxSourceKind::ExternalCli {
        PendingInboxMessage::new_external_request(
            session_id.clone(),
            std::mem::take(&mut request.prompt),
        )
    } else {
        let Some(from_session_id) = request.from_session_id.clone() else {
            return Err(FreshSessionStartOutcome {
                status: "rejected".to_string(),
                agent_id: request.agent_id,
                session_id,
                message_id: uuid::Uuid::new_v4().to_string(),
                reply_back: request.reply_back,
                reason: Some(
                    "internal fresh Session request requires a source Session".to_string(),
                ),
            });
        };
        PendingInboxMessage::new_request(
            from_session_id,
            request.from_label.clone(),
            session_id.clone(),
            std::mem::take(&mut request.prompt),
            request.reply_back,
        )
    };
    if let Some(id) = network_message_id {
        message.message_id = id;
    }
    let owner_id = format!("inbox-start-{}", uuid::Uuid::new_v4());
    let transient_owner = SidecarOwner::Agent(owner_id);
    let lifecycle =
        std::sync::Arc::new(crate::sidecar::acquire_session_lifecycle(&[&session_id]).await);

    let mut prepared = PreparedFreshSession {
        request,
        session_id: session_id.clone(),
        message,
        port: 0,
        process_generation: 0,
        manager: manager.clone(),
        owner: Some(transient_owner.clone()),
        lifecycle: Some(lifecycle.clone()),
    };

    let runtime_identity = crate::sidecar::resolve_agent_runtime_identity_by_id_from_config(
        &prepared.request.agent_id,
    );
    let (runtime_override, runtime_source_override) = resolve_fresh_start_runtime_identity(
        prepared.request.birth_overrides.as_ref(),
        runtime_identity
            .as_ref()
            .map(|identity| identity.runtime.clone()),
        runtime_identity
            .as_ref()
            .and_then(|identity| identity.runtime_source.clone()),
    );
    let ensure =
        crate::sidecar::ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
            lifecycle.clone(),
            app_handle.clone(),
            manager.clone(),
            session_id.clone(),
            std::path::PathBuf::from(&prepared.request.workspace_path),
            transient_owner.clone(),
            runtime_override,
            runtime_source_override,
        )
        .await;
    let (port, process_generation) = match ensure {
        Ok(result) => (result.port, result.generation),
        Err(error) => {
            release_transient_owner(manager, &session_id, &transient_owner).await;
            prepared.owner.take();
            return Err(prepared.outcome(
                "delivery_failed",
                Some(format!("sidecar start failed: {error}")),
            ));
        }
    };

    prepared.port = port;
    prepared.process_generation = process_generation;
    Ok(prepared)
}

/// Helper for the admin handler: ensure target sidecar exists (resume if dead),
/// then deliver. Returns the same DeliverOutcome.
///
/// Healthy reuse and dead-session resume share one transient Agent owner path.
/// The lifecycle fence covers lookup/ensure, delivery, BackgroundCompletion
/// handoff, and owner release so deletion cannot cross the delivery.
pub async fn deliver_with_resume(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    message: PendingInboxMessage,
    resume_workspace_path: Option<std::path::PathBuf>,
) -> DeliverOutcome {
    deliver_with_resume_policy(
        app_handle,
        manager,
        message,
        resume_workspace_path,
        SessionBirthPolicy::AllowBirth,
        |_| true,
    )
    .await
}

/// Deliver to an already-durable Product Session. A frozen routing reference
/// (for example a local Task comment reply) is not authority to recreate a
/// Session that the user has deleted.
pub async fn deliver_existing_session_with_resume(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    message: PendingInboxMessage,
    resume_workspace_path: Option<std::path::PathBuf>,
) -> DeliverOutcome {
    deliver_with_resume_policy(
        app_handle,
        manager,
        message,
        resume_workspace_path,
        SessionBirthPolicy::ExistingOnly,
        |session_id| {
            crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(session_id)
                .is_some()
        },
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionBirthPolicy {
    AllowBirth,
    ExistingOnly,
}

fn session_target_is_eligible(
    policy: SessionBirthPolicy,
    metadata_exists: impl FnOnce() -> bool,
) -> bool {
    policy == SessionBirthPolicy::AllowBirth || metadata_exists()
}

async fn deliver_with_resume_policy<F>(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    message: PendingInboxMessage,
    resume_workspace_path: Option<std::path::PathBuf>,
    birth_policy: SessionBirthPolicy,
    session_metadata_exists: F,
) -> DeliverOutcome
where
    F: FnOnce(&str) -> bool,
{
    match prepare_delivery(app_handle,manager,message,resume_workspace_path,birth_policy,session_metadata_exists).await {
        Ok(prepared)=>prepared.admit(app_handle,None,||Ok(())).await,
        Err(outcome)=>outcome,
    }
}

/// Original Inbox ownership split at the cold preparation boundary. A network
/// permit is acquired after releasing the lifecycle lock, while the transient
/// owner keeps the prepared process alive. Local delivery retains its lock.
pub(crate) struct PreparedDelivery {
    message:PendingInboxMessage,
    manager:ManagedSidecarManager,
    port:u16,
    process_generation:u64,
    owner:Option<SidecarOwner>,
    lifecycle:Option<std::sync::Arc<crate::sidecar::SessionLifecycleGuard>>,
    birth_policy:SessionBirthPolicy,
}
impl Drop for PreparedDelivery {
    fn drop(&mut self) {
        self.lifecycle.take();
        if let Some(owner)=self.owner.take() {crate::sidecar::schedule_release_session_sidecar(self.manager.clone(),self.message.to_session_id.clone(),owner);}
    }
}
impl PreparedDelivery {
    pub(crate) fn release_lifecycle_for_network(&mut self){self.lifecycle.take();}
    pub(crate) async fn admit<G:FnOnce()->Result<(),String>>(self,app:&AppHandle,
        reference:Option<super::types::NetworkReturnReference>,guard:G)->DeliverOutcome {
        self.admit_handoff(app,reference,guard,false).await
    }
    pub(crate) async fn admit_network<G:FnOnce()->Result<(),String>>(self,app:&AppHandle,
        reference:Option<super::types::NetworkReturnReference>,guard:G)->DeliverOutcome {
        self.admit_handoff(app,reference,guard,true).await
    }
    async fn admit_handoff<G:FnOnce()->Result<(),String>>(mut self,app:&AppHandle,
        reference:Option<super::types::NetworkReturnReference>,guard:G,network_handoff:bool)->DeliverOutcome {
        let to_sid=self.message.to_session_id.clone();
        if self.lifecycle.is_none(){self.lifecycle=Some(std::sync::Arc::new(crate::sidecar::acquire_session_lifecycle(&[&to_sid]).await));}
        if !self.manager.lock().is_ok_and(|state|state.is_live(&to_sid,self.process_generation)) {
            return DeliverOutcome::Rejected {reason:"TARGET_GENERATION_CHANGED".into()};
        }
        // Re-read durable identity after a network wait; an owner token keeps
        // a process alive but cannot authorize recreating a deleted Session.
        if self.birth_policy==SessionBirthPolicy::ExistingOnly
            &&crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(&to_sid).is_none()
            && !self.manager.lock().is_ok_and(|state| state.session_has_owners_other_than(&to_sid, self.owner.as_ref())) {
            return DeliverOutcome::SessionNotFound;
        }
        if let Err(reason)=guard(){return DeliverOutcome::Rejected {reason};}
        self.message.network_return=reference;
        let app=app.clone();
        // Last local handoff: the original Inbox must finish its true ACK and
        // BackgroundCompletion transfer even if its network caller disappears.
        tauri::async_runtime::spawn(async move {
            let outcome=http_post_drain(self.port,&self.message,network_handoff).await;
            start_headless_completion_if_admitted(&app,&self.manager,&to_sid,&outcome);
            if let Some(owner)=self.owner.take(){release_transient_owner(&self.manager,&to_sid,&owner).await;}
            self.lifecycle.take();outcome
        }).await.unwrap_or(DeliverOutcome::Unconfirmed {reason:"ADMISSION_UNCONFIRMED".into()})
    }
}
pub(crate) async fn prepare_existing_delivery(app:&AppHandle,manager:&ManagedSidecarManager,message:PendingInboxMessage,
    path:std::path::PathBuf)->Result<PreparedDelivery,DeliverOutcome> {
    prepare_delivery(app,manager,message,Some(path),SessionBirthPolicy::ExistingOnly,|session|
        crate::sidecar::runtime_identity::resolve_session_runtime_identity_full(session).is_some()).await
}
async fn prepare_delivery<F:FnOnce(&str)->bool>(app:&AppHandle,manager:&ManagedSidecarManager,message:PendingInboxMessage,
    path:Option<std::path::PathBuf>,birth_policy:SessionBirthPolicy,metadata_exists:F)->Result<PreparedDelivery,DeliverOutcome> {
    let to_sid=message.to_session_id.clone();
    let lifecycle=std::sync::Arc::new(crate::sidecar::acquire_session_lifecycle(&[&to_sid]).await);
    if !session_target_is_eligible(birth_policy,||manager.lock().is_ok_and(|state|state.session_has_owners(&to_sid))||metadata_exists(&to_sid)) {
        return Err(DeliverOutcome::SessionNotFound);
    }
    let owner=SidecarOwner::Agent(format!("inbox-deliver-{}",uuid::Uuid::new_v4()));
    // Install the RAII owner before an await that can be cancelled.
    let mut prepared=PreparedDelivery {message,manager:manager.clone(),port:0,process_generation:0,
        owner:Some(owner.clone()),lifecycle:Some(lifecycle.clone()),birth_policy};
    let healthy=manager.lock().ok().and_then(|mut state| {
        state.attach_owner_to_healthy_session(&to_sid,owner.clone()).map(|port|(port,state.generation_for(&to_sid).expect("attached live session")))
    });
    let (port,generation)=if let Some(binding)=healthy {binding}else {
        let path=path.ok_or(DeliverOutcome::SessionNotFound)?;
        let result=crate::sidecar::ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
            lifecycle,app.clone(),manager.clone(),to_sid,path,owner,None,None).await
            .map_err(|_|DeliverOutcome::DeliveryFailed {reason:"TARGET_PREPARATION_FAILED".into()})?;
        (result.port,result.generation)
    };
    prepared.port=port;prepared.process_generation=generation;
    Ok(prepared)
}

fn start_headless_completion_if_admitted(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    session_id: &str,
    outcome: &DeliverOutcome,
) {
    if !should_start_headless_completion(outcome) {
        return;
    }
    start_headless_completion(app_handle, manager, session_id);
}

fn should_start_headless_completion(outcome: &DeliverOutcome) -> bool {
    matches!(
        outcome,
        DeliverOutcome::Delivered { .. } | DeliverOutcome::Unconfirmed { .. }
    )
}

fn start_headless_completion(
    app_handle: &AppHandle,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> bool {
    match crate::sidecar::start_headless_background_completion(app_handle, manager, session_id) {
        Ok(result) => {
            ulog_info!(
                "[inbox] headless BackgroundCompletion for {} started={}",
                session_id,
                result.started
            );
            result.started
        }
        Err(e) => {
            ulog_error!(
                "[inbox] failed to start headless BackgroundCompletion for {}: {}",
                session_id,
                e
            );
            false
        }
    }
}

/// Release the transient inbox-delivery owner. Idempotent — no-op if the
/// sidecar was already torn down or the owner was never inserted.
async fn release_transient_owner(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) {
    match crate::sidecar::release_session_sidecar(manager, session_id, owner).await {
        Ok(stopped) => {
            ulog_info!(
                "[inbox] released transient owner for {}; sidecar_stopped={}",
                session_id,
                stopped
            );
        }
        Err(e) => {
            ulog_warn!(
                "[inbox] cannot release transient owner for {}: {}",
                session_id,
                e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_start_request_uses_the_camel_case_management_contract() {
        let request = FreshSessionStartRequest {
            agent_id: "agent-1".to_string(),
            workspace_path: "/workspace".to_string(),
            from_session_id: Some("source-session".to_string()),
            source_kind: InboxSourceKind::InternalSession,
            from_label: "Source Agent".to_string(),
            prompt: "Review this".to_string(),
            reply_back: true,
            birth_overrides: None,
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "agentId": "agent-1",
                "workspacePath": "/workspace",
                "fromSessionId": "source-session",
                "sourceKind": "internal-session",
                "fromLabel": "Source Agent",
                "prompt": "Review this",
                "replyBack": true,
            })
        );
    }

    #[test]
    fn fresh_start_request_serializes_birth_overrides_when_present() {
        let request = FreshSessionStartRequest {
            agent_id: "agent-1".to_string(),
            workspace_path: "/workspace".to_string(),
            from_session_id: Some("source-session".to_string()),
            source_kind: InboxSourceKind::InternalSession,
            from_label: "Source Agent".to_string(),
            prompt: "Review this".to_string(),
            reply_back: true,
            birth_overrides: Some(SessionBirthOverrides {
                runtime: Some("codex".to_string()),
                runtime_source: Some("system-cli".to_string()),
                provider_id: None,
                model: Some("gpt-5.5".to_string()),
                reasoning_effort: Some("high".to_string()),
                permission_mode: Some("no-restrictions".to_string()),
            }),
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "agentId": "agent-1",
                "workspacePath": "/workspace",
                "fromSessionId": "source-session",
                "sourceKind": "internal-session",
                "fromLabel": "Source Agent",
                "prompt": "Review this",
                "replyBack": true,
                "birthOverrides": {
                    "runtime": "codex",
                    "runtimeSource": "system-cli",
                    "model": "gpt-5.5",
                    "reasoningEffort": "high",
                    "permissionMode": "no-restrictions",
                }
            })
        );
    }

    #[test]
    fn birth_overrides_runtime_takes_precedence_over_agent_default_identity() {
        let overrides = SessionBirthOverrides {
            runtime: Some("dsh".to_string()),
            runtime_source: Some("integrated".to_string()),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek-v4-pro".to_string()),
            reasoning_effort: None,
            permission_mode: Some("full-autonomous".to_string()),
        };
        assert_eq!(
            resolve_fresh_start_runtime_identity(
                Some(&overrides),
                Some("antigravity".to_string()),
                Some("system-cli".to_string()),
            ),
            (Some("dsh".to_string()), Some("integrated".to_string()))
        );
        assert_eq!(
            resolve_fresh_start_runtime_identity(
                None,
                Some("antigravity".to_string()),
                Some("system-cli".to_string()),
            ),
            (Some("antigravity".to_string()), Some("system-cli".to_string()))
        );
    }

    #[test]
    fn fresh_external_start_has_no_source_session_or_reply_channel() {
        let request = FreshSessionStartRequest {
            agent_id: "agent-1".to_string(),
            workspace_path: "/workspace".to_string(),
            from_session_id: None,
            source_kind: InboxSourceKind::ExternalCli,
            from_label: "External CLI".to_string(),
            prompt: "Review this".to_string(),
            reply_back: false,
            birth_overrides: None,
        };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "agentId": "agent-1",
                "workspacePath": "/workspace",
                "sourceKind": "external-cli",
                "fromLabel": "External CLI",
                "prompt": "Review this",
                "replyBack": false,
            })
        );
    }

    #[test]
    fn fresh_start_outcome_keeps_receipt_ids_for_unconfirmed_admission() {
        let outcome = FreshSessionStartOutcome {
            status: "unconfirmed".to_string(),
            agent_id: "agent-1".to_string(),
            session_id: "fresh-session".to_string(),
            message_id: "message-1".to_string(),
            reply_back: true,
            reason: Some("ACK lost".to_string()),
        };

        let value = serde_json::to_value(outcome).unwrap();
        assert_eq!(value["status"], "unconfirmed");
        assert_eq!(value["agentId"], "agent-1");
        assert_eq!(value["sessionId"], "fresh-session");
        assert_eq!(value["messageId"], "message-1");
        assert_eq!(value["replyBack"], true);
        assert_eq!(value["reason"], "ACK lost");
    }

    #[test]
    fn explicit_target_rejection_is_distinct_from_ack_loss() {
        let parsed: FreshStartTargetResponse = serde_json::from_value(serde_json::json!({
            "accepted": false,
            "reason": "runtime rejected dispatch"
        }))
        .unwrap();

        assert_eq!(parsed.accepted, Some(false));
        assert_eq!(parsed.reason.as_deref(), Some("runtime rejected dispatch"));

        let message =
            PendingInboxMessage::new_external_request("target".to_string(), "work".to_string());
        assert!(matches!(
            drain_ack_outcome(
                &message,
                409,
                Ok(DrainResponse {
                    accepted: false,
                    reason: Some("runtime rejected dispatch".to_string()),
                }),
            ),
            DeliverOutcome::Rejected { reason }
                if reason == "runtime rejected dispatch"
        ));
        assert!(matches!(
            drain_ack_outcome(&message, 200, Err("invalid body".to_string())),
            DeliverOutcome::Unconfirmed { .. }
        ));
    }

    #[test]
    fn target_can_return_unconfirmed_admission_as_json_null() {
        let parsed: FreshStartTargetResponse = serde_json::from_value(serde_json::json!({
            "accepted": null,
            "unconfirmed": true,
            "reason": "termination could not be confirmed"
        }))
        .unwrap();

        assert_eq!(parsed.accepted, None);
        assert_eq!(
            parsed.reason.as_deref(),
            Some("termination could not be confirmed")
        );
    }

    #[test]
    fn only_external_cli_delivery_ambiguity_uses_unconfirmed_outcome() {
        let external =
            PendingInboxMessage::new_external_request("target".to_string(), "work".to_string());
        assert!(matches!(
            ambiguous_delivery_outcome(&external, "ack lost".to_string()),
            DeliverOutcome::Unconfirmed { .. }
        ));

        let internal = PendingInboxMessage::new_request(
            "source".to_string(),
            "Source".to_string(),
            "target".to_string(),
            "work".to_string(),
            true,
        );
        assert!(matches!(
            ambiguous_delivery_outcome(&internal, "ack lost".to_string()),
            DeliverOutcome::DeliveryFailed { .. }
        ));
        assert!(should_start_headless_completion(
            &DeliverOutcome::Unconfirmed {
                reason: "ack lost".to_string()
            }
        ));
        assert!(!should_start_headless_completion(
            &DeliverOutcome::Rejected {
                reason: "busy".to_string()
            }
        ));
    }

    #[tokio::test]
    async fn channel_handoff_lost_or_malformed_ack_remains_unknown() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for response in [None, Some(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad".as_slice())] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tauri::async_runtime::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let read = stream.read(&mut buffer).await.unwrap();
                    if read == 0 { break; }
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(header_end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length: ")).unwrap().parse().unwrap();
                        if bytes.len() >= header_end + 4 + length { break; }
                    }
                }
                assert!(String::from_utf8_lossy(&bytes).contains("channelHandoff"));
                if let Some(response) = response { stream.write_all(response).await.unwrap(); }
            });
            let mut message = PendingInboxMessage::new_request("source".into(), "Source".into(), "target".into(), "payload".into(), false);
            message.session_event = Some(serde_json::json!({"type":"send.request","channelHandoff":{"context":"context"}}));
            let outcome = http_post_drain(port, &message, false).await;
            assert!(matches!(outcome, DeliverOutcome::Unconfirmed { .. }));
            assert!(should_start_headless_completion(&outcome));
            assert!(matches!(drain_ack_outcome(&message, 409, Ok(DrainResponse {accepted:false,reason:None})), DeliverOutcome::Rejected {..}));
            server.await.unwrap();
        }
    }

    #[test]
    fn network_handoff_ack_loss_is_unknown_for_internal_reply_and_no_reply() {
        for reply_back in [false,true] {
            let message=PendingInboxMessage::new_request("source".into(),"Source".into(),"target".into(),"work".into(),reply_back);
            assert!(matches!(drain_ack_outcome_for_handoff(&message,200,Err("ACK lost".into()),true),DeliverOutcome::Unconfirmed {..}));
            assert!(matches!(drain_ack_outcome_for_handoff(&message,200,Ok(DrainResponse {accepted:false,reason:Some("busy".into())}),true),DeliverOutcome::Rejected {..}));
            assert!(matches!(drain_ack_outcome_for_handoff(&message,200,Ok(DrainResponse {accepted:true,reason:None}),true),DeliverOutcome::Delivered {..}));
        }
    }

    #[test]
    fn existing_only_delivery_never_turns_a_missing_session_into_birth_authority() {
        assert!(!session_target_is_eligible(
            SessionBirthPolicy::ExistingOnly,
            || false
        ));
        assert!(session_target_is_eligible(
            SessionBirthPolicy::ExistingOnly,
            || true
        ));

        let birth_probe_called = std::cell::Cell::new(false);
        assert!(session_target_is_eligible(
            SessionBirthPolicy::AllowBirth,
            || {
                birth_probe_called.set(true);
                false
            }
        ));
        assert!(!birth_probe_called.get());
    }

    #[test]
    fn drain_ack_requires_an_explicit_boolean_accepted_field() {
        assert!(matches!(
            drain_outcome(
                "message-1",
                serde_json::from_value::<DrainResponse>(serde_json::json!({ "accepted": true }))
                    .map_err(|error| error.to_string()),
            ),
            DeliverOutcome::Delivered { .. }
        ));
        assert!(matches!(
            drain_outcome(
                "message-1",
                serde_json::from_value::<DrainResponse>(serde_json::json!({ "success": true }))
                    .map_err(|error| error.to_string()),
            ),
            DeliverOutcome::DeliveryFailed { .. }
        ));
    }
}
