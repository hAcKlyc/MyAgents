//! Shared validation for the fixed metadata catalog upload acknowledgement.

use myagents_agent_network_protocol::{validate_metadata, MetadataKind};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CatalogAckError {
    Invalid,
    NotCurrent,
}

pub(crate) fn validate_catalog_ack(
    value: &Value,
    expected_epoch: &str,
    expected_seq: u64,
) -> Result<(), CatalogAckError> {
    validate_metadata(MetadataKind::Catalog, value).map_err(|_| CatalogAckError::Invalid)?;
    if value.get("connectionEpoch").and_then(Value::as_str) != Some(expected_epoch)
        || value.get("catalogSeq").and_then(Value::as_u64) != Some(expected_seq)
    {
        return Err(CatalogAckError::NotCurrent);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_protocol::{validate_catalog, CatalogSnapshot};

    #[test]
    fn accepts_exact_ack_for_a_valid_zero_item_catalog() {
        let epoch = uuid::Uuid::new_v4().to_string();
        let snapshot = serde_json::to_value(CatalogSnapshot {
            version: 1,
            connection_epoch: epoch.clone(),
            catalog_seq: 1,
            items: vec![],
        })
        .unwrap();
        validate_catalog(&snapshot).unwrap();

        let ack = serde_json::json!({"connectionEpoch":epoch,"catalogSeq":1});
        validate_catalog_ack(&ack, &epoch, 1).unwrap();
    }

    #[test]
    fn rejects_ack_from_an_older_epoch_or_wrong_sequence() {
        let epoch = uuid::Uuid::new_v4().to_string();
        let old_epoch = uuid::Uuid::new_v4().to_string();
        let wrong_epoch = serde_json::json!({"connectionEpoch":old_epoch,"catalogSeq":3});
        assert_eq!(
            validate_catalog_ack(&wrong_epoch, &epoch, 3),
            Err(CatalogAckError::NotCurrent)
        );

        let wrong_seq = serde_json::json!({"connectionEpoch":epoch,"catalogSeq":2});
        assert_eq!(
            validate_catalog_ack(&wrong_seq, &epoch, 3),
            Err(CatalogAckError::NotCurrent)
        );
    }

    #[test]
    fn rejects_incomplete_mistyped_and_unknown_ack_fields() {
        let epoch = uuid::Uuid::new_v4().to_string();
        for malformed in [
            serde_json::json!({"connectionEpoch":epoch}),
            serde_json::json!({"connectionEpoch":epoch,"catalogSeq":"3"}),
            serde_json::json!({"connectionEpoch":epoch,"catalogSeq":3,"ready":true}),
        ] {
            assert_eq!(
                validate_catalog_ack(&malformed, &epoch, 3),
                Err(CatalogAckError::Invalid)
            );
        }
    }
}
