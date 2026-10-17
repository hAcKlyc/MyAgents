//! Device-pair crypto channel; Session execution remains outside this owner.
//! Pair sequences outlive an idle TLS channel and are cleared only at an outer
//! account/connection epoch boundary, so receipt expiry cannot admit a replay.
use super::crypto::{InnerTls, TlsIdentity};
use super::jwt::VerifiedPeer;
use super::NetworkError;
use myagents_agent_network_protocol::{
    budget, encode_object, encode_tls_frame, validate_business, BusinessObject, ChannelHello,
    DeviceScope, ObjectDecoder, ReceiveSequence,
};
use myagents_host_management_protocol::{
    encode_frame as encode_management, CanonicalUuid, Frame as ManagementFrame,
    FrameDecoder as ManagementDecoder, ManagementMessage, PeerRole, RequestParams, ResponseResult,
    MAX_OBJECT_BYTES as MAX_MANAGEMENT_OBJECT_BYTES,
    MAX_RECEIVE_BYTES as MAX_MANAGEMENT_RECEIVE_BYTES,
};
use rustls::RootCertStore;
use serde_json::Value;
use std::time::Instant;

const MANAGEMENT_BOOTSTRAP_LIMIT: usize =
    MAX_MANAGEMENT_OBJECT_BYTES + 4 + MAX_MANAGEMENT_RECEIVE_BYTES;

