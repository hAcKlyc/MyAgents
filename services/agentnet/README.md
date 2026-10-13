# Owned AgentNet service

This directory contains the independently owned AgentNet service: OIDC login, public instance discovery, device identity, DPoP-protected metadata, a bounded WebSocket relay, and optional authenticated administrator registry routes. The source preserves the four metadata/relay safeguards from the deployed `04faeb1d` service. Desktop/Host adapters have their own owner and acceptance records; building this service does not establish complete remote-management, shared execution or production acceptance. No official account or encrypted Host identity is migrated.

## Authentication ownership

Dex supplies the login screen and local accounts, so deployment does not require the upstream official account service. AgentNet verifies OIDC signatures, issuer, audience and nonce with the `openidconnect` crate. The service maps the verified issuer/subject to its own durable principal; it stores only hashes of its own session credentials. PKCE and one-use login transactions bind the delivery to the initiating device. The first account is operator-provisioned; there is no open registration or password grant. The OIDC provider can later be replaced by an existing organization provider.

The service executable uses a fixed OIDC provider, validates discovery endpoints before requests and exchanges authorization codes with a distinct provider PKCE verifier. Callback handling retains a verified subject in a bounded, short-lived transaction; client PKCE proof is separately required to claim the session once. Valid provider failures and exchange failures terminate the transaction. Signature/key validation failure can trigger one bounded refresh from the fixed, same-origin JWKS URI, followed by one validation retry. Concurrent refreshes share the result and failures have a cooldown; issuer/audience/nonce/expiry failures do not trigger refresh. Changes to the provider's JWKS URI or advertised algorithms require a service restart.

Historical isolated HTTPS acceptance with Dex v2.46.0 exercised its native password/approval forms, authorization-code exchange, device PKCE denial, one-use polling, service restart/session persistence, stable account mapping, revocation, cancellation, terminal provider denial and invalid-code replay rejection. Subsequent identity and relay checks exercised device enrollment, issued certificates, one-use proofs, restart persistence, live session revocation, catalog Ready, paired channels and opaque frame forwarding. These checks establish their tested scope only. The owning task has separately verified independent public IP-SAN HTTPS login, native desktop/Linux Host visibility, model configuration, disabled Agent creation, persisted readback and own Host service restart on b116. Model credentials remain unconfigured and no paid inference was invoked. Fixed-reader first reads succeeded, but repeated-authorization acceptance after cold startup remains open. The administrator fixture separately validates the added registry operations; it does not establish Host execution.

The login routes are `POST /auth/login/start`, `GET /auth/callback`, `POST /auth/login/poll`, `DELETE /auth/login/cancel`, and `GET|DELETE /auth/session`. When identity, network and relay are enabled together, `GET /api/agent-network/instance` returns the bounded public descriptor (service, environment, network, login issuer, fixed protocol and TLS capability, root certificate, and JWKS); it does not return an account identity. Session credentials are returned only in a no-store JSON response to the initiating client and never enter browser redirect URLs. `/health` reports only the authentication phase.

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

### Native Dex deployment

Docker is optional. A verified native Dex executable from the pinned release can run under a dedicated non-root systemd account alongside the AgentNet executable. Record both executable digests and source provenance, check target ABI compatibility, and keep executables root-owned and non-writable by the service account. Prepare the same closed Dex configuration with SQLite in the service account's mode-0700 state directory and `web.http` bound to `127.0.0.1:15556`; preserve its static user ID, bcrypt hash, client secret and exact redirect URI. Replace the container-only `/var/dex` path with that private native state path. Run `dex serve /absolute/private/dex.json`; the service account must own its private configuration and writable state. No Docker daemon or public backend listener is required.

Use the existing HTTPS ingress for the canonical OIDC issuer and AgentNet origin. A valid, publicly trusted IP-SAN certificate can support an HTTPS IP origin without a DNS name. Preserve existing application routes, forward fixed AgentNet paths without URI rewriting, and pass WebSocket upgrades for `/v1/ws`. Apply login rate and connection limits; allow the fixed 8-MiB catalog budget only on `/v1/devices/self/catalog`, while ordinary management/authentication HTTP requests retain their 8-KiB body budget. Keep authorization query strings and credentials out of proxy logs. Verify certificate renewal and its ingress reload hook, especially for short-lived IP certificates.

Before enabling units or ingress changes, back up matching private state/configuration/keys, validate unit and Nginx drafts, and compare current ingress configuration with the preparation digest. On failure, restore original ingress independently of service-stop failures; confirm termination from actual unit state and PID before claiming cleanup. Preserve unresolved state for diagnosis. A deployed descriptor and successful restart establish service readiness only; browser login and actual desktop/Host management remain separate acceptance gates.

## Public deployment preparation

The source currently serves a loopback listener; it does not configure public DNS, certificates, or the reverse proxy. Before enabling a public instance, choose an operator-controlled HTTPS origin and provision a valid certificate with its matching DNS or IP SAN. Configure the OIDC issuer and exact callback URL to match the reachable login endpoint, and set the identity issuer to the canonical service HTTPS origin used by the descriptor and signed device material. Keep the service listener bound to loopback. Route ordinary HTTP requests and `/v1/ws` WebSocket upgrades through the existing HTTPS ingress without changing its current application listeners or exposing the backend port. Verify the public descriptor from an external client and check that its service ID, environment, network ID, issuer, JWKS, and root certificate match the private configuration and client trust pins.

