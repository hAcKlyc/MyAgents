# MOXBOTS-PROJECT-BOARD-001 独立 UI / 代码审阅

审阅日期：2026-10-14。独立审阅者：`board_ui_review`（非实现者）。仓库分支 `codex/project-board-20261014`，基准 HEAD `43994b75`，审阅对象为未提交工作区；期间主 Agent 修改了状态翻译、等待触发标签与详情读取 generation fence，最终产品 revision 仍需主 Agent 固定并复验。

## 结论

未发现 P1；初审两个 P2 均已由实现者修复，并于 01:31（本机时间）在新源码、全新 Chromium context 独立复验通过。本次覆盖范围内无剩余阻断。已完成真实 React 组件的独立 Chromium 隔离审阅，不能据此宣布原生桌面或生产业务验收通过。

## 环境与证据

- 审阅服务 `http://127.0.0.1:5174/__board_audit`，生产 `GlobalSidebar`、`ProjectBoard`、`ProjectBoardDetail` 配合合成 Task/Session/API。
- 使用仓库已有 Playwright、缓存 Chromium headless shell 1243；未安装依赖、未操作用户浏览器/原生客户端，未部署或执行真实模型。
- 独立脚本、JSON 和截图位于 `/tmp/moxbots-board-review/`：`review.mjs` / `results.json`、`focus.json`、`error.mjs` / `activity-error.json` / `activity-error.png`、`acceptance.mjs` / `acceptance.json`，以及 `dark-{1440,1024,768,540}.png`、`light-{1440,1024,768,540}.png`、`light-detail-540.png`、`light-list-1440.png`。
- 初始 fixture middleware 未识别 `?light`，独立审阅以请求拦截方式仅取原 fixture HTML 并保留 light location；已告知主 Agent，主 Agent 报告新 run.mjs 已修正 pathname 匹配。该问题属于验收脚本，不计为产品缺陷。
- 已读取根 AGENTS.md、vendored git-project-sync、ai-yaoren-local 的 UI acceptance、任务记录和 DESIGN 字号/主题规则。仅写本报告；无产品源码修改。

## 实际执行结果

| 项目 | 结果与边界 |
| --- | --- |
| Task / Session 去重 | 6 Task + 1 未关联 Session；关联 alpha-1 不另建 Session 行。列表实际 7 行。 |
| 状态语义 | 阻塞/等待答复归需要处理；verifying 待验收；done 已完成；空闲会话留其他组，不当完成；已启用 schedule 无 executionState 显示等待触发。源码 freshActivity 超过 60s / error 时归未知。 |
| 搜索 / 筛选 / 回程 | 独立输入“项目管理”、需要我筛选、验收草稿，在 fixture 原会话占位页返回后保留。真实 App 跳原会话 owner 路径只做代码审阅，未做原生联调。 |
| 验收失败 | 模拟 status 更新失败后，alert 可见且“独立验收输入保留”未丢，返回看板继续保留。未对真实 Task 写入验收状态。 |
| 开始执行失败 | 合成 taskRun 抛错后 alert 显示“执行失败（模拟）”，调用记录仅一次。未调用实际任务执行或模型。 |
| 8 组主题与宽度 | dark / light 各 1440、1024、768、540；documentWidth 等于 viewportWidth，无整页横向溢出。主信息、任务卡片、分组、按钮和详情可读；不等于全量 WCAG 认证。 |
| 窄屏分组 | 540/768 内容区使用可展开分组，四组状态可见；待开始入口与列表可定位任务。 |
| 键盘 | 打开详情时关闭按钮获得焦点；可见 focus 样式存在。窄屏背景焦点隔离已修复；Shift+Tab 首尾循环、15 次 Tab 全在详情内，Escape 关闭后回原卡片，见 PB-UI-01。 |
| 状态错误 | taskRun/status 失败可见；activity 故障已显示失败数和具体原因，关联 Task 详情亦可见；恢复刷新后 alert 全清，见 PB-UI-02。 |

## 缺陷

### PB-UI-01 — P2：窄屏覆盖详情后仍可聚焦背景内容（已修复并独立复验）

- 环境：fixture，light 540×900；同 CSS `@media(max-width:700px)` 形态适用。
- 复现：打开 `task:task-blocked` 详情；从自动聚焦的关闭按钮按 Shift+Tab，或正向 Tab 越过“重新执行”，继续 Tab 到侧栏/被覆盖的看板元素。
- 预期：覆盖形态中被遮挡的看板不可聚焦；详情内操作和可见导航可用，Escape 可可靠关闭详情并回原卡片。
- 初审实际：详情为 absolute overlay，但背景没有 inert 或焦点约束。独立 Tab 序列越过详情进入侧栏 rail 浮层，Escape 优先关闭该浮层，详情仍存在；焦点未回原卡片。继续键盘导航可作用于视觉被覆盖的看板。
- 影响：键盘用户丢失操作位置，可能触发看不见的背景操作；不是视觉截图能识别的问题。
- owning source：`ProjectBoard.tsx` 的 `.pb-content` / selected detail；`ProjectBoardDetail.tsx` 初始焦点、Escape；`ProjectBoard.css` 窄屏 `.pb-detail` overlay。
- 证据：`focus.json` / `results.json` 的 narrow detail tab sequence 与 Escape return focus、`light-detail-540.png`。
- 建议：仅覆盖形态为背景看板设置 inert，或实现与形态相符的焦点约束；桌面并排详情不必强制全局 modal trap。修复后复验 Shift+Tab、长 Tab 序列、Escape、鼠标关闭、打开原会话及返回。

