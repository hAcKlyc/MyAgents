# MOXBOTS-SIDEBAR-ORG-001 独立 UI 审阅

Owner：sidebar_ui_review（未实现产品源码）。范围：MoXBots 正式 GlobalSidebar、SidebarOrganizationControls、SessionContextMenu 的源码审查和独立浏览器行为验收。未操作生产、安装包、真实账号、模型、用户 Chrome 或真实业务数据。

## 环境与复现

仓库任务分支 `codex/sidebar-organization-20261013`，起点 `e976726355918cd37fa832641028c84b78786234`。初轮验收版本为 `15b11ab98e3e135925bfb2592ac4085be2b0b03e`（2026-10-13T22:30:28.944176+08:00 完成复验）；七个产品 source SHA256 见 `sidebar-organization-validation/source-hashes.json`。实现、主干提交与安装由主 Agent 独立追踪。

使用项目已安装 Vite + Playwright 与本机现有 headless Chromium 1243；没有下载新框架或浏览器。fixture 真实加载产品组件、i18n、主题与 CSS，只有配置、session 元数据及业务 service 以精确 Vite alias 替换。3 个 Agent、6 个 session 均为合成 `/synthetic/` 标识；独立 browser context / localhost origin，拦截外网请求。fixture 是验收支架，不是产品或静态原型。

```sh
MYAGENTS_BUILD_PROFILE=moxbot node dev-docs/sidebar-organization-validation/run.mjs --check
```

可用 `SIDEBAR_AUDIT_CHROMIUM` 指定已有 headless executable。`--serve` 提供仅 loopback 的持久页面，主 Agent 已用 IAB 独立复核；默认脚本结束关闭自己创建的 browser/server。

证据：`sidebar-organization-validation/results.json` 每个用例保存实际动作后的 localStorage 和导航 callback；`*-round.txt` 留下真实 drag 坐标、结果和复现；`initial.png`、`organized-1280.png`、`rail-900.png` 为相应页面。拖拽全部使用真实 mouse move/down/move/up，键盘用例使用 Space/Arrow/Escape，没有调用内部 handler 或伪造 DragEndEvent。

## 发现及修复复验

- UI-001：创建空分区后，在 Alpha 内将第二条任务拖向第一条任务行，`closestCenter` 将其移入空分区。已由实现者改为按拖拽类型与原 Agent 约束的碰撞，缩短 workspace header 命中矩形，并优先 pointerWithin 行；同路径上下排序与跨区拖拽复验通过。原失败截图 `failure-2.png`、`failure-3.png`；修复结果见后续轮次日志。
- UI-002：将任务拖到其他 Agent 标题，排除该 Agent droppable 后，root 容器仍将其恢复到原 Agent，造成整理位置变化。身份未被改写，仍属于 required cancellation 问题；已由实现者增加实际 foreign header 命中拒绝，合并后相同鼠标路径复验通过。
- 测试支架事件：更新 mock favorite 字段导致 Vite HMR reload，曾在菜单操作中使对话框消失；日志明确包含 fixture reload。稳定运行后“更多→移动到分区→原 Agent 下→保存”完整链通过，不据此认定产品 modal 生命周期缺陷。
- 测试支架校正：更多按钮为 hover/focus 显示，须先 hover 行，等待显露；收藏的实际中文标签为“收藏对话”。没有用 force click 绕过正常可点性。

## 行为验收矩阵

| 用例 | 最终状态 | 证据 |
| --- | --- | --- |
| 建分区与刷新 | 通过 | create section / refresh preserves section |
| 整行任务拖拽不误导航/父 Agent、3px移动正常导航 | 通过 | nested entire row / small pointer motion |
| 原 Agent 内任务向上、向下排序 | 修复后通过 | session upward/downward reorder |
| 拖任务到分区、仍导航原 Agent | 通过 | session drag / navigation callback |
| 工作区携带仍嵌套的子任务移动 | 通过 | workspace drag with children，alpha-2 始终唯一 |
| 折叠分区接收工作区 | 通过 | collapsed section receives workspace |
| 拖出侧边栏取消 | 通过 | outside drop cancels |
| 拖到其他 Agent 拒绝 | 修复后通过 | foreign Agent rejects task drop |
| 菜单恢复原 Agent | 通过 | restore task original Agent via menu |
| 创建 Escape 取消、焦点恢复 | 通过 | create cancel focus returns |
| 分区拖排序、改名、删除与资源恢复 | 通过 | sorting / rename / delete section |
| 键盘拾起、取消 | 通过 | keyboard drag Escape cancellation |
| 键盘提交排序 | 通过 | keyboard section reorder commits |
| 收藏/归档视图 | 通过 | favorite / archive checks |
| 新建分区保存失败保留输入、旧投影与重试 | 通过 | storage failure preserves input and retry succeeds |
| 已归档视图禁用创建分区 | 通过 | archive view disables drag（同时检查创建disabled） |
| 1280×800 与 900×800 rail/flyout、长名称 | 通过 | 三张页面截图与900交互结果 |

