# MoxBots 自动更新独立验收

任务：MOXBOTS-UPDATER-20261014。独立审阅者：`/root/updater_independent_acceptance`。

源码工作树：`/Users/zhangshaohua/Documents/Codex/2026-10-14/moxbots-updater`；起始主干 `0bb3f934368860f46c8e19981feb7ab10ddf1709`。2026-10-14 23:25（Asia/Shanghai）审阅的是尚未提交且实现者继续修改的工作树，不能将起始 SHA 当作最终交付 SHA。

## 当前验收状态

- [x] 独立只读审阅 SessionEngine admission、builtin 延迟启动及预热、Rust idle/freeze/release 和待安装包签名复验。
- [x] 独立运行 selector 与 MoxBots updater hook 测试：111 + 4 = 115 条通过。
- [x] 独立运行 transcript writer 与 turn lifecycle 测试：8 + 39 = 47 条通过。
- [x] 独立运行发布工具测试：2 条通过，包含真实 disposable minisign 验证、篡改拒绝、归档路径校验、版本不可变、晋级和回滚。
- [x] 本次发现的问题修复后复核（见下文）；静态与确定性测试 gate 通过。
- [ ] 实际 UI 交互和截图，等待实现者提供隔离候选或 fixture 入口。
- [ ] 官网服务器真实 HTTPS 下载、签名验证和 A → B 安装重启，等待正式制品与实际更新证据。
- [ ] 正式包签名、公证、附票、Gatekeeper 与最终源码对应关系，等待制品。

本审阅未停止、启动或替换已有主 App，未读取私钥或其他秘密，未部署服务。测试使用隔离 fixtures；测试通过不能替代真实更新或 UI 验收。

## 发现与修复复核

### UIR-01：后台下载失败后手动检查无法重试（P2）

复现：远端版本高于本地；Rust 正在后台下载；用户手动检查时 `check_and_download_update` 返回 false；hook 将 `keepDownloadingState` 和 `downloadingRef` 保持 true；随后收到 `updater:download-failed`。原失败事件仅恢复 `preparing`，没有清除 downloading 状态和 ref，Settings 会一直显示下载中，下一次手动检查被 ref 拦截。

2026-10-14 23:34 只读复核已确认失败与 ready 事件均清除 `downloadingRef.current`，失败事件恢复 downloading/preparing；两条独立回归覆盖 false handoff → failed → manual retry，以及 false handoff → ready → signature-error → manual retry，均真实再次调用检查 IPC。该项关闭。

### UIR-02：执行 idle 不代表回答已持久化（P1）

`builtin-session/turn-lifecycle.ts` 的 terminal cleanup 在 transcript persistence 之前将 Session 标为 idle；V2 `transcript-persistence.ts` 的 `persistTranscriptNow` 调用 `writer.requestCommit()` 后即可返回。`selector.freezeSessionAdmissionsForUpdate` 当前没有核对 active transcript writer 的 `liveRevision/durableRevision` 或 IO 状态，所以文件写入仍在挂起或 retrying 时可以允许安装与退出。

既有 shutdown 的 `SessionStore.drainSessionTranscripts` 只有有限时间 flush，未检查 flush 返回 false 后阻止 process exit。因此慢盘、IO 失败或挂起条件下更新重启可能丢失最后一段回答。这不是执行状态 gate 已覆盖的范围。既有 writer 测试已独立证明 timeout 后仍存在 physical IO 与 live > durable 的真实状态，不能把 idle 或 `persistTranscriptNow` Promise 结束当作落盘证明。

2026-10-14 23:30 复核：实现者已在 `SessionStore.assertSessionTranscriptsDurableForUpdate` 只读检查真实 active writer owner，binding 中返回 busy，state 非 healthy 返回 unknown，live != durable 返回 busy。selector 在 admission 已关闭时调用；错误会释放本事务 freeze，不 flush、revoke 或取消 writer。本项原缺口已修复。独立复跑真实 temporary SessionStore 的 delayed `file.append` 测试，拒绝期间 owner 未 revoked，放行 commit 后读回磁盘中的 `must survive` 回答；stability integration 8/8 通过。

2026-10-14 23:34 最终复核已确认 selector 在 DSH native child 异步 observation 结束且 token 再确认后再次同步读 durable，堵住同一次 freeze 内迟到 native terminal event 产生新 revision 的窗口。该项关闭。

### UIR-03：函数改造后遗漏调用（低影响）

`usesDeferredInstall` 改为函数后，startup pending effect 原来仍检查 `!usesDeferredInstall`。2026-10-14 23:25 已看到修复为 `!usesDeferredInstall()`。macOS 本次主路径未因此走错，但原条件没有执行平台判定。

