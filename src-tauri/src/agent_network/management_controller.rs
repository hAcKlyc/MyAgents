//! One owned management request on the existing authenticated actor socket.
//! Route snapshots are not grants. The Host independently authorizes dispatch.
use super::{
    channel::ManagementEvent,
    connection::send,
    identity::NetworkIdentity,
    pairs::{Offer, Pairs},
    transport::{DeviceAddress, NetworkSocket, NetworkTransport},
    NetworkError,
};
use futures_util::{SinkExt, StreamExt};
use myagents_agent_network_protocol::{
    decode_tls_frame, ClientMessage, ConnectionScope, DeviceScope, ServerEnvelope, ServerMessage,
};
use myagents_host_management_protocol::{
    CanonicalUuid, Frame, ManagementMessage, ManagementMethod, RequestParams, ResponseResult,
    NAMESPACE, VERSION,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagementRequest {
    pub connection_id: String,
    pub auth_generation: u64,
    pub principal_id: String,
    pub network_id: String,
    pub device_id: String,
    /// First inspection discovers the signed target. Every later read/write
    /// stays bound to that target, including the original receipt lookup.
    #[serde(default)]
    pub target_scope: Option<DeviceScope>,
    pub method: ManagementMethod,
    pub params: RequestParams,
}
impl ManagementRequest {
    pub(crate) fn mutation(&self) -> bool {
        matches!(
            self.method,
            ManagementMethod::ConfigSet
                | ManagementMethod::CredentialSet
                | ManagementMethod::ResourcesCreate
                | ManagementMethod::ConfigProviderSet
                | ManagementMethod::CredentialProviderSet
                | ManagementMethod::ResourcesRegister
        )
    }
    pub(crate) fn message(&self, id: CanonicalUuid) -> Result<ManagementMessage, NetworkError> {
        if !matches!(
            self.method,
            ManagementMethod::HostSnapshot | ManagementMethod::HostCapabilities
        ) && self.target_scope.is_none()
        {
            return Err(NetworkError::new("HOST_MANAGEMENT_TARGET_REQUIRED"));
        }
        let message = ManagementMessage::Request {
            request_id: id,
            method: self.method,
            params: self.params.clone(),
        };
        Frame {
            namespace: NAMESPACE.into(),
            version: VERSION,
            sender_sequence: 1,
            channel_id: id,
            message: message.clone(),
        }
        .validate()
        .map_err(|_| NetworkError::new("HOST_MANAGEMENT_REQUEST_INVALID"))?;
        Ok(message)
    }
}

fn matches_target(request: &ManagementRequest, current: &DeviceScope) -> Result<(), NetworkError> {
    if request
        .target_scope
        .as_ref()
        .is_some_and(|expected| expected != current)
    {
        return Err(NetworkError::new("HOST_MANAGEMENT_TARGET_CHANGED"));
    }
    Ok(())
}
#[derive(Serialize)]
pub(crate) struct ManagementResponse {
    pub scope: DeviceScope,
    pub result: ResponseResult,
    #[serde(skip)]
    _allocation: super::memory::Allocation,
}

pub(crate) fn lost(mutation: bool, sent: bool) -> NetworkError {
    NetworkError::new(if mutation && sent {
        "HOST_MANAGEMENT_UNCONFIRMED"
    } else {
        "HOST_MANAGEMENT_NOT_COMPLETED"
    })
}
fn matches_offer(
    offer: &Offer,
    address: &DeviceAddress,
    local: &DeviceScope,
    epoch: &str,
) -> Result<(), NetworkError> {
    offer.validate_scope(local, epoch)?;
    let (peer, peer_epoch, binding) = if offer.initiator == *local {
        (
            &offer.responder,
            &offer.responder_epoch,
            &offer.responder_binding,
        )
    } else {
        (
            &offer.initiator,
            &offer.initiator_epoch,
            &offer.initiator_binding,
        )
    };
    if peer != &address.scope
        || peer_epoch != &address.connection_epoch
        || binding.as_deref() != Some(address.signed_binding.as_str())
    {
        return Err(NetworkError::new("HOST_MANAGEMENT_TARGET_CHANGED"));
    }
    Ok(())
}
fn mutation_matches(value: &impl serde::Serialize, id: CanonicalUuid) -> bool {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.get("mutationId").cloned())
        == serde_json::to_value(id).ok()
}
/// This code is emitted only after a READY, single read-only probe is retired.
pub(crate) fn isolated_unsupported_probe(
    request: &ManagementRequest,
    error: &NetworkError,
) -> bool {
    request.method == ManagementMethod::HostCapabilities
        && error.code == "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE"
}
fn response_matches(request: &ManagementRequest, result: &ResponseResult) -> bool {
    use myagents_host_management_protocol::{Owner, ProviderConfigReceipt, ResourceReceipt};
    match (request.method, &request.params, result) {
        (
            ManagementMethod::HostCapabilities,
            RequestParams::Snapshot(_),
            ResponseResult::Capabilities(_),
        ) => return true,
        (
            ManagementMethod::HostInspect,
            RequestParams::Snapshot(_),
            ResponseResult::ExtendedSnapshot(s),
        ) => return s.host_id.as_uuid().to_string() == request.device_id,
        (
            ManagementMethod::ResourcesDirectoryList,
            RequestParams::ResourcesDirectoryList(p),
            ResponseResult::DirectoryList(d),
        ) => return p.root_id == d.root_id && p.relative_path == d.relative_path,
        (
            ManagementMethod::ConfigProviderSet,
            RequestParams::ConfigProviderSet(p),
            ResponseResult::ProviderConfigReceipt(r),
        ) => {
            return match r {
                ProviderConfigReceipt::Persisted {
                    mutation_id,
                    settings,
                    ..
                } => *mutation_id == p.mutation_id && settings.provider_id == p.provider.id,
                ProviderConfigReceipt::Conflict { mutation_id, .. } => {
                    *mutation_id == p.mutation_id
                }
                ProviderConfigReceipt::NotFound { .. } => false,
            }
        }
        (
            ManagementMethod::CredentialProviderSet,
            RequestParams::CredentialSet(p),
            ResponseResult::ProviderCredentialReceipt(r),
        ) => return mutation_matches(r, p.mutation_id),
        (
            ManagementMethod::ReceiptProviderGet,
            RequestParams::ReceiptProviderGet(p),
            ResponseResult::ProviderCredentialReceipt(r),
        ) if p.owner == Owner::Credentials => return mutation_matches(r, p.mutation_id),
        (
            ManagementMethod::ReceiptProviderGet,
            RequestParams::ReceiptProviderGet(p),
            ResponseResult::ProviderConfigReceipt(r),
        ) if p.owner == Owner::Config => {
            return match r {
                ProviderConfigReceipt::Persisted {
                    mutation_id,
                    settings,
                    ..
                } => *mutation_id == p.mutation_id && settings.provider_id == p.provider_id,
                ProviderConfigReceipt::Conflict { mutation_id, .. }
                | ProviderConfigReceipt::NotFound { mutation_id } => *mutation_id == p.mutation_id,
            }
        }
        (
            ManagementMethod::ReceiptProviderGet,
            RequestParams::ReceiptProviderGet(p),
            ResponseResult::ReceiptNotFound { mutation_id, owner },
        ) => return p.mutation_id == *mutation_id && p.owner == *owner,
        (
            ManagementMethod::ResourcesRegister,
            RequestParams::ResourcesRegister(p),
            ResponseResult::ResourceReceipt(r),
        ) => {
            return !matches!(r, ResourceReceipt::NotFound { .. })
                && mutation_matches(r, p.mutation_id)
        }
        (_, _, ResponseResult::Error { .. }) => return true,
        (
            ManagementMethod::HostCapabilities
            | ManagementMethod::HostInspect
            | ManagementMethod::ConfigProviderSet
            | ManagementMethod::CredentialProviderSet
            | ManagementMethod::ReceiptProviderGet
            | ManagementMethod::ResourcesDirectoryList
            | ManagementMethod::ResourcesRegister,
            _,
            _,
        ) => return false,
        _ => {}
    }
    match (&request.params, result) {
        (_, ResponseResult::Error { .. }) => true,
        (RequestParams::Snapshot(_), ResponseResult::Snapshot(snapshot)) => {
            snapshot.host_id.as_uuid().to_string() == request.device_id
        }
        (
            RequestParams::ConfigSet(_),
            ResponseResult::ConfigReceipt(
                myagents_host_management_protocol::ConfigReceipt::NotFound { .. },
            ),
        ) => false,
        (RequestParams::ConfigSet(p), ResponseResult::ConfigReceipt(r)) => {
            serde_json::to_value(r)
                .ok()
                .and_then(|v| v.get("mutationId").cloned())
                == serde_json::to_value(p.mutation_id).ok()
        }
        (
            RequestParams::ResourcesCreate(_),
            ResponseResult::ResourceReceipt(
                myagents_host_management_protocol::ResourceReceipt::NotFound { .. },
            ),
        ) => false,
        (RequestParams::ResourcesCreate(p), ResponseResult::ResourceReceipt(r)) => {
            serde_json::to_value(r)
                .ok()
                .and_then(|v| v.get("mutationId").cloned())
                == serde_json::to_value(p.mutation_id).ok()
        }
        (RequestParams::CredentialSet(p), ResponseResult::CredentialReceipt(r)) => {
            serde_json::to_value(r)
                .ok()
                .and_then(|v| v.get("mutationId").cloned())
                == serde_json::to_value(p.mutation_id).ok()
        }
        (RequestParams::ReceiptGet(p), ResponseResult::CredentialReceipt(r))
            if p.owner == myagents_host_management_protocol::Owner::Credentials =>
        {
            serde_json::to_value(r)
                .ok()
                .and_then(|v| v.get("mutationId").cloned())
                == serde_json::to_value(p.mutation_id).ok()
        }
        (RequestParams::ReceiptGet(p), ResponseResult::ReceiptNotFound { mutation_id, owner }) => {
            p.mutation_id == *mutation_id && p.owner == *owner
        }
        (RequestParams::ReceiptGet(p), ResponseResult::ConfigReceipt(r))
            if p.owner == myagents_host_management_protocol::Owner::Config =>
        {
            serde_json::to_value(r)
                .ok()
                .and_then(|v| v.get("mutationId").cloned())
                == serde_json::to_value(p.mutation_id).ok()
        }
        (RequestParams::ReceiptGet(p), ResponseResult::ResourceReceipt(r))
            if p.owner == myagents_host_management_protocol::Owner::Resources =>
        {
            serde_json::to_value(r)
                .ok()
                .and_then(|v| v.get("mutationId").cloned())
                == serde_json::to_value(p.mutation_id).ok()
        }
        _ => false,
    }
}
fn consume(
    events: Vec<ManagementEvent>,
    request: &ManagementRequest,
    id: CanonicalUuid,
    sent: bool,
) -> Result<(bool, Option<ResponseResult>), NetworkError> {
    let mut ready = false;
    let mut response = None;
    for event in events {
        match event {
            ManagementEvent::Ready if !sent && !ready => ready = true,
            ManagementEvent::Response { request_id, result }
                if sent
                    && request_id == id
                    && response.is_none()
                    && response_matches(request, &result) =>
            {
                response = Some(result)
            }
            _ => return Err(NetworkError::new("HOST_MANAGEMENT_RESPONSE_INVALID")),
        }
    }
    Ok((ready, response))
}