Create one dedicated service state directory owned by the service account with mode 0700, and keep the mode-0600 service configuration and signing-key file in controlled private locations. The state directory contains `auth.sqlite3`, `devices.sqlite3`, `metadata.sqlite3`, and `peers.sqlite3`; the stable identity signing keys are configured separately. Preserve the state directory, key file, Dex state, generated secrets, and exact configuration as one recoverable deployment set. Do not reuse one profile's state or keys for another service/environment, and do not move state between principals or service IDs by editing database pins.

For each upgrade, record the executable/source and Dex image digests, verify the config and private directory ownership/modes, then take a consistent backup while the service is stopped. Upgrade only the dedicated service and its matching Dex project. Roll back the service binary, Dex image, configuration, signing keys, and state as a compatible set; do not restore an older database under a newer writer or vice versa. Recheck `/health`, the public descriptor, browser login, a device session and WebSocket upgrade after deployment. These are deployment checks to perform; they are not claims that public deployment has occurred.

## Optional device identity endpoints

Initialize signing keys explicitly once, into an absolute path within a mode-0700 directory owned by the service account:

```sh
myagents-agentnet-service --initialize-identity-keys /absolute/private/state/identity-keys.json
```

Existing files are never overwritten. Add an optional closed `identity` object to the private service configuration, with `issuer` (the canonical HTTPS service origin), `service_id` (a stable UUID), `environment` (`production` or `development`) and `key_file` (the absolute initialized path). The device database uses the same private `state_dir`. Back up the keys, device database and authentication database together; changing the issuing keys without a migration invalidates client trust.

The adapter exposes `GET /api/agent-network/identity/state`, `POST /api/agent-network/identity`, `POST /api/agent-network/challenge`, `POST /api/agent-network/identity/current`, `POST /api/agent-network/certificate`, and public `GET /api/agent-network/jwks`. Private routes require the service's live opaque bearer session. Initial enrollment is insert-only and cannot replace an existing key. Current identity and certificate renewal require a one-use, operation/session/generation-bound proof from the stored P-256 key. The persisted key fingerprint is the shared client's SPKI SHA-256 fingerprint; JWT `cnf.jkt` remains the separate RFC7638 JWK thumbprint. Account-scoped state queries can inspect another device owned by that same principal but never return its CSR or private material.

Identity responses use a direct JSON body; metadata uses its fixed protocol envelope. The old static-key enrollment path remains separate from the owned OIDC account adapter. Rotate/recovery and general device-revocation administration are not exposed by this HTTP adapter. Session revocation is serialized against issuance; signed credentials are subject to live session-handle and current-generation checks in the network and relay adapters.

## Optional network metadata endpoints

After initializing identity authority, add the closed `network` configuration object, for example `{"name":"My private AgentNet"}`. Network configuration requires the identity configuration above. It opens a separate private metadata database under `state_dir`; service UUID and environment are pinned to that database, so changing them requires an explicit migration or a separate state directory. Displaying a different network name does not change account or device scope.

An existing nonempty metadata database without a profile pin is rejected rather than assigned a guessed owner. This stage has no previously released metadata database to migrate. If importing legacy data, first take a consistent private backup, establish a separate empty state directory with the intended profile, and use a reviewed explicit migration. Do not delete rows or edit the pin to bypass this check.

`POST /api/agent-network/device/registration` is an owned extension accepting only `deviceName`, `platform`, `osVersion` and `appVersion`. Device ID, principal and network come from the verified live session/device authority. The fixed metadata routes are `GET /v1/me/network`, `GET /v1/devices`, `GET /v1/devices/{device}/agents`, `POST /v1/networks/{network}/devices/{device}/join|leave`, `GET|PATCH /v1/networks/{network}/devices/{device}/name`, and `GET /v1/mutations/{mutation}`.

These routes require the issued device access JWT in `Authorization: Bearer ...` and a fresh ES256 `DPoP` proof using that device's key. Proofs bind the access-token hash, method and canonical issuer/path. Missing or old nonces receive a predispatch `401` with `DPoP-Nonce`; the client may construct a new proof and retry once before any operation is dispatched. Each service start generates a new nonce. Proof replay, live-session revocation and wrong generation/key never request automatic retry. Query pagination is snapshot-based (`cursor`, `limit` 1–200), and mutation UUIDs bind the exact request: retries return the original receipt, conflicting reuse fails, and expired receipts remain tombstoned rather than allowing a mutation to run again.

Success responses use `{"ok":true,"data":...}`; errors use a fixed code, `retryable:false` and request UUID. Reads and errors use `Cache-Control: no-store`. Devices remain offline with unknown Agent counts until the actual relay/catalog owner acknowledges their current catalog. The fixed management application currently exposes configuration snapshot/update, resource creation, and receipt lookup over the encrypted Host channel. Callable/mount mutations, operation permits and return routes are not exposed. The public descriptor advertises the implemented TLS capability; it does not grant account membership or Host-management permission.

