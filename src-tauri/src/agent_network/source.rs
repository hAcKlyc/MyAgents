//! Fixed Node Host → App entry. Host provenance is supplied only after the
//! existing CLI capability gate; source Session identity comes from the live
//! Sidecar generation, never from query parameters or a remote device.
use super::{
    actor::ManagedAgentNetwork, catalog::read_local_catalog, commands::MetadataRequest,
    NetworkError,
};
use crate::sidecar::ManagedSidecarManager;
use myagents_agent_network_protocol::{SourceRequest, VerifiedCaller};
use serde::Deserialize;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InvokeRequest {
    pub sidecar_id: String,
    pub source_kind: SourceKind,
    pub request: SourceRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SourceKind {
    InternalSession,
    ExternalCli,
}

/// Presentation only: the network directory owns this same display name.
/// Keep the existing caller label budget, including non-BMP names.
fn network_caller_label(agent_name: &str, device_name: Option<&str>) -> String {
    let label = match device_name {
        Some(device) => format!("{agent_name}@{device}"),
        None => agent_name.to_owned(),
    };
    let mut units = 0;
    label
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= 320
        })
        .collect()
}

fn registered_caller_label(
    agent_name: &str,
    device: &serde_json::Value,
    device_id: &str,
    network_id: &str,
    principal_id: Option<&str>,
) -> Result<String, NetworkError> {
    if device["deviceId"] != device_id
        || device["networkId"] != network_id
        || device["principalId"].as_str() != principal_id
    {
        return Err(NetworkError::new("NETWORK_METADATA_SCOPE_MISMATCH"));
    }
    let name = device["name"]
        .as_str()
        .ok_or_else(|| NetworkError::new("NETWORK_METADATA_INVALID"))?;
    Ok(network_caller_label(agent_name, Some(name)))
}

pub(crate) async fn invoke(
    owner: &ManagedAgentNetwork,
    manager: &ManagedSidecarManager,
    generation: u64,
    input: InvokeRequest,
    queued_at: Instant,
) -> Result<super::calls::CallResult, NetworkError> {
    // Account for the query during original source identity/catalog preparation,
    // not only after it reaches the connector command queue.
    // The operation owns the selector type; a Session reference carries the
    // same Agent scope for connection routing and keeps its exact Session ID.
    let reference = input
        .request
        .reference()
        .map_err(|_| NetworkError::new("PROTOCOL_INVALID"))?;
    let owner = owner.for_reference(&reference.agent)?;
    let allocation = owner.reserve_payload(&input.request)?;
    let request = input.request;
    let network_generation = owner.generation();
    let live_source = {
        let manager = manager
            .lock()
            .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?;
        if !manager.is_live_process(&input.sidecar_id, generation) {
            return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
        }
        match input.source_kind {
            SourceKind::ExternalCli => None,
            SourceKind::InternalSession => Some(
                manager
                    .resolve_session_process_source(&input.sidecar_id, generation)
                    .ok_or_else(|| NetworkError::new("SOURCE_SESSION_REQUIRED"))?,
            ),
        }
    };
    let caller = if let Some(source) = live_source {
        let catalog = read_local_catalog(manager).await?;
        let path = crate::cron_task::normalize_path(&source.workspace_path.to_string_lossy());
        let mut identities = catalog.iter().filter(|item| {
            let canonical = std::fs::canonicalize(&item.path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&item.path));
            crate::cron_task::normalize_path(&canonical.to_string_lossy()) == path
        });
        let identity = identities
            .next()
            .ok_or_else(|| NetworkError::new("SOURCE_AGENT_NOT_FOUND"))?;
        if identities.next().is_some() {
            return Err(NetworkError::new("SOURCE_AGENT_IDENTITY_CONFLICT"));
        }
        let current = manager
            .lock()
            .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
            .resolve_session_process_source(&input.sidecar_id, generation)
            .ok_or_else(|| NetworkError::new("SOURCE_GENERATION_CHANGED"))?;
        if current.product_session_id != source.product_session_id
            || current.workspace_path != source.workspace_path
        {
            return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
        }
        let snapshot = owner.snapshot();
        let network_id = snapshot
            .network_id
            .ok_or_else(|| NetworkError::new("CONNECTOR_NOT_READY"))?;
        let device_id = owner.local_device_identity()?.device_id;
        let device = owner
            .request(MetadataRequest::DeviceName {
                network_id: network_id.clone(),
                device_id: device_id.clone(),
            })
            .await?;
        let label = registered_caller_label(
            &identity.name,
            &device,
            &device_id,
            &network_id,
            snapshot.principal_id.as_deref(),
        )?;
        VerifiedCaller::Internal {
            source_session_id: current.product_session_id,
            source_agent_id: identity.local_agent_id.clone(),
            label,
        }
    } else {
        VerifiedCaller::External {
            label: "External CLI".into(),
        }
    };
    // Catalog preparation cannot reset either the deadline or auth generation.
    if !manager
        .lock()
        .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
        .is_live_process(&input.sidecar_id, generation)
    {
        return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
    }
    owner
        .invoke(request, caller, queued_at, network_generation, allocation)
        .await
}

