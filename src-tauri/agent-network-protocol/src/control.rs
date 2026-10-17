//! Typed control dispatch. Shared JSON schemas remain the wire authority;
//! variants make omitted handling a compiler error rather than silent fallthrough.
use crate::{budget, validate_control, validate_server_control, DeviceScope, ProtocolError};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionScope {
    pub service_id: String,
    pub network_id: String,
    pub boot_epoch: String,
    pub connection_epoch: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEnvelope {
    pub version: u8,
    pub control_id: String,
    #[serde(flatten)]
    pub message: ServerMessage,
}
impl ServerEnvelope {
    pub fn parse(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() > budget("controlBytes") {
            return Err(ProtocolError("CONTROL_TOO_LARGE"));
        }
        let value = serde_json::from_slice(bytes).map_err(|_| ProtocolError("CONTROL_INVALID"))?;
        validate_server_control(&value)?;
        serde_json::from_value(value).map_err(|_| ProtocolError("CONTROL_INVALID"))
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ServerMessage {
    #[serde(rename = "hello.result")]
    Hello {
        #[serde(flatten)]
        scope: ConnectionScope,
        identity: DeviceScope,
        network_revision: u64,
        membership_revision: u64,
        connector_nonce: String,
    },
    #[serde(rename = "auth.refreshed")]
    AuthRefreshed {
        #[serde(flatten)]
        scope: ConnectionScope,
        expires_at: u64,
    },
    #[serde(rename = "ready.result")]
    Ready {
        #[serde(flatten)]
        scope: ConnectionScope,
        catalog_seq: u64,
    },
    #[serde(rename = "channel.offer")]
    ChannelOffer {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        initiator: DeviceScope,
        responder: DeviceScope,
        initiator_connection_epoch: String,
        responder_connection_epoch: String,
        initiator_binding: Option<String>,
        responder_binding: Option<String>,
    },
    #[serde(rename = "channel.accepted")]
    ChannelAccepted {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        initiator_binding: String,
        responder_binding: String,
    },
    #[serde(rename = "credit.available")]
    Credit {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        sequence: u64,
        received_bytes: u64,
    },
    #[serde(rename = "channel.ready")]
    ChannelReady {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
    },
    #[serde(rename = "channel.closed")]
    ChannelClosed {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        reason: String,
    },
    #[serde(rename = "op.prepared")]
    OpPrepared {
        #[serde(flatten)]
        scope: ConnectionScope,
        op_id: String,
        target_mount_id: String,
        target: DeviceScope,
        target_connection_epoch: String,
    },
    #[serde(rename = "permit.result")]
    Permit {
        #[serde(flatten)]
        scope: ConnectionScope,
        op_id: String,
        attempt_id: String,
        permit_id: String,
        source: DeviceScope,
        target: DeviceScope,
        source_connection_epoch: String,
        target_connection_epoch: String,
        target_mount_id: String,
        membership_revision: u64,
        enable_revision: u64,
        freshness_ms: u64,
        #[serde(default)]
        recoverable: bool,
        return_route_id: String,
    },
    #[serde(rename = "route.suspended")]
    RouteSuspended {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        remaining_ms: u64,
    },
    #[serde(rename = "route.resumed")]
    RouteResumed {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        source_connection_epoch: String,
        target_connection_epoch: String,
    },
    #[serde(rename = "route.closed")]
    RouteClosed {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        reason: String,
    },
    #[serde(rename = "route.opened")]
    RouteOpened {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        op_id: String,
        source: DeviceScope,
        target: DeviceScope,
        source_connection_epoch: String,
        target_connection_epoch: String,
        target_mount_id: String,
        #[serde(default)]
        recoverable: bool,
    },
    #[serde(rename = "route.rebound")]
    RouteRebound {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        channel_id: String,
    },
    #[serde(rename = "change.available")]
    Changed {
        #[serde(flatten)]
        scope: ConnectionScope,
        #[serde(rename = "scope")]
        change: ChangeScope,
        revision: u64,
    },
    #[serde(rename = "error")]
    Error { code: String, retryable: bool },
}
impl ServerMessage {
    pub fn scope(&self) -> Option<&ConnectionScope> {
        match self {
            Self::Hello { scope, .. }
            | Self::AuthRefreshed { scope, .. }
            | Self::Ready { scope, .. }
            | Self::ChannelOffer { scope, .. }
            | Self::ChannelAccepted { scope, .. }
            | Self::ChannelReady { scope, .. }
            | Self::Credit { scope, .. }
            | Self::ChannelClosed { scope, .. }
            | Self::OpPrepared { scope, .. }
            | Self::Permit { scope, .. }
            | Self::RouteClosed { scope, .. }
            | Self::RouteSuspended { scope, .. }
            | Self::RouteResumed { scope, .. }
            | Self::RouteOpened { scope, .. }
            | Self::RouteRebound { scope, .. }
            | Self::Changed { scope, .. } => Some(scope),
            Self::Error { .. } => None,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeScope {
    Settings,
    Catalog,
    Presence,
    Roster,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientEnvelope {
    pub version: u8,
    pub control_id: String,
    #[serde(flatten)]
    pub message: ClientMessage,
}
impl ClientEnvelope {
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let value = serde_json::to_value(self).map_err(|_| ProtocolError("CONTROL_INVALID"))?;
        validate_control(&value)?;
        let bytes = serde_json::to_vec(&value).map_err(|_| ProtocolError("CONTROL_INVALID"))?;
        if bytes.len() > budget("controlBytes") {
            return Err(ProtocolError("CONTROL_TOO_LARGE"));
        }
        Ok(bytes)
    }
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviousConnection {
    pub connection_epoch: String,
    pub connector_nonce: String,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello {
        client_version: String,
        capabilities: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        previous_connection: Option<PreviousConnection>,
    },
    #[serde(rename = "auth.refresh")]
    Refresh {
        #[serde(flatten)]
        scope: ConnectionScope,
        access_token: String,
    },
    #[serde(rename = "ready")]
    Ready {
        #[serde(flatten)]
        scope: ConnectionScope,
        catalog_seq: u64,
    },
    #[serde(rename = "channel.open")]
    Open {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        target_device_id: String,
        target_key_generation: u64,
        target_connection_epoch: String,
        target_binding: Option<String>,
    },
    #[serde(rename = "channel.accept")]
    Accept {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        signed_binding: String,
    },
    #[serde(rename = "channel.ready")]
    ChannelReady {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
    },
    #[serde(rename = "channel.close")]
    Close {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        reason: String,
    },
    #[serde(rename = "op.prepare")]
    Prepare {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        op_id: String,
        target_mount_id: String,
    },
    #[serde(rename = "op.release")]
    Release {
        #[serde(flatten)]
        scope: ConnectionScope,
        op_id: String,
    },
    #[serde(rename = "permit.acquire")]
    Permit {
        #[serde(flatten)]
        scope: ConnectionScope,
        op_id: String,
        attempt_id: String,
        target_mount_id: String,
        expected_membership_revision: u64,
        expected_enable_revision: u64,
    },
    #[serde(rename = "credit.release")]
    Credit {
        #[serde(flatten)]
        scope: ConnectionScope,
        channel_id: String,
        sequence: u64,
        received_bytes: u64,
    },
    #[serde(rename = "route.resume")]
    Resume {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
    },
    #[serde(rename = "route.rebind")]
    Rebind {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        channel_id: String,
    },
    #[serde(rename = "route.close")]
    CloseRoute {
        #[serde(flatten)]
        scope: ConnectionScope,
        return_route_id: String,
        reason: String,
    },
}
