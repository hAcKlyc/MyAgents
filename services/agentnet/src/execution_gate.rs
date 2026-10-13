//! Finite execution authority: a cryptographic admission result alone is never
//! permission. Every operation rechecks the actual live stores under AuthStore.
use crate::{
    AuthError, SessionProjection, network_http::NetworkService, relay_controller::RelayController,
};
use myagents_agentnet_admission_core::ValidatedAccess;
use myagents_agentnet_device_core::SessionContext;
use myagents_agentnet_execution_core::{ExecutionScope, HostContext};
use myagents_agentnet_identity_core::IssuerProfile;
use myagents_agentnet_metadata_core::{Presence, RelayMetadataState};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GateError(pub &'static str);
impl std::fmt::Display for GateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for GateError {}
impl From<AuthError> for GateError {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::SessionRejected => Self("SESSION_REJECTED"),
            _ => Self("EXECUTION_AUTH_UNAVAILABLE"),
        }
    }
}
pub(crate) fn now() -> Result<u64, GateError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|_| GateError("EXECUTION_CLOCK_UNAVAILABLE"))
}
pub(crate) fn profile(n: &NetworkService) -> IssuerProfile {
    IssuerProfile {
        issuer: n.issuer.clone(),
        service_id: n.service_id.clone(),
        environment: n.environment.clone(),
        network_id: n.network_id.clone(),
    }
}
fn context(session: &SessionProjection, expiry: i64) -> SessionContext {
    SessionContext {
        principal_id: session.account.principal_id.clone(),
        network_id: session.account.network_id.clone(),
        device_id: session.device_id.clone(),
        session_handle: session.session_handle.clone(),
        expires_at: session.expires_at.min(expiry),
    }
}
#[derive(Clone)]
pub(crate) struct LiveHost {
    pub scope: ExecutionScope,
    pub metadata: RelayMetadataState,
    pub expires_at: u64,
}
impl LiveHost {
    pub fn check_context(&self, c: &HostContext) -> Result<(), GateError> {
        c.validate()
            .map_err(|_| GateError("HOST_CONTEXT_REJECTED"))?;
        if self.metadata.connection_epoch.as_deref() != Some(c.connection_epoch.as_str())
            || self.metadata.membership_revision != c.membership_revision
        {
            return Err(GateError("HOST_CONTEXT_REJECTED"));
        }
        Ok(())
    }
}
/// Read-only owner consent scope. An OIDC browser may not be an enrolled device;
/// actual target DeviceStore and Metadata ownership still must both agree.
pub(crate) fn owner_scope(
    n: &NetworkService,
    session: &SessionProjection,
    target: &str,
) -> Result<ExecutionScope, GateError> {
    if session.account.network_id != n.network_id {
        return Err(GateError("HOST_OWNER_REQUIRED"));
    }
    let c = context(session, session.expires_at);
    let d = n
        .devices
        .read_state(&c, target)
        .map_err(|_| GateError("HOST_OWNER_REQUIRED"))?
        .ok_or(GateError("HOST_OWNER_REQUIRED"))?;
    let m = n
        .metadata
        .read_owned_target(&c, target)
        .map_err(|_| GateError("HOST_OWNER_REQUIRED"))?;
    if !m.joined
        || m.membership_revision == 0
        || m.identity_binding_id != d.identity_binding_id
        || m.key_generation != d.key_generation
        || m.key_fingerprint != d.key_fingerprint
    {
        return Err(GateError("HOST_OWNER_REQUIRED"));
    }
    let scope = ExecutionScope {
        issuer: n.issuer.clone(),
        service_id: n.service_id.clone(),
        environment: n.environment.clone(),
        network_id: n.network_id.clone(),
        host_owner_id: session.account.principal_id.clone(),
        host_device_id: target.into(),
        host_key_generation: d.key_generation,
        identity_binding_id: d.identity_binding_id,
    };
    scope
        .validate()
        .map_err(|_| GateError("HOST_OWNER_REQUIRED"))?;
    Ok(scope)
}
/// Called only inside a live AuthStore callback. Never re-enters AuthStore.
pub(crate) fn prepare_host(
    n: &NetworkService,
    relay: &RelayController,
    a: &ValidatedAccess,
    s: &SessionProjection,
) -> Result<LiveHost, GateError> {
    if s.account.principal_id != a.principal_id()
        || s.account.network_id != n.network_id
        || s.device_id != a.device_id()
        || s.session_handle != a.session_handle()
        || a.issuer_network_id() != n.network_id
        || a.issuer_origin() != n.issuer
        || a.service_id() != n.service_id
        || a.environment() != n.environment
    {
        return Err(GateError("HOST_IDENTITY_REJECTED"));
    }
    let c = context(s, a.expires_at());
    let d = n
        .devices
        .read_state(&c, &c.device_id)
        .map_err(|_| GateError("HOST_IDENTITY_REJECTED"))?
        .ok_or(GateError("HOST_IDENTITY_REJECTED"))?;
    if d.key_generation != a.key_generation() || d.key_fingerprint != a.public_key_fingerprint() {
        return Err(GateError("HOST_IDENTITY_REJECTED"));
    }
    let p = n
        .peers
        .lookup(&c, a.access_jti(), d.key_generation, &d.key_fingerprint)
        .map_err(|_| GateError("HOST_IDENTITY_REJECTED"))?
        .ok_or(GateError("HOST_IDENTITY_REJECTED"))?;
    if p.identity_binding_id != d.identity_binding_id
        || p.key_generation != d.key_generation
        || p.key_fingerprint != d.key_fingerprint
        || p.network_id != c.network_id
        || p.principal_id != c.principal_id
        || p.device_id != c.device_id
        || p.session_handle != c.session_handle
    {
        return Err(GateError("HOST_IDENTITY_REJECTED"));
    }
    let live_epoch = relay
        .execution_epoch(a)
        .map_err(|_| GateError("HOST_CONTEXT_REJECTED"))?;
    let m = n
        .metadata
        .read_relay_state(&c, &c.device_id)
        .map_err(|_| GateError("HOST_CONTEXT_REJECTED"))?;
    if !m.joined
        || m.presence != Presence::Ready
        || m.connection_epoch.as_deref() != Some(live_epoch.as_str())
        || m.identity_binding_id != d.identity_binding_id
        || m.key_generation != d.key_generation
        || m.key_fingerprint != d.key_fingerprint
        || m.catalog_epoch != m.connection_epoch
        || m.durable_ack_seq != Some(m.catalog_seq)
    {
        return Err(GateError("HOST_CONTEXT_REJECTED"));
    }
    let scope = ExecutionScope {
        issuer: n.issuer.clone(),
        service_id: n.service_id.clone(),
        environment: n.environment.clone(),
        network_id: n.network_id.clone(),
        host_owner_id: c.principal_id,
        host_device_id: c.device_id,
        host_key_generation: d.key_generation,
        identity_binding_id: d.identity_binding_id,
    };
    let expires_at = u64::try_from(c.expires_at.min(p.peer_expires_at).min(p.access_expires_at))
        .map_err(|_| GateError("HOST_IDENTITY_REJECTED"))?;
    if expires_at <= now()? {
        return Err(GateError("HOST_IDENTITY_REJECTED"));
    }
    Ok(LiveHost {
        scope,
        metadata: m,
        expires_at,
    })
}
pub(crate) fn with_host<T>(
    n: &NetworkService,
    relay: &RelayController,
    a: &ValidatedAccess,
    op: impl FnOnce(LiveHost) -> Result<T, GateError>,
) -> Result<T, GateError> {
    n.auth
        .with_valid_session_handle(a.session_handle(), |s| op(prepare_host(n, relay, a, &s)?))
}
/// One AuthStore transaction for Host plus original command actor. Storing an
/// internal session handle is not storing or accepting a bearer credential.
pub(crate) fn with_host_and_actor<T>(
    n: &NetworkService,
    relay: &RelayController,
    a: &ValidatedAccess,
    actor_handle: &str,
    actor_id: &str,
    admins: &[String],
    op: impl FnOnce(LiveHost, u64) -> Result<T, GateError>,
) -> Result<T, GateError> {
    n.auth
        .with_valid_session_handles(&[a.session_handle(), actor_handle], |sessions| {
            let host = sessions
                .iter()
                .find(|s| s.session_handle == a.session_handle())
                .ok_or(GateError("SESSION_REJECTED"))?;
            let actor = sessions
                .iter()
                .find(|s| s.session_handle == actor_handle)
                .ok_or(GateError("SESSION_REJECTED"))?;
            if actor.account.principal_id != actor_id
                || actor.account.network_id != n.network_id
                || !admins.iter().any(|id| id == actor_id)
            {
                return Err(GateError("ADMIN_REQUIRED"));
            }
            let live = prepare_host(n, relay, a, host)?;
            let until = live
                .expires_at
                .min(u64::try_from(actor.expires_at).map_err(|_| GateError("SESSION_REJECTED"))?);
            op(live, until)
        })
}
