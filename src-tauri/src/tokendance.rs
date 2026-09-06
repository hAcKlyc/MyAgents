//! TokenDance's transient desktop authorization and account API boundary.
//! Credentials remain in config.json. Neither payment orders nor auth flows
//! are restored after app exit.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::Html,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{
    future::{AbortHandle, AbortRegistration, Abortable},
    StreamExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const PROVIDER: &str = "tokendance";
const ORIGIN: &str = "https://tokendance.space";
const APP_URL: &str = "https://myagents.io";
const BACKGROUND_WAIT: Duration = Duration::from_secs(15 * 60);
const RESPONSE_LIMIT: usize = 256 * 1024;

pub(crate) fn attribution_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-app-url",
        reqwest::header::HeaderValue::from_static(APP_URL),
    );
    headers
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDanceError {
    code: String,
    message: String,
    recovery_action: Option<String>,
    account_version: Option<String>,
}

fn error(code: &str) -> TokenDanceError {
    TokenDanceError {
        code: code.into(),
        message: code.into(),
        recovery_action: None,
        account_version: None,
    }
}

fn config_path() -> Result<PathBuf, TokenDanceError> {
    crate::app_dirs::myagents_data_dir()
        .map(|p| p.join("config.json"))
        .ok_or_else(|| error("config_unavailable"))
}

fn key_version(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}

fn config_key(config: &Value) -> &str {
    config
        .get("providerApiKeys")
        .and_then(|v| v.get(PROVIDER))
        .and_then(Value::as_str)
        .unwrap_or("")
}

async fn current_key() -> Result<(Zeroizing<String>, String), TokenDanceError> {
    let path = config_path()?;
    tokio::task::spawn_blocking(move || {
        let config =
            crate::config_io::read_config_json(&path).map_err(|_| error("config_unavailable"))?;
        let key = config_key(&config).trim().to_owned();
        let version = key_version(&key);
        Ok((Zeroizing::new(key), version))
    })
    .await
    .map_err(|_| error("config_unavailable"))?
}

fn client() -> Result<reqwest::Client, TokenDanceError> {
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .default_headers(attribution_headers())
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    crate::proxy_config::build_client_with_proxy_for_provider(builder, PROVIDER)
        .map_err(|_| error("network_error"))
}

