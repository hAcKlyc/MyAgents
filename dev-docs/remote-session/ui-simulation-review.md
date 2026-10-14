# REMOTE-SESSION-IMPLEMENTATION-20261015：独立组件界面验收

2026-10-15（Asia/Shanghai）。结论：**本地模拟组件路径通过**，发现的主要按钮文字对比度问题由 UI owner 修复后复验通过。不能据此宣布真实远程或完整 App 验收完成。

审阅者是 Host worker，未实现或修改生产 Renderer。使用独立 Playwright headless Chromium（本机缓存 build 1243），未使用用户 Chrome、已有登录会话或公网服务。

## 范围与运行程序

实际 `src/renderer/features/remote-session/RemoteSession.tsx`、实际 renderer API 校验、实际 CSS/theme/i18n；临时 `.remote-acceptance.tsx/.html` 仅提供模拟 Tauri invoke 与合成快照、回执、Tab binding。所有请求、消息、设备与审批均为合成数据，不含真实业务或凭据。临时 harness 不提交。

两种 viewport 为 **1280×900** 和 **390×844**。证据请求记录与源码文件摘要见 [ui-simulation-evidence.json](ui-simulation-evidence.json)。首轮 harness 的错误 i18n 导入、缺少 color-scheme 以及测试 Vite HMR proxy 500 已排除；仅最终 fresh-server 无错误截图作为验收证据。

## 流程与截图

| 步骤 | 检查内容与结果 | 1280 宽 | 390 宽 |
| --- | --- | --- | --- |
| 1 | 历史列表与新会话输入可见；输入后发送可用，通过 | [初始](01-initial-1280.png)、[首条输入](01b-first-message-1280.png) | [初始](01-initial-390.png)、[首条输入](01b-first-message-390.png) |
| 2 | 首发发出 `start`，真实组件收到 accepted 后调用 `onBound(session-test)`；Tab 转为现有会话并读取快照，通过 | [批准请求](02-approval-1280.png) | [批准请求](02-approval-390.png) |
| 3 | 点击“仅允许这一次”；请求携带 Session、generation、turnId、requestId、permission 与 approved=true，之后审批卡消失，通过 | 同步骤 2 取证，请求见 JSON | 同步骤 2 取证，请求见 JSON |
| 4 | 续写发出同 Session 的 `send`；模拟新快照 actionable=false 后批准禁用、拒绝仍可用；拒绝发送 approved=false 并清理卡片，通过 | [不完整请求/拒绝](03-followup-1280.png) | [不完整请求/拒绝](03-followup-390.png) |
| 5 | “停止这一轮”发出精确 generation/turnId；收到模拟 stopped 快照，停止按钮消失、正文与状态均为停止，通过 | [停止](04-stopped-1280.png) | [停止](04-stopped-390.png) |
| 6 | 新会话入口返回列表，再点击历史行；同 session-test 的历史与停止状态恢复，通过 | [历史恢复](05-history-restored-1280.png) | [历史恢复](05-history-restored-390.png) |

所有截图逐张打开检查；无空白、裁切错误或加载覆盖。每个宽度的最终运行均 **pageerror=0、console error=0**；document scrollWidth 与 viewport 同宽，无横向溢出。

## 视觉、响应式与可访问性

- 已修复：普通 button 的 `text-[var(--ink-secondary)]` 与 primary text utility 冲突，导致黑底深灰字。UI owner 拆分样式后，启用的批准和发送按钮均为 `rgb(255,255,255)` / `rgb(17,17,17)`、opacity=1，按 sRGB 相对亮度公式计算对比度约 **18.9:1**。
- 1280 宽批准按钮 y=409.56、高37；输入框 y=727.05、高81.56。390 宽批准按钮 y=458.56、高37；输入框 y=671.05、高81.56。批准、拒绝与输入均在视口内；手机宽度停止按钮换行可见。
- 非阻断改进：390 宽标题下的设备/Agent 身份行发生 ellipsis，长身份不完全可见。建议在窄布局保留完整设备名或提供可访问的展开信息。此项不影响本轮审批、续写或停止操作。
- 已检查实际 DOM 的输入 label、按钮名称、禁用条件与 section aria-label；没有以截图宣称完整 WCAG、屏幕阅读器或触屏键盘验收。

## 尚未覆盖

完整 App 的 AgentNet 入口、真实 TabWorkspaceController、Tauri 原生壳、真实认证与设备加密传输、远端原 SessionEngine、真实持久化与模型调用、断线/账号切换/接纳未知恢复、长 transcript 与真实计划/问题交互均不由此模拟证明。实际请求的安全与业务正确性仍须后端测试和真实双端联调验收。
