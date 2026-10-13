# BOTS-CLOUD-EXEC-001 · finite Bot execution contract

User approved finite Bot delegation on 2026-10-13. This implementation uses outbound Host-self HTTPS polling, scoped owner grants and signed short leases. Existing device-pair/relay/same-principal rules remain intact. This file is the team interface draft; closed Rust schema and parity fixtures will become the actual wire authority. The cloud registry UI/PR20 remains a separate first-stage delivery.

## Owners and first slice

Cloud owns human session/role validation, actual device ownership checks, grants, command ledger and typed signing. Host owns accepted local grants, restricted workspaces, Bot/Agent mapping, configuration, admission, any actual run generation and original receipts. Browser state is a projection, never a execution outcome. Credential plaintext never enters the contract; configuration uses approved Host-local model references.

First slice: owner accepts one Bot/Host/root grant; Host listener explicitly opted into the pinned service; create disabled Agent and stable binding, configure Bot-local state, enable/disable scoped admission, soft-delete/restore with original receipts and restart persistence. No paid model turn. Enable can only succeed for a genuinely supported/configured adapter; a metadata-only binding is never called runnable. First Host keeps one active Session, rejects another Bot with HOST_BUSY, never stops an unrelated/private Session. Real inference, multi-Bot concurrent workers, IM/cron and sharing remain separate gates.

## Common serialization

New namespace `moxbot.bot.execution/v1`; JWT audience `moxbot-host-bots/v1`. All JSON fields snake_case; deny unknown fields. IDs lowercase canonical UUID unless agent_id is an opaque bounded existing Agent ID. Counters safe integers (0..2^53-1), Unix seconds for deadlines. Original request hash is SHA256 of recursively key-sorted closed JSON excluding request_hash; no float/NaN, arbitrary keys or credential strings. Rust/Node parity fixtures validate canonical bytes and limits.

Scope: issuer (canonical HTTPS origin), service_id, environment, network_id, host_owner_id, host_device_id, host_key_generation, identity_binding_id. Host connection context: challenge_nonce, local_auth_generation, boot_epoch, connection_epoch, membership_revision. Host generates challenge and local generations; server independently checks actual connection epoch/membership. Host checks all echoed fields again under its owner lock.

Grant: id, generation, scope, bot_id, root_id, relative_path, operations, allowed_runtimes, allowed_model_refs, max_daily_tokens, expires_at. Root ID is locally configured, relative path contains only safe path components and must be fixed to this Bot. Owner acceptance requires live OIDC session whose actual DeviceStore/Metadata target principal matches; admin resource config cannot substitute for ownership. Host independently accepts the signed grant only inside its configured opt-in root/service/identity scope. Delete/revoke closes permission; restore requires a newly accepted grant generation, does not revive old sharing.

Command: mutation_id, request_hash, actor_principal_id, actor_session_handle, grant_id, grant_generation, bot_id, binding_generation, expected_host_revision, operation. Operation is a closed tagged object `{method,params}`:

- create: name, description, runtime, model_ref (nullable UUID), system_prompt, daily_tokens, resource_expected_revision. Creates disabled Agent through existing resource owner, then durable binding; staged intent recovery must preserve the original resource CAS/body.
- configure: name, description, runtime, model_ref, system_prompt, daily_tokens. Bot-local immutable configuration only.
- enable: empty params. Requires authorized runtime/model/credential and correct Bot-local run entry; no global execution flag.
- disable: policy=cancel. Closes this Bot's admission and only cancels its bound run generation.
- delete: confirmation (exact name). Admission and activity closure required before final deleted receipt.
- restore: empty params. Restores disabled with fresh grant; no old capabilities/channels/tasks.

Bot snapshot: bot_id, agent_id?, binding_generation, revision, deleted, admission(closed/open), activity(idle/running/stopping/stopped/unknown), configured, runnable, unsupported_reason?, config, active_run? (session_id/run_generation). No absolute private path, transcript, raw key or arbitrary user metadata. Receipt: mutation_id/request_hash, grant_id/generation, bot_id, agent_id?, binding_generation, revision, status(persisted/conflict/failed/unconfirmed), code?, snapshot?. Persisted config is not running. Stopped requires closed admission and actual bound activity termination; receipt must not claim effects if the result is unknown.

## Signed proofs and authorization timing

Typed grant/intent/lease JWT methods on existing protected ServiceKeys; fixed typ values `moxbot-execution-{grant,intent,lease}+jwt`, fixed aud/namespace, no arbitrary claims signer or key export. Grant claims bind full scope/grant and expiry. Intent claims bind scope, original command and grant. Lease additionally binds intent_hash, Host challenge/context, lease_id and iat/exp (maximum15 seconds). All trusted target checks and expiry validation happen before signing, then Host verifies again before application.

Pull returns intent only. `/execution/self/lease` checks both live Host session and original admin session handle in one AuthStore gate, current role, actual DeviceStore identity/key, Metadata joined/membership/current epoch, grant generation and original hash. Store/network locks cannot span await or be re-entered. Host-self endpoints use actual JWT+DPoP and derive Host identity from validated scope, never arbitrary request Host IDs. Separate typed decoder/transport uses existing pinned origin/authenticated helper, never vendor MetadataKind.

Lease issuance is the authorization acceptance point. Remote revoke blocks new leases and marks cancellation pending; effective revocation only after Host confirms closed admission/activity. Do not promise instantaneous cross-network revocation of an issued lease. On connection/account/key generation change or lease expiration, Host drops pending challenges and admission; stale proofs fail closed.

