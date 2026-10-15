# MOXBOTS-PROJECT-BOARD-001 — 项目执行看板

用户已批准 PB-002，目标为真实 MoXBots 桌面。工作区行的看板图标与菜单打开独立项目看板；项目名继续展开会话，新对话和原会话入口沿用原行为。同一工作区复用一个标签页。

## 状态与操作

- 展示实际 Task 和未关联正式任务的 Session。按工作区路径隔离，旧 Task 无路径时按工作区 ID；隐藏删除与产品托管任务；已归档单列历史。关联会话不另计为独立任务，归档会话仍可从原任务进入。
- 四列从左到右：待开始、执行中、待确认、已完成；需要我是筛选。待确认细分成果、答复/授权、阻塞、已停止及状态待核实；空闲会话与等待触发的定时任务单独折叠。`idle` 从不变为完成，调度已启用不表示正在执行。
- Task 状态和执行状态取既有 Rust TaskStore/TaskApplication。Session 状态通过现有 owner-addressed `/api/admin/session/state` 读取，入口/手动刷新以及活动可见看板每30秒最多查询50个会话（未归档优先）、并发4；不启动 Session 或模型，隐藏/非活动停止刷新。快照一分钟后归为未知，查询时间、未查询数量、失败数量可见。
- Task run/rerun/status/get/doc 沿用现有 API，不能通过设置 running 伪造执行。停止失败与正在执行时禁止再次派发。问题、权限批准、继续沟通进入原 Chat，复用请求 owner。验收操作先查看交付，后端确认才更新状态；完成不代表已发布或通过生产验收。
- 保留列表/看板、筛选、搜索、详情选择、展开和验收草稿；切换 Chat 返回时仍在原位。本次不新增关闭标签页/重启后的看板状态持久化。
- 使用现有字号与主题语义 token。内容区 <=860 使用分组列表，窗口 <=700 的详情覆盖形态隔离背景键盘焦点并支持 Escape 回原卡片。

## 代码与验收

入口 `src/renderer/App.tsx`、`components/global-sidebar/GlobalSidebar.tsx`，标签定义 `features/project-board/tabModule.tsx`，投影/API/hooks/详情在同一 feature，页面 `pages/ProjectBoard.tsx` 与 CSS。无新任务或会话 authority，无数据库迁移。

`dev-docs/project-board-validation/` 提供真实生产 React 组件的隔离合成 API fixture。运行：

```bash
MYAGENTS_BUILD_PROFILE=moxbot node dev-docs/project-board-validation/run.mjs --check
```

检查 Task/Session 去重、状态、筛选、草稿、错误重试、原会话事件、键盘、深浅主题及1440/1024/768/540布局。`results.json` 与选定截图为合成验证，不能证明真实 Tauri/Rust API、账号、模型执行、原生安装或生产验收。独立审阅见 `project-board-review.md`，两项 P2 经一轮修复已关闭。

主 Agent负责整体集成与验收；board_data_audit请求 gpt-6-luna/medium只读梳理；board_ui_review请求 gpt-6.1-sol/medium独立审阅跨状态交互，未改产品源码。具体运行模型与用量未从工具确认，不估计成本收益。未调用外部模型或发起真实付费任务。

## 主干与安装

源码、远端 main、安装与真实路径分别追踪于 `.agent-sync/tasks/codex-project-board-20261014-da9bc0a5.md`。本任务不修改云服务、账号凭据或现有 Host。当前客户端更新由既有安装 owner 串行维护，未经独占窗口交接不并发换包或退出应用。安装交付需要实际冻结源码/包内 renderer与server来源、有效签名、回滚和原生看板路径复验。

集成后本地验证：typecheck、完整lint、99项相关unit/DOM、12组隔离React交互与MoXBots生产web构建通过；独立审阅的产品文件未因main同步发生变化。已有dependency-cruiser warnings没有降级为新增错误，未修改无关依赖。固定源/看板bundle hash见validation/source-hashes.json。PR31等待当前头CI；已安装客户端不包含此次看板。

## 会话时长与快捷入口（MOXBOTS-PROJECT-BOARD-002）

卡片将“最近更新”明确标注，与“本轮已用”分开；列表和详情使用同一计时投影。本轮时长从内置/外部 Runtime 的当前 product transcript turn.startedAt 读取，由执行 owner 计算墙钟耗时（含等待答复），不以 Session 创建时间、lastActiveAt 或 Sidecar uptime 替代。未取得开始时间明确显示不可用，空闲不运行计时器。入口/刷新仍是有限只读查询；活动可见看板每30秒有界核对，前端一秒计时不额外读网络。一分钟未更新或读取失败后冻结快照时长并提示待核实。

卡片与列表有独立“进入会话”按钮，单关联会话直接使用既有 OPEN_SESSION_IN_NEW_TAB 进入准确 Session；多关联会话仍通过详情选择，避免随意打开某次历史执行。标题区域/详情按钮继续打开详情，独立按钮不嵌套；键盘可操作，返回保留看板状态。

隔离验证可设置 `PROJECT_BOARD_AUDIT_OUTPUT=/tmp/board-audit`，避免重写版本管理中的旧验收截图。新增计时、快捷入口、过期/恢复检查使用实际 React 组件和合成数据，不代表原生已安装。

## 四阶段与可信执行状态（MOXBOTS-PROJECT-BOARD-004）

已完成留在最右列用于审视进展；用户主动归档后进入历史。仅已归档且当前没有已知执行/待处理状态的记录进入历史。归档后发现活跃或上次活跃状态尚未重新核实，优先暴露在工作台。恢复 Task 回到原已完成状态，不调用 run/rerun；Session 只恢复 metadata。

后台SDK子任务以当前Query的运行注册表作为依据。root idle但子任务仍active时投影running，不借用上一轮Query的children或伪造时长。root error且无active children返回SESSION_EXECUTION_FAILED，前端显示阻塞。Rust只在确实无owner时返回idle；starting/dead/draining/recovery owner返回不可观测。未取得状态不折为空闲，失败保留上次快照及查询时间。请求串行跨刷新交接、并发上限4，慢50会话扫描不被30秒时钟打断。

归档前对canonical Task.sessionIds去重复核owner。此读写不是原子执行锁；并发新执行仍可能发生，投影会保持活跃记录可见。本次不改变既有Session metadata归档/Task scheduler停止语义，不增加伪原子锁。

实际组件隔离页面：`node dev-docs/project-board-validation/state/serve.mjs`，仅绑定127.0.0.1:8879，合成数据，不执行模型、不读写业务记录。相关测试、独立审阅和发布门槛见 `project-board-validation/state/README.md` 与分支任务记录。
