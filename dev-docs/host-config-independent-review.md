# 独立验收：MOXBOTS-HOST-CONFIG-20261013

状态：待最终冻结SHA确认。已完成非实现者源码集中复验与主Agent实际IAB截图独立审阅；本子Agent未进行实际IAB交互。模型primary回显及writeAvailable dispatch gate已静态闭合；现代Host显式执行授权入口回归已静态修复；等待最终SHA与主Agent测试结果确认。没有使用真实 Host、真实密钥、用户 Chrome 或现有已安装客户端。此记录不能证明真实 Host 联调、原生安装或生产验收。

范围：Host 详情复用 Settings Provider/模型交互、桌面当前主 Agent 配置复用、远端目录浏览/选择。唯一写入文件为本报告。依据：用户 AGENTS 指令、`specs/tech_docs/host_configuration_reuse.md`、`specs/DESIGN.md` 状态可信/真实语义/跨平台及无障碍原则。

## 新发现（初审源码，尚待修复后冻结复验）

- [ ] **P1 本地注册表越界可达。** `OwnedHostProviderConfiguration.tsx:57–62,77–79` 保留 source provider 原始 ID，只把 `isBuiltin` 设为 false。`ModelManagementPanel.tsx:138,168–198,428–468` 的 TokenDance/OpenCode 特殊发现/添加路径按 ID 判断，直接调用 `atomicModifyConfig`/`rebuildAndPersistAvailableProviders`，没有 builtin 或外部受控门禁。打开对应 API Provider 的 Host draft 管理模型，模型发现或添加可触发桌面本地注册表持久化。要求显式隔离受控模式或确保所有内部写路径不可达，并验证桌面 config 未改变。
- [ ] **P1 当前 Host 配置编辑依赖有效桌面 source。** `OwnedHostProviderConfiguration.tsx:33–34,77–79,186–190` provider/fields 初始 null，唯一赋值入口是 source 导入；extended snapshot 只提供 ID/model，不能 hydrate 已配置 profile。复现：Host 已配置，desktop default Workspace/provider 为空或不支持；重新打开 Host，无法编辑原模型、连接参数或保存 profile。需 owner 读取非密钥 profile，或提供不依赖 source 的手动/预置配置入口。
- [ ] **P1 未确认远端映射时静默用首个 root。** `OwnedHostProviderConfiguration.tsx:36` 无合法现有 workspace 时默认为 first-root/empty-path；导入只检查 rootId 后立即发送配置。Mac 本地 source path 只是提示，此 fallback 会把工作区设为根而不是强制选择。需未映射状态为空、显式选择后才允许应用；已有合法 Host workspace 可保留。
- [ ] **P2 单层目录不能返回根。** `OwnedHostDirectoryPicker.tsx:49,58` 在 `relativePath="child"` 时 parent 为合法空字符串，却被 `disabled={!parent}` 禁用。应判断 parent===null；复验 root→中文/空格 child→返回根。
- [ ] **P2 首页面/错误状态刷新无效。** `OwnedHostDirectoryPicker.tsx:47,58` effect 依赖 root/path/cursor，Refresh 只把 cursor 设 undefined、history 清空。首页面 cursor 已 undefined，刷新不重新请求；第一次请求错误也不能重试。需 refresh generation 并复验同路径新增项/错误后重试。
- [ ] **P2 extension 逐方法能力未体现。** `OwnedHostManagement.tsx:95–102` 仅确认 inspect/config-set/list 后丢弃 capabilities；key/recovery/register 按钮仍发送未广告的方法，providerKinds 也未下传。需按方法与协议分别 gate，避免半升级 Host 执行不支持操作。验收 fixture 必须覆盖缺 credential/provider-receipt/register 方法。

- [ ] **P2 新 Host 成功加载后仍显示加载中。** `OwnedHostManagement.tsx` 的 loading 条件为 `online && !snapshot && !notice`，extended snapshot 始终不满足 legacy snapshot，成功显示新配置面板时仍留下 loading 状态。应以所有 snapshot/value 判断完成。

