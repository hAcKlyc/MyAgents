use crate::{AuthConfig, AuthError, AuthStore, VerifiedSubject};
use axum::{
    Json, Router,
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse},
    routing::{delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointMaybeSet, EndpointNotSet,
    EndpointSet, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
};
use rand::random;
use reqwest::{Client, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_HTTP_BODY: usize = 8 * 1024;
const MAX_PROVIDER_BODY: usize = 256 * 1024;
const MAX_TRANSACTIONS: usize = 1024;
const COMPLETION_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sign-in complete</title><p>Sign-in complete. Return to the application.</p>";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceFileConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Zeroizing<String>,
    pub callback_url: String,
    pub network_id: String,
    pub state_dir: PathBuf,
    pub listen: SocketAddr,
    #[serde(default)]
    pub ca_bundle: Option<PathBuf>,
    #[serde(default = "default_session_ttl")]
    pub session_ttl_seconds: u64,
}
fn default_session_ttl() -> u64 {
    86_400
}

struct Pending {
    device_id: String,
    client_challenge: String,
    provider_verifier: Zeroizing<String>,
    state: Zeroizing<String>,
    nonce: Zeroizing<String>,
    expires_at: i64,
    phase: Phase,
}
type ServiceClient = CoreClient<
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointSet,
    EndpointMaybeSet,
>;
enum Phase {
    Pending,
    Exchanging,
    Ready(VerifiedSubject),
    Consuming,
}
struct Flow {
    pending: Mutex<HashMap<String, Pending>>,
    ttl: Duration,
}
struct App {
    client: ServiceClient,
    http: Client,
    origin: Url,
    store: AuthStore,
    flow: Flow,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "pkceChallenge")]
    pkce_challenge: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    transaction_id: String,
    expires_at: i64,
    authorization_url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PollRequest {
    #[serde(rename = "transactionId")]
    transaction_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "pkceVerifier")]
    pkce_verifier: Zeroizing<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    access_token: Zeroizing<String>,
    expires_at: i64,
    principal_id: String,
    network_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelRequest {
    #[serde(rename = "transactionId")]
    transaction_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "pkceVerifier")]
    pkce_verifier: Zeroizing<String>,
}
pub async fn serve_from_config(path: impl AsRef<Path>) -> Result<(), AuthError> {
    let config = read_config(path.as_ref())?;
    validate_config(&config)?;
    let builder = Client::builder()
        .redirect(Policy::none())
        .https_only(true)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15));
    let builder = if let Some(ca_path) = &config.ca_bundle {
        let bytes = read_root_ca(ca_path)?;
        builder.add_root_certificate(
            reqwest::Certificate::from_pem(&bytes).map_err(|_| AuthError::OidcConfiguration)?,
        )
    } else {
        builder
    };
    let http = builder.build().map_err(|_| AuthError::OidcConfiguration)?;
    let issuer = IssuerUrl::new(config.issuer.clone()).map_err(|_| AuthError::OidcConfiguration)?;
    let discovery_http = http.clone();
    let origin = Url::parse(&config.issuer).map_err(|_| AuthError::OidcConfiguration)?;
    let discovery_origin = origin.clone();
    let bounded =
        move |request| bounded_call(discovery_http.clone(), discovery_origin.clone(), request);
    let metadata = tokio::time::timeout(
        Duration::from_secs(20),
        CoreProviderMetadata::discover_async(issuer.clone(), &bounded),
    )
    .await
    .map_err(|_| AuthError::OidcConfiguration)?
    .map_err(|_| AuthError::OidcConfiguration)?;
    let token_endpoint_option = metadata.token_endpoint();
    let token_endpoint = token_endpoint_option
        .as_ref()
        .ok_or(AuthError::OidcConfiguration)?;
    if metadata.issuer() != &issuer
        || !same_origin(issuer.url(), metadata.authorization_endpoint().url())
        || !same_origin(issuer.url(), token_endpoint.url())
        || !same_origin(issuer.url(), metadata.jwks_uri().url())
        || metadata.jwks().keys().is_empty()
        || metadata.jwks().keys().len() > 32
        || metadata
            .userinfo_endpoint()
            .as_ref()
            .is_some_and(|endpoint| !same_origin(issuer.url(), endpoint.url()))
    {
        return Err(AuthError::OidcConfiguration);
    }
    let auth_endpoint = metadata.authorization_endpoint().clone();
    let token_endpoint = (*token_endpoint).clone();
    let client = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(config.client_id.clone()),
        Some(ClientSecret::new(config.client_secret.to_string())),
    )
    .set_auth_uri(auth_endpoint)
    .set_token_uri(token_endpoint)
    .set_redirect_uri(
        RedirectUrl::new(config.callback_url.clone()).map_err(|_| AuthError::OidcConfiguration)?,
    );
    let auth = AuthConfig {
        network_id: config.network_id,
        login_ttl: Duration::from_secs(300),
        session_ttl: Duration::from_secs(config.session_ttl_seconds),
    };
    let store = AuthStore::open(&config.state_dir, &auth)?;
    let app = Arc::new(App {
        client,
        http,
        origin,
        store,
        flow: Flow {
            pending: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(300),
        },
    });
    let router = Router::new()
        .route("/auth/login/start", post(start))
        .route("/auth/callback", get(callback))
        .route("/auth/login/poll", post(poll))
        .route("/auth/login/cancel", delete(cancel))
        .route("/auth/session", get(session).delete(revoke))
        .route("/health", get(health))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_HTTP_BODY))
        .layer(axum::middleware::map_response(no_store))
        .with_state(app);
    let listener = TcpListener::bind(config.listen)
        .await
        .map_err(|_| AuthError::Configuration)?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|_| AuthError::Storage)
}

