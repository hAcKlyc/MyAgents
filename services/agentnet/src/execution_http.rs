//! Optional finite Bot queue HTTP adapter. Signed leases authorize an accepted
//! command; only a verified Host receipt establishes its actual effect.
use crate::{
    AuthError, SessionProjection,
    admin_store::{AdminConfig, AdminStore, Bot},
    execution_gate::{self as gate, GateError},
    execution_store::{CommandRow, ExecutionStore, GrantRow, GrantState, InstancePin, LedgerError},
    network_http::NetworkService,
    relay_controller::RelayController,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use myagents_agentnet_execution_core::{
    AUDIENCE, Activity, Admission, BotSnapshot, Command, Grant, GrantClaims, HostContext,
    HostObservation, IntentClaims, LeaseClaims, MAX_LEASE_SECONDS, MAX_OBJECT_BYTES,
    MAX_PROOF_SECONDS, MAX_SAFE_INTEGER, NAMESPACE, Operation, Receipt, RevocationClaims,
    command_hash, verify_revocation,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct ExecutionService {
    #[cfg(test)]
    fixture_origin: Option<String>,
    network: NetworkService,
    relay: Arc<RelayController>,
    store: Arc<ExecutionStore>,
    registry: Arc<AdminStore>,
    config: Arc<AdminConfig>,
    in_flight: Arc<Semaphore>,
}
impl ExecutionService {
    pub fn open(
        network: NetworkService,
        relay: Arc<RelayController>,
        dir: &Path,
        config: AdminConfig,
    ) -> Result<Self, AuthError> {
        config.validate().map_err(|_| AuthError::Configuration)?;
        let pin = InstancePin {
            issuer: network.issuer.clone(),
            service_id: network.service_id.clone(),
            environment: network.environment.clone(),
            network_id: network.network_id.clone(),
        };
        Ok(Self {
            #[cfg(test)]
            fixture_origin: None,
            store: Arc::new(ExecutionStore::open(dir, pin).map_err(|_| AuthError::Storage)?),
            registry: Arc::new(
                AdminStore::open(dir, &network.network_id).map_err(|_| AuthError::Storage)?,
            ),
            network,
            relay,
            config: Arc::new(config),
            in_flight: Arc::new(Semaphore::new(32)),
        })
    }
    pub(crate) fn ledger(&self) -> Arc<ExecutionStore> {
        self.store.clone()
    }
    pub fn router(&self) -> Router<()> {
        Router::new()
            .route("/api/bots/grants/accept", post(dispatch))
            .route("/api/bots/grants/revoke", post(dispatch))
            .route("/api/admin/bots/{id}/execution", post(dispatch))
            .route("/api/admin/execution/mutations/{id}", get(dispatch))
            .route("/execution/self/pull", post(dispatch))
            .route("/execution/self/lease", post(dispatch))
            .route("/execution/self/receipt", post(dispatch))
            .route("/execution/self/observe", post(dispatch))
            .layer(middleware::from_fn(no_store))
            .with_state(Arc::new(self.clone()))
    }
    fn bot(&self, id: &str) -> Result<Bot, Error> {
        self.registry
            .bots()
            .map_err(|_| Error::unavailable())?
            .into_iter()
            .find(|b| b.id == id)
            .ok_or(Error::new(StatusCode::NOT_FOUND, "BOT_NOT_FOUND"))
    }
    fn check_bot_grant(&self, bot: &Bot, g: &Grant) -> Result<(), Error> {
        if bot.id != g.bot_id
            || bot.owner_id != g.scope.host_owner_id
            || bot.host_id != g.scope.host_device_id
        {
            return Err(Error::forbidden("BOT_TARGET_MISMATCH"));
        }
        let host = self
            .config
            .hosts
            .iter()
            .find(|h| h.id == bot.host_id)
            .ok_or(Error::forbidden("HOST_RESOURCE_UNAVAILABLE"))?;
        if !host.owner_ids.contains(&bot.owner_id)
            || g.allowed_runtimes
                .iter()
                .any(|r| !host.runtimes.contains(r))
            || g.max_daily_tokens > self.config.max_daily_tokens
        {
            return Err(Error::forbidden("GRANT_RESOURCE_REJECTED"));
        }
        for id in &g.allowed_model_refs {
            if !self.config.model_refs.iter().any(|m| {
                m.id == *id
                    && m.owner_ids.contains(&bot.owner_id)
                    && g.allowed_runtimes.iter().any(|r| m.runtimes.contains(r))
            }) {
                return Err(Error::forbidden("MODEL_RESOURCE_REJECTED"));
            }
        }
        Ok(())
    }
    fn check_operation(&self, bot: &Bot, operation: &Operation) -> Result<(), Error> {
        if bot.deleted && !matches!(operation, Operation::Restore(_)) {
            return Err(Error::forbidden("BOT_DELETED"));
        }
        if let Operation::Delete(params) = operation
            && params.confirmation != bot.name
        {
            return Err(Error::bad());
        }
        let config = match operation {
            Operation::Create(p) => Some(p.config()),
            Operation::Configure(p) => Some(p.clone()),
            _ => None,
        };
        if let Some(c) = config
            && let Some(model) = &c.model_ref
            && !self.config.model_refs.iter().any(|r| {
                r.id == *model
                    && r.owner_ids.contains(&bot.owner_id)
                    && r.runtimes.contains(&c.runtime)
            })
        {
            return Err(Error::forbidden("MODEL_RESOURCE_REJECTED"));
        }
        Ok(())
    }
    fn human(
        &self,
        p: &SessionProjection,
        method: &Method,
        path: &str,
        body: &[u8],
    ) -> Result<Value, Error> {
        if p.account.network_id != self.network.network_id {
            return Err(Error::forbidden("NETWORK_REJECTED"));
        }
        let now = gate::now()?;
        match (method.as_str(), path) {
            ("POST", "/api/bots/grants/accept") => {
                let q: AcceptRequest = decode(body)?;
                q.grant.validate().map_err(|_| Error::bad())?;
                let scope = gate::owner_scope(&self.network, p, &q.grant.scope.host_device_id)?;
                if scope != q.grant.scope {
                    return Err(Error::forbidden("GRANT_SCOPE_REJECTED"));
                }
                let bot = self.bot(&q.grant.bot_id)?;
                self.check_bot_grant(&bot, &q.grant)?;
                if bot.deleted
                    && !q
                        .grant
                        .operations
                        .contains(&myagents_agentnet_execution_core::Method::Restore)
                {
                    return Err(Error::forbidden("BOT_DELETED"));
                }
                let row = self.store.accept_grant(
                    &q.grant,
                    q.expected_generation,
                    &p.session_handle,
                    now,
                )?;
                if row.state != GrantState::Active {
                    return Err(Error::conflict("GRANT_NOT_ACTIVE"));
                }
                let until = u64::try_from(p.expires_at).map_err(|_| Error::bad())?;
                let signed = self.sign_grant(&row, now, until)?;
                let known = self
                    .store
                    .known_bot_snapshot(&row.grant.scope, &row.grant.bot_id)?;
                Ok(
                    json!({"grant":row.grant,"state":row.state,"grant_token":signed,"last_known_snapshot":known,"effective_revoked":false}),
                )
            }
            ("POST", "/api/bots/grants/revoke") => {
                let q: RevokeRequest = decode(body)?;
                let old = self.store.grant(&q.grant_id)?;
                let scope = gate::owner_scope(&self.network, p, &old.grant.scope.host_device_id)?;
                if scope != old.grant.scope {
                    return Err(Error::forbidden("GRANT_OWNER_REQUIRED"));
                }
                let row = self.store.revoke(
                    &q.grant_id,
                    q.expected_generation,
                    &p.account.principal_id,
                    &q.mutation_id,
                )?;
                Ok(
                    json!({"grant_id":row.grant.id,"generation":row.grant.generation,"state":row.state,"effective_revoked":row.state==GrantState::Revoked}),
                )
            }
            _ => {
                if !self
                    .config
                    .admin_principal_ids
                    .contains(&p.account.principal_id)
                {
                    return Err(Error::forbidden("ADMIN_REQUIRED"));
                }
                if let Some(id) = path
                    .strip_prefix("/api/admin/bots/")
                    .and_then(|s| s.strip_suffix("/execution"))
                {
                    if method != Method::POST || !uuid(id) {
                        return Err(Error::bad());
                    }
                    let q: QueueRequest = decode(body)?;
                    let prior = match self.store.command(&q.mutation_id) {
                        Ok(r) => Some(r),
                        Err(e) if e.0 == "EXECUTION_MUTATION_NOT_FOUND" => None,
                        Err(e) => return Err(e.into()),
                    };
                    let handle = prior.as_ref().map_or(p.session_handle.as_str(), |r| {
                        r.command.actor_session_handle.as_str()
                    });
                    let mut command = Command {
                        mutation_id: q.mutation_id,
                        request_hash: String::new(),
                        actor_principal_id: p.account.principal_id.clone(),
                        actor_session_handle: handle.into(),
                        grant_id: q.grant_id,
                        grant_generation: q.grant_generation,
                        bot_id: id.into(),
                        binding_generation: q.binding_generation,
                        expected_host_revision: q.expected_host_revision,
                        operation: q.operation,
                    };
                    command.request_hash = command_hash(&command).map_err(|_| Error::bad())?;
                    command.validate().map_err(|_| Error::bad())?;
                    if let Some(old) = prior {
                        if old.command != command {
                            return Err(Error::conflict("EXECUTION_MUTATION_MISMATCH"));
                        }
                        return Ok(command_projection(&old));
                    }
                    let row = self.store.grant(&command.grant_id)?;
                    if row.state != GrantState::Active {
                        return Err(Error::conflict("GRANT_NOT_ACTIVE"));
                    }
                    let bot = self.bot(id)?;
                    self.check_bot_grant(&bot, &row.grant)?;
                    self.check_operation(&bot, &command.operation)?;
                    let saved = self.store.enqueue(&command, &row.grant, now)?;
                    Ok(command_projection(&saved))
                } else if let Some(id) = path.strip_prefix("/api/admin/execution/mutations/") {
                    if method != Method::GET || !uuid(id) || !body.is_empty() {
                        return Err(Error::bad());
                    }
                    let row = self.store.command(id)?;
                    if row.command.actor_principal_id != p.account.principal_id {
                        return Err(Error::forbidden("EXECUTION_ACTOR_REQUIRED"));
                    }
                    Ok(command_projection(&row))
                } else {
                    Err(Error::bad())
                }
            }
        }
    }
    fn sign_grant(&self, row: &GrantRow, now: u64, until: u64) -> Result<String, Error> {
        let exp = deadline(now, MAX_PROOF_SECONDS, until.min(row.grant.expires_at))?;
        let claims = GrantClaims {
            iss: self.network.issuer.clone(),
            aud: AUDIENCE.into(),
            namespace: NAMESPACE.into(),
            iat: now,
            nbf: now,
            exp,
            jti: Uuid::new_v4().to_string(),
            grant: row.grant.clone(),
        };
        self.network
            ._keys
            .sign_execution_grant(&gate::profile(&self.network), &claims)
            .map_err(|_| Error::unavailable())
    }
    fn host(
        &self,
        a: &myagents_agentnet_admission_core::ValidatedAccess,
        path: &str,
        body: &[u8],
    ) -> Result<Value, Error> {
        match path {
            "/execution/self/observe" => {
                let q: ObserveRequest = decode(body)?;
                q.observation.validate().map_err(|_| Error::bad())?;
                gate::with_host(&self.network, &self.relay, a, |live| {
                    live.check_context(&q.host_context)?;
                    let host = self
                        .config
                        .hosts
                        .iter()
                        .find(|h| h.id == live.scope.host_device_id)
                        .ok_or(GateError("HOST_RESOURCE_UNAVAILABLE"))?;
                    if !host.owner_ids.contains(&live.scope.host_owner_id) {
                        return Err(GateError("HOST_RESOURCE_UNAVAILABLE"));
                    }
                    let seen_at = gate::now()?;
                    self.store
                        .observe(&live.scope, &q.host_context, &q.observation, seen_at)
                        .map_err(to_gate)?;
                    Ok(json!({"observed":true,"seen_at":seen_at}))
                })
                .map_err(Error::from)
            }
            "/execution/self/pull" => {
                let q: PullRequest = decode(body)?;
                q.host_context.validate().map_err(|_| Error::bad())?;
                let mut response_bytes = 256usize;
                let (scope, commands, grants, revocations) = gate::with_host(
                    &self.network,
                    &self.relay,
                    a,
                    |live| {
                        live.check_context(&q.host_context)?;
                        let now = gate::now()?;
                        let mut grants = Vec::new();
                        let mut revocations = Vec::new();
                        let commands = self.store.queued_for(&live.scope).map_err(to_gate)?;
                        let needed: std::collections::BTreeSet<_> = commands
                            .iter()
                            .map(|r| r.command.grant_id.as_str())
                            .collect();
                        let mut rows = self.store.grants().map_err(to_gate)?;
                        rows.sort_by_key(|r| !needed.contains(r.grant.id.as_str()));
                        for row in rows {
                            if row.grant.scope != live.scope {
                                continue;
                            }
                            if row.state == GrantState::Active
                                && row.grant.expires_at > now
                                && grants.len() < 8
                            {
                                let item = json!({"grant_token":self.sign_grant(&row,now,live.expires_at).map_err(error_gate)?});
                                push_budget(&mut grants, item, &mut response_bytes)?;
                            } else if row.state == GrantState::Revoking && revocations.len() < 8 {
                                let exp = deadline(now, MAX_LEASE_SECONDS, live.expires_at)
                                    .map_err(error_gate)?;
                                let claims = RevocationClaims {
                                    iss: self.network.issuer.clone(),
                                    aud: AUDIENCE.into(),
                                    namespace: NAMESPACE.into(),
                                    iat: now,
                                    nbf: now,
                                    exp,
                                    jti: Uuid::new_v4().to_string(),
                                    scope: live.scope.clone(),
                                    grant_id: row.grant.id,
                                    revoked_generation: row.grant.generation,
                                    bot_id: row.grant.bot_id,
                                    host_context: q.host_context.clone(),
                                };
                                let token = self
                                    .network
                                    ._keys
                                    .sign_execution_revocation(
                                        &gate::profile(&self.network),
                                        &claims,
                                        live.expires_at,
                                    )
                                    .map_err(|_| GateError("EXECUTION_SIGNING_UNAVAILABLE"))?;
                                push_budget(
                                    &mut revocations,
                                    json!({"revocation_token":token}),
                                    &mut response_bytes,
                                )?;
                            }
                        }
                        Ok((live.scope.clone(), commands, grants, revocations))
                    },
                )?;
                let mut intents = Vec::new();
                // Never re-enter AuthStore inside with_host: each original actor
                // gets a separate complete Host+actor gate after the first ends.
                for row in commands {
                    let result = gate::with_host_and_actor(
                        &self.network,
                        &self.relay,
                        a,
                        &row.command.actor_session_handle,
                        &row.command.actor_principal_id,
                        &self.config.admin_principal_ids,
                        |live, until| {
                            live.check_context(&q.host_context)?;
                            if live.scope != scope || live.scope != row.scope {
                                return Err(GateError("HOST_CONTEXT_REJECTED"));
                            }
                            let now = gate::now()?;
                            let g = self.store.grant(&row.command.grant_id).map_err(to_gate)?;
                            if g.state != GrantState::Active {
                                return Err(GateError("GRANT_NOT_ACTIVE"));
                            }
                            let bot = self.bot(&row.command.bot_id).map_err(error_gate)?;
                            self.check_bot_grant(&bot, &g.grant).map_err(error_gate)?;
                            self.check_operation(&bot, &row.command.operation)
                                .map_err(error_gate)?;
                            let exp =
                                deadline(now, MAX_PROOF_SECONDS, until.min(g.grant.expires_at))
                                    .map_err(error_gate)?;
                            let mut claims = IntentClaims {
                                iss: self.network.issuer.clone(),
                                aud: AUDIENCE.into(),
                                namespace: NAMESPACE.into(),
                                iat: now,
                                nbf: now,
                                exp,
                                jti: Uuid::new_v4().to_string(),
                                scope: live.scope,
                                grant: g.grant,
                                command: row.command.clone(),
                            };
                            if let Some(old) = self
                                .store
                                .current_intent(&claims.scope, &claims.command.mutation_id, now)
                                .map_err(to_gate)?
                                && old.command == claims.command
                                && old.grant == claims.grant
                                && old.exp <= exp
                            {
                                claims = old;
                            }
                            let token = self
                                .network
                                ._keys
                                .sign_execution_intent(
                                    &gate::profile(&self.network),
                                    &claims,
                                    until,
                                )
                                .map_err(|_| GateError("EXECUTION_SIGNING_UNAVAILABLE"))?;
                            let hash = self.store.issue_intent(&claims, now).map_err(to_gate)?;
                            Ok(json!({"intent_token":token,"intent_hash":hash}))
                        },
                    );
                    match result {
                        Ok(value) => {
                            push_budget(&mut intents, value, &mut response_bytes)?;
                        }
                        Err(e)
                            if matches!(
                                e.0,
                                "SESSION_REJECTED"
                                    | "ADMIN_REQUIRED"
                                    | "GRANT_NOT_ACTIVE"
                                    | "COMMAND_NOT_PENDING"
                            ) => {}
                        Err(e) => return Err(e.into()),
                    }
                }
                Ok(json!({"grants":grants,"intents":intents,"revocations":revocations}))
            }
            "/execution/self/lease" => {
                let q: LeaseRequest = decode(body)?;
                q.host_context.validate().map_err(|_| Error::bad())?;
                if !hex_hash(&q.intent_hash) {
                    return Err(Error::bad());
                }
                let intent = gate::with_host(&self.network, &self.relay, a, |live| {
                    live.check_context(&q.host_context)?;
                    let stored = self.store.intent(&q.intent_hash).map_err(to_gate)?;
                    if stored.scope != live.scope {
                        return Err(GateError("HOST_IDENTITY_REJECTED"));
                    }
                    Ok(stored)
                })?;
                gate::with_host_and_actor(
                    &self.network,
                    &self.relay,
                    a,
                    &intent.command.actor_session_handle,
                    &intent.command.actor_principal_id,
                    &self.config.admin_principal_ids,
                    |live, until| {
                        live.check_context(&q.host_context)?;
                        if live.scope != intent.scope {
                            return Err(GateError("HOST_IDENTITY_REJECTED"));
                        }
                        let now = gate::now()?;
                        let exp = deadline(
                            now,
                            MAX_LEASE_SECONDS,
                            until.min(intent.exp).min(intent.grant.expires_at),
                        )
                        .map_err(error_gate)?;
                        let bot = self.bot(&intent.command.bot_id).map_err(error_gate)?;
                        self.check_bot_grant(&bot, &intent.grant)
                            .map_err(error_gate)?;
                        self.check_operation(&bot, &intent.command.operation)
                            .map_err(error_gate)?;
                        let claims = LeaseClaims {
                            iss: self.network.issuer.clone(),
                            aud: AUDIENCE.into(),
                            namespace: NAMESPACE.into(),
                            iat: now,
                            nbf: now,
                            exp,
                            jti: Uuid::new_v4().to_string(),
                            scope: live.scope,
                            grant_id: intent.command.grant_id.clone(),
                            grant_generation: intent.command.grant_generation,
                            bot_id: intent.command.bot_id.clone(),
                            binding_generation: intent.command.binding_generation,
                            mutation_id: intent.command.mutation_id.clone(),
                            request_hash: intent.command.request_hash.clone(),
                            intent_hash: q.intent_hash.clone(),
                            host_context: q.host_context.clone(),
                            lease_id: Uuid::new_v4().to_string(),
                        };
                        let candidate_token = self
                            .network
                            ._keys
                            .sign_execution_lease(
                                &gate::profile(&self.network),
                                &claims,
                                &intent,
                                until,
                            )
                            .map_err(|_| GateError("EXECUTION_SIGNING_UNAVAILABLE"))?;
                        let accepted = self
                            .store
                            .issue_lease(&claims, &intent, &q.host_context, now)
                            .map_err(to_gate)?;
                        let token = if accepted == claims {
                            candidate_token
                        } else {
                            self.network
                                ._keys
                                .sign_execution_lease(
                                    &gate::profile(&self.network),
                                    &accepted,
                                    &intent,
                                    until,
                                )
                                .map_err(|_| GateError("EXECUTION_SIGNING_UNAVAILABLE"))?
                        };
                        Ok(json!({"lease_token":token,"lease_id":accepted.lease_id}))
                    },
                )
                .map_err(Into::into)
            }
            "/execution/self/receipt" => {
                let q: ReceiptRequest = decode(body)?;
                gate::with_host(&self.network,&self.relay,a,|live|{
                    match q {
                        ReceiptRequest::Command {host_context,lease_id,receipt}=>{
                            live.check_context(&host_context)?;if !uuid(&lease_id){return Err(GateError("EXECUTION_INVALID"));}
                            let row=self.store.record_receipt(&lease_id,&live.scope,&receipt).map_err(to_gate)?;
                            Ok(command_projection(&row))
                        }
                        ReceiptRequest::Revocation {host_context,revocation_token,snapshot}=>{
                            live.check_context(&host_context)?;snapshot.validate().map_err(|_|GateError("HOST_RECEIPT_REJECTED"))?;
                            if snapshot.admission!=Admission::Closed||!matches!(snapshot.activity,Activity::Stopped|Activity::Idle)||snapshot.active_run.is_some(){return Err(GateError("HOST_REVOCATION_UNCONFIRMED"));}
                            let rows=self.store.grants().map_err(to_gate)?;
                            let row=rows.into_iter().find(|r|r.grant.scope==live.scope&&r.grant.bot_id==snapshot.bot_id&&matches!(r.state,GrantState::Revoking|GrantState::Revoked)).ok_or(GateError("GRANT_REVOCATION_MISMATCH"))?;
                            verify_revocation(&revocation_token,&self.network._keys.jwks(),&live.scope,gate::now()?,&host_context,&row.grant.id,&row.grant.bot_id,row.grant.generation).map_err(|_|GateError("HOST_REVOCATION_PROOF_REJECTED"))?;
                            let confirmed=self.store.confirm_revoked(&row.grant.id,row.grant.generation,&live.scope,&snapshot).map_err(to_gate)?;
                            Ok(json!({"grant_id":confirmed.grant.id,"generation":confirmed.grant.generation,"state":confirmed.state,"effective_revoked":true}))
                        }
                    }
                }).map_err(Into::into)
            }
            _ => Err(Error::bad()),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptRequest {
    grant: Grant,
    expected_generation: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeRequest {
    grant_id: String,
    expected_generation: u64,
    mutation_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueueRequest {
    mutation_id: String,
    grant_id: String,
    grant_generation: u64,
    binding_generation: u64,
    expected_host_revision: u64,
    operation: Operation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PullRequest {
    host_context: HostContext,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObserveRequest {
    host_context: HostContext,
    observation: HostObservation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseRequest {
    intent_hash: String,
    host_context: HostContext,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ReceiptRequest {
    Command {
        host_context: HostContext,
        lease_id: String,
        receipt: Receipt,
    },
    Revocation {
        host_context: HostContext,
        revocation_token: String,
        snapshot: BotSnapshot,
    },
}
fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, Error> {
    serde_json::from_slice(body).map_err(|_| Error::bad())
}
fn uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
}
fn hex_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn deadline(now: u64, ttl: u64, until: u64) -> Result<u64, Error> {
    let end = now.checked_add(ttl).ok_or_else(Error::bad)?.min(until);
    if end <= now || end > MAX_SAFE_INTEGER {
        return Err(Error::forbidden("EXECUTION_AUTH_EXPIRED"));
    }
    Ok(end)
}
fn command_projection(row: &CommandRow) -> Value {
    json!({"mutation_id":row.command.mutation_id,"request_hash":row.command.request_hash,"bot_id":row.command.bot_id,"status":row.status,"receipt":row.receipt,"lease_count":row.lease_count})
}
const MAX_PULL_BYTES: usize = 1024 * 1024;
fn push_budget(values: &mut Vec<Value>, value: Value, used: &mut usize) -> Result<bool, GateError> {
    let size = serde_json::to_vec(&value)
        .map_err(|_| GateError("EXECUTION_RESPONSE_UNAVAILABLE"))?
        .len();
    let next = used
        .checked_add(size + 1)
        .ok_or(GateError("EXECUTION_RESPONSE_CAPACITY"))?;
    if next > MAX_PULL_BYTES {
        return Ok(false);
    }
    *used = next;
    values.push(value);
    Ok(true)
}
fn to_gate(e: LedgerError) -> GateError {
    GateError(e.0)
}
fn error_gate(e: Error) -> GateError {
    GateError(e.code)
}
#[derive(Debug)]
struct Error {
    status: StatusCode,
    code: &'static str,
}
impl Error {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
    fn bad() -> Self {
        Self::new(StatusCode::BAD_REQUEST, "EXECUTION_INVALID")
    }
    fn forbidden(code: &'static str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code)
    }
    fn conflict(code: &'static str) -> Self {
        Self::new(StatusCode::CONFLICT, code)
    }
    fn unavailable() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "EXECUTION_UNAVAILABLE")
    }
}
impl From<AuthError> for Error {
    fn from(e: AuthError) -> Self {
        match e {
            AuthError::SessionRejected => Self::new(StatusCode::UNAUTHORIZED, "SESSION_REJECTED"),
            _ => Self::unavailable(),
        }
    }
}
impl From<GateError> for Error {
    fn from(e: GateError) -> Self {
        if e.0.contains("UNAVAILABLE") {
            Self::unavailable()
        } else {
            Self::forbidden(e.0)
        }
    }
}
impl From<LedgerError> for Error {
    fn from(e: LedgerError) -> Self {
        if e.0.contains("STORAGE") || e.0 == "EXECUTION_CAPACITY" {
            Self::new(StatusCode::SERVICE_UNAVAILABLE, e.0)
        } else if e.0.ends_with("NOT_FOUND") {
            Self::new(StatusCode::NOT_FOUND, e.0)
        } else {
            Self::conflict(e.0)
        }
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"ok":false,"code":self.code}))).into_response()
    }
}
fn bearer(h: &HeaderMap) -> Result<Zeroizing<String>, Error> {
    let mut values = h.get_all(header::AUTHORIZATION).iter();
    let v = values
        .next()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty() && s.len() <= 16 * 1024)
        .ok_or(Error::new(StatusCode::UNAUTHORIZED, "SESSION_REJECTED"))?;
    if values.next().is_some() {
        return Err(Error::bad());
    }
    Ok(Zeroizing::new(v.into()))
}
async fn dispatch(State(s): State<Arc<ExecutionService>>, request: Request) -> Response {
    let permit = match s.in_flight.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return Error::new(StatusCode::SERVICE_UNAVAILABLE, "EXECUTION_CAPACITY")
                .into_response();
        }
    };
    let (parts, body) = request.into_parts();
    if parts.uri.query().is_some() {
        return Error::bad().into_response();
    }
    let path = parts.uri.path().to_owned();
    let host = path.starts_with("/execution/self/");
    let access = if host {
        match s
            .network
            .admit_response(&parts.headers, &parts.method, &parts.uri)
        {
            Ok(a) => Some(a),
            Err(r) => return *r,
        }
    } else {
        None
    };
    let human_token = if !host {
        let mut origins = parts.headers.get_all(header::ORIGIN).iter();
        let expected_origin = s.network.issuer.as_str();
        #[cfg(test)]
        let expected_origin = s.fixture_origin.as_deref().unwrap_or(expected_origin);
        if let Some(origin) = origins.next()
            && (origin.to_str().ok() != Some(expected_origin) || origins.next().is_some())
        {
            return Error::forbidden("ORIGIN_REJECTED").into_response();
        }
        match bearer(&parts.headers) {
            Ok(t) => Some(t),
            Err(e) => return e.into_response(),
        }
    } else {
        None
    };
    let bytes = match tokio::time::timeout(
        Duration::from_secs(10),
        to_bytes(
            body,
            if path == "/execution/self/observe" {
                MAX_OBJECT_BYTES + 1024
            } else {
                MAX_OBJECT_BYTES
            },
        ),
    )
    .await
    {
        Ok(Ok(b)) => b,
        Ok(Err(_)) => {
            return Error::new(StatusCode::PAYLOAD_TOO_LARGE, "EXECUTION_BODY_TOO_LARGE")
                .into_response();
        }
        Err(_) => {
            return Error::new(StatusCode::REQUEST_TIMEOUT, "EXECUTION_BODY_TIMEOUT")
                .into_response();
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if let Some(a) = access {
            s.host(&a, &path, &bytes)
        } else {
            s.network
                .auth
                .with_valid_session(human_token.as_ref().ok_or_else(Error::bad)?, |p| {
                    s.human(&p, &parts.method, &path, &bytes)
                })
        }
    })
    .await;
    match result {
        Ok(Ok(data)) => Json(json!({"ok":true,"data":data})).into_response(),
        Ok(Err(e)) => e.into_response(),
        Err(_) => Error::unavailable().into_response(),
    }
}
async fn no_store(request: Request, next: Next) -> Response {
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
        admin_store::Resource,
        network_http::tests::{Device, Fixture},
        relay_http::tests::{finish_ready, joined_syncing_controller},
    };
    use axum::{body::Body, http::Request as HttpRequest};
    use myagents_agentnet_execution_core::{
        BotConfig, Method as BotMethod, verify_intent, verify_lease,
    };
    use tower::ServiceExt;
    pub(crate) struct Setup {
        pub(crate) f: Fixture,
        pub(crate) host: Device,
        pub(crate) owner: Device,
        pub(crate) admin: Device,
        pub(crate) other: Device,
        pub(crate) s: ExecutionService,
        pub(crate) grant: Grant,
        pub(crate) context: HostContext,
        pub(crate) bot_id: String,
    }
    impl Setup {
        pub(crate) fn model_relay(&self) -> Arc<RelayController> {
            self.s.relay.clone()
        }
        pub(crate) fn browser_admin_service(&self) -> crate::admin_http::AdminService {
            let mut service = crate::admin_http::AdminService::open(
                self.f.auth.clone(),
                self.f.dir.path(),
                (*self.s.config).clone(),
                "http://127.0.0.1:5199".into(),
                &self.f.network,
            )
            .unwrap();
            service.connect_execution(self.s.ledger());
            service
        }
    }
    async fn setup() -> Setup {
        setup_mode(false).await
    }
    pub(crate) async fn browser_setup() -> Setup {
        setup_mode(true).await
    }
    async fn setup_mode(browser: bool) -> Setup {
        let f = Fixture::new();
        let host = f.device("execution-owner");
        let owner = f.device("execution-owner");
        let admin = f.device(if browser {
            "execution-owner"
        } else {
            "execution-admin"
        });
        let other = f.device("execution-other");
        let (controller, epoch, hello) = joined_syncing_controller(&f, &host).await;
        finish_ready(&controller, &f, &host, &epoch, &hello);
        let config = AdminConfig {
            admin_principal_ids: vec![admin.context.principal_id.clone()],
            hosts: vec![Resource {
                id: host.context.device_id.clone(),
                name: "Test Host".into(),
                owner_ids: vec![host.context.principal_id.clone()],
                runtimes: vec!["builtin".into()],
            }],
            model_refs: if browser {
                vec![Resource {
                    id: Uuid::new_v4().to_string(),
                    name: "合成模型引用（不调用模型）".into(),
                    owner_ids: vec![host.context.principal_id.clone()],
                    runtimes: vec!["builtin".into()],
                }]
            } else {
                vec![]
            },
            max_daily_tokens: 1000,
        };
        let mut s =
            ExecutionService::open(f.service.clone(), controller, f.dir.path(), config).unwrap();
        if browser {
            s.fixture_origin = Some("http://127.0.0.1:5199".into());
        }
        let bot_id = Uuid::new_v4().to_string();
        let body = json!({"id":bot_id,"name":if browser {"合成生命周期 Bot"} else {"finite"},"description":"","owner_id":host.context.principal_id,"host_id":host.context.device_id,"runtime":"builtin","model_ref":s.config.model_refs.first().map(|r|r.id.clone()),"system_prompt":"","daily_tokens":100,"revision":1,"deleted":false,"state":"stopped","configured":false,"expected_revision":0,"mutation_id":bot_id});
        s.registry
            .mutate(
                &admin.context.principal_id,
                "create",
                Uuid::parse_str(&bot_id).unwrap(),
                &body,
                None,
                &s.config,
                std::slice::from_ref(&host.context.principal_id),
            )
            .unwrap();
        let p = f.auth.validate_session(&owner.account_token).unwrap();
        let scope = gate::owner_scope(&f.service, &p, &host.context.device_id).unwrap();
        let grant = Grant {
            id: Uuid::new_v4().to_string(),
            generation: 1,
            scope,
            bot_id: bot_id.clone(),
            root_id: "workspaces".into(),
            relative_path: if browser {
                format!("bots/{bot_id}")
            } else {
                "finite".into()
            },
            operations: vec![
                BotMethod::Create,
                BotMethod::Configure,
                BotMethod::Enable,
                BotMethod::Disable,
                BotMethod::Delete,
                BotMethod::Restore,
            ],
            allowed_runtimes: vec!["builtin".into()],
            allowed_model_refs: s.config.model_refs.iter().map(|r| r.id.clone()).collect(),
            max_daily_tokens: 1000,
            expires_at: gate::now().unwrap() + if browser { 3600 } else { 1000 },
        };
        let context = HostContext {
            challenge_nonce: Uuid::new_v4().to_string(),
            local_auth_generation: 1,
            boot_epoch: hello["bootEpoch"].as_str().unwrap().into(),
            connection_epoch: epoch,
            membership_revision: 1,
        };
        Setup {
            f,
            host,
            owner,
            admin,
            other,
            s,
            grant,
            context,
            bot_id,
        }
    }
    async fn response(
        s: &ExecutionService,
        method: Method,
        path: &str,
        token: &str,
        body: Value,
        proof: Option<String>,
    ) -> (StatusCode, Value, HeaderMap) {
        let mut r = HttpRequest::builder()
            .method(method)
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::HOST, "untrusted.invalid")
            .header("x-forwarded-host", "untrusted.invalid");
        if let Some(p) = proof {
            r = r.header("DPoP", p);
        }
        let request = r
            .body(Body::from(if body.is_null() {
                String::new()
            } else {
                body.to_string()
            }))
            .unwrap();
        let out = s.router().oneshot(request).await.unwrap();
        let status = out.status();
        let headers = out.headers().clone();
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert!(!headers.contains_key("access-control-allow-origin"));
        let bytes = to_bytes(out.into_body(), MAX_OBJECT_BYTES).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            headers,
        )
    }
    async fn human(t: &Setup, token: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let (s, v, _) = response(&t.s, Method::POST, path, token, body, None).await;
        (s, v)
    }
    pub(crate) async fn host(t: &Setup, path: &str, body: Value) -> (StatusCode, Value) {
        let (_, _, h) =
            response(&t.s, Method::POST, path, &t.host.access, body.clone(), None).await;
        let nonce = h["dpop-nonce"].to_str().unwrap();
        let proof = t.f.proof(&t.host, "POST", path, Some(nonce));
        let (s, v, _) = response(&t.s, Method::POST, path, &t.host.access, body, Some(proof)).await;
        (s, v)
    }
    async fn accept(t: &Setup) {
        let (status, v) = human(
            t,
            &t.owner.account_token,
            "/api/bots/grants/accept",
            json!({"grant":t.grant,"expected_generation":0}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{v}");
    }
    fn queue(t: &Setup, id: &str) -> Value {
        json!({"mutation_id":id,"grant_id":t.grant.id,"grant_generation":1,"binding_generation":0,"expected_host_revision":0,"operation":{"method":"create","params":{"name":"finite","description":"","runtime":"builtin","model_ref":null,"system_prompt":"","daily_tokens":100,"resource_expected_revision":0}}})
    }
    #[tokio::test]
    async fn revoked_original_actor_blocks_new_lease_but_current_host_can_reconcile_final_receipt()
    {
        let t = setup().await;
        accept(&t).await;
        let id = Uuid::new_v4().to_string();
        let mut command = queue(&t, &id);
        command["binding_generation"] = json!(1);
        assert_eq!(
            human(
                &t,
                &t.admin.account_token,
                &format!("/api/admin/bots/{}/execution", t.bot_id),
                command
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, pull) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        let hash = pull["data"]["intents"][0]["intent_hash"].as_str().unwrap();
        let lease_body = json!({"intent_hash":hash,"host_context":t.context});
        let (status, lease) = host(&t, "/execution/self/lease", lease_body.clone()).await;
        assert_eq!(status, StatusCode::OK);
        let original = t.s.store.command(&id).unwrap().command;
        t.f.auth.revoke_session(&t.admin.account_token).unwrap();
        assert!(t.f.auth.validate_session(&t.admin.account_token).is_err());
        assert_eq!(
            host(&t, "/execution/self/lease", lease_body).await.0,
            StatusCode::FORBIDDEN
        );
        let mut snapshot = empty_snapshot(&t);
        snapshot.agent_id = Some(Uuid::new_v4().to_string());
        snapshot.binding_generation = 1;
        snapshot.revision = 1;
        let receipt = Receipt {
            mutation_id: original.mutation_id.clone(),
            request_hash: original.request_hash.clone(),
            grant_id: original.grant_id.clone(),
            grant_generation: original.grant_generation,
            bot_id: original.bot_id.clone(),
            agent_id: snapshot.agent_id.clone(),
            binding_generation: 1,
            revision: 1,
            status: myagents_agentnet_execution_core::ReceiptStatus::Persisted,
            code: None,
            snapshot: Some(snapshot),
        };
        let mut current = t.context.clone();
        current.challenge_nonce = Uuid::new_v4().to_string();
        let body = json!({"kind":"command","host_context":current,"lease_id":lease["data"]["lease_id"],"receipt":receipt});
        let (status, ack) = host(&t, "/execution/self/receipt", body.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ack["data"]["status"], "host_confirmed");
        assert_eq!(
            host(&t, "/execution/self/receipt", body).await.0,
            StatusCode::OK
        );
        let saved = t.s.store.command(&id).unwrap();
        assert_eq!(saved.command, original);
        assert_eq!(saved.receipt, Some(receipt));
        assert_eq!(saved.lease_count, 1);
    }
    #[tokio::test]
    async fn observation_requires_live_device_proof_context_and_never_makes_a_receipt() {
        let mut t = setup().await;
        let observation = HostObservation {
            host_revision: 0,
            resource_revision: 0,
            root_ids: vec!["workspaces".into()],
            supported_runtimes: vec![],
            allowed_bot_ids: vec![t.bot_id.clone()],
            allowed_model_refs: vec![],
            max_daily_tokens: 1000,
            policy_expires_at: t.grant.expires_at,
            snapshots: vec![empty_snapshot(&t)],
        };
        let path = "/execution/self/observe";
        let body = json!({"host_context":t.context,"observation":observation});
        assert_eq!(
            human(&t, &t.owner.account_token, path, body.clone())
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, v) = host(&t, path, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        let reports = t.s.store.public_observations().unwrap();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].scope, t.grant.scope);
        assert!(reports[0].seen_at > 0);
        assert!(
            t.s.store
                .known_bot_snapshot(&t.grant.scope, &t.bot_id)
                .unwrap()
                .is_none()
        );
        let mut bad = body.clone();
        bad["seen_at"] = json!(1);
        assert_eq!(host(&t, path, bad).await.0, StatusCode::BAD_REQUEST);
        let mut bad = body.clone();
        bad["host_context"]["connection_epoch"] = json!(Uuid::new_v4().to_string());
        assert_eq!(host(&t, path, bad).await.0, StatusCode::FORBIDDEN);
        t.s = ExecutionService::open(
            t.f.service.clone(),
            Arc::new(RelayController::new(t.f.service.clone()).unwrap()),
            t.f.dir.path(),
            (*t.s.config).clone(),
        )
        .unwrap();
        assert_eq!(host(&t, path, body).await.0, StatusCode::FORBIDDEN); // Durable Ready without runtime WS is insufficient.
        assert_eq!(t.s.store.public_observations().unwrap().len(), 1); // Still only a last report, not current authority.
    }
    fn empty_snapshot(t: &Setup) -> BotSnapshot {
        BotSnapshot {
            bot_id: t.bot_id.clone(),
            agent_id: None,
            binding_generation: 0,
            revision: 0,
            deleted: false,
            admission: Admission::Closed,
            activity: Activity::Stopped,
            configured: false,
            runnable: false,
            unsupported_reason: Some("ADAPTER_NOT_CONNECTED".into()),
            config: BotConfig {
                name: "finite".into(),
                description: String::new(),
                runtime: "builtin".into(),
                model_ref: None,
                system_prompt: String::new(),
                daily_tokens: 100,
            },
            active_run: None,
        }
    }
    #[tokio::test]
    async fn actual_owner_required_even_for_admin_and_closed_inputs() {
        let t = setup().await;
        let body = json!({"grant":t.grant,"expected_generation":0});
        assert_eq!(
            human(
                &t,
                &t.admin.account_token,
                "/api/bots/grants/accept",
                body.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            human(
                &t,
                &t.other.account_token,
                "/api/bots/grants/accept",
                body.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let mut bad = body;
        bad["grant"]["scope"]["host_owner_id"] = json!(t.admin.context.principal_id);
        assert_eq!(
            human(&t, &t.admin.account_token, "/api/bots/grants/accept", bad)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        accept(&t).await;
        let mut q = queue(&t, &Uuid::new_v4().to_string());
        q["actor_session_handle"] = json!(t.admin.context.session_handle);
        assert_eq!(
            human(
                &t,
                &t.admin.account_token,
                &format!("/api/admin/bots/{}/execution", t.bot_id),
                q
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        t.f.auth.revoke_session(&t.owner.account_token).unwrap();
        assert_eq!(
            human(
                &t,
                &t.owner.account_token,
                "/api/bots/grants/accept",
                json!({"grant":t.grant,"expected_generation":0})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn immutable_admin_retry_never_rebinds_original_session() {
        let t = setup().await;
        accept(&t).await;
        let id = Uuid::new_v4().to_string();
        let path = format!("/api/admin/bots/{}/execution", t.bot_id);
        let q = queue(&t, &id);
        assert_eq!(
            human(&t, &t.other.account_token, &path, q.clone()).await.0,
            StatusCode::FORBIDDEN
        );
        let first = human(&t, &t.admin.account_token, &path, q.clone()).await;
        assert_eq!(first.0, StatusCode::OK, "{}", first.1);
        assert!(!first.1.to_string().contains("actor_session_handle"));
        let next = t.f.device("execution-admin");
        let replay = human(&t, &next.account_token, &path, q.clone()).await;
        assert_eq!(replay.0, StatusCode::OK);
        assert_eq!(first.1, replay.1);
        assert_eq!(
            t.s.store.command(&id).unwrap().command.actor_session_handle,
            t.admin.context.session_handle
        );
        let mut changed = q;
        changed["expected_host_revision"] = json!(1);
        assert_eq!(
            human(&t, &next.account_token, &path, changed).await.0,
            StatusCode::CONFLICT
        );
        let read = format!("/api/admin/execution/mutations/{id}");
        assert_eq!(
            response(
                &t.s,
                Method::GET,
                &read,
                &next.account_token,
                Value::Null,
                None
            )
            .await
            .0,
            StatusCode::OK
        );
        t.f.auth.revoke_session(&t.admin.account_token).unwrap();
        let (_, pull) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        assert!(pull["data"]["intents"].as_array().unwrap().is_empty());
    }
    #[tokio::test]
    async fn real_dpop_epoch_actor_gate_and_signed_lease_from_server_ledger() {
        let t = setup().await;
        accept(&t).await;
        let id = Uuid::new_v4().to_string();
        let p = format!("/api/admin/bots/{}/execution", t.bot_id);
        assert_eq!(
            human(&t, &t.admin.account_token, &p, queue(&t, &id))
                .await
                .0,
            StatusCode::OK
        );
        let (status, v) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{v}");
        let record = &v["data"]["intents"][0];
        let intent = verify_intent(
            record["intent_token"].as_str().unwrap(),
            &t.f.service._keys.jwks(),
            &t.grant.scope,
            gate::now().unwrap(),
        )
        .unwrap();
        let hash = record["intent_hash"].as_str().unwrap();
        let req = json!({"intent_hash":hash,"host_context":t.context});
        let (status, l) = host(&t, "/execution/self/lease", req.clone()).await;
        assert_eq!(status, StatusCode::OK, "{l}");
        let token = l["data"]["lease_token"].as_str().unwrap();
        let lease = verify_lease(
            token,
            &t.f.service._keys.jwks(),
            &t.grant.scope,
            gate::now().unwrap(),
            &intent,
            &t.context,
        )
        .unwrap();
        assert!(lease.exp - lease.iat <= 15);
        let (status, again) = host(&t, "/execution/self/lease", req.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(l, again);
        assert_eq!(t.s.store.command(&id).unwrap().lease_count, 1);
        let mut bad = req.clone();
        bad["host_context"]["connection_epoch"] = json!(Uuid::new_v4().to_string());
        assert_eq!(
            host(&t, "/execution/self/lease", bad).await.0,
            StatusCode::FORBIDDEN
        );
        let mut arbitrary = req.clone();
        arbitrary["intent"] = json!(intent);
        assert_eq!(
            host(&t, "/execution/self/lease", arbitrary).await.0,
            StatusCode::BAD_REQUEST
        );
        t.f.auth.revoke_session(&t.admin.account_token).unwrap();
        assert_eq!(
            host(&t, "/execution/self/lease", req).await.0,
            StatusCode::FORBIDDEN
        );
        let missingproof = response(
            &t.s,
            Method::POST,
            "/execution/self/pull",
            &t.host.access,
            json!({"host_context":t.context}),
            None,
        )
        .await;
        assert_eq!(missingproof.0, StatusCode::UNAUTHORIZED);
    }
    #[tokio::test]
    async fn revoke_pending_until_exact_signed_host_closed_binding_ack() {
        let t = setup().await;
        accept(&t).await;
        let revoke = json!({"grant_id":t.grant.id,"expected_generation":1,"mutation_id":Uuid::new_v4().to_string()});
        assert_eq!(
            human(
                &t,
                &t.admin.account_token,
                "/api/bots/grants/revoke",
                revoke.clone()
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (status, v) = human(
            &t,
            &t.owner.account_token,
            "/api/bots/grants/revoke",
            revoke,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["data"]["effective_revoked"], false);
        let (status, pull) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let token = pull["data"]["revocations"][0]["revocation_token"]
            .as_str()
            .unwrap();
        let mut snapshot = empty_snapshot(&t);
        snapshot.activity = Activity::Unknown;
        let bad = json!({"kind":"revocation","host_context":t.context,"revocation_token":token,"snapshot":snapshot});
        assert_eq!(
            host(&t, "/execution/self/receipt", bad).await.0,
            StatusCode::FORBIDDEN
        );
        let mut context = t.context.clone();
        context.challenge_nonce = Uuid::new_v4().to_string();
        let bad = json!({"kind":"revocation","host_context":context,"revocation_token":token,"snapshot":empty_snapshot(&t)});
        assert_eq!(
            host(&t, "/execution/self/receipt", bad).await.0,
            StatusCode::FORBIDDEN
        );
        let good = json!({"kind":"revocation","host_context":t.context,"revocation_token":token,"snapshot":empty_snapshot(&t)});
        let (status, ack) = host(&t, "/execution/self/receipt", good).await;
        assert_eq!(status, StatusCode::OK, "{ack}");
        assert_eq!(ack["data"]["effective_revoked"], true);
        assert_eq!(
            t.s.store.grant(&t.grant.id).unwrap().state,
            GrantState::Revoked
        );
    }
    #[tokio::test]
    async fn unknown_leased_create_blocks_revoke_until_original_receipt_and_exact_binding() {
        let t = setup().await;
        accept(&t).await;
        let id = Uuid::new_v4().to_string();
        let path = format!("/api/admin/bots/{}/execution", t.bot_id);
        assert_eq!(
            human(&t, &t.admin.account_token, &path, queue(&t, &id))
                .await
                .0,
            StatusCode::OK
        );
        let (_, pull) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        let hash = pull["data"]["intents"][0]["intent_hash"].as_str().unwrap();
        let (status, leased) = host(
            &t,
            "/execution/self/lease",
            json!({"intent_hash":hash,"host_context":t.context}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let lease_id = leased["data"]["lease_id"].as_str().unwrap();
        assert_eq!(human(&t,&t.owner.account_token,"/api/bots/grants/revoke",json!({"grant_id":t.grant.id,"expected_generation":1,"mutation_id":Uuid::new_v4().to_string()})).await.0,StatusCode::OK);
        let (_, pull) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        let token = pull["data"]["revocations"][0]["revocation_token"]
            .as_str()
            .unwrap();
        let ack = json!({"kind":"revocation","host_context":t.context,"revocation_token":token,"snapshot":empty_snapshot(&t)});
        let (status, v) = host(&t, "/execution/self/receipt", ack.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(v["code"], "HOST_COMMAND_OUTCOME_UNCONFIRMED");
        let command = t.s.store.command(&id).unwrap().command;
        let mut snapshot = empty_snapshot(&t);
        snapshot.agent_id = Some("host-fixture-agent".into());
        snapshot.binding_generation = 1;
        snapshot.revision = 1;
        let receipt = Receipt {
            mutation_id: id,
            request_hash: command.request_hash,
            grant_id: t.grant.id.clone(),
            grant_generation: 1,
            bot_id: t.bot_id.clone(),
            agent_id: snapshot.agent_id.clone(),
            binding_generation: 1,
            revision: 1,
            status: myagents_agentnet_execution_core::ReceiptStatus::Persisted,
            code: None,
            snapshot: Some(snapshot.clone()),
        };
        let report = json!({"kind":"command","host_context":t.context,"lease_id":lease_id,"receipt":receipt});
        let mut wrong = report.clone();
        wrong["receipt"]["request_hash"] = json!("0".repeat(64));
        assert_eq!(
            host(&t, "/execution/self/receipt", wrong).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            host(&t, "/execution/self/receipt", report).await.0,
            StatusCode::OK
        );
        let (status, v) = host(&t, "/execution/self/receipt", ack).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(v["code"], "HOST_BINDING_MISMATCH");
        let ack = json!({"kind":"revocation","host_context":t.context,"revocation_token":token,"snapshot":snapshot});
        let (status, v) = host(&t, "/execution/self/receipt", ack).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        assert_eq!(v["data"]["effective_revoked"], true);
    }
    #[tokio::test]
    async fn new_controller_cannot_reuse_old_durable_ready_epoch() {
        let t = setup().await;
        accept(&t).await;
        let id = Uuid::new_v4().to_string();
        let path = format!("/api/admin/bots/{}/execution", t.bot_id);
        assert_eq!(
            human(&t, &t.admin.account_token, &path, queue(&t, &id))
                .await
                .0,
            StatusCode::OK
        );
        let (_, pull) = host(
            &t,
            "/execution/self/pull",
            json!({"host_context":t.context}),
        )
        .await;
        let hash = pull["data"]["intents"][0]["intent_hash"].as_str().unwrap();
        let restarted = ExecutionService::open(
            t.f.service.clone(),
            Arc::new(RelayController::new(t.f.service.clone()).unwrap()),
            t.f.dir.path(),
            (*t.s.config).clone(),
        )
        .unwrap();
        let body = json!({"intent_hash":hash,"host_context":t.context});
        let (_, _, headers) = response(
            &restarted,
            Method::POST,
            "/execution/self/lease",
            &t.host.access,
            body.clone(),
            None,
        )
        .await;
        let proof = t.f.proof(
            &t.host,
            "POST",
            "/execution/self/lease",
            Some(headers["dpop-nonce"].to_str().unwrap()),
        );
        assert_eq!(
            response(
                &restarted,
                Method::POST,
                "/execution/self/lease",
                &t.host.access,
                body,
                Some(proof)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(restarted.store.command(&id).unwrap().lease_count, 0);
    }
    #[tokio::test]
    async fn repeated_poll_reuses_original_intent_hash_without_capacity_growth() {
        let t = setup().await;
        accept(&t).await;
        let id = Uuid::new_v4().to_string();
        let path = format!("/api/admin/bots/{}/execution", t.bot_id);
        assert_eq!(
            human(&t, &t.admin.account_token, &path, queue(&t, &id))
                .await
                .0,
            StatusCode::OK
        );
        let mut expected = None;
        for _ in 0..80 {
            let (status, pull) = host(
                &t,
                "/execution/self/pull",
                json!({"host_context":t.context}),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{pull}");
            assert!(serde_json::to_vec(&pull).unwrap().len() <= MAX_PULL_BYTES);
            let hash = pull["data"]["intents"][0]["intent_hash"]
                .as_str()
                .unwrap()
                .to_owned();
            if let Some(old) = &expected {
                assert_eq!(old, &hash);
            } else {
                expected = Some(hash);
            }
        }
        let db = rusqlite::Connection::open(t.f.dir.path().join("execution.sqlite3")).unwrap();
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM issued_intents", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
