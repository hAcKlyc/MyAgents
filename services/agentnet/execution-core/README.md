# Finite Bot execution wire owner

This crate and `js/index.mjs` define the closed `moxbot.bot.execution/v1` DTOs,
canonical hashes and pinned ES256 proof verification. They do not authenticate
humans, verify actual device ownership, persist grant generations, or execute
Host operations. Those gates remain the HTTP/store/Host owners' responsibility.

## Public contract

Rust crate: `myagents-agentnet-execution-core`. Node ESM:
`services/agentnet/execution-core/js/index.mjs`; adjacent `index.d.mts` declares
its TypeScript API. Import the shared verifier rather than reproducing JWT logic.

- `command_hash` / `commandHash`: SHA256 of the recursively ASCII-key-sorted
  command, excluding **only** its `request_hash` field. Original CAS, actor,
  operation and grant/binding generations remain hashed.
- `intent_hash` / `intentHash`: SHA256 of the complete canonical `IntentClaims`,
  not the JWT bytes. The lease binds this hash and the original command hash.
- `verify_grant` / `verifyGrant`, `verify_intent` / `verifyIntent`,
  `verify_lease` / `verifyLease`, `verify_revocation` / `verifyRevocation` verify
  a caller-pinned public JWKS. They never fetch header-provided keys or URLs.
- Lease verification additionally requires the previously verified full intent
  and **current** Host context. Revocation verification requires the current
  context and exact local grant ID, Bot ID and revoked generation.
- Schema `validate*` functions check DTO structure/semantics only. They are not
  a substitute for `verify*`, live authority or durable local grant checks.
- `HostObservation::validate` / `validateHostObservation` validate a closed
  report of policy-approved Bot snapshots and capability arrays. The complete
  canonical DTO is at most 64 KiB, collections are unique and at most 64 items,
  and each snapshot belongs to `allowed_bot_ids`. Add whole snapshots only while
  this bound holds. These reports are display metadata; they never replace a
  mutation receipt, establish a binding, authorize execution or confirm revoke.

Rust and Node reject unknown/duplicate JWT object fields, incorrect proof
kind/audience/namespace/issuer/scope, unsafe integers, float spellings in raw JWT
JSON, stale epochs/nonces/generations, expired/future proofs, excessive lifetimes,
request/intent hash changes and grant configuration/scope violations. Node
`strictParse` preserves duplicate-key rejection before typed validation.

All fields use snake_case. UUIDs are canonical lowercase. `agent_id` is the
bounded existing opaque Agent ID. `model_ref` is a required nullable UUID.
Payload limit is 64 KiB, JWT limit 128 KiB, grant collections at most 64 items.
Grant/intent JWT validity is at most 300 seconds (the underlying durable grant
may last longer). Lease/revocation JWT validity is at most 15 seconds. Clocks
have no implicit grace period. Counters are bounded by `2^53-1`.

`ServiceKeys` exposes only typed `sign_execution_{grant,intent,lease,revocation}`
methods. Signer profile and embedded scope must match. Intent, lease and
revocation callers supply the live-authority deadline; the signed proof cannot
outlive it. Lease also cannot outlive its validated intent or grant. Signing
uses the existing protected service key and fixed per-proof typ/audience/domain.
No arbitrary claims signer or secret-export API was added.

A service signature means that the Host trusts that service's authenticated
owner/admin decision within its locally accepted grant. It does not prove the
user signed the command cryptographically. Issuance is the lease acceptance
point; remote revocation does not instantly cancel an already-issued lease.
Effective revocation requires the Host's real admission/activity receipt.

`runnable` requires an adapter-backed configured Agent binding; open admission
requires runnable. It is not model inference evidence. Unknown mutation outcomes
cannot carry an effective snapshot. Restore/revoke monotonic generation handling,
activity termination, receipt replay and active-run identity remain owner duties.

## Verification

`fixtures/wire-v1.json` is the schema/canonical hash/parity fixture.
`fixtures/signed-v1.json` contains public Node-generated ES256 signatures and
public JWK only. The generating private key is ephemeral and is never saved.
Identity-core tests also generate protected service keys at runtime and verify
Rust-signed proofs through the actual Node ESM consumer.

```sh
cargo test --locked --manifest-path services/agentnet/execution-core/Cargo.toml
cargo clippy --locked --all-targets --manifest-path services/agentnet/execution-core/Cargo.toml -- -D warnings
cargo fmt --manifest-path services/agentnet/execution-core/Cargo.toml --check
cargo test --locked --manifest-path services/agentnet/identity-core/Cargo.toml
cargo clippy --locked --all-targets --manifest-path services/agentnet/identity-core/Cargo.toml -- -D warnings
cargo fmt --manifest-path services/agentnet/identity-core/Cargo.toml --check
node --test services/agentnet/execution-core/js/index.test.mjs
```

Node 24, pinned by the repository `.nvmrc`, is used for cross-runtime parity. No
network, real account, model invocation, production acceptance or deployment is
performed by these tests.
