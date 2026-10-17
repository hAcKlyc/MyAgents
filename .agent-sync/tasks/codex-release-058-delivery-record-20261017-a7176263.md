<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/release-058-delivery-record-20261017 -->
<!-- git-project-sync-task:base=ec9eb610a6472af44b390d49967d2aa9588f2447 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-058-COMMUNITY-RELEASE-20261016 — 交付记录

目标：将冻结12449源码的实际签名/公证、同源隔离原生与真实社区验收、最终自有服务分发事实及限制写回main。只改交付文档，不改变冻结源码或已生成制品。

- [x] 确认用户指定 canonical Git、实际main、干净独占记录分支；旧共享构建工作树的他人修改保留。
- [x] 完整制品/自有签名/Apple Accepted及独立验包。
- [x] 同源隔离UpdaterQA和ModelQA真实路径，Root与独立原件复核。
- [x] 自有服务器stage不可变058；stable仍057。
- [ ] 完整外部GET/独审/验签、原子stable和公开复验。
- [ ] 记录提交、PR/CI、main合入与远端包含核验。

详见 `dev-docs/releases/moxbots-0.5.8.md`。生产正式binary/Reader未运行、日常客户端未升级，QA导航浮层/IME/ASR/Host等限制保留。当前外部完整下载进行中；下一步只在完整证据通过后promote，不改变或退出日常客户端。