fn queue_request(
    pairs: &mut Pairs,
    target: &str,
    message: ManagementMessage,
    queued: &mut bool,
) -> Result<(), NetworkError> {
    pairs.send_management(target, message)?;
    *queued = true;
    Ok(())
}
async fn handoff_frame<S: futures_util::Sink<Message> + Unpin>(
    socket: &mut S,
    frame: Vec<u8>,
    target: &str,
    queued: bool,
    sent: &AtomicBool,
) -> Result<(), NetworkError> {
    mark_frame_handoff(&frame, target, queued, sent)?;
    socket
        .send(Message::Binary(frame))
        .await
        .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))
}
fn mark_frame_handoff(
    frame: &[u8],
    target: &str,
    request_queued: bool,
    sent: &AtomicBool,
) -> Result<(), NetworkError> {
    let (channel, _) =
        decode_tls_frame(frame).map_err(|_| NetworkError::new("TLS_FRAME_INVALID"))?;
    if request_queued && channel == target {
        sent.store(true, Ordering::Release);
    }
    Ok(())
}
async fn flush_frames(
    socket: &mut NetworkSocket,
    pairs: &mut Pairs,
    target: &str,
    request_queued: bool,
    sent: &AtomicBool,
    frames: &mut usize,
) -> Result<(), NetworkError> {
    while let Some(frame) = pairs.next_frame()? {
        *frames += 1;
        if *frames > 256 {
            return Err(NetworkError::new("HOST_MANAGEMENT_CAPACITY"));
        }
        // Only the request-bearing ciphertext's transport handoff is uncertain.
        // A send failure can be partial, so mark immediately before awaiting it.
        handoff_frame(socket, frame, target, request_queued, sent).await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute(
    socket: &mut NetworkSocket,
    transport: &NetworkTransport,
    identity: &NetworkIdentity,
    local: &DeviceScope,
    scope: &ConnectionScope,
    pairs: &mut Pairs,
    request: &ManagementRequest,
    sent: Arc<AtomicBool>,
) -> Result<ManagementResponse, NetworkError> {
    if !identity.account.is_management_only()
        || request.connection_id != identity.account.binding_id()
        || request.principal_id != local.principal_id
        || request.network_id != local.network_id
    {
        return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
    }
    let channel = uuid::Uuid::new_v4().to_string();
    let request_id = CanonicalUuid::new(uuid::Uuid::new_v4());
    let message = request.message(request_id)?;
    pairs.reserve_management_retirement(&channel, scope, local)?;
    let mut known_to_peer = false;
    let mut unsupported_close = false;
    let mut peer_closed = false;
    let operation = async {
        identity.account.ensure_current()?;
        let identity = identity.clone().ensure_peer().await?;
        let address = transport
            .device_address(&identity.token, local, &request.device_id)
            .await?;
        matches_target(request, &address.scope)?;
        let mut verifier = identity.verifier.clone();
        let peer = verifier.peer(&address.signed_binding).await?;
        if peer.service_id != address.scope.service_id
            || peer.environment != address.scope.environment
            || peer.principal_id != address.scope.principal_id
            || peer.device_id != address.scope.device_id
            || peer.key_generation != address.scope.key_generation
        {
            return Err(NetworkError::new("HOST_ADDRESS_INVALID"));
        }
        identity.account.ensure_current()?;
        known_to_peer = true;
        send(
            socket,
            ClientMessage::Open {
                scope: scope.clone(),
                channel_id: channel.clone(),
                target_device_id: address.scope.device_id.clone(),
                target_key_generation: address.scope.key_generation,
                target_connection_epoch: address.connection_epoch.clone(),
                target_binding: Some(address.signed_binding.clone()),
            },
        )
        .await?;
        let mut offer = None;
        let mut controls = 0usize;
        let mut frames = 0usize;
        let mut events = Vec::new();
        let mut request_queued = false;
        let mut decoded_allocation = None;
        loop {
            identity.account.ensure_current()?;
            if identity.access.exp <= jsonwebtoken::get_current_timestamp() {
                return Err(NetworkError::new("NETWORK_TOKEN_EXPIRED"));
            }
            let (ready, result) = consume(
                std::mem::take(&mut events),
                request,
                request_id,
                sent.load(Ordering::Acquire),
            )?;
            if let Some(result) = result {
                return Ok(ManagementResponse {
                    scope: address.scope.clone(),
                    result,
                    _allocation: decoded_allocation
                        .take()
                        .ok_or_else(|| NetworkError::new("HOST_MANAGEMENT_RESPONSE_INVALID"))?,
                });
            }
            drop(decoded_allocation.take());
            if ready {
                let current = transport
                    .device_address(&identity.token, local, &request.device_id)
                    .await?;
                if current != address {
                    return Err(NetworkError::new("HOST_MANAGEMENT_TARGET_CHANGED"));
                }
                identity.account.ensure_current()?;
                // Flush remaining handshake output before queueing any request bytes.
                flush_frames(socket, pairs, &channel, false, &sent, &mut frames).await?;
                queue_request(pairs, &channel, message.clone(), &mut request_queued)?;
            }
            for id in pairs.announce_ready() {
                send(
                    socket,
                    ClientMessage::ChannelReady {
                        scope: scope.clone(),
                        channel_id: id,
                    },
                )
                .await?;
            }
            flush_frames(socket, pairs, &channel, request_queued, &sent, &mut frames).await?;
            match socket.next().await {
                Some(Ok(Message::Ping(bytes))) => socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Text(text))) if text == "ma-network-pong" => {}
                Some(Ok(Message::Text(text))) => {
                    controls += 1;
                    if controls > 256 {
                        return Err(NetworkError::new("HOST_MANAGEMENT_CAPACITY"));
                    }
                    let envelope = ServerEnvelope::parse(text.as_bytes())
                        .map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
                    if envelope.message.scope().is_some_and(|s| s != scope) {
                        return Err(NetworkError::new("CONTROL_SCOPE_MISMATCH"));
                    }
                    super::owned_profile::control(&envelope.message)?;
                    if pairs.consume_retired_management(
                        &envelope.message,
                        scope,
                        local,
                        &scope.connection_epoch,
                    )? {
                        continue;
                    }
                    match envelope.message {
                        ServerMessage::ChannelOffer {
                            channel_id,
                            initiator,
                            responder,
                            initiator_connection_epoch,
                            responder_connection_epoch,
                            initiator_binding,
                            responder_binding,
                            ..
                        } => {
                            if channel_id != channel {
                                pairs.reserve_management_retirement(&channel_id, scope, local)?;
                                pairs.retire_management(&channel_id, true);
                                send(
                                    socket,
                                    ClientMessage::Close {
                                        scope: scope.clone(),
                                        channel_id,
                                        reason: "TARGET_UNAVAILABLE".into(),
                                    },
                                )
                                .await?;
                                continue;
                            }
                            if offer.is_some() {
                                return Err(NetworkError::new("HOST_MANAGEMENT_RESPONSE_INVALID"));
                            }
                            let next = Offer {
                                channel_id: channel.clone(),
                                initiator,
                                responder,
                                initiator_epoch: initiator_connection_epoch,
                                responder_epoch: responder_connection_epoch,
                                initiator_binding,
                                responder_binding,
                            };
                            matches_offer(&next, &address, local, &scope.connection_epoch)?;
                            pairs.reserve(&channel)?;
                            let signed_binding = identity
                                .peer
                                .as_ref()
                                .ok_or_else(|| NetworkError::new("NETWORK_CERTIFICATE_INVALID"))?
                                .signed_binding
                                .clone();
                            offer = Some(next);
                            send(
                                socket,
                                ClientMessage::Accept {
                                    scope: scope.clone(),
                                    channel_id: channel.clone(),
                                    signed_binding,
                                },
                            )
                            .await?;
                        }
                        ServerMessage::ChannelAccepted {
                            channel_id,
                            initiator_binding,
                            responder_binding,
                            ..
                        } if channel_id == channel => {
                            let mut next = offer
                                .take()
                                .ok_or_else(|| NetworkError::new("CHANNEL_OFFER_MISSING"))?;
                            next.initiator_binding = Some(initiator_binding);
                            next.responder_binding = Some(responder_binding);
                            matches_offer(&next, &address, local, &scope.connection_epoch)?;
                            pairs.accepted(&channel)?;
                            pairs.install(
                                next.verify(&identity, local, &scope.connection_epoch)
                                    .await?,
                                local,
                                &scope.connection_epoch,
                            )?;
                            let (next, allocation) = pairs.feed_management(&channel, &[])?;
                            events = next;
                            decoded_allocation = Some(allocation);
                        }
                        ServerMessage::ChannelReady { channel_id, .. } if channel_id == channel => {
                            pairs.ready(&channel)?;
                            let (next, allocation) = pairs.feed_management(&channel, &[])?;
                            events = next;
                            decoded_allocation = Some(allocation);
                        }
                        ServerMessage::Credit {
                            channel_id,
                            sequence,
                            received_bytes,
                            ..
                        } if channel_id == channel => {
                            pairs.credit(&channel, sequence, received_bytes)?
                        }
                        ServerMessage::ChannelClosed {
                            channel_id, reason, ..
                        } if channel_id == channel => {
                            peer_closed = true;
                            unsupported_close = request.method
                                == ManagementMethod::HostCapabilities
                                && sent.load(Ordering::Acquire)
                                && reason == "peer-closed";
                            pairs.note_management_closed(&channel);
                            return Err(NetworkError::new("HOST_MANAGEMENT_CHANNEL_CLOSED"));
                        }
                        ServerMessage::Changed { .. } => {
                            return Err(NetworkError::new("HOST_MANAGEMENT_POLICY_CHANGED"))
                        }
                        ServerMessage::Error { code, .. } => {
                            return Err(NetworkError::cloud(&code, 400))
                        }
                        _ => return Err(NetworkError::new("CONTROL_UNEXPECTED")),
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let (id, payload) = decode_tls_frame(&bytes)
                        .map_err(|_| NetworkError::new("TLS_FRAME_INVALID"))?;
                    if id != channel {
                        return Err(NetworkError::new("HOST_MANAGEMENT_RESPONSE_INVALID"));
                    }
                    let (next, allocation) = pairs.feed_management(&channel, payload)?;
                    events = next;
                    decoded_allocation = Some(allocation);
                    let (sequence, received_bytes) = pairs.release_credit(&channel, bytes.len())?;
                    send(
                        socket,
                        ClientMessage::Credit {
                            scope: scope.clone(),
                            channel_id: channel.clone(),
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
    let result = tokio::time::timeout(Duration::from_secs(30), operation)
        .await
        .unwrap_or_else(|_| Err(NetworkError::new("HOST_MANAGEMENT_TIMEOUT")));
    pairs.retire_management(&channel, known_to_peer);
    let _ = pairs.take_failures();
    // Cleanup is bounded and best effort. A failed Close cannot change a receipt.
    let cleanup_confirmed = peer_closed
        || matches!(
            tokio::time::timeout(
                Duration::from_secs(1),
                send(
                    socket,
                    ClientMessage::Close {
                        scope: scope.clone(),
                        channel_id: channel.clone(),
                        reason: "READ_COMPLETED".into(),
                    },
                ),
            )
            .await,
            Ok(Ok(_))
        );
    let unsupported_result = matches!(&result, Ok(ManagementResponse { result: ResponseResult::Error { code }, .. }) if matches!(code.as_str(), "INVALID_REQUEST" | "METHOD_UNSUPPORTED"));
    if request.method == ManagementMethod::HostCapabilities
        && sent.load(Ordering::Acquire)
        && (unsupported_close || unsupported_result)
        && cleanup_confirmed
        && pairs.management_retired_ready(&channel)
        && identity.account.ensure_current().is_ok()
    {
        return Err(NetworkError::new("HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE"));
    }
    result.map_err(|error| {
        if request.mutation() && sent.load(Ordering::Acquire) {
            lost(true, true)
        } else {
            error
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_write_is_not_account_change() {
        assert_eq!(lost(true, true).code, "HOST_MANAGEMENT_UNCONFIRMED");
        assert_eq!(lost(true, false).code, "HOST_MANAGEMENT_NOT_COMPLETED");
        assert_eq!(lost(false, true).code, "HOST_MANAGEMENT_NOT_COMPLETED");
    }
    fn request() -> ManagementRequest {
        ManagementRequest {
            connection_id: "owned:test".into(),
            auth_generation: 1,
            principal_id: "p".into(),
            network_id: "n".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            target_scope: None,
            method: ManagementMethod::HostSnapshot,
            params: RequestParams::Snapshot(myagents_host_management_protocol::SnapshotParams {}),
        }
    }
    #[test]
    fn writes_require_the_inspected_target_and_reject_its_replacement() {
        let mut r = request();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        assert!(r.message(id).is_ok()); // First inspection can discover identity.
        r.method = ManagementMethod::ConfigSet;
        r.params = RequestParams::ConfigSet(myagents_host_management_protocol::ConfigSetParams {
            expected_revision: 0,
            provider_id: "moonshot-coding".into(),
            model: "kimi-for-coding".into(),
            workspace: None,
            execution_authorized: false,
            mutation_id: id,
        });
        assert_eq!(
            r.message(id).err().unwrap().code,
            "HOST_MANAGEMENT_TARGET_REQUIRED"
        );
        let current = DeviceScope {
            service_id: "s".into(),
            environment: "e".into(),
            network_id: r.network_id.clone(),
            principal_id: r.principal_id.clone(),
            device_id: r.device_id.clone(),
            key_generation: 1,
        };
        r.target_scope = Some(current.clone());
        assert!(r.message(id).is_ok());
        assert!(matches_target(&r, &current).is_ok());
        let mut replacement = current.clone();
        replacement.key_generation += 1;
        assert_eq!(
            matches_target(&r, &replacement).err().unwrap().code,
            "HOST_MANAGEMENT_TARGET_CHANGED"
        );
        replacement = current;
        replacement.service_id = "other-service".into();
        assert!(matches_target(&r, &replacement).is_err());
    }
    #[test]
    fn ready_is_consumed_without_another_tls_frame() {
        let r = request();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        assert!(
            consume(vec![ManagementEvent::Ready], &r, id, false)
                .unwrap()
                .0
        );
        assert!(consume(vec![ManagementEvent::Ready], &r, id, true).is_err());
    }
    #[test]
    fn response_must_match_request_id_and_sent_boundary() {
        let r = request();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let event = || ManagementEvent::Response {
            request_id: id,
            result: ResponseResult::Error {
                code: "HOST_UNAVAILABLE".into(),
            },
        };
        assert!(consume(vec![event()], &r, id, false).is_err());
        assert!(consume(
            vec![event()],
            &r,
            CanonicalUuid::new(uuid::Uuid::new_v4()),
            true
        )
        .is_err());
        assert!(consume(vec![event()], &r, id, true).unwrap().1.is_some());
        assert!(consume(vec![event(), event()], &r, id, true).is_err());
    }
    #[test]
    fn receipt_response_checks_owner_and_original_mutation() {
        let mut r = request();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        r.method = ManagementMethod::ReceiptGet;
        r.params = RequestParams::ReceiptGet(myagents_host_management_protocol::ReceiptGetParams {
            mutation_id: id,
            owner: myagents_host_management_protocol::Owner::Config,
        });
        assert!(response_matches(
            &r,
            &ResponseResult::ReceiptNotFound {
                mutation_id: id,
                owner: myagents_host_management_protocol::Owner::Config
            }
        ));
        assert!(!response_matches(
            &r,
            &ResponseResult::ReceiptNotFound {
                mutation_id: id,
                owner: myagents_host_management_protocol::Owner::Resources
            }
        ));
        assert!(!response_matches(
            &r,
            &ResponseResult::ReceiptNotFound {
                mutation_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                owner: myagents_host_management_protocol::Owner::Config
            }
        ));
    }
    #[test]
    fn credential_write_and_receipt_are_bound_to_original_mutation_and_owner() {
        use myagents_host_management_protocol::{
            ConfigEffect, CredentialReceipt, CredentialSetParams, Owner,
        };
        let mut r = request();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        r.method = ManagementMethod::CredentialSet;
        r.target_scope = Some(DeviceScope {
            service_id: "s".into(),
            environment: "e".into(),
            network_id: r.network_id.clone(),
            principal_id: r.principal_id.clone(),
            device_id: r.device_id.clone(),
            key_generation: 1,
        });
        r.params = RequestParams::CredentialSet(CredentialSetParams {
            expected_revision: 0,
            provider_id: "moonshot-coding".into(),
            credential: "isolated-fixture-only".into(),
            mutation_id: id,
        });
        assert!(r.mutation());
        assert!(r.message(CanonicalUuid::new(uuid::Uuid::new_v4())).is_ok());
        let valid = ResponseResult::CredentialReceipt(CredentialReceipt::Persisted {
            mutation_id: id,
            revision: 1,
            effect: ConfigEffect::NewSession,
        });
        assert!(response_matches(&r, &valid));
        assert!(!response_matches(
            &r,
            &ResponseResult::CredentialReceipt(CredentialReceipt::Conflict {
                mutation_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
                revision: 1,
                effect: ConfigEffect::None
            })
        ));
        assert!(!response_matches(
            &r,
            &ResponseResult::ConfigReceipt(
                myagents_host_management_protocol::ConfigReceipt::NotFound { mutation_id: id }
            )
        ));
        assert!(!response_matches(
            &r,
            &ResponseResult::ReceiptNotFound {
                mutation_id: id,
                owner: Owner::Credentials
            }
        ));
        r.method = ManagementMethod::ReceiptGet;
        r.params = RequestParams::ReceiptGet(myagents_host_management_protocol::ReceiptGetParams {
            mutation_id: id,
            owner: Owner::Credentials,
        });
        assert!(!r.mutation());
        assert!(response_matches(&r, &valid));
        assert!(response_matches(
            &r,
            &ResponseResult::ReceiptNotFound {
                mutation_id: id,
                owner: Owner::Credentials
            }
        ));
        r.params = RequestParams::ReceiptGet(myagents_host_management_protocol::ReceiptGetParams {
            mutation_id: id,
            owner: Owner::Config,
        });
        assert!(!response_matches(&r, &valid));
        r.params = RequestParams::ReceiptGet(myagents_host_management_protocol::ReceiptGetParams {
            mutation_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            owner: Owner::Credentials,
        });
        assert!(!response_matches(&r, &valid));
    }
    #[test]
    fn actor_recovery_is_exclusive_to_the_retired_capability_probe_signal() {
        let mut r = request();
        r.method = ManagementMethod::HostCapabilities;
        assert!(isolated_unsupported_probe(
            &r,
            &NetworkError::new("HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE")
        ));
        for code in [
            "ACCOUNT_BINDING_CHANGED",
            "HOST_MANAGEMENT_TIMEOUT",
            "HOST_MANAGEMENT_CHANNEL_CLOSED",
            "CONTROL_SCOPE_MISMATCH",
            "HOST_MANAGEMENT_RESPONSE_INVALID",
        ] {
            assert!(!isolated_unsupported_probe(&r, &NetworkError::new(code)));
        }
        r.method = ManagementMethod::HostSnapshot;
        assert!(!isolated_unsupported_probe(
            &r,
            &NetworkError::new("HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE")
        ));
        r.method = ManagementMethod::ConfigProviderSet;
        assert!(r.mutation());
        assert!(!isolated_unsupported_probe(
            &r,
            &NetworkError::new("HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE")
        ));
    }

    #[test]
    fn request_method_and_params_remain_closed() {
        let mut r = request();
        r.method = ManagementMethod::ConfigSet;
        assert!(r.message(CanonicalUuid::new(uuid::Uuid::new_v4())).is_err());
    }
}

#[cfg(test)]
mod offer_tests {
    use super::*;
    #[test]
    fn offer_must_match_actual_address_not_just_same_account() {
        let local = DeviceScope {
            service_id: "test.service".into(),
            environment: "development".into(),
            network_id: "n".into(),
            principal_id: "p".into(),
            device_id: "00000000-0000-0000-0000-000000000001".into(),
            key_generation: 1,
        };
        let target = DeviceScope {
            device_id: "00000000-0000-0000-0000-000000000002".into(),
            ..local.clone()
        };
        let address = DeviceAddress {
            version: 1,
            scope: target.clone(),
            connection_epoch: "target-epoch".into(),
            membership_revision: 1,
            signed_binding: "signed-target".into(),
        };
        let mut offer = Offer {
            channel_id: uuid::Uuid::new_v4().to_string(),
            initiator: local.clone(),
            responder: target,
            initiator_epoch: "local-epoch".into(),
            responder_epoch: address.connection_epoch.clone(),
            initiator_binding: Some("signed-local".into()),
            responder_binding: Some(address.signed_binding.clone()),
        };
        assert!(matches_offer(&offer, &address, &local, "local-epoch").is_ok());
        offer.responder_epoch = "replacement".into();
        assert!(matches_offer(&offer, &address, &local, "local-epoch").is_err());
        offer.responder_epoch = address.connection_epoch.clone();
        offer.responder_binding = Some("other-binding".into());
        assert!(matches_offer(&offer, &address, &local, "local-epoch").is_err());
        offer.responder_binding = Some(address.signed_binding.clone());
        offer.responder.key_generation = 2;
        assert!(matches_offer(&offer, &address, &local, "local-epoch").is_err());
    }
}

#[cfg(test)]
mod handoff_tests {
    use super::super::pairs::tests::{
        exchange_management, installed_management_pair, management_budget,
    };
    use super::*;
    fn message() -> ManagementMessage {
        ManagementMessage::Request {
            request_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            method: ManagementMethod::ConfigSet,
            params: RequestParams::ConfigSet(myagents_host_management_protocol::ConfigSetParams {
                expected_revision: 0,
                provider_id: "moonshot-coding".into(),
                model: "k3".into(),
                workspace: None,
                execution_authorized: false,
                mutation_id: CanonicalUuid::new(uuid::Uuid::new_v4()),
            }),
        }
    }
    fn budget_failure(post_write: bool) {
        let (mut host, mut controller, _, _, channel) = installed_management_pair();
        exchange_management(&mut host, &mut controller, &channel);
        assert!(host.peer(&channel).is_ok());
        assert!(controller.peer(&channel).is_ok());
        assert!(controller.next_frame().unwrap().is_none());
        let message = message();
        let encoding = (super::super::memory::measure(&message).unwrap().0 + 256) * 3
            + myagents_agent_network_protocol::budget("channelQueueBytes");
        let held_bytes = myagents_agent_network_protocol::budget("connectorBytes")
            - controller.buffered_bytes()
            - if post_write { encoding + 1 } else { 1 };
        let budget = management_budget(&controller);
        let held = budget.reserve(held_bytes).unwrap();
        let sent = AtomicBool::new(false);
        let mut queued = false;
        let error = queue_request(&mut controller, &channel, message, &mut queued).unwrap_err();
        assert_eq!(error.code, "CONNECTOR_CAPACITY");
        assert!(!queued);
        let mut attempts = 0;
        while let Some(frame) = controller.next_frame().unwrap() {
            mark_frame_handoff(&frame, &channel, queued, &sent).unwrap();
            attempts += 1;
        }
        assert_eq!(attempts, 0);
        assert!(!sent.load(Ordering::Acquire));
        assert_eq!(
            lost(true, sent.load(Ordering::Acquire)).code,
            "HOST_MANAGEMENT_NOT_COMPLETED"
        );
        assert!(!controller.has_channel(&channel));
        drop(held);
    }
    #[test]
    fn actual_pairs_preflight_failure_is_not_a_transport_handoff() {
        budget_failure(false);
    }
    #[test]
    fn actual_pairs_post_tls_accounting_failure_is_not_a_transport_handoff() {
        budget_failure(true);
    }

    struct PendingFlush {
        attempts: usize,
    }
    impl futures_util::Sink<Message> for PendingFlush {
        type Error = ();
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn start_send(mut self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), ()> {
            self.attempts += 1;
            Ok(())
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            std::task::Poll::Pending
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), ()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }
    #[tokio::test]
    async fn actual_request_frame_partial_transport_attempt_is_unconfirmed() {
        let (mut host, mut controller, _, _, channel) = installed_management_pair();
        exchange_management(&mut host, &mut controller, &channel);
        let mut queued = false;
        queue_request(&mut controller, &channel, message(), &mut queued).unwrap();
        let frame = controller.next_frame().unwrap().unwrap();
        let sent = AtomicBool::new(false);
        mark_frame_handoff(&frame, &channel, false, &sent).unwrap();
        assert!(!sent.load(Ordering::Acquire));
        mark_frame_handoff(&frame, &uuid::Uuid::new_v4().to_string(), true, &sent).unwrap();
        assert!(!sent.load(Ordering::Acquire));
        let mut transport = PendingFlush { attempts: 0 };
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            handoff_frame(&mut transport, frame, &channel, queued, &sent)
        )
        .await
        .is_err());
        assert_eq!(transport.attempts, 1);
        assert!(sent.load(Ordering::Acquire));
        assert_eq!(
            lost(true, sent.load(Ordering::Acquire)).code,
            "HOST_MANAGEMENT_UNCONFIRMED"
        );
    }
}