Cloud endpoints (proposed closed interface):

- POST /api/admin/bots/{id}/execution (original typed command, live admin)
- GET /api/admin/execution/mutations/{mutation_id} (original actor scoped receipt)
- POST /api/bots/grants/accept|revoke (live actual Host owner)
- POST /execution/self/pull|lease|receipt (device JWT+DPoP and full live gate)

Nginx uses existing TLS origin, no new public listener. All body/queue/store sizes bounded, no-store responses. First-stage registry start/stop remain disconnected until actual execution adapter and accepted target capability are wired.

## File ownership and acceptance

Primary: cloud execution gate/ledger/HTTP/controller, registry UI adapter, integration, Git/main/deployment. Sol/high requested worker: new execution-core closed schema/hash/fixtures plus identity-core typed signer APIs and Cargo wiring, no network/Host/production. Luna/medium requested worker: new Host bot-delegation/bot-management/bot-runtime files and focused tests, no main/IPC/connector/cloud/production. Existing PR14 owner owns its active source until explicit thin-hook boundary release; do not modify its worktree.

Required tests: true cryptographic wrong-domain/scope/nonce/expiry refusal; owner vs other admin; current/revoked sessions and grants; current device/membership/epoch; original mutation/CAS/unknown recovery; restricted-root creation and local-ledger crash recovery; Bot A disable cannot affect Bot B/private Session; deleted grant cannot restore; restart closed admission. Runtime enable/execution requires real immutable snapshot adapter proof; fake runner fixtures do not satisfy real acceptance. Integration and effective production state tracked separately.

## Host observation and administrator lifecycle UI (integration contract)

`HostObservation` is a closed DTO with `host_revision`, `resource_revision`, `root_ids`, `supported_runtimes`, `allowed_bot_ids`, `allowed_model_refs`, `max_daily_tokens`, `policy_expires_at`, `snapshots`. Counters use existing safe integer rules; allowed arrays are bounded by existing finite policy. Snapshot additions stop before the entire DTO exceeds64KiB; never truncate a field or token. No absolute paths, Provider credentials, private sessions or global Host settings are exposed. Only policy-approved Bot snapshots may be reported.

Private IPC adds request `{method:'status'}` and response `{method:'status',observation:HostObservation}`. Node status reconciles exact Runtime identity before returning snapshots. Rust obtains status only after current scope/context handshake and passes `{host_context,observation}` to fixed POST `/execution/self/observe`, under the same current device/DPoP/realWS gate. The protected Rust policy independently constrains reported arrays/limits/expiry. No reported capability grants permission.

Cloud persists the bounded authenticated observation under exact scope/context with server `seen_at`; never uses it in place of an original mutation receipt or to authorize binding changes/revocation. Bootstrap `execution.hosts` returns `{host_id,scope,seen_at,host_context,observation}` for declared deployment resources; UI labels these as latest Host reports, treats >30s as stale/unknown, and does not infer process state from registry fields. Each execution record keeps immutable `grant,state` plus latest reported matching snapshot (or historical receipt with its age/label).

Admin lifecycle: before creation of an actual Agent, choose a fresh finite owner grant and one reported root ID; use relative path `bots/<bot UUID>` and model references already declared for this owner. Owner grant acceptance uses existing live OIDC identity and actual DeviceStore/Metadata ownership, never a checkbox pretending to be another owner. Other administrators may enqueue within an accepted grant but cannot consent on its owner's behalf. Every operation retains its original mutation ID and exact request for receipt queries; unknown outcomes block retargeting/resubmission under a new ID.

First slice is real Host Product Session lifecycle (create/configure/enable/disable/delete/restore). Invocation remains disabled: no paid turn, IM/cron, tools or cloud access to private Session endpoints. Running means an identity-bound Host Session is alive; configuration/model inference acceptance remains separate. After revocation, a fresh grant+binding generation may restore a confirmed inactive/revoked Bot in the same approved root; it stays closed until explicit enable. Multi-user sharing and unrelated Desktop/Host management are separate deliverables.

## Durable final receipt recovery and policy expiry

After a verified lease, the Host records its lease ID with the original command and protected policy fingerprint before an effect. A final receipt and its pending lease ACKs are committed atomically. The private `pending_receipts` IPC returns only persisted/conflict/failed receipts matching the original mutation/hash and current Bot whitelist/policy fingerprint, in bounded batches. `ack_receipt` confirms the exact lease/mutation/hash tuple, retaining immutable command and receipt history. Legacy records never invent lease IDs or a policy pin; unconfirmed outcomes are never promoted.

Every outbound poll reconciles these original receipts before new commands. The existing Host device/DPoP/scope/live connection gate accepts an original leased result independently of the now-revoked administrator session; it cannot authorize a new lease or replay an effect. Only a matching cloud receipt projection clears the local pending ACK. An unchanged expired policy permits this read/ACK lane only; it prohibits status observation, new grants, pull/lease and effects. A changed/deleted authority file closes the channel, and a different policy fingerprint cannot read old pending entries. Drain original ACKs before an operator replaces a policy; unresolved or unpinned history requires explicit owner reconciliation, never a guessed success.

Supervisor expiry closes only its bound Bot child: bounded shutdown, SIGTERM, then SIGKILL, requiring actual ChildProcess exit evidence. Unknown exits keep unknown state. Private Sessions retain their original owner and lifecycle. This first release does not claim recovery of an unknown process across supervisor restart without authoritative process evidence.
