# 0.5.5 modelqa 接线独立审阅

任务：`MOXBOTS-055-UNIFIED-ACCEPTANCE`。审阅者：`updater_qa_review`。日期：2026-10-15。

本阶段仅审阅 integration 工作树的 Root 新增路由、renderer 入口与 runtime policy/launcher 接线。开始时 HEAD 为 `430e499db37ce3ffccae7818da682381faebb3e9`，加本轮未提交接线 diff。没有重复审阅 NEXT 已独立验收的内部实现；初次审阅时 Title 尚未合入，第四轮已追加复核，见下文。

仅写本文，没有修改源码、提交、操作 GUI、调用模型/SSH/Keychain、读取指定隔离 HOME 的 config/auth 内容或访问日常应用数据。

## 结论和后续

- [x] exact path/method/profile 的 composition 与 dispatcher 使用同一 `isModelQaRoute()`。
- [x] 非 modelqa profile 的目标 GET/POST/DELETE 不进入能力路由；modelqa 无 token/错误 token 在 lazy import/handler 前返回 401。
- [x] 原生 `apiFetch → globalSidecarFetch → global_sidecar_http_request` 保留 path/method/body，Rust loopback owner 追加自己的 internal token；GET/POST/DELETE 均已有支持。
- [x] runtime policy 仅生成两个明确 executable env 名和明确无凭据 loopback HTTP proxy env；不生成 PATH、不允许任意 env/args/未知 runtime 字段。CLI 要求 canonical physical executable 和 SHA-256 相符。
- [x] 独立 8 项 build scripts 与 11 个额外合成 policy 负例通过。
- [x] 四 profile、两种 Sidecar role 的 160 个路由/auth 探针通过，见证据边界。
- [x] Title handler/page 合入后复核组合接线、focused 测试与实际源码组合探针；完整源码构建由 Root 独立执行，不冒充已构建原生包。
- [x] Root 已处理 brand merge 冲突；第四轮 `git diff --check` 通过，审阅者未改冲突文件。
- [ ] 原生 UI、真实模型、真实 owned-cloud/Linux Host 及生产发布仍归各 owner 串行验收，本阶段未执行。

在已检查范围内未发现新增 P1/P2；第四轮已通过 Title 组合代码复核，仍不能据此宣称完整构建或 native 验收通过。

## 路由和原生代理依据

`src/server/modelqa/routes.ts` 同时限制编译 profile、精确路径和方法，并先调用既有 timing-safe internal credential matcher。Bearer 或外部 CLI 权限不能替代 Rust process-lifetime token。`sidecar-composition.ts` 只对该函数认可的路径授予 common，不新增宽泛 `/api/modelqa/` prefix。非目标方法、相邻路径、尾斜杠和子路径均不可达。

生产 OPTIONS 仍走既有通用 CORS 204，而非开放 modelqa 能力。测试中的 production 404 结论针对目标 GET/POST/DELETE 及错误业务方法。

renderer query 参数仅在编译 modelqa 分支选择 Home/Next/Title；其他 profile 仍加载原 App。Rust 主窗口 modelqa 默认进入独立入口。页面的 `apiFetch` 走现有 Global Sidecar command，原生代理不允许 renderer 选择任意控制 URL，也没有新 HTTP 代理权力。尚未合入的 Title page 不计编译通过。

## 独立执行结果

运行时为 Codex bundled Node `v24.19.0`。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `node --test scripts/build-moxbot-modelqa.test.mjs scripts/build-moxbot-updaterqa.test.mjs` | 8/8 | profile/launcher/runtime manifest 配置及负例；无原生构建 |
| 临时 Node runtime policy probe | 11/11 | 未知顶层字段、未知 runtime、额外 args、非 canonical path、带凭据代理、非 HTTP/低端口/path/query 代理均拒绝；合成 CLI 未执行。非回环地址另由上一行既有脚本测试覆盖 |
| 编译 profile routing/auth probe | 160/160 | 真 composition、dispatcher、internal-token matcher；四 profile × Global/Session，目标方法无/错/正确 token，相邻/错误路径方法 |

路由探针用 esbuild 在内存编译，将 NEXT/Title handler 替换为只返回 synthetic Response 的 fixture，并将不会调用的 management client 替换为抛错 fixture。没有网络、App 或模型执行。它证明实际门禁和分派行为，不证明内部 handler、Rust IPC、真实凭据或 native UI。首版 harness 因捆绑 undici 的 VM process 字段不全而初始化失败；隔离不用的 management client 后 160 项通过，前次没有进入目标路由，不计产品失败或通过。

