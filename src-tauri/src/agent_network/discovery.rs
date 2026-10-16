//! Fresh bounded directories. Each paginated read charges retained objects to
//! the App budget before waiting for another page and carries its lease to merge.
use super::{
    actor::ManagedConnection,
    commands::MetadataRequest,
    memory::{measure, Allocation},
    NetworkError,
};
use myagents_agent_network_protocol::budget;
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio::time::{timeout_at, Duration, Instant};
fn charge_directory(allocation: &mut Allocation, bytes: usize) -> Result<(), NetworkError> {
    allocation.resize(bytes.saturating_mul(2))
}
fn result(
    items: Vec<Value>,
    complete: bool,
    status: &str,
    context: Value,
    allocation: Allocation,
) -> (Value, Allocation) {
    (
        json!({"items":items,"complete":complete,"networkStatus":status,"context":context}),
        allocation,
    )
}
async fn remote_connection(
    owner: &ManagedConnection,
    local_only: bool,
    name: &str,
) -> Result<(Value, Allocation), NetworkError> {
    let snapshot = owner.snapshot();
    let generation = owner.generation();
    let device = owner.local_device_identity()?;
    let context = json!({"authGeneration":snapshot.auth_generation,"deviceId":device.device_id,"deviceName":snapshot.device_name.or(device.device_name),"platform":device.platform,"networkId":snapshot.network_id,"principalId":snapshot.principal_id});
    let overhead = measure(&context)?.0 + 128;
    let mut allocation = owner.memory_budget().reserve(overhead * 2)?;
    if local_only || snapshot.state != "ready" {
        return Ok(result(
            vec![],
            snapshot.state == "signedOut",
            snapshot.state,
            context,
            allocation,
        ));
    }
    let network = snapshot
        .network_id
        .ok_or_else(|| NetworkError::new("NETWORK_SCOPE_MISMATCH"))?;
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut cursor = None;
    let mut mounts = HashSet::new();
    let mut cursors = HashSet::new();
    let mut items = Vec::new();
    let mut bytes = 0;
    loop {
        let response = timeout_at(
            deadline,
            owner.request(MetadataRequest::Callable {
                network_id: network.clone(),
                cursor: cursor.clone(),
                limit: budget("pageMax"),
            }),
        )
        .await;
        if owner.generation() != generation
            || owner.snapshot().auth_generation != snapshot.auth_generation
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        let page = match response {
            Ok(Ok(page)) => page,
            _ => return Ok(result(items, false, "error", context, allocation)),
        };
        let entries = page["items"]
            .as_array()
            .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
        for entry in entries {
            let mount = entry["mountId"]
                .as_str()
                .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
            if !mounts.insert(mount.to_owned()) {
                return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
            }
            if entry["source"]["networkId"] != network {
                return Err(NetworkError::new("NETWORK_SCOPE_MISMATCH"));
            }
            // Peer credentials stay in the connector. Presentation labels never route.
            let item = json!({"localAgentId":entry["localAgentId"],"selector":entry["selector"],"name":entry["name"],"icon":entry["icon"],"isLocal":false,"deviceId":entry["deviceId"],"deviceName":entry["deviceName"],"platform":entry["platform"],"description":entry["description"],"source":entry["source"],"networkName":name,"connectionId":owner.connection_id});
            let size = measure(&item)?.0;
            if items.len() >= budget("catalogItems") || bytes + size > budget("catalogBytes") {
                return Ok(result(items, false, "incomplete", context, allocation));
            }
            charge_directory(&mut allocation, overhead + bytes + size)?;
            bytes += size;
            items.push(item);
        }
        if page["complete"] == true {
            return Ok(result(items, true, "ready", context, allocation));
        }
        let next = page["nextCursor"]
            .as_str()
            .ok_or_else(|| NetworkError::new("NETWORK_PAGE_INVALID"))?;
        if !cursors.insert(next.to_owned()) {
            return Err(NetworkError::new("NETWORK_PAGE_INVALID"));
        }
        cursor = Some(next.into());
    }
}
/// Reads are independent and parallel. Selection has no effect; failure keeps
/// other results and never retries a business route in another network.
pub(crate) async fn remote(
    owner: &super::registry::ManagedAgentNetwork,
    local_only: bool,
) -> Result<Value, NetworkError> {
    use futures_util::{stream::FuturesUnordered, StreamExt};
    let views = owner.view();
    let mut reads = FuturesUnordered::new();
    for connection in owner.all() {
        let name = views
            .connections
            .iter()
            .find(|v| v.id == connection.connection_id)
            .map(|v| v.name.clone())
            .unwrap_or_else(|| "MyAgents".into());
        reads.push(async move {
            let response = remote_connection(&connection, local_only, &name).await;
            (
                connection.connection_id.clone(),
                name,
                connection.snapshot(),
                response,
            )
        });
    }
    let mut items = Vec::new();
    let mut networks = Vec::new();
    let mut complete = true;
    let mut bytes = 0;
    let mut leases = Vec::new();
    let mut context = Value::Null;
    let mut ready = false;
    while let Some((id, name, snapshot, response)) = reads.next().await {
        match response {
            Ok((mut value, allocation)) => {
                if id == "official" {
                    context = value["context"].clone();
                }
                ready |= snapshot.state == "ready";
                complete &= value["complete"] == true;
                networks.push(json!({"connectionId":id,"networkName":name,"complete":value["complete"],"networkStatus":value["networkStatus"],"context":value["context"]}));
                if let Value::Array(entries) = value["items"].take() {
                    for item in entries {
                        let size = measure(&item)?.0;
                        if items.len() >= budget("catalogItems")
                            || bytes + size > budget("catalogBytes")
                        {
                            complete = false;
                            break;
                        }
                        bytes += size;
                        items.push(item);
                    }
                }
                leases.push(allocation);
            }
            Err(error) => {
                complete = false;
                networks.push(json!({"connectionId":id,"networkName":name,"complete":false,"networkStatus":"error","error":error,"context":null}));
            }
        }
    }
    Ok(
        json!({"items":items,"complete":complete,"networkStatus":if ready{"ready"}else if complete{"signedOut"}else{"incomplete"},"context":context,"networks":networks}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paginated_reads_charge_while_pending_and_release_on_cancellation() {
        let memory = super::super::memory::MemoryBudget::default();
        let mut reads = Vec::new();
        for _ in 0..7 {
            let mut lease = memory.reserve(0).unwrap();
            charge_directory(&mut lease, 8 * 1024 * 1024).unwrap();
            reads.push(lease);
        }
        let mut eighth = memory.reserve(0).unwrap();
        charge_directory(&mut eighth, 8 * 1024 * 1024).unwrap();
        let mut ninth = memory.reserve(0).unwrap();
        assert_eq!(
            charge_directory(&mut ninth, 1).unwrap_err().code,
            "CONNECTOR_CAPACITY"
        );
        // A cancelled partial directory releases its accumulated pages immediately.
        drop(eighth);
        charge_directory(&mut ninth, 8 * 1024 * 1024).unwrap();
        let merged = result(vec![], false, "error", Value::Null, ninth);
        assert!(memory.reserve(1).is_err());
        drop(merged);
        drop(reads);
        assert!(memory.reserve(128 * 1024 * 1024).is_ok());
    }
}
