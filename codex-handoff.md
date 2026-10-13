# Codex Handoff

<!-- codex-handoff:version=1 -->
<!-- codex-handoff:project=MoXBots -->
<!-- codex-handoff:last-updated=2026-10-13T11:53:38+08:00 -->
<!-- codex-handoff:latest-anchor=MAH-CLOUD-MANAGEMENT-20261013 -->

## Current Snapshot

- **MAH-DESKTOP-CREDENTIALS-20261013**：用户要求避免反复输入钥匙串密码。已核实后台 `ensure_current` 每次读取 OS 凭据和 ad-hoc 新包 hash 身份变化两个来源；修复仅缓存已验证的进程内非秘密 guard，首次 restore 仍读 OS 库，精确删除/替换/active/expiry 仍失效。取消新登录不撤销现有登录，存储同步锁不跨 await。凭据、Mac 密码不写 Git，不新增明文后端、不放宽全局 ACL；独立本地试用签名身份与私有构建密码只在 owner 私有目录，签名副本 strict 校验和固定证书 DR 已通过，旧凭据首次迁移可能仍需一次系统确认，真实不反复弹窗尚待验收。
- **canonical 仓库**：`https://github.com/heavenzhang/MoXBots` 是原 fork 的重命名，同一 GitHub repository ID，origin 已核查更新。主干 `848c0592` 合并 MoXBots 品牌 PR #16；管理分支已整合品牌源 `40c90d13`。PR #14 管理成果尚未合入。迟到控制消息修复 `3a294c78` 已完成源码独立审查，整合 `b359893b` Test CI 六作业通过；Owned CI 首次并发 metadata 初始化双失败，`16658390` 增加私有有界初始化锁，20 tests/clippy 与并发重复通过，原 Linux 失败未在 Mac 精确复现，待修复后 Linux CI。新桌面管理包原生构建成功，但不能当真实 Agent 创建验收。
- **MAH-CLOUD-MANAGEMENT-20261013**：主 owner 沿用 `feat/mah-management-device-pairs`。源码 `02e55746` 的 Test CI 七作业和 Owned 服务构建通过；PR #14 仍待真实管理验收与主干交付。用户继续授权 goal 模式和桌面联调；模型密钥后续由产品界面配置，本轮没有付费模型调用。
- **当前真实部署**：独立认证与云 AgentNet 已在用户授权的新云主机部署，受信 IP-SAN HTTPS 可用，不必要求域名；后端仅 loopback，既有应用和入口保全。心跳修复 `7cdfe315` 已用有来源与摘要的 CI 制品发布；桌面和已安装 Linux Host 完成真实同账号浏览器授权、入网，并跨 51 秒保持相同连接 epoch 的 Ready。身份、凭据、数据库和旧服务均保留；恢复必须用当前阶段一致性备份，不能覆盖为登录前数据库。
- **真实管理进度与当前缺陷**：桌面原生 Host snapshot 成功，Kimi 默认模型配置保存到 Linux Host revision 1；密钥未配置、执行未授权、Agent 创建尚未验收。保存后的自动刷新遇旧请求迟到 `channel.closed`，原保存回执仍有效。正在补有界、严格 scope 的退役通道收尾，并同时覆盖 actor idle 与下一 RPC 接收；未知通道仍拒绝。通过修复回归后，整合 MoXBots 品牌分支并重新构建试用包，再完成 Agent 创建和重启持久化的真实桌面路径。
- **实例和包区分**：原 MyAgents 保持运行。MoX bot / MoXBots 共用独立 `com.moxbot.app`、`~/.moxbot`、`moxbot://`；当前获授权的管理包为 `50f3722c`。独立品牌试用包不含 PR #14 管理代码，不能把其设备可见性当远程配置验收。新云服务指认证、准入、metadata 和 relay；已安装 Linux Host 是本轮执行节点，新云另装第三执行节点不作为本轮必需步骤。
- 私有环境、账号、授权链接、PID、制品 SHA、备份及真实证据仅保存在主 owner 的受限 QA 目录；公开 Git 不记录凭据。下面保留旧 checkpoint 供历史追溯，其尚未授权/尚未入网等状态以本段为准。

- **MAH-CLOUD-20261013 当前部署**：用户新增授权的云服务器上，原生 Dex v2.46.0 与 owned AgentNet 已以独立非 root UID991 部署并启用；使用现有受信 IP-SAN HTTPS 入口，后端仅 loopback，保留既有 `/mori/`。运行二进制摘要、四个私有数据库、原应用进程/页面、公网监听和实际重启后 descriptor/签名 keys 一致性已核验。证书续签 timer 与 Nginx reload hook 已核实。新云网络浏览器登录与桌面/Host 管理尚未验收，不能据此宣布完整流程完成。
- 本轮同步并保留并发 PR #15 主干成果，分支 `8adfdf82` 已推送，主干 `efb22f16`；30项安装器回归、合并后 typecheck 与26项相关 server/shared unit 通过。云启用脚本停止失败回滚 P2 经修复、3项故障注入与独立复核关闭。实际部署备份/凭据/访问链接仅留私有目录；MoX bot 新云网络接入已准备，等待桌面即时权限确认。原私有 loopback 测试环境已停止且原四个服务保全。PR #14 仍 draft，未合入主干；模型调用仍0。