#[derive(Default)]
pub(crate) struct PairSequences {
    incoming: ReceiveSequence,
    outgoing: u64,
}
impl PairSequences {
    fn next(&mut self) -> Result<u64, NetworkError> {
        self.outgoing = self
            .outgoing
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| NetworkError::new("CHANNEL_SEQUENCE_EXHAUSTED"))?;
        Ok(self.outgoing)
    }
}
pub(crate) struct Channel {
    pub id: String,
    local: DeviceScope,
    peer: DeviceScope,
    local_epoch: String,
    peer_epoch: String,
    tls: InnerTls,
    decoder: ObjectDecoder,
    mode: ChannelMode,
    hello_sent: bool,
    peer_hello: bool,
    relay_ready: bool,
    failed: bool,
    pub created_at: Instant,
    pub last_activity: Instant,
}
enum ChannelMode {
    Agent,
    Management(ManagementChannel),
}
struct ManagementChannel {
    role: PeerRole,
    initiator: bool,
    state: ManagementState,
    channel_id: CanonicalUuid,
    nonce: CanonicalUuid,
    incoming_sequence: u64,
    outgoing_sequence: u64,
    decoder: ManagementDecoder,
    bootstrap: Vec<u8>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum ManagementState {
    AwaitHello,
    AwaitAck,
    Ready,
}
#[derive(Debug)]
pub(crate) enum ManagementEvent {
    Ready,
    Request {
        request_id: CanonicalUuid,
        method: myagents_host_management_protocol::ManagementMethod,
        params: RequestParams,
    },
    Response {
        request_id: CanonicalUuid,
        result: ResponseResult,
    },
}
impl Channel {
    pub(crate) fn new(
        id: String,
        local: DeviceScope,
        peer: DeviceScope,
        local_epoch: String,
        peer_epoch: String,
        identity: &TlsIdentity,
        roots: RootCertStore,
        binding: &VerifiedPeer,
        initiator: bool,
    ) -> Result<Self, NetworkError> {
        if local.service_id != peer.service_id
            || local.environment != peer.environment
            || local.network_id != peer.network_id
            || local.principal_id != peer.principal_id
            || local.device_id == peer.device_id
            || binding.service_id != peer.service_id
            || binding.environment != peer.environment
            || binding.principal_id != peer.principal_id
            || binding.device_id != peer.device_id
            || binding.key_generation != peer.key_generation
        {
            return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
        }
        let tls = if initiator {
            InnerTls::client(
                identity,
                roots,
                binding.san.clone(),
                binding.certificate_fingerprint.clone(),
            )?
        } else {
            InnerTls::server(
                identity,
                roots,
                binding.san.clone(),
                binding.certificate_fingerprint.clone(),
            )?
        };
        let now = Instant::now();
        Ok(Self {
            id,
            local,
            peer,
            local_epoch,
            peer_epoch,
            tls,
            decoder: ObjectDecoder::default(),
            mode: ChannelMode::Agent,
            hello_sent: false,
            peer_hello: false,
            relay_ready: false,
            failed: false,
            created_at: now,
            last_activity: now,
        })
    }
    pub(crate) fn new_management(
        id: String,
        local: DeviceScope,
        peer: DeviceScope,
        local_epoch: String,
        peer_epoch: String,
        identity: &TlsIdentity,
        roots: RootCertStore,
        binding: &VerifiedPeer,
        role: PeerRole,
        tls_initiator: bool,
    ) -> Result<Self, NetworkError> {
        let management_initiator = role == PeerRole::Controller;
        let channel_id =
            CanonicalUuid::parse(&id).map_err(|_| NetworkError::new("CHANNEL_ID_INVALID"))?;
        let mut channel = Self::new(
            id,
            local,
            peer,
            local_epoch,
            peer_epoch,
            identity,
            roots,
            binding,
            tls_initiator,
        )?;
        channel.mode = ChannelMode::Management(ManagementChannel {
            role,
            initiator: management_initiator,
            state: if management_initiator {
                ManagementState::AwaitAck
            } else {
                ManagementState::AwaitHello
            },
            channel_id,
            nonce: CanonicalUuid::new(uuid::Uuid::new_v4()),
            incoming_sequence: 0,
            outgoing_sequence: 0,
            decoder: ManagementDecoder::default(),
            bootstrap: Vec::new(),
        });
        Ok(channel)
    }
    pub(crate) fn peer(&self) -> &DeviceScope {
        &self.peer
    }
    pub(crate) fn peer_epoch(&self) -> &str {
        &self.peer_epoch
    }
    pub(crate) fn crypto_ready(&self) -> bool {
        !self.failed && self.tls.verified() && self.hello_sent && self.peer_hello
    }
    pub(crate) fn ready(&self) -> bool {
        match &self.mode {
            ChannelMode::Agent => self.crypto_ready() && self.relay_ready,
            ChannelMode::Management(channel) => {
                self.crypto_ready() && self.relay_ready && channel.state == ManagementState::Ready
            }
        }
    }
    pub(crate) fn mark_relay_ready(&mut self) -> Result<(), NetworkError> {
        if !self.crypto_ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        self.relay_ready = true;
        Ok(())
    }
    pub(crate) fn feed(
        &mut self,
        bytes: &[u8],
        sequences: &mut PairSequences,
    ) -> Result<Vec<BusinessObject>, NetworkError> {
        if matches!(self.mode, ChannelMode::Management(_)) {
            return Err(NetworkError::new("MANAGEMENT_FEED_REQUIRED"));
        }
        if self.failed {
            return Err(NetworkError::new("CHANNEL_CLOSED"));
        }
        let result = self.feed_inner(bytes, sequences);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    pub(crate) fn feed_management(
        &mut self,
        bytes: &[u8],
        sequences: &mut PairSequences,
    ) -> Result<Vec<ManagementEvent>, NetworkError> {
        if !matches!(self.mode, ChannelMode::Management(_)) {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        if self.failed {
            return Err(NetworkError::new("CHANNEL_CLOSED"));
        }
        let result = self.feed_management_inner(bytes, sequences);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn feed_management_inner(
        &mut self,
        bytes: &[u8],
        sequences: &mut PairSequences,
    ) -> Result<Vec<ManagementEvent>, NetworkError> {
        let plaintext = self.tls.feed(bytes)?;
        self.last_activity = Instant::now();
        if self.tls.verified() && !self.hello_sent {
            let hello = BusinessObject::Hello(ChannelHello {
                version: 1,
                sender_sequence: sequences.next()?,
                channel_id: self.id.clone(),
                source: self.local.clone(),
                target: self.peer.clone(),
                source_connection_epoch: self.local_epoch.clone(),
                target_connection_epoch: self.peer_epoch.clone(),
            });
            self.write_object(&hello)?;
            self.hello_sent = true;
        }

        let tail = plaintext.as_slice();
        if !self.peer_hello {
            let management = match &mut self.mode {
                ChannelMode::Management(value) => value,
                ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
            };
            if tail.len() > MANAGEMENT_BOOTSTRAP_LIMIT.saturating_sub(management.bootstrap.len()) {
                return Err(NetworkError::new("RESOURCE_EXHAUSTED"));
            }
            management
                .bootstrap
                .try_reserve_exact(tail.len())
                .map_err(|_| NetworkError::new("RESOURCE_EXHAUSTED"))?;
            management.bootstrap.extend_from_slice(tail);
            if management.bootstrap.len() < 4 {
                return Ok(Vec::new());
            }
            let size = u32::from_be_bytes(
                management.bootstrap[..4]
                    .try_into()
                    .map_err(|_| NetworkError::new("CHANNEL_HELLO_MISMATCH"))?,
            ) as usize;
            if size == 0 || size > MAX_MANAGEMENT_OBJECT_BYTES.min(budget("controlBytes")) {
                return Err(NetworkError::new("CHANNEL_HELLO_MISMATCH"));
            }
            let end = 4usize
                .checked_add(size)
                .ok_or_else(|| NetworkError::new("CHANNEL_HELLO_MISMATCH"))?;
            if management.bootstrap.len() < end {
                return Ok(Vec::new());
            }
            let value: Value = serde_json::from_slice(&management.bootstrap[4..end])
                .map_err(|_| NetworkError::new("CHANNEL_HELLO_MISMATCH"))?;
            validate_business(&value).map_err(protocol_error)?;
            let object = BusinessObject::parse(value).map_err(protocol_error)?;
            sequences
                .incoming
                .observe(object.sequence())
                .map_err(protocol_error)?;
            match object {
                BusinessObject::Hello(hello)
                    if hello.channel_id == self.id
                        && hello.source == self.peer
                        && hello.target == self.local
                        && hello.source_connection_epoch == self.peer_epoch
                        && hello.target_connection_epoch == self.local_epoch =>
                {
                    self.peer_hello = true;
                }
                _ => return Err(NetworkError::new("CHANNEL_HELLO_MISMATCH")),
            }
            let remainder = management.bootstrap[end..].to_vec();
            management.bootstrap.clear();
            self.begin_management_negotiation()?;
            let mut events = Vec::new();
            if !remainder.is_empty() {
                events.extend(self.process_management_plaintext(&remainder)?);
            }
            return Ok(events);
        }
        let events = self.process_management_plaintext(tail)?;
        Ok(events)
    }
    fn begin_management_negotiation(&mut self) -> Result<(), NetworkError> {
        let management = match &self.mode {
            ChannelMode::Management(value) => value,
            ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
        };
        if management.initiator {
            let message = ManagementMessage::Hello {
                protocol: myagents_host_management_protocol::PROTOCOL.into(),
                role: management.role,
                nonce: management.nonce,
            };
            self.write_management_message(message)?;
        }
        Ok(())
    }
    fn process_management_plaintext(
        &mut self,
        plaintext: &[u8],
    ) -> Result<Vec<ManagementEvent>, NetworkError> {
        let frames = match &mut self.mode {
            ChannelMode::Management(value) => {
                value.decoder.push(plaintext).map_err(management_error)?
            }
            ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
        };
        let mut events = Vec::new();
        for frame in frames {
            let (state, role, initiator, expected_nonce) = {
                let management = match &mut self.mode {
                    ChannelMode::Management(value) => value,
                    ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
                };
                if frame.channel_id != management.channel_id {
                    return Err(NetworkError::new("CHANNEL_ID_MISMATCH"));
                }
                if frame.sender_sequence <= management.incoming_sequence {
                    return Err(NetworkError::new("DUPLICATE_OBJECT"));
                }
                management.incoming_sequence = frame.sender_sequence;
                (
                    management.state,
                    management.role,
                    management.initiator,
                    management.nonce,
                )
            };
            match frame.message {
                ManagementMessage::Hello {
                    role: peer_role,
                    nonce,
                    ..
                } if !initiator
                    && state == ManagementState::AwaitHello
                    && role == PeerRole::Host
                    && peer_role == PeerRole::Controller =>
                {
                    self.write_management_message(ManagementMessage::HelloAck {
                        protocol: myagents_host_management_protocol::PROTOCOL.into(),
                        role,
                        nonce,
                    })?;
                    if let ChannelMode::Management(management) = &mut self.mode {
                        management.state = ManagementState::Ready;
                    }
                    if self.ready() {
                        events.push(ManagementEvent::Ready);
                    }
                }
                ManagementMessage::HelloAck {
                    role: peer_role,
                    nonce,
                    ..
                } if initiator
                    && state == ManagementState::AwaitAck
                    && role == PeerRole::Controller
                    && peer_role == PeerRole::Host
                    && nonce == expected_nonce =>
                {
                    if let ChannelMode::Management(management) = &mut self.mode {
                        management.state = ManagementState::Ready;
                    }
                    if self.ready() {
                        events.push(ManagementEvent::Ready);
                    }
                }
                ManagementMessage::Request {
                    request_id,
                    method,
                    params,
                } if state == ManagementState::Ready && role == PeerRole::Host && self.ready() => {
                    events.push(ManagementEvent::Request {
                        request_id,
                        method,
                        params,
                    });
                }
                ManagementMessage::Response { request_id, result }
                    if state == ManagementState::Ready
                        && role == PeerRole::Controller
                        && self.ready() =>
                {
                    events.push(ManagementEvent::Response { request_id, result });
                }
                _ => return Err(NetworkError::new("CHANNEL_MANAGEMENT_HANDSHAKE_MISMATCH")),
            }
        }
        Ok(events)
    }
    fn write_management_message(&mut self, message: ManagementMessage) -> Result<(), NetworkError> {
        let frame = {
            let management = match &mut self.mode {
                ChannelMode::Management(value) => value,
                ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
            };
            management.outgoing_sequence = management
                .outgoing_sequence
                .checked_add(1)
                .filter(|value| *value <= myagents_host_management_protocol::MAX_SAFE_SEQUENCE)
                .ok_or_else(|| NetworkError::new("CHANNEL_SEQUENCE_EXHAUSTED"))?;
            ManagementFrame {
                namespace: myagents_host_management_protocol::NAMESPACE.into(),
                version: myagents_host_management_protocol::VERSION,
                sender_sequence: management.outgoing_sequence,
                channel_id: management.channel_id,
                message,
            }
        };
        let bytes = encode_management(&frame).map_err(management_error)?;
        self.tls.write_plaintext(&bytes)?;
        self.last_activity = Instant::now();
        Ok(())
    }
    pub(crate) fn send_management(
        &mut self,
        message: ManagementMessage,
    ) -> Result<(), NetworkError> {
        if !self.ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        let role = match &self.mode {
            ChannelMode::Management(value) => value.role,
            ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
        };
        if !matches!(
            (role, &message),
            (PeerRole::Controller, ManagementMessage::Request { .. })
                | (PeerRole::Host, ManagementMessage::Response { .. })
        ) {
            return Err(NetworkError::new("CHANNEL_ROLE_MISMATCH"));
        }
        self.write_management_message(message)
    }
    pub(crate) fn finish_management(&mut self) -> Result<(), NetworkError> {
        let management = match &mut self.mode {
            ChannelMode::Management(value) => value,
            ChannelMode::Agent => return Err(NetworkError::new("CHANNEL_MODE_MISMATCH")),
        };
        if !management.bootstrap.is_empty() {
            self.failed = true;
            return Err(NetworkError::new("CHANNEL_TRUNCATED_FRAME"));
        }
        if let Err(error) = management.decoder.finish() {
            self.failed = true;
            return Err(management_error(error));
        }
        if management.state != ManagementState::Ready || !self.ready() {
            self.failed = true;
            return Err(NetworkError::new("CHANNEL_MANAGEMENT_NOT_READY"));
        }
        Ok(())
    }
    fn feed_inner(
        &mut self,
        bytes: &[u8],
        sequences: &mut PairSequences,
    ) -> Result<Vec<BusinessObject>, NetworkError> {
        let plaintext = self.tls.feed(bytes)?;
        self.last_activity = Instant::now();
        if self.tls.verified() && !self.hello_sent {
            let hello = BusinessObject::Hello(ChannelHello {
                version: 1,
                sender_sequence: sequences.next()?,
                channel_id: self.id.clone(),
                source: self.local.clone(),
                target: self.peer.clone(),
                source_connection_epoch: self.local_epoch.clone(),
                target_connection_epoch: self.peer_epoch.clone(),
            });
            self.write_object(&hello)?;
            self.hello_sent = true;
        }
        let mut business = Vec::new();
        for object in self.decoder.push(&plaintext).map_err(protocol_error)? {
            let object = BusinessObject::parse(object).map_err(protocol_error)?;
            sequences
                .incoming
                .observe(object.sequence())
                .map_err(protocol_error)?;
            if !self.peer_hello {
                match object {
                    BusinessObject::Hello(hello)
                        if hello.channel_id == self.id
                            && hello.source == self.peer
                            && hello.target == self.local
                            && hello.source_connection_epoch == self.peer_epoch
                            && hello.target_connection_epoch == self.local_epoch =>
                    {
                        self.peer_hello = true
                    }
                    _ => return Err(NetworkError::new("CHANNEL_HELLO_MISMATCH")),
                }
            } else {
                if !self.ready() || matches!(object, BusinessObject::Hello(_)) {
                    return Err(NetworkError::new("CHANNEL_NOT_READY"));
                }
                if let BusinessObject::Invoke(ref invocation) = object {
                    if invocation.source != self.peer {
                        return Err(NetworkError::new("CHANNEL_SCOPE_MISMATCH"));
                    }
                }
                business.push(object);
            }
        }
        Ok(business)
    }
    pub(crate) fn send(
        &mut self,
        mut object: BusinessObject,
        sequences: &mut PairSequences,
    ) -> Result<(), NetworkError> {
        if matches!(self.mode, ChannelMode::Management(_)) {
            return Err(NetworkError::new("CHANNEL_MODE_MISMATCH"));
        }
        if !self.ready() {
            return Err(NetworkError::new("CHANNEL_NOT_READY"));
        }
        if matches!(object, BusinessObject::Hello(_)) {
            return Err(NetworkError::new("PROTOCOL_INVALID"));
        }
        object.set_sequence(sequences.next()?);
        self.write_object(&object)
    }
    fn write_object(&mut self, object: &BusinessObject) -> Result<(), NetworkError> {
        let value =
            serde_json::to_value(object).map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?;
        let bytes = encode_object(&value).map_err(protocol_error)?;
        self.tls.write_plaintext(&bytes)?;
        self.last_activity = Instant::now();
        Ok(())
    }
    pub(crate) fn drain_frame(&mut self) -> Result<Option<Vec<u8>>, NetworkError> {
        if self.failed {
            return Err(NetworkError::new("CHANNEL_CLOSED"));
        }
        let Some(bytes) = self.tls.drain_chunk()? else {
            return Ok(None);
        };
        Ok(Some(
            encode_tls_frame(&self.id, &bytes).map_err(protocol_error)?,
        ))
    }
    pub(crate) fn buffered_bytes(&self) -> usize {
        self.decoder.buffered_bytes()
            + self.tls.buffered_bytes()
            + match &self.mode {
                ChannelMode::Agent => 0,
                ChannelMode::Management(value) => {
                    value.bootstrap.len() + value.decoder.buffered_len()
                }
            }
    }
}
fn protocol_error(error: myagents_agent_network_protocol::ProtocolError) -> NetworkError {
    NetworkError::cloud(error.0, 400)
}
fn management_error(error: myagents_host_management_protocol::CodecError) -> NetworkError {
    NetworkError::cloud(&error.to_string(), 400)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::crypto::{certificate_fingerprint, tests::Fixture};
    use super::*;
    use myagents_agent_network_protocol::{decode_tls_frame, PeerBinding};
    pub(crate) fn ready_pair() -> (Channel, Channel, PairSequences, PairSequences) {
        let fixture = Fixture::new();
        let scope = |n| DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            principal_id: "account".into(),
            device_id: format!("00000000-0000-0000-0000-{n:012}"),
            key_generation: 1,
        };
        let first = scope(3);
        let second = scope(4);
        let binding = |scope: &DeviceScope, identity: &TlsIdentity, name: &str| {
            VerifiedPeer::fixture(PeerBinding {
                service_id: scope.service_id.clone(),
                environment: scope.environment.clone(),
                principal_id: scope.principal_id.clone(),
                device_id: scope.device_id.clone(),
                key_generation: 1,
                identity_binding_id: "00000000-0000-0000-0000-000000000005".into(),
                certificate_fingerprint: certificate_fingerprint(&identity.certificates[0]),
                san: name.into(),
                certificate: String::new(),
                expires_at: jsonwebtoken::get_current_timestamp() + 3600,
            })
        };
        let id = "00000000-0000-0000-0000-000000000006";
        let mut a = Channel::new(
            id.into(),
            first.clone(),
            second.clone(),
            "00000000-0000-0000-0000-000000000007".into(),
            "00000000-0000-0000-0000-000000000008".into(),
            &fixture.first,
            fixture.roots(),
            &binding(&second, &fixture.second, "second.network.invalid"),
            true,
        )
        .unwrap();
        let mut b = Channel::new(
            id.into(),
            second.clone(),
            first.clone(),
            "00000000-0000-0000-0000-000000000008".into(),
            "00000000-0000-0000-0000-000000000007".into(),
            &fixture.second,
            fixture.roots(),
            &binding(&first, &fixture.first, "first.network.invalid"),
            false,
        )
        .unwrap();
        let mut sa = PairSequences::default();
        let mut sb = PairSequences::default();
        for _ in 0..20 {
            while let Some(frame) = a.drain_frame().unwrap() {
                b.feed(decode_tls_frame(&frame).unwrap().1, &mut sb)
                    .unwrap();
            }
            while let Some(frame) = b.drain_frame().unwrap() {
                a.feed(decode_tls_frame(&frame).unwrap().1, &mut sa)
                    .unwrap();
            }
            if a.crypto_ready() && b.crypto_ready() {
                a.mark_relay_ready().unwrap();
                b.mark_relay_ready().unwrap();
                return (a, b, sa, sb);
            }
        }
        panic!("pair handshake did not complete")
    }

    fn management_pair() -> (Channel, Channel, PairSequences, PairSequences) {
        management_pair_with_tls_initiator(true)
    }

    fn management_pair_with_tls_initiator(
        controller_is_tls_initiator: bool,
    ) -> (Channel, Channel, PairSequences, PairSequences) {
        let fixture = Fixture::new();
        let scope = |n| DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            principal_id: "account".into(),
            device_id: format!("00000000-0000-0000-0000-{n:012}"),
            key_generation: 1,
        };
        let controller = scope(3);
        let host = scope(4);
        let binding = |scope: &DeviceScope, identity: &TlsIdentity, name: &str| {
            VerifiedPeer::fixture(PeerBinding {
                service_id: scope.service_id.clone(),
                environment: scope.environment.clone(),
                principal_id: scope.principal_id.clone(),
                device_id: scope.device_id.clone(),
                key_generation: 1,
                identity_binding_id: "00000000-0000-0000-0000-000000000005".into(),
                certificate_fingerprint: certificate_fingerprint(&identity.certificates[0]),
                san: name.into(),
                certificate: String::new(),
                expires_at: jsonwebtoken::get_current_timestamp() + 3600,
            })
        };
        let channel_id = "00000000-0000-0000-0000-000000000006";
        let controller_epoch = "00000000-0000-0000-0000-000000000007";
        let host_epoch = "00000000-0000-0000-0000-000000000008";
        let a = Channel::new_management(
            channel_id.into(),
            controller.clone(),
            host.clone(),
            controller_epoch.into(),
            host_epoch.into(),
            &fixture.first,
            fixture.roots(),
            &binding(&host, &fixture.second, "second.network.invalid"),
            PeerRole::Controller,
            controller_is_tls_initiator,
        )
        .unwrap();
        let b = Channel::new_management(
            channel_id.into(),
            host.clone(),
            controller.clone(),
            host_epoch.into(),
            controller_epoch.into(),
            &fixture.second,
            fixture.roots(),
            &binding(&controller, &fixture.first, "first.network.invalid"),
            PeerRole::Host,
            !controller_is_tls_initiator,
        )
        .unwrap();
        (a, b, PairSequences::default(), PairSequences::default())
    }

    fn complete_management_handshake(
        a: &mut Channel,
        b: &mut Channel,
        sa: &mut PairSequences,
        sb: &mut PairSequences,
    ) -> Vec<ManagementEvent> {
        let mut events = Vec::new();
        for _ in 0..24 {
            while let Some(frame) = a.drain_frame().unwrap() {
                events.extend(
                    b.feed_management(decode_tls_frame(&frame).unwrap().1, sb)
                        .unwrap(),
                );
            }
            while let Some(frame) = b.drain_frame().unwrap() {
                events.extend(
                    a.feed_management(decode_tls_frame(&frame).unwrap().1, sa)
                        .unwrap(),
                );
            }
            if management_protocol_ready(a) && management_protocol_ready(b) {
                return events;
            }
        }
        panic!("management channel handshake did not complete")
    }

    fn tls_handshake_only(a: &mut Channel, b: &mut Channel) {
        for _ in 0..16 {
            while let Some(bytes) = a.tls.drain_chunk().unwrap() {
                b.tls.feed(&bytes).unwrap();
            }
            while let Some(bytes) = b.tls.drain_chunk().unwrap() {
                a.tls.feed(&bytes).unwrap();
            }
            if a.tls.verified() && b.tls.verified() {
                return;
            }
        }
        panic!("TLS handshake did not complete")
    }

    fn management_protocol_ready(channel: &Channel) -> bool {
        matches!(
            &channel.mode,
            ChannelMode::Management(value) if value.state == ManagementState::Ready
        )
    }

    fn inject_coalesced_agent_and_management(
        a: &mut Channel,
        b: &mut Channel,
        sequences_a: &mut PairSequences,
        sequences_b: &mut PairSequences,
        management: ManagementFrame,
    ) -> Result<Vec<ManagementEvent>, NetworkError> {
        let hello = BusinessObject::Hello(ChannelHello {
            version: 1,
            sender_sequence: sequences_a.next()?,
            channel_id: a.id.clone(),
            source: a.local.clone(),
            target: a.peer.clone(),
            source_connection_epoch: a.local_epoch.clone(),
            target_connection_epoch: a.peer_epoch.clone(),
        });
        let mut plaintext = encode_object(&serde_json::to_value(hello).unwrap()).unwrap();
        plaintext.extend(encode_management(&management).unwrap());
        a.tls.write_plaintext(&plaintext)?;
        let frame = a
            .drain_frame()?
            .ok_or_else(|| NetworkError::new("CHANNEL_NOT_READY"))?;
        b.feed_management(decode_tls_frame(&frame).unwrap().1, sequences_b)
    }

    #[allow(dead_code)]
    mod legacy_codec {
        include!("../../host-management-protocol/tests/fixtures/legacy_v1.rs");
    }
    #[test]
    fn old_codec_rejects_capability_probe_only_after_complete_tls_ready() {
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(controller.ready() && host.ready());
        controller
            .send_management(ManagementMessage::Request {
                request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                method: myagents_host_management_protocol::ManagementMethod::HostCapabilities,
                params: RequestParams::Snapshot(
                    myagents_host_management_protocol::SnapshotParams {},
                ),
            })
            .unwrap();
        let mut old = legacy_codec::FrameDecoder::default();
        let mut rejected = false;
        while let Some(frame) = controller.drain_frame().unwrap() {
            // Actual authenticated TLS plaintext is handed to the frozen old codec.
            let plaintext = host.tls.feed(decode_tls_frame(&frame).unwrap().1).unwrap();
            if old.push(&plaintext).is_err() {
                rejected = true;
            }
        }
        assert!(rejected);
        assert!(
            controller.ready(),
            "peer rejection concerns this management channel, not TLS/account identity"
        );
        // Old closed codec still accepts the fallback snapshot shape.
        let snapshot = legacy_codec::Frame {
            namespace: legacy_codec::NAMESPACE.into(),
            version: 1,
            sender_sequence: 1,
            channel_id: legacy_codec::CanonicalUuid::new(uuid::Uuid::new_v4()),
            message: legacy_codec::ManagementMessage::Request {
                request_id: legacy_codec::CanonicalUuid::new(uuid::Uuid::new_v4()),
                method: legacy_codec::ManagementMethod::HostSnapshot,
                params: legacy_codec::RequestParams::Snapshot(legacy_codec::SnapshotParams {}),
            },
        };
        assert!(legacy_codec::encode_frame(&snapshot).is_ok());
    }

    #[test]
    fn management_tls_channel_negotiates_then_routes_only_typed_management() {
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        assert!(controller
            .send_management(ManagementMessage::Request {
                request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
                params: RequestParams::Snapshot(
                    myagents_host_management_protocol::SnapshotParams {},
                ),
            })
            .is_err());
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        let events = complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(controller.ready() && host.ready());
        assert!(events
            .iter()
            .any(|event| matches!(event, ManagementEvent::Ready)));

        let request_id = CanonicalUuid::new(uuid::Uuid::new_v4());
        controller
            .send_management(ManagementMessage::Request {
                request_id,
                method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
                params: RequestParams::Snapshot(
                    myagents_host_management_protocol::SnapshotParams {},
                ),
            })
            .unwrap();
        let mut requests = Vec::new();
        while let Some(frame) = controller.drain_frame().unwrap() {
            requests.extend(
                host.feed_management(decode_tls_frame(&frame).unwrap().1, &mut sh)
                    .unwrap(),
            );
        }
        assert!(matches!(
            requests.as_slice(),
            [ManagementEvent::Request { request_id: got, .. }] if *got == request_id
        ));
        host.send_management(ManagementMessage::Response {
            request_id,
            result: ResponseResult::Error {
                code: "NOT_FOUND".into(),
            },
        })
        .unwrap();
        let mut responses = Vec::new();
        while let Some(frame) = host.drain_frame().unwrap() {
            responses.extend(
                controller
                    .feed_management(decode_tls_frame(&frame).unwrap().1, &mut sc)
                    .unwrap(),
            );
        }
        assert!(matches!(
            responses.as_slice(),
            [ManagementEvent::Response { request_id: got, result: ResponseResult::Error { code } }]
                if *got == request_id && code == "NOT_FOUND"
        ));
        assert!(host
            .send_management(ManagementMessage::Request {
                request_id,
                method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
                params: RequestParams::Snapshot(
                    myagents_host_management_protocol::SnapshotParams {},
                ),
            })
            .is_err());
    }

    #[test]
    fn legacy_default_channel_still_delivers_agent_business_objects() {
        let (mut controller, mut host, mut sc, mut sh) = ready_pair();
        assert!(controller.ready() && host.ready());
        let value = serde_json::json!({
            "version": 1,
            "kind": "return-ack",
            "opId": uuid::Uuid::new_v4().to_string(),
            "senderSequence": 999,
            "returnRouteId": uuid::Uuid::new_v4().to_string(),
            "eventId": uuid::Uuid::new_v4().to_string(),
            "settlement": "delivered"
        });
        controller
            .send(BusinessObject::parse(value).unwrap(), &mut sc)
            .unwrap();
        let mut received = Vec::new();
        while let Some(frame) = controller.drain_frame().unwrap() {
            received.extend(
                host.feed(decode_tls_frame(&frame).unwrap().1, &mut sh)
                    .unwrap(),
            );
        }
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].sequence(), 2);
    }

