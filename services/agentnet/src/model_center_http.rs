//! Admin and finite Host HTTP surfaces for the model center.
//!
//! Administrator operations are authenticated through the existing OIDC gate. Model calls
//! use short-lived Bot/session bearers and never hold the admin auth lock across upstream IO.
use super::{
    admin_http::{self, AdminService, Err as HttpError},
    model_center_gateway::{LiveCheck, ModelCenterGateway},
    model_center_store::ModelCenterStore,
    model_center_types::{
        ApiProtocol, ModelCenterError, ModelWrite, ProviderWrite, SessionLease, UpstreamFormat,
        UsageRecord, ValidatedBot,
    },
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

type LiveBotCheck =
    Arc<dyn Fn(&ValidatedBot) -> super::model_center_types::Result<ValidatedBot> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct ModelCenterHttp {
    admin: Arc<AdminService>,
    store: Arc<ModelCenterStore>,
    gateway: ModelCenterGateway,
    live: LiveBotCheck,
    live_session: LiveBotCheck,
}

impl ModelCenterHttp {
    pub(crate) fn new(
        admin: AdminService,
        store: Arc<ModelCenterStore>,
        live: LiveBotCheck,
        live_session: LiveBotCheck,
    ) -> Self {
        Self {
            admin: Arc::new(admin),
            store,
            gateway: ModelCenterGateway::new(),
            live,
            live_session,
        }
    }

    pub(crate) fn router(&self) -> Router<()> {
        let state = Arc::new(self.clone());
        Router::new()
            .route("/api/admin/model-center", get(model_center))
            .route("/api/admin/model-providers", post(create_provider))
            .route(
                "/api/admin/model-providers/{id}",
                patch(update_provider).delete(delete_provider),
            )
            .route("/api/admin/model-providers/{id}/probe", get(probe_provider))
            .route("/api/admin/models", post(create_model))
            .route(
                "/api/admin/models/{id}",
                patch(update_model).delete(delete_model),
            )
            .route("/api/admin/model-mutations/{id}", get(model_mutation))
            .route("/api/admin/model-usage", get(model_usage))
            .route("/api/admin/bots/{id}/model", post(assign_bot_model))
            .route("/api/bot-model/sessions", post(create_session))
            .route(
                "/api/bot-model/sessions/{session_id}/v1/messages",
                post(invoke_anthropic),
            )
            .route(
                "/api/bot-model/sessions/{session_id}/v1/messages/count_tokens",
                post(count_tokens),
            )
            .route(
                "/api/bot-model/sessions/{session_id}/v1/chat/completions",
                post(invoke_chat_completions),
            )
            .route(
                "/api/bot-model/sessions/{session_id}/v1/responses",
                post(invoke_responses),
            )
            // Chat payloads are bounded to 1 MiB. Admin mutations remain far below this limit.
            .layer(DefaultBodyLimit::max(1_048_576))
            .layer(middleware::from_fn(no_store))
            .with_state(state)
    }
}

async fn model_center(
    State(s): State<Arc<ModelCenterHttp>>,
    headers: HeaderMap,
) -> Result<Json<Value>, HttpError> {
    let origin = request_origin(&headers);
    let response = admin_http::blocking_admin(s.admin.clone(), headers, origin, move |_, _| {
        let providers = s.store.providers().map_err(map_model_error)?;
        let models = s.store.models().map_err(map_model_error)?;
        let bots = s.admin.store.bots().map_err(|_| HttpError::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_STORAGE_UNAVAILABLE"))?;
        let bindings: Vec<Value> = bots.iter().map(|bot| json!({
            "bot_id": bot.id,
            "desired_model_ref": bot.model_ref,
            "revision": bot.revision,
        })).collect();
        Ok(json!({ "enabled": true, "providers": providers, "models": models, "bindings": bindings }))
    }).await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

async fn create_provider(
    State(s): State<Arc<ModelCenterHttp>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let (mutation_id, expected_revision, write) = provider_write(body, None)?;
    if expected_revision != 0 {
        return Err(HttpError::new(
            StatusCode::CONFLICT,
            "MODEL_CENTER_REVISION_CONFLICT",
        ));
    }
    let origin = request_origin(&headers);
    let response = admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, _| {
        let row = s
            .store
            .put_provider(actor, &mutation_id, write, expected_revision)
            .map_err(map_model_error)?;
        serde_json::to_value(row).map_err(|_| {
            HttpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MODEL_CENTER_STORAGE_UNAVAILABLE",
            )
        })
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

async fn update_provider(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let id = parse_path_uuid(&raw_id)?;
    let (mutation_id, expected_revision, write) = provider_write(body, Some(&id))?;
    let origin = request_origin(&headers);
    let response = admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, _| {
        let row = s
            .store
            .put_provider(actor, &mutation_id, write, expected_revision)
            .map_err(map_model_error)?;
        serde_json::to_value(row).map_err(|_| {
            HttpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MODEL_CENTER_STORAGE_UNAVAILABLE",
            )
        })
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteMutation {
    mutation_id: String,
    expected_revision: u64,
}

async fn delete_provider(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DeleteMutation>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let id = canonical_uuid(&raw_id)?;
    let operation = canonical_mutation(&body.mutation_id)?;
    let origin = request_origin(&headers);
    let response = admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, _| {
        let row = s
            .store
            .delete_provider(actor, &operation, &id, body.expected_revision)
            .map_err(map_model_error)?;
        serde_json::to_value(row).map_err(|_| {
            HttpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MODEL_CENTER_STORAGE_UNAVAILABLE",
            )
        })
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

async fn create_model(
    State(s): State<Arc<ModelCenterHttp>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let (mutation_id, expected_revision, write) = model_write(body)?;
    if expected_revision != 0 {
        return Err(HttpError::new(
            StatusCode::CONFLICT,
            "MODEL_CENTER_REVISION_CONFLICT",
        ));
    }
    let origin = request_origin(&headers);
    let response =
        admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, accounts| {
            require_registered_owners(&write.owner_ids, accounts)?;
            let row = s
                .store
                .put_model(actor, &mutation_id, write, expected_revision)
                .map_err(map_model_error)?;
            serde_json::to_value(row).map_err(|_| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "MODEL_CENTER_STORAGE_UNAVAILABLE",
                )
            })
        })
        .await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

async fn update_model(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let id = parse_path_uuid(&raw_id)?;
    let (mutation_id, expected_revision, write) = model_write(body)?;
    if write.id != id.to_string() {
        return Err(HttpError::bad());
    }
    let origin = request_origin(&headers);
    let response =
        admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, accounts| {
            require_registered_owners(&write.owner_ids, accounts)?;
            let row = s
                .store
                .put_model(actor, &mutation_id, write, expected_revision)
                .map_err(map_model_error)?;
            serde_json::to_value(row).map_err(|_| {
                HttpError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "MODEL_CENTER_STORAGE_UNAVAILABLE",
                )
            })
        })
        .await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

async fn delete_model(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<DeleteMutation>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let id = canonical_uuid(&raw_id)?;
    let operation = canonical_mutation(&body.mutation_id)?;
    let origin = request_origin(&headers);
    let response = admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, _| {
        let row = s
            .store
            .delete_model(actor, &operation, &id, body.expected_revision)
            .map_err(map_model_error)?;
        serde_json::to_value(row).map_err(|_| {
            HttpError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "MODEL_CENTER_STORAGE_UNAVAILABLE",
            )
        })
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":response})))
}

fn provider_write(
    value: Value,
    id: Option<&Uuid>,
) -> Result<(String, u64, ProviderWrite), HttpError> {
    let (mutation_id, expected_revision, object) = split_mutation(value)?;
    let write: ProviderWrite =
        serde_json::from_value(Value::Object(object)).map_err(|_| HttpError::bad())?;
    if id.is_some_and(|id| write.id != id.to_string()) {
        return Err(HttpError::bad());
    }
    Ok((mutation_id, expected_revision, write))
}

fn model_write(value: Value) -> Result<(String, u64, ModelWrite), HttpError> {
    let (mutation_id, expected_revision, object) = split_mutation(value)?;
    let write: ModelWrite =
        serde_json::from_value(Value::Object(object)).map_err(|_| HttpError::bad())?;
    Ok((mutation_id, expected_revision, write))
}

fn split_mutation(
    value: Value,
) -> Result<(String, u64, serde_json::Map<String, Value>), HttpError> {
    let mut object = value.as_object().cloned().ok_or_else(HttpError::bad)?;
    let mutation = object
        .remove("mutation_id")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(HttpError::bad)?;
    let expected = object
        .remove("expected_revision")
        .and_then(|v| v.as_u64())
        .ok_or_else(HttpError::bad)?;
    Ok((canonical_mutation(&mutation)?, expected, object))
}

async fn model_mutation(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, HttpError> {
    let id = parse_path_uuid(&raw_id)?;
    let origin = request_origin(&headers);
    let result = admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, _| {
        s.store
            .mutation(&id.to_string(), actor)
            .map_err(map_model_error)
    })
    .await?;
    Ok(Json(json!({"ok":true,"data":result})))
}

#[derive(Deserialize)]
struct UsageQuery {
    bot_id: Option<String>,
    owner_id: Option<String>,
    model_ref: Option<String>,
    limit: Option<usize>,
}

async fn model_usage(
    State(s): State<Arc<ModelCenterHttp>>,
    headers: HeaderMap,
    Query(query): Query<UsageQuery>,
) -> Result<Json<Value>, HttpError> {
    let bot_id = query.bot_id.map(|v| canonical_uuid(&v)).transpose()?;
    let owner_id = query.owner_id.map(|v| canonical_uuid(&v)).transpose()?;
    let model_ref = query.model_ref.map(|v| canonical_uuid(&v)).transpose()?;
    let limit = query.limit.unwrap_or(100).clamp(1, 100);
    let origin = request_origin(&headers);
    let result =
        admin_http::blocking_admin(s.admin.clone(), headers, origin, move |_, accounts| {
            if let Some(owner) = &owner_id {
                require_registered_owners(std::slice::from_ref(owner), accounts)?;
            }
            let all = s.store.usage(500).map_err(map_model_error)?;
            let filtered = all
                .into_iter()
                .filter(|r| {
                    bot_id.as_ref().is_none_or(|v| &r.bot_id == v)
                        && owner_id.as_ref().is_none_or(|v| &r.owner_id == v)
                        && model_ref.as_ref().is_none_or(|v| &r.model_ref == v)
                })
                .collect::<Vec<_>>();
            let summary = usage_summary(&filtered);
            let rows = filtered
                .into_iter()
                .take(limit)
                .map(usage_public)
                .collect::<Vec<_>>();
            Ok(json!({"rows":rows,"summary":summary,"window_limit":500}))
        })
        .await?;
    Ok(Json(json!({"ok":true,"data":result})))
}

fn usage_public(r: UsageRecord) -> Value {
    json!({
        "request_id":r.request_id,"bot_id":r.bot_id,"owner_id":r.owner_id,"session_id":r.session_id,
        "model_ref":r.model_ref,"model_revision":r.model_revision,"provider_revision":r.provider_revision,
        "started_at":r.started_at,"completed_at":r.completed_at,"duration_ms":r.duration_ms,
        "outcome":r.outcome,"input_tokens":r.input_tokens,"output_tokens":r.output_tokens,
        "charged_tokens":r.charged_tokens,"cost_microusd":r.cost_microusd,
        "price_version":r.price_version,"usage_known":r.usage_known
    })
}

fn usage_summary(rows: &[UsageRecord]) -> Value {
    let tokens = rows.iter().try_fold(0u64, |sum, row| {
        if !row.usage_known {
            return None;
        }
        sum.checked_add(row.input_tokens?)
            .and_then(|v| v.checked_add(row.output_tokens?))
    });
    let cost = rows
        .iter()
        .try_fold(0u64, |sum, row| sum.checked_add(row.cost_microusd?));
    let duration = if rows.is_empty() {
        Some(0)
    } else {
        rows.iter()
            .try_fold(0u128, |sum, row| {
                sum.checked_add(u128::from(row.duration_ms?))
            })
            .map(|sum| (sum / rows.len() as u128) as u64)
    };
    let failure_rate = if rows.is_empty() || rows.iter().any(|r| r.outcome == "reserved") {
        None
    } else {
        Some(rows.iter().filter(|r| r.outcome != "success").count() as f64 / rows.len() as f64)
    };
    json!({"requests":rows.len(),"tokens":tokens,"cost_microusd":cost,"avg_duration_ms":duration,"failure_rate":failure_rate})
}

async fn probe_provider(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, HttpError> {
    let id = parse_path_uuid(&raw_id)?;
    let origin = request_origin(&headers);
    let store = s.store.clone();
    admin_http::blocking_admin(s.admin.clone(), headers, origin, move |_, _| {
        store.provider(&id.to_string()).map_err(map_model_error)?;
        Ok(())
    })
    .await?;
    let result = s
        .gateway
        .probe(s.store.clone(), &id.to_string())
        .await
        .map_err(map_model_error)?;
    Ok(Json(json!({"ok":true,"data":result})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssignModel {
    mutation_id: String,
    expected_revision: u64,
    model_ref: String,
}

async fn assign_bot_model(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<AssignModel>,
) -> Result<Json<Value>, HttpError> {
    require_write_origin(&s.admin, &headers)?;
    let bot_id = parse_path_uuid(&raw_id)?;
    let operation = canonical_mutation(&body.mutation_id)?;
    let model_ref = canonical_uuid(&body.model_ref)?;
    let operation_uuid = valid_uuid(&operation)?;
    let origin = request_origin(&headers);
    let result =
        admin_http::blocking_admin(s.admin.clone(), headers, origin, move |actor, accounts| {
            let registered = accounts
                .iter()
                .map(|a| a.principal_id.clone())
                .collect::<Vec<_>>();
            // Hash only the caller's stable request projection. Reading the previous receipt first
            // lets AdminStore decide exact replay vs. same-ID conflict before mutable Bot/provider
            // state or the expected revision can reject a completed operation.
            let registry_body = json!({
                "id":bot_id.to_string(),"model_ref":model_ref,
                "mutation_id":operation.to_string(),"expected_revision":body.expected_revision
            });
            let config = s.admin.effective_config()?;
            let prior = s.admin.store.mutation(operation_uuid, actor);
            if prior.is_ok() {
                return s
                    .admin
                    .store
                    .mutate(
                        actor,
                        "configure",
                        operation_uuid,
                        &registry_body,
                        Some(body.expected_revision),
                        &config,
                        &registered,
                    )
                    .map_err(|(code, retry)| mutation_error(code, retry));
            }
            if prior != Err("mutation not found") {
                return Err(HttpError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ADMIN_STORAGE_UNAVAILABLE",
                ));
            }
            let bots = s.admin.store.bots().map_err(|_| {
                HttpError::new(StatusCode::SERVICE_UNAVAILABLE, "ADMIN_STORAGE_UNAVAILABLE")
            })?;
            let bot = bots
                .into_iter()
                .find(|b| b.id == bot_id.to_string())
                .ok_or_else(|| HttpError::new(StatusCode::NOT_FOUND, "BOT_NOT_FOUND"))?;
            if bot.deleted {
                return Err(HttpError::new(StatusCode::CONFLICT, "BOT_DELETED"));
            }
            let model = s.store.model(&model_ref).map_err(map_model_error)?;
            let provider = s
                .store
                .provider(&model.config.provider_id)
                .map_err(map_model_error)?;
            if !model.config.enabled || !provider.enabled {
                return Err(HttpError::new(
                    StatusCode::CONFLICT,
                    "MODEL_CENTER_DISABLED",
                ));
            }
            if !model.config.owner_ids.contains(&bot.owner_id) {
                return Err(HttpError::new(
                    StatusCode::FORBIDDEN,
                    "MODEL_ASSIGNMENT_FORBIDDEN",
                ));
            }
            if !config.model_refs.iter().any(|r| {
                r.id == model_ref
                    && r.owner_ids.contains(&bot.owner_id)
                    && r.runtimes.contains(&bot.runtime)
            }) {
                return Err(HttpError::new(
                    StatusCode::FORBIDDEN,
                    "MODEL_ASSIGNMENT_FORBIDDEN",
                ));
            }
            let updated = s
                .admin
                .store
                .mutate(
                    actor,
                    "configure",
                    operation_uuid,
                    &registry_body,
                    Some(body.expected_revision),
                    &config,
                    &registered,
                )
                .map_err(|(code, retry)| mutation_error(code, retry))?;
            Ok(updated)
        })
        .await?;
    Ok(Json(json!({"ok":true,"data":result})))
}

fn mutation_error(code: &'static str, retryable: bool) -> HttpError {
    let status = match code {
        "BOT_NOT_FOUND" => StatusCode::NOT_FOUND,
        "RESOURCE_ASSIGNMENT_FORBIDDEN" => StatusCode::FORBIDDEN,
        "admin storage unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        c if c.contains("CONFLICT") || c.contains("REQUIRED") => StatusCode::CONFLICT,
        _ => StatusCode::BAD_REQUEST,
    };
    let _ = retryable;
    HttpError::new(status, code)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSession {
    bot_id: String,
    host_id: String,
    model_ref: String,
    max_output_tokens: u64,
    max_total_tokens: u64,
}

async fn create_session(
    State(s): State<Arc<ModelCenterHttp>>,
    headers: HeaderMap,
    Json(body): Json<CreateSession>,
) -> Result<Json<Value>, HttpError> {
    let bearer = bearer(&headers)?;
    let grant = s
        .store
        .authenticate_bot_grant(&bearer)
        .map_err(map_model_error)?;
    let bot_id = canonical_uuid(&body.bot_id)?;
    let host_id = canonical_uuid(&body.host_id)?;
    let model_ref = canonical_uuid(&body.model_ref)?;
    if grant.scope.bot_id != bot_id
        || grant.scope.host_id != host_id
        || !grant.allowed_model_refs.contains(&model_ref)
    {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    if body.max_output_tokens == 0
        || body.max_output_tokens > grant.max_output_tokens
        || body.max_total_tokens == 0
        || body.max_total_tokens > grant.scope.daily_tokens
    {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    let mut candidate = grant.scope.clone();
    candidate.model_ref = model_ref.clone();
    let current = (s.live)(&candidate).map_err(map_model_error)?;
    if !same_host_bot(&candidate, &current) || current.model_ref != model_ref {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    let total = body
        .max_total_tokens
        .min(current.daily_tokens)
        .min(grant.scope.daily_tokens);
    let output = body
        .max_output_tokens
        .min(grant.max_output_tokens)
        .min(total);
    let session_id = Uuid::new_v4().to_string();
    let issued = s
        .store
        .issue_session_with_limits(&bearer, &current, &session_id, 900, output, total)
        .map_err(map_model_error)?;
    Ok(Json(session_lease_wire(
        &s.admin.origin,
        issued.lease,
        issued.bearer,
    )))
}

fn session_lease_wire(origin: &str, lease: SessionLease, access_token: String) -> Value {
    let is_openai = lease.provider.api_protocol == ApiProtocol::Openai;
    let mut value = json!({
        "session_id":lease.session_id,"model_ref":lease.model.config.id,
        "provider_id":lease.provider.id,"model":lease.model.config.model_id,
        "provider_revision":lease.provider.revision,"model_revision":lease.model.revision,
        "gateway_base_url":format!("{origin}/api/bot-model/sessions/{}",lease.session_id),
        "api_protocol":lease.provider.api_protocol,"max_output_tokens":lease.max_output_tokens,
        "max_total_tokens":lease.max_total_tokens,"expires_at":lease.expires_at,"access_token":access_token
    });
    if is_openai {
        value["upstream_format"] = json!(lease.provider.upstream_format);
        value["max_output_tokens_param_name"] = json!(lease.provider.max_output_tokens_param_name);
    } else {
        value["max_output_tokens_param_name"] = json!(lease.provider.max_output_tokens_param_name);
    }
    value
}

async fn invoke_anthropic(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, HttpError> {
    invoke(s, id, headers, body, Invocation::Anthropic).await
}
async fn count_tokens(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(raw_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    let id = parse_path_uuid(&raw_id)?;
    let bearer = bearer(&headers)?;
    let lease = s
        .store
        .authenticate_session(&bearer)
        .map_err(map_model_error)?;
    if lease.session_id != id.to_string() {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    if lease.provider.api_protocol != ApiProtocol::Anthropic {
        return Err(HttpError::new(
            StatusCode::NOT_FOUND,
            "MODEL_CENTER_ROUTE_UNSUPPORTED",
        ));
    }
    let live = (s.live_session)(&lease.bot).map_err(map_model_error)?;
    if !same_host_bot(&lease.bot, &live) {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    let encoded = serde_json::to_vec(&body).map_err(|_| HttpError::bad())?;
    if encoded.len() > 1_048_576 {
        return Err(HttpError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "MODEL_CENTER_REQUEST_TOO_LARGE",
        ));
    }
    let object = body.as_object().ok_or_else(HttpError::bad)?;
    if object.get("model").and_then(Value::as_str) != Some(lease.model.config.model_id.as_str())
        || !object.get("messages").is_some_and(Value::is_array)
    {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    let mut counted = serde_json::Map::new();
    for key in ["system", "messages", "tools"] {
        if let Some(value) = object.get(key) {
            counted.insert(key.to_string(), value.clone());
        }
    }
    let bytes = serde_json::to_vec(&Value::Object(counted))
        .map_err(|_| HttpError::bad())?
        .len();
    let input_tokens = (bytes / 4 + 1) as u64;
    Ok(Json(json!({"input_tokens":input_tokens})))
}
async fn invoke_chat_completions(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, HttpError> {
    invoke(s, id, headers, body, Invocation::ChatCompletions).await
}
async fn invoke_responses(
    State(s): State<Arc<ModelCenterHttp>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, HttpError> {
    invoke(s, id, headers, body, Invocation::Responses).await
}

#[derive(Clone, Copy)]
enum Invocation {
    Anthropic,
    ChatCompletions,
    Responses,
}

async fn invoke(
    s: Arc<ModelCenterHttp>,
    raw_id: String,
    headers: HeaderMap,
    body: Value,
    mode: Invocation,
) -> Result<Response, HttpError> {
    let id = parse_path_uuid(&raw_id)?;
    let bearer = bearer(&headers)?;
    let retries = headers
        .get_all("x-stainless-retry-count")
        .iter()
        .collect::<Vec<_>>();
    if retries.len() > 1 {
        return Err(HttpError::bad());
    }
    if let Some(value) = retries.first() {
        let count = value
            .to_str()
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or_else(HttpError::bad)?;
        if count > 0 {
            return Err(HttpError::new(
                StatusCode::CONFLICT,
                "UPSTREAM_RETRY_NOT_ALLOWED",
            ));
        }
    }
    let lease = s
        .store
        .authenticate_session(&bearer)
        .map_err(map_model_error)?;
    if lease.session_id != id.to_string() {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_CENTER_CREDENTIAL_REJECTED",
        ));
    }
    let path_matches = matches!(
        (
            mode,
            lease.provider.api_protocol,
            lease.provider.upstream_format
        ),
        (Invocation::Anthropic, ApiProtocol::Anthropic, _)
            | (
                Invocation::ChatCompletions,
                ApiProtocol::Openai,
                UpstreamFormat::ChatCompletions
            )
            | (
                Invocation::Responses,
                ApiProtocol::Openai,
                UpstreamFormat::Responses
            )
    );
    if !path_matches {
        return Err(HttpError::new(
            StatusCode::NOT_FOUND,
            "MODEL_CENTER_ROUTE_UNSUPPORTED",
        ));
    }
    let live = s.live_session.clone();
    let check: LiveCheck = Arc::new(move |session| live(&session.bot));
    let response = s
        .gateway
        .invoke_with_headers(
            s.store.clone(),
            bearer,
            Uuid::new_v4().to_string(),
            body,
            check,
            headers,
        )
        .await
        .map_err(map_model_error)?;
    Ok(response)
}

fn require_registered_owners(
    owners: &[String],
    accounts: &[crate::AccountProjection],
) -> Result<(), HttpError> {
    if owners
        .iter()
        .any(|owner| !accounts.iter().any(|a| &a.principal_id == owner))
    {
        return Err(HttpError::new(
            StatusCode::FORBIDDEN,
            "MODEL_OWNER_NOT_REGISTERED",
        ));
    }
    Ok(())
}

fn same_host_bot(a: &ValidatedBot, b: &ValidatedBot) -> bool {
    a.bot_id == b.bot_id
        && a.owner_id == b.owner_id
        && a.host_id == b.host_id
        && a.host_key_generation == b.host_key_generation
        && a.identity_binding_id == b.identity_binding_id
}

fn require_write_origin(admin: &AdminService, headers: &HeaderMap) -> Result<(), HttpError> {
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(value) if value == admin.origin => Ok(()),
        _ => Err(HttpError::new(StatusCode::FORBIDDEN, "ORIGIN_REJECTED")),
    }
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

fn bearer(headers: &HeaderMap) -> Result<String, HttpError> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let value = values
        .next()
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.starts_with("Bearer ") && v.len() > 7 && v.len() <= 16 * 1024)
        .ok_or_else(|| HttpError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"))?;
    if values.next().is_some() {
        return Err(HttpError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    Ok(value[7..].to_owned())
}

fn valid_uuid(id: &str) -> Result<Uuid, HttpError> {
    Uuid::parse_str(id).map_err(|_| HttpError::bad())
}
fn parse_path_uuid(id: &str) -> Result<Uuid, HttpError> {
    valid_uuid(id)
}
fn canonical_uuid(id: &str) -> Result<String, HttpError> {
    Ok(valid_uuid(id)?.to_string())
}
fn canonical_mutation(id: &str) -> Result<String, HttpError> {
    canonical_uuid(id)
}

fn map_model_error(error: ModelCenterError) -> HttpError {
    let (status, code) = match error {
        ModelCenterError::Storage => (
            StatusCode::SERVICE_UNAVAILABLE,
            "MODEL_CENTER_STORAGE_UNAVAILABLE",
        ),
        ModelCenterError::UnsafeState => {
            (StatusCode::SERVICE_UNAVAILABLE, "MODEL_CENTER_UNSAFE_STATE")
        }
        ModelCenterError::Invalid => (StatusCode::BAD_REQUEST, "MODEL_CENTER_INVALID_REQUEST"),
        ModelCenterError::RevisionConflict => {
            (StatusCode::CONFLICT, "MODEL_CENTER_REVISION_CONFLICT")
        }
        ModelCenterError::NotFound => (StatusCode::NOT_FOUND, "MODEL_CENTER_NOT_FOUND"),
        ModelCenterError::Unauthorized => {
            (StatusCode::FORBIDDEN, "MODEL_CENTER_CREDENTIAL_REJECTED")
        }
        ModelCenterError::Disabled => (StatusCode::CONFLICT, "MODEL_CENTER_DISABLED"),
        ModelCenterError::Quota => (StatusCode::TOO_MANY_REQUESTS, "MODEL_CENTER_QUOTA_EXCEEDED"),
        ModelCenterError::PriceUnknown => (StatusCode::CONFLICT, "MODEL_CENTER_PRICE_UNKNOWN"),
        ModelCenterError::Replay => (StatusCode::CONFLICT, "MODEL_CENTER_REQUEST_REPLAY"),
        ModelCenterError::Upstream => (StatusCode::BAD_GATEWAY, "MODEL_CENTER_UPSTREAM_REJECTED"),
        ModelCenterError::Timeout => (StatusCode::GATEWAY_TIMEOUT, "MODEL_CENTER_UPSTREAM_TIMEOUT"),
        ModelCenterError::OutputLimit => {
            (StatusCode::PAYLOAD_TOO_LARGE, "MODEL_CENTER_OUTPUT_LIMIT")
        }
        ModelCenterError::UnsafeUpstream => {
            (StatusCode::BAD_GATEWAY, "MODEL_CENTER_UNSAFE_UPSTREAM")
        }
    };
    HttpError::new(status, code)
}

async fn no_store(req: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model_center_authority::{ModelAuthority, ModelCenterConfig},
        model_center_types::{AuthType, ModelWrite},
    };
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    struct Fixture {
        t: crate::execution_http::tests::Setup,
        store: Arc<ModelCenterStore>,
        admin: AdminService,
        service: ModelCenterHttp,
        bot_id: String,
        provider_id: String,
        model_ids: Vec<String>,
        authority: ModelAuthority,
        scope: ValidatedBot,
    }

    async fn fixture() -> Fixture {
        let t = crate::execution_http::tests::browser_setup().await;
        let mut admin = t.browser_admin_service();
        let store = Arc::new(ModelCenterStore::open(t.f.dir.path(), &t.f.network).unwrap());
        let actor = t.admin.context.principal_id.clone();
        let provider_id = Uuid::new_v4().to_string();
        store
            .put_provider(
                &actor,
                &Uuid::new_v4().to_string(),
                ProviderWrite {
                    id: provider_id.clone(),
                    label: "fixture supplier".into(),
                    base_url: "https://model-center-test.invalid/v1".into(),
                    api_protocol: ApiProtocol::Anthropic,
                    auth_type: AuthType::ApiKey,
                    upstream_format: UpstreamFormat::ChatCompletions,
                    max_output_tokens_param_name: "max_tokens".into(),
                    max_output_tokens: 128,
                    enabled: true,
                    api_key: Some("fixture-secret-never-return".into()),
                },
                0,
            )
            .unwrap();
        let mut model_ids = Vec::new();
        for model_id in ["fixture-a", "fixture-b"] {
            let id = Uuid::new_v4().to_string();
            store
                .put_model(
                    &actor,
                    &Uuid::new_v4().to_string(),
                    ModelWrite {
                        id: id.clone(),
                        provider_id: provider_id.clone(),
                        model_id: model_id.into(),
                        label: model_id.into(),
                        owner_ids: vec![actor.clone()],
                        enabled: true,
                        input_price_microusd_per_million: None,
                        output_price_microusd_per_million: None,
                        price_version: None,
                    },
                    0,
                )
                .unwrap();
            model_ids.push(id);
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
                &actor,
                "configure",
                Uuid::new_v4(),
                &json!({"id":bot.id,"model_ref":model_ids[0],"system_prompt":"fixture system"}),
                Some(bot.revision),
                &admin.effective_config().unwrap(),
                std::slice::from_ref(&actor),
            )
            .unwrap();
        let authority = ModelAuthority::new(
            admin.clone(),
            t.model_relay(),
            store.clone(),
            ModelCenterConfig {
                enabled: true,
                concurrency_limit: 2,
                daily_cost_microusd: None,
            },
        );
        let seed = ValidatedBot {
            bot_id: t.bot_id.clone(),
            owner_id: actor,
            host_id: t.host.context.device_id.clone(),
            host_key_generation: 1,
            identity_binding_id: Uuid::nil().to_string(),
            model_ref: model_ids[0].clone(),
            binding_revision: 1,
            daily_tokens: 100,
            daily_cost_microusd: None,
            concurrency_limit: 2,
        };
        let scope = (authority.validator())(&seed).unwrap();
        let service = ModelCenterHttp::new(
            admin.clone(),
            store.clone(),
            authority.validator(),
            authority.captured_validator(),
        );
        Fixture {
            bot_id: t.bot_id.clone(),
            t,
            store,
            admin,
            service,
            provider_id,
            model_ids,
            authority,
            scope,
        }
    }

    fn call(
        method: &str,
        path: &str,
        bearer: Option<&str>,
        origin: Option<&str>,
        body: Option<Value>,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(token) = bearer {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        if body.is_some() {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
        }
        builder
            .body(
                body.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap()
    }

    async fn json_response(response: axum::response::Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    fn admin_router(f: &Fixture) -> Router {
        f.admin
            .router()
            .merge(f.service.router())
            .merge(f.authority.router())
    }

    #[tokio::test]
    async fn admin_gate_origin_secret_write_only_and_registered_model_owners() {
        let f = fixture().await;
        let router = f.service.router();
        let no_auth = router
            .clone()
            .oneshot(call("GET", "/api/admin/model-center", None, None, None))
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        let ordinary = router
            .clone()
            .oneshot(call(
                "GET",
                "/api/admin/model-center",
                Some(&f.t.other.account_token),
                None,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(ordinary.status(), StatusCode::FORBIDDEN);

        let no_origin = router.clone().oneshot(call("POST", "/api/admin/model-providers", Some(&f.t.admin.account_token), None,
            Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":0,"id":Uuid::new_v4().to_string(),"label":"no-origin","base_url":"https://supplier.example/v1","api_protocol":"anthropic","auth_type":"api_key","api_key":"nope"})))).await.unwrap();
        assert_eq!(no_origin.status(), StatusCode::FORBIDDEN);

        let center = router
            .clone()
            .oneshot(call(
                "GET",
                "/api/admin/model-center",
                Some(&f.t.admin.account_token),
                Some(&f.admin.origin),
                None,
            ))
            .await
            .unwrap();
        let (status, value) = json_response(center).await;
        assert_eq!(status, StatusCode::OK);
        let encoded = value.to_string();
        assert!(!encoded.contains("fixture-secret-never-return"));
        assert_eq!(value["data"]["providers"][0]["has_key"], true);

        let stale = router.clone().oneshot(call("PATCH", &format!("/api/admin/model-providers/{}", f.provider_id), Some(&f.t.admin.account_token), Some(&f.admin.origin),
            Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":0,"id":f.provider_id,"label":"stale","base_url":"https://model-center-test.invalid/v1","api_protocol":"anthropic","auth_type":"api_key","enabled":true,"max_output_tokens":128,"max_output_tokens_param_name":"max_tokens","api_key":"rotate"})))).await.unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);

        let unregistered = router.oneshot(call("POST", "/api/admin/models", Some(&f.t.admin.account_token), Some(&f.admin.origin),
            Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":0,"id":Uuid::new_v4().to_string(),"provider_id":f.provider_id,"model_id":"orphan","label":"orphan","owner_ids":[Uuid::new_v4().to_string()],"enabled":true})))).await.unwrap();
        assert_eq!(unregistered.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn logical_delete_routes_require_origin_and_preserve_disabled_records() {
        let f = fixture().await;
        let router = f.service.router();
        let model = f.store.model(&f.model_ids[1]).unwrap();
        let provider = f.store.provider(&f.provider_id).unwrap();
        let absent_origin = router.clone().oneshot(call("DELETE", &format!("/api/admin/models/{}", model.config.id), Some(&f.t.admin.account_token), None,
            Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":model.revision})))).await.unwrap();
        assert_eq!(absent_origin.status(), StatusCode::FORBIDDEN);
        let deleted_model = router.clone().oneshot(call("DELETE", &format!("/api/admin/models/{}", model.config.id), Some(&f.t.admin.account_token), Some(&f.admin.origin),
            Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":model.revision})))).await.unwrap();
        let (status, model_value) = json_response(deleted_model).await;
        assert_eq!(status, StatusCode::OK, "{model_value}");
        assert!(!model_value["data"]["enabled"].as_bool().unwrap());
        assert!(
            !model_value
                .to_string()
                .contains("fixture-secret-never-return")
        );
        assert!(!f.store.model(&model.config.id).unwrap().config.enabled);

        let deleted_provider = router.oneshot(call("DELETE", &format!("/api/admin/model-providers/{}", provider.id), Some(&f.t.admin.account_token), Some(&f.admin.origin),
            Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":provider.revision})))).await.unwrap();
        let (status, provider_value) = json_response(deleted_provider).await;
        assert_eq!(status, StatusCode::OK, "{provider_value}");
        assert!(!provider_value["data"]["enabled"].as_bool().unwrap());
        assert!(
            !provider_value
                .to_string()
                .contains("fixture-secret-never-return")
        );
        assert!(
            f.store.model(&f.model_ids[0]).is_ok(),
            "logical delete preserves model history"
        );
    }

    #[tokio::test]
    async fn bot_desired_model_assignment_uses_cas_and_does_not_issue_a_session() {
        let f = fixture().await;
        let bot = f
            .admin
            .store
            .bots()
            .unwrap()
            .into_iter()
            .find(|b| b.id == f.bot_id)
            .unwrap();
        let body = json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":bot.revision,"model_ref":f.model_ids[1]});
        let response = admin_router(&f)
            .oneshot(call(
                "POST",
                &format!("/api/admin/bots/{}/model", f.bot_id),
                Some(&f.t.admin.account_token),
                Some(&f.admin.origin),
                Some(body.clone()),
            ))
            .await
            .unwrap();
        let (status, updated) = json_response(response).await;
        assert_eq!(status, StatusCode::OK, "{updated}");
        assert_eq!(updated["data"]["model_ref"], f.model_ids[1]);
        let replay = admin_router(&f)
            .oneshot(call(
                "POST",
                &format!("/api/admin/bots/{}/model", f.bot_id),
                Some(&f.t.admin.account_token),
                Some(&f.admin.origin),
                Some(body.clone()),
            ))
            .await
            .unwrap();
        let (replay_status, replay_value) = json_response(replay).await;
        assert_eq!(replay_status, StatusCode::OK, "{replay_value}");
        assert_eq!(
            replay_value["data"]["revision"],
            updated["data"]["revision"]
        );
        let receipt = admin_router(&f)
            .oneshot(call(
                "GET",
                &format!(
                    "/api/admin/mutations/{}",
                    body["mutation_id"].as_str().unwrap()
                ),
                Some(&f.t.admin.account_token),
                Some(&f.admin.origin),
                None,
            ))
            .await
            .unwrap();
        let (receipt_status, receipt_value) = json_response(receipt).await;
        assert_eq!(receipt_status, StatusCode::OK, "{receipt_value}");
        assert_eq!(receipt_value["data"]["id"], f.bot_id);
        let conflict = admin_router(&f).oneshot(call("POST", &format!("/api/admin/bots/{}/model", f.bot_id), Some(&f.t.admin.account_token), Some(&f.admin.origin), Some(json!({"mutation_id":body["mutation_id"],"expected_revision":bot.revision,"model_ref":f.model_ids[0]})))).await.unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let stale = admin_router(&f).oneshot(call("POST", &format!("/api/admin/bots/{}/model", f.bot_id), Some(&f.t.admin.account_token), Some(&f.admin.origin), Some(json!({"mutation_id":Uuid::new_v4().to_string(),"expected_revision":bot.revision,"model_ref":f.model_ids[0]})))).await.unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn host_session_contract_is_flat_and_rejects_wrong_host_or_model_and_protocol_path() {
        let f = fixture().await;
        let grant = f
            .store
            .issue_bot_credential_for_models(&f.scope, &[f.model_ids[0].clone()], 600)
            .unwrap();
        let router = admin_router(&f);
        let session_path = "/api/bot-model/sessions";
        let make_body = |host_id: &str, model_ref: &str| {
            json!({
                "bot_id":f.bot_id,"host_id":host_id,"model_ref":model_ref,
                "max_output_tokens":24,"max_total_tokens":80
            })
        };
        let wrong_host = router
            .clone()
            .oneshot(call(
                "POST",
                session_path,
                Some(&grant.bearer),
                None,
                Some(make_body(&Uuid::new_v4().to_string(), &f.model_ids[0])),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_host.status(), StatusCode::FORBIDDEN);
        let wrong_model = router
            .clone()
            .oneshot(call(
                "POST",
                session_path,
                Some(&grant.bearer),
                None,
                Some(make_body(&f.scope.host_id, &f.model_ids[1])),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_model.status(), StatusCode::FORBIDDEN);

        let issued = router
            .clone()
            .oneshot(call(
                "POST",
                session_path,
                Some(&grant.bearer),
                None,
                Some(make_body(&f.scope.host_id, &f.model_ids[0])),
            ))
            .await
            .unwrap();
        let (status, wire) = json_response(issued).await;
        assert_eq!(status, StatusCode::OK, "{wire}");
        assert!(
            wire.get("data").is_none(),
            "Host contract is a flat lease object"
        );
        for key in [
            "session_id",
            "model_ref",
            "provider_id",
            "model",
            "provider_revision",
            "model_revision",
            "gateway_base_url",
            "api_protocol",
            "max_output_tokens_param_name",
            "max_output_tokens",
            "max_total_tokens",
            "expires_at",
            "access_token",
        ] {
            assert!(wire.get(key).is_some(), "missing {key}: {wire}");
        }
        assert_eq!(wire["api_protocol"], "anthropic");
        assert_eq!(wire["max_output_tokens_param_name"], "max_tokens");
        assert!(
            wire["gateway_base_url"]
                .as_str()
                .unwrap()
                .ends_with(&format!(
                    "/api/bot-model/sessions/{}",
                    wire["session_id"].as_str().unwrap()
                ))
        );
        let session_id = wire["session_id"].as_str().unwrap();
        let count_path = format!("/api/bot-model/sessions/{session_id}/v1/messages/count_tokens");
        let count_body = json!({"model":"fixture-a","system":"hello","messages":[{"role":"user","content":"world"}],"tools":[{"name":"lookup","input_schema":{"type":"object"}}]});
        let invalid_bearer = router
            .clone()
            .oneshot(call(
                "POST",
                &count_path,
                Some("invalid"),
                None,
                Some(count_body.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(invalid_bearer.status(), StatusCode::FORBIDDEN);
        let wrong_session = router
            .clone()
            .oneshot(call(
                "POST",
                &format!(
                    "/api/bot-model/sessions/{}/v1/messages/count_tokens",
                    Uuid::new_v4()
                ),
                wire["access_token"].as_str(),
                None,
                Some(count_body.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_session.status(), StatusCode::FORBIDDEN);
        let counted = router
            .clone()
            .oneshot(call(
                "POST",
                &count_path,
                wire["access_token"].as_str(),
                None,
                Some(count_body),
            ))
            .await
            .unwrap();
        let (count_status, count_value) = json_response(counted).await;
        assert_eq!(count_status, StatusCode::OK, "{count_value}");
        let count_bytes = serde_json::to_vec(&json!({"system":"hello","messages":[{"role":"user","content":"world"}],"tools":[{"name":"lookup","input_schema":{"type":"object"}}]})).unwrap().len();
        assert_eq!(count_value["input_tokens"], json!(count_bytes / 4 + 1));
        assert!(
            f.store.usage(100).unwrap().is_empty(),
            "local count does not create billable usage"
        );
        let wrong_protocol = router
            .oneshot(call(
                "POST",
                &format!(
                    "/api/bot-model/sessions/{}/v1/chat/completions",
                    wire["session_id"].as_str().unwrap()
                ),
                wire["access_token"].as_str(),
                None,
                Some(json!({"model":"fixture-a","messages":[]})),
            ))
            .await
            .unwrap();
        assert_eq!(wrong_protocol.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn empty_usage_is_truthful_and_probe_requires_admin_before_any_supplier_access() {
        let f = fixture().await;
        let router = f.service.router();
        let empty = router
            .clone()
            .oneshot(call(
                "GET",
                "/api/admin/model-usage",
                Some(&f.t.admin.account_token),
                Some(&f.admin.origin),
                None,
            ))
            .await
            .unwrap();
        let (status, usage) = json_response(empty).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(usage["data"]["rows"], json!([]));
        assert_eq!(usage["data"]["summary"]["requests"], 0);
        assert_eq!(usage["data"]["summary"]["tokens"], 0);

        let unauth = router
            .clone()
            .oneshot(call(
                "GET",
                &format!("/api/admin/model-providers/{}/probe", f.provider_id),
                Some(&f.t.other.account_token),
                Some(&f.admin.origin),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(unauth.status(), StatusCode::FORBIDDEN);
        // .invalid is reserved and cannot resolve to a real supplier. The authorized probe must
        // reach the explicit catalog GET path and fail closed without fabricating a success.
        let probe = router
            .oneshot(call(
                "GET",
                &format!("/api/admin/model-providers/{}/probe", f.provider_id),
                Some(&f.t.admin.account_token),
                Some(&f.admin.origin),
                None,
            ))
            .await
            .unwrap();
        assert!(
            matches!(
                probe.status(),
                StatusCode::BAD_GATEWAY | StatusCode::GATEWAY_TIMEOUT
            ),
            "{}",
            probe.status()
        );
    }
}