fn read_config(path: &Path) -> Result<ServiceFileConfig, AuthError> {
    use std::os::unix::fs::OpenOptionsExt;
    let md = fs::symlink_metadata(path).map_err(|_| AuthError::UnsafePath)?;
    if !md.file_type().is_file()
        || md.nlink() != 1
        || md.mode() & 0o777 != 0o600
        || md.uid() != nix::unistd::Uid::effective().as_raw()
    {
        return Err(AuthError::UnsafePath);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| AuthError::UnsafePath)?;
    let md = file.metadata().map_err(|_| AuthError::UnsafePath)?;
    if !md.file_type().is_file()
        || md.nlink() != 1
        || md.mode() & 0o777 != 0o600
        || md.uid() != nix::unistd::Uid::effective().as_raw()
        || md.len() > 16 * 1024
    {
        return Err(AuthError::UnsafePath);
    }
    serde_json::from_reader(file).map_err(|_| AuthError::Configuration)
}

fn read_root_ca(path: &Path) -> Result<Vec<u8>, AuthError> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let before = fs::symlink_metadata(path).map_err(|_| AuthError::UnsafePath)?;
    if !before.file_type().is_file()
        || before.nlink() != 1
        || before.uid() != 0
        || before.mode() & 0o022 != 0
        || before.len() == 0
        || before.len() > 64 * 1024
    {
        return Err(AuthError::UnsafePath);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| AuthError::UnsafePath)?;
    let opened = file.metadata().map_err(|_| AuthError::UnsafePath)?;
    if !opened.file_type().is_file()
        || opened.nlink() != 1
        || opened.uid() != 0
        || opened.mode() & 0o022 != 0
        || opened.dev() != before.dev()
        || opened.ino() != before.ino()
    {
        return Err(AuthError::UnsafePath);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AuthError::UnsafePath)?;
    if bytes.is_empty() || bytes.len() > 64 * 1024 {
        return Err(AuthError::UnsafePath);
    }
    Ok(bytes)
}
fn validate_config(c: &ServiceFileConfig) -> Result<(), AuthError> {
    let issuer = Url::parse(&c.issuer).map_err(|_| AuthError::OidcConfiguration)?;
    let callback = Url::parse(&c.callback_url).map_err(|_| AuthError::OidcConfiguration)?;
    if issuer.scheme() != "https"
        || issuer.username() != ""
        || issuer.password().is_some()
        || issuer.query().is_some()
        || issuer.fragment().is_some()
        || callback.scheme() != "https"
        || callback.path() != "/auth/callback"
        || callback.username() != ""
        || callback.password().is_some()
        || callback.query().is_some()
        || callback.fragment().is_some()
        || c.client_id.is_empty()
        || c.client_id.len() > 512
        || c.client_secret.is_empty()
        || c.client_secret.len() > 4096
        || !c.listen.ip().is_loopback()
        || !(60..=31_536_000).contains(&c.session_ttl_seconds)
    {
        return Err(AuthError::OidcConfiguration);
    }
    Ok(())
}
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
        && b.query().is_none()
        && b.fragment().is_none()
        && b.username().is_empty()
        && b.password().is_none()
}

