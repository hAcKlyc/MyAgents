//! Explicit one-shot device-channel probe. No operation, mount permit or business send.
use crate::{
    agent_network::{
        account::NetworkAccountSession,
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
    binding: Option<String>,
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
fn select_routing(
    items: &[Value],
    device: &Value,
    local: &DeviceScope,
) -> Result<Target, NetworkError> {
    let mut selected: Option<Target> = None;
    for item in items.iter().filter(|v| v["deviceId"] == device["deviceId"]) {
        if item["source"]["serviceId"] != local.service_id
            || item["source"]["networkId"] != local.network_id
            || item["isLocal"] != false
            || item["membershipRevision"] != device["membershipRevision"]
            || item["connectionEpoch"] != device["catalogEpoch"]
        {
            return Err(NetworkError::new("TARGET_ROUTING_SCOPE_MISMATCH"));
        }
        let generation = item["keyGeneration"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?;
        let epoch = item["connectionEpoch"]
            .as_str()
            .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?;
        let binding = match item.get("signedBinding") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            _ => return Err(NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE")),
        };
        let mut peer = local.clone();
        peer.device_id = device["deviceId"]
            .as_str()
            .ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))?
            .into();
        peer.key_generation = generation;
        let target = Target {
            peer,
            epoch: epoch.into(),
            binding,
        };
        if selected.as_ref().is_some_and(|old| old != &target) {
            return Err(NetworkError::new("TARGET_ROUTING_METADATA_AMBIGUOUS"));
        }
        selected = Some(target);
    }
    selected.ok_or_else(|| NetworkError::new("TARGET_ROUTING_METADATA_UNAVAILABLE"))
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
async fn pages(
    transport: &NetworkTransport,
    token: &str,
    network: Option<&str>,
) -> Result<Vec<Value>, NetworkError> {
    let mut all = Vec::new();
    let mut cursor = None::<String>;
    loop {
        let route = match network {
            Some(id) => NetworkRoute::Callable {
                network_id: id,
                cursor: cursor.as_deref(),
                limit: budget("pageMax"),
            },
            None => NetworkRoute::Devices {
                cursor: cursor.as_deref(),
                limit: budget("pageMax"),
            },
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
    let setup = async {
        let account =
            NetworkAccountSession::Official(crate::auth::OfficialAccountSession::capture()?);
        let identity =
            NetworkIdentity::initialize_with_store(account, None, owner.store.clone()).await?;
        let memory = MemoryBudget::default();
        let transport =
            NetworkTransport::new(&identity.network_url, identity.device_key(), memory.clone())?;
        let mut socket = transport.websocket(&identity.token).await?;
        send(&mut socket, connector::hello()).await?;
        let (scope, local, _) = initial_hello(&mut socket, &identity).await?;
        // Inspect existing authority before any catalog PUT: this probe must never
        // replace an existing Agent source with its explicit zero-Agent catalog.
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
        let policy = policy::hydrate(&transport, &identity.token, &local).await?;
        if !policy.joined {
            return Err(NetworkError::new("SOURCE_DEVICE_NOT_JOINED"));
        }
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
                        _ => return Err(NetworkError::new("CONTROL_UNEXPECTED")),
                    }
                }
                _ => return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED")),
            }
        }
        let devices = pages(&transport, &identity.token, None).await?;
        let device = select_device(&devices, id, &local)?;
        let callable = pages(&transport, &identity.token, Some(&local.network_id)).await?;
        let target = select_routing(&callable, device, &local)?;
        Ok((
            identity,
            socket,
            scope,
            local,
            target,
            memory,
            foreign_offers,
        ))
    };
    let (mut identity, mut socket, scope, local, target, memory, foreign_offers) =
        tokio::time::timeout_at(deadline, setup)
            .await
            .map_err(|_| NetworkError::new("PROBE_DEADLINE_EXCEEDED"))??;
    let channel_id = uuid::Uuid::new_v4().to_string();
    let mut report = Report {
        status: "channel-ready",
        source_catalog_empty: true,
        target_discovered: true,
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
                target_binding: target.binding.clone(),
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
                        _ => return Err(NetworkError::new("CONTROL_UNEXPECTED")),
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
        json!({"deviceId":device()["deviceId"],"source":{"serviceId":local().service_id,"networkId":local().network_id},"isLocal":false,"membershipRevision":2,"connectionEpoch":device()["catalogEpoch"],"keyGeneration":3,"signedBinding":"nonsecret-selection-fixture"})
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
    fn absent_routing_never_guesses_generation_and_conflicting_routing_is_closed() {
        assert!(
            matches!(select_routing(&[],&device(),&local()),Err(e) if e.code=="TARGET_ROUTING_METADATA_UNAVAILABLE")
        );
        let first = routing();
        let mut other = first.clone();
        other["keyGeneration"] = json!(4);
        assert!(
            matches!(select_routing(&[first,other],&device(),&local()),Err(e) if e.code=="TARGET_ROUTING_METADATA_AMBIGUOUS")
        );
        {
            let mut row = routing();
            row["keyGeneration"] = Value::Null;
            assert!(
                matches!(select_routing(&[row],&device(),&local()),Err(e) if e.code=="TARGET_ROUTING_METADATA_UNAVAILABLE")
            );
        }
        let mut lazy = routing();
        lazy["signedBinding"] = Value::Null;
        assert!(select_routing(&[lazy], &device(), &local())
            .unwrap()
            .binding
            .is_none());
        for invalid in [json!(""), json!(1), json!({})] {
            let mut row = routing();
            row["signedBinding"] = invalid;
            assert!(select_routing(&[row], &device(), &local()).is_err());
        }
        let mut missing = routing();
        missing.as_object_mut().unwrap().remove("signedBinding");
        assert!(select_routing(&[missing], &device(), &local()).is_err());
        let mut row = routing();
        row["connectionEpoch"] = json!("stale");
        assert!(
            matches!(select_routing(&[row],&device(),&local()),Err(e) if e.code=="TARGET_ROUTING_SCOPE_MISMATCH")
        );
    }
    #[test]
    fn zero_agent_source_opens_only_a_device_channel_without_mount_operation_or_permit() {
        let mut lazy = routing();
        lazy["signedBinding"] = Value::Null;
        let target = select_routing(&[lazy], &device(), &local()).unwrap();
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
            target_binding: target.binding,
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
        let target = select_routing(&[routing()], &device(), &local()).unwrap();
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
            &select_routing(&[routing()], &device(), &local()).unwrap()
        )
        .is_err());
    }
}