## 已观察到的契约（只读证据，不等于运行通过）

- `desktopHostConfigSource.ts` 以 defaultWorkspacePath 匹配 Agent，显式 Agent provider/model 优先；missing/disabled/archived/ambiguous/external runtime 分别报错。应用时重新读取 config，source credential 只在局部变量内用于发送，不进入 sourceHint 或 pending identity。
- SHA-256 version profile 冻结 provider endpoint/protocol/aliases/model；config 与 credential 分离写，credential 绑定 prepared version ID。源码已增加 scope 检查、pipeline lock、write lock、manual profileDirty gate 与部分成功反馈；须等最终版本再验证迟到/并发/未知回执。
- Settings 共用 `ProviderConnectionFields` 与 `ModelManagementPanel` 有真实组件导入；不能据此断言完整 Settings 选择/预置/密钥控件复用已完成。
- 旧 Host fallback 仅在明确 `HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE` 发生；主 socket/epoch 未变需 Node/Rust integration 或实际旧 Host 证据，界面源码不能证明。

## 冻结后界面验收清单

- [ ] 1280×800 与 900×800：打开 Host 配置、目录 picker、模型管理；截取实际 rendered evidence，检查布局/滚动/按钮和长 Unicode path。
- [ ] source Agent 优先于默认配置，应用前变更 source 后读取新值；portable API 正常，订阅/runtime/local proxy 明确失败。
- [ ] 空 source 下已配置 Host 保持可编辑；未配置 target 不自动用根；source 不含 key 时准确配置-only。
- [ ] model draft 的所有操作只走 controlled callbacks，真实本地 registry 不写；重新打开可查看实际 persisted profile。
- [ ] apply config→key 两阶段成功/配置失败/密钥冲突/未知 receipt 恢复；没有自动重发未知写；手动 key 绑定实际 persisted version。
- [ ] 延迟 source/hash 时关闭、切 Host、身份改变、source error、重复点击；不存在晚发旧 Host mutation或未解除忙状态。
- [ ] root 切换、child→root、Unicode/space、下一页/上一页、第一页刷新、分页目录改变、symlink 不显示、offline、empty/error 和 retry。
- [ ] 显式 register 非根目录，返回 disabled Agent；create 失败不误报成功。
- [ ] keyboard Tab containment、Escape/IME、打开初始 focus 与关闭 focus 恢复；无后台可聚焦覆盖内容。
- [ ] 旧 Host legacy form 可配置，缺方法/缺协议 capabilities 精准禁止对应动作；不能用整体降级隐藏可用功能。

未执行：实际 IAB fixture 操作、原生客户端、真实 Host 私有管理路径、重启持久化、真实账号/权限、生产发布。解除入口阻断需主智能体提供最终冻结 revision 与隔离 fixture URL/应用绑定。

## 隔离 fixture 准备与工具边界（2026-10-13）

新增获授权的 ignored 本地 harness：`playground/host-config-qa/`，运行命令与场景/截图点见其 README.md。真实组件与 CSS/i18n 保持复用；仅截断 Tauri transport 和 source config 读取，source version函数仍为真实实现。完全合成 scope/API/path/key，non-management invoke强制拒绝。

已验证：Vite build成功（230模块）；loopback URL `http://127.0.0.1:5187/` HTTP200；这些仅证明 harness 构建与服务状态。尚无实际UI截图或交互通过证据。

工具阻断：子Agent cua.createBrowserTab('iab', URL) 返回 `Browser is not available: iab`；主Agent交付 tab2/browser4 后，子Agent cua.getTab('2',{browser:'4'}) 返回 `Browser is not available: 4`。子Agent浏览器inventory只有Chrome/Brave扩展，未选择/操作；主Agent能绑定其IAB 4，故已交还主Agent进行实际界面验收。

