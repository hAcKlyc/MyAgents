//! One App-owned device connector. Every async job belongs to this connection
//! future: dropping it at an auth/exit boundary cancels HTTP, keys, channels and
//! private bodies together. Neither a Tab nor a Session owns its lifetime.
#[path = "catalog_ack.rs"]
mod catalog_ack;

use super::account::NetworkAccountSession;
use super::calls::{CallableAgent, Calls};
use super::catalog::read_local_catalog;
use super::commands::MetadataRequest;
use super::connection::{initial_hello, send, send_control};
use super::identity::NetworkIdentity;
use super::incoming::{error_outcome, Admission, Incoming};
use super::local_owner;
use super::memory::{measure, Allocation, MemoryBudget};
use super::pairs::{Offer, Pairs, VerifiedOffer};
use super::policy::{hydrate, LocalPolicy};
use super::returns::{Callback, ReturnAdmission, ReturnIntent, SourceReturns, TargetReturns};
use super::transport::{NetworkRoute, NetworkTransport};
use super::NetworkError;
use crate::sidecar::ManagedSidecarManager;
use crate::ulog_warn;
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt, SinkExt, StreamExt};
use myagents_agent_network_protocol::{
    budget, BusinessObject, CatalogSnapshot, ClientMessage, ConnectionScope, Outcome,
    PreviousConnection, ServerEnvelope, ServerMessage, SourceRequest, VerifiedCaller,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkSnapshot {
    pub state: &'static str,
    pub principal_id: Option<String>,
    pub network_id: Option<String>,
    pub device_name: Option<String>,
    pub error: Option<NetworkError>,
    pub revision: u64,
    pub auth_generation: u64,
    pub connection_id: String,
}
struct MetadataCommand {
    generation: u64,
    request: MetadataRequest,
    reply: oneshot::Sender<Result<Value, NetworkError>>,
}
struct RpcCommand {
    allocation: Allocation,
    generation: u64,
    request: SourceRequest,
    caller: VerifiedCaller,
    queued_at: Instant,
    reply: Option<oneshot::Sender<Result<super::calls::CallResult, NetworkError>>>,
}
struct WatchesCommand {
    generation: u64,
    source_session: String,
    cancel: Option<String>,
    all: bool,
    reply: oneshot::Sender<Result<Value, NetworkError>>,
}
enum Command {
    Watches(WatchesCommand),
    Metadata(MetadataCommand),
    Rpc(RpcCommand),
    Management(ManagementCommand),
    Return { generation: u64, callback: Callback },
}
struct ManagementCommand {
    generation: u64,
    queued_at: Instant,
    request: super::management_controller::ManagementRequest,
    sent: Arc<AtomicBool>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    _allocation: Allocation,
    reply: oneshot::Sender<Result<super::management_controller::ManagementResponse, NetworkError>>,
}
impl Command {
    fn reject(self, error: NetworkError) {
        match self {
            Self::Management(command) => {
                let _ = command.reply.send(Err(error));
            }
            Self::Watches(command) => {
                let _ = command.reply.send(Err(error));
            }
            Self::Return { callback, .. } => {
                let _ = callback.reply.send(Err(error));
            }
            Self::Metadata(command) => {
                let _ = command.reply.send(Err(error));
            }
            Self::Rpc(mut command) => {
                if let Some(reply) = command.reply.take() {
                    let _ = reply.send(Err(error));
                }
            }
        }
    }
}
#[derive(Clone, Copy)]
struct Boundary {
    generation: u64,
    auth_generation: u64,
    suspended: bool,
    shutdown: bool,
}
pub(crate) struct AgentNetwork {
    pub(crate) connection_id: String,
    account: Option<NetworkAccountSession>,
    authorized_identity_store: Option<Arc<dyn super::crypto::IdentityStore>>,
    memory: MemoryBudget,
    snapshot: Mutex<NetworkSnapshot>,
    boundary: watch::Sender<Boundary>,
    catalog_changed: Arc<Notify>,
    commands: mpsc::Sender<Command>,
    receiver: Mutex<Option<mpsc::Receiver<Command>>>,
    management_slot: Arc<tokio::sync::Semaphore>,
}
pub(crate) type ManagedConnection = Arc<AgentNetwork>;
pub(crate) use super::registry::ManagedAgentNetwork;
impl AgentNetwork {
    pub(crate) fn new(
        connection_id: String,
        account: Option<NetworkAccountSession>,
        memory: MemoryBudget,
    ) -> ManagedConnection {
        Self::with_generation(connection_id, account, memory, 0)
    }
    pub(crate) fn with_generation(
        connection_id: String,
        account: Option<NetworkAccountSession>,
        memory: MemoryBudget,
        seed: u64,
    ) -> ManagedConnection {
        Self::with_authorized_store(connection_id, account, memory, seed, None)
    }
    pub(crate) fn with_authorized_store(
        connection_id: String,
        account: Option<NetworkAccountSession>,
        memory: MemoryBudget,
        seed: u64,
        authorized_identity_store: Option<Arc<dyn super::crypto::IdentityStore>>,
    ) -> ManagedConnection {
        let (boundary, _) = watch::channel(Boundary {
            generation: seed,
            auth_generation: seed,
            suspended: false,
            shutdown: false,
        });
        let (commands, receiver) = mpsc::channel(budget("pending"));
        Arc::new(Self {
            connection_id,
            account,
            authorized_identity_store,
            memory,
            snapshot: Mutex::new(NetworkSnapshot {
                state: "signedOut",
                principal_id: None,
                network_id: None,
                device_name: None,
                error: None,
                revision: 0,
                auth_generation: seed,
                connection_id: String::new(),
            }),
            boundary,
            catalog_changed: Arc::new(Notify::new()),
            commands,
            receiver: Mutex::new(Some(receiver)),
            management_slot: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }
    pub(crate) fn snapshot(&self) -> NetworkSnapshot {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        snapshot.connection_id = self.connection_id.clone();
        snapshot
    }
    fn publish<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        generation: u64,
        mut snapshot: NetworkSnapshot,
    ) {
        {
            let mut current = self
                .snapshot
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.boundary.borrow().generation != generation {
                return;
            }
            snapshot.connection_id = self.connection_id.clone();
            snapshot.revision = current.revision.saturating_add(1);
            snapshot.auth_generation = self.boundary.borrow().auth_generation;
            *current = snapshot.clone();
        }
        let _ = app.emit("agent-network:changed", snapshot);
    }
    pub(crate) fn auth_boundary<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) {
        let snapshot = {
            let mut current = self
                .snapshot
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.boundary.send_modify(|value| {
                value.generation = value.generation.saturating_add(1);
                value.auth_generation = value.auth_generation.saturating_add(1);
            });
            let snapshot = NetworkSnapshot {
                state: "signedOut",
                principal_id: None,
                network_id: None,
                device_name: None,
                error: None,
                revision: current.revision.saturating_add(1),
                auth_generation: self.boundary.borrow().auth_generation,
                connection_id: self.connection_id.clone(),
            };
            *current = snapshot.clone();
            snapshot
        };
        let _ = app.emit("agent-network:changed", snapshot);
    }
    pub(crate) fn power_boundary(&self, app: &tauri::AppHandle, suspended: bool) {
        let snapshot = {
            let mut current = self
                .snapshot
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            self.boundary.send_modify(|value| {
                value.generation = value.generation.saturating_add(1);
                value.suspended = suspended;
            });
            current.state = "disconnected";
            current.device_name = None;
            current.error = Some(NetworkError::new("NETWORK_POWER_BOUNDARY"));
            current.revision = current.revision.saturating_add(1);
            current.clone()
        };
        let _ = app.emit("agent-network:changed", snapshot);
    }
    pub(crate) fn deactivate(&self) {
        if let Some(account) = &self.account {
            account.deactivate();
        }
        self.stop();
    }
    pub(crate) fn stop(&self) {
        self.boundary.send_modify(|value| {
            value.generation = value.generation.saturating_add(1);
            value.shutdown = true;
        });
    }
    pub(crate) async fn management(
        &self,
        request: super::management_controller::ManagementRequest,
    ) -> Result<super::management_controller::ManagementResponse, NetworkError> {
        let snapshot = self.snapshot();
        if request.connection_id != self.connection_id
            || request.auth_generation != snapshot.auth_generation
            || snapshot.principal_id.as_deref() != Some(request.principal_id.as_str())
            || snapshot.network_id.as_deref() != Some(request.network_id.as_str())
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        if !self
            .account
            .as_ref()
            .is_some_and(NetworkAccountSession::is_management_only)
        {
            return Err(NetworkError::new("OWNED_PROFILE_UNSUPPORTED"));
        }
        if snapshot.state != "ready" {
            return Err(NetworkError::new("CONNECTOR_NOT_READY"));
        }
        request.message(myagents_host_management_protocol::CanonicalUuid::new(
            uuid::Uuid::new_v4(),
        ))?;
        let allocation = self
            .memory
            .reserve(measure(&request.params)?.0.saturating_mul(3) + budget("controlBytes"))?;
        let permit = self
            .management_slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| NetworkError::new("HOST_MANAGEMENT_BUSY"))?;
        let mutation = request.mutation();
        let sent = Arc::new(AtomicBool::new(false));
        let phase = *self.boundary.borrow();
        let (reply, response) = oneshot::channel();
        self.commands
            .try_send(Command::Management(ManagementCommand {
                generation: phase.generation,
                queued_at: Instant::now(),
                request,
                sent: sent.clone(),
                _permit: permit,
                _allocation: allocation,
                reply,
            }))
            .map_err(|_| NetworkError::new("NETWORK_REQUEST_CAPACITY"))?;
        // Dropping the owning connection or a deadline never proves a write failed.
        tokio::time::timeout(Duration::from_secs(34), response)
            .await
            .map_err(|_| {
                super::management_controller::lost(mutation, sent.load(Ordering::Acquire))
            })?
            .map_err(|_| {
                super::management_controller::lost(mutation, sent.load(Ordering::Acquire))
            })?
    }
    pub(crate) async fn request(&self, request: MetadataRequest) -> Result<Value, NetworkError> {
        // Validate before queueing, and keep the queued payload metadata-only.
        let mutation = request.body()?.is_some();
        if self.snapshot().state != "ready" {
            return Err(NetworkError::new("CONNECTOR_NOT_READY"));
        }
        let phase = *self.boundary.borrow();
        let generation = phase.generation;
        let (reply, response) = oneshot::channel();
        self.commands
            .try_send(Command::Metadata(MetadataCommand {
                generation,
                request,
                reply,
            }))
            .map_err(|_| NetworkError::new("NETWORK_REQUEST_CAPACITY"))?;
        // After queue handoff, timeout or a dropped connection future cannot
        // prove a settings write failed. Reads have no uncertain save outcome.
        // A power/transport boundary also cannot prove an account change.
        let lost = || {
            metadata_response_lost(
                mutation,
                self.boundary.borrow().auth_generation != phase.auth_generation,
            )
        };
        tokio::time::timeout(Duration::from_secs(35), response)
            .await
            .map_err(|_| lost())?
            .map_err(|_| lost())?
    }
    pub(crate) async fn return_event(
        &self,
        target_session: String,
        reference: crate::inbox::types::NetworkReturnReference,
        event: Value,
    ) -> Result<myagents_agent_network_protocol::ReturnSettlement, NetworkError> {
        if self.snapshot().state != "ready" {
            return Err(NetworkError::new("CONNECTOR_NOT_READY"));
        }
        let bytes = measure(&event)?.0;
        if bytes > budget("objectBytes") {
            return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
        }
        let allocation = self
            .memory
            .reserve(bytes.saturating_mul(2) + budget("controlBytes"))?;
        let (reply, response) = oneshot::channel();
        self.commands
            .try_send(Command::Return {
                generation: self.generation(),
                callback: Callback {
                    target_session,
                    reference,
                    event,
                    reply,
                    queued_at: Instant::now(),
                    allocation: Some(allocation),
                },
            })
            .map_err(|_| NetworkError::new("NETWORK_REQUEST_CAPACITY"))?;
        tokio::time::timeout(Duration::from_secs(31), response)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(Ok(
                myagents_agent_network_protocol::ReturnSettlement::Unconfirmed,
            ))
    }
    pub(crate) async fn watches(
        &self,
        source_session: String,
        cancel: Option<String>,
        all: bool,
        generation: u64,
    ) -> Result<Value, NetworkError> {
        if self.generation() != generation {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        // Registrations live only in the current ready connection. No replay.
        if self.snapshot().state != "ready" {
            return Ok(serde_json::json!({"watches":[]}));
        }
        let (reply, response) = oneshot::channel();
        self.commands
            .try_send(Command::Watches(WatchesCommand {
                generation,
                source_session,
                cancel,
                all,
                reply,
            }))
            .map_err(|_| NetworkError::new("NETWORK_REQUEST_CAPACITY"))?;
        tokio::time::timeout(Duration::from_secs(10), response)
            .await
            .map_err(|_| NetworkError::new("NETWORK_QUERY_FAILED"))?
            .map_err(|_| NetworkError::new("NETWORK_QUERY_FAILED"))?
    }
    pub(crate) fn generation(&self) -> u64 {
        self.boundary.borrow().generation
    }
    pub(crate) fn catalog_changed(&self) {
        self.catalog_changed.notify_one();
    }
    pub(crate) fn memory_budget(&self) -> MemoryBudget {
        self.memory.clone()
    }
    pub(crate) fn reserve_payload(
        &self,
        value: &impl Serialize,
    ) -> Result<Allocation, NetworkError> {
        let bytes = measure(value)?.0;
        if bytes > budget("objectBytes") {
            return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
        }
        self.memory
            .reserve(bytes.saturating_mul(2) + budget("controlBytes"))
    }
    pub(crate) async fn invoke(
        &self,
        request: SourceRequest,
        caller: VerifiedCaller,
        queued_at: Instant,
        generation: u64,
        allocation: Allocation,
    ) -> Result<super::calls::CallResult, NetworkError> {
        let request = SourceRequest::parse(
            serde_json::to_value(request).map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?,
        )
        .map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?;
        request
            .bind("scope-validation", &caller)
            .map_err(|_| NetworkError::new("EXTERNAL_CLI_CAPABILITY_NOT_OPEN"))?;
        if self.generation() != generation {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        if self.snapshot().state != "ready" {
            return Err(NetworkError::new("CONNECTOR_NOT_READY"));
        }
        let deadline =
            myagents_agent_network_protocol::remote_deadline(request.method(), "connector")
                .expect("closed operation");
        let admission = matches!(request.method(), "session.start" | "session.send");
        let details =
            serde_json::json!({"requestId":request.request_id,"selector":request.selector});
        let (reply, response) = oneshot::channel();
        let remaining = Duration::from_millis(deadline)
            .checked_sub(queued_at.elapsed())
            .ok_or_else(|| NetworkError::new("NETWORK_REQUEST_NOT_SENT"))?;
        self.commands
            .try_send(Command::Rpc(RpcCommand {
                generation,
                allocation,
                request,
                caller,
                queued_at,
                reply: Some(reply),
            }))
            .map_err(|_| NetworkError::new("NETWORK_REQUEST_CAPACITY"))?;
        tokio::time::timeout(remaining + Duration::from_secs(2), response)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_else(|| {
                let mut error = NetworkError::new(if admission {
                    "ADMISSION_UNCONFIRMED"
                } else {
                    "NETWORK_QUERY_FAILED"
                });
                error.details = Some(details);
                Err(error)
            })
    }
}
pub(crate) fn auth_boundary_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(owner) = app.try_state::<ManagedAgentNetwork>() {
        owner.auth_boundary(app);
    }
}
pub(crate) fn start(
    app: tauri::AppHandle,
    owner: ManagedConnection,
    manager: ManagedSidecarManager,
) {
    let mut receiver = owner
        .receiver
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
        .expect("Agent Network owner starts once");
    tauri::async_runtime::spawn(async move {
        let mut boundary = owner.boundary.subscribe();
        let mut previous: Option<(String, PreviousConnection)> = None;
        let mut renewed: Option<NetworkIdentity> = None;
        let mut reconnect = super::reconnect::ReconnectBackoff::default();
        loop {
            let phase = *boundary.borrow_and_update();
            if phase.shutdown {
                break;
            }
            if phase.suspended {
                tokio::select! {
                    _ = boundary.changed() => {},

                }
                continue;
            }
            let retry_after;
            match owner
                .account
                .clone()
                .map(Ok)
                .unwrap_or_else(NetworkAccountSession::capture)
            {
                Ok(account) => {
                    let principal = account.principal_id().ok().map(str::to_owned);
                    let binding = account.binding_id().to_owned();
                    owner.publish(
                        &app,
                        phase.generation,
                        NetworkSnapshot {
                            state: "connecting",
                            principal_id: principal.clone(),
                            network_id: None,
                            device_name: None,
                            error: None,
                            revision: 0,
                            auth_generation: 0,
                            connection_id: String::new(),
                        },
                    );
                    let prior = previous
                        .as_ref()
                        .filter(|(old, _)| *old == binding)
                        .map(|(_, value)| value.clone());
                    let result = {
                        let attempt = connect(
                            &app,
                            &owner,
                            &manager,
                            &mut receiver,
                            account,
                            phase.generation,
                            prior,
                            &mut previous,
                            renewed.take(),
                            &mut reconnect,
                        );
                        tokio::pin!(attempt);
                        tokio::select! { biased;
                            _ = boundary.changed() => None,

                            result = &mut attempt => Some(result),
                        }
                    };
                    let Some(result) = result else {
                        reconnect.reset();
                        previous = None;
                        renewed = None;
                        continue;
                    };
                    let error = match result {
                        Ok(identity) => {
                            reconnect.reset();
                            renewed = Some(identity);
                            continue;
                        }
                        Err(error) => {
                            // A ready connection is a successful recovery, even
                            // if its eventual disconnect returned an error.
                            if owner.snapshot().state == "ready" {
                                reconnect.reset();
                            }
                            retry_after = error.retry_after;
                            Some(error)
                        }
                    };
                    owner.publish(
                        &app,
                        phase.generation,
                        NetworkSnapshot {
                            state: "disconnected",
                            principal_id: principal,
                            network_id: None,
                            device_name: None,
                            error,
                            revision: 0,
                            auth_generation: 0,
                            connection_id: String::new(),
                        },
                    );
                    if owner.snapshot().error.as_ref().is_some_and(|error| {
                        error.code == "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED"
                    }) {
                        // Only explicit recovery may request OS authorization.
                        // Keep the diagnostic stable instead of retrying reads.
                        let _ = boundary.changed().await;
                        continue;
                    }
                }
                Err(error) => {
                    retry_after = error.retry_after;
                    owner.publish(
                        &app,
                        phase.generation,
                        NetworkSnapshot {
                            state: if error.code == "SPACE_REAUTH_REQUIRED" {
                                "signedOut"
                            } else {
                                "unavailable"
                            },
                            principal_id: None,
                            network_id: None,
                            device_name: None,
                            error: Some(error),
                            revision: 0,
                            auth_generation: 0,
                            connection_id: String::new(),
                        },
                    );
                }
            }
            // No business request is kept for reconnection. Reject metadata
            // commands as well; mutations require receipt inspection by caller.
            while let Ok(command) = receiver.try_recv() {
                command.reject(NetworkError::new("CONNECTOR_NOT_READY"));
            }
            let random = uuid::Uuid::new_v4();
            let jitter = u16::from_le_bytes([random.as_bytes()[0], random.as_bytes()[1]]);
            let snapshot = owner.snapshot();
            let code = snapshot
                .error
                .as_ref()
                .map(diagnostic_code)
                .unwrap_or("OTHER_NETWORK_FAILURE");
            let delay = reconnect.next_with_code(jitter, retry_after, code);
            tokio::select! {
                _=tokio::time::sleep(delay)=>{},
                _=boundary.changed()=>{previous=None;renewed=None;reconnect.reset();},
            }
        }
    });
}
/// Only closed, known codes enter diagnostics; even schema-safe upstream text
/// must not become a log payload. Never include error details or account scope.
pub(super) fn diagnostic_code(error: &NetworkError) -> &'static str {
    const CODES: &[&str] = &[
        "ACCOUNT_BINDING_CHANGED",
        "ADMISSION_UNCONFIRMED",
        "BUSINESS_CONTEXT_NOT_FOUND",
        "CATALOG_INVALID",
        "CATALOG_NOT_CURRENT",
        "CATALOG_SEQUENCE_EXHAUSTED",
        "CHANNEL_OFFER_MISSING",
        "CONNECTOR_CAPACITY",
        "CONNECTOR_NOT_READY",
        "CONTROL_INVALID",
        "CONTROL_SCOPE_MISMATCH",
        "CONTROL_UNEXPECTED",
        "DEVICE_ID_UNAVAILABLE",
        "DEVICE_REGISTRATION_INVALID",
        "DEVICE_REVOKED",
        "ENROLLMENT_KEY_INVALID",
        "EXTERNAL_CLI_CAPABILITY_NOT_OPEN",
        "HOST_ADDRESS_INVALID",
        "HOST_MANAGEMENT_BUSY",
        "HOST_MANAGEMENT_CONNECTION_RESET",
        "IDENTITY_CERTIFICATE_INVALID",
        "IDENTITY_KEY_MISMATCH",
        "IDENTITY_REQUEST_INVALID",
        "IDENTITY_RESPONSE_INVALID",
        "IDENTITY_SCOPE_MISMATCH",
        "IDENTITY_STATE_INVALID",
        "INVALID_REFERENCE",
        "KEY_GENERATION_EXHAUSTED",
        "MESSAGE_TOO_LARGE",
        "NETWORK_ACCOUNT_RESPONSE_INVALID",
        "NETWORK_ACCOUNT_UNAVAILABLE",
        "NETWORK_BACKPRESSURE",
        "NETWORK_BUFFER_LIMIT",
        "NETWORK_CERTIFICATE_INVALID",
        "NETWORK_CONFIG_INVALID",
        "NETWORK_CONFIG_UNAVAILABLE",
        "NETWORK_CONFIG_WRITE_FAILED",
        "NETWORK_CONNECTION_CLOSED",
        "NETWORK_CONNECTION_NOT_FOUND",
        "NETWORK_CONNECTION_TIMEOUT",
        "NETWORK_CREDENTIAL_BACKEND_UNSUPPORTED",
        "NETWORK_CREDENTIAL_CORRUPT",
        "NETWORK_CREDENTIAL_GENERATION_CONFLICT",
        "NETWORK_CREDENTIAL_KEY_MISSING",
        "NETWORK_CREDENTIAL_PATH_UNSAFE",
        "NETWORK_CREDENTIAL_PERSISTENCE_UNCONFIRMED",
        "NETWORK_CREDENTIAL_STORE_INVALID",
        "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED",
        "NETWORK_CREDENTIAL_STORE_UNAVAILABLE",
        "NETWORK_DESCRIPTOR_INVALID",
        "NETWORK_ENDPOINT_INVALID",
        "NETWORK_FEATURE_DISABLED",
        "NETWORK_KEY_INVALID",
        "NETWORK_METADATA_INVALID",
        "NETWORK_PEER_BINDING_MISMATCH",
        "NETWORK_POWER_BOUNDARY",
        "NETWORK_PRIVATE_KEY_MISSING",
        "NETWORK_PROOF_INVALID",
        "NETWORK_PROTOCOL_UNSUPPORTED",
        "NETWORK_PROXY_INVALID",
        "NETWORK_QUERY_FAILED",
        "NETWORK_REFERENCE_INVALID",
        "NETWORK_REMOVAL_UNCONFIRMED",
        "NETWORK_REQUEST_CAPACITY",
        "NETWORK_REQUEST_INVALID",
        "NETWORK_REQUEST_NOT_SENT",
        "NETWORK_REQUEST_UNCONFIRMED",
        "NETWORK_RESPONSE_INVALID",
        "NETWORK_SCOPE_MISMATCH",
        "NETWORK_TLS_FAILED",
        "NETWORK_TOKEN_EXPIRED",
        "NETWORK_TOKEN_INVALID",
        "NETWORK_TRANSPORT_FAILED",
        "NETWORK_TRUST_CHANGED",
        "NETWORK_UPGRADE_REJECTED",
        "NETWORK_URL_INVALID",
        "OFFICIAL_NETWORK_CANNOT_REMOVE",
        "OWNED_BROWSER_UNAVAILABLE",
        "OWNED_CA_FILE_INVALID",
        "OWNED_JOIN_REQUIRED",
        "OWNED_JOIN_UNCONFIRMED",
        "OWNED_LOGIN_CANCELLED",
        "OWNED_LOGIN_EXPIRED",
        "OWNED_LOGIN_INVALID",
        "OWNED_LOGIN_NOT_FOUND",
        "OWNED_LOGIN_RESULT_UNAVAILABLE",
        "OWNED_LOGIN_SUPERSEDED",
        "OWNED_PROFILE_UNSUPPORTED",
        "OWNED_REQUEST_INVALID",
        "OWNED_RESPONSE_INVALID",
        "OWNED_RESPONSE_TOO_LARGE",
        "OWNED_SESSION_INVALID",
        "PAGE_LIMIT_INVALID",
        "PERMIT_INVALID",
        "PROOF_REJECTED",
        "PROTOCOL_INVALID",
        "SESSION_EXPIRED",
        "SOURCE_CATALOG_INVALID",
        "SOURCE_CATALOG_NOT_EMPTY",
        "SPACE_REAUTH_REQUIRED",
        "TARGET_PREPARATION_MISSING",
        "TLS_FRAME_INVALID",
        "UNAUTHORIZED",
    ];
    CODES
        .iter()
        .copied()
        .find(|code| *code == error.code)
        .unwrap_or("OTHER_NETWORK_FAILURE")
}
/// A connection-scoped fence for original owner jobs that have crossed the
/// final handoff. They finish their ACK, then release remote watch resources
/// if this connection disappeared while registration was in flight.
struct ConnectionLifetime(Arc<AtomicBool>);
impl Drop for ConnectionLifetime {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn identity_check_delay() -> Duration {
    // One task per active device context, 5.5–6h jitter. Idle connections do
    // not poll Space or renew certificates; offers still renew on demand.
    let random = uuid::Uuid::new_v4();
    let jitter = u16::from_le_bytes([random.as_bytes()[0], random.as_bytes()[1]]) as u64 % 1801;
    Duration::from_secs(5 * 3600 + 1800 + jitter)
}
enum Work {
    Returned {
        channel_id: String,
        op_id: String,
        return_route_id: String,
        event_id: String,
        settlement: myagents_agent_network_protocol::ReturnSettlement,
        allocation: Option<Allocation>,
    },
    Metadata {
        allocation: Option<Allocation>,
        reply: oneshot::Sender<Result<Value, NetworkError>>,
        result: Result<Value, NetworkError>,
    },
    Catalog(Result<u64, NetworkError>),
    Hydrate {
        catalog_seq: u64,
        result: Result<LocalPolicy, NetworkError>,
    },
    Precheck {
        op_id: String,
        result: Result<local_owner::PreparedTarget, Outcome>,
    },
    Executed {
        op_id: String,
        return_route_id: Option<String>,
        outcome: Outcome,
        allocation: Option<Allocation>,
    },
    Peer {
        offer: Offer,
        result: Result<NetworkIdentity, NetworkError>,
    },
    RenewIdentity(Result<NetworkIdentity, NetworkError>),
    Offer {
        channel_id: String,
        result: Result<VerifiedOffer, NetworkError>,
    },
    Resolve {
        op_id: String,
        result: Result<CallableAgent, NetworkError>,
    },
}
async fn connect(
    app: &tauri::AppHandle,
    owner: &AgentNetwork,
    manager: &ManagedSidecarManager,
    commands: &mut mpsc::Receiver<Command>,
    account: NetworkAccountSession,
    generation: u64,
    previous: Option<PreviousConnection>,
    previous_out: &mut Option<(String, PreviousConnection)>,
    renewed: Option<NetworkIdentity>,
    reconnect: &mut super::reconnect::ReconnectBackoff,
) -> Result<NetworkIdentity, NetworkError> {
    let mut identity = match renewed {
        Some(identity) if identity.account.binding_id() == account.binding_id() => {
            account.ensure_current()?;
            identity
        }
        _ => match &owner.authorized_identity_store {
            Some(store) => {
                NetworkIdentity::initialize_with_store(account, None, store.clone()).await?
            }
            None => NetworkIdentity::initialize(account, None).await?,
        },
    };
    let transport = Arc::new(NetworkTransport::new_with_public_ca(
        &identity.network_url,
        identity.device_key(),
        owner.memory.clone(),
        identity.account.public_tls_ca(),
    )?);
    if let NetworkAccountSession::Owned(account) = &identity.account {
        let join = account.join_authorized.swap(false, Ordering::AcqRel);
        super::owned_admission::enroll(&identity, &transport, join).await?;
    }
    let mut socket = transport.websocket(&identity.token).await?;
    send(
        &mut socket,
        ClientMessage::Hello {
            client_version: env!("CARGO_PKG_VERSION").into(),
            capabilities: if identity.account.is_management_only() {
                vec!["tls13-mtls".into()]
            } else {
                ["tls13-mtls", "typed-rpc", "permit-v1", "return-v1"]
                    .map(str::to_owned)
                    .to_vec()
            },
            previous_connection: previous,
        },
    )
    .await?;
    let (scope, local, resume) = initial_hello(&mut socket, &identity).await?;
    let management_only = identity.account.is_management_only();
    *previous_out = Some((identity.account.binding_id().to_owned(), resume));
    let connection_lifetime = ConnectionLifetime(Arc::new(AtomicBool::new(true)));
    let mut work: FuturesUnordered<BoxFuture<'static, Work>> = FuturesUnordered::new();
    let mut pairs = if management_only {
        Pairs::new_management(
            owner.memory.clone(),
            myagents_host_management_protocol::PeerRole::Controller,
        )
    } else {
        Pairs::new(owner.memory.clone())
    };
    let mut calls = Calls::default();
    let mut source_returns = SourceReturns::default();
    let mut target_returns = TargetReturns::new(manager.clone(), owner.connection_id.clone());
    let mut incoming_calls = Incoming::new(owner.memory.clone());
    // Compact dedup/route/sequence registries and a bounded metadata snapshot.
    let _registry_allocation = owner
        .memory
        .reserve(budget("dedupBytes") + budget("catalogBytes"))?;
    let mut prepared_targets = HashMap::<String, local_owner::PreparedTarget>::new();
    let mut catalog_seq = 1;
    let mut catalog_busy = true;
    let mut pending_offers = HashMap::<String, (Offer, NetworkIdentity)>::new();
    let mut hydrated = false;
    let mut local_policy = None::<LocalPolicy>;
    let mut hydrate_busy = false;
    let mut hydrate_dirty = false;
    let mut ready_requested = false;
    let mut last_server = Instant::now();
    let mut last_ping = Instant::now();
    let mut next_identity_check = None::<Instant>;
    let mut identity_check_busy = false;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    work.push(catalog_work(
        manager.clone(),
        transport.clone(),
        identity.token.clone(),
        scope.clone(),
        catalog_seq,
        management_only,
    ));
    loop {
        identity.account.ensure_current()?;
        tokio::select! {
            incoming = socket.next() => {
                last_server = Instant::now();
                match incoming {
                    Some(Ok(Message::Ping(bytes))) => socket.send(Message::Pong(bytes)).await
                        .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Text(text))) => {
                        if text=="ma-network-pong" {continue;}
                        let envelope = ServerEnvelope::parse(text.as_bytes()).map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
                        if envelope.message.scope().is_some_and(|current| current != &scope) { return Err(NetworkError::new("CONTROL_SCOPE_MISMATCH")); }
                        if management_only { super::owned_profile::control(&envelope.message)?; }
                        if management_only && pairs.consume_retired_management(
                            &envelope.message, &scope, &local, &scope.connection_epoch,
                        )? { continue; }
                        match envelope.message {
                            ServerMessage::Ready { catalog_seq: accepted, .. } if ready_requested && accepted == catalog_seq && local_policy.is_some() => {
                                hydrated = true;
                                reconnect.recovered();
                                owner.publish(app, generation, NetworkSnapshot { connection_id:owner.connection_id.clone(),state: "ready", principal_id: Some(local.principal_id.clone()),
                                    network_id: Some(local.network_id.clone()), device_name: local_policy.as_ref().map(|policy| policy.device_name.clone()), error: None, revision: 0, auth_generation: 0 });
                            }
                            ServerMessage::Changed { change, .. } => {
                                if matches!(change, myagents_agent_network_protocol::ChangeScope::Settings | myagents_agent_network_protocol::ChangeScope::Catalog) {
                                    local_policy = None; hydrate_dirty = true;
                                }
                                let snapshot = owner.snapshot(); owner.publish(app, generation, snapshot);
                            }
                            ServerMessage::AuthRefreshed { expires_at, .. } if expires_at == identity.access.exp => {},
                            ServerMessage::Error { code, retryable } => {let mut error=NetworkError::cloud(&code,400);error.retryable=retryable;
                                if let Some(op)=incoming_calls.control_op(&envelope.control_id) {
                                    prepared_targets.remove(&op);
                                    if let Some((channel,response,_allocation))=incoming_calls.finish(&op,error_outcome(error)) {let _=pairs.send(&channel,BusinessObject::Response(response));}
                                } else if !target_returns.control_failed(&envelope.control_id,error.clone())&&!calls.control_failed(&envelope.control_id,error.clone()) {return Err(error);}
                            }
                            ServerMessage::ChannelOffer { channel_id, initiator, responder, initiator_connection_epoch,
                                responder_connection_epoch, initiator_binding, responder_binding, .. } => {
                                if management_only {
                                    pairs.reserve_management_retirement(&channel_id,&scope,&local)?;
                                    pairs.retire_management(&channel_id,true);
                                    send(&mut socket, ClientMessage::Close {scope:scope.clone(),channel_id,reason:"TARGET_UNAVAILABLE".into()}).await?;
                                    continue;
                                }
                                if work.len() >= budget("pending") { return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY")); }
                                if let Err(error) = pairs.reserve(&channel_id) {
                                    send(&mut socket, ClientMessage::Close { scope: scope.clone(), channel_id, reason: error.code }).await?;
                                    continue;
                                }
                                let offer = Offer { channel_id: channel_id.clone(), initiator, responder, initiator_epoch: initiator_connection_epoch,
                                    responder_epoch: responder_connection_epoch, initiator_binding, responder_binding };
                                offer.validate_scope(&local,&scope.connection_epoch)?;
                                let identity=identity.clone();
                                work.push(async move {Work::Peer {offer,result:identity.ensure_peer().await}}.boxed());
                            }
                            ServerMessage::ChannelAccepted {channel_id,initiator_binding,responder_binding,..} => {
                                pairs.accepted(&channel_id)?;
                                let (mut offer,identity)=pending_offers.remove(&channel_id).ok_or_else(||NetworkError::new("CHANNEL_OFFER_MISSING"))?;
                                offer.initiator_binding=Some(initiator_binding);offer.responder_binding=Some(responder_binding);
                                let local=local.clone();let epoch=scope.connection_epoch.clone();
                                work.push(async move {Work::Offer {channel_id,result:offer.verify(&identity,&local,&epoch).await}}.boxed());
                            }
                            ServerMessage::Credit {channel_id,sequence,received_bytes,..} => {
                                if management_only && !pairs.has_channel(&channel_id) { return Err(NetworkError::new("CONTROL_UNEXPECTED")); }
                                pairs.credit(&channel_id,sequence,received_bytes)?
                            },
                            ServerMessage::ChannelReady { channel_id, .. } => pairs.ready(&channel_id)?,
                            ServerMessage::ChannelClosed { channel_id, .. } => {
                                if management_only && !pairs.has_channel(&channel_id) { return Err(NetworkError::new("CONTROL_UNEXPECTED")); }
                                pairs.remove(&channel_id);pending_offers.remove(&channel_id);calls.channel_closed(&channel_id);target_returns.channel_closed(&channel_id);
                                for op in incoming_calls.channel_ops(&channel_id) {
                                    prepared_targets.remove(&op);
                                    incoming_calls.finish(&op,error_outcome(NetworkError::new("ADMISSION_UNCONFIRMED")));
                                }
                            }
                            ServerMessage::OpPrepared { op_id, target_mount_id, target, target_connection_epoch, .. } => {
                                match calls.prepared(&envelope.control_id, &op_id, &target_mount_id, &target, &target_connection_epoch, &local) {
                                    Ok((channel_id, object)) => { if let Err(error) = pairs.send(&channel_id, object) { calls.fail(&op_id, error); } }
                                    Err(error) if error.code == "OP_NOT_CURRENT" => {
                                        send(&mut socket, ClientMessage::Release { scope: scope.clone(), op_id }).await?;
                                    }
                                    Err(error) => return Err(error),
                                }
                            }
                            permit @ ServerMessage::Permit {..} => {
                                identity.account.ensure_current()?;
                                if owner.generation()!=generation {return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));}
                                let invocation=match incoming_calls.permit(&envelope.control_id,&permit,&local,&scope) {
                                    Ok(invocation)=>invocation,
                                    Err(error) if error.code=="PERMIT_ALREADY_CONSUMED"||error.code=="OP_NOT_CURRENT"=>continue,
                                    Err(error) if error.code=="PERMIT_EXPIRED"=>{
                                        if let ServerMessage::Permit {op_id,return_route_id,..}=&permit {
                                            prepared_targets.remove(op_id);
                                            if let Some((channel,response,_allocation))=incoming_calls.finish(op_id,error_outcome(error)) {let _=pairs.send(&channel,BusinessObject::Response(response));}
                                            send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id:return_route_id.clone(),reason:"PERMIT_EXPIRED".into()}).await?;
                                        }
                                        continue;
                                    },
                                    Err(error)=>return Err(error),
                                };
                                let manager=manager.clone();let op_id=invocation.op_id.clone();let return_route_id=invocation.return_route_id.clone();
                                let prepared=prepared_targets.remove(&op_id).ok_or_else(||NetworkError::new("TARGET_PREPARATION_MISSING"))?;
                                if let Err(error)=target_returns.register(&invocation,&permit,prepared.identity.local_session_id.as_deref()) {
                                    if let Some((channel,response,_allocation))=incoming_calls.finish(&op_id,error_outcome(error)) {let _=pairs.send(&channel,BusinessObject::Response(response));}
                                    send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id:return_route_id.expect("permit route"),reason:"RETURN_CAPACITY".into()}).await?;
                                    continue;
                                }
                                let watch_alive=target_returns.watch_lifetime(&op_id);
                                let connection_id=owner.connection_id.clone();let memory=owner.memory.clone();let app=app.clone();let account=identity.account.clone();let connection_alive=connection_lifetime.0.clone();let deadline=incoming_calls.admitted_until(&op_id).ok_or_else(||NetworkError::new("PERMIT_INVALID"))?;
                                work.push(async move {
                                    let mut allocation = None;
                                    let outcome=if let Some(fresh)=prepared.fresh {
                                        let reference=if matches!(&invocation.operation,myagents_agent_network_protocol::Operation::Start(p) if p.reply_back) {
                                            Some(crate::inbox::types::NetworkReturnReference {connection_id:Some(connection_id.clone()),op_id:uuid::Uuid::parse_str(&op_id).expect("validated op"),
                                                return_route_id:uuid::Uuid::parse_str(return_route_id.as_deref().expect("validated permit")).expect("validated route")})
                                        } else {None};
                                        let guard_app=app.clone();
                                        local_owner::start_outcome(fresh.admit(&app,reference,move || {
                                            account.ensure_current().map_err(|error|error.code)?;
                                            if !connection_alive.load(Ordering::Acquire)||guard_app.state::<ManagedAgentNetwork>().current_generation(&connection_id)!=Some(generation) {return Err("ACCOUNT_BINDING_CHANGED".into());}
                                            if Instant::now()>=deadline {return Err("PERMIT_EXPIRED".into());}Ok(())
                                        }).await)
                                    } else if let Some(send)=prepared.send {
                                        let myagents_agent_network_protocol::Operation::Send(params)=&invocation.operation else {unreachable!("prepared send operation")};
                                        let reference=if params.reply_back {Some(crate::inbox::types::NetworkReturnReference {connection_id:Some(connection_id.clone()),op_id:uuid::Uuid::parse_str(&op_id).expect("validated op"),return_route_id:uuid::Uuid::parse_str(return_route_id.as_deref().expect("validated route")).expect("validated route")})}else{None};
                                        let guard_app=app.clone();
                                        local_owner::send_outcome(params,send.admit_network(&app,reference,move || {
                                            account.ensure_current().map_err(|error|error.code)?;
                                            if !connection_alive.load(Ordering::Acquire)||guard_app.state::<ManagedAgentNetwork>().current_generation(&connection_id)!=Some(generation) {return Err("ACCOUNT_BINDING_CHANGED".into());}
                                            if Instant::now()>=deadline {return Err("PERMIT_EXPIRED".into());}Ok(())
                                        }).await)
                                    } else if matches!(&invocation.operation,myagents_agent_network_protocol::Operation::Watch(_)) {
                                        let guard_app=app.clone();
                                        let (outcome,reserved)=local_owner::watch(&app,&manager,&invocation,memory,connection_id.clone(),move || {
                                            account.ensure_current().map_err(|error|error.code)?;
                                            if !connection_alive.load(Ordering::Acquire)||guard_app.state::<ManagedAgentNetwork>().current_generation(&connection_id)!=Some(generation) {return Err("ACCOUNT_BINDING_CHANGED".into());}
                                            if watch_alive.as_ref().is_some_and(|alive| !alive.load(Ordering::Acquire)) {return Err("WATCH_CANCELLED".into());}
                                            if Instant::now()>=deadline {return Err("PERMIT_EXPIRED".into());}Ok(())
                                        }).await;
                                        allocation=reserved;outcome
                                    } else { match local_owner::read(&manager,&invocation.operation,memory).await {
                                        Ok((outcome, reserved)) => { allocation=Some(reserved); outcome }, Err(error) => error_outcome(error)
                                    }};
                                    let expects_return=match &outcome {
                                        Outcome::Start {result}=>result["replyBack"]==true&&result["accepted"]!=false,
                                        Outcome::Send {result}=>result["replyBack"]==true&&(result["delivered"]==true||result["unconfirmed"]==true),
                                        Outcome::Watch {result}=>result["watched"]==true&&result["delivery"]=="registered"&&result["coalesced"]!=true,_=>false,
                                    };
                                    Work::Executed {op_id,return_route_id:if expects_return {None} else {return_route_id},outcome,allocation}
                                }.boxed());
                            }
                            ref route @ ServerMessage::RouteOpened {ref source,..} if source==&local => {
                                match calls.route_opened(route,&local,&scope) {
                                    Ok(())=>source_returns.route(route)?,
                                    Err(error) if error.code=="OP_NOT_CURRENT"=>{},
                                    Err(error)=>return Err(error),
                                }
                            }
                            ServerMessage::RouteClosed {return_route_id,..}=> {source_returns.close_route(&return_route_id);target_returns.close_route(&return_route_id);},
                            ServerMessage::RouteRebound {return_route_id,channel_id,..}=> {
                                match target_returns.rebound(&envelope.control_id,&return_route_id,&channel_id) {
                                    Ok(object)=> {if let Err(error)=pairs.send(&channel_id,object) {target_returns.close_route(&return_route_id);send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id,reason:error.code}).await?;}},
                                    Err(error) if error.code=="RETURN_NOT_PENDING"=>{},
                                    Err(error)=>return Err(error),
                                }
                            },
                            ServerMessage::RouteOpened {..} => {},
                            ServerMessage::Hello {..} | ServerMessage::Ready {..} | ServerMessage::AuthRefreshed {..} => return Err(NetworkError::new("CONTROL_UNEXPECTED")),
                        }
                    }
                    Some(Ok(Message::Binary(bytes))) => {
                        let (channel_id, payload) = myagents_agent_network_protocol::decode_tls_frame(&bytes)
                            .map_err(|_| NetworkError::new("TLS_FRAME_INVALID"))?;
                        if management_only {
                            pairs.remove(&channel_id);
                            send(&mut socket,ClientMessage::Close {scope:scope.clone(),channel_id,reason:"TARGET_UNAVAILABLE".into()}).await?;
                            continue;
                        }
                        match pairs.feed(&channel_id, payload) {
                            Ok((objects,_decoded_allocation)) => {
                                let (sequence,received_bytes)=pairs.release_credit(&channel_id,bytes.len())?;
                                send(&mut socket,ClientMessage::Credit {scope:scope.clone(),channel_id:channel_id.clone(),sequence,received_bytes}).await?;
                                for object in objects {
                                    // A response/ACK write can retire this pair while
                                    // dispatching the current decoded batch. Remaining
                                    // objects cannot use a retired pair's identity.
                                    if !pairs.has_channel(&channel_id) { break; }
                                    match object {
                                        BusinessObject::Response(response) => {
                                            source_returns.response(&response.op_id,&response.outcome)?;
                                            if let Some(op_id) = calls.response(&channel_id, response)? {
                                                send(&mut socket, ClientMessage::Release { scope: scope.clone(), op_id }).await?;
                                            }
                                        }
                                        BusinessObject::Invoke(invocation) => {
                                            let (peer,epoch)=pairs.peer(&channel_id)?;
                                            let op_id=invocation.op_id.clone();
                                            let request_id=invocation.request_id.clone();
                                            match incoming_calls.insert(invocation,&channel_id,peer,epoch,&local,pairs.buffered_bytes()+calls.bytes()+source_returns.bytes()+target_returns.bytes()) {
                                                Ok(Admission::New) => {
                                                    let preparation=incoming_calls.preparation(&op_id)?;
                                                    let manager=manager.clone();let app=app.clone();
                                                    work.push(async move {Work::Precheck {op_id,result:local_owner::prepare(&app,&manager,&preparation).await}}.boxed());
                                                }
                                                Ok(Admission::Pending) => {},
                                                Ok(Admission::Completed(response)) => {let _=pairs.send(&channel_id,BusinessObject::Response(response));},
                                                Err(error) => {
                                                    // Reject this invocation without disconnecting other
                                                    // Agents or discarding already accepted return routes.
                                                    let response=myagents_agent_network_protocol::RpcResponse {version:1,op_id,request_id,sender_sequence:1,outcome:error_outcome(error)};
                                                    let _=pairs.send(&channel_id,BusinessObject::Response(response));
                                                },
                                            }
                                        }
                                        BusinessObject::Event(event)=> {
                                            let (peer,epoch)=pairs.peer(&channel_id)?;
                                            match source_returns.event(&event,peer,epoch,&local,&scope.connection_epoch)? {
                                                ReturnAdmission::Deliver(intent)=> {
                                                    let event_id=event.event["eventId"].as_str().expect("validated event").to_owned();
                                                    let allocation = match owner.memory.reserve(measure(&event)?.0 * 3) {
                                                        Ok(allocation) => allocation,
                                                        Err(_) => {
                                                            let settlement=myagents_agent_network_protocol::ReturnSettlement::Dropped;
                                                            source_returns.finish(&event.op_id,&event_id,settlement.clone())?;
                                                            let _=pairs.send(&channel_id,BusinessObject::Ack(myagents_agent_network_protocol::ReturnAck {version:1,sender_sequence:1,op_id:event.op_id,return_route_id:event.return_route_id,event_id,settlement}));
                                                            continue;
                                                        }
                                                    };
                                                    let app=app.clone();let manager=manager.clone();let channel_id=channel_id.clone();
                                                    work.push(async move {let settlement=local_owner::deliver_return(&app,&manager,intent,event.event).await;
                                                        Work::Returned {channel_id,op_id:event.op_id,return_route_id:event.return_route_id,event_id,settlement,allocation:Some(allocation)}}.boxed());
                                                },
                                                ReturnAdmission::Joined(settlement)=> {
                                                    let event_id=event.event["eventId"].as_str().expect("validated event").to_owned();
                                                    let channel_id=channel_id.clone();
                                                    work.push(async move { Work::Returned { channel_id, op_id:event.op_id,
                                                        return_route_id:event.return_route_id,event_id,settlement:settlement.await,allocation:None } }.boxed());
                                                },
                                                ReturnAdmission::Pending=>{},
                                                ReturnAdmission::Cached(settlement)=>{let _=pairs.send(&channel_id,BusinessObject::Ack(myagents_agent_network_protocol::ReturnAck {
                                                    version:1,op_id:event.op_id,sender_sequence:1,return_route_id:event.return_route_id,
                                                    event_id:event.event["eventId"].as_str().expect("validated event").into(),settlement}));},
                                            }
                                        },
                                        BusinessObject::Ack(ack)=> {
                                            let (peer,epoch)=pairs.peer(&channel_id)?;
                                            match target_returns.ack(ack,&channel_id,peer,epoch) {
                                                Ok(return_route_id)=> {send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id,reason:"RETURN_COMPLETED".into()}).await?;},
                                                Err(error) if error.code=="RETURN_CONTEXT_LOST"||error.code=="RETURN_NOT_PENDING"=>{},
                                                Err(error)=>return Err(error),
                                            }
                                        },
                                        _ => return Err(NetworkError::new("BUSINESS_CONTEXT_NOT_FOUND")),
                                    }
                                }
                            }
                            Err(error) => {
                                pairs.remove(&channel_id);
                                send(&mut socket, ClientMessage::Close { scope: scope.clone(), channel_id, reason: error.code }).await?;
                            }
                        }
                    },
                    Some(Ok(Message::Frame(_))) | Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED")),
                }
            }
            Some(completed) = work.next(), if !work.is_empty() => {
                match completed {
                    Work::Returned {channel_id,op_id,return_route_id,event_id,settlement,allocation:_allocation}=> {
                        if source_returns.finish(&op_id,&event_id,settlement.clone()).is_ok() {
                            // Commit the local receipt before ACK. A lost channel
                            // cannot inject a second Inbox event on rebind.
                            let _=pairs.send(&channel_id,BusinessObject::Ack(myagents_agent_network_protocol::ReturnAck {
                                version:1,op_id,sender_sequence:1,return_route_id,event_id,settlement}));
                        }
                    },
                    Work::Metadata { allocation: _allocation, reply, result } => { identity.account.ensure_current()?; let _ = reply.send(result); }
                    Work::Resolve { op_id, result } => {
                        if let Err(error) = result.and_then(|target| { source_returns.resolved(&op_id,&target); calls.resolved(&op_id, target, &local) }) { calls.fail(&op_id, error); }
                    }
                    Work::Catalog(result) => {
                        catalog_busy = false; let accepted = result?;
                        if accepted != catalog_seq { return Err(NetworkError::new("CATALOG_NOT_CURRENT")); }
                        local_policy = None; hydrate_dirty = true;
                    }
                    Work::Hydrate { catalog_seq: hydrated_seq, result } => {
                        hydrate_busy = false;
                        // A later catalog/settings notification invalidates this
                        // projection even if its HTTP response arrives last.
                        if hydrated_seq == catalog_seq && !hydrate_dirty {
                            local_policy = Some(result?);
                            if hydrated {
                                let mut snapshot = owner.snapshot();
                                let name = local_policy.as_ref().map(|policy| policy.device_name.clone());
                                if snapshot.device_name != name {
                                    snapshot.device_name = name;
                                    owner.publish(app, generation, snapshot);
                                }
                            }
                            if !catalog_busy && !ready_requested {
                                send(&mut socket, ClientMessage::Ready { scope: scope.clone(), catalog_seq }).await?;
                                ready_requested = true;
                            }
                        }
                    }
                    Work::Offer { channel_id, result } => {
                        let installed = result.and_then(|verified| pairs.install(verified, &local, &scope.connection_epoch));
                        match installed {
                            Ok(_) => {}
                            Err(error) => { pairs.remove(&channel_id); send(&mut socket, ClientMessage::Close { scope: scope.clone(), channel_id, reason: error.code }).await?; }
                        }
                    }
                    Work::RenewIdentity(result)=> {
                        identity_check_busy=false;
                        match result {
                            Ok(updated)=>identity=updated,
                            Err(error) if error.retryable && identity.peer.as_ref().is_some_and(|peer| peer.binding.expires_at > jsonwebtoken::get_current_timestamp()) => {
                                // The original leaf and connection remain valid. The
                                // same active-context task will check again; idle
                                // connections still have no renewal polling.
                                ulog_warn!("[agent-network] peer renewal deferred: {}", error.code);
                            },
                            Err(error)=>return Err(error),
                        }
                    },
                    Work::Peer {offer,result} => {
                        let channel_id=offer.channel_id.clone();
                        match result {
                            Ok(updated) => {
                                let signed_binding=updated.peer.as_ref().ok_or_else(||NetworkError::new("NETWORK_CERTIFICATE_INVALID"))?.signed_binding.clone();
                                identity=updated.clone();
                                pending_offers.insert(channel_id.clone(),(offer,updated));
                                send(&mut socket,ClientMessage::Accept {scope:scope.clone(),channel_id,signed_binding}).await?;
                            }
                            Err(error) => {pairs.remove(&channel_id);send(&mut socket,ClientMessage::Close {scope:scope.clone(),channel_id,reason:error.code}).await?;}
                        }
                    }
                    Work::Precheck {op_id,result} => {
                        match result {
                            Ok(prepared) => {if let Err(error)=incoming_calls.prepared(&op_id) {
                                if error.code!="OP_NOT_CURRENT" {return Err(error);}
                            } else {prepared_targets.insert(op_id,prepared);}},
                            Err(outcome) => {if let Some((channel,response,_allocation))=incoming_calls.finish(&op_id,outcome) {let _=pairs.send(&channel,BusinessObject::Response(response));}}
                        }
                    }
                    Work::Executed {op_id,return_route_id,outcome,allocation:_response_allocation} => {
                        if return_route_id.is_some() {target_returns.cancel(&op_id);}
                        if let Some((channel,response,_allocation))=incoming_calls.finish(&op_id,outcome) {let _=pairs.send(&channel,BusinessObject::Response(response));}
                        if let Some(return_route_id)=return_route_id {send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id,reason:"READ_COMPLETED".into()}).await?;}
                    }
                }
            }
            Some(command) = commands.recv() => {
                if let Command::Management(command) = command {
                    if command.reply.is_closed() || !management_only || command.generation != generation || !hydrated
                        || command.request.auth_generation != owner.snapshot().auth_generation
                        || command.request.connection_id != owner.connection_id
                        || command.request.principal_id != local.principal_id
                        || command.request.network_id != local.network_id {
                        let _=command.reply.send(Err(NetworkError::new("CONNECTOR_NOT_READY")));
                        continue;
                    }
                    let remaining = Duration::from_secs(30).checked_sub(command.queued_at.elapsed());
                    let result = match remaining {
                        Some(remaining) => tokio::time::timeout(remaining, super::management_controller::execute(&mut socket,&transport,&identity,&local,&scope,&mut pairs,&command.request,command.sent.clone()))
                            .await.unwrap_or_else(|_|Err(super::management_controller::lost(command.request.mutation(),command.sent.load(Ordering::Acquire)))),
                        None => Err(super::management_controller::lost(command.request.mutation(),false)),
                    };
                    let result=if owner.generation()!=generation || identity.account.ensure_current().is_err() {
                        Err(super::management_controller::lost(command.request.mutation(),command.sent.load(Ordering::Acquire)))
                    } else {result};
                    let failed=result.is_err();
                    let _=command.reply.send(result);
                    if failed { return Err(NetworkError::new("HOST_MANAGEMENT_CONNECTION_RESET")); }
                    last_server=Instant::now();last_ping=Instant::now();
                    continue;
                }
                if management_only {
                    match &command {
                        Command::Metadata(metadata) => {
                            if let Err(error) = super::owned_profile::metadata(&metadata.request.route()) {command.reject(error);continue;}
                        }
                        _ => {command.reject(NetworkError::new("OWNED_PROFILE_UNSUPPORTED"));continue;}
                    }
                }
                if let Command::Watches(command)=command {
                    if command.generation!=generation { let _=command.reply.send(Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"))); continue; }
                    let (result,routes)=source_returns.watches(&command.source_session,command.cancel.as_deref(),command.all);
                    for return_route_id in routes {send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id,reason:"WATCH_CANCELLED".into()}).await?;}
                    let _=command.reply.send(Ok(result)); continue;
                }
                if let Command::Return {generation:command_generation,callback}=command {
                    if command_generation!=generation {let _=callback.reply.send(Err(NetworkError::new("ACCOUNT_BINDING_CHANGED")));continue;}
                    if let Err((callback,error))=target_returns.enqueue(callback,pairs.buffered_bytes()+calls.bytes()+incoming_calls.bytes()+source_returns.bytes()) {let _=callback.reply.send(Err(error));}
                    continue;
                }
                if let Command::Rpc(mut command) = command {
                    if command.generation != generation || !hydrated || work.len() >= budget("pending") {
                        if let Some(reply) = command.reply.take() { let _ = reply.send(Err(NetworkError::new("CONNECTOR_NOT_READY"))); }
                        continue;
                    }
                    let return_intent=ReturnIntent::from_request(&command.request,&command.caller)?;
                    let reference = command.request.reference().map_err(|_| NetworkError::new("INVALID_REFERENCE"))?.agent;
                    let op_id = match calls.insert(command.request, command.caller, &mut command.reply, command.queued_at, &local, Some(command.allocation), pairs.buffered_bytes()+incoming_calls.bytes()+target_returns.bytes()+source_returns.bytes()) {
                        Ok(op) => op,
                        Err(error) => { if let Some(reply) = command.reply.take() { let _ = reply.send(Err(error)); } continue; }
                    };
                    if let Some(intent)=return_intent {
                        if let Err(error)=source_returns.reserve(&op_id,intent) {calls.fail(&op_id,error);continue;}
                    }
                    let transport = transport.clone(); let token = identity.token.clone(); let account = identity.account.clone();
                    work.push(async move { let result = async {
                        account.ensure_current()?;
                        let value = transport.json(NetworkRoute::Resolve { network_id: &reference.network_id, mount_id: &reference.mount_id }, &token, None).await?;
                        account.ensure_current()?;
                        serde_json::from_value(value).map_err(|_| NetworkError::new("NETWORK_METADATA_INVALID"))
                    }.await; Work::Resolve { op_id, result } }.boxed());
                    continue;
                }
                let Command::Metadata(command) = command else { unreachable!("RPC handled above") };
                if command.generation != generation || !hydrated {
                    let _ = command.reply.send(Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"))); continue;
                }
                if work.len() >= budget("pending") {
                    let _ = command.reply.send(Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"))); continue;
                }
                let transport = transport.clone(); let token = identity.token.clone(); let account = identity.account.clone();
                work.push(async move {
                    let result = async { account.ensure_current()?;
                        let body = command.request.body()?;
                        let owned = transport.json_owned(command.request.route(), &token, body).await?;
                        account.ensure_current()?; Ok(owned) }.await;
                    let (result, allocation) = match result { Ok((value, allocation)) => (Ok(value), Some(allocation)), Err(error) => (Err(error), None) };
                    Work::Metadata { allocation, reply: command.reply, result }
                }.boxed());
            }
            _ = owner.catalog_changed.notified(), if !catalog_busy && !management_only => {
                catalog_seq = catalog_seq.checked_add(1).filter(|value| *value <= 9_007_199_254_740_991)
                    .ok_or_else(|| NetworkError::new("CATALOG_SEQUENCE_EXHAUSTED"))?;
                catalog_busy = true; ready_requested = false;
                local_policy = None;
                work.push(catalog_work(manager.clone(), transport.clone(), identity.token.clone(), scope.clone(), catalog_seq, management_only));
            }
            _ = tick.tick() => {
                source_returns.expire();
                let active=!source_returns.is_empty()||!target_returns.is_empty();
                if !active {next_identity_check=None;}
                else if !identity_check_busy {
                    let due=next_identity_check.get_or_insert_with(||Instant::now()+identity_check_delay());
                    if *due<=Instant::now() {
                        *due=Instant::now()+identity_check_delay();
                        if identity.renewal_due() {
                            identity_check_busy=true;let identity=identity.clone();
                            work.push(async move {Work::RenewIdentity(identity.ensure_peer().await)}.boxed());
                        }
                    }
                }
                for return_route_id in target_returns.expire() {send(&mut socket,ClientMessage::CloseRoute {scope:scope.clone(),return_route_id,reason:"RETURN_DEADLINE".into()}).await?;}
                for op in incoming_calls.expired(Instant::now()) {
                    prepared_targets.remove(&op);
                    if let Some((channel,response,_allocation))=incoming_calls.finish(&op,error_outcome(NetworkError::new("ADMISSION_UNCONFIRMED"))) {let _=pairs.send(&channel,BusinessObject::Response(response));}
                }
                for op_id in calls.expire(Instant::now()) {
                    // Releasing a route is resource cleanup, never remote cancel.
                    send(&mut socket, ClientMessage::Release { scope: scope.clone(), op_id }).await?;
                }
                if last_server.elapsed() > Duration::from_millis(budget("offlineMs") as u64) {
                    return Err(NetworkError::new("NETWORK_CONNECTION_TIMEOUT"));
                }
                for (channel_id, reason) in pairs.expired() {
                    pairs.remove(&channel_id);calls.channel_closed(&channel_id);target_returns.channel_closed(&channel_id);
                    send(&mut socket, ClientMessage::Close { scope: scope.clone(), channel_id, reason: reason.into() }).await?;
                }
                if identity.access.exp<=jsonwebtoken::get_current_timestamp() {return Err(NetworkError::new("NETWORK_TOKEN_EXPIRED"));}
                if last_ping.elapsed()>=Duration::from_millis(budget("pingMs") as u64) {
                    socket.send(Message::Text("ma-network-ping".into())).await.map_err(|_|NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;
                    last_ping=Instant::now();
                }

            }
        }
        source_returns.prune_unsent(&calls);
        for action in target_returns.advance(&pairs, &scope) {
            send_control(&mut socket, action.id, action.message).await?;
        }
        for action in calls.advance(&pairs, &local, &scope) {
            send_control(&mut socket, action.id, action.message).await?;
        }
        if let Some(policy) = &local_policy {
            for (op, action) in incoming_calls.advance(policy, &scope) {
                match action {
                    Ok(action) => {
                        send_control(&mut socket, action.id, action.message).await?;
                    }
                    Err(error) => {
                        if let Some((channel, response, _allocation)) =
                            incoming_calls.finish(&op, error_outcome(error))
                        {
                            let _ = pairs.send(&channel, BusinessObject::Response(response));
                        }
                    }
                }
            }
        }

        if hydrate_dirty && !hydrate_busy && !catalog_busy {
            hydrate_dirty = false;
            hydrate_busy = true;
            let transport = transport.clone();
            let token = identity.token.clone();
            let local = local.clone();
            work.push(
                async move {
                    Work::Hydrate {
                        catalog_seq,
                        result: if management_only {
                            super::policy::hydrate_owned(&transport, &token, &local).await
                        } else {
                            hydrate(&transport, &token, &local).await
                        },
                    }
                }
                .boxed(),
            );
        }
        while let Some(frame) = pairs.next_frame()? {
            tokio::time::timeout(
                Duration::from_millis(budget("backpressureMs") as u64),
                socket.send(Message::Binary(frame)),
            )
            .await
            .map_err(|_| NetworkError::new("NETWORK_BACKPRESSURE"))?
            .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;
        }
        // A bounded pair writer failure retires that pair, never the healthy
        // outer connection or another peer's accepted return/watch contexts.
        for (channel_id, error) in pairs.take_failures() {
            pairs.remove(&channel_id);
            pending_offers.remove(&channel_id);
            calls.channel_closed(&channel_id);
            target_returns.channel_closed(&channel_id);
            for op in incoming_calls.channel_ops(&channel_id) {
                prepared_targets.remove(&op);
                incoming_calls.finish(
                    &op,
                    error_outcome(NetworkError::new("ADMISSION_UNCONFIRMED")),
                );
            }
            send(
                &mut socket,
                ClientMessage::Close {
                    scope: scope.clone(),
                    channel_id,
                    reason: error.code,
                },
            )
            .await?;
        }
        for channel_id in pairs.announce_ready() {
            send(
                &mut socket,
                ClientMessage::ChannelReady {
                    scope: scope.clone(),
                    channel_id,
                },
            )
            .await?;
        }
    }
}
fn catalog_work(
    manager: ManagedSidecarManager,
    transport: Arc<NetworkTransport>,
    token: zeroize::Zeroizing<String>,
    scope: ConnectionScope,
    catalog_seq: u64,
    management_only: bool,
) -> BoxFuture<'static, Work> {
    async move {
        let result = async {
            // This profile has no Agent invocation authority. Its explicit
            // empty catalog is not a fallback after failing to read local data.
            let items = if management_only {
                Vec::new()
            } else {
                read_local_catalog(&manager).await?
            };
            let snapshot = CatalogSnapshot {
                version: 1,
                connection_epoch: scope.connection_epoch.clone(),
                catalog_seq,
                items,
            };
            let value =
                serde_json::to_value(snapshot).map_err(|_| NetworkError::new("CATALOG_INVALID"))?;
            myagents_agent_network_protocol::validate_catalog(&value)
                .map_err(|_| NetworkError::new("CATALOG_INVALID"))?;
            let uploaded = transport
                .json(NetworkRoute::Catalog, &token, Some(value))
                .await?;
            catalog_ack::validate_catalog_ack(&uploaded, &scope.connection_epoch, catalog_seq)
                .map_err(|error| {
                    NetworkError::new(match error {
                        catalog_ack::CatalogAckError::Invalid => "CATALOG_INVALID",
                        catalog_ack::CatalogAckError::NotCurrent => "CATALOG_NOT_CURRENT",
                    })
                })?;
            Ok(catalog_seq)
        }
        .await;
        Work::Catalog(result)
    }
    .boxed()
}

