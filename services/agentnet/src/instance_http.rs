//! Public, bounded descriptor for this independently owned network instance.
//! It exposes only configured issuer material and is merged only when the
//! identity, network, and relay owners are all active.

use crate::{identity_http::IdentityService, network_http::NetworkService};
use axum::{
    Router,
    body::Body,
    extract::{OriginalUri, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

const INSTANCE_PATH: &str = "/api/agent-network/instance";
const MAX_INSTANCE_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct InstanceHttp {
    snapshot: Arc<InstanceSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstanceSnapshot {
    version: u8,
    profile: &'static str,
    service_id: String,
    environment: String,
    network_id: String,
    name: String,
    issuer: String,
    login_issuer: String,
    protocol: u8,
    capabilities: [&'static str; 1],
    root_certificate: String,
    jwks: Value,
}

impl InstanceHttp {
    pub(crate) fn new(
        identity: &IdentityService,
        network: &NetworkService,
        login_issuer: &str,
    ) -> Self {
        let public = identity.public_instance_material();
        Self {
            snapshot: Arc::new(InstanceSnapshot {
                version: 1,
                profile: "owned-device-relay-v1",
                service_id: public.service_id,
                environment: public.environment,
                network_id: network.network_id.clone(),
                name: network.public_network_name().to_owned(),
                issuer: public.issuer,
                login_issuer: login_issuer.to_owned(),
                protocol: 1,
                capabilities: ["tls13-mtls"],
                root_certificate: public.root_certificate,
                jwks: public.jwks,
            }),
        }
    }

    pub(crate) fn router(&self) -> Router<()> {
        Router::new()
            .route(INSTANCE_PATH, any(discover))
            .with_state(Arc::new(self.clone()))
    }
}

async fn discover(
    State(instance): State<Arc<InstanceHttp>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if method != Method::GET {
        return no_store_error(StatusCode::METHOD_NOT_ALLOWED);
    }
    if uri.query().is_some()
        || headers.contains_key(header::AUTHORIZATION)
        || headers.contains_key(header::COOKIE)
        || headers.contains_key("dpop")
    {
        return no_store_error(StatusCode::BAD_REQUEST);
    }
    let Ok(bytes) = serde_json::to_vec(instance.snapshot.as_ref()) else {
        return no_store_error(StatusCode::SERVICE_UNAVAILABLE);
    };
    if bytes.is_empty() || bytes.len() > MAX_INSTANCE_BYTES {
        return no_store_error(StatusCode::SERVICE_UNAVAILABLE);
    }
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn no_store_error(status: StatusCode) -> Response {
    let mut response = status.into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
