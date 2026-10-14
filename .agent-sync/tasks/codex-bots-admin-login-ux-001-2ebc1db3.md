<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-admin-login-ux-001 -->
<!-- git-project-sync-task:base=d86f7505f641ecbe6d136142c11422ef063ea0e5 -->
<!-- git-project-sync-task:status=in-progress -->


# Task: BOTS-ADMIN-LOGIN-UX-001 同页中文管理员登录

## Objective

修复云后台弹窗登录造成的双窗口割裂：当前标签页登录、固定同源返回、中文统一品牌。仅现有认证链路 UI/跳转，不新增账号、权限或认证 owner。

## Acceptance criteria

- [ ] 当前标签页跳转登录并返回 /admin，成功加载既有管理员目录；不创建弹窗。
- [ ] 错误、取消、浏览器返回、刷新及过期可恢复，普通账号依旧 403。
- [ ] PKCE/device/state 绑定及单次消费保持，临时事务仅 tab-scoped；bearer 不落盘、不入URL。
- [ ] 中文登录页面 390/768/1440 布局、键盘与交互检查通过。
- [ ] 聚焦测试、独立只读审阅、CI、main 合入及远端核查。
- [ ] 云端备份/回滚、源码对应、真实管理员登录/退出复验。

## Completed

- 基线与 origin/main d86f7505 已核实；隔离工作树 start gate PASS。
- 主 Agent 实现/集成/发布；login_ux_review 只读审阅，requested gpt-6-luna/medium，实际模型及用量未知。

## Verification

- 代码：已实现；模拟：服务89测试+新browser_return单测、Python5测试、clippy、真实AuthStore loopback同页登录/取消/过期/退出撤销/普通用户403通过，弹窗0；真实联调/生产：待验证；提交/main：待交付。

## Blockers and unknowns

- 当前没有新增授权需求；使用既有受控测试账号，禁止模型调用及 Bot/账号业务写入。

## Next step

- 运行同页登录、返回和中文模板验收，CI 后发布。
