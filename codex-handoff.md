# Codex Handoff

<!-- codex-handoff:version=1 -->
<!-- codex-handoff:project=MyAgents -->
<!-- codex-handoff:last-updated=2026-10-12T01:46:00+08:00 -->
<!-- codex-handoff:latest-anchor=mah-linux-20261012 -->

## Current Snapshot

- Status: 已按用户授权 fork 到 heavenzhang/MyAgents；桌面 UI 首批及协议 authority 文档修复已交付 fork main（4267bdb9）。Linux Host 实现、专项测试及独立静态复核已通过；服务器安装、配置/身份重启、锁/幂等/失败回滚及禁止模型执行的 Session 持久化验收已通过，尚未完成真实 Kimi 执行与 AgentNet 联调。
- Current task: MAH-LINUX-20261012：Linux 无桌面 Host、隔离真机安装与本地执行，然后 AgentNet 远程配置。
- Latest anchor: mah-linux-20261012。
- Branch / commit: Linux 开发分支 `feat/mah-linux-host`；origin 为用户 fork heavenzhang/MyAgents，upstream 保留 hAcKlyc/MyAgents；本阶段代码 000e9632；fork main 仍为4267bdb9，待Windows并发临时文件修复CI复验合入。用 git status/log/ls-remote 核对最新交付，不将本文件旧锚点当当前 HEAD。
- Important files: `src/renderer/api/hostManagement.ts`、`features/agent-network/HostManagement.tsx`、`hostManagementState.ts`、`DeviceDetails.tsx`、相关测试、中英文 app locale；边界说明 `specs/tech_docs/host_management_ui.md`。
- Key decisions: 共同接口仍为方案 v0；类型只是 UI seam。生产 adapter 明确协议不支持，不发送草案命令；不可手改 vendored 1.1.0 artifact。Host owner 裁决权限、revision、持久化及生效；凭据只写。Provider/credential 独立提交；未知写入只查原 mutationId；Session 出生快照不被新默认覆盖。
- Dependencies: 用户指定 Kimi 测试；AIRouter 已配置 Kimi K3，但 Host 所需凭据安全文件路径尚待补充。Agenthub 协议源码与测试实例仍未取得访问；不手改 vendor。测试服务器连接信息保留在主聊天的私有测试记录，不进入本公开 Git 仓库。
- Next steps: 见 specs/tech_docs/linux_host.md 的勾选清单；已完成最终 bundle 真启动及真机 systemd 安装/重启/回滚；取得凭据后运行 Kimi 受控任务、权限与 resume；之后从 Agenthub authority 更新契约并联调桌面 adapter。

## Resume Instructions

- 先读此文件、源码 AGENTS.md / CLAUDE.md，以及主聊天的最新 INTERFACE.md。INTERFACE.md 是项目协作约定和未实现的 v0 草案，不是线协议 authority；实际线协议以 Agenthub authority 发布的固定产物为准，桌面端不能自定另一套。
- 核对路径、remote、branch、HEAD、工作区与 worktree，保留用户和并发修改。
- 对照最新 anchor 与 Handoff Log；区分本地自动测试、Linux 无模型真机验证与尚未完成的真实 Kimi/AgentNet 验收，不称作整体业务发布。
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
