use crate::admin_http::AdminService;
use crate::admin_store::AdminConfig;
use crate::execution_http::ExecutionService;
use crate::feedback_http::FeedbackService;
use crate::identity_http::{IdentityHttpConfig, IdentityService};
use crate::network_http::{NetworkHttpConfig, NetworkService};
use crate::relay_controller::RelayController;
use crate::relay_transport::{RelayHandler, RelayTransport};
use crate::{AuthConfig, AuthError, AuthStore, VerifiedSubject};
use axum::{
    Json, Router,
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect},
    routing::{delete, get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openidconnect::{
    AuthorizationCode, ClaimsVerificationError, ClientId, ClientSecret, CsrfToken,
    EndpointMaybeSet, EndpointNotSet, EndpointSet, IssuerUrl, Nonce, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, Scope, SignatureVerificationError, TokenResponse,
    core::{
        CoreAuthenticationFlow, CoreClient, CoreIdTokenVerifier, CoreJsonWebKeySet,
        CoreProviderMetadata, CoreTokenResponse,
    },
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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    #[serde(default)]
    pub identity: Option<IdentityHttpConfig>,
    #[serde(default)]
    pub network: Option<NetworkHttpConfig>,
    #[serde(default)]
    pub relay: bool,
    #[serde(default)]
    pub administration: Option<AdminConfig>,
    #[serde(default)]
    pub execution: bool,
    #[serde(default)]
    pub model_center: Option<crate::model_center_authority::ModelCenterConfig>,
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
    browser_return_path: Option<&'static str>,
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
    Failed,
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
    store: Arc<AuthStore>,
    flow: Flow,
    verification: Verification,
}
struct Verification {
    metadata: CoreProviderMetadata,
    client_id: ClientId,
    client_secret: ClientSecret,
    cache: Mutex<KeyCache>,
}
struct KeyCache {
    keys: CoreJsonWebKeySet,
    generation: u64,
    refreshing: bool,
    last_attempt: Option<Instant>,
}
impl Verification {
    fn new(
        metadata: CoreProviderMetadata,
        client_id: ClientId,
        client_secret: ClientSecret,
    ) -> Self {
        let keys = metadata.jwks().clone();
        Self {
            metadata,
            client_id,
            client_secret,
            cache: Mutex::new(KeyCache {
                keys,
                generation: 0,
                refreshing: false,
                last_attempt: None,
            }),
        }
    }
    fn verifier(&self, keys: CoreJsonWebKeySet) -> CoreIdTokenVerifier<'static> {
        CoreIdTokenVerifier::new_confidential_client(
            self.client_id.clone(),
            self.client_secret.clone(),
            self.metadata.issuer().clone(),
            keys,
        )
        .set_allowed_algs(
            self.metadata
                .id_token_signing_alg_values_supported()
                .clone(),
        )
    }
}
struct RefreshClaim<'a>(&'a Mutex<KeyCache>);
impl Drop for RefreshClaim<'_> {
    fn drop(&mut self) {
        if let Ok(mut cache) = self.0.lock() {
            cache.refreshing = false;
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "pkceChallenge")]
    pkce_challenge: String,
    #[serde(default, rename = "browserReturn")]
    browser_return: bool,
    #[serde(default, rename = "browserReturnPath")]
    browser_return_path: Option<String>,
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
    let verification = Verification::new(
        metadata.clone(),
        ClientId::new(config.client_id.clone()),
        ClientSecret::new(config.client_secret.to_string()),
    );
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
        network_id: config.network_id.clone(),
        login_ttl: Duration::from_secs(300),
        session_ttl: Duration::from_secs(config.session_ttl_seconds),
    };
    let store = Arc::new(AuthStore::open(&config.state_dir, &auth)?);
    let feedback = FeedbackService::open(
        store.clone(),
        &config.state_dir,
        config.administration.clone(),
        Url::parse(&config.callback_url)
            .map_err(|_| AuthError::Configuration)?
            .origin()
            .ascii_serialization(),
        &config.network_id,
    )?;
    let mut administration = config
        .administration
        .clone()
        .map(|settings| {
            let callback =
                Url::parse(&config.callback_url).map_err(|_| AuthError::Configuration)?;
            let origin = callback.origin().ascii_serialization();
            AdminService::open(
                store.clone(),
                &config.state_dir,
                settings,
                origin,
                &config.network_id,
            )
        })
        .transpose()?;
    let identity = config
        .identity
        .as_ref()
        .map(|identity_config| {
            IdentityService::open(
                store.clone(),
                &config.state_dir,
                identity_config,
                &config.network_id,
            )
        })
        .transpose()?;
    let network = config
        .network
        .as_ref()
        .map(|network_config| {
            NetworkService::open(
                store.clone(),
                &config.state_dir,
                config.identity.as_ref().ok_or(AuthError::Configuration)?,
                &config.network_id,
                network_config,
            )
        })
        .transpose()?;
    if config.relay && (identity.is_none() || network.is_none()) {
        return Err(AuthError::Configuration);
    }
    let relay = if config.relay {
        let network = network.clone().ok_or(AuthError::Configuration)?;
        Some(Arc::new(RelayController::new(network)?))
    } else {
        None
    };
    let mut execution = if config.execution {
        Some(ExecutionService::open(
            network.clone().ok_or(AuthError::Configuration)?,
            relay.clone().ok_or(AuthError::Configuration)?,
            &config.state_dir,
            config
                .administration
                .clone()
                .ok_or(AuthError::Configuration)?,
        )?)
    } else {
        None
    };
    if let (Some(admin), Some(exec)) = (administration.as_mut(), execution.as_ref()) {
        admin.connect_execution(exec.ledger());
    }
    let (model_center, _model_owner_lock) =
        if let Some(settings) = config.model_center.clone().filter(|s| s.enabled) {
            if settings.concurrency_limit == 0
                || settings.concurrency_limit > 32
                || settings.daily_cost_microusd == Some(0)
            {
                return Err(AuthError::Configuration);
            }
            let admin = administration.as_mut().ok_or(AuthError::Configuration)?;
            let model_store = Arc::new(
                crate::model_center_store::ModelCenterStore::open(
                    &config.state_dir,
                    &config.network_id,
                )
                .map_err(|_| AuthError::Storage)?,
            );
            // This process exclusively owns admission before the listener opens.
            let (owner_lock, _) = model_store
                .start_exclusive()
                .map_err(|_| AuthError::Storage)?;
            admin.connect_models(model_store.clone());
            if let Some(exec) = execution.as_mut() {
                exec.connect_models(model_store.clone());
            }
            let authority = crate::model_center_authority::ModelAuthority::new(
                admin.clone(),
                relay.clone().ok_or(AuthError::Configuration)?,
                model_store.clone(),
                settings,
            );
            let http = crate::model_center_http::ModelCenterHttp::new(
                admin.clone(),
                model_store,
                authority.validator(),
                authority.captured_validator(),
            );
            (
                Some(http.router().merge(authority.router())),
                Some(owner_lock),
            )
        } else {
            (None, None)
        };
    let app = Arc::new(App {
        client,
        http,
        origin,
        store,
        flow: Flow {
            pending: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(300),
        },
        verification,
    });
    let router = Router::new()
        .route("/auth/login/start", post(start))
        .route("/auth/callback", get(callback))
        .route("/auth/login/poll", post(poll))
        .route("/auth/login/cancel", delete(cancel))
        .route("/auth/session", get(session).delete(revoke))
        .route("/health", get(health))
        .with_state(app);
    let router = assemble_feature_routes(router, identity, network, relay, &config.issuer)
        .merge(feedback.router());
    let router = if let Some(admin) = administration {
        router.merge(admin.router())
    } else {
        router
    };
    let router = if let Some(exec) = execution {
        router.merge(exec.router())
    } else {
        router
    };
    let router = if let Some(models) = model_center {
        router.merge(models)
    } else {
        router
    };
    let router = router
        .layer(axum::extract::DefaultBodyLimit::max(MAX_HTTP_BODY))
        .layer(axum::middleware::map_response(no_store));
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

