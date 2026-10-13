//! App-owned network identity, transport and admission adapters.
mod account;
pub(crate) mod account_operation;
pub(crate) mod actor;
mod calls;
mod catalog;
mod channel;
pub(crate) mod commands;
mod connection;
mod credential_restore;
mod crypto;
pub(crate) mod discovery;
mod identity;
mod identity_desktop;
mod incoming;
mod jwt;
mod local_owner;
mod memory;
mod management_controller;
mod owned_account_desktop;
mod owned_admission;
mod owned_login;
mod owned_profile;
mod pairs;
mod policy;
mod power;
pub(crate) mod reconnect;
pub(crate) mod registry;
pub(crate) mod returns;
pub(crate) mod source;
mod transport;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkError {
    pub code: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip)]
    pub retry_after: Option<std::time::Duration>,
}
impl NetworkError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code: code.into(),
            retryable: code == "NETWORK_QUERY_FAILED",
            details: None,
            retry_after: None,
        }
    }
    pub(crate) fn cloud(code: &str, status: u16) -> Self {
        let safe = !code.is_empty()
            && code.len() <= 128
            && code
                .bytes()
                .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == b'_');
        Self {
            code: if safe {
                code.into()
            } else {
                "NETWORK_ACCOUNT_UNAVAILABLE".into()
            },
            retryable: status == 429 || status >= 500,
            details: None,
            retry_after: None,
        }
    }
}
impl std::fmt::Display for NetworkError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}
impl std::error::Error for NetworkError {}
impl From<crypto::CryptoError> for NetworkError {
    fn from(error: crypto::CryptoError) -> Self {
        Self {
            code: error.to_string(),
            retryable: false,
            details: None,
            retry_after: None,
        }
    }
}
