# MAH-SELFHOST-SERVICE-20261012

## Current acceptance checkpoint — MAH-DESKTOP-MANAGEMENT-20261013

This checkpoint supersedes the incomplete-client and relay statements in the historical milestones below. Source now includes the public descriptor, owned desktop/Host account adapters, real WS relay and encrypted Host management IPC; this is independently deployed service code, separate from the official account system.

- [x] Automated/native two-device identity, relay/Pairs, management persistence, receipt and restart checks.
- [x] Real MoX bot desktop account login and automatic online recovery after desktop restart; original MyAgents remains separate.
- [x] Installed Linux connector CA directory and public-read permission fixes, safe same-release migration, original-service preservation, and actual `owned-auth-start` success. The first Host browser request expired without authorization.
- [x] User-authorized Host login and enrollment; the installed Linux Host is visible online in the independent cloud network.
- [x] Real b116 desktop model configuration and disabled Agent creation, persisted server readback and own Host service restart. Model API credentials and paid execution remain unconfigured.
- [x] Independent IP-SAN HTTPS authentication and AgentNet deployment on the authorized cloud server, preserving its existing app. Target connection details and credentials remain outside Git.
- [ ] Fixed credential reader first migration survives cold startup and a different desktop build without repeated authorization. First reads succeeded; same-build cold startup still returned authorization required, with no automatic retry.
- [ ] Required CI, main delivery and deployment correspondence for the accepted final artifacts.

The two desktop builds preserve the same signed reader bytes. Synthetic cold-process queries also pass with hardened runtime and an App-contained helper, but do not reproduce the legacy-record rejection. Real credential reads and authorization retries remain stopped while investigating; the verified b116 desktop has been restored. Required CI passed at d30235b3; the final native/update gate is still open.

Real model calls remain zero. Product-supplied credentials and any required paid-call authorization are a separate execution gate; they must not be requested through chat.

## Administrator control plane and deployed service compatibility

BOTS-CLOUD-ADMIN-001 adds optional authenticated registry administration. Status and acceptance are tracked in [the implementation contract](planning/BOTS-CLOUD-ADMIN-IMPLEMENTATION.md). The four metadata/relay source files preserve the independently deployed `04faeb1d` safeguards (same-principal device address, persisted catalog preservation, raw heartbeat and private initialization locking). The Host management base from `b116404e` is integrated on an isolated branch based on current main (`e9767263`); its previously verified desktop path covered model configuration save, disabled Agent creation, and Host restart. This branch still needs CI and review before main delivery. Fixed-reader no-prompt packaging and caller changes are excluded and remain a separate draft; no new desktop package was built, signed, or installed in this stage.

The historical foundation milestones below are retained as history. Current source exposes the owned descriptor and real bounded WS relay; the earlier no-relay/no-client stage statements do not describe current capability.

## Historical milestones

Goal: deploy an independently owned AgentNet service including browser login, device identity, zero-Agent discovery, encrypted relay, and desktop-to-Host configuration. This service does not require access to the upstream author's private server or official account credentials.