## 已确认的设计边界

- 未观察到自动安装或任务结束后自动重启路径；安装属于用户点击后的显式动作。
- Running、queued、approval、SDK background task、native DSH child activity、初始化/预热及已 admitted mutable Promise 均有独立保护。
- Rust 使用既有 lifecycle admission gate 拒绝新的 resource birth；终端打开、录音暂停/settling、document/speech queue/worker 都按 owner 状态拒绝重启。
- UPDATE_BUSY、UPDATE_ACTIVITY_UNKNOWN 保留待安装版本；失败 release 只释放 exact-generation/exact-token freeze，不停止已有工作。
- 安装读取的磁盘 bytes 再用当前产品 pinned public key 验证；download/install 使用同一 UPDATE_IN_PROGRESS 互斥。
- 发布工具保持 immutable release 路径；stable 原子晋级且保留历史，其他未验收平台不生成假 manifest。
- 本次静态检查没有替代服务的真实 TLS、最终包公证或 App 自动更新执行证据。

## 实际 UI 验收矩阵（待执行）

| 路径 | 实际操作 | 应见行为 | 状态 |
|---|---|---|---|
| 后台发现和下载 | 启动隔离 updater-enabled A；不点更新 | 背景下载；任务保持运行；不安装/退出 | 待实际 |
| Titlebar 重启入口 | ready 时点击；再点稍后 | 清晰确认框；取消不 invoke 安装；ready 保留 | 待实际 |
| Settings 重启入口 | ready 时点击；确认 | 同一确认与错误反馈，不出现强制结束任务选项 | 待实际 |
| 启动 pending | 重启 A，有 pending bytes | 提示版本；稍后保留；不能自动安装 | 待实际 |
| Busy 拒绝 | 真实任务/队列/审批/终端/录音之一活动时确认 | 提示完成后再试；任务连续；pending 保留 | 待实际 |
| Unknown 拒绝 | 受控 exact owner 无法可靠观测 | App 继续；错误可见；不取消任务 | 待实际 |
| 下载失败重试 | 后台下载时手动检查；下载失败；再次检查 | spinner 恢复；可重试；旧 pending 保留 | 待实际 |
| 签名失败 | 隔离 pending bytes 受控篡改后确认 | 不安装/退出；错误可见；要求重新验证下载 | 待实际 |
| A → B | 所有 owner idle 时用户确认 | 安装并重启至 B；数据与标签页保留；实际 binary 版本变化 | 待实际 |

## 独立测试命令

```sh
src-tauri/resources/nodejs/bin/node node_modules/vitest/vitest.mjs run --project unit src/server/session-engine/session-engine.unit.test.ts --project dom src/renderer/hooks/useUpdater.moxbot.test.tsx
src-tauri/resources/nodejs/bin/node node_modules/vitest/vitest.mjs run --project unit src/server/session-transcript/writer.unit.test.ts src/server/builtin-session/turn-lifecycle.unit.test.ts
src-tauri/resources/nodejs/bin/node --test scripts/moxbot-updates/release.test.mjs
```

Node 实测版本 v24.20.0。stderr 中的预期 SDK、存储失败注入日志来自受控回归；上述三组退出码均为 0。

第二轮独立修复复核（2026-10-14 23:30）：

```sh
src-tauri/resources/nodejs/bin/node node_modules/vitest/vitest.mjs run --project integration src/server/session-transcript/stability.integration.test.ts --project dom src/renderer/hooks/useUpdater.moxbot.test.tsx --project unit src/server/session-engine/session-engine.unit.test.ts
```

111 selector + 5 hook + 8 stability = 124 条通过（包含重复复验；不能与第一轮简单相加为独立用例总数）。

第三轮最终独立复核（2026-10-14 23:34）：

```sh
src-tauri/resources/nodejs/bin/node node_modules/vitest/vitest.mjs run --project integration src/server/session-transcript/stability.integration.test.ts --project dom src/renderer/hooks/useUpdater.moxbot.test.tsx src/renderer/hooks/useUpdater.test.tsx src/renderer/components/CustomTitleBar.restorepill.test.tsx --project unit src/server/session-engine/session-engine.unit.test.ts
```

111 selector + 6 MoxBots hook + 4 默认 hook + 7 titlebar + 8 stability = 136 条通过，退出码 0。独立静态审阅与确定性测试 gate 通过，UIR-01/02/03 全部关闭，未发现新的阻断性代码缺陷。DOM 测试仍不等于实际页面验收。

此时关键审阅文件 SHA-256：

