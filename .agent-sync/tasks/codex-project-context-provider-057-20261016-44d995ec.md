<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-context-provider-057-20261016 -->
<!-- git-project-sync-task:base=c225acd830513eb50736f75718f559a9ebda17bc -->
<!-- git-project-sync-task:status=ready-for-review -->

# Task: MOXBOTS-PROJECT-CONTEXT-001 真实Provider验收与057交接

## Objective

补齐 MOXBOTS-PROJECT-CONTEXT-001 真实Provider联调：同项目新会话自动知道其他会话的重要进展和决策，跨项目隔离及关闭开关；将结果交唯一统一发布会话并明确纳入0.5.7。沿用已合main的产品源码，不改日常客户端、不并发发布。

## Acceptance criteria

- [x] 核实main c225acd8、clean独立分支、已授权Kimi配置存在且0600，不回显凭据。
- [x] 无真凭据本地预检：真实SDK init与实际请求tools/MCP为空，独立HOME和OS网络约束有效。
- [x] 实际SessionEngine/facade/adapter/SDK/持久化/Provider链路完成源会话和三条新会话路径。
- [x] 同项目回答含源会话随机决策、模型生成进展编号及“尚未发布”；跨项目/关闭开关wire与回答均无泄漏。
- [ ] 提交脱敏证据、相关检查、CI及远端main；发送固定交接给统一发布会话。

## Completed

既有产品实现PR68已合远端main c225acd830513eb50736f75718f559a9ebda17bc，候选六CI通过且tree一致。本轮新增手动验收入口，仅使用临时合成项目和已授权Kimi Coding/k3；不增加生产路由、权限或模型回退。已通知统一发布会话用户指定0.5.7，当前冻结056保持不变。完整结果见dev-docs/project-context-validation/provider-acceptance.md和provider-results.json；四个进程组清理后为空。实际相同提问开启/关闭输入差641 Token，仅此样本，不冒充固定费率。

## Verification

无真凭据预检通过；最终源/同项目/异项目/关闭4次真实请求均200/complete，独立复核通过。前置2次源请求虽成功但脚本/格式验收失败，保留不算通过；本轮共6次真实请求。读取原SessionStore、产品Facade自动准备，不手工拼接背景；关闭使用atomicModifyProjects并由独立新进程重读。逐请求保存私有wire、上游和持久化证据；只提交脱敏摘要和哈希。原生UI、HTTP/Rust生命周期、其他Runtime真实模型及正式发布不在本轮通过范围。

## Blockers and unknowns

真实Provider三路径与独立复核均通过，待本轮证据提交的CI/main收尾。正常桌面完整原生生命周期及安装后验收仍交统一发布会话，真实facade后台联调不替代它们。

## Deployment request

用户明确要求放到0.5.7。唯一发布聊天01a12bc2-907a-7702-b6dd-788225c5dfe4「MoxBots桌面端统一打包负责人」负责既有macOS arm64渠道；本功能及验收记录queued到057，不加入冻结056。无新增服务、凭据、数据库迁移。需先核对远端main/CI及本次真实证据，再完成正式签名包、原生新会话/设置持久化和发布验收。关闭projectContextEnabled仅阻止未来注入，不删除已发送上下文；包回滚遵守既有发布owner流程。

## Next step

提交脱敏脚本/证据，等最终候选CI后合入并核验远端main，固定SHA交唯一发布会话0.5.7。最终CI/main/发送回执记录在PR和统一发布会话，不为勾选再改变已测源码。
