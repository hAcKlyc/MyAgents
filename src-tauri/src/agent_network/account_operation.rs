//! Fixed issuer routes shared by Desktop and the independent headless owner.
use super::NetworkError;
pub(crate) enum AccountOperation {
    IdentityState(String),
    Identity,
    Certificate,
    Rotate,
    Challenge,
    Current,
    Jwks,
    Revoke,
    RevokeState,
}
impl AccountOperation {
    pub(crate) fn request(&self) -> Result<(reqwest::Method, String, bool), NetworkError> {
        let (method, path, authenticated) = match self {
            Self::IdentityState(device_id) => {
                let canonical = uuid::Uuid::parse_str(device_id)
                    .map_err(|_| NetworkError::new("DEVICE_ID_INVALID"))?;
                if canonical.to_string() != *device_id {
                    return Err(NetworkError::new("DEVICE_ID_INVALID"));
                }
                (
                    reqwest::Method::GET,
                    format!("/api/agent-network/identity/state?deviceId={device_id}"),
                    true,
                )
            }
            Self::Identity => (
                reqwest::Method::POST,
                "/api/agent-network/identity".into(),
                true,
            ),
            Self::Certificate => (
                reqwest::Method::POST,
                "/api/agent-network/certificate".into(),
                true,
            ),
            Self::Rotate => (
                reqwest::Method::POST,
                "/api/agent-network/identity/rotate".into(),
                true,
            ),
            Self::Challenge => (
                reqwest::Method::POST,
                "/api/agent-network/challenge".into(),
                true,
            ),
            Self::Current => (
                reqwest::Method::POST,
                "/api/agent-network/identity/current".into(),
                true,
            ),
            Self::Revoke => (
                reqwest::Method::POST,
                "/api/agent-network/revoke".into(),
                true,
            ),
            Self::RevokeState => (
                reqwest::Method::POST,
                "/api/agent-network/revoke-state".into(),
                true,
            ),
            Self::Jwks => (
                reqwest::Method::GET,
                "/api/agent-network/jwks".into(),
                false,
            ),
        };
        Ok((method, path, authenticated))
    }
}
