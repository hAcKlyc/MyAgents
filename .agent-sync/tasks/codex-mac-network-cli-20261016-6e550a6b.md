<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mac-network-cli-20261016 -->
<!-- git-project-sync-task:base=b1001048bc5877ccaae0ab7af137cd94b2ddbde2 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-MAC-NETWORK-CLI-20261016

## Objective

用户授权为 Mac 客户端补充命令行登录/恢复 Bots 网络，复用原设备身份，完整测试并合入 https://github.com/heavenzhang/MoXBots.git main。源码/测试/main范围；明确不发布/更新/重启日常客户端。独立worktree基线b1001048，主Agent负责Rust owner、集成/验收/main；network_cli_surface独占TS CLI/server及测试，network_cli_security_review独立只读安全审查。无外部模型调用、无生产/凭据操作。

## Acceptance criteria

- [x] 核实际仓库/clean base/main；独立分支start/task-init通过。
- [x] 六个命令复用原CLI enable/token、Sidecar capability/generation准入；无新进程/服务/授权旁路。
- [x] login仅既有Owned connection/revision，原principal/device/trust/key/membership/selection；无新设备或key轮换；不接受密码/issuer等覆盖参数。
- [x] restore后台读取原session/key；typed failure不降级、不迁移凭据、不影响ready actor；保留取消/并发边界。
- [ ] Rust原生测试、真实CLI→Sidecar→Management loopback、既有回归、独立审查、CI全部通过。
- [ ] 正常PR/main合入，核remote ancestry/tree；记录不发布/不触碰日常客户端的边界。

## Completed

接口合同与操作说明dev-docs/mac-network-cli.md。TS相关445项单测/loopback通过，typecheck/定向lint通过；独立审查发现并修复composition漏登记、readonly初始化后迁移、CLI登录重入membership。已将native network/cli测试追加到既有macOS CI job；本机Swift工具链PackageDescription链接错误留证，不把受阻运行算通过。

## Verification

本机测试日志只放项目pointer output/mac-network-cli-20261016，提交摘要见acceptance文档。系统Node22不符合engines；使用App内置Node24仅作编译/测试工具，不启动App。Rust Mac check的DOCS_RS只跳过无关Swift native依赖构建，不能算native运行；完整native tests由真实macOS CI执行，仍pending。

## Blockers and unknowns

不涉及已冻结056包或057发布；无任何部署请求。真实账号、OS钥匙串、签名原生包及生产ready未在本任务操作，不能冒称通过；代码/模拟联调/native CI/main分别列证据。日常PID48419保持，未重启、安装或改profile/权限。

## Next step

完成Rust检查/原生回归与独立复核，提交阶段成果并跑PR exact-head CI，再正常集成最新main。
