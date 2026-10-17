use crate::{
    AccountProjection, AuthError, AuthStore,
    admin_store::{AdminConfig, AdminStore},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
pub struct AdminService {
    pub(crate) auth: Arc<AuthStore>,
    pub(crate) store: Arc<AdminStore>,
    pub(crate) config: Arc<AdminConfig>,
    models: Option<Arc<crate::model_center_store::ModelCenterStore>>,
    execution: Option<Arc<crate::execution_store::ExecutionStore>>,
    pub(crate) origin: String,
    in_flight: Arc<Semaphore>,
}
impl AdminService {
    pub fn open(
        auth: Arc<AuthStore>,
        dir: &std::path::Path,
        config: AdminConfig,
        origin: String,
        network_id: &str,
    ) -> Result<Self, AuthError> {
        config.validate().map_err(|_| AuthError::Configuration)?;
        let store = AdminStore::open(dir, network_id).map_err(|_| AuthError::Storage)?;
        Ok(Self {
            auth,
            store: Arc::new(store),
            config: Arc::new(config),
            execution: None,
            models: None,
            origin,
            in_flight: Arc::new(Semaphore::new(32)),
        })
    }
    pub(crate) fn connect_execution(
        &mut self,
        ledger: Arc<crate::execution_store::ExecutionStore>,
    ) {
        self.execution = Some(ledger);
    }
    pub(crate) fn connect_models(
        &mut self,
        store: Arc<crate::model_center_store::ModelCenterStore>,
    ) {
        self.models = Some(store);
    }
    pub(crate) fn effective_config(&self) -> Result<AdminConfig, Err> {
        match &self.models {
            Some(store) => self.config.with_managed_models(store).map_err(|_| {
                Err::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "MODEL_CENTER_STORAGE_UNAVAILABLE",
                )
            }),
            None => Ok((*self.config).clone()),
        }
    }
    pub fn router(&self) -> Router<()> {
        let s = Arc::new(self.clone());
        Router::new()
            .route("/admin", get(admin_page))
            .route("/admin/app.js", get(js))
            .route("/admin/styles.css", get(css))
            .route("/admin/feedback.js", get(feedback_js))
            .route("/api/admin/bootstrap", get(bootstrap))
            .route("/api/admin/bots", post(create))
            .route("/api/admin/bots/{id}", patch(configure))
            .route("/api/admin/bots/{id}/assign", post(assign))
            .route("/api/admin/bots/{id}/start", post(start))
            .route("/api/admin/bots/{id}/stop", post(stop))
            .route("/api/admin/bots/{id}/delete", post(delete))
            .route("/api/admin/bots/{id}/restore", post(restore))
            .route("/api/admin/mutations/{id}", get(mutation))
            .layer(DefaultBodyLimit::max(16 * 1024))
            .layer(middleware::from_fn(no_store))
            .with_state(s)
    }
}
async fn admin_page() -> Response {
    asset(
        include_str!("../admin-web/index.html"),
        "text/html; charset=utf-8",
    )
}
async fn js() -> Response {
    asset(
        include_str!("../admin-web/app.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn css() -> Response {
    asset(
        include_str!("../admin-web/styles.css"),
        "text/css; charset=utf-8",
    )
}
async fn feedback_js() -> Response {
    asset(
        include_str!("../admin-web/feedback.js"),
        "text/javascript; charset=utf-8",
    )
}
fn asset(s: &'static str, kind: &'static str) -> Response {
    let mut r = s.into_response();
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    r
}
async fn bootstrap(State(s): State<Arc<AdminService>>, h: HeaderMap) -> Result<Json<Value>, Err> {
    let origin = h
        .get(header::ORIGIN)
        .and_then(|x| x.to_str().ok())
        .map(str::to_owned);
    let out=blocking_admin(s.clone(),h,origin,move|actor,accounts|{
  let users=accounts.iter().map(|x|json!({"principal_id":x.principal_id,"network_id":x.network_id})).collect::<Vec<_>>();
  let hosts=s.config.hosts.iter().map(|x|json!({"id":x.id,"name":x.name,"owner_ids":x.owner_ids,"runtimes":x.runtimes,"execution_connected":false,"state":"not_connected"})).collect::<Vec<_>>();
  let config=s.effective_config()?;
  let models=config.model_refs.iter().map(|x|json!({"id":x.id,"label":x.name,"owner_ids":x.owner_ids,"runtimes":x.runtimes})).collect::<Vec<_>>();
  let bots=s.store.bots().map_err(|_|Err::new(StatusCode::SERVICE_UNAVAILABLE,"ADMIN_STORAGE_UNAVAILABLE"))?;
  let audit=s.store.audit().map_err(|_|Err::new(StatusCode::SERVICE_UNAVAILABLE,"ADMIN_STORAGE_UNAVAILABLE"))?;
  let execution=if let Some(exec)=&s.execution {
      let rows=exec.grants().map_err(|_|Err::new(StatusCode::SERVICE_UNAVAILABLE,"EXECUTION_STORAGE_UNAVAILABLE"))?;
      let mut records=Vec::new();
      for row in rows {
          let snapshot=exec.known_bot_snapshot(&row.grant.scope,&row.grant.bot_id).map_err(|_|Err::new(StatusCode::SERVICE_UNAVAILABLE,"EXECUTION_STORAGE_UNAVAILABLE"))?;
          records.push(json!({"grant":row.grant,"state":row.state,"snapshot":snapshot}));
      }
      let reports=exec.public_observations().map_err(|_|Err::new(StatusCode::SERVICE_UNAVAILABLE,"EXECUTION_STORAGE_UNAVAILABLE"))?;
      let reports=reports.into_iter().filter(|row|s.config.hosts.iter().any(|host|host.id==row.host_id&&host.owner_ids.contains(&row.scope.host_owner_id))).collect::<Vec<_>>();
      json!({"enabled":true,"records":records,"hosts":reports,"invocation":false})
  }else{json!({"enabled":false,"records":[],"hosts":[],"invocation":false})};
  Ok(json!({"ok":true,"data":{"execution":execution,"principal_id":actor,"users":users,"hosts":hosts,"model_refs":models,"bots":bots,"audit":audit,"capabilities":{"sharing":false,"host_execution":s.execution.is_some(),"registry_only":s.execution.is_none(),"max_daily_tokens":s.config.max_daily_tokens}}}))
 }).await?;
    Ok(Json(out))
}
async fn create(
    State(s): State<Arc<AdminService>>,
    h: HeaderMap,
    Json(mut b): Json<Value>,
) -> Result<Json<Value>, Err> {
    ensure_keys(
        &b,
        &[
            "mutation_id",
            "expected_revision",
            "name",
            "description",
            "owner_id",
            "host_id",
            "runtime",
            "model_ref",
            "system_prompt",
            "daily_tokens",
        ],
    )?;
    let id = mutation_id(&b)?;
    if b.get("expected_revision").and_then(Value::as_u64) != Some(0) {
        return Err(Err::bad());
    }
    uuid_field(&b, "owner_id")?;
    uuid_field(&b, "host_id")?;
    if let Some(v) = b.get("model_ref").filter(|v| !v.is_null()) {
        Uuid::parse_str(v.as_str().ok_or_else(Err::bad)?).map_err(|_| Err::bad())?;
    }
    b["id"] = json!(id.to_string());
    b["revision"] = json!(1);
    b["deleted"] = json!(false);
    b["state"] = json!("stopped");
    b["configured"] = json!(false);
    mutate(s, h, "create", id, b, None).await
}
async fn configure(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(mut b): Json<Value>,
) -> Result<Json<Value>, Err> {
    ensure_keys(
        &b,
        &[
            "mutation_id",
            "expected_revision",
            "name",
            "description",
            "runtime",
            "model_ref",
            "system_prompt",
            "daily_tokens",
        ],
    )?;
    let id = Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?;
    let op = mutation_id(&b)?;
    let rev = b.get("expected_revision").and_then(Value::as_u64);
    b["id"] = json!(id.to_string());
    if b.get("owner_id").is_some() || b.get("host_id").is_some() {
        return Err(Err::bad());
    }
    mutate(s, h, "configure", op, b, rev).await
}
async fn assign(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(mut b): Json<Value>,
) -> Result<Json<Value>, Err> {
    ensure_keys(
        &b,
        &[
            "mutation_id",
            "expected_revision",
            "owner_id",
            "host_id",
            "confirm_impact",
        ],
    )?;
    let id = Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?;
    let op = mutation_id(&b)?;
    let rev = b.get("expected_revision").and_then(Value::as_u64);
    let _owner = uuid_field(&b, "owner_id")?;
    let _host = uuid_field(&b, "host_id")?;
    b["id"] = json!(id.to_string());
    mutate(s, h, "assign", op, b, rev).await
}
async fn start(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Result<Json<Value>, Err> {
    simple(
        s,
        Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?,
        h,
        b,
        "start",
    )
    .await
}
async fn stop(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Result<Json<Value>, Err> {
    simple(
        s,
        Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?,
        h,
        b,
        "stop",
    )
    .await
}
async fn delete(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Result<Json<Value>, Err> {
    simple(
        s,
        Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?,
        h,
        b,
        "delete",
    )
    .await
}
async fn restore(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Result<Json<Value>, Err> {
    simple(
        s,
        Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?,
        h,
        b,
        "restore",
    )
    .await
}
async fn simple(
    s: Arc<AdminService>,
    id: Uuid,
    h: HeaderMap,
    mut b: Value,
    a: &'static str,
) -> Result<Json<Value>, Err> {
    let keys: &[&str] = match a {
        "delete" => &["mutation_id", "expected_revision", "confirm_name"],
        _ => &["mutation_id", "expected_revision"],
    };
    ensure_keys(&b, keys)?;
    let op = mutation_id(&b)?;
    let rev = b.get("expected_revision").and_then(Value::as_u64);
    b["id"] = json!(id.to_string());
    mutate(s, h, a, op, b, rev).await
}
async fn mutate(
    s: Arc<AdminService>,
    h: HeaderMap,
    a: &'static str,
    id: Uuid,
    b: Value,
    r: Option<u64>,
) -> Result<Json<Value>, Err> {
    let origin = h
        .get(header::ORIGIN)
        .and_then(|x| x.to_str().ok())
        .map(str::to_owned);
    let out = blocking_admin(s.clone(), h, origin, move |actor, accounts| {
        let users = accounts
            .iter()
            .map(|u| u.principal_id.clone())
            .collect::<Vec<_>>();
        if a != "create"
            && let Some(exec) = &s.execution
        {
            let target = b.get("id").and_then(Value::as_str).ok_or_else(Err::bad)?;
            if exec.bot_has_live_grant(target).map_err(|_| {
                Err::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "EXECUTION_STORAGE_UNAVAILABLE",
                )
            })? {
                return Err(Err::new(
                    StatusCode::CONFLICT,
                    "HOST_EXECUTION_MUTATION_REQUIRED",
                ));
            }
        }
        s.store
            .mutate(actor, a, id, &b, r, &s.effective_config()?, &users)
            .map_err(|(c, retry)| Err {
                status: if c == "HOST_EXECUTION_NOT_CONNECTED" {
                    StatusCode::CONFLICT
                } else if c == "BOT_NOT_FOUND" {
                    StatusCode::NOT_FOUND
                } else if c == "RESOURCE_ASSIGNMENT_FORBIDDEN" {
                    StatusCode::FORBIDDEN
                } else if c == "admin storage unavailable" {
                    StatusCode::SERVICE_UNAVAILABLE
                } else if c.contains("CONFLICT") || c.contains("REQUIRED") || c.contains("NAME_") {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::BAD_REQUEST
                },
                code: c,
                retryable: retry,
            })
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":out})))
}
async fn mutation(
    State(s): State<Arc<AdminService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
) -> Result<Json<Value>, Err> {
    let id = Uuid::parse_str(&raw_id).map_err(|_| Err::bad())?;
    let origin = h
        .get(header::ORIGIN)
        .and_then(|x| x.to_str().ok())
        .map(str::to_owned);
    let value = blocking_admin(s.clone(), h, origin, move |actor, _| {
        s.store
            .mutation(id, actor)
            .map_err(|_| Err::new(StatusCode::NOT_FOUND, "MUTATION_NOT_FOUND"))
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":value})))
}
pub(crate) async fn blocking_admin<T, F>(
    s: Arc<AdminService>,
    headers: HeaderMap,
    origin: Option<String>,
    operation: F,
) -> Result<T, Err>
where
    T: Send + 'static,
    F: FnOnce(&str, &[AccountProjection]) -> Result<T, Err> + Send + 'static,
{
    let permit = s
        .in_flight
        .clone()
        .try_acquire_owned()
        .map_err(|_| Err::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_CAPACITY"))?;
    if origin.as_deref().is_some_and(|v| v != s.origin) {
        return Err(Err::new(StatusCode::FORBIDDEN, "ORIGIN_REJECTED"));
    }
    let token = bearer(&headers)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let accounts = s.auth.registered_principals().map_err(Err::auth)?;
        s.auth.with_valid_session(&token, |p| {
            if !s
                .config
                .admin_principal_ids
                .iter()
                .any(|id| id == &p.account.principal_id)
            {
                return Err(Err::new(StatusCode::FORBIDDEN, "ADMIN_REQUIRED"));
            }
            operation(&p.account.principal_id, &accounts)
        })
    })
    .await
    .map_err(|_| Err::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_UNAVAILABLE"))?
}
fn mutation_id(v: &Value) -> Result<Uuid, Err> {
    Uuid::parse_str(
        v.get("mutation_id")
            .and_then(Value::as_str)
            .ok_or_else(Err::bad)?,
    )
    .map_err(|_| Err::bad())
}
fn ensure_keys(v: &Value, allowed: &[&str]) -> Result<(), Err> {
    if v.as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        Err(Err::bad())
    } else {
        Ok(())
    }
}
fn uuid_field(v: &Value, k: &str) -> Result<Uuid, Err> {
    Uuid::parse_str(v.get(k).and_then(Value::as_str).ok_or_else(Err::bad)?).map_err(|_| Err::bad())
}
fn bearer(h: &HeaderMap) -> Result<String, Err> {
    let mut i = h.get_all(header::AUTHORIZATION).iter();
    let v = i
        .next()
        .and_then(|x| x.to_str().ok())
        .filter(|x| x.starts_with("Bearer ") && x.len() > 7 && x.len() < 128)
        .ok_or_else(|| Err::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"))?;
    if i.next().is_some() {
        return Err(Err::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    Ok(v[7..].to_owned())
}
async fn no_store(req: Request<Body>, next: Next) -> Response {
    let mut r = next.run(req).await;
    if r.status().is_client_error() || r.status().is_server_error() {
        let is_json = r
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|x| x.to_str().ok())
            .is_some_and(|x| x.starts_with("application/json"));
        if !is_json {
            let status = r.status();
            let code = if status == StatusCode::PAYLOAD_TOO_LARGE {
                "REQUEST_TOO_LARGE"
            } else {
                "REQUEST_INVALID"
            };
            r = Err::new(status, code).into_response();
        }
    }
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    r.headers_mut().insert(header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
    r
}
#[derive(Debug)]
pub(crate) struct Err {
    pub(crate) status: StatusCode,
    pub(crate) code: &'static str,
    pub(crate) retryable: bool,
}
impl Err {
    pub(crate) fn new(status: StatusCode, code: &'static str) -> Self {
        Self {
            status,
            code,
            retryable: false,
        }
    }
    pub(crate) fn bad() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "REQUEST_INVALID")
    }
    pub(crate) fn auth(e: AuthError) -> Self {
        match e {
            AuthError::SessionRejected => Self::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            _ => Self::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_UNAVAILABLE"),
        }
    }
}
impl From<AuthError> for Err {
    fn from(e: AuthError) -> Self {
        Self::auth(e)
    }
}
impl IntoResponse for Err {
    fn into_response(self) -> Response {
        (self.status,Json(json!({"ok":false,"error":{"code":self.code,"message":self.code,"retryable":self.retryable}}))).into_response()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use axum::{
        body::Body,
        extract::{Path as AxumPath, State as AxumState},
        http::Request,
        response::Redirect,
        routing::{delete, post},
    };
    use base64::Engine;
    use sha2::Digest;
    use std::{collections::HashMap, fs, os::unix::fs::PermissionsExt, time::Duration};
    use tempfile::TempDir;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    const NETWORK: &str = "11111111-1111-4111-8111-111111111111";
    const HOST: &str = "22222222-2222-4222-8222-222222222222";
    const HOST_B: &str = "44444444-4444-4444-8444-444444444444";
    const MODEL: &str = "33333333-3333-4333-8333-333333333333";
    type PendingLogin = (String, String, String);

    #[derive(Clone)]
    struct BrowserFixture {
        auth: Arc<AuthStore>,
        subjects: HashMap<String, crate::VerifiedSubject>,
        pending: Arc<Mutex<HashMap<String, PendingLogin>>>,
        authorization_url: String,
    }

    pub(crate) fn browser_fixture_router(
        auth: Arc<AuthStore>,
        subjects: HashMap<String, crate::VerifiedSubject>,
        authorization_url: String,
    ) -> Router {
        let fixture = BrowserFixture {
            auth,
            subjects,
            pending: Arc::new(Mutex::new(HashMap::new())),
            authorization_url,
        };
        Router::new()
            .route("/auth/login/start", post(fixture_login_start))
            .route("/auth/login/poll", post(fixture_login_poll))
            .route("/auth/session", delete(fixture_revoke))
            .route("/fixture-login", get(fixture_login_page))
            .route("/fixture-identity/{identity}", get(fixture_identity))
            .with_state(fixture)
    }
    async fn fixture_login_start(
        AxumState(s): AxumState<BrowserFixture>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, Err> {
        ensure_keys(&body, &["deviceId", "pkceChallenge", "browserReturn"])?;
        let device = body["deviceId"].as_str().ok_or_else(Err::bad)?;
        let challenge = body["pkceChallenge"].as_str().ok_or_else(Err::bad)?;
        if Uuid::parse_str(device).is_err() || challenge.len() != 43 {
            return Err(Err::bad());
        }
        let identity = headers
            .get(header::COOKIE)
            .and_then(|x| x.to_str().ok())
            .and_then(|cookie| {
                cookie
                    .split(';')
                    .find_map(|part| part.trim().strip_prefix("fixture_identity="))
            })
            .unwrap_or("admin");
        if !s.subjects.contains_key(identity) {
            return Err(Err::bad());
        }
        let tx = Uuid::new_v4().to_string();
        s.pending.lock().await.insert(
            tx.clone(),
            (device.to_owned(), challenge.to_owned(), identity.to_owned()),
        );
        Ok(Json(
            json!({"transactionId":tx,"expiresAt":4102444800_i64,"authorizationUrl":s.authorization_url}),
        ))
    }

    async fn fixture_login_poll(
        AxumState(s): AxumState<BrowserFixture>,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, Err> {
        ensure_keys(&body, &["transactionId", "deviceId", "pkceVerifier"])?;
        let tx = body["transactionId"].as_str().ok_or_else(Err::bad)?;
        let device = body["deviceId"].as_str().ok_or_else(Err::bad)?;
        let verifier = body["pkceVerifier"].as_str().ok_or_else(Err::bad)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        let mut pending = s.pending.lock().await;
        let (expected_device, expected_challenge, identity) = pending
            .get(tx)
            .ok_or_else(|| Err::new(StatusCode::UNAUTHORIZED, "LOGIN_TRANSACTION_INVALID"))?;
        if expected_device != device || expected_challenge != &challenge {
            return Err(Err::new(
                StatusCode::UNAUTHORIZED,
                "LOGIN_TRANSACTION_INVALID",
            ));
        }
        let identity = identity.clone();
        pending.remove(tx);
        drop(pending);
        let subject = s.subjects.get(&identity).ok_or_else(Err::bad)?;
        let session = s.auth.issue_session(subject, device).map_err(Err::auth)?;
        let token = session.into_token();
        Ok(Json(json!({"accessToken":token.as_str()})))
    }

    async fn fixture_revoke(
        AxumState(s): AxumState<BrowserFixture>,
        headers: HeaderMap,
    ) -> Result<StatusCode, Err> {
        let token = bearer(&headers)?;
        s.auth.revoke_session(&token).map_err(Err::auth)?;
        Ok(StatusCode::NO_CONTENT)
    }

    async fn fixture_login_page() -> Response {
        asset(
            "<!doctype html><meta charset=utf-8><title>Test fixture</title><p>Synthetic local test login completed. <a href=/admin?login=complete>返回后台</a></p><p>For the ordinary test account, first visit /fixture-identity/ordinary; to return to the admin account, visit /fixture-identity/admin. The default identity is admin.</p>",
            "text/html; charset=utf-8",
        )
    }

    async fn fixture_identity(AxumPath(identity): AxumPath<String>) -> Result<Response, Err> {
        if identity != "admin" && identity != "ordinary" {
            return Err(Err::bad());
        }
        let mut response = Redirect::to("/admin").into_response();
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&format!(
                "fixture_identity={identity}; Path=/; HttpOnly; SameSite=Strict"
            ))
            .map_err(|_| Err::bad())?,
        );
        Ok(response)
    }

    fn setup() -> (
        AdminService,
        Arc<AuthStore>,
        TempDir,
        String,
        String,
        String,
        String,
    ) {
        setup_with_origin("https://admin.example.test")
    }

    fn setup_with_origin(
        origin: &str,
    ) -> (
        AdminService,
        Arc<AuthStore>,
        TempDir,
        String,
        String,
        String,
        String,
    ) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let auth = Arc::new(
            AuthStore::open(
                dir.path(),
                &crate::AuthConfig {
                    network_id: NETWORK.into(),
                    login_ttl: Duration::from_secs(300),
                    session_ttl: Duration::from_secs(3600),
                },
            )
            .unwrap(),
        );
        let subject = |label: &str| {
            crate::VerifiedSubject::from_verified_claims(
                "https://issuer.example.test".into(),
                label.into(),
            )
            .unwrap()
        };
        let admin_session = auth
            .issue_session(&subject("admin"), &Uuid::new_v4().to_string())
            .unwrap();
        let admin_id = admin_session.account.principal_id.clone();
        let admin_token = admin_session.into_token().to_string();
        let ordinary_session = auth
            .issue_session(&subject("ordinary"), &Uuid::new_v4().to_string())
            .unwrap();
        let ordinary_id = ordinary_session.account.principal_id.clone();
        let ordinary_token = ordinary_session.into_token().to_string();
        let config = AdminConfig {
            admin_principal_ids: vec![admin_id.clone()],
            hosts: vec![
                crate::admin_store::Resource {
                    id: HOST.into(),
                    name: "Synthetic Host A".into(),
                    owner_ids: vec![admin_id.clone(), ordinary_id.clone()],
                    runtimes: vec!["builtin".into(), "codex".into()],
                },
                crate::admin_store::Resource {
                    id: HOST_B.into(),
                    name: "Synthetic Host B".into(),
                    owner_ids: vec![admin_id.clone(), ordinary_id.clone()],
                    runtimes: vec!["builtin".into(), "codex".into()],
                },
            ],
            model_refs: vec![crate::admin_store::Resource {
                id: MODEL.into(),
                name: "Synthetic approved model".into(),
                owner_ids: vec![admin_id.clone(), ordinary_id.clone()],
                runtimes: vec!["builtin".into(), "codex".into()],
            }],
            max_daily_tokens: 1000,
        };
        let service =
            AdminService::open(auth.clone(), dir.path(), config, origin.into(), NETWORK).unwrap();
        (
            service,
            auth,
            dir,
            admin_id,
            admin_token,
            ordinary_id,
            ordinary_token,
        )
    }

    async fn call(
        app: Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, "https://admin.example.test");
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        app.oneshot(
            builder
                .body(
                    body.map(|b| Body::from(b.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn http_gate_bootstrap_admin_ordinary_and_revoked_sessions() {
        let (service, auth, _dir, principal, token, _, ordinary) = setup();
        let app = service.router();
        let response = call(
            app.clone(),
            "GET",
            "/api/admin/bootstrap",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["data"]["principal_id"], principal);
        assert_eq!(value["data"]["hosts"][0]["execution_connected"], false);
        assert_eq!(value["data"]["hosts"][0]["state"], "not_connected");
        assert_eq!(value["data"]["capabilities"]["sharing"], false);

        let denied = call(
            app.clone(),
            "GET",
            "/api/admin/bootstrap",
            Some(&ordinary),
            None,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let revoked = token.clone();
        auth.revoke_session(&revoked).unwrap();
        let denied = call(app, "GET", "/api/admin/bootstrap", Some(&token), None).await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn http_mutations_reject_cross_origin_and_unknown_fields() {
        let (service, _auth, _dir, principal, token, _, _) = setup();
        let app = service.router();
        let mut body = json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":0,"name":"draft","description":"","owner_id":principal,"host_id":HOST,"runtime":"builtin","model_ref":null,"system_prompt":"","daily_tokens":100,"unexpected":true});
        let response = call(
            app.clone(),
            "POST",
            "/api/admin/bots",
            Some(&token),
            Some(body.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        body.as_object_mut().unwrap().remove("unexpected");
        let req = Request::builder()
            .method("POST")
            .uri("/api/admin/bots")
            .header(header::ORIGIN, "https://evil.example.test")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = app.oneshot(req).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    }

    #[tokio::test]
    async fn fixture_login_binds_selected_ordinary_identity_to_device_and_pkce_once() {
        let (admin_service, auth, _dir, _admin_id, _admin_token, ordinary_id, _) = setup();
        let subject = |identity: &str| {
            crate::VerifiedSubject::from_verified_claims(
                "https://issuer.example.test".into(),
                identity.into(),
            )
            .unwrap()
        };
        let state = BrowserFixture {
            auth: auth.clone(),
            subjects: ["admin", "ordinary"]
                .into_iter()
                .map(|identity| (identity.to_owned(), subject(identity)))
                .collect(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            authorization_url: "http://127.0.0.1:5198/fixture-login".into(),
        };
        let app = Router::new()
            .route("/auth/login/start", post(fixture_login_start))
            .route("/auth/login/poll", post(fixture_login_poll))
            .route("/auth/session", delete(fixture_revoke))
            .with_state(state)
            .merge(admin_service.router())
            .layer(middleware::from_fn(no_store));
        let device = Uuid::new_v4().to_string();
        let verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.as_bytes()));
        let start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/auth/login/start")
                    .header(header::COOKIE, "fixture_identity=ordinary")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"deviceId":device,"pkceChallenge":challenge}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start.status(), StatusCode::OK);
        let start: Value =
            serde_json::from_slice(&axum::body::to_bytes(start.into_body(), 4096).await.unwrap())
                .unwrap();
        let tx = start["transactionId"].as_str().unwrap();
        let body = json!({"transactionId":tx,"deviceId":device,"pkceVerifier":verifier});
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/auth/login/poll")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        let token = result["accessToken"].as_str().unwrap();
        assert_eq!(
            auth.validate_session(token).unwrap().account.principal_id,
            ordinary_id
        );
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );

        // A separately issued admin session can be revoked through the same
        // test-only route and is then rejected by the real admin API gate.
        let admin_device = Uuid::new_v4().to_string();
        let admin_start = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/auth/login/start")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"deviceId":admin_device,"pkceChallenge":challenge}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let admin_start: Value = serde_json::from_slice(
            &axum::body::to_bytes(admin_start.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        let admin_poll = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/auth/login/poll")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"transactionId":admin_start["transactionId"],"deviceId":admin_device,"pkceVerifier":verifier}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let admin_poll: Value = serde_json::from_slice(
            &axum::body::to_bytes(admin_poll.into_body(), 4096)
                .await
                .unwrap(),
        )
        .unwrap();
        let admin_token = admin_poll["accessToken"].as_str().unwrap().to_owned();
        let bootstrap_request = || {
            Request::builder()
                .uri("/api/admin/bootstrap")
                .header(header::ORIGIN, "https://admin.example.test")
                .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(bootstrap_request())
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let logout = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/auth/session")
                    .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::NO_CONTENT);
        assert_eq!(logout.headers()[header::CACHE_CONTROL], "no-store");
        assert!(auth.validate_session(&admin_token).is_err());
        let denied = app.oneshot(bootstrap_request()).await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(denied.headers()[header::CACHE_CONTROL], "no-store");
    }

    /// Run with `cargo test --locked --lib admin_browser_fixture -- --ignored --nocapture`.
    /// This binds only to loopback and exposes synthetic test login routes only in test builds.
    #[tokio::test]
    #[ignore = "manual browser acceptance fixture; serves until interrupted"]
    async fn admin_browser_fixture() {
        let (service, auth, dir, _principal, _discarded_token, _ordinary_id, _) =
            setup_with_origin("http://127.0.0.1:5198");
        let subjects = ["admin", "ordinary"]
            .into_iter()
            .map(|identity| {
                (
                    identity.to_owned(),
                    crate::VerifiedSubject::from_verified_claims(
                        "https://issuer.example.test".into(),
                        identity.into(),
                    )
                    .unwrap(),
                )
            })
            .collect();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:5198")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let fixture = BrowserFixture {
            auth,
            subjects,
            pending: Arc::new(Mutex::new(HashMap::new())),
            authorization_url: format!("http://{address}/fixture-login"),
        };
        let fixture_routes = Router::new()
            .route("/auth/login/start", post(fixture_login_start))
            .route("/auth/login/poll", post(fixture_login_poll))
            .route("/auth/session", delete(fixture_revoke))
            .route("/fixture-login", get(fixture_login_page))
            .route("/fixture-identity/{identity}", get(fixture_identity))
            .with_state(fixture);
        let app = fixture_routes
            .merge(service.router())
            .layer(middleware::from_fn(no_store));
        let _keep_state_dir_alive = dir;
        println!("ADMIN_BROWSER_FIXTURE_URL=http://{address}/admin");
        axum::serve(listener, app).await.unwrap();
    }
}