存储故障修复追加后23项全部通过，`storage-recovery-round.txt` 与 `results.json` 对应同一轮；脚本以失败结果设置非零退出码。独立截图检视：层级、缩进、密度与既有侧边栏一致，长名称截断，1280展开与900 rail/flyout均未见遮挡或横向溢出。整行任务拖拽未触发导航或父Agent拖拽，3px移动正常导航；菜单及键盘提交/取消通过。Fixture三份脚本直接项目eslint通过；npm wrapper因机器Node22与项目Node24门槛不符未使用，不将其报为产品lint结果。

本次结论仅覆盖合成数据下真实 renderer UI 行为及 localStorage 浏览器刷新保留；不证明 Tauri 原生壳、真实 config/session 持久化、认证权限或生产安装。原生客户端安装由既有凭据/Host owner 统一提供，本 worker 未换包或重启，原生验收仍由主 Agent 单独追踪。

执行记录：发现两处 required collision 缺陷，均由主实现者修复，本 reviewer 在相同真实 pointer 路径复验。未测算费用、token或节省比例。视觉/交互/响应式合成 renderer 门禁通过；原生/真实持久化验收未覆盖。

## 保存失败语义补验（2026-10-13T22:36:36.372603+08:00）

主 Agent 追加修复了 dialog 保存失败时关闭丢失输入，以及已归档视图允许创建但不可见的问题。此轮以 HEAD `15b11ab98e3e135925bfb2592ac4085be2b0b03e` 加两份尚未提交产品源码修改为候选，精确 SHA256 已更新；不得以 HEAD 单独表示本轮验收源码。

新增用例只在独立 browser context 中令 Storage.prototype.setItem 对 `myagents.globalSidebar.v1` 抛合成 QuotaExceededError，不改产品源码。实际 click 保存后验证：dialog count=1、输入“存储故障后可重试”不变、保存重新 enabled、写入故障确实触发、旧 localStorage organization 不变；截图 `storage-failure-input-retained.png`。finally 恢复原 Storage 实现后点击同一保存，localStorage 成功新增该分区且 dialog 关闭。此前22项全部重跑通过，归档用例额外验证创建入口 disabled。mock toast 仅记录警告而没有真实 Toast 渲染，因此不将截图当作错误 toast 可见性证据。

源码归档核对：本次23项实际验收的7份产品文件SHA256与功能提交45ad14d0完全相同；该条为提交映射核实，不声称重新执行UI。执行日志以同名 .txt 版本随Git保存，原 .log 保留在本地。

## 900×800 rail flyout 嵌套拖拽补验（2026-10-13T15:27:40.222Z）

此轮仅追加窄窗口真实 pointer 路径，不重复或修改此前23项证据日期与结果来源。任务分支 HEAD `f8894e763f7019a3ebfb1195a5df724912d72d35`；主 Agent 告知产品已由 PR25 合 main c21，本 worker 不以该告知替代远端交付核验。五个 core 产品 SHA256 与当轮来源见 `rail-dnd-results.json`。

在正式 flyout 的合成 Alpha 两条任务上依次实际执行：整行将任务二移入“窄窗口拖拽”；手柄将任务一移入同分区；整行把任务二向下排序；手柄把任务二向上排序。四步均通过；每步在 mouseup 后等待450ms覆盖hover关闭计时及动画，确认分区header仍visible、导航callback数量保持0、placements与orders符合预期。最终分区内顺序为alpha-2、alpha-1。截图 `rail-dnd-before.png` / `rail-dnd-after.png` 与鼠标坐标、每步prefs快照位于 `rail-dnd-results.json`；原始运行结果随Git保存为 `rail-dnd.txt`（原 .log 保留本地）。截图独立检视无重叠或横向溢出。

复现：`MYAGENTS_BUILD_PROFILE=moxbot node dev-docs/sidebar-organization-validation/run.mjs --rail-check`。新窄路径脚本及runner eslint通过。范围仍为独立Chromium合成renderer；未操作真实App、联合签名构建、安装owner或生产。
