//! Fixed 1.1 device-level opaque relay state machine.
//!
//! This crate does not perform socket I/O, decrypt TLS, parse AgentNet business
//! frames, or authorize operations. The parent service must revalidate the
//! access session and current device/membership state before constructing the
//! trusted snapshots consumed here.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use myagents_agent_network_protocol::{
    budget, decode_tls_frame, validate_control, validate_server_control, DeviceScope,
};
use myagents_agentnet_admission_core::ValidatedAccess;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use thiserror::Error;
use uuid::Uuid;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub struct RelayConfig {
    pub service_id: String,
    pub issuer: String,
    pub environment: String,
    pub network_id: String,
    /// Pinned issuer JWKS. Relay never fetches keys or follows token URLs.
    pub peer_jwks: Value,
}

/// A synchronously read projection from the parent AuthStore/DeviceStore and
/// authoritative membership state. Its values are inputs from a trusted local
/// caller, not evidence the relay can independently establish as live.
#[derive(Clone)]
pub struct TrustedLiveSnapshot {
    pub scope: DeviceScope,
    pub session_handle: String,
    pub session_expires_at: i64,
    /// SHA-256(SPKI DER), matched to the DPoP-bound current device key.
    pub current_key_fingerprint: String,
    /// SHA-256 certificate fingerprint, matched to the signed peer binding.
    pub current_certificate_fingerprint: String,
    pub current_identity_binding_id: String,
    pub joined: bool,
    pub network_revision: u64,
    pub membership_revision: u64,
}

impl std::fmt::Debug for TrustedLiveSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustedLiveSnapshot")
            .field("scope", &scope_id(&self.scope))
            .field("session_handle", &"[redacted]")
            .field("session_expires_at", &self.session_expires_at)
            .field("joined", &self.joined)
            .field("network_revision", &self.network_revision)
            .field("membership_revision", &self.membership_revision)
            .finish()
    }
}

pub struct AuthorizedDevice {
    scope: DeviceScope,
    session_handle: String,
    expires_at: i64,
    key_fingerprint: String,
    certificate_fingerprint: String,
    binding_id: String,
    membership_revision: u64,
    network_revision: u64,
    signed_binding: String,
}

impl std::fmt::Debug for AuthorizedDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorizedDevice")
            .field("scope", &scope_id(&self.scope))
            .field("session_handle", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .field("membership_revision", &self.membership_revision)
            .finish()
    }
}

impl AuthorizedDevice {
    pub fn scope(&self) -> &DeviceScope {
        &self.scope
    }
    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }
    pub fn current_key_fingerprint(&self) -> &str {
        &self.key_fingerprint
    }
    pub fn membership_revision(&self) -> u64 {
        self.membership_revision
    }
}

/// One-time evidence from the parent catalog/policy owner. The caller must
/// create it only after durable catalog ACK and current relay policy checks.
#[derive(Clone)]
pub struct TrustedReadyEvidence {
    pub scope: DeviceScope,
    pub connection_epoch: String,
    pub catalog_sequence: u64,
    pub acknowledged_sequence: u64,
    pub membership_revision: u64,
    pub policy_allows_relay: bool,
}

