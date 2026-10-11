# Codex Handoff

<!-- codex-handoff:version=1 -->
<!-- codex-handoff:project=MyAgents -->
<!-- codex-handoff:last-updated=2026-10-12T00:48:00+08:00 -->
<!-- codex-handoff:latest-anchor=20261012-0048-mah-ui-provider -->

## Current Snapshot

- Status: 桌面端首批本地实现与隔离 UI 验收通过，尚无真实 Host 联调；未合入主干、未推送、未发布。
- Current task: MAH-20261012，MAH-UI 首批：AgentNet 设备详情中的 Host 管理入口、执行环境及 Provider 配置。
- Latest anchor: 20261012-0048-mah-ui-provider。
- Branch / commit: `feat/mah-ui-host-management`；来源 `origin/main` 为 `37cf5282f28e1c91cb47f02a34c1dd53a31faaad`（0.5.2）。本文件所在任务提交是首批交付锚点；用 `git log -1` 核对。
- Important files: `src/renderer/api/hostManagement.ts`、`features/agent-network/HostManagement.tsx`、`hostManagementState.ts`、`DeviceDetails.tsx`、相关测试、中英文 app locale；边界说明 `specs/tech_docs/host_management_ui.md`。
- Key decisions: 共同接口仍为方案 v0；类型只是 UI seam。生产 adapter 明确协议不支持，不发送草案命令；不可手改 vendored 1.1.0 artifact。Host owner 裁决权限、revision、持久化及生效；凭据只写。Provider/credential 独立提交；未知写入只查原 mutationId；Session 出生快照不被新默认覆盖。
- Blockers: Agenthub authority 协议、Linux Host 实现及两设备真实测试环境尚未接入；当前已配置 GitHub 账号对上游只有 pull 权限，未找到明确可写 fork。主干集成/发布由 MAH 主聊天统一安排，桌面端聊天不操作 Host/云端生产。
- Next steps: 主聊天确定有效接口版本和可写交付仓库；从 authority 导入固定契约，再由 Rust 接入受信任人类设备级入口；替换 adapter 并复验真实权限/CAS/回执/生效；随后扩展工作区/Agent、MCP/Skills、真实 pending interaction 审批与日志。

## Resume Instructions

- 先读此文件、源码 AGENTS.md / CLAUDE.md，以及主聊天的最新 INTERFACE.md；后者与协议产物是线协议 authority，不能由桌面端自定另一套。
- 核对路径、remote、branch、HEAD、工作区与 worktree，保留用户和并发修改。
- 对照最新 anchor 与 Handoff Log；当前仅有本地与 fixture 证据，不能称作真实业务验收或发布。
- 重跑受后续改动影响的检查即可，不因为此文档重复全部测试。UI fixture 与真实 Host 验收分开记录。

## Handoff Log

### 2026-10-12 00:48 +08:00 — desktop task — 20261012-0048-mah-ui-provider

- Summary: 独立 `source` 检出从指定上游同步；没有修改主聊天只读检出或其他项目。
- Changes: 新增 Host UI seam、协议门禁 adapter、代表页、窗口内非秘密草稿/回执状态；原网络 store 清理身份 scope；设备详情保留既有功能并补充完整长名称换行。
- Verification: 50/50 聚焦 DOM/unit 检查通过；typecheck、修改文件 ESLint、Web build（含主题校验）通过；依赖边界 0 errors，15 个原有孤立模块 warnings。详情标题修复后重跑既有页面 24/24；独立 UI reviewer 的视觉/交互/响应式 fixture 验收通过，1 次修复。
- UI evidence: 三视口 1440×900 / 1024×768 / 768×900，中英文；加载/空 Host/旧设备/无权限/只读/离线/冲突/未确认/待生效/测试失败；合成 IME 和 Enter/重复点击。原生 macOS IME 未验证；真实能力协商、持久化、Provider、审批和结果路径均未验证。截图不代替实际联调。
- Evidence location: 本任务检出的同级 `outputs/MAH-UI-INDEPENDENT-REVIEW.md` 与 `outputs/ui-evidence/`；隔离运行 harness 在同级 `work/host-ui/`，不进入生产。复现：Node >=24.14、npm >=11.15，安装按 lockfile；运行 `node node_modules/vite/bin/vite.js --config ../work/host-ui/vite.config.mjs --configLoader native`，仅 loopback 5188。产物不包含真实凭据。
- Collaboration: 主智能体实现和总验收（GPT-6 家族，具体变体/effort 未确认）；独立 UI worker 请求 `gpt-6-luna` / medium，实际型号/effort 未确认。纯 Codex 内置，未调用外部模型；用量/费用未知。
- Next steps: 保持真实联调开放；不得将 fixture 保存/审批用作业务完成证据。完整远端审批必须绑定 SessionEngine 的 session/request/turn/Runtime generation，重连先回读。
