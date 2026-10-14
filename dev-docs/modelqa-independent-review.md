# Model QA 独立审阅

任务：`MOXBOTS-055-UNIFIED-ACCEPTANCE`。审阅者：`updater_qa_review`。日期：2026-10-15。

本轮是只读代码与确定性测试审阅；唯一写入文件是本文。没有操作 GUI、模型、钥匙串、日常应用或生产环境，没有提交代码。审阅基线为 `c7bab28594a03dfba7167200a90ae73ad0a6b5aa` 及本轮未提交 modelqa diff；后续 fixture handler/page 尚未纳入本结论。

## 结论与待办

- [x] 已复核第一轮 P1 修复：`identity_desktop.rs::authorize_owned_identity()` 的 modelqa 分支调用 `authorize_model_qa_with()`，授权前映射物理 scope，读取映射 scope，返回的 store 再包装；TLS/wire scope 保持原值。
- [x] 已检查普通身份 load/save/delete、actor connection cache 和授权恢复的 store 选择。generic `OsIdentityStore` 使用固定 service 加 credential-name hash，NoEntry 不回退原 scope；modelqa owned-account 使用独立 `com.moxbot.modelqa.owned-agentnet.v1`，账号 key 另含 `.moxbot-modelqa`。
- [x] 已复核 modelqa 普通 SessionEngine 执行和外部恢复拒绝、SDK child 的 AsyncLocalStorage utility admission、utility 显式 provider/model 条件与 tools/MCP/settings/persistence 配置。
- [x] 已复核四种 build profile 的 JS/Rust 标识及隔离 cfg、production reader feature 拒绝、端口/CLI/deeplink/marker 区分、modelqa 空 updater endpoint、公用隔离 shell/sidecar 环境和全局快捷键禁用。
- [x] P2：原始 HOME、有效目录链接和关键文件 dangling symlink 检查已收口，最终复验通过。
- [x] P2：SDK guard 在每个实际创建路径再次检查可撤销 utility scope，最终复验通过。
- [ ] Rust modelqa 编译和三项 backend 测试尚未通过本轮验证；首次日志显示 Swift dependency linker 阻断，不能用 Node 测试替代。
- [ ] 新增 fixture handler/page 接线后需要第三轮审阅。
- [ ] 真实 modelqa 原生应用、真实模型和专用 Linux Host 由各 owner 在获授权的隔离环境串行验收；本报告未执行、未宣称通过。

## P2：启动入口接受路径链接，不能完整保证独立状态

`scripts/run-moxbot-modelqa.mjs::launchModelQa()` 先 `realpathSync(home)`，再交给 `modelQaLaunchEnvironment()` 检查，所以后者对原输入 symlink 的拒绝在实际启动入口被消除。另一个实质缺口是仅验证 HOME 本身，随后对 data、CLAUDE_CONFIG_DIR、CODEX_HOME 使用 recursive mkdir；已有的 `.moxbot-modelqa`、`claude`、`codex` 目录链接会被接受，可能把隔离配置或会话发现重定向至其他根。当前测试仅验证环境 helper 的 HOME symlink，未覆盖 launch preflight 或子目录链接。

建议在 spawn 前检查原始 HOME 输入及已有数据/凭据目录：lstat 确认物理目录、realpath 保持根内、自有权限；允许本任务正常复用，但拒绝外部链接。用合成临时目录覆盖这条 negative case，不读取用户数据。已向主 Agent 报告；此处不修改实现。

## 已独立执行的验证

运行时：Codex bundled Node `v24.19.0`。所有测试均为确定性 mock/临时合成数据，无真实 SDK 请求、账号或模型消费。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| `node --test scripts/build-moxbot-modelqa.test.mjs scripts/build-moxbot-updaterqa.test.mjs` | 6/6 | profile 定义、配置/参数约束、环境 helper；不证明已构建原生包 |
| `model-qa-utility-admission.unit.test.ts` | 3/3 | 普通 SDK 拒绝、utility options、异步 admission 并发隔离 |
| `sdk-child-launch-guard.unit.test.ts` | 17/17 | SDK guard 和既有正常默认行为 |
| `provider-verify.updaterqa.unit.test.ts` | 1/1 | updaterqa credential/model discovery 拒绝 |
| `updater-qa-utility-admission.unit.test.ts` | 3/3 | updaterqa utility/OAuth/vision 后端拒绝 |
| `shell.updaterqa.unit.test.ts` | 1/1 | updaterqa shell discovery 拒绝 |
| `title-generator.unit.test.ts` | 18/18 | 既有 title/utility 行为、终态与清理回归 |
| `session-engine/session-engine.unit.test.ts` | 117/117 | 既有 selector、执行及 updater admission 行为；该套 modelqa mock 为 false，不冒充 modelqa 专项执行测试 |
| `git diff --check` | 通过 | 本轮 diff 无 whitespace 错误 |

