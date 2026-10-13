//! Device-pair state is scoped to one authenticated outer connection. Pair
//! sequence high-waters survive idle channel recreation until that scope drops.
use super::channel::{Channel, ManagementEvent, PairSequences};
use super::crypto::private_roots;
use super::identity::{NetworkIdentity, PeerIdentity};
use super::jwt::VerifiedPeer;
use super::NetworkError;
use myagents_agent_network_protocol::{
    budget, BusinessObject, ConnectionScope, DeviceScope, ServerMessage,
};
use myagents_host_management_protocol::{ManagementMessage, PeerRole};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

pub(crate) struct Offer {
    pub channel_id: String,
    pub initiator: DeviceScope,
    pub responder: DeviceScope,
    pub initiator_epoch: String,
    pub responder_epoch: String,
    pub initiator_binding: Option<String>,
    pub responder_binding: Option<String>,
}
pub(crate) struct VerifiedOffer {
    offer: Offer,
    first: VerifiedPeer,
    second: VerifiedPeer,
    identity: PeerIdentity,
    root_certificate: String,
}
impl Offer {
    pub(crate) fn validate_scope(
        &self,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<(), NetworkError> {
        if !((self.initiator == *local && self.initiator_epoch == epoch)
            || (self.responder == *local && self.responder_epoch == epoch))
            || self.initiator.service_id != self.responder.service_id
            || self.initiator.network_id != self.responder.network_id
            || self.initiator.environment != self.responder.environment
            || self.initiator.principal_id != self.responder.principal_id
            || self.initiator.device_id == self.responder.device_id
            || key(&self.initiator) >= key(&self.responder)
        {
            return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
        }
        Ok(())
    }
    pub(crate) async fn verify(
        self,
        identity: &NetworkIdentity,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<VerifiedOffer, NetworkError> {
        self.validate_scope(local, epoch)?;
        let mut verifier = identity.verifier.clone();
        let first = verifier
            .peer(
                self.initiator_binding
                    .as_deref()
                    .ok_or_else(|| NetworkError::new("PEER_BINDING_MISSING"))?,
            )
            .await?;
        let second = verifier
            .peer(
                self.responder_binding
                    .as_deref()
                    .ok_or_else(|| NetworkError::new("PEER_BINDING_MISSING"))?,
            )
            .await?;
        for (scope, peer) in [(&self.initiator, &first), (&self.responder, &second)] {
            if scope.service_id != peer.service_id
                || scope.environment != peer.environment
                || scope.principal_id != peer.principal_id
                || scope.device_id != peer.device_id
                || scope.key_generation != peer.key_generation
            {
                return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
            }
        }
        let ours = if self.initiator == *local {
            &first
        } else {
            &second
        };
        let verifier_root = identity.root_certificate.clone();
        let identity = identity
            .peer
            .as_ref()
            .ok_or_else(|| NetworkError::new("NETWORK_CERTIFICATE_INVALID"))?;
        if ours.certificate_fingerprint != identity.binding.certificate_fingerprint {
            return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
        }
        Ok(VerifiedOffer {
            offer: self,
            first,
            second,
            identity: identity.clone(),
            root_certificate: verifier_root,
        })
    }
}
// The server's canonical device key uses this exact ordered full scope tuple.
fn key(scope: &DeviceScope) -> String {
    format!(
        "{}/{}/{}/{}/{}/{}",
        scope.service_id,
        scope.environment,
        scope.network_id,
        scope.principal_id,
        scope.device_id,
        scope.key_generation
    )
}
struct Entry {
    channel: Channel,
    pair: String,
    announced: bool,
    accepted: bool,
    certificate_expires_at: u64,
    management_events: VecDeque<ManagementEvent>,
    management_event_bytes: usize,
    management_ready_announced: bool,
}
struct PendingOffer {
    accepted: bool,
    bytes: Vec<u8>,
    created_at: Instant,
}
fn event_size(event: &ManagementEvent) -> Result<usize, NetworkError> {
    let dynamic = match event {
        ManagementEvent::Ready => 0,
        ManagementEvent::Request { params, .. } => super::memory::measure(params)?.0 + 36,
        ManagementEvent::Response { result, .. } => super::memory::measure(result)?.0 + 36,
    };
    std::mem::size_of::<ManagementEvent>()
        .checked_add(dynamic)
        .ok_or_else(|| NetworkError::new("RESOURCE_EXHAUSTED"))
}
fn queue_management_events(
    queue: &mut VecDeque<ManagementEvent>,
    queued_bytes: &mut usize,
    events: Vec<ManagementEvent>,
) -> Result<(), NetworkError> {
    for event in events {
        let bytes = event_size(&event)?;
        *queued_bytes = queued_bytes
            .checked_add(bytes)
            .ok_or_else(|| NetworkError::new("RESOURCE_EXHAUSTED"))?;
        queue.push_back(event);
    }
    Ok(())
}
#[derive(Default)]
struct Credits {
    sent: u64,
    returned: u64,
    return_sequence: u64,
    received: u64,
    release_sequence: u64,
}
const MANAGEMENT_ACTIVE_TOMBSTONE_LIMIT: usize = 128;
const MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT: usize = 128;
const MANAGEMENT_TOMBSTONE_LIMIT: usize =
    MANAGEMENT_ACTIVE_TOMBSTONE_LIMIT + MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT;

struct RetiredManagementChannel {
    channel_id: String,
    connection_scope: ConnectionScope,
    local: DeviceScope,
    epoch: String,
    known_to_peer: bool,
    installed: bool,
    ready_seen: bool,
    closed_seen: bool,
    credits: Option<Credits>,
}

#[derive(Default)]
pub(crate) struct Pairs {
    memory: super::memory::MemoryBudget,
    management_role: Option<PeerRole>,
    allocation: Option<super::memory::Allocation>,
    pending: HashMap<String, PendingOffer>,
    channels: HashMap<String, Entry>,
    sequences: HashMap<String, PairSequences>,
    credits: HashMap<String, Credits>,
    retired_management: VecDeque<RetiredManagementChannel>,
    failures: Vec<(String, NetworkError)>,
}
impl Pairs {
    pub(crate) fn new(memory: super::memory::MemoryBudget) -> Self {
        Self {
            memory,
            ..Self::default()
        }
    }
    pub(crate) fn new_management(memory: super::memory::MemoryBudget, role: PeerRole) -> Self {
        Self {
            memory,
            management_role: Some(role),
            ..Self::default()
        }
    }
    fn account_buffers(&mut self) -> Result<(), NetworkError> {
        let bytes = self.buffered_bytes();
        match &mut self.allocation {
            Some(allocation) => allocation.resize(bytes),
            None => {
                self.allocation = Some(self.memory.reserve(bytes)?);
                Ok(())
            }
        }
    }

    pub(crate) fn reserve(&mut self, id: &str) -> Result<(), NetworkError> {
        if self.pending.contains_key(id)
            || self.channels.contains_key(id)
            || self
                .retired_management
                .iter()
                .any(|entry| entry.channel_id == id && entry.known_to_peer)
        {
            return Err(NetworkError::new("CHANNEL_ID_REUSED"));
        }
        let handshakes = self
            .channels
            .values()
            .filter(|entry| !entry.channel.ready())
            .count();
        if self.channels.len() + self.pending.len() >= budget("channels")
            || handshakes + self.pending.len() >= budget("handshakes")
        {
            return Err(NetworkError::new("CHANNEL_CAPACITY"));
        }
        self.credits.insert(id.into(), Credits::default());
        self.pending.insert(
            id.into(),
            PendingOffer {
                accepted: false,
                bytes: Vec::new(),
                created_at: Instant::now(),
            },
        );
        Ok(())
    }
    pub(crate) fn install(
        &mut self,
        verified: VerifiedOffer,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<(String, bool), NetworkError> {
        let offer = verified.offer;
        let pending = self
            .pending
            .remove(&offer.channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_CLOSED"))?;
        if pending.created_at.elapsed() > Duration::from_millis(budget("handshakeMs") as u64) {
            return Err(NetworkError::new("CHANNEL_HANDSHAKE_TIMEOUT"));
        }
        if self.channels.contains_key(&offer.channel_id) {
            return Err(NetworkError::new("CHANNEL_ID_REUSED"));
        }
        if self.channels.len() >= budget("channels")
            || self
                .channels
                .values()
                .filter(|value| !value.channel.ready())
                .count()
                >= budget("handshakes")
        {
            return Err(NetworkError::new("CHANNEL_CAPACITY"));
        }
        let certificate_expires_at = verified.first.expires_at.min(verified.second.expires_at);
        let initiator = offer.initiator == *local;
        let (peer, peer_epoch, binding) = if initiator {
            (offer.responder, offer.responder_epoch, verified.second)
        } else {
            (offer.initiator, offer.initiator_epoch, verified.first)
        };
        if self
            .channels
            .values()
            .any(|entry| entry.channel.peer() == &peer)
        {
            return Err(NetworkError::new("CHANNEL_PAIR_EXISTS"));
        }
        let pair = format!("{}|{}|{}|{}", key(local), key(&peer), epoch, peer_epoch);
        if !self.sequences.contains_key(&pair) && self.sequences.len() >= budget("catalogItems") {
            return Err(NetworkError::new("PAIR_SEQUENCE_CAPACITY"));
        }
        self.sequences.entry(pair.clone()).or_default();
        let roots = private_roots(&verified.root_certificate)?;
        let mut channel = match self.management_role {
            Some(role) => Channel::new_management(
                offer.channel_id.clone(),
                local.clone(),
                peer,
                epoch.into(),
                peer_epoch,
                &verified.identity.tls,
                roots,
                &binding,
                role,
                initiator,
            )?,
            None => Channel::new(
                offer.channel_id.clone(),
                local.clone(),
                peer,
                epoch.into(),
                peer_epoch,
                &verified.identity.tls,
                roots,
                &binding,
                initiator,
            )?,
        };
        let mut management_events = VecDeque::new();
        let mut management_event_bytes = 0usize;
        if !pending.bytes.is_empty() {
            for chunk in pending.bytes.chunks(budget("tlsChunkBytes")) {
                let sequences = self.sequences.get_mut(&pair).expect("installed sequence");
                if self.management_role.is_some() {
                    let decoded = channel.feed_management(chunk, sequences)?;
                    queue_management_events(
                        &mut management_events,
                        &mut management_event_bytes,
                        decoded,
                    )?;
                } else {
                    let objects = channel.feed(chunk, sequences)?;
                    if !objects.is_empty() {
                        return Err(NetworkError::new("CHANNEL_NOT_READY"));
                    }
                }
            }
        }
        let management_ready_announced = management_events
            .iter()
            .any(|event| matches!(event, ManagementEvent::Ready));
        self.channels.insert(
            offer.channel_id.clone(),
            Entry {
                channel,
                pair,
                announced: false,
                accepted: pending.accepted,
                certificate_expires_at,
                management_events,
                management_event_bytes,
                management_ready_announced,
            },
        );
        if let Err(error) = self.account_buffers() {
            self.remove(&offer.channel_id);
            return Err(error);
        }
        Ok((offer.channel_id, !initiator))
    }
    pub(crate) fn accepted(&mut self, channel_id: &str) -> Result<(), NetworkError> {
        if let Some(pending) = self.pending.get_mut(channel_id) {
            if pending.accepted {
                return Err(NetworkError::new("CHANNEL_ALREADY_ACCEPTED"));
            }
            pending.accepted = true;
            return Ok(());
        }
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        if entry.accepted {
            return Err(NetworkError::new("CHANNEL_ALREADY_ACCEPTED"));
        }
        entry.accepted = true;
        // A TLS initiator already has outbound ClientHello in its bounded writer.
        Ok(())
    }
    pub(crate) fn feed(
        &mut self,
        channel_id: &str,
        bytes: &[u8],
    ) -> Result<(Vec<BusinessObject>, super::memory::Allocation), NetworkError> {
        if self.management_role.is_some() {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        let channel_bytes = self.channels.get(channel_id).map_or_else(
            || {
                self.pending
                    .get(channel_id)
                    .map_or(0, |entry| entry.bytes.len())
            },
            |entry| entry.channel.buffered_bytes(),
        );
        // Retain the decoded objects' reservation through actor dispatch. An
        // incomplete object can become a complete Value in this very chunk.
        let allocation = self
            .memory
            .reserve((channel_bytes + bytes.len()) * 2 + budget("channelQueueBytes"))?;
        let objects = if let Some(pending) = self.pending.get_mut(channel_id) {
            if !pending.accepted {
                return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
            }
            if pending.bytes.len() + bytes.len() > budget("channelQueueBytes") {
                return Err(NetworkError::new("CHANNEL_BACKPRESSURE"));
            }
            pending.bytes.extend_from_slice(bytes);
            Vec::new()
        } else {
            let entry = self
                .channels
                .get_mut(channel_id)
                .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
            if !entry.accepted {
                return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
            }
            entry.channel.feed(
                bytes,
                self.sequences
                    .get_mut(&entry.pair)
                    .expect("installed sequence"),
            )?
        };
        self.account_buffers()?;
        Ok((objects, allocation))
    }
    pub(crate) fn feed_management(
        &mut self,
        channel_id: &str,
        bytes: &[u8],
    ) -> Result<(Vec<ManagementEvent>, super::memory::Allocation), NetworkError> {
        if self.management_role.is_none() {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        let channel_bytes = self.channels.get(channel_id).map_or_else(
            || {
                self.pending
                    .get(channel_id)
                    .map_or(0, |pending| pending.bytes.len())
            },
            |entry| entry.channel.buffered_bytes() + entry.management_event_bytes,
        );
        let allocation = self
            .memory
            .reserve((channel_bytes + bytes.len()) * 2 + budget("channelQueueBytes"))?;
        if let Some(pending) = self.pending.get_mut(channel_id) {
            if !pending.accepted {
                return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
            }
            if pending.bytes.len() + bytes.len() > budget("channelQueueBytes") {
                return Err(NetworkError::new("CHANNEL_BACKPRESSURE"));
            }
            pending.bytes.extend_from_slice(bytes);
            self.account_buffers()?;
            return Ok((Vec::new(), allocation));
        }
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        if !entry.accepted {
            return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
        }
        let mut events: Vec<_> = entry.management_events.drain(..).collect();
        entry.management_event_bytes = 0;
        let decoded = entry.channel.feed_management(
            bytes,
            self.sequences
                .get_mut(&entry.pair)
                .expect("installed sequence"),
        )?;
        if decoded
            .iter()
            .any(|event| matches!(event, ManagementEvent::Ready))
        {
            entry.management_ready_announced = true;
        }
        events.extend(decoded);
        self.account_buffers()?;
        Ok((events, allocation))
    }
    pub(crate) fn release_credit(
        &mut self,
        id: &str,
        bytes: usize,
    ) -> Result<(u64, u64), NetworkError> {
        let flow = self
            .credits
            .get_mut(id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        flow.received = flow
            .received
            .checked_add(bytes as u64)
            .filter(|x| *x <= 9_007_199_254_740_991)
            .ok_or_else(|| NetworkError::new("CREDIT_OVERFLOW"))?;
        flow.release_sequence += 1;
        Ok((flow.release_sequence, flow.received))
    }
    pub(crate) fn credit(
        &mut self,
        id: &str,
        sequence: u64,
        received: u64,
    ) -> Result<(), NetworkError> {
        // A close can overtake a previously queued credit notification.
        let Some(flow) = self.credits.get_mut(id) else {
            return Ok(());
        };
        if Some(sequence) != flow.return_sequence.checked_add(1)
            || received <= flow.returned
            || received > flow.sent
        {
            return Err(NetworkError::new("CREDIT_INVALID"));
        }
        flow.returned = received;
        flow.return_sequence = sequence;
        Ok(())
    }
    pub(crate) fn next_frame(&mut self) -> Result<Option<Vec<u8>>, NetworkError> {
        let device = self
            .credits
            .values()
            .map(|c| c.sent - c.returned)
            .sum::<u64>();
        let maximum = (budget("tlsChunkBytes") + 22) as u64;
        if device + maximum > budget("socketQueueBytes") as u64 {
            return Ok(None);
        }
        let mut result = None;
        for (id, entry) in self.channels.iter_mut().filter(|(_, entry)| entry.accepted) {
            let flow = self.credits.get_mut(id).expect("reserved channel credits");
            if flow.sent - flow.returned + maximum > budget("channelQueueBytes") as u64 {
                continue;
            }
            let frame = match entry.channel.drain_frame() {
                Ok(frame) => frame,
                Err(error) => {
                    self.failures.push((id.clone(), error));
                    continue;
                }
            };
            if let Some(frame) = frame {
                flow.sent = flow
                    .sent
                    .checked_add(frame.len() as u64)
                    .filter(|x| *x <= 9_007_199_254_740_991)
                    .ok_or_else(|| NetworkError::new("CREDIT_OVERFLOW"))?;
                result = Some(frame);
                break;
            }
        }
        self.account_buffers()?;
        Ok(result)
    }
    pub(crate) fn announce_ready(&mut self) -> Vec<String> {
        self.channels
            .values_mut()
            .filter_map(|entry| {
                if entry.channel.crypto_ready() && !entry.announced {
                    entry.announced = true;
                    Some(entry.channel.id.clone())
                } else {
                    None
                }
            })
            .collect()
    }
    pub(crate) fn ready(&mut self, channel_id: &str) -> Result<(), NetworkError> {
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        entry.channel.mark_relay_ready()?;
        if self.management_role.is_some()
            && entry.channel.ready()
            && !entry.management_ready_announced
        {
            let event = ManagementEvent::Ready;
            entry.management_event_bytes = event_size(&event)?;
            entry.management_events.push_back(event);
            entry.management_ready_announced = true;
            if let Err(error) = self.account_buffers() {
                self.remove(channel_id);
                return Err(error);
            }
        }
        Ok(())
    }
    pub(crate) fn remove(&mut self, channel_id: &str) {
        self.channels.remove(channel_id);
        self.pending.remove(channel_id);
        self.credits.remove(channel_id);
        // Removal only releases bytes and therefore cannot exceed the budget.
        self.account_buffers().expect("buffer release");
    }

    /// Reserve bounded bookkeeping before sending an Open. A full tombstone
    /// table therefore rejects before a remote management operation can run.
    pub(crate) fn reserve_management_retirement(
        &mut self,
        channel_id: &str,
        connection_scope: &ConnectionScope,
        local: &DeviceScope,
    ) -> Result<(), NetworkError> {
        if self.management_role.is_none() {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        if self
            .retired_management
            .iter()
            .any(|entry| entry.channel_id == channel_id)
            || self.pending.contains_key(channel_id)
            || self.channels.contains_key(channel_id)
        {
            return Err(NetworkError::new("CHANNEL_ID_REUSED"));
        }
        let active = self
            .retired_management
            .iter()
            .filter(|entry| !entry.closed_seen)
            .count();
        if active >= MANAGEMENT_ACTIVE_TOMBSTONE_LIMIT {
            return Err(NetworkError::new("HOST_MANAGEMENT_CAPACITY"));
        }
        if self.retired_management.len() >= MANAGEMENT_TOMBSTONE_LIMIT {
            let completed = self
                .retired_management
                .iter()
                .filter(|entry| entry.closed_seen)
                .count();
            if completed >= MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT {
                if let Some(index) = self
                    .retired_management
                    .iter()
                    .position(|entry| entry.closed_seen)
                {
                    self.retired_management.remove(index);
                } else {
                    return Err(NetworkError::new("HOST_MANAGEMENT_CAPACITY"));
                }
            } else {
                return Err(NetworkError::new("HOST_MANAGEMENT_CAPACITY"));
            }
        }
        self.retired_management.push_back(RetiredManagementChannel {
            channel_id: channel_id.to_owned(),
            connection_scope: connection_scope.clone(),
            local: local.clone(),
            epoch: connection_scope.connection_epoch.clone(),
            known_to_peer: false,
            installed: false,
            ready_seen: false,
            closed_seen: false,
            credits: None,
        });
        if let Err(error) = self.account_buffers() {
            self.retired_management.pop_back();
            return Err(error);
        }
        Ok(())
    }

    /// Remove the active pair while preserving only the bounded state needed
    /// to validate controls already queued on this connection.
    pub(crate) fn retire_management(&mut self, channel_id: &str, known_to_peer: bool) {
        let Some(index) = self
            .retired_management
            .iter()
            .position(|entry| entry.channel_id == channel_id)
        else {
            // Preserve a confirmed operation result if an internal invariant
            // is ever violated; the actor's next strict control check will
            // fail closed instead of rewriting a receipt as unconfirmed.
            self.remove(channel_id);
            return;
        };
        let active = self.channels.remove(channel_id);
        let credits = self.credits.remove(channel_id);
        self.pending.remove(channel_id);
        if !known_to_peer {
            self.retired_management.remove(index);
            self.account_buffers()
                .expect("pair retirement releases buffers");
            return;
        }
        let retired = &mut self.retired_management[index];
        retired.installed = active.is_some();
        retired.ready_seen = active.as_ref().is_some_and(|entry| entry.channel.ready());
        retired.credits = credits;
        retired.known_to_peer = known_to_peer;
        self.account_buffers()
            .expect("pair retirement releases buffers");
    }

    /// A bounded tombstone must own cleanup before a probe can preserve its actor.
    pub(crate) fn management_retired_ready(&self, channel_id: &str) -> bool {
        !self.channels.contains_key(channel_id)
            && !self.pending.contains_key(channel_id)
            && self.retired_management.iter().any(|entry| {
                entry.channel_id == channel_id
                    && entry.known_to_peer
                    && entry.installed
                    && entry.ready_seen
            })
    }

    pub(crate) fn note_management_closed(&mut self, channel_id: &str) {
        if let Some(entry) = self
            .retired_management
            .iter_mut()
            .find(|entry| entry.channel_id == channel_id)
        {
            entry.closed_seen = true;
        }
    }

    /// Consume only valid, same-connection cleanup controls for a channel
    /// retired by this management client. All other controls stay in the
    /// caller's strict current-channel dispatch and are rejected there.
    pub(crate) fn consume_retired_management(
        &mut self,
        message: &ServerMessage,
        connection_scope: &ConnectionScope,
        local: &DeviceScope,
        epoch: &str,
    ) -> Result<bool, NetworkError> {
        let channel_id = match message {
            ServerMessage::ChannelClosed { channel_id, .. }
            | ServerMessage::ChannelReady { channel_id, .. }
            | ServerMessage::Credit { channel_id, .. } => channel_id,
            _ => return Ok(false),
        };
        let Some(retired) = self
            .retired_management
            .iter_mut()
            .find(|entry| entry.channel_id == *channel_id)
        else {
            return Ok(false);
        };
        if !retired.known_to_peer {
            return Ok(false);
        }
        if !retired.known_to_peer
            || retired.connection_scope != *connection_scope
            || retired.local != *local
            || retired.epoch != epoch
            || message.scope() != Some(connection_scope)
        {
            return Err(NetworkError::new("CONTROL_SCOPE_MISMATCH"));
        }
        match message {
            ServerMessage::ChannelClosed { .. } => {
                if retired.closed_seen {
                    return Err(NetworkError::new("CONTROL_UNEXPECTED"));
                }
                retired.closed_seen = true;
            }
            ServerMessage::ChannelReady { .. } => {
                if !retired.installed || retired.ready_seen {
                    return Err(NetworkError::new("CONTROL_UNEXPECTED"));
                }
                retired.ready_seen = true;
            }
            ServerMessage::Credit {
                sequence,
                received_bytes,
                ..
            } => {
                let Some(flow) = retired.credits.as_mut() else {
                    return Err(NetworkError::new("CREDIT_INVALID"));
                };
                if Some(*sequence) != flow.return_sequence.checked_add(1)
                    || *received_bytes <= flow.returned
                    || *received_bytes > flow.sent
                {
                    return Err(NetworkError::new("CREDIT_INVALID"));
                }
                flow.returned = *received_bytes;
                flow.return_sequence = *sequence;
            }
            _ => unreachable!(),
        }
        if matches!(message, ServerMessage::ChannelClosed { .. }) {
            // Urgent relay cleanup may overtake queued controls. Keep a bounded
            // completed tombstone so valid late Ready/Credit can still be checked.
            let completed = self
                .retired_management
                .iter()
                .filter(|entry| entry.closed_seen)
                .count();
            if completed > MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT {
                if let Some(index) = self
                    .retired_management
                    .iter()
                    .position(|entry| entry.closed_seen && entry.channel_id != *channel_id)
                {
                    self.retired_management.remove(index);
                }
            }
            self.account_buffers()?;
        }
        Ok(true)
    }
    pub(crate) fn send(
        &mut self,
        channel_id: &str,
        object: BusinessObject,
    ) -> Result<(), NetworkError> {
        if self.management_role.is_some() {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        let result = self.write_object(channel_id, object);
        if let Err(error) = &result {
            self.remove(channel_id);
            self.failures.push((channel_id.to_owned(), error.clone()));
        }
        result
    }
    pub(crate) fn send_management(
        &mut self,
        channel_id: &str,
        message: ManagementMessage,
    ) -> Result<(), NetworkError> {
        if self.management_role.is_none() {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        let result = self.write_management(channel_id, message);
        if let Err(error) = &result {
            self.remove(channel_id);
            self.failures.push((channel_id.to_owned(), error.clone()));
        }
        result
    }
    fn write_management(
        &mut self,
        channel_id: &str,
        message: ManagementMessage,
    ) -> Result<(), NetworkError> {
        let message_bytes = super::memory::measure(&message)?.0;
        // The outer frame adds namespace, version, channel UUID, sequence, JSON
        // punctuation and the four-byte prefix. Reserve those bounded bytes too.
        let envelope_bytes = message_bytes
            .checked_add(256)
            .filter(|bytes| *bytes <= myagents_host_management_protocol::MAX_OBJECT_BYTES)
            .ok_or_else(|| NetworkError::new("MESSAGE_TOO_LARGE"))?;
        let reservation = envelope_bytes
            .checked_mul(3)
            .and_then(|bytes| bytes.checked_add(budget("channelQueueBytes")))
            .ok_or_else(|| NetworkError::new("RESOURCE_EXHAUSTED"))?;
        let _encoding = self.memory.reserve(reservation)?;
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        if !entry.accepted {
            return Err(NetworkError::new("CHANNEL_NOT_ACCEPTED"));
        }
        entry.channel.send_management(message)?;
        self.account_buffers()
    }
    pub(crate) fn take_failures(&mut self) -> Vec<(String, NetworkError)> {
        std::mem::take(&mut self.failures)
    }
    fn write_object(
        &mut self,
        channel_id: &str,
        object: BusinessObject,
    ) -> Result<(), NetworkError> {
        let bytes = super::memory::measure(&object)?.0;
        if bytes > budget("objectBytes") {
            return Err(NetworkError::new("MESSAGE_TOO_LARGE"));
        }
        // Validation Value, encoded frame and TLS writer coexist during encode.
        let _encoding = self
            .memory
            .reserve(bytes * 3 + budget("channelQueueBytes"))?;
        let entry = self
            .channels
            .get_mut(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?;
        entry.channel.send(
            object,
            self.sequences
                .get_mut(&entry.pair)
                .expect("installed sequence"),
        )?;
        self.account_buffers()
    }
    pub(crate) fn ready_for(&self, peer: &DeviceScope, epoch: &str) -> Option<&str> {
        self.channels
            .values()
            .find(|entry| {
                entry.channel.peer() == peer
                    && entry.channel.peer_epoch() == epoch
                    && entry.channel.ready()
            })
            .map(|entry| entry.channel.id.as_str())
    }
    pub(crate) fn has_channel(&self, channel_id: &str) -> bool {
        self.channels.contains_key(channel_id)
    }
    pub(crate) fn peer(&self, channel_id: &str) -> Result<(&DeviceScope, &str), NetworkError> {
        let channel = &self
            .channels
            .get(channel_id)
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_FOUND"))?
            .channel;
        if !channel.ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        Ok((channel.peer(), channel.peer_epoch()))
    }
    pub(crate) fn buffered_bytes(&self) -> usize {
        self.channels
            .values()
            .map(|entry| entry.channel.buffered_bytes() + entry.management_event_bytes)
            .sum::<usize>()
            + self
                .pending
                .values()
                .map(|entry| entry.bytes.len())
                .sum::<usize>()
            + self
                .retired_management
                .iter()
                .map(|entry| {
                    entry.channel_id.capacity()
                        + entry.connection_scope.service_id.capacity()
                        + entry.connection_scope.network_id.capacity()
                        + entry.connection_scope.boot_epoch.capacity()
                        + entry.connection_scope.connection_epoch.capacity()
                        + entry.local.service_id.capacity()
                        + entry.local.environment.capacity()
                        + entry.local.network_id.capacity()
                        + entry.local.principal_id.capacity()
                        + entry.local.device_id.capacity()
                })
                .sum::<usize>()
            + self
                .retired_management
                .capacity()
                .saturating_mul(std::mem::size_of::<RetiredManagementChannel>())
    }
    pub(crate) fn expired(&self) -> Vec<(String, &'static str)> {
        let now = Instant::now();
        self.channels
            .values()
            .filter_map(|entry| {
                if entry.certificate_expires_at <= jsonwebtoken::get_current_timestamp() {
                    Some((entry.channel.id.clone(), "CHANNEL_CERTIFICATE_EXPIRED"))
                } else if !entry.channel.ready()
                    && now.duration_since(entry.channel.created_at)
                        > Duration::from_millis(budget("handshakeMs") as u64)
                {
                    Some((entry.channel.id.clone(), "CHANNEL_HANDSHAKE_TIMEOUT"))
                } else {
                    None
                }
            })
            .chain(self.pending.iter().filter_map(|(id, entry)| {
                (now.duration_since(entry.created_at)
                    > Duration::from_millis(budget("handshakeMs") as u64))
                .then(|| (id.clone(), "CHANNEL_HANDSHAKE_TIMEOUT"))
            }))
            .collect()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::crypto::{certificate_fingerprint, tests::Fixture, TlsIdentity};
    use super::super::identity::PeerIdentity;
    use super::*;
    use myagents_agent_network_protocol::{decode_tls_frame, ChannelHello, PeerBinding};
    use myagents_host_management_protocol::{
        CanonicalUuid, ManagementMethod, RequestParams, SnapshotParams,
    };
    use std::sync::Arc;

    fn management_scopes() -> (DeviceScope, DeviceScope) {
        let scope = |n| DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            principal_id: "account".into(),
            device_id: format!("00000000-0000-0000-0000-{n:012}"),
            key_generation: 1,
        };
        (scope(3), scope(4))
    }

    fn verified_management_offers(
        fixture: Fixture,
        channel_id: &str,
        first: &DeviceScope,
        second: &DeviceScope,
    ) -> (VerifiedOffer, VerifiedOffer) {
        let first_epoch = "00000000-0000-0000-0000-000000000007";
        let second_epoch = "00000000-0000-0000-0000-000000000008";
        let binding = |scope: &DeviceScope, identity: &TlsIdentity, san: &str| {
            VerifiedPeer::fixture(PeerBinding {
                service_id: scope.service_id.clone(),
                environment: scope.environment.clone(),
                principal_id: scope.principal_id.clone(),
                device_id: scope.device_id.clone(),
                key_generation: scope.key_generation,
                identity_binding_id: "00000000-0000-0000-0000-000000000005".into(),
                certificate_fingerprint: certificate_fingerprint(&identity.certificates[0]),
                san: san.into(),
                certificate: String::new(),
                expires_at: jsonwebtoken::get_current_timestamp() + 3600,
            })
        };
        let first_peer = binding(first, &fixture.first, "first.network.invalid");
        let second_peer = binding(second, &fixture.second, "second.network.invalid");
        let root_certificate = fixture.ca.pem();
        let make_offer = |local_identity, local_binding| VerifiedOffer {
            offer: Offer {
                channel_id: channel_id.into(),
                initiator: first.clone(),
                responder: second.clone(),
                initiator_epoch: first_epoch.into(),
                responder_epoch: second_epoch.into(),
                initiator_binding: None,
                responder_binding: None,
            },
            first: first_peer.clone(),
            second: second_peer.clone(),
            identity: PeerIdentity {
                tls: Arc::new(local_identity),
                binding: local_binding,
                signed_binding: String::new(),
            },
            root_certificate: root_certificate.clone(),
        };
        (
            make_offer(fixture.first, first_peer.clone()),
            make_offer(fixture.second, second_peer.clone()),
        )
    }

    pub(crate) fn installed_management_pair() -> (Pairs, Pairs, DeviceScope, DeviceScope, String) {
        let (first, second) = management_scopes();
        let channel_id = "00000000-0000-0000-0000-000000000006".to_owned();
        let fixture = Fixture::new();
        let (first_offer, second_offer) =
            verified_management_offers(fixture, &channel_id, &first, &second);
        let mut a = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Host,
        );
        let mut b = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Controller,
        );
        a.reserve(&channel_id).unwrap();
        b.reserve(&channel_id).unwrap();
        a.accepted(&channel_id).unwrap();
        b.accepted(&channel_id).unwrap();
        a.install(first_offer, &first, "00000000-0000-0000-0000-000000000007")
            .unwrap();
        b.install(
            second_offer,
            &second,
            "00000000-0000-0000-0000-000000000008",
        )
        .unwrap();
        (a, b, first, second, channel_id)
    }

    pub(crate) fn management_budget(pairs: &Pairs) -> super::super::memory::MemoryBudget {
        pairs.memory.clone()
    }

    pub(crate) fn exchange_management(a: &mut Pairs, b: &mut Pairs, id: &str) -> (bool, bool) {
        let mut ready_a = false;
        let mut ready_b = false;
        for _ in 0..32 {
            let mut moved = false;
            while let Some(frame) = a.next_frame().unwrap() {
                moved = true;
                let (events, _allocation) = b
                    .feed_management(id, decode_tls_frame(&frame).unwrap().1)
                    .unwrap();
                ready_b |= events
                    .iter()
                    .any(|event| matches!(event, ManagementEvent::Ready));
            }
            if let Some(flow) = a.credits.get(id) {
                if flow.sent > flow.returned {
                    a.credit(id, flow.return_sequence + 1, flow.sent).unwrap();
                }
            }
            while let Some(frame) = b.next_frame().unwrap() {
                moved = true;
                let (events, _allocation) = a
                    .feed_management(id, decode_tls_frame(&frame).unwrap().1)
                    .unwrap();
                ready_a |= events
                    .iter()
                    .any(|event| matches!(event, ManagementEvent::Ready));
            }
            if let Some(flow) = b.credits.get(id) {
                if flow.sent > flow.returned {
                    b.credit(id, flow.return_sequence + 1, flow.sent).unwrap();
                }
            }
            for pairs in [&mut *a, &mut *b] {
                let ready = pairs
                    .channels
                    .get(id)
                    .is_some_and(|entry| entry.channel.crypto_ready());
                if ready {
                    pairs.announce_ready();
                    pairs.ready(id).unwrap();
                }
            }
            if a.channels[id].channel.ready() && b.channels[id].channel.ready() {
                return (ready_a, ready_b);
            }
            assert!(moved || !a.channels[id].channel.ready() || !b.channels[id].channel.ready());
        }
        panic!("management pair did not reach ready")
    }

    #[test]
    fn pairs_keep_management_roles_separate_from_tls_direction_and_gate_mode() {
        let (mut host, mut controller, host_scope, controller_scope, id) =
            installed_management_pair();
        // Canonical lower-key host is the TLS initiator, while the management role is Host.
        // Controller therefore sends the management Hello despite being the TLS responder.
        assert!(!host.channels[&id].channel.crypto_ready());
        assert_eq!(
            host.send(
                &id,
                BusinessObject::Hello(ChannelHello {
                    version: 1,
                    sender_sequence: 1,
                    channel_id: id.clone(),
                    source: host_scope.clone(),
                    target: controller_scope.clone(),
                    source_connection_epoch: "00000000-0000-0000-0000-000000000007".into(),
                    target_connection_epoch: "00000000-0000-0000-0000-000000000008".into(),
                })
            )
            .unwrap_err()
            .code,
            "CHANNEL_MODE_MISMATCH"
        );
        assert_eq!(
            controller.feed(&id, b"x").err().unwrap().code,
            "CHANNEL_MODE_MISMATCH"
        );
        let (host_ready_event, controller_ready_event) =
            exchange_management(&mut host, &mut controller, &id);
        assert_eq!(
            host.ready_for(&controller_scope, "00000000-0000-0000-0000-000000000008"),
            Some(id.as_str())
        );
        assert_eq!(
            controller.ready_for(&host_scope, "00000000-0000-0000-0000-000000000007"),
            Some(id.as_str())
        );
        let host_ready_event = host_ready_event
            || host
                .feed_management(&id, &[])
                .unwrap()
                .0
                .iter()
                .any(|event| matches!(event, ManagementEvent::Ready));
        let controller_ready_event = controller_ready_event
            || controller
                .feed_management(&id, &[])
                .unwrap()
                .0
                .iter()
                .any(|event| matches!(event, ManagementEvent::Ready));
        assert!(host_ready_event && controller_ready_event);

        let request_id = CanonicalUuid::new(uuid::Uuid::new_v4());
        controller
            .send_management(
                &id,
                ManagementMessage::Request {
                    request_id,
                    method: ManagementMethod::HostSnapshot,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            )
            .unwrap();
        let frame = controller
            .next_frame()
            .unwrap()
            .expect("queued request frame");
        let (events, _allocation) = host
            .feed_management(&id, decode_tls_frame(&frame).unwrap().1)
            .unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            ManagementEvent::Request {
                method: ManagementMethod::HostSnapshot,
                ..
            }
        )));
        assert!(controller.channels[&id].channel.peer() == &host_scope);
    }

    #[test]
    fn management_send_before_ready_retires_only_the_unready_pair() {
        let (_host, mut controller, _peer, _local, id) = installed_management_pair();
        let error = controller
            .send_management(
                &id,
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: ManagementMethod::HostSnapshot,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "CHANNEL_NOT_READY");
        assert!(!controller.has_channel(&id));
        let failures = controller.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, id);
        assert_eq!(failures[0].1.code, error.code);
    }

    #[test]
    fn management_outbox_backpressure_and_close_preserve_pair_sequence_owner() {
        let (mut _host, mut controller, first, second, id) = installed_management_pair();
        exchange_management(&mut _host, &mut controller, &id);
        let pair_key = format!(
            "{}|{}|{}|{}",
            key(&second),
            key(&first),
            "00000000-0000-0000-0000-000000000008",
            "00000000-0000-0000-0000-000000000007"
        );
        let sequence_owner = &controller.sequences[&pair_key] as *const PairSequences;
        for _ in 0..10_000 {
            let result = controller.send_management(
                &id,
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: ManagementMethod::HostSnapshot,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            );
            result.unwrap();
        }
        let mut sent = 0u64;
        while let Some(frame) = controller.next_frame().unwrap() {
            sent += frame.len() as u64;
        }
        assert!(sent > 0 && sent <= budget("channelQueueBytes") as u64);
        assert!(controller.channels[&id].channel.buffered_bytes() > 0);
        // A remote credit releases the bounded writer and allows the remaining frames to drain.
        controller
            .credit(&id, controller.credits[&id].return_sequence + 1, sent)
            .unwrap();
        let mut drained_after_credit = false;
        while controller.next_frame().unwrap().is_some() {
            drained_after_credit = true;
            let flow = &controller.credits[&id];
            controller
                .credit(&id, flow.return_sequence + 1, flow.sent)
                .unwrap();
        }
        assert!(drained_after_credit);
        controller.remove(&id);
        assert_eq!(controller.buffered_bytes(), 0);
        assert!(!controller.credits.contains_key(&id));
        assert_eq!(
            &controller.sequences[&pair_key] as *const PairSequences,
            sequence_owner
        );

        // Re-reserving the same pair/channel uses the preserved sequence owner rather than
        // silently creating a fresh high-water record.
        let fixture = Fixture::new();
        let (_, second_offer) = verified_management_offers(fixture, &id, &first, &second);
        controller.reserve(&id).unwrap();
        controller.accepted(&id).unwrap();
        controller
            .install(
                second_offer,
                &second,
                "00000000-0000-0000-0000-000000000008",
            )
            .unwrap();
        assert_eq!(
            &controller.sequences[&pair_key] as *const PairSequences,
            sequence_owner
        );
        controller.remove(&id);
    }

    #[test]
    fn management_write_failure_retires_only_the_affected_pair() {
        let (mut host, mut controller, _first, local, first_id) = installed_management_pair();
        let second_peer = DeviceScope {
            device_id: "00000000-0000-0000-0000-000000000002".into(),
            ..local.clone()
        };
        let second_id = "00000000-0000-0000-0000-000000000009";
        let (host_offer, controller_offer) =
            verified_management_offers(Fixture::new(), second_id, &second_peer, &local);
        let mut host_two = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Host,
        );
        host_two.reserve(second_id).unwrap();
        host_two.accepted(second_id).unwrap();
        host_two
            .install(
                host_offer,
                &second_peer,
                "00000000-0000-0000-0000-000000000007",
            )
            .unwrap();
        controller.reserve(second_id).unwrap();
        controller.accepted(second_id).unwrap();
        controller
            .install(
                controller_offer,
                &local,
                "00000000-0000-0000-0000-000000000008",
            )
            .unwrap();
        exchange_management(&mut host, &mut controller, &first_id);
        exchange_management(&mut host_two, &mut controller, second_id);

        // ConfigSet with Snapshot params is a typed but schema-invalid management message.
        // Encoding advances local management state before it can fail, so this pair must close.
        let error = controller
            .send_management(
                &first_id,
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: ManagementMethod::ConfigSet,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            )
            .unwrap_err();
        assert!(!error.code.is_empty());
        assert!(!controller.has_channel(&first_id));
        assert!(controller.has_channel(second_id));
        let failures = controller.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, first_id);
        assert_eq!(failures[0].1.code, error.code);
        assert!(controller.next_frame().unwrap().is_none());
        controller
            .send_management(
                second_id,
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: ManagementMethod::HostSnapshot,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            )
            .unwrap();
        assert!(controller.has_channel(second_id));
    }

    #[test]
    fn management_memory_preflight_fails_closed_before_tls_write() {
        let (mut _host, mut controller, _peer, _local, id) = installed_management_pair();
        exchange_management(&mut _host, &mut controller, &id);
        let held = controller
            .memory
            .reserve(budget("connectorBytes") - controller.buffered_bytes() - 1)
            .unwrap();
        let error = controller
            .send_management(
                &id,
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: ManagementMethod::HostSnapshot,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "CONNECTOR_CAPACITY");
        assert!(!controller.has_channel(&id));
        assert!(controller.next_frame().unwrap().is_none());
        let failures = controller.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, id);
        assert_eq!(failures[0].1.code, error.code);
        drop(held);
    }

    #[test]
    fn management_post_write_accounting_failure_closes_only_written_pair() {
        let (mut host, mut controller, _first, local, first_id) = installed_management_pair();
        let second_peer = DeviceScope {
            device_id: "00000000-0000-0000-0000-000000000002".into(),
            ..local.clone()
        };
        let second_id = "00000000-0000-0000-0000-000000000009";
        let (host_offer, controller_offer) =
            verified_management_offers(Fixture::new(), second_id, &second_peer, &local);
        let mut host_two = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Host,
        );
        host_two.reserve(second_id).unwrap();
        host_two.accepted(second_id).unwrap();
        host_two
            .install(
                host_offer,
                &second_peer,
                "00000000-0000-0000-0000-000000000007",
            )
            .unwrap();
        controller.reserve(second_id).unwrap();
        controller.accepted(second_id).unwrap();
        controller
            .install(
                controller_offer,
                &local,
                "00000000-0000-0000-0000-000000000008",
            )
            .unwrap();
        exchange_management(&mut host, &mut controller, &first_id);
        exchange_management(&mut host_two, &mut controller, second_id);

        let message = ManagementMessage::Request {
            request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            method: ManagementMethod::HostSnapshot,
            params: RequestParams::Snapshot(SnapshotParams {}),
        };
        let message_bytes = super::super::memory::measure(&message).unwrap().0;
        let encoding_reservation = (message_bytes + 256) * 3 + budget("channelQueueBytes");
        let held_bytes =
            budget("connectorBytes") - controller.buffered_bytes() - encoding_reservation - 1;
        let held = controller.memory.reserve(held_bytes).unwrap();

        // The temporary encoding reservation fits with one byte left, but the TLS write adds
        // more than one byte to the persistent pair projection; post-write accounting must fail.
        let error = controller.send_management(&first_id, message).unwrap_err();
        assert_eq!(error.code, "CONNECTOR_CAPACITY");
        assert!(!controller.has_channel(&first_id));
        assert!(controller.has_channel(second_id));
        assert!(controller.next_frame().unwrap().is_none());
        let failures = controller.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, first_id);
        assert_eq!(failures[0].1.code, error.code);
        drop(held);
    }

    #[test]
    fn concurrent_responses_wait_for_credit_without_retiring_the_pair() {
        use myagents_agent_network_protocol::{decode_tls_frame, Outcome, RpcResponse};
        let (sender, mut receiver, send_sequence, mut receive_sequence) =
            super::super::channel::tests::ready_pair();
        let channel = sender.id.clone();
        let mut pairs = Pairs::default();
        pairs.sequences.insert("pair".into(), send_sequence);
        pairs.credits.insert(channel.clone(), Credits::default());
        pairs.channels.insert(
            channel.clone(),
            Entry {
                channel: sender,
                pair: "pair".into(),
                announced: true,
                accepted: true,
                certificate_expires_at: jsonwebtoken::get_current_timestamp() + 3600,
                management_events: VecDeque::new(),
                management_event_bytes: 0,
                management_ready_announced: false,
            },
        );
        let response = |text: String| {
            BusinessObject::Response(RpcResponse {
                version: 1,
                sender_sequence: 1,
                op_id: uuid::Uuid::new_v4().to_string(),
                request_id: uuid::Uuid::new_v4().to_string(),
                outcome: Outcome::Get {
                    result: serde_json::json!({"id":"session","messages":[{"id":"message","role":"assistant","timestamp":"2026-10-01T00:00:00Z","content":text}],"hasMoreBefore":false,"isLive":false,"liveSessionState":null,"snapshotRevision":1}),
                },
            })
        };
        pairs
            .send(
                &channel,
                response("x".repeat(budget("channelQueueBytes") * 3)),
            )
            .unwrap();
        let mut received = Vec::new();
        while let Some(frame) = pairs.next_frame().unwrap() {
            received.extend(
                receiver
                    .feed(decode_tls_frame(&frame).unwrap().1, &mut receive_sequence)
                    .unwrap(),
            );
        }
        assert!(received.is_empty());
        pairs.send(&channel, response("second".into())).unwrap();
        assert!(pairs.take_failures().is_empty());
        loop {
            let (seq, bytes) = {
                let flow = &pairs.credits[&channel];
                (flow.return_sequence + 1, flow.sent)
            };
            pairs.credit(&channel, seq, bytes).unwrap();
            let mut drained = false;
            while let Some(frame) = pairs.next_frame().unwrap() {
                drained = true;
                received.extend(
                    receiver
                        .feed(decode_tls_frame(&frame).unwrap().1, &mut receive_sequence)
                        .unwrap(),
                );
            }
            if !drained {
                break;
            }
        }
        assert_eq!(received.len(), 2);
        assert!(pairs.channels.contains_key(&channel));
        pairs.remove(&channel);
        assert_eq!(pairs.buffered_bytes(), 0);
    }
    #[test]
    fn writer_capacity_retires_only_the_affected_pair() {
        let (mut first, _, first_sequence, _) = super::super::channel::tests::ready_pair();
        let (mut other, _, other_sequence, _) = super::super::channel::tests::ready_pair();
        first.id = uuid::Uuid::new_v4().to_string();
        other.id = uuid::Uuid::new_v4().to_string();
        let failed = first.id.clone();
        let healthy = other.id.clone();
        let mut pairs = Pairs::default();
        for (channel, pair, sequence) in [
            (first, "first", first_sequence),
            (other, "other", other_sequence),
        ] {
            pairs.credits.insert(channel.id.clone(), Credits::default());
            pairs.sequences.insert(pair.into(), sequence);
            pairs.channels.insert(
                channel.id.clone(),
                Entry {
                    channel,
                    pair: pair.into(),
                    announced: true,
                    accepted: true,
                    certificate_expires_at: jsonwebtoken::get_current_timestamp() + 3600,
                    management_events: VecDeque::new(),
                    management_event_bytes: 0,
                    management_ready_announced: false,
                },
            );
        }
        pairs.account_buffers().unwrap();
        let pressure = pairs
            .memory
            .reserve(budget("connectorBytes") - pairs.buffered_bytes())
            .unwrap();
        let object = BusinessObject::Response(myagents_agent_network_protocol::RpcResponse {
            version: 1,
            sender_sequence: 1,
            op_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            outcome: super::super::incoming::error_outcome(NetworkError::new("TARGET_BUSY")),
        });
        assert_eq!(
            pairs.send(&failed, object).unwrap_err().code,
            "CONNECTOR_CAPACITY"
        );
        assert!(!pairs.has_channel(&failed));
        assert!(pairs.has_channel(&healthy));
        let failures = pairs.take_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].0, failed);
        drop(pressure);
        pairs.remove(&healthy);
        assert_eq!(pairs.buffered_bytes(), 0);
    }
    #[test]
    fn accepted_before_verification_is_bounded_and_cancelled_with_offer() {
        let mut pairs = Pairs::default();
        pairs.reserve("offer").unwrap();
        assert_eq!(
            pairs.feed("offer", b"tls").err().unwrap().code,
            "CHANNEL_NOT_ACCEPTED"
        );
        pairs.accepted("offer").unwrap();
        assert!(pairs
            .feed("offer", &vec![1; budget("channelQueueBytes")])
            .unwrap()
            .0
            .is_empty());
        assert_eq!(pairs.buffered_bytes(), budget("channelQueueBytes"));
        assert_eq!(
            pairs.feed("offer", &[1]).err().unwrap().code,
            "CHANNEL_BACKPRESSURE"
        );
        pairs.remove("offer");
        assert_eq!(pairs.buffered_bytes(), 0);
        assert_eq!(
            pairs.accepted("offer").err().unwrap().code,
            "CHANNEL_NOT_FOUND"
        );
    }

    #[test]
    fn unsupported_ready_probe_retirement_preserves_connection_scope_and_recycles_cleanup() {
        let (remote, local) = management_scopes();
        let channel = "00000000-0000-0000-0000-000000000096".to_owned();
        let (remote_offer, local_offer) =
            verified_management_offers(Fixture::new(), &channel, &remote, &local);
        let mut host = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Host,
        );
        let mut controller = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Controller,
        );
        let scope = ConnectionScope {
            service_id: local.service_id.clone(),
            network_id: local.network_id.clone(),
            boot_epoch: "00000000-0000-0000-0000-000000000010".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000008".into(),
        };
        let saved_scope = scope.clone();
        controller
            .reserve_management_retirement(&channel, &scope, &local)
            .unwrap();
        host.reserve(&channel).unwrap();
        controller.reserve(&channel).unwrap();
        host.accepted(&channel).unwrap();
        controller.accepted(&channel).unwrap();
        host.install(
            remote_offer,
            &remote,
            "00000000-0000-0000-0000-000000000007",
        )
        .unwrap();
        controller
            .install(local_offer, &local, &scope.connection_epoch)
            .unwrap();
        assert!(!controller.management_retired_ready(&channel));
        exchange_management(&mut host, &mut controller, &channel);
        controller
            .send_management(
                &channel,
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: ManagementMethod::HostCapabilities,
                    params: RequestParams::Snapshot(SnapshotParams {}),
                },
            )
            .unwrap();
        assert!(controller.next_frame().unwrap().is_some());
        controller.note_management_closed(&channel);
        controller.retire_management(&channel, true);
        assert!(controller.management_retired_ready(&channel));
        assert!(!controller.has_channel(&channel));
        assert!(scope == saved_scope);
        // Late scoped credit remains validated by the tombstone rather than resetting the actor.
        let credit = controller
            .retired_management
            .iter()
            .find(|r| r.channel_id == channel)
            .unwrap()
            .credits
            .as_ref()
            .unwrap();
        assert!(credit.sent > credit.returned);
        let late_credit = ServerMessage::Credit {
            scope: scope.clone(),
            channel_id: channel.clone(),
            sequence: credit.return_sequence + 1,
            received_bytes: credit.sent,
        };
        assert!(controller
            .consume_retired_management(&late_credit, &scope, &local, &scope.connection_epoch)
            .unwrap());
        assert!(controller
            .consume_retired_management(&late_credit, &scope, &local, &scope.connection_epoch)
            .is_err());
        let unexpected = ServerMessage::ChannelClosed {
            scope: scope.clone(),
            channel_id: uuid::Uuid::new_v4().to_string(),
            reason: "peer-closed".into(),
        };
        assert!(!controller
            .consume_retired_management(&unexpected, &scope, &local, &scope.connection_epoch)
            .unwrap());
    }

    #[test]
    fn retired_management_controls_are_scoped_validated_and_terminal_close_frees_slot() {
        let (first, second) = management_scopes();
        let local = first.clone();
        let id = "00000000-0000-0000-0000-000000000099";
        let connection = ConnectionScope {
            service_id: local.service_id.clone(),
            network_id: local.network_id.clone(),
            boot_epoch: "00000000-0000-0000-0000-000000000010".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000011".into(),
        };
        let (first_offer, second_offer) =
            verified_management_offers(Fixture::new(), id, &first, &second);
        let mut local_pairs = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Host,
        );
        let mut peer_pairs = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Controller,
        );
        local_pairs
            .reserve_management_retirement(id, &connection, &local)
            .unwrap();
        // The reservation coexists with the active channel until the request ends.
        local_pairs.reserve(id).unwrap();
        peer_pairs.reserve(id).unwrap();
        local_pairs.accepted(id).unwrap();
        peer_pairs.accepted(id).unwrap();
        local_pairs
            .install(first_offer, &first, &connection.connection_epoch)
            .unwrap();
        peer_pairs
            .install(
                second_offer,
                &second,
                "00000000-0000-0000-0000-000000000012",
            )
            .unwrap();
        local_pairs.credits.get_mut(id).unwrap().sent = 100;
        local_pairs.retire_management(id, true);

        let late_ready = ServerMessage::ChannelReady {
            scope: connection.clone(),
            channel_id: id.into(),
        };
        assert!(local_pairs
            .consume_retired_management(
                &late_ready,
                &connection,
                &local,
                &connection.connection_epoch
            )
            .unwrap());
        assert_eq!(
            local_pairs
                .consume_retired_management(
                    &late_ready,
                    &connection,
                    &local,
                    &connection.connection_epoch,
                )
                .unwrap_err()
                .code,
            "CONTROL_UNEXPECTED"
        );
        let late_credit = |sequence, received_bytes| ServerMessage::Credit {
            scope: connection.clone(),
            channel_id: id.into(),
            sequence,
            received_bytes,
        };
        assert!(local_pairs
            .consume_retired_management(
                &late_credit(1, 60),
                &connection,
                &local,
                &connection.connection_epoch,
            )
            .unwrap());
        assert_eq!(
            local_pairs
                .consume_retired_management(
                    &late_credit(3, 90),
                    &connection,
                    &local,
                    &connection.connection_epoch,
                )
                .unwrap_err()
                .code,
            "CREDIT_INVALID"
        );
        let mut wrong_connection = connection.clone();
        wrong_connection.connection_epoch = "00000000-0000-0000-0000-000000000013".into();
        assert_eq!(
            local_pairs
                .consume_retired_management(
                    &late_credit(2, 100),
                    &wrong_connection,
                    &local,
                    &wrong_connection.connection_epoch,
                )
                .unwrap_err()
                .code,
            "CONTROL_SCOPE_MISMATCH"
        );
        let mut wrong_local = local.clone();
        wrong_local.key_generation += 1;
        assert_eq!(
            local_pairs
                .consume_retired_management(
                    &late_credit(2, 100),
                    &connection,
                    &wrong_local,
                    &connection.connection_epoch,
                )
                .unwrap_err()
                .code,
            "CONTROL_SCOPE_MISMATCH"
        );
        let unknown = ServerMessage::ChannelClosed {
            scope: connection.clone(),
            channel_id: "00000000-0000-0000-0000-000000000098".into(),
            reason: "peer-closed".into(),
        };
        assert!(!local_pairs
            .consume_retired_management(&unknown, &connection, &local, &connection.connection_epoch)
            .unwrap());

        let closed = ServerMessage::ChannelClosed {
            scope: connection.clone(),
            channel_id: id.into(),
            reason: "peer-closed".into(),
        };
        assert!(local_pairs
            .consume_retired_management(&closed, &connection, &local, &connection.connection_epoch)
            .unwrap());
        assert_eq!(local_pairs.retired_management.len(), 1);
        assert_eq!(
            local_pairs
                .consume_retired_management(
                    &closed,
                    &connection,
                    &local,
                    &connection.connection_epoch,
                )
                .unwrap_err()
                .code,
            "CONTROL_UNEXPECTED"
        );
        // Urgent relay delivery can overtake a queued Credit; retain and check
        // that valid late frame after receiving Closed.
        assert!(local_pairs
            .consume_retired_management(
                &late_credit(2, 100),
                &connection,
                &local,
                &connection.connection_epoch,
            )
            .unwrap());
        // A normal terminal ack releases the active slot for the next RPC while
        // retaining bounded state for controls that urgent delivery may reorder.
        local_pairs
            .reserve_management_retirement(
                "00000000-0000-0000-0000-000000000097",
                &connection,
                &local,
            )
            .unwrap();
        peer_pairs.remove(id);
    }

    #[test]
    fn rejected_management_offer_close_is_consumed_as_known_retirement() {
        let (local, _) = management_scopes();
        let connection = ConnectionScope {
            service_id: local.service_id.clone(),
            network_id: local.network_id.clone(),
            boot_epoch: "00000000-0000-0000-0000-000000000020".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000021".into(),
        };
        let rejected_offer = "00000000-0000-0000-0000-000000000022";
        let mut pairs = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Host,
        );

        // Mirrors the management-only Offer rejection path: reserve the exact
        // peer-visible channel before sending Close, then accept its late ack.
        pairs
            .reserve_management_retirement(rejected_offer, &connection, &local)
            .unwrap();
        pairs.retire_management(rejected_offer, true);
        let close_ack = ServerMessage::ChannelClosed {
            scope: connection.clone(),
            channel_id: rejected_offer.into(),
            reason: "peer-closed".into(),
        };
        assert!(pairs
            .consume_retired_management(
                &close_ack,
                &connection,
                &local,
                &connection.connection_epoch,
            )
            .unwrap());
        let unknown = ServerMessage::ChannelClosed {
            scope: connection.clone(),
            channel_id: "00000000-0000-0000-0000-000000000023".into(),
            reason: "peer-closed".into(),
        };
        assert!(
            !pairs
                .consume_retired_management(
                    &unknown,
                    &connection,
                    &local,
                    &connection.connection_epoch,
                )
                .unwrap()
        );
        assert_eq!(pairs.retired_management.len(), 1);
    }

    #[test]
    fn retired_management_tombstone_capacity_fails_before_open_and_closed_ack_recycles() {
        let local = management_scopes().0;
        let connection = ConnectionScope {
            service_id: local.service_id.clone(),
            network_id: local.network_id.clone(),
            boot_epoch: "00000000-0000-0000-0000-000000000020".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000021".into(),
        };
        let mut pairs = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Controller,
        );
        for index in 0..MANAGEMENT_ACTIVE_TOMBSTONE_LIMIT {
            pairs
                .reserve_management_retirement(
                    &format!("00000000-0000-0000-0000-{index:012}"),
                    &connection,
                    &local,
                )
                .unwrap();
        }
        assert_eq!(
            pairs
                .reserve_management_retirement(
                    "10000000-0000-0000-0000-000000000000",
                    &connection,
                    &local,
                )
                .unwrap_err()
                .code,
            "HOST_MANAGEMENT_CAPACITY"
        );
        let oldest = "00000000-0000-0000-0000-000000000000";
        pairs.retire_management(oldest, true);
        let closed = ServerMessage::ChannelClosed {
            scope: connection.clone(),
            channel_id: oldest.into(),
            reason: "peer-closed".into(),
        };
        assert!(pairs
            .consume_retired_management(&closed, &connection, &local, &connection.connection_epoch)
            .unwrap());
        pairs
            .reserve_management_retirement(
                "10000000-0000-0000-0000-000000000000",
                &connection,
                &local,
            )
            .unwrap();
    }

    #[test]
    fn completed_management_tombstones_evict_oldest_at_fixed_bound() {
        let local = management_scopes().0;
        let connection = ConnectionScope {
            service_id: local.service_id.clone(),
            network_id: local.network_id.clone(),
            boot_epoch: "00000000-0000-0000-0000-000000000030".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000031".into(),
        };
        let mut pairs = Pairs::new_management(
            super::super::memory::MemoryBudget::default(),
            PeerRole::Controller,
        );
        for index in 0..=MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT {
            let id = format!("00000000-0000-0000-0001-{index:012}");
            pairs
                .reserve_management_retirement(&id, &connection, &local)
                .unwrap();
            pairs.retire_management(&id, true);
            let closed = ServerMessage::ChannelClosed {
                scope: connection.clone(),
                channel_id: id.clone(),
                reason: "peer-closed".into(),
            };
            assert!(pairs
                .consume_retired_management(
                    &closed,
                    &connection,
                    &local,
                    &connection.connection_epoch,
                )
                .unwrap());
        }
        assert_eq!(
            pairs.retired_management.len(),
            MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT
        );
        let evicted = ServerMessage::Credit {
            scope: connection.clone(),
            channel_id: "00000000-0000-0000-0001-000000000000".into(),
            sequence: 1,
            received_bytes: 1,
        };
        assert!(!pairs
            .consume_retired_management(&evicted, &connection, &local, &connection.connection_epoch)
            .unwrap());
        let newest = ServerMessage::ChannelClosed {
            scope: connection.clone(),
            channel_id: format!(
                "00000000-0000-0000-0001-{index:012}",
                index = MANAGEMENT_COMPLETED_TOMBSTONE_LIMIT
            ),
            reason: "peer-closed".into(),
        };
        assert_eq!(
            pairs
                .consume_retired_management(
                    &newest,
                    &connection,
                    &local,
                    &connection.connection_epoch,
                )
                .unwrap_err()
                .code,
            "CONTROL_UNEXPECTED"
        );
    }
    #[test]
    fn verification_jobs_count_towards_handshake_capacity_and_expire() {
        let mut pairs = Pairs::default();
        for i in 0..budget("handshakes") {
            pairs.reserve(&i.to_string()).unwrap();
        }
        assert_eq!(
            pairs.reserve("extra").err().unwrap().code,
            "CHANNEL_CAPACITY"
        );
        pairs.pending.get_mut("0").unwrap().created_at -=
            Duration::from_millis(budget("handshakeMs") as u64 + 1);
        assert_eq!(
            pairs.expired(),
            vec![("0".into(), "CHANNEL_HANDSHAKE_TIMEOUT")]
        );
        pairs.remove("0");
        pairs.reserve("extra").unwrap();
    }
}
