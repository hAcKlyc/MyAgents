# Owned AgentNet service

This directory is the independent server implementation for MAH-SELFHOST-SERVICE-20261012. It contains an authentication core, a loopback HTTP authorization-code adapter, private Dex deployment preparation, a bounded device identity signer and durable device identity HTTP routes. It is **not yet a complete deployable AgentNet**: metadata and relay, desktop/Host adapters and remote-management acceptance remain open in [IMPLEMENTATION.md](IMPLEMENTATION.md). No existing official account or encrypted Host identity is migrated.

## Authentication ownership

Dex supplies the login screen and local accounts, so deployment does not require the upstream official account service. AgentNet verifies OIDC signatures, issuer, audience and nonce with the `openidconnect` crate. The service maps the verified issuer/subject to its own durable principal; it stores only hashes of its own session credentials. PKCE and one-use login transactions bind the delivery to the initiating device. The first account is operator-provisioned; there is no open registration or password grant. The OIDC provider can later be replaced by an existing organization provider.

The service executable uses a fixed OIDC provider, validates discovery endpoints before requests and exchanges authorization codes with a distinct provider PKCE verifier. Callback handling retains a verified subject in a bounded, short-lived transaction; client PKCE proof is separately required to claim the session once. Valid provider failures and exchange failures terminate the transaction. Signature/key validation failure can trigger one bounded refresh from the fixed, same-origin JWKS URI, followed by one validation retry. Concurrent refreshes share the result and failures have a cooldown; issuer/audience/nonce/expiry failures do not trigger refresh. Changes to the provider's JWKS URI or advertised algorithms require a service restart.

Real isolated HTTPS acceptance with Dex v2.46.0 exercised its native password/approval forms, authorization-code exchange, device PKCE denial, one-use polling, service restart/session persistence, stable account mapping, revocation, cancellation, terminal provider denial and invalid-code replay rejection. This was an automated native-form HTTP flow on loopback, not acceptance of the desktop login UI or a public deployment. Separate tests exercise issued certificates through the real shared client and mutual TLS. The device HTTP adapter is tested with a cryptographically verified OIDC fixture and actual device CSR/proofs; live Dex-to-device endpoint acceptance is still separate.

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

Identity responses currently use a direct JSON body; metadata will use its protocol envelope. The existing static-key selfhost client expects a different account envelope and is not a compatible login client yet. No network capabilities are advertised by these routes. Rotate, recovery, device revocation and DPoP-protected metadata/relay admission are not implemented by this HTTP adapter. Session revocation is serialized against issuance; signed credentials remain subject to a future live session-handle and current-generation check at every network admission.

## Persistence, backup and rollback

Keep `dex-state` and the generated configuration together. The initial user ID and client secret must remain stable across restart and upgrade. Do not rerun bootstrap into an existing directory, change static user IDs, or copy official MyAgents tokens. For an initial bounded backup, stop this dedicated Compose project, copy the complete private bundle to a private archive, and restart it; no other project should be stopped. Store backup access separately from public artifacts. Before upgrading, record the old image digest and take a consistent backup. Rollback uses the previous image and its compatible state backup; avoid restoring old authentication state over new active sessions without an explicit maintenance plan.

Session records also carry independent, random UUID handles for associating future signed device credentials with their live authenticated session. These handles are not bearer credentials and have no unauthenticated HTTP lookup. Both bearer and internal handle validation check expiry after database lock acquisition and again before returning. The handle migration preserves existing session hashes, expiry and revocation and prevents old programs from inserting handle-less sessions. Take a consistent authentication-state backup before this upgrade; a downgrade must restore matching state and executable together rather than run an old writer on the migrated database.

## Verification

```sh
cargo +1.92.0 test --locked --manifest-path services/agentnet/Cargo.toml
cargo +1.92.0 clippy --locked --all-targets --manifest-path services/agentnet/Cargo.toml -- -D warnings
cargo +1.92.0 test --locked --manifest-path services/agentnet/device-core/Cargo.toml
cargo +1.92.0 test --locked --manifest-path services/agentnet/identity-core/Cargo.toml
python3 -m unittest discover -s services/agentnet/deploy -p 'test_*.py'
```

These checks validate their local scope. Real browser login, device enrollment, zero-Agent routing, encrypted relay and desktop remote configuration require separate live acceptance.