async fn read_response(
    response: reqwest::Response,
    version: Option<&str>,
) -> Result<Value, TokenDanceError> {
    if !response.status().is_success() {
        let mut failure = error(if response.status().as_u16() == 429 {
            "rate_limited"
        } else {
            "request_failed"
        });
        failure.account_version = version.map(str::to_owned);
        failure.recovery_action = response
            .headers()
            .get("TokenDance-Recovery-Action")
            .and_then(|v| v.to_str().ok())
            .filter(|v| {
                matches!(
                    *v,
                    "top_up_balance" | "reauthorize_api_key" | "api_key_quota"
                )
            })
            .map(str::to_owned);
        return Err(failure);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| error("network_error"))?;
        if body.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(error("invalid_response"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| error("invalid_response"))
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthPhase {
    Waiting,
    Exchanging,
    Saving,
    SaveFailed,
    Failed,
    Expired,
    Connected,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    id: String,
    phase: AuthPhase,
    auth_url: String,
    error: Option<TokenDanceError>,
}

struct AuthFlow {
    view: AuthView,
    verifier: Zeroizing<String>,
    pending_key: Option<Zeroizing<String>>,
    original_version: String,
    viewers: HashSet<String>,
    closed_at: Option<Instant>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl AuthFlow {
    fn expired(&self, now: Instant) -> bool {
        self.view.phase == AuthPhase::Waiting
            && self.viewers.is_empty()
            && self
                .closed_at
                .is_some_and(|closed| now.duration_since(closed) >= BACKGROUND_WAIT)
    }
    fn stop_listener(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    fn close_viewer(&mut self, viewer: &str, now: Instant) {
        if self.viewers.remove(viewer) && self.viewers.is_empty() {
            self.closed_at = Some(now);
        }
    }
    fn accept_callback(&mut self, now: Instant) -> Option<Zeroizing<String>> {
        if self.expired(now) || self.view.phase != AuthPhase::Waiting {
            return None;
        }
        self.view.phase = AuthPhase::Exchanging;
        let verifier = self.verifier.clone();
        self.verifier.zeroize();
        self.stop_listener();
        Some(verifier)
    }
    fn finish_save(&mut self, result: Result<(), TokenDanceError>) {
        match result {
            Ok(()) => {
                self.view.phase = AuthPhase::Connected;
                self.view.error = None;
                self.pending_key = None;
            }
            Err(e) => {
                if e.code == "account_changed" {
                    // The flow's original credential can never win this CAS
                    // again. Discard its key and offer fresh authorization.
                    self.view.phase = AuthPhase::Failed;
                    self.pending_key = None;
                } else {
                    self.view.phase = AuthPhase::SaveFailed;
                }
                self.view.error = Some(e);
            }
        }
    }
}
impl Drop for AuthFlow {
    fn drop(&mut self) {
        self.stop_listener();
    }
}

fn auth() -> &'static AsyncMutex<Option<AuthFlow>> {
    static AUTH: OnceLock<AsyncMutex<Option<AuthFlow>>> = OnceLock::new();
    AUTH.get_or_init(|| AsyncMutex::new(None))
}

fn publish(app: &AppHandle, view: &AuthView) {
    let _ = app.emit("tokendance:auth-changed", view);
}

#[derive(Clone)]
struct CallbackContext {
    app: AppHandle,
    id: String,
    host: String,
}

async fn callback(
    State(context): State<CallbackContext>,
    headers: HeaderMap,
    uri: Uri,
) -> (StatusCode, Html<&'static str>) {
    let pairs: Vec<_> = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).collect();
    let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
    if headers.get("host").and_then(|v| v.to_str().ok()) != Some(context.host.as_str())
        || codes.len() != 1
        || codes[0].1.is_empty()
        || codes[0].1.len() > 4096
    {
        return (
            StatusCode::BAD_REQUEST,
            Html("Invalid authorization callback."),
        );
    }
    let code = Zeroizing::new(codes[0].1.to_string());
    let verifier;
    {
        let mut state = auth().lock().await;
        let Some(flow) = state.as_mut().filter(|f| f.view.id == context.id) else {
            return (
                StatusCode::GONE,
                Html("Authorization is no longer active. Return to MyAgents."),
            );
        };
        let Some(accepted_verifier) = flow.accept_callback(Instant::now()) else {
            return (
                StatusCode::GONE,
                Html("Authorization is no longer active. Return to MyAgents."),
            );
        };
        verifier = accepted_verifier;
        publish(&context.app, &flow.view);
    }
    tauri::async_runtime::spawn(async move {
        let result = async {
            let response = client()?.post(format!("{ORIGIN}/portal/api/v1/auth/keys"))
                .json(&json!({ "code": code.as_str(), "code_verifier": verifier.as_str(), "code_challenge_method": "S256" }))
                .send().await.map_err(|_| error("exchange_failed"))?;
            let body = read_response(response, None).await?;
            let key = body.get("key").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                .ok_or_else(|| error("invalid_response"))?;
            Ok::<_, TokenDanceError>(Zeroizing::new(key.to_string()))
        }.await;
        {
            let mut state = auth().lock().await;
            let Some(flow) = state.as_mut().filter(|f| f.view.id == context.id) else {
                return;
            };
            match result {
                Ok(key) => {
                    flow.pending_key = Some(key);
                    flow.view.phase = AuthPhase::Saving;
                }
                Err(failure) => {
                    flow.view.phase = AuthPhase::Failed;
                    flow.view.error = Some(failure);
                }
            }
            publish(&context.app, &flow.view);
            if flow.view.phase != AuthPhase::Saving {
                return;
            }
        }
        save_key(context.app, context.id).await;
    });
    (StatusCode::OK, Html("<!doctype html><meta charset=utf-8><title>MyAgents</title><p>授权已接收，请返回 MyAgents 查看连接结果。<br>Authorization received. Return to MyAgents to finish connecting.</p>"))
}

fn persist_key(
    path: &std::path::Path,
    key: &str,
    original_version: &str,
) -> Result<(), TokenDanceError> {
    crate::config_io::with_config_lock(path, false, |config| {
        let existing = config_key(config).trim();
        if existing != key && key_version(existing) != original_version {
            return Err("account_changed".into());
        }
        let root = config.as_object_mut().ok_or("invalid_config")?;
        let keys = root.entry("providerApiKeys").or_insert_with(|| json!({}));
        keys.as_object_mut()
            .ok_or("invalid_config")?
            .insert(PROVIDER.into(), json!(key));
        // Model verification describes the previous credential; login itself
        // must never invent a successful model probe.
        if let Some(statuses) = root
            .get_mut("providerVerifyStatus")
            .and_then(Value::as_object_mut)
        {
            statuses.remove(PROVIDER);
        }
        Ok(())
    })
    .map(|_| ())
    .map_err(|e| {
        error(if e.contains("account_changed") {
            "account_changed"
        } else {
            "save_failed"
        })
    })
}

async fn save_key(app: AppHandle, id: String) {
    let (key, original) = {
        let state = auth().lock().await;
        let Some(flow) = state
            .as_ref()
            .filter(|f| f.view.id == id && f.view.phase == AuthPhase::Saving)
        else {
            return;
        };
        let Some(key) = &flow.pending_key else {
            return;
        };
        (key.clone(), flow.original_version.clone())
    };
    let result = match config_path() {
        Ok(path) => tokio::task::spawn_blocking(move || persist_key(&path, &key, &original))
            .await
            .unwrap_or_else(|_| Err(error("save_failed"))),
        Err(e) => Err(e),
    };
    let mut state = auth().lock().await;
    let Some(flow) = state.as_mut().filter(|f| f.view.id == id) else {
        return;
    };
    flow.finish_save(result);
    if flow.view.phase == AuthPhase::Connected {
        let _ = app.emit("app:config-changed", ());
    }
    publish(&app, &flow.view);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAuthResult {
    view: AuthView,
    is_new: bool,
}

#[tauri::command]
pub async fn cmd_tokendance_auth_open(
    app: AppHandle,
    viewer_id: String,
    fresh: bool,
) -> Result<OpenAuthResult, TokenDanceError> {
    let (_, original_version) = current_key().await?;
    let mut state = auth().lock().await;
    if let Some(flow) = state.as_mut() {
        if flow.expired(Instant::now()) {
            flow.view.phase = AuthPhase::Expired;
            flow.stop_listener();
        }
        let active = matches!(
            flow.view.phase,
            AuthPhase::Waiting | AuthPhase::Exchanging | AuthPhase::Saving
        );
        if active || (!fresh && flow.view.phase == AuthPhase::SaveFailed) {
            flow.viewers.insert(viewer_id);
            flow.closed_at = None;
            return Ok(OpenAuthResult {
                view: flow.view.clone(),
                is_new: false,
            });
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| error("listener_failed"))?;
    let host = listener
        .local_addr()
        .map_err(|_| error("listener_failed"))?
        .to_string();
    let id = Uuid::new_v4().to_string();
    let verifier = Zeroizing::new(format!("{}{}", Uuid::new_v4(), Uuid::new_v4()));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let path = format!("/callback/{id}");
    let mut url = url::Url::parse(&format!("{ORIGIN}/auth")).map_err(|_| error("invalid_url"))?;
    url.query_pairs_mut()
        .append_pair("callback_url", &format!("http://{host}{path}"))
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("app_url", APP_URL)
        .append_pair("key_name", "MyAgents");
    let view = AuthView {
        id: id.clone(),
        phase: AuthPhase::Waiting,
        auth_url: url.to_string(),
        error: None,
    };
    let (shutdown, stopped) = oneshot::channel();
    *state = Some(AuthFlow {
        view: view.clone(),
        verifier,
        pending_key: None,
        original_version,
        viewers: HashSet::from([viewer_id]),
        closed_at: None,
        shutdown: Some(shutdown),
    });
    let router = Router::new()
        .route(&path, get(callback))
        .with_state(CallbackContext {
            app: app.clone(),
            id: id.clone(),
            host,
        });
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await;
    });
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let mut state = auth().lock().await;
            let Some(flow) = state
                .as_mut()
                .filter(|f| f.view.id == id && f.view.phase == AuthPhase::Waiting)
            else {
                break;
            };
            if flow.expired(Instant::now()) {
                flow.view.phase = AuthPhase::Expired;
                flow.stop_listener();
                publish(&app, &flow.view);
                break;
            }
        }
    });
    Ok(OpenAuthResult { view, is_new: true })
}

