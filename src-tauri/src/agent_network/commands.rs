//! Renderer requests contain only network metadata. The App actor holds all
//! credentials; no request may choose an account origin or arbitrary HTTP route.
use super::transport::NetworkRoute;
use super::NetworkError;
use myagents_agent_network_protocol::budget;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum MetadataRequest {
    Network,
    Devices {
        cursor: Option<String>,
        limit: usize,
    },
    DeviceName {
        network_id: String,
        device_id: String,
    },
    RenameDevice {
        network_id: String,
        device_id: String,
        name: String,
        expected_name: String,
        mutation_id: String,
    },
    Agents {
        device_id: String,
        cursor: Option<String>,
        limit: usize,
    },
    Callable {
        network_id: String,
        cursor: Option<String>,
        limit: usize,
    },
    Membership {
        network_id: String,
        device_id: String,
        joined: bool,
        mutation_id: String,
        expected_membership_revision: u64,
    },
    Enabled {
        network_id: String,
        mount_id: String,
        enabled: bool,
        mutation_id: String,
        expected_membership_revision: u64,
        expected_enable_revision: u64,
    },
    Description {
        network_id: String,
        mount_id: String,
        description: Option<String>,
        mutation_id: String,
        expected_membership_revision: u64,
        expected_description_revision: u64,
    },
    Receipt {
        mutation_id: String,
    },
}
impl MetadataRequest {
    pub(crate) fn route(&self) -> NetworkRoute<'_> {
        match self {
            Self::Network => NetworkRoute::Network,
            Self::Devices { cursor, limit } => NetworkRoute::Devices {
                cursor: cursor.as_deref(),
                limit: *limit,
            },
            Self::DeviceName {
                network_id,
                device_id,
            } => NetworkRoute::DeviceName {
                network_id,
                device_id,
                write: false,
            },
            Self::RenameDevice {
                network_id,
                device_id,
                ..
            } => NetworkRoute::DeviceName {
                network_id,
                device_id,
                write: true,
            },
            Self::Agents {
                device_id,
                cursor,
                limit,
            } => NetworkRoute::Agents {
                device_id,
                cursor: cursor.as_deref(),
                limit: *limit,
            },
            Self::Callable {
                network_id,
                cursor,
                limit,
            } => NetworkRoute::Callable {
                network_id,
                cursor: cursor.as_deref(),
                limit: *limit,
            },
            Self::Membership {
                network_id,
                device_id,
                joined,
                ..
            } => NetworkRoute::Membership {
                network_id,
                device_id,
                joined: *joined,
            },
            Self::Enabled {
                network_id,
                mount_id,
                ..
            }
            | Self::Description {
                network_id,
                mount_id,
                ..
            } => NetworkRoute::Mount {
                network_id,
                mount_id,
            },
            Self::Receipt { mutation_id } => NetworkRoute::Receipt { mutation_id },
        }
    }
    pub(crate) fn body(&self) -> Result<Option<Value>, NetworkError> {
        let value = match self {
            Self::RenameDevice {
                name,
                expected_name,
                mutation_id,
                ..
            } => Some(json!({
                "name": name, "expectedName": expected_name, "mutationId": mutation_id,
            })),
            Self::Membership {
                mutation_id,
                expected_membership_revision,
                ..
            } => Some(json!({"mutationId":mutation_id,
                "expectedMembershipRevision":expected_membership_revision})),
            Self::Enabled {
                mutation_id,
                expected_membership_revision,
                expected_enable_revision,
                enabled,
                ..
            } => Some(json!({
                "mutationId":mutation_id,"expectedMembershipRevision":expected_membership_revision,
                "expectedEnableRevision":expected_enable_revision,"enabled":enabled})),
            Self::Description {
                mutation_id,
                expected_membership_revision,
                expected_description_revision,
                description,
                ..
            } => {
                if description
                    .as_ref()
                    .is_some_and(|value| value.len() > budget("descriptionBytes"))
                {
                    return Err(NetworkError::new("DESCRIPTION_TOO_LARGE"));
                }
                Some(
                    json!({"mutationId":mutation_id,"expectedMembershipRevision":expected_membership_revision,
                    "expectedDescriptionRevision":expected_description_revision,"description":description}),
                )
            }
            Self::Network
            | Self::DeviceName { .. }
            | Self::Devices { .. }
            | Self::Agents { .. }
            | Self::Callable { .. }
            | Self::Receipt { .. } => None,
        };
        if let Some(value) = &value {
            let validation = if matches!(self, Self::RenameDevice { .. }) {
                myagents_agent_network_protocol::validate_device_name_mutation(value)
            } else {
                myagents_agent_network_protocol::validate_mutation(
                    matches!(self, Self::Membership { .. }),
                    value,
                )
            };
            validation.map_err(|_| NetworkError::new("MUTATION_INVALID"))?;
        }
        Ok(value)
    }
}
#[tauri::command]
pub(crate) fn cmd_agent_network_snapshot(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    connection_id: Option<String>,
) -> Result<super::actor::NetworkSnapshot, NetworkError> {
    Ok(state
        .connection(connection_id.as_deref().unwrap_or("official"))?
        .snapshot())
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_request(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    request: MetadataRequest,
    connection_id: Option<String>,
) -> Result<Value, NetworkError> {
    state
        .connection(connection_id.as_deref().unwrap_or("official"))?
        .request(request)
        .await
}

#[tauri::command]
pub(crate) async fn cmd_agent_discovery(
    local_only: Option<bool>,
    manager: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
) -> Result<Value, NetworkError> {
    super::local_owner::discovery(&manager, local_only.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_device_is_a_closed_cas_intent_with_shared_name_validation() {
        let input = json!({"kind":"renameDevice", "networkId":"11111111-1111-4111-8111-111111111111",
            "deviceId":"22222222-2222-4222-8222-222222222222", "name":"家里 Windows", "expectedName":"DESKTOP-123",
            "mutationId":"33333333-3333-4333-8333-333333333333"});
        let request: MetadataRequest = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(
            request.body().unwrap().unwrap()["expectedName"],
            "DESKTOP-123"
        );
        for name in [
            "".to_string(),
            " Mac".to_string(),
            "a\nb".to_string(),
            "😀".repeat(81),
        ] {
            let mut invalid = input.clone();
            invalid["name"] = json!(name);
            assert_eq!(
                serde_json::from_value::<MetadataRequest>(invalid)
                    .unwrap()
                    .body()
                    .unwrap_err()
                    .code,
                "MUTATION_INVALID"
            );
        }
        let mut invalid = input;
        invalid["origin"] = json!("https://untrusted.test");
        assert!(serde_json::from_value::<MetadataRequest>(invalid).is_err());
    }
}

#[tauri::command]
pub(crate) fn cmd_agent_network_connections(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
) -> super::registry::RegistryView {
    state.view()
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_select(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    connection_id: String,
) -> Result<super::registry::RegistryView, NetworkError> {
    state.select(&app, connection_id).await
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_join(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    manager: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    url: String,
    key: String,
) -> Result<super::registry::RegistryView, NetworkError> {
    state
        .inner()
        .join(
            app,
            manager.inner().clone(),
            url,
            zeroize::Zeroizing::new(key),
        )
        .await
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_owned_start(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    issuer: String,
    public_tls_ca_file: Option<String>,
) -> Result<super::owned_account_desktop::StartedLogin, NetworkError> {
    state
        .owned_start(&issuer, public_tls_ca_file.as_deref())
        .await
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_owned_open_authorization(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    attempt_id: String,
) -> Result<(), NetworkError> {
    state.owned_open(&attempt_id).await
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_owned_poll(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    manager: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    attempt_id: String,
) -> Result<OwnedPollResponse, NetworkError> {
    match state
        .inner()
        .owned_poll(app, manager.inner().clone(), &attempt_id)
        .await?
    {
        Some(registry) => Ok(OwnedPollResponse {
            status: "authenticated",
            registry: Some(registry),
        }),
        None => Ok(OwnedPollResponse {
            status: "pending",
            registry: None,
        }),
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedPollResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry: Option<super::registry::RegistryView>,
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_owned_cancel(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    attempt_id: String,
) -> Result<(), NetworkError> {
    state.owned_cancel(&attempt_id).await
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_owned_restore_credentials(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    manager: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    connection_id: String,
    expected_registry_revision: u64,
    operation_id: String,
) -> Result<super::registry::RegistryView, NetworkError> {
    state
        .inner()
        .owned_restore_credentials(
            app,
            manager.inner().clone(),
            connection_id,
            expected_registry_revision,
            operation_id,
        )
        .await
}
#[tauri::command]
pub(crate) fn cmd_agent_network_owned_restore_cancel(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    operation_id: String,
) -> Result<(), NetworkError> {
    state.owned_restore_cancel(&operation_id)
}
#[tauri::command]
pub(crate) async fn cmd_agent_network_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    connection_id: String,
) -> Result<super::registry::RegistryView, NetworkError> {
    state.inner().remove(app, connection_id).await
}

/// Owned management only; the registry and actor validate every locator fence.
#[tauri::command]
pub(crate) async fn cmd_agent_network_management(
    state: tauri::State<'_, super::actor::ManagedAgentNetwork>,
    request: super::management_controller::ManagementRequest,
) -> Result<super::management_controller::ManagementResponse, NetworkError> {
    state
        .connection(&request.connection_id)?
        .management(request)
        .await
}
