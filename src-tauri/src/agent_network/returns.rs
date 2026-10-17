//! Original-call return authority. Only opaque correlation and local owner
//! references survive the admission receipt. Negotiated terminal recovery is
//! bounded in App memory; original operations are never replayed.
use super::NetworkError;
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use myagents_agent_network_protocol::{
    budget, DeviceScope, Outcome, ReturnEvent, ReturnSettlement, ServerMessage, SourceOperation,
    SourceRequest, VerifiedCaller,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Clone)]
pub(crate) enum Correlation {
    Reply(String),
    Watch(String),
}
#[derive(Clone)]
pub(crate) struct ReturnIntent {
    pub source_session: String,
    pub source_agent: String,
    pub target_session: Option<String>,
    pub target_agent: Option<myagents_agent_network_protocol::AgentReference>,
    pub correlation: Correlation,
    pub peer_label: Option<(String, String)>,
}
impl ReturnIntent {
    fn log(&self, stage: &str, op: &str, route: Option<&str>, code: &str) {
        let (kind, correlation) = match &self.correlation {
            Correlation::Reply(id) => ("reply", id),
            Correlation::Watch(id) => ("watch", id),
        };
        crate::ulog_info!(
            "[agent-network/return] stage={} kind={} op_id={} route_id={} correlation_id={} code={}",
            stage,
            kind,
            crate::network_diagnostics::safe_request_id(Some(op)).unwrap_or("invalid"),
            crate::network_diagnostics::safe_request_id(route).unwrap_or("none"),
            crate::network_diagnostics::safe_request_id(Some(correlation)).unwrap_or("invalid"),
            NetworkError::cloud(code, 400).code,
        );
    }
    pub(crate) fn from_request(
        request: &SourceRequest,
        caller: &VerifiedCaller,
    ) -> Result<Option<Self>, NetworkError> {
        let VerifiedCaller::Internal {
            source_session_id,
            source_agent_id,
            ..
        } = caller
        else {
            return Ok(None);
        };
        let correlation = match &request.operation {
            SourceOperation::Start(p) | SourceOperation::Send(p) if p.reply_back => {
                Correlation::Reply(p.message_id.clone())
            }
            SourceOperation::Watch(p) => Correlation::Watch(p.watch_id.clone()),
            _ => return Ok(None),
        };
        let reference = request
            .reference()
            .map_err(|_| NetworkError::new("INVALID_REFERENCE"))?;
        Ok(Some(Self {
            target_agent: Some(reference.agent.clone()),
            source_session: source_session_id.clone(),
            source_agent: source_agent_id.clone(),
            target_session: request
                .reference()
                .map_err(|_| NetworkError::new("INVALID_REFERENCE"))?
                .local_session_id,
            correlation,
            peer_label: None,
        }))
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Route {
    id: String,
    source: DeviceScope,
    target: DeviceScope,
    source_epoch: String,
    target_epoch: String,
    recoverable: bool,
    suspended_until: Option<Instant>,
    resume_after: Option<Instant>,
    resume_control: Option<String>,
}
impl Route {
    fn suspend(&mut self, remaining: Duration) {
        if !self.recoverable {
            return;
        }
        let deadline = Instant::now() + remaining.min(recovery_window());
        self.suspended_until = Some(
            self.suspended_until
                .map_or(deadline, |old| old.min(deadline)),
        );
    }
    fn resume(&mut self, source: &str, target: &str) {
        if self.recoverable {
            self.source_epoch = source.into();
            self.target_epoch = target.into();
            self.suspended_until = None;
            self.resume_after = None;
            self.resume_control = None;
        }
    }
    fn advance(
        &mut self,
        scope: &myagents_agent_network_protocol::ConnectionScope,
    ) -> Option<super::calls::Control> {
        if self.suspended_until.is_none() || self.resume_after.is_some_and(|at| at > Instant::now())
        {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.resume_control = Some(id.clone());
        self.resume_after = Some(Instant::now() + Duration::from_secs(10));
        Some(super::calls::Control {
            id,
            message: myagents_agent_network_protocol::ClientMessage::Resume {
                scope: scope.clone(),
                return_route_id: self.id.clone(),
            },
        })
    }
    fn expired(&self) -> bool {
        self.suspended_until.is_some_and(|at| at <= Instant::now())
    }
}
fn recovery_window() -> Duration {
    Duration::from_millis(budget("returnRecoveryMs") as u64)
}

struct Context {
    intent: ReturnIntent,
    route: Option<Route>,
    pending: Option<(String, [u8; 32])>,
    turn_id: Option<String>,
    notification: Option<String>,
    watch_cancelled: Option<Instant>,
}
struct Receipt {
    route: Route,
    event_id: String,
    digest: [u8; 32],
    settlement: ReturnSettlement,
    at: Instant,
}
#[derive(Default)]
pub(crate) struct SourceReturns {
    contexts: HashMap<String, Context>,
    receipts: HashMap<String, Receipt>,
    notifications: HashMap<String, Notification>,
    unavailable: Vec<(ReturnIntent, String)>,
}
type SettlementFuture = Shared<BoxFuture<'static, ReturnSettlement>>;
struct Notification {
    settlement: SettlementFuture,
    complete: Option<oneshot::Sender<ReturnSettlement>>,
    at: Instant,
}
pub(crate) enum ReturnAdmission {
    Deliver(ReturnIntent),
    Pending,
    Joined(SettlementFuture),
    Cached(ReturnSettlement),
}
impl SourceReturns {
    pub(crate) fn reserve(&mut self, op: &str, intent: ReturnIntent) -> Result<(), NetworkError> {
        self.expire();
        let watches = self
            .contexts
            .values()
            .filter(|c| matches!(&c.intent.correlation, Correlation::Watch(_)))
            .count();
        if self.contexts.len() >= budget("returns")
            || self.contexts.len() + self.receipts.len() >= budget("receipts")
            || matches!(&intent.correlation, Correlation::Watch(_)) && watches >= budget("watches")
        {
            return Err(NetworkError::new("NETWORK_RETURN_CAPACITY"));
        }
        if self.contexts.contains_key(op) || self.receipts.contains_key(op) {
            return Err(NetworkError::new("OP_ID_REUSED"));
        }
        intent.log("source_reserved", op, None, "NONE");
        self.contexts.insert(
            op.into(),
            Context {
                intent,
                route: None,
                pending: None,
                turn_id: None,
                notification: None,
                watch_cancelled: None,
            },
        );
        Ok(())
    }
    pub(crate) fn resolved(&mut self, op: &str, target: &super::calls::CallableAgent) {
        if let Some(context) = self.contexts.get_mut(op) {
            context.intent.peer_label = Some((target.name.clone(), target.device_name.clone()));
        }
    }
    /// Lists/cancels only this live caller's observations. A pending Inbox
    /// admission is already irreversible; it is reported and never retracted.
    pub(crate) fn watches(
        &mut self,
        source: &str,
        cancel: Option<&str>,
        all: bool,
    ) -> (serde_json::Value, Vec<String>) {
        let mut items = Vec::new();
        let mut routes = Vec::new();
        self.contexts.retain(|_, context| {
            let Correlation::Watch(id) = &context.intent.correlation else { return true; };
            if context.intent.source_session != source || context.watch_cancelled.is_some() { return true; }
            let target = context.intent.target_agent.as_ref().zip(context.intent.target_session.as_ref())
                .and_then(|(agent, session)| myagents_agent_network_protocol::SessionReference {
                    agent: agent.clone(), local_session_id: session.clone()
                }.encode().ok());
            let selected = all || cancel == Some(id.as_str());
            let cancellable = context.route.is_some() && context.pending.is_none();
            let cancelled = selected && cancellable;
            items.push(serde_json::json!({"watchId":id,"targetSessionId":target,"turnId":context.turn_id,
                "source":"network","cancelled":cancelled,"registrationPending":context.turn_id.is_none(),"deliveryPending":context.pending.is_some()}));
            if cancelled {
                if let Some(route) = &context.route { routes.push(route.id.clone()); }
                // Keep the authenticated route briefly to settle an event
                // already in flight as dropped, using the existing receipt TTL.
                context.watch_cancelled = Some(Instant::now());
            }
            true
        });
        (serde_json::json!({"watches":items}), routes)
    }
    /// Calls has already verified this message against its resolved target.
    pub(crate) fn route(&mut self, message: &ServerMessage) -> Result<(), NetworkError> {
        let ServerMessage::RouteOpened {
            op_id,
            return_route_id,
            source,
            target,
            source_connection_epoch,
            target_connection_epoch,
            recoverable,
            ..
        } = message
        else {
            return Err(NetworkError::new("RETURN_ROUTE_INVALID"));
        };
        let Some(context) = self.contexts.get_mut(op_id) else {
            return Ok(());
        };
        let route = Route {
            id: return_route_id.clone(),
            source: source.clone(),
            target: target.clone(),
            source_epoch: source_connection_epoch.clone(),
            target_epoch: target_connection_epoch.clone(),
            recoverable: *recoverable,
            suspended_until: None,
            resume_after: None,
            resume_control: None,
        };
        if context
            .route
            .as_ref()
            .is_some_and(|previous| previous != &route)
        {
            return Err(NetworkError::new("RETURN_ROUTE_SCOPE_MISMATCH"));
        }
        context.route = Some(route);
        Ok(())
    }
    pub(crate) fn response(&mut self, op: &str, outcome: &Outcome) -> Result<(), NetworkError> {
        let Some(context) = self.contexts.get_mut(op) else {
            return Ok(());
        };
        if context.watch_cancelled.is_some() {
            return Ok(());
        }
        if let Outcome::Start { result } = outcome {
            if let Some(session) = result["sessionId"].as_str() {
                if context
                    .intent
                    .target_session
                    .as_deref()
                    .is_some_and(|expected| expected != session)
                {
                    return Err(NetworkError::new("RETURN_TARGET_SESSION_MISMATCH"));
                }
                context.intent.target_session = Some(session.into());
            }
        }
        if let Outcome::Watch { result } = outcome {
            context.turn_id = result["turnId"].as_str().map(str::to_owned);
        }
        let rejected = match outcome {
            Outcome::Start { result } => result["accepted"] == false,
            Outcome::Send { result } => {
                result["delivered"] == false && result["unconfirmed"] != true
            }
            Outcome::Watch { result } => {
                result["watched"] == false
                    || result["delivery"] != "registered"
                    || result["coalesced"] == true
            }
            Outcome::Error { .. } => true,
            _ => false,
        };
        if rejected && context.pending.is_none() {
            self.contexts.remove(op);
        }
        Ok(())
    }
    pub(crate) fn event(
        &mut self,
        event: &ReturnEvent,
        peer: &DeviceScope,
        peer_epoch: &str,
        local: &DeviceScope,
        local_epoch: &str,
    ) -> Result<ReturnAdmission, NetworkError> {
        self.expire();
        // Pair sequence is transport-local and changes when the same logical
        // event is presented on a freshly authenticated channel. Hash borrowed
        // business fields, without cloning a potentially 16 MiB result.
        let (_, digest) = super::memory::measure(&(
            event.version,
            &event.op_id,
            &event.return_route_id,
            &event.event,
            &event.source,
            &event.target,
            &event.target_local_session_id,
        ))?;
        let event_id = event.event["eventId"]
            .as_str()
            .ok_or_else(|| NetworkError::new("RETURN_EVENT_INVALID"))?;
        let validate = |route: &Route| {
            if route.id != event.return_route_id
                || route.source != *local
                || route.target != *peer
                || route.source_epoch != local_epoch
                || route.target_epoch != peer_epoch
                || event.source != route.source
                || event.target != route.target
            {
                return Err(NetworkError::new("RETURN_SCOPE_MISMATCH"));
            }
            Ok(())
        };
        if let Some(receipt) = self.receipts.get(&event.op_id) {
            validate(&receipt.route)?;
            if receipt.event_id != event_id || receipt.digest != digest {
                return Err(NetworkError::new("RETURN_EVENT_COLLISION"));
            }
            return Ok(ReturnAdmission::Cached(receipt.settlement.clone()));
        }
        let context = self
            .contexts
            .get_mut(&event.op_id)
            .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
        validate(
            context
                .route
                .as_ref()
                .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?,
        )?;
        if event.event["targetSessionId"] != context.intent.source_session
            || event.event["sourceSessionId"] != event.target_local_session_id
            || context
                .intent
                .target_session
                .as_deref()
                .is_some_and(|expected| expected != event.target_local_session_id)
        {
            return Err(NetworkError::new("RETURN_SESSION_SCOPE_MISMATCH"));
        }
        let correlated = match &context.intent.correlation {
            Correlation::Reply(id) => {
                event.event["type"] == "send.result" && event.event["requestEventId"] == *id
            }
            Correlation::Watch(id) => {
                matches!(
                    event.event["type"].as_str(),
                    Some("watch.completed" | "watch.error" | "watch.already_idle")
                ) && event.event["watchId"] == *id
            }
        };
        if !correlated {
            return Err(NetworkError::new("RETURN_CORRELATION_MISMATCH"));
        }
        if let Some((id, expected)) = &context.pending {
            if id != event_id || expected != &digest {
                return Err(NetworkError::new("RETURN_EVENT_COLLISION"));
            }
            return Ok(ReturnAdmission::Pending);
        }
        context.intent.target_session = Some(event.target_local_session_id.clone());
        context.pending = Some((event_id.into(), digest));
        if context.watch_cancelled.is_some() {
            self.finish(&event.op_id, event_id, ReturnSettlement::Dropped)?;
            return Ok(ReturnAdmission::Cached(ReturnSettlement::Dropped));
        }
        // The target lifecycle supplies the real turn and its Inbox request.
        // Scope includes verified peer/epochs, both Sessions and the request:
        // identical text, a later turn or another request never joins.
        let request = match &context.intent.correlation {
            Correlation::Reply(id) => Some(id.as_str()),
            Correlation::Watch(_) => event.event["requestEventIds"]
                .as_array()
                .filter(|ids| ids.len() == 1)
                .and_then(|ids| ids[0].as_str()),
        };
        let key = event.event["turnId"]
            .as_str()
            .zip(request)
            .map(|(turn, request)| {
                serde_json::to_string(&(
                    context
                        .route
                        .as_ref()
                        .expect("validated route")
                        .source
                        .clone(),
                    peer,
                    &context.intent.source_session,
                    &event.target_local_session_id,
                    &context.intent.target_agent,
                    turn,
                    request,
                ))
                .expect("serializable scope")
            });
        if let Some(key) = key {
            context.notification = Some(key.clone());
            if let Some(existing) = self.notifications.get(&key) {
                return Ok(ReturnAdmission::Joined(existing.settlement.clone()));
            }
            let (complete, response) = oneshot::channel();
            let settlement = async move { response.await.unwrap_or(ReturnSettlement::Dropped) }
                .boxed()
                .shared();
            self.notifications.insert(
                key,
                Notification {
                    settlement,
                    complete: Some(complete),
                    at: Instant::now(),
                },
            );
        }
        Ok(ReturnAdmission::Deliver(context.intent.clone()))
    }
    pub(crate) fn finish(
        &mut self,
        op: &str,
        event_id: &str,
        settlement: ReturnSettlement,
    ) -> Result<(), NetworkError> {
        let context = self
            .contexts
            .get(op)
            .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
        let (expected, _) = context
            .pending
            .as_ref()
            .ok_or_else(|| NetworkError::new("RETURN_NOT_PENDING"))?;
        if expected != event_id {
            return Err(NetworkError::new("RETURN_EVENT_COLLISION"));
        }
        let context = self.contexts.remove(op).expect("validated current context");
        context.intent.log(
            "source_settled",
            op,
            context.route.as_ref().map(|r| r.id.as_str()),
            settlement_code(&settlement),
        );
        let (expected, digest) = context.pending.expect("validated pending event");
        if let Some(key) = &context.notification {
            if let Some(notification) = self.notifications.get_mut(key) {
                if let Some(complete) = notification.complete.take() {
                    let _ = complete.send(settlement.clone());
                }
            }
        }
        self.receipts.insert(
            op.into(),
            Receipt {
                route: context.route.expect("validated route"),
                event_id: expected,
                digest,
                settlement,
                at: Instant::now(),
            },
        );
        Ok(())
    }
    pub(crate) fn close_route(&mut self, route: &str, reason: &str) {
        self.receipts.retain(|_, receipt| receipt.route.id != route);
        self.contexts.retain(|op, context| {
            if context.route.as_ref().is_some_and(|r| r.id == route) {
                // Pending local admission and cancelled-watch tombstones may
                // still settle, but a closed remote route can never resume.
                let closed = context.route.as_mut().expect("matched route");
                closed.recoverable = false;
                closed.suspended_until = None;
                closed.resume_control = None;
                context.intent.log(
                    if context.pending.is_some() {
                        "source_route_closed_pending"
                    } else {
                        "source_route_closed"
                    },
                    op,
                    Some(route),
                    reason,
                );
            }
            let keep = context.watch_cancelled.is_some()
                || context.pending.is_some()
                || context.route.as_ref().is_none_or(|r| r.id != route);
            if !keep
                && !matches!(
                    reason,
                    "RETURN_COMPLETED"
                        | "READ_COMPLETED"
                        | "WATCH_CANCELLED"
                        | "PERMIT_EXPIRED"
                        | "RETURN_CAPACITY"
                )
            {
                self.unavailable
                    .push((context.intent.clone(), reason.into()));
            }
            keep
        });
    }
    pub(crate) fn disconnected(&mut self) {
        let routes: Vec<_> = self
            .contexts
            .values_mut()
            .filter_map(|c| c.route.as_mut())
            .chain(self.receipts.values_mut().map(|r| &mut r.route))
            .map(|r| {
                r.suspend(recovery_window());
                r.resume_after = None;
                (r.id.clone(), r.recoverable)
            })
            .collect();
        for (id, recoverable) in routes {
            if !recoverable {
                self.close_route(&id, "CONNECTION_ENDED");
            }
        }
        self.contexts.retain(|_, c| c.route.is_some());
    }
    pub(crate) fn suspended(&mut self, id: &str, remaining: u64) {
        for r in self
            .contexts
            .values_mut()
            .filter_map(|c| c.route.as_mut())
            .chain(self.receipts.values_mut().map(|r| &mut r.route))
            .filter(|r| r.id == id)
        {
            r.suspend(Duration::from_millis(remaining));
        }
    }
    pub(crate) fn resumed(&mut self, id: &str, source: &str, target: &str) {
        self.expire();
        for r in self
            .contexts
            .values_mut()
            .filter_map(|c| c.route.as_mut())
            .chain(self.receipts.values_mut().map(|r| &mut r.route))
            .filter(|r| r.id == id)
        {
            r.resume(source, target);
        }
    }
    pub(crate) fn advance(
        &mut self,
        scope: &myagents_agent_network_protocol::ConnectionScope,
    ) -> Vec<super::calls::Control> {
        self.contexts
            .values_mut()
            .filter(|c| c.watch_cancelled.is_none())
            .filter_map(|c| c.route.as_mut())
            .chain(self.receipts.values_mut().map(|r| &mut r.route))
            .filter_map(|r| r.advance(scope))
            .collect()
    }
    pub(crate) fn control_failed(&mut self, control: &str, code: &str) -> bool {
        let route = self
            .contexts
            .values()
            .filter_map(|c| c.route.as_ref())
            .chain(self.receipts.values().map(|r| &r.route))
            .find(|r| r.resume_control.as_deref() == Some(control))
            .map(|r| r.id.clone());
        if let Some(id) = &route {
            if permanent_resume_error(code) {
                self.close_route(id, code);
                self.receipts.retain(|_, r| &r.route.id != id);
            }
        }
        route.is_some()
    }
    pub(crate) fn verify_local(&mut self, local: &DeviceScope) {
        self.expire();
        let ids: Vec<_> = self
            .contexts
            .values()
            .filter_map(|c| c.route.as_ref())
            .filter(|r| r.source != *local)
            .map(|r| r.id.clone())
            .collect();
        for id in ids {
            self.close_route(&id, "RETURN_IDENTITY_CHANGED");
        }
        self.receipts.retain(|_, r| r.route.source == *local);
    }
    pub(crate) fn invalidate(&mut self, code: &str) {
        let ids: Vec<_> = self
            .contexts
            .values()
            .filter_map(|c| c.route.as_ref().map(|r| r.id.clone()))
            .collect();
        for id in ids {
            self.close_route(&id, code);
        }
        self.contexts.clear();
        self.receipts.clear();
        self.notifications.clear();
    }
    pub(crate) fn take_unavailable(&mut self) -> Vec<(ReturnIntent, String)> {
        std::mem::take(&mut self.unavailable)
    }
    pub(crate) fn prune_unsent(&mut self, calls: &super::calls::Calls) {
        self.contexts
            .retain(|op, c| c.route.is_some() || calls.has_history(op));
    }
    pub(crate) fn expire(&mut self) {
        let expired: Vec<_> = self
            .contexts
            .values()
            .filter_map(|c| c.route.as_ref())
            .filter(|r| r.expired())
            .map(|r| r.id.clone())
            .collect();
        for id in expired {
            self.close_route(&id, "RETURN_RECOVERY_EXPIRED");
        }
        self.contexts.retain(|_, c| {
            c.watch_cancelled.is_none_or(|at| {
                at.elapsed() < Duration::from_millis(budget("returnReceiptMs") as u64)
            })
        });
        self.notifications.retain(|_, n| {
            n.at.elapsed() < Duration::from_millis(budget("returnReceiptMs") as u64)
        });
        self.receipts.retain(|_, r| {
            !r.route.expired()
                && r.at.elapsed() < Duration::from_millis(budget("returnReceiptMs") as u64)
        });
    }
    pub(crate) fn bytes(&self) -> usize {
        (self.contexts.len() + self.receipts.len() + self.notifications.len()) * 4096
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.contexts.values().all(|c| c.watch_cancelled.is_some())
    }
}

impl Drop for SourceReturns {
    fn drop(&mut self) {
        for (op, context) in &self.contexts {
            context.intent.log(
                "source_context_released",
                op,
                context.route.as_ref().map(|r| r.id.as_str()),
                if context.pending.is_some() {
                    "ADMISSION_UNCONFIRMED"
                } else {
                    "CONNECTION_ENDED"
                },
            );
        }
    }
}

fn permanent_resume_error(code: &str) -> bool {
    !matches!(
        code,
        "TARGET_OFFLINE"
            | "RETURN_SUSPENDED"
            | "NETWORK_CONNECTION_CLOSED"
            | "CONNECTION_NOT_CURRENT"
            | "NETWORK_BACKPRESSURE"
            | "CHANNEL_SCOPE_MISMATCH"
            | "CHANNEL_NOT_READY"
            | "CHANNEL_NOT_ACCEPTED"
            | "ACCOUNT_SERVICE_UNAVAILABLE"
            | "NETWORK_ACCOUNT_UNAVAILABLE"
            | "SPACE_UNAVAILABLE"
            | "RESOURCE_EXHAUSTED"
            | "NETWORK_QUERY_FAILED"
    )
}

fn settlement_code(settlement: &ReturnSettlement) -> &'static str {
    match settlement {
        ReturnSettlement::Delivered => "DELIVERED",
        ReturnSettlement::Unconfirmed => "UNCONFIRMED",
        ReturnSettlement::Dropped => "DROPPED",
    }
}

/// Terminal callbacks enter from the actual live Session process. This record
/// contains only correlation; result bytes exist solely in the bounded pending
/// delivery and are discarded at its deadline or identity boundary.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallbackRequest {
    pub sidecar_id: String,
    pub reference: crate::inbox::types::NetworkReturnReference,
    pub event: serde_json::Value,
}
pub(crate) struct Callback {
    pub(crate) allocation: Option<super::memory::Allocation>,
    pub target_session: String,
    pub reference: crate::inbox::types::NetworkReturnReference,
    pub event: serde_json::Value,
    pub reply: tokio::sync::oneshot::Sender<Result<ReturnSettlement, NetworkError>>,
    pub queued_at: Instant,
}
struct TargetContext {
    alive: Arc<AtomicBool>,
    route: Route,
    intent: ReturnIntent,
    target_session: String,
}
enum DeliveryPhase {
    Waiting,
    Opening { channel: String, control: String },
    Rebinding { channel: String, control: String },
    Sent { channel: String },
}
struct Delivery {
    callback: Callback,
    event_id: String,
    phase: DeliveryPhase,
    bytes: usize,
}
// Only a bounded control intent survives result expiry. No event/body is kept.
// The route may have resumed at the peer before this device reconnects.
struct ClosingRoute {
    local: DeviceScope,
    reason: &'static str,
    until: Instant,
    after: Option<Instant>,
    control: Option<String>,
}
#[derive(Default)]
pub(crate) struct TargetReturns {
    connection_id: Option<String>,
    contexts: HashMap<String, TargetContext>,
    pending: HashMap<String, Delivery>,
    closing: HashMap<String, ClosingRoute>,
    manager: Option<crate::sidecar::ManagedSidecarManager>,
}
impl TargetReturns {
    pub(crate) fn new(
        manager: crate::sidecar::ManagedSidecarManager,
        connection_id: String,
    ) -> Self {
        Self {
            manager: Some(manager),
            connection_id: Some(connection_id),
            contexts: HashMap::new(),
            pending: HashMap::new(),
            closing: HashMap::new(),
        }
    }
    pub(crate) fn register(
        &mut self,
        invocation: &myagents_agent_network_protocol::Invocation,
        permit: &ServerMessage,
        target_session: Option<&str>,
    ) -> Result<bool, NetworkError> {
        let VerifiedCaller::Internal {
            source_session_id,
            source_agent_id,
            ..
        } = &invocation.caller
        else {
            return Ok(false);
        };
        let correlation = match &invocation.operation {
            myagents_agent_network_protocol::Operation::Start(p) if p.reply_back => {
                Correlation::Reply(p.message_id.clone())
            }
            myagents_agent_network_protocol::Operation::Send(p) if p.reply_back => {
                Correlation::Reply(p.message_id.clone())
            }
            myagents_agent_network_protocol::Operation::Watch(p) => {
                Correlation::Watch(p.watch_id.clone())
            }
            _ => return Ok(false),
        };
        if self.contexts.len() + self.closing.len() >= budget("returns")
            || matches!(&correlation, Correlation::Watch(_))
                && self
                    .contexts
                    .values()
                    .filter(|c| matches!(c.intent.correlation, Correlation::Watch(_)))
                    .count()
                    >= budget("watches")
        {
            return Err(NetworkError::new("NETWORK_RETURN_CAPACITY"));
        }
        let ServerMessage::Permit {
            return_route_id,
            source,
            target,
            source_connection_epoch,
            target_connection_epoch,
            recoverable,
            ..
        } = permit
        else {
            return Err(NetworkError::new("PERMIT_INVALID"));
        };
        if self.contexts.contains_key(&invocation.op_id) {
            return Err(NetworkError::new("OP_ID_REUSED"));
        }
        self.contexts.insert(
            invocation.op_id.clone(),
            TargetContext {
                alive: Arc::new(AtomicBool::new(true)),
                route: Route {
                    id: return_route_id.clone(),
                    source: source.clone(),
                    target: target.clone(),
                    source_epoch: source_connection_epoch.clone(),
                    target_epoch: target_connection_epoch.clone(),
                    recoverable: *recoverable,
                    suspended_until: None,
                    resume_after: None,
                    resume_control: None,
                },
                intent: ReturnIntent {
                    source_session: source_session_id.clone(),
                    source_agent: source_agent_id.clone(),
                    target_session: None,
                    target_agent: None,
                    correlation,
                    peer_label: None,
                },
                target_session: target_session
                    .ok_or_else(|| NetworkError::new("TARGET_SESSION_REQUIRED"))?
                    .into(),
            },
        );
        Ok(true)
    }
    pub(crate) fn disconnected(&mut self) {
        for close in self.closing.values_mut() {
            close.after = None;
        }
        let ids: Vec<_> = self
            .contexts
            .values_mut()
            .map(|c| {
                c.route.suspend(recovery_window());
                c.route.resume_after = None;
                (c.route.id.clone(), c.route.recoverable)
            })
            .collect();
        for (id, recoverable) in ids {
            if !recoverable {
                self.close_route(&id, "CONNECTION_ENDED");
            }
        }
        for d in self.pending.values_mut() {
            d.phase = DeliveryPhase::Waiting;
        }
    }
    pub(crate) fn suspended(&mut self, id: &str, remaining: u64) {
        for c in self.contexts.values_mut().filter(|c| c.route.id == id) {
            c.route.suspend(Duration::from_millis(remaining));
        }
    }
    pub(crate) fn resumed(&mut self, id: &str, source: &str, target: &str) {
        self.expire();
        for (op, c) in self.contexts.iter_mut().filter(|(_, c)| c.route.id == id) {
            let changed = c.route.source_epoch != source
                || c.route.target_epoch != target
                || c.route.suspended_until.is_some();
            c.route.resume(source, target);
            if changed {
                if let Some(d) = self.pending.get_mut(op) {
                    d.phase = DeliveryPhase::Waiting;
                }
            }
        }
    }
    pub(crate) fn verify_local(&mut self, local: &DeviceScope) {
        self.expire();
        self.closing.retain(|_, close| close.local == *local);
        let ids: Vec<_> = self
            .contexts
            .values()
            .filter(|c| c.route.target != *local)
            .map(|c| c.route.id.clone())
            .collect();
        for id in ids {
            self.close_route(&id, "RETURN_IDENTITY_CHANGED");
        }
    }
    pub(crate) fn invalidate(&mut self, code: &str) {
        self.closing.clear();
        for op in self.contexts.keys().cloned().collect::<Vec<_>>() {
            self.complete(&op, Ok(ReturnSettlement::Dropped), code);
        }
    }
    /// The return-route owner fences the already-running registration job.
    pub(crate) fn watch_lifetime(&self, op: &str) -> Option<Arc<AtomicBool>> {
        self.contexts
            .get(op)
            .filter(|c| matches!(c.intent.correlation, Correlation::Watch(_)))
            .map(|c| c.alive.clone())
    }
    pub(crate) fn enqueue(
        &mut self,
        mut callback: Callback,
        buffered: usize,
    ) -> Result<(), (Callback, NetworkError)> {
        self.expire();
        let mut check = || {
            let op = callback.reference.op_id.to_string();
            let context = self
                .contexts
                .get(&op)
                .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
            if context.route.id != callback.reference.return_route_id.to_string()
                || context.target_session != callback.target_session
                || callback.event["sourceSessionId"] != context.target_session
                || callback.event["targetSessionId"] != context.intent.source_session
            {
                return Err(NetworkError::new("RETURN_SESSION_SCOPE_MISMATCH"));
            }
            let correlated = match &context.intent.correlation {
                Correlation::Reply(id) => {
                    callback.event["type"] == "send.result"
                        && callback.event["requestEventId"] == *id
                }
                Correlation::Watch(id) => {
                    matches!(
                        callback.event["type"].as_str(),
                        Some("watch.completed" | "watch.error" | "watch.already_idle")
                    ) && callback.event["watchId"] == *id
                }
            };
            if !correlated {
                return Err(NetworkError::new("RETURN_CORRELATION_MISMATCH"));
            }
            let event_id = callback.event["eventId"]
                .as_str()
                .ok_or_else(|| NetworkError::new("RETURN_EVENT_INVALID"))?
                .to_owned();
            let mut object = serde_json::json!({"version":1,"kind":"return-event","senderSequence":1,"opId":op,
                "returnRouteId":context.route.id,"source":context.route.source,"target":context.route.target,
                "targetLocalSessionId":context.target_session,"event":null});
            object["event"] = std::mem::take(&mut callback.event);
            myagents_agent_network_protocol::validate_business(&object)
                .map_err(|_| NetworkError::new("RETURN_EVENT_INVALID"))?;
            let bytes = super::memory::measure(&object)?.0;
            callback.event = object["event"].take();
            if let Some(allocation) = &mut callback.allocation {
                allocation.resize(bytes * 2 + budget("controlBytes"))?;
            }
            if self.pending.contains_key(&op) {
                return Err(NetworkError::new("RETURN_ALREADY_PENDING"));
            }
            if self.pending.len() >= budget("pending")
                || bytes > budget("objectBytes")
                || buffered + self.bytes() + bytes > budget("connectorBytes")
            {
                return Err(NetworkError::new("CONNECTOR_CAPACITY"));
            }
            Ok((op, event_id, bytes))
        };
        match check() {
            Ok((op, event_id, bytes)) => {
                self.contexts[&op].intent.log(
                    "target_queued",
                    &op,
                    Some(&self.contexts[&op].route.id),
                    "RETURN_PENDING",
                );
                self.pending.insert(
                    op,
                    Delivery {
                        callback,
                        event_id,
                        bytes,
                        phase: DeliveryPhase::Waiting,
                    },
                );
                Ok(())
            }
            Err(error) => Err((callback, error)),
        }
    }
    pub(crate) fn advance(
        &mut self,
        pairs: &super::pairs::Pairs,
        scope: &myagents_agent_network_protocol::ConnectionScope,
    ) -> Vec<super::calls::Control> {
        let mut actions: Vec<_> = self
            .contexts
            .values_mut()
            .filter_map(|c| c.route.advance(scope))
            .collect();
        for (route, close) in &mut self.closing {
            if close.until <= Instant::now() || close.after.is_some_and(|at| at > Instant::now()) {
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            close.control = Some(id.clone());
            close.after = Some(Instant::now() + Duration::from_secs(10));
            actions.push(super::calls::Control {
                id,
                message: myagents_agent_network_protocol::ClientMessage::CloseRoute {
                    scope: scope.clone(),
                    return_route_id: route.clone(),
                    reason: close.reason.into(),
                },
            });
        }
        let mut openings: HashMap<(String, String), (String, String)> = self
            .pending
            .iter()
            .filter_map(|(op, d)| {
                if let DeliveryPhase::Opening { channel, control } = &d.phase {
                    let c = &self.contexts[op];
                    Some((
                        (
                            c.route.source.device_id.clone(),
                            c.route.source_epoch.clone(),
                        ),
                        (channel.clone(), control.clone()),
                    ))
                } else {
                    None
                }
            })
            .collect();
        for (op, delivery) in &mut self.pending {
            if !matches!(
                delivery.phase,
                DeliveryPhase::Waiting | DeliveryPhase::Opening { .. }
            ) {
                continue;
            }
            let context = &self.contexts[op];
            if context.route.suspended_until.is_some() {
                continue;
            }
            if let Some(channel) =
                pairs.ready_for(&context.route.source, &context.route.source_epoch)
            {
                let control = uuid::Uuid::new_v4().to_string();
                actions.push(super::calls::Control {
                    id: control.clone(),
                    message: myagents_agent_network_protocol::ClientMessage::Rebind {
                        scope: scope.clone(),
                        return_route_id: context.route.id.clone(),
                        channel_id: channel.into(),
                    },
                });
                delivery.phase = DeliveryPhase::Rebinding {
                    channel: channel.into(),
                    control,
                };
            } else if matches!(delivery.phase, DeliveryPhase::Waiting) {
                let key = (
                    context.route.source.device_id.clone(),
                    context.route.source_epoch.clone(),
                );
                let (channel, control) = openings
                    .entry(key)
                    .or_insert_with(|| {
                        let channel = uuid::Uuid::new_v4().to_string();
                        let control = uuid::Uuid::new_v4().to_string();
                        actions.push(super::calls::Control {
                            id: control.clone(),
                            message: myagents_agent_network_protocol::ClientMessage::Open {
                                scope: scope.clone(),
                                channel_id: channel.clone(),
                                target_device_id: context.route.source.device_id.clone(),
                                target_key_generation: context.route.source.key_generation,
                                target_connection_epoch: context.route.source_epoch.clone(),
                                target_binding: None,
                            },
                        });
                        (channel, control)
                    })
                    .clone();
                delivery.phase = DeliveryPhase::Opening { channel, control };
            }
        }
        actions
    }
    pub(crate) fn rebound(
        &mut self,
        control_id: &str,
        route: &str,
        channel: &str,
    ) -> Result<myagents_agent_network_protocol::BusinessObject, NetworkError> {
        let op = self
            .pending
            .iter()
            .find_map(|(op, d)| {
                matches!(&d.phase,DeliveryPhase::Rebinding {control,..} if control==control_id)
                    .then(|| op.clone())
            })
            .ok_or_else(|| NetworkError::new("RETURN_NOT_PENDING"))?;
        let context = &self.contexts[&op];
        let delivery = self.pending.get_mut(&op).expect("located delivery");
        if context.route.id != route
            || !matches!(&delivery.phase,DeliveryPhase::Rebinding {channel:expected,..} if expected==channel)
        {
            return Err(NetworkError::new("RETURN_SCOPE_MISMATCH"));
        }
        delivery.phase = DeliveryPhase::Sent {
            channel: channel.into(),
        };
        // Negotiated recovery retains the same logical event until ACK. The
        // source's App-scoped receipt prevents a second Inbox admission.
        let event = if context.route.recoverable {
            delivery.callback.event.clone()
        } else {
            delivery.bytes = 0;
            std::mem::take(&mut delivery.callback.event)
        };
        Ok(myagents_agent_network_protocol::BusinessObject::Event(
            ReturnEvent {
                version: 1,
                op_id: op,
                sender_sequence: 1,
                return_route_id: route.into(),
                event,
                source: context.route.source.clone(),
                target: context.route.target.clone(),
                target_local_session_id: context.target_session.clone(),
            },
        ))
    }
    pub(crate) fn ack(
        &mut self,
        ack: myagents_agent_network_protocol::ReturnAck,
        channel: &str,
        peer: &DeviceScope,
        epoch: &str,
    ) -> Result<String, NetworkError> {
        let context = self
            .contexts
            .get(&ack.op_id)
            .ok_or_else(|| NetworkError::new("RETURN_CONTEXT_LOST"))?;
        let delivery = self
            .pending
            .get(&ack.op_id)
            .ok_or_else(|| NetworkError::new("RETURN_NOT_PENDING"))?;
        if ack.return_route_id != context.route.id
            || ack.event_id != delivery.event_id
            || peer != &context.route.source
            || epoch != context.route.source_epoch
            || !matches!(&delivery.phase,DeliveryPhase::Sent {channel:expected} if expected==channel)
        {
            return Err(NetworkError::new("RETURN_SCOPE_MISMATCH"));
        }
        let route = context.route.id.clone();
        self.complete(&ack.op_id, Ok(ack.settlement), "RETURN_ACK");
        Ok(route)
    }
    fn cleanup_reference(
        &self,
        op: &str,
        route: &str,
    ) -> Option<crate::inbox::types::NetworkReturnReference> {
        Some(crate::inbox::types::NetworkReturnReference {
            connection_id: self.connection_id.clone(),
            op_id: uuid::Uuid::parse_str(op).ok()?,
            return_route_id: uuid::Uuid::parse_str(route).ok()?,
        })
    }
    fn complete(&mut self, op: &str, result: Result<ReturnSettlement, NetworkError>, reason: &str) {
        if let Some(context) = self.contexts.remove(op) {
            context.intent.log(
                "target_context_released",
                op,
                Some(&context.route.id),
                reason,
            );
            context.alive.store(false, Ordering::Release);
            if let (Some(manager), Correlation::Watch(watch_id)) =
                (&self.manager, context.intent.correlation)
            {
                let manager = manager.clone();
                let target = context.target_session;
                if let Some(reference) = self.cleanup_reference(op, &context.route.id) {
                    tauri::async_runtime::spawn(async move {
                        crate::inbox::watch::remove_network_watch(
                            &manager, &target, &watch_id, &reference,
                        )
                        .await;
                    });
                }
            }
        }
        if let Some(delivery) = self.pending.remove(op) {
            crate::ulog_info!(
                "[agent-network/return] stage=target_settled op_id={} event_id={} code={}",
                op,
                crate::network_diagnostics::safe_request_id(Some(&delivery.event_id))
                    .unwrap_or("invalid"),
                match &result {
                    Ok(settlement) => settlement_code(settlement),
                    Err(error) => error.code.as_str(),
                }
            );
            let _ = delivery.callback.reply.send(result);
        }
    }
    pub(crate) fn cancel(&mut self, op: &str) {
        self.queue_close(op, "RETURN_NOT_EXPECTED");
        self.complete(op, Ok(ReturnSettlement::Dropped), "RETURN_NOT_EXPECTED");
    }
    fn queue_close(&mut self, op: &str, reason: &'static str) {
        if let Some(context) = self.contexts.get(op) {
            self.closing
                .entry(context.route.id.clone())
                .or_insert_with(|| ClosingRoute {
                    local: context.route.target.clone(),
                    reason,
                    until: Instant::now() + Duration::from_millis(budget("returnReceiptMs") as u64),
                    after: None,
                    control: None,
                });
        }
    }
    pub(crate) fn close_route(&mut self, route: &str, reason: &str) {
        self.closing.remove(route);
        let ops: Vec<_> = self
            .contexts
            .iter()
            .filter(|(_, c)| c.route.id == route)
            .map(|(op, _)| op.clone())
            .collect();
        for op in ops {
            self.complete(&op, Ok(ReturnSettlement::Dropped), reason);
        }
    }
    pub(crate) fn control_failed(&mut self, control: &str, error: NetworkError) -> bool {
        if let Some(route) = self
            .closing
            .iter()
            .find(|(_, close)| close.control.as_deref() == Some(control))
            .map(|(id, _)| id.clone())
        {
            if permanent_resume_error(&error.code) {
                self.closing.remove(&route);
            }
            return true;
        }
        let resumed = self
            .contexts
            .values()
            .find(|c| c.route.resume_control.as_deref() == Some(control))
            .map(|c| c.route.id.clone());
        if let Some(id) = resumed {
            if permanent_resume_error(&error.code) {
                self.close_route(&id, &error.code);
            }
            return true;
        }
        let ops: Vec<_> = self
            .pending
            .iter()
            .filter_map(|(op, d)| match &d.phase {
                DeliveryPhase::Opening {
                    control: expected, ..
                }
                | DeliveryPhase::Rebinding {
                    control: expected, ..
                } if expected == control => Some(op.clone()),
                _ => None,
            })
            .collect();
        let matched = !ops.is_empty();
        if matches!(
            error.code.as_str(),
            "CHANNEL_PAIR_EXISTS" | "CHANNEL_ALREADY_OPEN"
        ) && ops
            .iter()
            .all(|op| matches!(self.pending[op].phase, DeliveryPhase::Opening { .. }))
        {
            return matched;
        }
        for op in ops {
            if self.contexts[&op].route.recoverable && !permanent_resume_error(&error.code) {
                self.contexts
                    .get_mut(&op)
                    .unwrap()
                    .route
                    .suspend(recovery_window());
                self.pending.get_mut(&op).unwrap().phase = DeliveryPhase::Waiting;
            } else {
                self.complete(&op, Err(error.clone()), &error.code);
            }
        }
        matched
    }
    pub(crate) fn channel_closed(&mut self, channel: &str) {
        // Only negotiated routes can resend the same event after a lost ACK;
        // legacy routes retain the original one-transmission behavior.
        for (op, delivery) in &mut self.pending {
            if matches!(&delivery.phase, DeliveryPhase::Sent {channel: c} if c == channel)
                && self.contexts[op].route.recoverable
            {
                self.contexts
                    .get_mut(op)
                    .unwrap()
                    .route
                    .suspend(recovery_window());
                delivery.phase = DeliveryPhase::Waiting;
                continue;
            }
            match &delivery.phase {
                DeliveryPhase::Opening { channel: c, .. }
                | DeliveryPhase::Rebinding { channel: c, .. }
                    if c == channel =>
                {
                    delivery.phase = DeliveryPhase::Waiting
                }
                _ => {}
            }
        }
    }
    pub(crate) fn expire(&mut self) {
        self.closing.retain(|_, close| close.until > Instant::now());
        let expired: Vec<_> = self
            .contexts
            .iter()
            .filter(|(op, c)| {
                c.route.expired()
                    || self.pending.get(*op).is_some_and(|d| {
                        d.callback.queued_at.elapsed()
                            >= if c.route.recoverable {
                                recovery_window()
                            } else {
                                Duration::from_secs(30)
                            }
                    })
            })
            .map(|(op, _)| op.clone())
            .collect();
        for op in expired {
            self.queue_close(&op, "RETURN_DEADLINE");
            self.complete(&op, Ok(ReturnSettlement::Unconfirmed), "RETURN_DEADLINE");
        }
    }
    pub(crate) fn bytes(&self) -> usize {
        (self.contexts.len() + self.closing.len()) * 4096
            + self.pending.values().map(|d| d.bytes).sum::<usize>()
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.contexts.is_empty()
    }
}
impl Drop for TargetReturns {
    fn drop(&mut self) {
        for op in self.contexts.keys().cloned().collect::<Vec<_>>() {
            self.complete(&op, Ok(ReturnSettlement::Dropped), "CONNECTION_ENDED");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_protocol::{ConnectionScope, Invocation, Operation, StartParams};
    use serde_json::json;
    fn recoverable_source() -> SourceReturns {
        let mut s = source();
        s.contexts
            .get_mut(&id(9))
            .unwrap()
            .route
            .as_mut()
            .unwrap()
            .recoverable = true;
        s
    }
    fn recoverable_target() -> TargetReturns {
        let mut t = target();
        t.contexts.get_mut(&id(9)).unwrap().route.recoverable = true;
        t
    }
    #[test]
    fn closed_route_receipts_and_pending_admission_never_resume() {
        let mut s = recoverable_source();
        assert!(matches!(
            s.event(&event(), &device(4), &id(7), &device(3), &id(6))
                .unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        s.close_route(&id(8), "RETURN_COMPLETED");
        s.finish(&id(9), &id(12), ReturnSettlement::Delivered)
            .unwrap();
        s.disconnected();
        assert!(s.advance(&scope()).is_empty());
        s.close_route(&id(8), "RETURN_COMPLETED");
        assert!(s.receipts.is_empty());
        assert!(s.take_unavailable().is_empty());
    }
    #[tokio::test]
    async fn disconnect_retains_terminal_until_fresh_route_and_ack_without_duplicate_inbox() {
        let mut s = recoverable_source();
        let mut t = recoverable_target();
        s.disconnected();
        t.disconnected();
        let (c, reply) = callback();
        t.enqueue(c, 0)
            .unwrap_or_else(|_| panic!("offline enqueue"));
        assert_eq!(
            t.advance(&super::super::pairs::Pairs::default(), &scope())
                .len(),
            1
        ); // resume only
        assert!(!s.is_empty());
        assert!(!t.is_empty());
        s.resumed(&id(8), &id(40), &id(41));
        t.resumed(&id(8), &id(40), &id(41));
        t.pending.get_mut(&id(9)).unwrap().phase = DeliveryPhase::Rebinding {
            channel: id(42),
            control: id(43),
        };
        let myagents_agent_network_protocol::BusinessObject::Event(first) =
            t.rebound(&id(43), &id(8), &id(42)).unwrap()
        else {
            panic!("event")
        };
        assert!(!t.pending[&id(9)].callback.event.is_null());
        assert!(matches!(
            s.event(&first, &device(4), &id(41), &device(3), &id(40))
                .unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        s.finish(&id(9), &id(12), ReturnSettlement::Unconfirmed)
            .unwrap();
        // The Inbox owner did not confirm admission. Lost ACK must still not
        // cause another admission after both sockets are replaced.
        s.disconnected();
        t.disconnected();
        s.resumed(&id(8), &id(44), &id(45));
        t.resumed(&id(8), &id(44), &id(45));
        t.pending.get_mut(&id(9)).unwrap().phase = DeliveryPhase::Rebinding {
            channel: id(46),
            control: id(47),
        };
        let myagents_agent_network_protocol::BusinessObject::Event(second) =
            t.rebound(&id(47), &id(8), &id(46)).unwrap()
        else {
            panic!("event")
        };
        assert_eq!(first.event, second.event);
        assert!(matches!(
            s.event(&second, &device(4), &id(45), &device(3), &id(44))
                .unwrap(),
            ReturnAdmission::Cached(ReturnSettlement::Unconfirmed)
        ));
        assert!(s
            .event(&second, &device(4), &id(41), &device(3), &id(40))
            .is_err());
        t.ack(
            myagents_agent_network_protocol::ReturnAck {
                version: 1,
                op_id: id(9),
                sender_sequence: 1,
                return_route_id: id(8),
                event_id: id(12),
                settlement: ReturnSettlement::Unconfirmed,
            },
            &id(46),
            &device(3),
            &id(44),
        )
        .unwrap();
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Unconfirmed
        ));
        assert!(t.is_empty());
    }
    #[tokio::test]
    async fn reply_and_watch_share_admission_across_socket_epochs() {
        let mut s = recoverable_source();
        let watch = add_watch(&mut s);
        s.contexts
            .get_mut(&id(21))
            .unwrap()
            .route
            .as_mut()
            .unwrap()
            .recoverable = true;
        let mut reply = event();
        reply.event["turnId"] = json!("actual-turn");
        assert!(matches!(
            admit(&mut s, &reply).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        s.finish(&id(9), &id(12), ReturnSettlement::Delivered)
            .unwrap();
        s.disconnected();
        s.resumed(&id(22), &id(40), &id(41));
        let ReturnAdmission::Joined(settlement) = s
            .event(&watch, &device(4), &id(41), &device(3), &id(40))
            .unwrap()
        else {
            panic!("shared original Inbox admission")
        };
        assert!(matches!(settlement.await, ReturnSettlement::Delivered));
    }
    #[test]
    fn accepted_watch_lifetime_survives_transport_but_not_identity_loss() {
        let mut t = recoverable_target();
        t.contexts.get_mut(&id(9)).unwrap().intent.correlation = Correlation::Watch(id(20));
        let alive = t.watch_lifetime(&id(9)).unwrap();
        t.disconnected();
        assert!(alive.load(Ordering::Acquire));
        t.resumed(&id(8), &id(40), &id(41));
        assert!(alive.load(Ordering::Acquire));
        t.invalidate("ACCOUNT_BINDING_CHANGED");
        assert!(!alive.load(Ordering::Acquire));
    }
    #[test]
    fn temporary_authority_outage_keeps_the_original_recovery_deadline() {
        let mut s = recoverable_source();
        s.disconnected();
        let action = s.advance(&scope()).remove(0);
        let deadline = s.contexts[&id(9)].route.as_ref().unwrap().suspended_until;
        assert!(s.control_failed(&action.id, "ACCOUNT_SERVICE_UNAVAILABLE"));
        assert!(!s.is_empty());
        assert_eq!(
            s.contexts[&id(9)].route.as_ref().unwrap().suspended_until,
            deadline
        );
        assert!(s.control_failed(&action.id, "ACCOUNT_AUTH_REVOKED"));
        assert!(s.is_empty());
        assert_eq!(s.take_unavailable().len(), 1);
    }
    #[tokio::test]
    async fn offline_result_expiry_closes_the_route_after_reconnect() {
        let mut s = recoverable_source();
        let mut t = recoverable_target();
        let (mut callback, reply) = callback();
        callback.queued_at = Instant::now() - recovery_window();
        t.enqueue(callback, 0)
            .unwrap_or_else(|_| panic!("callback"));
        s.disconnected();
        t.disconnected();
        // Result retention expires before either route's outage deadline.
        t.expire();
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Unconfirmed
        ));
        assert!(t.pending.is_empty());
        s.resumed(&id(8), &id(40), &id(41));
        t.resumed(&id(8), &id(40), &id(41));
        let actions = t.advance(&super::super::pairs::Pairs::default(), &scope());
        assert_eq!(actions.len(), 1);
        let myagents_agent_network_protocol::ClientMessage::CloseRoute {
            return_route_id,
            reason,
            ..
        } = &actions[0].message
        else {
            panic!("close expired route")
        };
        // The relay's authenticated close notifies the still-waiting source.
        s.close_route(return_route_id, reason);
        t.close_route(return_route_id, reason);
        assert_eq!(s.take_unavailable().len(), 1);
        assert!(s.take_unavailable().is_empty());
        assert!(t
            .advance(&super::super::pairs::Pairs::default(), &scope())
            .is_empty());
        assert_eq!(t.bytes(), 0);
    }
    #[test]
    fn disconnect_during_resume_authorization_keeps_both_returns() {
        let mut s = recoverable_source();
        let mut t = recoverable_target();
        s.disconnected();
        t.disconnected();
        let source_action = s.advance(&scope()).remove(0);
        let target_action = t
            .advance(&super::super::pairs::Pairs::default(), &scope())
            .remove(0);
        assert!(s.control_failed(&source_action.id, "CONNECTION_NOT_CURRENT"));
        assert!(t.control_failed(
            &target_action.id,
            NetworkError::new("CONNECTION_NOT_CURRENT")
        ));
        assert!(!s.is_empty());
        assert!(!t.is_empty());
        assert!(s.take_unavailable().is_empty());
    }
    #[test]
    fn expired_result_keeps_only_bounded_identity_scoped_close_metadata() {
        for identity_change in [false, true] {
            let mut t = recoverable_target();
            let (mut callback, _) = callback();
            callback.queued_at = Instant::now() - recovery_window();
            t.enqueue(callback, 0)
                .unwrap_or_else(|_| panic!("callback"));
            t.expire();
            assert!(t.pending.is_empty());
            assert!(t.contexts.is_empty());
            assert_eq!(t.bytes(), 4096);
            let until = t.closing[&id(8)].until;
            let action = t
                .advance(&super::super::pairs::Pairs::default(), &scope())
                .remove(0);
            assert!(t.control_failed(&action.id, NetworkError::new("ACCOUNT_SERVICE_UNAVAILABLE")));
            t.disconnected();
            assert_eq!(t.closing[&id(8)].until, until);
            assert_eq!(
                t.advance(&super::super::pairs::Pairs::default(), &scope())
                    .len(),
                1
            );
            if identity_change {
                let mut changed = device(4);
                changed.key_generation += 1;
                t.verify_local(&changed);
            } else {
                t.closing.get_mut(&id(8)).unwrap().until = Instant::now() - Duration::from_secs(1);
                t.expire();
            }
            assert_eq!(t.bytes(), 0);
        }
    }
    #[test]
    fn late_resume_cannot_revive_expired_local_context() {
        let mut s = recoverable_source();
        s.disconnected();
        s.contexts
            .get_mut(&id(9))
            .unwrap()
            .route
            .as_mut()
            .unwrap()
            .suspended_until = Some(Instant::now() - Duration::from_secs(1));
        s.resumed(&id(8), &id(40), &id(41));
        assert!(s.is_empty());
        assert_eq!(s.take_unavailable().len(), 1);
        let mut t = recoverable_target();
        t.disconnected();
        t.contexts.get_mut(&id(9)).unwrap().route.suspended_until =
            Some(Instant::now() - Duration::from_secs(1));
        t.resumed(&id(8), &id(40), &id(41));
        assert!(t.is_empty());
    }
    #[test]
    fn outage_deadline_does_not_extend_and_expiry_notifies_once() {
        let mut s = recoverable_source();
        s.disconnected();
        let route = s.contexts.get_mut(&id(9)).unwrap().route.as_mut().unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        route.suspended_until = Some(deadline);
        s.disconnected();
        assert_eq!(
            s.contexts[&id(9)].route.as_ref().unwrap().suspended_until,
            Some(deadline)
        );
        s.contexts
            .get_mut(&id(9))
            .unwrap()
            .route
            .as_mut()
            .unwrap()
            .suspended_until = Some(Instant::now() - Duration::from_secs(1));
        s.expire();
        assert!(s.is_empty());
        let notes = s.take_unavailable();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].1, "RETURN_RECOVERY_EXPIRED");
        s.expire();
        assert!(s.take_unavailable().is_empty());
    }
    #[tokio::test]
    async fn terminal_budget_expires_and_identity_boundary_releases_private_result() {
        for boundary in [false, true] {
            let mut t = recoverable_target();
            let (c, reply) = callback();
            t.enqueue(c, 0).unwrap_or_else(|_| panic!("enqueue"));
            if boundary {
                let mut changed = device(4);
                changed.key_generation += 1;
                t.verify_local(&changed);
            } else {
                t.disconnected();
                t.contexts.get_mut(&id(9)).unwrap().route.suspended_until =
                    Some(Instant::now() - Duration::from_secs(1));
                t.expire();
                assert!(t.closing.contains_key(&id(8)));
            }
            assert!(matches!(
                reply.await.unwrap().unwrap(),
                ReturnSettlement::Dropped | ReturnSettlement::Unconfirmed
            ));
            assert!(t.is_empty());
            assert_eq!(t.bytes(), if boundary { 0 } else { 4096 });
        }
        let mut s = recoverable_source();
        s.invalidate("ACCOUNT_BINDING_CHANGED");
        assert!(s.is_empty());
        assert_eq!(s.take_unavailable().len(), 1);
    }
    #[test]
    fn long_online_task_has_no_recovery_deadline_and_watch_cancel_is_not_failure() {
        let mut s = recoverable_source();
        s.expire();
        assert!(!s.is_empty());
        assert!(s.advance(&scope()).is_empty());
        add_watch(&mut s);
        s.watches("caller-session", Some(&id(20)), false);
        s.close_route(&id(22), "WATCH_CANCELLED");
        assert!(s.take_unavailable().is_empty());
    }
    #[test]
    fn local_admission_pending_during_disconnect_settles_once_on_new_epoch() {
        let mut s = recoverable_source();
        assert!(matches!(
            admit(&mut s, &event()).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        s.disconnected();
        s.resumed(&id(8), &id(40), &id(41));
        assert!(matches!(
            s.event(&event(), &device(4), &id(41), &device(3), &id(40))
                .unwrap(),
            ReturnAdmission::Pending
        ));
        s.finish(&id(9), &id(12), ReturnSettlement::Delivered)
            .unwrap();
        assert!(matches!(
            s.event(&event(), &device(4), &id(41), &device(3), &id(40))
                .unwrap(),
            ReturnAdmission::Cached(ReturnSettlement::Delivered)
        ));
    }
    #[test]
    fn exact_watch_cleanup_reference_stays_with_the_owning_connection() {
        let mut a = TargetReturns::default();
        a.connection_id = Some(id(41));
        let mut b = TargetReturns::default();
        b.connection_id = Some(id(42));
        let first = a.cleanup_reference(&id(9), &id(10)).unwrap();
        let other = b.cleanup_reference(&id(9), &id(10)).unwrap();
        assert_eq!(first.op_id, other.op_id);
        assert_eq!(first.return_route_id, other.return_route_id);
        assert_ne!(first.connection_id, other.connection_id);
        assert_eq!(serde_json::to_value(first).unwrap()["connectionId"], id(41));
    }
    fn id(n: u32) -> String {
        format!("00000000-0000-0000-0000-{n:012}")
    }
    fn device(n: u32) -> DeviceScope {
        DeviceScope {
            service_id: id(1),
            environment: "development".into(),
            network_id: id(2),
            principal_id: "account".into(),
            device_id: id(n),
            key_generation: 1,
        }
    }
    fn scope() -> ConnectionScope {
        ConnectionScope {
            service_id: id(1),
            network_id: id(2),
            boot_epoch: id(5),
            connection_epoch: id(6),
        }
    }
    fn intent() -> ReturnIntent {
        ReturnIntent {
            source_session: "caller-session".into(),
            source_agent: "caller-agent".into(),
            target_session: None,
            target_agent: Some(myagents_agent_network_protocol::AgentReference {
                service_id: id(1),
                network_id: id(2),
                mount_id: id(11),
            }),
            correlation: Correlation::Reply(id(10)),
            peer_label: None,
        }
    }
    fn route() -> ServerMessage {
        ServerMessage::RouteOpened {
            scope: scope(),
            return_route_id: id(8),
            op_id: id(9),
            source: device(3),
            target: device(4),
            source_connection_epoch: id(6),
            target_connection_epoch: id(7),
            target_mount_id: id(11),
            recoverable: false,
        }
    }
    fn event() -> ReturnEvent {
        ReturnEvent {
            version: 1,
            op_id: id(9),
            return_route_id: id(8),
            sender_sequence: 3,
            source: device(3),
            target: device(4),
            target_local_session_id: "target-session".into(),
            event: json!({
        "version":1,"type":"send.result","eventId":id(12),"requestEventId":id(10),"sourceSessionId":"target-session","sourceLabel":"Agent","targetSessionId":"caller-session","status":"ok","terminalReason":"completed","createdAt":"2026-10-01T00:00:00Z","payload":"result"}),
        }
    }
    fn source() -> SourceReturns {
        let mut registry = SourceReturns::default();
        registry.reserve(&id(9), intent()).unwrap();
        registry.route(&route()).unwrap();
        registry
    }
    fn admit(
        registry: &mut SourceReturns,
        event: &ReturnEvent,
    ) -> Result<ReturnAdmission, NetworkError> {
        registry.event(event, &device(4), &id(7), &device(3), &id(6))
    }

    fn add_watch(r: &mut SourceReturns) -> ReturnEvent {
        let mut watch_intent = intent();
        watch_intent.target_session = Some("target-session".into());
        watch_intent.correlation = Correlation::Watch(id(20));
        r.reserve(&id(21), watch_intent).unwrap();
        let mut watch_route = route();
        if let ServerMessage::RouteOpened {
            op_id,
            return_route_id,
            ..
        } = &mut watch_route
        {
            *op_id = id(21);
            *return_route_id = id(22);
        }
        r.route(&watch_route).unwrap();
        r.response(
            &id(21),
            &Outcome::Watch {
                result: json!({"watched":true,"delivery":"registered","turnId":"actual-turn"}),
            },
        )
        .unwrap();
        let mut watch = event();
        watch.op_id = id(21);
        watch.return_route_id = id(22);
        watch.event = json!({"version":1,"type":"watch.completed","eventId":id(23),"watchId":id(20),
            "sourceSessionId":"target-session","sourceLabel":"Target","targetSessionId":"caller-session",
            "createdAt":"2026-10-01T00:00:00Z","latestResult":"same result","turnId":"actual-turn","requestEventIds":[id(10)]});
        watch
    }
    #[tokio::test]
    async fn watch_and_auto_reply_join_one_admission_in_both_orders_and_keep_each_receipt() {
        for watch_first in [false, true] {
            let mut r = source();
            let watch = add_watch(&mut r);
            let mut reply = event();
            reply.event["turnId"] = json!("actual-turn");
            let (leader, follower) = if watch_first {
                (&watch, &reply)
            } else {
                (&reply, &watch)
            };
            assert!(matches!(
                admit(&mut r, leader).unwrap(),
                ReturnAdmission::Deliver(_)
            ));
            let ReturnAdmission::Joined(settlement) = admit(&mut r, follower).unwrap() else {
                panic!("one Inbox admission")
            };
            let leader_id = leader.event["eventId"].as_str().unwrap();
            r.finish(&leader.op_id, leader_id, ReturnSettlement::Unconfirmed)
                .unwrap();
            assert!(matches!(settlement.await, ReturnSettlement::Unconfirmed));
            r.finish(
                &follower.op_id,
                follower.event["eventId"].as_str().unwrap(),
                ReturnSettlement::Unconfirmed,
            )
            .unwrap();
            assert_eq!(r.receipts.len(), 2);
            assert!(matches!(
                admit(&mut r, follower).unwrap(),
                ReturnAdmission::Cached(ReturnSettlement::Unconfirmed)
            ));
        }
    }
    #[test]
    fn registration_pending_watch_cancels_and_drops_an_authenticated_late_return() {
        let mut r = source();
        let watch = add_watch(&mut r);
        r.contexts.get_mut(&watch.op_id).unwrap().turn_id = None; // target registered, receipt still in flight
        let (result, routes) = r.watches("caller-session", Some(&id(20)), false);
        assert_eq!(routes, vec![id(22)]);
        assert_eq!(result["watches"][0]["cancelled"], true);
        assert_eq!(result["watches"][0]["registrationPending"], true);
        assert!(r.watches("caller-session", None, false).0["watches"]
            .as_array()
            .unwrap()
            .is_empty());
        r.close_route(&id(22), "WATCH_CANCELLED");
        r.response(
            &watch.op_id,
            &Outcome::Watch {
                result: json!({"watched":true,"delivery":"registered","turnId":"actual-turn"}),
            },
        )
        .unwrap();
        assert!(matches!(
            admit(&mut r, &watch).unwrap(),
            ReturnAdmission::Cached(ReturnSettlement::Dropped)
        ));
        assert!(matches!(
            admit(&mut r, &watch).unwrap(),
            ReturnAdmission::Cached(ReturnSettlement::Dropped)
        ));
        assert!(r.contexts.contains_key(&id(9))); // automatic reply remains independent
    }

    #[test]
    fn identical_text_cannot_merge_another_request_or_turn_and_cancellation_is_scoped() {
        let mut r = source();
        let mut watch = add_watch(&mut r);
        let mut reply = event();
        reply.event["turnId"] = json!("actual-turn");
        assert!(matches!(
            admit(&mut r, &reply).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        watch.event["requestEventIds"] = json!([id(99)]);
        assert!(matches!(
            admit(&mut r, &watch).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        let (_, routes) = r.watches("caller-session", None, true);
        assert!(routes.is_empty()); // pending admissions cannot be retracted
        assert_eq!(r.contexts.len(), 2);
        let mut r = source();
        let mut watch = add_watch(&mut r);
        watch.event["turnId"] = json!("another-turn");
        assert!(matches!(
            admit(&mut r, &reply).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        assert!(matches!(
            admit(&mut r, &watch).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        let mut r = source();
        add_watch(&mut r);
        assert!(r.watches("other-session", None, true).1.is_empty());
        assert_eq!(
            r.watches("caller-session", Some(&id(20)), false).1,
            vec![id(22)]
        );
        assert_eq!(
            r.contexts
                .values()
                .filter(|c| c.watch_cancelled.is_none())
                .count(),
            1
        ); // automatic reply survives cancel-all
    }
    #[test]
    fn equivalent_watch_receipt_retires_only_the_duplicate_route() {
        let mut r = source();
        add_watch(&mut r);
        r.response(&id(21),&Outcome::Watch {result:json!({"watched":true,"delivery":"registered","coalesced":true,"watchId":id(30)})}).unwrap();
        assert_eq!(r.contexts.len(), 1);
        assert!(r.contexts.contains_key(&id(9)));
    }
    #[test]
    fn reply_before_start_receipt_binds_the_real_session_and_rejects_conflicting_receipt() {
        let mut r = source();
        assert!(matches!(
            admit(&mut r, &event()).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        assert_eq!(
            r.response(
                &id(9),
                &Outcome::Start {
                    result: json!({"sessionId":"other-session","accepted":true})
                }
            )
            .unwrap_err()
            .code,
            "RETURN_TARGET_SESSION_MISMATCH"
        );
        r.response(
            &id(9),
            &Outcome::Start {
                result: json!({"sessionId":"target-session","accepted":true}),
            },
        )
        .unwrap();
        assert_eq!(r.contexts.len(), 1);
    }
    #[test]
    fn duplicate_does_not_redeliver_and_dedup_survives_pair_sequence_change() {
        let mut r = source();
        let mut e = event();
        assert!(matches!(
            admit(&mut r, &e).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
        e.sender_sequence = 20;
        assert!(matches!(
            admit(&mut r, &e).unwrap(),
            ReturnAdmission::Pending
        ));
        assert!(r
            .finish(&id(9), &id(99), ReturnSettlement::Delivered)
            .is_err());
        assert_eq!(r.contexts.len(), 1);
        r.finish(&id(9), &id(12), ReturnSettlement::Unconfirmed)
            .unwrap();
        e.sender_sequence = 50;
        assert!(matches!(
            admit(&mut r, &e).unwrap(),
            ReturnAdmission::Cached(ReturnSettlement::Unconfirmed)
        ));
        e.event["payload"] = json!("different");
        assert_eq!(
            admit(&mut r, &e).err().unwrap().code,
            "RETURN_EVENT_COLLISION"
        );
    }
    #[test]
    fn wrong_peer_generation_epoch_session_or_correlation_never_enters_inbox() {
        let mut r = source();
        let mut wrong = device(4);
        wrong.key_generation = 2;
        assert_eq!(
            r.event(&event(), &wrong, &id(7), &device(3), &id(6))
                .err()
                .unwrap()
                .code,
            "RETURN_SCOPE_MISMATCH"
        );
        assert_eq!(
            r.event(&event(), &device(4), &id(99), &device(3), &id(6))
                .err()
                .unwrap()
                .code,
            "RETURN_SCOPE_MISMATCH"
        );
        let mut e = event();
        e.event["targetSessionId"] = json!("other");
        assert_eq!(
            admit(&mut r, &e).err().unwrap().code,
            "RETURN_SESSION_SCOPE_MISMATCH"
        );
        e = event();
        e.event["requestEventId"] = json!(id(99));
        assert_eq!(
            admit(&mut r, &e).err().unwrap().code,
            "RETURN_CORRELATION_MISMATCH"
        );
        let mut altered = route();
        if let ServerMessage::RouteOpened { target, .. } = &mut altered {
            target.key_generation += 1;
        }
        assert_eq!(
            r.route(&altered).unwrap_err().code,
            "RETURN_ROUTE_SCOPE_MISMATCH"
        );
        assert!(matches!(
            admit(&mut r, &event()).unwrap(),
            ReturnAdmission::Deliver(_)
        ));
    }
    fn target() -> TargetReturns {
        let mut r = TargetReturns::default();
        let invocation = Invocation {
            version: 1,
            op_id: id(9),
            request_id: id(13),
            sender_sequence: 1,
            source: device(3),
            caller: VerifiedCaller::Internal {
                source_session_id: "caller-session".into(),
                source_agent_id: "caller-agent".into(),
                label: "Caller".into(),
            },
            target_mount_id: id(11),
            return_route_id: Some(id(8)),
            operation: Operation::Start(StartParams {
                local_agent_id: "target-agent".into(),
                prompt: "query".into(),
                message_id: id(10),
                reply_back: true,
            }),
        };
        let permit = ServerMessage::Permit {
            scope: scope(),
            op_id: id(9),
            attempt_id: id(14),
            permit_id: id(15),
            source: device(3),
            target: device(4),
            source_connection_epoch: id(6),
            target_connection_epoch: id(7),
            target_mount_id: id(11),
            membership_revision: 1,
            enable_revision: 1,
            freshness_ms: 5000,
            recoverable: false,
            return_route_id: id(8),
        };
        assert!(r
            .register(&invocation, &permit, Some("target-session"))
            .unwrap());
        r
    }
    fn callback() -> (
        Callback,
        tokio::sync::oneshot::Receiver<Result<ReturnSettlement, NetworkError>>,
    ) {
        let (reply, receiver) = tokio::sync::oneshot::channel();
        (
            Callback {
                target_session: "target-session".into(),
                reference: crate::inbox::types::NetworkReturnReference {
                    connection_id: None,
                    op_id: uuid::Uuid::parse_str(&id(9)).unwrap(),
                    return_route_id: uuid::Uuid::parse_str(&id(8)).unwrap(),
                },
                event: event().event,
                reply,
                queued_at: Instant::now(),
                allocation: None,
            },
            receiver,
        )
    }
    #[tokio::test]
    async fn target_rebind_ack_is_required_before_transmission_and_ack_is_correlated() {
        let mut r = target();
        let (c, reply) = callback();
        assert!(r.enqueue(c, 0).is_ok());
        assert_eq!(
            r.rebound("unsolicited", &id(8), "channel")
                .err()
                .unwrap()
                .code,
            "RETURN_NOT_PENDING"
        );
        r.pending.get_mut(&id(9)).unwrap().phase = DeliveryPhase::Rebinding {
            channel: "channel".into(),
            control: "rebind".into(),
        };
        assert!(r.rebound("rebind", &id(8), "wrong").is_err());
        let object = r.rebound("rebind", &id(8), "channel").unwrap();
        assert!(matches!(
            object,
            myagents_agent_network_protocol::BusinessObject::Event(_)
        ));
        assert!(r.pending[&id(9)].callback.event.is_null());
        assert!(r.rebound("rebind", &id(8), "channel").is_err());
        let ack = myagents_agent_network_protocol::ReturnAck {
            version: 1,
            op_id: id(9),
            sender_sequence: 4,
            return_route_id: id(8),
            event_id: id(12),
            settlement: ReturnSettlement::Delivered,
        };
        assert!(r
            .ack(ack.clone(), "channel", &device(3), "other-epoch")
            .is_err());
        assert_eq!(r.ack(ack, "channel", &device(3), &id(6)).unwrap(), id(8));
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Delivered
        ));
        assert!(r.is_empty());
    }
    #[tokio::test]
    async fn callback_cannot_choose_another_session_and_transmitted_event_is_never_replayed() {
        let mut r = target();
        let (mut c, _) = callback();
        c.target_session = "other-session".into();
        assert_eq!(
            r.enqueue(c, 0).err().unwrap().1.code,
            "RETURN_SESSION_SCOPE_MISMATCH"
        );
        let (c, reply) = callback();
        assert!(r.enqueue(c, 0).is_ok());
        r.pending.get_mut(&id(9)).unwrap().phase = DeliveryPhase::Sent {
            channel: "channel".into(),
        };
        r.channel_closed("channel");
        assert!(r
            .advance(&super::super::pairs::Pairs::default(), &scope())
            .is_empty());
        r.pending.get_mut(&id(9)).unwrap().callback.queued_at =
            Instant::now() - Duration::from_secs(31);
        r.expire();
        assert!(r.closing.contains_key(&id(8)));
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Unconfirmed
        ));
    }
    #[test]
    fn watch_route_close_and_drop_fence_in_flight_registration() {
        for close in [false, true] {
            let mut r = target();
            r.contexts.get_mut(&id(9)).unwrap().intent.correlation = Correlation::Watch(id(20));
            let alive = r.watch_lifetime(&id(9)).unwrap();
            assert!(alive.load(Ordering::Acquire));
            if close {
                r.close_route(&id(8), "CONNECTION_ENDED");
            }
            drop(r);
            assert!(!alive.load(Ordering::Acquire));
        }
    }

    #[tokio::test]
    async fn connection_boundary_discards_callback_and_closes_only_its_route() {
        let mut r = target();
        let (c, reply) = callback();
        assert!(r.enqueue(c, 0).is_ok());
        r.close_route(&id(99), "CONNECTION_ENDED");
        assert!(!r.is_empty());
        drop(r);
        assert!(matches!(
            reply.await.unwrap().unwrap(),
            ReturnSettlement::Dropped
        ));
        let mut source = source();
        source.close_route(&id(8), "CONNECTION_ENDED");
        assert_eq!(
            admit(&mut source, &event()).err().unwrap().code,
            "RETURN_CONTEXT_LOST"
        );
    }
}
