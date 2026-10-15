# Model QA HOME 绑定独立审阅

任务：`MOXBOTS-055-UNIFIED-ACCEPTANCE`。审阅者：`/root/updater_qa_review`。日期：2026-10-15。

范围为 `7b930136fb819a888ea5a34dd7b393714871f793` 加 Root 未提交的 QA HOME/container diff；Root 独占实现，审阅者仅写本文。没有 GUI 租约、没有 GUI/模型/生产/SSH 操作，没有读取真实 Keychain、密码或 auth/config 凭据内容，没有修改共享源码或提交。

## 结论

在本任务**固定 Mac、全新 A6 HOME/私有 Keychain、全新设备与正常 PKCE、不迁移 A5 owned 状态**约束下，当前 diff 未发现可复现的 P1/P2 凭据逃逸；可以进入候选构建及原生身份读写/联网验收。此结论不是 A6 原生、真实 Keychain roundtrip、owned actor 在线或 Host 业务验收通过。

共享 `agent-network-crypto`、`agent-network-crypto-parent`、Reader 与 pin 文件 diff 为空；原有认证、stdin 闭集请求、UIFail/authorize 区分及 helper deadline 实现没有修改。生产的 owned-account SERVICE 值保持原值，modelqa 改回现有 helper 允许的标准 service，依赖私有 Keychain、APP_DATA hash、物理 identity scope 维持隔离；不允许用此变更读取/迁移 A5 旧槽。

## 已检查的接线

- [x] `main.rs` 只有 `cfg(all(target_os="macos", myagents_model_qa))` 在现有 reader 前调用 QA startup guard。普通 production/MyAgents/updaterqa 不进入 HOME 恢复。
- [x] 只有精确单个私有 helper flag 且 HOME 真正缺失才恢复编译常量。非空错值、空值、非 UTF-8、普通 GUI/CLI 缺失及私有 flag suffix/extra args 拒绝；恢复不由请求体或运行时可变路径指定。
- [x] Node builder 必选 `--qa-home`，只接受 ASCII direct-child `/private/tmp/moxbots-modelqa-*`，覆盖继承编译变量；Rust build.rs 独立验证并设置 `cargo:rerun-if-env-changed`，其他 profile 注入 QA HOME 拒绝。PlistBuddy 参数无 shell 拼接，launcher 读取 artifact 的 HOME 字段需精确匹配。
- [x] HOME/Library/Preferences/Keychains 验证 physical/canonical/UID/private mode；default keychain 为普通文件、单 link、private mode。已有 security prefs 拒绝 symlink/异 owner/硬链接/他人可写；没有 create/unlock/set-default/search-list/fallback。
- [x] User domain 常量 0 与 pinned security-framework-sys enum 一致，使用真实 `SecKeychainCopyDomainDefault` / `SecKeychainGetPath` 元数据，不凭 plist 声明推断 default。返回路径必须直接位于编译 HOME 的 Keychains 目录且实际文件验证通过。
- [x] ModelQaIdentityStore load/save/delete 在 backend 前复验；owned account read/write/auth-read/delete 的实际 I/O 前复验，而非仅 Entry 构造时检查。现有 scope 映射不变。
- [x] 未修改 SessionEngine/update admission counters。隔离 HOME 校验在 credential I/O 内部，不放宽既有 owner/generation/取消边界。
- [x] A5 HOME、Keychain、人类 test 和 owned session/device/token/state 保留，不迁移；A6 只最小投影本任务授权的模型 key/CLI auth/allowlist，重新设备及 PKCE。该操作由 Root 执行，审阅者未读取投影内容。
- [ ] 候选 A6 编译闭环、helper 冷启动读回与正常 PKCE 后 actor 实际联网由对应 owner 接续验收。

## 独立测试与更正

Codex bundled Node `v24.19.0`：`node --test scripts/build-moxbot-modelqa.test.mjs` **6/6** 通过。额外只调用路径 validator 的末尾 LF、CR、CRLF、U+2028、U+2029 五个合成负例均拒绝，没有创建该类目录或执行外部程序。`git diff --check` 通过。

**撤回早期 Linux ENOENT 误报。** 审阅者漏读了 native physical-home 测试现有的 darwin-only 条件；文件第 47/63 行两组均显式 skip 非 macOS，runtime-policy 使用 realpath(tmpdir)，parser 不建目录。因此当前没有此 CI 阻断，也不需要泛化跳过其他身份/注入契约。

Root 报告 Node 组合 **9/9** 已通过。随后审阅者独立核对 `modelqa_home.rs` SHA-256 为 `dedc35841af5f1083be4a3407c02d46c23514c98b810d14cbd65c8e0fd6325fa`，与 Root 给定源码一致；直接运行 `work/unified-055-20261015/modelqa-home-unit --nocapture`，standalone Rust guard **3/3** 通过、无忽略项。该二进制由 Root 用 cache 的 libc/tempfile 编译，审阅者没有重编译或启动 Cargo；本次三项为独立复跑结果，仅合成文件元数据与 fake default resolver，不查询真实 Keychain。

## 测试与设计的准确边界

Rust guard 三项覆盖 HOME 选择、路径/UID/mode/symlink/hardlink/default escape、default drift 时合成 mutation counter 为零。它们没有调用真实 OS default resolver。现有真正 I/O guard 在 `not(test)` 下被排除，因此“guard-before-backend”目前由源码检查确认，不能说三项测试已经执行了实际 IdentityStore/owned I/O 接线。最有价值的后续回归是给现有 guard 增加默认拒绝的 test validator 或注入 resolver，再以真实 owner/backend spy 验证 drift 时所有后台调用为零；不需要改变共享协议。

实现未额外比较 getpwuid 返回的 OS account home。审阅者只读核对 OS 账号路径元数据，确认本机真实 HOME 位于所有允许 QA 根之外，real/effective UID 一致；故本任务没有当前路径混同证据。若该 profile 将来用于非标准 OS home 配置，应增加显式拒绝与纯负例，不能把临时目录前缀当作所有机器的普遍证明。

这是进程配置与私有目录隔离，不是对同 UID 恶意修改的 OS 沙盒；不因此授权扩大普通模型工具权限或借用日常身份。正式 production build/OS default 不在本次变更和验收范围内。

## A7 launcher umask 有界追加审阅

在 HEAD `6c48e25ca7939c41da8af2b432d4b026180f020f` 上，仅独立审阅未提交的 `run-moxbot-modelqa.mjs` 与 `build-moxbot-modelqa.test.mjs` 两份 diff。新 wrapper 在同步 `spawn` 前将本 CLI 的 mask 临时设为 `077`，并在 `finally` 恢复；正常返回和同步参数校验抛错均恢复。调用仅替换 QA App 的 spawn，未增加异步间隔、凭据读取或生产入口。未发现本次改动的 P1/P2 阻断。

独立使用 bundled Node 24 运行 `node --test scripts/build-moxbot-modelqa.test.mjs`，**7/7 通过、无跳过**；新增用例实际启动纯合成子 Node、写入合成文件并验证 `0600`，同时检查成功及同步失败后的父进程 mask 恢复。Root 报告的组合 10 项未由本次审阅重复运行，不与独立 7 项混同。

作用仅限此 launcher 未来新建 QA 子进程及其后续继承者的创建 mask，不改变现有 A6、日常 App 进程或 OS 设置，也不修复已有文件权限。mask 对显式 chmod 或修改已有文件权限没有禁止作用；同 UID、私有目录隔离仍不构成 OS sandbox。本次没有 GUI、模型、真实 Keychain API 或凭据内容读取，也没有修改两份实现/测试脚本。
