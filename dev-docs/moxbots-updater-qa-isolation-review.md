# MOXBOTS-UPDATER-20261014 — QA 隔离独立审阅

审阅日期：2026-10-15（Asia/Shanghai）。审阅者为非实现者，仅阅读源码和运行指定自动化测试；未安装、启动、退出或操作任何 MoXBots App，未读取或修改日常 `~/.moxbot`、钥匙串或用户会话。

## 当前结论

第二轮复核：初轮发现已在源码中关闭，追加 Node 回归通过，可进入冻结 QA 产物的原生构建/隔离验收。尚不能宣布完整隔离或真实 A→B 通过；Rust terminal regression、实际 QA 原生构建和运行路径仍待验收。生产更新器已交付不等于 QA 原生 A→B 验收完成。本报告针对 QA 差异，不代替正式 App 公证或真实业务验收。

## 已核实边界

- QA Tauri 身份 `com.moxbot.updaterqa`、显示名、URL scheme 和 CLI 名称独立；Rust/Node 数据根均为 `.moxbot-updaterqa`。资产与 fs 插件 scope 没有授权日常 `.moxbot`。
- QA 构建 wrapper 只允许新的 `/private/tmp` 工作区、独立 public key、显式 IPv4 loopback HTTP 更新地址和受限 arm64/output 参数；拒绝 config/features/debug 等注入，拒绝复用正式 updater 公钥。所有 Vite/server/bridge/CLI assets 重新编译且使用同一 build defines。
- 生产配置仍 HTTPS，QA 的 insecure transport 只出现在 QA overlay。正式 macOS MoxBots credential reader feature 门禁保留；QA 禁止链接该 feature，OS identity store/account entry 直接拒绝，不构造钥匙串后端。
- QA sidecar 基准端口 33415、进程 argv marker 独立；CLI port 文件、app.lock 由 QA 数据根派生。Management API 为独立动态 loopback listener。
- 启动恢复清理使用当前 QA executable Resources 与 QA 数据根，不用全局 SDK/MCP pattern sweep；锁 PID 的真实实现比对当前 executable 精确规范路径，并非品牌名匹配。
- QA 保持 `IS_MOXBOT=true`；更新安装继续走同一 `prepare_update_restart` 和 TerminalManager 活跃终端拒绝路径，未另建宽松模拟更新器。
- provider-verify 的订阅/模型探测、prewarm 定时器、SDK query factory 与 SessionEngine 执行入口具有 QA 拒绝分支；生产条件为 false，不改变原有行为。

## 发现及关闭证据

1. **P1 — QA PTY 仍继承父进程环境及 PATH。** `src-tauri/src/terminal.rs::inject_terminal_env` 拼接原有 PATH，CommandBuilder 继承环境；仅换 `/bin/sh` 和去掉 `-l` 不会消除 `ENV/BASH_ENV`、用户工具路径或模型凭据环境变量。应在 QA 构建清空/严格 allowlist 环境，仅保留 QA/bundle/system PATH，并设置自身 Claude/Codex 根。原生终端 busy 验收前必须收紧。
2. **P1 — 外部标题 utility 绕过模型执行拒绝。** `src/server/title-generator.ts::generateTitleExternal` 直接构造 runtime 并 `startSession`，没有 selector/SDK query guard。`generateUtilityText`、subscription auth、vision 的 provider/bridge 准备也位于 SDK factory 拒绝之前。应在最早 utility/account/tool 入口 QA fail closed，避免凭据准备或外部 CLI 启动。
3. **P2 — QA 已有 Session 恢复被过早拒绝。** `restoreInitialExternalSessionAtSelector` 在判断 builtin/external 前即走 execution deny；index 启动对有 initialSessionId 的 Session 调用它，可能导致 deferred init failed 与更新 guard 状态未知。应允许纯 builtin product transcript 恢复，只禁止实际 external/model execution。恢复阶段还应避免 SDK native transcript probe，保留自己的 QA product transcript 验证。

第二轮独立复核关闭证据：

- **P1 终端环境：源码已修复，原生 regression 待执行。** QA `inject_terminal_env` 提前调用独立 helper，`env_clear()` 后仅赋予固定 bundle/system PATH、QA `terminal-home`、独立 `CODEX_HOME/CLAUDE_CONFIG_DIR` 和必要 TERM/locale/loopback 配置；不注入用户 PATH、SSH agent、OAuth/API 环境或 shell startup 环境。缺少 QA root 时也清空环境。新增 `updater_qa_terminal_environment_tests` 直接读取实际 CommandBuilder 环境并检查 negative canary；此 Rust 测试本审阅未运行，不以 Node 结果替代。
- **P1 模型 utility：源码与 Node regression 已关闭。** `generateUtilityText`、`generateTitleExternal`、`startSubscriptionLogin`、`submitSubscriptionLoginCode`、`analyzeImages` 均在函数起点拒绝 QA，先于 provider 配置、bridge、runtime 构造、SDK 或 image 文件读取。新增 `updater-qa-utility-admission.unit.test.ts` 用实际入口及 backend spy 验证 3/3；既有生产 title/OAuth regression 同次复跑通过。
- **P2 历史恢复：源码与 selector regression 已关闭。** restore 使用 update admission；builtin 返回 false，只有确需 external restore 时 QA 拒绝。112 个 selector 测试包含 builtin 初始化允许与 external 不调用 owner 的回归。`initializeAgent` 的 QA metadata 不再走 SDK resume/native transcript probe，并在 pending native conversation mutation 恢复前拒绝；自身 product transcript 加载保留。完整重启后的 UI 历史恢复仍待实际 A→B。
- **编译门禁补充：静态复核。** `registry.rs` credential slot promote 调用同步排除 `myagents_updater_qa`，与 account/identity 的 cfg 一致；QA 原生重编译由主实现者执行，此项不冒称已完成独立 native 编译。

