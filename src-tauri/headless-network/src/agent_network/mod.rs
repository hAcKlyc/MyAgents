//! Original fixed-protocol crypto/identity/transport modules, new process owner.
#[path = "../../../src/agent_network/account.rs"]
pub(crate) mod account;
#[path = "../../../src/agent_network/account_operation.rs"]
pub(crate) mod account_operation;
#[path = "../../../src/agent_network/identity.rs"]
pub(crate) mod identity;
#[path = "../../../src/agent_network/jwt.rs"]
pub(crate) mod jwt;
#[path = "../../../src/agent_network/memory.rs"]
pub(crate) mod memory;
#[path = "../../../src/agent_network/owned_admission.rs"]
pub(crate) mod owned_admission;
#[path = "../../../src/agent_network/owned_login.rs"]
pub(crate) mod owned_login;
#[path = "../../../src/agent_network/owned_profile.rs"]
pub(crate) mod owned_profile;
#[path = "../../../src/agent_network/policy.rs"]
pub(crate) mod policy;
#[path = "../../../src/agent_network/reconnect.rs"]
pub(crate) mod reconnect;
#[path = "../../../src/agent_network/transport.rs"]
pub(crate) mod transport;
pub(crate) mod crypto {
    pub use myagents_agent_network_crypto::*;
}
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct NetworkError {
    pub code: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
    #[serde(skip)]
    pub retry_after: Option<std::time::Duration>,
}
impl NetworkError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code: code.into(),
            retryable: false,
            details: None,
            retry_after: None,
        }
    }
    pub(crate) fn cloud(code: &str, status: u16) -> Self {
        let safe = !code.is_empty()
            && code.len() <= 128
            && code
                .bytes()
                .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_');
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
impl From<crypto::CryptoError> for NetworkError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::cloud(&e.to_string(), 400)
    }
}
impl std::fmt::Display for NetworkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}
impl std::error::Error for NetworkError {}

#[path = "../../../src/agent_network/connection.rs"]
pub(crate) mod connection;

#[path = "../connector.rs"]
pub(crate) mod connector;

// Retain original fixed-protocol implementation and its established signatures.
#[allow(clippy::too_many_arguments)]
#[path = "../../../src/agent_network/channel.rs"]
pub(crate) mod channel;
// Original timeout iterator is reused unchanged; the probe itself has no lint exemptions.
#[allow(clippy::filter_map_bool_then)]
#[path = "../../../src/agent_network/pairs.rs"]
pub(crate) mod pairs;

// Original pair parity tests use business error projections, never the probe runtime.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
#[path = "../../../src/agent_network/calls.rs"]
pub(crate) mod calls;
#[cfg(test)]
#[path = "../../../src/agent_network/incoming.rs"]
pub(crate) mod incoming;
#[path = "../../../src/agent_network/management_controller.rs"]
pub(crate) mod management_controller;
