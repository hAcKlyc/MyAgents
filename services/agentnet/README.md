# Owned AgentNet service

This directory is the independent server implementation for MAH-SELFHOST-SERVICE-20261012. It contains authentication and device identity HTTP routes, private Dex deployment preparation, a DPoP-protected metadata adapter and a standalone bounded relay state machine. It is **not yet a complete deployable AgentNet**: real WebSocket relay, desktop/Host adapters and remote-management acceptance remain open in [IMPLEMENTATION.md](IMPLEMENTATION.md). No existing official account or encrypted Host identity is migrated.

## Authentication ownership

Dex supplies the login screen and local accounts, so deployment does not require the upstream official account service. AgentNet verifies OIDC signatures, issuer, audience and nonce with the `openidconnect` crate. The service maps the verified issuer/subject to its own durable principal; it stores only hashes of its own session credentials. PKCE and one-use login transactions bind the delivery to the initiating device. The first account is operator-provisioned; there is no open registration or password grant. The OIDC provider can later be replaced by an existing organization provider.

The service executable uses a fixed OIDC provider, validates discovery endpoints before requests and exchanges authorization codes with a distinct provider PKCE verifier. Callback handling retains a verified subject in a bounded, short-lived transaction; client PKCE proof is separately required to claim the session once. Valid provider failures and exchange failures terminate the transaction. Signature/key validation failure can trigger one bounded refresh from the fixed, same-origin JWKS URI, followed by one validation retry. Concurrent refreshes share the result and failures have a cooldown; issuer/audience/nonce/expiry failures do not trigger refresh. Changes to the provider's JWKS URI or advertised algorithms require a service restart.

Real isolated HTTPS acceptance with Dex v2.46.0 exercised its native password/approval forms, authorization-code exchange, device PKCE denial, one-use polling, service restart/session persistence, stable account mapping, revocation, cancellation, terminal provider denial and invalid-code replay rejection. A subsequent live acceptance exercised initial device enrollment, issued signatures/certificates, one-use proofs and wrong-key/replay denials, certificate renewal, restart persistence and immediate session revocation. These were automated native-form HTTP flows on loopback, not acceptance of the desktop login UI or a public deployment. Separate tests exercise issued certificates through the real shared client and mutual TLS.

The current routes are `POST /auth/login/start`, `GET /auth/callback`, `POST /auth/login/poll`, `DELETE /auth/login/cancel`, and `GET|DELETE /auth/session`. Session credentials are returned only in a no-store JSON response to the initiating client; they never enter browser redirect URLs. `/health` reports only the authentication phase.

## Prepare the independent login service

Prerequisites: Python 3, Docker Compose, `htpasswd` (`apache2-utils` on Ubuntu) and an operator-controlled HTTPS issuer/callback. Run preparation as the account that will own the state directory. The bundle uses that UID/GID for the container and does not overwrite an existing bundle.

```sh
python3 services/agentnet/deploy/bootstrap_auth.py \
  --output /absolute/private/path/agentnet-auth \
  --issuer https://auth.example.com/dex \
  --callback https://network.example.com/auth/callback \
  --email administrator@example.com
```

The password is prompted without echo; automation may instead use `--password-file` with a mode-0600, owner-controlled regular file. Generated files are mode 0600, directories 0700; they contain a bcrypt hash and generated OIDC client secret. Keep the bundle outside Git. No default password is provided. The generator starts no service and opens no port.

The generated Compose file runs Dex v2.46.0 and binds only `127.0.0.1:15556`. Before use, verify the image digest against the chosen release and record it with the deployment artifact. A separately configured HTTPS ingress must forward the exact issuer path to that loopback listener. Do not publish the container HTTP port. For isolated HTTPS tests, `--tls-cert` and `--tls-key` mount operator-provided private files and configure Dex HTTPS directly; clients must trust that test CA explicitly.

```sh
docker compose -f /absolute/private/path/agentnet-auth/compose.json config --quiet
docker compose -f /absolute/private/path/agentnet-auth/compose.json up -d
```