/// Merge the optional feature routers into the same production router used by
/// `serve`. NetworkService owns the shared 404/405 fallback contract; the
/// feature routers must therefore remain route-only and not install a second
/// fallback.
fn assemble_feature_routes(
    router: Router<()>,
    identity: Option<IdentityService>,
    network: Option<NetworkService>,
    relay: Option<Arc<RelayController>>,
    login_issuer: &str,
) -> Router<()> {
    let instance =
        match (&identity, &network, &relay) {
            (Some(identity), Some(network), Some(_)) => Some(
                crate::instance_http::InstanceHttp::new(identity, network, login_issuer),
            ),
            _ => None,
        };
    let mut router = router;
    if let Some(identity) = identity {
        router = router.merge(identity.router());
    }
    if let Some(network) = network {
        router = router.merge(network.router());
    }
    if let Some(controller) = relay {
        router = router
            .merge(crate::relay_http::router(controller.clone()))
            .merge(RelayTransport::new(controller as Arc<dyn RelayHandler>).router());
    }
    if let Some(instance) = instance {
        router = router.merge(instance.router());
    }
    router
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
    if c.relay && (c.identity.is_none() || c.network.is_none()) {
        return Err(AuthError::Configuration);
    }
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
    let browser_return_path = match (req.browser_return, req.browser_return_path.as_deref()) {
        (false, None) => None,
        (true, None | Some("/admin")) => Some("/admin"),
        (true, Some("/feedback")) => Some("/feedback"),
        _ => return Err(ApiError::BadRequest),
    };
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
            browser_return_path,
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
    let exchange_app = app.clone();
    let keys_app = app.clone();
    let browser_return = callback_browser_return_path(&app, &uri);
    let result = callback_using(
        app,
        uri,
        move |code, verifier| async move {
            let exchange = exchange_app
                .client
                .exchange_code(AuthorizationCode::new(code))
                .set_pkce_verifier(PkceCodeVerifier::new(verifier));
            let http = exchange_app.http.clone();
            let origin = exchange_app.origin.clone();
            tokio::time::timeout(
                Duration::from_secs(15),
                exchange.request_async(&move |r| bounded_call(http.clone(), origin.clone(), r)),
            )
            .await
            .map_err(|_| ApiError::Provider)?
            .map_err(|_| ApiError::Provider)
        },
        move || async move {
            let http = keys_app.http.clone();
            let origin = keys_app.origin.clone();
            CoreJsonWebKeySet::fetch_async(keys_app.verification.metadata.jwks_uri(), &move |r| {
                bounded_call(http.clone(), origin.clone(), r)
            })
            .await
            .map_err(|_| ApiError::Provider)
        },
    )
    .await;
    if let Some(path) = browser_return {
        Ok(browser_return_response(path, result.is_ok()))
    } else {
        match result {
            Ok(response) => Ok(response),
            Err(error) => Ok(callback_failure_page(error)),
        }
    }
}

