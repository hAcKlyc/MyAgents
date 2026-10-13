use myagents_host_management_protocol::*;
use serde_json::{Value, json};
use uuid::Uuid;
fn request(method: &str, params: Value) -> Value {
    json!({"namespace":"host.management","version":1,"senderSequence":1,"channelId":Uuid::new_v4(),
        "message":{"kind":"request","requestId":Uuid::new_v4(),"method":method,"params":params}})
}
fn check(v: Value) -> bool {
    serde_json::from_value::<Frame>(v).is_ok_and(|f| encode_frame(&f).is_ok())
}
fn provider() -> Value {
    json!({"id":"portable-api","name":"桌面主 Agent","apiProtocol":"openai","baseUrl":"https://api.example.com/v1","authType":"both","upstreamFormat":"responses","modelAliases":{"sonnet":"vendor/model-1"}})
}
fn config() -> Value {
    json!({"provider":provider(),"model":"vendor/model-1","workspace":{"rootId":"workspaces","relativePath":"项目 A/资料"},"executionAuthorized":false,"expectedRevision":0,"mutationId":Uuid::new_v4()})
}
#[test]
fn extension_requests_are_closed_and_legacy_shapes_remain_restricted() {
    assert!(check(request("host.capabilities", json!({}))));
    assert!(check(request("host.inspect", json!({}))));
    assert!(check(request("config.provider.set", config())));
    let credential = json!({"providerId":"portable-api","credential":"synth-test-key","expectedRevision":0,"mutationId":Uuid::new_v4()});
    assert!(check(request(
        "credential.provider.set",
        credential.clone()
    )));
    assert!(!check(request("credential.set", credential)));
    assert!(!check(request("host.capabilities", json!({"env":true}))));
    let mut p = config();
    p["provider"]["headers"] = json!({"x-secret":"test"});
    assert!(!check(request("config.provider.set", p)));
    let mut p = config();
    p["provider"]["authType"] = json!("oauth");
    assert!(!check(request("config.provider.set", p)));
    assert!(!check(request(
        "receipt.provider.get",
        json!({"owner":"resources","providerId":"portable-api","mutationId":Uuid::new_v4()})
    )));
}
#[test]
fn provider_endpoint_model_and_utf8_directory_bounds() {
    for endpoint in [
        "http://api.example.com",
        "https://user:pass@api.example.com",
        "https://api.example.com?key=test",
        "https://api.example.com#fragment",
        "https://localhost:443",
        "https://127.0.0.1",
        "https://[::1]",
        "https://127.1",
        "https://0x7f000001",
    ] {
        let mut p = config();
        p["provider"]["baseUrl"] = json!(endpoint);
        assert!(!check(request("config.provider.set", p)), "{endpoint}");
    }
    for model in ["", "bad\nmodel", &"m".repeat(161)] {
        let mut p = config();
        p["model"] = json!(model);
        assert!(!check(request("config.provider.set", p)));
    }
    for path in ["", "项目 A", "项目 A/资料"] {
        assert!(check(request(
            "resources.directory.list",
            json!({"rootId":"workspaces","relativePath":path})
        )));
    }
    for path in [
        "/etc",
        "../x",
        "a/../b",
        "a/./b",
        "a//b",
        "a\\b",
        "a\0b",
        &"中".repeat(1366),
    ] {
        assert!(
            !check(request(
                "resources.directory.list",
                json!({"rootId":"workspaces","relativePath":path})
            )),
            "{path:?}"
        );
    }
    assert!(!check(request(
        "resources.register",
        json!({"rootId":"workspaces","relativePath":"","expectedRevision":0,"mutationId":Uuid::new_v4()})
    )));
    assert!(check(request(
        "resources.register",
        json!({"rootId":"workspaces","relativePath":"项目 A","expectedRevision":0,"mutationId":Uuid::new_v4()})
    )));
}
fn response(result: Value) -> Value {
    let mut f = request("host.snapshot", json!({}));
    f["message"] = json!({"kind":"response","requestId":Uuid::new_v4(),"result":result});
    f
}
#[test]
fn directory_results_cannot_escape_location_or_exceed_page() {
    let valid = json!({"kind":"directory-list","rootId":"workspaces","relativePath":"项目 A","entries":[{"name":"资料","relativePath":"项目 A/资料"}],"nextCursor":null});
    assert!(check(response(valid.clone())));
    let mut p = valid.clone();
    p["entries"][0]["relativePath"] = json!("other/资料");
    assert!(!check(response(p)));
    let mut p = valid.clone();
    p["entries"] = json!(vec![valid["entries"][0].clone(); 129]);
    assert!(!check(response(p)));
    let mut p = valid;
    p["entries"][0]["name"] = json!("../资料");
    assert!(!check(response(p)));
}
#[test]
fn generic_receipts_never_expand_legacy_dtos() {
    let settings = json!({"revision":1,"providerId":"portable-api","model":"vendor/model","workspace":{"rootId":"workspaces","relativePath":"项目 A"},"executionAuthorized":false});
    let mut receipt = json!({"kind":"provider-config-receipt","status":"persisted","mutationId":Uuid::new_v4(),"revision":1,"effect":"new-session","settings":settings});
    assert!(check(response(receipt.clone())));
    receipt["kind"] = json!("config-receipt");
    assert!(!check(response(receipt)));
    assert!(check(response(
        json!({"kind":"error","code":"HOST_MANAGEMENT_UPGRADE_REQUIRED"})
    )));
    let raw = request(
        "credential.provider.set",
        json!({"providerId":"portable-api","credential":"synth-test-key","expectedRevision":0,"mutationId":Uuid::new_v4()}),
    );
    let frame: Frame = serde_json::from_value(raw).unwrap();
    assert!(!format!("{frame:?}").contains("synth-test-key"));
}

