//! Offline verification of self-hosted AgentNet access JWTs and per-request
//! DPoP proofs. Session revocation remains an AuthStore responsibility.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use p256::{ecdsa::VerifyingKey, pkcs8::EncodePublicKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const MAX_ACCESS_JWT_BYTES: usize = 16 * 1024;
const MAX_DPOP_JWT_BYTES: usize = 8 * 1024;
const MAX_REPLAY_ENTRIES: usize = 65_536;
const MAX_REPLAY_PER_DEVICE: usize = 1_024;

/// Static trust configuration. JWKS is pinned by the caller; this crate never
/// fetches a key or follows a token-provided URL.
#[derive(Clone, Debug)]
pub struct ExpectedService {
    pub https_origin_canonical: String,
    pub service_id: String,
    pub environment: String,
    pub network_id: String,
    pub jwks: Value,
}

/// Hard upper bounds for the in-memory DPoP replay set.
#[derive(Clone, Copy, Debug)]
pub struct ReplayPolicy {
    pub max_entries: usize,
    pub max_per_device: usize,
    require_nonce: bool,
}

impl ReplayPolicy {
    pub fn with_limits(max_entries: usize, max_per_device: usize) -> Self {
        Self {
            max_entries,
            max_per_device,
            require_nonce: true,
        }
    }
}

impl Default for ReplayPolicy {
    fn default() -> Self {
        Self {
            max_entries: 16_384,
            max_per_device: 256,
            require_nonce: true,
        }
    }
}

/// Claims verified cryptographically and bound to this single DPoP request.
/// The session handle must still be checked against the authoritative session
/// store before granting a protected operation.
#[derive(Clone, PartialEq, Eq)]
pub struct ValidatedAccess {
    principal_id: String,
    device_id: String,
    key_generation: u64,
    session_handle: String,
    jkt: String,
    public_key_fingerprint: String,
    issuer_network_id: String,
    service_id: String,
    environment: String,
    issuer_origin: String,
    expires_at: i64,
}

impl std::fmt::Debug for ValidatedAccess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ValidatedAccess")
            .field("principal_id", &"[redacted]")
            .field("device_id", &"[redacted]")
            .field("key_generation", &self.key_generation)
            .field("session_handle", &"[redacted]")
            .field("jkt", &self.jkt)
            .field("public_key_fingerprint", &self.public_key_fingerprint)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl ValidatedAccess {
    pub fn principal_id(&self) -> &str {
        &self.principal_id
    }
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn key_generation(&self) -> u64 {
        self.key_generation
    }
    pub fn session_handle(&self) -> &str {
        &self.session_handle
    }
    pub fn jkt(&self) -> &str {
        &self.jkt
    }
    /// SHA-256 of DER SubjectPublicKeyInfo; distinct from RFC 7638 JKT.
    pub fn public_key_fingerprint(&self) -> &str {
        &self.public_key_fingerprint
    }
    /// Configured issuer network scope. The access JWT schema has no network
    /// claim, so this value is not derived from or proven by the token.
    pub fn issuer_network_id(&self) -> &str {
        &self.issuer_network_id
    }
    /// Service audience from the validator's pinned context, after the JWT
    /// audience and issuer claims have been checked against that context.
    pub fn service_id(&self) -> &str {
        &self.service_id
    }
    /// Environment from the validator's pinned context, after matching the
    /// signed access claim.
    pub fn environment(&self) -> &str {
        &self.environment
    }
    /// Canonical issuer origin from the pinned validator configuration.
    pub fn issuer_origin(&self) -> &str {
        &self.issuer_origin
    }
    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionError {
    #[error("static service configuration is invalid")]
    Configuration,
    #[error("access token or DPoP proof was rejected")]
    Rejected,
    #[error("DPoP proof has already been used")]
    Replay,
    #[error("replay protection is at capacity")]
    Capacity,
    #[error("replay protection is unavailable")]
    Unavailable,
}

#[derive(Clone)]
pub struct AdmissionValidator {
    expected: Arc<ValidatedService>,
    replay: Arc<Mutex<ReplaySet>>,
    policy: ReplayPolicy,
}

struct ValidatedService {
    origin: String,
    service_id: String,
    environment: String,
    network_id: String,
    signing_keys: HashMap<String, DecodingKey>,
}

#[derive(Default)]
struct ReplaySet {
    entries: HashMap<String, ReplayEntry>,
}

struct ReplayEntry {
    device_id: String,
    expires_at: i64,
}

struct DpopContext<'a> {
    access_jwt: &'a str,
    method: &'a str,
    request_url: &'a str,
    expected_nonce: Option<&'a str>,
    now: i64,
}

