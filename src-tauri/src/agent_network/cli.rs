//! Bounded external CLI DTOs. Authentication remains in the existing Sidecar
//! admission + generation gate; PKCE, keys and publication stay in native owners.
use super::{registry::RegistryView, NetworkError};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Status {
        sidecar_id: String,
    },
    Login {
        sidecar_id: String,
        connection_id: String,
        expected_revision: u64,
    },
    Poll {
        sidecar_id: String,
        attempt_id: String,
    },
    Cancel {
        sidecar_id: String,
        attempt_id: String,
    },
    Restore {
        sidecar_id: String,
        connection_id: String,
        expected_revision: u64,
        operation_id: String,
    },
    CancelRestore {
        sidecar_id: String,
        operation_id: String,
    },
}
impl Request {
    pub(crate) fn sidecar_id(&self) -> &str {
        match self {
            Self::Status { sidecar_id }
            | Self::Login { sidecar_id, .. }
            | Self::Poll { sidecar_id, .. }
            | Self::Cancel { sidecar_id, .. }
            | Self::Restore { sidecar_id, .. }
            | Self::CancelRestore { sidecar_id, .. } => sidecar_id,
        }
    }
    pub(crate) fn validate(&self) -> Result<(), NetworkError> {
        let valid_id =
            |id: &str| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control);
        let uuid = |id: &str| uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id);
        let valid = valid_id(self.sidecar_id())
            && match self {
                Self::Status { .. } => true,
                Self::Login {
                    connection_id,
                    expected_revision,
                    ..
                } => valid_id(connection_id) && *expected_revision <= 9_007_199_254_740_991,
                Self::Poll { attempt_id, .. } | Self::Cancel { attempt_id, .. } => uuid(attempt_id),
                Self::Restore {
                    connection_id,
                    expected_revision,
                    operation_id,
                    ..
                } => {
                    valid_id(connection_id)
                        && *expected_revision <= 9_007_199_254_740_991
                        && uuid(operation_id)
                }
                Self::CancelRestore { operation_id, .. } => uuid(operation_id),
            };
        if valid {
            Ok(())
        } else {
            Err(NetworkError::new("NETWORK_ARGUMENT_INVALID"))
        }
    }
}
/// Explicit projection: errors never include details, keys, descriptors, account
/// tokens, PKCE state, or configuration. Authenticated != transport ready.
pub(crate) fn status(view: RegistryView) -> Value {
    let connections: Vec<_> = view.connections.into_iter().map(|c| json!({
        "id": c.id, "name": c.name, "official": c.official, "removing":c.removing,
        "localDeviceId": c.local_device_id, "ownedAccount": c.owned_account,
        "state": c.snapshot.state, "revision":c.snapshot.revision,
        "error": c.snapshot.error.map(|error| json!({"code":error.code,"retryable":error.retryable})),
    })).collect();
    json!({"revision":view.revision,"selfhostEnabled":view.selfhost_enabled,"connections":connections})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_action_schema_rejects_credentials_and_identity_override() {
        for field in [
            "password",
            "token",
            "issuer",
            "deviceId",
            "principalId",
            "publicTlsCaFile",
            "join",
        ] {
            let mut body = json!({"action":"login","sidecarId":"global","connectionId":"saved","expectedRevision":0});
            body[field] = json!("injected");
            assert!(serde_json::from_value::<Request>(body).is_err(), "{field}");
        }
        assert!(
            serde_json::from_value::<Request>(json!({"action":"join","sidecarId":"global"}))
                .is_err()
        );
    }
    #[test]
    fn identifiers_and_revisions_are_bounded_before_dispatch() {
        for revision in [0_u64, 9_007_199_254_740_991, 9_007_199_254_740_992] {
            let request:Request = serde_json::from_value(json!({"action":"login","sidecarId":"global","connectionId":"saved","expectedRevision":revision})).unwrap();
            assert_eq!(
                request.validate().is_ok(),
                revision <= 9_007_199_254_740_991
            );
        }
        for id in ["bad", "", "00000000-0000-4000-8000-000000000001"] {
            let request: Request = serde_json::from_value(
                json!({"action":"poll","sidecarId":"global","attemptId":id}),
            )
            .unwrap();
            assert_eq!(request.validate().is_ok(), id.len() == 36);
        }
        let request:Request=serde_json::from_value(json!({"action":"cancel-restore","sidecarId":"global","operationId":"00000000-0000-4000-8000-000000000001"})).unwrap();
        request.validate().unwrap();
    }
    #[test]
    fn status_projects_no_auth_material_or_unverified_readiness() {
        let owner = super::super::registry::NetworkRegistry::new();
        let view = status(owner.view());
        assert!(view.get("revision").is_some());
        for key in [
            "authorizationUrl",
            "token",
            "descriptor",
            "selected",
            "ownedServiceUrl",
        ] {
            assert!(view.get(key).is_none());
        }
    }
}
