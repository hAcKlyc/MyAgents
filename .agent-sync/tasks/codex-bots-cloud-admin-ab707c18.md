<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-cloud-admin -->
<!-- git-project-sync-task:base=2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: BOTS-CLOUD-ADMIN-001 unified authenticated Bots administration

## Objective

基于用户指定 MoXBots 现有云服务，实现平台管理员 Bots 管理；个人使用属于客户端Bots Net。此前仅原型限制已被用户的真实实现请求覆盖。独立工作树，保留其他任务和现网修复。

## Acceptance criteria

- [x] 本地实际AuthStore鉴权、普通身份拒绝、会话撤销、授权资源校验。
- [x] 私有SQLite管理登记CRUD/归属Host分配/删除恢复，CAS、原操作幂等与审计。
- [x] 真实Rust API浏览器fixture三个UI gate与primary独立关键路径复核。
- [x] PR20 exact-head 7项CI通过，main be48a22b 已包含成果且远端核实。
- [x] 用户明确授权首位测试管理员；已备份并升级现网、核验运行SHA和真实OIDC/admin API路径。
- [x] IAB独立标签页登录修复 BOTS-ADMIN-LOGIN-002 已发布，真实浏览器路径通过。
- [ ] Host有限委派与真实启停；跨用户共享/多账号执行另外验收。

## Completed

源码：admin_http/admin_store、admin-web、server接线、AuthStore最小账号投影；运维配置和执行边界见ADMINISTRATION.md。现网04fa的metadata-core/relay三个模块四文件修复原样保留，避免覆盖真实运行修复；未导入其他桌面/Host代码。完整阶段合同和执行接入提案位于services/agentnet/planning/。

## Verification

cargo test --locked（组合service73通过1忽略、metadata-core20通过）；clippy -Dwarnings、fmt、完整npm lint通过。新增手动test-only loopback fixture及版本化Playwright验收脚本；token不序列化，UI served/source hash一致。独立UI三gate通过，primary额外核验配置、分配清空、持久化与删除恢复。证据services/agentnet/validation/。这些检查不是现网OIDC或Host执行验收。

## Current state and next step

PR20已合入并发布。运行CI source2dec7655与main be48a22b完整tree相同，SHA2563a04ab08e02a21f4dd908239c6714d2e0e5d2d6befeecc7e55855936b3b5a8db已核验。Dex/Mori仍active；新管理SQLite0700父目录/0600文件及一致性备份通过。真实OIDC和授权停止态CRUD/CAS/幂等/持久化/软删恢复/退出后401通过；尚未验证真实普通账号（fixture普通403已过）。不保存实际账号/凭据到Git。

IAB未暴露popup页面，已另开BOTS-ADMIN-LOGIN-002补独立标签页辅助入口；该修复本地验收通过、待CI/main/发布。当前登记后台 start409明确未接执行；真实有限委派已获用户架构确认，由独立BOTS-CLOUD-EXEC-001继续实现。跨用户共享和收费模型调用不在已验收范围。原维护窗口已由Host owner释放，云端升级在主Agent单独窗口完成；不改桌面或101测试Host。

### 2026-10-13 — administrator release and real browser acceptance

PR20 plus PR22 are in remote main. Login source `60e3a52c08bf79d3985e1453449719269a35fb1a` passed seven exact-head checks; PR22 merge `1cfa2f85dc6c936c02b86f1f40945961665608a7` passed Owned AgentNet run38396057654. Its CI artifact11812672883 has verified API archive digest5198fa3f… and binary SHA256 `9b9320f57685a938cee53492eec412567df8076a273e7ef72a12a461ca5f06bc`; complete source tree matches that accepted main commit. Subsequent main documentation changes do not alter the deployed service.

The user explicitly authorized the existing integration test account as this instance's first platform administrator. The binary-only release preserved exact existing role/config and ingress hashes, stopped only the dedicated network service, created consistent private SQLite/state backups and retained the previous binary and rollback. Dex, Mori and Linux Host were not restarted. Runtime executable/source/hash and health were independently verified.

Real OIDC PKCE login through the in-app browser's independent sign-in tab succeeded. Authenticated UI create/configure and approved owner/Host selection succeeded, revisions persisted, and disconnected start was truthfully rejected. Actual API verification also passed original mutation replay, reload persistence, recoverable delete/restore and logout token revocation. Controlled drafts only; no model calls. Real ordinary-user production login and actual Host execution remain unverified; fixture ordinary403 is not substituted for production evidence. Private production evidence is under `/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/`; raw accounts, tokens, credentials and Host identifiers remain outside Git.

BOTS-CLOUD-EXEC-001 continues separately: protected owner opt-in, current Host source preservation, Linux gates and true Session lifecycle release are open. Shared usage remains future planning.
