# Codex Handoff

<!-- codex-handoff:version=1 -->
<!-- codex-handoff:project=MyAgents -->
<!-- codex-handoff:last-updated=2026-10-12T15:47:57+08:00 -->
<!-- codex-handoff:latest-anchor=mah-remote-management-20261012 -->

## Current Snapshot

- **当前 MAH-DESKTOP-MANAGEMENT-20261013 覆盖下方旧登录/锁屏阻断**：工作分支 `feat/mah-management-device-pairs`，PR #14 draft；`f2b0266c` 七项 CI 全成功。桌面包源 `50f3722c`，与原 MyAgents 并行运行和数据保全已核验。
- 用户亲自完成独立测试账号登录；真实桌面 poll 接纳认证，MoX bot 重启后保留账号并自动恢复独立网络在线。未安装全局 CA、未增加公网监听；账号、访问链接、截图和日志只在私有 QA 目录。
- 已安装 Linux 连接器暴露 CA 安装缺陷：公开证书原在 root-only 私密目录。修复安装器采用 profile 固定 public 目录（root0755/证书0644），私密目录仍0700；安全同版本迁移与故障回滚回归 30/30、独立审阅通过。真机迁移已完成，非 root 读取成功，旧 CA/加密凭据、Node PID、原 MyAgents 和公网监听保全。
- 真机授权重试仍报 `PUBLIC_TLS_CA_UNSAFE`：Rust 连接器 leaf 权限检查误把公开 CA 按私密文件处理，拒绝 group/other read。下一步修复公开 CA 校验，仅保留禁止不可信写入、symlink、hardlink、非可信 owner 等边界，再用新 Linux 制品重试。不能将 CA 可读或桌面在线当作已安装 Host 入网成功。
- 完整桌面→Linux 模型/只写凭据/Agent 创建持久化尚未验收；真实模型调用仍为0，需产品内真实凭据与费用授权。PR #14 未合入主干或发布。

- **最新核查 MAH-CLIENT-HOST-MGMT-20261012 覆盖下方旧协议阻断判断**：用户要求先核实仅改桌面与 Host 的路径；设备级 `channel.open` 没有 mount 字段，peer TLS/身份通道与 Agent permit 独立。固定本地业务 schema 不证明官方 relay 拒绝扩展；先做原固定协议的无副作用设备握手探针，不预设三个服务仓库都需要改动或权限。
- 本地资源准备层已交付 PR #6 / main `1d2c806e2700cd70804a1174f27b6ec23acdca68`，完整 CI `38221628350` 六项通过，测试 merge 与主干 tree 相同；下方未完成 CI 和失败 checkpoint 已过期。远程配置/凭据/Agent 创建没有真实验收。
- 当前隔离分支 `feat/mah-device-channel-probe` 从上述 main 建立。探针只发合法 Open/Accept/TLS/ChannelHello/Ready，不发 Agent invoke、不写配置/凭据、不新增公网端口，原身份留在独立 Rust owner。当前目录缺目标 key generation，需从已有 callable 路由投影取得或明确返回寻址不可用，不能猜代次；零 Agent 的设备目标发现仍待证实。

