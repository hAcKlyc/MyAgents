<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/remote-session-20261015 -->
<!-- git-project-sync-task:base=ff957fdf078d8e96e732c5b22c89ee2f41337fe9 -->
<!-- git-project-sync-task:status=in-progress -->

# REMOTE-SESSION-IMPLEMENTATION-20261015

用户授权：2026-10-15 开始开发。前序设计与本地原型已认可。

目标：同账号网络设备的 Agent 可直接打开独立远程会话窗口，查看/新建/继续会话、响应实际审批与提问、明确停止。复用远端 SessionEngine/SessionStore，不通过 @，不新增公网入口。首版有界快照同步；Host 保留单活跃执行限制。

## To Do

- [x] 确认权威仓库、分支、remote/worktree及并发状态：独立worktree从origin/main ff957fdf创建，保留原checkout。
- [x] 协议与 owner 边界：owned encrypted management session.remote 扩展，不改vendor固定协议包。
- [x] 桌面与Host执行 owner：配置冻结、权限检查、durable operation receipt、精确generation/turn审批和停止。
- [x] RemoteSessionTab：账号隔离、真实快照、分页、断线恢复、不自动重发、关闭窗口不停止。
- [x] 代码检查及模拟验证：TypeScript/Rust、IPC/DOM/权限与重复请求反证、独立审查。
- [ ] 真实联调：两设备身份与真实Provider会话；模拟通过不替代此项。
- [ ] 提交、CI、合入远端主干并核实SHA。
- [ ] 候选包、发布、真实用户路径复验：受现有release owner/资源签名/原生工具链约束。

## 并行责任

主Agent：shared协议、desktop Node owner、receipt/projection、集成/验收/主干交付。host_audit：Host supervisor/worker/IPC。remote_transport：Rust协议/actor/desktop target。remote_ui：renderer独立Tab与入口。均在本worktree，互斥文件范围，禁止操作生产或扩大范围。

## 当前证据

- 同步主干0c7后的全量unit：560 files，5625 passed / 5 skipped；DOM267 files / 2290 passed（37279整合时）。原基线unit5607通过。
- 定向owner/receipt：含真实Global Node routes与跨进程落盘handoff、并发与失败注入、过期进程租约、10k总容量（模拟容量2）、不保存prompt。最终聚焦测试14+1通过。
- Host：service7、IPC11、真实worker3、Bot1；排队ACK helper3；保留Bot执行权限与私有history。
- Renderer：账号/冷恢复、API、持久操作编号、DOM、分页、安全Markdown等回归通过；实际组件1280/390流程由非UI实现者验收，见 `dev-docs/remote-session/ui-simulation-review.md`，均为模拟传输。
- Rust：协议25、pairs16、controller13、admission owner1通过；Host与protocol Clippy通过；DOCS_RS desktop type-check通过。
- TypeScript全量、完整lint/依赖门禁/文档链接通过（16既有orphan warnings，无errors）；Web/Node MoXBots profile构建通过。合并后真实Node/Host owner30项复验通过。
- 原生构建限制已重复核实：CommandLineTools Swift6.3.2的apple-metal PackageDescription arm64 undefined symbol，当前无完整Xcode。DOCS_RS不能代替真实原生构建。
- 真实双端、Provider、安装客户端、发布验收仍未完成。

## 当前交付与下一步

PR45：https://github.com/heavenzhang/MoXBots/pull/45。源实现32518221，已整合主干0c7b8e72。3330471e的CI五项Rust/平台检查通过；Node集成测试仅Linux旧资源列表断言失败（新增远程夹具产生第二Agent）。修正为创建receipt准确身份、完整列表/长度/roots/revision断言，本机IPC11/11通过，Linux分支须CI复验；不降低门禁。新主干d7264a43反馈中心已同步；仅plan追加记录冲突，保留双方记录。独立复核183项组合DOM通过；发现A账号退出确认框可滞留到B的问题，最小修复为exact projectionBoundary核验并在边界变化关闭菜单/确认。新增账号切换/generation反证，与remote/store/fence合计38项通过。整合后TypeScript通过。86f候选重建已在Vite阶段仅停止本任务builder树，须按修复后HEAD重建；不将中断产物当成果。

原生缓存：锁定apple-metal62、apple-cf87、screencapturekit70源码文件全匹配；APFS复制到独立target，不修改旧target/fingerprint/output，普通Cargo（无DOCS_RS）probe实际Metal/CF运行成功。证据 `/private/tmp/moxbots-remote-native-cache-probe-20261015/evidence.json`。当前无完整Xcode，fresh-cold Swift环境问题仍未修复。

标准MoXBots builder已完成3330471e真实原生编译/打包（无DOCS_RS，无stub；固定reader验证通过）。候选 `/private/tmp/moxbots-remote-session-candidate-20261015/target/aarch64-apple-darwin/release/bundle/macos/MoXBots.app`，日志 `/tmp/moxbots-remote-session-native-candidate.log`。未签名、未安装、未发布、未做真实双端/Provider验收；后续主干整合变化需重新构建。

明确的日常App保护约束：WPS项目 `output/formal-install-20261015/PROTECTED-DAILY-APP.md`。不借用/修改日常App、~/.moxbot、登录或钥匙串。开发目录本身不证明bundle/单实例/数据/端口/credential namespace隔离。本候选未启动。已有101验收记录普通execution=false且Agent禁用，不能擅自开启；本机SSH agent的只读BatchMode连接返回publickey,password拒绝，尚未找到本任务可复用的Host凭据路径。

