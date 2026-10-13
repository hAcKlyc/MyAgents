<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-admin-login-fallback -->
<!-- git-project-sync-task:base=be48a22b9eef0130bbf0f3c7e24fdcf1e52e8576 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# BOTS-ADMIN-LOGIN-002: independently reachable OIDC sign-in

Scope: administrator cloud sign-in fallback; no Host execution or role expansion. Canonical repository https://github.com/heavenzhang/MoXBots.git.

- [x] Preserve existing popup flow and in-memory PKCE/token state; visible validated independent-tab link and explicit cancellation.
- [x] Loopback actual AuthStore login/admin regression, inaccessible/null popup, cleared link/cancel/re-login; 390/768 layout/focus.
- [x] Primary source and real in-app-browser regression review; syntax/ESLint/diff checks.
- [ ] Exact-head CI and main delivery.
- [ ] Replace accepted cloud artifact preserving current roles/state and backup; real in-app OIDC/admin path.

Stage1 registry main: PR20 / be48a22b9eef0130bbf0f3c7e24fdcf1e52e8576, deployed CI source2dec765597dbe95a628797a590ba218d8f579f0e has the same complete source tree. Existing cloud service artifact SHA2563a04ab08e02a21f4dd908239c6714d2e0e5d2d6befeecc7e55855936b3b5a8db verified; private consistent backup and rollback preserved. User explicitly approved the existing test principal as first platform administrator. Real OIDC + admin API CRUD/CAS/replay/soft-delete-restore/logout revocation passed with controlled stopped drafts, no model calls. Original popup remains unverified in IAB; this fix closes that UI gate after deployment.

Evidence: services/agentnet/validation/{BOTS-CLOUD-ADMIN-UI.md,scripts/login-fallback-smoke.mjs}; current cloud-specific private records under /Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/. Credentials/account IDs stay outside Git. Cancel smoke uses a bounded fixture shim because manual fixture omits cancel route; actual service cancel semantics retain existing backend tests.

Execution: ai-yaoren-local only. Primary owns integration/main/deployment; cloud_backend_impl requested gpt-6-luna/medium owns fallback plus regression, actual runtime/effort and token/cost unknown. Existing Stage1 independent UI review and primary review retained; no external model calls. One narrowly scoped repair adds a missing UI path discovered during production acceptance; no claims of cost savings.

Next: accepted-head CI/main then controlled existing-service upgrade and real browser acceptance. BOTS-CLOUD-EXEC-001 remains a separate active worktree/task; shared usage remains future planning.