## 状态边界

先前 modelqa profile 的 P1 授权恢复与 P2 路径/异步撤销修复，见前一工作树的 `dev-docs/modelqa-independent-review.md`。Root 报告 Rust release namespace/backend 三项已实跑通过；本阶段没有自行复跑 Rust，也未据此扩大原生验收状态。

最后执行 `git diff --check` 时工作树处于 Root 的在途 brand merge，`.agent-sync/plan.md` 为 UU，含冲突标记；已通知 Root。这不是 runtime 漏洞，也不是可忽略的最终交付状态，合并结束后需重验。

## 第四轮：Title 接线与取消/持久化

检查时 HEAD `82981aed2f17f73ac0eceeab0015eaa80ea2abfd`，已包含 TITLE `7f4a1b97` 与品牌合入，加 Root 接线 diff。独立复跑结果：

| 测试 | 结果 | 边界 |
| --- | --- | --- |
| `modelqa/title.integration.test.ts` | 28/28 | 合成配置与生成器；真实 handler、临时 receipt IO、授权/取消/完成竞态 |
| `ModelQaTitle.test.tsx` | 8/8 | DOM 与 mock API；明确点击、DELETE、等待 POST 终态、完成赢竞态、卸载取消 |
| `title-generator.unit.test.ts` | 18/18 | utility SDK options/AbortController/晚到句柄关闭，SDK 为 spy |
| `sidecar-composition.unit.test.ts` | 139/139 | 既有 common/global/session 边界回归 |
| `git diff --check` | 通过 | brand merge 冲突已解决 |

共 **193 项**，未调用真实模型。另以内存 esbuild/VM 组合实际 `routes.ts + sidecar-composition.ts + title.ts`，只替换配置/生成器及不会调用的 management/NEXT owner，独立验证：

- 无 token 401 先于 config 读取；合法 internal token 经 Global composition 到实际 Title handler。
- 合法固定 fixture 生成后临时 receipt 可读取；完成后 DELETE 返回 completed。
- 未知输入字段及 GET 查询拒绝；active DELETE 202 确实使传给真实 title owner 的 signal aborted；晚到成功返回 499，旧 receipt 字节保持。
- receipt 指向已有外部合成文件的链接在 GET/POST 均 503，外部字节不变。dangling receipt link 在 GET 被视为无记录，成功写入通过 `wx` 随机临时文件与 rename 替换 QA 自身链接，未创建外部目标；没有跟随链接写入漏洞。未把这点误称为一律拒绝 dangling receipt。

源码取消链为：UI 显式 DELETE → 原生 Global proxy 保留 query/method 且追加内部 token → handler 精确 requestId controller.abort → `generateTitle(..., signal)` → utility 自有 controller → SDK query 的 abortController/关闭清理。单纯 JS AbortSignal 无法中断 Tauri invoke 的限制已由显式 DELETE 处理；原生是否真正关闭进程、是否恢复可用，还须 native 验收，不以本链路推断为已通过。

Provider 授权只从 `.moxbot-modelqa` 的显式 allowlist 选择 API provider/model：禁订阅/远程 cloud-session、禁 endpoint/credential source、要求有效非空 key 与 HTTPS 无 URL 凭据，固定合成输入，HTTP body 不接受 prompt/key/baseUrl/runtime。GET 不泄露 key 或 endpoint。同步 receipt 提交后 active 清理与 DELETE 的 completed 分支避免成功被误称取消；失败/取消不覆写前一结果。

第四轮的 Request/DOM/静态检查未发现其他 P1/P2。随后 TITLE owner 的真实 `@hono/node-server` wire 复现揭示一个此前未覆盖的取消阻断：没有 payload 的 DELETE 仍可能有空 ReadableStream，`req.body !== null` 会误拒绝 400。**当前不能关闭 wire cancellation 缺口或作完整阶段通过结论**；等待精确修复 SHA，补实际空 body 与真实 payload 区分及对应 wire 回归。A1 不能用于最终取消验收，Root 准备 A2。

此前 193 项和组合探针只证明各自 Request/DOM/mock 层，未经过 Hono wire，不倒填真实取消通过。完整 typecheck/lint/build 仍按 Root 实际结果记录；原生 App、真实模型/Host、收费任务、Keychain 和生产发布没有由本审阅执行或扩展为通过。