async fn bounded_call(
    client: Client,
    origin: Url,
    req: openidconnect::HttpRequest,
) -> Result<openidconnect::HttpResponse, std::io::Error> {
    let request_uri = Url::parse(&req.uri().to_string())
        .map_err(|_| std::io::Error::other("provider request rejected"))?;
    if !same_origin(&origin, &request_uri)
        || request_uri.scheme() != "https"
        || request_uri.query().is_some()
        || request_uri.fragment().is_some()
    {
        return Err(std::io::Error::other("provider endpoint rejected"));
    }
    let request: reqwest::Request =
        reqwest::Request::try_from(req).map_err(|_| std::io::Error::other("request rejected"))?;
    let response = client
        .execute(request)
        .await
        .map_err(|_| std::io::Error::other("provider request failed"))?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_PROVIDER_BODY as u64)
    {
        return Err(std::io::Error::other("provider response too large"));
    }
    let status = response.status();
    let version = response.version();
    let headers = response.headers().clone();
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| std::io::Error::other("provider response failed"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_BODY {
            return Err(std::io::Error::other("provider response too large"));
        }
        body.extend_from_slice(&chunk);
    }
    let mut builder = openidconnect::http::Response::builder()
        .status(status)
        .version(version);
    for (name, value) in &headers {
        builder = builder.header(name, value);
    }
    builder
        .body(body)
        .map_err(|_| std::io::Error::other("provider response invalid"))
}

async fn start(
    State(app): State<Arc<App>>,
    Json(req): Json<StartRequest>,
) -> Result<(StatusCode, Json<StartResponse>), ApiError> {
    let device = canonical_uuid(&req.device_id).ok_or(ApiError::BadRequest)?;
    if !valid_challenge(&req.pkce_challenge) {
        return Err(ApiError::BadRequest);
    }
    let now = unix_now().map_err(|_| ApiError::Internal)?;
    let expires = now + app.flow.ttl.as_secs() as i64;
    let tx = Uuid::new_v4().to_string();
    let state = URL_SAFE_NO_PAD.encode(random::<[u8; 32]>());
    let nonce = URL_SAFE_NO_PAD.encode(random::<[u8; 32]>());
    let (provider_challenge, provider_verifier) = PkceCodeChallenge::new_random_sha256();
    let state_for_url = state.clone();
    let nonce_for_url = nonce.clone();
    let auth_url = app
        .client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            move || CsrfToken::new(state_for_url),
            move || Nonce::new(nonce_for_url),
        )
        .add_scope(Scope::new("openid".into()))
        .add_scope(Scope::new("profile".into()))
        .add_scope(Scope::new("email".into()))
        .set_pkce_challenge(provider_challenge)
        .url()
        .0;
    if auth_url.query().is_none() || auth_url.fragment().is_some() {
        return Err(ApiError::Internal);
    }
    let mut guard = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
    guard.retain(|_, p| p.expires_at > now);
    if guard.len() >= MAX_TRANSACTIONS {
        return Err(ApiError::Busy);
    }
    guard.insert(
        tx.clone(),
        Pending {
            device_id: device,
            client_challenge: req.pkce_challenge,
            provider_verifier: Zeroizing::new(provider_verifier.secret().to_owned()),
            state: Zeroizing::new(state),
            nonce: Zeroizing::new(nonce),
            expires_at: expires,
            phase: Phase::Pending,
        },
    );
    Ok((
        StatusCode::OK,
        Json(StartResponse {
            transaction_id: tx,
            expires_at: expires,
            authorization_url: auth_url.to_string(),
        }),
    ))
}