- **当前 MAH-DESKTOP-MANAGEMENT-20261013 覆盖下方旧登录/锁屏阻断**：工作分支 `feat/mah-management-device-pairs`，PR #14 draft；`f2b0266c` 七项 CI 全成功。桌面包源 `50f3722c`，与原 MyAgents 并行运行和数据保全已核验。
- 用户亲自完成独立测试账号登录；真实桌面 poll 接纳认证，MoX bot 重启后保留账号并自动恢复独立网络在线。未安装全局 CA、未增加公网监听；账号、访问链接、截图和日志只在私有 QA 目录。
- 已安装 Linux 连接器暴露 CA 安装缺陷：公开证书原在 root-only 私密目录。修复安装器采用 profile 固定 public 目录（root0755/证书0644），私密目录仍0700；安全同版本迁移与故障回滚回归 30/30、独立审阅通过。真机迁移已完成，非 root 读取成功，旧 CA/加密凭据、Node PID、原 MyAgents 和公网监听保全。
- 真机授权重试仍报 `PUBLIC_TLS_CA_UNSAFE`：Rust 连接器 leaf 权限检查误把公开 CA 按私密文件处理，拒绝 group/other read。公开 CA 校验现已修复为禁止不可信写入与特殊位，保留 symlink、hardlink、非可信 owner 和大小边界；118项 headless 测试与clippy通过，主审公开权限回归通过。新 Linux 制品源 `710820e9`（tree 与 `cadfa520` 相同）已安装，真实 `owned-auth-start` 成功；首个 Host 浏览器请求已过期，待用户准备后重新发起。不能将 CA 可读或桌面在线当作已安装 Host 入网成功。
- 完整桌面→Linux 模型/只写凭据/Agent 创建持久化尚未验收；真实模型调用仍为0，需产品内真实凭据与费用授权。用户另授权新服务器承载独立认证、AgentNet 与云 Host；域名待确认，已有服务保留，未发布公共入口。PR #14 未合入主干或发布。
- **本聊天最新任务 MAH-NEXT-DRAFT-20261013**：沿用 `feat/mah-headless-identity-store`，基线 `4887cbf5`，同分支同步 fork main `e344dac8` 后为 `5dea4a8d`。新增根据当前对话生成的灰色下一步建议；首次 Enter 只接纳可编辑草稿，随后正常发送才执行。IME/composition/keyCode229、重复 Enter、草稿/附件、busy/审批及会话切换保护保持。此任务不改 Host/AgentNet 实例，下面远程管理 owner 记录保留。
- **功能边界**：Builtin 隔离文本 utility 可生成；DSH/Claude Code/Codex 的无工具、非持久化 utility 尚未验证，因此明确不可用。模型错误/空建议静默保留普通输入。最近128个完成anchor LRU，在途请求合并；建议不写 transcript/metadata/队列。完整契约见 `specs/tech_docs/session_architecture.md`。
- **本轮验收/交付**：140项聚焦 unit/DOM + 标题Provider mock integration 2项；完整 typecheck/lint（依赖/文档）与 Web/server build；窄屏420字预览滚动缺陷已修复并独立复验；visual/interaction/responsive三gate通过fixture范围。功能提交 `a103f8c4ff9cd8515daf17cb8e3965869ca52704`，fork main交付由 [PR #15](https://github.com/heavenzhang/MyAgents/pull/15) 的最终CI/merge与远端Git核实。记录与证据位于本任务目录同级 `outputs/MAH-NEXT-DRAFT-{TODO,INDEPENDENT-REVIEW,DELIVERY}.md` 和 `work/next-draft-*`。未调用真实模型、未替换已安装桌面包，原生macOS中文输入法与真实模型生成仍未验收。

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

### 2026-10-13 — MAH-NEXT-DRAFT-20261013

- 灰色建议与 textarea value 分开，Enter 接纳→编辑→现有发送快捷键/按钮执行；Esc/输入忽略当前anchor，迟到结果按Session/回复/Runtime/provider/model隔离。首次按键不创建任务，长按不会连发。
- Session Sidecar route 只接受owner/anchor ID；实际SessionEngine校验idle/human/completed transcript，活动Provider/model从后端读取，30秒timeout/Abort/迟到handle清理，Builtin纯文本无工具和历史写入。其它Runtime标注不可用，不能借用原生Agent loop或系统CLI。
- 源码/模拟/真实生成/原生桌面/主干/发布分别记录；独立UI使用真实组件+hook+生产主题，apiPost合成结果，不等于真实模型或Host联调。接续按本轮交付记录核实主干SHA/CI，并用受控Builtin会话补真实生成与原生IME验收。
