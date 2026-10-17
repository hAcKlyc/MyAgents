//! Narrow fixed-origin account adapter for the App's Agent Network owner.
//! The original account owner retains the opaque token and exact login binding.
use super::*;
use crate::agent_network::NetworkError;
use crate::network_diagnostics::{error_category, RequestDiagnostic};

pub(crate) use crate::agent_network::account_operation::AccountOperation;

#[derive(Clone)]
pub(crate) struct OfficialAccountSession {
    session: AuthenticatedSpaceSession,
}
impl OfficialAccountSession {
    pub(crate) fn capture() -> Result<Self, NetworkError> {
        // Space demo fixtures must not mint an actual device/network identity.
        if crate::space_cloud_mock::is_enabled() {
            return Err(NetworkError::new("NETWORK_ACCOUNT_UNAVAILABLE"));
        }
        let session = require_session().map_err(|_| NetworkError::new("SPACE_REAUTH_REQUIRED"))?;
        let origin = url::Url::parse(&session.base_url)
            .map_err(|_| NetworkError::new("NETWORK_ISSUER_INVALID"))?;
        if origin.scheme() != "https" || origin.origin().ascii_serialization() != session.base_url {
            return Err(NetworkError::new("NETWORK_ISSUER_INVALID"));
        }
        Ok(Self { session })
    }
    pub(crate) fn binding_id(&self) -> &str {
        self.session.session_binding_id()
    }
    pub(crate) fn issuer(&self) -> &str {
        &self.session.base_url
    }
    pub(crate) fn principal_id(&self) -> Result<&str, NetworkError> {
        self.session
            .user
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or_else(|| NetworkError::new("NETWORK_PRINCIPAL_INVALID"))
    }
    pub(crate) fn environment(&self) -> &'static str {
        match space_build_capability().active_environment {
            SpaceEnvironment::Production => "production",
            SpaceEnvironment::Dev => "development",
        }
    }
    pub(crate) fn service_id(&self) -> Result<&'static str, NetworkError> {
        let id = match space_build_capability().active_environment {
            SpaceEnvironment::Production => option_env!("MYAGENTS_AGENT_NETWORK_SERVICE_ID"),
            SpaceEnvironment::Dev => option_env!("MYAGENTS_AGENT_NETWORK_DEV_SERVICE_ID"),
        }
        .ok_or_else(|| NetworkError::new("NETWORK_SERVICE_UNCONFIGURED"))?;
        if uuid::Uuid::parse_str(id)
            .map(|value| value.to_string())
            .as_deref()
            != Ok(id)
        {
            return Err(NetworkError::new("NETWORK_SERVICE_UNCONFIGURED"));
        }
        Ok(id)
    }
    pub(crate) fn ensure_current(&self) -> Result<(), NetworkError> {
        let current = require_session().map_err(|_| NetworkError::new("ACCOUNT_AUTH_REVOKED"))?;
        if current.session_binding_id() != self.binding_id()
            || current.base_url != self.session.base_url
        {
            return Err(NetworkError::new("ACCOUNT_BINDING_CHANGED"));
        }
        Ok(())
    }
    pub(crate) async fn request(
        &self,
        operation: AccountOperation,
        body: Option<Value>,
    ) -> Result<Value, NetworkError> {
        self.ensure_current()?;
        let capability = ensure_space_available()
            .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?;
        let (method, path, authenticated) = operation.request()?;
        // This is an external fixed HTTPS origin, with the existing App proxy.
        // Never follow a redirect carrying the opaque user credential.
        #[allow(clippy::disallowed_methods)]
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none());
        let client = crate::proxy_config::build_client_with_proxy(builder)
            .map_err(|_| NetworkError::new("NETWORK_PROXY_INVALID"))?;
        let diagnostic = RequestDiagnostic::new("network-account", &method, &path);
        let mut request = with_space_client_context_headers(
            client.request(
                method,
                api_url(self.issuer(), &path)
                    .map_err(|_| NetworkError::new("NETWORK_ISSUER_INVALID"))?,
            ),
            &capability,
        );
        if authenticated {
            request = request.header(
                AUTHORIZATION,
                format!("Bearer {}", self.session.session_token()),
            );
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = diagnostic
            .send(request)
            .await
            .map_err(|_| NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503))?;
        let status = response.status();
        let retry_after = crate::agent_network::reconnect::retry_after(&response);
        let bytes = read_account_response_body(&mut response, &diagnostic).await?;
        self.ensure_current()?;
        let envelope = decode_account_response(status, &bytes, retry_after).inspect_err(|_| {
            diagnostic.failure(
                "decode",
                if status.is_success() {
                    "decode"
                } else {
                    "http"
                },
                Some(status.as_u16()),
                None,
            );
        })?;
        if !status.is_success() || !envelope.success {
            let code = envelope
                .code
                .as_deref()
                .unwrap_or("NETWORK_ACCOUNT_UNAVAILABLE");
            // Proof/certificate 401 is distinct from loss of the original login.
            if status == reqwest::StatusCode::UNAUTHORIZED
                && ["SPACE_REAUTH_REQUIRED", "NOT_AUTHENTICATED"].contains(&code)
            {
                if mark_user_session_reauth_required(&self.session)
                    .await
                    .map_err(|_| NetworkError::new("SPACE_SESSION_STATE_WRITE_FAILED"))?
                {
                    account_user_session_invalidated();
                }
            }
            diagnostic.failure(
                "response",
                "http",
                Some(status.as_u16()),
                envelope.request_id.as_deref(),
            );
            let mut error = NetworkError::cloud(code, status.as_u16());
            error.retry_after = retry_after;
            return Err(error);
        }
        envelope
            .data
            .ok_or_else(|| NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"))
    }
}