## Optional opaque WebSocket relay

Set `"relay":true` only together with both identity and network configuration. The same loopback service then mounts `GET /v1/ws` (fixed `myagents-agent-network.v1` subprotocol), `PUT /v1/devices/self/catalog` and `GET /api/agent-network/policy/self`. Configure the private HTTPS ingress to pass WebSocket upgrades; the backend must remain loopback-only.

WebSocket admission requires an actual issued access JWT, fresh DPoP, live account session and current device generation. The peer owner retains only verified public certificates and signed peer bindings indexed by the exact access JTI. Hello creates a server epoch and Syncing presence. Catalog upload is bounded by the locked protocol, requires that same live socket/JTI/epoch and persists before ACK. Ready additionally checks the durable catalog sequence; failure removes the exact connection immediately. New channels require both endpoints' durable Ready projections and current epochs. Auth revocation, replacement and EOF close only the admitted connection; old EOF cannot mark a replacement Offline.

The transport forwards opaque TLS-framed bytes without interpreting model credentials or management payloads. Queues, message sizes, pending handshakes, write deadlines and blocking operations are bounded. Cleanup effects are delivered on controller errors and revocation. Automated loopback tests use actual signed identities/DPoP and real WebSocket clients for dual Offer/Accept, Ready, byte-preserving forwarding, both-end close and revocation/replacement cleanup. Native Linux QA has also exercised the relay and management code. This does not close the user-authorized desktop-to-Linux configuration acceptance described above.

Owned login adapters exist for desktop and Linux Host. The desktop stores its owned account/session separately from the legacy static-key account; the Host uses its explicit local encrypted credential and management-IPC configuration. Initial login/join remains an explicit operator/user action. Do not infer membership from discovery or same-account visibility, and do not advertise Agent permit/return capabilities that are not implemented. The actual user-driven Host authorization, desktop online status, management write/readback, restart persistence and denial/recovery path remain acceptance gates.

## Persistence, backup and rollback

Keep `dex-state`, generated configuration, the AgentNet private state directory, and identity signing keys together as a deployment set. The initial user ID and client secret must remain stable across restart and upgrade. Do not rerun bootstrap into an existing directory, change static user IDs, or copy official MyAgents tokens. For a consistent backup, stop only this dedicated AgentNet service and Dex project, copy the private state/config/key material to a private archive, then restart the same units. Store backup access separately from public artifacts. Before upgrading, record the old image and executable digests. Rollback restores the matching binary, config, keys, databases, and Dex state; do not restore older authentication state over new active sessions without an explicit maintenance plan.

Session records carry independent, random UUID handles used to associate signed device credentials with their live authenticated session. These handles are not bearer credentials and have no unauthenticated HTTP lookup. Both bearer and internal handle validation check expiry after database lock acquisition and again before returning. The authentication database includes a session-handle migration that preserves existing session hashes, expiry and revocation. A downgrade must restore a matching database backup and executable together rather than run an old writer on the migrated database.

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

These checks validate their local scope. Target login, public ingress, desktop/Host management, restart/readback, and failure recovery require separate current acceptance evidence; administrator registry checks do not replace them.

## Administrator control plane

The optional same-origin `/admin` console and `/api/admin/` routes now use the existing OIDC/session authority, private Bot registry, CAS/idempotent receipts and metadata audit. Registered users and explicitly authorized Host/model references are checked server-side. Configuration and soft-delete are real control-plane writes; Host execution is not connected and `start` fails closed. Activation and operational acceptance are separate from the local fixture tests. See [ADMINISTRATION.md](ADMINISTRATION.md) and [implementation status](planning/BOTS-CLOUD-ADMIN-IMPLEMENTATION.md).

## Future Bots administration and Bots Net sharing

The service is planned as a multi-user system with a platform-administrator Bots console and explicit per-Bot cross-user grants. Personal network use remains in the client, with its current Agent Net entry planned to become Bots Net. Platform administrators, Bot owners, and per-Bot sharing administrators have distinct authority; private sessions and credentials are not automatically exposed. Planning documents are in [the AgentNets roadmap](planning/AGENTNETS-ROADMAP.md), [v1 requirements and permissions](planning/AGENTNETS-BOT-SHARING-V1.md), and [the delivery and future-development checklist](planning/TODO.md). The [interactive prototype](../../dev-docs/prototypes/agentnets-bot-sharing-v1/index.html) uses synthetic local data only; it is not authenticated integration or a released sharing capability. Device and Host-management isolation remains a separate boundary.

Canonical owned fork: https://github.com/heavenzhang/MoXBots.git (renamed from heavenzhang/MyAgents on 2026-10-13). Historical commit and release references are retained.

管理员Bots生命周期的后续规划见 [BOT-ADMIN-LIFECYCLE-V1.md](planning/BOT-ADMIN-LIFECYCLE-V1.md)，覆盖新建、配置、启停、纳管所属用户/Host分配及逻辑删除；管理登记控制面已进入实现与验收；真实Host执行和跨用户共享仍另行接线。