pub(crate) async fn return_event(
    owner: &ManagedAgentNetwork,
    manager: &ManagedSidecarManager,
    generation: u64,
    input: super::returns::CallbackRequest,
) -> Result<myagents_agent_network_protocol::ReturnSettlement, NetworkError> {
    let source = {
        let state = manager
            .lock()
            .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?;
        state
            .resolve_session_process_source(&input.sidecar_id, generation)
            .ok_or_else(|| NetworkError::new("SOURCE_GENERATION_CHANGED"))?
    };
    if input.event["sourceSessionId"] != source.product_session_id {
        return Err(NetworkError::new("RETURN_SESSION_SCOPE_MISMATCH"));
    }
    owner
        .connection(
            input
                .reference
                .connection_id
                .as_deref()
                .unwrap_or("official"),
        )?
        .return_event(source.product_session_id, input.reference, input.event)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WatchesRequest {
    pub sidecar_id: String,
    pub cancel: Option<String>,
    #[serde(default)]
    pub all: bool,
}
pub(crate) async fn watches(
    owner: &ManagedAgentNetwork,
    manager: &ManagedSidecarManager,
    generation: u64,
    input: WatchesRequest,
) -> Result<serde_json::Value, NetworkError> {
    if input.all && input.cancel.is_some() {
        return Err(NetworkError::new("NETWORK_ARGUMENT_INVALID"));
    }
    let source = manager
        .lock()
        .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
        .resolve_session_process_source(&input.sidecar_id, generation)
        .ok_or_else(|| NetworkError::new("SOURCE_SESSION_REQUIRED"))?;
    let mut listings = Vec::new();
    let mut complete = true;
    for connection in owner.all() {
        let epoch = connection.generation();
        match connection
            .watches(source.product_session_id.clone(), None, false, epoch)
            .await
        {
            Ok(value) => listings.push((connection, epoch, value)),
            Err(_) => complete = false,
        }
    }
    let local_read =
        crate::inbox::watch::manage_local_watches(manager, &source.product_session_id, None, false)
            .await?;
    if let Some(cancel) = &input.cancel {
        let matches = listings
            .iter()
            .filter(|(_, _, v)| {
                v["watches"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|w| w["watchId"].as_str() == Some(cancel)))
            })
            .count()
            + usize::from(
                local_read
                    .iter()
                    .any(|w| w["watchId"].as_str() == Some(cancel)),
            );
        if matches > 1 {
            return Err(NetworkError::new("WATCH_ID_AMBIGUOUS"));
        }
        if !complete {
            return Err(NetworkError::new("NETWORK_QUERY_FAILED"));
        }
    }
    let mut watches = Vec::new();
    for (connection, epoch, value) in listings {
        let owns = input.cancel.as_ref().is_some_and(|cancel| {
            value["watches"]
                .as_array()
                .is_some_and(|a| a.iter().any(|w| w["watchId"].as_str() == Some(cancel)))
        });
        let result = if input.all || owns {
            connection
                .watches(
                    source.product_session_id.clone(),
                    input.cancel.clone(),
                    input.all,
                    epoch,
                )
                .await?
        } else {
            value
        };
        for mut item in result["watches"].as_array().cloned().unwrap_or_default() {
            item["connectionId"] = serde_json::json!(connection.connection_id);
            watches.push(item);
        }
    }
    let local = if input.all
        || input
            .cancel
            .as_ref()
            .is_some_and(|id| local_read.iter().any(|w| w["watchId"].as_str() == Some(id)))
    {
        crate::inbox::watch::manage_local_watches(
            manager,
            &source.product_session_id,
            input.cancel.as_deref(),
            input.all,
        )
        .await?
    } else {
        local_read
    };
    watches.extend(local);
    if !manager
        .lock()
        .map_err(|_| NetworkError::new("SOURCE_OWNER_UNAVAILABLE"))?
        .is_live_process(&input.sidecar_id, generation)
    {
        return Err(NetworkError::new("SOURCE_GENERATION_CHANGED"));
    }
    Ok(serde_json::json!({"watches":watches,"complete":complete}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_request_label_carries_the_registered_device_name() {
        assert_eq!(
            network_caller_label("Mino", Some("Example-Mac.local")),
            "Mino@Example-Mac.local"
        );
        assert_eq!(
            network_caller_label("Mino", Some("EXAMPLE-WIN")),
            "Mino@EXAMPLE-WIN"
        );
        assert_eq!(network_caller_label("Mino", None), "Mino");
    }

    #[test]
    fn caller_label_uses_the_network_nickname_and_requires_its_account_device_scope() {
        let name = serde_json::json!({"deviceId":"device-b", "networkId":"network", "principalId":"account", "name":"家里 Windows"});
        assert_eq!(
            registered_caller_label("Mino", &name, "device-b", "network", Some("account")).unwrap(),
            "Mino@家里 Windows"
        );
        for (device, network, account) in [
            ("device-a", "network", "account"),
            ("device-b", "other", "account"),
            ("device-b", "network", "other"),
        ] {
            assert_eq!(
                registered_caller_label("Mino", &name, device, network, Some(account))
                    .unwrap_err()
                    .code,
                "NETWORK_METADATA_SCOPE_MISMATCH"
            );
        }
    }

    #[test]
    fn network_request_label_stays_within_the_protocol_utf16_budget() {
        let label = network_caller_label(&"😀".repeat(159), Some("Win"));
        assert_eq!(label.encode_utf16().count(), 320);
        assert_eq!(label, format!("{}@W", "😀".repeat(159)));
    }
}
