//! The owned relay profile grants device membership, never Agent invocation.
use super::{transport::NetworkRoute, NetworkError};
use myagents_agent_network_protocol::ServerMessage;

pub(crate) fn control(message: &ServerMessage) -> Result<(), NetworkError> {
    if matches!(
        message,
        ServerMessage::AuthRefreshed { .. }
            | ServerMessage::Ready { .. }
            | ServerMessage::Changed { .. }
            | ServerMessage::Error { .. }
            | ServerMessage::ChannelOffer { .. }
            | ServerMessage::ChannelAccepted { .. }
            | ServerMessage::Credit { .. }
            | ServerMessage::ChannelReady { .. }
            | ServerMessage::ChannelClosed { .. }
    ) {
        Ok(())
    } else {
        Err(NetworkError::new("OWNED_PROFILE_UNSUPPORTED"))
    }
}
pub(crate) fn metadata(route: &NetworkRoute<'_>) -> Result<(), NetworkError> {
    if matches!(
        route,
        NetworkRoute::Network
            | NetworkRoute::Devices { .. }
            | NetworkRoute::Agents { .. }
            | NetworkRoute::Membership { .. }
            | NetworkRoute::DeviceName { .. }
            | NetworkRoute::Receipt { .. }
    ) {
        Ok(())
    } else {
        Err(NetworkError::new("OWNED_PROFILE_UNSUPPORTED"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_protocol::ConnectionScope;
    #[test]
    fn owned_profile_rejects_business_routes_and_controls() {
        assert!(metadata(&NetworkRoute::Resolve {
            network_id: "n",
            mount_id: "m"
        })
        .is_err());
        assert!(metadata(&NetworkRoute::Callable {
            network_id: "n",
            cursor: None,
            limit: 1
        })
        .is_err());
        assert!(metadata(&NetworkRoute::Mount {
            network_id: "n",
            mount_id: "m"
        })
        .is_err());
        assert!(metadata(&NetworkRoute::Devices {
            cursor: None,
            limit: 1
        })
        .is_ok());
        let scope = ConnectionScope {
            service_id: "s".into(),
            network_id: "n".into(),
            boot_epoch: "b".into(),
            connection_epoch: "c".into(),
        };
        assert!(control(&ServerMessage::RouteClosed {
            scope: scope.clone(),
            return_route_id: "r".into(),
            reason: "test".into()
        })
        .is_err());
        assert!(control(&ServerMessage::Ready {
            scope,
            catalog_seq: 1
        })
        .is_ok());
    }
}