Run `myagents-agentnet-service --config /absolute/private/service.json` using a mode-0600 owner-controlled file. Required fields are `issuer`, `client_id`, `client_secret`, `callback_url`, `network_id`, `state_dir`, and `listen`; optional fields are `ca_bundle` and `session_ttl_seconds`. Issuer and callback must use HTTPS, callback must end in `/auth/callback`, and `listen` must be loopback. The service state directory must already exist with mode 0700. If explicitly supplied, the CA bundle must be an immutable root-controlled regular file; it is trusted only by this service, not installed into the system trust store. Forward a separate HTTPS service origin to this loopback API. Client secrets must stay out of environment variables, command arguments and request logs.

## Optional device identity endpoints

Initialize signing keys explicitly once, into an absolute path within a mode-0700 directory owned by the service account:

```sh
myagents-agentnet-service --initialize-identity-keys /absolute/private/state/identity-keys.json
```

Existing files are never overwritten. Add an optional closed `identity` object to the private service configuration, with `issuer` (the canonical HTTPS service origin), `service_id` (a stable UUID), `environment` (`production` or `development`) and `key_file` (the absolute initialized path). The device database uses the same private `state_dir`. Back up the keys, device database and authentication database together; changing the issuing keys without a migration invalidates client trust.

The adapter exposes `GET /api/agent-network/identity/state`, `POST /api/agent-network/identity`, `POST /api/agent-network/challenge`, `POST /api/agent-network/identity/current`, `POST /api/agent-network/certificate`, and public `GET /api/agent-network/jwks`. Private routes require the service's live opaque bearer session. Initial enrollment is insert-only and cannot replace an existing key. Current identity and certificate renewal require a one-use, operation/session/generation-bound proof from the stored P-256 key. The persisted key fingerprint is the shared client's SPKI SHA-256 fingerprint; JWT `cnf.jkt` remains the separate RFC7638 JWK thumbprint. Account-scoped state queries can inspect another device owned by that same principal but never return its CSR or private material.

Identity responses use a direct JSON body; metadata uses its fixed protocol envelope. The existing static-key selfhost client expects a different account envelope and is not a compatible login client yet. No network capabilities are advertised by these routes. Rotate, recovery and device revocation are not implemented by this HTTP adapter. Session revocation is serialized against issuance; signed credentials are subject to live session-handle and current-generation checks in the optional network HTTP adapter.

## Optional network metadata endpoints

After initializing identity authority, add the closed `network` configuration object, for example `{"name":"My private AgentNet"}`. Network configuration requires the identity configuration above. It opens a separate private metadata database under `state_dir`; service UUID and environment are pinned to that database, so changing them requires an explicit migration or a separate state directory. Displaying a different network name does not change account or device scope.

An existing nonempty metadata database without a profile pin is rejected rather than assigned a guessed owner. This stage has no previously released metadata database to migrate. If importing legacy data, first take a consistent private backup, establish a separate empty state directory with the intended profile, and use a reviewed explicit migration. Do not delete rows or edit the pin to bypass this check.

`POST /api/agent-network/device/registration` is an owned extension accepting only `deviceName`, `platform`, `osVersion` and `appVersion`. Device ID, principal and network come from the verified live session/device authority. The fixed metadata routes are `GET /v1/me/network`, `GET /v1/devices`, `GET /v1/devices/{device}/agents`, `POST /v1/networks/{network}/devices/{device}/join|leave`, `GET|PATCH /v1/networks/{network}/devices/{device}/name`, and `GET /v1/mutations/{mutation}`.

These routes require the issued device access JWT in `Authorization: Bearer ...` and a fresh ES256 `DPoP` proof using that device's key. Proofs bind the access-token hash, method and canonical issuer/path. Missing or old nonces receive a predispatch `401` with `DPoP-Nonce`; the client may construct a new proof and retry once before any operation is dispatched. Each service start generates a new nonce. Proof replay, live-session revocation and wrong generation/key never request automatic retry. Query pagination is snapshot-based (`cursor`, `limit` 1–200), and mutation UUIDs bind the exact request: retries return the original receipt, conflicting reuse fails, and expired receipts remain tombstoned rather than allowing a mutation to run again.

Success responses use `{"ok":true,"data":...}`; errors use a fixed code, `retryable:false` and request UUID. Reads and errors use `Cache-Control: no-store`. Devices remain offline with unknown Agent counts until the actual relay/catalog owner acknowledges their current catalog. Callable/mount mutations, operation permits and return routes are not exposed by this stage; it does not advertise their capabilities.

## Optional opaque WebSocket relay

