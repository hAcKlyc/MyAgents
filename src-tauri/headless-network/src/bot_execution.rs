//! Finite outbound execution worker. It requires an operator-protected policy
//! and a live connector fence; no HTTP value can enable this owner.
use crate::{
    agent_network::{
        account::NetworkAccountSession,
        identity::NetworkIdentity,
        policy::LocalPolicy,
        transport::{ExecutionRoute, NetworkTransport},
        NetworkError,
    },
    bot_execution_ipc::{BotExecutionIpc, ContextBase, RequestPayload, ResponsePayload},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use myagents_agent_network_protocol::{ConnectionScope, DeviceScope};
use myagents_agentnet_execution_core::{
    verify_grant, verify_intent, verify_lease, verify_revocation, Activity, Admission, BotSnapshot,
    ExecutionScope, Grant, HostContext, HostObservation, Method, Receipt, RevocationClaims,
    MAX_JWT_BYTES, MAX_SAFE_INTEGER,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
fn err(code: &'static str) -> NetworkError {
    NetworkError::new(code)
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s)
}
fn code(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn unique(v: &[String], allow_empty: bool) -> bool {
    (allow_empty || !v.is_empty())
        && v.len() <= 64
        && v.iter().collect::<BTreeSet<_>>().len() == v.len()
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FinitePolicy {
    pub scope: ExecutionScope,
    pub account_binding: String,
    pub allowed_bot_ids: Vec<String>,
    pub root_ids: Vec<String>,
    pub operations: Vec<Method>,
    pub runtimes: Vec<String>,
    pub model_refs: Vec<String>,
    pub max_daily_tokens: u64,
    pub expires_at: u64,
}
impl FinitePolicy {
    fn permits_receipt(&self, r: &Receipt) -> Result<(), NetworkError> {
        self.validate_integrity()?;
        r.validate()
            .map_err(|_| err("BOT_EXECUTION_RECEIPT_MISMATCH"))?;
        if !self.allowed_bot_ids.contains(&r.bot_id)
            || r.status == myagents_agentnet_execution_core::ReceiptStatus::Unconfirmed
            || (r.status == myagents_agentnet_execution_core::ReceiptStatus::Persisted
                && r.snapshot.is_none())
        {
            return Err(err("BOT_EXECUTION_RECEIPT_MISMATCH"));
        }
        Ok(())
    }
    fn permits_observation(&self, o: &HostObservation, now: u64) -> Result<(), NetworkError> {
        self.validate(now)?;
        o.validate()
            .map_err(|_| err("BOT_EXECUTION_OBSERVATION_INVALID"))?;
        if o.root_ids.iter().any(|s| !self.root_ids.contains(s))
            || o.supported_runtimes
                .iter()
                .any(|s| !self.runtimes.contains(s))
            || o.allowed_bot_ids
                .iter()
                .any(|s| !self.allowed_bot_ids.contains(s))
            || o.allowed_model_refs
                .iter()
                .any(|s| !self.model_refs.contains(s))
            || o.max_daily_tokens > self.max_daily_tokens
            || o.policy_expires_at > self.expires_at
            || o.policy_expires_at <= now
            || o.snapshots.iter().any(|s| {
                !self.allowed_bot_ids.contains(&s.bot_id)
                    || !self.runtimes.contains(&s.config.runtime)
                    || s.config
                        .model_ref
                        .as_ref()
                        .is_some_and(|m| !self.model_refs.contains(m))
                    || s.config.daily_tokens > self.max_daily_tokens
            })
        {
            return Err(err("BOT_EXECUTION_LOCAL_POLICY_REJECTED"));
        }
        Ok(())
    }
    fn validate(&self, now: u64) -> Result<(), NetworkError> {
        self.validate_integrity()?;
        if self.expires_at <= now {
            return Err(err("BOT_EXECUTION_POLICY_EXPIRED"));
        }
        Ok(())
    }
    fn validate_integrity(&self) -> Result<(), NetworkError> {
        self.scope
            .validate()
            .map_err(|_| err("BOT_EXECUTION_POLICY_INVALID"))?;
        if !uuid(&self.account_binding)
            || !unique(&self.allowed_bot_ids, false)
            || !self.allowed_bot_ids.iter().all(|s| uuid(s))
            || !unique(&self.root_ids, false)
            || !self.root_ids.iter().all(|s| code(s, 64))
            || !unique(&self.runtimes, false)
            || !self.runtimes.iter().all(|s| code(s, 64))
            || !unique(&self.model_refs, true)
            || !self.model_refs.iter().all(|s| uuid(s))
            || self.operations.is_empty()
            || self.operations.len() > 6
            || self.operations.iter().collect::<BTreeSet<_>>().len() != self.operations.len()
            || self.max_daily_tokens == 0
            || self.max_daily_tokens > MAX_SAFE_INTEGER
            || self.expires_at == 0
            || self.expires_at > MAX_SAFE_INTEGER
        {
            return Err(err("BOT_EXECUTION_POLICY_INVALID"));
        }
        Ok(())
    }
    fn permits(&self, g: &Grant, now: u64) -> Result<(), NetworkError> {
        self.validate(now)?;
        g.validate()
            .map_err(|_| err("BOT_EXECUTION_GRANT_INVALID"))?;
        if g.scope != self.scope
            || !self.allowed_bot_ids.contains(&g.bot_id)
            || !self.root_ids.contains(&g.root_id)
            || g.operations.iter().any(|m| !self.operations.contains(m))
            || g.allowed_runtimes
                .iter()
                .any(|r| !self.runtimes.contains(r))
            || g.allowed_model_refs
                .iter()
                .any(|r| !self.model_refs.contains(r))
            || g.max_daily_tokens > self.max_daily_tokens
            || g.expires_at > self.expires_at
            || g.expires_at <= now
        {
            return Err(err("BOT_EXECUTION_LOCAL_POLICY_REJECTED"));
        }
        Ok(())
    }
    pub(crate) fn load(path: &Path) -> Result<PolicyGuard, NetworkError> {
        let (bytes, dev, ino) = policy_file(path)?;
        let policy: FinitePolicy =
            serde_json::from_slice(&bytes).map_err(|_| err("BOT_EXECUTION_POLICY_INVALID"))?;
        policy.validate_integrity()?;
        Ok(PolicyGuard {
            policy,
            path: path.into(),
            dev,
            ino,
            hash: Sha256::digest(&bytes).into(),
        })
    }
}
pub(crate) struct PolicyGuard {
    policy: FinitePolicy,
    path: PathBuf,
    dev: u64,
    ino: u64,
    hash: [u8; 32],
}
impl PolicyGuard {
    pub(crate) fn policy(&self) -> &FinitePolicy {
        &self.policy
    }
    fn verify_integrity(&self) -> Result<(), NetworkError> {
        let (bytes, dev, ino) = policy_file(&self.path)?;
        if (dev, ino) != (self.dev, self.ino)
            || <[u8; 32]>::from(Sha256::digest(&bytes)) != self.hash
        {
            return Err(err("BOT_EXECUTION_POLICY_CHANGED"));
        }
        self.policy.validate_integrity()
    }
}
fn policy_file(path: &Path) -> Result<(Vec<u8>, u64, u64), NetworkError> {
    let reject = || err("BOT_EXECUTION_POLICY_PATH_INVALID");
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(reject());
    }
    let parent = path.parent().ok_or_else(reject)?;
    if parent.canonicalize().map_err(|_| reject())? != parent {
        return Err(reject());
    }
    let uid = unsafe { libc::geteuid() };
    if uid == 0 {
        return Err(reject());
    }
    let mut p = PathBuf::from("/");
    for c in parent.components().skip(1) {
        p.push(c);
        let m = fs::symlink_metadata(&p).map_err(|_| reject())?;
        if !m.is_dir()
            || m.file_type().is_symlink()
            || m.mode() & 0o022 != 0
            || (m.uid() != 0 && m.uid() != uid)
        {
            return Err(reject());
        }
    }
    let m = fs::symlink_metadata(path).map_err(|_| reject())?;
    if !m.is_file()
        || m.file_type().is_symlink()
        || m.nlink() != 1
        || m.uid() != uid
        || m.mode() & 0o777 != 0o600
        || m.len() > 64 * 1024
    {
        return Err(reject());
    }
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| reject())?;
    let opened = f.metadata().map_err(|_| reject())?;
    if opened.dev() != m.dev() || opened.ino() != m.ino() {
        return Err(reject());
    }
    let mut bytes = Vec::new();
    f.by_ref()
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| reject())?;
    let after = fs::symlink_metadata(path).map_err(|_| reject())?;
    if bytes.len() > 64 * 1024
        || after.dev() != m.dev()
        || after.ino() != m.ino()
        || after.mode() & 0o777 != 0o600
        || after.nlink() != 1
    {
        return Err(reject());
    }
    Ok((bytes, m.dev(), m.ino()))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantToken {
    grant_token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IntentToken {
    intent_token: String,
    intent_hash: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevocationToken {
    revocation_token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PullResponse {
    grants: Vec<GrantToken>,
    intents: Vec<IntentToken>,
    revocations: Vec<RevocationToken>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LeaseResponse {
    lease_token: String,
    lease_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandAck {
    mutation_id: String,
    request_hash: String,
    bot_id: String,
    status: String,
    receipt: Option<Receipt>,
    lease_count: u64,
}
impl CommandAck {
    fn confirms(&self, r: &Receipt) -> bool {
        self.mutation_id == r.mutation_id
            && self.request_hash == r.request_hash
            && self.bot_id == r.bot_id
            && self.lease_count > 0
            && self.lease_count <= MAX_SAFE_INTEGER
            && if r.status == myagents_agentnet_execution_core::ReceiptStatus::Unconfirmed {
                self.status == "unconfirmed" && self.receipt.is_none()
            } else {
                self.status == "host_confirmed" && self.receipt.as_ref() == Some(r)
            }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevocationAck {
    grant_id: String,
    generation: u64,
    state: String,
    effective_revoked: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObserveAck {
    observed: bool,
    seen_at: u64,
}
#[derive(Serialize)]
struct ObserveRequest<'a> {
    host_context: &'a HostContext,
    observation: &'a HostObservation,
}
#[derive(Serialize)]
struct ContextRequest<'a> {
    host_context: &'a HostContext,
}
#[derive(Serialize)]
struct LeaseRequest<'a> {
    intent_hash: &'a str,
    host_context: &'a HostContext,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ReceiptRequest<'a> {
    Command {
        host_context: &'a HostContext,
        lease_id: &'a str,
        receipt: &'a Receipt,
    },
    Revocation {
        host_context: &'a HostContext,
        revocation_token: &'a str,
        snapshot: &'a BotSnapshot,
    },
}
#[derive(Default)]
pub(crate) struct PollResult {
    pub acknowledged_commands: usize,
    pub acknowledged_revocations: usize,
}
pub(crate) struct BotExecution {
    ipc: Arc<BotExecutionIpc>,
    policy: PolicyGuard,
    serial: Mutex<()>,
    nonces: Mutex<BTreeMap<String, u64>>,
}
impl BotExecution {
    pub(crate) fn new(
        ipc: Arc<BotExecutionIpc>,
        policy: PolicyGuard,
    ) -> Result<Self, NetworkError> {
        policy.verify_integrity()?;
        Ok(Self {
            ipc,
            policy,
            serial: Mutex::new(()),
            nonces: Mutex::new(BTreeMap::new()),
        })
    }
    pub(crate) fn cancel_pending(&self) {
        self.ipc.cancel_pending();
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn poll_once(
        &self,
        identity: &NetworkIdentity,
        transport: &NetworkTransport,
        connection: &ConnectionScope,
        local: &DeviceScope,
        policy: &LocalPolicy,
        local_auth_generation: u64,
        connection_live: &AtomicBool,
    ) -> Result<PollResult, NetworkError> {
        let _serial = self
            .serial
            .try_lock()
            .map_err(|_| err("BOT_EXECUTION_BUSY"))?;
        if !transport.execution_origin_matches(&self.policy.policy().scope.issuer) {
            return Err(err("BOT_EXECUTION_IDENTITY_REJECTED"));
        }
        let live = || {
            self.live(
                identity,
                connection,
                local,
                policy,
                local_auth_generation,
                connection_live,
            )
        };
        let (scope, base, jwks) = live()?;
        let ctx = self.challenge(&scope, &base).await?;
        live()?;
        let mut result = PollResult::default();
        let ResponsePayload::PendingReceipts { receipts } =
            self.ipc.request(RequestPayload::PendingReceipts {}).await?
        else {
            return Err(err("BOT_EXECUTION_IPC_RESPONSE_INVALID"));
        };
        live()?;
        for pending in receipts {
            live()?;
            if !pending.validate() {
                return Err(err("BOT_EXECUTION_RECEIPT_MISMATCH"));
            }
            self.policy.policy.permits_receipt(&pending.receipt)?;
            let (ack, _hold) = transport
                .execution_json::<CommandAck>(
                    ExecutionRoute::Receipt,
                    &identity.token,
                    &ReceiptRequest::Command {
                        host_context: &ctx,
                        lease_id: &pending.lease_id,
                        receipt: &pending.receipt,
                    },
                )
                .await?;
            live()?;
            if !ack.confirms(&pending.receipt) {
                return Err(err("BOT_EXECUTION_RECEIPT_UNCONFIRMED"));
            }
            self.ack_receipt(&pending.lease_id, &pending.receipt)
                .await?;
            live()?;
            result.acknowledged_commands += 1;
        }
        // Expiry permits only reconciliation of durable final receipts under
        // the unchanged protected file and actual current Host identity.
        if self.policy.policy.expires_at <= jsonwebtoken::get_current_timestamp() {
            return Ok(result);
        }
        let active = || {
            self.policy
                .policy
                .validate(jsonwebtoken::get_current_timestamp())?;
            live()
        };
        active()?;
        let ResponsePayload::Status { observation } =
            self.ipc.request(RequestPayload::Status {}).await?
        else {
            return Err(err("BOT_EXECUTION_IPC_RESPONSE_INVALID"));
        };
        active()?;
        self.policy
            .policy
            .permits_observation(&observation, jsonwebtoken::get_current_timestamp())?;
        let (ack, _observe_hold) = transport
            .execution_json::<ObserveAck>(
                ExecutionRoute::Observe,
                &identity.token,
                &ObserveRequest {
                    host_context: &ctx,
                    observation: &observation,
                },
            )
            .await?;
        active()?;
        if !ack.observed || ack.seen_at == 0 || ack.seen_at > MAX_SAFE_INTEGER {
            return Err(err("BOT_EXECUTION_OBSERVATION_UNCONFIRMED"));
        }
        let (pull, _allocation) = transport
            .execution_json::<PullResponse>(
                ExecutionRoute::Pull,
                &identity.token,
                &ContextRequest { host_context: &ctx },
            )
            .await?;
        active()?;
        if pull.grants.len() > 8 || pull.intents.len() > 8 || pull.revocations.len() > 8 {
            return Err(err("BOT_EXECUTION_RESPONSE_INVALID"));
        }
        // Closing grants precedes new work; short cancellation proofs must not
        // wait behind all grant materialization or model operations.
        for token in pull.revocations {
            active()?;
            let peek: RevocationClaims = peek(&token.revocation_token)?;
            let proof = verify_revocation(
                &token.revocation_token,
                &jwks,
                &scope,
                jsonwebtoken::get_current_timestamp(),
                &ctx,
                &peek.grant_id,
                &peek.bot_id,
                peek.revoked_generation,
            )
            .map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))?;
            if !self.policy.policy.allowed_bot_ids.contains(&proof.bot_id) {
                return Err(err("BOT_EXECUTION_LOCAL_POLICY_REJECTED"));
            }
            let response = self
                .ipc
                .request(RequestPayload::Revoke {
                    revocation_token: token.revocation_token.clone(),
                    grant_id: proof.grant_id.clone(),
                    bot_id: proof.bot_id.clone(),
                    revoked_generation: proof.revoked_generation,
                })
                .await?;
            active()?;
            let ResponsePayload::Snapshot { snapshot } = response else {
                return Err(err("BOT_EXECUTION_IPC_RESPONSE_INVALID"));
            };
            if snapshot.bot_id != proof.bot_id
                || snapshot.admission != Admission::Closed
                || !matches!(snapshot.activity, Activity::Idle | Activity::Stopped)
                || snapshot.active_run.is_some()
            {
                return Err(err("BOT_EXECUTION_REVOCATION_UNCONFIRMED"));
            }
            let (ack, _hold) = transport
                .execution_json::<RevocationAck>(
                    ExecutionRoute::Receipt,
                    &identity.token,
                    &ReceiptRequest::Revocation {
                        host_context: &ctx,
                        revocation_token: &token.revocation_token,
                        snapshot: &snapshot,
                    },
                )
                .await?;
            active()?;
            if ack.grant_id != proof.grant_id
                || ack.generation != proof.revoked_generation
                || ack.state != "revoked"
                || !ack.effective_revoked
            {
                return Err(err("BOT_EXECUTION_REVOCATION_UNCONFIRMED"));
            }
            result.acknowledged_revocations += 1;
        }
        for token in pull.grants {
            active()?;
            let proof = verify_grant(
                &token.grant_token,
                &jwks,
                &scope,
                jsonwebtoken::get_current_timestamp(),
            )
            .map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))?;
            self.policy
                .policy
                .permits(&proof.grant, jsonwebtoken::get_current_timestamp())?;
            let response = self
                .ipc
                .request(RequestPayload::Grant {
                    token: token.grant_token,
                })
                .await?;
            active()?;
            if !matches!(response,ResponsePayload::Grant{grant_id,generation}if grant_id==proof.grant.id&&generation==proof.grant.generation)
            {
                return Err(err("BOT_EXECUTION_GRANT_UNCONFIRMED"));
            }
        }
        for token in pull.intents {
            active()?;
            let intent = verify_intent(
                &token.intent_token,
                &jwks,
                &scope,
                jsonwebtoken::get_current_timestamp(),
            )
            .map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))?;
            self.policy
                .policy
                .permits(&intent.grant, jsonwebtoken::get_current_timestamp())?;
            if myagents_agentnet_execution_core::intent_hash(&intent)
                .map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))?
                != token.intent_hash
            {
                return Err(err("BOT_EXECUTION_PROOF_REJECTED"));
            }
            let challenge = self.challenge(&scope, &base).await?;
            active()?;
            let (leased, _hold) = transport
                .execution_json::<LeaseResponse>(
                    ExecutionRoute::Lease,
                    &identity.token,
                    &LeaseRequest {
                        intent_hash: &token.intent_hash,
                        host_context: &challenge,
                    },
                )
                .await?;
            active()?;
            let lease = verify_lease(
                &leased.lease_token,
                &jwks,
                &scope,
                jsonwebtoken::get_current_timestamp(),
                &intent,
                &challenge,
            )
            .map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))?;
            if lease.lease_id != leased.lease_id {
                return Err(err("BOT_EXECUTION_PROOF_REJECTED"));
            }
            let response = self
                .ipc
                .request(RequestPayload::Execute {
                    intent_token: token.intent_token,
                    lease_token: leased.lease_token,
                })
                .await?;
            active()?;
            let ResponsePayload::Receipt { receipt } = response else {
                return Err(err("BOT_EXECUTION_IPC_RESPONSE_INVALID"));
            };
            receipt
                .matches_command(&intent.command)
                .map_err(|_| err("BOT_EXECUTION_RECEIPT_MISMATCH"))?;
            let (ack, _hold) = transport
                .execution_json::<CommandAck>(
                    ExecutionRoute::Receipt,
                    &identity.token,
                    &ReceiptRequest::Command {
                        host_context: &challenge,
                        lease_id: &lease.lease_id,
                        receipt: &receipt,
                    },
                )
                .await?;
            active()?;
            if !ack.confirms(&receipt) {
                return Err(err("BOT_EXECUTION_RECEIPT_UNCONFIRMED"));
            }
            if receipt.status != myagents_agentnet_execution_core::ReceiptStatus::Unconfirmed {
                self.ack_receipt(&lease.lease_id, &receipt).await?;
                active()?;
            }
            result.acknowledged_commands += 1;
        }
        Ok(result)
    }
    async fn ack_receipt(&self, lease_id: &str, receipt: &Receipt) -> Result<(), NetworkError> {
        let response = self
            .ipc
            .request(RequestPayload::AckReceipt {
                lease_id: lease_id.into(),
                mutation_id: receipt.mutation_id.clone(),
                request_hash: receipt.request_hash.clone(),
            })
            .await?;
        if matches!(response,ResponsePayload::ReceiptAck {lease_id:received} if received==lease_id)
        {
            Ok(())
        } else {
            Err(err("BOT_EXECUTION_RECEIPT_UNCONFIRMED"))
        }
    }
    fn live(
        &self,
        identity: &NetworkIdentity,
        connection: &ConnectionScope,
        local: &DeviceScope,
        policy: &LocalPolicy,
        generation: u64,
        live: &AtomicBool,
    ) -> Result<(ExecutionScope, ContextBase, serde_json::Value), NetworkError> {
        if !live.load(Ordering::Acquire) {
            return Err(err("BOT_EXECUTION_CONNECTION_CLOSED"));
        }
        self.policy.verify_integrity()?;
        identity.account.ensure_current()?;
        let NetworkAccountSession::Owned(owned) = &identity.account else {
            return Err(err("BOT_EXECUTION_OWNED_ACCOUNT_REQUIRED"));
        };
        let peer = identity
            .peer
            .as_ref()
            .ok_or_else(|| err("BOT_EXECUTION_PEER_IDENTITY_REQUIRED"))?;
        let now = jsonwebtoken::get_current_timestamp();
        if identity.access.iss != identity.scope.issuer
            || identity.access.aud != local.service_id
            || identity.access.sub != local.principal_id
            || identity.access.device_id != local.device_id
            || identity.access.key_generation != local.key_generation
            || owned.descriptor.service_id != local.service_id
            || owned.descriptor.environment != local.environment
            || owned.descriptor.network_id != local.network_id
            || identity.access.exp <= now
            || peer.binding.expires_at <= now
            || owned.session.expires_at <= now
            || owned.connection_id != self.policy.policy.account_binding
            || !policy.joined
            || policy.membership_revision == 0
            || identity.scope.issuer != owned.descriptor.issuer
            || local.service_id != identity.scope.service_id
            || local.environment != identity.scope.environment
            || local.principal_id != identity.scope.principal_id
            || local.device_id != identity.scope.device_id
            || local.key_generation != identity.scope.key_generation
            || connection.service_id != local.service_id
            || connection.network_id != local.network_id
            || owned.session.network_id != local.network_id
            || owned.session.principal_id != local.principal_id
            || peer.binding.service_id != local.service_id
            || peer.binding.environment != local.environment
            || peer.binding.principal_id != local.principal_id
            || peer.binding.device_id != local.device_id
            || peer.binding.key_generation != local.key_generation
        {
            return Err(err("BOT_EXECUTION_IDENTITY_REJECTED"));
        }
        let scope = ExecutionScope {
            issuer: identity.scope.issuer.clone(),
            service_id: local.service_id.clone(),
            environment: local.environment.clone(),
            network_id: local.network_id.clone(),
            host_owner_id: local.principal_id.clone(),
            host_device_id: local.device_id.clone(),
            host_key_generation: local.key_generation,
            identity_binding_id: peer.binding.identity_binding_id.clone(),
        };
        if scope != self.policy.policy.scope {
            return Err(err("BOT_EXECUTION_LOCAL_POLICY_REJECTED"));
        }
        let base = ContextBase {
            local_auth_generation: generation,
            boot_epoch: connection.boot_epoch.clone(),
            connection_epoch: connection.connection_epoch.clone(),
            membership_revision: policy.membership_revision,
        };
        base.validate()?;
        scope
            .validate()
            .map_err(|_| err("BOT_EXECUTION_IDENTITY_REJECTED"))?;
        Ok((scope, base, owned.descriptor.jwks.clone()))
    }
    async fn challenge(
        &self,
        scope: &ExecutionScope,
        base: &ContextBase,
    ) -> Result<HostContext, NetworkError> {
        let reply = self
            .ipc
            .request(RequestPayload::Context {
                scope: scope.clone(),
                host_context: base.clone(),
            })
            .await?;
        let ResponsePayload::Challenge { host_context } = reply else {
            return Err(err("BOT_EXECUTION_CHALLENGE_INVALID"));
        };
        host_context
            .validate()
            .map_err(|_| err("BOT_EXECUTION_CHALLENGE_INVALID"))?;
        if !base.matches(&host_context) {
            return Err(err("BOT_EXECUTION_CHALLENGE_INVALID"));
        }
        let now = jsonwebtoken::get_current_timestamp();
        let mut known = self.nonces.lock().await;
        known.retain(|_, deadline| *deadline > now);
        if known.contains_key(&host_context.challenge_nonce) || known.len() >= 1024 {
            return Err(err("BOT_EXECUTION_CHALLENGE_REPLAY"));
        }
        known.insert(host_context.challenge_nonce.clone(), now + 60);
        Ok(host_context)
    }
}
fn peek<T: serde::de::DeserializeOwned>(token: &str) -> Result<T, NetworkError> {
    if token.len() > MAX_JWT_BYTES {
        return Err(err("BOT_EXECUTION_PROOF_REJECTED"));
    }
    let mut parts = token.split('.');
    let _header = parts.next();
    let body = parts
        .next()
        .ok_or_else(|| err("BOT_EXECUTION_PROOF_REJECTED"))?;
    if parts.next().is_none() || parts.next().is_some() {
        return Err(err("BOT_EXECUTION_PROOF_REJECTED"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))?;
    serde_json::from_slice(&bytes).map_err(|_| err("BOT_EXECUTION_PROOF_REJECTED"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!(
            "../../../services/agentnet/execution-core/fixtures/wire-v1.json"
        ))
        .unwrap()
    }
    fn policy() -> FinitePolicy {
        let f = fixture();
        FinitePolicy {
            scope: serde_json::from_value(f["scope"].clone()).unwrap(),
            account_binding: uuid::Uuid::new_v4().to_string(),
            allowed_bot_ids: vec![f["grant"]["bot_id"].as_str().unwrap().into()],
            root_ids: vec!["workspaces".into()],
            operations: vec![
                Method::Create,
                Method::Configure,
                Method::Enable,
                Method::Disable,
                Method::Delete,
                Method::Restore,
            ],
            runtimes: vec!["builtin".into()],
            model_refs: vec![f["grant"]["allowed_model_refs"][0].as_str().unwrap().into()],
            max_daily_tokens: 1000,
            expires_at: 1_800_001_000,
        }
    }
    #[test]
    fn reported_capabilities_must_stay_inside_operator_policy() {
        let p = policy();
        let o: HostObservation = serde_json::from_value(fixture()["observation"].clone()).unwrap();
        p.permits_observation(&o, 1_800_000_001).unwrap();
        for mutate in [
            |o: &mut HostObservation| o.root_ids = vec!["private".into()],
            |o: &mut HostObservation| o.supported_runtimes = vec!["unverified".into()],
            |o: &mut HostObservation| o.allowed_bot_ids.push(uuid::Uuid::new_v4().to_string()),
            |o: &mut HostObservation| o.allowed_model_refs.push(uuid::Uuid::new_v4().to_string()),
            |o: &mut HostObservation| o.max_daily_tokens = 1001,
            |o: &mut HostObservation| o.policy_expires_at = 1_800_001_001,
            |o: &mut HostObservation| o.snapshots[0].config.daily_tokens = 1001,
        ] {
            let mut bad = o.clone();
            mutate(&mut bad);
            assert!(p.permits_observation(&bad, 1_800_000_001).is_err());
        }
        // Empty verified adapters remain empty; reporting does not authorize one.
        assert!(o.supported_runtimes.is_empty());
    }
    #[test]
    fn operator_policy_limits_bot_root_runtime_model_and_budget() {
        let p = policy();
        let g: Grant = serde_json::from_value(fixture()["grant"].clone()).unwrap();
        p.permits(&g, 1_800_000_001).unwrap();
        for mutate in [
            |g: &mut Grant| g.bot_id = uuid::Uuid::new_v4().to_string(),
            |g: &mut Grant| g.root_id = "private".into(),
            |g: &mut Grant| g.allowed_runtimes = vec!["other".into()],
            |g: &mut Grant| g.max_daily_tokens = 1001,
            |g: &mut Grant| g.generation = MAX_SAFE_INTEGER + 1,
        ] {
            let mut bad = g.clone();
            mutate(&mut bad);
            assert!(p.permits(&bad, 1_800_000_001).is_err());
        }
        assert!(p.permits(&g, p.expires_at).is_err());
    }
    #[test]
    fn expired_unchanged_policy_allows_only_final_receipt_reconciliation() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        let dir = tempfile::Builder::new()
            .prefix("finite-expired-")
            .tempdir_in(home)
            .unwrap();
        let p = policy();
        let now = jsonwebtoken::get_current_timestamp();
        let mut value = serde_json::json!({"scope":p.scope,"account_binding":p.account_binding,"allowed_bot_ids":p.allowed_bot_ids,"root_ids":p.root_ids,"operations":p.operations,"runtimes":p.runtimes,"model_refs":p.model_refs,"max_daily_tokens":p.max_daily_tokens,"expires_at":now-1});
        let file = dir.path().join("policy.json");
        fs::write(&file, value.to_string()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let guard = FinitePolicy::load(&file).unwrap();
        guard.verify_integrity().unwrap();
        let receipt: Receipt = serde_json::from_value(fixture()["receipt"].clone()).unwrap();
        guard.policy.permits_receipt(&receipt).unwrap();
        let grant: Grant = serde_json::from_value(fixture()["grant"].clone()).unwrap();
        assert!(guard.policy.permits(&grant, now).is_err());
        let o: HostObservation = serde_json::from_value(fixture()["observation"].clone()).unwrap();
        assert!(guard.policy.permits_observation(&o, now).is_err());
        let mut unknown = receipt.clone();
        unknown.status = myagents_agentnet_execution_core::ReceiptStatus::Unconfirmed;
        unknown.snapshot = None;
        assert!(guard.policy.permits_receipt(&unknown).is_err());
        let mut foreign = receipt;
        foreign.bot_id = uuid::Uuid::new_v4().to_string();
        foreign.snapshot = None;
        assert!(guard.policy.permits_receipt(&foreign).is_err());
        value["account_binding"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
        fs::write(&file, value.to_string()).unwrap();
        assert!(guard.verify_integrity().is_err());
    }
    #[test]
    fn protected_policy_rejects_replacement_symlink_mode_and_unknown_field() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap())
            .canonicalize()
            .unwrap();
        let dir = tempfile::Builder::new()
            .prefix("finite-policy-")
            .tempdir_in(home)
            .unwrap();
        let p = policy();
        let mut value = serde_json::json!({"scope":p.scope,"account_binding":p.account_binding,"allowed_bot_ids":p.allowed_bot_ids,"root_ids":p.root_ids,"operations":p.operations,"runtimes":p.runtimes,"model_refs":p.model_refs,"max_daily_tokens":p.max_daily_tokens,"expires_at":p.expires_at});
        value["expires_at"] = serde_json::json!(jsonwebtoken::get_current_timestamp() + 1000);
        let file = dir.path().join("policy.json");
        fs::write(&file, value.to_string()).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let guard = FinitePolicy::load(&file).unwrap();
        guard.verify_integrity().unwrap();
        value["remote_enabled"] = serde_json::json!(true);
        fs::write(&file, value.to_string()).unwrap();
        assert!(guard.verify_integrity().is_err());
        assert!(FinitePolicy::load(&file).is_err());
        let link = dir.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(FinitePolicy::load(&link).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(policy_file(&file).is_err());
    }
    #[test]
    fn revocation_target_peek_never_substitutes_for_signature_or_scope() {
        let f = fixture();
        let signed: serde_json::Value = serde_json::from_str(include_str!(
            "../../../services/agentnet/execution-core/fixtures/signed-v1.json"
        ))
        .unwrap();
        let token = signed["tokens"]["revocation"].as_str().unwrap();
        let proof: RevocationClaims = peek(token).unwrap();
        let scope = policy().scope;
        verify_revocation(
            token,
            &signed["jwks"],
            &scope,
            f["now"].as_u64().unwrap(),
            &proof.host_context,
            &proof.grant_id,
            &proof.bot_id,
            proof.revoked_generation,
        )
        .unwrap();
        let mut wrong = scope.clone();
        wrong.host_key_generation += 1;
        assert!(verify_revocation(
            token,
            &signed["jwks"],
            &wrong,
            f["now"].as_u64().unwrap(),
            &proof.host_context,
            &proof.grant_id,
            &proof.bot_id,
            proof.revoked_generation
        )
        .is_err());
    }
}