更新源码显示初审7项已有修复方向：snapshot provider hydration、空默认workspace、Host synthetic draft ID、逐方法能力、parent===null、refreshGeneration、loading排除extendedSnapshot。尚未冻结，不据此勾选通过，实际UI与真实Host结论保持未验收。

## 修复过程残留（未冻结）

- [ ] **能力需在 dispatch 内检查。** 当前 `importDesktop`→`saveCredential` 未检查 credential method；apply 按钮只检查当前 draft 的 protocol，导入后的 source protocol 可能不同。缺 credential 时禁止该段、准确配置-only；不支持 source protocol 时不可 config dispatch。不能仅靠按钮 gate。
- [x] **已修复源码：hydrated immutable ID 反复版本化。** `versionPortableHostProfile` hash identity包含profile.id；从snapshot hydration得到既有版本ID，再次save会对版本ID重新hash/追加，完全相同metadata/model也生成新profile，占用bounded容量且原key不自动对应。当前helper已使用sourceProviderId??profile.id并返回sourceProviderId，版本identity来源稳定；主Agent报告16unit通过（本审查未代替其执行）。fixture改用真实helper预计算provider ID，避免随机初始ID造成误判。运行UI仍待主Agent。
- [ ] **source catalog读取跨版本。** `loadDesktopHostConfigSource` catalog使用initialConfig，之后currentConfig仅更新选择/keys/aliases。期间custom provider endpoint/protocol/model定义变化，生成混合source。需最终config对应catalog，并验证endpoint更新一起重读。
- [ ] **目录弹窗键盘焦点。** 初始focus有实现，但未见Tab containment和关闭后focus恢复。aria-modal不等于trap，必须实际键盘复验；若不可复验不宣称通过。

Harness 自检纠正：Vite transform 原先在 esbuild 后，typed signature regex 未命中source读取stub。所有非管理Tauri IPC仍拒绝；旧source操作结果无效。已修正为 enforce:'pre' 且 stub未命中直接报错；读取served module确认实际函数仅 `return await window.__hostQA.source()`。主Agent已通知 reload后重验source路径。

源码更新观察：source catalog现在从同一个 freshly-read currentConfig派生，dispatch时检查prepared protocol/method，saveCredential检查supportsCredentialWrite。上述两项静态残留已关闭，最终冻结UI仍待主Agent。

继续更新：目录picker已加入Tab边界循环与unmount focus恢复，静态焦点缺口关闭，实际键盘结果由主Agent核验。最后两个待核门禁一致性：一键apply与saveProfile内部未见activeSession检查（只有手动save按钮禁用）；scope effect不依赖online，source/hash等待期间online变false时closure仍保留online=true，可能继续尝试发送配置。后端拒绝只能证明不会持久化，不等于界面不尝试；需冻结前确认处理方式。

## Harness CSS gate 修正

主Agent IAB发现原harness Tailwind未扫描renderer，导致product border/rounded/spacing/w-full缺失；此前截图仅是harness失败证据，不能据此验收产品视觉。修复仅harness qa.css：import原renderer index.css，@source ../../src/renderer，main改为导入qa.css，保留原theme。实际served CSS module 282669 bytes并包含 rounded-xl/space-y-4/w-full/border/sm:grid-cols-*/p-4，原文保留 playground/host-config-qa/evidence/served-css-module.txt。未改产品CSS。harness在此修复后冻结交回主IAB，不再连续修改。

主IAB另发现Directory effect随locator对象重新创建导致请求循环，UIworker修复中；该界面真实运行问题不得被先前源码方向判断覆盖。仍未有子Agent实际UI证据。