impl AdmissionValidator {
    pub fn new(expected: ExpectedService, policy: ReplayPolicy) -> Result<Self, AdmissionError> {
        let origin = canonical_origin(&expected.https_origin_canonical)?;
        if !canonical_uuid(&expected.service_id)
            || !canonical_uuid(&expected.network_id)
            || !matches!(expected.environment.as_str(), "production" | "development")
            || policy.max_entries == 0
            || policy.max_entries > MAX_REPLAY_ENTRIES
            || policy.max_per_device == 0
            || policy.max_per_device > MAX_REPLAY_PER_DEVICE
        {
            return Err(AdmissionError::Configuration);
        }
        let signing_keys = parse_pinned_jwks(&expected.jwks)?;
        Ok(Self {
            expected: Arc::new(ValidatedService {
                origin,
                service_id: expected.service_id,
                environment: expected.environment,
                network_id: expected.network_id,
                signing_keys,
            }),
            replay: Arc::new(Mutex::new(ReplaySet::default())),
            policy,
        })
    }

    /// Verify an access JWT and the DPoP proof for this exact request. A
    /// supplied expected nonce is mandatory and compared byte-for-byte; this
    /// crate does not issue or manage nonces itself.
    pub fn validate(
        &self,
        access_jwt: &str,
        dpop_jwt: &str,
        method: &str,
        request_url: &str,
        expected_nonce: Option<&str>,
    ) -> Result<ValidatedAccess, AdmissionError> {
        self.validate_with_clock(
            access_jwt,
            dpop_jwt,
            method,
            request_url,
            expected_nonce,
            system_unix_time,
        )
    }

    /// Deterministic test clock. Production `validate` never uses this path.
    #[cfg(test)]
    fn validate_at(
        &self,
        access_jwt: &str,
        dpop_jwt: &str,
        method: &str,
        request_url: &str,
        expected_nonce: Option<&str>,
        now: i64,
    ) -> Result<ValidatedAccess, AdmissionError> {
        self.validate_with_clock(
            access_jwt,
            dpop_jwt,
            method,
            request_url,
            expected_nonce,
            || Ok(now),
        )
    }

    fn validate_with_clock(
        &self,
        access_jwt: &str,
        dpop_jwt: &str,
        method: &str,
        request_url: &str,
        expected_nonce: Option<&str>,
        mut clock: impl FnMut() -> Result<i64, AdmissionError>,
    ) -> Result<ValidatedAccess, AdmissionError> {
        if access_jwt.len() > MAX_ACCESS_JWT_BYTES
            || dpop_jwt.len() > MAX_DPOP_JWT_BYTES
            || method.is_empty()
            || !method.bytes().all(|b| {
                b.is_ascii_uppercase() || b.is_ascii_digit() || b"!#$%&'*+-.^_`|~".contains(&b)
            })
        {
            return Err(AdmissionError::Rejected);
        }
        let now = clock()?;
        let access_header = jwt_header(access_jwt)?;
        exact_keys(&access_header, &["alg", "typ", "kid"])?;
        if map_string_at(&access_header, "alg")? != "ES256"
            || map_string_at(&access_header, "typ")? != "ma-network-access+jwt"
        {
            return Err(AdmissionError::Rejected);
        }
        let kid = map_string_at(&access_header, "kid")?;
        let key = self
            .expected
            .signing_keys
            .get(kid)
            .ok_or(AdmissionError::Rejected)?;
        let claims: Value = decode_verified(access_jwt, key)?;
        myagents_agent_network_protocol::validate_access(&claims)
            .map_err(|_| AdmissionError::Rejected)?;
        self.validate_access_claims(&claims, now)?;

        let proof_header = jwt_header(dpop_jwt)?;
        exact_keys(&proof_header, &["typ", "alg", "jwk"])?;
        if map_string_at(&proof_header, "typ")? != "dpop+jwt"
            || map_string_at(&proof_header, "alg")? != "ES256"
        {
            return Err(AdmissionError::Rejected);
        }
        let public_jwk = proof_header.get("jwk").ok_or(AdmissionError::Rejected)?;
        let (proof_key, proof_jkt, public_key_fingerprint) = parse_proof_jwk(public_jwk)?;
        let proof: Value = decode_verified(dpop_jwt, &proof_key)?;
        self.validate_dpop_claims(
            &proof,
            DpopContext {
                access_jwt,
                method,
                request_url,
                expected_nonce,
                now,
            },
        )?;

        let claims_jkt = string_at(claims.get("cnf").ok_or(AdmissionError::Rejected)?, "jkt")?;
        if claims_jkt != proof_jkt {
            return Err(AdmissionError::Rejected);
        }
        let device_id = string_at(&claims, "deviceId")?.to_owned();
        let proof_jti = string_at(&proof, "jti")?;
        let replay_key = format!("{proof_jkt}:{proof_jti}");
        let proof_iat = integer_at(&proof, "iat")?;
        let replay_expiry = proof_iat
            .checked_add(myagents_agent_network_protocol::budget("popSeconds") as i64)
            .and_then(|expiry| {
                expiry
                    .checked_add(myagents_agent_network_protocol::budget("clockSkewSeconds") as i64)
            })
            .and_then(|expiry| expiry.checked_add(1))
            .ok_or(AdmissionError::Rejected)?;
        self.consume_replay_checked(
            replay_key,
            device_id.clone(),
            replay_expiry,
            &mut clock,
            |locked_now| {
                self.validate_access_claims(&claims, locked_now)?;
                self.validate_dpop_claims(
                    &proof,
                    DpopContext {
                        access_jwt,
                        method,
                        request_url,
                        expected_nonce,
                        now: locked_now,
                    },
                )
            },
        )?;

        // Insertion is deliberately fail-closed if the proof expires during
        // the final projection work: the replay key stays consumed.
        let return_now = clock()?;
        self.validate_access_claims(&claims, return_now)?;
        self.validate_dpop_claims(
            &proof,
            DpopContext {
                access_jwt,
                method,
                request_url,
                expected_nonce,
                now: return_now,
            },
        )?;

        Ok(ValidatedAccess {
            principal_id: string_at(&claims, "sub")?.to_owned(),
            device_id,
            key_generation: unsigned_at(&claims, "keyGeneration")?,
            session_handle: string_at(&claims, "sessionHandle")?.to_owned(),
            jkt: proof_jkt,
            public_key_fingerprint,
            issuer_network_id: self.expected.network_id.clone(),
            service_id: self.expected.service_id.clone(),
            environment: self.expected.environment.clone(),
            issuer_origin: self.expected.origin.clone(),
            expires_at: integer_at(&claims, "exp")?,
        })
    }

