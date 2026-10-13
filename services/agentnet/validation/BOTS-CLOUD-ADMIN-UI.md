# BOTS-CLOUD-ADMIN-001 UI 验收报告

## 当前结论

**三项验收门均通过，范围限于本地 test-only fixture；不代表生产登录、发布或用户验收。** Visual、interaction、actual UI/API gates 均有当前编译版本的浏览器证据及服务端行为证据。先前的登出/revocation与窄屏交互问题已经分别通过 fixture 修复和 RWD 编译版本复验；早期版本的未通过记录保留在“历史轮次”中，不构成当前阻断。

验收运行在 loopback `http://127.0.0.1:5198/admin`，使用 test-only same-origin PKCE 登录流程、真实 Rust `AdminService`/`AuthStore` 与临时 SQLite。身份、Host、模型引用、Bot 及说明均为合成测试数据；不保存 bearer 或浏览器会话，不代表生产 OIDC 登录或真实 Host 执行。

**登录 fallback 追加验收（2026-10-13）：** 仓库 `/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin`，分支 `codex/bots-admin-login-fallback`，验收工作区基于 HEAD `be48a22b9eef0130bbf0f3c7e24fdcf1e52e8576`。test-only fixture session 15922 的 served assets 与本次工作区源码逐字节 hash 相同：

- `services/agentnet/admin-web/index.html`：`fc37c7b324d9450261243475ec908b16ceed8afef26a6aed8ca08a7669e2f5ce`
- `services/agentnet/admin-web/app.js`：`37579285d1769e650cc1824dc00b424ec933c6308ad91f4807a3f0eb427b0046`
- `services/agentnet/admin-web/styles.css`：`3922947162d9c35ba36a54d83ef01bcbf8a19461f91bd864b0e014ba21dbf759`

Fallback 浏览器回归确认 `window.open` 返回非 null 但未产生可见 popup 时，用户仍可在独立标签页打开服务端已校验的同源授权 URL，并通过 fixture 的真实 start/poll 与 `AuthStore` 完成管理员登录。另覆盖 `window.open` 返回 null、取消后链接清理以及随后重新登录；取消请求本身由 Playwright test shim 响应，因为当前 Rust 浏览器 fixture 没有 `/auth/login/cancel` 路由，因此本项只证明浏览器清理和发出取消请求，不证明服务端取消事务。390×844 与 768×1024 下登录页及 fallback 链接均无横向溢出，登录按钮和链接键盘焦点轮廓可见；截图保存在本次 smoke 输出临时目录。现有 `auth-retest.mjs` 同轮复验：logout 204、已撤销 bearer bootstrap 401、普通身份 bootstrap 403 `ADMIN_REQUIRED`。这些是本地 fixture 结果，不代替主审进行的生产 OIDC 验收。

## Gate 1 — Visual / responsive：通过

在 1440×900、768×1024、390×844 检查登录和已登录管理页。三种视口下 document/body 宽度均未超过 viewport。768px 的表格显示横向浏览提示；390px 的 Bots 列表转换为卡片，管理按钮可见。视觉复核未发现页面级横向溢出。编辑器可在手机视口内滚动。

截图：`screenshots/login-{1440x900,768x1024,390x844}.png`、`screenshots/final-admin-{1440x900,768x1024,390x844}.png`、`screenshots/final-editor-390x844.png`、`screenshots/final-populated-390x844.png`。当前 populated 截图含多条此前运行留下的合成 QA Bot，不是生产数据。

## Gate 2 — Interaction / keyboard / touch reachability：通过

- 键盘 Enter 可激活“用户”导航；Escape 可关闭编辑器。
- 在 768px 从“刷新”开始按 Tab，5 次到达标记为“Bots 列表及管理操作”的区域；该区域显示 3px 实线焦点轮廓。
- 在触屏启用的移动视口，390px 卡片中的“配置”“分配”“关闭准入”“删除”均可见、可点击并打开对应编辑界面；“新建 Bot”也完成实际点击和创建。
- 删除后在回收站点击“恢复”并提交，bootstrap 确认 Bot 已恢复。

本轮对“分配”和“关闭准入”只验证可达并打开界面，随后取消；这两个移动端点击没有提交 mutation。本报告的真实分配与关闭准入结果见下方 actual UI/API gate 和独立主流程证据。

## Gate 3 — Actual UI + Rust API behavior：通过（fixture 范围）

当前及前序桌面浏览器运行中验证了以下实际服务端行为：