Current base: fork main f0d630e3a3bac085c8615bdd49af728679b12c48 (MoX isolation, PR #11). Service worktree/branch: myagents-selfhost-service / feat/mah-selfhost-service. Existing official desktop/Host enrollment is preserved. Implementation, deterministic integration, real two-device acceptance, main delivery and deployment are separate gates.

## Ownership decisions

- New service source lives under services/agentnet, independently of desktop Tauri and Node Host. Fixed vendor 1.1.0 artifacts remain unchanged.
- Reuse mature cryptography and protocol validation. Signing: existing pinned jsonwebtoken/P-256; device certificate issuer: rcgen with verified CSR; relay is opaque to inner TLS plaintext. No custom JWT signature or certificate algorithm.
- Self-contained authentication deployment uses Dex (standard OIDC) with its local user connector; existing enterprise OIDC can replace it. The service is an OIDC relying party using authorization-code + PKCE with issuer/audience/nonce validation. Authentication is independent from official Space.
- The service database owns IdP issuer+subject to UUID principal mapping, login transactions/session hashes, devices/generation/revocation, membership, catalogue revisions and mutation receipts. Runtime owns bounded connection epochs/pairs/credits and short-lived replay/challenge state.
- Public service discovery does not grant a principal identity. A verified login resolves the account principal and its network; authenticated descriptor pins service/issuer/network/JWKS/root. Existing static selfhost enrollment remains compatible as a separate path.
- Zero-Agent routing must have a device-level authenticated descriptor (deviceId, current generation, connection epoch, signed binding, membership revision); a dummy exposed Agent is not needed.
- Management data and model credentials remain end-to-end encrypted between desktop and Host. Host remains the configuration/Agent/secret authority; relay accounts and routing metadata never contain model API keys.
- First owned backend process binds loopback behind a separately configured TLS ingress. No public listener, official network migration or production credential is introduced during isolated development. Deployment artifacts must document initialization, persistence, backups, upgrades and rollback.

## Delivery gates

- [x] Bounded GitHub/public source search and existing selfhost/API/identity contract audit.
- [x] Authentication foundation: durable account mapping; PKCE/nonce transactions with expiry/single use; bounded session records and revocation; authorization tests against wrong issuer/subject/audience/replay; local restart persistence. Independent review expiry race repaired with final-clock regression.
- [x] HTTPS-only OIDC discovery/code exchange and loopback HTTP login/poll/cancel/session adapter implemented; local tests/clippy passed. This does not close live login acceptance below.
- [x] Isolated real Dex HTTPS form/code-exchange acceptance: device/PKCE denials, single-use poll, durable session after restart, stable account, revoke and cancel. Tested CI source e47cdb3b/tree eeeca9f1; not a desktop browser UI or public deployment.
- [x] Bounded device identity signer: explicit stable keys, signature-verified P-256 CSR, server-controlled SAN/chain, fixed access/bootstrap/peer tokens. Separate durable device storage and identity REST authorization are implemented below; live integration remains open.
- [ ] Real Dex-backed browser login, delivery bound to requested device/instance, account-scoped membership and first-device enrollment.
- [x] Durable insert-only device owner and bearer-gated identity/state/challenge/current/certificate endpoints; real shared-client CSR/PoP/SPKI compatibility, one-use challenge, account isolation, restart persistence and cross-connection session revocation gate tested locally.
- [x] Live Dex-to-device endpoint acceptance on CI 38252528764: initial CSR enrollment and real signatures/certificates, duplicate denial, same-account read-only access, one-use PoP and wrong-proof denials, certificate renewal, durable restart and immediate session revocation. No desktop UI or public deployment is implied.
- [x] Owned desktop and Linux Host management base, encrypted app codec/admission/IPC, and explicit account/identity restore paths are integrated. The prior `b116404e` desktop acceptance covered model configuration save, disabled Agent creation, and Host restart; this merge still requires exact-tree CI and review. Fixed-reader no-prompt packaging remains excluded.
- [ ] Rotate/recovery/device revocation and full DPoP network admission parity.
- [x] Local metadata owner and HTTP adapter: authenticated account-scoped device registration/directory, membership/name CAS, durable mutation receipts and complete frozen pagination. DPoP validates the fixed service/issuer, actual method/path, key and live session/current generation; per-boot nonce rejects proofs across restart. Live metadata acceptance and zero-Agent routing descriptor remain open.
- [x] Bounded relay state machine with real signed access/peer-binding validation, exact current epoch/catalog ACK gates, opaque framing/credit and handshake/idle limits. It is now wired into the bounded WebSocket/controller adapter below; real desktop/Host acceptance remains open.
- [x] WebSocket control/controller state machine and durable public peer snapshots, signed dual-device pair bindings, bounded opaque TLS frames/credit/close, exact-epoch presence cleanup and failure cleanup. Real loopback clients cover Ready, pair/forward/close, revoke and replacement; native Linux deployment and desktop/Host acceptance remain open.
- [x] Desktop and Linux Host independently configured own-service login/network entry and encrypted management app codec/admission/IPC are integrated.
- [ ] Full remote configuration/credential write and persistent Agent matrix, including readback, denial and recovery beyond the cases explicitly tested above.
- [ ] Deterministic CI, source review, exact artifact provenance/main push, test deployment and real two-device acceptance.

Sources checked for the selected authentication components: Dex local connector documentation https://dexidp.io/docs/connectors/local/ ; Dex current release v2.46.0 https://github.com/dexidp/dex/releases/tag/v2.46.0 ; Rust openidconnect 4.0.1 https://docs.rs/openidconnect/4.0.1/openidconnect/ . These are integration choices; source presence or a running identity provider is not evidence that the full service works.

## Device identity acceptance boundary

The parent service has 24 local tests, device-core has 8, and identity-core has 7 including actual two-device mutual TLS. The HTTP identity integration uses a genuinely signed OIDC fixture through the verifier, actual DevicePrivateKey/CSR proofs and signer JWKS. Independent review identified and repaired an SPKI versus JWK fingerprint mismatch before delivery. Service revocation gates serialize issuance against another AuthStore connection; expiry is rechecked after locks. No desktop UI, public listener or official Host identity was changed by these checks.

Real isolated Linux identity acceptance used source cbf15ae7ec0ef5f554f8ade67d0e547641238aa4, tree 1d47f0c809a999fded7052af2b4071e8d3b7abdd (identical to the accepted PR #9 head and main merge). Binary SHA256: 7da49727e85dcfb6dc5d75a3d6b7b91607c8914ef44764b031e63359e26d4898. Eleven named behavior checks passed, including a service restart. Test services were stopped afterward; the existing official Host services and public listeners were unchanged.

## Network integration boundary

The optional network HTTP adapter rechecks signed access against a live AuthStore session handle and current DeviceStore generation/SPKI before each metadata operation. It never accepts self-reported principal/network/epoch authority. The metadata database owns CAS revisions, immutable mutation IDs/tombstones, and cursor snapshots. Catalog upload and online presence have no public HTTP shortcut: a real relay connection owner must supply its current server-generated epoch and durable ACK evidence. An empty, acknowledged catalog can mean zero Agents; an offline/unpublished device has unknown counts.

The standalone relay returns bounded effects; the future WebSocket owner must deliver those effects through bounded queues, invalidate affected connections on membership/session/generation changes, and close a channel if its opaque frame cannot be enqueued. It must sample fresh time after acquiring its owner lock. No relay, permit, return-route or remote-management capability is advertised by the current service. Product acceptance still requires owned login clients, real encrypted two-device transport, a human management grant, and Host-owned secret/configuration/Agent operations.

Client-source integration review found two handshake prerequisites missing from the initial standalone relay: opaque TLS must flow during Accepted before endpoint Ready, and canonical channel roles require Offers and separate Accepts on both peers. These were repaired before delivery. Eight relay tests now include actual ServiceKeys-issued device certificates, mutual TLS and bidirectional ChannelHello through Accepted opaque forwarding, both UUID open directions and dual acceptance. They do not prove a running WebSocket adapter.

## Relay HTTP/WS integration — 2026-10-13

The parent service composes identity, metadata, relay catalog/policy and WS through one production assembly helper. A real router smoke test caught and repaired duplicate fallbacks before deployment. Auth gates both channel endpoints in one transaction; PeerStore selects the exact signed issuance JTI; Metadata provides the current epoch and durable ACK; Runtime owns bounded connections/pairs/credits. An independent review identified a failed-Ready persistence window; controller now checks durable Ready on Open and immediately removes the exact runtime/core connection and emits cleanup on Ready persistence failure. The regression injects a real SQLite Ready-write failure.

Current routes do not create a public descriptor, hand login sessions to desktop/Host owners, or dispatch management to the Host Unixsocket. Those gates remain required and cannot be substituted by the relay tests. Official Host state/services and MyAgents sessions are preserved.
