//! Shared fixed-protocol control handshake; process owners supply their lifecycle.
use super::{identity::NetworkIdentity, transport::NetworkSocket, NetworkError};
use futures_util::{SinkExt, StreamExt};
use myagents_agent_network_protocol::{
    budget, ClientEnvelope, ClientMessage, ConnectionScope, DeviceScope, PreviousConnection,
    ServerEnvelope, ServerMessage,
};
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
pub(crate) async fn send(
    socket: &mut NetworkSocket,
    message: ClientMessage,
) -> Result<String, NetworkError> {
    let control_id = uuid::Uuid::new_v4().to_string();
    send_control(socket, control_id.clone(), message).await?;
    Ok(control_id)
}
pub(crate) async fn send_control(
    socket: &mut NetworkSocket,
    control_id: String,
    message: ClientMessage,
) -> Result<(), NetworkError> {
    let bytes = ClientEnvelope {
        version: 1,
        control_id: control_id.clone(),
        message,
    }
    .encode()
    .map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
    let text = String::from_utf8(bytes).map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
    tokio::time::timeout(
        Duration::from_millis(budget("backpressureMs") as u64),
        socket.send(Message::Text(text)),
    )
    .await
    .map_err(|_| NetworkError::new("NETWORK_BACKPRESSURE"))?
    .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?;
    Ok(())
}
pub(crate) async fn initial_hello(
    socket: &mut NetworkSocket,
    identity: &NetworkIdentity,
) -> Result<(ConnectionScope, DeviceScope, PreviousConnection), NetworkError> {
    let read = async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Ping(bytes))) => socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| NetworkError::new("NETWORK_CONNECTION_CLOSED"))?,
                Some(Ok(Message::Text(text))) => {
                    let envelope = ServerEnvelope::parse(text.as_bytes())
                        .map_err(|_| NetworkError::new("CONTROL_INVALID"))?;
                    return match envelope.message {
                        ServerMessage::Hello {
                            scope,
                            identity: local,
                            connector_nonce,
                            ..
                        } if scope.service_id == identity.scope.service_id
                            && local.service_id == scope.service_id
                            && local.network_id == scope.network_id
                            && local.environment == identity.scope.environment
                            && local.principal_id == identity.scope.principal_id
                            && local.device_id == identity.scope.device_id
                            && local.key_generation == identity.scope.key_generation =>
                        {
                            let previous = PreviousConnection {
                                connection_epoch: scope.connection_epoch.clone(),
                                connector_nonce,
                            };
                            Ok((scope, local, previous))
                        }
                        ServerMessage::Error { code, .. } => Err(NetworkError::cloud(&code, 400)),
                        _ => Err(NetworkError::new("CONTROL_SCOPE_MISMATCH")),
                    };
                }
                _ => return Err(NetworkError::new("NETWORK_CONNECTION_CLOSED")),
            }
        }
    };
    tokio::time::timeout(Duration::from_millis(budget("helloMs") as u64), read)
        .await
        .map_err(|_| NetworkError::new("NETWORK_HELLO_TIMEOUT"))?
}
