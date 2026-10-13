//! Source RPC correlation for one authenticated connection. This holds bounded
//! in-flight requests, never an execution queue or a retry/outbox mechanism.
use super::{pairs::Pairs, NetworkError};
use myagents_agent_network_protocol::{
    budget, remote_deadline, AgentReference, BusinessObject, ClientMessage, ConnectionScope,
    DeviceScope, Invocation, Outcome, RpcResponse, SourceRequest, VerifiedCaller,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CallableAgent {
    pub mount_id: String,
    pub local_agent_id: String,
    pub name: String,
    // Presentation metadata remains accepted by the strict resolve DTO, not peer identity.
    #[serde(default)]
    pub icon: Option<String>,
    pub description: Option<String>,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub membership_revision: u64,
    pub enable_revision: u64,
    pub selector: String,
    pub is_local: bool,
    pub source: AgentReferenceScope,
    pub connection_epoch: String,
    pub key_generation: u64,
    pub signed_binding: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentReferenceScope {
    pub service_id: String,
    pub network_id: String,
}
impl CallableAgent {
    pub(crate) fn peer(&self, local: &DeviceScope) -> DeviceScope {
        DeviceScope {
            service_id: self.source.service_id.clone(),
            environment: local.environment.clone(),
            network_id: self.source.network_id.clone(),
            principal_id: local.principal_id.clone(),
            device_id: self.device_id.clone(),
            key_generation: self.key_generation,
        }
    }
}
enum Phase {
    Resolving,
    Opening {
        channel_id: String,
        control_id: String,
    },
    Preparing {
        channel_id: String,
        control_id: String,
    },
    Sent {
        channel_id: String,
    },
}
pub(crate) struct CallResult {
    pub outcome: Outcome,
    pub identity: Option<serde_json::Value>,
}
struct Call {
    _allocation: Option<super::memory::Allocation>,
    request: Option<SourceRequest>,
    request_id: String,
    selector: String,
    reference: AgentReference,
    method: &'static str,
    caller: VerifiedCaller,
    source: DeviceScope,
    target: Option<CallableAgent>,
    phase: Phase,
    deadline: Instant,
    bytes: usize,
    reply: Option<oneshot::Sender<Result<CallResult, NetworkError>>>,
    return_route: Option<String>,
}
struct Retired {
    request_id: String,
    channel_id: String,
    method: &'static str,
    at: Instant,
    target: DeviceScope,
    target_epoch: String,
    mount: String,
    return_route: Option<String>,
}
pub(crate) struct Control {
    pub id: String,
    pub message: ClientMessage,
}
#[derive(Default)]
pub(crate) struct Calls {
    calls: HashMap<String, Call>,
    retired: HashMap<String, Retired>,
    bytes: usize,
}
impl Calls {
    pub(crate) fn insert(
        &mut self,
        request: SourceRequest,
        caller: VerifiedCaller,
        reply: &mut Option<oneshot::Sender<Result<CallResult, NetworkError>>>,
        queued_at: Instant,
        local: &DeviceScope,
        allocation: Option<super::memory::Allocation>,
        buffered: usize,
    ) -> Result<String, NetworkError> {
        let reference = request
            .reference()
            .map_err(|_| NetworkError::new("INVALID_REFERENCE"))?
            .agent;
        if reference.service_id != local.service_id || reference.network_id != local.network_id {
            return Err(NetworkError::new("NETWORK_SCOPE_MISMATCH"));
        }
        // Enforce the external capability boundary before any resolution or TLS.
        request
            .bind("scope-validation", &caller)
            .map_err(|_| NetworkError::new("EXTERNAL_CLI_CAPABILITY_NOT_OPEN"))?;
        if self.calls.len() >= budget("pending")
            || self.calls.len() + self.retired.len() >= budget("receipts")
        {
            return Err(NetworkError::new("NETWORK_REQUEST_CAPACITY"));
        }
        let bytes = super::memory::measure(&request)?.0;
        if bytes > budget("objectBytes")
            || self
                .bytes
                .checked_add(bytes)
                .and_then(|n| n.checked_add(buffered))
                .is_none_or(|n| n > budget("connectorBytes"))
        {
            return Err(NetworkError::new("CONNECTOR_CAPACITY"));
        }
        let method = request.method();
        let deadline = queued_at
            + Duration::from_millis(
                remote_deadline(method, "connector").expect("closed operation"),
            );
        if deadline <= Instant::now() {
            return Err(NetworkError::new("NETWORK_REQUEST_TIMEOUT"));
        }
        let op = uuid::Uuid::new_v4().to_string();
        self.bytes += bytes;
        self.calls.insert(
            op.clone(),
            Call {
                _allocation: allocation,
                request_id: request.request_id.clone(),
                selector: request.selector.clone(),
                reference,
                method,
                caller,
                source: local.clone(),
                request: Some(request),
                target: None,
                phase: Phase::Resolving,
                deadline,
                bytes,
                reply: reply.take(),
                return_route: None,
            },
        );
        Ok(op)
    }
    pub(crate) fn resolved(
        &mut self,
        op: &str,
        target: CallableAgent,
        local: &DeviceScope,
    ) -> Result<(), NetworkError> {
        let call = self
            .calls
            .get_mut(op)
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))?;
        if !matches!(call.phase, Phase::Resolving)
            || target.source.service_id != call.reference.service_id
            || target.source.network_id != call.reference.network_id
            || target.mount_id != call.reference.mount_id
            || target.selector
                != call
                    .reference
                    .encode()
                    .map_err(|_| NetworkError::new("INVALID_REFERENCE"))?
            || target.is_local
        {
            return Err(NetworkError::new("TARGET_SCOPE_MISMATCH"));
        }
        if target.device_id == local.device_id {
            return Err(NetworkError::new("TARGET_IS_LOCAL_DEVICE"));
        }
        call.target = Some(target);
        Ok(())
    }
    pub(crate) fn advance(
        &mut self,
        pairs: &Pairs,
        local: &DeviceScope,
        scope: &ConnectionScope,
    ) -> Vec<Control> {
        // All calls for one device/epoch share one opening. Roles still come
        // from the authenticated relay offer, never the business direction.
        let mut openings: HashMap<(String, String), (String, String)> = self
            .calls
            .values()
            .filter_map(|call| {
                if let (
                    Some(target),
                    Phase::Opening {
                        channel_id,
                        control_id,
                    },
                ) = (&call.target, &call.phase)
                {
                    Some((
                        (target.device_id.clone(), target.connection_epoch.clone()),
                        (channel_id.clone(), control_id.clone()),
                    ))
                } else {
                    None
                }
            })
            .collect();
        let mut actions = Vec::new();
        for (op, call) in &mut self.calls {
            let Some(target) = &call.target else { continue };
            if !matches!(call.phase, Phase::Resolving | Phase::Opening { .. }) {
                continue;
            }
            if let Some(channel_id) = pairs.ready_for(&target.peer(local), &target.connection_epoch)
            {
                let id = uuid::Uuid::new_v4().to_string();
                actions.push(Control {
                    id: id.clone(),
                    message: ClientMessage::Prepare {
                        scope: scope.clone(),
                        channel_id: channel_id.into(),
                        op_id: op.clone(),
                        target_mount_id: target.mount_id.clone(),
                    },
                });
                call.phase = Phase::Preparing {
                    channel_id: channel_id.into(),
                    control_id: id,
                };
            } else if matches!(call.phase, Phase::Resolving) {
                let key = (target.device_id.clone(), target.connection_epoch.clone());
                let (channel_id, id) = openings
                    .entry(key)
                    .or_insert_with(|| {
                        let channel_id = uuid::Uuid::new_v4().to_string();
                        let id = uuid::Uuid::new_v4().to_string();
                        actions.push(Control {
                            id: id.clone(),
                            message: ClientMessage::Open {
                                scope: scope.clone(),
                                channel_id: channel_id.clone(),
                                target_device_id: target.device_id.clone(),
                                target_key_generation: target.key_generation,
                                target_connection_epoch: target.connection_epoch.clone(),
                                target_binding: target.signed_binding.clone(),
                            },
                        });
                        (channel_id, id)
                    })
                    .clone();
                call.phase = Phase::Opening {
                    channel_id,
                    control_id: id,
                };
            }
        }
        actions
    }
    pub(crate) fn prepared(
        &mut self,
        control_id: &str,
        op: &str,
        mount: &str,
        target: &DeviceScope,
        target_epoch: &str,
        local: &DeviceScope,
    ) -> Result<(String, BusinessObject), NetworkError> {
        let call = self
            .calls
            .get_mut(op)
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))?;
        let Some(metadata) = &call.target else {
            return Err(NetworkError::new("OP_NOT_CURRENT"));
        };
        let channel = match &call.phase {
            Phase::Preparing {
                channel_id,
                control_id: expected,
            } if expected == control_id => channel_id.clone(),
            _ => return Err(NetworkError::new("OP_NOT_CURRENT")),
        };
        if mount != call.reference.mount_id
            || *target != metadata.peer(local)
            || target_epoch != metadata.connection_epoch
        {
            return Err(NetworkError::new("OP_SCOPE_MISMATCH"));
        }
        let request = call
            .request
            .take()
            .ok_or_else(|| NetworkError::new("OP_ALREADY_SENT"))?;
        let operation = request
            .bind(&metadata.local_agent_id, &call.caller)
            .map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?;
        self.bytes -= call.bytes;
        call.bytes = 0;
        call.phase = Phase::Sent {
            channel_id: channel.clone(),
        };
        Ok((
            channel,
            BusinessObject::Invoke(Invocation {
                version: 1,
                op_id: op.into(),
                request_id: call.request_id.clone(),
                sender_sequence: 1,
                source: local.clone(),
                caller: call.caller.clone(),
                target_mount_id: mount.into(),
                return_route_id: None,
                operation,
            }),
        ))
    }
    pub(crate) fn response(
        &mut self,
        channel_id: &str,
        response: RpcResponse,
    ) -> Result<Option<String>, NetworkError> {
        if let Some(retired) = self.retired.get(&response.op_id) {
            if retired.request_id != response.request_id
                || retired.channel_id != channel_id
                || outcome_method(&response.outcome).is_some_and(|method| method != retired.method)
            {
                return Err(NetworkError::new("RESPONSE_SCOPE_MISMATCH"));
            }
            return Ok(None); // A late/duplicate receipt cannot resurrect a call.
        }
        let call = self
            .calls
            .get(&response.op_id)
            .ok_or_else(|| NetworkError::new("RESPONSE_UNSOLICITED"))?;
        let method = outcome_method(&response.outcome).unwrap_or(call.method);
        if response.request_id != call.request_id
            || method != call.method
            || !matches!(&call.phase, Phase::Sent { channel_id: expected } if expected == channel_id)
        {
            return Err(NetworkError::new("RESPONSE_SCOPE_MISMATCH"));
        }
        let op = response.op_id;
        self.settle(&op, Ok(response.outcome));
        Ok(Some(op))
    }
    pub(crate) fn route_opened(
        &mut self,
        message: &myagents_agent_network_protocol::ServerMessage,
        local: &DeviceScope,
        scope: &ConnectionScope,
    ) -> Result<(), NetworkError> {
        let myagents_agent_network_protocol::ServerMessage::RouteOpened {
            return_route_id,
            op_id,
            source,
            target,
            source_connection_epoch,
            target_connection_epoch,
            target_mount_id,
            ..
        } = message
        else {
            return Err(NetworkError::new("RETURN_ROUTE_INVALID"));
        };
        if let Some(retired) = self.retired.get_mut(op_id) {
            if source != local
                || source_connection_epoch != &scope.connection_epoch
                || target != &retired.target
                || target_connection_epoch != &retired.target_epoch
                || target_mount_id != &retired.mount
                || retired
                    .return_route
                    .as_ref()
                    .is_some_and(|previous| previous != return_route_id)
            {
                return Err(NetworkError::new("RETURN_ROUTE_SCOPE_MISMATCH"));
            }
            retired.return_route = Some(return_route_id.clone());
            return Ok(());
        }
        let call = self
            .calls
            .get_mut(op_id)
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))?;
        let peer = call
            .target
            .as_ref()
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))?;
        if source != local
            || source_connection_epoch != &scope.connection_epoch
            || target != &peer.peer(local)
            || target_connection_epoch != &peer.connection_epoch
            || target_mount_id != &call.reference.mount_id
            || !matches!(call.phase, Phase::Sent { .. })
            || call
                .return_route
                .as_ref()
                .is_some_and(|id| id != return_route_id)
        {
            return Err(NetworkError::new("RETURN_ROUTE_SCOPE_MISMATCH"));
        }
        call.return_route = Some(return_route_id.clone());
        Ok(())
    }
    pub(crate) fn control_failed(&mut self, control_id: &str, error: NetworkError) -> bool {
        let ops: Vec<_> = self
            .calls
            .iter()
            .filter_map(|(op, call)| match &call.phase {
                Phase::Opening {
                    control_id: expected,
                    ..
                }
                | Phase::Preparing {
                    control_id: expected,
                    ..
                } if expected == control_id => Some(op.clone()),
                _ => None,
            })
            .collect();
        let matched = !ops.is_empty();
        // Simultaneous endpoints can race to open the same pair. The existing
        // authenticated offer will arrive; keep waiting within the same RPC
        // deadline rather than retrying the business invocation.
        if matches!(
            error.code.as_str(),
            "CHANNEL_PAIR_EXISTS" | "CHANNEL_ALREADY_OPEN"
        ) && ops
            .iter()
            .all(|op| matches!(self.calls[op].phase, Phase::Opening { .. }))
        {
            return matched;
        }
        for op in ops {
            self.settle(&op, Err(error.clone()));
        }
        matched
    }
    pub(crate) fn fail(&mut self, op: &str, error: NetworkError) {
        self.settle(op, Err(error));
    }
    fn settle(&mut self, op: &str, result: Result<Outcome, NetworkError>) {
        if let Some(mut call) = self.calls.remove(op) {
            self.bytes -= call.bytes;
            if let Phase::Sent { channel_id } = &call.phase {
                let target = call.target.as_ref().expect("sent call resolved target");
                self.retired.insert(
                    op.into(),
                    Retired {
                        request_id: call.request_id.clone(),
                        channel_id: channel_id.clone(),
                        method: call.method,
                        at: Instant::now(),
                        target: target.peer(&call.source),
                        target_epoch: target.connection_epoch.clone(),
                        mount: target.mount_id.clone(),
                        return_route: call.return_route.clone(),
                    },
                );
            }
            if let Some(reply) = call.reply.take() {
                let result = result.map(|outcome| CallResult {
                    outcome,
                    identity: call.target.as_ref().map(|target| serde_json::json!({
                        "agentId":target.selector,"agentName":target.name,"deviceId":target.device_id,"deviceName":target.device_name,
                    })),
                });
                let _ = reply.send(result);
            }
        }
    }
    pub(crate) fn channel_closed(&mut self, channel_id: &str) {
        let ops: Vec<_> = self
            .calls
            .iter()
            .filter_map(|(op, call)| match &call.phase {
                Phase::Opening {
                    channel_id: expected,
                    ..
                }
                | Phase::Preparing {
                    channel_id: expected,
                    ..
                }
                | Phase::Sent {
                    channel_id: expected,
                } if expected == channel_id => Some(op.clone()),
                _ => None,
            })
            .collect();
        for op in ops {
            self.fail_uncertain(&op);
        }
    }
    fn fail_uncertain(&mut self, op: &str) {
        if let Some(call) = self.calls.get(op) {
            let mut error = NetworkError::new(
                if matches!(call.phase, Phase::Sent { .. })
                    && matches!(call.method, "session.start" | "session.send")
                {
                    "ADMISSION_UNCONFIRMED"
                } else if matches!(call.phase, Phase::Sent { .. }) {
                    "NETWORK_QUERY_FAILED"
                } else {
                    "NETWORK_REQUEST_NOT_SENT"
                },
            );
            error.details =
                Some(serde_json::json!({ "requestId":call.request_id,"selector":call.selector }));
            self.settle(op, Err(error));
        }
    }
    pub(crate) fn expire(&mut self, now: Instant) -> Vec<String> {
        self.retired.retain(|_, value| {
            now.duration_since(value.at) < Duration::from_millis(budget("receiptMs") as u64)
        });
        let ops: Vec<_> = self
            .calls
            .iter()
            .filter(|(_, call)| {
                call.deadline <= now || call.reply.as_ref().is_none_or(oneshot::Sender::is_closed)
            })
            .map(|(op, _)| op.clone())
            .collect();
        for op in &ops {
            self.fail_uncertain(op);
        }
        ops
    }
    pub(crate) fn has_history(&self, op: &str) -> bool {
        self.calls.contains_key(op) || self.retired.contains_key(op)
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes + self.retired.len() * 4096
    }
}
fn outcome_method(outcome: &Outcome) -> Option<&'static str> {
    Some(match outcome {
        Outcome::Show { .. } => "agent.show",
        Outcome::List { .. } => "session.list",
        Outcome::Get { .. } => "session.get",
        Outcome::State { .. } => "session.state",
        Outcome::Start { .. } => "session.start",
        Outcome::Send { .. } => "session.send",
        Outcome::Watch { .. } => "session.watch",
        Outcome::Error { .. } => return None,
    })
}
impl Drop for Calls {
    fn drop(&mut self) {
        for op in self.calls.keys().cloned().collect::<Vec<_>>() {
            self.fail_uncertain(&op);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn local() -> DeviceScope {
        DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            device_id: "00000000-0000-0000-0000-000000000003".into(),
            principal_id: "account".into(),
            environment: "development".into(),
            key_generation: 1,
        }
    }
    fn request() -> SourceRequest {
        SourceRequest::parse(json!({
        "selector":"ma-agent:1:00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002:00000000-0000-0000-0000-000000000004",
        "requestId":"00000000-0000-0000-0000-000000000005","operation":{"method":"agent.show","params":{}}
    })).unwrap()
    }
    fn metadata_json() -> serde_json::Value {
        json!({
            "mountId": "00000000-0000-0000-0000-000000000004",
            "localAgentId": "target-agent",
            "name": "Agent",
            "icon": "lightning",
            "description": null,
            "deviceId": "00000000-0000-0000-0000-000000000006",
            "deviceName": "Other device",
            "platform": "windows",
            "membershipRevision": 1,
            "enableRevision": 1,
            "selector": request().selector,
            "isLocal": false,
            "source": {
                "serviceId": local().service_id,
                "networkId": local().network_id,
            },
            "connectionEpoch": "00000000-0000-0000-0000-000000000007",
            "keyGeneration": 1,
            "signedBinding": "test-binding",
        })
    }
    fn decode_metadata(value: serde_json::Value) -> CallableAgent {
        // Exercise both transport schema validation and the actor's actual decode.
        myagents_agent_network_protocol::validate_metadata(
            myagents_agent_network_protocol::MetadataKind::CallableAgent,
            &value,
        )
        .unwrap();
        serde_json::from_value(value).expect("schema-valid callable metadata must decode")
    }
    fn metadata() -> CallableAgent {
        decode_metadata(metadata_json())
    }
    fn pending(calls: &mut Calls) -> (String, oneshot::Receiver<Result<CallResult, NetworkError>>) {
        pending_request(calls, request())
    }
    fn pending_request(
        calls: &mut Calls,
        request: SourceRequest,
    ) -> (String, oneshot::Receiver<Result<CallResult, NetworkError>>) {
        let (reply, response) = oneshot::channel();
        let mut reply = Some(reply);
        let op = calls
            .insert(
                request,
                VerifiedCaller::External {
                    label: "External CLI".into(),
                },
                &mut reply,
                Instant::now(),
                &local(),
                None,
                0,
            )
            .unwrap();
        (op, response)
    }
    fn preparing(calls: &mut Calls, op: &str) {
        calls.resolved(op, metadata(), &local()).unwrap();
        calls.calls.get_mut(op).unwrap().phase = Phase::Preparing {
            channel_id: "channel".into(),
            control_id: "control".into(),
        };
    }
    #[test]
    fn callable_metadata_icon_shapes_preserve_rpc_resolution() {
        for icon in [
            None,
            Some(json!(null)),
            Some(json!("lightning")),
            Some(json!("future-icon")),
        ] {
            let mut value = metadata_json();
            if let Some(icon) = &icon {
                value["icon"] = icon.clone();
            } else {
                value.as_object_mut().unwrap().remove("icon");
            }
            let target = decode_metadata(value);
            assert_eq!(
                target.icon,
                icon.and_then(|value| value.as_str().map(str::to_owned))
            );
            let peer = target.peer(&local());
            for (method, params) in [
                ("agent.show", json!({})),
                ("session.list", json!({"limit": 5})),
            ] {
                let request = SourceRequest::parse(json!({
                    "selector": request().selector,
                    "requestId": request().request_id,
                    "operation": {"method": method, "params": params},
                }))
                .unwrap();
                let mut calls = Calls::default();
                let (op, _reply) = pending_request(&mut calls, request);
                calls.resolved(&op, target.clone(), &local()).unwrap();
                assert!(peer == metadata().peer(&local()));
                assert_eq!(
                    calls.calls[&op].target.as_ref().unwrap().local_agent_id,
                    "target-agent"
                );
            }
        }
    }
    #[test]
    fn callable_metadata_keeps_protocol_and_decode_strict() {
        let mut unknown_field = metadata_json();
        unknown_field["unexpected"] = json!(true);
        assert!(myagents_agent_network_protocol::validate_metadata(
            myagents_agent_network_protocol::MetadataKind::CallableAgent,
            &unknown_field,
        )
        .is_err());
        assert!(serde_json::from_value::<CallableAgent>(unknown_field).is_err());

        for invalid_icon in [
            json!("x".repeat(257)),
            json!(42),
            json!({"name": "lightning"}),
        ] {
            let mut value = metadata_json();
            value["icon"] = invalid_icon;
            assert!(myagents_agent_network_protocol::validate_metadata(
                myagents_agent_network_protocol::MetadataKind::CallableAgent,
                &value,
            )
            .is_err());
        }
    }
    #[test]
    fn prepared_receipt_binds_all_identities_and_never_sends_twice() {
        let mut calls = Calls::default();
        let (op, _) = pending(&mut calls);
        preparing(&mut calls, &op);
        assert_eq!(
            calls
                .prepared(
                    "wrong",
                    &op,
                    &metadata().mount_id,
                    &metadata().peer(&local()),
                    &metadata().connection_epoch,
                    &local()
                )
                .err()
                .unwrap()
                .code,
            "OP_NOT_CURRENT"
        );
        let mut wrong = metadata().peer(&local());
        wrong.key_generation += 1;
        assert_eq!(
            calls
                .prepared(
                    "control",
                    &op,
                    &metadata().mount_id,
                    &wrong,
                    &metadata().connection_epoch,
                    &local()
                )
                .err()
                .unwrap()
                .code,
            "OP_SCOPE_MISMATCH"
        );
        let (channel, object) = calls
            .prepared(
                "control",
                &op,
                &metadata().mount_id,
                &metadata().peer(&local()),
                &metadata().connection_epoch,
                &local(),
            )
            .unwrap();
        assert_eq!(channel, "channel");
        if let BusinessObject::Invoke(invoke) = object {
            assert_eq!(invoke.operation.agent_id(), "target-agent");
            assert_eq!(invoke.request_id, request().request_id);
            assert_eq!(invoke.source.principal_id, "account");
        } else {
            panic!("expected invoke");
        }
        assert!(calls
            .prepared(
                "control",
                &op,
                &metadata().mount_id,
                &metadata().peer(&local()),
                &metadata().connection_epoch,
                &local()
            )
            .is_err());
        assert_eq!(calls.bytes(), 0);
    }
    #[tokio::test]
    async fn wrong_response_cannot_settle_call_and_duplicate_response_is_not_delivered() {
        let mut calls = Calls::default();
        let (op, reply) = pending(&mut calls);
        preparing(&mut calls, &op);
        calls
            .prepared(
                "control",
                &op,
                &metadata().mount_id,
                &metadata().peer(&local()),
                &metadata().connection_epoch,
                &local(),
            )
            .unwrap();
        let response = RpcResponse {
            version: 1,
            op_id: op.clone(),
            request_id: request().request_id,
            sender_sequence: 2,
            outcome: Outcome::Error {
                error: myagents_agent_network_protocol::BusinessError {
                    code: "TARGET_OFFLINE".into(),
                    message: "Offline".into(),
                },
            },
        };
        let mut wrong = response.clone();
        wrong.request_id = "wrong".into();
        assert_eq!(
            calls.response("channel", wrong).err().unwrap().code,
            "RESPONSE_SCOPE_MISMATCH"
        );
        assert_eq!(
            calls
                .response("other-channel", response.clone())
                .err()
                .unwrap()
                .code,
            "RESPONSE_SCOPE_MISMATCH"
        );
        assert_eq!(
            calls.response("channel", response.clone()).unwrap(),
            Some(op)
        );
        assert!(matches!(
            reply.await.unwrap().unwrap().outcome,
            Outcome::Error { .. }
        ));
        assert_eq!(calls.response("channel", response).unwrap(), None);
    }
    #[tokio::test]
    async fn disconnect_reports_uncertainty_only_after_transmission_and_drops_private_body() {
        let mut calls = Calls::default();
        let (op, reply) = pending(&mut calls);
        calls.expire(Instant::now() + Duration::from_secs(26));
        assert_eq!(
            reply.await.unwrap().err().unwrap().code,
            "NETWORK_REQUEST_NOT_SENT"
        );
        assert_eq!(calls.bytes(), 0);
        assert!(calls.is_empty());
        let (op2, reply2) = pending(&mut calls);
        preparing(&mut calls, &op2);
        calls
            .prepared(
                "control",
                &op2,
                &metadata().mount_id,
                &metadata().peer(&local()),
                &metadata().connection_epoch,
                &local(),
            )
            .unwrap();
        drop(calls);
        let failure = reply2.await.unwrap().err().unwrap();
        assert_eq!(failure.code, "NETWORK_QUERY_FAILED");
        assert_eq!(failure.details.unwrap()["requestId"], request().request_id);
        assert_ne!(op, op2);
    }
    #[test]
    fn untransmitted_requests_for_same_peer_share_one_channel_open() {
        let mut calls = Calls::default();
        let (a, _reply_a) = pending(&mut calls);
        let (b, _reply_b) = pending(&mut calls);
        calls.resolved(&a, metadata(), &local()).unwrap();
        calls.resolved(&b, metadata(), &local()).unwrap();
        let scope = ConnectionScope {
            service_id: local().service_id,
            network_id: local().network_id,
            boot_epoch: "boot".into(),
            connection_epoch: "epoch".into(),
        };
        let actions = calls.advance(&Pairs::default(), &local(), &scope);
        assert_eq!(actions.len(), 1);
        assert!(calls.control_failed(&actions[0].id, NetworkError::new("CHANNEL_PAIR_EXISTS")));
        assert_eq!(calls.calls.len(), 2);
        assert!(calls
            .advance(&Pairs::default(), &local(), &scope)
            .is_empty());
    }
}
