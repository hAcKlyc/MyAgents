//! Fixed 1.1 metadata HTTP adapter. No catalog upload or relay authority.
//! Device registration is an owned application extension, never self-reported scope.
use crate::{AuthError, AuthStore, identity_http::IdentityHttpConfig};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use myagents_agentnet_admission_core::{
    AdmissionError, AdmissionValidator, ExpectedService, ReplayPolicy, ValidatedAccess,
};
use myagents_agentnet_device_core::{DeviceError, DeviceRecord, DeviceStore, SessionContext};
use myagents_agentnet_identity_core::ServiceKeys;
use myagents_agentnet_metadata_core::{DeviceInfo, MetadataError, MetadataProfile, MetadataStore};
use myagents_agentnet_peer_core::{PeerProfile, PeerStore};
use rand::TryRngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_BODY: usize = 8 * 1024;
const MAX_HEADER: usize = 16 * 1024;
const MAX_IN_FLIGHT: usize = 32;
const BODY_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkHttpConfig {
    pub name: String,
}

#[derive(Clone)]
pub struct NetworkService {
    pub(super) auth: Arc<AuthStore>,
    pub(super) devices: Arc<DeviceStore>,
    pub(super) metadata: Arc<MetadataStore>,
    pub(super) peers: Arc<PeerStore>,
    admission: AdmissionValidator,
    in_flight: Arc<Semaphore>,
    pub(super) issuer: String,
    pub(super) network_id: String,
    pub(super) service_id: String,
    pub(super) environment: String,
    network_name: String,
    boot_nonce: String,
    #[cfg(test)]
    test_body_read_timeout: Option<std::time::Duration>,
    // This owner only loads existing signing authority; it never initializes keys.
    pub(super) _keys: Arc<ServiceKeys>,
}

