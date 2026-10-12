//! Authenticated HTTP adapter for the self-hosted identity signer.
//!
//! This module owns no credentials: every private route is gated by a live
//! AuthStore bearer session, and device mutations run inside its revocation
//! gate. Public-key persistence and proof-of-possession are delegated to the
//! device owner; signing is delegated to identity-core.

use crate::{AuthError, AuthStore, SessionProjection};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        DefaultBodyLimit, Query, Request, State,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use myagents_agentnet_device_core::{
    ChallengeOperation, DeviceError, DeviceRecord, DeviceStore, SessionContext, csr_fingerprint,
};
use myagents_agentnet_identity_core::{
    IdentityCoreError, IdentityRequest, IssuedIdentity, IssuerProfile, ServiceKeys,
};
use myagents_agentnet_peer_core::{PeerProfile, PeerStore};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use url::Url;
use zeroize::Zeroizing;

const MAX_HTTP_BODY: usize = 8 * 1024;

/// Operator configuration for the already-initialized identity signing keys.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityHttpConfig {
    pub issuer: String,
    pub service_id: String,
    pub environment: String,
    pub key_file: PathBuf,
}

#[derive(Clone)]
pub struct IdentityService {
    auth: Arc<AuthStore>,
    devices: Arc<DeviceStore>,
    peers: Arc<PeerStore>,
    keys: Arc<ServiceKeys>,
    profile: IssuerProfile,
}

impl IdentityService {
    pub fn open(
        auth: Arc<AuthStore>,
        state_dir: &Path,
        config: &IdentityHttpConfig,
        network_id: &str,
    ) -> Result<Self, AuthError> {
        if !config.key_file.is_absolute() || !state_dir.is_absolute() {
            return Err(AuthError::Configuration);
        }
        validate_profile(
            &config.issuer,
            &config.service_id,
            &config.environment,
            network_id,
        )?;
        let keys = ServiceKeys::load(&config.key_file).map_err(|_| AuthError::Configuration)?;
        let devices = DeviceStore::open(state_dir).map_err(|_| AuthError::Storage)?;
        let profile = IssuerProfile {
            issuer: config.issuer.clone(),
            service_id: config.service_id.clone(),
            environment: config.environment.clone(),
            network_id: network_id.to_owned(),
        };
        let peers = PeerStore::open(
            state_dir,
            PeerProfile {
                issuer: profile.issuer.clone(),
                service_id: profile.service_id.clone(),
                environment: profile.environment.clone(),
                network_id: profile.network_id.clone(),
            },
        )
        .map_err(|_| AuthError::Storage)?;
        Ok(Self {
            auth,
            devices: Arc::new(devices),
            peers: Arc::new(peers),
            keys: Arc::new(keys),
            profile,
        })
    }

    pub fn router(&self) -> Router<()> {
        let state = Arc::new(self.clone());
        Router::new()
            .route("/api/agent-network/identity/state", get(identity_state))
            .route("/api/agent-network/identity", post(identity_initial))
            .route("/api/agent-network/challenge", post(challenge))
            .route(
                "/api/agent-network/identity/current",
                post(identity_current),
            )
            .route("/api/agent-network/certificate", post(certificate_renew))
            .route("/api/agent-network/jwks", get(jwks))
            .layer(DefaultBodyLimit::max(MAX_HTTP_BODY))
            .layer(middleware::from_fn(add_no_store))
            .with_state(state)
    }

    fn with_session<T>(
        &self,
        headers: &HeaderMap,
        operation: impl FnOnce(SessionProjection) -> Result<T, IdentityHttpError>,
    ) -> Result<T, IdentityHttpError> {
        let token = bearer_token(headers)?;
        self.auth.with_valid_session(&token, operation)
    }

    fn context(&self, session: &SessionProjection) -> Result<SessionContext, IdentityHttpError> {
        if session.account.network_id != self.profile.network_id {
            return Err(IdentityHttpError::auth(AuthError::SessionRejected));
        }
        Ok(SessionContext {
            principal_id: session.account.principal_id.clone(),
            network_id: session.account.network_id.clone(),
            device_id: session.device_id.clone(),
            session_handle: session.session_handle.clone(),
            expires_at: session.expires_at,
        })
    }