#[tauri::command]
pub async fn cmd_tokendance_auth_status() -> Option<AuthView> {
    auth().lock().await.as_ref().map(|flow| flow.view.clone())
}

#[tauri::command]
pub async fn cmd_tokendance_auth_close(viewer_id: String) {
    if let Some(flow) = auth().lock().await.as_mut() {
        flow.close_viewer(&viewer_id, Instant::now());
    }
}

#[tauri::command]
pub async fn cmd_tokendance_auth_retry_save(
    app: AppHandle,
    id: String,
) -> Result<(), TokenDanceError> {
    {
        let mut state = auth().lock().await;
        let flow = state
            .as_mut()
            .filter(|f| f.view.id == id && f.view.phase == AuthPhase::SaveFailed)
            .ok_or_else(|| error("authorization_inactive"))?;
        flow.view.phase = AuthPhase::Saving;
        flow.view.error = None;
        publish(&app, &flow.view);
    }
    save_key(app, id).await;
    Ok(())
}

async fn account_request(
    path: &str,
    expected_version: &str,
    amount: Option<u32>,
) -> Result<(Value, String), TokenDanceError> {
    let (key, version) = current_key().await?;
    if key.is_empty() {
        return Err(error("not_connected"));
    }
    if version != expected_version {
        return Err(error("account_changed"));
    }
    let client = client()?;
    let url = format!("{ORIGIN}/portal/api/v1/{path}");
    let request = if let Some(amount) = amount {
        client.post(url).json(&json!({"amount": amount}))
    } else {
        client.get(url)
    };
    let response = request
        .bearer_auth(key.as_str())
        .send()
        .await
        .map_err(|_| error("network_error"))?;
    Ok((read_response(response, Some(&version)).await?, version))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceView {
    account_version: String,
    balance: i64,
    credits: i64,
    credits_used: i64,
}

#[tauri::command]
pub async fn cmd_tokendance_balance(
    account_version: String,
) -> Result<BalanceView, TokenDanceError> {
    let (body, version) = account_request("user/balance", &account_version, None).await?;
    let balance = body
        .get("balance")
        .ok_or_else(|| error("invalid_response"))?;
    Ok(BalanceView {
        account_version: version,
        balance: balance
            .get("balance")
            .and_then(Value::as_i64)
            .ok_or_else(|| error("invalid_response"))?,
        credits: balance
            .get("credits")
            .and_then(Value::as_i64)
            .ok_or_else(|| error("invalid_response"))?,
        credits_used: balance
            .get("credits_used")
            .and_then(Value::as_i64)
            .ok_or_else(|| error("invalid_response"))?,
    })
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PaymentSession {
    id: String,
    amount: u32,
    status: String,
    payment_url: Option<String>,
    status_url: String,
    expired_at: i64,
    created_at: i64,
    paid_at: Option<i64>,
}

fn validate_session(
    body: Value,
    amount: Option<u32>,
    id: Option<&str>,
) -> Result<PaymentSession, TokenDanceError> {
    let session: PaymentSession =
        serde_json::from_value(body.get("session").cloned().unwrap_or(Value::Null))
            .map_err(|_| error("invalid_response"))?;
    if session.id.is_empty()
        || session.id.len() > 256
        || session
            .id
            .chars()
            .any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        || !(1..=100_000).contains(&session.amount)
        || amount.is_some_and(|a| session.amount != a)
        || id.is_some_and(|id| session.id != id)
        || !matches!(
            session.status.as_str(),
            "pending" | "paid" | "failed" | "closed" | "refunded"
        )
        || session.status_url != format!("{ORIGIN}/portal/api/v1/payment/sessions/{}", session.id)
        || session.expired_at <= session.created_at
        || (session.status == "pending"
            && !session
                .payment_url
                .as_ref()
                .is_some_and(|u| !u.is_empty() && u.len() <= 8192))
    {
        return Err(error("invalid_response"));
    }
    Ok(session)
}

struct PaymentRequest {
    abort: AbortHandle,
    registration: Option<AbortRegistration>,
    reserved_at: Instant,
}

type PaymentRequests = HashMap<String, PaymentRequest>;

fn payment_requests() -> &'static Mutex<PaymentRequests> {
    static REQUESTS: OnceLock<Mutex<PaymentRequests>> = OnceLock::new();
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn reserve_payment_request(
    requests: &mut PaymentRequests,
    now: Instant,
) -> Result<String, TokenDanceError> {
    // Unclaimed reservations may outlive a closed WebView. Expiry rejects late
    // admission; it never makes cancelled requests eligible to run again.
    requests.retain(|_, request| {
        request.registration.is_none()
            || now.duration_since(request.reserved_at) < Duration::from_secs(30)
    });
    if requests.len() >= 16 {
        return Err(error("request_busy"));
    }
    let id = Uuid::new_v4().to_string();
    let (abort, registration) = AbortHandle::new_pair();
    requests.insert(
        id.clone(),
        PaymentRequest {
            abort,
            registration: Some(registration),
            reserved_at: now,
        },
    );
    Ok(id)
}

fn claim_payment_request(
    requests: &mut PaymentRequests,
    id: &str,
    now: Instant,
) -> Result<AbortRegistration, TokenDanceError> {
    let request = requests
        .get_mut(id)
        .ok_or_else(|| error("request_cancelled"))?;
    if now.duration_since(request.reserved_at) >= Duration::from_secs(30)
        && request.registration.is_some()
    {
        requests.remove(id);
        return Err(error("request_cancelled"));
    }
    request
        .registration
        .take()
        .ok_or_else(|| error("request_busy"))
}

fn cancel_payment_request(requests: &mut PaymentRequests, id: &str) {
    if let Some(request) = requests.remove(id) {
        request.abort.abort();
    }
}

// Registration is acknowledged before the async payment command is submitted.
// Cancelling before that command is first polled must also prevent admission.
#[tauri::command]
pub fn cmd_tokendance_prepare_payment_request() -> Result<String, TokenDanceError> {
    reserve_payment_request(
        &mut payment_requests().lock().unwrap_or_else(|e| e.into_inner()),
        Instant::now(),
    )
}

#[tauri::command]
pub async fn cmd_tokendance_payment(
    request_id: String,
    account_version: String,
    amount: Option<u32>,
    session_id: Option<String>,
) -> Result<PaymentSession, TokenDanceError> {
    if Uuid::parse_str(&request_id).is_err()
        || (amount.is_some() == session_id.is_some())
        || amount.is_some_and(|a| !(1..=100_000).contains(&a))
        || session_id.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.len() > 256
                || id
                    .chars()
                    .any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        })
    {
        return Err(error("invalid_request"));
    }
    let registration = {
        let mut requests = payment_requests().lock().unwrap_or_else(|e| e.into_inner());
        claim_payment_request(&mut requests, &request_id, Instant::now())?
    };
    let result = Abortable::new(
        async {
            let path = session_id
                .as_ref()
                .map(|id| format!("payment/sessions/{id}"))
                .unwrap_or_else(|| "payment/sessions".into());
            let (body, _) = account_request(&path, &account_version, amount).await?;
            validate_session(body, amount, session_id.as_deref())
        },
        registration,
    )
    .await
    .unwrap_or_else(|_| Err(error("request_cancelled")));
    payment_requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&request_id);
    result
}

