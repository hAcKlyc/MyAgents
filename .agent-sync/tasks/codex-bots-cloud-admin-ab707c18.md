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
- [ ] 远端CI、合入最新main、推送并核实远端主干包含成果。
- [ ] 第一位平台管理员权限确认、现网备份回滚、串行升级、真实OIDC/账号路径验收。
- [ ] Host有限委派与真实启停；跨用户共享/多账号执行另外验收。

## Completed

源码：admin_http/admin_store、admin-web、server接线、AuthStore最小账号投影；运维配置和执行边界见ADMINISTRATION.md。现网04fa的metadata-core/relay三个模块四文件修复原样保留，避免覆盖真实运行修复；未导入其他桌面/Host代码。完整阶段合同和执行接入提案位于services/agentnet/planning/。

## Verification

cargo test --locked（组合service73通过1忽略、metadata-core20通过）；clippy -Dwarnings、fmt、完整npm lint通过。新增手动test-only loopback fixture及版本化Playwright验收脚本；token不序列化，UI served/source hash一致。独立UI三gate通过，primary额外核验配置、分配清空、持久化与删除恢复。证据services/agentnet/validation/。这些检查不是现网OIDC或Host执行验收。

## Blockers and unknowns

现有云目标与安全访问已经核实，正在与现有Host owner协调维护窗口；本任务不在该窗口中重启云服务。首位平台管理员尚未授予，不从Host所有权推定管理权限。真正Host执行需要controller/delegation契约和架构确认；目前start明确409拒绝，stop只关准入。共享/模型费用及生产验收未完成。模型运行元数据和token/费用未知。

## Next step

查看当前Git/CI状态；提交本任务记录并同步最新main，遵守CI与远端交付门禁；在授权和维护窗口明确后复验现网基线、备份/回滚并串行发布。真实执行按BOTS-CLOUD-EXECUTION-V1.md讨论，不用SSH写Host状态替代用户路径。
