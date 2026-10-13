# MOXBOTS-PROJECT-BOARD-001 — 项目执行看板

用户已批准 PB-002，目标为真实 MoXBots 桌面。工作区行的看板图标与菜单打开独立项目看板；项目名继续展开会话，新对话和原会话入口沿用原行为。同一工作区复用一个标签页。

## 状态与操作

- 展示实际 Task 和未关联正式任务的 Session。按工作区路径隔离，旧 Task 无路径时按工作区 ID；隐藏已归档/删除与产品托管任务。关联会话不另计为独立任务，归档会话仍可从原任务进入。
- 四组：执行中、待处理/阻塞、待验收、已完成；待开始有独立入口；空闲、未知会话与等待触发的定时任务单列。`idle` 从不变为完成，调度已启用不表示正在执行。
- Task 状态和执行状态取既有 Rust TaskStore/TaskApplication。Session 状态通过现有 owner-addressed `/api/admin/session/state` 读取，入口/手动刷新最多查询最近 50 个非归档会话、并发 4；不启动 Session 或模型、不周期网络轮询。快照一分钟后归为未知，查询时间、未查询数量、失败数量可见。
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