#[tauri::command]
pub fn cmd_tokendance_cancel_payment_request(request_id: String) {
    cancel_payment_request(
        &mut payment_requests().lock().unwrap_or_else(|e| e.into_inner()),
        &request_id,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn model_catalog_pins_attribution_without_affecting_other_providers() {
        let (sender, mut received) = tokio::sync::mpsc::channel(2);
        let router = Router::new().route(
            "/models",
            get(move |headers: HeaderMap| {
                let sender = sender.clone();
                async move {
                    sender
                        .send(
                            headers
                                .get("x-app-url")
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_owned),
                        )
                        .await
                        .unwrap();
                    axum::Json(json!({"data": []}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/models", listener.local_addr().unwrap());
        let (stop, stopped) = oneshot::channel::<()>();
        let server = tauri::async_runtime::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let result = crate::commands::cmd_fetch_provider_models(
            url.clone(),
            PROVIDER.into(),
            None,
            None,
            Some(HashMap::from([(
                "X-App-URL".into(),
                "https://wrong.example".into(),
            )])),
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(
            received.recv().await.unwrap().as_deref(),
            Some("https://myagents.io")
        );
        assert!(crate::commands::cmd_fetch_provider_models(
            url,
            "other-provider".into(),
            None,
            None,
            None
        )
        .await
        .is_ok());
        assert_eq!(received.recv().await.unwrap(), None);
        let _ = stop.send(());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn payment_cancellation_prevents_late_admission_and_aborts_claimed_work() {
        let now = Instant::now();
        let mut requests = PaymentRequests::new();
        let id = reserve_payment_request(&mut requests, now).ok().unwrap();
        cancel_payment_request(&mut requests, &id);
        assert!(claim_payment_request(&mut requests, &id, now).is_err());

        let id = reserve_payment_request(&mut requests, now).ok().unwrap();
        let registration = claim_payment_request(&mut requests, &id, now).ok().unwrap();
        assert!(claim_payment_request(&mut requests, &id, now).is_err());
        cancel_payment_request(&mut requests, &id);
        let mut entered = false;
        let result = Abortable::new(
            async {
                entered = true;
            },
            registration,
        )
        .await;
        assert!(result.is_err());
        assert!(!entered);
        assert!(requests.is_empty());
    }

    #[test]
    fn abandoned_payment_reservations_expire_without_readmission() {
        let now = Instant::now();
        let mut requests = PaymentRequests::new();
        let old = reserve_payment_request(&mut requests, now).ok().unwrap();
        assert!(claim_payment_request(&mut requests, &old, now + Duration::from_secs(30)).is_err());
        assert!(requests.is_empty());
        for _ in 0..16 {
            reserve_payment_request(&mut requests, now).ok().unwrap();
        }
        assert!(reserve_payment_request(&mut requests, now).is_err());
        assert!(reserve_payment_request(&mut requests, now + Duration::from_secs(30)).is_ok());
        assert_eq!(requests.len(), 1);
        assert!(claim_payment_request(&mut requests, &old, now + Duration::from_secs(60)).is_err());
    }

    fn flow() -> AuthFlow {
        AuthFlow {
            view: AuthView {
                id: "flow".into(),
                phase: AuthPhase::Waiting,
                auth_url: String::new(),
                error: None,
            },
            verifier: Zeroizing::new("verifier".into()),
            pending_key: None,
            original_version: key_version(""),
            viewers: HashSet::from(["window".into()]),
            closed_at: None,
            shutdown: None,
        }
    }

    #[test]
    fn visible_authorization_stays_alive_and_last_close_has_fifteen_minutes() {
        let start = Instant::now();
        let mut f = flow();
        assert!(!f.expired(start + BACKGROUND_WAIT * 3));
        f.viewers.insert("second".into());
        f.close_viewer("window", start);
        assert!(!f.expired(start + BACKGROUND_WAIT * 3));
        f.close_viewer("second", start);
        f.close_viewer("second", start + Duration::from_secs(20));
        assert!(!f.expired(start + BACKGROUND_WAIT - Duration::from_secs(1)));
        assert!(f.expired(start + BACKGROUND_WAIT));
        assert!(f.accept_callback(start + BACKGROUND_WAIT).is_none());
    }

    #[test]
    fn reopening_reuses_flow_and_callback_is_consumed_once_without_saving_timeout() {
        let start = Instant::now();
        let mut f = flow();
        f.close_viewer("window", start);
        f.viewers.insert("window".into());
        f.closed_at = None;
        assert!(!f.expired(start + BACKGROUND_WAIT * 3));
        f.close_viewer("window", start + BACKGROUND_WAIT * 3);
        assert_eq!(
            f.accept_callback(start + BACKGROUND_WAIT * 3)
                .as_deref()
                .map(String::as_str),
            Some("verifier")
        );
        assert!(f.verifier.is_empty());
        assert!(f.accept_callback(start).is_none());
        assert!(!f.expired(start + BACKGROUND_WAIT * 10));
    }

    #[test]
    fn key_save_merges_latest_config_and_does_not_overwrite_a_newer_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, json!({"providerApiKeys":{"other":"unrelated"}, "providerVerifyStatus":{"tokendance":{"status":"valid"},"other":{"status":"valid"}},"presetCustomModels":{"tokendance":[{"model":"added"}]},"uiLanguage":"en-US"}).to_string()).unwrap();
        assert!(persist_key(&path, "first", &key_version("")).is_ok());
        let saved = crate::config_io::read_config_json(&path).unwrap();
        assert_eq!(config_key(&saved), "first");
        assert_eq!(saved["providerApiKeys"]["other"], "unrelated");
        assert_eq!(
            saved["presetCustomModels"]["tokendance"][0]["model"],
            "added"
        );
        assert_eq!(saved["uiLanguage"], "en-US");
        assert!(saved["providerVerifyStatus"].get("tokendance").is_none());
        // A write that became visible before a durability error can be retried.
        assert!(persist_key(&path, "first", &key_version("")).is_ok());
        let failure = persist_key(&path, "late", &key_version("")).err().unwrap();
        assert_eq!(failure.code, "account_changed");
        assert_eq!(
            config_key(&crate::config_io::read_config_json(&path).unwrap()),
            "first"
        );
    }

    #[test]
    fn account_conflict_ends_old_authorization_instead_of_retrying_its_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut f = flow();
        f.view.phase = AuthPhase::Saving;
        f.pending_key = Some(Zeroizing::new("old-flow-key".into()));
        std::fs::write(
            &path,
            json!({"providerApiKeys":{"tokendance":"replacement"}}).to_string(),
        )
        .unwrap();

        f.finish_save(persist_key(&path, "old-flow-key", &f.original_version));

        assert!(f.view.phase == AuthPhase::Failed);
        assert_eq!(f.view.error.as_ref().unwrap().code, "account_changed");
        assert!(f.pending_key.is_none());
        assert_eq!(
            config_key(&crate::config_io::read_config_json(&path).unwrap()),
            "replacement"
        );
    }

    #[test]
    fn disk_save_failure_preserves_key_for_retry_and_success_clears_it() {
        let mut f = flow();
        f.view.phase = AuthPhase::Saving;
        f.pending_key = Some(Zeroizing::new("retry-key".into()));
        f.finish_save(Err(error("save_failed")));
        assert!(f.view.phase == AuthPhase::SaveFailed);
        assert_eq!(
            f.pending_key.as_deref().map(String::as_str),
            Some("retry-key")
        );
        f.finish_save(Ok(()));
        assert!(f.view.phase == AuthPhase::Connected);
        assert!(f.view.error.is_none());
        assert!(f.pending_key.is_none());
    }

    fn payment() -> Value {
        json!({"session":{"id":"test-1","amount":50,"status":"pending","payment_url":"https://pay.example.test/test", "status_url":format!("{ORIGIN}/portal/api/v1/payment/sessions/test-1"),"created_at":100,"expired_at":700}})
    }

    #[test]
    fn payment_response_binds_id_amount_origin_status_and_expiry() {
        assert!(validate_session(payment(), Some(50), None).is_ok());
        assert!(validate_session(payment(), Some(100), None).is_err());
        assert!(validate_session(payment(), None, Some("old-id")).is_err());
        for (key, value) in [
            ("status_url", json!("https://foreign.test/status")),
            ("status", json!("unknown")),
            ("expired_at", json!(99)),
            ("payment_url", Value::Null),
            ("id", json!("../escape")),
        ] {
            let mut body = payment();
            body["session"][key] = value;
            assert!(validate_session(body, None, None).is_err());
        }
    }
}