- 管理员 test identity 登录，bootstrap 读取真实服务端目录；创建停止态 Bot 草稿并持久化。每日额度填 `0` 时表单保留值且没有请求写入；修正后保存成功。
- 模型/提示词配置与刷新后读取成功；说明中的 XSS 样本以文本显示，没有创建图片节点或执行脚本。
- 未知 mutation 结果场景中，浏览器请求被转发到真实服务端提交后，仅丢弃响应。UI 保留原 mutation ID、关闭编辑器并可直接查询原回执；原回执确认写入，未创建新 ID 重复提交。
- Start 返回 HTTP 409 `HOST_EXECUTION_NOT_CONNECTED`，后续 bootstrap 未显示 running。
- 未授权的用户/Host 配对返回 HTTP 403 `RESOURCE_ASSIGNMENT_FORBIDDEN`；草稿、选择和管理员会话保留，服务端 owner 未改变。允许的分配将 Bot 转至合成普通用户与 Host B，并清除原提示词/模型引用；之后授权配置持久化。
- CAS 冲突返回 HTTP 409 `REVISION_CONFLICT`，本地编辑值保留，服务端较新值未被覆盖；刷新编辑状态后可再次保存。
- 写入成功但随后 bootstrap 刷新失败时，界面报告“写入已确认、刷新失败”，未误报为未决写入；后续刷新读回持久化值。
- 停止对话框明确表示关闭准入不代表 Host 进程已停止。错误名称删除返回 HTTP 409 `NAME_CONFIRMATION_REQUIRED`；正确名称删除及恢复均持久化，恢复后仍为停止态。新登录从 SQLite 读回 Bot 状态。
- 当前 fixture 中管理员登出发出 `DELETE /auth/session`，返回 HTTP 204；同一内存 bearer 再请求 bootstrap 返回 401。普通身份实际 bootstrap 返回 HTTP 403 `ADMIN_REQUIRED`，管理台仍隐藏并显示权限提示。
- BR02 名称边界与服务端拒绝属于 backend 测试证据：非法名称 HTTP 400 `INVALID_BOT_NAME`；60 字中文/trim 名称及原始请求 hash 回放按主流程结果验证。服务端测试结果由 primary 汇总；本 UI 报告不另行推导数量。

另有 primary 独立主流程验收：创建、配置、启动被拒绝、分配并清空旧配置、刷新后持久化、精确名称删除及恢复均完成。以上为 test-only Rust fixture 行为，不是生产账户或生产服务验收。

## 实现范围与限制

Sharing 与真实 Host execution 尚未实现。测试证明后台准确呈现执行未接入，不会把登记成功、关闭准入或配置完成误称为实际 OS 执行状态。生产 OIDC/真实用户身份、真实 Host 启停、共享执行、生产发布及生产用户验收不在本验收范围。

模型、推理档位和实际用量没有可核验的运行时元数据，因此记录为未知。

## 历史轮次与纠正记录

以下仅保留为版本演进和问题闭环证据；当前状态以本报告开头 hash 和三个当前 gate 为准。

- 初始 core run 使用 `app.js=170fe4d687bf784cdfb3a074283a47bf552100779108b5be8e10bb0e9a777a39`、`styles.css=0432034e6dae2d30114b55512bf80237bdeef1f8e1a4dcb6c316819551b3acd1`。当时 test fixture 的 `DELETE /auth/session` 返回 404、旧 token 仍可用；键盘/触屏可达性也未测试。这是当轮 fixture/验收缺口，不能套用为当前状态。
- 初始核心业务路径完成后，primary 更新了 test-only auth route 和移动端布局。后续 fixture 12896 中 logout=204、撤销 token bootstrap=401、普通身份 bootstrap=403 `ADMIN_REQUIRED`，详见 `auth-retest.mjs`。
- RWD/BR02 编译版本使用本报告开头的 `975c798c…` app 与 `0dec267e…` CSS。fixture 72891 复验三视口、键盘、390px 按钮触达及 auth。旧 `admin-empty-*` 截图来自更早的单 Host fixture 和 app hash `f69201d…`，不作为当前验收证据。

## 可复现材料

外部 QA 目录：`/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-qa/`

- 浏览器核心业务路径：`run-fixture.mjs`
- auth/revocation 与 ordinary-user 拒绝：`auth-retest.mjs`
- RWD、键盘与手机操作：`rwd-final-smoke.mjs`
- 当前截图：`screenshots/`

脚本只在进程内暂存测试 bearer，不序列化 token/session；脚本输出和截图只含合成测试数据。


版本化复现入口与代表截图见 [validation README](README.md)。报告中的base HEAD是验收时已有提交；新增工作区源码通过三文件hash绑定，不能把base HEAD误认为本功能提交。
