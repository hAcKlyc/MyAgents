//! Fixed HTTP routes used by an explicitly enabled AgentNet relay.
//!
//! Admission verifies the exact HTTP method and URI with DPoP. The controller
//! then rechecks the live session, device, peer, and metadata state before it
//! performs either operation.

use crate::{relay_controller::RelayController, relay_transport::RelayFailure};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{OriginalUri, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use myagents_agent_network_protocol::{CatalogSnapshot, budget, validate_catalog};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

const BODY_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_LIMIT: usize = 16 * 1024;
const BLOCKING_WORKERS: usize = 32;

#[derive(Clone)]
struct HttpState {
    controller: Arc<RelayController>,
    blocking: Arc<Semaphore>,
}

pub fn router(controller: Arc<RelayController>) -> Router<()> {
    let state = Arc::new(HttpState {
        controller,
        blocking: Arc::new(Semaphore::new(BLOCKING_WORKERS)),
    });
    Router::new()
        .route(
            "/v1/devices/self/catalog",
            axum::routing::put(upload_catalog),
        )
        .route("/api/agent-network/policy/self", get(self_policy))
        .layer(middleware::from_fn(no_store))
        .with_state(state)
}

async fn upload_catalog(
    State(state): State<Arc<HttpState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    if !bounded_headers(&headers) || !json_content_type(&headers) || uri.query().is_some() {
        return fixed_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let controller = state.controller.clone();
    let headers_for_auth = headers.clone();
    let uri_for_auth = uri.clone();
    let admission = match run_blocking(state.clone(), move || {
        controller.admit_http(&headers_for_auth, &Method::PUT, &uri_for_auth)
    })
    .await
    {
        Ok(Ok(access)) => access,
        Ok(Err(response)) => return *response,
        Err(status) => return fixed_error(status, "RELAY_UNAVAILABLE"),
    };

    let bytes = match tokio::time::timeout(
        BODY_TIMEOUT,
        to_bytes(request.into_body(), budget("catalogBytes")),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return fixed_error(StatusCode::PAYLOAD_TOO_LARGE, "INVALID_CATALOG"),
        Err(_) => return fixed_error(StatusCode::REQUEST_TIMEOUT, "REQUEST_TIMEOUT"),
    };
    let snapshot: CatalogSnapshot = match serde_json::from_slice(&bytes) {
        Ok(snapshot) => snapshot,
        Err(_) => return fixed_error(StatusCode::BAD_REQUEST, "INVALID_CATALOG"),
    };
    let value = match serde_json::to_value(&snapshot) {
        Ok(value) => value,
        Err(_) => return fixed_error(StatusCode::BAD_REQUEST, "INVALID_CATALOG"),
    };
    if validate_catalog(&value).is_err()
        || snapshot.items.len() > budget("catalogItems")
        || bytes.len() > budget("catalogBytes")
    {
        return fixed_error(StatusCode::BAD_REQUEST, "INVALID_CATALOG");
    }

    let controller = state.controller.clone();
    match run_blocking(state, move || {
        controller.upload_catalog(&admission, &snapshot)
    })
    .await
    {
        Ok(Ok(receipt)) => {
            (StatusCode::OK, Json(json!({"ok": true, "data": receipt}))).into_response()
        }
        Ok(Err(error)) => relay_error(error),
        Err(status) => fixed_error(status, "RELAY_UNAVAILABLE"),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn self_policy(
    State(state): State<Arc<HttpState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    query: Result<axum::extract::Query<PolicyQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let axum::extract::Query(query) = match query {
        Ok(query) => query,
        Err(_) => return fixed_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST"),
    };
    if !bounded_headers(&headers)
        || query
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() > 2048)
    {
        return fixed_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let limit = query.limit.unwrap_or(budget("pageSize"));
    if limit == 0 || limit > budget("pageMax") {
        return fixed_error(StatusCode::BAD_REQUEST, "INVALID_REQUEST");
    }
    let controller = state.controller.clone();
    let headers_for_auth = headers.clone();
    let uri_for_auth = uri.clone();
    let access = match run_blocking(state.clone(), move || {
        controller.admit_http(&headers_for_auth, &Method::GET, &uri_for_auth)
    })
    .await
    {
        Ok(Ok(access)) => access,
        Ok(Err(response)) => return *response,
        Err(status) => return fixed_error(status, "RELAY_UNAVAILABLE"),
    };
    let controller = state.controller.clone();
    let cursor = query.cursor;
    match run_blocking(state, move || {
        controller.self_policy(&access, cursor.as_deref(), limit)
    })
    .await
    {
        Ok(Ok(page)) => (StatusCode::OK, Json(json!({"ok": true, "data": page}))).into_response(),
        Ok(Err(error)) => relay_error(error),
        Err(status) => fixed_error(status, "RELAY_UNAVAILABLE"),
    }
}

async fn run_blocking<T, F>(state: Arc<HttpState>, operation: F) -> Result<T, StatusCode>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let permit = state
        .blocking
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

fn bounded_headers(headers: &HeaderMap) -> bool {
    headers.iter().fold(0usize, |total, (name, value)| {
        total
            .saturating_add(name.as_str().len())
            .saturating_add(value.as_bytes().len())
    }) <= HEADER_LIMIT
}

fn json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
}

fn relay_error(error: RelayFailure) -> Response {
    if error.code() == "RELAY_REJECTED" {
        fixed_error(StatusCode::FORBIDDEN, "RELAY_REJECTED")
    } else {
        fixed_error(StatusCode::SERVICE_UNAVAILABLE, "RELAY_UNAVAILABLE")
    }
}

fn fixed_error(status: StatusCode, code: &'static str) -> Response {
    (status, Json(json!({"ok": false, "error": {"code": code}}))).into_response()
}

async fn no_store(request: axum::http::Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{
        network_http::tests::{Device, Fixture},
        relay_controller::RelayController,
        relay_transport::RelayHandler,
    };
    use axum::{body::to_bytes, http::Request};
    use myagents_agentnet_admission_core::ValidatedAccess;
    use myagents_agentnet_relay_core::Effect;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    fn bearer_headers(device: &Device) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", device.access.as_str())).unwrap(),
        );
        headers
    }

    async fn response(
        router: Router,
        method: Method,
        uri: &str,
        headers: HeaderMap,
        body: &str,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::from(body.to_owned()))
            .unwrap();
        *request.headers_mut() = headers;
        router.oneshot(request).await.unwrap()
    }

    async fn signed_headers(
        router: &Router,
        fixture: &Fixture,
        device: &Device,
        method: &str,
        uri: &str,
        json_body: bool,
    ) -> HeaderMap {
        let mut headers = bearer_headers(device);
        if json_body {
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
        }
        let challenge = response(
            router.clone(),
            method.parse().unwrap(),
            uri,
            headers.clone(),
            "",
        )
        .await;
        assert_eq!(challenge.status(), StatusCode::UNAUTHORIZED);
        let nonce = challenge
            .headers()
            .get("dpop-nonce")
            .and_then(|value| value.to_str().ok())
            .expect("authenticated request receives the current DPoP nonce");
        let proof = fixture.proof(device, method, uri, Some(nonce));
        headers.insert("dpop", HeaderValue::from_str(&proof).unwrap());
        headers.insert(header::HOST, HeaderValue::from_static("attacker.invalid"));
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("attacker.invalid"),
        );
        headers
    }

    pub(crate) fn controller_access(
        controller: &RelayController,
        fixture: &Fixture,
        device: &Device,
        method: &str,
        uri: &str,
    ) -> ValidatedAccess {
        let uri: axum::http::Uri = uri.parse().unwrap();
        let mut headers = bearer_headers(device);
        let challenge = controller
            .admit_http(&headers, &method.parse().unwrap(), &uri)
            .unwrap_err();
        let nonce = challenge
            .headers()
            .get("dpop-nonce")
            .and_then(|value| value.to_str().ok())
            .expect("authenticated request receives the current DPoP nonce");
        let proof = fixture.proof(device, method, uri.path(), Some(nonce));
        headers.insert("dpop", HeaderValue::from_str(&proof).unwrap());
        controller
            .admit_http(&headers, &method.parse().unwrap(), &uri)
            .unwrap()
    }

    pub(crate) async fn joined_syncing_controller(
        fixture: &Fixture,
        device: &Device,
    ) -> (Arc<RelayController>, String, Value) {
        fixture.register(device).await;
        let join_uri = format!(
            "/v1/networks/{}/devices/{}/join",
            fixture.network, device.context.device_id
        );
        let body = json!({
            "mutationId": uuid::Uuid::new_v4().to_string(),
            "expectedMembershipRevision": 0
        })
        .to_string();
        assert_eq!(
            fixture.request(device, "POST", &join_uri, &body).await.0,
            StatusCode::OK
        );

        let controller = Arc::new(RelayController::new(fixture.service.clone()).unwrap());
        let ws_uri = "/v1/ws";
        let access = controller_access(&controller, fixture, device, "GET", ws_uri);
        let hello = json!({
            "version": 1,
            "controlId": uuid::Uuid::new_v4().to_string(),
            "type": "hello",
            "clientVersion": "test",
            "capabilities": []
        });
        let (connection_id, effects) = controller.as_ref().hello(access, hello).unwrap();
        let result = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::Control { json, .. } if json["type"] == "hello.result" => {
                    Some(json.clone())
                }
                _ => None,
            })
            .expect("hello emits the server-owned connection epoch");
        let epoch = result["connectionEpoch"].as_str().unwrap().to_owned();
        let _ = connection_id;
        (controller, epoch, result)
    }

    #[test]
    fn catalog_route_accepts_only_fixed_bounded_catalog_schema() {
        let valid = json!({
            "version": 1,
            "connectionEpoch": "a8f8fdd4-2c41-4a29-84c0-0327b379f1ab",
            "catalogSeq": 1,
            "items": [{
                "localAgentId": "agent",
                "localWorkspaceId": "workspace",
                "name": "Agent",
                "path": "/workspace",
                "lifecycle": "active",
                "exposureRevision": 0
            }]
        });
        let snapshot: CatalogSnapshot = serde_json::from_value(valid.clone()).unwrap();
        assert!(validate_catalog(&valid).is_ok());
        assert_eq!(snapshot.items.len(), 1);

        let mut unknown_root = valid.clone();
        unknown_root["unexpected"] = json!(true);
        assert!(serde_json::from_value::<CatalogSnapshot>(unknown_root.clone()).is_err());
        assert!(validate_catalog(&unknown_root).is_err());

        let mut unknown_item = valid;
        unknown_item["items"][0]["unexpected"] = json!(true);
        assert!(validate_catalog(&unknown_item).is_err());
    }

    #[test]
    fn catalog_limits_match_locked_protocol_budget() {
        assert_eq!(budget("catalogBytes"), 8 * 1024 * 1024);
        assert_eq!(budget("catalogItems"), 5000);
    }

    #[test]
    fn request_headers_have_a_fixed_total_size_limit() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        assert!(bounded_headers(&headers));
        headers.insert(
            "x-padding",
            HeaderValue::from_bytes(&vec![b'a'; HEADER_LIMIT]).unwrap(),
        );
        assert!(!bounded_headers(&headers));
    }

    #[test]
    fn self_policy_query_rejects_unknown_and_duplicate_parameters() {
        let unknown: axum::http::Uri = "/api/agent-network/policy/self?limit=2&extra=x"
            .parse()
            .unwrap();
        assert!(axum::extract::Query::<PolicyQuery>::try_from_uri(&unknown).is_err());

        let duplicate: axum::http::Uri = "/api/agent-network/policy/self?limit=2&limit=3"
            .parse()
            .unwrap();
        assert!(axum::extract::Query::<PolicyQuery>::try_from_uri(&duplicate).is_err());

        let valid: axum::http::Uri = "/api/agent-network/policy/self?limit=2&cursor=abc"
            .parse()
            .unwrap();
        let axum::extract::Query(query) =
            axum::extract::Query::<PolicyQuery>::try_from_uri(&valid).unwrap();
        assert_eq!(query.limit, Some(2));
        assert_eq!(query.cursor.as_deref(), Some("abc"));
    }

    #[tokio::test]
    async fn real_dpop_gates_catalog_and_self_policy_during_syncing() {
        let fixture = Fixture::new();
        let device = fixture.device("relay-http-owner");
        let (controller, epoch, _) = joined_syncing_controller(&fixture, &device).await;
        // Match the server's relay-enabled composition: ordinary network
        // routes remain mounted beside the relay's catalog/policy routes.
        let routes = Router::new()
            .merge(fixture.service.router())
            .merge(router(controller));

        let policy_uri = "/api/agent-network/policy/self";
        let headers = signed_headers(&routes, &fixture, &device, "GET", policy_uri, false).await;
        let before_catalog = response(routes.clone(), Method::GET, policy_uri, headers, "").await;
        assert_eq!(before_catalog.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(before_catalog.headers()[header::CACHE_CONTROL], "no-store");

        let catalog_uri = "/v1/devices/self/catalog";
        let wrong_epoch_body = json!({
            "version": 1,
            "connectionEpoch": uuid::Uuid::new_v4().to_string(),
            "catalogSeq": 1,
            "items": []
        })
        .to_string();
        let headers = signed_headers(&routes, &fixture, &device, "PUT", catalog_uri, true).await;
        let stale = response(
            routes.clone(),
            Method::PUT,
            catalog_uri,
            headers,
            &wrong_epoch_body,
        )
        .await;
        assert_eq!(stale.status(), StatusCode::FORBIDDEN);
        let stale_bytes = to_bytes(stale.into_body(), 8 * 1024).await.unwrap();
        let stale_body: Value = serde_json::from_slice(&stale_bytes).unwrap();
        assert_eq!(stale_body["error"]["code"], "RELAY_REJECTED");

        let catalog_body = json!({
            "version": 1,
            "connectionEpoch": epoch,
            "catalogSeq": 1,
            "items": []
        })
        .to_string();
        let headers = signed_headers(&routes, &fixture, &device, "PUT", catalog_uri, true).await;
        let catalog = response(
            routes.clone(),
            Method::PUT,
            catalog_uri,
            headers,
            &catalog_body,
        )
        .await;
        assert_eq!(catalog.status(), StatusCode::OK);
        assert_eq!(catalog.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = to_bytes(catalog.into_body(), 64 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["ok"], true);

        // The client proof binds the configured issuer and path. Host and
        // forwarding headers are deliberately attacker-controlled and ignored.
        let headers = signed_headers(&routes, &fixture, &device, "GET", policy_uri, false).await;
        let policy = response(routes, Method::GET, policy_uri, headers, "").await;
        assert_eq!(policy.status(), StatusCode::OK);
        assert_eq!(policy.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = to_bytes(policy.into_body(), 64 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["ok"], true);
    }

    #[tokio::test]
    async fn protected_routes_reject_missing_auth_and_wrong_dpop_method_or_url() {
        let fixture = Fixture::new();
        let device = fixture.device("relay-http-auth");
        let controller = Arc::new(RelayController::new(fixture.service.clone()).unwrap());
        let routes = router(controller);
        let path = "/v1/devices/self/catalog";

        let missing = response(
            routes.clone(),
            Method::GET,
            "/api/agent-network/policy/self",
            HeaderMap::new(),
            "",
        )
        .await;
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(missing.headers()[header::CACHE_CONTROL], "no-store");

        let mut challenge_headers = bearer_headers(&device);
        challenge_headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let nonce_response =
            response(routes.clone(), Method::PUT, path, challenge_headers, "").await;
        let nonce = nonce_response.headers()["dpop-nonce"].to_str().unwrap();
        let wrong_method = fixture.proof(&device, "POST", path, Some(nonce));
        let mut headers = bearer_headers(&device);
        headers.insert("dpop", HeaderValue::from_str(&wrong_method).unwrap());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let rejected_method = response(routes.clone(), Method::PUT, path, headers, "{}").await;
        assert_eq!(rejected_method.status(), StatusCode::UNAUTHORIZED);
        let bytes = to_bytes(rejected_method.into_body(), 8 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "NETWORK_PROOF_REJECTED");

        let wrong_url = fixture.proof(&device, "PUT", "/v1/devices/not-self/catalog", Some(nonce));
        let mut headers = bearer_headers(&device);
        headers.insert("dpop", HeaderValue::from_str(&wrong_url).unwrap());
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let rejected_url = response(routes, Method::PUT, path, headers, "{}").await;
        assert_eq!(rejected_url.status(), StatusCode::UNAUTHORIZED);
        let bytes = to_bytes(rejected_url.into_body(), 8 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "NETWORK_PROOF_REJECTED");
    }
}
