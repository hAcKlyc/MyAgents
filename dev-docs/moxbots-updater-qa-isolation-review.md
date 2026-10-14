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

## 第四轮：真实签名篡改拒绝（通过）

主实现者仅在 QA loopback 52831 暂置 negative manifest：0.5.4 指向 QA 独立钥匙对原始 canary 字节签名、服务内容却追加 `TAMPER` 的不可安装档；fixture 说明 `work/updater-20261014/qa-signature-tamper-fixture.json`。独立验收者未安装、未自行修改 HTTP fixture。

2026-10-15 01:12:43 与 01:13:14（北京时间）两次原生设置“检查更新”实测：

- Rust 获取真实200 manifest、发现0.5.4、下载进度52%→100%；随后真实 signature verification failed。QA own unified log 350–357、380–387 可复现，不是 mock 拒绝。
- 原生 UI 显示失败 toast；按钮恢复“检查更新”，无永久 spinner、无 ready/重启安装状态。再次点击确实重新下载并再次拒绝，证明失败后可重试。截图 `qa-ui-signature-rejected.png`（工具即时截屏也记录了失败 toast）。
- App PID 保持48497、About仍0.5.3，未调用安装或重启。Chat 草稿仍完整；同一 PTY 实际执行 `printf QA-PTY-ALIVE-AFTER-SIGNATURE-REJECT` 并回显，非仅静态旧内容。已保存 record content SHA-256仍为 `21b1ffdff484e6a3887c3075e51ab1aa431652fdaf6b3ff76a7779ea9d7789d1`。
- 已通知主实现者撤销 negative manifest，等待真正 B archive；本项证明下载校验拒绝，尚不证明 ready 后磁盘重校验/实际安装路径。

按已授权 QA 验收，在同一 QA PTY 启动系统 `/bin/date` + `/bin/sleep 5` 可控循环，输出 `QA-BUSY-HH:MM:SS`，用于后续更新拒绝前后的持续活动证明。最终仅 Ctrl+C 停止自建循环并关闭自身 PTY；不终止任何用户进程。

## 第五轮：合法下载、取消与忙碌拒绝（通过）；空闲安装状态未知（阻断）

主实现者提供合法独立 QA B：0.5.4 / `com.moxbot.updaterqa`；archive SHA-256 `a51c4f72d96508ed8886071ca3fc19cd27ecb37e2caa641add6e829f81ffcbfb`，342389840 bytes。2026-10-15 01:30:38–39，原生设置检查后实际下载并验签、持久化 pending、显示 ready 与目标0.5.4，App仍0.5.3/PID48497。

- 设置“重启安装”弹出明确确认：显示目标0.5.4，并说明任务/其他操作进行时保留更新、完成后重试。截图 `qa-ui-confirmation.png`。点击“稍后”后保留ready、不安装、不重启。
- 顶栏“重启更新”使用同确认；在自建PTY循环期间点击确认，01:31:09 backend拒绝 `user terminal is still open`，释放 shutdown gate。UI要求完成工作并关闭终端，保留更新包；App版本/PID不变。截图 `qa-ui-busy-retained.png`。
- 返回 Chat，原循环继续输出01:31:15、01:31:20及之后时间，证明拒绝没有停止实际命令或终端；Chat草稿未变。截图 `qa-ui-busy-loop-survived.png`。此项是真实 native PTY owner 的不中断验收，不替代付费模型执行/审批/录音的真实验收。
- 仅 Ctrl+C 停止自建循环，随后在其 shell 输入 `exit`。own log 461–462，01:31:53 `Shell exited` / `Self-cleaned dead session` 确认真实PTY已从owner移除。
- **空闲 A→B 尚未通过。** 01:32:27，再次明确确认安装后，backend读取已验签pending并报 `Session owner generation=2 reason=UPDATE_ACTIVITY_UNKNOWN`，`Unable to release exact generation 2 update admission`，随后释放 Rust gate。UI显示“暂时无法确认所有操作已结束。更新包已保留，应用会继续运行，请稍后重试”。截图 `qa-ui-idle-unknown.png`。没有安装、重启或改变版本，已通知主实现者诊断；验收者没有关闭/改写该Session来绕过guard。