### PB-UI-02 — P2：会话状态查询失败被吞为未知，关联任务失败数量也不可见（已修复并独立复验）

- 复现：仅拦截合成 `mock.ts` 模块，将 `apiPostJson` observe 改为 throw `会话状态查询失败（独立故障注入）`；打开未关联 alpha-2 详情。
- 预期：明确提示快照查询失败、失败数量/原因及刷新恢复路径；不把未查询/过期与请求失败合并成无法诊断的提示。
- 初审实际：`useProjectBoardData.ts` 将异常保存到 `ActivitySnapshot.error`，但 ProjectBoard / Detail 不消费 error。卡片/详情仅“执行状态未知”，无 alert，footer 仍“会话状态查询于…”。所有 2 个会话查询均失败，unknownCount 仅计 1 个未关联会话，关联 task 的失败未显示。
- 影响：用户无法辨别空闲、快照过期与 owner/API 故障；初审时任务记录要求“快照时间和失败必须可见”未满足；修复后已满足。
- owning source：`useProjectBoardData.ts` catch / activity map，`ProjectBoard.tsx` unknownCount 与 footer，`ProjectBoardDetail.tsx` error rendering。
- 证据：`activity-error.json` / `activity-error.png` 现为修复后复验结果；初审 alerts=[] 表现已由审阅者当时通报主 Agent。
- 建议：失败数按实际 activity.error 统计，包括已关联会话；给出可读失败提示和刷新按钮；选中会话显示具体失败原因。继续用未知状态，不能伪造 idle 或完成。

## 修复后的独立回归

- 新源码新增 `useBoardOverlay`，窄屏 `.pb-content` inert 与详情 Tab 首尾循环。关闭按钮 Shift+Tab 回“重新执行”；正向 15 次 Tab 全保持在详情；Escape 后等 rAF，focus 为 `task:task-blocked`。鼠标关闭、run 失败、列表仍可用。
- activity 故障注入改为可切换 flag：2 个失败会话（包括关联 Task）进入全局 role=alert；未关联会话与关联任务详情均显示具体故障原因；将模拟 API 恢复再点击刷新后 alert 数为 0。继续保持未知状态，不伪造运行状态。
- 修复后重新执行 8 组 dark/light 视口与列表语义、验收失败草稿/搜索/筛选回程；无 pageerror，证据 JSON/截图已更新为复验结果，前述缺陷实际表现为初审历史。
- 复验范围未扩大到原生客户端或真实后台；仍需主 Agent 固定最终提交 SHA，并运行其主干/构建/发布门禁。

## 未验证门禁

原生安装、真实 TaskStore/Sidecar API、实际 App 页签恢复、权限、跨工作区/归档真实数据、真实写入与持久化、真实业务执行和生产发布未验证。本报告的模拟任务状态变化不证明真实后台成功。review artifact 应随产品最终 revision 固定；两项修复的独立回归已关闭，真实门禁继续由主 Agent 追踪。

## 执行记录

单个独立审阅 worker，约 10 分钟内完成初审与 1 轮修复回归；主 Agent 实现和整体验收，worker 只写报告。未调用 AIRouter 或真实模型任务；当前 worker 的精确模型、token 与费用无工具实测，未知。独立故障注入与键盘序列发现了截图检查不能揭示的两项问题；下一次代表页验收应预先包含 overlay Shift+Tab 和关联会话 activity 故障。

## Rail 入口追加回归

实现者最后仅将 `GlobalSidebar` renderTree 的 `onOpenProjectBoard` 包装为打开后 `closeFlyout()`。独立使用新 Chromium context、540×900 验证 rail→Agent 工作区→Alpha 看板图标与“更多→项目看板”两个入口：看板可见，flyout 均收起（DOM count=0）。图标入口前后 Alpha 展开状态均 false；菜单入口前后均 true，没有将打开看板混同项目展开切换。

原有“在此工作区新建对话”按钮保留、可点击，点击后按既有行为收起 flyout，Alpha 展开状态仍 true。fixture 的 `onOpenWorkspace` 为合成成功回调，因此本项只证明入口和旧回调/展开行为不受这次包装改动影响，不能证明原生 Session 实际创建。源码中该包装仅作用于 `onOpenProjectBoard`，未改 `onToggle` / `onOpenWorkspace`。

证据 `/tmp/moxbots-board-review/rail.mjs`、`rail.json`、`rail-final.png`。追加回归通过；当前独立审阅覆盖内无待修 P1/P2。既有真实门禁保持未验证。