Harness credential owner真实性修正：原fixture config切到新provider后保留旧credentials provider/configured，主Agent指出与Node inspect契约不符。已改per-provider credentialStates与selected ID projection，既有版本true/rev1，新版本false/rev0；credential写绑定ID更新map。此修正后需要reload，此前partial的key configured标签无效。CSS/loader保持冻结。主Agent报告实际IAB目录loop已修并复验通过，此报告仅记录主Agent结果，不替代其截图/调用证据。


## 最后集中复验（development tree，冻结SHA待交付）

当前结论：此前 R1–R7 已在源码中闭合；后续 source catalog一致性、版本origin、dispatch方法/协议、目录焦点与请求对象loop也有对应修补。剩余本轮模型状态回显问题与尚在测试的writeAvailable发送门禁需最终确认，不宣布全部接受。

| 问题/契约 | 本次只读复核 |
| --- | --- |
| Host 模型面板本地registry越界 | resolvedProvider固定host-draft-* ID、isBuiltin:false，Controlled callbacks负责模型新增/选择；TokenDance/OpenCode id特殊atomic分支对该合成ID不可达；参数编辑明确关闭、目录候选只用于选择 |
| 空source已配置Host编辑 | provider/fields hydrate owner snapshot.provider；manual draft不依赖source；已有model/path保持可编辑 |
| 静默root映射 | 无合法settings.workspace时rootId空；source apply打开picker而不config dispatch；已有owner workspace保留 |
| 单层返回root、首页refresh/error retry | parent===null gate；refreshGeneration依赖明确；分页cursor/history保持bounded |
| capabilities | inspect-only启动可显示，profile/credential/register/list分别gate；profile发送前检查prepared protocol；缺credential明确配置-only/unsupported反馈 |
| loading残留 | legacy/extended均不存在才显示loading |
| async lifetime/duplicate | scope key包含locator与全部owner identity；组件key使用fullscope；source pipeline epoch、manual preparation token、write lock；offline/stopping终止准备；activeSession禁止profile但允许key写 |
| profile→key→receipt | source key局部变量，pending只留identity；密钥写目标为prepared persisted version；known失败与unknown查询文案分开；profile origin稳定；key写仍需最终writeAvailable gate确认 |
| directory locator loop | effect依赖locator/scope的primitive值，而非新对象；主Agent报告IAB重复请求已复验关闭 |
| model candidates | source.models最多128，过滤不兼容endpoint/protocol/auth模型；Host只保存selected model，说明文案明确不是完整catalog |

**本轮新增残留 P2：模型面板 Primary 状态回显。** portableHostProviderToRegistry给primaryModel=models[0]；resolvedProvider目前未覆盖primaryModel:model。onSetPrimaryModel只setModel、不重排候选，所以选第二候选后外层input变更，模型panel仍将首候选标为Primary，重开也不一致；source.models首项也不保证等于Agent选择。已要求UIworker明确primaryModel:model并测重开后的Primary标识。

**writeAvailable范围：** 手动keyinput/submit已有disabled gate，当前read版saveCredential仅mayWriteRef/supportsCredentialWrite等，尚无snapshot.credentials.writeAvailable；source apply同样可尝试送key。主Agent已说明最后补丁正在测试，待SHA核实，不重复列为新问题。

### 独立查看实际截图

使用view_image实际查看如下主Agent IAB PNG（时间来自文件mtime，Asia/Shanghai，2026-10-13）：

- `moxbots-host-config-evidence/configured-900.png` 22:15，900宽full-page bitmap（高度1217）；字段、按钮、路径均完整，未见水平裁切；可见“浏览Host目录”focus outline。截图早于最后model候选/selection-only修补，不能验证最终模型panel。
- `moxbots-host-config-evidence/directory-1280.png` 22:15，1280×800；真实picker居中、中文/空格目录与分页动作清晰，选中目录按钮focus可见，尺寸未溢出。静态截图不能证明Tab循环/刷新/分页事件；这些由主Agent IAB交互证据负责。
- `moxbots-host-config-evidence/partial-900.png` 22:28，900宽full-page bitmap（高度1297）；新profile/model已显示，key输入空、提示Host尚未配置密钥；底部准确写“配置已保存，但密钥未更新。请查看Host密钥状态后重试。”，没有要求查询不存在的回执。该截图涵盖known failure修补，但早于最终model primary/writeAvailable修补。

