//! Desktop uses the shared crypto implementation with the original explicit OS store.
pub use myagents_agent_network_crypto::*;

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) use myagents_agent_network_crypto::tests::Fixture;
    #[test]
    fn network_channel_requires_encrypted_scope_hello_and_preserves_pair_sequences() {
        use super::super::channel::{Channel, PairSequences};
        use super::super::jwt::VerifiedPeer;
        use myagents_agent_network_protocol::{decode_tls_frame, DeviceScope, PeerBinding};
        let fixture = Fixture::new();
        let mut local = DeviceScope {
            service_id: uuid::Uuid::new_v4().to_string(),
            environment: "development".into(),
            network_id: uuid::Uuid::new_v4().to_string(),
            principal_id: "isolated-owner".into(),
            device_id: uuid::Uuid::new_v4().to_string(),
            key_generation: 1,
        };
        let mut peer = local.clone();
        peer.device_id = uuid::Uuid::new_v4().to_string();
        let local_epoch = uuid::Uuid::new_v4().to_string();
        let peer_epoch = uuid::Uuid::new_v4().to_string();
        let binding = |scope: &DeviceScope, identity: &TlsIdentity, name: &str| {
            VerifiedPeer::fixture(PeerBinding {
                service_id: scope.service_id.clone(),
                environment: scope.environment.clone(),
                principal_id: scope.principal_id.clone(),
                device_id: scope.device_id.clone(),
                key_generation: scope.key_generation,
                identity_binding_id: uuid::Uuid::new_v4().to_string(),
                certificate_fingerprint: certificate_fingerprint(&identity.certificates[0]),
                san: name.into(),
                certificate: String::new(),
                expires_at: jsonwebtoken::get_current_timestamp() + 300,
            })
        };
        let make_pair = |a: DeviceScope, b: DeviceScope| {
            let id = uuid::Uuid::new_v4().to_string();
            let first = binding(&a, &fixture.first, "first.network.invalid");
            let second = binding(&b, &fixture.second, "second.network.invalid");
            (
                Channel::new(
                    id.clone(),
                    a.clone(),
                    b.clone(),
                    local_epoch.clone(),
                    peer_epoch.clone(),
                    &fixture.first,
                    fixture.roots(),
                    &second,
                    true,
                )
                .unwrap(),
                Channel::new(
                    id,
                    b,
                    a,
                    peer_epoch.clone(),
                    local_epoch.clone(),
                    &fixture.second,
                    fixture.roots(),
                    &first,
                    false,
                )
                .unwrap(),
            )
        };
        let exchange = |a: &mut Channel,
                        b: &mut Channel,
                        sa: &mut PairSequences,
                        sb: &mut PairSequences|
         -> Result<(), super::super::NetworkError> {
            for _ in 0..10 {
                while let Some(frame) = a.drain_frame()? {
                    assert!(b.feed(decode_tls_frame(&frame).unwrap().1, sb)?.is_empty());
                }
                while let Some(frame) = b.drain_frame()? {
                    assert!(a.feed(decode_tls_frame(&frame).unwrap().1, sa)?.is_empty());
                }
                if a.crypto_ready() && b.crypto_ready() {
                    a.mark_relay_ready()?;
                    b.mark_relay_ready()?;
                    return Ok(());
                }
            }
            panic!("Encrypted channel hello did not converge");
        };
        let (mut a, mut b) = make_pair(local.clone(), peer.clone());
        let mut sa = PairSequences::default();
        let mut sb = PairSequences::default();
        assert!(!a.ready());
        exchange(&mut a, &mut b, &mut sa, &mut sb).unwrap();
        let ack = serde_json::json!({"version":1,"kind":"return-ack","opId":uuid::Uuid::new_v4().to_string(),
            "senderSequence":999,"returnRouteId":uuid::Uuid::new_v4().to_string(),"eventId":uuid::Uuid::new_v4().to_string(),"settlement":"delivered"});
        a.send(
            myagents_agent_network_protocol::BusinessObject::parse(ack).unwrap(),
            &mut sa,
        )
        .unwrap();
        let mut objects = Vec::new();
        while let Some(frame) = a.drain_frame().unwrap() {
            objects.extend(
                b.feed(decode_tls_frame(&frame).unwrap().1, &mut sb)
                    .unwrap(),
            );
        }
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].sequence(), 2);
        // Recreating TLS does not expire the outer connection pair's high-water.
        let (mut replaced_a, mut replaced_b) = make_pair(local.clone(), peer.clone());
        assert!(exchange(
            &mut replaced_a,
            &mut replaced_b,
            &mut PairSequences::default(),
            &mut sb
        )
        .is_err());
        // A different network cannot be presented as another peer of this pair.
        let second = binding(&peer, &fixture.second, "second.network.invalid");
        peer.key_generation = 2;
        assert!(Channel::new(
            uuid::Uuid::new_v4().to_string(),
            local.clone(),
            peer.clone(),
            local_epoch.clone(),
            peer_epoch.clone(),
            &fixture.first,
            fixture.roots(),
            &second,
            true
        )
        .is_err());
        peer.key_generation = 1;
        local.network_id = uuid::Uuid::new_v4().to_string();
        assert!(Channel::new(
            uuid::Uuid::new_v4().to_string(),
            local,
            peer.clone(),
            local_epoch,
            peer_epoch,
            &fixture.first,
            fixture.roots(),
            &second,
            true
        )
        .is_err());
    }
}