async fn callback(
    State(app): State<Arc<App>>,
    OriginalUri(uri): OriginalUri,
) -> Result<impl IntoResponse, ApiError> {
    let query = uri.query().ok_or(ApiError::BadRequest)?;
    if query.len() > 8192 {
        return Err(ApiError::BadRequest);
    }
    let mut fields = HashMap::<String, String>::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if !matches!(key.as_ref(), "code" | "state")
            || fields
                .insert(key.into_owned(), value.into_owned())
                .is_some()
        {
            return Err(ApiError::BadRequest);
        }
    }
    let code = fields
        .remove("code")
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or(ApiError::BadRequest)?;
    let state = Zeroizing::new(
        fields
            .remove("state")
            .filter(|s| s.len() <= 256)
            .ok_or(ApiError::BadRequest)?,
    );
    let now = unix_now().map_err(|_| ApiError::Internal)?;
    let (txid, nonce, provider_verifier, expires) = {
        let mut all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
        all.retain(|_, p| p.expires_at > now);
        let found = all
            .iter_mut()
            .find(|(_, p)| ct_eq(p.state.as_bytes(), state.as_bytes()))
            .ok_or(ApiError::BadRequest)?;
        let (id, p) = found;
        if p.expires_at <= now || !matches!(p.phase, Phase::Pending) {
            return Err(ApiError::BadRequest);
        }
        p.phase = Phase::Exchanging;
        (
            id.clone(),
            Zeroizing::new(p.nonce.to_string()),
            p.provider_verifier.to_string(),
            p.expires_at,
        )
    };
    let verifier = PkceCodeVerifier::new(provider_verifier);
    let exchange = app
        .client
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(verifier);
    let callback_http = app.http.clone();
    let callback_origin = app.origin.clone();
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        exchange.request_async(&move |r| {
            bounded_call(callback_http.clone(), callback_origin.clone(), r)
        }),
    )
    .await
    .map_err(|_| ApiError::Provider)?
    .map_err(|_| ApiError::Provider)?;
    let token = response.id_token().ok_or(ApiError::Provider)?;
    let claims = token
        .claims(
            &app.client.id_token_verifier(),
            &Nonce::new(nonce.to_string()),
        )
        .map_err(|_| ApiError::Provider)?;
    let issuer = claims.issuer().as_str().to_owned();
    let subject = claims.subject().as_str().to_owned();
    if subject.is_empty() || subject.len() > 512 || issuer.len() > 2048 {
        return Err(ApiError::Provider);
    }
    let verified =
        VerifiedSubject::from_verified_claims(issuer, subject).map_err(|_| ApiError::Provider)?;
    let mut all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
    let current = all.get_mut(&txid).ok_or(ApiError::BadRequest)?;
    if current.expires_at != expires
        || current.expires_at <= unix_now().map_err(|_| ApiError::Internal)?
        || !matches!(current.phase, Phase::Exchanging)
    {
        return Err(ApiError::BadRequest);
    }
    current.phase = Phase::Ready(verified);
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::PRAGMA, "no-cache"),
        ],
        Html(COMPLETION_PAGE),
    ))
}

async fn poll(
    State(app): State<Arc<App>>,
    Json(req): Json<PollRequest>,
) -> Result<axum::response::Response, ApiError> {
    let tx = canonical_uuid(&req.transaction_id).ok_or(ApiError::BadRequest)?;
    let device = canonical_uuid(&req.device_id).ok_or(ApiError::BadRequest)?;
    if !valid_verifier(&req.pkce_verifier) {
        return Err(ApiError::BadRequest);
    }
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(req.pkce_verifier.as_bytes()));
    let mut all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
    let now = unix_now().map_err(|_| ApiError::Internal)?;
    all.retain(|_, p| p.expires_at > now);
    let p = all.get_mut(&tx).ok_or(ApiError::BadRequest)?;
    if p.expires_at <= now
        || p.device_id != device
        || !ct_eq(p.client_challenge.as_bytes(), challenge.as_bytes())
    {
        return Err(ApiError::Unauthorized);
    }
    match &p.phase {
        Phase::Pending | Phase::Exchanging => {
            return Ok((
                StatusCode::ACCEPTED,
                [(header::CACHE_CONTROL, "no-store")],
                Json(serde_json::json!({"status":"pending"})),
            )
                .into_response());
        }
        Phase::Consuming => return Err(ApiError::Busy),
        Phase::Ready(_) => {}
    }
    let subject = match std::mem::replace(&mut p.phase, Phase::Consuming) {
        Phase::Ready(s) => s,
        _ => return Err(ApiError::Busy),
    };
    let result = app.store.issue_session(&subject, &device);
    // Credential consumption is fail-closed: on storage failure remove the tx; caller starts over.
    all.remove(&tx);
    let issued = result.map_err(|_| ApiError::Internal)?;
    let expires_at = issued.expires_at;
    let account = issued.account.clone();
    let token = issued.into_token();
    Ok((
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(SessionResponse {
            access_token: token,
            expires_at,
            principal_id: account.principal_id,
            network_id: account.network_id,
        }),
    )
        .into_response())
}