    fn validate_access_claims(&self, claims: &Value, now: i64) -> Result<(), AdmissionError> {
        let skew = myagents_agent_network_protocol::budget("clockSkewSeconds") as i64;
        let max_lifetime = myagents_agent_network_protocol::budget("tokenSeconds") as i64;
        let iat = integer_at(claims, "iat")?;
        let nbf = integer_at(claims, "nbf")?;
        let exp = integer_at(claims, "exp")?;
        if string_at(claims, "iss")? != self.expected.origin
            || string_at(claims, "aud")? != self.expected.service_id
            || string_at(claims, "environment")? != self.expected.environment
            || !canonical_uuid(string_at(claims, "jti")?)
            || !canonical_uuid(string_at(claims, "sub")?)
            || !canonical_uuid(string_at(claims, "deviceId")?)
            || !canonical_uuid(string_at(claims, "sessionHandle")?)
            || integer_at(claims, "keyGeneration")? < 1
            || iat > now.saturating_add(skew)
            || nbf > now.saturating_add(skew)
            || exp <= now.saturating_sub(skew)
            || exp <= iat
            || nbf > exp
            || exp.saturating_sub(iat) > max_lifetime
        {
            return Err(AdmissionError::Rejected);
        }
        Ok(())
    }

    fn validate_dpop_claims(
        &self,
        claims: &Value,
        context: DpopContext<'_>,
    ) -> Result<(), AdmissionError> {
        let object = claims.as_object().ok_or(AdmissionError::Rejected)?;
        let allowed = ["jti", "iat", "htm", "htu", "ath", "nonce"];
        if object.keys().any(|key| !allowed.contains(&key.as_str()))
            || ["jti", "iat", "htm", "htu", "ath"]
                .iter()
                .any(|key| !object.contains_key(*key))
        {
            return Err(AdmissionError::Rejected);
        }
        let request = canonical_request_url(context.request_url, &self.expected.origin)?;
        let iat = integer_at(claims, "iat")?;
        let max_age = myagents_agent_network_protocol::budget("popSeconds") as i64;
        let skew = myagents_agent_network_protocol::budget("clockSkewSeconds") as i64;
        let ath = URL_SAFE_NO_PAD.encode(Sha256::digest(context.access_jwt.as_bytes()));
        if !canonical_uuid(string_at(claims, "jti")?)
            || string_at(claims, "htm")? != context.method
            || string_at(claims, "htu")? != request
            || string_at(claims, "ath")? != ath
            || iat > context.now.saturating_add(skew)
            || iat < context.now.saturating_sub(max_age.saturating_add(skew))
        {
            return Err(AdmissionError::Rejected);
        }
        match (context.expected_nonce, claims.get("nonce")) {
            (Some(expected), Some(Value::String(actual)))
                if !expected.is_empty() && expected.len() <= 256 && actual == expected => {}
            (None, None) if !self.policy.require_nonce => {}
            _ => return Err(AdmissionError::Rejected),
        }
        Ok(())
    }

