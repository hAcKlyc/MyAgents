# 0.5.5 独立原生验收记录

任务：`MOXBOTS-055-UNIFIED-ACCEPTANCE`。验收者：`/root/updater_qa_review`。日期：2026-10-15。

**A4 部分通过，不能宣布整体完成。** Codex / Claude Code 真实建议、首次回车草稿交互、Title 两固定任务及原生取消/结果保全已验证；DSH 明确失败，真实中文 IME 与 Escape 原生覆盖待补。未验收普通任务执行、真实 Host 或生产发布。

## 环境和授权

- 唯一操作 App：`/private/tmp/moxbots-modelqa-055-20261015-A4/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/MoXBots Model QA.app`，bundle `com.moxbot.modelqa`，版本 0.5.5，source `2b2f12cdd87aa18bd02451be068ffc0fbf41dd64`。
- 通过 bundle ID 绑定，随后只读 ps 确认唯一 App PID **23513**，Global **23825**，没有因绑定创建副本。Root 提供的 source/hash/signature 回执为 `work/unified-055-20261015/A4-native-candidate.json` 与 `A4-source-snapshot.json`；本验收不冒充自行重跑全部制品审计。
- HOME：`/private/tmp/moxbots-modelqa-home-055-d6yb_l95`，所有截图、AX、原始安全 receipt 与日志摘录仅落其 `native-independent/`，目录权限 0700，JSON/text 0600。
- 没有读取 config/auth 密钥内容，没有操作日常 App、用户数据、Keychain、登录、SSH、生产、安装或重启。没有修改产品源码或提交。
- 人类先前在 QA 创建的 `test` 与其会话保持原状；本验收没有进入/重跑/删除它。NEXT 页面 `onSend() => false`，不得以本页二次回车证明普通任务执行通过。

## To Do 与验收状态

| 项目 | 状态 | 实际证据 / 完成条件 |
| --- | --- | --- |
| Codex system-cli / gpt-6.1-sol | 原生真实生成通过 | 一次 15.039s，灰色建议与 receipt 可见 |
| Claude Code system-cli / sonnet | 原生真实生成通过 | 一次 4.725s，灰色建议与 receipt 可见 |
| 首次 Enter → 可编辑草稿 | 原生通过 | Codex 灰字消失、成为正文，追加 `QA-EDIT-CODEX` 可读 |
| 长按 Enter | 限定页面通过 | 通过 native pressKey 保持 1.3s 后草稿一次可见、未丢失；页面禁发送，不声称普通任务/重复发送计数验收 |
| 二次 Enter | 仅禁执行边界通过 | 编辑稿保留；fixture 阻止执行，不计普通任务发送通过 |
| Escape 忽略 | 原生待补 | 不复用新调用制造证据；已有 DOM 测试不能替代原生 |
| 中文 IME 候选/提交 | 原生待补 | 两个已授权输入源快捷键后只见拉丁输入，无真实候选或组合下划线，不能算 IME 通过 |
| DSH integrated / moonshot-coding / k3 | **失败，待 A5** | 一次 10ms 返回无有效建议，不计真实模型成功，不重试 |
| Title expense-summary | 原生真实模型通过 | 9.540s，15 字，有对象与动作，receipt 对应 |
| Title goal-summary | 原生真实模型通过 | 3.262s，10 字，有对象与动作，receipt 对应 |
| Title 真正取消 SDK | 原生通过 | 实际 SDK PID 44793 → DELETE202/POST499 → PID 消失、无 SDK 后代 |
| 取消后无晚到覆盖 | 原生通过 | 旧 receipt 逐字节不变，间隔检查和页面重载后仍保持 |
| Title 页面重载持久化 | 原生通过 | 离开页面回首页再打开，原 goal title/provider/model/time 恢复 |
| 普通会话自动标题/真实 Host/生产发布 | 未验收 | 不属于本 fixture 结果，不扩大结论 |

## NEXT 实际结果

固定合成前序对话是 CSV 导入测试方案，明确不是用户真实会话。实际返回：

- Codex：`请细化空文件、缺失列和重复数据的测试用例，用表格列出输入样例、测试步骤和预期结果；对尚未明确的导入规则标注待确认项。`
- Claude Code：`请细化空文件、缺失列和重复数据这三类场景：每类给出具体的CSV输入样例、预期的系统行为（错误提示或处理结果）以及对应的断言点，用表格形式呈现。`