- **最新接续覆盖下方旧checkpoint**：基础入网已经交付并真实验收，fork main `92fa2c5f24faa026f81ed6567a9bb6211f1bb144`（PR #5，六项CI通过）。Linux Host完成独立官方浏览器授权、签发/Hello/空catalog/policy/服务端Ready；原桌面同账号加入后显示Linux在线，服务重启自动恢复，无需再次登录。
- 当前用户请求 **MAH-REMOTE-MANAGEMENT-20261012**：从桌面AgentNet给Linux Host配置模型/只写凭据、创建真实持久Agent，无需手工SSH。模型配置现在进入实现范围；不要要求用户向聊天提供密钥。收费模型测试仍需单独费用授权，不以测试调用作为配置界面可用的必要前置。
- 当前阶段记录与验收清单：`specs/tech_docs/headless_remote_management.md`。主集成分支 `feat/mah-remote-management` 从上述main建立；独立资源owner分支 `feat/mah-host-resources`，同一base。原入网与桌面工作区保留，不reset/覆盖。
- 实质依赖：1.1.0无设备级Host管理契约，正式renderer adapter仍不可用。授权GitHub账号目前不可访问Agenthub、MyAgents_AgentNet、MyAgents_space，官方测试部署入口未知；已经向用户询问。现有Agent invoke、roster/membership不得充当管理隧道，不手改vendor，不新增公网管理端口，不把fixture称为远程配置。
- 本地资源准备层已实现：复用原 `registerWorkspaceAgent`/持久registry，Host受限workspace创建、同锁域损坏拒写与幂等恢复；默认Agent disabled、无channels、不触发模型或自动任务。独立审查、macOS聚焦/既有registry回归与Linux隔离scratch检查通过，PR #6完整CI和主干交付待完成。未连接Socket/wire/UI，未改正在运行的Host数据，凭据动态写入owner与正式权限/grant须明确后再连接真实链路。
- 资源源码提交 `3cf77e19e1c48fce6c428b100d6e735cc98fa947`，主集成 `f4be625eb4a9ad1727436255ad2348fcb15f658f`；[PR #6](https://github.com/heavenzhang/MyAgents/pull/6) 是本地准备层交付入口，远程模型配置和Agent创建没有验收通过。
- Linux全量CI `38220139540` 五项通过，JS integration新资源用例失败：Agent写入中断时外层intent drain覆盖了resource的unconfirmed回执。已在Linux隔离目录真实复现，必须修复并重新验证，不能跳过此例或放宽generic drain合同；修复/最终CI及主干结果以PR #6与主owner私有执行记录为准。

### Historical snapshot (superseded)

- Status: 已按用户授权 fork 到 heavenzhang/MyAgents；桌面 UI 首批及协议 authority 文档修复已交付 fork main（4267bdb9）。Linux Host 实现、专项测试及独立静态复核已通过；服务器安装、配置/身份重启、锁/幂等/失败回滚及禁止模型执行的 Session 持久化验收已通过，尚未完成真实 Kimi 执行与 AgentNet 联调。
- Current task: MAH-UI-PAGES-20261012 四页 renderer 准备层已完成本地验收，交由主聊天统一集成；MAH-LINUX-20261012 的 Linux/AgentNet 接续仍由原 owner 管理。
- Latest anchor: mah-ui-pages-20261012；下方 Linux owner checkpoint 保持原记录。
- Branch / commit: `feat/mah-headless-identity-store`，基线 fork main `d190f8fde103e3f261cf21406a05be5c0355489e`；已验收运行包源码 `8b5b7820263fd9a96361e58d50072c5a05436946`。实际状态以 git 和主聊天私有 QA 为准。
- Important files: `src/renderer/api/hostManagement.ts`、`features/agent-network/HostManagement.tsx`、`hostManagementState.ts`、`DeviceDetails.tsx`、相关测试、中英文 app locale；边界说明 `specs/tech_docs/host_management_ui.md`。
- Key decisions: 共同接口仍为方案 v0；类型只是 UI seam。生产 adapter 明确协议不支持，不发送草案命令；不可手改 vendored 1.1.0 artifact。Host owner 裁决权限、revision、持久化及生效；凭据只写。Provider/credential 独立提交；未知写入只查原 mutationId；Session 出生快照不被新默认覆盖。
- Dependencies: 用户指定 Kimi 测试；AIRouter 已配置 Kimi K3，但 Host 所需凭据安全文件路径尚待补充。Agenthub 协议源码与测试实例仍未取得访问；不手改 vendor。测试服务器连接信息保留在主聊天的私有测试记录，不进入本公开 Git 仓库。
- Next step: 完成独立 crypto/store 整合和完整门禁，使用指定可信 CI artifact 在隔离 Rust UID 下验收 systemd 加密存储；取得安全凭据后验证 Kimi，取得 authority 后接入实际 AgentNet。

## Desktop UI continuation checkpoint

- MAH-UI-PAGES-20261012：在实际当前 `feat/mah-headless-identity-store` / `dd5494b3` 上续作；保留 Linux/身份存储成果，未切换分支。主聊天继续拥有 Host、正式协议、主干合入与发布。本段不改变下方 Linux owner 的验收结论。
- 四页 UI 准备层已实现：工作区/Agent、MCP/Skills、审批、日志，生产能力仍明确不可用。没有新 Tauri/wire 方法，没有修改 vendor、Host/云端/身份后端。正式来源仍是 Agenthub，v0 类型仅为 renderer seam。
- 84/84 聚焦 unit/DOM、typecheck、修改文件 lint 与 Web build 已通过；独立 UI 视觉/响应式在三视口及中英文24组合通过，已测交互通过。R-UI-01 名称残留已修复并独立复验，主审复验放弃及正式适配器门禁。此段随本轮 Conventional Commit 交付；准确 SHA 与 patch/bundle 见同级 outputs/MAH-UI-PAGES-DELIVERY.md。本聊天没有推送、合入或发布。
- 接续重点：用 authority 发布的设备级能力/人类 grant/typed owner 投影替换 optional pages adapter。资源CAS冲突不能重设baseline，未知操作只查原ID；审批绑定Session/request/turn/Runtime及fresh read token；日志有界且Host必须真正脱敏。真实业务与生产验收保持开放。

## Latest owner checkpoint

- PR #3 已合入 fork main `d190f8fde103e3f261cf21406a05be5c0355489e`，源码 `8b5b7820263fd9a96361e58d50072c5a05436946`；完整 CI 38168368033 四作业成功。对应 unsigned 测试 prerelease 已通过真实在线安装、同 ID 并发/冲突回执、重启恢复、配置和既有 Session 保留验收。仍未发 Kimi Query、未接 AgentNet。
- MAH-IDENTITY-20261012：当前 `feat/mah-headless-identity-store` 从上述 main 建立。实际 headless 服务无 session bus，现有 Linux Secret Service 不可直接用；抽取共享 Rust crypto，Desktop 保持显式 OS store，新增显式 systemd KEK + 动态 AEAD 身份存储。
- 独立存储用例首轮通过；真机验收脚本经独立复核，artifact 校验后复制窗口已修复。完整 CI、可信 Linux artifact、隔离 UID/systemd 原生验收及新源码主干交付待完成。不把隔离存储测试称作 AgentNet 登记成功。
- Kimi 安全凭据位置和 Agenthub authority/test account 访问仍待补充，问题已提出；不要重复提问、扫描无关凭据或手改 vendor。

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
- Previous download-repair checkpoint: 保持真实联调开放；不得将 fixture 保存/审批用作业务完成证据。完整远端审批必须绑定 SessionEngine 的 session/request/turn/Runtime generation，重连先回读。

### 2026-10-12 — Linux Host 主干与在线下载验收

- PR #1已交付fork main e5603d06，源90667797，CI38163417406四作业成功，Windows168/168。remote main/祖先/代码树已实际核查。
- unsigned test prerelease已公开，来源/两个摘要固定；Ubuntu Release网页下载curl(56)失败，安装器未运行，旧Host active。没有宣布在线安装成功。API/raw路线核实后修复下载，保留严格元数据与字节校验。
- 仍未发真实Kimi请求，未接AgentNet；缺安全凭据路径和可读authority，主Goal active。

### 2026-10-12 02:55 +08:00 — 下载依赖与 UI 生命周期修复

- bb995c23 的 API 原型已在 Ubuntu 下载并验证旧公开制品归档；raw installer 超时，installer未运行，test Host恢复active、仍为000e9632。原型不是已发布的修复制品。
- scripts/host将installer通过git show固定提交后嵌入bootstrap；HostManagement修复点击准入signal与busy顺序，StrictMode回归通过。主智能体集成，两个既有native worker独立打包/审查，无模型执行。
- 新提交、完整CI、PR #2合入、实际新版在线安装仍待下一步；Kimi凭据和Agenthub authority依赖未解除，主Goal active。


### 2026-10-12 — desktop UI continuation — MAH-UI-PAGES-20261012

- Summary: 用户要求续做四类管理页，确认分支由主智能体决定。沿用实际当前身份存储分支，隔离 renderer 文件所有权，不改 Host/协议/生产。
- Changes: 五Tab导航、owner范围内资源配置与CAS回执、权限/计划/必答问题、脱敏日志分页；跨页草稿保护，断线/身份/权限变化废弃迟到结果。正式adapter无pages，所有真实功能仍协议门禁。
- Verification: 84项unit/DOM聚焦回归通过，typecheck/修改文件lint/Webbuild通过；依赖边界0errors、15个既有孤立模块warnings。独立视觉/响应式24组合通过；资源配置/CAS/unknown/审批/日志、加载/测试失败、Escape/Tab及合成IME已测交互通过。R-UI-01修复后三路径独立复验通过；主审检查放弃后输入清空和production适配器不可用。原生IME/Tauri/真实Host/完整身份权限组合未验证。
- Collaboration: 主智能体集成与最终验收，资源实现worker请求gpt-6-luna/medium，复用独立UI验收worker先前请求gpt-6-luna/medium；运行实际model/effort、token与费用未知，未调用AIRouter。资源模块共3轮修复（主审2轮、独立UI1轮），独立复验闭环。三名参与者，文件范围互斥，无模型升级，用量/收益未知。
- Evidence: outputs/MAH-UI-PAGES-DELIVERY.md、MAH-UI-PAGES-INDEPENDENT-REVIEW.md、ui-pages-evidence/、verification/pages-*；loopback fixture位于work/host-pages-ui，端口5189，不含真实凭据。
- Next: 主聊天读取本轮本地提交和outputs交付记录，统一同步最新main、按CI/审查整合；接正式authority后再验真实两设备权限/持久化/MCP/审批/日志。不得将fixture结果当作真实成功。
