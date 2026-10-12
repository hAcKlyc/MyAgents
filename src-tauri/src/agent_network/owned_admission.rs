//! Owned device admission precedes outer Hello. Every write still uses JWT/DPoP.
use super::{
    identity::NetworkIdentity,
    transport::{NetworkRoute, NetworkTransport},
    NetworkError,
};
use serde_json::json;
use std::collections::HashSet;

pub(crate) async fn enroll(
    identity: &NetworkIdentity,
    transport: &NetworkTransport,
    join_authorized: bool,
) -> Result<(), NetworkError> {
    identity.account.ensure_current()?;
    let super::account::NetworkAccountSession::Owned(account) = &identity.account else {
        return Err(NetworkError::new("OWNED_PROFILE_REQUIRED"));
    };
    let network = &account.descriptor.network_id;
    let device = crate::device_identity::current_device_identity()
        .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
    if device.device_id != identity.scope.device_id {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    transport.register_device(&identity.token, &device).await?;
    let mut cursor: Option<String> = None;
    let mut cursors = HashSet::new();
    for _ in 0..100 {
        identity.account.ensure_current()?;
        let page = transport
            .json(
                NetworkRoute::Devices {
                    cursor: cursor.as_deref(),
                    limit: 100,
                },
                &identity.token,
                None,
            )
            .await?;
        let items = page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_RESPONSE_INVALID"))?;
        let own: Vec<_> = items
            .iter()
            .filter(|v| v["deviceId"] == device.device_id)
            .collect();
        if own.len() > 1 {
            return Err(NetworkError::new("DEVICE_REGISTRATION_INVALID"));
        }
        if let Some(own) = own.first() {
            if own["principalId"] != identity.scope.principal_id || own["networkId"] != *network {
                return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
            }
            if own["joined"] == true {
                return Ok(());
            }
            if own["joined"] != false || !join_authorized {
                return Err(NetworkError::new("OWNED_JOIN_REQUIRED"));
            }
            let revision = own["membershipRevision"]
                .as_u64()
                .ok_or_else(|| NetworkError::new("NETWORK_RESPONSE_INVALID"))?;
            let mutation = uuid::Uuid::new_v4().to_string();
            let result = transport
                .json(
                    NetworkRoute::Membership {
                        network_id: network,
                        device_id: &device.device_id,
                        joined: true,
                    },
                    &identity.token,
                    Some(json!({"mutationId":mutation,"expectedMembershipRevision":revision})),
                )
                .await;
            // A lost response must not replay this write with a new mutation ID.
            // The caller consumes its explicit initial-join grant before calling.
            let result = result.map_err(|_| NetworkError::new("OWNED_JOIN_UNCONFIRMED"))?;
            if result["deviceId"] != device.device_id
                || result["joined"] != true
                || result["membershipRevision"].as_u64() != revision.checked_add(1)
            {
                return Err(NetworkError::new("OWNED_JOIN_UNCONFIRMED"));
            }
            identity.account.ensure_current()?;
            return Ok(());
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        match &cursor {
            None => break,
            Some(c) if !cursors.insert(c.clone()) => {
                return Err(NetworkError::new("NETWORK_RESPONSE_INVALID"))
            }
            _ => {}
        }
    }
    Err(NetworkError::new("DEVICE_REGISTRATION_INVALID"))
}