    fn issue(
        &self,
        session: &SessionProjection,
        record: &DeviceRecord,
    ) -> Result<IssuedIdentity, IdentityHttpError> {
        if record.principal_id != session.account.principal_id
            || record.network_id != session.account.network_id
            || record.device_id != session.device_id
        {
            return Err(IdentityHttpError::device(DeviceError::OwnerMismatch));
        }
        // Signing may outlive the authenticated session. This issuer checks the
        // session both before and after this closure; later admission still
        // checks sessionHandle against AuthStore and never treats these tokens
        // as durable authorization after logout/revocation.
        let issued = self
            .keys
            .issue(
                &self.profile,
                &IdentityRequest {
                    principal_id: record.principal_id.clone(),
                    device_id: record.device_id.clone(),
                    key_generation: record.key_generation,
                    identity_binding_id: record.identity_binding_id.clone(),
                    session_handle: session.session_handle.clone(),
                    csr_pem: record.csr_pem.clone(),
                },
            )
            .map_err(IdentityHttpError::identity)?;
        let context = self.context(session)?;
        self.peers
            .record_issued(&context, record, &self.keys, &issued)
            .map_err(|_| IdentityHttpError::internal())?;
        Ok(issued)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateQuery {
    device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceInfo {
    device_name: String,
    platform: String,
    os_version: String,
    app_version: String,
}

impl DeviceInfo {
    fn validate(&self) -> Result<(), IdentityHttpError> {
        if self.device_name.len() > 256
            || self.platform.len() > 64
            || self.os_version.len() > 128
            || self.app_version.len() > 128
        {
            return Err(IdentityHttpError::bad_request("IDENTITY_REQUEST_INVALID"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialIdentityBody {
    device_id: String,
    csr: String,
    expected_key_generation: Option<u64>,
    #[serde(default)]
    device_info: Option<DeviceInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChallengeBody {
    device_id: String,
    operation: String,
    target_fingerprint: String,
    expected_key_generation: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CurrentBody {
    device_id: String,
    key_fingerprint: String,
    expected_key_generation: u64,
    challenge_id: String,
    proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CertificateBody {
    device_id: String,
    csr: String,
    expected_key_generation: u64,
    challenge_id: String,
    proof: String,
}

async fn identity_state(
    State(service): State<Arc<IdentityService>>,
    headers: HeaderMap,
    query: Result<Query<StateQuery>, QueryRejection>,
) -> Result<Json<Value>, IdentityHttpError> {
    let Query(query) =
        query.map_err(|_| IdentityHttpError::bad_request("IDENTITY_REQUEST_INVALID"))?;
    service.with_session(&headers, |session| {
        let context = service.context(&session)?;
        let record = service
            .devices
            .read_state(&context, &query.device_id)
            .map_err(IdentityHttpError::device)?;
        let value = json!({
            "serviceId": service.profile.service_id,
            "environment": service.profile.environment,
            "deviceId": query.device_id,
            "keyGeneration": record.as_ref().map(|entry| entry.key_generation),
            "keyFingerprint": record.map(|entry| entry.key_fingerprint),
        });
        Ok(Json(value))
    })
}

async fn identity_initial(
    State(service): State<Arc<IdentityService>>,
    headers: HeaderMap,
    body: Result<Json<InitialIdentityBody>, JsonRejection>,
) -> Result<Json<Value>, IdentityHttpError> {
    let Json(body) =
        body.map_err(|_| IdentityHttpError::bad_request("IDENTITY_REQUEST_INVALID"))?;
    if body.expected_key_generation.is_some() {
        return Err(IdentityHttpError::conflict("KEY_GENERATION_CONFLICT"));
    }
    if let Some(info) = body.device_info.as_ref() {
        info.validate()?;
    }
    service.with_session(&headers, |session| {
        require_own_device(&session, &body.device_id)?;
        let context = service.context(&session)?;
        let record = service
            .devices
            .claim_initial(&context, &body.csr)
            .map_err(IdentityHttpError::device)?;
        if record.csr_pem != body.csr
            || csr_fingerprint(&record.csr_pem).map_err(IdentityHttpError::device)?
                != record.key_fingerprint
        {
            return Err(IdentityHttpError::internal());
        }
        service
            .issue(&session, &record)?
            .as_json()
            .map(Json)
            .map_err(IdentityHttpError::identity)
    })
}

async fn challenge(
    State(service): State<Arc<IdentityService>>,
    headers: HeaderMap,
    body: Result<Json<ChallengeBody>, JsonRejection>,
) -> Result<Json<Value>, IdentityHttpError> {
    let Json(body) =
        body.map_err(|_| IdentityHttpError::bad_request("IDENTITY_REQUEST_INVALID"))?;
    let operation = match body.operation.as_str() {
        "recover-query" => ChallengeOperation::RecoverQuery,
        "renew" => ChallengeOperation::Renew,
        // Rotation is not part of the current client contract. Do not issue a
        // challenge that no supported endpoint can safely complete.
        "rotate" => {
            return Err(IdentityHttpError::bad_request(
                "IDENTITY_OPERATION_UNSUPPORTED",
            ));
        }
        _ => return Err(IdentityHttpError::bad_request("IDENTITY_OPERATION_INVALID")),
    };
    service.with_session(&headers, |session| {
        require_own_device(&session, &body.device_id)?;
        let context = service.context(&session)?;
        let challenge = service
            .devices
            .create_challenge(
                &context,
                operation,
                body.expected_key_generation,
                &body.target_fingerprint,
            )
            .map_err(IdentityHttpError::device)?;
        Ok(Json(json!({
            "challengeId": challenge.challenge_id,
            "nonce": challenge.nonce,
            "expiresAt": challenge.expires_at,
        })))
    })
}

async fn identity_current(
    State(service): State<Arc<IdentityService>>,
    headers: HeaderMap,
    body: Result<Json<CurrentBody>, JsonRejection>,
) -> Result<Json<Value>, IdentityHttpError> {
    let Json(body) =
        body.map_err(|_| IdentityHttpError::bad_request("IDENTITY_REQUEST_INVALID"))?;
    service.with_session(&headers, |session| {
        require_own_device(&session, &body.device_id)?;
        let context = service.context(&session)?;
        let record = service
            .devices
            .consume_proof(
                &context,
                ChallengeOperation::RecoverQuery,
                body.expected_key_generation,
                &body.challenge_id,
                &body.proof,
            )
            .map_err(IdentityHttpError::device)?;
        if body.key_fingerprint != record.key_fingerprint
            || csr_fingerprint(&record.csr_pem).map_err(IdentityHttpError::device)?
                != record.key_fingerprint
        {
            return Err(IdentityHttpError::conflict("KEY_GENERATION_CONFLICT"));
        }
        service
            .issue(&session, &record)?
            .as_json()
            .map(Json)
            .map_err(IdentityHttpError::identity)
    })
}

async fn certificate_renew(
    State(service): State<Arc<IdentityService>>,
    headers: HeaderMap,
    body: Result<Json<CertificateBody>, JsonRejection>,
) -> Result<Json<Value>, IdentityHttpError> {
    let Json(body) =
        body.map_err(|_| IdentityHttpError::bad_request("IDENTITY_REQUEST_INVALID"))?;
    service.with_session(&headers, |session| {
        require_own_device(&session, &body.device_id)?;
        let context = service.context(&session)?;
        // Consume the old-key proof first so a valid proof cannot be replayed
        // with a different incoming CSR. Only the verified persisted CSR signs.
        let record = service
            .devices
            .consume_proof(
                &context,
                ChallengeOperation::Renew,
                body.expected_key_generation,
                &body.challenge_id,
                &body.proof,
            )
            .map_err(IdentityHttpError::device)?;
        let requested = csr_fingerprint(&body.csr).map_err(IdentityHttpError::device)?;
        if requested != record.key_fingerprint
            || csr_fingerprint(&record.csr_pem).map_err(IdentityHttpError::device)?
                != record.key_fingerprint
        {
            return Err(IdentityHttpError::conflict("KEY_GENERATION_CONFLICT"));
        }
        service
            .issue(&session, &record)?
            .as_json()
            .map(Json)
            .map_err(IdentityHttpError::identity)
    })
}

async fn jwks(State(service): State<Arc<IdentityService>>) -> Json<Value> {
    Json(service.keys.jwks())
}

fn require_own_device(
    session: &SessionProjection,
    device_id: &str,
) -> Result<(), IdentityHttpError> {
    if session.device_id != device_id {
        return Err(IdentityHttpError::device(DeviceError::OwnerMismatch));
    }
    Ok(())
}

fn bearer_token(headers: &HeaderMap) -> Result<Zeroizing<String>, IdentityHttpError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|token| {
            token.len() == 43
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .ok_or_else(|| IdentityHttpError::auth(AuthError::SessionRejected))?;
    Ok(Zeroizing::new(value.to_owned()))
}

fn validate_profile(
    issuer: &str,
    service_id: &str,
    environment: &str,
    network_id: &str,
) -> Result<(), AuthError> {
    let url = Url::parse(issuer).map_err(|_| AuthError::Configuration)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.origin().ascii_serialization() != issuer
        || !canonical_uuid(service_id)
        || !canonical_uuid(network_id)
        || !matches!(environment, "production" | "development")
    {
        return Err(AuthError::Configuration);
    }
    Ok(())
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

async fn add_no_store(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Debug)]
enum IdentityHttpError {
    Auth(AuthError),
    Device(DeviceError),
    Identity(IdentityCoreError),
    Fixed(StatusCode, &'static str),
}

impl IdentityHttpError {
    fn auth(error: AuthError) -> Self {
        Self::Auth(error)
    }
    fn device(error: DeviceError) -> Self {
        Self::Device(error)
    }
    fn identity(error: IdentityCoreError) -> Self {
        Self::Identity(error)
    }
    fn bad_request(code: &'static str) -> Self {
        Self::Fixed(StatusCode::BAD_REQUEST, code)
    }
    fn conflict(code: &'static str) -> Self {
        Self::Fixed(StatusCode::CONFLICT, code)
    }
    fn internal() -> Self {
        Self::Fixed(StatusCode::INTERNAL_SERVER_ERROR, "IDENTITY_UNAVAILABLE")
    }

    fn response(&self) -> (StatusCode, &'static str) {
        match self {
            Self::Auth(AuthError::SessionRejected) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            Self::Auth(_) => (StatusCode::INTERNAL_SERVER_ERROR, "IDENTITY_UNAVAILABLE"),
            Self::Device(DeviceError::InvalidSession) => (StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            Self::Device(DeviceError::OwnerMismatch | DeviceError::DeviceNotFound) => {
                (StatusCode::NOT_FOUND, "IDENTITY_NOT_FOUND")
            }
            Self::Device(DeviceError::DeviceAlreadyClaimed | DeviceError::GenerationConflict) => {
                (StatusCode::CONFLICT, "KEY_GENERATION_CONFLICT")
            }
            Self::Device(
                DeviceError::ChallengeRejected
                | DeviceError::ChallengeExpired
                | DeviceError::ProofInvalid,
            ) => (StatusCode::FORBIDDEN, "PROOF_REJECTED"),
            Self::Device(DeviceError::InvalidInput) => {
                (StatusCode::BAD_REQUEST, "IDENTITY_REQUEST_INVALID")
            }
            Self::Device(_) => (StatusCode::INTERNAL_SERVER_ERROR, "IDENTITY_UNAVAILABLE"),
            Self::Identity(IdentityCoreError::CsrInvalid | IdentityCoreError::ScopeInvalid) => {
                (StatusCode::BAD_REQUEST, "IDENTITY_REQUEST_INVALID")
            }
            Self::Identity(_) => (StatusCode::INTERNAL_SERVER_ERROR, "IDENTITY_UNAVAILABLE"),
            Self::Fixed(status, code) => (*status, code),
        }
    }
}

impl From<AuthError> for IdentityHttpError {
    fn from(error: AuthError) -> Self {
        Self::Auth(error)
    }
}

impl IntoResponse for IdentityHttpError {
    fn into_response(self) -> Response {
        let (status, code) = self.response();
        (status, Json(json!({"error":{"code":code}}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthConfig, OidcVerifier};
    use axum::{
        body::{Body, to_bytes},
        http::{
            Request,
            header::{AUTHORIZATION, CONTENT_TYPE},
        },
    };
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use myagents_agent_network_crypto::DevicePrivateKey;
    use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts};
    use serde_json::json;
    use std::{fs, os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
    use tempfile::TempDir;
    use tower::ServiceExt;
    use uuid::Uuid;
    use zeroize::Zeroizing;

    const OIDC_ISSUER: &str = "https://dex.example.test";
    const OIDC_CLIENT: &str = "agentnet-desktop";

    struct SigningFixture {
        key: RsaPrivateKey,
        jwks: Value,
    }
    impl SigningFixture {
        fn new() -> Self {
            let key = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
            Self {
                jwks: json!({"keys":[{"kty":"RSA","n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),"kid":"oidc-test-key","alg":"RS256","use":"sig"}]}),
                key,
            }
        }
        fn subject(&self) -> crate::VerifiedSubject {
            let nonce = Uuid::new_v4().to_string();
            let now = jsonwebtoken::get_current_timestamp();
            let mut header = Header::new(Algorithm::RS256);
            header.kid = Some("oidc-test-key".into());
            let claims = json!({"iss":OIDC_ISSUER,"sub":"local-user-1","aud":OIDC_CLIENT,"iat":now,"exp":now+600,"nonce":nonce});
            let der = self.key.to_pkcs1_der().unwrap();
            let token = Zeroizing::new(
                encode(&header, &claims, &EncodingKey::from_rsa_der(der.as_bytes())).unwrap(),
            );
            OidcVerifier::new(OIDC_ISSUER, OIDC_CLIENT, self.jwks.clone())
                .unwrap()
                .verify_id_token(&token, &nonce)
                .unwrap()
        }
    }

    fn private_dir() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    async fn request(
        router: Router,
        token: Option<&str>,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value, HeaderMap) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        let request = if let Some(body) = body {
            builder
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        };
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), MAX_HTTP_BODY).await.unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value, headers)
    }

    fn config(service_id: &str, key_file: PathBuf) -> IdentityHttpConfig {
        IdentityHttpConfig {
            issuer: "https://agentnet.example.test".into(),
            service_id: service_id.into(),
            environment: "development".into(),
            key_file,
        }
    }

    fn verify_signed_result(
        value: &Value,
        service: &IdentityService,
        typ: &str,
        audience: &str,
    ) -> Value {
        let token = if typ == "ma-network-access+jwt" {
            value["accessToken"].as_str().unwrap()
        } else {
            value["signedBinding"].as_str().unwrap()
        };
        let header = jsonwebtoken::decode_header(token).unwrap();
        assert_eq!(header.typ.as_deref(), Some(typ));
        let jwks: jsonwebtoken::jwk::JwkSet = serde_json::from_value(service.keys.jwks()).unwrap();
        let key =
            jsonwebtoken::DecodingKey::from_jwk(jwks.find(header.kid.as_deref().unwrap()).unwrap())
                .unwrap();
        let mut validation = jsonwebtoken::Validation::new(Algorithm::ES256);
        validation.set_issuer(&[service.profile.issuer.as_str()]);
        validation.set_audience(&[audience]);
        jsonwebtoken::decode::<Value>(token, &key, &validation)
            .unwrap()
            .claims
    }

    fn authenticated_service(
        dir: &TempDir,
    ) -> (IdentityService, Arc<AuthStore>, String, String, String) {
        let network_id = Uuid::new_v4().to_string();
        let service_id = Uuid::new_v4().to_string();
        let auth = Arc::new(
            AuthStore::open(
                dir.path(),
                &AuthConfig {
                    network_id: network_id.clone(),
                    login_ttl: Duration::from_secs(300),
                    session_ttl: Duration::from_secs(3600),
                },
            )
            .unwrap(),
        );
        let fixture = SigningFixture::new();
        let verified = fixture.subject();
        let first_device = Uuid::new_v4().to_string();
        let second_device = Uuid::new_v4().to_string();
        let token1 = auth
            .issue_session(&verified, &first_device)
            .unwrap()
            .into_token()
            .to_string();
        let token2 = auth
            .issue_session(&verified, &second_device)
            .unwrap()
            .into_token()
            .to_string();
        let keys_path = dir.path().join("identity-keys.json");
        ServiceKeys::generate_initial(&keys_path).unwrap();
        let service = IdentityService::open(
            auth.clone(),
            dir.path(),
            &config(&service_id, keys_path),
            &network_id,
        )
        .unwrap();
        (service, auth, token1, token2, first_device)
    }

    #[tokio::test]
    async fn real_session_identity_issue_current_renew_and_fail_closed_paths() {
        let dir = private_dir();
        let (service, auth, token, other_device_token, device_id) = authenticated_service(&dir);
        let router = service.router();
        let device_key = DevicePrivateKey::generate().unwrap();
        let csr = device_key.csr().unwrap();
        let initial_body = json!({"deviceId":device_id,"csr":csr,"expectedKeyGeneration":null,"deviceInfo":{"deviceName":"test","platform":"linux","osVersion":"test","appVersion":"test"}});
        let (status, issued, headers) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity",
            Some(initial_body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(issued["keyGeneration"], 1);
        let access = verify_signed_result(
            &issued,
            &service,
            "ma-network-access+jwt",
            &service.profile.service_id,
        );
        assert_eq!(access["deviceId"], device_id);
        assert_eq!(
            access["cnf"]["jkt"],
            device_key.public_thumbprint().unwrap()
        );
        let peer = verify_signed_result(
            &issued,
            &service,
            "ma-network-peer+jwt",
            "myagents-agent-peer",
        );
        assert_eq!(peer["binding"]["deviceId"], device_id);
        assert_eq!(peer["binding"]["principalId"], access["sub"]);
        let context = service
            .context(&auth.validate_session(&token).unwrap())
            .unwrap();
        let initial_jti = access["jti"].as_str().unwrap();
        let initial_snapshot = service
            .peers
            .lookup(
                &context,
                initial_jti,
                1,
                &device_key.public_fingerprint().unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            initial_snapshot.certificate,
            issued["certificate"].as_str().unwrap()
        );
        assert_eq!(
            initial_snapshot.signed_binding,
            issued["signedBinding"].as_str().unwrap()
        );

        let (jwks_status, jwks, jwks_headers) =
            request(router.clone(), None, "GET", "/api/agent-network/jwks", None).await;
        assert_eq!(jwks_status, StatusCode::OK);
        assert_eq!(jwks, service.keys.jwks());
        assert_eq!(jwks_headers.get(header::CACHE_CONTROL).unwrap(), "no-store");

        let (status, state, _) = request(
            router.clone(),
            Some(&token),
            "GET",
            &format!("/api/agent-network/identity/state?deviceId={device_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(state["keyGeneration"], 1);

        // Same-account sessions may read another device's public identity state.
        let (status, state, _) = request(
            router.clone(),
            Some(&other_device_token),
            "GET",
            &format!("/api/agent-network/identity/state?deviceId={device_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            state["keyFingerprint"],
            device_key.public_fingerprint().unwrap()
        );

        // But a different device session cannot mint challenges against it.
        let (status, _, _) = request(router.clone(), Some(&other_device_token), "POST", "/api/agent-network/challenge", Some(json!({"deviceId":device_id,"operation":"recover-query","targetFingerprint":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","expectedKeyGeneration":1}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let fingerprint = device_key.public_fingerprint().unwrap();
        let (status, challenge, _) = request(router.clone(), Some(&token), "POST", "/api/agent-network/challenge", Some(json!({"deviceId":device_id,"operation":"recover-query","targetFingerprint":fingerprint,"expectedKeyGeneration":1}))).await;
        assert_eq!(status, StatusCode::OK);
        let proof = device_key
            .sign_proof(
                challenge["challengeId"].as_str().unwrap(),
                challenge["nonce"].as_str().unwrap(),
            )
            .unwrap();
        let current_body = json!({"deviceId":device_id,"keyFingerprint":fingerprint,"expectedKeyGeneration":1,"challengeId":challenge["challengeId"],"proof":proof});

        let (status, bad_proof_challenge, _) = request(router.clone(), Some(&token), "POST", "/api/agent-network/challenge", Some(json!({"deviceId":device_id,"operation":"recover-query","targetFingerprint":fingerprint,"expectedKeyGeneration":1}))).await;
        assert_eq!(status, StatusCode::OK);
        let wrong_key = DevicePrivateKey::generate().unwrap();
        let wrong_proof = wrong_key
            .sign_proof(
                bad_proof_challenge["challengeId"].as_str().unwrap(),
                bad_proof_challenge["nonce"].as_str().unwrap(),
            )
            .unwrap();
        let bad_body = json!({"deviceId":device_id,"keyFingerprint":fingerprint,"expectedKeyGeneration":1,"challengeId":bad_proof_challenge["challengeId"],"proof":wrong_proof});
        let (status, _, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity/current",
            Some(bad_body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let retry_proof = device_key
            .sign_proof(
                bad_proof_challenge["challengeId"].as_str().unwrap(),
                bad_proof_challenge["nonce"].as_str().unwrap(),
            )
            .unwrap();
        let retry_body = json!({"deviceId":device_id,"keyFingerprint":fingerprint,"expectedKeyGeneration":1,"challengeId":bad_proof_challenge["challengeId"],"proof":retry_proof});
        let (status, _, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity/current",
            Some(retry_body),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, current, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity/current",
            Some(current_body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            verify_signed_result(
                &current,
                &service,
                "ma-network-access+jwt",
                &service.profile.service_id
            )["deviceId"],
            device_id
        );
        let current_claims = verify_signed_result(
            &current,
            &service,
            "ma-network-access+jwt",
            &service.profile.service_id,
        );
        let current_snapshot = service
            .peers
            .lookup(
                &context,
                current_claims["jti"].as_str().unwrap(),
                1,
                &fingerprint,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            current_snapshot.certificate,
            current["certificate"].as_str().unwrap()
        );
        assert_eq!(
            current_snapshot.signed_binding,
            current["signedBinding"].as_str().unwrap()
        );
        assert_ne!(current_snapshot.access_jti, initial_snapshot.access_jti);
        let (status, repeat_challenge, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/challenge",
            Some(json!({"deviceId":device_id,"operation":"recover-query","targetFingerprint":fingerprint,"expectedKeyGeneration":1})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let repeat_proof = device_key
            .sign_proof(
                repeat_challenge["challengeId"].as_str().unwrap(),
                repeat_challenge["nonce"].as_str().unwrap(),
            )
            .unwrap();
        let repeat_body = json!({"deviceId":device_id,"keyFingerprint":fingerprint,"expectedKeyGeneration":1,"challengeId":repeat_challenge["challengeId"],"proof":repeat_proof});
        let (status, _, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity/current",
            Some(repeat_body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity/current",
            Some(repeat_body),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // A valid renewal proof cannot be used to replace the stored CSR/key.
        let (status, renew_challenge, _) = request(router.clone(), Some(&token), "POST", "/api/agent-network/challenge", Some(json!({"deviceId":device_id,"operation":"renew","targetFingerprint":fingerprint,"expectedKeyGeneration":1}))).await;
        assert_eq!(status, StatusCode::OK);
        let renew_proof = device_key
            .sign_proof(
                renew_challenge["challengeId"].as_str().unwrap(),
                renew_challenge["nonce"].as_str().unwrap(),
            )
            .unwrap();
        let replacement_key = DevicePrivateKey::generate().unwrap();
        let (status, _, _) = request(router.clone(), Some(&token), "POST", "/api/agent-network/certificate", Some(json!({"deviceId":device_id,"csr":replacement_key.csr().unwrap(),"expectedKeyGeneration":1,"challengeId":renew_challenge["challengeId"],"proof":renew_proof}))).await;
        assert_eq!(status, StatusCode::CONFLICT);

        let (status, renew_challenge, _) = request(router.clone(), Some(&token), "POST", "/api/agent-network/challenge", Some(json!({"deviceId":device_id,"operation":"renew","targetFingerprint":fingerprint,"expectedKeyGeneration":1}))).await;
        assert_eq!(status, StatusCode::OK);
        let renew_proof = device_key
            .sign_proof(
                renew_challenge["challengeId"].as_str().unwrap(),
                renew_challenge["nonce"].as_str().unwrap(),
            )
            .unwrap();
        let (status, renewed, _) = request(router.clone(), Some(&token), "POST", "/api/agent-network/certificate", Some(json!({"deviceId":device_id,"csr":csr,"expectedKeyGeneration":1,"challengeId":renew_challenge["challengeId"],"proof":renew_proof}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            verify_signed_result(
                &renewed,
                &service,
                "ma-network-peer+jwt",
                "myagents-agent-peer"
            )["binding"]["keyGeneration"],
            1
        );
        let renewed_claims = verify_signed_result(
            &renewed,
            &service,
            "ma-network-access+jwt",
            &service.profile.service_id,
        );
        let renewed_snapshot = service
            .peers
            .lookup(
                &context,
                renewed_claims["jti"].as_str().unwrap(),
                1,
                &fingerprint,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            renewed_snapshot.certificate,
            renewed["certificate"].as_str().unwrap()
        );
        assert_eq!(
            renewed_snapshot.signed_binding,
            renewed["signedBinding"].as_str().unwrap()
        );
        assert_ne!(renewed_snapshot.access_jti, current_snapshot.access_jti);

        let restarted = IdentityService::open(
            auth.clone(),
            dir.path(),
            &config(
                &service.profile.service_id,
                dir.path().join("identity-keys.json"),
            ),
            &service.profile.network_id,
        )
        .unwrap();
        assert_eq!(
            restarted
                .peers
                .lookup(&context, &renewed_snapshot.access_jti, 1, &fingerprint,)
                .unwrap(),
            Some(renewed_snapshot.clone()),
            "restart loads the exact issued public snapshot"
        );

        let (status, _, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity",
            Some(initial_body),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        auth.revoke_session(&token).unwrap();
        let (status, rejected, _) = request(
            router.clone(),
            Some(&token),
            "POST",
            "/api/agent-network/identity/current",
            Some(current_body),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(rejected["accessToken"].is_null());
        let (status, _, _) = request(
            router,
            Some(&token),
            "GET",
            &format!("/api/agent-network/identity/state?deviceId={device_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn snapshot_persistence_failure_never_returns_successful_identity() {
        let dir = private_dir();
        let (service, _auth, token, _other_device_token, device_id) = authenticated_service(&dir);
        let peer_db = dir.path().join("peers.sqlite3");
        let peer_connection = rusqlite::Connection::open(peer_db).unwrap();
        peer_connection
            .execute_batch(
                "CREATE TRIGGER fail_peer_snapshot_insert BEFORE INSERT ON peer_snapshots
                 BEGIN SELECT RAISE(ABORT,'test persistence failure'); END;",
            )
            .unwrap();

        let key = DevicePrivateKey::generate().unwrap();
        let (status, response, _) = request(
            service.router(),
            Some(&token),
            "POST",
            "/api/agent-network/identity",
            Some(json!({
                "deviceId": device_id,
                "csr": key.csr().unwrap(),
                "deviceInfo": {
                    "deviceName": "test",
                    "platform": "linux",
                    "osVersion": "test",
                    "appVersion": "test"
                }
            })),
        )
        .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response["error"]["code"], "IDENTITY_UNAVAILABLE");
        assert!(response["accessToken"].is_null());
        let rows: i64 = peer_connection
            .query_row("SELECT COUNT(*) FROM peer_snapshots", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }
}