impl NetworkService {
    pub fn open(
        auth: Arc<AuthStore>,
        state_dir: &Path,
        identity: &IdentityHttpConfig,
        network_id: &str,
        config: &NetworkHttpConfig,
    ) -> Result<Self, AuthError> {
        if !state_dir.is_absolute() || !identity.key_file.is_absolute() {
            return Err(AuthError::Configuration);
        }
        let keys = ServiceKeys::load(&identity.key_file).map_err(|_| AuthError::Configuration)?;
        let admission = AdmissionValidator::new(
            ExpectedService {
                https_origin_canonical: identity.issuer.clone(),
                service_id: identity.service_id.clone(),
                environment: identity.environment.clone(),
                network_id: network_id.into(),
                jwks: keys.jwks(),
            },
            ReplayPolicy::default(),
        )
        .map_err(|_| AuthError::Configuration)?;
        let devices = DeviceStore::open(state_dir).map_err(|_| AuthError::Storage)?;
        let metadata = MetadataStore::open(
            state_dir,
            MetadataProfile {
                service_id: identity.service_id.clone(),
                environment: identity.environment.clone(),
                network_name: config.name.clone(),
            },
        )
        .map_err(|_| AuthError::Configuration)?;
        let peers = PeerStore::open(
            state_dir,
            PeerProfile {
                issuer: identity.issuer.clone(),
                service_id: identity.service_id.clone(),
                environment: identity.environment.clone(),
                network_id: network_id.into(),
            },
        )
        .map_err(|_| AuthError::Configuration)?;
        let mut nonce = [0u8; 32];
        rand::rngs::OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| AuthError::Configuration)?;
        Ok(Self {
            auth,
            devices: Arc::new(devices),
            metadata: Arc::new(metadata),
            peers: Arc::new(peers),
            admission,
            in_flight: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            issuer: identity.issuer.clone(),
            network_id: network_id.into(),
            service_id: identity.service_id.clone(),
            environment: identity.environment.clone(),
            network_name: config.name.clone(),
            boot_nonce: URL_SAFE_NO_PAD.encode(nonce),
            #[cfg(test)]
            test_body_read_timeout: None,
            _keys: Arc::new(keys),
        })
    }

    fn body_read_timeout(&self) -> std::time::Duration {
        #[cfg(test)]
        if let Some(timeout) = self.test_body_read_timeout {
            return timeout;
        }
        BODY_READ_TIMEOUT
    }

    pub(crate) fn public_network_name(&self) -> &str {
        &self.network_name
    }

    pub fn router(&self) -> Router<()> {
        Router::new()
            .route("/api/agent-network/device/registration", post(dispatch))
            .route("/v1/me/network", get(dispatch))
            .route("/v1/devices", get(dispatch))
            .route("/v1/devices/{device}/agents", get(dispatch))
            .route(
                "/v1/networks/{network}/devices/{device}/join",
                post(dispatch),
            )
            .route(
                "/v1/networks/{network}/devices/{device}/leave",
                post(dispatch),
            )
            .route(
                "/v1/networks/{network}/devices/{device}/name",
                get(dispatch).patch(dispatch),
            )
            .route("/v1/mutations/{mutation}", get(dispatch))
            .fallback(unknown_route)
            .method_not_allowed_fallback(method_not_allowed)
            .layer(middleware::from_fn(no_store))
            .with_state(Arc::new(self.clone()))
    }

    fn admit(
        &self,
        headers: &HeaderMap,
        method: &Method,
        uri: &axum::http::Uri,
    ) -> Result<ValidatedAccess, HttpError> {
        // The operator's pinned origin and the actual origin-form URI are the
        // only URL authority. Host and forwarded headers never participate.
        if uri.scheme().is_some() || uri.authority().is_some() || !uri.path().starts_with('/') {
            return Err(HttpError::bad());
        }
        let access = single_header(headers, header::AUTHORIZATION.as_str())?
            .strip_prefix("Bearer ")
            .filter(|v| !v.is_empty())
            .ok_or_else(HttpError::unauthorized)?;
        let access = Zeroizing::new(access.to_owned());
        let proof = match single_header(headers, "dpop") {
            Ok(proof) => Zeroizing::new(proof.to_owned()),
            Err(_) if !headers.contains_key("dpop") => {
                return Err(HttpError::nonce(&self.boot_nonce));
            }
            Err(_) => return Err(HttpError::unauthorized()),
        };
        let url = format!(
            "{}{}",
            self.issuer,
            uri.path_and_query().map_or(uri.path(), |v| v.as_str())
        );
        self.admission
            .validate(
                &access,
                &proof,
                method.as_str(),
                &url,
                Some(&self.boot_nonce),
            )
            .map_err(|error| match error {
                AdmissionError::Rejected if nonce_needs_refresh(&proof, &self.boot_nonce) => {
                    HttpError::nonce(&self.boot_nonce)
                }
                AdmissionError::Rejected => {
                    HttpError::fixed(StatusCode::UNAUTHORIZED, "NETWORK_PROOF_REJECTED")
                }
                AdmissionError::Replay => {
                    HttpError::fixed(StatusCode::UNAUTHORIZED, "NETWORK_PROOF_REPLAY")
                }
                AdmissionError::Capacity => {
                    HttpError::fixed(StatusCode::SERVICE_UNAVAILABLE, "NETWORK_PROOF_CAPACITY")
                }
                AdmissionError::Unavailable | AdmissionError::Configuration => {
                    HttpError::unavailable()
                }
            })
    }

    pub(super) fn admit_response(
        &self,
        headers: &HeaderMap,
        method: &Method,
        uri: &axum::http::Uri,
    ) -> Result<ValidatedAccess, Box<Response>> {
        self.admit(headers, method, uri)
            .map_err(|error| Box::new(error.into_response()))
    }

    fn execute(
        &self,
        access: &ValidatedAccess,
        method: &Method,
        uri: &axum::http::Uri,
        body: &[u8],
    ) -> Result<Value, HttpError> {
        self.auth
            .with_valid_session_handle(access.session_handle(), |session| {
                if session.account.principal_id != access.principal_id()
                    || session.account.network_id != self.network_id
                    || access.issuer_network_id() != self.network_id
                    || access.issuer_origin() != self.issuer
                    || access.service_id() != self.service_id
                    || access.environment() != self.environment
                    || session.device_id != access.device_id()
                    || session.session_handle != access.session_handle()
                {
                    return Err(HttpError::unauthorized());
                }
                let context = SessionContext {
                    principal_id: session.account.principal_id,
                    network_id: session.account.network_id,
                    device_id: session.device_id,
                    session_handle: session.session_handle,
                    expires_at: session.expires_at.min(access.expires_at()),
                };
                let device = self
                    .devices
                    .read_state(&context, &context.device_id)
                    .map_err(HttpError::device)?
                    .ok_or_else(HttpError::unauthorized)?;
                if device.key_generation != access.key_generation()
                    || device.key_fingerprint != access.public_key_fingerprint()
                {
                    return Err(HttpError::unauthorized());
                }
                self.operation(&context, &device, method, uri, body)
            })
    }

    fn operation(
        &self,
        context: &SessionContext,
        device: &DeviceRecord,
        method: &Method,
        uri: &axum::http::Uri,
        body: &[u8],
    ) -> Result<Value, HttpError> {
        let path: Vec<_> = uri.path().split('/').filter(|p| !p.is_empty()).collect();
        match (method.as_str(), path.as_slice()) {
            ("POST", ["api", "agent-network", "device", "registration"]) => {
                no_query(uri)?;
                let info: Registration = decode(body)?;
                self.metadata
                    .register_device(
                        context,
                        device,
                        &DeviceInfo {
                            name: info.device_name,
                            platform: info.platform,
                            os_version: info.os_version,
                            app_version: info.app_version,
                        },
                    )
                    .map_err(HttpError::metadata)?;
                Ok(json!({"registered":true,"deviceId":context.device_id}))
            }
            ("GET", ["v1", "me", "network"]) => {
                no_query(uri)?;
                empty_body(body)?;
                self.metadata
                    .get_network(context)
                    .map_err(HttpError::metadata)
            }
            ("GET", ["v1", "devices"]) => {
                empty_body(body)?;
                let page = PageQuery::parse(uri.query())?;
                self.metadata
                    .list_devices(context, page.cursor.as_deref(), page.limit)
                    .map_err(HttpError::metadata)
            }
            ("GET", ["v1", "devices", target, "agents"]) => {
                empty_body(body)?;
                let page = PageQuery::parse(uri.query())?;
                self.metadata
                    .list_agents(context, target, page.cursor.as_deref(), page.limit)
                    .map_err(HttpError::metadata)
            }
            ("POST", ["v1", "networks", network, "devices", target, action])
                if matches!(*action, "join" | "leave") =>
            {
                no_query(uri)?;
                scope_path(context, network)?;
                let change: Membership = decode(body)?;
                self.metadata
                    .mutate_membership(
                        context,
                        target,
                        *action == "join",
                        change.expected_membership_revision,
                        &change.mutation_id,
                    )
                    .map_err(HttpError::metadata)
            }
            ("GET", ["v1", "networks", network, "devices", target, "name"]) => {
                no_query(uri)?;
                empty_body(body)?;
                scope_path(context, network)?;
                self.metadata
                    .get_device_name(context, target)
                    .map_err(HttpError::metadata)
            }
            ("PATCH", ["v1", "networks", network, "devices", target, "name"]) => {
                no_query(uri)?;
                scope_path(context, network)?;
                let change: Rename = decode(body)?;
                self.metadata
                    .rename_device(
                        context,
                        target,
                        &change.name,
                        &change.expected_name,
                        &change.mutation_id,
                    )
                    .map_err(HttpError::metadata)
            }
            ("GET", ["v1", "mutations", mutation]) => {
                no_query(uri)?;
                empty_body(body)?;
                self.metadata
                    .get_receipt(context, mutation)
                    .map_err(HttpError::metadata)
            }
            _ => Err(HttpError::fixed(
                StatusCode::NOT_FOUND,
                "NETWORK_ROUTE_NOT_FOUND",
            )),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registration {
    device_name: String,
    platform: String,
    os_version: String,
    app_version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Membership {
    mutation_id: String,
    expected_membership_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rename {
    name: String,
    expected_name: String,
    mutation_id: String,
}

struct PageQuery {
    cursor: Option<String>,
    limit: usize,
}
impl PageQuery {
    fn parse(query: Option<&str>) -> Result<Self, HttpError> {
        let mut cursor = None;
        let mut limit = None;
        for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
            match key.as_ref() {
                "cursor" if cursor.is_none() => {
                    if !canonical_uuid(&value) {
                        return Err(HttpError::bad());
                    }
                    cursor = Some(value.into_owned());
                }
                "limit" if limit.is_none() => {
                    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(HttpError::bad());
                    }
                    let parsed: usize = value.parse().map_err(|_| HttpError::bad())?;
                    if !(1..=200).contains(&parsed) {
                        return Err(HttpError::bad());
                    }
                    limit = Some(parsed);
                }
                _ => return Err(HttpError::bad()),
            }
        }
        Ok(Self {
            cursor,
            limit: limit.unwrap_or(50),
        })
    }
}
// This untrusted hint controls only a public predispatch challenge, never
// authentication. Actual signature/closed claims/nonce verification remains
// admission-core's responsibility. Malformed proofs do not trigger retry.
fn nonce_needs_refresh(proof: &str, expected: &str) -> bool {
    #[derive(Deserialize)]
    struct NonceHint {
        nonce: Option<String>,
    }
    let parts: Vec<_> = proof.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let Ok(payload) = URL_SAFE_NO_PAD.decode(parts[1]) else {
        return false;
    };
    let Ok(hint) = serde_json::from_slice::<NonceHint>(&payload) else {
        return false;
    };
    hint.nonce.as_deref() != Some(expected)
}
fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|v| v.to_string() == value)
}
fn scope_path(context: &SessionContext, network: &str) -> Result<(), HttpError> {
    if network != context.network_id {
        return Err(HttpError::fixed(StatusCode::NOT_FOUND, "NETWORK_NOT_FOUND"));
    }
    Ok(())
}
fn decode<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, HttpError> {
    serde_json::from_slice(body).map_err(|_| HttpError::bad())
}
fn no_query(uri: &axum::http::Uri) -> Result<(), HttpError> {
    if uri.query().is_some() {
        return Err(HttpError::bad());
    }
    Ok(())
}
fn empty_body(body: &[u8]) -> Result<(), HttpError> {
    if !body.is_empty() {
        return Err(HttpError::bad());
    }
    Ok(())
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, HttpError> {
    let mut values = headers.get_all(name).iter();
    let first = values
        .next()
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= MAX_HEADER)
        .ok_or_else(HttpError::unauthorized)?;
    if values.next().is_some() {
        return Err(HttpError::unauthorized());
    }
    Ok(first)
}
async fn dispatch(
    State(service): State<Arc<NetworkService>>,
    request: Request,
) -> Result<Json<Value>, HttpError> {
    // One shared admission bound includes slow bodies and blocking executions.
    // No waiting queue is created when all permits are already owned.
    let permit = service.in_flight.clone().try_acquire_owned().map_err(|_| {
        HttpError::fixed(StatusCode::SERVICE_UNAVAILABLE, "NETWORK_REQUEST_CAPACITY")
    })?;
    let (parts, body) = request.into_parts();
    let access = service.admit(&parts.headers, &parts.method, &parts.uri)?;
    // Admission consumes the proof, but no live-store operation starts until
    // the entire bounded body arrives within this wall-clock deadline. A
    // timeout has no nonce and must never trigger transport mutation retry.
    let bytes = tokio::time::timeout(service.body_read_timeout(), to_bytes(body, MAX_BODY))
        .await
        .map_err(|_| HttpError::fixed(StatusCode::REQUEST_TIMEOUT, "NETWORK_BODY_TIMEOUT"))?
        .map_err(|_| HttpError::fixed(StatusCode::PAYLOAD_TOO_LARGE, "NETWORK_BODY_TOO_LARGE"))?;
    // Keep the complete authoritative gate on a blocking worker. Never hold a
    // store lock across await, split the live gate, or time out an execution
    // which may already have committed. Cancellation leaves this task and its
    // owned permit alive until it completes; mutation receipts remain authority.
    let data = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        service.execute(&access, &parts.method, &parts.uri, &bytes)
    })
    .await
    .map_err(|_| HttpError::unavailable())??;
    Ok(Json(json!({"ok":true,"data":data})))
}
async fn unknown_route() -> HttpError {
    HttpError::fixed(StatusCode::NOT_FOUND, "NETWORK_ROUTE_NOT_FOUND")
}
async fn method_not_allowed() -> HttpError {
    HttpError::fixed(StatusCode::METHOD_NOT_ALLOWED, "NETWORK_METHOD_NOT_ALLOWED")
}
async fn no_store(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
struct HttpError {
    status: StatusCode,
    code: &'static str,
    nonce: Option<String>,
}
impl HttpError {
    fn fixed(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            nonce: None,
        }
    }
    fn bad() -> Self {
        Self::fixed(StatusCode::BAD_REQUEST, "NETWORK_REQUEST_INVALID")
    }
    fn unauthorized() -> Self {
        Self::fixed(StatusCode::UNAUTHORIZED, "UNAUTHORIZED")
    }
    fn unavailable() -> Self {
        Self::fixed(StatusCode::SERVICE_UNAVAILABLE, "NETWORK_UNAVAILABLE")
    }
    fn nonce(nonce: &str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "NETWORK_NONCE_REQUIRED",
            nonce: Some(nonce.into()),
        }
    }
    fn device(error: DeviceError) -> Self {
        match error {
            DeviceError::Storage | DeviceError::UnsafePath => Self::unavailable(),
            _ => Self::unauthorized(),
        }
    }
    fn metadata(error: MetadataError) -> Self {
        use MetadataError::*;
        match error {
            InvalidSession => Self::unauthorized(),
            InvalidInput => Self::bad(),
            UnsafePath | Storage | ProfileMismatch | UnboundDatabase => Self::unavailable(),
            DeviceOwnerMismatch => Self::fixed(StatusCode::NOT_FOUND, "DEVICE_NOT_FOUND"),
            DeviceNotRegistered => Self::fixed(StatusCode::CONFLICT, "DEVICE_NOT_REGISTERED"),
            IdentityConflict => Self::fixed(StatusCode::CONFLICT, "KEY_GENERATION_CONFLICT"),
            MembershipConflict => Self::fixed(StatusCode::CONFLICT, "MEMBERSHIP_REVISION_CONFLICT"),
            NameConflict => Self::fixed(StatusCode::CONFLICT, "DEVICE_NAME_CONFLICT"),
            CatalogConflict => Self::fixed(StatusCode::CONFLICT, "CATALOG_CONFLICT"),
            CatalogStale => Self::fixed(StatusCode::CONFLICT, "CATALOG_STALE"),
            ReceiptConflict => Self::fixed(StatusCode::CONFLICT, "MUTATION_CONFLICT"),
            ReceiptNotFound => Self::fixed(StatusCode::NOT_FOUND, "MUTATION_NOT_FOUND"),
            ReceiptExpired => Self::fixed(StatusCode::GONE, "MUTATION_EXPIRED"),
            ReceiptCapacity | SnapshotCapacity => {
                Self::fixed(StatusCode::SERVICE_UNAVAILABLE, "NETWORK_CAPACITY")
            }
            InvalidCursor => Self::fixed(StatusCode::BAD_REQUEST, "DIRECTORY_CURSOR_INVALID"),
            Unsupported => {
                Self::fixed(StatusCode::NOT_IMPLEMENTED, "NETWORK_OPERATION_UNSUPPORTED")
            }
        }
    }
}
impl From<AuthError> for HttpError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::SessionRejected => Self::unauthorized(),
            _ => Self::unavailable(),
        }
    }
}
impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(json!({"ok":false,"error":{"code":self.code,"retryable":false},"requestId":Uuid::new_v4().to_string()}))).into_response();
        if let Some(nonce) = self.nonce
            && let Ok(value) = HeaderValue::from_str(&nonce)
        {
            response.headers_mut().insert("dpop-nonce", value);
        }
        response
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{AuthConfig, OidcVerifier, VerifiedSubject};
    use axum::{body::to_bytes, http::Request};
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use myagents_agent_network_crypto::DevicePrivateKey;
    use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts};
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
    use tempfile::TempDir;
    use tower::ServiceExt;

    struct OidcFixture {
        key: RsaPrivateKey,
        jwks: Value,
    }
    impl OidcFixture {
        fn new() -> Self {
            let key = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 2048).unwrap();
            let jwks = json!({"keys":[{"kty":"RSA","n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
                "e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),"kid":"fixture","alg":"RS256","use":"sig"}]});
            Self { key, jwks }
        }
        fn subject(&self, subject: &str) -> VerifiedSubject {
            let nonce = Uuid::new_v4().to_string();
            let now = jsonwebtoken::get_current_timestamp();
            let mut header = Header::new(Algorithm::RS256);
            header.kid = Some("fixture".into());
            let claims = json!({"iss":"https://dex.example.test","sub":subject,"aud":"agentnet-desktop",
                "iat":now,"exp":now+600,"nonce":nonce});
            let der = self.key.to_pkcs1_der().unwrap();
            let token = Zeroizing::new(
                encode(&header, &claims, &EncodingKey::from_rsa_der(der.as_bytes())).unwrap(),
            );
            OidcVerifier::new(
                "https://dex.example.test",
                "agentnet-desktop",
                self.jwks.clone(),
            )
            .unwrap()
            .verify_id_token(&token, &nonce)
            .unwrap()
        }
    }
    pub(crate) struct Device {
        pub(crate) key: DevicePrivateKey,
        pub(crate) account_token: Zeroizing<String>,
        pub(crate) access: Zeroizing<String>,
        pub(crate) context: SessionContext,
    }
    pub(crate) struct Fixture {
        pub(crate) dir: TempDir,
        oidc: OidcFixture,
        pub(crate) auth: Arc<AuthStore>,
        pub(crate) config: IdentityHttpConfig,
        pub(crate) network: String,
        pub(crate) service: NetworkService,
    }
    impl Fixture {
        pub(crate) fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let network = Uuid::new_v4().to_string();
            let auth = Arc::new(
                AuthStore::open(
                    dir.path(),
                    &AuthConfig {
                        network_id: network.clone(),
                        login_ttl: Duration::from_secs(300),
                        session_ttl: Duration::from_secs(3600),
                    },
                )
                .unwrap(),
            );
            let config = IdentityHttpConfig {
                issuer: "https://agentnet.example.test".into(),
                service_id: Uuid::new_v4().to_string(),
                environment: "development".into(),
                key_file: dir.path().join("identity-keys.json"),
            };
            ServiceKeys::generate_initial(&config.key_file).unwrap();
            let service = NetworkService::open(
                auth.clone(),
                dir.path(),
                &config,
                &network,
                &NetworkHttpConfig {
                    name: "Isolated network".into(),
                },
            )
            .unwrap();
            Self {
                dir,
                oidc: OidcFixture::new(),
                auth,
                config,
                network,
                service,
            }
        }
        pub(crate) fn verified_subject(&self, label: &str) -> crate::VerifiedSubject {
            self.oidc.subject(label)
        }
        pub(crate) fn device(&self, subject: &str) -> Device {
            let id = Uuid::new_v4().to_string();
            let account_token = Zeroizing::new(
                self.auth
                    .issue_session(&self.oidc.subject(subject), &id)
                    .unwrap()
                    .into_token()
                    .to_string(),
            );
            let session = self.auth.validate_session(&account_token).unwrap();
            let context = SessionContext {
                principal_id: session.account.principal_id,
                network_id: session.account.network_id,
                device_id: id,
                session_handle: session.session_handle,
                expires_at: session.expires_at,
            };
            let key = DevicePrivateKey::generate().unwrap();
            let record = self
                .service
                .devices
                .claim_initial(&context, &key.csr().unwrap())
                .unwrap();
            let issued = self
                .service
                ._keys
                .issue(
                    &myagents_agentnet_identity_core::IssuerProfile {
                        issuer: self.config.issuer.clone(),
                        service_id: self.config.service_id.clone(),
                        environment: self.config.environment.clone(),
                        network_id: self.network.clone(),
                    },
                    &myagents_agentnet_identity_core::IdentityRequest {
                        principal_id: context.principal_id.clone(),
                        device_id: context.device_id.clone(),
                        key_generation: record.key_generation,
                        identity_binding_id: record.identity_binding_id.clone(),
                        session_handle: context.session_handle.clone(),
                        csr_pem: record.csr_pem.clone(),
                    },
                )
                .unwrap();
            self.service
                .peers
                .record_issued(&context, &record, &self.service._keys, &issued)
                .unwrap();
            Device {
                key,
                account_token,
                access: Zeroizing::new(issued.access_token),
                context,
            }
        }
        pub(crate) fn proof(
            &self,
            device: &Device,
            method: &str,
            uri: &str,
            nonce: Option<&str>,
        ) -> String {
            device
                .key
                .dpop(
                    method,
                    &url::Url::parse(&format!("{}{}", self.config.issuer, uri)).unwrap(),
                    &device.access,
                    nonce,
                )
                .unwrap()
        }
        pub(crate) async fn send(
            &self,
            service: &NetworkService,
            device: &Device,
            method: &str,
            uri: &str,
            body: &str,
            proof: &str,
        ) -> (StatusCode, Value, HeaderMap) {
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", device.access.as_str()),
                )
                .header("DPoP", proof)
                .header(header::CONTENT_TYPE, "application/json")
                // An untrusted external host must not affect htu verification.
                .header(header::HOST, "attacker.invalid")
                .header("x-forwarded-host", "attacker.invalid")
                .body(Body::from(body.to_owned()))
                .unwrap();
            let response = service.router().oneshot(request).await.unwrap();
            let status = response.status();
            let headers = response.headers().clone();
            assert_eq!(headers[header::CACHE_CONTROL], "no-store");
            assert!(!headers.contains_key("access-control-allow-origin"));
            let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
            let data: Value = serde_json::from_slice(&bytes).unwrap();
            if !status.is_success() {
                assert_eq!(data.as_object().unwrap().len(), 3);
                assert_eq!(data["ok"], false);
                assert_eq!(data["error"]["retryable"], false);
                assert_eq!(data["error"].as_object().unwrap().len(), 2);
                assert!(canonical_uuid(data["requestId"].as_str().unwrap()));
            }
            (status, data, headers)
        }
        pub(crate) async fn request(
            &self,
            device: &Device,
            method: &str,
            uri: &str,
            body: &str,
        ) -> (StatusCode, Value, HeaderMap) {
            let proof = self.proof(device, method, uri, Some(&self.service.boot_nonce));
            self.send(&self.service, device, method, uri, body, &proof)
                .await
        }
        pub(crate) async fn register(&self, device: &Device) {
            let (status, data, _) = self
                .request(
                    device,
                    "POST",
                    "/api/agent-network/device/registration",
                    registration(),
                )
                .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(
                data["data"],
                json!({"registered":true,"deviceId":device.context.device_id})
            );
        }
    }
    fn registration() -> &'static str {
        r#"{"deviceName":"Linux QA","platform":"linux","osVersion":"test","appVersion":"test"}"#
    }

    #[tokio::test]
    async fn nonce_precedes_registration_replay_never_dispatches_and_host_is_ignored() {
        let f = Fixture::new();
        let d = f.device("owner");
        let uri = "/api/agent-network/device/registration";
        let proof = f.proof(&d, "POST", uri, None);
        let (status, _, headers) = f
            .send(&f.service, &d, "POST", uri, registration(), &proof)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers["dpop-nonce"], f.service.boot_nonce);
        assert_eq!(
            f.service.metadata.get_network(&d.context).unwrap_err(),
            MetadataError::DeviceNotRegistered
        );
        let proof = f.proof(&d, "POST", uri, Some(&f.service.boot_nonce));
        assert_eq!(
            f.send(&f.service, &d, "POST", uri, registration(), &proof)
                .await
                .0,
            StatusCode::OK
        );
        let (status, data, headers) = f
            .send(&f.service, &d, "POST", uri, registration(), &proof)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(data["error"]["code"], "NETWORK_PROOF_REPLAY");
        assert!(!headers.contains_key("dpop-nonce"));
        let wrong = DevicePrivateKey::generate()
            .unwrap()
            .dpop(
                "POST",
                &url::Url::parse(&format!("{}{}", f.config.issuer, uri)).unwrap(),
                &d.access,
                Some(&f.service.boot_nonce),
            )
            .unwrap();
        let (status, _, headers) = f
            .send(&f.service, &d, "POST", uri, registration(), &wrong)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers.contains_key("dpop-nonce"));
    }

    #[tokio::test]
    async fn directory_is_closed_paged_scoped_and_reconnect_preserves_name() {
        let f = Fixture::new();
        let a = f.device("owner");
        let b = f.device("owner");
        let c = f.device("owner");
        f.register(&a).await;
        f.register(&b).await;
        f.register(&c).await;
        let (status, network, _) = f.request(&a, "GET", "/v1/me/network", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(network["data"]["networkId"], f.network);
        assert_eq!(network["data"]["capabilities"], json!([]));
        let first = f.request(&a, "GET", "/v1/devices?limit=2", "").await.1["data"].clone();
        assert_eq!(first["items"].as_array().unwrap().len(), 2);
        assert_eq!(first["complete"], false);
        let cursor = first["nextCursor"].as_str().unwrap();
        let second = f
            .request(
                &a,
                "GET",
                &format!("/v1/devices?cursor={cursor}&limit=2"),
                "",
            )
            .await
            .1["data"]
            .clone();
        assert_eq!(second["complete"], true);
        assert_eq!(second["items"].as_array().unwrap().len(), 1);
        let default = f.request(&a, "GET", "/v1/devices", "").await.1;
        assert_eq!(default["data"]["complete"], true);
        for query in [
            "limit=1&limit=2",
            "limit=201",
            "limit=0",
            "unknown=1",
            "cursor=bad",
            "limit=%FF",
        ] {
            assert_eq!(
                f.request(&a, "GET", &format!("/v1/devices?{query}"), "")
                    .await
                    .0,
                StatusCode::BAD_REQUEST
            );
        }
        let foreign = f.device("foreign");
        f.register(&foreign).await;
        assert_eq!(
            f.request(&foreign, "GET", "/v1/devices", "").await.1["data"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            f.request(
                &foreign,
                "GET",
                &format!("/v1/devices?cursor={cursor}&limit=2"),
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        // Absent catalog/relay evidence is an error, never a successful empty Agents list.
        assert_eq!(
            f.request(
                &a,
                "GET",
                &format!("/v1/devices/{}/agents", a.context.device_id),
                ""
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let uri = format!(
            "/v1/networks/{}/devices/{}/name",
            f.network, a.context.device_id
        );
        let stale = json!({"name":"Renamed","expectedName":"Wrong","mutationId":Uuid::new_v4().to_string()}).to_string();
        let (status, error, headers) = f.request(&b, "PATCH", &uri, &stale).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], "DEVICE_NAME_CONFLICT");
        assert!(!headers.contains_key("dpop-nonce"));
        assert_eq!(
            f.request(&foreign, "GET", &uri, "").await.0,
            StatusCode::NOT_FOUND
        );
        let body = json!({"name":"Renamed","expectedName":"Linux QA","mutationId":Uuid::new_v4().to_string()}).to_string();
        assert_eq!(f.request(&b, "PATCH", &uri, &body).await.0, StatusCode::OK);
        f.register(&a).await;
        assert_eq!(
            f.request(&a, "GET", &uri, "").await.1["data"]["name"],
            "Renamed"
        );
    }

    #[tokio::test]
    async fn mutation_cas_receipt_cross_owner_network_and_duplicate_json_are_enforced() {
        let f = Fixture::new();
        let a = f.device("owner");
        let foreign = f.device("foreign");
        f.register(&a).await;
        f.register(&foreign).await;
        let uri = format!(
            "/v1/networks/{}/devices/{}/join",
            f.network, a.context.device_id
        );
        let id = Uuid::new_v4().to_string();
        let body = json!({"mutationId":id,"expectedMembershipRevision":0}).to_string();
        let (status, reply, _) = f.request(&a, "POST", &uri, &body).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["data"]["membershipRevision"], 1);
        assert_eq!(f.request(&a, "POST", &uri, &body).await.1, reply);
        assert_eq!(
            f.request(&a, "GET", &format!("/v1/mutations/{id}"), "")
                .await
                .1,
            reply
        );
        let changed = json!({"mutationId":id,"expectedMembershipRevision":1}).to_string();
        assert_eq!(
            f.request(&a, "POST", &uri, &changed).await.1["error"]["code"],
            "MUTATION_CONFLICT"
        );
        let stale = json!({"mutationId":Uuid::new_v4().to_string(),"expectedMembershipRevision":0})
            .to_string();
        assert_eq!(
            f.request(&a, "POST", &uri, &stale).await.1["error"]["code"],
            "MEMBERSHIP_REVISION_CONFLICT"
        );
        assert_eq!(
            f.request(&foreign, "POST", &uri, &stale).await.0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            f.request(&foreign, "GET", &format!("/v1/mutations/{id}"), "")
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        let wrong_network = uri.replace(&f.network, &Uuid::new_v4().to_string());
        assert_eq!(
            f.request(&a, "POST", &wrong_network, &body).await.0,
            StatusCode::NOT_FOUND
        );
        for bad in [
            format!(
                r#"{{"mutationId":"{id}","expectedMembershipRevision":1,"expectedMembershipRevision":1}}"#
            ),
            format!(
                r#"{{"mutationId":"{id}","expectedMembershipRevision":1,"deviceId":"{}"}}"#,
                a.context.device_id
            ),
        ] {
            assert_eq!(
                f.request(&a, "POST", &uri, &bad).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let duplicate = registration().replace(
            "\"platform\":\"linux\"",
            "\"platform\":\"linux\",\"platform\":\"linux\"",
        );
        assert_eq!(
            f.request(
                &a,
                "POST",
                "/api/agent-network/device/registration",
                &duplicate
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let large = "x".repeat(MAX_BODY + 1);
        let (status, _, headers) = f.request(&a, "POST", &uri, &large).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(!headers.contains_key("dpop-nonce"));
        assert_eq!(
            f.request(&a, "GET", "/v1/callable", "").await.0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn revoked_session_and_restart_nonce_cannot_dispatch_or_trigger_business_retry() {
        let f = Fixture::new();
        let a = f.device("owner");
        f.register(&a).await;
        let proof = f.proof(&a, "GET", "/v1/me/network", Some(&f.service.boot_nonce));
        let reopened = NetworkService::open(
            f.auth.clone(),
            f.dir.path(),
            &f.config,
            &f.network,
            &NetworkHttpConfig {
                name: "Isolated network".into(),
            },
        )
        .unwrap();
        assert_ne!(reopened.boot_nonce, f.service.boot_nonce);
        let (status, _, headers) = f
            .send(&reopened, &a, "GET", "/v1/me/network", "", &proof)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(headers["dpop-nonce"], reopened.boot_nonce);
        let fresh = f.proof(&a, "GET", "/v1/me/network", Some(&reopened.boot_nonce));
        assert_eq!(
            f.send(&reopened, &a, "GET", "/v1/me/network", "", &fresh)
                .await
                .0,
            StatusCode::OK
        );
        f.auth.revoke_session(&a.account_token).unwrap();
        let fresh = f.proof(&a, "GET", "/v1/me/network", Some(&reopened.boot_nonce));
        let (status, _, headers) = f
            .send(&reopened, &a, "GET", "/v1/me/network", "", &fresh)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers.contains_key("dpop-nonce"));
        // Even registration cannot reconstitute scope after authoritative logout.
        let fresh = f.proof(
            &a,
            "POST",
            "/api/agent-network/device/registration",
            Some(&reopened.boot_nonce),
        );
        assert_eq!(
            f.send(
                &reopened,
                &a,
                "POST",
                "/api/agent-network/device/registration",
                registration(),
                &fresh
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn signed_access_is_still_bound_to_live_session_device_and_current_spki() {
        let f = Fixture::new();
        let mut a = f.device("owner");
        let b = f.device("owner");
        f.register(&a).await;
        let original = Zeroizing::new(a.access.to_string());
        let sign = |handle: &str, csr: String| {
            let record = f
                .service
                .devices
                .read_state(&a.context, &a.context.device_id)
                .unwrap()
                .unwrap();
            Zeroizing::new(
                f.service
                    ._keys
                    .issue(
                        &myagents_agentnet_identity_core::IssuerProfile {
                            issuer: f.config.issuer.clone(),
                            service_id: f.config.service_id.clone(),
                            environment: f.config.environment.clone(),
                            network_id: f.network.clone(),
                        },
                        &myagents_agentnet_identity_core::IdentityRequest {
                            principal_id: a.context.principal_id.clone(),
                            device_id: a.context.device_id.clone(),
                            key_generation: 1,
                            identity_binding_id: record.identity_binding_id,
                            session_handle: handle.to_owned(),
                            csr_pem: csr,
                        },
                    )
                    .unwrap()
                    .access_token,
            )
        };
        // Valid issuer signature and valid DPoP are insufficient when the
        // authenticated session handle belongs to another device.
        let other_handle = sign(&b.context.session_handle, a.key.csr().unwrap());
        let wrong_key = DevicePrivateKey::generate().unwrap();
        let wrong_spki = sign(&a.context.session_handle, wrong_key.csr().unwrap());
        a.access = other_handle;
        let (status, _, headers) = f.request(&a, "GET", "/v1/me/network", "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers.contains_key("dpop-nonce"));
        a.access = wrong_spki;
        let proof = wrong_key
            .dpop(
                "GET",
                &url::Url::parse(&format!("{}/v1/me/network", f.config.issuer)).unwrap(),
                &a.access,
                Some(&f.service.boot_nonce),
            )
            .unwrap();
        let (status, _, headers) = f
            .send(&f.service, &a, "GET", "/v1/me/network", "", &proof)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers.contains_key("dpop-nonce"));
        a.access = original;
        f.auth.expire_session_for_test(&a.account_token).unwrap();
        let (status, _, headers) = f.request(&a, "GET", "/v1/me/network", "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers.contains_key("dpop-nonce"));
    }
    #[tokio::test]
    async fn network_fallback_merges_with_real_identity_routes_without_shadowing_them() {
        let f = Fixture::new();
        let identity = crate::identity_http::IdentityService::open(
            f.auth.clone(),
            f.dir.path(),
            &f.config,
            &f.network,
        )
        .unwrap();
        let router = identity.router().merge(f.service.router());
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-network/jwks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
        let jwks: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(jwks, f.service._keys.jwks());
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/v1/unsupported")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
        let error: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error["error"]["code"], "NETWORK_ROUTE_NOT_FOUND");
    }
    #[tokio::test]
    async fn pending_body_has_finite_deadline_is_cancelled_and_never_registers_device() {
        use axum::body::{Bytes, HttpBody};
        use std::{
            convert::Infallible,
            pin::Pin,
            sync::atomic::{AtomicBool, AtomicUsize, Ordering},
            task::{Context, Poll},
            time::Instant,
        };
        struct PendingBody {
            polled: Arc<AtomicUsize>,
            dropped: Arc<AtomicBool>,
        }
        impl HttpBody for PendingBody {
            type Data = Bytes;
            type Error = Infallible;
            fn poll_frame(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
                self.polled.fetch_add(1, Ordering::SeqCst);
                Poll::Pending
            }
        }
        impl Drop for PendingBody {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }
        let f = Fixture::new();
        let device = f.device("owner");
        assert_eq!(BODY_READ_TIMEOUT, Duration::from_secs(10));
        assert_eq!(f.service.body_read_timeout(), BODY_READ_TIMEOUT);
        let mut service = f.service.clone();
        let deadline = Duration::from_millis(30);
        service.test_body_read_timeout = Some(deadline);
        let uri = "/api/agent-network/device/registration";
        let proof = f.proof(&device, "POST", uri, Some(&service.boot_nonce));
        let polled = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", device.access.as_str()),
            )
            .header("dpop", &proof)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::new(PendingBody {
                polled: polled.clone(),
                dropped: dropped.clone(),
            }))
            .unwrap();
        let start = Instant::now();
        let response =
            tokio::time::timeout(Duration::from_secs(2), service.router().oneshot(request))
                .await
                .expect("pending body must be bounded by the route deadline")
                .unwrap();
        assert!(start.elapsed() >= deadline);
        assert!(polled.load(Ordering::SeqCst) > 0);
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key("dpop-nonce"));
        let bytes = to_bytes(response.into_body(), MAX_BODY).await.unwrap();
        let error: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error["ok"], false);
        assert_eq!(
            error["error"],
            json!({"code":"NETWORK_BODY_TIMEOUT","retryable":false})
        );
        assert!(canonical_uuid(error["requestId"].as_str().unwrap()));
        assert_eq!(
            service.metadata.get_network(&device.context).unwrap_err(),
            MetadataError::DeviceNotRegistered
        );
        // The admitted proof was consumed: timeout cannot be followed by an
        // automatic resend with the same proof to materialize the registration.
        let (status, error, headers) = f
            .send(&service, &device, "POST", uri, registration(), &proof)
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(error["error"]["code"], "NETWORK_PROOF_REPLAY");
        assert!(!headers.contains_key("dpop-nonce"));
        assert_eq!(
            service.metadata.get_network(&device.context).unwrap_err(),
            MetadataError::DeviceNotRegistered
        );
    }
    #[tokio::test]
    async fn cloned_service_shares_capacity_rejects_before_admission_and_recovers_after_release() {
        let f = Fixture::new();
        let device = f.device("owner");
        let clone = f.service.clone();
        assert!(Arc::ptr_eq(&clone.in_flight, &f.service.in_flight));
        assert_eq!(MAX_IN_FLIGHT, 32);
        let mut held = Vec::new();
        for _ in 0..MAX_IN_FLIGHT {
            held.push(f.service.in_flight.clone().try_acquire_owned().unwrap());
        }
        assert_eq!(clone.in_flight.available_permits(), 0);
        let uri = "/api/agent-network/device/registration";
        let proof = f.proof(&device, "POST", uri, Some(&f.service.boot_nonce));
        let (status, error, headers) = tokio::time::timeout(
            Duration::from_secs(2),
            f.send(&clone, &device, "POST", uri, registration(), &proof),
        )
        .await
        .expect("capacity exhaustion must reject without queuing");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            error["error"],
            json!({"code":"NETWORK_REQUEST_CAPACITY","retryable":false})
        );
        assert!(!headers.contains_key("dpop-nonce"));
        assert_eq!(
            clone.metadata.get_network(&device.context).unwrap_err(),
            MetadataError::DeviceNotRegistered
        );
        // Capacity rejection precedes admission, so the original unused proof
        // remains usable after a slot is released. This is an explicit test
        // operation, not an automatic application retry.
        drop(held.pop());
        assert_eq!(f.service.in_flight.available_permits(), 1);
        let (status, data, _) = f
            .send(&clone, &device, "POST", uri, registration(), &proof)
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            data["data"],
            json!({"registered":true,"deviceId":device.context.device_id})
        );
        assert_eq!(f.service.in_flight.available_permits(), 1);
        drop(held);
        assert_eq!(clone.in_flight.available_permits(), MAX_IN_FLIGHT);
    }
}