impl std::fmt::Debug for TrustedReadyEvidence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustedReadyEvidence")
            .field("scope", &scope_id(&self.scope))
            .field("connection_epoch", &self.connection_epoch)
            .field("catalog_sequence", &self.catalog_sequence)
            .field("acknowledged_sequence", &self.acknowledged_sequence)
            .field("membership_revision", &self.membership_revision)
            .field("policy_allows_relay", &self.policy_allows_relay)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct ReadyProof {
    connection_id: String,
    connection_epoch: String,
    catalog_sequence: u64,
    session_handle: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RelayError {
    #[error("relay configuration is invalid")]
    Configuration,
    #[error("device authorization is invalid")]
    Unauthorized,
    #[error("connection is missing, stale, or not ready")]
    Connection,
    #[error("control frame is invalid")]
    Control,
    #[error("control replay or sequence violation")]
    Replay,
    #[error("relay capacity exceeded")]
    Capacity,
    #[error("channel state or scope is invalid")]
    Channel,
    #[error("opaque frame is invalid")]
    Frame,
    #[error("credit is invalid")]
    Credit,
    #[error("relay state is unavailable")]
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// A validated, fixed-schema 1.1 server control, addressed to one current
    /// connection. The adapter must still perform bounded socket delivery.
    Control {
        target_connection_id: String,
        json: Value,
    },
    /// Opaque TLS frame, unchanged byte-for-byte and addressed to one peer.
    OpaqueFrame {
        target_connection_id: String,
        bytes: Vec<u8>,
    },
    Close {
        target_connection_id: String,
        channel_id: String,
        reason: &'static str,
    },
}

struct Connection {
    device: AuthorizedDevice,
    connection_epoch: String,
    ready: bool,
    control_ids: HashSet<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChannelState {
    Offered,
    Accepted,
    Ready,
}

struct Channel {
    id: String,
    initiator: String,
    responder: String,
    initiator_scope: DeviceScope,
    responder_scope: DeviceScope,
    initiator_epoch: String,
    responder_epoch: String,
    initiator_binding: String,
    responder_binding: String,
    initiator_accepted: bool,
    responder_accepted: bool,
    initiator_ready: bool,
    responder_ready: bool,
    created_at_ms: i64,
    last_activity_ms: i64,
    state: ChannelState,
    forward: Direction,
    reverse: Direction,
}

#[derive(Default)]
struct Direction {
    sent: u64,
    returned: u64,
    return_sequence: u64,
}

pub struct RelayCore {
    config: RelayConfig,
    boot_epoch: String,
    connections: HashMap<String, Connection>,
    channels: HashMap<String, Channel>,
}

impl RelayCore {
    pub fn new(config: RelayConfig) -> Result<Self, RelayError> {
        let jwks_bytes =
            serde_json::to_vec(&config.peer_jwks).map_err(|_| RelayError::Configuration)?;
        if !canonical_uuid(&config.service_id)
            || !canonical_uuid(&config.network_id)
            || !matches!(config.environment.as_str(), "production" | "development")
            || !is_https_issuer(&config.issuer)
            || jwks_bytes.len() > budget("relayMetadataBytes")
            || parse_jwks(&config.peer_jwks).is_err()
        {
            return Err(RelayError::Configuration);
        }
        Ok(Self {
            config,
            boot_epoch: Uuid::new_v4().to_string(),
            connections: HashMap::new(),
            channels: HashMap::new(),
        })
    }

    /// Construct relay authority only after the parent has revalidated the
    /// bearer session and synchronously read the current device/membership row.
    /// The peer JWT itself is verified here against the pinned issuer keys.
    pub fn authorize_device(
        &self,
        access: &ValidatedAccess,
        snapshot: TrustedLiveSnapshot,
        signed_peer_binding: &str,
        now_unix: i64,
    ) -> Result<AuthorizedDevice, RelayError> {
        let scope = &snapshot.scope;
        if !snapshot.joined
            || snapshot.network_revision > MAX_SAFE_INTEGER
            || scope.service_id != self.config.service_id
            || scope.environment != self.config.environment
            || scope.network_id != self.config.network_id
            || scope.principal_id != access.principal_id()
            || scope.device_id != access.device_id()
            || scope.key_generation != access.key_generation()
            || access.service_id() != self.config.service_id
            || access.environment() != self.config.environment
            || access.issuer_origin() != self.config.issuer
            || access.issuer_network_id() != self.config.network_id
            || snapshot.session_handle != access.session_handle()
            || snapshot.current_key_fingerprint != access.public_key_fingerprint()
            || snapshot.current_certificate_fingerprint.is_empty()
            || snapshot.session_expires_at <= now_unix
            || access.expires_at() <= now_unix
            || signed_peer_binding.is_empty()
            || signed_peer_binding.len() > 32_768
            || snapshot.current_identity_binding_id.is_empty()
        {
            return Err(RelayError::Unauthorized);
        }
        let peer_expires_at = verify_peer_binding(
            &self.config,
            scope,
            &snapshot.current_certificate_fingerprint,
            &snapshot.current_identity_binding_id,
            signed_peer_binding,
            now_unix,
        )?;
        Ok(AuthorizedDevice {
            scope: scope.clone(),
            session_handle: snapshot.session_handle,
            expires_at: access
                .expires_at()
                .min(snapshot.session_expires_at)
                .min(peer_expires_at),
            key_fingerprint: snapshot.current_key_fingerprint,
            certificate_fingerprint: snapshot.current_certificate_fingerprint,
            binding_id: snapshot.current_identity_binding_id,
            membership_revision: snapshot.membership_revision,
            network_revision: snapshot.network_revision,
            signed_binding: signed_peer_binding.to_owned(),
        })
    }

    /// Register an already-authorized device connection. Epoch, nonce and
    /// connection ID are server-generated; a new connection replaces only the
    /// previous socket for this device scope.
    pub fn connect(
        &mut self,
        device: AuthorizedDevice,
        now_unix: i64,
    ) -> Result<(String, Vec<Effect>), RelayError> {
        if device.expires_at <= now_unix {
            return Err(RelayError::Unauthorized);
        }
        let connection_id = Uuid::new_v4().to_string();
        let connection_epoch = Uuid::new_v4().to_string();
        let connector_nonce = Uuid::new_v4().to_string();
        let replaced: Vec<String> = self
            .connections
            .iter()
            .filter(|(_, value)| value.device.scope.device_id == device.scope.device_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = Vec::new();
        for old in replaced {
            effects.extend(self.drop_connection(&old, "connection-replaced"));
        }
        if self.connections.len() >= budget("pending") {
            return Err(RelayError::Capacity);
        }
        let hello = json!({
            "version": 1,
            "controlId": Uuid::new_v4().to_string(),
            "type": "hello.result",
            "serviceId": device.scope.service_id,
            "networkId": device.scope.network_id,
            "bootEpoch": self.boot_epoch,
            "connectionEpoch": connection_epoch,
            "identity": device.scope,
            "networkRevision": device.network_revision,
            "membershipRevision": device.membership_revision,
            "connectorNonce": connector_nonce,
        });
        effects.push(control_effect(&connection_id, hello)?);
        self.connections.insert(
            connection_id.clone(),
            Connection {
                device,
                connection_epoch,
                ready: false,
                control_ids: HashSet::new(),
            },
        );
        Ok((connection_id, effects))
    }

    /// Mint ready evidence only after the parent catalog owner has verified
    /// durable ACK and current policy. `TrustedReadyEvidence` is an integration
    /// boundary, not a proof independently verifiable by this crate.
    pub fn ready_proof(
        &self,
        connection_id: &str,
        evidence: TrustedReadyEvidence,
        now_unix: i64,
    ) -> Result<ReadyProof, RelayError> {
        let connection = self.live_connection(connection_id, now_unix)?;
        if evidence.scope != connection.device.scope
            || evidence.connection_epoch != connection.connection_epoch
            || evidence.catalog_sequence == 0
            || evidence.catalog_sequence != evidence.acknowledged_sequence
            || evidence.membership_revision != connection.device.membership_revision
            || !evidence.policy_allows_relay
            || evidence.catalog_sequence > MAX_SAFE_INTEGER
        {
            return Err(RelayError::Unauthorized);
        }
        Ok(ReadyProof {
            connection_id: connection_id.to_owned(),
            connection_epoch: connection.connection_epoch.clone(),
            catalog_sequence: evidence.catalog_sequence,
            session_handle: connection.device.session_handle.clone(),
        })
    }

    /// Apply one bounded fixed 1.1 client control. `now_ms` is trusted
    /// monotonic time sampled after the owner lock. A Ready control requires a
    /// matching ReadyProof; all other controls reject unexpected proof values.
    pub fn handle_control(
        &mut self,
        connection_id: &str,
        bytes: &[u8],
        ready_proof: Option<ReadyProof>,
        now_unix: i64,
        now_ms: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        if bytes.len() > budget("controlBytes") {
            return Err(RelayError::Control);
        }
        let value: Value = serde_json::from_slice(bytes).map_err(|_| RelayError::Control)?;
        validate_control(&value).map_err(|_| RelayError::Control)?;
        let kind = value["type"].as_str().ok_or(RelayError::Control)?;
        let control_id = value["controlId"].as_str().ok_or(RelayError::Control)?;
        let scope = self.control_scope(&value)?;
        let connection = self.live_connection(connection_id, now_unix)?;
        if !scope_matches_connection(&scope, connection, &self.boot_epoch) {
            return Err(RelayError::Connection);
        }
        if connection.control_ids.contains(control_id) {
            return Err(RelayError::Replay);
        }
        if connection.control_ids.len() >= budget("relayMetadataBytes") / 1024 {
            return Err(RelayError::Capacity);
        }
        let replay_entries: usize = self
            .connections
            .values()
            .map(|value| value.control_ids.len())
            .sum();
        if replay_entries >= budget("relayMetadataBytes") / 256 {
            return Err(RelayError::Capacity);
        }
        self.connections
            .get_mut(connection_id)
            .ok_or(RelayError::Connection)?
            .control_ids
            .insert(control_id.to_owned());

        match kind {
            "ready" => self.handle_ready(connection_id, &value, ready_proof, now_unix),
            _ if ready_proof.is_some() => Err(RelayError::Control),
            "channel.open" => self.open_channel(connection_id, &value, now_unix, now_ms),
            "channel.accept" => self.accept_channel(connection_id, &value, now_unix, now_ms),
            "channel.ready" => self.channel_ready(connection_id, &value, now_unix, now_ms),
            "channel.close" => self.close_channel(connection_id, &value, now_unix),
            "credit.release" => self.release_credit(connection_id, &value, now_unix, now_ms),
            "auth.refresh" => Err(RelayError::Unauthorized),
            _ => Ok(vec![unsupported_effect(connection_id, control_id)?]),
        }
    }

    /// Forward one complete TLS frame without inspecting or changing its
    /// encrypted payload. `now_ms` is trusted monotonic time sampled after the
    /// owner lock; callers must already have enforced fresh session validation
    /// and this method independently checks stored expiry.
    pub fn forward_frame(
        &mut self,
        connection_id: &str,
        bytes: &[u8],
        now_unix: i64,
        now_ms: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        let (channel_id, _) = decode_tls_frame(bytes).map_err(|_| RelayError::Frame)?;
        let channel = self.channels.get(&channel_id).ok_or(RelayError::Channel)?;
        if channel.state == ChannelState::Offered
            || (channel.state == ChannelState::Accepted
                && now_ms.saturating_sub(channel.created_at_ms) > budget("handshakeMs") as i64)
        {
            return Err(RelayError::Channel);
        }
        self.live_connection(connection_id, now_unix)?;
        let (target, sent, returned, forward) = if connection_id == channel.initiator {
            (
                channel.responder.clone(),
                channel.forward.sent,
                channel.forward.returned,
                true,
            )
        } else if connection_id == channel.responder {
            (
                channel.initiator.clone(),
                channel.reverse.sent,
                channel.reverse.returned,
                false,
            )
        } else {
            return Err(RelayError::Channel);
        };
        self.live_connection(&target, now_unix)?;
        let amount = u64::try_from(bytes.len()).map_err(|_| RelayError::Frame)?;
        let next_sent = sent
            .checked_add(amount)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or(RelayError::Credit)?;
        if next_sent.saturating_sub(returned) > budget("channelQueueBytes") as u64 {
            return Err(RelayError::Capacity);
        }
        let socket_queued: u64 = self
            .channels
            .values()
            .map(|value| {
                let to_initiator = if value.initiator == target {
                    value.reverse.sent.saturating_sub(value.reverse.returned)
                } else {
                    0
                };
                let to_responder = if value.responder == target {
                    value.forward.sent.saturating_sub(value.forward.returned)
                } else {
                    0
                };
                to_initiator + to_responder
            })
            .sum();
        if socket_queued.saturating_add(amount) > budget("socketQueueBytes") as u64 {
            return Err(RelayError::Capacity);
        }
        let channel = self
            .channels
            .get_mut(&channel_id)
            .ok_or(RelayError::Channel)?;
        if forward {
            channel.forward.sent = next_sent;
        } else {
            channel.reverse.sent = next_sent;
        }
        channel.last_activity_ms = now_ms;
        Ok(vec![Effect::OpaqueFrame {
            target_connection_id: target,
            bytes: bytes.to_vec(),
        }])
    }

    /// Invalidate all sessions and channel pairs for one device after the
    /// parent detects revocation, key rotation, or membership removal.
    pub fn invalidate_device(&mut self, device_id: &str) -> Vec<Effect> {
        let ids: Vec<String> = self
            .connections
            .iter()
            .filter(|(_, connection)| connection.device.scope.device_id == device_id)
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = Vec::new();
        for id in ids {
            effects.extend(self.drop_connection(&id, "device-invalidated"));
        }
        effects
    }

    /// Expire offers after the handshake budget, ready channels after the
    /// fixed idle budget, and sessions whose session or peer binding expired.
    pub fn expire(&mut self, now_unix: i64, now_ms: i64) -> Vec<Effect> {
        let stale_connections: Vec<String> = self
            .connections
            .iter()
            .filter(|(_, connection)| connection.device.expires_at <= now_unix)
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = Vec::new();
        for id in stale_connections {
            effects.extend(self.drop_connection(&id, "session-expired"));
        }
        let timeout = budget("handshakeMs") as i64;
        let idle_timeout = budget("idleChannelMs") as i64;
        let expired: Vec<(String, &'static str)> = self
            .channels
            .iter()
            .filter(|(_, channel)| {
                if channel.state == ChannelState::Ready {
                    now_ms.saturating_sub(channel.last_activity_ms) > idle_timeout
                } else {
                    now_ms.saturating_sub(channel.created_at_ms) > timeout
                }
            })
            .map(|(id, channel)| {
                (
                    id.clone(),
                    if channel.state == ChannelState::Ready {
                        "channel-idle-timeout"
                    } else {
                        "handshake-timeout"
                    },
                )
            })
            .collect();
        for (id, reason) in expired {
            effects.extend(self.remove_channel(&id, reason));
        }
        effects
    }

    fn handle_ready(
        &mut self,
        connection_id: &str,
        value: &Value,
        proof: Option<ReadyProof>,
        now_unix: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        let proof = proof.ok_or(RelayError::Unauthorized)?;
        let connection = self.live_connection(connection_id, now_unix)?;
        if proof.connection_id != connection_id
            || proof.connection_epoch != connection.connection_epoch
            || proof.session_handle != connection.device.session_handle
            || proof.catalog_sequence != value["catalogSeq"].as_u64().ok_or(RelayError::Control)?
            || connection.ready
        {
            return Err(RelayError::Unauthorized);
        }
        self.connections.get_mut(connection_id).unwrap().ready = true;
        let current = self
            .connections
            .get(connection_id)
            .ok_or(RelayError::Connection)?;
        let response = json!({
            "version":1,
            "controlId":Uuid::new_v4().to_string(),
            "type":"ready.result",
            "serviceId":self.config.service_id,
            "networkId":self.config.network_id,
            "bootEpoch":self.boot_epoch,
            "connectionEpoch":current.connection_epoch,
            "catalogSeq":proof.catalog_sequence,
        });
        Ok(vec![control_effect(connection_id, response)?])
    }

    fn open_channel(
        &mut self,
        connection_id: &str,
        value: &Value,
        now_unix: i64,
        now_ms: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        let initiator = self.live_connection(connection_id, now_unix)?;
        if !initiator.ready || self.channels.len() >= budget("channels") {
            return Err(RelayError::Connection);
        }
        if self
            .channels
            .values()
            .filter(|channel| channel.state != ChannelState::Ready)
            .count()
            >= budget("handshakes")
        {
            return Err(RelayError::Capacity);
        }
        let target_device = value["targetDeviceId"]
            .as_str()
            .ok_or(RelayError::Control)?;
        let target_generation = value["targetKeyGeneration"]
            .as_u64()
            .ok_or(RelayError::Control)?;
        let target_epoch = value["targetConnectionEpoch"]
            .as_str()
            .ok_or(RelayError::Control)?;
        let target_id = self
            .connections
            .iter()
            .find(|(_, connection)| {
                connection.device.scope.device_id == target_device
                    && connection.device.scope.key_generation == target_generation
                    && connection.connection_epoch == target_epoch
                    && connection.ready
            })
            .map(|(id, _)| id.clone())
            .ok_or(RelayError::Connection)?;
        let responder = self.live_connection(&target_id, now_unix)?;
        if !same_principal_network(&initiator.device.scope, &responder.device.scope)
            || initiator.device.scope.device_id == responder.device.scope.device_id
            || pair_key(&initiator.device.scope, &responder.device.scope).is_some_and(|key| {
                self.channels
                    .values()
                    .any(|channel| channel_pair_key(channel) == key)
            })
        {
            return Err(RelayError::Channel);
        }
        let channel_id = value["channelId"].as_str().ok_or(RelayError::Control)?;
        if self.channels.contains_key(channel_id) {
            return Err(RelayError::Replay);
        }
        let requested_responder_binding = match value["targetBinding"].as_str() {
            Some(binding) => {
                verify_peer_binding(
                    &self.config,
                    &responder.device.scope,
                    &responder.device.certificate_fingerprint,
                    &responder.device.binding_id,
                    binding,
                    now_unix,
                )?;
                Some(binding.to_owned())
            }
            None => None,
        };
        let responder_binding = responder.device.signed_binding.clone();
        if requested_responder_binding
            .as_ref()
            .is_some_and(|binding| binding != &responder_binding)
        {
            return Err(RelayError::Unauthorized);
        }
        let open_scope = initiator.device.scope.clone();
        let target_scope = responder.device.scope.clone();
        let (
            initiator_id,
            responder_id,
            initiator_scope,
            responder_scope,
            initiator_epoch,
            responder_epoch,
            initiator_binding,
            responder_binding,
        ) = if scope_key(&open_scope) < scope_key(&target_scope) {
            (
                connection_id.to_owned(),
                target_id.clone(),
                open_scope,
                target_scope,
                initiator.connection_epoch.clone(),
                responder.connection_epoch.clone(),
                initiator.device.signed_binding.clone(),
                responder.device.signed_binding.clone(),
            )
        } else {
            (
                target_id.clone(),
                connection_id.to_owned(),
                target_scope,
                open_scope,
                responder.connection_epoch.clone(),
                initiator.connection_epoch.clone(),
                responder.device.signed_binding.clone(),
                initiator.device.signed_binding.clone(),
            )
        };
        let offer_for = |connection_epoch: &str| {
            json!({
                "version":1,
                "controlId":Uuid::new_v4().to_string(),
                "type":"channel.offer",
                "serviceId":self.config.service_id,
                "networkId":self.config.network_id,
                "bootEpoch":self.boot_epoch,
                "connectionEpoch":connection_epoch,
                "channelId":channel_id,
                "initiator":initiator_scope,
                "responder":responder_scope,
                "initiatorConnectionEpoch":initiator_epoch,
                "responderConnectionEpoch":responder_epoch,
                "initiatorBinding":initiator_binding,
                "responderBinding":responder_binding,
            })
        };
        let opener_offer = offer_for(&initiator.connection_epoch);
        let target_offer = offer_for(&responder.connection_epoch);
        self.channels.insert(
            channel_id.to_owned(),
            Channel {
                id: channel_id.to_owned(),
                initiator: initiator_id,
                responder: responder_id,
                initiator_scope,
                responder_scope,
                initiator_epoch,
                responder_epoch,
                initiator_binding,
                responder_binding,
                initiator_accepted: false,
                responder_accepted: false,
                initiator_ready: false,
                responder_ready: false,
                created_at_ms: now_ms,
                last_activity_ms: now_ms,
                state: ChannelState::Offered,
                forward: Direction::default(),
                reverse: Direction::default(),
            },
        );
        Ok(vec![
            control_effect(connection_id, opener_offer)?,
            control_effect(&target_id, target_offer)?,
        ])
    }

    fn accept_channel(
        &mut self,
        connection_id: &str,
        value: &Value,
        now_unix: i64,
        now_ms: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        let (accepting_scope, accepting_epoch, accepting_certificate_fp, accepting_binding_id) = {
            let accepting = self.live_connection(connection_id, now_unix)?;
            (
                accepting.device.scope.clone(),
                accepting.connection_epoch.clone(),
                accepting.device.certificate_fingerprint.clone(),
                accepting.device.binding_id.clone(),
            )
        };
        let channel_id = value["channelId"].as_str().ok_or(RelayError::Control)?;
        let binding = value["signedBinding"].as_str().ok_or(RelayError::Control)?;
        let channel = self.channels.get(channel_id).ok_or(RelayError::Channel)?;
        if channel.state != ChannelState::Offered
            || now_ms.saturating_sub(channel.created_at_ms) > budget("handshakeMs") as i64
        {
            return Err(RelayError::Channel);
        }
        let is_initiator = if channel.initiator == connection_id
            && channel.initiator_epoch == accepting_epoch
            && channel.initiator_scope == accepting_scope
        {
            if channel.initiator_accepted {
                return Err(RelayError::Replay);
            }
            true
        } else if channel.responder == connection_id
            && channel.responder_epoch == accepting_epoch
            && channel.responder_scope == accepting_scope
        {
            if channel.responder_accepted {
                return Err(RelayError::Replay);
            }
            false
        } else {
            return Err(RelayError::Channel);
        };
        let expected_binding = if is_initiator {
            &channel.initiator_binding
        } else {
            &channel.responder_binding
        };
        if binding != expected_binding {
            return Err(RelayError::Unauthorized);
        }
        verify_peer_binding(
            &self.config,
            &accepting_scope,
            &accepting_certificate_fp,
            &accepting_binding_id,
            binding,
            now_unix,
        )?;
        let (
            initiator_id,
            responder_id,
            initiator_scope,
            responder_scope,
            initiator_epoch,
            responder_epoch,
            initiator_binding,
            responder_binding,
        ) = (
            channel.initiator.clone(),
            channel.responder.clone(),
            channel.initiator_scope.clone(),
            channel.responder_scope.clone(),
            channel.initiator_epoch.clone(),
            channel.responder_epoch.clone(),
            channel.initiator_binding.clone(),
            channel.responder_binding.clone(),
        );
        for (peer_id, peer_scope, peer_epoch, peer_binding) in [
            (
                &initiator_id,
                &initiator_scope,
                &initiator_epoch,
                &initiator_binding,
            ),
            (
                &responder_id,
                &responder_scope,
                &responder_epoch,
                &responder_binding,
            ),
        ] {
            let peer = self.live_connection(peer_id, now_unix)?;
            if peer.device.scope != *peer_scope || peer.connection_epoch != *peer_epoch {
                return Err(RelayError::Connection);
            }
            verify_peer_binding(
                &self.config,
                peer_scope,
                &peer.device.certificate_fingerprint,
                &peer.device.binding_id,
                peer_binding,
                now_unix,
            )?;
        }
        let channel = self
            .channels
            .get_mut(channel_id)
            .ok_or(RelayError::Channel)?;
        if is_initiator {
            channel.initiator_accepted = true;
        } else {
            channel.responder_accepted = true;
        }
        channel.last_activity_ms = now_ms;
        if !channel.initiator_accepted || !channel.responder_accepted {
            return Ok(Vec::new());
        }
        channel.state = ChannelState::Accepted;
        let channel_id = channel.id.clone();
        let a = json!({"version":1,"controlId":Uuid::new_v4().to_string(),"type":"channel.accepted","serviceId":self.config.service_id,"networkId":self.config.network_id,"bootEpoch":self.boot_epoch,"connectionEpoch":initiator_epoch,"channelId":channel_id,"initiatorBinding":initiator_binding,"responderBinding":responder_binding});
        let b = json!({"version":1,"controlId":Uuid::new_v4().to_string(),"type":"channel.accepted","serviceId":self.config.service_id,"networkId":self.config.network_id,"bootEpoch":self.boot_epoch,"connectionEpoch":responder_epoch,"channelId":channel_id,"initiatorBinding":initiator_binding,"responderBinding":responder_binding});
        Ok(vec![
            control_effect(&initiator_id, a)?,
            control_effect(&responder_id, b)?,
        ])
    }

    fn channel_ready(
        &mut self,
        connection_id: &str,
        value: &Value,
        now_unix: i64,
        now_ms: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        self.live_connection(connection_id, now_unix)?;
        let channel_id = value["channelId"].as_str().ok_or(RelayError::Control)?;
        let channel = self
            .channels
            .get_mut(channel_id)
            .ok_or(RelayError::Channel)?;
        if channel.state != ChannelState::Accepted
            || now_ms.saturating_sub(channel.created_at_ms) > budget("handshakeMs") as i64
        {
            return Err(RelayError::Channel);
        }
        if channel.initiator == connection_id {
            if channel.initiator_ready {
                return Err(RelayError::Replay);
            }
            channel.initiator_ready = true;
        } else if channel.responder == connection_id {
            if channel.responder_ready {
                return Err(RelayError::Replay);
            }
            channel.responder_ready = true;
        } else {
            return Err(RelayError::Channel);
        }
        if channel.initiator_ready && channel.responder_ready {
            channel.state = ChannelState::Ready;
            channel.last_activity_ms = now_ms;
            let a = channel_control(
                &self.config,
                &self.boot_epoch,
                channel,
                &channel.initiator,
                "channel.ready",
            )?;
            let b = channel_control(
                &self.config,
                &self.boot_epoch,
                channel,
                &channel.responder,
                "channel.ready",
            )?;
            Ok(vec![a, b])
        } else {
            channel.last_activity_ms = now_ms;
            Ok(Vec::new())
        }
    }

    fn close_channel(
        &mut self,
        connection_id: &str,
        value: &Value,
        now_unix: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        self.live_connection(connection_id, now_unix)?;
        let channel_id = value["channelId"].as_str().ok_or(RelayError::Control)?;
        if !self.channels.get(channel_id).is_some_and(|channel| {
            channel.initiator == connection_id || channel.responder == connection_id
        }) {
            return Err(RelayError::Channel);
        }
        Ok(self.remove_channel(channel_id, "peer-closed"))
    }

    fn release_credit(
        &mut self,
        connection_id: &str,
        value: &Value,
        now_unix: i64,
        now_ms: i64,
    ) -> Result<Vec<Effect>, RelayError> {
        self.live_connection(connection_id, now_unix)?;
        let channel_id = value["channelId"].as_str().ok_or(RelayError::Control)?;
        let sequence = value["sequence"].as_u64().ok_or(RelayError::Control)?;
        let received = value["receivedBytes"].as_u64().ok_or(RelayError::Control)?;
        let channel = self
            .channels
            .get_mut(channel_id)
            .ok_or(RelayError::Channel)?;
        let (direction, sender) = if channel.responder == connection_id {
            (&mut channel.forward, channel.initiator.clone())
        } else if channel.initiator == connection_id {
            (&mut channel.reverse, channel.responder.clone())
        } else {
            return Err(RelayError::Channel);
        };
        if sequence != direction.return_sequence.saturating_add(1)
            || received <= direction.returned
            || received > direction.sent
        {
            return Err(RelayError::Credit);
        }
        direction.return_sequence = sequence;
        direction.returned = received;
        channel.last_activity_ms = now_ms;
        let sender_epoch = self
            .connections
            .get(&sender)
            .ok_or(RelayError::Connection)?
            .connection_epoch
            .clone();
        let message = json!({"version":1,"controlId":Uuid::new_v4().to_string(),"type":"credit.available","serviceId":self.config.service_id,"networkId":self.config.network_id,"bootEpoch":self.boot_epoch,"connectionEpoch":sender_epoch,"channelId":channel_id,"sequence":sequence,"receivedBytes":received});
        Ok(vec![control_effect(&sender, message)?])
    }

    fn control_scope(&self, value: &Value) -> Result<ControlScope, RelayError> {
        Ok(ControlScope {
            service_id: value["serviceId"]
                .as_str()
                .ok_or(RelayError::Control)?
                .to_owned(),
            network_id: value["networkId"]
                .as_str()
                .ok_or(RelayError::Control)?
                .to_owned(),
            boot_epoch: value["bootEpoch"]
                .as_str()
                .ok_or(RelayError::Control)?
                .to_owned(),
            connection_epoch: value["connectionEpoch"]
                .as_str()
                .ok_or(RelayError::Control)?
                .to_owned(),
        })
    }

    fn live_connection(&self, id: &str, now_unix: i64) -> Result<&Connection, RelayError> {
        let connection = self.connections.get(id).ok_or(RelayError::Connection)?;
        if connection.device.expires_at <= now_unix {
            return Err(RelayError::Unauthorized);
        }
        Ok(connection)
    }

    fn remove_channel(&mut self, channel_id: &str, reason: &'static str) -> Vec<Effect> {
        let Some(channel) = self.channels.remove(channel_id) else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        for (id, epoch) in [
            (channel.initiator, channel.initiator_epoch),
            (channel.responder, channel.responder_epoch),
        ] {
            if !self.connections.contains_key(&id) {
                continue;
            }
            let closed = json!({
                "version":1,
                "controlId":Uuid::new_v4().to_string(),
                "type":"channel.closed",
                "serviceId":self.config.service_id,
                "networkId":self.config.network_id,
                "bootEpoch":self.boot_epoch,
                "connectionEpoch":epoch,
                "channelId":channel_id,
                "reason":reason,
            });
            if let Ok(effect) = control_effect(&id, closed) {
                effects.push(effect);
            }
            effects.push(Effect::Close {
                target_connection_id: id,
                channel_id: channel_id.to_owned(),
                reason,
            });
        }
        effects
    }

    fn drop_connection(&mut self, connection_id: &str, reason: &'static str) -> Vec<Effect> {
        self.connections.remove(connection_id);
        let affected: Vec<String> = self
            .channels
            .iter()
            .filter(|(_, channel)| {
                channel.initiator == connection_id || channel.responder == connection_id
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut effects = Vec::new();
        for id in affected {
            effects.extend(self.remove_channel(&id, reason));
        }
        effects
    }
}

struct ControlScope {
    service_id: String,
    network_id: String,
    boot_epoch: String,
    connection_epoch: String,
}

fn scope_matches_connection(scope: &ControlScope, conn: &Connection, boot: &str) -> bool {
    scope.service_id == conn.device.scope.service_id
        && scope.network_id == conn.device.scope.network_id
        && scope.boot_epoch == boot
        && scope.connection_epoch == conn.connection_epoch
}

fn same_principal_network(a: &DeviceScope, b: &DeviceScope) -> bool {
    a.service_id == b.service_id
        && a.environment == b.environment
        && a.network_id == b.network_id
        && a.principal_id == b.principal_id
}

fn scope_key(scope: &DeviceScope) -> (String, String, String, String, String, u64) {
    (
        scope.service_id.clone(),
        scope.environment.clone(),
        scope.network_id.clone(),
        scope.principal_id.clone(),
        scope.device_id.clone(),
        scope.key_generation,
    )
}

fn pair_key(a: &DeviceScope, b: &DeviceScope) -> Option<String> {
    if !same_principal_network(a, b) || a.device_id == b.device_id {
        return None;
    }
    let (first, second) = if scope_key(a) < scope_key(b) {
        (a, b)
    } else {
        (b, a)
    };
    Some(format!("{}|{}", scope_id(first), scope_id(second)))
}

fn channel_pair_key(channel: &Channel) -> String {
    pair_key(&channel.initiator_scope, &channel.responder_scope).unwrap_or_default()
}

fn scope_id(scope: &DeviceScope) -> String {
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

fn control_effect(target: &str, value: Value) -> Result<Effect, RelayError> {
    validate_server_control(&value).map_err(|_| RelayError::Unavailable)?;
    Ok(Effect::Control {
        target_connection_id: target.to_owned(),
        json: value,
    })
}

fn unsupported_effect(target: &str, control_id: &str) -> Result<Effect, RelayError> {
    control_effect(
        target,
        json!({"version":1,"controlId":control_id,"type":"error","code":"UNSUPPORTED","retryable":false}),
    )
}

fn channel_control(
    config: &RelayConfig,
    boot: &str,
    channel: &Channel,
    target: &str,
    kind: &str,
) -> Result<Effect, RelayError> {
    let epoch = if target == channel.initiator {
        &channel.initiator_epoch
    } else {
        &channel.responder_epoch
    };
    control_effect(
        target,
        json!({"version":1,"controlId":Uuid::new_v4().to_string(),"type":kind,"serviceId":config.service_id,"networkId":config.network_id,"bootEpoch":boot,"connectionEpoch":epoch,"channelId":channel.id}),
    )
}

fn is_https_issuer(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.origin().ascii_serialization() == value
    })
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn parse_jwks(jwks: &Value) -> Result<Vec<(String, DecodingKey)>, RelayError> {
    let keys = jwks["keys"].as_array().ok_or(RelayError::Configuration)?;
    if keys.is_empty() || keys.len() > 32 {
        return Err(RelayError::Configuration);
    }
    let mut output = Vec::with_capacity(keys.len());
    let mut seen_kids = HashSet::new();
    for value in keys {
        if value["kty"] != "EC"
            || value["crv"] != "P-256"
            || value["alg"] != "ES256"
            || value["use"] != "sig"
            || ["d", "p", "q", "dp", "dq", "qi", "oth"]
                .iter()
                .any(|private| value.get(*private).is_some())
        {
            return Err(RelayError::Configuration);
        }
        let kid = value["kid"].as_str().ok_or(RelayError::Configuration)?;
        if kid.is_empty() || kid.len() > 128 || !seen_kids.insert(kid.to_owned()) {
            return Err(RelayError::Configuration);
        }
        let jwk: jsonwebtoken::jwk::Jwk =
            serde_json::from_value(value.clone()).map_err(|_| RelayError::Configuration)?;
        output.push((
            kid.to_owned(),
            DecodingKey::from_jwk(&jwk).map_err(|_| RelayError::Configuration)?,
        ));
    }
    if output.is_empty() {
        return Err(RelayError::Configuration);
    }
    Ok(output)
}

fn verify_peer_binding(
    config: &RelayConfig,
    scope: &DeviceScope,
    current_fingerprint: &str,
    current_binding_id: &str,
    token: &str,
    now: i64,
) -> Result<i64, RelayError> {
    if token.len() > 32_768 {
        return Err(RelayError::Unauthorized);
    }
    let header_segment = token.split('.').next().ok_or(RelayError::Unauthorized)?;
    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_segment)
        .map_err(|_| RelayError::Unauthorized)?;
    let header_json: Value =
        serde_json::from_slice(&header_bytes).map_err(|_| RelayError::Unauthorized)?;
    if header_json.as_object().is_none_or(|object| {
        object
            .keys()
            .any(|key| !["alg", "typ", "kid"].contains(&key.as_str()))
            || object.len() != 3
    }) {
        return Err(RelayError::Unauthorized);
    }
    let header = jsonwebtoken::decode_header(token).map_err(|_| RelayError::Unauthorized)?;
    if header.alg != Algorithm::ES256 || header.typ.as_deref() != Some("ma-network-peer+jwt") {
        return Err(RelayError::Unauthorized);
    }
    let kid = header.kid.ok_or(RelayError::Unauthorized)?;
    let key = parse_jwks(&config.peer_jwks)?
        .into_iter()
        .find(|(candidate, _)| candidate == &kid)
        .map(|(_, key)| key)
        .ok_or(RelayError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::ES256);
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    let claims = decode::<Value>(token, &key, &validation)
        .map_err(|_| RelayError::Unauthorized)?
        .claims;
    myagents_agent_network_protocol::validate_signed_peer(&claims)
        .map_err(|_| RelayError::Unauthorized)?;
    let binding = &claims["binding"];
    if claims["iss"] != config.issuer
        || claims["aud"] != "myagents-agent-peer"
        || claims["sub"] != scope.principal_id
        || claims["exp"].as_i64().unwrap_or_default() <= now
        || claims["iat"].as_i64().unwrap_or_default()
            > now.saturating_add(budget("clockSkewSeconds") as i64)
        || claims["nbf"].as_i64().unwrap_or_default()
            > now.saturating_add(budget("clockSkewSeconds") as i64)
        || claims["iat"].as_i64().unwrap_or_default() > claims["exp"].as_i64().unwrap_or_default()
        || claims["exp"]
            .as_i64()
            .unwrap_or_default()
            .saturating_sub(claims["iat"].as_i64().unwrap_or_default())
            > budget("certificateSeconds") as i64
        || binding["serviceId"] != scope.service_id
        || binding["environment"] != scope.environment
        || binding["principalId"] != scope.principal_id
        || binding["deviceId"] != scope.device_id
        || binding["keyGeneration"].as_u64() != Some(scope.key_generation)
        || binding["certificateFingerprint"] != current_fingerprint
        || binding["identityBindingId"] != current_binding_id
        || binding["expiresAt"].as_i64().unwrap_or_default() <= now
        || claims["exp"].as_i64().unwrap_or_default()
            > binding["expiresAt"].as_i64().unwrap_or_default()
    {
        return Err(RelayError::Unauthorized);
    }
    Ok(claims["exp"].as_i64().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_crypto::DevicePrivateKey;
    use myagents_agentnet_identity_core::{IdentityRequest, IssuerProfile, ServiceKeys};
    use std::{fs, os::unix::fs::PermissionsExt};
    use url::Url;

    struct DeviceFixture {
        authorized: AuthorizedDevice,
        access: ValidatedAccess,
        device_key: std::sync::Arc<DevicePrivateKey>,
        tls_identity: std::sync::Arc<myagents_agent_network_crypto::TlsIdentity>,
        root_certificate: String,
        binding_san: String,
        request: IdentityRequest,
        snapshot: TrustedLiveSnapshot,
        signed_binding: String,
        scope: DeviceScope,
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        core: RelayCore,
        keys: ServiceKeys,
        profile: IssuerProfile,
        principal_id: String,
        now: i64,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let keys = ServiceKeys::generate_initial(dir.path().join("issuer-keys.json")).unwrap();
            let profile = IssuerProfile {
                issuer: "https://agentnet.example.test".into(),
                service_id: Uuid::new_v4().to_string(),
                environment: "development".into(),
                network_id: Uuid::new_v4().to_string(),
            };
            let core = RelayCore::new(RelayConfig {
                service_id: profile.service_id.clone(),
                issuer: profile.issuer.clone(),
                environment: profile.environment.clone(),
                network_id: profile.network_id.clone(),
                peer_jwks: keys.jwks(),
            })
            .unwrap();
            Self {
                _dir: dir,
                core,
                keys,
                profile,
                principal_id: Uuid::new_v4().to_string(),
                now: jsonwebtoken::get_current_timestamp() as i64,
            }
        }

        fn device(&self) -> DeviceFixture {
            self.device_with_id(Uuid::new_v4())
        }

        fn device_with_id(&self, device_id: Uuid) -> DeviceFixture {
            let device_id = device_id.to_string();
            let session_handle = Uuid::new_v4().to_string();
            let identity_binding_id = Uuid::new_v4().to_string();
            let key = std::sync::Arc::new(DevicePrivateKey::generate().unwrap());
            let request = IdentityRequest {
                principal_id: self.principal_id.clone(),
                device_id: device_id.clone(),
                key_generation: 1,
                identity_binding_id: identity_binding_id.clone(),
                session_handle: session_handle.clone(),
                csr_pem: key.csr().unwrap(),
            };
            let issued = self.keys.issue(&self.profile, &request).unwrap();
            let leaf = issued.certificate.as_deref().unwrap();
            let mut chain = myagents_agent_network_crypto::certificate_chain(leaf).unwrap();
            for pem in &issued.certificate_chain {
                chain.extend(myagents_agent_network_crypto::certificate_chain(pem).unwrap());
            }
            let tls_identity = std::sync::Arc::new(
                myagents_agent_network_crypto::TlsIdentity::new(chain, key.clone()).unwrap(),
            );
            let admission = myagents_agentnet_admission_core::AdmissionValidator::new(
                myagents_agentnet_admission_core::ExpectedService {
                    https_origin_canonical: self.profile.issuer.clone(),
                    service_id: self.profile.service_id.clone(),
                    environment: self.profile.environment.clone(),
                    network_id: self.profile.network_id.clone(),
                    jwks: self.keys.jwks(),
                },
                myagents_agentnet_admission_core::ReplayPolicy::default(),
            )
            .unwrap();
            let proof = key
                .dpop(
                    "GET",
                    &Url::parse("https://agentnet.example.test/relay-test").unwrap(),
                    &issued.access_token,
                    Some("test-boot-nonce"),
                )
                .unwrap();
            let access = admission
                .validate(
                    &issued.access_token,
                    &proof,
                    "GET",
                    "https://agentnet.example.test/relay-test",
                    Some("test-boot-nonce"),
                )
                .unwrap();
            let scope = DeviceScope {
                service_id: self.profile.service_id.clone(),
                environment: self.profile.environment.clone(),
                network_id: self.profile.network_id.clone(),
                principal_id: self.principal_id.clone(),
                device_id,
                key_generation: 1,
            };
            let snapshot = TrustedLiveSnapshot {
                scope: scope.clone(),
                session_handle,
                session_expires_at: issued.access_token_expires_at as i64,
                current_key_fingerprint: key.public_fingerprint().unwrap(),
                current_certificate_fingerprint: issued.certificate_fingerprint.clone().unwrap(),
                current_identity_binding_id: identity_binding_id,
                joined: true,
                network_revision: 12,
                membership_revision: 7,
            };
            let signed_binding = issued.signed_binding.unwrap();
            let authorized = self
                .core
                .authorize_device(&access, snapshot.clone(), &signed_binding, self.now)
                .unwrap();
            DeviceFixture {
                authorized,
                access,
                device_key: key,
                tls_identity,
                root_certificate: issued.certificate_chain.last().unwrap().clone(),
                binding_san: format!(
                    "{}.devices.{}.invalid",
                    request.identity_binding_id, self.profile.service_id
                ),
                request,
                snapshot,
                signed_binding,
                scope,
            }
        }

        fn connect_ready(&mut self, device: DeviceFixture) -> (String, Value, String, DeviceScope) {
            let signed_binding = device.signed_binding.clone();
            let scope = device.scope.clone();
            let (connection_id, effects) = self.core.connect(device.authorized, self.now).unwrap();
            let hello = effects
                .into_iter()
                .find_map(|effect| match effect {
                    Effect::Control { json, .. } if json["type"] == "hello.result" => Some(json),
                    _ => None,
                })
                .unwrap();
            let proof = self
                .core
                .ready_proof(
                    &connection_id,
                    TrustedReadyEvidence {
                        scope: device.scope,
                        connection_epoch: hello["connectionEpoch"].as_str().unwrap().into(),
                        catalog_sequence: 1,
                        acknowledged_sequence: 1,
                        membership_revision: 7,
                        policy_allows_relay: true,
                    },
                    self.now,
                )
                .unwrap();
            let ready = json!({
                "version":1,
                "controlId":Uuid::new_v4().to_string(),
                "type":"ready",
                "serviceId":hello["serviceId"],
                "networkId":hello["networkId"],
                "bootEpoch":hello["bootEpoch"],
                "connectionEpoch":hello["connectionEpoch"],
                "catalogSeq":1,
            });
            let effects = self
                .core
                .handle_control(
                    &connection_id,
                    &serde_json::to_vec(&ready).unwrap(),
                    Some(proof),
                    self.now,
                    1_000,
                )
                .unwrap();
            assert_eq!(effects.len(), 1);
            assert_eq!(effects[0].control_json().unwrap()["type"], "ready.result");
            (connection_id, hello, signed_binding, scope)
        }

        fn ready_pair(&mut self, now_ms: i64) -> (String, String, Value, Value, String) {
            let first = self.device();
            let second = self.device();
            let (first_id, first_hello, first_binding, _) = self.connect_ready(first);
            let (second_id, second_hello, second_binding, _) = self.connect_ready(second);
            let channel_id = Uuid::new_v4().to_string();
            let open = client_control(
                &first_hello,
                "channel.open",
                json!({
                    "channelId":channel_id,
                    "targetDeviceId":second_hello["identity"]["deviceId"],
                    "targetKeyGeneration":1,
                    "targetConnectionEpoch":second_hello["connectionEpoch"],
                    "targetBinding":null,
                }),
            );
            self.core
                .handle_control(
                    &first_id,
                    &serde_json::to_vec(&open).unwrap(),
                    None,
                    self.now,
                    now_ms,
                )
                .unwrap();
            let accept_first = client_control(
                &first_hello,
                "channel.accept",
                json!({"channelId":channel_id,"signedBinding":first_binding}),
            );
            assert!(self
                .core
                .handle_control(
                    &first_id,
                    &serde_json::to_vec(&accept_first).unwrap(),
                    None,
                    self.now,
                    now_ms + 1,
                )
                .unwrap()
                .is_empty());
            let accept = client_control(
                &second_hello,
                "channel.accept",
                json!({"channelId":channel_id,"signedBinding":second_binding}),
            );
            self.core
                .handle_control(
                    &second_id,
                    &serde_json::to_vec(&accept).unwrap(),
                    None,
                    self.now,
                    now_ms + 2,
                )
                .unwrap();
            for (connection_id, hello) in [(&first_id, &first_hello), (&second_id, &second_hello)] {
                let ready = client_control(hello, "channel.ready", json!({"channelId":channel_id}));
                self.core
                    .handle_control(
                        connection_id,
                        &serde_json::to_vec(&ready).unwrap(),
                        None,
                        self.now,
                        now_ms + 3,
                    )
                    .unwrap();
            }
            (first_id, second_id, first_hello, second_hello, channel_id)
        }
    }

    impl Effect {
        fn control_json(&self) -> Option<&Value> {
            match self {
                Self::Control { json, .. } => Some(json),
                _ => None,
            }
        }

        fn target_id(&self) -> Option<&str> {
            match self {
                Self::Control {
                    target_connection_id,
                    ..
                } => Some(target_connection_id),
                Self::OpaqueFrame {
                    target_connection_id,
                    ..
                } => Some(target_connection_id),
                Self::Close {
                    target_connection_id,
                    ..
                } => Some(target_connection_id),
            }
        }
    }

    fn client_control(hello: &Value, kind: &str, extra: Value) -> Value {
        let mut value = json!({
            "version":1,
            "controlId":Uuid::new_v4().to_string(),
            "type":kind,
            "serviceId":hello["serviceId"],
            "networkId":hello["networkId"],
            "bootEpoch":hello["bootEpoch"],
            "connectionEpoch":hello["connectionEpoch"],
        });
        for (key, item) in extra.as_object().unwrap() {
            value[key] = item.clone();
        }
        value
    }

    #[allow(clippy::too_many_arguments)] // Explicit endpoints, peer control envelope and credit state.
    fn relay_tls_chunk(
        core: &mut RelayCore,
        channel_id: &str,
        sender_connection: &str,
        receiver_connection: &str,
        receiver_hello: &Value,
        receiver: &mut myagents_agent_network_crypto::InnerTls,
        tls_chunk: &[u8],
        received_bytes: &mut u64,
        credit_sequence: &mut u64,
        now_unix: i64,
        now_ms: i64,
    ) -> Vec<u8> {
        let frame =
            myagents_agent_network_protocol::encode_tls_frame(channel_id, tls_chunk).unwrap();
        let effects = core
            .forward_frame(sender_connection, &frame, now_unix, now_ms)
            .unwrap();
        assert_eq!(effects.len(), 1);
        match &effects[0] {
            Effect::OpaqueFrame {
                target_connection_id,
                bytes,
            } => {
                assert_eq!(target_connection_id, receiver_connection);
                assert_eq!(bytes, &frame);
            }
            _ => panic!("expected opaque TLS frame forwarding"),
        }
        let (got_channel, payload) =
            myagents_agent_network_protocol::decode_tls_frame(&frame).unwrap();
        assert_eq!(got_channel, channel_id);
        let plaintext = receiver.feed(payload).unwrap();
        *received_bytes += frame.len() as u64;
        *credit_sequence += 1;
        let credit = client_control(
            receiver_hello,
            "credit.release",
            json!({
                "channelId":channel_id,
                "sequence":*credit_sequence,
                "receivedBytes":*received_bytes,
            }),
        );
        core.handle_control(
            receiver_connection,
            &serde_json::to_vec(&credit).unwrap(),
            None,
            now_unix,
            now_ms,
        )
        .unwrap();
        plaintext
    }

    #[test]
    fn accepted_relays_real_mtls_and_channel_hello_before_ready_then_business_after_ready() {
        use myagents_agent_network_crypto::{private_roots, InnerTls};
        use myagents_agent_network_protocol::{
            encode_object, BusinessObject, ChannelHello, ObjectDecoder,
        };

        let mut fixture = Fixture::new();
        let first = fixture
            .device_with_id(Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap());
        let second = fixture
            .device_with_id(Uuid::parse_str("ffffffff-ffff-4fff-bfff-ffffffffffff").unwrap());
        let first_identity = first.tls_identity.clone();
        let second_identity = second.tls_identity.clone();
        let first_root = first.root_certificate.clone();
        let second_root = second.root_certificate.clone();
        let first_san = first.binding_san.clone();
        let second_san = second.binding_san.clone();
        let first_fp = first.snapshot.current_certificate_fingerprint.clone();
        let second_fp = second.snapshot.current_certificate_fingerprint.clone();
        let (first_id, first_hello, first_binding, first_scope) = fixture.connect_ready(first);
        let (second_id, second_hello, second_binding, second_scope) = fixture.connect_ready(second);
        let channel_id = Uuid::new_v4().to_string();

        let open = client_control(
            &second_hello,
            "channel.open",
            json!({
                "channelId":channel_id,
                "targetDeviceId":first_scope.device_id,
                "targetKeyGeneration":first_scope.key_generation,
                "targetConnectionEpoch":first_hello["connectionEpoch"],
                "targetBinding":null,
            }),
        );
        let offered = fixture
            .core
            .handle_control(
                &second_id,
                &serde_json::to_vec(&open).unwrap(),
                None,
                fixture.now,
                5_000,
            )
            .unwrap();
        assert_eq!(offered.len(), 2);
        assert!(offered
            .iter()
            .all(|effect| effect.control_json().unwrap()["type"] == "channel.offer"));
        let first_offer = offered
            .iter()
            .find(|effect| effect.target_id() == Some(first_id.as_str()))
            .unwrap()
            .control_json()
            .unwrap();
        let second_offer = offered
            .iter()
            .find(|effect| effect.target_id() == Some(second_id.as_str()))
            .unwrap()
            .control_json()
            .unwrap();
        assert_eq!(
            first_offer["connectionEpoch"],
            first_hello["connectionEpoch"]
        );
        assert_eq!(
            second_offer["connectionEpoch"],
            second_hello["connectionEpoch"]
        );
        assert_eq!(
            first_offer["initiator"],
            serde_json::to_value(&first_scope).unwrap()
        );
        assert_eq!(
            first_offer["responder"],
            serde_json::to_value(&second_scope).unwrap()
        );
        assert_eq!(second_offer["initiator"], first_offer["initiator"]);
        assert_eq!(second_offer["responder"], first_offer["responder"]);

        let roots_client = private_roots(&first_root).unwrap();
        let roots_server = private_roots(&second_root).unwrap();
        let mut client =
            InnerTls::client(first_identity.as_ref(), roots_client, second_san, second_fp).unwrap();
        let mut server =
            InnerTls::server(second_identity.as_ref(), roots_server, first_san, first_fp).unwrap();

        // The initiator has a genuine TLS ClientHello queued before Accept.
        let client_hello_chunk = client.drain_chunk().unwrap().unwrap();
        let client_hello_frame =
            myagents_agent_network_protocol::encode_tls_frame(&channel_id, &client_hello_chunk)
                .unwrap();
        assert_eq!(
            fixture
                .core
                .forward_frame(&first_id, &client_hello_frame, fixture.now, 5_001),
            Err(RelayError::Channel)
        );

        let accept_first = client_control(
            &first_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":first_binding}),
        );
        assert!(fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&accept_first).unwrap(),
                None,
                fixture.now,
                5_002,
            )
            .unwrap()
            .is_empty());
        assert_eq!(
            fixture.core.handle_control(
                &first_id,
                &serde_json::to_vec(&accept_first).unwrap(),
                None,
                fixture.now,
                5_002,
            ),
            Err(RelayError::Replay)
        );
        assert_eq!(
            fixture
                .core
                .forward_frame(&first_id, &client_hello_frame, fixture.now, 5_002),
            Err(RelayError::Channel)
        );
        let accept_second = client_control(
            &second_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":second_binding}),
        );
        let accepted = fixture
            .core
            .handle_control(
                &second_id,
                &serde_json::to_vec(&accept_second).unwrap(),
                None,
                fixture.now,
                5_003,
            )
            .unwrap();
        assert!(accepted
            .iter()
            .all(|effect| effect.control_json().unwrap()["type"] == "channel.accepted"));

        let mut first_received = 0;
        let mut second_received = 0;
        let mut first_credit_sequence = 0;
        let mut second_credit_sequence = 0;
        let mut first_plaintext = Vec::new();
        let mut second_plaintext = Vec::new();
        second_plaintext.extend(relay_tls_chunk(
            &mut fixture.core,
            &channel_id,
            &first_id,
            &second_id,
            &second_hello,
            &mut server,
            &client_hello_chunk,
            &mut second_received,
            &mut second_credit_sequence,
            fixture.now,
            5_009,
        ));
        for step in 0..64 {
            let mut progressed = false;
            if let Some(chunk) = client.drain_chunk().unwrap() {
                second_plaintext.extend(relay_tls_chunk(
                    &mut fixture.core,
                    &channel_id,
                    &first_id,
                    &second_id,
                    &second_hello,
                    &mut server,
                    &chunk,
                    &mut second_received,
                    &mut second_credit_sequence,
                    fixture.now,
                    5_010 + step,
                ));
                progressed = true;
            }
            if let Some(chunk) = server.drain_chunk().unwrap() {
                first_plaintext.extend(relay_tls_chunk(
                    &mut fixture.core,
                    &channel_id,
                    &second_id,
                    &first_id,
                    &first_hello,
                    &mut client,
                    &chunk,
                    &mut first_received,
                    &mut first_credit_sequence,
                    fixture.now,
                    5_010 + step,
                ));
                progressed = true;
            }
            if client.verified() && server.verified() && !progressed {
                break;
            }
        }
        assert!(
            client.verified(),
            "client must verify the issued server identity"
        );
        assert!(
            server.verified(),
            "server must verify the issued client identity"
        );

        let make_channel_hello = |source: DeviceScope,
                                  target: DeviceScope,
                                  source_epoch: &Value,
                                  target_epoch: &Value| {
            BusinessObject::Hello(ChannelHello {
                version: 1,
                sender_sequence: 1,
                channel_id: channel_id.clone(),
                source,
                target,
                source_connection_epoch: source_epoch.as_str().unwrap().to_owned(),
                target_connection_epoch: target_epoch.as_str().unwrap().to_owned(),
            })
        };
        let first_channel_hello = make_channel_hello(
            first_scope.clone(),
            second_scope.clone(),
            &first_hello["connectionEpoch"],
            &second_hello["connectionEpoch"],
        );
        let first_hello_value = serde_json::to_value(first_channel_hello).unwrap();
        let first_hello_frame = encode_object(&first_hello_value).unwrap();
        client.write_plaintext(&first_hello_frame).unwrap();
        let chunk = client.drain_chunk().unwrap().unwrap();
        second_plaintext.extend(relay_tls_chunk(
            &mut fixture.core,
            &channel_id,
            &first_id,
            &second_id,
            &second_hello,
            &mut server,
            &chunk,
            &mut second_received,
            &mut second_credit_sequence,
            fixture.now,
            5_100,
        ));
        let mut decoder = ObjectDecoder::default();
        let received = decoder.push(&second_plaintext).unwrap();
        assert_eq!(received.len(), 1);
        assert!(matches!(
            BusinessObject::parse(received.into_iter().next().unwrap()).unwrap(),
            BusinessObject::Hello(hello)
                if hello.source == first_scope
                    && hello.target == second_scope
                    && hello.channel_id == channel_id
        ));

        let second_channel_hello = make_channel_hello(
            second_scope.clone(),
            first_scope.clone(),
            &second_hello["connectionEpoch"],
            &first_hello["connectionEpoch"],
        );
        let second_hello_value = serde_json::to_value(second_channel_hello).unwrap();
        let second_hello_frame = encode_object(&second_hello_value).unwrap();
        server.write_plaintext(&second_hello_frame).unwrap();
        let chunk = server.drain_chunk().unwrap().unwrap();
        first_plaintext.extend(relay_tls_chunk(
            &mut fixture.core,
            &channel_id,
            &second_id,
            &first_id,
            &first_hello,
            &mut client,
            &chunk,
            &mut first_received,
            &mut first_credit_sequence,
            fixture.now,
            5_101,
        ));
        let mut decoder = ObjectDecoder::default();
        let received = decoder.push(&first_plaintext).unwrap();
        assert_eq!(received.len(), 1);
        assert!(matches!(
            BusinessObject::parse(received.into_iter().next().unwrap()).unwrap(),
            BusinessObject::Hello(hello)
                if hello.source == second_scope
                    && hello.target == first_scope
                    && hello.channel_id == channel_id
        ));

        for (connection_id, hello) in [(&first_id, &first_hello), (&second_id, &second_hello)] {
            let ready = client_control(hello, "channel.ready", json!({"channelId":channel_id}));
            fixture
                .core
                .handle_control(
                    connection_id,
                    &serde_json::to_vec(&ready).unwrap(),
                    None,
                    fixture.now,
                    5_102,
                )
                .unwrap();
        }

        // Real business JSON stays encrypted in transit and is only forwarded
        // after the client protocol and relay-ready gates have both completed.
        let business = json!({
            "kind":"invoke",
            "version":1,
            "opId":Uuid::new_v4().to_string(),
            "requestId":Uuid::new_v4().to_string(),
            "senderSequence":2,
            "source":first_scope,
            "caller":{"kind":"external-cli","label":"relay-test"},
            "targetMountId":Uuid::new_v4().to_string(),
            "method":"agent.show",
            "params":{"localAgentId":"agent-test"},
        });
        myagents_agent_network_protocol::validate_business(&business).unwrap();
        client
            .write_plaintext(&encode_object(&business).unwrap())
            .unwrap();
        let chunk = client.drain_chunk().unwrap().unwrap();
        let delivered = relay_tls_chunk(
            &mut fixture.core,
            &channel_id,
            &first_id,
            &second_id,
            &second_hello,
            &mut server,
            &chunk,
            &mut second_received,
            &mut second_credit_sequence,
            fixture.now,
            5_103,
        );
        let mut decoder = ObjectDecoder::default();
        let received = decoder.push(&delivered).unwrap();
        assert_eq!(received.len(), 1);
        assert!(matches!(
            BusinessObject::parse(received.into_iter().next().unwrap()).unwrap(),
            BusinessObject::Invoke(invocation)
                if invocation.source == first_scope
                    && invocation.operation.method() == "agent.show"
        ));
    }

    #[test]
    fn real_signed_devices_pair_ready_and_forward_opaque_frames_with_credit() {
        let mut fixture = Fixture::new();
        let first = fixture.device();
        let second = fixture.device();
        let (first_id, first_hello, first_binding, _first_scope) = fixture.connect_ready(first);
        let (second_id, second_hello, second_binding, _second_scope) =
            fixture.connect_ready(second);
        let channel_id = Uuid::new_v4().to_string();
        let open = client_control(
            &first_hello,
            "channel.open",
            json!({
                "channelId":channel_id,
                "targetDeviceId":second_hello["identity"]["deviceId"],
                "targetKeyGeneration":1,
                "targetConnectionEpoch":second_hello["connectionEpoch"],
                "targetBinding":null,
            }),
        );
        let offer = fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&open).unwrap(),
                None,
                fixture.now,
                2_000,
            )
            .unwrap();
        assert_eq!(offer.len(), 2);
        assert!(offer
            .iter()
            .all(|effect| effect.control_json().unwrap()["type"] == "channel.offer"));
        assert_eq!(
            offer
                .iter()
                .filter(|effect| effect.target_id() == Some(first_id.as_str()))
                .count(),
            1
        );
        assert_eq!(
            offer
                .iter()
                .filter(|effect| effect.target_id() == Some(second_id.as_str()))
                .count(),
            1
        );
        assert!(offer.iter().all(|effect| {
            effect.control_json().unwrap()["initiatorBinding"].is_string()
                && effect.control_json().unwrap()["responderBinding"].is_string()
        }));

        let accept_first = client_control(
            &first_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":first_binding}),
        );
        assert!(fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&accept_first).unwrap(),
                None,
                fixture.now,
                2_001,
            )
            .unwrap()
            .is_empty());
        let accept_second = client_control(
            &second_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":second_binding}),
        );
        let accepted = fixture
            .core
            .handle_control(
                &second_id,
                &serde_json::to_vec(&accept_second).unwrap(),
                None,
                fixture.now,
                2_002,
            )
            .unwrap();
        assert_eq!(accepted.len(), 2);
        assert!(accepted
            .iter()
            .all(|effect| effect.control_json().unwrap()["type"] == "channel.accepted"));
        let early_frame =
            myagents_agent_network_protocol::encode_tls_frame(&channel_id, &[1]).unwrap();
        // Offered channels cannot carry bytes. Accepted channels may carry the
        // opaque TLS handshake needed before either client can announce ready.
        assert_eq!(
            fixture
                .core
                .forward_frame(&first_id, &early_frame, fixture.now, 1_000)
                .unwrap()[0]
                .target_id(),
            Some(second_id.as_str())
        );

        let first_ready = client_control(
            &first_hello,
            "channel.ready",
            json!({"channelId":channel_id}),
        );
        assert!(fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&first_ready).unwrap(),
                None,
                fixture.now,
                2_002
            )
            .unwrap()
            .is_empty());
        // One peer's outer ready signal does not close the TLS path for the
        // other peer; client-side business readiness has its own crypto gate.
        let second_ready = client_control(
            &second_hello,
            "channel.ready",
            json!({"channelId":channel_id}),
        );
        let ready_effects = fixture
            .core
            .handle_control(
                &second_id,
                &serde_json::to_vec(&second_ready).unwrap(),
                None,
                fixture.now,
                2_003,
            )
            .unwrap();
        assert_eq!(ready_effects.len(), 2);
        assert!(ready_effects
            .iter()
            .all(|effect| effect.control_json().unwrap()["type"] == "channel.ready"));

        let frame = myagents_agent_network_protocol::encode_tls_frame(
            &channel_id,
            &[0x16, 0x03, 0x04, 0x00],
        )
        .unwrap();
        let forwarded = fixture
            .core
            .forward_frame(&first_id, &frame, fixture.now, 1_000)
            .unwrap();
        assert_eq!(
            forwarded,
            vec![Effect::OpaqueFrame {
                target_connection_id: second_id.clone(),
                bytes: frame.clone(),
            }]
        );
        let credit = client_control(
            &second_hello,
            "credit.release",
            json!({
                "channelId":channel_id,
                "sequence":1,
                "receivedBytes":frame.len(),
            }),
        );
        let credit_effects = fixture
            .core
            .handle_control(
                &second_id,
                &serde_json::to_vec(&credit).unwrap(),
                None,
                fixture.now,
                2_004,
            )
            .unwrap();
        assert_eq!(credit_effects.len(), 1);
        assert_eq!(credit_effects[0].target_id(), Some(first_id.as_str()));
        assert_eq!(
            credit_effects[0].control_json().unwrap()["type"],
            "credit.available"
        );
        assert_eq!(
            fixture
                .core
                .forward_frame(&first_id, &frame, fixture.now, 1_000)
                .unwrap()
                .len(),
            1
        );
        let bad_credit = client_control(
            &second_hello,
            "credit.release",
            json!({
                "channelId":channel_id,"sequence":1,"receivedBytes":frame.len()
            }),
        );
        assert_eq!(
            fixture.core.handle_control(
                &second_id,
                &serde_json::to_vec(&bad_credit).unwrap(),
                None,
                fixture.now,
                2_005
            ),
            Err(RelayError::Credit)
        );
        let max_frame = myagents_agent_network_protocol::encode_tls_frame(
            &channel_id,
            &vec![0x17; budget("tlsChunkBytes")],
        )
        .unwrap();
        for _ in 0..3 {
            assert!(fixture
                .core
                .forward_frame(&first_id, &max_frame, fixture.now, 1_000)
                .is_ok());
        }
        assert_eq!(
            fixture
                .core
                .forward_frame(&first_id, &max_frame, fixture.now, 1_000),
            Err(RelayError::Capacity)
        );
        assert_eq!(
            fixture
                .core
                .forward_frame(&first_id, &[1, 1, 0, 0], fixture.now, 1_000),
            Err(RelayError::Frame)
        );
    }

    #[test]
    fn canonical_channel_pair_is_stable_when_smaller_scope_opens_and_both_accept() {
        let mut fixture = Fixture::new();
        let first = fixture
            .device_with_id(Uuid::parse_str("00000000-0000-4000-8000-000000000002").unwrap());
        let second = fixture
            .device_with_id(Uuid::parse_str("ffffffff-ffff-4fff-bfff-ffffffffffff").unwrap());
        let (first_id, first_hello, first_binding, first_scope) = fixture.connect_ready(first);
        let (second_id, second_hello, second_binding, second_scope) = fixture.connect_ready(second);
        let channel_id = Uuid::new_v4().to_string();
        let open = client_control(
            &first_hello,
            "channel.open",
            json!({
                "channelId":channel_id,
                "targetDeviceId":second_scope.device_id,
                "targetKeyGeneration":second_scope.key_generation,
                "targetConnectionEpoch":second_hello["connectionEpoch"],
                "targetBinding":null,
            }),
        );
        let offers = fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&open).unwrap(),
                None,
                fixture.now,
                8_000,
            )
            .unwrap();
        assert_eq!(offers.len(), 2);
        for (connection_id, hello) in [(&first_id, &first_hello), (&second_id, &second_hello)] {
            let offer = offers
                .iter()
                .find(|effect| effect.target_id() == Some(connection_id.as_str()))
                .unwrap()
                .control_json()
                .unwrap();
            assert_eq!(offer["connectionEpoch"], hello["connectionEpoch"]);
            assert_eq!(
                offer["initiator"],
                serde_json::to_value(&first_scope).unwrap()
            );
            assert_eq!(
                offer["responder"],
                serde_json::to_value(&second_scope).unwrap()
            );
        }

        let accept_first = client_control(
            &first_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":first_binding}),
        );
        assert!(fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&accept_first).unwrap(),
                None,
                fixture.now,
                8_001,
            )
            .unwrap()
            .is_empty());
        let accept_second = client_control(
            &second_hello,
            "channel.accept",
            json!({"channelId":channel_id,"signedBinding":second_binding}),
        );
        let accepted = fixture
            .core
            .handle_control(
                &second_id,
                &serde_json::to_vec(&accept_second).unwrap(),
                None,
                fixture.now,
                8_002,
            )
            .unwrap();
        assert_eq!(accepted.len(), 2);
        assert!(accepted.iter().all(|effect| {
            let value = effect.control_json().unwrap();
            value["type"] == "channel.accepted"
                && value["initiatorBinding"].is_string()
                && value["responderBinding"].is_string()
        }));
    }

    #[test]
    fn ready_channels_expire_after_idle_and_active_pair_and_pair_quota_are_scoped() {
        let mut fixture = Fixture::new();
        let base = 50_000;
        let (old_a, _old_b, old_hello, old_peer, old_channel) = fixture.ready_pair(base);
        let (active_a, _active_b, _active_hello, _active_peer, active_channel) =
            fixture.ready_pair(base + 10);

        let active_at = base + budget("idleChannelMs") as i64 - 10;
        let opaque =
            myagents_agent_network_protocol::encode_tls_frame(&active_channel, &[0x5a]).unwrap();
        let forwarded = fixture
            .core
            .forward_frame(&active_a, &opaque, fixture.now, active_at)
            .unwrap();
        assert_eq!(forwarded.len(), 1);
        assert!(matches!(forwarded[0], Effect::OpaqueFrame { .. }));

        // A well-formed but unauthorized close does not count as pair activity.
        let invalid_close = client_control(
            &old_hello,
            "channel.close",
            json!({"channelId":Uuid::new_v4().to_string(),"reason":"test"}),
        );
        assert_eq!(
            fixture.core.handle_control(
                &old_a,
                &serde_json::to_vec(&invalid_close).unwrap(),
                None,
                fixture.now,
                active_at + 1,
            ),
            Err(RelayError::Channel)
        );

        let expired_at = base + budget("idleChannelMs") as i64 + 4;
        let effects = fixture.core.expire(fixture.now, expired_at);
        assert_eq!(fixture.core.channels.len(), 1);
        assert!(fixture.core.channels.contains_key(&active_channel));
        assert!(!fixture.core.channels.contains_key(&old_channel));
        assert!(effects.iter().any(|effect| matches!(
            effect,
            Effect::Close { channel_id, reason: "channel-idle-timeout", .. }
                if channel_id == &old_channel
        )));
        assert!(!effects.iter().any(|effect| matches!(
            effect,
            Effect::Close { channel_id, .. } if channel_id == &active_channel
        )));

        // Removing the expired pair frees its endpoint pair key and channel quota.
        let reopened_id = Uuid::new_v4().to_string();
        let reopen = client_control(
            &old_hello,
            "channel.open",
            json!({
                "channelId":reopened_id,
                "targetDeviceId":old_peer["identity"]["deviceId"],
                "targetKeyGeneration":1,
                "targetConnectionEpoch":old_peer["connectionEpoch"],
                "targetBinding":null,
            }),
        );
        assert!(fixture
            .core
            .handle_control(
                &old_a,
                &serde_json::to_vec(&reopen).unwrap(),
                None,
                fixture.now,
                expired_at + 1,
            )
            .is_ok());
        assert_eq!(fixture.core.channels.len(), 2);
    }

    #[test]
    fn snapshot_scope_generation_and_peer_signature_must_match_real_access() {
        let mut fixture = Fixture::new();
        let device = fixture.device();
        let invalid = TrustedLiveSnapshot {
            scope: DeviceScope {
                key_generation: 2,
                ..device.scope.clone()
            },
            session_handle: device.authorized.session_handle.clone(),
            session_expires_at: device.authorized.expires_at,
            current_key_fingerprint: device.authorized.key_fingerprint.clone(),
            current_certificate_fingerprint: device.authorized.certificate_fingerprint.clone(),
            current_identity_binding_id: device.authorized.binding_id.clone(),
            joined: true,
            network_revision: device.authorized.network_revision,
            membership_revision: device.authorized.membership_revision,
        };
        assert!(matches!(
            fixture.core.authorize_device(
                &device.access,
                invalid,
                &device.signed_binding,
                fixture.now
            ),
            Err(RelayError::Unauthorized)
        ));
        let mut wrong_key = device.snapshot.clone();
        wrong_key.current_key_fingerprint = Uuid::new_v4().to_string();
        assert!(matches!(
            fixture.core.authorize_device(
                &device.access,
                wrong_key,
                &device.signed_binding,
                fixture.now,
            ),
            Err(RelayError::Unauthorized)
        ));
        let mut not_joined = device.snapshot.clone();
        not_joined.joined = false;
        assert!(matches!(
            fixture.core.authorize_device(
                &device.access,
                not_joined,
                &device.signed_binding,
                fixture.now,
            ),
            Err(RelayError::Unauthorized)
        ));
        let principal = fixture.principal_id.clone();
        fixture.principal_id = Uuid::new_v4().to_string();
        let other = fixture.device();
        fixture.principal_id = principal;
        assert!(matches!(
            fixture.core.authorize_device(
                &device.access,
                other.snapshot,
                &other.signed_binding,
                fixture.now,
            ),
            Err(RelayError::Unauthorized)
        ));
        assert!(matches!(
            fixture.core.authorize_device(
                &device.access,
                device.snapshot.clone(),
                "not-a-signed-peer-binding",
                fixture.now,
            ),
            Err(RelayError::Unauthorized)
        ));
    }

    #[test]
    fn signed_access_projection_cannot_cross_service_environment_or_network() {
        let fixture = Fixture::new();
        let device = fixture.device();
        let variants = ["service", "environment", "network"];
        for variant in variants {
            let mut profile = fixture.profile.clone();
            match variant {
                "service" => profile.service_id = Uuid::new_v4().to_string(),
                "environment" => profile.environment = "production".into(),
                "network" => profile.network_id = Uuid::new_v4().to_string(),
                _ => unreachable!(),
            }
            let issued = fixture.keys.issue(&profile, &device.request).unwrap();
            let target_validator = myagents_agentnet_admission_core::AdmissionValidator::new(
                myagents_agentnet_admission_core::ExpectedService {
                    https_origin_canonical: profile.issuer.clone(),
                    service_id: profile.service_id.clone(),
                    environment: profile.environment.clone(),
                    network_id: profile.network_id.clone(),
                    jwks: fixture.keys.jwks(),
                },
                myagents_agentnet_admission_core::ReplayPolicy::default(),
            )
            .unwrap();
            let url = Url::parse("https://agentnet.example.test/relay-test").unwrap();
            let proof = device
                .device_key
                .dpop(
                    "GET",
                    &url,
                    &issued.access_token,
                    Some("cross-scope-test-nonce"),
                )
                .unwrap();
            let target_access = target_validator
                .validate(
                    &issued.access_token,
                    &proof,
                    "GET",
                    "https://agentnet.example.test/relay-test",
                    Some("cross-scope-test-nonce"),
                )
                .unwrap();
            let mut snapshot = device.snapshot.clone();
            snapshot.scope.service_id = profile.service_id.clone();
            snapshot.scope.environment = profile.environment.clone();
            snapshot.scope.network_id = profile.network_id.clone();
            snapshot.current_certificate_fingerprint =
                issued.certificate_fingerprint.clone().unwrap();
            snapshot.current_identity_binding_id = device.request.identity_binding_id.clone();
            let target_core = RelayCore::new(RelayConfig {
                service_id: profile.service_id.clone(),
                issuer: profile.issuer.clone(),
                environment: profile.environment.clone(),
                network_id: profile.network_id.clone(),
                peer_jwks: fixture.keys.jwks(),
            })
            .unwrap();
            let signed_binding = issued.signed_binding.unwrap();
            assert!(target_core
                .authorize_device(
                    &target_access,
                    snapshot.clone(),
                    &signed_binding,
                    fixture.now
                )
                .is_ok());
            assert!(
                matches!(
                    target_core.authorize_device(
                        &device.access,
                        snapshot,
                        &signed_binding,
                        fixture.now,
                    ),
                    Err(RelayError::Unauthorized)
                ),
                "cross-{variant} validated projection must fail"
            );
        }
    }

    #[test]
    fn fixed_schema_epoch_durable_ack_and_control_replay_are_enforced() {
        let mut fixture = Fixture::new();
        let device = fixture.device();
        let scope = device.scope.clone();
        let (connection_id, effects) = fixture
            .core
            .connect(device.authorized, fixture.now)
            .unwrap();
        let hello = effects[0].control_json().unwrap().clone();
        let evidence = |epoch: String, catalog: u64, ack: u64| TrustedReadyEvidence {
            scope: scope.clone(),
            connection_epoch: epoch,
            catalog_sequence: catalog,
            acknowledged_sequence: ack,
            membership_revision: 7,
            policy_allows_relay: true,
        };
        assert!(matches!(
            fixture.core.ready_proof(
                &connection_id,
                evidence(Uuid::new_v4().to_string(), 4, 4),
                fixture.now,
            ),
            Err(RelayError::Unauthorized)
        ));
        assert!(matches!(
            fixture.core.ready_proof(
                &connection_id,
                evidence(hello["connectionEpoch"].as_str().unwrap().into(), 4, 3),
                fixture.now,
            ),
            Err(RelayError::Unauthorized)
        ));
        let mut wrong_membership =
            evidence(hello["connectionEpoch"].as_str().unwrap().into(), 4, 4);
        wrong_membership.membership_revision += 1;
        assert!(matches!(
            fixture
                .core
                .ready_proof(&connection_id, wrong_membership, fixture.now),
            Err(RelayError::Unauthorized)
        ));
        let proof = fixture
            .core
            .ready_proof(
                &connection_id,
                evidence(hello["connectionEpoch"].as_str().unwrap().into(), 4, 4),
                fixture.now,
            )
            .unwrap();
        let mut ready = client_control(&hello, "ready", json!({"catalogSeq":4}));
        ready["unknownField"] = json!(true);
        assert_eq!(
            fixture.core.handle_control(
                &connection_id,
                &serde_json::to_vec(&ready).unwrap(),
                Some(proof.clone()),
                fixture.now,
                1_100,
            ),
            Err(RelayError::Control)
        );
        ready.as_object_mut().unwrap().remove("unknownField");
        ready["connectionEpoch"] = json!(Uuid::new_v4().to_string());
        assert_eq!(
            fixture.core.handle_control(
                &connection_id,
                &serde_json::to_vec(&ready).unwrap(),
                Some(proof.clone()),
                fixture.now,
                1_101,
            ),
            Err(RelayError::Connection)
        );
        ready["connectionEpoch"] = hello["connectionEpoch"].clone();
        assert_eq!(
            fixture
                .core
                .handle_control(
                    &connection_id,
                    &serde_json::to_vec(&ready).unwrap(),
                    Some(proof.clone()),
                    fixture.now,
                    1_102,
                )
                .unwrap()[0]
                .control_json()
                .unwrap()["type"],
            "ready.result"
        );
        let unsupported = client_control(
            &hello,
            "op.prepare",
            json!({
                "channelId":Uuid::new_v4().to_string(),
                "opId":Uuid::new_v4().to_string(),
                "targetMountId":Uuid::new_v4().to_string(),
            }),
        );
        let unsupported_effect = fixture
            .core
            .handle_control(
                &connection_id,
                &serde_json::to_vec(&unsupported).unwrap(),
                None,
                fixture.now,
                1_103,
            )
            .unwrap();
        assert_eq!(
            unsupported_effect[0].control_json().unwrap()["type"],
            "error"
        );
        assert_eq!(
            unsupported_effect[0].control_json().unwrap()["code"],
            "UNSUPPORTED"
        );
        assert_eq!(
            fixture.core.handle_control(
                &connection_id,
                &serde_json::to_vec(&ready).unwrap(),
                Some(proof),
                fixture.now,
                1_104,
            ),
            Err(RelayError::Replay)
        );
    }

    #[test]
    fn malformed_epoch_replay_timeout_and_replacement_are_fail_closed() {
        let mut fixture = Fixture::new();
        let first = fixture.device();
        let second = fixture.device();
        let first_authorized = fixture
            .core
            .authorize_device(
                &first.access,
                first.snapshot.clone(),
                &first.signed_binding,
                fixture.now,
            )
            .unwrap();
        let (first_id, first_hello, _, _) = fixture.connect_ready(first);
        let (second_id, second_hello, _, _) = fixture.connect_ready(second);
        let channel_id = Uuid::new_v4().to_string();
        let open = client_control(
            &first_hello,
            "channel.open",
            json!({
                "channelId":channel_id,
                "targetDeviceId":second_hello["identity"]["deviceId"],
                "targetKeyGeneration":1,
                "targetConnectionEpoch":second_hello["connectionEpoch"],
                "targetBinding":null,
            }),
        );
        let open_bytes = serde_json::to_vec(&open).unwrap();
        let initial_offer = fixture
            .core
            .handle_control(&first_id, &open_bytes, None, fixture.now, 10_000)
            .unwrap();
        assert_eq!(initial_offer.len(), 2);
        assert_eq!(
            initial_offer
                .iter()
                .filter(|effect| effect.target_id() == Some(first_id.as_str()))
                .count(),
            1
        );
        assert_eq!(
            initial_offer
                .iter()
                .filter(|effect| effect.target_id() == Some(second_id.as_str()))
                .count(),
            1
        );
        assert_eq!(
            fixture
                .core
                .handle_control(&first_id, &open_bytes, None, fixture.now, 10_001),
            Err(RelayError::Replay)
        );

        let expired = fixture
            .core
            .expire(fixture.now, 10_000 + budget("handshakeMs") as i64 + 1);
        assert_eq!(expired.len(), 4);
        assert_eq!(
            expired
                .iter()
                .filter(|effect| matches!(effect, Effect::Close { channel_id: id, .. } if id == &channel_id))
                .count(),
            2
        );
        assert_eq!(
            expired
                .iter()
                .filter(|effect| effect
                    .control_json()
                    .is_some_and(|value| value["type"] == "channel.closed"))
                .count(),
            2
        );
        assert!(!fixture.core.channels.contains_key(&channel_id));

        let next_channel = Uuid::new_v4().to_string();
        let next_open = client_control(
            &first_hello,
            "channel.open",
            json!({
                "channelId":next_channel,
                "targetDeviceId":second_hello["identity"]["deviceId"],
                "targetKeyGeneration":1,
                "targetConnectionEpoch":second_hello["connectionEpoch"],
                "targetBinding":null,
            }),
        );
        let offer = fixture
            .core
            .handle_control(
                &first_id,
                &serde_json::to_vec(&next_open).unwrap(),
                None,
                fixture.now,
                20_000,
            )
            .unwrap();
        assert_eq!(offer.len(), 2);
        assert_eq!(
            offer
                .iter()
                .filter(|effect| effect.target_id() == Some(second_id.as_str()))
                .count(),
            1
        );
        let (replacement_id, replacement_effects) =
            fixture.core.connect(first_authorized, fixture.now).unwrap();
        assert_ne!(replacement_id, first_id);
        assert_eq!(replacement_effects.len(), 3);
        assert!(replacement_effects.iter().any(|effect| {
            matches!(effect, Effect::Close { target_connection_id, channel_id, .. }
                if target_connection_id == &second_id && channel_id == &next_channel)
        }));
        assert!(replacement_effects.iter().any(|effect| {
            effect.target_id() == Some(second_id.as_str())
                && effect
                    .control_json()
                    .is_some_and(|value| value["type"] == "channel.closed")
        }));
        assert!(replacement_effects.iter().any(|effect| {
            effect.target_id() == Some(replacement_id.as_str())
                && effect
                    .control_json()
                    .is_some_and(|value| value["type"] == "hello.result")
        }));
        let stale_close = client_control(
            &first_hello,
            "channel.close",
            json!({
                "channelId":next_channel,"reason":"late close"
            }),
        );
        assert_eq!(
            fixture.core.handle_control(
                &first_id,
                &serde_json::to_vec(&stale_close).unwrap(),
                None,
                fixture.now,
                20_001,
            ),
            Err(RelayError::Connection)
        );
        assert!(!fixture.core.channels.contains_key(&next_channel));
    }
}
