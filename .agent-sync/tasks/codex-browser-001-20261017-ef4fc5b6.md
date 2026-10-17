<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/browser-001-20261017 -->
<!-- git-project-sync-task:base=348251b3ce990dfbd0e0888d140477c6ed353f83 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-BROWSER-001

## Objective
补齐随 App 升级的浏览器操作 Skill；让用户从对话工具菜单发现、安装、开启和选择 Agent 浏览器；以实际浏览器操作验证路径。

## Acceptance criteria / To Do
- [x] 核实权威仓库/main/隔离工作树与发布owner；base 348251b3。
- [x] Skill 自动发现及版本化同步，真实工具与 CLI 合同准确。
- [x] 未安装、下载中、失败、已就绪、未全局启用与对话选择入口可用；不冒充连接成功。
- [x] 相称回归、类型、lint、构建与实际页面交互；独立审查。
- [x] 真实浏览器导航、快照、输入、点击、截图、关闭/新会话持久化结果，区分合成authority与真实账号/模型。
- [ ] CI、合入main并核实远端包含成果。
- [ ] 发布由唯一owner串行承接；生产与真实安装验收分开记录。

## Completed
隔离分支创建；主Agent负责界面/系统同步/集成验收，browser_skill独占 bundled-skills/moxbots-browser 与 myagents-docs 的两份浏览器reference。既有Token/模型权限不扩大。

## Verification
源目录和远端base核实；start/task-init gate PASS；531项定向测试、TypeScript、eslint与MoXBots web构建通过；quick_validate用真实PyYAML通过；真实Provider与锁定Chromium及新SessionCookie恢复通过（测试替身Rust authority）。证据记录在 dev-docs/browser-001/acceptance.md；私有/大制品放本地MoxBot/output/browser-001-20261017。

## Deployment request
Required: macOS arm64 desktop, next unfrozen release. Sole owner 01a12bc2-907a-7702-b6dd-788225c5dfe4; no release takeover, frozen artifact modification or daily App restart. This task may build isolated candidates for acceptance. No cloud/Host/API exposure change or migrations. Preserve existing browser identity state; rollback via prior signed app with compatible config.

## CI repair

PR https://github.com/heavenzhang/MoXBots/pull/100 。首轮JS CI发现验收脚本7处lint，Rust1697通过/1失败，原因旧版本断言60未同步；已修脚本和版本61断言，新增optional Skill断言。完整本地lint及原生fmt复核，等待修复头完整CI。

## Blockers and unknowns
正式发布/当前原生会话与完整真实账号验收未完成；不把组件/loopback测试当生产验收。

## Next step
提交/推送、CI及main集成；之后由唯一发布owner接续原生安装与正式用户路径验收。