    #[cfg(test)]
    fn consume_replay(
        &self,
        key: String,
        device_id: String,
        expires_at: i64,
        now: i64,
    ) -> Result<(), AdmissionError> {
        let mut replay = self
            .replay
            .lock()
            .map_err(|_| AdmissionError::Unavailable)?;
        replay.entries.retain(|_, entry| entry.expires_at > now);
        if replay.entries.contains_key(&key) {
            return Err(AdmissionError::Replay);
        }
        if replay.entries.len() >= self.policy.max_entries
            || replay
                .entries
                .values()
                .filter(|entry| entry.device_id == device_id)
                .count()
                >= self.policy.max_per_device
        {
            return Err(AdmissionError::Capacity);
        }
        replay.entries.insert(
            key,
            ReplayEntry {
                device_id,
                expires_at,
            },
        );
        Ok(())
    }

    fn consume_replay_checked<C, F>(
        &self,
        key: String,
        device_id: String,
        expires_at: i64,
        clock: &mut C,
        check: F,
    ) -> Result<(), AdmissionError>
    where
        C: FnMut() -> Result<i64, AdmissionError>,
        F: FnOnce(i64) -> Result<(), AdmissionError>,
    {
        let mut replay = self
            .replay
            .lock()
            .map_err(|_| AdmissionError::Unavailable)?;
        // Fresh time is sampled only after acquiring the mutex. This closes
        // the window where validation waits behind another request until the
        // access token or proof has expired.
        let now = clock()?;
        check(now)?;
        replay.entries.retain(|_, entry| entry.expires_at > now);
        if replay.entries.contains_key(&key) {
            return Err(AdmissionError::Replay);
        }
        if replay.entries.len() >= self.policy.max_entries
            || replay
                .entries
                .values()
                .filter(|entry| entry.device_id == device_id)
                .count()
                >= self.policy.max_per_device
        {
            return Err(AdmissionError::Capacity);
        }
        replay.entries.insert(
            key,
            ReplayEntry {
                device_id,
                expires_at,
            },
        );
        Ok(())
    }
}

fn system_unix_time() -> Result<i64, AdmissionError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AdmissionError::Unavailable)?
        .as_secs();
    i64::try_from(seconds).map_err(|_| AdmissionError::Unavailable)
}

fn canonical_origin(value: &str) -> Result<String, AdmissionError> {
    let url = Url::parse(value).map_err(|_| AdmissionError::Configuration)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.origin().ascii_serialization() != value
    {
        return Err(AdmissionError::Configuration);
    }
    Ok(value.to_owned())
}

fn canonical_request_url(value: &str, origin: &str) -> Result<String, AdmissionError> {
    let mut url = Url::parse(value).map_err(|_| AdmissionError::Rejected)?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != origin
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AdmissionError::Rejected);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn parse_pinned_jwks(value: &Value) -> Result<HashMap<String, DecodingKey>, AdmissionError> {
    let object = value.as_object().ok_or(AdmissionError::Configuration)?;
    if object.len() != 1 || !object.contains_key("keys") {
        return Err(AdmissionError::Configuration);
    }
    let keys = value["keys"]
        .as_array()
        .ok_or(AdmissionError::Configuration)?;
    if keys.is_empty() || keys.len() > 8 {
        return Err(AdmissionError::Configuration);
    }
    let mut parsed = HashMap::new();
    for key in keys {
        let jwk = key.as_object().ok_or(AdmissionError::Configuration)?;
        exact_keys(jwk, &["kty", "crv", "x", "y", "kid", "alg", "use"])
            .map_err(|_| AdmissionError::Configuration)?;
        if string_at(key, "kty").map_err(|_| AdmissionError::Configuration)? != "EC"
            || string_at(key, "crv").map_err(|_| AdmissionError::Configuration)? != "P-256"
            || string_at(key, "alg").map_err(|_| AdmissionError::Configuration)? != "ES256"
            || string_at(key, "use").map_err(|_| AdmissionError::Configuration)? != "sig"
        {
            return Err(AdmissionError::Configuration);
        }
        let kid = string_at(key, "kid").map_err(|_| AdmissionError::Configuration)?;
        if !canonical_b64_32(kid) || parsed.contains_key(kid) {
            return Err(AdmissionError::Configuration);
        }
        let (decoding, jkt, _) = parse_ec_coordinates(key)?;
        if jkt != kid {
            return Err(AdmissionError::Configuration);
        }
        parsed.insert(kid.to_owned(), decoding);
    }
    Ok(parsed)
}