    #[test]
    fn coalesced_agent_hello_and_management_hello_use_same_verified_tls_channel() {
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        // Complete TLS only; then send AgentNet Hello and management Hello as
        // two length-prefixed objects in one encrypted application write.
        tls_handshake_only(&mut controller, &mut host);
        let nonce = match &controller.mode {
            ChannelMode::Management(value) => value.nonce,
            ChannelMode::Agent => panic!("wrong channel mode"),
        };
        let management_hello = ManagementFrame {
            namespace: myagents_host_management_protocol::NAMESPACE.into(),
            version: myagents_host_management_protocol::VERSION,
            sender_sequence: 1,
            channel_id: CanonicalUuid::parse(&controller.id).unwrap(),
            message: ManagementMessage::Hello {
                protocol: myagents_host_management_protocol::PROTOCOL.into(),
                role: PeerRole::Controller,
                nonce,
            },
        };
        let first_events = inject_coalesced_agent_and_management(
            &mut controller,
            &mut host,
            &mut sc,
            &mut sh,
            management_hello,
        )
        .unwrap();
        assert!(!first_events
            .iter()
            .any(|event| matches!(event, ManagementEvent::Ready)));

        for _ in 0..12 {
            while let Some(frame) = controller.drain_frame().unwrap() {
                host.feed_management(decode_tls_frame(&frame).unwrap().1, &mut sh)
                    .unwrap();
            }
            while let Some(frame) = host.drain_frame().unwrap() {
                controller
                    .feed_management(decode_tls_frame(&frame).unwrap().1, &mut sc)
                    .unwrap();
            }
            if management_protocol_ready(&controller) && management_protocol_ready(&host) {
                break;
            }
        }
        assert!(management_protocol_ready(&controller) && management_protocol_ready(&host));
        assert!(!controller.ready() && !host.ready());
        controller.mark_relay_ready().unwrap();
        host.mark_relay_ready().unwrap();
        assert!(controller.ready() && host.ready());
    }

