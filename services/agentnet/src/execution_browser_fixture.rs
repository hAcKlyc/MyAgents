//! Test-build-only browser lane. The cloud authority/ledger/proofs are real;
//! Host SDK state and lifecycle effects are synthetic. No model is invoked.
use crate::{
    admin_http,
    execution_http::tests::{Setup, browser_setup, host},
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use myagents_agentnet_execution_core::{
    Activity, Admission, BotConfig, BotSnapshot, Command, Grant, HostObservation, Operation,
    Receipt, ReceiptStatus, RevocationClaims, verify_grant, verify_intent, verify_lease,
    verify_revocation,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;
use uuid::Uuid;
const ORIGIN: &str = "http://127.0.0.1:5199";
const CONTROL: &str = "<!doctype html><meta charset=utf-8><title>Synthetic execution fixture</title><h1>合成生命周期验收</h1><p>真实 AuthStore/DeviceStore/RelayHandler、DPoP、签名、队列和回执；Host/SDK 生命周期由测试模拟。不证明 Linux Host、实际运行或付费模型推理。</p><p><a href='/admin'>管理台</a></p><form action='/fixture-host/pause' method='post'><button>暂停 Host 命令（观察 pending）</button></form><form action='/fixture-host/resume' method='post'><button>继续 Host 命令</button></form><form action='/fixture-host/conflict-next' method='post'><button>下一命令产生 CAS conflict</button></form><form action='/fixture-host/unconfirmed-next' method='post'><button>下一命令回报 unconfirmed</button></form>";
#[derive(Default)]
pub(crate) struct Controls {
    paused: bool,
    conflict_next: bool,
    unconfirmed_next: bool,
}
struct SyntheticHost {
    revision: u64,
    resource_revision: u64,
    snapshot: Option<BotSnapshot>,
    grants: BTreeMap<String, Grant>,
    receipts: BTreeMap<String, Receipt>,
}
impl SyntheticHost {
    fn new() -> Self {
        Self {
            revision: 0,
            resource_revision: 0,
            snapshot: None,
            grants: BTreeMap::new(),
            receipts: BTreeMap::new(),
        }
    }
    fn observation(&self, t: &Setup) -> HostObservation {
        HostObservation {
            host_revision: self.revision,
            resource_revision: self.resource_revision,
            root_ids: vec!["workspaces".into()],
            supported_runtimes: vec!["builtin".into()],
            allowed_bot_ids: vec![t.bot_id.clone()],
            allowed_model_refs: t.grant.allowed_model_refs.clone(),
            max_daily_tokens: 1000,
            policy_expires_at: t.grant.expires_at,
            snapshots: self.snapshot.iter().cloned().collect(),
        }
    }
    fn empty(&self, t: &Setup) -> BotSnapshot {
        BotSnapshot {
            bot_id: t.bot_id.clone(),
            agent_id: None,
            binding_generation: 0,
            revision: self.revision,
            deleted: false,
            admission: Admission::Closed,
            activity: Activity::Idle,
            configured: false,
            runnable: false,
            unsupported_reason: Some("SYNTHETIC_LIFECYCLE_ONLY".into()),
            active_run: None,
            config: BotConfig {
                name: "合成生命周期 Bot".into(),
                description: String::new(),
                runtime: "builtin".into(),
                model_ref: None,
                system_prompt: String::new(),
                daily_tokens: 100,
            },
        }
    }
    fn permits(t: &Setup, g: &Grant) -> bool {
        g.scope == t.grant.scope
            && g.bot_id == t.bot_id
            && g.root_id == "workspaces"
            && g.relative_path == t.grant.relative_path
            && g.max_daily_tokens <= 1000
            && g.expires_at <= t.grant.expires_at
            && g.allowed_runtimes.iter().all(|r| r == "builtin")
            && g.allowed_model_refs
                .iter()
                .all(|m| t.grant.allowed_model_refs.contains(m))
    }
    fn execute(&mut self, t: &Setup, c: &Command, controls: &mut Controls) -> Receipt {
        if let Some(old) = self.receipts.get(&c.mutation_id) {
            return old.clone();
        }
        if controls.conflict_next {
            controls.conflict_next = false;
            self.revision += 1;
            if let Some(s) = &mut self.snapshot {
                s.revision = self.revision;
            }
        }
        let mut status = ReceiptStatus::Persisted;
        let mut code = None;
        if controls.unconfirmed_next {
            controls.unconfirmed_next = false;
            status = ReceiptStatus::Unconfirmed;
            code = Some("SYNTHETIC_OUTCOME_UNCONFIRMED".into());
        } else if c.expected_host_revision != self.revision {
            status = ReceiptStatus::Conflict;
            code = Some("REVISION_CONFLICT".into());
        } else {
            let old = self.snapshot.clone();
            let valid = match &c.operation {
                Operation::Create(p) => {
                    old.is_none()
                        && c.binding_generation == 1
                        && p.resource_expected_revision == self.resource_revision
                }
                Operation::Restore(_) => old
                    .as_ref()
                    .is_some_and(|s| s.deleted && c.binding_generation > s.binding_generation),
                _ => old
                    .as_ref()
                    .is_some_and(|s| !s.deleted && c.binding_generation == s.binding_generation),
            };
            if !valid {
                status = ReceiptStatus::Conflict;
                code = Some("BOT_BINDING_GENERATION_CONFLICT".into());
            } else if matches!(c.operation, Operation::Enable(_))
                && old.as_ref().is_some_and(|s| !s.runnable)
            {
                status = ReceiptStatus::Failed;
                code = Some("BOT_RUNTIME_UNSUPPORTED".into());
            } else {
                let mut s = old.unwrap_or_else(|| self.empty(t));
                match &c.operation {
                    Operation::Create(p) => {
                        s.config = p.config();
                        s.agent_id = Some(Uuid::new_v4().to_string());
                        s.binding_generation = c.binding_generation;
                        s.configured = s.config.model_ref.is_some();
                        s.runnable = s.configured;
                        s.unsupported_reason =
                            (!s.configured).then(|| "MODEL_NOT_CONFIGURED".into());
                        s.activity = Activity::Idle;
                        self.resource_revision += 1;
                    }
                    Operation::Configure(p) => {
                        s.config = p.clone();
                        s.configured = s.config.model_ref.is_some();
                        s.runnable = s.configured;
                        s.unsupported_reason =
                            (!s.configured).then(|| "MODEL_NOT_CONFIGURED".into());
                        if !s.runnable {
                            s.admission = Admission::Closed;
                            s.activity = Activity::Stopped;
                        }
                    }
                    Operation::Enable(_) => {
                        s.admission = Admission::Open;
                        s.activity = Activity::Idle;
                    }
                    Operation::Disable(_) => {
                        s.admission = Admission::Closed;
                        s.activity = Activity::Stopped;
                    }
                    Operation::Delete(_) => {
                        s.deleted = true;
                        s.runnable = false;
                        s.admission = Admission::Closed;
                        s.activity = Activity::Stopped;
                    }
                    Operation::Restore(_) => {
                        s.deleted = false;
                        s.runnable = s.configured;
                        s.agent_id = Some(Uuid::new_v4().to_string());
                        s.binding_generation = c.binding_generation;
                        s.admission = Admission::Closed;
                        s.activity = Activity::Idle;
                        self.resource_revision += 1;
                    }
                }
                self.revision += 1;
                s.revision = self.revision;
                s.active_run = None;
                s.validate().unwrap();
                self.snapshot = Some(s);
            }
        }
        let s = self.snapshot.clone().unwrap_or_else(|| self.empty(t));
        let receipt = Receipt {
            mutation_id: c.mutation_id.clone(),
            request_hash: c.request_hash.clone(),
            grant_id: c.grant_id.clone(),
            grant_generation: c.grant_generation,
            bot_id: c.bot_id.clone(),
            agent_id: s.agent_id.clone(),
            binding_generation: s.binding_generation,
            revision: s.revision,
            status,
            code,
            snapshot: if status == ReceiptStatus::Unconfirmed {
                None
            } else {
                Some(s)
            },
        };
        receipt.matches_command(c).unwrap();
        if status != ReceiptStatus::Unconfirmed {
            self.receipts.insert(c.mutation_id.clone(), receipt.clone());
        }
        receipt
    }
    async fn tick(&mut self, t: &Setup, controls: &mut Controls) {
        let mut context = t.context.clone();
        context.challenge_nonce = Uuid::new_v4().to_string();
        let observation = self.observation(t);
        observation.validate().unwrap();
        assert_eq!(
            host(
                t,
                "/execution/self/observe",
                json!({"host_context":context,"observation":observation})
            )
            .await
            .0,
            StatusCode::OK
        );
        let (status, pull) = host(t, "/execution/self/pull", json!({"host_context":context})).await;
        assert_eq!(status, StatusCode::OK);
        let jwks = t.f.service._keys.jwks();
        let now = jsonwebtoken::get_current_timestamp();
        for item in pull["data"]["revocations"].as_array().unwrap() {
            let token = item["revocation_token"].as_str().unwrap();
            let target =
                t.s.ledger()
                    .grants()
                    .unwrap()
                    .into_iter()
                    .find(|g| {
                        g.state == crate::execution_store::GrantState::Revoking
                            && g.grant.scope == t.grant.scope
                    })
                    .unwrap();
            let proof: RevocationClaims = verify_revocation(
                token,
                &jwks,
                &t.grant.scope,
                now,
                &context,
                &target.grant.id,
                &t.bot_id,
                target.grant.generation,
            )
            .unwrap();
            assert!(Self::permits(t, &target.grant));
            let mut snapshot = self.snapshot.clone().unwrap_or_else(|| self.empty(t));
            snapshot.admission = Admission::Closed;
            snapshot.activity = Activity::Stopped;
            snapshot.active_run = None;
            self.revision += 1;
            snapshot.revision = self.revision;
            self.snapshot = Some(snapshot.clone());
            self.grants.remove(&proof.grant_id);
            // The real ledger may reject ACK until a lost original receipt is reconciled.
            let _=host(t,"/execution/self/receipt",json!({"kind":"revocation","host_context":context,"revocation_token":token,"snapshot":snapshot})).await;
        }
        for item in pull["data"]["grants"].as_array().unwrap() {
            let g = verify_grant(
                item["grant_token"].as_str().unwrap(),
                &jwks,
                &t.grant.scope,
                now,
            )
            .unwrap()
            .grant;
            assert!(Self::permits(t, &g));
            if let Some(old) = self.grants.get(&g.id) {
                assert_eq!(old, &g)
            }
            self.grants.insert(g.id.clone(), g);
        }
        if controls.paused {
            return;
        }
        for item in pull["data"]["intents"].as_array().unwrap() {
            let intent = verify_intent(
                item["intent_token"].as_str().unwrap(),
                &jwks,
                &t.grant.scope,
                jsonwebtoken::get_current_timestamp(),
            )
            .unwrap();
            assert!(Self::permits(t, &intent.grant));
            assert_eq!(self.grants.get(&intent.grant.id), Some(&intent.grant));
            context.challenge_nonce = Uuid::new_v4().to_string();
            let (status, leased) = host(
                t,
                "/execution/self/lease",
                json!({"intent_hash":item["intent_hash"],"host_context":context}),
            )
            .await;
            if status != StatusCode::OK {
                continue;
            }
            let lease = verify_lease(
                leased["data"]["lease_token"].as_str().unwrap(),
                &jwks,
                &t.grant.scope,
                jsonwebtoken::get_current_timestamp(),
                &intent,
                &context,
            )
            .unwrap();
            let receipt = self.execute(t, &intent.command, controls);
            assert_eq!(host(t,"/execution/self/receipt",json!({"kind":"command","host_context":context,"lease_id":lease.lease_id,"receipt":receipt})).await.0,StatusCode::OK);
        }
    }
}
async fn control(State(c): State<Arc<Mutex<Controls>>>, Path(mode): Path<String>) -> Response {
    let mut c = c.lock().await;
    match mode.as_str() {
        "pause" => c.paused = true,
        "resume" => c.paused = false,
        "conflict-next" => c.conflict_next = true,
        "unconfirmed-next" => c.unconfirmed_next = true,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    }
    Html(CONTROL).into_response()
}
async fn synthetic_banner(request: Request, next: Next) -> Response {
    let page = request.uri().path() == "/admin";
    let response = next.run(request).await;
    if !page {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    let bytes = to_bytes(body, 1024 * 1024).await.unwrap();
    let text=String::from_utf8(bytes.to_vec()).unwrap().replacen("<body>","<body><p style='background:#fff4c2;padding:12px'>合成生命周期测试：真实云认证/队列/签名，Host/SDK为模拟，无 Linux 或付费模型验收。 <a href='/fixture-control'>测试控制</a></p>",1);
    Response::from_parts(parts, Body::from(text))
}
pub(crate) async fn browser_fixture() -> (Router, Arc<Setup>, Arc<Mutex<Controls>>) {
    let t = Arc::new(browser_setup().await);
    let admin = t.browser_admin_service();
    let subjects: HashMap<_, _> = [
        ("admin", t.f.verified_subject("execution-owner")),
        ("ordinary", t.f.verified_subject("execution-other")),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    let controls = Arc::new(Mutex::new(Controls::default()));
    let app = admin_http::tests::browser_fixture_router(
        t.f.auth.clone(),
        subjects,
        format!("{ORIGIN}/fixture-login"),
    )
    .merge(admin.router())
    .merge(t.s.router())
    .merge(
        Router::new()
            .route("/fixture-control", get(|| async { Html(CONTROL) }))
            .route("/fixture-host/{mode}", post(control))
            .with_state(controls.clone()),
    )
    .layer(middleware::from_fn(synthetic_banner));
    (app, t, controls)
}
#[tokio::test]
#[ignore = "manual synthetic browser lifecycle acceptance; loopback only, serves until interrupted"]
async fn execution_browser_fixture() {
    let (app, t, controls) = browser_fixture().await;
    let (listener, tick) = (
        tokio::net::TcpListener::bind("127.0.0.1:5199")
            .await
            .unwrap(),
        async move {
            let mut host = SyntheticHost::new();
            loop {
                host.tick(&t, &mut *controls.lock().await).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        },
    );
    println!("EXECUTION_BROWSER_FIXTURE_URL={ORIGIN}/admin");
    tokio::select! {r=axum::serve(listener,app)=>r.unwrap(),_=tick=>{}}
}

async fn call(app: &Router, path: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    use tower::ServiceExt;
    let mut request = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN);
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
async fn queue(
    app: &Router,
    t: &Setup,
    token: &str,
    g: &Grant,
    binding: u64,
    revision: u64,
    operation: Value,
) -> String {
    let id = Uuid::new_v4().to_string();
    assert_eq!(call(app,&format!("/api/admin/bots/{}/execution",t.bot_id),Some(token),json!({"mutation_id":id,"grant_id":g.id,"grant_generation":g.generation,"binding_generation":binding,"expected_host_revision":revision,"operation":operation})).await.0,StatusCode::OK);
    id
}
#[tokio::test]
async fn synthetic_browser_lane_real_auth_queue_cas_receipts_and_fresh_restore() {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (app, t, _) = browser_fixture().await;
    let device = Uuid::new_v4().to_string();
    let verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
    let challenge =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier));
    let (status, start) = call(
        &app,
        "/auth/login/start",
        None,
        json!({"deviceId":device,"pkceChallenge":challenge}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, session) = call(
        &app,
        "/auth/login/poll",
        None,
        json!({"transactionId":start["transactionId"],"deviceId":device,"pkceVerifier":verifier}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = zeroize::Zeroizing::new(session["accessToken"].as_str().unwrap().to_owned());
    assert_eq!(
        t.f.auth
            .validate_session(&token)
            .unwrap()
            .account
            .principal_id,
        t.host.context.principal_id
    );
    assert_eq!(
        call(
            &app,
            "/api/bots/grants/accept",
            Some(&token),
            json!({"grant":t.grant,"expected_generation":0})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut host = SyntheticHost::new();
    let mut controls = Controls::default();
    let config = json!({"name":"合成生命周期 Bot","description":"synthetic lifecycle only","runtime":"builtin","model_ref":t.grant.allowed_model_refs[0],"system_prompt":"","daily_tokens":100});
    let mut create = config.clone();
    create["model_ref"] = Value::Null;
    create["resource_expected_revision"] = json!(0);
    let id = queue(
        &app,
        &t,
        &token,
        &t.grant,
        1,
        0,
        json!({"method":"create","params":create}),
    )
    .await;
    host.tick(&t, &mut controls).await;
    assert_eq!(t.s.ledger().command(&id).unwrap().status, "host_confirmed");
    assert!(!host.snapshot.as_ref().unwrap().runnable);
    let denied = queue(
        &app,
        &t,
        &token,
        &t.grant,
        1,
        host.revision,
        json!({"method":"enable","params":{}}),
    )
    .await;
    host.tick(&t, &mut controls).await;
    assert_eq!(
        t.s.ledger()
            .command(&denied)
            .unwrap()
            .receipt
            .unwrap()
            .status,
        ReceiptStatus::Failed
    );
    assert_eq!(host.snapshot.as_ref().unwrap().admission, Admission::Closed);
    for (method, params) in [
        ("configure", config),
        ("enable", json!({})),
        ("disable", json!({"policy":"cancel"})),
        ("delete", json!({"confirmation":"合成生命周期 Bot"})),
    ] {
        let id = queue(
            &app,
            &t,
            &token,
            &t.grant,
            1,
            host.revision,
            json!({"method":method,"params":params}),
        )
        .await;
        host.tick(&t, &mut controls).await;
        assert_eq!(
            t.s.ledger().command(&id).unwrap().receipt.unwrap().status,
            ReceiptStatus::Persisted
        );
        assert_ne!(host.snapshot.as_ref().unwrap().activity, Activity::Running);
    }
    assert!(host.snapshot.as_ref().unwrap().deleted);
    assert_eq!(call(&app,"/api/bots/grants/revoke",Some(&token),json!({"grant_id":t.grant.id,"expected_generation":1,"mutation_id":Uuid::new_v4().to_string()})).await.0,StatusCode::OK);
    host.tick(&t, &mut controls).await;
    assert_eq!(
        t.s.ledger().grant(&t.grant.id).unwrap().state,
        crate::execution_store::GrantState::Revoked
    );
    let mut fresh = t.grant.clone();
    fresh.id = Uuid::new_v4().to_string();
    fresh.generation = 2;
    assert_eq!(
        call(
            &app,
            "/api/bots/grants/accept",
            Some(&token),
            json!({"grant":fresh,"expected_generation":1})
        )
        .await
        .0,
        StatusCode::OK
    );
    let id = queue(
        &app,
        &t,
        &token,
        &fresh,
        2,
        host.revision,
        json!({"method":"restore","params":{}}),
    )
    .await;
    host.tick(&t, &mut controls).await;
    assert_eq!(t.s.ledger().command(&id).unwrap().status, "host_confirmed");
    assert!(!host.snapshot.as_ref().unwrap().deleted);
    assert_eq!(host.snapshot.as_ref().unwrap().binding_generation, 2);
    controls.conflict_next = true;
    let id = queue(
        &app,
        &t,
        &token,
        &fresh,
        2,
        host.revision,
        json!({"method":"enable","params":{}}),
    )
    .await;
    host.tick(&t, &mut controls).await;
    assert_eq!(
        t.s.ledger().command(&id).unwrap().receipt.unwrap().status,
        ReceiptStatus::Conflict
    );
    controls.paused = true;
    let id = queue(
        &app,
        &t,
        &token,
        &fresh,
        2,
        host.revision,
        json!({"method":"disable","params":{"policy":"cancel"}}),
    )
    .await;
    host.tick(&t, &mut controls).await;
    assert_eq!(t.s.ledger().command(&id).unwrap().lease_count, 0);
    assert!(t.s.ledger().command(&id).unwrap().receipt.is_none());
    controls.paused = false;
    host.tick(&t, &mut controls).await;
    assert_eq!(t.s.ledger().command(&id).unwrap().status, "host_confirmed");
    assert_eq!(host.observation(&t).allowed_bot_ids, vec![t.bot_id.clone()]);
}
