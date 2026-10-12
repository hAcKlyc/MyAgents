# MAH-SELFHOST-SERVICE-20261012

Goal: deploy an independently owned AgentNet service including browser login, device identity, zero-Agent discovery, encrypted relay, and desktop-to-Host configuration. This service does not require access to the upstream author's private server or official account credentials.

Current base: fork main 1d2c806e2700cd70804a1174f27b6ec23acdca68. Service worktree/branch: myagents-selfhost-service / feat/mah-selfhost-service. Existing official desktop/Host enrollment is preserved. Implementation, deterministic integration, real two-device acceptance, main delivery and deployment are separate gates.

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
- [ ] Authentication foundation: durable account mapping; PKCE/nonce transactions with expiry/single use; bounded session records and revocation; authorization tests against wrong issuer/subject/audience/replay; actual restart persistence.
- [ ] Real Dex-backed browser login, delivery bound to requested device/instance, account-scoped membership and first-device enrollment.
- [ ] Identity/CSR/PoP/DPoP/JWT endpoints and revocation/rotation parity with existing clients.
- [ ] Metadata owner, CAS receipts and current zero-Agent device routing descriptor.
- [ ] WebSocket control state machine, signed pair binding, bounded opaque TLS frames/credit/close and no uncertain write replay.
- [ ] Desktop and Linux Host independently configured own-service login/network entry and encrypted management app codec/admission/IPC.
- [ ] Remote model configuration/credential write and real persistent Agent creation from desktop, readback, restart, denial and recovery.
- [ ] Deterministic CI, source review, exact artifact provenance/main push, test deployment and real two-device acceptance.

Sources checked for the selected authentication components: Dex local connector documentation https://dexidp.io/docs/connectors/local/ ; Dex current release v2.46.0 https://github.com/dexidp/dex/releases/tag/v2.46.0 ; Rust openidconnect 4.0.1 https://docs.rs/openidconnect/4.0.1/openidconnect/ . These are integration choices; source presence or a running identity provider is not evidence that the full service works.
