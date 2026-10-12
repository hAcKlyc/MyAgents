#[path = "../../src/agent_network/catalog_ack.rs"]
pub(crate) mod catalog_ack;

use crate::{
    agent_network::{
        account::NetworkAccountSession,
        channel::ManagementEvent,
        connection::{initial_hello, send},
        identity::NetworkIdentity,
        memory::MemoryBudget,
        pairs::{Offer, Pairs},
        policy,
        reconnect::ReconnectBackoff,
        transport::{NetworkRoute, NetworkTransport},
        NetworkError,
    },
    state::Owner,
    status::{self, Status},
};
use futures_util::{SinkExt, StreamExt};
use myagents_agent_network_protocol::{
    budget, CatalogSnapshot, ChangeScope, ClientMessage, ServerEnvelope, ServerMessage,
};
use myagents_host_management_protocol::{ManagementMessage, PeerRole};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;
fn publish(
    owner: &Owner,
    path: Option<&Path>,
    state: &str,
    network: Option<&str>,
    ready: bool,
    error: Option<&str>,
) -> Result<(), NetworkError> {
    status::write(
        path,
        &Status {
            state,
            device_id: &owner.device_id,
            network_id: network,
            ready,
            error_code: error,
        },
    )
}
pub(crate) fn hello() -> ClientMessage {
    ClientMessage::Hello {
        client_version: env!("CARGO_PKG_VERSION").into(),
        capabilities: ["tls13-mtls", "typed-rpc", "permit-v1", "return-v1"]
            .map(str::to_owned)
            .to_vec(),
        previous_connection: None,
    }
}
pub(crate) fn empty_catalog(epoch: String) -> Result<serde_json::Value, NetworkError> {
    // This dedicated owner exposes no Agent registry or business invoke adapter.
    // Empty is its explicit product configuration, never a fallback after read failure.
    let value = serde_json::to_value(CatalogSnapshot {
        version: 1,
        connection_epoch: epoch,
        catalog_seq: 1,
        items: vec![],
    })
    .map_err(|_| NetworkError::new("CATALOG_INVALID"))?;
    myagents_agent_network_protocol::validate_catalog(&value)
        .map_err(|_| NetworkError::new("CATALOG_INVALID"))?;
    Ok(value)
}
pub(crate) fn control_gate(
    message: &ServerMessage,
    scope: &myagents_agent_network_protocol::ConnectionScope,
    catalog_confirmed: bool,
    policy_confirmed: bool,
) -> Result<(), NetworkError> {
    if message.scope().is_some_and(|current| current != scope) {
        return Err(NetworkError::new("CONTROL_SCOPE_MISMATCH"));
    }
    if let ServerMessage::Ready { catalog_seq, .. } = message {
        if *catalog_seq != 1 || !catalog_confirmed || !policy_confirmed {
            return Err(NetworkError::new("READY_PRECONDITION_FAILED"));
        }
    }
    Ok(())
}
fn consume_join_grant(run: &AtomicBool, connection: &AtomicBool) -> bool {
    let run_granted = run.swap(false, Ordering::AcqRel);
    let connection_granted = connection.swap(false, Ordering::AcqRel);
    run_granted && connection_granted
}
fn is_management_enabled(owned_profile: bool, listener_enabled: bool) -> bool {
    owned_profile && listener_enabled
}
fn require_captured_binding(actual: &str, captured: &str) -> Result<(), NetworkError> {
    if actual == captured {
        Ok(())
    } else {
        Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"))
    }
}
#[derive(Clone, Copy)]
struct ManagementRuntime<'a> {
    ipc: &'a crate::management_ipc::ManagementIpc,
    binding: &'a crate::management_admission::ManagementBinding,
}
async fn connect(
    owner: &Owner,
    path: Option<&Path>,
    backoff: &mut ReconnectBackoff,
    owned: Option<&crate::owned::Connection>,
    join_authorized: &AtomicBool,
    admission_failed: &mut bool,
    management: Option<ManagementRuntime<'_>>,
) -> Result<(), NetworkError> {
    let account = if let Some(owned) = owned {
        owned
            .account(join_authorized.load(Ordering::Acquire))
            .await?
    } else {
        let official = crate::auth::OfficialAccountSession::capture()?;
        official.upsert_device().await?;
        NetworkAccountSession::Official(official)
    };
    if let Some(runtime) = management {
        runtime.binding.verify()?;
        require_captured_binding(account.binding_id(), runtime.binding.account_binding())?;
    }
    publish(owner, path, "initializing", None, false, None)?;
    let mut identity =
        NetworkIdentity::initialize_with_store(account, None, owner.store.clone()).await?;
    let memory = MemoryBudget::default();
    let transport = NetworkTransport::new_with_public_ca(
        &identity.network_url,
        identity.device_key(),
        memory.clone(),
        identity.account.public_tls_ca(),
    )?;
    if let NetworkAccountSession::Owned(account) = &identity.account {
        // One operator grant belongs to this run, not each reconnect.
        let grant = consume_join_grant(join_authorized, &account.join_authorized);
        if let Err(error) =
            crate::agent_network::owned_admission::enroll(&identity, &transport, grant).await
        {
            *admission_failed = true;
            return Err(error);
        }
    }
    let mut socket = transport.websocket(&identity.token).await?;
    send(
        &mut socket,
        if owned.is_some() {
            management_hello()
        } else {
            hello()
        },
    )
    .await?;
    let (scope, local, _) = initial_hello(&mut socket, &identity).await?;
    publish(owner, path, "catalog", Some(&scope.network_id), false, None)?;
    let uploaded = transport
        .json(
            NetworkRoute::Catalog,
            &identity.token,
            Some(empty_catalog(scope.connection_epoch.clone())?),
        )
        .await?;
    catalog_ack::validate_catalog_ack(&uploaded, &scope.connection_epoch, 1).map_err(|error| {
        NetworkError::new(match error {
            catalog_ack::CatalogAckError::Invalid => "CATALOG_INVALID",
            catalog_ack::CatalogAckError::NotCurrent => "CATALOG_NOT_CURRENT",
        })
    })?;
    let mut policy = if owned.is_some() {
        policy::hydrate_owned(&transport, &identity.token, &local).await?
    } else {
        policy::hydrate(&transport, &identity.token, &local).await?
    };
    send(
        &mut socket,
        ClientMessage::Ready {
            scope: scope.clone(),
            catalog_seq: 1,
        },
    )
    .await?;
    let mut ready = false;
    let management_enabled =
        is_management_enabled(identity.account.is_management_only(), management.is_some());
    let mut pairs = management_enabled.then(|| Pairs::new_management(memory, PeerRole::Host));
    let mut pending_offers = std::collections::HashMap::<String, Offer>::new();
    let mut last_status = Instant::now();
    let mut last_server = Instant::now();
    let mut last_ping = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        identity.account.ensure_current()?;
        tokio::select! {
        incoming=socket.next()=>{
        last_server=Instant::now();
        match incoming{
        Some(Ok(Message::Ping(bytes)))=>socket.send(Message::Pong(bytes)).await.map_err(|_|NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
        Some(Ok(Message::Pong(_)))=>{},
        Some(Ok(Message::Text(text)))=>{
        if text=="ma-network-pong"{continue;}
        let envelope=ServerEnvelope::parse(text.as_bytes()).map_err(|_|NetworkError::new("CONTROL_INVALID"))?;
        if owned.is_some() { crate::agent_network::owned_profile::control(&envelope.message)?; }
        control_gate(&envelope.message,&scope,true,true)?;
        match envelope.message{
        ServerMessage::Ready{catalog_seq:1,..} if !ready=>{ready=true;backoff.recovered();publish(owner,path,"ready",Some(&scope.network_id),true,None)?;},
        ServerMessage::Changed{change:ChangeScope::Settings|ChangeScope::Catalog,..}=>{publish(owner,path,"hydrating",Some(&scope.network_id),false,None)?;policy=if owned.is_some(){policy::hydrate_owned(&transport,&identity.token,&local).await?}else{policy::hydrate(&transport,&identity.token,&local).await?};if identity.account.is_management_only()&&!policy.joined{return Err(NetworkError::new("OWNED_MEMBERSHIP_REQUIRED"));}publish(owner,path,if ready{"ready"}else{"hydrating"},Some(&scope.network_id),ready,None)?;},
        ServerMessage::Changed{..} if identity.account.is_management_only()=>{policy=policy::hydrate_owned(&transport,&identity.token,&local).await?;if !policy.joined{return Err(NetworkError::new("OWNED_MEMBERSHIP_REQUIRED"));}},
        ServerMessage::Changed{..}|ServerMessage::RouteClosed{..}=>{},
        ServerMessage::ChannelOffer{channel_id,initiator,responder,initiator_connection_epoch,responder_connection_epoch,initiator_binding,responder_binding,..}=>{
            if !ready {
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"HOST_NOT_READY".into()}).await?;
                continue;
            }
            let Some(pairs) = pairs.as_mut() else {
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"TARGET_UNAVAILABLE".into()}).await?;
                continue;
            };
            let offer=Offer{channel_id:channel_id.clone(),initiator,responder,initiator_epoch:initiator_connection_epoch,responder_epoch:responder_connection_epoch,initiator_binding,responder_binding};
            if offer.validate_scope(&local,&scope.connection_epoch).is_err() || pending_offers.contains_key(&channel_id) || pairs.has_channel(&channel_id) {
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"CHANNEL_SCOPE_MISMATCH".into()}).await?;
                continue;
            }
            if let Err(error) = pairs.reserve(&channel_id) {
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:error.code}).await?;
                continue;
            }
            identity=identity.clone().ensure_peer().await?;
            let binding=identity.peer.as_ref().ok_or_else(||NetworkError::new("NETWORK_CERTIFICATE_INVALID"))?.signed_binding.clone();
            pending_offers.insert(channel_id.clone(),offer);
            if let Err(error)=send(&mut socket,ClientMessage::Accept{scope:scope.clone(),channel_id:channel_id.clone(),signed_binding:binding}).await {
                pairs.remove(&channel_id); pending_offers.remove(&channel_id); return Err(error);
            }
        },
        ServerMessage::ChannelAccepted{channel_id,initiator_binding,responder_binding,..}=>{
            let (Some(pairs),Some(mut offer))=(pairs.as_mut(),pending_offers.remove(&channel_id)) else {
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"CHANNEL_OFFER_MISSING".into()}).await?;
                continue;
            };
            let result=async {
                pairs.accepted(&channel_id)?;
                offer.initiator_binding=Some(initiator_binding); offer.responder_binding=Some(responder_binding);
                let verified=offer.verify(&identity,&local,&scope.connection_epoch).await?;
                pairs.install(verified,&local,&scope.connection_epoch)?;
                Ok::<(),NetworkError>(())
            }.await;
            if result.is_err() {
                pairs.remove(&channel_id);
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"CHANNEL_BINDING_INVALID".into()}).await?;
            }
        },
        ServerMessage::Credit{channel_id,sequence,received_bytes,..}=>{
            if let Some(pairs)=pairs.as_mut(){ if pairs.has_channel(&channel_id){ if let Err(error)=pairs.credit(&channel_id,sequence,received_bytes){pairs.remove(&channel_id);send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:error.code}).await?;} } }
        },
        ServerMessage::ChannelReady{channel_id,..}=>{
            if let Some(pairs)=pairs.as_mut(){ if pairs.has_channel(&channel_id){ if let Err(error)=pairs.ready(&channel_id){pairs.remove(&channel_id);send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:error.code}).await?;} else { let (events,allocation)=pairs.feed_management(&channel_id,&[]) ?; handle_management_events(&mut socket,pairs,&scope,&channel_id,events,management,&identity).await?; drop(allocation); } } else { send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"CHANNEL_NOT_FOUND".into()}).await?; } }
        },
        ServerMessage::ChannelClosed{channel_id,..}=>{if let Some(pairs)=pairs.as_mut(){pairs.remove(&channel_id);} pending_offers.remove(&channel_id);},
        ServerMessage::Error{code,retryable}=>{let mut e=NetworkError::cloud(&code,400);e.retryable=retryable;return Err(e);},
        _=>return Err(NetworkError::new("CONTROL_UNEXPECTED")),
        }
        },Some(Ok(Message::Binary(bytes)))=>{
            let (channel_id,payload)=myagents_agent_network_protocol::decode_tls_frame(&bytes).map_err(|_|NetworkError::new("CHANNEL_FRAME_INVALID"))?;
            let Some(pairs)=pairs.as_mut() else { continue; };
            if !pairs.has_channel(&channel_id) {
                pairs.remove(&channel_id);
                pending_offers.remove(&channel_id);
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"CHANNEL_NOT_FOUND".into()}).await?;
                continue;
            }
            identity.account.ensure_current()?;
            let (events,allocation)=match pairs.feed_management(&channel_id,payload){Ok(value)=>value,Err(error)=>{pairs.remove(&channel_id);send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:error.code}).await?;continue;}};
            handle_management_events(&mut socket,pairs,&scope,&channel_id,events,management,&identity).await?;
            if pairs.has_channel(&channel_id) {
                let (sequence,received_bytes)=pairs.release_credit(&channel_id,bytes.len())?;
                send(&mut socket,ClientMessage::Credit{scope:scope.clone(),channel_id,sequence,received_bytes}).await?;
            }
            drop(allocation);
        },_=>return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED"))}
        if let Some(pairs)=pairs.as_mut(){ drain_management(&mut socket,pairs,&scope).await?; }
        },_=tick.tick()=>{
        if identity.access.exp<=jsonwebtoken::get_current_timestamp(){return Err(NetworkError::new("NETWORK_TOKEN_EXPIRED"));}
        if last_server.elapsed()>Duration::from_millis(budget("offlineMs")as u64){return Err(NetworkError::new("NETWORK_CONNECTION_TIMEOUT"));}
        if last_ping.elapsed()>=Duration::from_millis(budget("pingMs")as u64){socket.send(Message::Text("ma-network-ping".into())).await.map_err(|_|NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;last_ping=Instant::now();}
        // Reading the real relay policy is a Ready precondition; zero mounts do not
        // waive hydration or create local invocation authority.
        if last_status.elapsed()>=Duration::from_secs(10){publish(owner,path,if ready{"ready"}else{"hydrating"},Some(&scope.network_id),ready,None)?;last_status=Instant::now();}
        let _=(&policy.device_name,policy.joined,policy.membership_revision,policy.mounts.len());
        if let Some(pairs)=pairs.as_mut(){ drain_management(&mut socket,pairs,&scope).await?; }
        if let Some(pairs)=pairs.as_mut(){
            for (channel_id,reason) in pairs.expired(){
                pairs.remove(&channel_id);
                pending_offers.remove(&channel_id);
                send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:reason.into()}).await?;
            }
        }
        }}
    }
}

