//! Identity activation is serialized by App scope. OS persistence precedes
//! issuer activation; the issuer's public state plus new-key PoP recovers a
//! lost activation ACK without replaying activation or storing a second pointer.
use super::account::NetworkAccountSession;
use super::crypto::{
    certificate_chain, certificate_fingerprint, CryptoError, DevicePrivateKey, IdentityStore,
    KeyScope, TlsIdentity,
};
use super::jwt::{AccessClaims, AccountVerifier, VerifiedPeer};
use super::NetworkError;
use crate::space_cloud::agent_network::AccountOperation;
use myagents_agent_network_protocol::{budget, IdentityState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock};
use zeroize::Zeroizing;

/// Existing OS key is authoritative for committed-enrollment ACK recovery.
/// A pending removal may be replaced only after the issuer proved revocation.
fn key_generation_plan(
    previous: Option<u64>,
    key_present: bool,
    replacement: bool,
    selfhost: bool,
    retired_generation: Option<u64>,
) -> Result<(u64, bool), NetworkError> {
    if retired_generation.is_some_and(|retired| {
        !(replacement || key_present && previous.is_some_and(|current| current > retired))
    }) {
        return Err(NetworkError::new("NETWORK_REMOVAL_UNCONFIRMED"));
    }
    let recovery = previous.is_some() && !key_present && !replacement;
    if recovery && selfhost {
        return Err(NetworkError::new("NETWORK_PRIVATE_KEY_MISSING"));
    }
    let generation = previous.unwrap_or(1);
    let generation = if recovery || replacement {
        generation
            .checked_add(1)
            .filter(|g| *g <= 9_007_199_254_740_991)
            .ok_or_else(|| NetworkError::new("KEY_GENERATION_EXHAUSTED"))?
    } else {
        generation
    };
    Ok((generation, recovery))
}

static IDENTITY_GATES: LazyLock<crate::keyed_lifecycle::KeyedLifecycleRegistry> =
    LazyLock::new(crate::keyed_lifecycle::KeyedLifecycleRegistry::new);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityResult {
    device_id: String,
    key_generation: u64,
    identity_binding_id: String,
    certificate: Option<String>,
    certificate_chain: Vec<String>,
    certificate_fingerprint: Option<String>,
    signed_binding: Option<String>,
    certificate_expires_at: Option<u64>,
    access_token: String,
    access_token_expires_at: u64,
    bootstrap_grant: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    challenge_id: String,
    nonce: String,
    expires_at: u64,
}

