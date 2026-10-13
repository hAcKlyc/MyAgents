use myagents_agent_network_crypto::{
    certificate_chain, certificate_fingerprint, private_roots, DevicePrivateKey, InnerTls,
    TlsIdentity,
};
use myagents_agent_network_protocol::{
    validate_access, validate_business, validate_signed_peer, BusinessObject, ChannelHello,
    DeviceScope, PeerBinding,
};
use myagents_agentnet_identity_core::{
    IdentityRequest, IssuedIdentity, IssuerProfile, ServiceKeys,
};
use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, sync::Arc};
use uuid::Uuid;

struct Device {
    scope: DeviceScope,
    identity: TlsIdentity,
    issued: IssuedIdentity,
    binding: PeerBinding,
    jwk_thumbprint: String,
}

fn issue_device(
    keys: &ServiceKeys,
    profile: &IssuerProfile,
    principal: &str,
    generation: u64,
) -> Device {
    let key = Arc::new(DevicePrivateKey::generate().unwrap());
    let jwk_thumbprint = key.public_thumbprint().unwrap();
    let binding_id = Uuid::new_v4().to_string();
    let request = IdentityRequest {
        principal_id: principal.into(),
        device_id: Uuid::new_v4().to_string(),
        key_generation: generation,
        identity_binding_id: binding_id.clone(),
        session_handle: Uuid::new_v4().to_string(),
        csr_pem: key.csr().unwrap(),
    };
    let issued = keys.issue(profile, &request).unwrap();
    let claims = verify_signed_peer(&issued, keys, profile);
    let binding: PeerBinding = serde_json::from_value(claims["binding"].clone()).unwrap();
    assert_eq!(binding.principal_id, request.principal_id);
    assert_eq!(binding.device_id, request.device_id);
    assert_eq!(binding.key_generation, request.key_generation);
    assert_eq!(binding.service_id, profile.service_id);
    assert_eq!(binding.environment, profile.environment);
    assert_eq!(binding.identity_binding_id, binding_id);
    assert_eq!(binding.identity_binding_id, request.identity_binding_id);

    let leaf = issued.certificate.as_deref().unwrap();
    let mut chain = certificate_chain(leaf).unwrap();
    for pem in &issued.certificate_chain {
        chain.extend(certificate_chain(pem).unwrap());
    }
    let identity = TlsIdentity::new(chain, key).unwrap();
    assert_eq!(
        binding.certificate_fingerprint,
        issued.certificate_fingerprint.as_deref().unwrap()
    );
    assert_eq!(
        certificate_fingerprint(&identity.certificates[0]),
        binding.certificate_fingerprint
    );
    assert_eq!(binding.certificate, leaf);
    let scope = DeviceScope {
        service_id: profile.service_id.clone(),
        environment: profile.environment.clone(),
        network_id: profile.network_id.clone(),
        principal_id: request.principal_id,
        device_id: request.device_id,
        key_generation: request.key_generation,
    };
    Device {
        scope,
        identity,
        issued,
        binding,
        jwk_thumbprint,
    }
}

fn verify_access_token(
    issued: &IssuedIdentity,
    keys: &ServiceKeys,
    profile: &IssuerProfile,
) -> Value {
    let header = jsonwebtoken::decode_header(&issued.access_token).unwrap();
    assert_eq!(header.typ.as_deref(), Some("ma-network-access+jwt"));
    let set: jsonwebtoken::jwk::JwkSet = serde_json::from_value(keys.jwks()).unwrap();
    let key =
        jsonwebtoken::DecodingKey::from_jwk(set.find(header.kid.as_deref().unwrap()).unwrap())
            .unwrap();
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::ES256);
    validation.set_issuer(&[profile.issuer.as_str()]);
    validation.set_audience(&[profile.service_id.as_str()]);
    let claims = jsonwebtoken::decode::<Value>(&issued.access_token, &key, &validation)
        .unwrap()
        .claims;
    validate_access(&claims).unwrap();
    claims
}