## 独立复跑

使用已配置 Node 24，只运行源码测试，没有客户端操作。

- `node --test scripts/build-moxbot-updaterqa.test.mjs`：3/3 通过。
- Vitest 五文件：`provider-verify.updaterqa.unit.test.ts`、`shell.updaterqa.unit.test.ts`、`sdk-child-launch-guard.unit.test.ts`、`session-engine.unit.test.ts`、`app-profile.integration.test.ts`：137/137 通过。数据隔离 integration 使用自身 temporary home fixture。
- `npx tsc --noEmit`：通过。

第二轮复跑：上述五文件加 `updater-qa-utility-admission.unit.test.ts`、生产 `title-generator.unit.test.ts` 和 `subscription-auth.unit.test.ts`，**8 文件 164/164 通过**；`npx tsc --noEmit` 及 `git diff --check` 通过。运行日期仍为 2026-10-15，本轮未操作 App/日常数据/钥匙串。测试总数包含生产与 fixture regression，不代表 164 条原生路径。

## 状态与下一步

| 项目 | 状态 | 证据边界 |
|---|---|---|
| QA 源码身份/数据/端口/清理与入口 | 静态核实通过 | 初轮 3 项发现已按上述证据关闭 |
| 自动化模拟/隔离 fixture | 构建 3/3；第二轮 Node 164/164；tsc/diff 检查通过 | 不证明 App 实际运行隔离 |
| Rust CommandBuilder 环境 regression | 已补源码，未独立运行 | 等待实际 Rust 测试结果 |
| Rust QA 原生编译 | 主实现者正在执行，独立未核验 | 不争抢编译 target |
| 独立原生 UI | 未验收 | 等待冻结独立 App 与入口修复 |
| 真实 QA A→B | 未验收 | 要验证签名、下载、确认/取消、busy 保留、空闲重启、版本/历史保留 |
| 日常正式 App 与业务 | 本审阅不操作 | 不以日常安装状态代替 QA 实测 |

启动原生测试前，实际冻结产物应与 QA bundle/data/单实例/端口/凭据拒绝配置对应；仅 `/private/tmp` 存放路径不足以证明隔离。所有后续操作仅针对明确识别的 QA App。

## 第三轮：原生 A 端准备（未安装 B）

唯一操作对象 `/private/tmp/moxbots-updaterqa-live-20261015/MoXBots Updater QA.app`；computer_use 实际状态确认 `com.moxbot.updaterqa`、PID 48497、1200×800 窗口。QA HOME `/private/tmp/moxbots-updaterqa-home-20261015`，界面关于页显示 0.5.3。所有工具显式指定 QA bundle ID 或其精准窗口 ID 2864145，未扫描其他 App 内容，未操作日常 App/数据/钥匙串。截图留在 QA HOME，未把工具成功当界面生效。

- 关于页“检查更新”入口可见可点击，布局在 1200×800 可读，没有截断关键更新控件。
- **新发现 UIR-QA-204：A 端手动检查错误处理。** 2026-10-15 00:59（北京时间），点击检查更新出现“检查更新失败，请稍后重试”。同 QA `logs/unified-2026-10-15.log` 188–205 确认 endpoint 返回 HTTP 204、0 字节，manual connectivity 路径报 JSON EOF；177–182 的后台检查同204能正确识别暂无更新。已通知主实现者，B 将包含 manual 204→up-to-date 修复；升级后再复验，不把 A 的失败记为通过。
- 启动页输入 ASCII 草稿 `QA-UPDATER-20261015-DRAFT-DO-NOT-SEND`，可见且切标签后仍保留，未发送模型；此阶段尚不能证明升级后恢复草稿。
- 通过真实“记录” UI 保存 `QA-UPDATER-20261015-PERSISTED-RECORD #updaterqa`，界面提示“记录已保存，可在任务中心查看”，随后在任务中心实际看到记录。QA 自身持久化文件：`.moxbot-updaterqa/records/2026-10/5bdb9601-77c6-4bf8-a605-a9f733c57590/content.md` 与 `record.json`。没有创建/运行 AI 任务。
- 原生截图：QA HOME 下 `qa-ui-project-empty.png`、`qa-ui-record-created.png`、`qa-ui-record-in-task-center.png`。截图仅证明各自对应页面，数据文件证明该 QA marker 实际落盘。
- A 的 QA log 显示系统 skill `cuse` 缺失，已交给主实现者核对 QA 与正式产物资源完整性。此处没有尝试模型/桌面工具执行，不能据此宣称正式包业务完整性通过。

B 就绪之前不安装、不退出 QA。后续确认/取消、busy 拒绝、签名下载、A→B 版本更换与 marker 保全仍待实际执行。

原生准备补充：主实现者经 QA Global 正式 `/sessions` 元数据 owner 建立空 builtin fixture `98a85638-b8be-405d-b0f7-56edd540a537`。独立验收者从项目看板实际打开其原会话，恢复 0 条消息；输入但不发送 `QA-CHAT-DRAFT-20261015-KEEP-AFTER-UPDATE`。随后通过 Chat 的“打开终端”控件创建真实 PTY，在该终端执行仅输出自身 HOME 的 `printf`：可见 `/private/tmp/moxbots-updaterqa-home-20261015/.moxbot-updaterqa/terminal-home`，提示符 `sh-3.2$`。截图 `qa-ui-terminal-isolated-home.png`。QA终端保持打开用于后续 busy 拒绝；尚未通过安装路径验证拒绝，因此本阶段仅证明实际 PTY 与自身环境路径。