async fn cancel(
    State(app): State<Arc<App>>,
    Json(req): Json<CancelRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let tx = canonical_uuid(&req.transaction_id).ok_or(ApiError::BadRequest)?;
    let device = canonical_uuid(&req.device_id).ok_or(ApiError::BadRequest)?;
    if !valid_verifier(&req.pkce_verifier) {
        return Err(ApiError::BadRequest);
    }
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(req.pkce_verifier.as_bytes()));
    let mut all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
    let p = all.get(&tx).ok_or(ApiError::BadRequest)?;
    if p.device_id != device || !ct_eq(p.client_challenge.as_bytes(), challenge.as_bytes()) {
        return Err(ApiError::Unauthorized);
    }
    all.remove(&tx);
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    ))
}

async fn session(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let token = bearer(&headers)?;
    let projection = app
        .store
        .validate_session(token)
        .map_err(|_| ApiError::Unauthorized)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(
            serde_json::json!({"principalId":projection.account.principal_id,"networkId":projection.account.network_id,"deviceId":projection.device_id,"expiresAt":projection.expires_at}),
        ),
    ))
}
async fn revoke(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    app.store
        .revoke_session(bearer(&headers)?)
        .map_err(|_| ApiError::Unauthorized)?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    ))
}
async fn health() -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"phase":"authentication"})),
    )
}

async fn no_store(mut response: axum::response::Response) -> axum::response::Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;
    if token.len() != 43 {
        return Err(ApiError::Unauthorized);
    }
    Ok(token)
}
fn canonical_uuid(v: &str) -> Option<String> {
    let u = Uuid::parse_str(v).ok()?;
    (u.to_string() == v).then(|| v.to_owned())
}
fn valid_challenge(s: &str) -> bool {
    s.len() == 43
        && URL_SAFE_NO_PAD
            .decode(s)
            .is_ok_and(|b| b.len() == 32 && URL_SAFE_NO_PAD.encode(b) == s)
}
fn valid_verifier(s: &str) -> bool {
    (43..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}
fn unix_now() -> Result<i64, AuthError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| AuthError::Storage)?
            .as_secs(),
    )
    .map_err(|_| AuthError::Storage)
}

