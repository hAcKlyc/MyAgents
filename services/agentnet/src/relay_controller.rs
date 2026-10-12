//! Live-authority adapter between AgentNet owners and the opaque relay core.
//!
//! This controller never logs credentials or interprets TLS payloads. All
//! state transitions are gated by current AuthStore, DeviceStore, PeerStore,
//! and MetadataStore projections before the runtime mutex is acquired.

use crate::{
    AuthError, SessionProjection,
    network_http::NetworkService,
    relay_transport::{RelayFailure, RelayHandler},
};
use axum::{
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use myagents_agent_network_protocol::{
    CatalogSnapshot, DeviceScope, decode_tls_frame, validate_control,
};
use myagents_agentnet_admission_core::ValidatedAccess;
use myagents_agentnet_device_core::{DeviceRecord, SessionContext};
use myagents_agentnet_metadata_core::{MetadataError, Page, Presence, RelayMetadataState};
use myagents_agentnet_peer_core::PeerSnapshot;
use myagents_agentnet_relay_core::{
    Effect, RelayConfig, RelayCore, RelayError, TrustedLiveSnapshot, TrustedReadyEvidence,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const FAILURE_REJECTED: &str = "RELAY_REJECTED";
const FAILURE_UNAVAILABLE: &str = "RELAY_UNAVAILABLE";

#[derive(Clone)]
struct RuntimeConnection {
    access: ValidatedAccess,
    epoch: String,
}

struct Runtime {
    core: RelayCore,
    connections: HashMap<String, RuntimeConnection>,
}

struct PreparedLive {
    context: SessionContext,
    device: DeviceRecord,
    peer: PeerSnapshot,
    metadata: RelayMetadataState,
    relay: TrustedLiveSnapshot,
}

/// A current device address, not a management permission or an Agent permit.
/// The endpoints still verify the channel's signed bindings and device TLS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceAddress {
    version: u8,
    scope: DeviceScope,
    connection_epoch: String,
    membership_revision: u64,
    signed_binding: String,
}

pub struct RelayController {
    network: NetworkService,
    runtime: Mutex<Runtime>,
    monotonic_origin: Instant,
}

impl RelayController {
    pub fn new(network: NetworkService) -> Result<Self, AuthError> {
        let core = RelayCore::new(RelayConfig {
            service_id: network.service_id.clone(),
            issuer: network.issuer.clone(),
            environment: network.environment.clone(),
            network_id: network.network_id.clone(),
            peer_jwks: network._keys.jwks(),
        })
        .map_err(|_| AuthError::Configuration)?;
        Ok(Self {
            network,
            runtime: Mutex::new(Runtime {
                core,
                connections: HashMap::new(),
            }),
            monotonic_origin: Instant::now(),
        })
    }

    /// Validate the fixed HTTP proof. Operations separately recheck live authority.
    pub(crate) fn admit_http(
        &self,
        headers: &HeaderMap,
        method: &Method,
        uri: &Uri,
    ) -> Result<ValidatedAccess, Box<Response>> {
        self.network.admit_response(headers, method, uri)
    }

    /// Persist a complete catalog only for the exact live websocket access JTI
    /// and server-owned connection epoch. The metadata owner returns the
    /// durable acknowledgement; this method never makes the connection Ready.
    pub fn upload_catalog(
        &self,
        access: &ValidatedAccess,
        snapshot: &CatalogSnapshot,
    ) -> Result<Value, RelayFailure> {
        let connection_id = self.connection_for_access(access)?;
        self.with_live(access, |live| {
            if !live.metadata.joined {
                return Err(rejected());
            }
            let epoch = self.recheck_connection(&connection_id, access)?;
            if snapshot.connection_epoch != epoch
                || live.metadata.connection_epoch.as_deref() != Some(epoch.as_str())
                || !matches!(live.metadata.presence, Presence::Syncing | Presence::Ready)
            {
                return Err(rejected());
            }
            self.network
                .metadata
                .upload_catalog(&live.context, live.device.key_generation, &epoch, snapshot)
                .map_err(map_metadata)
        })
    }

    /// Read the current device's own frozen policy pages during Syncing or
    /// Ready. The active epoch is selected from the controller registry.
    pub fn self_policy(
        &self,
        access: &ValidatedAccess,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Page<Value>, RelayFailure> {
        let connection_id = self.connection_for_access(access)?;
        self.with_live(access, |live| {
            if !live.metadata.joined {
                return Err(rejected());
            }
            let epoch = self.recheck_connection(&connection_id, access)?;
            if live.metadata.connection_epoch.as_deref() != Some(epoch.as_str())
                || !matches!(live.metadata.presence, Presence::Syncing | Presence::Ready)
            {
                return Err(rejected());
            }
            self.network
                .metadata
                .list_self_policy(&live.context, &epoch, cursor, limit)
                .map_err(map_metadata)
        })
    }

    /// Resolve a zero-Agent device only from the live relay and durable owners.
    /// Both sessions are locked together; directory metadata is never enough.
    pub(crate) fn device_address(
        &self,
        access: &ValidatedAccess,
        target_device: &str,
    ) -> Result<DeviceAddress, RelayFailure> {
        if uuid::Uuid::parse_str(target_device)
            .map(|id| id.to_string())
            .as_deref()
            != Ok(target_device)
            || target_device == access.device_id()
        {
            return Err(rejected());
        }
        let source_id = self.connection_for_access(access)?;
        let source = self.connection_entry(&source_id)?;
        let (target_id, target) = {
            let runtime = self.runtime()?;
            let mut matches = runtime.connections.iter().filter(|(_, entry)| {
                entry.access.device_id() == target_device
                    && entry.access.principal_id() == access.principal_id()
                    && entry.access.issuer_network_id() == access.issuer_network_id()
            });
            let (id, entry) = matches.next().ok_or_else(rejected)?;
            let found = (id.clone(), entry.clone());
            if matches.next().is_some() {
                return Err(rejected());
            }
            found
        };
        self.with_two_live(access, &target.access, |source_live, target_live| {
            if source_live.context.principal_id != target_live.context.principal_id
                || source_live.context.network_id != target_live.context.network_id
                || !durably_ready(&source_live.metadata, &source.epoch)
                || !durably_ready(&target_live.metadata, &target.epoch)
            {
                return Err(rejected());
            }
            let runtime = self.runtime()?;
            verify_runtime_pair(&runtime, &source_id, &source, &target_id, &target)?;
            let (now, _) = fresh_times(&self.monotonic_origin)?;
            for id in [&source_id, &target_id] {
                if !runtime
                    .core
                    .connection_projection(id, now)
                    .map_err(map_relay)?
                    .is_ready()
                {
                    return Err(rejected());
                }
            }
            Ok(DeviceAddress {
                version: 1,
                scope: target_live.relay.scope,
                connection_epoch: target.epoch.clone(),
                membership_revision: target_live.metadata.membership_revision,
                signed_binding: target_live.peer.signed_binding,
            })
        })
    }

    fn prepare_live(
        &self,
        access: &ValidatedAccess,
        session: &SessionProjection,
    ) -> Result<PreparedLive, AuthError> {
        let now = unix_now().map_err(|_| AuthError::Storage)?;
        if session.account.principal_id != access.principal_id()
            || session.account.network_id != self.network.network_id
            || session.device_id != access.device_id()
            || session.session_handle != access.session_handle()
            || access.expires_at() <= now
            || access.issuer_network_id() != self.network.network_id
            || access.issuer_origin() != self.network.issuer
            || access.service_id() != self.network.service_id
            || access.environment() != self.network.environment
        {
            return Err(AuthError::SessionRejected);
        }
        let context = SessionContext {
            principal_id: session.account.principal_id.clone(),
            network_id: session.account.network_id.clone(),
            device_id: session.device_id.clone(),
            session_handle: session.session_handle.clone(),
            expires_at: session.expires_at.min(access.expires_at()),
        };
        let device = self
            .network
            .devices
            .read_state(&context, &context.device_id)
            .map_err(|_| AuthError::Storage)?
            .ok_or(AuthError::SessionRejected)?;
        if device.key_generation != access.key_generation()
            || device.key_fingerprint != access.public_key_fingerprint()
        {
            return Err(AuthError::SessionRejected);
        }
        let peer = self
            .network
            .peers
            .lookup(
                &context,
                access.access_jti(),
                device.key_generation,
                &device.key_fingerprint,
            )
            .map_err(|_| AuthError::Storage)?
            .ok_or(AuthError::SessionRejected)?;
        let metadata = self
            .network
            .metadata
            .read_relay_state(&context, &context.device_id)
            .map_err(|_| AuthError::Storage)?;
        if metadata.key_generation != device.key_generation
            || metadata.key_fingerprint != device.key_fingerprint
            || metadata.identity_binding_id != device.identity_binding_id
            || peer.key_generation != device.key_generation
            || peer.key_fingerprint != device.key_fingerprint
            || peer.identity_binding_id != device.identity_binding_id
            || peer.device_id != device.device_id
            || peer.principal_id != device.principal_id
            || peer.network_id != device.network_id
        {
            return Err(AuthError::SessionRejected);
        }
        let scope = DeviceScope {
            service_id: self.network.service_id.clone(),
            environment: self.network.environment.clone(),
            network_id: self.network.network_id.clone(),
            principal_id: context.principal_id.clone(),
            device_id: context.device_id.clone(),
            key_generation: device.key_generation,
        };
        let relay = TrustedLiveSnapshot {
            scope,
            session_handle: context.session_handle.clone(),
            session_expires_at: context.expires_at.min(peer.session_expires_at),
            current_key_fingerprint: device.key_fingerprint.clone(),
            current_certificate_fingerprint: peer.certificate_fingerprint.clone(),
            current_identity_binding_id: device.identity_binding_id.clone(),
            joined: metadata.joined,
            network_revision: metadata.network_revision,
            membership_revision: metadata.membership_revision,
        };
        Ok(PreparedLive {
            context,
            device,
            peer,
            metadata,
            relay,
        })
    }

    fn with_live<T>(
        &self,
        access: &ValidatedAccess,
        operation: impl FnOnce(PreparedLive) -> Result<T, RelayFailure>,
    ) -> Result<T, RelayFailure> {
        let gated: Result<Result<T, RelayFailure>, AuthError> = self
            .network
            .auth
            .with_valid_session_handle(access.session_handle(), |session| {
                let live = self.prepare_live(access, &session)?;
                Ok(operation(live))
            });
        flatten_gate(gated)
    }

    fn with_two_live<T>(
        &self,
        first: &ValidatedAccess,
        second: &ValidatedAccess,
        operation: impl FnOnce(PreparedLive, PreparedLive) -> Result<T, RelayFailure>,
    ) -> Result<T, RelayFailure> {
        if first.session_handle() == second.session_handle()
            || first.device_id() == second.device_id()
        {
            return Err(rejected());
        }
        let gated: Result<Result<T, RelayFailure>, AuthError> =
            self.network.auth.with_valid_session_handles(
                &[first.session_handle(), second.session_handle()],
                |sessions: Vec<SessionProjection>| {
                    if sessions.len() != 2 {
                        return Err(AuthError::SessionRejected);
                    }
                    let first_session = sessions
                        .iter()
                        .find(|session| session.session_handle == first.session_handle())
                        .ok_or(AuthError::SessionRejected)?;
                    let second_session = sessions
                        .iter()
                        .find(|session| session.session_handle == second.session_handle())
                        .ok_or(AuthError::SessionRejected)?;
                    let first_live = self.prepare_live(first, first_session)?;
                    let second_live = self.prepare_live(second, second_session)?;
                    Ok(operation(first_live, second_live))
                },
            );
        flatten_gate(gated)
    }

    fn connection_for_access(&self, access: &ValidatedAccess) -> Result<String, RelayFailure> {
        let runtime = self.runtime()?;
        runtime
            .connections
            .iter()
            .find(|(_, entry)| entry.access == *access)
            .map(|(connection_id, _)| connection_id.clone())
            .ok_or_else(rejected)
    }

    #[cfg(test)]
    pub(crate) fn connection_id_for_test(&self, access: &ValidatedAccess) -> String {
        self.connection_for_access(access).unwrap()
    }

    fn recheck_connection(
        &self,
        connection_id: &str,
        access: &ValidatedAccess,
    ) -> Result<String, RelayFailure> {
        let runtime = self.runtime()?;
        let entry = runtime
            .connections
            .get(connection_id)
            .ok_or_else(rejected)?;
        if entry.access != *access {
            return Err(rejected());
        }
        let (now, _) = fresh_times(&self.monotonic_origin)?;
        let projection = runtime
            .core
            .connection_projection(connection_id, now)
            .map_err(map_relay)?;
        if projection.connection_epoch() != entry.epoch
            || projection.scope().device_id != access.device_id()
            || projection.scope().key_generation != access.key_generation()
            || projection.session_handle() != access.session_handle()
        {
            return Err(rejected());
        }
        Ok(entry.epoch.clone())
    }

    fn connection_entry(&self, connection_id: &str) -> Result<RuntimeConnection, RelayFailure> {
        self.runtime()?
            .connections
            .get(connection_id)
            .cloned()
            .ok_or_else(rejected)
    }

    fn channel_entries(
        &self,
        connection_id: &str,
        channel_id: &str,
    ) -> Result<[(String, RuntimeConnection); 2], RelayFailure> {
        let runtime = self.runtime()?;
        let ids = runtime
            .core
            .channel_connections(connection_id, channel_id)
            .map_err(map_relay)?;
        let first = runtime
            .connections
            .get(&ids[0])
            .cloned()
            .ok_or_else(rejected)?;
        let second = runtime
            .connections
            .get(&ids[1])
            .cloned()
            .ok_or_else(rejected)?;
        Ok([(ids[0].clone(), first), (ids[1].clone(), second)])
    }

    fn open_target_entry(
        &self,
        value: &Value,
    ) -> Result<(String, RuntimeConnection), RelayFailure> {
        let device = value
            .get("targetDeviceId")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        let generation = value
            .get("targetKeyGeneration")
            .and_then(Value::as_u64)
            .ok_or_else(rejected)?;
        let epoch = value
            .get("targetConnectionEpoch")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;
        self.runtime()?
            .connections
            .iter()
            .find(|(_, entry)| {
                entry.access.device_id() == device
                    && entry.access.key_generation() == generation
                    && entry.epoch == epoch
            })
            .map(|(id, entry)| (id.clone(), entry.clone()))
            .ok_or_else(rejected)
    }

    fn disconnect_exact(&self, connection_id: &str) -> Vec<Effect> {
        let Ok(mut runtime) = self.runtime() else {
            return Vec::new();
        };
        runtime.connections.remove(connection_id);
        runtime.core.disconnect(connection_id)
    }

    /// Best-effort Offline CAS for a connection this controller admitted.
    /// It is scoped by the captured identity and exact server epoch, so it can
    /// only lower presence and cannot affect a replacement connection.
    fn close_presence(&self, access: &ValidatedAccess, epoch: &str) {
        let scope = DeviceScope {
            service_id: access.service_id().to_owned(),
            environment: access.environment().to_owned(),
            network_id: access.issuer_network_id().to_owned(),
            principal_id: access.principal_id().to_owned(),
            device_id: access.device_id().to_owned(),
            key_generation: access.key_generation(),
        };
        let _ =
            self.network
                .metadata
                .close_connection(&scope, access.public_key_fingerprint(), epoch);
    }

    fn runtime(&self) -> Result<MutexGuard<'_, Runtime>, RelayFailure> {
        self.runtime.lock().map_err(|_| unavailable())
    }
}

impl RelayHandler for RelayController {
    fn preflight(&self, headers: &HeaderMap, uri: &Uri) -> Result<ValidatedAccess, Box<Response>> {
        let access = self.network.admit_response(headers, &Method::GET, uri)?;
        self.with_live(&access, |live| {
            if !live.metadata.joined {
                return Err(rejected());
            }
            Ok(())
        })
        .map_err(|_| Box::new((StatusCode::UNAUTHORIZED, "relay unavailable").into_response()))?;
        Ok(access)
    }

    fn hello(
        &self,
        access: ValidatedAccess,
        hello: Value,
    ) -> Result<(String, Vec<Effect>), RelayFailure> {
        validate_control(&hello).map_err(|_| rejected())?;
        if hello.get("type").and_then(Value::as_str) != Some("hello")
            || hello.get("version").and_then(Value::as_u64) != Some(1)
        {
            return Err(rejected());
        }
        self.with_live(&access, |live| {
            if !live.metadata.joined {
                return Err(rejected());
            }
            let (connection_id, effects, epoch, replaced) = {
                let mut runtime = self.runtime()?;
                let replaced: Vec<RuntimeConnection> = runtime
                    .connections
                    .values()
                    .filter(|entry| entry.access.device_id() == access.device_id())
                    .cloned()
                    .collect();
                let (now, _) = fresh_times(&self.monotonic_origin)?;
                let authorized = runtime
                    .core
                    .authorize_device(&access, live.relay.clone(), &live.peer.signed_binding, now)
                    .map_err(map_relay)?;
                let (connection_id, effects) =
                    runtime.core.connect(authorized, now).map_err(map_relay)?;
                let projection = runtime
                    .core
                    .connection_projection(&connection_id, now)
                    .map_err(map_relay)?;
                let epoch = projection.connection_epoch().to_owned();
                runtime
                    .connections
                    .retain(|_, entry| entry.access.device_id() != access.device_id());
                runtime.connections.insert(
                    connection_id.clone(),
                    RuntimeConnection {
                        access: access.clone(),
                        epoch: epoch.clone(),
                    },
                );
                (connection_id, effects, epoch, replaced)
            };
            if self
                .network
                .metadata
                .set_presence(
                    &live.context,
                    live.device.key_generation,
                    &epoch,
                    Presence::Syncing,
                    None,
                )
                .is_err()
            {
                let mut cleanup: Vec<Effect> = effects
                    .into_iter()
                    .filter(|effect| {
                        !matches!(effect, Effect::Control { json, .. } if json["type"] == "hello.result")
                    })
                    .collect();
                cleanup.extend(self.disconnect_exact(&connection_id));
                self.close_presence(&access, &epoch);
                for old in &replaced {
                    self.close_presence(&old.access, &old.epoch);
                }
                return Err(unavailable().with_cleanup(cleanup));
            }
            Ok((connection_id, effects))
        })
    }

    fn control(&self, connection_id: &str, control: Value) -> Result<Vec<Effect>, RelayFailure> {
        validate_control(&control).map_err(|_| rejected())?;
        let sender = self.connection_entry(connection_id)?;
        let kind = control
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(rejected)?;

        if kind == "channel.open" {
            let (target_id, target) = self.open_target_entry(&control)?;
            let result = self.with_two_live(
                &sender.access,
                &target.access,
                |sender_live, target_live| {
                    if !durably_ready(&sender_live.metadata, &sender.epoch)
                        || !durably_ready(&target_live.metadata, &target.epoch)
                    {
                        return Err(rejected());
                    }
                    let mut runtime = self.runtime()?;
                    verify_runtime_pair(&runtime, connection_id, &sender, &target_id, &target)?;
                    let (now, now_ms) = fresh_times(&self.monotonic_origin)?;
                    let bytes = serde_json::to_vec(&control).map_err(|_| rejected())?;
                    runtime
                        .core
                        .handle_control(connection_id, &bytes, None, now, now_ms)
                        .map_err(map_relay)
                },
            );
            // On error the transport closes this socket and invokes
            // `disconnect`, which returns the core's cleanup effects so the
            // other channel endpoint receives its close notification too.
            return result;
        }

        if matches!(
            kind,
            "channel.accept" | "channel.ready" | "channel.close" | "credit.release"
        ) {
            let channel_id = control
                .get("channelId")
                .and_then(Value::as_str)
                .ok_or_else(rejected)?;
            let endpoints = self.channel_entries(connection_id, channel_id)?;
            let first = &endpoints[0];
            let second = &endpoints[1];
            let result = self.with_two_live(
                &first.1.access,
                &second.1.access,
                |first_live, second_live| {
                    if !first_live.metadata.joined || !second_live.metadata.joined {
                        return Err(rejected());
                    }
                    let mut runtime = self.runtime()?;
                    verify_runtime_pair(&runtime, &first.0, &first.1, &second.0, &second.1)?;
                    if !runtime
                        .core
                        .channel_connections(connection_id, channel_id)
                        .is_ok_and(|ids| ids.contains(&first.0) && ids.contains(&second.0))
                    {
                        return Err(rejected());
                    }
                    let (now, now_ms) = fresh_times(&self.monotonic_origin)?;
                    let bytes = serde_json::to_vec(&control).map_err(|_| rejected())?;
                    runtime
                        .core
                        .handle_control(connection_id, &bytes, None, now, now_ms)
                        .map_err(map_relay)
                },
            );
            return result;
        }

        self.with_live(&sender.access, |live| {
            if !live.metadata.joined {
                return Err(rejected());
            }
            let mut runtime = self.runtime()?;
            verify_runtime_entry(&runtime, connection_id, &sender)?;
            let ready_proof = if kind == "ready" {
                let epoch = runtime
                    .connections
                    .get(connection_id)
                    .ok_or_else(rejected)?
                    .epoch
                    .clone();
                let sequence = control
                    .get("catalogSeq")
                    .and_then(Value::as_u64)
                    .ok_or_else(rejected)?;
                if live.metadata.connection_epoch.as_deref() != Some(epoch.as_str())
                    || live.metadata.catalog_epoch.as_deref() != Some(epoch.as_str())
                    || live.metadata.catalog_seq != sequence
                    || live.metadata.durable_ack_seq != Some(sequence)
                {
                    return Err(rejected());
                }
                Some(
                    runtime
                        .core
                        .ready_proof(
                            connection_id,
                            TrustedReadyEvidence {
                                scope: live.relay.scope.clone(),
                                connection_epoch: epoch,
                                catalog_sequence: sequence,
                                acknowledged_sequence: live
                                    .metadata
                                    .durable_ack_seq
                                    .unwrap_or_default(),
                                membership_revision: live.metadata.membership_revision,
                                policy_allows_relay: live.metadata.joined,
                            },
                            fresh_times(&self.monotonic_origin)?.0,
                        )
                        .map_err(map_relay)?,
                )
            } else {
                None
            };
            let (now, now_ms) = fresh_times(&self.monotonic_origin)?;
            let bytes = serde_json::to_vec(&control).map_err(|_| rejected())?;
            let effects = runtime
                .core
                .handle_control(connection_id, &bytes, ready_proof, now, now_ms)
                .map_err(map_relay)?;
            let ready_epoch = (kind == "ready")
                .then(|| {
                    runtime
                        .connections
                        .get(connection_id)
                        .map(|entry| entry.epoch.clone())
                })
                .flatten();
            drop(runtime);
            if let Some(epoch) = ready_epoch
                && let Err(error) = self.network.metadata.set_presence(
                    &live.context,
                    live.device.key_generation,
                    &epoch,
                    Presence::Ready,
                    Some(live.metadata.catalog_seq),
                )
            {
                // A failed durable Ready must never leave a routable core
                // connection behind while the websocket closes. Remove only
                // this admitted connection and deliver its channel cleanup.
                let cleanup = self.disconnect_exact(connection_id);
                self.close_presence(&sender.access, &epoch);
                return Err(map_metadata(error).with_cleanup(cleanup));
            }
            Ok(effects)
        })
    }

    fn binary(&self, connection_id: &str, frame: Vec<u8>) -> Result<Vec<Effect>, RelayFailure> {
        let (channel_id, _) = decode_tls_frame(&frame).map_err(|_| rejected())?;
        let endpoints = self.channel_entries(connection_id, &channel_id)?;
        let first = &endpoints[0];
        let second = &endpoints[1];
        self.with_two_live(
            &first.1.access,
            &second.1.access,
            |first_live, second_live| {
                if !first_live.metadata.joined || !second_live.metadata.joined {
                    return Err(rejected());
                }
                let mut runtime = self.runtime()?;
                verify_runtime_pair(&runtime, &first.0, &first.1, &second.0, &second.1)?;
                let ids = runtime
                    .core
                    .channel_connections(connection_id, &channel_id)
                    .map_err(map_relay)?;
                if !ids.contains(&first.0) || !ids.contains(&second.0) {
                    return Err(rejected());
                }
                let (now, now_ms) = fresh_times(&self.monotonic_origin)?;
                runtime
                    .core
                    .forward_frame(connection_id, &frame, now, now_ms)
                    .map_err(map_relay)
            },
        )
    }

    fn heartbeat(&self, connection_id: &str) -> Result<Vec<Effect>, RelayFailure> {
        let entry = self.connection_entry(connection_id)?;
        let heartbeat = self.with_live(&entry.access, |live| {
            if !live.metadata.joined {
                return Err(rejected());
            }
            let mut runtime = self.runtime()?;
            verify_runtime_entry(&runtime, connection_id, &entry)?;
            let (now, now_ms) = fresh_times(&self.monotonic_origin)?;
            runtime
                .core
                .connection_projection(connection_id, now)
                .map_err(map_relay)?;
            let effects = runtime.core.expire(now, now_ms);
            let stale: Vec<(String, RuntimeConnection)> = runtime
                .connections
                .iter()
                .filter_map(|(id, entry)| {
                    let current = runtime.core.connection_projection(id, now);
                    (!current.is_ok_and(|projection| {
                        projection.connection_epoch() == entry.epoch
                            && projection.session_handle() == entry.access.session_handle()
                    }))
                    .then(|| (id.clone(), entry.clone()))
                })
                .collect();
            for (id, _) in &stale {
                runtime.connections.remove(id);
            }
            drop(runtime);
            for (_, expired) in stale {
                self.close_presence(&expired.access, &expired.epoch);
            }
            Ok(effects)
        });
        match heartbeat {
            Ok(effects) => Ok(effects),
            Err(error) => {
                // Authentication and projection failures must not leave a
                // durable Ready marker behind. The transport closes this
                // socket after the error and then invokes `disconnect`, which
                // removes this exact ID and returns any channel cleanup
                // effects. Lower presence here so a failed heartbeat cannot
                // leave a stale Ready projection while that cleanup runs.
                self.close_presence(&entry.access, &entry.epoch);
                Err(error)
            }
        }
    }

    fn disconnect(&self, connection_id: &str) -> Vec<Effect> {
        let entry = self.connection_entry(connection_id).ok();
        let effects = self.disconnect_exact(connection_id);
        if let Some(entry) = entry {
            self.close_presence(&entry.access, &entry.epoch);
        }
        effects
    }

    fn delivery_failed(&self, connection_id: &str, channel_id: &str) -> Vec<Effect> {
        let Ok(endpoints) = self.channel_entries(connection_id, channel_id) else {
            return Vec::new();
        };
        let first = &endpoints[0];
        let second = &endpoints[1];
        let result = self.with_two_live(
            &first.1.access,
            &second.1.access,
            |first_live, second_live| {
                if !first_live.metadata.joined || !second_live.metadata.joined {
                    return Err(rejected());
                }
                let mut runtime = self.runtime()?;
                verify_runtime_pair(&runtime, &first.0, &first.1, &second.0, &second.1)?;
                let (now, _) = fresh_times(&self.monotonic_origin)?;
                runtime
                    .core
                    .fail_channel(connection_id, channel_id, now)
                    .map_err(map_relay)
            },
        );
        match result {
            Ok(effects) => effects,
            Err(_) => self.disconnect_exact(connection_id),
        }
    }
}

fn verify_runtime_entry(
    runtime: &Runtime,
    connection_id: &str,
    expected: &RuntimeConnection,
) -> Result<(), RelayFailure> {
    let current = runtime
        .connections
        .get(connection_id)
        .ok_or_else(rejected)?;
    if current.access != expected.access || current.epoch != expected.epoch {
        return Err(rejected());
    }
    Ok(())
}

fn durably_ready(metadata: &RelayMetadataState, epoch: &str) -> bool {
    metadata.joined
        && metadata.presence == Presence::Ready
        && metadata.connection_epoch.as_deref() == Some(epoch)
        && metadata.catalog_epoch.as_deref() == Some(epoch)
        && metadata.durable_ack_seq == Some(metadata.catalog_seq)
}

fn verify_runtime_pair(
    runtime: &Runtime,
    first_id: &str,
    first: &RuntimeConnection,
    second_id: &str,
    second: &RuntimeConnection,
) -> Result<(), RelayFailure> {
    verify_runtime_entry(runtime, first_id, first)?;
    verify_runtime_entry(runtime, second_id, second)
}

fn flatten_gate<T>(gated: Result<Result<T, RelayFailure>, AuthError>) -> Result<T, RelayFailure> {
    match gated {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error),
        Err(AuthError::SessionRejected) => Err(rejected()),
        Err(_) => Err(unavailable()),
    }
}

