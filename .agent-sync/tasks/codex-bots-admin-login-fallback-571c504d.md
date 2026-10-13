<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-admin-login-fallback -->
<!-- git-project-sync-task:base=be48a22b9eef0130bbf0f3c7e24fdcf1e52e8576 -->
<!-- git-project-sync-task:status=complete -->
<!-- git-project-sync-task:scaffold=false -->

# BOTS-ADMIN-LOGIN-002: independently reachable OIDC sign-in

Scope: administrator cloud sign-in fallback; no Host execution or role expansion. Canonical repository https://github.com/heavenzhang/MoXBots.git.

- [x] Preserve existing popup flow and in-memory PKCE/token state; visible validated independent-tab link and explicit cancellation.
- [x] Loopback actual AuthStore login/admin regression, inaccessible/null popup, cleared link/cancel/re-login; 390/768 layout/focus.
- [x] Primary source and real in-app-browser regression review; syntax/ESLint/diff checks.
- [x] Exact-head CI and main delivery.
- [x] Replace accepted cloud artifact preserving current roles/state and backup; real in-app OIDC/admin path.

Stage1 registry main: PR20 / be48a22b9eef0130bbf0f3c7e24fdcf1e52e8576, deployed CI source2dec765597dbe95a628797a590ba218d8f579f0e has the same complete source tree. Existing cloud service artifact SHA2563a04ab08e02a21f4dd908239c6714d2e0e5d2d6befeecc7e55855936b3b5a8db verified; private consistent backup and rollback preserved. User explicitly approved the existing test principal as first platform administrator. Real OIDC + admin API CRUD/CAS/replay/soft-delete-restore/logout revocation passed with controlled stopped drafts, no model calls. Original popup remains unverified in IAB; this fix closes that UI gate after deployment.

Evidence: services/agentnet/validation/{BOTS-CLOUD-ADMIN-UI.md,scripts/login-fallback-smoke.mjs}; current cloud-specific private records under /Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/. Credentials/account IDs stay outside Git. Cancel smoke uses a bounded fixture shim because manual fixture omits cancel route; actual service cancel semantics retain existing backend tests.

Execution: ai-yaoren-local only. Primary owns integration/main/deployment; cloud_backend_impl requested gpt-6-luna/medium owns fallback plus regression, actual runtime/effort and token/cost unknown. Existing Stage1 independent UI review and primary review retained; no external model calls. One narrowly scoped repair adds a missing UI path discovered during production acceptance; no claims of cost savings.

Next: accepted-head CI/main then controlled existing-service upgrade and real browser acceptance. BOTS-CLOUD-EXEC-001 remains a separate active worktree/task; shared usage remains future planning.


### 2026-10-13 — administrator release and real browser acceptance

PR20 plus PR22 are in remote main. Login source `60e3a52c08bf79d3985e1453449719269a35fb1a` passed seven exact-head checks; PR22 merge `1cfa2f85dc6c936c02b86f1f40945961665608a7` passed Owned AgentNet run38396057654. Its CI artifact11812672883 has verified API archive digest5198fa3f… and binary SHA256 `9b9320f57685a938cee53492eec412567df8076a273e7ef72a12a461ca5f06bc`; complete source tree matches that accepted main commit. Subsequent main documentation changes do not alter the deployed service.

The user explicitly authorized the existing integration test account as this instance's first platform administrator. The binary-only release preserved exact existing role/config and ingress hashes, stopped only the dedicated network service, created consistent private SQLite/state backups and retained the previous binary and rollback. Dex, Mori and Linux Host were not restarted. Runtime executable/source/hash and health were independently verified.

Real OIDC PKCE login through the in-app browser's independent sign-in tab succeeded. Authenticated UI create/configure and approved owner/Host selection succeeded, revisions persisted, and disconnected start was truthfully rejected. Actual API verification also passed original mutation replay, reload persistence, recoverable delete/restore and logout token revocation. Controlled drafts only; no model calls. Real ordinary-user production login and actual Host execution remain unverified; fixture ordinary403 is not substituted for production evidence. Private production evidence is under `/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/`; raw accounts, tokens, credentials and Host identifiers remain outside Git.

BOTS-CLOUD-EXEC-001 continues separately: protected owner opt-in, current Host source preservation, Linux gates and true Session lifecycle release are open. Shared usage remains future planning.