共 6 项脚本测试、160 项 Node unit 测试通过。未自行重复完整 lint/typecheck 或 Cargo 构建，避免与实现者正在进行的检查争抢；实现者报告的结果与本报告独立验证分开。

## 证据边界

Rust 日志只读核验位置：`/Users/zhangshaohua/Documents/WPS Cloud/【项目】目录/MoxBot/work/unified-055-20261015/modelqa-rust-tests.log`。读取时约 541–594 行有 `apple-metal` / `apple-cf` 的 Swift bridge manifest/linker 错误，尚无三项 backend 执行通过结果。

源码审阅未见本轮默认 production/MyAgents 新增阻断；这不等于原生包、生产发布或真实业务验收通过。SDK tools/settings 关闭与独立 HOME 是本轮 utility 限制的一部分，不能解释为通用文件系统沙盒；不得据此开放任意工具任务。owned-cloud 允许的是 modelqa 自身 namespace 的获批账号，未允许借用日常账号槽、SDK 历史或生产 reader。

## 启动 preflight 与可撤销 admission 追加复验

实现者增加 `prepareModelQaHome()`，实际 launch 入口先验证原始 HOME，data/codex/claude 用 lstat/realpath/uid/mode 校验。原来有效 HOME/目录链接问题已修；独立重跑脚本 **7/7** 通过（比第二轮新增一项）。native sidecar 的隔离清理另增加 NODE_OPTIONS/NODE_PATH/BASH_ENV/ENV/ZDOTDIR/LD_PRELOAD/DYLD_*，production 分支不变。

ALS 改为可撤销 `{ active }` 对象，utility resolve/reject 后 detached AsyncResource 继承 scope 失效。独立复跑 modelqa **4/4**、SDK guard **17/17** 通过。但仍有两处具体残余，已报告主 Agent：

1. `prepareModelQaHome()` 对关键 config/auth/lock 文件先 `existsSync(path)`；dangling symlink 被当成不存在而跳过 lstat。改为 lstat 捕获 ENOENT，其他类型/错误拒绝，可保留正常不存在文件的创建路径。
2. `createGuardedSdkQuery()` 的 active 检查在 await management admission 之前。已经在途的调用可在 owner 返回/撤销后由正常或 fail-open 分支继续 `createQuery()`。应在实际创建的统一 callback 再检查 active，并测试 deferred management 返回晚于 owner settle 时 create spy 零调用；production 原有 fail-open 保持。

这两项为当前 scoped review 的待修 P2，不宣称完成隔离验收。实现者正在用 release/cache 重试 Rust；debug Swift linker 失败仍保留，本文尚未将新的进行中编译计为通过。

随后独立执行 `utils/app-profile.integration.test.ts` **7/7** 通过：实际编译 profile、真实写入合成临时 HOME 的 config/history/CLI/deeplink/SessionStore metadata，modelqa 用例确认未读写同一合成 HOME 下的 production/updaterqa 根。该结果比 options spy 更进一步，但仍是 Node 本地隔离集成，不是原生应用或真实凭据/Host 验收。

## 阶段提交前最终复验

仅针对两项残余检查实现及回归，未重复其他已通过测试。关键文件改为 lstat、只允许 ENOENT，已有 dangling link 会取得 symlink metadata 并拒绝；新增合成 `codex/auth.json` dangling link 负测。SDK guard 的 `checkedCreateQuery()` 在每条 fail-open 和正常实际创建路径复验 active scope；新增 deferred management admission 在 utility owner 完成后返回，断言 create spy 从未调用。正常分支 guard 抛错仍走原 settle/release。

独立结果：build scripts **7/7**，modelqa unit **5/5**，既有 SDK guard unit **17/17**，`git diff --check` 通过。两个 P2 均关闭。当前 scoped profile diff **没有遗留 P1/P2 阻断，可作为阶段代码提交的独立审阅结论**。

该结论不扩大到进行中的 Rust release 编译，不扩大到尚未审阅的 native fixture handler/page，不扩大到真实模型、OS Keychain 读写、Linux Host、原生 UI 或生产发布。当前暂停，等待 native fixture 接线及指定验收任务。