#[test]
fn extended_snapshot_and_capabilities_are_closed_bounded_projections() {
    let snapshot = json!({"kind":"extended-snapshot","version":1,"hostId":Uuid::new_v4(),"configured":true,"provider":provider(),
        "settings":{"revision":1,"providerId":"portable-api","model":"vendor/model","workspace":{"rootId":"workspaces","relativePath":"项目 A"},"executionAuthorized":false},
        "activeSession":null,"stopping":false,"capabilities":[],"agentNet":{"available":true,"reason":null},"runtime":{"node":"24.0.0","sdkBinaryPresent":true},
        "credentials":{"providerId":"portable-api","configured":false,"revision":0,"writeAvailable":true},"resources":{"version":1,"revision":0,"roots":[],"agents":[]}});
    assert!(check(response(snapshot.clone())));
    let mut bad = snapshot.clone();
    bad["credentials"]["providerId"] = json!("other");
    assert!(!check(response(bad)));
    let mut bad = snapshot.clone();
    bad["credentials"]["credential"] = json!("test-secret");
    assert!(!check(response(bad)));
    let mut old = snapshot;
    old["kind"] = json!("snapshot");
    assert!(!check(response(old)));
    let capabilities = json!({"kind":"capabilities","version":1,"methods":["host.snapshot","host.capabilities","host.inspect"],"providerKinds":["anthropic","openai"],"limits":{"directoryEntries":128,"pathBytes":4096}});
    assert!(check(response(capabilities.clone())));
    let mut bad = capabilities.clone();
    bad["methods"] = json!(["host.capabilities", "host.capabilities"]);
    assert!(!check(response(bad)));
    let mut bad = capabilities;
    bad["limits"]["directoryEntries"] = json!(10000);
    assert!(!check(response(bad)));
}

#[test]
fn four_source_aliases_are_optional_closed_and_equally_bounded() {
    for aliases in [
        json!({"sonnet":"vendor/sonnet", "opus":"vendor/opus", "haiku":"vendor/haiku"}),
        json!({"fable":"vendor/fable", "sonnet":"vendor/sonnet", "opus":"vendor/opus", "haiku":"vendor/haiku"}),
        json!({"fable":"vendor/fable"}),
    ] {
        let mut p = config();
        p["provider"]["modelAliases"] = aliases;
        assert!(check(request("config.provider.set", p)));
    }
    for bad in [json!(""), json!("bad\nmodel"), json!("m".repeat(161))] {
        let mut p = config();
        p["provider"]["modelAliases"]["fable"] = bad;
        assert!(!check(request("config.provider.set", p)));
    }
    let mut p = config();
    p["provider"]["modelAliases"]["arbitrary"] = json!("vendor/model");
    assert!(!check(request("config.provider.set", p)));
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/host-management-v1.schema.json")).unwrap();
    let properties = schema["$defs"]["providerProfile"]["properties"]["modelAliases"]["properties"]
        .as_object()
        .unwrap();
    assert_eq!(properties.len(), 4);
    for name in ["fable", "sonnet", "opus", "haiku"] {
        assert_eq!(properties[name], json!({"$ref":"#/$defs/genericModel"}));
    }
}

