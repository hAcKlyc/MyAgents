<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/release-057-network-20261016 -->
<!-- git-project-sync-task:base=b1001048bc5877ccaae0ab7af137cd94b2ddbde2 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-057-NETWORK-RELEASE-20261016

## Objective

用户于2026-10-16在入网修复聊天01a1420f-245b-7f22-8a0f-4caaaf31b91b明确回复“授权发送并安排修复版”；本聊天实际核读human message01a142d4-9285-7c93-a968-52d61de5ab7d。安排下一未冻结0.5.7，保留055/056不可变，以既有own updater/Developer ID/公证/Reader/锁串行推进。不改云服务、Host、权限或公网范围；确认任务空闲且Mac手动解锁后才启用，不停止运行任务。

## Acceptance criteria

- [x] 实际仓库/sole owner/人类授权/主干b1001048及版本命名空间核对，clean独占worktree新任务分支。
- [ ] 057版本元数据和发布记录正常PR/七CI/main交付，固定正式SHA；后来main不混入。
- [ ] 完整正式native构建（不使用DOCS_RS或stub、不改系统工具链）、Reader/endpoint/公钥连续、Developer ID/Apple Accepted/staple/Gatekeeper和独立验包。
- [ ] 正常TLS完整公网GET/stat+hash/自有签名独审、原056回滚包完整、同锁CAS/备份/fsync/原子stable及公开复验；原生门禁未满足时保留候选而不宣称修复已上线可用。
- [ ] 新配置sessionBound的启用前兼容配置私有备份及新旧凭据槽保留、恢复配置而不回滚业务数据的回退准备。
- [ ] fresh完整活动准入、确认空闲及手动解锁后启用；实际新账号session/identity登记/membership/relay ready/目录/既有scope可调用路径和同账号恢复/旧身份保留逐项复验。
- [ ] 最终代码/main、正式制品、服务器发布、客户端启用及真实入网分别记录；未验边界与接续落盘。

## Completed

基线main b1001048bc5877ccaae0ab7af137cd94b2ddbde2，包含PR81入网恢复及此前已交主干057队列：Project Context/Provider记录、Host引导/兼容、默认关闭主备模型、缩放横滚动修复和输出时间/质量参考。当前只推进版本与记录，不修改这些产品实现；既有服务器认证与网站元数据不重新部署。记录dev-docs/releases/moxbots-0.5.7.md。

## Verification

来源delivery.json报告PR81候选cb8eff17、mainb100同tree及七CI通过；Root将独立核对。源码测试/合成JoinNetworkDialog不是签名原生或实际入网。正式构建可复验既有任务私有SwiftPM兼容wrapper，只在task-local副本移除不匹配private interface，系统库/public interface不变；若当前环境不符即阻断，禁止DOCS_RS发布。

## Blockers and unknowns

实际客户端代次/活动/配置路径、当前锁屏和新账号实际网络状态均待fresh核对；历史PID/包版本不能当空闲。没有通过签名包安装、真实identity/membership/relay/目录/可调用路径，不宣布入网恢复。PB004及真实Provider/其他Runtime边界继续独立追踪，不用模拟状态或付费调用凑验收。

## Next step

通过版本/协调PR后固定主干源码并正式构建签名公证。并行准备只读回滚和验收合同，不动日常App；真实启用严格等待空闲/手动解锁/兼容配置备份门禁。