fn verify_signed_peer(
    issued: &IssuedIdentity,
    keys: &ServiceKeys,
    profile: &IssuerProfile,
) -> Value {
    let token = issued.signed_binding.as_deref().unwrap();
    let header = jsonwebtoken::decode_header(token).unwrap();
    assert_eq!(header.typ.as_deref(), Some("ma-network-peer+jwt"));
    let set: jsonwebtoken::jwk::JwkSet = serde_json::from_value(keys.jwks()).unwrap();
    let jwk = set.find(header.kid.as_deref().unwrap()).unwrap();
    let key = jsonwebtoken::DecodingKey::from_jwk(jwk).unwrap();
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::ES256);
    validation.set_issuer(&[profile.issuer.as_str()]);
    validation.set_audience(&["myagents-agent-peer"]);
    let claims = jsonwebtoken::decode::<Value>(token, &key, &validation)
        .unwrap()
        .claims;
    validate_signed_peer(&claims).unwrap();
    claims
}

fn binding_matches_scope(
    binding: &PeerBinding,
    expected: &DeviceScope,
    profile: &IssuerProfile,
) -> bool {
    binding.principal_id == expected.principal_id
        && binding.device_id == expected.device_id
        && binding.key_generation == expected.key_generation
        && binding.service_id == expected.service_id
        && binding.environment == expected.environment
        && profile.service_id == expected.service_id
        && profile.environment == expected.environment
        && profile.network_id == expected.network_id
}

fn exchange_handshake(client: &mut InnerTls, server: &mut InnerTls) -> Result<(), String> {
    for _ in 0..32 {
        while let Some(chunk) = client.drain_chunk().map_err(|error| format!("{error:?}"))? {
            server
                .feed(&chunk)
                .map_err(|error| format!("server rejected client chain: {error:?}"))?;
        }
        while let Some(chunk) = server.drain_chunk().map_err(|error| format!("{error:?}"))? {
            client
                .feed(&chunk)
                .map_err(|error| format!("client rejected server chain: {error:?}"))?;
        }
        if client.verified() && server.verified() {
            return Ok(());
        }
    }
    Err("mutual TLS did not converge".into())
}

fn tls_pair(
    client_device: &Device,
    server_device: &Device,
    root_certificate_pem: &str,
    expected_server_name: String,
    expected_server_fingerprint: String,
) -> (InnerTls, InnerTls) {
    let roots = private_roots(root_certificate_pem).unwrap();
    let client = InnerTls::client(
        &client_device.identity,
        roots.clone(),
        expected_server_name,
        expected_server_fingerprint,
    )
    .unwrap();
    let server = InnerTls::server(
        &server_device.identity,
        roots,
        client_device.binding.san.clone(),
        client_device.binding.certificate_fingerprint.clone(),
    )
    .unwrap();
    (client, server)
}

