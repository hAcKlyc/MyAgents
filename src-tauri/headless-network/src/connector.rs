#[path = "../../src/agent_network/catalog_ack.rs"]
mod catalog_ack;

use crate::{
    agent_network::{
        account::NetworkAccountSession,
        connection::{initial_hello, send},
        identity::NetworkIdentity,
        memory::MemoryBudget,
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
use std::{
    path::Path,
    sync::Arc,
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
async fn connect(
    owner: &Owner,
    path: Option<&Path>,
    backoff: &mut ReconnectBackoff,
) -> Result<(), NetworkError> {
    let official = crate::auth::OfficialAccountSession::capture()?;
    official.upsert_device().await?;
    let account = NetworkAccountSession::Official(official);
    publish(owner, path, "initializing", None, false, None)?;
    let identity =
        NetworkIdentity::initialize_with_store(account, None, owner.store.clone()).await?;
    let transport = NetworkTransport::new(
        &identity.network_url,
        identity.device_key(),
        MemoryBudget::default(),
    )?;
    let mut socket = transport.websocket(&identity.token).await?;
    send(&mut socket, hello()).await?;
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
    let mut policy = policy::hydrate(&transport, &identity.token, &local).await?;
    send(
        &mut socket,
        ClientMessage::Ready {
            scope: scope.clone(),
            catalog_seq: 1,
        },
    )
    .await?;
    let mut ready = false;
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
        control_gate(&envelope.message,&scope,true,true)?;
        match envelope.message{
        ServerMessage::Ready{catalog_seq:1,..} if !ready=>{ready=true;backoff.recovered();publish(owner,path,"ready",Some(&scope.network_id),true,None)?;},
        ServerMessage::Changed{change:ChangeScope::Settings|ChangeScope::Catalog,..}=>{publish(owner,path,"hydrating",Some(&scope.network_id),false,None)?;policy=policy::hydrate(&transport,&identity.token,&local).await?;publish(owner,path,if ready{"ready"}else{"hydrating"},Some(&scope.network_id),ready,None)?;},
        ServerMessage::Changed{..}|ServerMessage::ChannelClosed{..}|ServerMessage::RouteClosed{..}=>{},
        ServerMessage::ChannelOffer{channel_id,..}=>{send(&mut socket,ClientMessage::Close{scope:scope.clone(),channel_id,reason:"TARGET_UNAVAILABLE".into()}).await?;},
        ServerMessage::Error{code,retryable}=>{let mut e=NetworkError::cloud(&code,400);e.retryable=retryable;return Err(e);},
        _=>return Err(NetworkError::new("CONTROL_UNEXPECTED")),
        }
        },_=>return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED"))}
        },_=tick.tick()=>{
        if identity.access.exp<=jsonwebtoken::get_current_timestamp(){return Err(NetworkError::new("NETWORK_TOKEN_EXPIRED"));}
        if last_server.elapsed()>Duration::from_millis(budget("offlineMs")as u64){return Err(NetworkError::new("NETWORK_CONNECTION_TIMEOUT"));}
        if last_ping.elapsed()>=Duration::from_millis(budget("pingMs")as u64){socket.send(Message::Text("ma-network-ping".into())).await.map_err(|_|NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;last_ping=Instant::now();}
        // Reading the real relay policy is a Ready precondition; zero mounts do not
        // waive hydration or create local invocation authority.
        if last_status.elapsed()>=Duration::from_secs(10){publish(owner,path,if ready{"ready"}else{"hydrating"},Some(&scope.network_id),ready,None)?;last_status=Instant::now();}
        let _=(&policy.device_name,policy.joined,policy.membership_revision,policy.mounts.len());
        }}
    }
}
pub(crate) async fn run(owner: Arc<Owner>, path: Option<&Path>) -> Result<(), NetworkError> {
    let mut backoff = ReconnectBackoff::default();
    loop {
        publish(&owner, path, "connecting", None, false, None)?;
        let result = tokio::select! {r=connect(&owner,path,&mut backoff)=>r,_=crate::shutdown()=>{publish(&owner,path,"stopped",None,false,None)?;return Ok(());}};
        let error = result.unwrap_err();
        let state = if [
            "SPACE_REAUTH_REQUIRED",
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
}
