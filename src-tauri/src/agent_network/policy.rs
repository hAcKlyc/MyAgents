//! Read-only projection of relay desired state. The relay remains the authority;
//! these revisions are preconditions for a fresh final permit, never permission.
use super::transport::{NetworkRoute, NetworkTransport};
use super::NetworkError;
use myagents_agent_network_protocol::{budget, DeviceScope};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone)]
pub(crate) struct MountPolicy {
    pub agent_id: String,
    pub enabled: bool,
    pub enable_revision: u64,
}
#[derive(Clone)]
pub(crate) struct LocalPolicy {
    pub device_name: String,
    pub joined: bool,
    pub membership_revision: u64,
    pub mounts: HashMap<String, MountPolicy>,
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, NetworkError> {
    value[key]
        .as_str()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))
}
fn revision(value: &Value, key: &str) -> Result<u64, NetworkError> {
    value[key]
        .as_u64()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))
}
pub(crate) async fn hydrate(
    transport: &NetworkTransport,
    token: &str,
    local: &DeviceScope,
) -> Result<LocalPolicy, NetworkError> {
    hydrate_with_profile(transport, token, local, false).await
}

pub(crate) async fn hydrate_owned(
    transport: &NetworkTransport,
    token: &str,
    local: &DeviceScope,
) -> Result<LocalPolicy, NetworkError> {
    hydrate_with_profile(transport, token, local, true).await
}

async fn hydrate_with_profile(
    transport: &NetworkTransport,
    token: &str,
    local: &DeviceScope,
    management_only: bool,
) -> Result<LocalPolicy, NetworkError> {
    let mut cursor = None::<String>;
    let mut scanned = 0;
    let device = loop {
        let page = transport
            .json(
                NetworkRoute::Devices {
                    cursor: cursor.as_deref(),
                    limit: budget("pageMax"),
                },
                token,
                None,
            )
            .await?;
        let items = page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
        scanned += items.len();
        if let Some(device) = items
            .iter()
            .find(|item| item["deviceId"] == local.device_id)
        {
            break device.clone();
        }
        if page["complete"] == true {
            return Err(NetworkError::new("DEVICE_NOT_REGISTERED"));
        }
        if scanned >= budget("catalogItems") {
            return Err(NetworkError::new("CATALOG_CAPACITY"));
        }
        let next = text(&page, "nextCursor")?.to_owned();
        if cursor.as_ref() == Some(&next) {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next);
    };
    if text(&device, "principalId")? != local.principal_id
        || text(&device, "networkId")? != local.network_id
    {
        return Err(NetworkError::new("NETWORK_METADATA_SCOPE_MISMATCH"));
    }
    let joined = device["joined"]
        .as_bool()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
    let membership_revision = revision(&device, "membershipRevision")?;
    let mut mounts = HashMap::new();
    cursor = None;
    loop {
        let page = transport
            .json(
                agent_page_route(
                    management_only,
                    &local.device_id,
                    cursor.as_deref(),
                    budget("pageMax"),
                ),
                token,
                None,
            )
            .await?;
        for item in page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?
        {
            if text(item, "principalId")? != local.principal_id
                || text(item, "deviceId")? != local.device_id
                || text(item, "networkId")? != local.network_id
            {
                return Err(NetworkError::new("NETWORK_METADATA_SCOPE_MISMATCH"));
            }
            let policy = MountPolicy {
                agent_id: text(item, "localAgentId")?.into(),
                enabled: item["enabled"]
                    .as_bool()
                    .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?,
                enable_revision: revision(item, "enableRevision")?,
            };
            if mounts
                .insert(text(item, "mountId")?.into(), policy)
                .is_some()
            {
                return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
            }
        }
        if page["complete"] == true {
            break;
        }
        if mounts.len() >= budget("catalogItems") {
            return Err(NetworkError::new("CATALOG_CAPACITY"));
        }
        let next = text(&page, "nextCursor")?.to_owned();
        if cursor.as_ref() == Some(&next) {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next);
    }
    Ok(LocalPolicy {
        device_name: text(&device, "name")?.into(),
        joined,
        membership_revision,
        mounts,
    })
}

fn agent_page_route<'a>(
    management_only: bool,
    device_id: &'a str,
    cursor: Option<&'a str>,
    limit: usize,
) -> NetworkRoute<'a> {
    if management_only {
        NetworkRoute::OwnedSelfPolicy { cursor, limit }
    } else {
        NetworkRoute::Agents {
            device_id,
            cursor,
            limit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_hydration_selects_self_only_route_for_management_profile() {
        let cursor_value = "11111111-1111-4111-8111-111111111111";
        let cursor = Some(cursor_value);
        let owned = agent_page_route(true, "22222222-2222-4222-8222-222222222222", cursor, 50);
        assert!(
            matches!(owned, NetworkRoute::OwnedSelfPolicy { cursor: Some(value), limit: 50 } if value == cursor_value)
        );

        let official = agent_page_route(false, "22222222-2222-4222-8222-222222222222", cursor, 50);
        assert!(
            matches!(official, NetworkRoute::Agents { device_id, cursor: Some(value), limit: 50 } if device_id == "22222222-2222-4222-8222-222222222222" && value == cursor_value)
        );
    }
}
