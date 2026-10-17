<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/release-058-delivery-record-20261017 -->
<!-- git-project-sync-task:base=ec9eb610a6472af44b390d49967d2aa9588f2447 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-058-COMMUNITY-RELEASE-20261016 — 交付记录

## Objective

目标：将冻结12449源码的实际签名/公证、同源隔离原生与真实社区验收、最终自有服务分发事实及限制写回main。只改交付文档，不改变冻结源码或已生成制品。

## Acceptance criteria

- [x] 用户指定 canonical Git、干净独占记录分支；他人修改不动。
- [x] 冻结12449正式签名、公证、自有签名及精确实物独审。
- [x] 同源隔离UpdaterQA真实更新与ModelQA实际社区路径独审，保留正式Runtime未测边界。
- [x] 自有服务器唯一完整外部GET、实际stat/hash、正常TLS、自有签名及17原件独审。
- [x] 同任务CAS原子stable058、公开小型复验、发布后独审与own-lock finish；057完整回退保留。
- [ ] 正常PR/CI/main合入与远端包含核验由发布owner继续，Git ref为最终事实。

## Completed

正式0.5.8更新分发已发布并核验，tag v0.5.8冻结12449。仅交付记录变更合并最新main85b1d2be（后续产品源码不进058包），没有新的产品代码或制品重建。详细范围/摘要见 `dev-docs/releases/moxbots-0.5.8.md`。

## Verification

Root聚合9cd63dd0与独审6a8134ca绑定67原件+Root收据；外部GET独审1c244e19，实际完整336365173B/TAR155e6a68/正常TLS/118909Bps，公钥验签通过；发布后独审012f22b2与Root逐项hash复核，随后server-finish实际通过。源tag远端peeled12449。文档diff --check通过；纯记录变更不重复运行产品测试，仓库CI照常执行。

## Blockers and unknowns

生产分发已完成。正式binary/Reader没有运行，日常客户端0.5.7未升级；QA截图导航浮层、IME/ASR/真实Host模型等限制如实保留。最终记录PR/CI/main尚待本分支正常流程，不能把工作分支当主干交付。

## Next step

提交本次最终记录、推送并创建PR，CI通过后正常merge，核实远端main包含记录和冻结source/tag；更新私有最终交付回执并关闭本聊天heartbeat。不得再次start/collect/promote、重打同版或操作日常客户端。