async fn handle_management_events(
    socket: &mut crate::agent_network::transport::NetworkSocket,
    pairs: &mut Pairs,
    scope: &myagents_agent_network_protocol::ConnectionScope,
    channel_id: &str,
    events: Vec<ManagementEvent>,
    management: Option<ManagementRuntime<'_>>,
    identity: &NetworkIdentity,
) -> Result<(), NetworkError> {
    for event in events {
        match event {
            ManagementEvent::Ready => {}
            ManagementEvent::Response { .. } => {
                pairs.remove(channel_id);
                send(
                    socket,
                    ClientMessage::Close {
                        scope: scope.clone(),
                        channel_id: channel_id.into(),
                        reason: "HOST_MANAGEMENT_UNEXPECTED_RESPONSE".into(),
                    },
                )
                .await?;
            }
            ManagementEvent::Request {
                request_id,
                method,
                params,
            } => {
                identity.account.ensure_current()?;
                if let Some(runtime) = management {
                    runtime.binding.verify()?;
                }
                let result = match management {
                    Some(runtime) => {
                        runtime
                            .ipc
                            .request(channel_id, request_id, method, params)
                            .await
                    }
                    None => Err(NetworkError::new("HOST_MANAGEMENT_UNCONFIRMED")),
                };
                if identity.account.ensure_current().is_err() {
                    pairs.remove(channel_id);
                    return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
                }
                if management.is_some_and(|runtime| runtime.binding.verify().is_err()) {
                    pairs.remove(channel_id);
                    return Err(NetworkError::new("HOST_MANAGEMENT_REBIND_REQUIRED"));
                }
                match result {
                    Ok(result) => {
                        if let Err(error) = pairs.send_management(
                            channel_id,
                            ManagementMessage::Response { request_id, result },
                        ) {
                            pairs.remove(channel_id);
                            send(
                                socket,
                                ClientMessage::Close {
                                    scope: scope.clone(),
                                    channel_id: channel_id.into(),
                                    reason: error.code,
                                },
                            )
                            .await?;
                        }
                    }
                    Err(_) => {
                        // The local operation may have committed before its response was lost.
                        // Never replay it; the owner can later query receipt.get.
                        pairs.remove(channel_id);
                        send(
                            socket,
                            ClientMessage::Close {
                                scope: scope.clone(),
                                channel_id: channel_id.into(),
                                reason: "HOST_MANAGEMENT_UNCONFIRMED".into(),
                            },
                        )
                        .await?;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn drain_management(
    socket: &mut crate::agent_network::transport::NetworkSocket,
    pairs: &mut Pairs,
    scope: &myagents_agent_network_protocol::ConnectionScope,
) -> Result<(), NetworkError> {
    for channel_id in pairs.announce_ready() {
        send(
            socket,
            ClientMessage::ChannelReady {
                scope: scope.clone(),
                channel_id,
            },
        )
        .await?;
    }
    for _ in 0..256 {
        let failures = pairs.take_failures();
        for (channel_id, error) in failures {
            pairs.remove(&channel_id);
            send(
                socket,
                ClientMessage::Close {
                    scope: scope.clone(),
                    channel_id,
                    reason: error.code,
                },
            )
            .await?;
        }
        let Some(frame) = pairs.next_frame()? else {
            break;
        };
        socket
            .send(Message::Binary(frame))
            .await
            .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;
    }
    let failures = pairs.take_failures();
    for (channel_id, error) in failures {
        pairs.remove(&channel_id);
        send(
            socket,
            ClientMessage::Close {
                scope: scope.clone(),
                channel_id,
                reason: error.code,
            },
        )
        .await?;
    }
    Ok(())
}
pub(crate) async fn run(owner: Arc<Owner>, path: Option<&Path>) -> Result<(), NetworkError> {
    run_context(owner, None, path, false, None, None).await
}
pub(crate) async fn run_owned(
    owner: Arc<Owner>,
    connection: &crate::owned::Connection,
    path: Option<&Path>,
    join_authorized: bool,
    management: Option<&crate::management_ipc::ManagementIpcConfig>,
) -> Result<(), NetworkError> {
    // Pin this run to the encrypted local account generation before creating
    // the reverse listener. A later login must start a new operator run.
    let management_binding = if management.is_some() {
        let account = connection.account(false).await?;
        Some(crate::management_admission::authorize(
            &connection.owner,
            &account,
        )?)
    } else {
        None
    };
    let ipc = management
        .map(crate::management_ipc::ManagementIpc::bind)
        .transpose()?;
    run_context(
        owner,
        Some(connection),
        path,
        join_authorized,
        ipc.as_ref(),
        management_binding.as_ref(),
    )
    .await
}
fn management_hello() -> ClientMessage {
    ClientMessage::Hello {
        client_version: env!("CARGO_PKG_VERSION").into(),
        capabilities: vec!["tls13-mtls".into()],
        previous_connection: None,
    }
}
async fn run_context(
    owner: Arc<Owner>,
    owned: Option<&crate::owned::Connection>,
    path: Option<&Path>,
    join_authorized: bool,
    management_ipc: Option<&crate::management_ipc::ManagementIpc>,
    management_binding: Option<&crate::management_admission::ManagementBinding>,
) -> Result<(), NetworkError> {
    if management_ipc.is_some() != management_binding.is_some() {
        return Err(NetworkError::new("HOST_MANAGEMENT_BINDING_INVALID"));
    }
    let management = management_ipc
        .zip(management_binding)
        .map(|(ipc, binding)| ManagementRuntime { ipc, binding });
    let join_authorized = AtomicBool::new(join_authorized);
    let mut admission_failed = false;
    let mut backoff = ReconnectBackoff::default();
    loop {
        publish(&owner, path, "connecting", None, false, None)?;
        let result = tokio::select! {r=connect(&owner,path,&mut backoff,owned,&join_authorized,&mut admission_failed,management)=>r,_=crate::shutdown()=>{publish(&owner,path,"stopped",None,false,None)?;return Ok(());}};
        let error = result.unwrap_err();
        let state = if [
            "SPACE_REAUTH_REQUIRED",
            "OWNED_REAUTH_REQUIRED",
            "ACCOUNT_AUTH_REVOKED",
            "NOT_AUTHENTICATED",
        ]
        .contains(&error.code.as_str())
        {
            "signedOut"
        } else if ["NETWORK_TOKEN_EXPIRED", "ACCOUNT_SESSION_EXPIRED"]
            .contains(&error.code.as_str())
        {
            "expired"
        } else {
            "unavailable"
        };
        publish(&owner, path, state, None, false, Some(&error.code))?;
        if management_ipc.is_some()
            && [
                "OWNED_REAUTH_REQUIRED",
                "OWNED_SESSION_INVALID",
                "ACCOUNT_BINDING_CHANGED",
                "ACCOUNT_SESSION_EXPIRED",
                "ACCOUNT_AUTH_REVOKED",
                "NOT_AUTHENTICATED",
                "SPACE_REAUTH_REQUIRED",
                "NETWORK_TRUST_CHANGED",
                "HOST_MANAGEMENT_REBIND_REQUIRED",
                "HOST_MANAGEMENT_GRANT_MISSING",
                "HOST_MANAGEMENT_GRANT_CORRUPT",
            ]
            .contains(&error.code.as_str())
        {
            // The reverse listener is pinned to this run's owned account. A
            // revoked/replaced binding ends the run instead of inheriting it.
            return Err(error);
        }
        // An uncertain enrollment mutation is not a transport retry.
        if admission_failed {
            return Err(error);
        }
        let id = uuid::Uuid::new_v4();
        let delay = backoff.next(
            u16::from_le_bytes([id.as_bytes()[0], id.as_bytes()[1]]),
            error.retry_after,
        );
        tokio::select! {_=tokio::time::sleep(delay)=>{},_=crate::shutdown()=>{publish(&owner,path,"stopped",None,false,None)?;return Ok(());}}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_hello_does_not_advertise_agent_execution_and_join_is_not_replayed() {
        let owned = serde_json::to_value(management_hello()).unwrap();
        assert_eq!(owned["capabilities"], serde_json::json!(["tls13-mtls"]));
        let official = serde_json::to_value(hello()).unwrap();
        assert_eq!(official["capabilities"].as_array().unwrap().len(), 4);
        let run = AtomicBool::new(true);
        let first_connection = AtomicBool::new(true);
        assert!(consume_join_grant(&run, &first_connection));
        assert!(!first_connection.load(Ordering::Acquire));
        // Even a newly constructed connection cannot reuse the old operator grant.
        let reconnected = AtomicBool::new(true);
        assert!(!consume_join_grant(&run, &reconnected));
        assert!(!reconnected.load(Ordering::Acquire));
        assert!(!consume_join_grant(
            &AtomicBool::new(false),
            &AtomicBool::new(true)
        ));
    }
    #[test]
    fn management_requires_both_owned_profile_and_explicit_operator_listener() {
        assert!(is_management_enabled(true, true));
        assert!(!is_management_enabled(false, true));
        assert!(!is_management_enabled(true, false));
        assert!(!is_management_enabled(false, false));
    }
    #[test]
    fn empty_catalog_is_real_explicit_zero_and_validated() {
        let value = empty_catalog(uuid::Uuid::new_v4().to_string()).unwrap();
        assert_eq!(value["items"], serde_json::json!([]));
        assert_eq!(value["catalogSeq"], 1);
    }
    #[test]
    fn ready_requires_scope_catalog_ack_and_hydrated_policy() {
        use myagents_agent_network_protocol::ConnectionScope;
        let scope = ConnectionScope {
            service_id: crate::state::SERVICE_ID.into(),
            network_id: uuid::Uuid::new_v4().to_string(),
            boot_epoch: uuid::Uuid::new_v4().to_string(),
            connection_epoch: uuid::Uuid::new_v4().to_string(),
        };
        let value = serde_json::json!({"version":1,"controlId":uuid::Uuid::new_v4().to_string(),"type":"ready.result","serviceId":scope.service_id,"networkId":scope.network_id,"bootEpoch":scope.boot_epoch,"connectionEpoch":scope.connection_epoch,"catalogSeq":1});
        let envelope = ServerEnvelope::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        for (catalog, policy) in [(false, false), (true, false), (false, true)] {
            assert_eq!(
                control_gate(&envelope.message, &scope, catalog, policy)
                    .unwrap_err()
                    .code,
                "READY_PRECONDITION_FAILED"
            );
        }
        control_gate(&envelope.message, &scope, true, true).unwrap();
        let mut newer = scope.clone();
        newer.connection_epoch = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            control_gate(&envelope.message, &newer, true, true)
                .unwrap_err()
                .code,
            "CONTROL_SCOPE_MISMATCH"
        );
        let wrong = ServerMessage::Ready {
            scope,
            catalog_seq: 2,
        };
        assert_eq!(
            control_gate(&wrong, &newer, true, true).unwrap_err().code,
            "CONTROL_SCOPE_MISMATCH"
        );
    }

    #[test]
    fn management_run_rejects_replaced_encrypted_account_binding() {
        let captured = uuid::Uuid::new_v4().to_string();
        assert!(require_captured_binding(&captured, &captured).is_ok());
        assert_eq!(
            require_captured_binding(&uuid::Uuid::new_v4().to_string(), &captured)
                .unwrap_err()
                .code,
            "ACCOUNT_BINDING_CHANGED"
        );
    }
}
