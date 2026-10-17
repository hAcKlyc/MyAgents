use myagents_agent_network_protocol::{
    validate_business, validate_catalog, validate_control, validate_access, validate_server_control, ServerEnvelope, AgentReference, BusinessObject,
    SessionReference,
};
use serde_json::Value;

#[test]
fn device_name_mutations_agree_with_typescript() {
    let fixtures: Value = serde_json::from_str(include_str!(
        concat!(env!("OUT_DIR"), "/fixtures/device-names.json")
    )).unwrap();
    for case in fixtures.as_array().unwrap() {
        assert_eq!(myagents_agent_network_protocol::validate_device_name_mutation(&case["value"]).is_ok(),
            case["valid"].as_bool().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn shared_wire_fixtures_agree_with_typescript() {
    let fixtures: Value = serde_json::from_str(include_str!(
        concat!(env!("OUT_DIR"), "/fixtures/parity.json")
    ))
    .unwrap();
    for case in fixtures["references"].as_array().unwrap() {
        let input = case["value"].as_str().unwrap();
        let valid = if case["kind"] == "agent" {
            AgentReference::parse(input).is_ok()
        } else {
            SessionReference::parse(input).is_ok()
        };
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{input}");
    }
    for (section, validate) in [
        (
            "business",
            validate_business
                as fn(&Value) -> Result<(), myagents_agent_network_protocol::ProtocolError>,
        ),
        ("controls", validate_control),
        ("catalogs", validate_catalog),
        ("access", validate_access),
        ("serverControls", validate_server_control),
    ] {
        for case in fixtures[section].as_array().unwrap() {
            assert_eq!(
                validate(&case["value"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn typed_business_dispatch_agrees_with_shared_schema() {
    let fixtures: Value = serde_json::from_str(include_str!(
        concat!(env!("OUT_DIR"), "/fixtures/parity.json")
    ))
    .unwrap();
    for case in fixtures["business"].as_array().unwrap() {
        let result = BusinessObject::parse(case["value"].clone());
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(typed) = result {
            let encoded = serde_json::to_value(&typed).unwrap();
            assert_eq!(
                encoded, case["value"],
                "typed serialization must preserve the entire object"
            );
        }
    }
}

#[test]
fn typed_control_contracts_include_fresh_peer_bindings_and_credits() {
    let fixtures:Value=serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/fixtures/parity.json"))).unwrap();
    for case in fixtures["serverControls"].as_array().unwrap() {
        let encoded=serde_json::to_vec(&case["value"]).unwrap();
        assert_eq!(ServerEnvelope::parse(&encoded).is_ok(),case["valid"].as_bool().unwrap(),"{}",case["name"]);
    }
}

#[test]
fn negotiated_return_recovery_controls_match_the_fixed_schema() {
    use myagents_agent_network_protocol::{ClientEnvelope, ClientMessage, ConnectionScope, ServerMessage};
    use serde_json::json;
    let scope = ConnectionScope {
        service_id: "00000000-0000-4000-8000-000000000001".into(),
        network_id: "00000000-0000-4000-8000-000000000002".into(),
        boot_epoch: "00000000-0000-4000-8000-000000000003".into(),
        connection_epoch: "00000000-0000-4000-8000-000000000004".into(),
    };
    let route = "00000000-0000-4000-8000-000000000005";
    let resume = ClientEnvelope { version: 1, control_id: route.into(), message: ClientMessage::Resume { scope: scope.clone(), return_route_id: route.into() } };
    let value = serde_json::to_value(resume).unwrap();
    validate_control(&value).unwrap();
    for (kind, extra) in [
        ("route.suspended", json!({"remainingMs":900000})),
        ("route.resumed", json!({"sourceConnectionEpoch":scope.connection_epoch,"targetConnectionEpoch":scope.boot_epoch})),
    ] {
        let mut value = serde_json::to_value(&scope).unwrap();
        let obj = value.as_object_mut().unwrap();
        obj.extend(json!({"version":1,"controlId":route,"type":kind,"returnRouteId":route}).as_object().unwrap().clone());
        obj.extend(extra.as_object().unwrap().clone());
        let typed = ServerEnvelope::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(typed.message, ServerMessage::RouteSuspended {..} | ServerMessage::RouteResumed {..}));
    }
}