fn parse_proof_jwk(value: &Value) -> Result<(DecodingKey, String, String), AdmissionError> {
    let object = value.as_object().ok_or(AdmissionError::Rejected)?;
    exact_keys(object, &["kty", "crv", "x", "y"])?;
    if string_at(value, "kty")? != "EC" || string_at(value, "crv")? != "P-256" {
        return Err(AdmissionError::Rejected);
    }
    let (key, jkt, fingerprint) = parse_ec_coordinates(value)?;
    Ok((key, jkt, fingerprint))
}

fn parse_ec_coordinates(value: &Value) -> Result<(DecodingKey, String, String), AdmissionError> {
    let x = string_at(value, "x")?;
    let y = string_at(value, "y")?;
    let x_bytes = decode_canonical_32(x)?;
    let y_bytes = decode_canonical_32(y)?;
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(4);
    sec1.extend_from_slice(&x_bytes);
    sec1.extend_from_slice(&y_bytes);
    let verifying_key =
        VerifyingKey::from_sec1_bytes(&sec1).map_err(|_| AdmissionError::Rejected)?;
    let spki_der = verifying_key
        .to_public_key_der()
        .map_err(|_| AdmissionError::Rejected)?;
    let jkt_json = json!({"crv":"P-256","kty":"EC","x":x,"y":y});
    let jkt = URL_SAFE_NO_PAD.encode(Sha256::digest(
        serde_json::to_vec(&jkt_json).map_err(|_| AdmissionError::Rejected)?,
    ));
    let fingerprint = URL_SAFE_NO_PAD.encode(Sha256::digest(spki_der.as_bytes()));
    let key = DecodingKey::from_ec_components(x, y).map_err(|_| AdmissionError::Rejected)?;
    Ok((key, jkt, fingerprint))
}

fn decode_canonical_32(value: &str) -> Result<Vec<u8>, AdmissionError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AdmissionError::Rejected)?;
    if decoded.len() != 32 || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(AdmissionError::Rejected);
    }
    Ok(decoded)
}

fn canonical_b64_32(value: &str) -> bool {
    decode_canonical_32(value).is_ok()
}

fn jwt_header(token: &str) -> Result<Map<String, Value>, AdmissionError> {
    let mut parts = token.split('.');
    let header = parts.next().ok_or(AdmissionError::Rejected)?;
    let payload = parts.next().ok_or(AdmissionError::Rejected)?;
    let signature = parts.next().ok_or(AdmissionError::Rejected)?;
    if parts.next().is_some() || header.is_empty() || payload.is_empty() || signature.is_empty() {
        return Err(AdmissionError::Rejected);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(header)
        .map_err(|_| AdmissionError::Rejected)?;
    let value: Value = serde_json::from_slice(&decoded).map_err(|_| AdmissionError::Rejected)?;
    value.as_object().cloned().ok_or(AdmissionError::Rejected)
}

fn decode_verified(token: &str, key: &DecodingKey) -> Result<Value, AdmissionError> {
    let mut validation = Validation::new(Algorithm::ES256);
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    decode::<Value>(token, key, &validation)
        .map(|data| data.claims)
        .map_err(|_| AdmissionError::Rejected)
}

fn exact_keys(object: &Map<String, Value>, required: &[&str]) -> Result<(), AdmissionError> {
    if object.len() != required.len() || object.keys().any(|key| !required.contains(&key.as_str()))
    {
        return Err(AdmissionError::Rejected);
    }
    Ok(())
}

fn string_at<'a>(value: &'a Value, key: &str) -> Result<&'a str, AdmissionError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(AdmissionError::Rejected)
}

fn map_string_at<'a>(value: &'a Map<String, Value>, key: &str) -> Result<&'a str, AdmissionError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(AdmissionError::Rejected)
}

fn integer_at(value: &Value, key: &str) -> Result<i64, AdmissionError> {
    value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or(AdmissionError::Rejected)
}

fn unsigned_at(value: &Value, key: &str) -> Result<u64, AdmissionError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(AdmissionError::Rejected)
}

fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use myagents_agent_network_crypto::DevicePrivateKey;
    use myagents_agentnet_identity_core::{IdentityRequest, IssuerProfile, ServiceKeys};
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        sync::{mpsc, Barrier},
        thread,
    };

    fn test_policy() -> ReplayPolicy {
        ReplayPolicy {
            require_nonce: false,
            ..ReplayPolicy::default()
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        keys: ServiceKeys,
        profile: IssuerProfile,
        request: IdentityRequest,
        device_key: DevicePrivateKey,
        validator: AdmissionValidator,
        issued: String,
        method: String,
        url: String,
        now: i64,
    }

    impl Fixture {
        fn new(policy: ReplayPolicy) -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let keys =
                ServiceKeys::generate_initial(dir.path().join("identity-keys.json")).unwrap();
            let profile = IssuerProfile {
                issuer: "https://agentnet.example.test".into(),
                service_id: Uuid::new_v4().to_string(),
                environment: "development".into(),
                network_id: Uuid::new_v4().to_string(),
            };
            let device_key = DevicePrivateKey::generate().unwrap();
            let request = IdentityRequest {
                principal_id: Uuid::new_v4().to_string(),
                device_id: Uuid::new_v4().to_string(),
                key_generation: 3,
                identity_binding_id: Uuid::new_v4().to_string(),
                session_handle: Uuid::new_v4().to_string(),
                csr_pem: device_key.csr().unwrap(),
            };
            let issued = keys.issue(&profile, &request).unwrap().access_token;
            let validator = AdmissionValidator::new(
                ExpectedService {
                    https_origin_canonical: profile.issuer.clone(),
                    service_id: profile.service_id.clone(),
                    environment: profile.environment.clone(),
                    network_id: profile.network_id.clone(),
                    jwks: keys.jwks(),
                },
                policy,
            )
            .unwrap();
            Self {
                _dir: dir,
                keys,
                profile,
                request,
                device_key,
                validator,
                issued,
                method: "POST".into(),
                url: "https://agentnet.example.test/api/agent-network/devices?trace=ignored#frag"
                    .into(),
                now: jsonwebtoken::get_current_timestamp() as i64,
            }
        }
        fn proof(&self) -> String {
            self.device_key
                .dpop(
                    &self.method,
                    &Url::parse(&self.url).unwrap(),
                    &self.issued,
                    None,
                )
                .unwrap()
        }
        fn validate(&self, proof: &str) -> Result<ValidatedAccess, AdmissionError> {
            self.validator
                .validate_at(&self.issued, proof, &self.method, &self.url, None, self.now)
        }
    }

    #[test]
    fn validates_service_issued_access_and_client_dpop_and_separates_fingerprints() {
        let fixture = Fixture::new(test_policy());
        let access = fixture.validate(&fixture.proof()).unwrap();
        assert_eq!(access.principal_id(), fixture.request.principal_id);
        assert_eq!(access.device_id(), fixture.request.device_id);
        assert_eq!(access.key_generation(), 3);
        assert_eq!(access.session_handle(), fixture.request.session_handle);
        assert_eq!(access.service_id(), fixture.profile.service_id);
        assert_eq!(access.environment(), fixture.profile.environment);
        assert_eq!(access.issuer_origin(), fixture.profile.issuer);
        assert_eq!(
            access.jkt(),
            fixture.device_key.public_thumbprint().unwrap()
        );
        assert_eq!(
            access.public_key_fingerprint(),
            fixture.device_key.public_fingerprint().unwrap()
        );
        assert_ne!(access.jkt(), access.public_key_fingerprint());
        assert!(access.expires_at() > fixture.now);
        assert!(fixture.keys.jwks()["keys"].as_array().is_some());
    }

    #[test]
    fn signed_access_cannot_be_revalidated_under_another_service_or_environment() {
        let fixture = Fixture::new(test_policy());
        let proof = fixture.proof();
        let different_service = AdmissionValidator::new(
            ExpectedService {
                https_origin_canonical: fixture.profile.issuer.clone(),
                service_id: Uuid::new_v4().to_string(),
                environment: fixture.profile.environment.clone(),
                network_id: fixture.profile.network_id.clone(),
                jwks: fixture.keys.jwks(),
            },
            test_policy(),
        )
        .unwrap();
        assert_eq!(
            different_service.validate_at(
                &fixture.issued,
                &proof,
                &fixture.method,
                &fixture.url,
                None,
                fixture.now,
            ),
            Err(AdmissionError::Rejected)
        );

        let different_environment = AdmissionValidator::new(
            ExpectedService {
                https_origin_canonical: fixture.profile.issuer.clone(),
                service_id: fixture.profile.service_id.clone(),
                environment: "production".into(),
                network_id: fixture.profile.network_id.clone(),
                jwks: fixture.keys.jwks(),
            },
            test_policy(),
        )
        .unwrap();
        assert_eq!(
            different_environment.validate_at(
                &fixture.issued,
                &proof,
                &fixture.method,
                &fixture.url,
                None,
                fixture.now,
            ),
            Err(AdmissionError::Rejected)
        );

        let original = fixture.validate(&proof).unwrap();
        assert_eq!(original.device_id(), fixture.request.device_id);
        assert_eq!(
            original.public_key_fingerprint(),
            fixture.device_key.public_fingerprint().unwrap()
        );
    }

    #[test]
    fn rejects_wrong_key_ath_method_url_nonce_and_access_jwt() {
        let fixture = Fixture::new(test_policy());
        let wrong_key = DevicePrivateKey::generate().unwrap();
        let wrong_proof = wrong_key
            .dpop(
                &fixture.method,
                &Url::parse(&fixture.url).unwrap(),
                &fixture.issued,
                None,
            )
            .unwrap();
        assert_eq!(
            fixture.validate(&wrong_proof),
            Err(AdmissionError::Rejected)
        );

        let wrong_method = fixture
            .device_key
            .dpop(
                "GET",
                &Url::parse(&fixture.url).unwrap(),
                &fixture.issued,
                None,
            )
            .unwrap();
        assert_eq!(
            fixture.validate(&wrong_method),
            Err(AdmissionError::Rejected)
        );
        let wrong_url = fixture
            .device_key
            .dpop(
                &fixture.method,
                &Url::parse("https://agentnet.example.test/other").unwrap(),
                &fixture.issued,
                None,
            )
            .unwrap();
        assert_eq!(fixture.validate(&wrong_url), Err(AdmissionError::Rejected));
        let nonce_proof = fixture
            .device_key
            .dpop(
                &fixture.method,
                &Url::parse(&fixture.url).unwrap(),
                &fixture.issued,
                Some("server-nonce"),
            )
            .unwrap();
        assert_eq!(
            fixture.validator.validate_at(
                &fixture.issued,
                &nonce_proof,
                &fixture.method,
                &fixture.url,
                Some("different"),
                fixture.now
            ),
            Err(AdmissionError::Rejected)
        );
        assert!(fixture
            .validator
            .validate_at(
                &fixture.issued,
                &nonce_proof,
                &fixture.method,
                &fixture.url,
                Some("server-nonce"),
                fixture.now
            )
            .is_ok());

        let bad_ath = fixture
            .device_key
            .dpop(
                &fixture.method,
                &Url::parse(&fixture.url).unwrap(),
                "different-access-jwt",
                None,
            )
            .unwrap();
        assert_eq!(fixture.validate(&bad_ath), Err(AdmissionError::Rejected));
        assert_eq!(
            fixture.validator.validate(
                "oidc-session-token-not-jwt",
                &bad_ath,
                &fixture.method,
                &fixture.url,
                None
            ),
            Err(AdmissionError::Rejected)
        );
    }

    #[test]
    fn replay_is_atomic_and_capacity_never_evicts_live_proofs() {
        let fixture = Fixture::new(ReplayPolicy {
            max_entries: 1,
            max_per_device: 1,
            require_nonce: false,
        });
        let proof = fixture.proof();
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let validator = fixture.validator.clone();
            let barrier = barrier.clone();
            let token = fixture.issued.clone();
            let proof = proof.clone();
            let method = fixture.method.clone();
            let url = fixture.url.clone();
            let now = fixture.now;
            workers.push(thread::spawn(move || {
                barrier.wait();
                validator.validate_at(&token, &proof, &method, &url, None, now)
            }));
        }
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == Err(AdmissionError::Replay))
                .count(),
            7
        );

        let another = fixture.proof();
        assert_eq!(fixture.validate(&another), Err(AdmissionError::Capacity));
    }

    #[test]
    fn replay_bounds_are_per_device_and_expired_entries_are_pruned() {
        let fixture = Fixture::new(ReplayPolicy {
            max_entries: 3,
            max_per_device: 1,
            require_nonce: false,
        });
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let third = Uuid::new_v4().to_string();
        assert_eq!(
            fixture
                .validator
                .consume_replay("jkt:a".into(), first.clone(), 100, 10),
            Ok(())
        );
        assert_eq!(
            fixture
                .validator
                .consume_replay("jkt:b".into(), first, 100, 10),
            Err(AdmissionError::Capacity)
        );
        assert_eq!(
            fixture
                .validator
                .consume_replay("jkt:c".into(), second, 100, 10),
            Ok(())
        );
        assert_eq!(
            fixture
                .validator
                .consume_replay("jkt:d".into(), third, 100, 10),
            Ok(())
        );
        assert_eq!(
            fixture
                .validator
                .consume_replay("jkt:e".into(), Uuid::new_v4().to_string(), 200, 10,),
            Err(AdmissionError::Capacity)
        );
        assert_eq!(
            fixture
                .validator
                .consume_replay("jkt:e".into(), Uuid::new_v4().to_string(), 200, 100,),
            Ok(())
        );
    }

    #[test]
    fn rejects_expired_tokens_and_invalid_trust_configuration() {
        let fixture = Fixture::new(test_policy());
        let proof = fixture.proof();
        let future =
            fixture.now + myagents_agent_network_protocol::budget("tokenSeconds") as i64 + 60;
        assert_eq!(
            fixture.validator.validate_at(
                &fixture.issued,
                &proof,
                &fixture.method,
                &fixture.url,
                None,
                future
            ),
            Err(AdmissionError::Rejected)
        );
        let mut bad = ExpectedService {
            https_origin_canonical: "http://agentnet.example.test".into(),
            service_id: fixture.profile.service_id.clone(),
            environment: fixture.profile.environment.clone(),
            network_id: fixture.profile.network_id.clone(),
            jwks: fixture.keys.jwks(),
        };
        assert!(matches!(
            AdmissionValidator::new(bad.clone(), ReplayPolicy::default()),
            Err(AdmissionError::Configuration)
        ));
        bad.https_origin_canonical = fixture.profile.issuer.clone();
        bad.jwks["keys"][0]["d"] = json!("must-not-be-private");
        assert!(matches!(
            AdmissionValidator::new(bad, ReplayPolicy::default()),
            Err(AdmissionError::Configuration)
        ));
    }

    #[test]
    fn nonce_is_required_by_default_but_can_be_explicitly_disabled_for_interop_tests() {
        let fixture = Fixture::new(ReplayPolicy::default());
        let proof_without_nonce = fixture.proof();
        assert_eq!(
            fixture.validate(&proof_without_nonce),
            Err(AdmissionError::Rejected)
        );

        let proof_with_nonce = fixture
            .device_key
            .dpop(
                &fixture.method,
                &Url::parse(&fixture.url).unwrap(),
                &fixture.issued,
                Some("boot-nonce"),
            )
            .unwrap();
        assert!(fixture
            .validator
            .validate_at(
                &fixture.issued,
                &proof_with_nonce,
                &fixture.method,
                &fixture.url,
                Some("boot-nonce"),
                fixture.now,
            )
            .is_ok());
    }

    #[test]
    fn lock_wait_rechecks_real_signed_access_and_dpop_with_fresh_time() {
        let fixture = Fixture::new(test_policy());
        let proof = fixture.proof();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let validator = fixture.validator.clone();
        let access = fixture.issued.clone();
        let proof_for_thread = proof.clone();
        let method = fixture.method.clone();
        let url = fixture.url.clone();
        let now = fixture.now;
        let worker = thread::spawn(move || {
            let mut calls = 0;
            validator.validate_with_clock(&access, &proof_for_thread, &method, &url, None, || {
                calls += 1;
                match calls {
                    1 => Ok(now),
                    2 => {
                        locked_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(now + 120)
                    }
                    _ => Ok(now + 120),
                }
            })
        });
        locked_rx.recv().unwrap();
        // The second clock sample runs after the validator owns the replay
        // mutex. Advancing beyond the proof's freshness window must reject it.
        release_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap(), Err(AdmissionError::Rejected));

        // A rejected expired proof was not inserted, so its signed request
        // can still be validated later if presented with a fresh proof.
        assert!(fixture.validate(&proof).is_ok());
    }

    #[test]
    fn proof_expiring_during_final_projection_fails_closed_after_consumption() {
        let fixture = Fixture::new(test_policy());
        let proof = fixture.proof();
        let mut calls = 0;
        let result = fixture.validator.validate_with_clock(
            &fixture.issued,
            &proof,
            &fixture.method,
            &fixture.url,
            None,
            || {
                calls += 1;
                if calls < 3 {
                    Ok(fixture.now)
                } else {
                    Ok(fixture.now + 120)
                }
            },
        );
        assert_eq!(result, Err(AdmissionError::Rejected));
        assert_eq!(fixture.validate(&proof), Err(AdmissionError::Replay));
    }
}
