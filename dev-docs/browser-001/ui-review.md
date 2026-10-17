# MOXBOTS-BROWSER-001 独立 UI 审阅

复核日期：2026-10-17
审阅范围：最新浏览器入口、状态 hook、设置页状态恢复、`initialMcpId` 深链 effect，以及当前任务 diff。Codex IAB surface 在本任务不可用（此前 `cua.getBrowser({ id: "iab" })` 返回 `Browser is not available: iab`，surface inventory 无 IAB）；未使用 Chrome/Brave，也未接管用户标签。因此本次未独立操作页面、未复测合成 UI 路径。主 Agent 报告其 IAB 已验证 happy path、失败重试和 unsupported；这不是我的独立观察。

## 结论

- **P1：未发现。**
- **P2：未发现当前仍存在的缺陷。** 上一轮发现的状态请求竞态已在源码中修复：设置页启动请求时保存 `browserResourceObservationRef`，失败时仅当期间没有接收到更晚的资源状态事件才设置读取失败。有效 owner event 会增加观察计数并清除失败标志，旧请求的 reject 不会覆盖较新的状态。对应 DOM 回归测试覆盖“事件先到、旧读取后 reject”，断言失败文案不出现且浏览器开关保持可用。证据：[SettingsPage.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/pages/settings/SettingsPage.tsx:1042)、[SettingsPage.browserResource.dom.test.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/pages/settings/SettingsPage.browserResource.dom.test.tsx:156)。
- 首次状态读取语义一致：`null` 表示读取中，`undefined` 表示读取失败，`BrowserResourceStatus` 表示已观测状态；hook 失败时保留已接收的有效状态。对话入口将读取失败明确指向设置页，设置页在失败时显示重试操作，并阻止此时开启尚未开启的托管浏览器。unsupported 状态不显示安装/重试资源操作。证据：[useBrowserResourceReady.ts](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/hooks/useBrowserResourceReady.ts:12)、[BrowserToolEntry.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/components/chat-input/components/BrowserToolEntry.tsx:47)、[ToolboxSection.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/pages/settings/sections/ToolboxSection.tsx:219)。
- 可选建议：无 `progressPercent` 时目前展示 2% 静态进度条，可能被看作卡住；可改为不定进度样式或等百分比有效后显示。此项不影响状态正确性，列为视觉建议。证据：[ToolboxSection.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/pages/settings/sections/ToolboxSection.tsx:357)。

## 深链与状态语义

`initialMcpId` 对可编辑 MCP 仍进入原配置流程；托管浏览器这类不可编辑资源则在卡片出现后滚动并 focus 卡片，不调用配置对话框。卡片未渲染时 effect 返回，`activeSection` 更新后重试。命中目标后 `notifySectionChange` 通过 generation 匹配消费对应的 `navigationIntent`；意图清除后 effect 不再重复执行。新增 DOM 测试直接断言卡片获得焦点且没有通用 MCP dialog。源码和测试中未发现 `activeSection` 依赖导致重复消费、错误打开 dialog 的路径。该判断基于源码与 DOM 测试，不是 IAB 运行观察。证据：[SettingsPage.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/pages/settings/SettingsPage.tsx:2287)、[tabModule.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/features/capabilities/tabModule.tsx:32)、[App.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/App.tsx:4591)、[SettingsPage.browserResource.dom.test.tsx](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/src/renderer/pages/settings/SettingsPage.browserResource.dom.test.tsx:147)。

对话入口的“connected”表述仍要求有效 MCP snapshot 为 ready 且非 stale；资源 ready 没有被直接当作会话已连接。卡片开关有 switch 角色、名称、`aria-checked` 与 busy 状态，资源状态以 status 区域展示，窄布局改为单列后在中等宽度以上恢复双列。当前 diff 的 CLI 项目级 browser selection 复用互斥 helper，只改变项目 enabled list；新增 admin handler 测试覆盖双向互斥且全局列表不变。未发现上述代码引入 P1/P2。

## 运行证据边界与未完成验收

我只核验了脱敏 receipt 的允许字段：Provider+Browser 运行记录包含 `browser_navigate`、`browser_type`、`browser_click`、`browser_take_screenshot` 调用，HTTP 状态均为 200，terminal 为 complete，second session 成功且报告 cookie 恢复。receipt 同时标明 `nativeUI=false`、`production=false`、`rustAuthority=synthetic`；因此这证明的是该 Provider/Browser 运行路径，不证明原生 UI、真实 Rust authority 或生产验收。对应截图 [model-receipt.png](/Users/zhangshaohua/Documents/Codex/2026-10-17/moxbots-browser/dev-docs/browser-001/model-receipt.png) 显示接受结果页，不是浏览器入口 UI 状态截图。

主 Agent 报告新增的 hook 恢复、设置页 DOM race/deep-link、重试与 unsupported、项目级互斥测试均通过；我检查了测试源码但未独立运行测试。IAB 不可用，所以未独立覆盖未安装→设置→安装进度→模拟完成→全局开关→对话开关、失败重试、unsupported、键盘焦点、窄宽和深色外观。当前审阅不能替代这些独立 UI 观察或真实生产验收。