fn metadata_response_lost(mutation: bool, auth_changed: bool) -> NetworkError {
    NetworkError::new(if auth_changed {
        "ACCOUNT_BINDING_CHANGED"
    } else if mutation {
        "NETWORK_REQUEST_UNCONFIRMED"
    } else {
        "NETWORK_TRANSPORT_FAILED"
    })
}

#[cfg(test)]
mod metadata_response_tests {
    use super::metadata_response_lost;

    #[test]
    fn diagnostic_code_never_echoes_unknown_upstream_payload_or_details() {
        let mut error = super::NetworkError::cloud("ACCESS_CAPABILITY_NOT_A_KNOWN_CODE", 401);
        error.details = Some(serde_json::json!({"secret":"private-fixture-value"}));
        assert_eq!(super::diagnostic_code(&error), "OTHER_NETWORK_FAILURE");
        error.code = "unexpected\nlog payload".into();
        assert_eq!(super::diagnostic_code(&error), "OTHER_NETWORK_FAILURE");
        assert_eq!(
            super::diagnostic_code(&super::NetworkError::new(
                "NETWORK_CREDENTIAL_STORE_INVALID"
            )),
            "NETWORK_CREDENTIAL_STORE_INVALID"
        );
    }

    #[test]
    fn lost_read_response_is_not_an_uncertain_save() {
        assert_eq!(
            metadata_response_lost(false, false).code,
            "NETWORK_TRANSPORT_FAILED"
        );
    }

    #[test]
    fn same_account_disconnect_preserves_uncertain_write() {
        assert_eq!(
            metadata_response_lost(true, false).code,
            "NETWORK_REQUEST_UNCONFIRMED"
        );
    }

    #[test]
    fn real_auth_boundary_fences_both_operation_kinds() {
        for mutation in [false, true] {
            assert_eq!(
                metadata_response_lost(mutation, true).code,
                "ACCOUNT_BINDING_CHANGED"
            );
        }
    }
}