#[derive(Debug)]
enum ApiError {
    BadRequest,
    Unauthorized,
    Busy,
    Provider,
    Internal,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, code) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::Provider => (StatusCode::BAD_GATEWAY, "identity_provider_error"),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        };
        (
            status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"error":code})),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openidconnect::TokenUrl;
    use sha2::Digest;

    fn test_app() -> (Arc<App>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let metadata: CoreProviderMetadata = serde_json::from_value(serde_json::json!({
            "issuer":"https://dex.example.test",
            "authorization_endpoint":"https://dex.example.test/auth",
            "token_endpoint":"https://dex.example.test/token",
            "jwks_uri":"https://dex.example.test/keys",
            "response_types_supported":["code"],
            "subject_types_supported":["public"],
            "id_token_signing_alg_values_supported":["RS256"]
        }))
        .unwrap();
        let client = CoreClient::from_provider_metadata(
            metadata,
            ClientId::new("agentnet-test".into()),
            Some(ClientSecret::new("unit-test-secret".into())),
        )
        .set_token_uri(TokenUrl::new("https://dex.example.test/token".into()).unwrap())
        .set_redirect_uri(
            RedirectUrl::new("https://agent.example.test/auth/callback".into()).unwrap(),
        );
        let auth = AuthConfig {
            network_id: "11111111-1111-4111-8111-111111111111".into(),
            login_ttl: Duration::from_secs(300),
            session_ttl: Duration::from_secs(3600),
        };
        let store = AuthStore::open(dir.path(), &auth).unwrap();
        let http = Client::builder()
            .redirect(Policy::none())
            .https_only(true)
            .build()
            .unwrap();
        let app = Arc::new(App {
            client,
            http,
            origin: Url::parse("https://dex.example.test").unwrap(),
            store,
            flow: Flow {
                pending: Mutex::new(HashMap::new()),
                ttl: Duration::from_secs(300),
            },
        });
        (app, dir)
    }

    #[test]
    fn service_config_requires_loopback_https_fixed_callback_and_no_query() {
        let good = ServiceFileConfig {
            issuer: "https://127.0.0.1:15556/dex".into(),
            client_id: "agentnet-local".into(),
            client_secret: Zeroizing::new("test-secret".into()),
            callback_url: "https://127.0.0.1:15557/auth/callback".into(),
            network_id: "11111111-1111-4111-8111-111111111111".into(),
            state_dir: PathBuf::from("/tmp/state"),
            listen: "127.0.0.1:15558".parse().unwrap(),
            ca_bundle: None,
            session_ttl_seconds: 3600,
        };
        assert!(validate_config(&good).is_ok());
        let mut bad = good;
        bad.listen = "0.0.0.0:15558".parse().unwrap();
        assert!(validate_config(&bad).is_err());
    }

    #[tokio::test]
    async fn provider_transport_rejects_cross_origin_before_network_access() {
        let request = openidconnect::http::Request::builder()
            .method("GET")
            .uri("https://attacker.invalid/jwks")
            .body(Vec::new())
            .unwrap();
        let client = Client::builder()
            .redirect(Policy::none())
            .https_only(true)
            .build()
            .unwrap();
        let allowed = Url::parse("https://dex.example.test/dex").unwrap();
        assert!(bounded_call(client, allowed, request).await.is_err());
    }

    #[test]
    fn endpoint_origin_check_rejects_query_credentials_and_other_ports() {
        let origin = Url::parse("https://dex.example.test/dex").unwrap();
        for bad in [
            "https://dex.example.test/auth?next=https://attacker.invalid",
            "https://user@dex.example.test/auth",
            "https://dex.example.test:444/auth",
            "http://dex.example.test/auth",
        ] {
            assert!(!same_origin(&origin, &Url::parse(bad).unwrap()), "{bad}");
        }
        assert!(same_origin(
            &origin,
            &Url::parse("https://dex.example.test/auth").unwrap()
        ));
    }

    #[tokio::test]
    async fn login_start_is_pkce_bound_and_pending_poll_cancel_are_device_bound() {
        let (app, _dir) = test_app();
        let device = "22222222-2222-4222-8222-222222222222";
        let verifier = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let (_, Json(started)) = start(
            State(app.clone()),
            Json(StartRequest {
                device_id: device.into(),
                pkce_challenge: challenge.clone(),
            }),
        )
        .await
        .unwrap();
        let auth_url = Url::parse(&started.authorization_url).unwrap();
        let params: HashMap<String, String> = auth_url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(params.get("state").map(String::len), Some(43));
        assert_eq!(params.get("code_challenge").map(String::len), Some(43));
        assert_ne!(params.get("code_challenge"), Some(&challenge));
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert!(!params.contains_key("access_token"));

        let poll_request = || PollRequest {
            transaction_id: started.transaction_id.clone(),
            device_id: device.into(),
            pkce_verifier: Zeroizing::new(verifier.into()),
        };
        let pending = poll(State(app.clone()), Json(poll_request()))
            .await
            .unwrap();
        assert_eq!(pending.status(), StatusCode::ACCEPTED);
        let bad_cancel = cancel(
            State(app.clone()),
            Json(CancelRequest {
                transaction_id: started.transaction_id.clone(),
                device_id: device.into(),
                pkce_verifier: Zeroizing::new(
                    "BCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~".into(),
                ),
            }),
        )
        .await;
        assert!(matches!(bad_cancel, Err(ApiError::Unauthorized)));
        let cancelled = cancel(
            State(app.clone()),
            Json(CancelRequest {
                transaction_id: started.transaction_id.clone(),
                device_id: device.into(),
                pkce_verifier: Zeroizing::new(verifier.into()),
            }),
        )
        .await
        .unwrap()
        .into_response();
        assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);
        assert!(matches!(
            poll(State(app), Json(poll_request())).await,
            Err(ApiError::BadRequest)
        ));
    }
}
