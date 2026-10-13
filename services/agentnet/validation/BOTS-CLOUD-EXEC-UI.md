# BOTS-CLOUD-EXEC-001 合成 UI 验收

验收时间：2026-10-13（本机）

范围：`http://127.0.0.1:5199` 合成浏览器 fixture；最终验收使用独立 headless Chromium；未访问真实 Cloud、Host 或模型。前期 Safari 观察未作为通过证据，也未复用用户 Chrome 或生产登录。

## 结果

Playwright headless Chromium 对实际 served 页面完成了合成 Owner 授权与 Bot 生命周期路径。fixture 使用真实 AuthStore、DPoP、签名、队列及回执处理；Host/SDK 的执行反馈由 fixture 模拟，因此这不证明真实 Host 进程、Linux 持久化或模型调用已经接通。

关键合成身份：管理员/Owner `e9eeca3d-1f46-4d31-a47f-0dc61e0276c7`；Bot `ab851dba-1548-48c6-8ffd-de7394eb33c0`；Host `33fa19cc-0929-47fd-bba0-96ce83476625`；模型引用 `f45343bc-bcb1-453a-a603-a7caa52e48b7`。bootstrap 中 Owner、Host device、scope 和 Bot allowlist 均精确匹配。

验证结果：

- Owner grant、Host create/configure、Host 启动请求和回执、disable、Host delete、Owner revoke ACK、fresh grant、restore 均走页面及原始 API。界面把 `idle + admission open` 显示为“Host Session 未启动 · 准入开放”，没有标成 running；disable 后回执为 `stopped + closed`，restore 后为 `idle + closed`。
- 暂停 Host 命令期间，原 mutation ID 保持稳定，pending 状态阻止新编辑器和额外写请求；恢复后收到原操作结果。CAS conflict 返回 `REVISION_CONFLICT`，界面显示新 revision 与当前 Host 状态。
- unconfirmed 回执保留原 mutation ID 与 pending 状态，并阻止新的配置操作和 POST。该用例作为最后一条 mutation 运行；当前 fixture 留有这一合成 pending 状态。
- 将测试页本地 `Date.now` 前移 31 秒后，页面显示“Host 状态未知”，并禁用 Host 创建和启动。fixture 服务时间及 Host observation 未修改；这是 freshness 客户端保护测试，不是 Host 离线实测。
- 独立合成登录回归：退出返回 HTTP 204，旧 session 访问 bootstrap 返回 401；普通用户登录留在管理权限拒绝页，bootstrap 返回 `403 ADMIN_REQUIRED`。Bearer 仅在测试进程内存中使用，未输出。
- 1440×900、768×1024、390×844 三种 viewport 均无页面级横向溢出。768px 的数据表保留内部横向滚动提示。对话框初始焦点、必填校验、Escape 关闭均通过。三张实际 served 页面截图已人工检查。
- 浏览器无 page errors。

## 复现

Node 24 与已安装的 Playwright Chromium：

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH \
CHROMIUM_EXECUTABLE='/Users/zhangshaohua/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
node services/agentnet/validation/scripts/execution-ui-smoke.mjs
```

身份与登出撤销的独立回归也通过：`DELETE /auth/session` 返回 204；同一旧 Bearer 的后续 bootstrap 返回 401；ordinary principal 返回 `ADMIN_REQUIRED`。该手动隔离用例的浏览器身份为 fixture 合成账号。现有 `auth-retest.mjs` 对 `/admin` HTML 做逐字节静态 hash 校验，而 5199 fixture 会插入测试 banner，因此该现成脚本不能用于此 fixture；本次改用新隔离上下文按真实页面路径验证。

页面截图（临时目录，非源码制品）：`/var/folders/34/45h5k_sd5z134tmnzl7499n00000gn/T/execution-ui-MYMHbv/`。

served `app.js` SHA-256：`a4d7e0e07139239f84c841b6c493aba90e34ac449a865822b6eb0c13813e654b`；served `styles.css` SHA-256：`385d9902fde417c8195864dbc5fcdb36991928be9eb78a463b10bfde2c58a5dc`。两者与工作树 UI 源文件一致。HTML 含 fixture banner 注入，不按原文件逐字节比较。

本轮没有做 Linux Host 集成、生产认证、真实设备签名账户验收、模型调用或付费调用；相关成本/Token 用量未知。

## Primary integration review

Primary inspected actual mobile and desktop evidence and verified the owner entry against the current served fixture. Manual refresh then confirmed scope/whitelist consistency; the earlier generic warning did not establish an allowlist defect. Real production OIDC/admin UI acceptance is tracked by BOTS-ADMIN-LOGIN-002 and is not used as Host execution evidence.

The preserved Host baseline later required two concurrency repairs: consistent registration-intent before supervisor order and shared atomic config patching. New integration tests cover concurrent projections and lock completion. Native management keeps same-principal pairing and a separate Bot IPC; private credentials do not enter the cloud/UI.