本轮均为QA独立 App/数据/loopback。合法pending保持，当前仍 A 0.5.3；B二进制/版本/record与draft保全、升级后204修复复验仍待真正安装完成。

### 根因与 QA A 退出

主实现者定位 production composition common 路由白名单漏注册 `/api/process/update-quiesce`，真实 global33415/session33416均返回404；并非 owner仍忙或 token未知。需在保持原有 internal credential/exact generation 鉴权下补精确生命周期路由并重建修复A2/B，不以关闭Session绕过。

按协调要求，2026-10-15 01:37:57 对唯一 QA bundle 发正常 Cmd+Q，computer_use返回 `App quit`，原 App PID48497已消失；数据未删除或替换，recordhash仍一致，退出前Chat草稿可见。随后仅查询已知QA端口，发现原 QA Node PID48719/72565 为PPID1仍监听33415/33416，其 executable、server资源路径与argv marker均确认属于本次QA。验收者未 kill；已通知主实现者处理该精确 QA 残余，不能把App关闭误写成全部owner已退出。UI暂交还主实现者，等待A2启动通知。

**草稿落盘尚无证据：**退出后仅只读扫描QA自己的JSON/Markdown文件和精确 `Library/WebKit/com.moxbot.updaterqa` 的 LocalStorage数据库（5条记录，UTF-8与UTF-16解码检查），没有发现Chat/Launcher测试草稿marker。初步源码观察SimpleChatInput为内存文本，update前的registered提交器覆盖Record note/file editor，tabs checkpoint主要保存元数据。不能宣布文本草稿升级保全；已通知主实现者在A2启动后实际复看，必要时补正式draft checkpoint。未读取其他WebKit命名空间或日常数据。本项当前为证据缺口，尚未以UI复开实测判定丢失。

## 第六轮：生命周期精确路由修复独立复核（通过源码/模拟）

复核 `ce5c897c40e7d6af8062fcaaf9499c9d9d366630` 两个 source/test 文件：`sidecar-composition.ts` 只在 `COMMON_EXACT_PATHS` 注册 `/api/process/update-quiesce`；没有增加宽泛 prefix、development union 或跨角色额外能力。Global 与 Session 都带 common，能进入 index 的同一实际 POST handler。原有 `hasValidInternalCliCredential`、exact `MYAGENTS_SIDECAR_GENERATION`、action/token检查、`freezeSessionAdmissionsForUpdate` owner/durable保护均未修改或放松。GET等方法不会执行POST更新处理。`/api/process/update-quiesce/other` 未匹配，仍在 composition层404。

独立复跑 Node24：`sidecar-composition.unit.test.ts` 139/139 与 `session-engine.unit.test.ts` 114/114，共253/253通过。新增测试经真实 composition 调用真实 credential predicate：缺caller身份响应401，并证明相邻未注册路径不会调用 handler；既有owner拒绝回归通过。未操作App/QA数据。此项仅源码/模拟通过，必须重建修复A2后再进行真实两角色生命周期握手和A→B。

主实现者通知已仅对精确认定QA残余48719/72565发TERM并核实退出，证据 `qa-failed-route404-retirement.json`；旧negative/valid manifest与pending归档保留，record/userdata保留。本审阅未自行kill或改数据，等待composer checkpoint完成后的独立复核及A2运行通知。

## 第七轮：composer checkpoint 独立源码/模拟审阅

复核 App、Chat/Launcher wiring、SimpleChatInput/attachment hook、`composerUpdateCheckpoint.ts` 与24个新增测试。