Set `"relay":true` only together with both identity and network configuration. The same loopback service then mounts `GET /v1/ws` (fixed `myagents-agent-network.v1` subprotocol), `PUT /v1/devices/self/catalog` and `GET /api/agent-network/policy/self`. Configure the private HTTPS ingress to pass WebSocket upgrades; the backend must remain loopback-only.

WebSocket admission requires an actual issued access JWT, fresh DPoP, live account session and current device generation. The peer owner retains only verified public certificates and signed peer bindings indexed by the exact access JTI. Hello creates a server epoch and Syncing presence. Catalog upload is bounded by the locked protocol, requires that same live socket/JTI/epoch and persists before ACK. Ready additionally checks the durable catalog sequence; failure removes the exact connection immediately. New channels require both endpoints' durable Ready projections and current epochs. Auth revocation, replacement and EOF close only the admitted connection; old EOF cannot mark a replacement Offline.

The transport forwards opaque TLS-framed bytes without interpreting model credentials or management payloads. Queues, message sizes, pending handshakes, write deadlines and blocking operations are bounded. Cleanup effects are delivered on controller errors and revocation. Local tests use actual signed identities/DPoP and real loopback WebSocket clients for dual Offer/Accept, Ready, byte-preserving forwarding, both-end close and revocation/replacement cleanup. These prove local transport behavior, not a desktop-to-Linux management flow.

No public instance descriptor or owned desktop/Host login adapter is included in this stage. Existing static-key selfhost enrollment remains a separate incompatible path. In particular, do not advertise the unimplemented Agent permit/return capabilities to make that client accept this service. The next client stage must use its own authenticated account owner and explicit device-management capability profile.

## Persistence, backup and rollback

Keep `dex-state` and the generated configuration together. The initial user ID and client secret must remain stable across restart and upgrade. Do not rerun bootstrap into an existing directory, change static user IDs, or copy official MyAgents tokens. For an initial bounded backup, stop this dedicated Compose project, copy the complete private bundle to a private archive, and restart it; no other project should be stopped. Store backup access separately from public artifacts. Before upgrading, record the old image digest and take a consistent backup. Rollback uses the previous image and its compatible state backup; avoid restoring old authentication state over new active sessions without an explicit maintenance plan.

Session records also carry independent, random UUID handles for associating future signed device credentials with their live authenticated session. These handles are not bearer credentials and have no unauthenticated HTTP lookup. Both bearer and internal handle validation check expiry after database lock acquisition and again before returning. The handle migration preserves existing session hashes, expiry and revocation and prevents old programs from inserting handle-less sessions. Take a consistent authentication-state backup before this upgrade; a downgrade must restore matching state and executable together rather than run an old writer on the migrated database.

## Verification

```sh
cargo +1.92.0 test --locked --manifest-path services/agentnet/Cargo.toml
cargo +1.92.0 clippy --locked --all-targets --manifest-path services/agentnet/Cargo.toml -- -D warnings
cargo +1.92.0 test --locked --manifest-path services/agentnet/device-core/Cargo.toml
cargo +1.92.0 test --locked --manifest-path services/agentnet/identity-core/Cargo.toml
for core in admission-core metadata-core peer-core relay-core; do
  cargo +1.92.0 test --locked --manifest-path services/agentnet/$core/Cargo.toml
done
python3 -m unittest discover -s services/agentnet/deploy -p 'test_*.py'
```

These checks validate their local scope. Real browser login, device enrollment, zero-Agent routing, encrypted relay and desktop remote configuration require separate live acceptance.

## Future multi-user Bot sharing

The service is planned as a multi-user system with explicit per-Bot cross-user grants. Planning documents are in [the AgentNets roadmap](planning/AGENTNETS-ROADMAP.md), [v1 requirements and permissions](planning/AGENTNETS-BOT-SHARING-V1.md), and [the delivery and future-development checklist](planning/TODO.md). The [interactive prototype](../../dev-docs/prototypes/agentnets-bot-sharing-v1/index.html) uses synthetic local data only; it is not authenticated integration or a released sharing capability. Device and Host-management isolation remains a separate boundary.

Canonical owned fork: https://github.com/heavenzhang/MoXBots.git (renamed from heavenzhang/MyAgents on 2026-10-13). Historical commit and release references are retained.