| 文件 | SHA-256 |
|---|---|
| src/server/session-engine/selector.ts | 60cba9e737f37448a425407e656b14eb0bcd21c9fe0a157fc418f56ae65bbd93 |
| src/server/SessionStore.ts | f52b1c199a9e1731d29c6b7ee44f07d30ba7949ef8f171c69a1c2d23c1e20af0 |
| src/renderer/hooks/useUpdater.ts | 43fb99c2f0b7a7e50dc6b850ef55badc65299879b26f6c9f3e935aab6e5cce2f |
| src-tauri/src/sidecar/shutdown.rs | 70a41426ce25900b2ee09b5b64ddeb174884758e8bc719368d000952e1d46568 |
| src-tauri/src/updater.rs | 040217b2a8c79504d91db6b0288b138902e79e23d161bb78579d7c247d350bbc |

仍未执行实际 UI、服务真实更新或正式包验收。客户端迁移协调期间，保持 `/Applications/MoXBots.app` 和 `~/.moxbot` 不启动、不退出、不操作、不安装。下一步需实现者提供独立候选及隔离数据目录，再做实际确认/取消/拒绝与 A → B 更新。

## 架构与编辑保存补充复核（2026-10-14 23:58）

本次读到的源码 HEAD：`f8b1dd1157d9d2cedf9122dff415d918869b7764`。迁移 owner 已释放客户端，但本独立审阅仍未操作主 App；真实更新应使用实现者安排的独立 `/tmp` 候选和隔离 HOME，保留主安装目录及其尚未合入的账号/Host 成果。

- selector 现在通过既有 `agent-session` facade 引入 `hasBuiltinActivityForUpdate` 和 `setUpdateRestartFrozen`。真实 activity 判断仍留在 builtin lifecycle owner，background task、MCP mutation、prewarm/timer、processing without Query 的条件与前次一致。
- MoxBots 确认更新后先顺序调用已注册 Record note submitters，再调用 file edit submitters；任一 false 即返回，异常显示错误后返回，不调用安装。保留同一 owner 的保存与错误处理，不调用可能结束任务/录音的 MyAgents exit confirmation。
- 既有 Record 的 flush owner 先等待当前提交，再循环保存更新草稿；FilePreview 的 transition owner 等待 composition/import/in-flight save，发生冲突或保存失败返回 false 并保留 mounted dirty buffer。本次 App 调用的是这些既有 owner。
- AppShellChrome 源码契约分别检查 MoxBots 与 MyAgents 分支；此契约只证明调用顺序，实际 owner 的 DOM 行为测试另行运行，仍不当作原生 UI 通过。

独立复跑：

```sh
src-tauri/resources/nodejs/bin/node node_modules/vitest/vitest.mjs run --project unit src/server/session-engine/session-engine.unit.test.ts src/renderer/components/AppShellChrome.contract.test.ts --project dom src/renderer/hooks/useUpdater.moxbot.test.tsx src/renderer/pages/RecordDetail.note-input.test.tsx src/renderer/features/record/useRecordTabLifecycle.test.tsx src/renderer/components/FilePreviewModal.liveReload.test.tsx
src-tauri/resources/nodejs/bin/node node_modules/dependency-cruiser/bin/dependency-cruise.mjs --config .dependency-cruiser.cjs src
```

225/225 用例通过：selector 111、AppShellChrome contract 16、MoxBots hook 6、Record note 51、Record lifecycle 12、FilePreview live reload 29。dependency-cruiser 退出码 0，2354 modules、9572 dependencies，0 errors、16 个既有 no-orphans warnings；没有放宽规则来跳过 selector 边界。DOM media pause 的未实现提示是 jsdom 环境限制，本次未将其计为原生录音/播放验收。

本轮没有确认新的阻断缺陷，静态/确定性 gate 保持通过。仍等待独立候选，实际原生 UI、真实更新安装与公证制品验收未验证。

| 本轮文件 | SHA-256 |
|---|---|
| src/server/session-engine/selector.ts | c272df3f178aafbcd7ed92ea92259665f1903fec33d85c9a1de8d5e0a7723225 |
| src/server/agent-session.ts | 2deeeb47ea26085cde7abaa2cf7c0a4e58f3ca1ddb4b1b669c9f715748f2a8f8 |
| src/server/builtin-session/lifecycle.ts | 0bc4db6f83a3714a80281f225e53bb201cfce3f5552649edc291c118b73f4f78 |
| src/renderer/App.tsx | dc81286e489596b98da10d5212716678a3f72a949d3b0060a1089e9e999c06ec |
| src/renderer/components/AppShellChrome.contract.test.ts | 35365b078cc77e229475ea191b2467f7e26714b2b4da8808def531968670e211 |
