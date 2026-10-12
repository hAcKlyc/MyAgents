//! Explicit one-shot device-channel probe. No operation, mount permit or business send.
use crate::{
    agent_network::{
        account::NetworkAccountSession,
        account_operation::AccountOperation,
        connection::{initial_hello, send},
        identity::NetworkIdentity,
        memory::MemoryBudget,
        pairs::{Offer, Pairs},
        policy,
        transport::{NetworkRoute, NetworkTransport},
        NetworkError,
    },
    connector,
    state::Owner,
};
use futures_util::{SinkExt, StreamExt};
use myagents_agent_network_protocol::{
    budget, ClientMessage, ConnectionScope, DeviceScope, ServerEnvelope, ServerMessage,
};
use serde::Serialize;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::Message;

#[derive(Serialize, Default)]
pub(crate) struct Report {
    status: &'static str,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    source_catalog_empty: bool,
    target_discovered: bool,
    target_identity_state_validated: bool,
    target_routing_without_agent_catalog: bool,
    open_sent: bool,
    offer_verified: bool,
    channel_ready: bool,
    tls_frames_sent: usize,
    tls_frames_received: usize,
    foreign_offers_closed: usize,
    business_objects_sent: usize,
}
fn close_error(reason: &str) -> NetworkError {
    let error = NetworkError::cloud(reason, 400);
    if error.code == "NETWORK_ACCOUNT_UNAVAILABLE" {
        NetworkError::new("PROBE_CHANNEL_CLOSED")
    } else {
        error
    }
}
fn failed_report(mut report: Report, error: &NetworkError) -> Report {
    report.status = "failed";
    report.error_code = Some(NetworkError::cloud(&error.code, 400).code);
    report
}
fn emit_failure(report: Report, error: &NetworkError) {
    // Only this fixed projection is emitted; never format the raw server response.
    eprintln!("{}", serde_json::json!(failed_report(report, error)));
}
#[derive(Clone, PartialEq, Eq)]
struct Target {
    peer: DeviceScope,
    epoch: String,
    key_fingerprint: String,
    membership_revision: u64,
}
fn select_device<'a>(
    items: &'a [Value],
    id: &str,
    local: &DeviceScope,
) -> Result<&'a Value, NetworkError> {
    if id == local.device_id {
        return Err(NetworkError::new("TARGET_IS_LOCAL_DEVICE"));
    }
    let mut matches = items.iter().filter(|v| v["deviceId"] == id);
    let target = matches
        .next()
        .ok_or_else(|| NetworkError::new("TARGET_DEVICE_UNKNOWN"))?;
    if matches.next().is_some() {
        return Err(NetworkError::new("TARGET_DEVICE_AMBIGUOUS"));
    }
    if target["principalId"] != local.principal_id || target["networkId"] != local.network_id {
        return Err(NetworkError::new("TARGET_SCOPE_MISMATCH"));
    }
    if target["joined"] != true || target["connectionState"] != "ready" {
        return Err(NetworkError::new("TARGET_DEVICE_NOT_READY"));
    }
    Ok(target)
}
fn target_from_identity(
    value: &Value,
    device: &Value,
    local: &DeviceScope,
) -> Result<Target, NetworkError> {
    myagents_agent_network_protocol::validate_identity_state(value)
        .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
    let state: myagents_agent_network_protocol::IdentityState =
        serde_json::from_value(value.clone())
            .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
    let id = device["deviceId"]
        .as_str()
        .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?;
    // Cross-bind issuer identity to the authenticated same-account Devices row.
    select_device(std::slice::from_ref(device), id, local)?;
    if state.service_id != local.service_id
        || state.environment != local.environment
        || state.device_id != id
    {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    let (generation, fingerprint) = match (state.key_generation, state.key_fingerprint) {
        (Some(generation), Some(fingerprint)) => (generation, fingerprint),
        (None, None) => return Err(NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE")),
        _ => return Err(NetworkError::new("IDENTITY_STATE_INVALID")),
    };
    let epoch = device["catalogEpoch"]
        .as_str()
        .filter(|epoch| {
            uuid::Uuid::parse_str(epoch)
                .map(|id| id.to_string())
                .as_deref()
                == Ok(*epoch)
        })
        .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?;
    let mut peer = local.clone();
    peer.device_id = id.into();
    peer.key_generation = generation;
    Ok(Target {
        peer,
        epoch: epoch.into(),
        key_fingerprint: fingerprint,
        membership_revision: device["membershipRevision"]
            .as_u64()
            .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?,
    })
}
async fn read_target_identity(
    identity: &NetworkIdentity,
    device: &Value,
    local: &DeviceScope,
) -> Result<Target, NetworkError> {
    let id = device["deviceId"]
        .as_str()
        .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?;
    let value = identity
        .account
        .request(AccountOperation::IdentityState(id.into()), None)
        .await?;
    target_from_identity(&value, device, local)
}
fn expected_offer(
    offer: &Offer,
    local: &DeviceScope,
    scope: &ConnectionScope,
    target: &Target,
) -> Result<(), NetworkError> {
    offer.validate_scope(local, &scope.connection_epoch)?;
    let (peer, epoch) = if offer.initiator == *local {
        (&offer.responder, &offer.responder_epoch)
    } else {
        (&offer.initiator, &offer.initiator_epoch)
    };
    if peer != &target.peer || epoch != &target.epoch {
        return Err(NetworkError::new("TARGET_SCOPE_MISMATCH"));
    }
    Ok(())
}
async fn pages(transport: &NetworkTransport, token: &str) -> Result<Vec<Value>, NetworkError> {
    let mut all = Vec::new();
    let mut cursor = None::<String>;
    loop {
        let route = NetworkRoute::Devices {
            cursor: cursor.as_deref(),
            limit: budget("pageMax"),
        };
        let page = transport.json(route, token, None).await?;
        let items = page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
        if all.len() + items.len() > budget("catalogItems") {
            return Err(NetworkError::new("CATALOG_CAPACITY"));
        }
        all.extend(items.iter().cloned());
        if page["complete"] == true {
            return Ok(all);
        }
        let next = page["nextCursor"]
            .as_str()
            .ok_or_else(|| NetworkError::new("NETWORK_PAGE_INVALID"))?;
        if cursor.as_deref() == Some(next) || items.is_empty() {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next.into());
    }
}
fn message_type(message: &ServerMessage) -> &'static str {
    match message {
        ServerMessage::Hello { .. } => "hello.result",
        ServerMessage::AuthRefreshed { .. } => "auth.refreshed",
        ServerMessage::Ready { .. } => "ready.result",
        ServerMessage::ChannelOffer { .. } => "channel.offer",
        ServerMessage::ChannelAccepted { .. } => "channel.accepted",
        ServerMessage::Credit { .. } => "credit.available",
        ServerMessage::ChannelReady { .. } => "channel.ready",
        ServerMessage::ChannelClosed { .. } => "channel.closed",
        ServerMessage::OpPrepared { .. } => "op.prepared",
        ServerMessage::Permit { .. } => "permit.result",
        ServerMessage::RouteClosed { .. } => "route.closed",
        ServerMessage::RouteOpened { .. } => "route.opened",
        ServerMessage::RouteRebound { .. } => "route.rebound",
        ServerMessage::Changed { .. } => "change.available",
        ServerMessage::Error { .. } => "error",
    }
}
fn change_scope(change: &myagents_agent_network_protocol::ChangeScope) -> &'static str {
    use myagents_agent_network_protocol::ChangeScope;
    match change {
        ChangeScope::Settings => "settings",
        ChangeScope::Catalog => "catalog",
        ChangeScope::Presence => "presence",
        ChangeScope::Roster => "roster",
    }
}
fn require_same_target(expected: &Target, fresh: &Target) -> Result<(), NetworkError> {
    if expected != fresh {
        return Err(NetworkError::new("TARGET_ROUTING_CHANGED"));
    }
    Ok(())
}
fn control_projection(stage: &'static str, message: &ServerMessage) -> Value {
    let mut projection = serde_json::json!({"stage":stage,"type":message_type(message)});
    if let ServerMessage::Changed { change, .. } = message {
        projection["changeScope"] = change_scope(change).into();
    }
    projection
}
fn trace_control(stage: &'static str, message: &ServerMessage) {
    eprintln!("{}", control_projection(stage, message));
}
fn require_joined(joined: bool) -> Result<(), NetworkError> {
    if !joined {
        return Err(NetworkError::new("SOURCE_DEVICE_NOT_JOINED"));
    }
    Ok(())
}
fn require_empty_source(page: &Value) -> Result<(), NetworkError> {
    let items = page["items"]
        .as_array()
        .ok_or_else(|| NetworkError::new("SOURCE_CATALOG_INVALID"))?;
    if !items.is_empty() {
        return Err(NetworkError::new("SOURCE_CATALOG_NOT_EMPTY"));
    }
    if page["complete"] != true {
        return Err(NetworkError::new("SOURCE_CATALOG_INVALID"));
    }
    Ok(())
}
pub(crate) async fn run(owner: Arc<Owner>, id: &str) -> Result<Report, NetworkError> {
    // Reserve one second for an explicit Close after a bounded handshake failure.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(29);
    let mut setup_phase = "identity";
    let setup = async {
        let account =
            NetworkAccountSession::Official(crate::auth::OfficialAccountSession::capture()?);
        let identity =
            NetworkIdentity::initialize_with_store(account, None, owner.store.clone()).await?;
        let memory = MemoryBudget::default();
        let transport =
            NetworkTransport::new(&identity.network_url, identity.device_key(), memory.clone())?;
        setup_phase = "initialHello";
        let mut socket = transport.websocket(&identity.token).await?;
        send(&mut socket, connector::hello()).await?;
        let (scope, local, _) = initial_hello(&mut socket, &identity).await?;
        // Inspect existing authority before any catalog PUT: this probe must never
        // replace an existing Agent source with its explicit zero-Agent catalog.
        setup_phase = "catalog";
        let existing = transport
            .json(
                NetworkRoute::Agents {
                    device_id: &local.device_id,
                    cursor: None,
                    limit: 1,
                },
                &identity.token,
                None,
            )
            .await?;
        require_empty_source(&existing)?;
        let uploaded = transport
            .json(
                NetworkRoute::Catalog,
                &identity.token,
                Some(connector::empty_catalog(scope.connection_epoch.clone())?),
            )
            .await?;
        if uploaded["catalogSeq"] != 1 {
            return Err(NetworkError::new("CATALOG_INVALID"));
        }
        setup_phase = "policy";
        let policy = policy::hydrate(&transport, &identity.token, &local).await?;
        require_joined(policy.joined)?;
        setup_phase = "ready";
        send(
            &mut socket,
            ClientMessage::Ready {
                scope: scope.clone(),
                catalog_seq: 1,
            },
        )
        .await?;
        let mut setup_controls = 0usize;
        let mut foreign_offers = 0usize;
        loop {
            identity.account.ensure_current()?;
            match socket.next().await {
                Some(Ok(Message::Ping(b))) => socket
                    .send(Message::Pong(b))
                    .await
                    .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Text(t))) if t == "ma-network-pong" => {}
                Some(Ok(Message::Text(t))) => {
                    setup_controls += 1;
                    if setup_controls > 256 {
                        return Err(NetworkError::new("PROBE_CAPACITY"));
                    }
                    let envelope = ServerEnvelope::parse(t.as_bytes())
                        .map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
                    connector::control_gate(&envelope.message, &scope, true, true)?;
                    match envelope.message {
                        ServerMessage::Ready { catalog_seq: 1, .. } => break,
                        ServerMessage::ChannelOffer { channel_id, .. } => {
                            foreign_offers += 1;
                            if foreign_offers > 16 {
                                return Err(NetworkError::new("PROBE_CAPACITY"));
                            }
                            send(
                                &mut socket,
                                ClientMessage::Close {
                                    scope: scope.clone(),
                                    channel_id,
                                    reason: "TARGET_UNAVAILABLE".into(),
                                },
                            )
                            .await?;
                        }
                        ServerMessage::Error { code, .. } => {
                            return Err(NetworkError::cloud(&code, 400))
                        }
                        message @ ServerMessage::Changed { .. } => {
                            trace_control("ready", &message);
                            let fresh =
                                policy::hydrate(&transport, &identity.token, &local).await?;
                            require_joined(fresh.joined)?;
                        }
                        unexpected => {
                            trace_control("ready", &unexpected);
                            return Err(NetworkError::new("CONTROL_UNEXPECTED"));
                        }
                    }
                }
                _ => return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED")),
            }
        }
        setup_phase = "targetlookup";
        let devices = pages(&transport, &identity.token).await?;
        let device = select_device(&devices, id, &local)?;
        let target = read_target_identity(&identity, device, &local).await?;
        Ok((
            identity,
            socket,
            scope,
            local,
            target,
            memory,
            foreign_offers,
            transport,
        ))
    };
    let setup_result = tokio::time::timeout_at(deadline, setup)
        .await
        .map_err(|_| NetworkError::new("PROBE_DEADLINE_EXCEEDED"))
        .and_then(|result| result);
    let (mut identity, mut socket, scope, local, target, memory, foreign_offers, transport) =
        match setup_result {
            Ok(result) => result,
            Err(error) => {
                eprintln!(
                    "{}",
                    serde_json::json!({"status":"failed","phase":setup_phase,"errorCode":NetworkError::cloud(&error.code,400).code})
                );
                return Err(error);
            }
        };
    let channel_id = uuid::Uuid::new_v4().to_string();
    let mut report = Report {
        status: "channel-ready",
        source_catalog_empty: true,
        target_discovered: true,
        target_identity_state_validated: true,
        target_routing_without_agent_catalog: true,
        foreign_offers_closed: foreign_offers,
        ..Report::default()
    };
    let mut pairs = Pairs::new(memory);
    let handshake = async {
        send(
            &mut socket,
            ClientMessage::Open {
                scope: scope.clone(),
                channel_id: channel_id.clone(),
                target_device_id: target.peer.device_id.clone(),
                target_key_generation: target.peer.key_generation,
                target_connection_epoch: target.epoch.clone(),
                target_binding: None,
            },
        )
        .await?;
        report.open_sent = true;
        let mut pending: Option<Offer> = None;
        let mut controls = 0usize;
        loop {
            identity.account.ensure_current()?;
            if identity.access.exp <= jsonwebtoken::get_current_timestamp() {
                return Err(NetworkError::new("NETWORK_TOKEN_EXPIRED"));
            }
            while let Some(frame) = pairs.next_frame()? {
                report.tls_frames_sent += 1;
                if report.tls_frames_sent > 256 {
                    return Err(NetworkError::new("PROBE_CAPACITY"));
                }
                socket
                    .send(Message::Binary(frame))
                    .await
                    .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;
            }
            if !pairs.take_failures().is_empty() {
                return Err(NetworkError::new("PROBE_CHANNEL_FAILED"));
            }
            for ready in pairs.announce_ready() {
                send(
                    &mut socket,
                    ClientMessage::ChannelReady {
                        scope: scope.clone(),
                        channel_id: ready,
                    },
                )
                .await?;
            }
            match socket.next().await {
                Some(Ok(Message::Ping(b))) => socket
                    .send(Message::Pong(b))
                    .await
                    .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Text(t))) if t == "ma-network-pong" => {}
                Some(Ok(Message::Text(t))) => {
                    controls += 1;
                    if controls > 256 {
                        return Err(NetworkError::new("PROBE_CAPACITY"));
                    }
                    let envelope = ServerEnvelope::parse(t.as_bytes())
                        .map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
                    connector::control_gate(&envelope.message, &scope, true, true)?;
                    match envelope.message {
                        ServerMessage::ChannelOffer {
                            channel_id: offered,
                            initiator,
                            responder,
                            initiator_connection_epoch,
                            responder_connection_epoch,
                            initiator_binding,
                            responder_binding,
                            ..
                        } => {
                            if offered != channel_id {
                                report.foreign_offers_closed += 1;
                                if report.foreign_offers_closed > 16 {
                                    return Err(NetworkError::new("PROBE_CAPACITY"));
                                }
                                send(
                                    &mut socket,
                                    ClientMessage::Close {
                                        scope: scope.clone(),
                                        channel_id: offered,
                                        reason: "TARGET_UNAVAILABLE".into(),
                                    },
                                )
                                .await?;
                                continue;
                            }
                            if pending.is_some() || pairs.has_channel(&channel_id) {
                                return Err(NetworkError::new("CHANNEL_ID_REUSED"));
                            }
                            let offer = Offer {
                                channel_id: offered,
                                initiator,
                                responder,
                                initiator_epoch: initiator_connection_epoch,
                                responder_epoch: responder_connection_epoch,
                                initiator_binding,
                                responder_binding,
                            };
                            expected_offer(&offer, &local, &scope, &target)?;
                            pairs.reserve(&channel_id)?;
                            identity = identity.ensure_peer().await?;
                            let binding = identity
                                .peer
                                .as_ref()
                                .ok_or_else(|| NetworkError::new("NETWORK_CERTIFICATE_INVALID"))?
                                .signed_binding
                                .clone();
                            pending = Some(offer);
                            send(
                                &mut socket,
                                ClientMessage::Accept {
                                    scope: scope.clone(),
                                    channel_id: channel_id.clone(),
                                    signed_binding: binding,
                                },
                            )
                            .await?;
                        }
                        ServerMessage::ChannelAccepted {
                            channel_id: accepted,
                            initiator_binding,
                            responder_binding,
                            ..
                        } if accepted == channel_id => {
                            let mut offer = pending
                                .take()
                                .ok_or_else(|| NetworkError::new("CHANNEL_OFFER_MISSING"))?;
                            pairs.accepted(&channel_id)?;
                            offer.initiator_binding = Some(initiator_binding);
                            offer.responder_binding = Some(responder_binding);
                            let verified = offer
                                .verify(&identity, &local, &scope.connection_epoch)
                                .await?;
                            pairs.install(verified, &local, &scope.connection_epoch)?;
                            report.offer_verified = true;
                        }
                        ServerMessage::Credit {
                            channel_id: credit,
                            sequence,
                            received_bytes,
                            ..
                        } if credit == channel_id => {
                            pairs.credit(&credit, sequence, received_bytes)?
                        }
                        ServerMessage::ChannelReady {
                            channel_id: ready, ..
                        } if ready == channel_id => {
                            pairs.ready(&ready)?;
                            report.channel_ready = true;
                            return Ok(());
                        }
                        ServerMessage::ChannelClosed {
                            channel_id: closed,
                            reason,
                            ..
                        } if closed == channel_id => return Err(close_error(&reason)),
                        ServerMessage::Error { code, .. } => {
                            return Err(NetworkError::cloud(&code, 400))
                        }
                        message @ ServerMessage::Changed { .. } => {
                            trace_control("handshake", &message);
                            let fresh_policy =
                                policy::hydrate(&transport, &identity.token, &local).await?;
                            require_joined(fresh_policy.joined)?;
                            let devices = pages(&transport, &identity.token).await?;
                            let fresh_device = select_device(&devices, id, &local)?;
                            let fresh_target =
                                read_target_identity(&identity, fresh_device, &local).await?;
                            require_same_target(&target, &fresh_target)?;
                            // Continue the original single Open only after fresh authority
                            // confirms unchanged routing. No business retry or re-PUT.
                            identity.account.ensure_current()?;
                        }
                        unexpected => {
                            trace_control("handshake", &unexpected);
                            return Err(NetworkError::new("CONTROL_UNEXPECTED"));
                        }
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    report.tls_frames_received += 1;
                    if report.tls_frames_received > 256 {
                        return Err(NetworkError::new("PROBE_CAPACITY"));
                    }
                    let (id, payload) = myagents_agent_network_protocol::decode_tls_frame(&bytes)
                        .map_err(|_| NetworkError::new("TLS_FRAME_INVALID"))?;
                    if id != channel_id {
                        return Err(NetworkError::new("PROBE_FOREIGN_FRAME"));
                    }
                    let (objects, _allocation) = pairs.feed(&id, payload)?;
                    if !objects.is_empty() {
                        return Err(NetworkError::new("PROBE_BUSINESS_REJECTED"));
                    }
                    let (sequence, received_bytes) = pairs.release_credit(&id, bytes.len())?;
                    send(
                        &mut socket,
                        ClientMessage::Credit {
                            scope: scope.clone(),
                            channel_id: id,
                            sequence,
                            received_bytes,
                        },
                    )
                    .await?;
                }
                _ => return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED")),
            }
        }
    };
    let result = tokio::time::timeout_at(deadline, handshake)
        .await
        .map_err(|_| NetworkError::new("PROBE_DEADLINE_EXCEEDED"))
        .and_then(|v| v);
    let close = ClientMessage::Close {
        scope,
        channel_id,
        reason: "PROBE_FINISHED".into(),
    };
    let closed = tokio::time::timeout(Duration::from_secs(1), send(&mut socket, close)).await;
    if let Err(error) = result {
        emit_failure(report, &error);
        return Err(error);
    }
    let closed = closed
        .map_err(|_| NetworkError::new("PROBE_CLOSE_UNCONFIRMED"))
        .and_then(|result| result.map(|_| ()));
    if let Err(error) = closed {
        emit_failure(report, &error);
        return Err(error);
    }
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn local() -> DeviceScope {
        DeviceScope {
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            network_id: "00000000-0000-0000-0000-000000000002".into(),
            environment: "development".into(),
            principal_id: "isolated".into(),
            device_id: "00000000-0000-0000-0000-000000000003".into(),
            key_generation: 1,
        }
    }
    fn device() -> Value {
        json!({"deviceId":"00000000-0000-0000-0000-000000000004","principalId":"isolated","networkId":local().network_id,"joined":true,"connectionState":"ready","membershipRevision":2,"catalogEpoch":"00000000-0000-0000-0000-000000000005"})
    }
    fn routing() -> Value {
        json!({"serviceId":local().service_id,"environment":local().environment,"deviceId":device()["deviceId"],"keyGeneration":3,"keyFingerprint":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
    }
    #[test]
    fn changed_revalidation_allows_only_exact_original_target_snapshot() {
        let target = target_from_identity(&routing(), &device(), &local()).unwrap();
        require_same_target(&target, &target.clone()).unwrap();
        let mut changes = Vec::new();
        let mut changed = target.clone();
        changed.peer.key_generation += 1;
        changes.push(changed);
        let mut changed = target.clone();
        changed.epoch = "changed-epoch".into();
        changes.push(changed);
        let mut changed = target.clone();
        changed.membership_revision += 1;
        changes.push(changed);
        let mut changed = target.clone();
        changed.key_fingerprint = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".into();
        changes.push(changed);
        let mut changed = target.clone();
        changed.peer.principal_id = "foreign".into();
        changes.push(changed);
        let mut changed = target.clone();
        changed.peer.network_id = "foreign".into();
        changes.push(changed);
        let mut changed = target.clone();
        changed.peer.device_id = "foreign".into();
        changes.push(changed);
        for changed in changes {
            assert_eq!(
                require_same_target(&target, &changed).unwrap_err().code,
                "TARGET_ROUTING_CHANGED"
            );
        }
        use myagents_agent_network_protocol::ChangeScope;
        for (value, name) in [
            (ChangeScope::Settings, "settings"),
            (ChangeScope::Catalog, "catalog"),
            (ChangeScope::Presence, "presence"),
            (ChangeScope::Roster, "roster"),
        ] {
            assert_eq!(change_scope(&value), name);
        }
    }
    #[test]
    fn changed_diagnostics_use_only_static_type_and_rehydrated_join_gate() {
        let scope = ConnectionScope {
            service_id: local().service_id,
            network_id: local().network_id,
            boot_epoch: "boot".into(),
            connection_epoch: "epoch".into(),
        };
        let changed = ServerMessage::Changed {
            scope,
            change: myagents_agent_network_protocol::ChangeScope::Catalog,
            revision: 999,
        };
        assert_eq!(message_type(&changed), "change.available");
        let projection = control_projection("ready", &changed);
        assert_eq!(projection.as_object().unwrap().len(), 3);
        assert_eq!(projection["changeScope"], "catalog");
        assert!(!projection.to_string().contains("999"));
        require_joined(true).unwrap();
        assert_eq!(
            require_joined(false).unwrap_err().code,
            "SOURCE_DEVICE_NOT_JOINED"
        );
        let error = ServerMessage::Error {
            code: "not-to-be-printed".into(),
            retryable: false,
        };
        assert_eq!(message_type(&error), "error");
    }
    #[test]
    fn source_catalog_getter_requires_explicit_complete_empty_page_before_put() {
        require_empty_source(&json!({"items":[], "complete":true})).unwrap();
        assert_eq!(
            require_empty_source(&json!({"items":[{"mount":"nonsecret"}], "complete":true}))
                .unwrap_err()
                .code,
            "SOURCE_CATALOG_NOT_EMPTY"
        );
        for page in [
            Value::Null,
            json!({}),
            json!({"items":null,"complete":true}),
            json!({"items":[],"complete":false}),
            json!({"items":[]}),
            json!({"items":[],"complete":"true"}),
        ] {
            assert_eq!(
                require_empty_source(&page).unwrap_err().code,
                "SOURCE_CATALOG_INVALID"
            );
        }
    }
    #[test]
    fn unknown_foreign_unjoined_offline_and_self_targets_are_rejected() {
        let id = device()["deviceId"].as_str().unwrap().to_owned();
        assert_eq!(
            select_device(&[], &id, &local()).unwrap_err().code,
            "TARGET_DEVICE_UNKNOWN"
        );
        for (key, value, code) in [
            ("principalId", json!("foreign"), "TARGET_SCOPE_MISMATCH"),
            ("networkId", json!("foreign"), "TARGET_SCOPE_MISMATCH"),
            ("joined", json!(false), "TARGET_DEVICE_NOT_READY"),
            (
                "connectionState",
                json!("offline"),
                "TARGET_DEVICE_NOT_READY",
            ),
        ] {
            let mut row = device();
            row[key] = value;
            assert_eq!(select_device(&[row], &id, &local()).unwrap_err().code, code);
        }
        assert_eq!(
            select_device(&[], &local().device_id, &local())
                .unwrap_err()
                .code,
            "TARGET_IS_LOCAL_DEVICE"
        );
        assert_eq!(
            select_device(&[device(), device()], &id, &local())
                .unwrap_err()
                .code,
            "TARGET_DEVICE_AMBIGUOUS"
        );
    }
    #[test]
    fn identity_routing_rejects_bad_schema_scope_null_pair_and_generation_boundaries() {
        for invalid in [Value::Null, json!({})] {
            assert!(target_from_identity(&invalid, &device(), &local()).is_err());
        }
        for (key, values) in [
            (
                "keyGeneration",
                vec![
                    json!(0),
                    json!(-1),
                    json!(9007199254740992u64),
                    json!(1.5),
                    json!("3"),
                ],
            ),
            ("keyFingerprint", vec![json!(""), json!("bad"), json!(3)]),
        ] {
            for value in values {
                let mut state = routing();
                state[key] = value;
                assert_eq!(
                    target_from_identity(&state, &device(), &local())
                        .err()
                        .unwrap()
                        .code,
                    "IDENTITY_STATE_INVALID"
                );
            }
        }
        let mut absent = routing();
        absent["keyGeneration"] = Value::Null;
        absent["keyFingerprint"] = Value::Null;
        assert_eq!(
            target_from_identity(&absent, &device(), &local())
                .err()
                .unwrap()
                .code,
            "TARGET_ROUTING_METADATA_UNAVAILABLE"
        );
        for key in ["keyGeneration", "keyFingerprint"] {
            let mut state = routing();
            state[key] = Value::Null;
            assert_eq!(
                target_from_identity(&state, &device(), &local())
                    .err()
                    .unwrap()
                    .code,
                "IDENTITY_STATE_INVALID"
            );
            state.as_object_mut().unwrap().remove(key);
            assert!(target_from_identity(&state, &device(), &local()).is_err());
        }
        for (key, value) in [
            ("serviceId", json!(local().network_id)),
            ("environment", json!("production")),
            ("deviceId", json!(local().device_id)),
        ] {
            let mut state = routing();
            state[key] = value;
            assert_eq!(
                target_from_identity(&state, &device(), &local())
                    .err()
                    .unwrap()
                    .code,
                "IDENTITY_SCOPE_MISMATCH"
            );
        }
        let mut extra = routing();
        extra["unexpected"] = true.into();
        assert!(target_from_identity(&extra, &device(), &local()).is_err());
        let mut boundary = routing();
        boundary["keyGeneration"] = json!(9007199254740991u64);
        assert_eq!(
            target_from_identity(&boundary, &device(), &local())
                .unwrap()
                .peer
                .key_generation,
            9007199254740991u64
        );
        for key in ["catalogEpoch", "membershipRevision"] {
            let mut row = device();
            row[key] = Value::Null;
            assert!(target_from_identity(&routing(), &row, &local()).is_err());
        }
    }
    #[test]
    fn zero_agent_source_opens_only_a_device_channel_without_mount_operation_or_permit() {
        let target = target_from_identity(&routing(), &device(), &local()).unwrap();
        let scope = ConnectionScope {
            service_id: local().service_id,
            network_id: local().network_id,
            boot_epoch: "00000000-0000-0000-0000-000000000006".into(),
            connection_epoch: "00000000-0000-0000-0000-000000000007".into(),
        };
        let empty = connector::empty_catalog(scope.connection_epoch.clone()).unwrap();
        assert_eq!(empty["items"], json!([]));
        let open = serde_json::to_value(ClientMessage::Open {
            scope,
            channel_id: "00000000-0000-0000-0000-000000000008".into(),
            target_device_id: target.peer.device_id,
            target_key_generation: target.peer.key_generation,
            target_connection_epoch: target.epoch,
            target_binding: None,
        })
        .unwrap();
        assert_eq!(open["type"], "channel.open");
        assert_eq!(open["targetBinding"], Value::Null);
        for key in ["targetMountId", "opId", "operation", "permit"] {
            assert!(open.get(key).is_none());
        }
        let report = serde_json::to_value(Report::default()).unwrap();
        assert_eq!(report["business_objects_sent"], 0);
        for key in [
            "token",
            "binding",
            "certificate",
            "target_device_id",
            "connection_epoch",
            "key_fingerprint",
            "keyFingerprint",
        ] {
            assert!(report.get(key).is_none());
        }
    }
    #[test]
    fn closure_codes_and_failed_stage_projection_are_safe_and_preserve_evidence() {
        assert_eq!(close_error("TARGET_NOT_READY").code, "TARGET_NOT_READY");
        for raw in [
            "",
            "secret-url?capability=example",
            "lowercase",
            "NEW\nLINE",
        ] {
            assert_eq!(close_error(raw).code, "PROBE_CHANNEL_CLOSED");
        }
        let report = Report {
            open_sent: true,
            offer_verified: true,
            tls_frames_sent: 3,
            tls_frames_received: 2,
            ..Report::default()
        };
        let value =
            serde_json::to_value(failed_report(report, &close_error("TARGET_NOT_READY"))).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["errorCode"], "TARGET_NOT_READY");
        assert_eq!(value["open_sent"], true);
        assert_eq!(value["offer_verified"], true);
        assert_eq!(value["channel_ready"], false);
        assert_eq!(value["tls_frames_sent"], 3);
        assert_eq!(value["tls_frames_received"], 2);
        assert_eq!(value["business_objects_sent"], 0);
        let mut unsafe_error = NetworkError::new("PROBE_CHANNEL_CLOSED");
        unsafe_error.code = "unexpected unsafe detail".into();
        let value = serde_json::to_value(failed_report(Report::default(), &unsafe_error)).unwrap();
        assert_eq!(value["errorCode"], "NETWORK_ACCOUNT_UNAVAILABLE");
        assert!(!value.to_string().contains("unexpected unsafe detail"));
    }
    #[test]
    fn signed_offer_still_must_target_the_selected_device_and_epoch() {
        let target = target_from_identity(&routing(), &device(), &local()).unwrap();
        let scope = ConnectionScope {
            service_id: local().service_id,
            network_id: local().network_id,
            boot_epoch: "boot".into(),
            connection_epoch: "local-epoch".into(),
        };
        let mut offer = Offer {
            channel_id: "channel".into(),
            initiator: local(),
            responder: target.peer.clone(),
            initiator_epoch: scope.connection_epoch.clone(),
            responder_epoch: target.epoch.clone(),
            initiator_binding: None,
            responder_binding: None,
        };
        expected_offer(&offer, &local(), &scope, &target).unwrap();
        offer.responder_epoch = "stale".into();
        assert!(expected_offer(&offer, &local(), &scope, &target).is_err());
        offer.responder_epoch = target.epoch.clone();
        offer.responder.device_id = "unknown".into();
        assert!(expected_offer(&offer, &local(), &scope, &target).is_err());
        offer.responder = target.peer;
        offer.responder.principal_id = "foreign".into();
        assert!(expected_offer(
            &offer,
            &local(),
            &scope,
            &target_from_identity(&routing(), &device(), &local()).unwrap()
        )
        .is_err());
    }
}
