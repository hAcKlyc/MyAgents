//! Model access uses the existing enrolled Host and account owners. A cloud
//! assignment does not grant process execution or access to a private session.
use crate::{
    admin_http::{AdminService, Err},
    model_center_store::ModelCenterStore,
    model_center_types::{ModelCenterError as E, Result, ValidatedBot},
    relay_controller::RelayController,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    routing::post,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

fn two() -> u32 {
    2
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCenterConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "two")]
    pub concurrency_limit: u32,
    #[serde(default)]
    pub daily_cost_microusd: Option<u64>,
}
pub(crate) type LiveValidator = Arc<dyn Fn(&ValidatedBot) -> Result<ValidatedBot> + Send + Sync>;
#[derive(Clone)]
pub(crate) struct ModelAuthority {
    admin: AdminService,
    relay: Arc<RelayController>,
    store: Arc<ModelCenterStore>,
    config: ModelCenterConfig,
}
impl ModelAuthority {
    pub(crate) fn new(
        admin: AdminService,
        relay: Arc<RelayController>,
        store: Arc<ModelCenterStore>,
        config: ModelCenterConfig,
    ) -> Self {
        Self {
            admin,
            relay,
            store,
            config,
        }
    }
    pub(crate) fn validator(&self) -> LiveValidator {
        let s = self.clone();
        Arc::new(move |scope| s.current(scope, None, false))
    }
    pub(crate) fn captured_validator(&self) -> LiveValidator {
        let s = self.clone();
        Arc::new(move |scope| s.current(scope, None, true))
    }
    fn current(
        &self,
        scope: &ValidatedBot,
        actor: Option<&str>,
        captured: bool,
    ) -> Result<ValidatedBot> {
        self.relay
            .with_model_host(&scope.owner_id, &scope.host_id, actor, |host| {
                let bot = self
                    .admin
                    .store
                    .bots()
                    .map_err(|_| E::Storage)?
                    .into_iter()
                    .find(|b| {
                        b.id == scope.bot_id && !b.deleted && b.configured && b.runtime == "builtin"
                    })
                    .ok_or(E::Unauthorized)?;
                if bot.owner_id != scope.owner_id
                    || bot.host_id != scope.host_id
                    || !self.admin.config.hosts.iter().any(|h| {
                        h.id == bot.host_id
                            && h.owner_ids.contains(&bot.owner_id)
                            && h.runtimes.iter().any(|r| r == "builtin")
                    })
                {
                    return Err(E::Unauthorized);
                }
                let model_ref = if captured {
                    scope.model_ref.clone()
                } else {
                    bot.model_ref.ok_or(E::Unauthorized)?
                };
                let model = self.store.model(&model_ref)?;
                if !model.config.enabled || !model.config.owner_ids.contains(&bot.owner_id) {
                    return Err(E::Unauthorized);
                }
                Ok(ValidatedBot {
                    bot_id: bot.id,
                    owner_id: bot.owner_id,
                    host_id: bot.host_id,
                    host_key_generation: host.scope.host_key_generation,
                    identity_binding_id: host.scope.identity_binding_id,
                    model_ref,
                    binding_revision: bot.revision,
                    daily_tokens: bot.daily_tokens.min(self.admin.config.max_daily_tokens),
                    daily_cost_microusd: self.config.daily_cost_microusd,
                    concurrency_limit: self.config.concurrency_limit,
                })
            })
    }
    pub(crate) fn router(&self) -> Router {
        Router::new()
            .route(
                "/api/admin/bots/{id}/model-access",
                post(issue).delete(revoke),
            )
            .with_state(Arc::new(self.clone()))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessRequest {
    allowed_model_refs: Vec<String>,
    ttl_seconds: u64,
}
fn token(headers: &HeaderMap, origin: &str) -> std::result::Result<String, Err> {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(origin) {
        return Err(Err::new(StatusCode::FORBIDDEN, "ORIGIN_REJECTED"));
    }
    let values = headers
        .get_all(header::AUTHORIZATION)
        .iter()
        .collect::<Vec<_>>();
    if values.len() != 1 {
        return Err(Err::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    values[0]
        .to_str()
        .ok()
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty() && v.len() < 120)
        .map(str::to_owned)
        .ok_or_else(|| Err::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"))
}
fn gate(s: &ModelAuthority, bearer: &str, bot_id: &str) -> std::result::Result<ValidatedBot, Err> {
    let session = s.admin.auth.validate_session(bearer).map_err(Err::auth)?;
    if !s
        .admin
        .config
        .admin_principal_ids
        .contains(&session.account.principal_id)
    {
        return Err(Err::new(StatusCode::FORBIDDEN, "ADMIN_REQUIRED"));
    }
    let bot = s
        .admin
        .store
        .bots()
        .map_err(|_| Err::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_STORAGE_UNAVAILABLE"))?
        .into_iter()
        .find(|b| b.id == bot_id)
        .ok_or_else(|| Err::new(StatusCode::NOT_FOUND, "BOT_NOT_FOUND"))?;
    if bot.owner_id != session.account.principal_id {
        return Err(Err::new(
            StatusCode::FORBIDDEN,
            "BOT_OWNER_CONSENT_REQUIRED",
        ));
    }
    let seed = ValidatedBot {
        bot_id: bot.id,
        owner_id: bot.owner_id,
        host_id: bot.host_id,
        host_key_generation: 1,
        identity_binding_id: Uuid::nil().to_string(),
        model_ref: bot.model_ref.unwrap_or_default(),
        binding_revision: bot.revision,
        daily_tokens: bot.daily_tokens,
        daily_cost_microusd: s.config.daily_cost_microusd,
        concurrency_limit: s.config.concurrency_limit,
    };
    s.current(&seed, Some(&session.session_handle), false)
        .map_err(|_| Err::new(StatusCode::FORBIDDEN, "LIVE_BOT_HOST_OWNER_REQUIRED"))
}
async fn issue(
    State(s): State<Arc<ModelAuthority>>,
    Path(id): Path<String>,
    h: HeaderMap,
    Json(body): Json<AccessRequest>,
) -> std::result::Result<Json<Value>, Err> {
    Uuid::parse_str(&id).map_err(|_| Err::bad())?;
    let bearer = token(&h, &s.admin.origin)?;
    let out = tokio::task::spawn_blocking(move || {
        let scope = gate(&s,&bearer,&id)?;
        let credential = s.store.issue_bot_credential_for_models(&scope,&body.allowed_model_refs,body.ttl_seconds)
            .map_err(|_|Err::new(StatusCode::BAD_REQUEST,"MODEL_ACCESS_REQUEST_REJECTED"))?;
        Ok::<_,Err>(json!({"ok":true,"data":{"access_token":credential.bearer,"expires_at":credential.expires_at,
            "bot_id":scope.bot_id,"host_id":scope.host_id,"allowed_model_refs":body.allowed_model_refs,
            "daily_tokens":scope.daily_tokens,"concurrency_limit":scope.concurrency_limit,"secret_shown_once":true}}))
    }).await.map_err(|_|Err::new(StatusCode::SERVICE_UNAVAILABLE,"MODEL_ACCESS_UNAVAILABLE"))??;
    Ok(Json(out))
}
async fn revoke(
    State(s): State<Arc<ModelAuthority>>,
    Path(id): Path<String>,
    h: HeaderMap,
) -> std::result::Result<Json<Value>, Err> {
    Uuid::parse_str(&id).map_err(|_| Err::bad())?;
    token(&h, &s.admin.origin)?;
    crate::admin_http::blocking_admin(
        Arc::new(s.admin.clone()),
        h,
        Some(s.admin.origin.clone()),
        move |actor, _| {
            let bot = s
                .admin
                .store
                .bots()
                .map_err(|_| {
                    Err::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_STORAGE_UNAVAILABLE")
                })?
                .into_iter()
                .find(|b| b.id == id)
                .ok_or_else(|| Err::new(StatusCode::NOT_FOUND, "BOT_NOT_FOUND"))?;
            if bot.owner_id != actor {
                return Err(Err::new(
                    StatusCode::FORBIDDEN,
                    "BOT_OWNER_CONSENT_REQUIRED",
                ));
            }
            s.store
                .revoke_bot(&id)
                .map_err(|_| Err::new(StatusCode::SERVICE_UNAVAILABLE, "MODEL_ACCESS_UNAVAILABLE"))
        },
    )
    .await?;
    Ok(Json(json!({"ok":true,"data":{"revoked":true}})))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model_center_types::{
        ApiProtocol, AuthType, ModelWrite, ProviderWrite, UpstreamFormat,
    };
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    pub(crate) async fn fixture() -> (
        crate::execution_http::tests::Setup,
        ModelAuthority,
        ValidatedBot,
        String,
    ) {
        let t = crate::execution_http::tests::browser_setup().await;
        let mut admin = t.browser_admin_service();
        let store = Arc::new(ModelCenterStore::open(t.f.dir.path(), &t.f.network).unwrap());
        let provider = Uuid::new_v4().to_string();
        store
            .put_provider(
                &t.admin.context.principal_id,
                &Uuid::new_v4().to_string(),
                ProviderWrite {
                    id: provider.clone(),
                    label: "fixture provider".into(),
                    base_url: "https://supplier.example.test".into(),
                    api_protocol: ApiProtocol::Anthropic,
                    auth_type: AuthType::ApiKey,
                    upstream_format: UpstreamFormat::ChatCompletions,
                    max_output_tokens_param_name: "max_tokens".into(),
                    max_output_tokens: 10,
                    enabled: true,
                    api_key: Some("fixture-key-never-real".into()),
                },
                0,
            )
            .unwrap();
        let mut models = Vec::new();
        for _ in 0..2 {
            let id = Uuid::new_v4().to_string();
            store
                .put_model(
                    &t.admin.context.principal_id,
                    &Uuid::new_v4().to_string(),
                    ModelWrite {
                        id: id.clone(),
                        provider_id: provider.clone(),
                        model_id: "fixture-model".into(),
                        label: "fixture model".into(),
                        owner_ids: vec![t.admin.context.principal_id.clone()],
                        enabled: true,
                        input_price_microusd_per_million: None,
                        output_price_microusd_per_million: None,
                        price_version: None,
                    },
                    0,
                )
                .unwrap();
            models.push(id);
        }
        admin.connect_models(store.clone());
        let bot = admin
            .store
            .bots()
            .unwrap()
            .into_iter()
            .find(|b| b.id == t.bot_id)
            .unwrap();
        admin
            .store
            .mutate(
                &t.admin.context.principal_id,
                "configure",
                Uuid::new_v4(),
                &json!({"id":bot.id,"model_ref":models[0],"system_prompt":"fixture only"}),
                Some(bot.revision),
                &admin.effective_config().unwrap(),
                std::slice::from_ref(&t.admin.context.principal_id),
            )
            .unwrap();
        let authority = ModelAuthority::new(
            admin,
            t.model_relay(),
            store,
            ModelCenterConfig {
                enabled: true,
                concurrency_limit: 2,
                daily_cost_microusd: None,
            },
        );
        let seed = ValidatedBot {
            bot_id: t.bot_id.clone(),
            owner_id: t.admin.context.principal_id.clone(),
            host_id: t.host.context.device_id.clone(),
            host_key_generation: 1,
            identity_binding_id: Uuid::new_v4().to_string(),
            model_ref: models[0].clone(),
            binding_revision: 1,
            daily_tokens: 100,
            daily_cost_microusd: None,
            concurrency_limit: 2,
        };
        let live = (authority.validator())(&seed).unwrap();
        (t, authority, live, models[1].clone())
    }
    #[tokio::test]
    async fn actual_host_gate_checks_account_and_captured_assignment() {
        let (t, s, scope, second) = fixture().await;
        let credential = s
            .store
            .issue_bot_credential_for_models(
                &scope,
                &[scope.model_ref.clone(), second.clone()],
                600,
            )
            .unwrap();
        let session = s
            .store
            .issue_session(&credential.bearer, &scope, &Uuid::new_v4().to_string(), 300)
            .unwrap();
        s.admin
            .store
            .mutate(
                &scope.owner_id,
                "configure",
                Uuid::new_v4(),
                &json!({"id":scope.bot_id,"model_ref":second}),
                Some(scope.binding_revision),
                &s.admin.effective_config().unwrap(),
                std::slice::from_ref(&scope.owner_id),
            )
            .unwrap();
        assert_eq!((s.validator())(&scope).unwrap().model_ref, second);
        assert_eq!(
            (s.captured_validator())(&session.lease.bot)
                .unwrap()
                .model_ref,
            scope.model_ref
        );
        let mut foreign = scope.clone();
        foreign.owner_id = t.other.context.principal_id.clone();
        assert!((s.validator())(&foreign).is_err());
        t.f.auth.revoke_session(&t.host.account_token).unwrap();
        assert!((s.validator())(&scope).is_err());
        assert!((s.captured_validator())(&scope).is_err());
    }
    #[tokio::test]
    async fn owner_consent_required_and_revoke_works_with_host_offline() {
        let (t, s, scope, _) = fixture().await;
        let call = |token: &str, method: &str| {
            Request::builder()
                .method(method)
                .uri(format!("/api/admin/bots/{}/model-access", scope.bot_id))
                .header("origin", &s.admin.origin)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"allowed_model_refs":[scope.model_ref],"ttl_seconds":600}).to_string(),
                ))
                .unwrap()
        };
        let denied = s
            .router()
            .oneshot(call(&t.other.account_token, "POST"))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let granted = s
            .router()
            .oneshot(call(&t.admin.account_token, "POST"))
            .await
            .unwrap();
        assert_eq!(granted.status(), StatusCode::OK);
        let data: Value =
            serde_json::from_slice(&to_bytes(granted.into_body(), 16384).await.unwrap()).unwrap();
        let access = data["data"]["access_token"].as_str().unwrap();
        assert!(s.store.authenticate_bot_grant(access).is_ok());
        t.f.auth.revoke_session(&t.host.account_token).unwrap();
        let revoked = s
            .router()
            .oneshot(call(&t.admin.account_token, "DELETE"))
            .await
            .unwrap();
        assert_eq!(revoked.status(), StatusCode::OK);
        assert!(s.store.authenticate_bot_grant(access).is_err());
        t.f.auth.revoke_session(&t.admin.account_token).unwrap();
        assert_eq!(
            s.router()
                .oneshot(call(&t.admin.account_token, "POST"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[cfg(test)]
#[tokio::test]
#[ignore = "manual loopback model center browser fixture; synthetic identities, no inference"]
async fn model_center_browser_fixture() {
    let (t, authority, scope, _) = tests::fixture().await;
    // Explicit synthetic metering records, never supplier inference. Browser
    // acceptance must exercise both known/unknown fields and an empty filter.
    let credential = authority.store.issue_bot_credential(&scope, 600).unwrap();
    for outcome in ["success", "upstream_error"] {
        let lease = authority
            .store
            .issue_session(&credential.bearer, &scope, &Uuid::new_v4().to_string(), 300)
            .unwrap();
        let request = Uuid::new_v4().to_string();
        authority
            .store
            .reserve(&lease.bearer, &request, 10, 10)
            .unwrap();
        let usage = if outcome == "success" {
            Some(crate::model_center_types::TokenUsage {
                input: 3,
                output: 2,
            })
        } else {
            None
        };
        authority
            .store
            .settle(&lease.lease, &request, usage, outcome)
            .unwrap();
    }
    let mut priced = authority.store.model(&scope.model_ref).unwrap();
    priced.config.label = "合成计量模型（仅本地验收）".into();
    priced.config.input_price_microusd_per_million = Some(1_000_000);
    priced.config.output_price_microusd_per_million = Some(2_000_000);
    priced.config.price_version = Some("synthetic-fixture-v1".into());
    authority
        .store
        .put_model(
            &scope.owner_id,
            &Uuid::new_v4().to_string(),
            priced.config,
            priced.revision,
        )
        .unwrap();
    let lease = authority
        .store
        .issue_session(&credential.bearer, &scope, &Uuid::new_v4().to_string(), 300)
        .unwrap();
    let request = Uuid::new_v4().to_string();
    authority
        .store
        .reserve(&lease.bearer, &request, 10, 10)
        .unwrap();
    authority
        .store
        .settle(
            &lease.lease,
            &request,
            Some(crate::model_center_types::TokenUsage {
                input: 3,
                output: 2,
            }),
            "success",
        )
        .unwrap();
    let mut subjects = std::collections::HashMap::new();
    subjects.insert("admin".into(), t.f.verified_subject("execution-owner"));
    subjects.insert("ordinary".into(), t.f.verified_subject("execution-other"));
    let http = crate::model_center_http::ModelCenterHttp::new(
        authority.admin.clone(),
        authority.store.clone(),
        authority.validator(),
        authority.captured_validator(),
    );
    let app = crate::admin_http::tests::browser_fixture_router(
        t.f.auth.clone(),
        subjects,
        "http://127.0.0.1:5199/fixture-login".into(),
    )
    .merge(authority.admin.router())
    .merge(http.router())
    .merge(authority.router());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:5199")
        .await
        .unwrap();
    println!(
        "MODEL_CENTER_SYNTHETIC_FIXTURE=http://127.0.0.1:5199/admin (real Rust owners, simulated enrolled Host, no paid call)"
    );
    axum::serve(listener, app).await.unwrap();
}