- 注册和文件读取入口限 MoxBots；MyAgents 不注册 owner，不启动 handoff读取或写入。编译QA沿用已有隔离 config root。
- 确认后、任何await前检查IME/发送/上传/FileReader/图片/截图/staged工作流，冻结输入/send/attachment入口；文字、context和owner revision在持久化后及 native invoke前重新核对。静态审阅未发现可继续发送模型或漏写草稿的P1路径。
- `safeWriteJson`实际helper为tmp→文件fsync→原子rename→目录fsync，不仅是localStorage保存。损坏/未能读取的旧main/bak/tmp不被新更新覆盖；failed attempt只清理自身已尝试写入内容。失败保持live草稿并释放输入。
- handoff包括精确Tab/Session/workspace/discussion identity；加载验证后使用其tabs驱动restore pill，优先于异步WebView旧snapshot。只在空且精确scope的实际composer挂载时恢复文字与typed context，不调用onSend；已存在文字和其它owner不消费。Launcher/pending的非空草稿不能安全恢复时拒绝安装，未以仅存文件当作恢复通过。
- 第二次更新前拒绝未认领或blocked handoff；恢复/清理IO失败保留证据。恢复后的原生可见性仍须A2→B2验证。

独立Node24复跑5文件123/123：checkpoint unit19、checkpoint DOM5、tabs37、IME3、send59；`tsc --noEmit`及`git diff --check`通过。未操作UI/QA或日常数据。

**P2 解冻边界待回归：**冻结中同组件的Session/workspace/discussion发生变化会重注册effect；本地 `priorReadOnly` 可能重新采到已冻结DOM的true，release后留下readonly。owner revision能正确拒绝更新，故尚无P1数据丢失证据，但可能无法继续编辑。已向主实现者提供 `rerender owner scope while frozen → abort/release` 的真实DOM回归步骤；本审阅尚未独立复现此新增场景，待确认/修复关闭。原生A2/B2仍未启动，此轮不证明真实重启恢复。

### P2 解冻修复复核（关闭）

主实现者将原readOnly保存在组件稳定 `updatePriorReadOnlyRef`，只有首次从未锁→锁才读取；同组件scope重注册期间 `wasLocked=true` 不再覆盖原状态。独立复跑 checkpoint unit19 + DOM6，共25/25通过；新增DOM真实 rerender Session/workspace、verify拒绝、abort/release后检查readonly消失并能重新编辑。`git diff --check`通过。本轮关闭上述P2，无产品源码修改或UI操作；保留A2→B2真实恢复未验收状态。

### 循环依赖修复复核

CI发现checkpoint运行时导入tabs codec引入UI composition循环。独立审阅4文件修复：checkpoint改成 `import type PersistedTabState`，begin/load接收App已有 `serializeTabs`/`deserializeTabs` 函数；App以原codec传入，测试也用原codec。没有新 serializer、schema变化、role/permission放松，移除 leaf→composition运行时反向依赖。独立复跑 checkpoint unit19 + DOM6 + tabPersistence37，共62/62通过，diff-check通过；full dependency lint/typecheck由主实现者运行，不将此局部结果冒称full CI通过。

主实现者已精确停止3份旧c46构建，旧构建未生成/发布候选；本审阅未操作进程。需要从包含依赖修复的新source pin重建QA A2/B2与正式包，UI继续暂停。

### 既有 App Shell contract 断言同步

CI旧断言仍寻找无参 `performRestartAndUpdate()`，而MoxBots路径现传入checkpoint。独立审阅单文件测试更新：检查checkpoint调用存在并在restart(checkpoint)之前，Record/file提交仍必须先于checkpoint；MyAgents路径无参断言保留。产品runtime没有修改，不构成新候选包。独立 `AppShellChrome.contract.test.ts` 16/16通过。

另已通知主实现者强化旧有Record/file `indexOf` 的存在断言：负一也满足“在checkpoint前”，应各自检查>=0再比较。此为测试覆盖严谨性建议，当前产品源码实际两类提交器仍存在；不宣称存在产品数据丢失。