#[derive(Clone)]
pub(crate) struct PeerIdentity {
    pub tls: Arc<TlsIdentity>,
    pub binding: VerifiedPeer,
    pub signed_binding: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PeerResult {
    device_id: String,
    key_generation: u64,
    identity_binding_id: String,
    certificate: Option<String>,
    certificate_chain: Vec<String>,
    certificate_fingerprint: Option<String>,
    signed_binding: Option<String>,
    certificate_expires_at: Option<u64>,
}
impl IdentityResult {
    fn peer_result(&self) -> PeerResult {
        PeerResult {
            device_id: self.device_id.clone(),
            key_generation: self.key_generation,
            identity_binding_id: self.identity_binding_id.clone(),
            certificate: self.certificate.clone(),
            certificate_chain: self.certificate_chain.clone(),
            certificate_fingerprint: self.certificate_fingerprint.clone(),
            signed_binding: self.signed_binding.clone(),
            certificate_expires_at: self.certificate_expires_at,
        }
    }
}
#[derive(Clone)]
pub(crate) struct NetworkIdentity {
    pub account: NetworkAccountSession,
    pub scope: KeyScope,
    pub peer: Option<PeerIdentity>,
    pub access: AccessClaims,
    pub token: Zeroizing<String>,
    pub network_url: String,
    pub root_certificate: String,
    pub verifier: AccountVerifier,
    key: Arc<DevicePrivateKey>,
}
impl NetworkIdentity {
    /// Public issuer confirmation lets the registry checkpoint revocation even
    /// when the retiring private key was lost. Persist this before enrollment.
    pub(crate) async fn revoked_scope(
        account: &NetworkAccountSession,
    ) -> Result<KeyScope, NetworkError> {
        account.validate_instance().await?;
        let device = crate::device_identity::current_device_identity()
            .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        let value = account
            .request(
                AccountOperation::IdentityState(device.device_id.clone()),
                None,
            )
            .await?;
        myagents_agent_network_protocol::validate_identity_state(&value)
            .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
        let state: IdentityState = serde_json::from_value(value)
            .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
        let scope = KeyScope {
            issuer: account.issuer().into(),
            environment: account.environment().into(),
            service_id: account.service_id()?.into(),
            principal_id: account.principal_id()?.into(),
            device_id: device.device_id,
            key_generation: state
                .key_generation
                .ok_or_else(|| NetworkError::new("IDENTITY_STATE_INVALID"))?,
        };
        if state.service_id != scope.service_id
            || state.environment != scope.environment
            || state.device_id != scope.device_id
        {
            return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
        }
        match account.request(AccountOperation::Challenge, Some(json!({
            "deviceId":scope.device_id, "operation":"recover-query",
            "targetFingerprint":state.key_fingerprint, "expectedKeyGeneration":scope.key_generation
        }))).await {
            Err(error) if error.code == "DEVICE_REVOKED" => Ok(scope),
            Err(error) => Err(error),
            Ok(_) => Err(NetworkError::new("NETWORK_REMOVAL_UNCONFIRMED")),
        }
    }
    pub(crate) async fn initialize_with_store(
        account: NetworkAccountSession,
        retired_generation: Option<u64>,
        store: Arc<dyn IdentityStore>,
    ) -> Result<Self, NetworkError> {
        account.validate_instance().await?;
        let device = crate::device_identity::current_device_identity()
            .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        let service_id = account.service_id()?.to_owned();
        let gate_key = format!(
            "{}|{}|{}|{}",
            account.issuer(),
            service_id,
            account.principal_id()?,
            device.device_id
        );
        let _gate = IDENTITY_GATES.acquire(&[&gate_key]).await;
        account.ensure_current()?;
        let state_value = account
            .request(
                AccountOperation::IdentityState(device.device_id.clone()),
                None,
            )
            .await?;
        myagents_agent_network_protocol::validate_identity_state(&state_value)
            .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
        let state: IdentityState = serde_json::from_value(state_value)
            .map_err(|_| NetworkError::new("IDENTITY_STATE_INVALID"))?;
        if state.service_id != service_id
            || state.environment != account.environment()
            || state.device_id != device.device_id
            || state.key_generation.is_some() != state.key_fingerprint.is_some()
        {
            return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
        }
        let mut scope = KeyScope {
            issuer: account.issuer().into(),
            environment: account.environment().into(),
            service_id,
            principal_id: account.principal_id()?.into(),
            device_id: device.device_id.clone(),
            key_generation: state.key_generation.unwrap_or(1),
        };
        let replacement = if account.requires_revocation_probe(state.key_generation) {
            match account.request(AccountOperation::Challenge,Some(json!({"deviceId":scope.device_id,"operation":"recover-query","targetFingerprint":state.key_fingerprint,"expectedKeyGeneration":scope.key_generation}))).await {
                Err(error) if error.code=="DEVICE_REVOKED"=>true,
                Err(error)=>return Err(error),
                Ok(_)=>false,
            }
        } else {
            false
        };
        let current_key = load_key_with_store(&scope, store.clone()).await?;
        if let (Some(key), Some(expected)) = (&current_key, &state.key_fingerprint) {
            if !replacement && key.public_fingerprint()? != *expected {
                return Err(NetworkError::new("NETWORK_CREDENTIAL_GENERATION_CONFLICT"));
            }
        }
        let has_identity = state.key_generation.is_some();
        let (generation, recovery) = key_generation_plan(
            state.key_generation,
            current_key.is_some(),
            replacement,
            account.is_selfhost(),
            retired_generation,
        )?;
        scope.key_generation = generation;
        let key = match if recovery || replacement {
            load_key_with_store(&scope, store.clone()).await?
        } else {
            current_key
        } {
            Some(key) => key,
            None => {
                let persisted_scope = scope.clone();
                tokio::task::spawn_blocking(move || {
                    let key = Arc::new(DevicePrivateKey::generate()?);
                    store.save_pending(&persisted_scope, &key)?;
                    Ok::<_, CryptoError>(key)
                })
                .await
                .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))??
            }
        };
        account.ensure_current()?;
        let state_result = if has_identity && !recovery && !replacement {
            let proof = proof(
                &account,
                &scope,
                &key,
                "recover-query",
                &key.public_fingerprint()?,
            )
            .await?;
            let query = json!({"deviceId":scope.device_id,"keyFingerprint":key.public_fingerprint()?,
                "expectedKeyGeneration":scope.key_generation,"challengeId":proof.0,"proof":proof.1});
            account
                .request(AccountOperation::Current, Some(query))
                .await?
        } else {
            account.request(if recovery { AccountOperation::Rotate } else { AccountOperation::Identity }, Some(json!({
                "deviceId":scope.device_id,"csr":key.csr()?,"expectedKeyGeneration":state.key_generation,
                "deviceInfo":{"deviceName":device.device_name,"platform":device.platform,"osVersion":device.os_version,"appVersion":device.app_version},
                // Initial identity does not accept a recovery field at all.
            }).as_object().cloned().map(|mut fields| { if recovery { fields.insert("recovery".into(), Value::Bool(true)); } Value::Object(fields) })
                .ok_or_else(|| NetworkError::new("IDENTITY_REQUEST_INVALID"))?)).await?
        };
        let verifier = AccountVerifier::new(account.clone()).await?;
        Self::validate_result(account, scope, key, verifier, state_result).await
    }

    async fn validate_result(
        account: NetworkAccountSession,
        scope: KeyScope,
        key: Arc<DevicePrivateKey>,
        mut verifier: AccountVerifier,
        value: Value,
    ) -> Result<Self, NetworkError> {
        let result: IdentityResult = serde_json::from_value(value)
            .map_err(|_| NetworkError::new("IDENTITY_RESPONSE_INVALID"))?;
        let access = verifier.access(&result.access_token).await?;
        let bootstrap = verifier.bootstrap(&result.bootstrap_grant).await?;
        if result.device_id != scope.device_id
            || result.key_generation != scope.key_generation
            || access.device_id != scope.device_id
            || access.key_generation != scope.key_generation
            || access.exp != result.access_token_expires_at
            || access.cnf.jkt != key.public_thumbprint()?
            || bootstrap.access.device_id != access.device_id
            || bootstrap.access.key_generation != access.key_generation
            || bootstrap.access.session_handle != access.session_handle
            || bootstrap.access.cnf.jkt != access.cnf.jkt
            || bootstrap.access.exp != access.exp
        {
            return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
        }
        account.ensure_bootstrap(&bootstrap.root_certificate, &bootstrap.network_url)?;
        let peer = validate_peer(
            &scope,
            key.clone(),
            &mut verifier,
            &bootstrap.root_certificate,
            result.peer_result(),
        )
        .await?;
        account.ensure_current()?;
        Ok(Self {
            account,
            scope,
            peer,
            access,
            token: Zeroizing::new(result.access_token),
            network_url: bootstrap.network_url,
            root_certificate: bootstrap.root_certificate,
            verifier,
            key,
        })
    }

    pub(crate) fn device_key(&self) -> Arc<DevicePrivateKey> {
        self.key.clone()
    }
    pub(crate) fn renewal_due(&self) -> bool {
        self.peer.as_ref().is_none_or(|peer| {
            peer.binding.expires_at
                <= jsonwebtoken::get_current_timestamp() + budget("certificateRenewSeconds") as u64
        })
    }
    /// A peer offer wakes lazy certificate work. Neither credential expiry nor
    /// outer connection epoch changes when only a same-key leaf is renewed.
    pub(crate) async fn ensure_peer(mut self) -> Result<Self, NetworkError> {
        if !self.renewal_due() {
            return Ok(self);
        }
        let gate_key = format!(
            "{}|{}|{}|{}",
            self.account.issuer(),
            self.scope.service_id,
            self.scope.principal_id,
            self.scope.device_id
        );
        let _gate = IDENTITY_GATES.acquire(&[&gate_key]).await;
        self.account.ensure_current()?;
        let device = crate::device_identity::current_device_identity()
            .map_err(|_| NetworkError::new("DEVICE_ID_UNAVAILABLE"))?;
        if device.device_id != self.scope.device_id {
            return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
        }
        let value = renew(&self.account, &self.scope, &self.key).await?;
        let peer: PeerResult = serde_json::from_value(value)
            .map_err(|_| NetworkError::new("IDENTITY_RESPONSE_INVALID"))?;
        self.peer = validate_peer(
            &self.scope,
            self.key.clone(),
            &mut self.verifier,
            &self.root_certificate,
            peer,
        )
        .await?;
        if self.peer.is_none() {
            return Err(NetworkError::new("NETWORK_CERTIFICATE_INVALID"));
        }
        self.account.ensure_current()?;
        Ok(self)
    }
}