fn account_body_failure(
    status: reqwest::StatusCode,
    retry_after: Option<Duration>,
    successful_response_error: NetworkError,
) -> NetworkError {
    let mut error = if status.is_success() {
        successful_response_error
    } else {
        NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", status.as_u16())
    };
    error.retry_after = retry_after;
    error
}
pub(crate) async fn read_account_response_body(
    response: &mut reqwest::Response,
    diagnostic: &RequestDiagnostic,
) -> Result<Vec<u8>, NetworkError> {
    let status = response.status();
    let retry_after = crate::agent_network::reconnect::retry_after(response);
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        diagnostic.failure("body", error_category(&error), Some(status.as_u16()), None);
        account_body_failure(
            status,
            retry_after,
            NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", 503),
        )
    })? {
        if bytes.len() + chunk.len() > 65_536 {
            diagnostic.failure("body", "size", Some(status.as_u16()), None);
            return Err(account_body_failure(
                status,
                retry_after,
                NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID"),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
// A non-JSON edge response is still an HTTP failure. Only a decoded, exact
// authentication code may invalidate the original Space login above.
fn decode_account_response(
    status: reqwest::StatusCode,
    bytes: &[u8],
    retry_after: Option<Duration>,
) -> Result<CloudEnvelope<Value>, NetworkError> {
    serde_json::from_slice(bytes).map_err(|_| {
        let mut error = if status.is_success() {
            NetworkError::new("NETWORK_ACCOUNT_RESPONSE_INVALID")
        } else {
            NetworkError::cloud("NETWORK_ACCOUNT_UNAVAILABLE", status.as_u16())
        };
        error.retry_after = retry_after;
        error
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn bounded_account_body_reader_preserves_edge_status_and_delay() {
        let diagnostic = RequestDiagnostic::new(
            "network-account",
            &reqwest::Method::GET,
            "/api/agent-network/jwks",
        );
        for status in [429, 503, 200] {
            for oversized in [false, true] {
                let bytes = if oversized {
                    vec![b'x'; 65_537]
                } else {
                    b"truncated".to_vec()
                };
                let (mut response, server) =
                    crate::network_diagnostics::test_response(status, bytes, !oversized).await;
                let error = read_account_response_body(&mut response, &diagnostic)
                    .await
                    .unwrap_err();
                drop(response);
                server.join().unwrap();
                if status == 200 {
                    assert_eq!(
                        error.code,
                        if oversized {
                            "NETWORK_ACCOUNT_RESPONSE_INVALID"
                        } else {
                            "NETWORK_ACCOUNT_UNAVAILABLE"
                        }
                    );
                    assert_eq!(error.retryable, !oversized);
                    assert_eq!(error.retry_after, None);
                } else {
                    assert_eq!(error.code, "NETWORK_ACCOUNT_UNAVAILABLE");
                    assert!(error.retryable);
                    assert_eq!(error.retry_after, Some(Duration::from_secs(45)));
                }
            }
        }
        let (mut response, server) =
            crate::network_diagnostics::test_response(200, vec![b'x'; 65_536], false).await;
        assert_eq!(
            read_account_response_body(&mut response, &diagnostic)
                .await
                .unwrap()
                .len(),
            65_536
        );
        server.join().unwrap();
    }

    #[test]
    fn malformed_edge_errors_never_claim_auth_revocation() {
        for status in [401, 403, 429, 500, 502, 503] {
            for bytes in [b"".as_slice(), b"<html>edge unavailable</html>".as_slice()] {
                let error = decode_account_response(
                    reqwest::StatusCode::from_u16(status).unwrap(),
                    bytes,
                    Some(Duration::from_secs(30)),
                )
                .err()
                .unwrap();
                assert_eq!(error.code, "NETWORK_ACCOUNT_UNAVAILABLE");
                assert_eq!(error.retryable, status == 429 || status >= 500);
                assert_eq!(error.retry_after, Some(Duration::from_secs(30)));
            }
        }
        assert_eq!(
            decode_account_response(reqwest::StatusCode::OK, b"", None)
                .err()
                .unwrap()
                .code,
            "NETWORK_ACCOUNT_RESPONSE_INVALID"
        );
        let envelope = decode_account_response(
            reqwest::StatusCode::UNAUTHORIZED,
            br#"{"success":false,"code":"NOT_AUTHENTICATED"}"#,
            None,
        )
        .unwrap();
        assert_eq!(envelope.code.as_deref(), Some("NOT_AUTHENTICATED"));
    }
}