两种 receipt 均显示编译授权 runtime/source/model、`syntheticPriorTranscript: true`、`normalTurnStarted: false`、`noTools: true`。Codex 灰字首次保持 Return 1.3s 后成为正文，可追加编辑；二次 Return 后文字仍保留。既有窗口截图为 1200×800，页面/按钮/草稿可见；没有冒充已做窄窗专项。

主要证据：`A4-next-baseline.*`、`A4-next-codex-result.*`、`A4-next-codex-enter-held.*`、`A4-next-codex-edit-second-enter.*`、`A4-next-claude-result.*`。

DSH 界面立即返回“本次模型未返回有效建议”，receipt `elapsedMs: 10`；Rust proxy 日志同次 POST 为 200/11ms。这只证明失败返回，未证明进入真实模型。Root 随后转述 NEXT owner 的源码诊断：handler 用 `permissionMode: 'plan'`，不属于 DSH 公开模式，准备阶段 throw 后被 service 转为 null；修复及新候选 A5 后须独立复验，不在 A4 原地绕过。证据 `A4-next-dsh-empty.*`。

中文输入的两次尝试都没有候选可见，不能把键入 `zhongwen` 或 `w` 当作真实 IME 组合。Root 只读确认既有输入源为 ABC / 五笔型，非拼音；本验收未新增源、改快捷键或伪造 composition 事件。证据 `A4-next-ime-composition.*`、`A4-ime-wubi-attempt.*`。由于输入已令 Claude ghost 隐藏，且 DSH 没有有效 ghost，Escape 留给 A5 正常结果继续验，不新增无理由付费调用。

## Title 实际结果与取消

Provider/model/runtime 均为 `moonshot-coding / k3 / builtin`，输入只使用固定长合成任务。

| fixture | 生成结果 | 字数 | 原生 proxy 时间 |
| --- | --- | --- | --- |
| expense-summary | 费用包编辑页万元展示与毛利校验 | 15 | 9.540s |
| goal-summary | 公司目标承接界面完善 | 10 | 3.262s |

两份私有原始 receipt 包含相应 fixtureId、providerId、modelId、requestId、`automaticSessionTitle:false` 与 `toolsEnabled:false`，均已保存。它们证明真实 utility 结果，不证明普通会话自动标题链路。

首次准备取消时调用先完成，取消控件已失效；该次结果按成功记录（goal-summary，2.966s），没有伪称取消。随后用一次紧接生成的原生取消验证：

1. 同一 CUA 调用中点击生成、读取真实取消控件、只读采集 Global 后代，看到 SDK 可执行文件 `.../Resources/claude-agent-sdk/claude` PID **44793**、PPID **23825**；没有发送 kill。
2. 2026-10-15 **08:52:07** 原生 UI 点击取消：Rust log DELETE 精确 requestId 返回 **202/4ms**，对应 POST **499/586ms**，页面显示“本次生成已取消”。
3. **08:52:20** 只读 ps 证实 44793 已不存在，Global 仅自身、无 SDK 后代；receipt 与取消前逐字节相同。后续重读与离开/重新打开页面仍显示前一 goal title，没有晚到结果覆盖。

主要证据：`A4-title-expense.*`、`A4-title-expense-receipt.json`、`A4-title-goal.*`、`A4-title-goal-receipt.json`、`A4-title-cancel-completion-won.*`、`A4-title-pre-cancel-receipt.json`、`A4-title-cancel-live-processes.json`、`A4-title-cancel-confirmed.*`、`A4-title-cancel-after.json`、`A4-title-http-evidence.log`、`A4-title-final-safe-receipt.json`、`A4-title-reloaded.*`。

这是实际原生 UI → Rust proxy → HTTP DELETE → SDK 子进程退出的验收，超出前一轮 Node mock/wire；不推断上游服务端停止计费或未继续推理。没有使用 A1 的旧取消证据。

## 调用与交接

本轮 NEXT 三次请求：两次真实 CLI 成功、一次 DSH 早退失败；Title 四次请求：两 fixture 各一次成功、一次完成赢取消竞态、一次真实取消。费用/token 未获得可核验统计，记录未知，不估算成本。没有重试 DSH，没有普通任务执行。

验收结束时无进行中调用，保留 A4 App 和 Global；最后页面为重载后的 Title，旧 receipt 保全。**2026-10-15 08:54:38（Asia/Shanghai）已停止并释放 GUI**，共享 FileLock 内自身 lease token 比对成功，pointer/lease 均标记 `windowReleased:true`；非秘密回执见私有 `A4-window-release.json`，释放后未再操作 GUI。接续应优先 A5 修正 DSH、真实候选 IME 与 Escape；已通过的 A4 Title 范围可以保留复核，不因 DSH 单点修复泛化为整包生产通过。


