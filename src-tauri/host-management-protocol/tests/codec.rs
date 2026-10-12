use myagents_host_management_protocol::*;
use serde_json::{json, Value};
use uuid::Uuid;

fn id() -> CanonicalUuid {
    CanonicalUuid::new(Uuid::new_v4())
}
fn snapshot_frame(sequence: u64) -> Frame {
    Frame {
        namespace: NAMESPACE.into(),
        version: VERSION,
        sender_sequence: sequence,
        channel_id: id(),
        message: ManagementMessage::Request {
            request_id: id(),
            method: ManagementMethod::HostSnapshot,
            params: RequestParams::Snapshot(SnapshotParams {}),
        },
    }
}
fn encoded(value: Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value).unwrap();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend(body);
    out
}

#[test]
fn round_trip_and_partial_coalesced_frames() {
    let one = encode_frame(&snapshot_frame(1)).unwrap();
    let two = encode_frame(&snapshot_frame(2)).unwrap();
    let mut decoder = FrameDecoder::default();
    assert!(decoder.push(&one[..3]).unwrap().is_empty());
    assert_eq!(
        decoder
            .push(&[one[3..].to_vec(), two.clone()].concat())
            .unwrap()
            .len(),
        2
    );
    assert_eq!(decoder.buffered_len(), 0);
    decoder.finish().unwrap();
}

#[test]
fn rejects_unknown_fields_version_unsafe_sequence_and_noncanonical_uuid() {
    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["unexpected"] = json!(true);
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidJson)
    );

    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["version"] = json!(2);
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidFrame)
    );

    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["senderSequence"] = json!(MAX_SAFE_SEQUENCE + 1);
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidFrame)
    );

    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["channelId"] = json!(id().as_uuid().to_string().to_uppercase());
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidJson)
    );
}

#[test]
fn rejects_unknown_kind_method_and_mismatched_params() {
    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["message"]["kind"] = json!("invoke");
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidJson)
    );

    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["message"]["method"] = json!("host.stop");
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidJson)
    );

    let mut raw = serde_json::to_value(snapshot_frame(1)).unwrap();
    raw["message"]["method"] = json!("config.set");
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidFrame)
    );
}

#[test]
fn config_and_resource_dtos_are_closed_and_bounded() {
    let mut config = snapshot_frame(1);
    config.message = ManagementMessage::Request {
        request_id: id(),
        method: ManagementMethod::ConfigSet,
        params: RequestParams::ConfigSet(ConfigSetParams {
            expected_revision: 0,
            provider_id: "moonshot-coding".into(),
            model: "m".into(),
            workspace: None,
            execution_authorized: false,
            mutation_id: id(),
        }),
    };
    let mut raw = serde_json::to_value(config).unwrap();
    raw["message"]["params"]["workspace"] = Value::Null;
    assert_eq!(
        FrameDecoder::default().push(&encoded(raw)),
        Err(CodecError::InvalidJson)
    );

    let mut resource = snapshot_frame(1);
    resource.message = ManagementMessage::Request {
        request_id: id(),
        method: ManagementMethod::ResourcesCreate,
        params: RequestParams::ResourcesCreate(ResourcesCreateParams {
            root_id: "root".into(),
            relative_path: "safe/../escape".into(),
            expected_revision: 0,
            mutation_id: id(),
            operation: ResourceOperation::Create,
        }),
    };
    assert_eq!(encode_frame(&resource), Err(CodecError::InvalidFrame));
}

#[test]
fn malformed_length_utf8_oversize_and_truncated_eof_poison_decoder() {
    let mut d = FrameDecoder::default();
    assert_eq!(d.push(&0u32.to_be_bytes()), Err(CodecError::InvalidLength));
    assert!(d.is_poisoned());
    assert_eq!(d.push(&[]), Err(CodecError::Poisoned));

    let mut d = FrameDecoder::default();
    let mut frame = (1u32).to_be_bytes().to_vec();
    frame.push(0xff);
    assert_eq!(d.push(&frame), Err(CodecError::InvalidJson));

    let mut d = FrameDecoder::default();
    assert_eq!(
        d.push(&((MAX_OBJECT_BYTES as u32) + 1).to_be_bytes()),
        Err(CodecError::FrameTooLarge)
    );

    let mut d = FrameDecoder::default();
    d.push(&[0, 0]).unwrap();
    assert_eq!(d.finish(), Err(CodecError::InvalidLength));
    assert!(d.is_poisoned());
}

#[test]
fn receive_buffer_is_bounded() {
    let mut d = FrameDecoder::default();
    let bytes = vec![0; MAX_RECEIVE_BYTES + 1];
    assert_eq!(d.push(&bytes), Err(CodecError::ReceiveTooLarge));
    assert!(d.is_poisoned());
}