// A browser can reach a stale callback after the transaction has already been purged.
// Preserve the error status while giving it a safe, fixed recovery action with no provider detail.
fn callback_failure_page(error: ApiError) -> axum::response::Response {
    let status = error.into_response().status();
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Html(include_str!("../admin-web/auth-error.html")),
    )
        .into_response()
}

fn callback_browser_return_path(app: &App, uri: &axum::http::Uri) -> Option<&'static str> {
    let query = uri.query().filter(|q| q.len() <= 8192)?;
    let states: Vec<_> = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .collect();
    if states.len() != 1 {
        return None;
    }
    app.flow
        .pending
        .lock()
        .ok()?
        .values()
        .find(|p| ct_eq(p.state.as_bytes(), states[0].as_bytes()))
        .and_then(|p| p.browser_return_path)
}

fn browser_return_response(path: &'static str, success: bool) -> axum::response::Response {
    let target = match (path, success) {
        ("/feedback", true) => "/feedback?login=complete",
        ("/feedback", false) => "/feedback?login=failed",
        (_, true) => "/admin?login=complete",
        (_, false) => "/admin?login=failed",
    };
    let mut response = Redirect::to(target).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
fn ensure_exchange(app: &App, txid: &str, expires: i64) -> Result<(), ApiError> {
    let all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
    let current = all.get(txid).ok_or(ApiError::BadRequest)?;
    if current.expires_at != expires
        || expires <= unix_now().map_err(|_| ApiError::Internal)?
        || !matches!(current.phase, Phase::Exchanging)
    {
        return Err(ApiError::BadRequest);
    }
    Ok(())
}
fn fail_exchange(app: &App, txid: &str, expires: i64) {
    if let Ok(mut all) = app.flow.pending.lock()
        && let Some(current) = all.get_mut(txid)
        && current.expires_at == expires
        && matches!(current.phase, Phase::Exchanging)
    {
        current.phase = Phase::Failed;
    }
}
struct ExchangeClaim {
    app: Arc<App>,
    txid: String,
    expires: i64,
}
impl Drop for ExchangeClaim {
    fn drop(&mut self) {
        fail_exchange(&self.app, &self.txid, self.expires);
    }
}
async fn refresh_keys<F, Fut>(
    app: &App,
    observed: u64,
    load: F,
) -> Result<CoreJsonWebKeySet, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<CoreJsonWebKeySet, ApiError>>,
{
    let wait_started = Instant::now();
    loop {
        let wait = {
            let mut cache = app
                .verification
                .cache
                .lock()
                .map_err(|_| ApiError::Internal)?;
            if cache.generation != observed {
                return Ok(cache.keys.clone());
            }
            if cache.refreshing {
                true
            } else {
                if cache
                    .last_attempt
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
                {
                    return Err(ApiError::Provider);
                }
                cache.refreshing = true;
                cache.last_attempt = Some(Instant::now());
                false
            }
        };
        if !wait {
            break;
        }
        if wait_started.elapsed() >= Duration::from_secs(15) {
            return Err(ApiError::Provider);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _claim = RefreshClaim(&app.verification.cache);
    let keys = tokio::time::timeout(Duration::from_secs(15), load())
        .await
        .map_err(|_| ApiError::Provider)??;
    if keys.keys().is_empty() || keys.keys().len() > 32 {
        return Err(ApiError::Provider);
    }
    let mut cache = app
        .verification
        .cache
        .lock()
        .map_err(|_| ApiError::Internal)?;
    if cache.generation == observed {
        cache.generation = cache.generation.checked_add(1).ok_or(ApiError::Internal)?;
        cache.keys = keys;
    }
    Ok(cache.keys.clone())
}
async fn callback_using<E, EF, K, KF>(
    app: Arc<App>,
    uri: axum::http::Uri,
    exchange: E,
    load_keys: K,
) -> Result<axum::response::Response, ApiError>
where
    E: FnOnce(String, String) -> EF,
    EF: std::future::Future<Output = Result<CoreTokenResponse, ApiError>>,
    K: FnOnce() -> KF,
    KF: std::future::Future<Output = Result<CoreJsonWebKeySet, ApiError>>,
{
    let query = uri.query().ok_or(ApiError::BadRequest)?;
    if query.len() > 8192 {
        return Err(ApiError::BadRequest);
    }
    let mut fields = HashMap::<String, String>::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if !matches!(
            key.as_ref(),
            "code" | "state" | "error" | "error_description" | "error_uri"
        ) || fields
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err(ApiError::BadRequest);
        }
    }
    let state = Zeroizing::new(
        fields
            .remove("state")
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or(ApiError::BadRequest)?,
    );
    let provider_error = fields.remove("error");
    let code = fields.remove("code");
    if provider_error
        .as_ref()
        .is_some_and(|e| e.is_empty() || e.len() > 256)
        || provider_error.is_some() == code.is_some()
        || (provider_error.is_none()
            && (fields.contains_key("error_description") || fields.contains_key("error_uri")))
        || code
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 4096)
    {
        return Err(ApiError::BadRequest);
    }
    let now = unix_now().map_err(|_| ApiError::Internal)?;
    let (txid, nonce, provider_verifier, expires) = {
        let mut all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
        all.retain(|_, p| p.expires_at > now);
        let (id, p) = all
            .iter_mut()
            .find(|(_, p)| ct_eq(p.state.as_bytes(), state.as_bytes()))
            .ok_or(ApiError::BadRequest)?;
        if p.expires_at <= now || !matches!(p.phase, Phase::Pending) {
            return Err(ApiError::BadRequest);
        }
        if provider_error.is_some() {
            p.phase = Phase::Failed;
            return Err(ApiError::LoginFailed);
        }
        p.phase = Phase::Exchanging;
        (
            id.clone(),
            Zeroizing::new(p.nonce.to_string()),
            p.provider_verifier.to_string(),
            p.expires_at,
        )
    };
    let _claim = ExchangeClaim {
        app: app.clone(),
        txid: txid.clone(),
        expires,
    };
    let result = async {
        let response = exchange(code.ok_or(ApiError::BadRequest)?, provider_verifier).await?;
        ensure_exchange(&app, &txid, expires)?;
        let token = response.id_token().ok_or(ApiError::Provider)?;
        let nonce = Nonce::new(nonce.to_string());
        let (keys, generation) = {
            let cache = app
                .verification
                .cache
                .lock()
                .map_err(|_| ApiError::Internal)?;
            (cache.keys.clone(), cache.generation)
        };
        let verifier = app.verification.verifier(keys);
        let subject = match token.claims(&verifier, &nonce) {
            Ok(claims) => VerifiedSubject::from_verified_claims(
                claims.issuer().as_str().into(),
                claims.subject().as_str().into(),
            )
            .map_err(|_| ApiError::Provider)?,
            Err(ClaimsVerificationError::SignatureVerification(
                SignatureVerificationError::NoMatchingKey
                | SignatureVerificationError::CryptoError(_),
            )) => {
                let keys = refresh_keys(&app, generation, load_keys).await?;
                ensure_exchange(&app, &txid, expires)?;
                let verifier = app.verification.verifier(keys);
                let claims = token
                    .claims(&verifier, &nonce)
                    .map_err(|_| ApiError::Provider)?;
                VerifiedSubject::from_verified_claims(
                    claims.issuer().as_str().into(),
                    claims.subject().as_str().into(),
                )
                .map_err(|_| ApiError::Provider)?
            }
            Err(_) => return Err(ApiError::Provider),
        };
        let mut all = app.flow.pending.lock().map_err(|_| ApiError::Internal)?;
        let current = all.get_mut(&txid).ok_or(ApiError::BadRequest)?;
        if current.expires_at != expires
            || expires <= unix_now().map_err(|_| ApiError::Internal)?
            || !matches!(current.phase, Phase::Exchanging)
        {
            return Err(ApiError::BadRequest);
        }
        current.phase = Phase::Ready(subject);
        Ok(())
    }
    .await;
    if let Err(error) = result {
        fail_exchange(&app, &txid, expires);
        return Err(error);
    }
    Ok((
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::PRAGMA, "no-cache"),
        ],
        Html(COMPLETION_PAGE),
    )
        .into_response())
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
        Phase::Failed => return Err(ApiError::LoginFailed),
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
    LoginFailed,
    Internal,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, code) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Self::Provider => (StatusCode::BAD_GATEWAY, "identity_provider_error"),
            Self::LoginFailed => (StatusCode::UNAUTHORIZED, "login_failed"),
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
    use axum::{body::Body, http::Request};
    use openidconnect::TokenUrl;
    use sha2::Digest;
    use tower::ServiceExt;

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
        let verification = Verification::new(
            metadata.clone(),
            ClientId::new("agentnet-test".into()),
            ClientSecret::new("unit-test-secret".into()),
        );
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
        let store = Arc::new(AuthStore::open(dir.path(), &auth).unwrap());
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
            verification,
        });
        (app, dir)
    }

    #[tokio::test]
    async fn production_feature_router_composes_identity_network_and_relay_without_fallback_conflict()
     {
        let fixture = crate::network_http::tests::Fixture::new();
        let identity = IdentityService::open(
            fixture.auth.clone(),
            fixture.dir.path(),
            &fixture.config,
            &fixture.network,
        )
        .unwrap();
        let controller = Arc::new(RelayController::new(fixture.service.clone()).unwrap());
        let router = assemble_feature_routes(
            Router::new(),
            Some(identity),
            Some(fixture.service.clone()),
            Some(controller),
            "https://dex.example.test",
        );
        let administration = AdminService::open(
            fixture.auth.clone(),
            fixture.dir.path(),
            AdminConfig {
                admin_principal_ids: vec![Uuid::new_v4().to_string()],
                hosts: vec![],
                model_refs: vec![],
                max_daily_tokens: 1000,
            },
            "https://agent.example.test".into(),
            &fixture.network,
        )
        .unwrap();
        let router = router.merge(administration.router());
        let page = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/admin")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
        assert!(page.headers().contains_key(header::CONTENT_SECURITY_POLICY));
        let anonymous = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/admin/bootstrap")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);

        let instance_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-network/instance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(instance_response.status(), StatusCode::OK);
        assert_eq!(
            instance_response.headers()[header::CACHE_CONTROL],
            "no-store"
        );
        assert_eq!(
            instance_response.headers()[header::CONTENT_TYPE],
            "application/json"
        );
        let bytes = axum::body::to_bytes(instance_response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let descriptor: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            descriptor
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "version",
                "profile",
                "serviceId",
                "environment",
                "networkId",
                "name",
                "issuer",
                "loginIssuer",
                "protocol",
                "capabilities",
                "rootCertificate",
                "jwks"
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(descriptor["version"], 1);
        assert_eq!(descriptor["profile"], "owned-device-relay-v1");
        assert_eq!(descriptor["serviceId"], fixture.config.service_id);
        assert_eq!(descriptor["environment"], "development");
        assert_eq!(descriptor["networkId"], fixture.network);
        assert_eq!(descriptor["name"], "Isolated network");
        assert_eq!(descriptor["issuer"], fixture.config.issuer);
        assert_eq!(descriptor["loginIssuer"], "https://dex.example.test");
        assert_eq!(descriptor["protocol"], 1);
        assert_eq!(
            descriptor["capabilities"],
            serde_json::json!(["tls13-mtls"])
        );
        let keys =
            myagents_agentnet_identity_core::ServiceKeys::load(&fixture.config.key_file).unwrap();
        assert_eq!(descriptor["rootCertificate"], keys.root_certificate_pem());
        assert_eq!(descriptor["jwks"], keys.jwks());
        for forbidden in [
            "principalId",
            "account",
            "deviceId",
            "accessToken",
            "bootstrapGrant",
            "typedRpc",
            "permit",
            "return",
            "hostManagement",
        ] {
            assert!(!descriptor.as_object().unwrap().contains_key(forbidden));
        }

        let query_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-network/instance?anything=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(query_response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(query_response.headers()[header::CACHE_CONTROL], "no-store");
        let credential_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-network/instance")
                    .header(header::AUTHORIZATION, "Bearer forbidden")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(credential_response.status(), StatusCode::BAD_REQUEST);
        for credential_header in [header::COOKIE.as_str(), "dpop"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/agent-network/instance")
                        .header(credential_header, "ignored")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        }
        let post_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/agent-network/instance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(post_response.status(), StatusCode::METHOD_NOT_ALLOWED);
        let head_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("HEAD")
                    .uri("/api/agent-network/instance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(head_response.status(), StatusCode::METHOD_NOT_ALLOWED);

        let no_relay_identity = IdentityService::open(
            fixture.auth.clone(),
            fixture.dir.path(),
            &fixture.config,
            &fixture.network,
        )
        .unwrap();
        let no_relay_router = assemble_feature_routes(
            Router::new(),
            Some(no_relay_identity),
            Some(fixture.service.clone()),
            None,
            "https://dex.example.test",
        );
        let absent = no_relay_router
            .oneshot(
                Request::builder()
                    .uri("/api/agent-network/instance")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(absent.status(), StatusCode::NOT_FOUND);

        let identity_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/agent-network/jwks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(identity_response.status(), StatusCode::OK);
        assert_eq!(
            identity_response.headers()[header::CACHE_CONTROL],
            "no-store"
        );

        // A protected network endpoint reaches its real owner and rejects the
        // missing credentials, proving it was not swallowed by another router.
        let network_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/me/network")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(network_response.status(), StatusCode::UNAUTHORIZED);

        // The catalog route is registered by relay_http; wrong-method behavior
        // remains 405, and the merged global middleware keeps it non-cacheable.
        let method_response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/devices/self/catalog")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(method_response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(method_response.headers()[header::CACHE_CONTROL], "no-store");

        let missing = router
            .oneshot(
                Request::builder()
                    .uri("/v1/not-a-route")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(missing.into_body(), 8 * 1024)
            .await
            .unwrap();
        let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(error["error"]["code"], "NETWORK_ROUTE_NOT_FOUND");
    }

    #[test]
    fn service_config_requires_loopback_https_fixed_callback_and_no_query() {
        let mut good = ServiceFileConfig {
            issuer: "https://127.0.0.1:15556/dex".into(),
            client_id: "agentnet-local".into(),
            client_secret: Zeroizing::new("test-secret".into()),
            callback_url: "https://127.0.0.1:15557/auth/callback".into(),
            network_id: "11111111-1111-4111-8111-111111111111".into(),
            state_dir: PathBuf::from("/tmp/state"),
            listen: "127.0.0.1:15558".parse().unwrap(),
            ca_bundle: None,
            session_ttl_seconds: 3600,
            identity: None,
            network: None,
            relay: false,
            administration: None,
            model_center: None,
            execution: false,
        };
        assert!(validate_config(&good).is_ok());
        good.relay = true;
        assert!(validate_config(&good).is_err());
        good.relay = false;
        good.listen = "0.0.0.0:15558".parse().unwrap();
        assert!(validate_config(&good).is_err());
    }

    #[test]
    fn relay_flag_defaults_off_for_existing_service_files() {
        let value = serde_json::json!({
            "issuer": "https://127.0.0.1:15556/dex",
            "client_id": "agentnet-local",
            "client_secret": "test-secret",
            "callback_url": "https://127.0.0.1:15557/auth/callback",
            "network_id": "11111111-1111-4111-8111-111111111111",
            "state_dir": "/tmp/state",
            "listen": "127.0.0.1:15558"
        });
        let config: ServiceFileConfig = serde_json::from_value(value).unwrap();
        assert!(!config.relay);
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
    async fn browser_return_is_opt_in_state_bound_and_has_no_redirect_input() {
        let (app, _dir) = test_app();
        let (_, Json(started)) = start(
            State(app.clone()),
            Json(StartRequest {
                device_id: "22222222-2222-4222-8222-222222222222".into(),
                pkce_challenge: URL_SAFE_NO_PAD.encode(Sha256::digest(TEST_VERIFIER.as_bytes())),
                browser_return: true,
                browser_return_path: None,
            }),
        )
        .await
        .unwrap();
        let url = Url::parse(&started.authorization_url).unwrap();
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(
            Some("/admin"),
            callback_browser_return_path(
                &app,
                &format!("/auth/callback?state={state}&code=test")
                    .parse()
                    .unwrap()
            )
        );
        assert_eq!(
            None,
            callback_browser_return_path(&app, &"/auth/callback?state=wrong".parse().unwrap())
        );
        assert_eq!(
            None,
            callback_browser_return_path(
                &app,
                &format!("/auth/callback?state={state}&state={state}")
                    .parse()
                    .unwrap()
            )
        );
        app.flow
            .pending
            .lock()
            .unwrap()
            .get_mut(&started.transaction_id)
            .unwrap()
            .expires_at = 0;
        assert_eq!(
            Some("/admin"),
            callback_browser_return_path(
                &app,
                &format!("/auth/callback?state={state}").parse().unwrap()
            )
        );
        for (success, location) in [
            (true, "/admin?login=complete"),
            (false, "/admin?login=failed"),
        ] {
            let response = browser_return_response("/admin", success);
            assert_eq!(response.status(), StatusCode::SEE_OTHER);
            assert_eq!(response.headers()[header::LOCATION], location);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::REFERRER_POLICY], "no-referrer");
        }
        assert!(serde_json::from_value::<StartRequest>(serde_json::json!({
            "deviceId":"22222222-2222-4222-8222-222222222222", "pkceChallenge":"unused", "returnUrl":"https://other.test"
        })).is_err());
        let failed = callback_failure_page(ApiError::BadRequest);
        assert_eq!(failed.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(failed.into_body(), 4096)
            .await
            .unwrap();
        let text = std::str::from_utf8(&body).unwrap();
        assert!(text.contains("登录未完成") && text.contains("href=\"/admin\""));
        let ordinary: StartRequest = serde_json::from_value(serde_json::json!({
            "deviceId":"22222222-2222-4222-8222-222222222222", "pkceChallenge":"unused"
        }))
        .unwrap();
        assert!(!ordinary.browser_return);
    }

    #[tokio::test]
    async fn browser_feedback_return_path_is_allowlisted_and_state_bound() {
        let (app, _dir) = test_app();
        let request = |path: Option<&str>, browser_return| StartRequest {
            device_id: TEST_DEVICE.into(),
            pkce_challenge: URL_SAFE_NO_PAD.encode(Sha256::digest(TEST_VERIFIER.as_bytes())),
            browser_return,
            browser_return_path: path.map(str::to_owned),
        };
        for path in [
            "https://evil.test",
            "//evil.test",
            "/feedback?token=test",
            "/feedback/",
            "/other",
            "",
        ] {
            assert!(matches!(
                start(State(app.clone()), Json(request(Some(path), true))).await,
                Err(ApiError::BadRequest)
            ));
        }
        assert!(matches!(
            start(State(app.clone()), Json(request(Some("/feedback"), false))).await,
            Err(ApiError::BadRequest)
        ));
        let (_, Json(started)) = start(State(app.clone()), Json(request(Some("/feedback"), true)))
            .await
            .unwrap();
        let url = Url::parse(&started.authorization_url).unwrap();
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(
            callback_browser_return_path(
                &app,
                &format!("/auth/callback?state={state}&browserReturnPath=/admin")
                    .parse()
                    .unwrap()
            ),
            Some("/feedback")
        );
        assert_eq!(
            callback_browser_return_path(
                &app,
                &"/auth/callback?state=unknown&browserReturnPath=/feedback"
                    .parse()
                    .unwrap()
            ),
            None
        );
        for (success, target) in [
            (true, "/feedback?login=complete"),
            (false, "/feedback?login=failed"),
        ] {
            let r = browser_return_response("/feedback", success);
            assert_eq!(r.status(), StatusCode::SEE_OTHER);
            assert_eq!(r.headers()[header::LOCATION], target);
            assert_eq!(r.headers()[header::REFERRER_POLICY], "no-referrer");
        }
        app.flow
            .pending
            .lock()
            .unwrap()
            .remove(&started.transaction_id);
        assert_eq!(
            callback_browser_return_path(
                &app,
                &format!("/auth/callback?state={state}").parse().unwrap()
            ),
            None
        );
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
                browser_return: false,
                browser_return_path: None,
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
    const TEST_DEVICE: &str = "22222222-2222-4222-8222-222222222222";
    const TEST_VERIFIER: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    struct Signing {
        key: rsa::RsaPrivateKey,
        jwks: CoreJsonWebKeySet,
        kid: &'static str,
    }
    fn signing(rotated: bool) -> &'static Signing {
        static OLD: std::sync::OnceLock<Signing> = std::sync::OnceLock::new();
        static NEW: std::sync::OnceLock<Signing> = std::sync::OnceLock::new();
        let cell = if rotated { &NEW } else { &OLD };
        cell.get_or_init(|| {
            use rsa::traits::PublicKeyParts;
            let key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng,2048).unwrap();
            let kid = if rotated { "new-key" } else { "old-key" };
            let jwks = serde_json::from_value(serde_json::json!({"keys":[{"kty":"RSA","n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),"kid":kid,"alg":"RS256","use":"sig"}]})).unwrap();
            Signing { key,jwks,kid }
        })
    }
    fn signed_response(
        signer: &Signing,
        nonce: &str,
        issuer: &str,
        audience: &str,
        expires: i64,
    ) -> CoreTokenResponse {
        use rsa::pkcs1::EncodeRsaPrivateKey;
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(signer.kid.into());
        let claims = serde_json::json!({"iss":issuer,"sub":"isolated-user","aud":audience,"iat":unix_now().unwrap(),"exp":expires,"nonce":nonce});
        let token = jsonwebtoken::encode(
            &header,
            &claims,
            &jsonwebtoken::EncodingKey::from_rsa_der(signer.key.to_pkcs1_der().unwrap().as_bytes()),
        )
        .unwrap();
        serde_json::from_value(serde_json::json!({"access_token":"test-only-not-authority","token_type":"Bearer","id_token":token})).unwrap()
    }
    async fn flow(app: &Arc<App>) -> (StartResponse, axum::http::Uri, String) {
        let (_, Json(started)) = start(
            State(app.clone()),
            Json(StartRequest {
                device_id: TEST_DEVICE.into(),
                pkce_challenge: URL_SAFE_NO_PAD.encode(Sha256::digest(TEST_VERIFIER.as_bytes())),
                browser_return: false,
                browser_return_path: None,
            }),
        )
        .await
        .unwrap();
        let url = Url::parse(&started.authorization_url).unwrap();
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let nonce = url
            .query_pairs()
            .find(|(k, _)| k == "nonce")
            .unwrap()
            .1
            .into_owned();
        let uri = format!("/auth/callback?code=isolated-code&state={state}")
            .parse()
            .unwrap();
        (started, uri, nonce)
    }
    fn poll_req(started: &StartResponse) -> PollRequest {
        PollRequest {
            transaction_id: started.transaction_id.clone(),
            device_id: TEST_DEVICE.into(),
            pkce_verifier: Zeroizing::new(TEST_VERIFIER.into()),
        }
    }
    fn ready_keys(app: &App) {
        app.verification.cache.lock().unwrap().keys = signing(false).jwks.clone();
    }
    fn token(nonce: &str, rotated: bool) -> CoreTokenResponse {
        signed_response(
            signing(rotated),
            nonce,
            "https://dex.example.test",
            "agentnet-test",
            unix_now().unwrap() + 600,
        )
    }
    async fn no_keys() -> Result<CoreJsonWebKeySet, ApiError> {
        panic!("unexpected refresh")
    }

    #[tokio::test]
    async fn provider_error_consumes_valid_state_and_poll_is_terminal_without_raw_detail() {
        let (app, _dir) = test_app();
        let (started, uri, _) = flow(&app).await;
        let state = uri.query().unwrap().split("state=").nth(1).unwrap();
        let error_uri = format!("/auth/callback?error=access_denied&error_description=private-provider-detail&state={state}").parse().unwrap();
        let result = callback_using(
            app.clone(),
            error_uri,
            |_, _| async { panic!("no exchange on error") },
            no_keys,
        )
        .await;
        assert!(matches!(result, Err(ApiError::LoginFailed)));
        assert!(matches!(
            poll(State(app.clone()), Json(poll_req(&started))).await,
            Err(ApiError::LoginFailed)
        ));
        assert!(matches!(
            callback_using(
                app.clone(),
                uri,
                |_, _| async { panic!("late callback") },
                no_keys
            )
            .await,
            Err(ApiError::BadRequest)
        ));
        let response = ApiError::LoginFailed.into_response();
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"error":"login_failed"})
        );
    }
    #[tokio::test]
    async fn exchange_failure_is_terminal_and_late_callback_cannot_reenter() {
        let (app, _dir) = test_app();
        let (started, uri, _) = flow(&app).await;
        assert!(matches!(
            callback_using(
                app.clone(),
                uri.clone(),
                |_, _| async { Err(ApiError::Provider) },
                no_keys
            )
            .await,
            Err(ApiError::Provider)
        ));
        assert!(matches!(
            poll(State(app.clone()), Json(poll_req(&started))).await,
            Err(ApiError::LoginFailed)
        ));
        assert!(matches!(
            callback_using(
                app,
                uri,
                |_, _| async { panic!("second exchange") },
                no_keys
            )
            .await,
            Err(ApiError::BadRequest)
        ));
    }
    #[tokio::test]
    async fn invalid_issuer_audience_nonce_and_expiry_never_trigger_refresh_or_ready() {
        for failure in 0..4 {
            let (app, _dir) = test_app();
            ready_keys(&app);
            let (started, uri, nonce) = flow(&app).await;
            let response = signed_response(
                signing(false),
                if failure == 2 { "wrong-nonce" } else { &nonce },
                if failure == 0 {
                    "https://foreign.test"
                } else {
                    "https://dex.example.test"
                },
                if failure == 1 {
                    "wrong-audience"
                } else {
                    "agentnet-test"
                },
                if failure == 3 {
                    unix_now().unwrap() - 60
                } else {
                    unix_now().unwrap() + 600
                },
            );
            assert!(matches!(
                callback_using(app.clone(), uri, |_, _| async { Ok(response) }, no_keys).await,
                Err(ApiError::Provider)
            ));
            assert!(matches!(
                poll(State(app), Json(poll_req(&started))).await,
                Err(ApiError::LoginFailed)
            ));
        }
    }
    #[tokio::test]
    async fn rotation_retries_verification_once_and_poll_issues_only_one_session() {
        let (app, _dir) = test_app();
        ready_keys(&app);
        let (started, uri, nonce) = flow(&app).await;
        callback_using(
            app.clone(),
            uri,
            |_, _| async { Ok(token(&nonce, true)) },
            || async { Ok(signing(true).jwks.clone()) },
        )
        .await
        .unwrap();
        assert_eq!(app.verification.cache.lock().unwrap().generation, 1);
        let (a, b) = tokio::join!(
            poll(State(app.clone()), Json(poll_req(&started))),
            poll(State(app.clone()), Json(poll_req(&started)))
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    }
    #[tokio::test]
    async fn cancel_during_rotation_prevents_late_ready() {
        let (app, _dir) = test_app();
        ready_keys(&app);
        let (started, uri, nonce) = flow(&app).await;
        let cancel_app = app.clone();
        let result = callback_using(
            app.clone(),
            uri,
            |_, _| async { Ok(token(&nonce, true)) },
            || async {
                cancel(
                    State(cancel_app),
                    Json(CancelRequest {
                        transaction_id: started.transaction_id.clone(),
                        device_id: TEST_DEVICE.into(),
                        pkce_verifier: Zeroizing::new(TEST_VERIFIER.into()),
                    }),
                )
                .await
                .unwrap();
                Ok(signing(true).jwks.clone())
            },
        )
        .await;
        assert!(matches!(result, Err(ApiError::BadRequest)));
        assert!(matches!(
            poll(State(app), Json(poll_req(&started))).await,
            Err(ApiError::BadRequest)
        ));
    }
    #[tokio::test]
    async fn expiry_during_rotation_prevents_late_ready() {
        let (app, _dir) = test_app();
        ready_keys(&app);
        let (started, uri, nonce) = flow(&app).await;
        let result = callback_using(
            app.clone(),
            uri,
            |_, _| async { Ok(token(&nonce, true)) },
            || async {
                app.flow
                    .pending
                    .lock()
                    .unwrap()
                    .get_mut(&started.transaction_id)
                    .unwrap()
                    .expires_at = 0;
                Ok(signing(true).jwks.clone())
            },
        )
        .await;
        assert!(matches!(result, Err(ApiError::BadRequest)));
        assert!(matches!(
            poll(State(app), Json(poll_req(&started))).await,
            Err(ApiError::BadRequest)
        ));
    }
    #[tokio::test]
    async fn failed_refresh_is_terminal_and_cooldown_bounds_subsequent_attempts() {
        let (app, _dir) = test_app();
        ready_keys(&app);
        for attempt in 0..2 {
            let (started, uri, nonce) = flow(&app).await;
            assert!(matches!(
                callback_using(
                    app.clone(),
                    uri,
                    |_, _| async { Ok(token(&nonce, true)) },
                    || async {
                        assert_eq!(attempt, 0, "cooldown must prevent a second fetch");
                        Err(ApiError::Provider)
                    }
                )
                .await,
                Err(ApiError::Provider)
            ));
            assert!(matches!(
                poll(State(app.clone()), Json(poll_req(&started))).await,
                Err(ApiError::LoginFailed)
            ));
        }
        assert!(!app.verification.cache.lock().unwrap().refreshing);
    }
    #[tokio::test]
    async fn parallel_rotated_callbacks_share_one_bounded_refresh() {
        let (app, _dir) = test_app();
        ready_keys(&app);
        let (_, uri_a, nonce_a) = flow(&app).await;
        let (_, uri_b, nonce_b) = flow(&app).await;
        let loads = std::sync::atomic::AtomicUsize::new(0);
        let a = callback_using(
            app.clone(),
            uri_a,
            |_, _| async { Ok(token(&nonce_a, true)) },
            || async {
                loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(signing(true).jwks.clone())
            },
        );
        let b = callback_using(
            app.clone(),
            uri_b,
            |_, _| async { Ok(token(&nonce_b, true)) },
            || async {
                loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(signing(true).jwks.clone())
            },
        );
        let (a, b) = tokio::join!(a, b);
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(loads.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn dropping_exchange_or_refresh_marks_failure_and_releases_refresh_claim() {
        for during_refresh in [false, true] {
            let (app, _dir) = test_app();
            ready_keys(&app);
            let (started, uri, nonce) = flow(&app).await;
            let result = tokio::time::timeout(
                Duration::from_millis(10),
                callback_using(
                    app.clone(),
                    uri,
                    |_, _| async {
                        if during_refresh {
                            Ok(token(&nonce, true))
                        } else {
                            std::future::pending::<Result<CoreTokenResponse, ApiError>>().await
                        }
                    },
                    std::future::pending::<Result<CoreJsonWebKeySet, ApiError>>,
                ),
            )
            .await;
            assert!(result.is_err());
            assert!(!app.verification.cache.lock().unwrap().refreshing);
            assert!(matches!(
                poll(State(app), Json(poll_req(&started))).await,
                Err(ApiError::LoginFailed)
            ));
        }
    }
    #[tokio::test]
    async fn refresh_rejects_empty_keys_and_does_not_loop_on_unusable_new_keys() {
        for mode in 0..3 {
            let (app, _dir) = test_app();
            ready_keys(&app);
            let (started, uri, nonce) = flow(&app).await;
            let mut calls = 0;
            let result = callback_using(
                app.clone(),
                uri,
                |_, _| async { Ok(token(&nonce, true)) },
                || {
                    calls += 1;
                    async move {
                        Ok(match mode {
                            0 => serde_json::from_value(serde_json::json!({"keys":[]})).unwrap(),
                            1 => signing(false).jwks.clone(),
                            _ => {
                                let value = serde_json::to_value(&signing(false).jwks).unwrap();
                                serde_json::from_value(
                                    serde_json::json!({"keys":vec![value["keys"][0].clone();33]}),
                                )
                                .unwrap()
                            }
                        })
                    }
                },
            )
            .await;
            assert!(matches!(result, Err(ApiError::Provider)));
            assert_eq!(calls, 1);
            assert!(matches!(
                poll(State(app), Json(poll_req(&started))).await,
                Err(ApiError::LoginFailed)
            ));
        }
    }
}
