<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/ui-zoom-scrollbar-20261016 -->
<!-- git-project-sync-task:base=1c13a06877846da03f9a1c3d9f00dac4e10e7828 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-UI-ZOOM-002 修复缩放后输入框横向滚动条

## Objective

修复用户截图中Ctrl+放大后输入框出现横向滚动条的问题。只调整SimpleChatInput的文本域/建议文字的横轴策略与grid收缩约束，不改缩放快捷键、字号档位、业务状态或版本。单Agent负责实现和整体复核，零子Agent。

## Acceptance criteria

- [x] 输入区禁用横向滚动；长URL换行且文本值不变。
- [x] 多行输入达到高度上限后仍能纵向滚动；建议文字不撑宽输入区。
- [x] Chromium真实组件60组布局回归，107项输入/IME/建议/保存/快捷键回归与完整类型检查。
- [ ] WebKit布局回归及最终构建；结果以PR验收回执及浏览器metrics为准。
- [ ] CI/远端main交付；客户端安装与真实原生缩放由统一发布聊天另验。

## Completed

原文本域只设置overflowY:auto，浏览器计算overflowX:auto；缩放时允许显示水平滚动条。文本域及ghost显式overflowX:hidden，保留overflowY:auto；grid轨道为minmax(0,1fr)，文字项可收缩。脚本`scripts/verify-chat-input-zoom.mjs`使用真实组件、现有快捷键和合成数据，在844/520宽、75/100/110/125/150/200%检查空输入、执行中空输入、长URL、多行及建议五种状态。

## Verification

`vitest`六个相关测试文件107/107通过；`npm run typecheck`通过，修改文件ESLint和diff检查通过。Chromium153.0.8010.12的60组布局通过。使用现有官方Playwright浏览器缓存的独立headless实例，不复用用户Chrome或登录数据；WebKit测试环境准备中。

修复前检查读到横向auto（断言失败），该结果证明策略缺口，不冒充已在真实安装App复现。几何/输入/纵向滚动及截图证据见`dev-docs/ui-zoom-scrollbar-acceptance.md`和PR更新。

## Blockers and unknowns

已冻结发布的055/056不可变；补丁排入下一未冻结批次，不回写既有包。本任务不启动/退出/安装日常或QA客户端，不操作签名、版本、服务器与真实业务数据。浏览器CSS缩放不等于实际WKWebView page zoom，原生验收保留未完成。

## Next step

完成浏览器/CI并交付main后，由统一发布owner选取包含本补丁的main，在独占原生窗口检查用户截图场景、长文本、纵向滚动和恢复默认。

## Deployment request

- Required / status: required，queued；待代码/CI与main交付，不表示已发布或已通知。
- Owner: 统一部署聊天`01a12bc2-907a-7702-b6dd-788225c5dfe4`；按main计划的Deployment coordination，不在本聊天执行部署。
- Target: 既有macOS arm64 MoXBots own updater下一未冻结批次；Ctrl+放大后输入框无横向滚动条，长文仍可上下滚动。
- Source: `codex/ui-zoom-scrollbar-20261016`及本任务记录，发布owner解析最终合入main的SHA。
- Dependencies / migration: 浏览器布局/CI/main完成后由owner整体打包；无新依赖、配置、持久化schema或迁移，不扩大权限。
- Acceptance / rollback: 页面检查与原生用户路径分开；由owner按既有包级备份/回滚流程处理，不热改已发布055/056。