下一步：整合最新主干、六项CI全绿、合入并核实远端main；重建与记录最终候选。真实验收需独立测试身份/运行环境及目标已授权的可执行Agent，正式发布仍须签名/公证、活动owner、回滚与真实用户验收。不得把源码/模拟/原生编译冒充生产可用。


## 2026-10-15 actual integration resume and capability compatibility fix

Feature PR45 and final014105a2 are on main. Formal signed/notarized0.5.4 freezes runtime e5a05f76; root verified installation and four restored tabs/8projects/35sessions, preserving original transcript bytes, Providers and attachments. Current remote main c7bab285 includes feature and release records. Local SwiftPM CLT incompatibility was solved with a task-local public-interface/library-preserving overlay, full fresh three-bridge probe and standard client rebuild; no system/dependency changes or stubs. Earlier cold-build/protected-daily-app statements above are historical and superseded for this task by verified repair and the user's explicit local non-isolated installation/testing authorization.

User now explicitly approved the existing dedicated Linux-Host Agent and Kimi Coding/k3 few-turn conversation/file-approval validation. Existing controlled operator SSH was verified read-only. Target actual Node dd7192d4/native114e2ac5 predates the feature; Host is idle, no children, original threeAgents disabled and executionfalse. No target config/key/Agent/model has yet been changed. CI38623129708 Node/native artifact checkout83e48946 has the same Git tree5c8347c5 as signed runtimee5. Prepare paired upgrade with existing identity/data/unit/policy safeguards and rollback; keep unrelated namespace/services intact. Operator preparation is not remote-business acceptance.

Detected and reproduced a production compatibility defect: src/host/main.ts advertises session.remote in host.capabilities.methods, while the renderer's strict OwnedHostCapabilities codec rejected that existing method. The new regression failed HOST_MANAGEMENT_RESPONSE_INVALID before the fix. Accept only this known capability in the renderer type/schema; arbitrary methods remain rejected and Host configuration write operations are unchanged. Focused API/Host management/Provider DOM/remote-session suite38 passed; Node24.20 typecheck/scopedlint passed. CI and main delivery of this small fix remain pending. Existing0.5.4 archive bytes must not be overwritten; the corrected installed desktop requires a new signed version and safe update window.

- [x] Verify main, authorized local0.5.4 install, source/artifact and data preservation.
- [x] Exact authorization to enable only the dedicated testAgent and reuse Kimi credentials; no repeat permission question.
- [x] Read-only real Linux runtime/activity and existing controlled credential location verification.
- [x] Regression-first reproduction and minimal renderer capability codec fix; unknown capability rejection retained.
- [ ] Required CI, main merge/push/SHA verification for this fix; new signed desktop package and safe installation.
- [ ] Paired testHost upgrade with verified source/digests, runtime idle/backup/rollback and unchanged identity/policies.
- [ ] Exact dedicatedAgent enabled/default approval mode, encrypted Kimi credential and execution-authorized owner writes; persist receipts and before-state.
- [ ] Native direct open/send/continue/allow-once/deny/stop/reconnect/persistence and source-side no-executor acceptance.
- [ ] Restore temporary execution/Agent authorization, release all task-owned GUI/control windows; retain evidence and limitations.

GUI lease is temporarily released for queued feedback/title verification; root performs only CLI/source preparation and must reclaim the shared native lease before UI actions. Private receipts/screenshots remain outside Git and raw credentials are not logged or committed.


## Objective

Deliver direct same-account remote Agent conversations on the original Session owner, including continuation and exact approvals. Resume actual Linux/desktop acceptance under the user's explicit dedicated Kimi test authorization; repair discovered compatibility defects.

## Acceptance criteria

Code and meaningful regression gates pass, all required CI passes and remote main contains the result. A source-verified paired testHost upgrade preserves identities/state/policies; real isolated desktop open/send/continue/approvals/persistence are proven separately. The unified owner signs and installs the next immutable0.5.5 package after all owners deliver main, without interrupting user tasks.

## Completed

PR45 feature/main, formal0.5.4 installation/data restoration, task-local cold Swift build repair, actual SSH/Host idle/version inspection, and minimal known-capability regression fix1c534aea. Target3Agents remain disabled, executionfalse, no credential mutation or model calls yet. PR49 tracks the discovered compatibility defect.

## Verification

Regression failed before fix; focused38 tests pass on Node24.20, typecheck/scopedlint pass. Artifact CI38623129708 is successful; its83e48946 checkout tree equals runtimee5a05f76. Existing source/installed-client evidence stays outside Git. PR49 required run38653219767 remains pending.

## Blockers and unknowns

Actual target predates session.remote and needs controlled paired upgrade. Target dynamic Kimi credential is absent, existing authorized local Kimi credential is available. Host management API cannot enable the disabled registry Agent, so exact operator preparation is separate from native remote-business acceptance. GUI is queued behind feedback/title; no concurrent installation or UI interaction. New fixed signed client is owned by unified0.5.5 release coordinator.

## Next step

Pass PR49 CI/merge/remote-main verification. Finish verified CI Host artifact transfer and safe paired upgrade/rollback preparation; enable only the approved dedicatedAgent. Reclaim GUI only after explicit release and use the unified real-model isolation profile for few-turn Kimi/approval acceptance. Return precise receipts/source/results to the already authorized unified owner; final signing/update is centralized.