    #[test]
    fn management_rejects_wrong_role_channel_and_replayed_sequence() {
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        let request_id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let request = ManagementMessage::Request {
            request_id,
            method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
            params: RequestParams::Snapshot(myagents_host_management_protocol::SnapshotParams {}),
        };
        let payload = encode_management(&ManagementFrame {
            namespace: myagents_host_management_protocol::NAMESPACE.into(),
            version: myagents_host_management_protocol::VERSION,
            sender_sequence: 2,
            channel_id: CanonicalUuid::parse(&controller.id).unwrap(),
            message: request,
        })
        .unwrap();
        controller.tls.write_plaintext(&payload).unwrap();
        let frame = controller.drain_frame().unwrap().unwrap();
        let packet = decode_tls_frame(&frame).unwrap().1.to_vec();
        assert!(matches!(
            host.feed_management(&packet, &mut sh).unwrap().as_slice(),
            [ManagementEvent::Request { .. }]
        ));
        controller.tls.write_plaintext(&payload).unwrap();
        let replay = controller.drain_frame().unwrap().unwrap();
        let replay = decode_tls_frame(&replay).unwrap().1.to_vec();
        assert_eq!(
            host.feed_management(&replay, &mut sh).unwrap_err().code,
            "DUPLICATE_OBJECT"
        );

        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(controller
            .send_management(ManagementMessage::Response {
                request_id,
                result: ResponseResult::Error {
                    code: "NOT_FOUND".into()
                },
            })
            .is_err());

        for (role, use_wrong_channel, send_request) in [
            (PeerRole::Host, false, false),
            (PeerRole::Controller, true, false),
            (PeerRole::Controller, false, true),
        ] {
            let (mut controller, mut host, mut sc, mut sh) = management_pair();
            tls_handshake_only(&mut controller, &mut host);
            let channel_id = if use_wrong_channel {
                CanonicalUuid::new(uuid::Uuid::new_v4())
            } else {
                CanonicalUuid::parse(&controller.id).unwrap()
            };
            let nonce = match &controller.mode {
                ChannelMode::Management(value) => value.nonce,
                ChannelMode::Agent => panic!("wrong channel mode"),
            };
            let message = if send_request {
                ManagementMessage::Request {
                    request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                    method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
                    params: RequestParams::Snapshot(
                        myagents_host_management_protocol::SnapshotParams {},
                    ),
                }
            } else {
                ManagementMessage::Hello {
                    protocol: myagents_host_management_protocol::PROTOCOL.into(),
                    role,
                    nonce,
                }
            };
            let result = inject_coalesced_agent_and_management(
                &mut controller,
                &mut host,
                &mut sc,
                &mut sh,
                ManagementFrame {
                    namespace: myagents_host_management_protocol::NAMESPACE.into(),
                    version: myagents_host_management_protocol::VERSION,
                    sender_sequence: 1,
                    channel_id,
                    message,
                },
            );
            assert!(result.is_err());
        }
    }

