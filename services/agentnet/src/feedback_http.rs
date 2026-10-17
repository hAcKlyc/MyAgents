use crate::{AuthError, AuthStore, admin_store::AdminConfig, feedback_store::FeedbackStore};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
pub struct FeedbackService {
    auth: Arc<AuthStore>,
    store: Arc<FeedbackStore>,
    admins: Arc<Vec<String>>,
    origin: String,
    network_id: String,
    in_flight: Arc<Semaphore>,
}
impl FeedbackService {
    pub fn open(
        auth: Arc<AuthStore>,
        dir: &std::path::Path,
        config: Option<AdminConfig>,
        origin: String,
        network_id: &str,
    ) -> Result<Self, AuthError> {
        if let Some(c) = &config {
            c.validate().map_err(|_| AuthError::Configuration)?;
        }
        let url = url::Url::parse(&origin).map_err(|_| AuthError::Configuration)?;
        if url.origin().ascii_serialization() != origin {
            return Err(AuthError::Configuration);
        }
        let store = FeedbackStore::open(dir, network_id).map_err(|_| AuthError::Storage)?;
        Ok(Self {
            auth,
            store: Arc::new(store),
            admins: Arc::new(config.map(|c| c.admin_principal_ids).unwrap_or_default()),
            origin,
            network_id: network_id.to_owned(),
            in_flight: Arc::new(Semaphore::new(32)),
        })
    }
    pub fn router(&self) -> Router<()> {
        Router::new()
            .route("/feedback", get(page))
            .route("/feedback/app.js", get(js))
            .route("/feedback/styles.css", get(css))
            .route("/api/feedback", get(list).post(create))
            .route("/api/feedback/{id}", get(detail))
            .route("/api/admin/feedback", get(admin_list))
            .route("/api/admin/feedback/{id}", patch(update))
            .layer(DefaultBodyLimit::max(64 * 1024))
            .layer(middleware::from_fn(no_store))
            .with_state(Arc::new(self.clone()))
    }
}
async fn page() -> Response {
    asset(
        include_str!("../feedback-web/index.html"),
        "text/html; charset=utf-8",
    )
}
async fn js() -> Response {
    asset(
        include_str!("../feedback-web/app.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn css() -> Response {
    asset(
        include_str!("../feedback-web/styles.css"),
        "text/css; charset=utf-8",
    )
}
fn asset(text: &'static str, content_type: &'static str) -> Response {
    let mut r = text.into_response();
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    r
}
async fn list(State(s): State<Arc<FeedbackService>>, h: HeaderMap) -> Result<Json<Value>, Error> {
    feedback_list(s, h, false).await
}
async fn admin_list(
    State(s): State<Arc<FeedbackService>>,
    h: HeaderMap,
) -> Result<Json<Value>, Error> {
    feedback_list(s, h, true).await
}
async fn feedback_list(
    s: Arc<FeedbackService>,
    h: HeaderMap,
    admin: bool,
) -> Result<Json<Value>, Error> {
    let store = s.store.clone();
    let items = blocking(s, h, admin, move |actor, _| {
        store.list(actor, admin).map_err(Error::store)
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":{"items":items}})))
}
async fn detail(
    State(s): State<Arc<FeedbackService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
) -> Result<Json<Value>, Error> {
    let id = Uuid::parse_str(&raw_id)
        .map_err(|_| Error::bad())?
        .to_string();
    let store = s.store.clone();
    let row = blocking(s, h, false, move |actor, admin| {
        store.get(&id, actor, admin).map_err(Error::store)
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":row})))
}
async fn create(
    State(s): State<Arc<FeedbackService>>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Result<Json<Value>, Error> {
    let store = s.store.clone();
    let row = blocking(s, h, false, move |actor, _| {
        store.create(actor, &b).map_err(Error::store)
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":row})))
}
async fn update(
    State(s): State<Arc<FeedbackService>>,
    Path(raw_id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Result<Json<Value>, Error> {
    let id = Uuid::parse_str(&raw_id)
        .map_err(|_| Error::bad())?
        .to_string();
    let store = s.store.clone();
    let row = blocking(s, h, true, move |actor, _| {
        store.update(&id, actor, &b).map_err(Error::store)
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":row})))
}
async fn blocking<T, F>(
    s: Arc<FeedbackService>,
    h: HeaderMap,
    admin_required: bool,
    operation: F,
) -> Result<T, Error>
where
    T: Send + 'static,
    F: FnOnce(&str, bool) -> Result<T, Error> + Send + 'static,
{
    let permit = s
        .in_flight
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new(StatusCode::SERVICE_UNAVAILABLE, "FEEDBACK_CAPACITY"))?;
    let mut origins = h.get_all(header::ORIGIN).iter();
    if let Some(origin) = origins.next()
        && (origin.to_str().ok() != Some(s.origin.as_str()) || origins.next().is_some())
    {
        return Err(Error::new(StatusCode::FORBIDDEN, "ORIGIN_REJECTED"));
    }
    let mut authorization = h.get_all(header::AUTHORIZATION).iter();
    let token = authorization
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 43)
        .ok_or_else(|| Error::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"))?
        .to_owned();
    if authorization.next().is_some() {
        return Err(Error::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        s.auth.with_valid_session(&token, |p| {
            if p.account.network_id != s.network_id {
                return Err(Error::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
            }
            let admin = s.admins.contains(&p.account.principal_id);
            if admin_required && !admin {
                return Err(Error::new(StatusCode::FORBIDDEN, "ADMIN_REQUIRED"));
            }
            operation(&p.account.principal_id, admin)
        })
    })
    .await
    .map_err(|_| Error::new(StatusCode::SERVICE_UNAVAILABLE, "FEEDBACK_UNAVAILABLE"))?
}
async fn no_store(req: Request<Body>, next: Next) -> Response {
    let mut r = next.run(req).await;
    if (r.status().is_client_error() || r.status().is_server_error())
        && !r
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"))
    {
        let code = if r.status() == StatusCode::PAYLOAD_TOO_LARGE {
            "REQUEST_TOO_LARGE"
        } else {
            "REQUEST_INVALID"
        };
        r = Error::new(r.status(), code).into_response();
    }
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    r.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    r.headers_mut().insert(header::CONTENT_SECURITY_POLICY,HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
    r
}
#[derive(Debug)]
struct Error {
    status: StatusCode,
    code: &'static str,
}
impl Error {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
    fn bad() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "REQUEST_INVALID")
    }
    fn store(code: &'static str) -> Self {
        Self::new(
            match code {
                "FEEDBACK_NOT_FOUND" => StatusCode::NOT_FOUND,
                "MUTATION_CONFLICT" | "REVISION_CONFLICT" => StatusCode::CONFLICT,
                "REQUEST_INVALID" => StatusCode::BAD_REQUEST,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            },
            code,
        )
    }
}
impl From<AuthError> for Error {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::SessionRejected => Self::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"),
            _ => Self::new(StatusCode::SERVICE_UNAVAILABLE, "FEEDBACK_UNAVAILABLE"),
        }
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.status,Json(json!({"ok":false,"error":{"code":self.code,"message":self.code,"retryable":self.status==StatusCode::SERVICE_UNAVAILABLE}}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
    use tower::ServiceExt;
    const ORIGIN: &str = "https://cloud.example.test";
    const NETWORK: &str = "11111111-1111-4111-8111-111111111111";
    struct Fixture {
        service: FeedbackService,
        auth: Arc<AuthStore>,
        dir: tempfile::TempDir,
        admin: String,
        user: String,
        other: String,
    }
    fn setup(admin_enabled: bool) -> Fixture {
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
        let session = |name: &str| {
            auth.issue_session(
                &crate::VerifiedSubject::from_verified_claims(
                    "https://issuer.example.test".into(),
                    name.into(),
                )
                .unwrap(),
                &Uuid::new_v4().to_string(),
            )
            .unwrap()
        };
        let admin = session("admin");
        let admin_id = admin.account.principal_id.clone();
        let admin = admin.into_token().to_string();
        let user = session("user").into_token().to_string();
        let other = session("other").into_token().to_string();
        let config = admin_enabled.then_some(AdminConfig {
            admin_principal_ids: vec![admin_id],
            hosts: vec![],
            model_refs: vec![],
            max_daily_tokens: 100,
        });
        let service =
            FeedbackService::open(auth.clone(), dir.path(), config, ORIGIN.into(), NETWORK)
                .unwrap();
        Fixture {
            service,
            auth,
            dir,
            admin,
            user,
            other,
        }
    }
    async fn call(
        app: Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN);
        if let Some(token) = token {
            b = b.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if body.is_some() {
            b = b.header(header::CONTENT_TYPE, "application/json");
        }
        let response = app
            .oneshot(
                b.body(
                    body.map(|b| Body::from(b.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let status = response.status();
        let value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        (status, value)
    }
    fn body() -> Value {
        json!({"mutation_id":Uuid::new_v4().to_string(),"title":"反馈标题","description":"保存后界面未更新，请检查。","category":"bug"})
    }
    #[tokio::test]
    async fn feedback_http_enforces_owner_admin_revocation_and_durable_replay() {
        let f = setup(true);
        let app = f.service.router();
        let b = body();
        assert_eq!(
            call(app.clone(), "POST", "/api/feedback", None, Some(b.clone()))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, row) = call(
            app.clone(),
            "POST",
            "/api/feedback",
            Some(&f.user),
            Some(b.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let id = row["data"]["id"].as_str().unwrap();
        let detail = format!("/api/feedback/{id}");
        assert_eq!(
            call(app.clone(), "GET", &detail, Some(&f.other), None)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                app.clone(),
                "GET",
                &format!("/api/feedback/{}", Uuid::new_v4()),
                Some(&f.other),
                None
            )
            .await
            .1["error"]["code"],
            "FEEDBACK_NOT_FOUND"
        );
        assert_eq!(
            call(app.clone(), "GET", &detail, Some(&f.admin), None)
                .await
                .0,
            StatusCode::OK
        );
        assert!(
            call(app.clone(), "GET", "/api/feedback", Some(&f.other), None)
                .await
                .1["data"]["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            call(
                app.clone(),
                "GET",
                "/api/admin/feedback",
                Some(&f.user),
                None
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let update = json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":1,"status":"resolved","reply":"问题已修复，请重试。"});
        let update_path = format!("/api/admin/feedback/{id}");
        assert_eq!(
            call(
                app.clone(),
                "PATCH",
                &update_path,
                Some(&f.user),
                Some(update.clone())
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, updated) = call(
            app.clone(),
            "PATCH",
            &update_path,
            Some(&f.admin),
            Some(update.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["data"]["revision"], 2);
        assert_eq!(updated["data"]["events"].as_array().unwrap().len(), 3);
        assert_eq!(
            call(
                app.clone(),
                "PATCH",
                &update_path,
                Some(&f.admin),
                Some(update)
            )
            .await
            .1,
            updated
        );
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/api/feedback",
                Some(&f.user),
                Some(b.clone())
            )
            .await
            .1,
            row
        );
        let mut b2 = b;
        b2["title"] = json!("修改内容");
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/api/feedback",
                Some(&f.user),
                Some(b2)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        let reopened =
            FeedbackService::open(f.auth.clone(), f.dir.path(), None, ORIGIN.into(), NETWORK)
                .unwrap();
        assert_eq!(
            call(reopened.router(), "GET", &detail, Some(&f.user), None)
                .await
                .1,
            updated
        );
        f.auth.revoke_session(&f.user).unwrap();
        assert_eq!(
            call(app.clone(), "GET", &detail, Some(&f.user), None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(app, "POST", "/api/feedback", Some(&f.user), Some(body()))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn feedback_http_user_api_survives_disabled_administration() {
        let f = setup(false);
        let app = f.service.router();
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/api/feedback",
                Some(&f.user),
                Some(body())
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(app.clone(), "GET", "/api/feedback", Some(&f.user), None)
                .await
                .1["data"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            call(app, "GET", "/api/admin/feedback", Some(&f.admin), None)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn feedback_http_rejects_cross_origin_malformed_auth_json_and_oversized_requests() {
        let f = setup(true);
        let app = f.service.router().layer(DefaultBodyLimit::max(8 * 1024));
        for (origin, auth) in [
            ("https://evil.example.test", format!("Bearer {}", f.user)),
            (ORIGIN, format!("Basic {}", f.user)),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/feedback")
                        .header(header::ORIGIN, origin)
                        .header(header::AUTHORIZATION, auth)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body().to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(matches!(
                response.status(),
                StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED
            ));
        }
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/feedback")
            .header(header::ORIGIN, ORIGIN)
            .header(header::AUTHORIZATION, format!("Bearer {}", f.user))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body().to_string()))
            .unwrap();
        request.headers_mut().append(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", f.admin)).unwrap(),
        );
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        for character in ["中", "😀"] {
            let mut unicode = body();
            unicode["description"] = json!(character.repeat(8000));
            assert_eq!(
                call(
                    app.clone(),
                    "POST",
                    "/api/feedback",
                    Some(&f.user),
                    Some(unicode)
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        for (payload, expected) in [
            ("{".to_owned(), StatusCode::BAD_REQUEST),
            ("x".repeat(65 * 1024), StatusCode::PAYLOAD_TOO_LARGE),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/feedback")
                        .header(header::ORIGIN, ORIGIN)
                        .header(header::AUTHORIZATION, format!("Bearer {}", f.user))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(payload))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            let value: Value = serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 4096)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(value["ok"], false);
            assert_eq!(
                value["error"]["code"],
                if expected == StatusCode::PAYLOAD_TOO_LARGE {
                    "REQUEST_TOO_LARGE"
                } else {
                    "REQUEST_INVALID"
                }
            );
        }
    }
    #[tokio::test]
    async fn feedback_http_assets_are_static_and_nostore_and_capacity_bounded() {
        let f = setup(true);
        let app = f.service.router();
        for path in ["/feedback", "/feedback/app.js", "/feedback/styles.css"] {
            let r = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::OK);
            assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
            assert!(r.headers().contains_key(header::CONTENT_SECURITY_POLICY));
        }
        let _all = f
            .service
            .in_flight
            .clone()
            .acquire_many_owned(32)
            .await
            .unwrap();
        assert_eq!(
            call(app, "GET", "/api/feedback", Some(&f.user), None)
                .await
                .1["error"]["code"],
            "FEEDBACK_CAPACITY"
        );
    }
    // This lane exists only in cargo test builds. Real account/session and feedback
    // stores back the UI; the upstream identity provider is a loopback chooser.
    #[derive(Clone)]
    struct BrowserFixture {
        auth: Arc<AuthStore>,
        pending: Arc<std::sync::Mutex<std::collections::HashMap<String, FixtureLogin>>>,
    }
    struct FixtureLogin {
        device: String,
        challenge: String,
        return_path: &'static str,
        identity: Option<String>,
    }
    fn fixture_pkce(body: &Value, login: &FixtureLogin) -> bool {
        use base64::Engine;
        use sha2::Digest;
        let Some(verifier) = body["pkceVerifier"].as_str() else {
            return false;
        };
        body["deviceId"].as_str() == Some(login.device.as_str())
            && base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(sha2::Sha256::digest(verifier.as_bytes()))
                == login.challenge
    }
    async fn fixture_start(
        State(s): State<BrowserFixture>,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, Error> {
        let device = body["deviceId"].as_str().ok_or_else(Error::bad)?;
        let challenge = body["pkceChallenge"].as_str().ok_or_else(Error::bad)?;
        Uuid::parse_str(device).map_err(|_| Error::bad())?;
        if challenge.len() != 43 {
            return Err(Error::bad());
        }
        let return_path = match body["browserReturnPath"].as_str() {
            None | Some("/admin") => "/admin",
            Some("/feedback") => "/feedback",
            _ => return Err(Error::bad()),
        };
        let tx = Uuid::new_v4().to_string();
        s.pending.lock().unwrap().insert(
            tx.clone(),
            FixtureLogin {
                device: device.into(),
                challenge: challenge.into(),
                return_path,
                identity: None,
            },
        );
        Ok(Json(
            json!({"transactionId":tx,"expiresAt":4102444800_i64,"authorizationUrl":format!("http://127.0.0.1:5197/fixture-login/{tx}")}),
        ))
    }
    async fn fixture_login(Path(tx): Path<String>) -> Response {
        let safe = Uuid::parse_str(&tx)
            .map(|v| v.to_string())
            .unwrap_or_default();
        axum::response::Html(format!("<!doctype html><meta charset=utf-8><title>合成反馈验收</title><h1>选择本地合成身份</h1><p>本测试使用真实权限和反馈存储，不连接生产身份提供方。</p><p><a href='/fixture-select/{safe}/user'>普通用户</a> · <a href='/fixture-select/{safe}/other'>另一用户</a> · <a href='/fixture-select/{safe}/admin'>管理员</a></p>")).into_response()
    }
    async fn fixture_select(
        State(s): State<BrowserFixture>,
        Path((tx, identity)): Path<(String, String)>,
    ) -> Result<Response, Error> {
        if !matches!(identity.as_str(), "user" | "other" | "admin") {
            return Err(Error::bad());
        }
        let mut all = s.pending.lock().unwrap();
        let pending = all.get_mut(&tx).ok_or_else(Error::bad)?;
        pending.identity = Some(identity);
        Ok(
            axum::response::Redirect::to(&format!("{}?login=complete", pending.return_path))
                .into_response(),
        )
    }
    async fn fixture_poll(
        State(s): State<BrowserFixture>,
        Json(body): Json<Value>,
    ) -> Result<Json<Value>, Error> {
        let tx = body["transactionId"].as_str().ok_or_else(Error::bad)?;
        let mut all = s.pending.lock().unwrap();
        let login = all.get(tx).ok_or_else(Error::bad)?;
        if !fixture_pkce(&body, login) {
            return Err(Error::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
        }
        let identity = login.identity.as_ref().ok_or_else(Error::bad)?;
        let subject = crate::VerifiedSubject::from_verified_claims(
            "https://issuer.example.test".into(),
            identity.into(),
        )
        .unwrap();
        let session = s
            .auth
            .issue_session(&subject, &login.device)
            .map_err(Error::from)?;
        all.remove(tx);
        let expires_at = session.expires_at;
        let principal_id = session.account.principal_id.clone();
        let network_id = session.account.network_id.clone();
        Ok(Json(
            json!({"accessToken":session.into_token().as_str(), "expiresAt":expires_at, "principalId":principal_id, "networkId":network_id}),
        ))
    }
    async fn fixture_cancel(
        State(s): State<BrowserFixture>,
        Json(body): Json<Value>,
    ) -> Result<StatusCode, Error> {
        let tx = body["transactionId"].as_str().ok_or_else(Error::bad)?;
        let mut all = s.pending.lock().unwrap();
        let login = all.get(tx).ok_or_else(Error::bad)?;
        if !fixture_pkce(&body, login) {
            return Err(Error::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
        }
        all.remove(tx);
        Ok(StatusCode::NO_CONTENT)
    }
    async fn fixture_revoke(
        State(s): State<BrowserFixture>,
        h: HeaderMap,
    ) -> Result<StatusCode, Error> {
        let token = h
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(Error::bad)?;
        s.auth.revoke_session(token).map_err(Error::from)?;
        Ok(StatusCode::NO_CONTENT)
    }
    #[tokio::test]
    #[ignore = "manual browser fixture; loopback only, synthetic upstream login"]
    async fn feedback_browser_fixture() {
        let f = setup(true);
        let config = AdminConfig {
            admin_principal_ids: (*f.service.admins).clone(),
            hosts: vec![],
            model_refs: vec![],
            max_daily_tokens: 100,
        };
        let origin = "http://127.0.0.1:5197";
        let service = FeedbackService::open(
            f.auth.clone(),
            f.dir.path(),
            Some(config.clone()),
            origin.into(),
            NETWORK,
        )
        .unwrap();
        let admin = crate::admin_http::AdminService::open(
            f.auth.clone(),
            f.dir.path(),
            config,
            origin.into(),
            NETWORK,
        )
        .unwrap();
        let state = BrowserFixture {
            auth: f.auth,
            pending: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        };
        let app = Router::new()
            .route("/auth/login/start", axum::routing::post(fixture_start))
            .route("/auth/login/poll", axum::routing::post(fixture_poll))
            .route("/auth/login/cancel", axum::routing::delete(fixture_cancel))
            .route("/auth/session", axum::routing::delete(fixture_revoke))
            .route("/fixture-login/{tx}", get(fixture_login))
            .route("/fixture-select/{tx}/{identity}", get(fixture_select))
            .with_state(state)
            .merge(service.router())
            .merge(admin.router());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:5197")
            .await
            .unwrap();
        let _keep_dir = f.dir;
        println!("FEEDBACK_BROWSER_FIXTURE_URL=http://127.0.0.1:5197/feedback");
        axum::serve(listener, app).await.unwrap();
    }
}