#[test]
fn service_issued_two_device_identities_complete_mutual_tls_and_channel_hello() {
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let keys = ServiceKeys::generate_initial(dir.path().join("identity-keys.json")).unwrap();
    let profile = IssuerProfile {
        issuer: "https://agentnet.example.test".into(),
        service_id: Uuid::new_v4().to_string(),
        environment: "development".into(),
        network_id: Uuid::new_v4().to_string(),
    };
    let first = issue_device(&keys, &profile, "oidc:subject-one", 3);
    let second = issue_device(&keys, &profile, "oidc:subject-two", 1);
    for device in [&first, &second] {
        let claims = verify_access_token(&device.issued, &keys, &profile);
        assert_eq!(claims["sub"], device.scope.principal_id);
        assert_eq!(claims["deviceId"], device.scope.device_id);
        assert_eq!(claims["keyGeneration"], device.scope.key_generation);
        assert_eq!(claims["environment"], profile.environment);
        assert_eq!(claims["cnf"]["jkt"], device.jwk_thumbprint);
    }
    let root_pem = first.issued.certificate_chain.last().unwrap();
    assert_eq!(
        root_pem,
        second.issued.certificate_chain.last().unwrap(),
        "both device chains must terminate at the service's pinned root"
    );
    let (mut client, mut server) = tls_pair(
        &first,
        &second,
        root_pem,
        second.binding.san.clone(),
        second.binding.certificate_fingerprint.clone(),
    );
    exchange_handshake(&mut client, &mut server).unwrap();

    // Use the real AgentNet ChannelHello schema over the verified TLS channel.
    let channel_id = Uuid::new_v4().to_string();
    let hello = BusinessObject::Hello(ChannelHello {
        version: 1,
        sender_sequence: 1,
        channel_id: channel_id.clone(),
        source: first.scope.clone(),
        target: second.scope.clone(),
        source_connection_epoch: Uuid::new_v4().to_string(),
        target_connection_epoch: Uuid::new_v4().to_string(),
    });
    let value = serde_json::to_value(&hello).unwrap();
    validate_business(&value).unwrap();
    let encoded = myagents_agent_network_protocol::encode_object(&value).unwrap();
    client.write_plaintext(&encoded).unwrap();
    let mut received = Vec::new();
    while let Some(chunk) = client.drain_chunk().unwrap() {
        received.extend(server.feed(&chunk).unwrap());
    }
    let size = u32::from_be_bytes(received[..4].try_into().unwrap()) as usize;
    assert_eq!(size, received.len() - 4);
    let decoded: Value = serde_json::from_slice(&received[4..]).unwrap();
    let parsed = BusinessObject::parse(decoded).unwrap();
    match parsed {
        BusinessObject::Hello(got) => {
            assert_eq!(got.channel_id, channel_id);
            assert!(got.source == first.scope);
            assert!(got.target == second.scope);
        }
        _ => panic!("expected AgentNet ChannelHello"),
    }
    let reply = BusinessObject::Hello(ChannelHello {
        version: 1,
        sender_sequence: 1,
        channel_id: channel_id.clone(),
        source: second.scope.clone(),
        target: first.scope.clone(),
        source_connection_epoch: Uuid::new_v4().to_string(),
        target_connection_epoch: Uuid::new_v4().to_string(),
    });
    let value = serde_json::to_value(&reply).unwrap();
    validate_business(&value).unwrap();
    server
        .write_plaintext(&myagents_agent_network_protocol::encode_object(&value).unwrap())
        .unwrap();
    let mut received = Vec::new();
    while let Some(chunk) = server.drain_chunk().unwrap() {
        received.extend(client.feed(&chunk).unwrap());
    }
    let size = u32::from_be_bytes(received[..4].try_into().unwrap()) as usize;
    assert_eq!(size, received.len() - 4);
    let decoded: Value = serde_json::from_slice(&received[4..]).unwrap();
    match BusinessObject::parse(decoded).unwrap() {
        BusinessObject::Hello(got) => {
            assert_eq!(got.channel_id, channel_id);
            assert!(got.source == second.scope);
            assert!(got.target == first.scope);
        }
        _ => panic!("expected reverse AgentNet ChannelHello"),
    }

    // The signed peer binding joins the presented TLS certificate to principal,
    // device, generation, service and environment. The current wire binding
    // schema has no networkId, so that dimension is checked against the trusted
    // service profile rather than claimed to be present in the signed binding.
    assert!(binding_matches_scope(
        &first.binding,
        &first.scope,
        &profile
    ));
    for (mut wrong_scope, label) in [
        (
            {
                let mut s = first.scope.clone();
                s.principal_id = second.scope.principal_id.clone();
                s
            },
            "principal",
        ),
        (
            {
                let mut s = first.scope.clone();
                s.device_id = second.scope.device_id.clone();
                s
            },
            "device",
        ),
        (
            {
                let mut s = first.scope.clone();
                s.key_generation += 1;
                s
            },
            "generation",
        ),
        (
            {
                let mut s = first.scope.clone();
                s.network_id = Uuid::new_v4().to_string();
                s
            },
            "network",
        ),
    ] {
        assert!(
            !binding_matches_scope(&first.binding, &wrong_scope, &profile),
            "peer binding must reject mismatched {label}"
        );
        // Prevent an accidental future change from making the case identical.
        wrong_scope.device_id = Uuid::new_v4().to_string();
    }

    // A different trust anchor must not complete TLS even with otherwise
    // correct SAN/fingerprint pins.
    let untrusted =
        ServiceKeys::generate_initial(dir.path().join("other-identity-keys.json")).unwrap();
    let (mut client, mut server) = tls_pair(
        &first,
        &second,
        untrusted.root_certificate_pem(),
        second.binding.san.clone(),
        second.binding.certificate_fingerprint.clone(),
    );
    assert!(exchange_handshake(&mut client, &mut server).is_err());

    // Both name and exact leaf fingerprint are mandatory independent pins.
    let (mut client, mut server) = tls_pair(
        &first,
        &second,
        root_pem,
        "wrong.devices.example.invalid".into(),
        second.binding.certificate_fingerprint.clone(),
    );
    assert!(exchange_handshake(&mut client, &mut server).is_err());
    let (mut client, mut server) = tls_pair(
        &first,
        &second,
        root_pem,
        second.binding.san.clone(),
        "wrong-certificate-fingerprint".into(),
    );
    assert!(exchange_handshake(&mut client, &mut server).is_err());
}