    fn establish_management_outer_ready(
        controller: &mut Channel,
        host: &mut Channel,
        sc: &mut PairSequences,
        sh: &mut PairSequences,
    ) {
        for _ in 0..24 {
            while let Some(frame) = controller.drain_frame().unwrap() {
                host.feed_management(decode_tls_frame(&frame).unwrap().1, sh)
                    .unwrap();
            }
            while let Some(frame) = host.drain_frame().unwrap() {
                controller
                    .feed_management(decode_tls_frame(&frame).unwrap().1, sc)
                    .unwrap();
            }
            if controller.crypto_ready() && host.crypto_ready() {
                controller.mark_relay_ready().unwrap();
                host.mark_relay_ready().unwrap();
                return;
            }
        }
        panic!("outer management channel did not become ready");
    }

    #[test]
    fn management_business_readiness_requires_outer_and_management_gates_in_either_order() {
        // Outer relay readiness arrives first: protocol Hello/Ack completes the
        // conjunction and emits Ready only then.
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        let events = complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(controller.ready() && host.ready());
        assert!(events
            .iter()
            .any(|event| matches!(event, ManagementEvent::Ready)));

        // Protocol readiness arrives first: no business Ready or delivery until
        // the original outer relay gate is satisfied.
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        assert!(controller.mark_relay_ready().is_err());
        assert!(host.mark_relay_ready().is_err());
        let protocol_events =
            complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(!controller.ready() && !host.ready());
        assert!(!protocol_events
            .iter()
            .any(|event| matches!(event, ManagementEvent::Ready)));
        assert!(controller
            .send_management(ManagementMessage::Request {
                request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
                params: RequestParams::Snapshot(
                    myagents_host_management_protocol::SnapshotParams {},
                ),
            })
            .is_err());

        let blocked = ManagementFrame {
            namespace: myagents_host_management_protocol::NAMESPACE.into(),
            version: myagents_host_management_protocol::VERSION,
            sender_sequence: 2,
            channel_id: CanonicalUuid::parse(&controller.id).unwrap(),
            message: ManagementMessage::Request {
                request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                method: myagents_host_management_protocol::ManagementMethod::HostSnapshot,
                params: RequestParams::Snapshot(
                    myagents_host_management_protocol::SnapshotParams {},
                ),
            },
        };
        controller
            .write_management_message(blocked.message)
            .unwrap();
        let frame = controller.drain_frame().unwrap().unwrap();
        assert!(host
            .feed_management(decode_tls_frame(&frame).unwrap().1, &mut sh)
            .is_err());

        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        host.write_management_message(ManagementMessage::Response {
            request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            result: ResponseResult::Error {
                code: "NOT_FOUND".into(),
            },
        })
        .unwrap();
        let frame = host.drain_frame().unwrap().unwrap();
        assert!(controller
            .feed_management(decode_tls_frame(&frame).unwrap().1, &mut sc)
            .is_err());

        // On a fresh channel, outer readiness after protocol readiness completes
        // the gate. Callers can observe this via Channel::ready().
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(controller.ready() && host.ready());

        // Application roles are independent of which TLS endpoint initiates.
        let (mut controller, mut host, mut sc, mut sh) = management_pair_with_tls_initiator(false);
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        assert!(controller.ready() && host.ready());
    }

