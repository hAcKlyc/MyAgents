//! Same-account remote control enters the original desktop Session owner.
use super::{
    memory::{Allocation, MemoryBudget},
    NetworkError,
};
use crate::sidecar::{manager::SidecarHttpDispatch, ManagedSidecarManager, SidecarOwner};
use myagents_host_management_protocol::{
    RemoteReceiptStatus, RemoteSessionRequest, RemoteSessionResult, ResponseResult,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
const LIMIT: usize = myagents_host_management_protocol::REMOTE_SESSION_BYTES;
async fn post(
    dispatch: &SidecarHttpDispatch,
    path: &str,
    body: Value,
    memory: &MemoryBudget,
) -> Result<(Value, Allocation), NetworkError> {
    let mut response = crate::local_http::json_client(Duration::from_secs(8))
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
    let status = response.status();
    let mut bytes = Vec::new();
    let mut allocation = memory.reserve(0)?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
        }
        allocation.resize((bytes.len() + chunk.len()) * 3)?;
        bytes.extend_from_slice(&chunk);
    }
    let mut value: Value =
        serde_json::from_slice(&bytes).map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if !status.is_success() || value["success"] != true {
        return Err(NetworkError::cloud(
            value["code"].as_str().unwrap_or("TARGET_OWNER_UNAVAILABLE"),
            status.as_u16(),
        ));
    }
    Ok((value["data"].take(), allocation))
}
fn global(manager: &ManagedSidecarManager) -> Result<SidecarHttpDispatch, NetworkError> {
    manager
        .lock()
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?
        .acquire_global_dispatch()
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))
}
fn session(
    manager: &ManagedSidecarManager,
    id: &str,
) -> Result<Option<SidecarHttpDispatch>, NetworkError> {
    manager
        .lock()
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))?
        .acquire_session_dispatch(id)
        .map_err(|_| NetworkError::new("TARGET_OWNER_UNAVAILABLE"))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    agent_id: String,
    session_id: String,
    workspace_path: String,
}
struct Owner {
    manager: ManagedSidecarManager,
    session: String,
    owner: SidecarOwner,
}
impl Drop for Owner {
    fn drop(&mut self) {
        crate::sidecar::schedule_release_session_sidecar(
            self.manager.clone(),
            self.session.clone(),
            self.owner.clone(),
        );
    }
}
async fn admission_state(
    manager: &ManagedSidecarManager,
    sid: &str,
    request: &RemoteSessionRequest,
    generation: u64,
    memory: &MemoryBudget,
) -> super::remote_admission::AdmissionState {
    use super::remote_admission::AdmissionState;
    if manager.lock().is_ok_and(|m| !m.is_live(sid, generation)) {
        return AdmissionState::Exited;
    }
    let Ok(Some(dispatch)) = session(manager, sid) else {
        return AdmissionState::Pending;
    };
    if dispatch.generation() != generation {
        return AdmissionState::Exited;
    }
    let receipt = RemoteSessionRequest::Receipt {
        agent_id: request.agent_id().into(),
        operation_id: request.operation_id().expect("mutation"),
    };
    let Ok((value, _)) = post(
        &dispatch,
        "/api/remote-session",
        json!({"request":receipt,"generation":generation.to_string()}),
        memory,
    )
    .await
    else {
        return AdmissionState::Pending;
    };
    let Ok(ResponseResult::RemoteSession { data }) = result(&receipt, value) else {
        return AdmissionState::Pending;
    };
    if !matches!(&data,RemoteSessionResult::Receipt{session_id:Some(receipt_sid),..} if receipt_sid==sid)
    {
        return AdmissionState::Pending;
    }
    match data {
        RemoteSessionResult::Receipt {
            status: RemoteReceiptStatus::Accepted,
            ..
        } => AdmissionState::Accepted,
        RemoteSessionResult::Receipt {
            status: RemoteReceiptStatus::Rejected,
            ..
        } => AdmissionState::Rejected,
        RemoteSessionResult::Receipt {
            status: RemoteReceiptStatus::Unconfirmed,
            ..
        } => {
            let snapshot = RemoteSessionRequest::Get {
                agent_id: request.agent_id().into(),
                session_id: sid.into(),
                limit: 1,
                before: None,
            };
            if let Ok((value, _)) = post(
                &dispatch,
                "/api/remote-session",
                json!({"request":snapshot,"generation":generation.to_string()}),
                memory,
            )
            .await
            {
                if let Ok(ResponseResult::RemoteSession {
                    data:
                        RemoteSessionResult::Snapshot {
                            state:
                                myagents_host_management_protocol::RemoteSessionState::Running
                                | myagents_host_management_protocol::RemoteSessionState::WaitingUserAction,
                            ..
                        },
                }) = result(&snapshot, value)
                {
                    return AdmissionState::Busy;
                }
            }
            AdmissionState::Pending
        }
        _ => AdmissionState::Pending,
    }
}
fn retain_admission(
    app: tauri::AppHandle,
    owner: Owner,
    request: RemoteSessionRequest,
    generation: u64,
    memory: MemoryBudget,
) -> Result<(), NetworkError> {
    static ADMISSIONS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let permit = ADMISSIONS
        .get_or_init(|| {
            std::sync::Arc::new(tokio::sync::Semaphore::new(
                myagents_agent_network_protocol::budget("pending"),
            ))
        })
        .clone()
        .try_acquire_owned()
        .map_err(|_| NetworkError::new("RESOURCE_EXHAUSTED"))?;
    let allocation = memory.reserve(super::memory::measure(&request)?.0 * 3 + 4096)?;
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let _allocation = allocation;
        let manager = owner.manager.clone();
        let sid = owner.session.clone();
        let (owner, state) = super::remote_admission::retain_owner(
            owner,
            Duration::from_secs(3600),
            Duration::from_secs(2),
            || admission_state(&manager, &sid, &request, generation, &memory),
        )
        .await;
        if matches!(
            state,
            super::remote_admission::AdmissionState::Accepted
                | super::remote_admission::AdmissionState::Busy
        ) {
            let _ = crate::sidecar::start_headless_background_completion(&app, &manager, &sid);
        }
        drop(owner);
    });
    Ok(())
}
fn result(request: &RemoteSessionRequest, value: Value) -> Result<ResponseResult, NetworkError> {
    let data: RemoteSessionResult =
        serde_json::from_value(value).map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    data.validate()
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if !request.matches_result(&data) {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    Ok(ResponseResult::RemoteSession { data })
}
pub(crate) async fn execute(
    app: &tauri::AppHandle,
    manager: &ManagedSidecarManager,
    request: RemoteSessionRequest,
    memory: MemoryBudget,
    account: super::account::NetworkAccountSession,
    lifetime: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(ResponseResult, Allocation), NetworkError> {
    let guard = || {
        account.ensure_current()?;
        if !lifetime.load(std::sync::atomic::Ordering::Acquire) {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        Ok(())
    };
    guard()?;
    request
        .validate()
        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_REQUEST_INVALID"))?;
    // Precheck uses authoritative Global registry and metadata, never remote paths.
    let global_dispatch = global(manager)?;
    let mut scope = json!({"localAgentId":request.agent_id()});
    if let Some(sid) = request.session_id() {
        scope["localSessionId"] = json!(sid);
    }
    let (identity, _) = post(
        &global_dispatch,
        "/api/admin/agent/network-precheck",
        scope,
        &memory,
    )
    .await?;
    let identity: super::local_owner::TargetIdentity = serde_json::from_value(identity)
        .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
    if identity.local_agent_id != request.agent_id()
        || identity.local_session_id.as_deref() != request.session_id()
    {
        return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
    }
    let mut prepared = None;
    guard()?;
    if matches!(request, RemoteSessionRequest::Start { .. }) {
        let (value, allocation) = post(
            &global_dispatch,
            "/api/remote-session/prepare",
            json!({"request":request}),
            &memory,
        )
        .await?;
        if let Some(receipt) = value.get("receipt") {
            return Ok((result(&request, receipt.clone())?, allocation));
        }
        let value: Prepared = serde_json::from_value(value)
            .map_err(|_| NetworkError::new("TARGET_RECEIPT_INVALID"))?;
        if value.agent_id != request.agent_id()
            || value.workspace_path != identity.workspace_path
            || uuid::Uuid::parse_str(&value.session_id).is_err()
        {
            return Err(NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"));
        }
        prepared = Some(value);
    }
    drop(global_dispatch);
    guard()?;
    let session_id = prepared
        .as_ref()
        .map(|p| p.session_id.as_str())
        .or(request.session_id());
    let mut transient = None;
    let mut lifecycle = None;
    if matches!(
        request,
        RemoteSessionRequest::Start { .. } | RemoteSessionRequest::Send { .. }
    ) {
        let sid = session_id.ok_or_else(|| NetworkError::new("TARGET_OWNER_SCOPE_MISMATCH"))?;
        let guard = std::sync::Arc::new(crate::sidecar::acquire_session_lifecycle(&[sid]).await);
        let owner = SidecarOwner::Agent(format!("remote-session-{}", uuid::Uuid::new_v4()));
        transient = Some(Owner {
            manager: manager.clone(),
            session: sid.into(),
            owner: owner.clone(),
        });
        // Prepared metadata is the birth authority. Reject a missing snapshot,
        // and never reread a changed Agent as an override for an existing Session.
        if crate::sidecar::resolve_session_runtime_identity_full(sid).is_none() {
            return Err(NetworkError::new("TARGET_SESSION_IDENTITY_MISSING"));
        }
        crate::sidecar::ensure_session_sidecar_with_runtime_identity_override_lifecycle_held(
            guard.clone(),
            app.clone(),
            manager.clone(),
            sid.into(),
            PathBuf::from(&identity.workspace_path),
            owner,
            None,
            None,
        )
        .await
        .map_err(|_| NetworkError::new("TARGET_PREPARATION_FAILED"))?;
        lifecycle = Some(guard);
    }
    let dispatch = if let Some(sid) = session_id {
        match session(manager, sid)? {
            Some(dispatch) => dispatch,
            None if matches!(request, RemoteSessionRequest::Get { .. }) => global(manager)?,
            None => return Err(NetworkError::new("TARGET_OWNER_UNAVAILABLE")),
        }
    } else {
        global(manager)?
    };
    // Approval and stop are generation fenced before any mutation is attempted.
    if let RemoteSessionRequest::Respond { generation, .. }
    | RemoteSessionRequest::Stop { generation, .. } = &request
    {
        if generation != &dispatch.generation().to_string() {
            return Err(NetworkError::new("TARGET_GENERATION_CHANGED"));
        }
    }
    let mut body = json!({"request":request,"generation":dispatch.generation().to_string()});
    if let Some(p) = prepared.as_ref() {
        body["preparedSessionId"] = json!(p.session_id);
    }
    guard()?;
    let generation = dispatch.generation();
    // Transfer before the HTTP handoff: dropping the Actor while awaiting an
    // unknown response must not release a still-configuring Session owner.
    if let Some(owner) = transient.take() {
        let receipt = RemoteSessionRequest::Receipt {
            agent_id: request.agent_id().into(),
            operation_id: request.operation_id().expect("mutation"),
        };
        retain_admission(app.clone(), owner, receipt, generation, memory.clone())?;
    }
    let response = post(&dispatch, "/api/remote-session", body, &memory).await;
    let (value, allocation) = match response {
        Ok(v) => v,
        Err(e) if request.mutation() => {
            let data = RemoteSessionResult::Receipt {
                agent_id: request.agent_id().into(),
                operation_id: request.operation_id().expect("mutation"),
                session_id: session_id.map(str::to_owned),
                status: RemoteReceiptStatus::Unconfirmed,
                code: Some(e.code),
            };
            return Ok((
                ResponseResult::RemoteSession { data },
                memory.reserve(1024)?,
            ));
        }
        Err(e) => return Err(e),
    };
    guard()?;
    let result = result(&request, value)?;
    drop(dispatch);
    drop(lifecycle);
    drop(transient);
    Ok((result, allocation))
}