## A7 独立补验：DSH 与键盘交互

本节追加 A7 结果，不改写或抹除 A4 的 DSH 失败。Root 通过共享 flock/token 转移唯一 GUI lease；审阅者先核对 token、owner 和 active 状态，按准确已运行 App 完整路径绑定，随后只读 ps 确认 App **31990** / Global **32043** 都来自 A7 路径。未按同名或 bundle 解析旧注册项。

- App：`/private/tmp/moxbots-modelqa-055-20261015-A7/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/MoXBots Model QA.app`。
- Root 提供 source `f44fc7c3479fb4844793cd73889500b80a66557d`、binary 前缀 `9de1ca37`、Developer ID strict/deep 与 CI 六项通过；这些为 Root 制品证据，本节不声称重新执行该审计。
- HOME：`/private/tmp/moxbots-modelqa-home-055-v2-4tv4sn5d`；原始 AX、截图与安全 receipt 仅保存在 `native-independent-A7/`（目录 0700，文件 0600）。
- 仅点击一次“生成真实建议”，其后全部复用该结果；没有再次调用付费生成。没有登录、Keychain API/UI、配置/凭据内容读取、Host、日常 App 或普通任务操作，没有权限提示/意外普通 turn/tool_use。

真实 DSH 返回：`请把空文件、缺失列和重复数据这三类场景展开成具体的测试用例表，包含用例编号、输入样例（示例CSV内容）、前置条件、预期结果和优先级。`

UI receipt：`runtime:dsh`、`runtimeSource:integrated`、`providerId:moonshot-coding`、`model:k3`、`elapsedMs:6203`、`syntheticPriorTranscript:true`、`normalTurnStarted:false`、`noTools:true`。该 receipt 没有 provider requestId/token/费用字段，不虚构这些信息；完整可见 JSON 保存为 `A7-next-dsh-receipt.json`。固定合成 CSV 对话未换成用户真实数据。

| 项目 | A7 原生结果 | 证据与限制 |
| --- | --- | --- |
| DSH integrated k3 生成 | 通过 | 一次真实生成、有效灰字，`A7-next-dsh-result.*` |
| 首次 Enter 与 held Return | 通过 | native Return 保持 1300ms，灰字只接纳一次成为正文，拦截计数仍 0；`A7-enter-held.*` |
| 可编辑草稿与第二独立 Enter | 通过限定页交互 | 追加 ` QA-EDIT-A7` 可见，再独立 Return，计数精确变为 1 且草稿保留；`A7-second-enter.*`。页面 onSend=false，不证明普通任务执行 |
| Escape 忽略 | 通过 | reset 复用同一结果，Escape 后灰字消失/输入为空/发送禁用，计数 0；`A7-escape.*` |
| 中文 IME 组合/候选提交 | **仍未验收** | 现有 ctrl+space 与 ctrl+alt+space 后分别真实按 w，仅见 Latin w，无候选或下划线；`A7-ime-first-source.*`、`A7-ime-next-source.*`。未按 Return 冒充 composition 证明，未伪造事件、未新增输入源/修改安全设置 |

本轮未获准其它 GUI，因此没有自行进入 SystemUIServer 输入源菜单诊断。最后仅用 BackSpace 删除自建 Latin w，保留该真实结果/receipt、空稿及计数 0（`A7-final.*`），没有退出 A7。普通任务、真实 Host、owned 冷读/relay、生产发布仍不属于本页验收；private HOME/进程配置不等于 OS sandbox。Root 另有旧注册项解析触发真实 HOME 空记录/两条加载日志的冷启动记录，本节不宣称全流程零真实 HOME 写入，也没有尝试删除该证据。

补充 IME 诊断与停手：Root 随后明确授权仅检查/选择现有输入源菜单、结束恢复原源。尝试 CUA `getApp(com.apple.TextInputMenuAgent)` 及 `getApp(com.apple.systemuiserver)` 均返回 `-10005 timeoutReached`，未取得菜单或原输入源状态，因而没有选择源/进入设置/继续 Return。已有快捷键是否实际切换输入源不可确认，不宣称已确认或恢复原源。真实 IME 继续 open。

**2026-10-15T13:00:52.062693+08:00 已停止所有 GUI 操作**；在共享 flock 下再次核对自身 token/owner 后，将 lease/pointer 标记 guiStopped/stopped，保留 owner/token/released:false，交 Root 收回，不自行清租约给他人。原 App/Global 保留，安全收据 `native-independent-A7/A7-window-stopped.json`。停止后不再操作 GUI。