    #[test]
    fn management_eof_rejects_partial_frame_and_closes_channel() {
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        establish_management_outer_ready(&mut controller, &mut host, &mut sc, &mut sh);
        complete_management_handshake(&mut controller, &mut host, &mut sc, &mut sh);
        controller.tls.write_plaintext(&[0, 0]).unwrap();
        let partial = controller.drain_frame().unwrap().unwrap();
        host.feed_management(decode_tls_frame(&partial).unwrap().1, &mut sh)
            .unwrap();
        assert_eq!(host.finish_management().unwrap_err().code, "INVALID_LENGTH");
        assert_eq!(
            host.feed_management(&[], &mut sh).unwrap_err().code,
            "CHANNEL_CLOSED"
        );
    }

    #[test]
    fn management_ack_with_wrong_nonce_is_rejected() {
        let (mut controller, mut host, mut sc, mut sh) = management_pair();
        tls_handshake_only(&mut controller, &mut host);
        let hello = BusinessObject::Hello(ChannelHello {
            version: 1,
            sender_sequence: sh.next().unwrap(),
            channel_id: host.id.clone(),
            source: host.local.clone(),
            target: host.peer.clone(),
            source_connection_epoch: host.local_epoch.clone(),
            target_connection_epoch: host.peer_epoch.clone(),
        });
        let plaintext = encode_object(&serde_json::to_value(hello).unwrap()).unwrap();
        host.tls.write_plaintext(&plaintext).unwrap();
        let hello_frame = host.drain_frame().unwrap().unwrap();
        controller
            .feed_management(decode_tls_frame(&hello_frame).unwrap().1, &mut sc)
            .unwrap();
        let wrong_nonce_ack = ManagementFrame {
            namespace: myagents_host_management_protocol::NAMESPACE.into(),
            version: myagents_host_management_protocol::VERSION,
            sender_sequence: 1,
            channel_id: CanonicalUuid::parse(&controller.id).unwrap(),
            message: ManagementMessage::HelloAck {
                protocol: myagents_host_management_protocol::PROTOCOL.into(),
                role: PeerRole::Host,
                nonce: CanonicalUuid::new(uuid::Uuid::new_v4()),
            },
        };
        host.tls
            .write_plaintext(&encode_management(&wrong_nonce_ack).unwrap())
            .unwrap();
        let ack_frame = host.drain_frame().unwrap().unwrap();
        assert_eq!(
            controller
                .feed_management(decode_tls_frame(&ack_frame).unwrap().1, &mut sc)
                .unwrap_err()
                .code,
            "CHANNEL_MANAGEMENT_HANDSHAKE_MISMATCH"
        );
    }
}
