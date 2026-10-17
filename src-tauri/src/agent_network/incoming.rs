//! Connection-scoped invocation/permit correlation. Execution and history stay
//! with the original owners; this registry neither schedules nor replays work.
use super::{calls::Control, policy::LocalPolicy, NetworkError};
use myagents_agent_network_protocol::{
    budget, remote_deadline, BusinessError, ClientMessage, ConnectionScope, DeviceScope,
    Invocation, Outcome, RpcResponse, ServerMessage,
};
use std::sync::Arc;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

enum Phase {
    Preparing,
    Ready,
    Permit {
        control_id: String,
        attempt_id: String,
        requested_at: Instant,
        membership: u64,
        enabled: u64,
    },
    Admitted,
}
struct Entry {
    allocation: super::memory::Allocation,
    invocation: Option<Arc<Invocation>>,
    request_id: String,
    source: DeviceScope,
    target_mount: String,
    agent_id: String,
    channel: String,
    source_epoch: String,
    digest: [u8; 32],
    phase: Phase,
    deadline: Instant,
    bytes: usize,
    admitted_until: Option<Instant>,
}
struct Receipt {
    request_id: String,
    source: DeviceScope,
    source_epoch: String,
    digest: [u8; 32],
    outcome: Outcome,
    at: Instant,
    bytes: usize,
}
#[derive(Default)]
pub(crate) struct Incoming {
    memory: super::memory::MemoryBudget,
    entries: HashMap<String, Entry>,
    receipts: HashMap<String, Receipt>,
    bytes: usize,
    receipt_bytes: usize,
}
pub(crate) enum Admission {
    New,
    Pending,
    Completed(RpcResponse),
}
impl Incoming {
    pub(crate) fn new(memory: super::memory::MemoryBudget) -> Self {
        Self {
            memory,
            ..Self::default()
        }
    }
    pub(crate) fn insert(
        &mut self,
        mut invocation: Invocation,
        channel: &str,
        peer: &DeviceScope,
        epoch: &str,
        local: &DeviceScope,
        buffered: usize,
    ) -> Result<Admission, NetworkError> {
        if invocation.source != *peer
            || peer.service_id != local.service_id
            || peer.network_id != local.network_id
            || peer.principal_id != local.principal_id
            || peer.environment != local.environment
            || peer.device_id == local.device_id
            || invocation.return_route_id.is_some()
        {
            return Err(NetworkError::new("INVOCATION_SCOPE_MISMATCH"));
        }
        // The pair codec has already verified the transport sequence. Keep one
        // normalized invocation rather than cloning a potentially large query
        // solely to calculate its stable deduplication digest.
        invocation.sender_sequence = 1;
        let (encoded_len, digest) = super::memory::measure(&invocation)?;
        if let Some(entry) = self.entries.get(&invocation.op_id) {
            if entry.digest != digest || entry.source_epoch != epoch {
                return Err(NetworkError::new("OP_SCOPE_MISMATCH"));
            }
            return Ok(Admission::Pending);
        }
        if let Some(receipt) = self.receipts.get(&invocation.op_id) {
            if receipt.digest != digest || receipt.source_epoch != epoch || receipt.source != *peer
            {
                return Err(NetworkError::new("OP_SCOPE_MISMATCH"));
            }
            return Ok(Admission::Completed(RpcResponse {
                version: 1,
                op_id: invocation.op_id,
                request_id: receipt.request_id.clone(),
                sender_sequence: 1,
                outcome: receipt.outcome.clone(),
            }));
        }
        if self.entries.len() >= budget("pending")
            || self.entries.len() + self.receipts.len() >= budget("receipts")
        {
            return Err(NetworkError::new("TARGET_REQUEST_CAPACITY"));
        }
        // Fresh preparation transfers a second copy into the ordinary Inbox
        // owner. Reserve it while that cold preparation is still pending.
        let retained = if matches!(
            &invocation.operation,
            myagents_agent_network_protocol::Operation::Start(_)
                | myagents_agent_network_protocol::Operation::Send(_)
        ) {
            encoded_len * 2
        } else {
            encoded_len
        };
        if encoded_len > budget("objectBytes")
            || self
                .bytes()
                .checked_add(retained)
                .and_then(|n| n.checked_add(buffered))
                .is_none_or(|n| n > budget("connectorBytes"))
        {
            return Err(NetworkError::new("CONNECTOR_CAPACITY"));
        }
        let deadline = Instant::now()
            + Duration::from_millis(
                remote_deadline(invocation.operation.method(), "connector")
                    .expect("closed operation"),
            );
        // Small owner prechecks are bounded separately. Large read responses
        // grow their own allocation as bytes arrive, not at maximum page size.
        let allocation = self.memory.reserve(retained + budget("controlBytes") * 2)?;
        self.bytes += retained;
        self.entries.insert(
            invocation.op_id.clone(),
            Entry {
                allocation,
                request_id: invocation.request_id.clone(),
                source: invocation.source.clone(),
                target_mount: invocation.target_mount_id.clone(),
                agent_id: invocation.operation.agent_id().into(),
                invocation: Some(Arc::new(invocation)),
                channel: channel.into(),
                source_epoch: epoch.into(),
                digest,
                phase: Phase::Preparing,
                deadline,
                bytes: retained,
                admitted_until: None,
            },
        );
        Ok(Admission::New)
    }
    pub(crate) fn prepared(&mut self, op: &str) -> Result<(), NetworkError> {
        let entry = self
            .entries
            .get_mut(op)
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))?;
        if !matches!(entry.phase, Phase::Preparing) {
            return Err(NetworkError::new("OP_NOT_CURRENT"));
        }
        entry.phase = Phase::Ready;
        Ok(())
    }
    pub(crate) fn preparation(&self, op: &str) -> Result<Arc<Invocation>, NetworkError> {
        self.entries
            .get(op)
            .and_then(|entry| entry.invocation.clone())
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))
    }
    pub(crate) fn advance(
        &mut self,
        policy: &LocalPolicy,
        scope: &ConnectionScope,
    ) -> Vec<(String, Result<Control, NetworkError>)> {
        let mut actions = Vec::new();
        let permits = self
            .entries
            .values()
            .filter(|entry| matches!(entry.phase, Phase::Permit { .. }))
            .count();
        let mut available = budget("permits").saturating_sub(permits);
        for (op, entry) in &mut self.entries {
            if !matches!(entry.phase, Phase::Ready) {
                continue;
            }
            let Some(mount) = policy.mounts.get(&entry.target_mount) else {
                actions.push((op.clone(), Err(NetworkError::new("AGENT_NOT_AVAILABLE"))));
                continue;
            };
            if !policy.joined || !mount.enabled || mount.agent_id != entry.agent_id {
                actions.push((op.clone(), Err(NetworkError::new("AGENT_NOT_OPEN"))));
                continue;
            }
            if available == 0 {
                continue;
            }
            available -= 1;
            let control_id = uuid::Uuid::new_v4().to_string();
            let attempt_id = uuid::Uuid::new_v4().to_string();
            entry.phase = Phase::Permit {
                control_id: control_id.clone(),
                attempt_id: attempt_id.clone(),
                requested_at: Instant::now(),
                membership: policy.membership_revision,
                enabled: mount.enable_revision,
            };
            actions.push((
                op.clone(),
                Ok(Control {
                    id: control_id,
                    message: ClientMessage::Permit {
                        scope: scope.clone(),
                        op_id: op.clone(),
                        attempt_id,
                        target_mount_id: entry.target_mount.clone(),
                        expected_membership_revision: policy.membership_revision,
                        expected_enable_revision: mount.enable_revision,
                    },
                }),
            ));
        }
        actions
    }
    /// The actor checks current account/generation before calling this. A
    /// successful result is the last local admission handoff, not business ACK.
    pub(crate) fn permit(
        &mut self,
        control: &str,
        permit: &ServerMessage,
        local: &DeviceScope,
        scope: &ConnectionScope,
    ) -> Result<Invocation, NetworkError> {
        let ServerMessage::Permit {
            op_id,
            attempt_id,
            source,
            target,
            source_connection_epoch,
            target_connection_epoch,
            target_mount_id,
            membership_revision,
            enable_revision,
            freshness_ms,
            return_route_id,
            ..
        } = permit
        else {
            return Err(NetworkError::new("PERMIT_INVALID"));
        };
        let entry = self
            .entries
            .get_mut(op_id)
            .ok_or_else(|| NetworkError::new("OP_NOT_CURRENT"))?;
        let Phase::Permit {
            control_id,
            attempt_id: expected,
            requested_at,
            membership,
            enabled,
        } = &entry.phase
        else {
            return Err(NetworkError::new("PERMIT_ALREADY_CONSUMED"));
        };
        if control_id != control
            || expected != attempt_id
            || source != &entry.source
            || target != local
            || source_connection_epoch != &entry.source_epoch
            || target_connection_epoch != &scope.connection_epoch
            || target_mount_id != &entry.target_mount
            || membership_revision != membership
            || enable_revision != enabled
            || *freshness_ms != budget("permitMs") as u64
        {
            return Err(NetworkError::new("PERMIT_SCOPE_MISMATCH"));
        }
        if requested_at.elapsed() >= Duration::from_millis(*freshness_ms)
            || entry.deadline <= Instant::now()
        {
            return Err(NetworkError::new("PERMIT_EXPIRED"));
        }
        entry.admitted_until = Some(*requested_at + Duration::from_millis(*freshness_ms));
        entry.phase = Phase::Admitted;
        let invocation = entry
            .invocation
            .take()
            .ok_or_else(|| NetworkError::new("PERMIT_ALREADY_CONSUMED"))?;
        let mut invocation = Arc::try_unwrap(invocation)
            .map_err(|_| NetworkError::new("TARGET_PREPARATION_NOT_FINISHED"))?;
        invocation.return_route_id = Some(return_route_id.clone());
        Ok(invocation)
    }
    pub(crate) fn admitted_until(&self, op: &str) -> Option<Instant> {
        self.entries.get(op).and_then(|entry| entry.admitted_until)
    }
    pub(crate) fn control_op(&self, control: &str) -> Option<String> {
        self.entries.iter().find_map(|(op, entry)| {
            matches!(&entry.phase, Phase::Permit { control_id, .. } if control_id == control)
                .then(|| op.clone())
        })
    }
    pub(crate) fn finish(
        &mut self,
        op: &str,
        outcome: Outcome,
    ) -> Option<(String, RpcResponse, super::memory::Allocation)> {
        let entry = self.entries.remove(op)?;
        self.bytes -= entry.bytes;
        // Only compact admission/error receipts are cached. Read responses
        // transfer ownership directly to TLS and are never copied for dedup.
        let can_cache = matches!(
            &outcome,
            Outcome::Start { .. }
                | Outcome::Send { .. }
                | Outcome::Watch { .. }
                | Outcome::Error { .. }
        );
        let size =
            super::memory::measure(&outcome).map_or(budget("dedupBytes"), |value| value.0) + 512;
        let (cached, bytes) = if can_cache
            && size <= budget("controlBytes")
            && size
                <= budget("dedupBytes")
                    .saturating_sub(budget("receipts") * 768)
                    .saturating_sub(self.receipt_bytes)
        {
            (outcome.clone(), size)
        } else {
            (
                error_outcome(NetworkError::new("OP_ALREADY_COMPLETED")),
                768,
            )
        };
        let response = RpcResponse {
            version: 1,
            op_id: op.into(),
            request_id: entry.request_id.clone(),
            sender_sequence: 1,
            outcome,
        };
        self.receipt_bytes += bytes;
        self.receipts.insert(
            op.into(),
            Receipt {
                request_id: entry.request_id,
                source: entry.source,
                source_epoch: entry.source_epoch,
                digest: entry.digest,
                outcome: cached,
                at: Instant::now(),
                bytes,
            },
        );
        Some((entry.channel, response, entry.allocation))
    }
    pub(crate) fn expired(&mut self, now: Instant) -> Vec<String> {
        self.receipts.retain(|_, receipt| {
            let retain =
                now.duration_since(receipt.at) < Duration::from_millis(budget("receiptMs") as u64);
            if !retain {
                self.receipt_bytes -= receipt.bytes;
            }
            retain
        });
        self.entries
            .iter()
            .filter(|(_, entry)| entry.deadline <= now)
            .map(|(op, _)| op.clone())
            .collect()
    }
    pub(crate) fn channel_ops(&self, channel: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.channel == channel)
            .map(|(op, _)| op.clone())
            .collect()
    }
    pub(crate) fn bytes(&self) -> usize {
        self.bytes + self.receipt_bytes
    }
}
pub(crate) fn error_outcome(error: NetworkError) -> Outcome {
    Outcome::Error {
        error: BusinessError {
            code: error.code.clone(),
            message: error.code,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::policy::MountPolicy;
    use super::*;
    use myagents_agent_network_protocol::{AgentParams, Operation, VerifiedCaller};
    fn scope(device: &str) -> DeviceScope {
        DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            environment: "development".into(),
            principal_id: "account".into(),
            device_id: device.into(),
            key_generation: 1,
        }
    }
    fn local() -> DeviceScope {
        scope("00000000-0000-0000-0000-000000000003")
    }
    fn peer() -> DeviceScope {
        scope("00000000-0000-0000-0000-000000000004")
    }
    fn connection() -> ConnectionScope {
        ConnectionScope {
            service_id: local().service_id,
            network_id: local().network_id,
            boot_epoch: "00000000-0000-0000-0000-000000000005".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000006".into(),
        }
    }
    fn invocation() -> Invocation {
        Invocation {
            version: 1,
            op_id: "00000000-0000-0000-0000-000000000007".into(),
            request_id: "00000000-0000-0000-0000-000000000008".into(),
            sender_sequence: 1,
            source: peer(),
            caller: VerifiedCaller::External {
                label: "External CLI".into(),
            },
            target_mount_id: "00000000-0000-0000-0000-000000000009".into(),
            return_route_id: None,
            operation: Operation::Show(AgentParams {
                local_agent_id: "agent-target".into(),
            }),
        }
    }
    fn policy() -> LocalPolicy {
        LocalPolicy {
            device_name: "Fixture device".into(),
            joined: true,
            membership_revision: 2,
            mounts: HashMap::from([(
                invocation().target_mount_id,
                MountPolicy {
                    agent_id: "agent-target".into(),
                    enabled: true,
                    enable_revision: 3,
                },
            )]),
        }
    }
    fn prepared() -> (Incoming, String, ServerMessage) {
        let mut incoming = Incoming::default();
        let invocation = invocation();
        assert!(matches!(
            incoming
                .insert(
                    invocation.clone(),
                    "channel",
                    &peer(),
                    "source-epoch",
                    &local(),
                    0
                )
                .unwrap(),
            Admission::New
        ));
        incoming.prepared(&invocation.op_id).unwrap();
        let (_, Ok(action)) = incoming.advance(&policy(), &connection()).remove(0) else {
            panic!("permit action")
        };
        let ClientMessage::Permit { attempt_id, .. } = action.message else {
            panic!("permit")
        };
        let permit = ServerMessage::Permit {
            scope: connection(),
            op_id: invocation.op_id,
            attempt_id,
            permit_id: "00000000-0000-0000-0000-000000000010".into(),
            source: peer(),
            target: local(),
            source_connection_epoch: "source-epoch".into(),
            target_connection_epoch: connection().connection_epoch,
            target_mount_id: invocation.target_mount_id,
            membership_revision: 2,
            enable_revision: 3,
            freshness_ms: 5000,
            recoverable: false,
            return_route_id: "00000000-0000-0000-0000-000000000011".into(),
        };
        (incoming, action.id, permit)
    }
    #[test]
    fn many_small_reads_do_not_reserve_maximum_history_pages() {
        let memory = super::super::memory::MemoryBudget::default();
        let mut incoming = Incoming::new(memory.clone());
        for _ in 0..budget("pending") {
            let mut call = invocation();
            call.op_id = uuid::Uuid::new_v4().to_string();
            call.request_id = uuid::Uuid::new_v4().to_string();
            incoming
                .insert(call, "channel", &peer(), "epoch", &local(), 0)
                .unwrap();
        }
        // All 64 small owner jobs leave room for actual maximum-size responses.
        let _response = memory.reserve(budget("objectBytes") * 3).unwrap();
    }
    #[test]
    fn read_payload_is_not_retained_as_a_dedup_receipt() {
        let mut incoming = Incoming::default();
        let call = invocation();
        incoming
            .insert(call.clone(), "channel", &peer(), "epoch", &local(), 0)
            .unwrap();
        let (_, response, _allocation) = incoming
            .finish(
                &call.op_id,
                Outcome::Get {
                    result: serde_json::json!({"text":"x".repeat(1024*1024)}),
                },
            )
            .unwrap();
        assert!(matches!(response.outcome, Outcome::Get { .. }));
        assert_eq!(incoming.receipt_bytes, 768);
        assert!(
            matches!(&incoming.receipts[&call.op_id].outcome, Outcome::Error {error} if error.code == "OP_ALREADY_COMPLETED")
        );
    }
    #[test]
    fn rejects_cross_account_and_spoofed_source_before_preparation() {
        let mut incoming = Incoming::default();
        let mut malicious = invocation();
        malicious.source.principal_id = "other-account".into();
        assert!(incoming
            .insert(malicious, "channel", &peer(), "epoch", &local(), 0)
            .is_err());
        assert_eq!(incoming.bytes(), 0);
    }
    #[test]
    fn preflight_is_not_final_permission_and_closed_mount_cannot_acquire() {
        let mut incoming = Incoming::default();
        let invocation = invocation();
        incoming
            .insert(invocation.clone(), "channel", &peer(), "epoch", &local(), 0)
            .unwrap();
        assert!(incoming.advance(&policy(), &connection()).is_empty());
        incoming.prepared(&invocation.op_id).unwrap();
        let mut closed = policy();
        closed.joined = false;
        let action = incoming.advance(&closed, &connection()).remove(0).1;
        assert!(matches!(action, Err(NetworkError { code, .. }) if code == "AGENT_NOT_OPEN"));
    }
    #[test]
    fn binds_scope_revision_epoch_attempt_and_hands_off_once() {
        let (mut incoming, control, mut permit) = prepared();
        if let ServerMessage::Permit {
            target_connection_epoch,
            ..
        } = &mut permit
        {
            *target_connection_epoch = "old".into();
        }
        assert!(incoming
            .permit(&control, &permit, &local(), &connection())
            .is_err());
        if let ServerMessage::Permit {
            target_connection_epoch,
            ..
        } = &mut permit
        {
            *target_connection_epoch = connection().connection_epoch;
        }
        let granted = incoming
            .permit(&control, &permit, &local(), &connection())
            .unwrap();
        assert!(granted.return_route_id.is_some());
        assert!(incoming
            .permit(&control, &permit, &local(), &connection())
            .is_err());
        assert!(incoming.entries[&invocation().op_id].invocation.is_none());
    }
    #[test]
    fn network_rtt_counts_toward_permit_freshness() {
        let (mut incoming, control, permit) = prepared();
        if let Phase::Permit { requested_at, .. } =
            &mut incoming.entries.get_mut(&invocation().op_id).unwrap().phase
        {
            *requested_at = Instant::now() - Duration::from_secs(5);
        }
        assert!(
            matches!(incoming.permit(&control, &permit, &local(), &connection()), Err(NetworkError { code, .. }) if code == "PERMIT_EXPIRED")
        );
    }
    #[test]
    fn completed_or_pending_duplicate_never_reexecutes_and_payload_collision_is_rejected() {
        let (mut incoming, control, permit) = prepared();
        let mut duplicate = invocation();
        duplicate.sender_sequence = 2;
        assert!(matches!(
            incoming
                .insert(
                    duplicate.clone(),
                    "channel",
                    &peer(),
                    "source-epoch",
                    &local(),
                    0
                )
                .unwrap(),
            Admission::Pending
        ));
        incoming
            .permit(&control, &permit, &local(), &connection())
            .unwrap();
        incoming
            .finish(
                &duplicate.op_id,
                error_outcome(NetworkError::new("SESSION_NOT_FOUND")),
            )
            .unwrap();
        assert!(matches!(
            incoming
                .insert(
                    duplicate.clone(),
                    "rebuilt-channel",
                    &peer(),
                    "source-epoch",
                    &local(),
                    0
                )
                .unwrap(),
            Admission::Completed(_)
        ));
        duplicate.request_id = "00000000-0000-0000-0000-000000000012".into();
        assert!(incoming
            .insert(duplicate, "channel", &peer(), "source-epoch", &local(), 0)
            .is_err());
    }
}