fn fresh_times(origin: &Instant) -> Result<(i64, i64), RelayFailure> {
    let wall = unix_now().map_err(|_| unavailable())?;
    let elapsed = i64::try_from(origin.elapsed().as_millis()).map_err(|_| unavailable())?;
    Ok((wall, elapsed))
}

fn unix_now() -> Result<i64, ()> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ())?
            .as_secs(),
    )
    .map_err(|_| ())
}

fn map_relay(_: RelayError) -> RelayFailure {
    rejected()
}

fn map_metadata(error: MetadataError) -> RelayFailure {
    match error {
        MetadataError::InvalidSession | MetadataError::IdentityConflict => rejected(),
        _ => unavailable(),
    }
}

fn rejected() -> RelayFailure {
    RelayFailure::new(FAILURE_REJECTED)
}

fn unavailable() -> RelayFailure {
    RelayFailure::new(FAILURE_UNAVAILABLE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_http::tests::Fixture;
    use crate::relay_http::tests::{
        controller_access, finish_ready, join_on_controller, joined_syncing_controller,
    };
    use serde_json::json;
    use uuid::Uuid;

    #[tokio::test]
    async fn address_rejects_cross_principal_revocation_and_membership_leave() {
        let fixture = Fixture::new();
        let source = fixture.device("address-owner");
        let target = fixture.device("address-owner");
        let foreign = fixture.device("address-foreign");
        let (controller, epoch, hello) = joined_syncing_controller(&fixture, &source).await;
        finish_ready(&controller, &fixture, &source, &epoch, &hello);
        let (target_epoch, target_hello) = join_on_controller(&controller, &fixture, &target).await;
        finish_ready(&controller, &fixture, &target, &target_epoch, &target_hello);
        let (foreign_epoch, foreign_hello) =
            join_on_controller(&controller, &fixture, &foreign).await;
        finish_ready(
            &controller,
            &fixture,
            &foreign,
            &foreign_epoch,
            &foreign_hello,
        );
        let access = controller_access(&controller, &fixture, &source, "GET", "/v1/me/network");
        assert!(
            controller
                .device_address(&access, &target.context.device_id)
                .is_ok()
        );
        for device in [
            &source.context.device_id,
            &foreign.context.device_id,
            &Uuid::new_v4().to_string(),
        ] {
            assert_eq!(
                controller
                    .device_address(&access, device)
                    .err()
                    .unwrap()
                    .code(),
                FAILURE_REJECTED
            );
        }
        let leave_uri = format!(
            "/v1/networks/{}/devices/{}/leave",
            fixture.network, target.context.device_id
        );
        assert_eq!(
            fixture
                .request(
                    &source,
                    "POST",
                    &leave_uri,
                    &json!({
                        "mutationId":Uuid::new_v4().to_string(),"expectedMembershipRevision":1
                    })
                    .to_string()
                )
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            controller
                .device_address(&access, &target.context.device_id)
                .err()
                .unwrap()
                .code(),
            FAILURE_REJECTED
        );
        let join_uri = leave_uri.replace("/leave", "/join");
        assert_eq!(
            fixture
                .request(
                    &source,
                    "POST",
                    &join_uri,
                    &json!({
                        "mutationId":Uuid::new_v4().to_string(),"expectedMembershipRevision":2
                    })
                    .to_string()
                )
                .await
                .0,
            StatusCode::OK
        );
        fixture.auth.revoke_session(&target.account_token).unwrap();
        assert_eq!(
            controller
                .device_address(&access, &target.context.device_id)
                .err()
                .unwrap()
                .code(),
            FAILURE_REJECTED
        );
    }

    #[tokio::test]
    async fn address_tracks_replacement_epoch_and_never_returns_syncing_target() {
        let fixture = Fixture::new();
        let source = fixture.device("address-replace");
        let target = fixture.device("address-replace");
        let (controller, epoch, hello) = joined_syncing_controller(&fixture, &source).await;
        finish_ready(&controller, &fixture, &source, &epoch, &hello);
        let (old_epoch, target_hello) = join_on_controller(&controller, &fixture, &target).await;
        let access = controller_access(&controller, &fixture, &source, "GET", "/v1/me/network");
        assert!(
            controller
                .device_address(&access, &target.context.device_id)
                .is_err()
        );
        finish_ready(&controller, &fixture, &target, &old_epoch, &target_hello);
        assert_eq!(
            controller
                .device_address(&access, &target.context.device_id)
                .unwrap()
                .connection_epoch,
            old_epoch
        );
        let target_access = controller_access(&controller, &fixture, &target, "GET", "/v1/ws");
        let (_, effects) = controller
            .hello(
                target_access,
                json!({
                    "version":1,"controlId":Uuid::new_v4().to_string(),"type":"hello",
                    "clientVersion":"replacement-test","capabilities":["tls13-mtls"]
                }),
            )
            .unwrap();
        let next_hello = effects
            .into_iter()
            .find_map(|effect| match effect {
                Effect::Control { json, .. } if json["type"] == "hello.result" => Some(json),
                _ => None,
            })
            .unwrap();
        let next_epoch = next_hello["connectionEpoch"].as_str().unwrap();
        assert_ne!(next_epoch, old_epoch);
        assert!(
            controller
                .device_address(&access, &target.context.device_id)
                .is_err()
        );
        finish_ready(&controller, &fixture, &target, next_epoch, &next_hello);
        assert_eq!(
            controller
                .device_address(&access, &target.context.device_id)
                .unwrap()
                .connection_epoch,
            next_epoch
        );
    }

    #[tokio::test]
    async fn failed_durable_ready_immediately_removes_routable_connection() {
        let fixture = Fixture::new();
        let device = fixture.device("ready-storage-failure");
        let (controller, epoch, hello) = joined_syncing_controller(&fixture, &device).await;
        let connection_id = controller
            .runtime()
            .unwrap()
            .connections
            .keys()
            .next()
            .unwrap()
            .clone();
        let access = controller_access(
            &controller,
            &fixture,
            &device,
            "PUT",
            "/v1/devices/self/catalog",
        );
        let snapshot: CatalogSnapshot = serde_json::from_value(json!({
            "version":1,"connectionEpoch":epoch,"catalogSeq":1,"items":[]
        }))
        .unwrap();
        controller.upload_catalog(&access, &snapshot).unwrap();
        let db = rusqlite::Connection::open(fixture.dir.path().join("metadata.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TRIGGER fail_ready BEFORE UPDATE OF presence ON devices
             WHEN NEW.presence='ready'
             BEGIN SELECT RAISE(ABORT, 'test durable write failure'); END;",
        )
        .unwrap();
        let ready = json!({"version":1,"controlId":Uuid::new_v4().to_string(),
            "type":"ready","catalogSeq":1,"serviceId":hello["serviceId"],
            "networkId":hello["networkId"],"bootEpoch":hello["bootEpoch"],
            "connectionEpoch":hello["connectionEpoch"]});
        let failure = controller.control(&connection_id, ready).unwrap_err();
        assert_eq!(failure.code(), FAILURE_UNAVAILABLE);
        let runtime = controller.runtime().unwrap();
        assert!(!runtime.connections.contains_key(&connection_id));
        assert!(
            runtime
                .core
                .connection_projection(&connection_id, unix_now().unwrap())
                .is_err()
        );
        drop(runtime);
        let state = fixture
            .service
            .metadata
            .read_relay_state(&device.context, &device.context.device_id)
            .unwrap();
        assert_eq!(state.presence, Presence::Offline);
        assert!(!durably_ready(&state, &epoch));
        assert!(controller.connection_for_access(&access).is_err());
    }
}
