<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/title-summary-20261014 -->
<!-- git-project-sync-task:base=43994b75ca9278420ecd352af2e0cc663f4a7cdc -->
<!-- git-project-sync-task:status=in-progress -->

# TITLE-001 — 概括任务内容生成简短标题

## Objective

用户于2026-10-14确认修改MoXBots，由当前Agent执行。权威仓库 https://github.com/heavenzhang/MoXBots.git，main。修改已有后端自动命名链路；不批量重命名已自动命名/手动命名的历史任务，不更改凭据或其他任务工作区。

## Acceptance criteria

- [x] 核实仓库、分支、既有改动、主干和安装owner；隔离工作树，从43994b75开始，已同步cf741f41。
- [x] 首个成功人类问答触发异步概括，保留必要对象和动作，中文通常8–16字，硬上限30字。
- [x] 移除“检索线索不是概要”指令；明确禁止仅复制开头，去掉【需求】/恢复等脚手架。
- [x] 用户2000/助手500 code point上下文，同一helper有界保留首尾，避免两级200字截断。
- [x] 拒绝认证错误和失败终态的部分文本；保留原有失败重试、并发guard与手动命名锁内保护。
- [x] 自动回归、真实V2持久化/重载和原renderer DOM验证。
- [x] 真实renderer概要显示/导航检查：1280×800与900×800，摘要显示和点击打开通过；合成数据，无布局改动。
- [ ] 当前源CI、主干合入与远端祖先核验。
- [ ] 已安装MoXBots包含本次成果、真实模型生成和侧栏更新复验。

## Completed

代码、单元测试、V2持久化回归、SDK请求隔离及renderer显示/导航验证已提交；main与原生验收尚开放。

## Verification

69项unit通过；72项TabProvider/GlobalSidebar DOM通过；真实V2持久化与重载1项、Provider SDK隔离2项通过；既有V2 store23项通过。合入cf741f41后69项unit、3项integration、完整typecheck和MoXBots server build通过。合入前完整lint/依赖边界/docs通过；CI检查合并后全量树。

本机原始证据 `/Users/zhangshaohua/Documents/Codex/2026-10-14/title-001-evidence/`；自动测试日志 `/tmp/title-001-*.log`。凭据与真实业务资料不进入Git。模块规范见 `specs/tech_docs/session_architecture.md#30-自动任务标题`。

## Blockers and unknowns

当前已安装App的server bundle来源506be6de，不能当成本次代码。另一个活动聊天“Bots 网络 可用”正在拥有凭据修复与统一换包；本任务未退出、替换或启动新App，也未向该聊天发消息。工具要求用户明确授权跨聊天消息；授权后提供本次冻结源/摘要，纳入统一包并回验。

真实SDK探测使用合成需求。认证状态查询返回loggedIn，但实际utility调用返回Not logged in · Please run /login；这不证明有效模型登录。此错误曾被旧cleanTitle截成标题，已新增拒绝与失败终态检查。修复后的真实探测返回null，没有生成有效概要，不冒充通过；不切换账号、不触发系统密码。Model/provider runtime真实路径验收仍开放。

## Next step

提交/推送并通过当前源CI合入main。取得跨聊天消息授权后，由唯一本机安装owner纳入标题修改；用受控合成会话验证真实模型、持久化和侧栏标题同步。

## 执行记录

单Agent/root负责实现、主审、UI与Git交付；0子Agent。选择依据：逻辑集中且改动小，委派会复制上下文。无模型升级，主模型为GPT-6系列，精确变体/推理档/费用未获运行时证据。明确采用ai-yaoren-local纯内置模式，未调用AIRouter。回归新增fixture修正后通过；真实探测发现认证错误误命名并修复。后续保留先确认生产身份、再做短标题真实探测的顺序。

Renderer证据：`dev-docs/title-summary-validation/renderer.json`与`renderer-900.png`。主Agent负责visual/interaction/responsive三个窄范围gate；均通过合成renderer覆盖，不能替代原生/真实模型。
