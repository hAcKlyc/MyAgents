use myagents_host_management_protocol::*;
use serde_json::{Value, json};
fn request(value: Value) -> Option<Frame> {
    let f:Frame=serde_json::from_value(json!({"namespace":NAMESPACE,"version":1,"senderSequence":1,"channelId":"00000000-0000-0000-0000-000000000001","message":{"kind":"request","requestId":"00000000-0000-0000-0000-000000000002","method":"session.remote","params":{"remoteSession":value}}})).ok()?;
    f.validate().ok()?;
    Some(f)
}
#[test]
fn closed_fields_and_bounds() {
    let valid = json!({"kind":"send","agentId":"agent:one","sessionId":"session-1","operationId":"00000000-0000-0000-0000-000000000003","text":"hello"});
    let f = request(valid.clone()).unwrap();
    assert_eq!(
        f.message,
        FrameDecoder::default()
            .push(&encode_frame(&f).unwrap())
            .unwrap()
            .remove(0)
            .message
    );
    for key in [
        "workspacePath",
        "caller",
        "provider",
        "runtime",
        "model",
        "credential",
    ] {
        let mut value = valid.clone();
        value[key] = json!("unexpected");
        assert!(request(value).is_none(), "{key}");
    }
    for key in ["operationId", "sessionId", "agentId"] {
        let mut value = valid.clone();
        value[key] = json!("/../../etc");
        assert!(request(value).is_none());
    }
    let mut value = valid;
    value["text"] = json!("x".repeat(8001));
    assert!(request(value).is_none());
    assert!(
        request(json!({"kind":"get","agentId":"a","sessionId":"s","limit":30,"before":null}))
            .is_none()
    );
    assert!(request(json!({"kind":"get","agentId":"a","sessionId":"s","limit":31})).is_none());
}
#[test]
fn response_scope_operation_and_required_nullability() {
    let req:RemoteSessionRequest=serde_json::from_value(json!({"kind":"send","agentId":"a","sessionId":"s","operationId":"00000000-0000-0000-0000-000000000003","text":"hello"})).unwrap();
    let value = json!({"kind":"receipt","agentId":"a","sessionId":"s","operationId":"00000000-0000-0000-0000-000000000003","status":"processing","code":null});
    let result: RemoteSessionResult = serde_json::from_value(value.clone()).unwrap();
    assert!(result.validate().is_ok());
    assert!(req.matches_result(&result));
    let mut value = value.clone();
    value["sessionId"] = json!("other");
    assert!(!req.matches_result(&serde_json::from_value(value.clone()).unwrap()));
    let mut value = value.clone();
    value.as_object_mut().unwrap().remove("code");
    assert!(serde_json::from_value::<RemoteSessionResult>(value.clone()).is_err());
    value["code"] = Value::Null;
    value["caller"] = json!("a");
    assert!(serde_json::from_value::<RemoteSessionResult>(value.clone()).is_err());
}
#[test]
fn mutation_contract_and_utf16_parity() {
    let start = json!({"kind":"start","agentId":"a","operationId":"00000000-0000-0000-0000-000000000003","text":"😀".repeat(4000)});
    assert!(request(start.clone()).is_some());
    let mut long = start;
    long["text"] = json!("😀".repeat(4001));
    assert!(request(long).is_none());
    let request:RemoteSessionRequest=serde_json::from_value(json!({"kind":"receipt","agentId":"a","operationId":"00000000-0000-0000-0000-000000000003"})).unwrap();
    assert!(!request.mutation());
}
#[test]
fn owned_cross_language_fixtures_cover_every_variant() {
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/remote-session-v1.json")).unwrap();
    for value in fixtures["requests"].as_array().unwrap() {
        assert!(request(value.clone()).is_some(), "{value}");
    }
    for value in fixtures["results"].as_array().unwrap() {
        let result: RemoteSessionResult = serde_json::from_value(value.clone()).unwrap();
        result.validate().unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), *value);
    }
}
#[test]
fn combined_projection_obeys_remote_budget_below_transport_ceiling() {
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/remote-session-v1.json")).unwrap();
    let mut snapshot = fixtures["results"][2].clone();
    let message = json!({"id":"message-1","role":"assistant","timestamp":"now","content":"x".repeat(16000),"truncated":false,"tools":[]});
    snapshot["messages"] = json!([message.clone(), message.clone(), message.clone(), message]);
    assert!(serde_json::to_vec(&snapshot).unwrap().len() > REMOTE_SESSION_BYTES);
    assert!(serde_json::to_vec(&snapshot).unwrap().len() < MAX_OBJECT_BYTES);
    let result: RemoteSessionResult = serde_json::from_value(snapshot).unwrap();
    assert_eq!(result.validate(), Err(CodecError::InvalidFrame));
}