没有重试本子Agent不可用的IAB、用户Chrome或已安装客户端。源码与截图证据没有证明真实Host加密通道/实际身份授权/重启持久化/生产发布；最终真实Host验收仍归主Agent。


## 末次只读复核：执行授权回归与最后两项闭合

**P1 已确认：现代 Host 缺失既有显式 owner GUI 执行授权路径。**

- `OwnedHostManagement.tsx:365–367` 的旧“允许本地会话执行”checkbox仅位于legacy snapshot分支；capabilities/inspect成功时使用extended panel，不显示该分支。
- `OwnedHostProviderConfiguration.tsx:171` 的config.provider.set始终传 `snapshot.settings?.executionAuthorized ?? false`，不存在手动执行授权控件；source应用的保持授权行为本身符合规范，但不能替代手动owner授权入口。
- `src/host/management.ts:247` 对generic配置绝对禁止false→true。`configureHost` 在`:118` 经legacyHostRepresentable判断，generic配置后因hostProviderWorkspace存在（`:161–162`）返回upgradeRequired。`src/host/main.ts` 管理dispatch未发现另一个执行授权method。源码/CLI搜索亦未找到可供现代owner GUI使用的其他动作。
- 复现链：新Host现有授权false→现代client通过capabilities选择extended panel→手动/桌面source配置API profile（授权保持false）→后续generic无法true，legacy配置也不能继续。即使generic之前仍可由旧接口授权，现代UI没有旧checkbox入口；这会使用户原先能显式开启执行的操作消失。

最小修补建议（未实现、未执行权限写入）：恢复现代手动owner checkbox及明确保存动作，source一键永远发送实际snapshot授权，不读/复制本地Agent执行授权。现有authenticated owner `config.provider.set`已有executionAuthorized布尔参数，可让明确手动设置生效，并继续CAS/mutation/activeSession/身份门禁；避免新增公网接口。如果后端仍要区分source与手动intent，可评估封闭intent，但这扩大wire范围，不是默认必要动作。

最后两项静态闭合：resolvedProvider已显式 `primaryModel:model`，候选选择/重开标识来源保持一致；supportsCredentialWrite已同时要求credentials.writeAvailable，saveCredential和source key段复用该gate。子Agent未重跑DOM/IAB，最终运行证据与SHA仍归主Agent确认。报告历史“待模型/写门禁”条目由此更新为已闭合。


## 执行授权回归修补复核

最后读取的development tree已恢复现代执行checkbox（OwnedHostProviderConfiguration.tsx:253附近），草稿初值读取snapshot实际授权；manual saveProfile默认使用execution草稿。source import明确传入 `snapshot.settings?.executionAuthorized ?? false`（:206附近），因此即使用户预先勾选草稿，source一键也不会隐式授予权限；用户后续手动点击保存才会提交其选择。activeSession/offline/stopping/pending门禁保留。

`src/host/management.ts:246–247`不再对authenticated owner generic写绝对禁止false→true，恢复与旧config.set一致的显式bool语义，继续身份/owner channel、CAS、原mutation回执、忙会话与不可变profile规则。未新增公网接口、没有执行真实授权写入。

实际读取回归测试：host-provider-config.integration.test.ts:87起覆盖grant持久化为true再revoke持久化为false；OwnedHostManagement.test.tsx:318–329覆盖勾选草稿后source仍提交false，随后手动保存true。测试当前由主Agent运行，本审查不冒称已执行或通过。

此修补关闭本次P1静态发现。最终review当前未留下已确认的范围内源码阻断；等待提交SHA及最终测试结果确认，所有真实Host/安装/生产边界仍保留。