async fn validate_peer(
    scope: &KeyScope,
    key: Arc<DevicePrivateKey>,
    verifier: &mut AccountVerifier,
    root: &str,
    result: PeerResult,
) -> Result<Option<PeerIdentity>, NetworkError> {
    if result.device_id != scope.device_id
        || result.key_generation != scope.key_generation
        || result.certificate_chain.len() != 2
        || result.certificate_chain[1] != root
    {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    let (certificate, fingerprint, signed, expires) = match (
        result.certificate,
        result.certificate_fingerprint,
        result.signed_binding,
        result.certificate_expires_at,
    ) {
        (None, None, None, None) => return Ok(None),
        (Some(c), Some(f), Some(s), Some(e)) => (c, f, s, e),
        _ => return Err(NetworkError::new("IDENTITY_CERTIFICATE_INVALID")),
    };
    let binding = verifier.peer(&signed).await?;
    let mut chain = certificate_chain(&certificate)?;
    if chain.len() != 1
        || certificate_fingerprint(&chain[0]) != fingerprint
        || binding.device_id != scope.device_id
        || binding.key_generation != scope.key_generation
        || binding.identity_binding_id != result.identity_binding_id
        || binding.expires_at != expires
        || binding.certificate_fingerprint != fingerprint
        || binding.certificate != certificate
    {
        return Err(NetworkError::new("IDENTITY_SCOPE_MISMATCH"));
    }
    for pem in result.certificate_chain {
        chain.extend(certificate_chain(&pem)?);
    }
    if chain.len() != 3 {
        return Err(NetworkError::new("IDENTITY_CERTIFICATE_INVALID"));
    }
    Ok(Some(PeerIdentity {
        tls: Arc::new(TlsIdentity::new(chain, key)?),
        binding,
        signed_binding: signed,
    }))
}

pub(super) async fn load_key_with_store(
    scope: &KeyScope,
    store: Arc<dyn IdentityStore>,
) -> Result<Option<Arc<DevicePrivateKey>>, NetworkError> {
    let scope = scope.clone();
    match tokio::task::spawn_blocking(move || store.load(&scope))
        .await
        .map_err(|_| NetworkError::new("NETWORK_CREDENTIAL_STORE_UNAVAILABLE"))?
    {
        Ok(key) => Ok(Some(Arc::new(key))),
        Err(CryptoError::CredentialMissing) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
pub(crate) async fn proof(
    account: &NetworkAccountSession,
    scope: &KeyScope,
    key: &DevicePrivateKey,
    operation: &str,
    target_fingerprint: &str,
) -> Result<(String, String), NetworkError> {
    let value = account
        .request(
            AccountOperation::Challenge,
            Some(json!({"deviceId":scope.device_id,"operation":operation,
        "targetFingerprint":target_fingerprint,"expectedKeyGeneration":scope.key_generation})),
        )
        .await?;
    let challenge: Challenge =
        serde_json::from_value(value).map_err(|_| NetworkError::new("NETWORK_PROOF_INVALID"))?;
    let now = jsonwebtoken::get_current_timestamp();
    if challenge.expires_at <= now
        || challenge.expires_at
            > now + budget("popSeconds") as u64 + budget("clockSkewSeconds") as u64
    {
        return Err(NetworkError::new("NETWORK_PROOF_INVALID"));
    }
    Ok((
        challenge.challenge_id.clone(),
        key.sign_proof(&challenge.challenge_id, &challenge.nonce)?,
    ))
}
async fn renew(
    account: &NetworkAccountSession,
    scope: &KeyScope,
    key: &DevicePrivateKey,
) -> Result<Value, NetworkError> {
    let signed = proof(account, scope, key, "renew", &key.public_fingerprint()?).await?;
    account
        .request(
            AccountOperation::Certificate,
            Some(certificate_request(scope, key, signed)?),
        )
        .await
}

fn certificate_request(
    scope: &KeyScope,
    key: &DevicePrivateKey,
    signed: (String, String),
) -> Result<Value, NetworkError> {
    Ok(
        json!({"deviceId":scope.device_id,"csr":key.csr()?,"expectedKeyGeneration":scope.key_generation,"challengeId":signed.0,"proof":signed.1}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_activation_ack_uses_persisted_private_key_and_same_generation() {
        // Initial private key is persisted before activation. The committed
        // public state after a lost response selects recover-query, not rotate.
        assert_eq!(
            key_generation_plan(None, true, false, true, None).unwrap(),
            (1, false)
        );
        assert_eq!(
            key_generation_plan(Some(1), true, false, true, None).unwrap(),
            (1, false)
        );
        assert_eq!(
            key_generation_plan(Some(1), false, false, true, None)
                .unwrap_err()
                .code,
            "NETWORK_PRIVATE_KEY_MISSING"
        );
    }
    #[test]
    fn missing_key_pending_removal_requires_revocation_before_fresh_enrollment() {
        assert_eq!(
            key_generation_plan(Some(1), false, false, true, Some(1))
                .unwrap_err()
                .code,
            "NETWORK_REMOVAL_UNCONFIRMED"
        );
        assert_eq!(
            key_generation_plan(Some(1), true, false, true, Some(1))
                .unwrap_err()
                .code,
            "NETWORK_REMOVAL_UNCONFIRMED"
        );
        assert_eq!(
            key_generation_plan(Some(1), false, true, true, Some(1)).unwrap(),
            (2, false)
        );
        assert_eq!(
            key_generation_plan(Some(2), true, false, true, None).unwrap(),
            (2, false)
        );
    }
    #[test]
    fn pending_replacement_ack_or_config_failure_recovers_only_newer_committed_key() {
        for _fault in ["activation response lost", "registry config write failed"] {
            // Durable revocation checkpoint survives both faults; issuer has
            // committed generation 2 and its key was saved before enrollment.
            assert_eq!(
                key_generation_plan(Some(2), true, false, true, Some(1)).unwrap(),
                (2, false)
            );
            assert_eq!(
                key_generation_plan(Some(1), true, false, true, Some(1))
                    .unwrap_err()
                    .code,
                "NETWORK_REMOVAL_UNCONFIRMED"
            );
            assert_eq!(
                key_generation_plan(Some(2), false, false, true, Some(1))
                    .unwrap_err()
                    .code,
                "NETWORK_REMOVAL_UNCONFIRMED"
            );
        }
    }
    #[test]
    fn renewal_body_uses_the_account_certificate_contract_without_roster_fields() {
        let key = DevicePrivateKey::generate().unwrap();
        let scope = KeyScope {
            issuer: "https://space-dev.myagents.io".into(),
            service_id: "00000000-0000-0000-0000-000000000001".into(),
            environment: "development".into(),
            principal_id: "account".into(),
            device_id: "00000000-0000-0000-0000-000000000002".into(),
            key_generation: 1,
        };
        let request = certificate_request(
            &scope,
            &key,
            (
                "00000000-0000-0000-0000-000000000003".into(),
                "contract-proof".into(),
            ),
        )
        .unwrap();
        let mut keys = request
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "challengeId",
                "csr",
                "deviceId",
                "expectedKeyGeneration",
                "proof"
            ]
        );
        assert_eq!(request["expectedKeyGeneration"], 1);
        if let Ok(path) = std::env::var("MYAGENTS_NETWORK_RENEWAL_CONTRACT_OUTPUT") {
            // Explicit isolated verification artifact: CSR/public metadata only.
            std::fs::write(path, serde_json::to_vec(&request).unwrap()).unwrap();
        }
    }
}