#[test]
fn explicit_token_auth_clear_api_key_mode_survives_codec_round_trip() {
    let mut p = config();
    p["provider"]["authType"] = json!("auth_token_clear_api_key");
    let frame: Frame = serde_json::from_value(request("config.provider.set", p)).unwrap();
    let bytes = encode_frame(&frame).unwrap();
    let decoded = FrameDecoder::default().push(&bytes).unwrap();
    assert_eq!(decoded.len(), 1);
    let RequestParams::ConfigProviderSet(params) = (match &decoded[0].message {
        ManagementMessage::Request { params, .. } => params,
        _ => panic!("expected typed request"),
    }) else {
        panic!("expected provider config")
    };
    assert_eq!(params.provider.auth_type, AuthType::AuthTokenClearApiKey);
    let value = serde_json::to_value(&decoded[0]).unwrap();
    assert_eq!(
        value["message"]["params"]["provider"]["authType"],
        json!("auth_token_clear_api_key")
    );
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/host-management-v1.schema.json")).unwrap();
    assert!(
        schema["$defs"]["providerProfile"]["properties"]["authType"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!("auth_token_clear_api_key"))
    );
}

#[test]
fn hydrated_profile_preserves_versioned_origin_and_requires_safe_matching_metadata() {
    let mut profile = provider();
    profile["id"] = json!("host-api-012345abcdef");
    profile["sourceProviderId"] = json!("desktop-main-api");
    let mut p = config();
    p["provider"] = profile.clone();
    let frame: Frame = serde_json::from_value(request("config.provider.set", p)).unwrap();
    let bytes = encode_frame(&frame).unwrap();
    let decoded = FrameDecoder::default().push(&bytes).unwrap();
    assert_eq!(
        serde_json::to_value(&decoded[0]).unwrap()["message"]["params"]["provider"],
        profile
    );
    let valid = json!({"kind":"extended-snapshot","version":1,"hostId":Uuid::new_v4(),"configured":true,"provider":profile,
        "settings":{"revision":1,"providerId":"host-api-012345abcdef","model":"vendor/model","workspace":{"rootId":"workspaces","relativePath":"项目 A"},"executionAuthorized":false},
        "activeSession":null,"stopping":false,"capabilities":[],"agentNet":{"available":true,"reason":null},"runtime":{"node":"24.0.0","sdkBinaryPresent":true},
        "credentials":{"providerId":"host-api-012345abcdef","configured":false,"revision":0,"writeAvailable":true},"resources":{"version":1,"revision":0,"roots":[],"agents":[]}});
    assert!(check(response(valid.clone())));
    for bad_id in ["", "unsafe/id", &"i".repeat(129)] {
        let mut bad = valid.clone();
        bad["provider"]["sourceProviderId"] = json!(bad_id);
        assert!(!check(response(bad)));
    }
    let mut bad = valid.clone();
    bad["provider"]["id"] = json!("other");
    assert!(!check(response(bad)));
    let mut bad = valid.clone();
    bad["provider"]["apiKey"] = json!("synth-secret");
    assert!(!check(response(bad)));
    let mut bad = valid.clone();
    bad.as_object_mut().unwrap().remove("provider");
    assert!(!check(response(bad)));
    let mut bad = valid.clone();
    bad["provider"] = Value::Null;
    assert!(!check(response(bad)));
    let mut empty = valid;
    empty["configured"] = json!(false);
    empty["settings"] = Value::Null;
    empty["provider"] = Value::Null;
    let raw = response(empty);
    assert!(check(raw.clone()));
    let decoded: Frame = serde_json::from_value(raw).unwrap();
    assert_eq!(
        serde_json::to_value(decoded).unwrap()["message"]["result"]["provider"],
        Value::Null
    );
}
