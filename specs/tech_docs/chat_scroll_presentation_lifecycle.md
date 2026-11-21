# Chat 滚动与窗口呈现生命周期

本文定义桌面主窗口失焦、最小化、隐藏、恢复与内部 Tab 切换时，Chat 虚拟列表的 owner、状态来源和恢复不变量。用户可见的 Shell 交互以 `specs/design/app_shell.md` 为准；本文解释实现边界与事故防护。

## 1. 为什么 focus 不是滚动生命周期

桌面 focus 只回答“键盘输入当前交给谁”，不回答窗口是否可绘制。Windows 允许用户在未激活窗口上悬停滚轮；macOS 的分屏、多显示器与 App 切换也可能让失焦窗口继续可见。若 blur 时保存一个不可变滚动快照、focus 时强制恢复，blur 后发生的真实用户滚动就会被旧快照覆盖。

因此：

- `onFocusChanged` 只更新通知/input attention，并触发一次 native surface 采样；focus 布尔值不进入 Chat scroll controller。
- shown 且未 minimized 的 active Chat 始终实时渲染和接收滚动输入。
- 只有不可绘制或几何不可信的 surface 才开启 continuity transaction。

## 2. Owner 与权威状态

| 事实 | Owner / source of truth | 生命周期 |
|------|-------------------------|----------|
| 主窗口是否 shown 且未 minimized | `useTrayEvents` 对 Tauri window 的采样；Rust-owned hide/show 由 canonical tray helper 同步发同一 edge | App 进程内 |
| presentation generation | `App` 的 `reduceMainWindowPresentation()`；available→unavailable 时递增 | App 进程内 |
| 当前 generation 的容器几何是否可用 | `MessageList` 外层 viewport 的非零 `ResizeObserver` | 当前 Chat mount / generation |
| Virtuoso 是否允许消费 live input | `isActive && surfaceAvailable && containerReadyForGeneration` | 当前 Tab commit |
| follow、可信 anchor、恢复事务与结算 | `useChatScrollController` | 当前 Chat / Session |
| messages、SSE、Session 生命周期 | `TabProvider` / Sidecar | 不受窗口呈现影响 |

不得把后端消息进度、document focus、一次端口/尺寸探测或 Virtuoso 的迟到 callback 提升为上述其它事实的 authority。

## 3. Presentation 与 admission 状态机

`MainWindowPresentation` 只有两个字段：

```ts
{ surfaceAvailable: boolean; generation: number }
```

规则：

1. focus、非零 resize、document visibility change 只触发 `isVisible + isMinimized` 最新优先采样。
2. 零尺寸 resize 和 renderer 主动 hide 在 native 操作前立即发布 unavailable，并使更旧的异步采样失效。Rust 全局快捷键等 Rust-owned hide/show 必须经过 `tray::hide_main_window` / `show_main_window`，在 WebView 可能暂停前后通过 `main-window:presentation-changed` 投影同一事实；这不是第二个 generation owner。
3. available→unavailable 推进一次 generation；重复 unavailable 和 unavailable→available 不重复推进。
4. surface 恢复后，MessageList 必须看到当前 generation 的非零容器几何才重新 admission。generation 0 的正常首屏可直接进入；恢复 generation 或首次在恢复 generation 内挂载的 Chat 都必须经过 observer。
5. 非 admitted 状态下 Virtuoso 继续 mounted，但只接收最后一次 admitted snapshot；从未 admitted 的列表接收空 snapshot。不得用 remount / React key 清空其内部状态。

App 的 Tab memo comparator 只让 active Chat 响应 presentation 对象变化；inactive Chat 在重新成为 active 时一次取得最新 generation，避免窗口事件重渲染全部重型 Tab。

## 4. Continuity transaction

`useChatScrollController` 是唯一恢复 owner。

### admission true → false

- 清除旧 layout compensation 与 bottom pin；经 Virtuoso `scrollBy({top:0, behavior:"auto"})` 撤销库内索引测量/完成订阅和原生运动，不改变 follow/reading 意图。Session effect cleanup 同样撤销其捕获的精确 virtualizer，发生在新 Session layout pin 前；不能只让应用回调过期而留下库内操作。
- 若 follow 为 `true` / `force`，保存 `follow=true`。
- 若用户正在阅读历史，保存该 Session 最近一次可信的 `{messageId, offsetFromViewportTop}`。可信 anchor 在 admitted viewport 的 scroll / atBottom(false) 上持续更新，因此可见失焦期间的 hover-scroll 自然覆盖旧位置。
- 创建单调 transaction id 并开启 recovery fence。重复 unavailable 信号不覆盖第一次捕获的用户意图。

当阅读线穿过长回复时，快照还会记录当前 block、可验证的 Markdown 源位置，以及一个字符相对视口的偏移。字符节点使用弱引用。重新挂载后按代码行或段内文本核实位置，逐级退到可定位的段落、块、消息。宽度变化、前插历史与恢复都由同一个控制器调整偏移。用户滚轮、主动跳转和工具展开仍优先于待完成的校正。

V2 旧页在用户主动向上滚入顶部一屏时可提前读取。虚拟列表的 overscan 也会提前挂载首行，采用页面因此使用实际触顶通知。TabProvider 只持有一个请求，并持续把其间的事件交给 TranscriptPage。采用时才捕获锚点、补齐事件与工具引用、前插可见行。隐藏、恢复、切换会话、断线与原生传输代次变化均会取消候选。推测读取失败后仍可触顶按需获取，按需失败的重试入口位于列表顶部。

### admission false → true

- Session identity 已改变：丢弃旧事务，由新 Session 的既有 initial pin owner 接管。
- follow 用户：只调用一次 `scrollToBottom('auto')`，随后关闭 fence。
- 历史阅读用户且目标 row 已挂载：只用 Virtuoso `scrollBy` 修正相对 offset，随后关闭 fence。
- 目标 row 尚未挂载：在 fence 内只调用一次 `scrollToIndex({align:'start'})` 请求挂载；最终 offset 等待 Virtuoso `itemsRendered` 后结算，即使 offset 已为零也必须结束索引挂载阶段。`align:start` 是内部 mounting step，不是可见最终状态。
- 目标 message 已删除：结束事务，不猜相邻位置。

所有 callback 都核对当前 Session、presentation generation 与 pending transaction identity。发送消息/回到底部、搜索、工具定位，以及 `useVirtuosoScroll` 已识别的 wheel/touch/scrollbar/viewport-key 输入优先级更高，会取消未完成的 continuity transaction。恢复 fence 内禁止普通跟随对齐；恢复后已经到底时不得再次发出滚动命令。

## 5. 不变量与禁止项

Chat 底部 query 耗时由 TabProvider 的 `useQueryElapsedClock` 持有，使用单调时钟累计当前 query 的运行片段；未决权限、AskUserQuestion 或 ExitPlanMode 等待期间暂停。已 resolved 的计划卡及自动批准的 EnterPlanMode 不暂停。Footer 仅每秒采样，工具/文案/布局变化、presentation suspension 和 Chat 展示子树重挂载都不能重置起点。结束、新 query 或真实 Session 切换重置，pending identity 实体化保留。连续 running 的普通 `queue:started` 在原 clock owner 内显式重置；`midTurnBreak` 实时补充仍属于当前 query，不重置。首次中途加入或整个 Tab owner 重建时无法恢复过去的暂停片段，计时从当前观察开始；不改变历史消息 `durationMs` 的后端墙钟含义。

Virtuoso 的 Footer 必须使用模块级稳定组件类型，动态内容通过现有 list context 传入，并与 data 一同遵守 frozen snapshot。`useMemo(() => function Footer(){...}, [动态值])` 仍会在依赖变化时创建新组件类型，重挂载整个 footer，不能作为“稳定 Footer”。

冻结展示 snapshot 不等于暂停组件内部的副作用。`MessageListPresentationContext` 只向 Footer 投影现有 `canLayoutVirtualList` 准入结果，不持有第二份状态；该值不能随 Virtuoso context 一起冻结。Footer 的 `useSyncExternalStore` 仅在准入时每秒订阅 Tab clock，并在不可呈现时撤销轮询、卸载 spinner 的动画节点（保留固定占位）；恢复时立即读取当前 clock。Chromium 可以延迟处理 `content-visibility:hidden` 后代的 class/style 变化，单纯移除动画 class 不保证立即清除已有 CSS animation。否则隐藏前的 loading snapshot 会使计时器在后台任务结束后仍永久运行。Tab clock 本身通过时间差累计，不依赖此轮询，也不因窗口隐藏、暂停采样或恢复而重置。

- focus change 必须产生零个 Chat scroll command。
- 可见失焦窗口的 `atBottomStateChange`、follow 与 pagination 正常工作。
- suspension 期间消息/SSE 正常推进，但 data、firstItemIndex、height estimate 和行测量不进入 Virtuoso。
- restore 期间普通底部对齐、pagination 和迟到 row measurement 不能抢在 continuity transaction 前执行。
- 不直接写 `scrollTop`，不增加平行 DOM scroller，不使用固定 timeout、无限 retry、单 RAF 猜测 WebView readiness，不用 React key/remount 修复缓存。
- internal Tab hide 与 native surface suspension 共用 list admission / continuity owner；不能再在 MessageList 内保存第二份 follow snapshot。

## 6. 连续输出与阅读意图

`useVirtuosoScroll` 持有用户是否跟随最新内容的意图。`atBottomStateChange` 仅描述虚拟列表的几何位置；正文、Footer、提示卡或输入框增高导致离底，不能关闭跟随。上滚 wheel、touch、viewport key 或抓取 scrollbar 进入阅读模式；平滑追赶尚未到达底部时，向下输入也先接管当前运动，向下输入到达真实底部（1px舍入容差）或显式“回到底部”恢复跟随。输入框内的光标移动不属于 viewport key。

主动展开消息/工具详情也是阅读意图，`onRowLayoutChanged` 在 direct-toggle 分支暂停跟随；不能再依赖展开后的几何离底来推断用户意图。搜索已挂载命中的快速路径也先调用控制器的 `pauseAutoScroll()`，再定位文字范围。

`scrollToMessage()` 返回本次导航是否仍有效的只读判断，供搜索的延迟 Range 定位和工具的延迟细定位共用。控制器的一份 navigation version 只在新输入/导航或生命周期失效时更新；Session、presentation generation 和 admission 也必须仍匹配。搜索 Range / 工具 DOM 细定位在目标已挂载且 navigation 仍有效后，再调用既有 pauseAutoScroll 结束自己的索引挂载阶段，随后才执行细定位；仅在导航开始前取消前任不足以完成这次交接。它与 continuity transaction 的序号分开，因为自动的行布局补偿不能取代用户导航意图。旧回调不得在用户滚动、切换 Session 或不可呈现之后重新发起滚动。

搜索、工具/Query 定位与 rewind/retry 调用 `pauseAutoScroll()` 后保持阅读模式，直到用户回到底部；不以固定500/2000ms定时器恢复过去的跟随决定。新的阅读输入还通过 Virtuoso 的 `scrollBy({top:0, behavior:'auto'})` 取消进行中的原生平滑滚动。react-virtuoso 4.18.3 原版的 index 定位会在动画停止后继续响应尺寸变化并重试旧目标；`scripts/patch-react-virtuoso.mjs` 在库的 scrollToIndex owner 内让新的 scrollBy，以及 imperative handle 的外部 scrollTo，清除旧的测量/动画订阅及超时。索引 owner 自身也发布 scrollTo，因此取消必须在外部命令入口完成，不能订阅公共输出而把当前索引事务自身取消。原生运动 adapter 在新 scrollTo/scrollBy 时同时撤销旧 smooth 完成计时器；新像素目标等于当前位置也必须停止旧动画，不能当作无操作跳过。两个模块格式一起校验并修复。版本固定为4.18.3，安装时应用，开发/构建/typecheck前验证；升级时必须重跑真实浏览器取消定位回归并评估移除补丁。

同一补丁还修正 element viewport 的垂直滚动范围投影。React 替换可见行时会先移除旧行、再更新 list padding；WebKit 可按中间状态缩小的 scrollHeight 钳制位置，即使最终总高度没有变化。Viewport 中一个绝对定位、无交互且对辅助技术隐藏的节点直接投影库已有的 `totalListHeight + deviation`，在提交期间维持模型声明的滚动范围。它位于测量列表之外，不持有高度缓存，不参与行/header/footer 测量，不改变 viewport 自身尺寸；自然内容可以超出它，行缩短也仍触发列表 ResizeObserver 并更新模型。禁止给测量列表设置固定高度或 min-height，否则可能屏蔽缩小通知、留下空白。Window/custom scroll parent 已有库级模型高度投影，horizontal 路径保持原行为。不能用原生 scroll 事件无限追底补偿中间状态回退，那会使可见范围在两段历史间持续震荡。

### 行高精度与最终滚动范围

行、Header、Footer 的真实 `getBoundingClientRect()` 尺寸保留小数；不能逐项 `Math.round()`。已复现的 5px 末尾偏差来自 14 行各丢失 0.34375px，末行丢失 0.390625px：模型总高 5882px，真实内容高 5887.203125px，`scrollToIndex(LAST/end)` 因此落到实际底部上方 5px。没有尺寸变化时不会再发生结算，增加重试或空 React 更新只会掩盖模型错误。

浏览器的原生滚动范围还会取整；仅保留行高精度，连续输出时 Footer 仍会因总高度的小数余量而发生不足 1px 的位移。锁定版本补丁在 Virtuoso 的垂直 element viewport 布局边界统一处理：令 `E = totalListHeight + deviation`，既有 extent 节点投影 `ceil(E)`，主列表既有 trailing padding 增加 `ceil(E) - E`。这只是当前总高度的无状态布局投影，余量小于 1px；不改变每行尺寸，不持有另一个高度缓存。余量位于被测量的行和 Footer 外，因而不会反馈进入尺寸模型；真实内容缩短仍正常触发测量与范围回收。Window/custom scroll parent 和 horizontal 不采用该 element viewport 尾部投影。

真实浏览器回归同时检查每个已挂载行的模型尺寸严格等于 DOM 尺寸、自然内容末端严格等于 extent 投影及原生 scrollHeight；初始定位、连续输出、收缩及小数 Footer 均覆盖。状态栏位置的严格相等断言保留，不能用扩大容差替代一致的几何模型。

MessageList 将 `followOutput` 固定为 `false`，因为 react-virtuoso 4.18.3 的同数量尺寸增长/viewport缩小路径只检查原始prop是否为false，并不会调用function形式的策略。自动跟随由 MessageList 的 `useChatFollowMotion` / `alignFollowingViewport` 统一处理：React layout commit、Virtuoso `totalListHeightChanged` 和 scroller resize 都更新同一运动循环；每帧读取当前 scrollHeight，通过 Virtuoso `scrollTo({top, behavior:"auto"})` 的像素 API 移动，不直接写 scrollTop，也不为每次更新重新启动原生 smooth。

该 hook 只持有当前 viewport 生命周期内的帧句柄、位置和速度，不持有第二份 follow / reading 意图。连续增长采用按实际帧间隔计算的临界阻尼（无回弹），重复尺寸通知只更新目标，保留当前速度。尺寸通知可能早于虚拟列表 padding / Footer 的 DOM 提交，因此通知即使暂时读到离底为零，也合并为下一帧的一次几何结算；已结算后不空转轮询。小于等于 1px 的尾差直接结算，停止后不再调度帧。初次可布局、Session / presentation generation 改变、恢复 fence 解除、显式 force 定位、内容收缩和 reduced-motion 使用即时对齐；离底超过 max(480px, viewport height) 的突增也立即追上，避免长距离动画积压。缩放或卡顿后的单帧积分最多使用 50ms。

每帧写入前读取现有 followEnabledRef；手动阅读输入同步关闭跟随，下一帧不再写入。未 admitted、恢复 fence、Session / generation 变化、scroller 更换和卸载均清理旧 RAF 与观察器；reduced-motion 偏好变化时立即取消动画并服从当前阅读意图。已到底、阅读中、未 admitted 或恢复 fence 内均不发跟随命令。逐 token 与 terminal 不拥有独立 pin 逻辑。

输入浮层中的 `AgentStatusPanel` 可见性归面板自身拥有，Footer 只投影 `SimpleChatInput` 实测高度。非空的已完成 TodoWrite / Task / runtime plan 数据不代表新活动；冷历史不展示完成提示，实时回合通过现有 `armedSessionId` 允许一次 terminal-first 展示，淡出后消费该资格。真正的新活动可以取消淡出并恢复显示。不得以 `!mounted && hasDisplayContent` 重新触发展示，否则永久保留的完成记录会让面板按 linger/fade 周期反复挂卸，改变输入浮层与 Footer 高度并造成静止会话回弹。入场与退出 effect 分开，`mounted` 仅驱动退出计时，不能作为重新入场的依据或取消入场第二帧。

初始行高来自 `useChatScrollModel` 的逐条 `heightEstimateSeed`，MessageList 仅投影到 Virtuoso `heightEstimates`；挂载后的真实测量才是几何 authority。不可同时设置 `defaultItemHeight`：锁定的 4.18.3 会先用它初始化 size tree，导致逐条估算被忽略，初次空数据后加载历史也受影响。没有 seed 的 caller 使用 Virtuoso 原有首行 probe。Seed 只初始化空树，不负责覆盖已有实测缓存、重置 Session 或保持滚动意图。

`scrollToIndex(LAST/end)` 使用缓存的行高，因此仅把命令提前到layout effect不能保证采用当前正文高度；WebKit可能将过渡位置绘制出来。行为验证必须包括真实虚拟列表与WebKit画面，不能把rAF中间读数直接等同于已绘制抖动。AssistantActions在回合结束的同次commit出现，避免loading移除后再延迟350ms插入操作栏。

## 7. 新会话启动遮罩与 query 衔接

`ChatBootOverlay` 只展示居中的启动状态；deferred / Suspense fallback 与 mounted Chat 使用相同外壳，保留原有 300 ms 退场动画，不在遮罩中复制用户气泡。

带 `initialMessage` 的 Chat 用本次发送的 `clientRequestId` 关联后台接纳后的用户行，只有真实 MessageList 的 `itemsRendered` 提交该行时才正常退场。前端 optimistic 气泡、Fork 的旧历史、Runtime `starting/running` 与 assistant 输出都不能代替这一呈现边界。TabProvider 的即时发送投影、loading、后台初始化与 canonical 接替继续照常运行；不等待 AI 回答。

MessageList 的呈现准入与 recovery fence 继续由现有 owner 裁决；不可呈现时不发布可供启动退场的行，但仍通知滚动 owner，让 recovery 可正常结算。无首条消息的入口在连接及恢复就绪后退场；普通 Cron 在任务创建完成后退场，因为它可能只安排未来执行、不产生当前 Tab 的 query。发送失败与待处理的人类交互允许立即展示相应操作，保留原有 30 秒无响应逃生超时。

## 8. 代码入口与验证

- native projection：`src/renderer/hooks/useTrayEvents.ts`、`src-tauri/src/tray.rs`
- pure generation policy：`src/renderer/utils/mainWindowPresentation.ts`
- App / active Tab projection：`src/renderer/App.tsx`
- geometry admission / frozen input：`src/renderer/components/MessageList.tsx`
- follow motion（无独立意图状态）：`src/renderer/hooks/useChatFollowMotion.ts`
- continuity transaction：`src/renderer/hooks/useChatScrollController.ts`

回归测试至少覆盖：visible blur 零恢复命令、latest-wins native sampling、generation reducer、inactive/最小化 frozen input、首次在恢复 generation mount、follow/anchor 两种恢复、unmounted anchor event-driven settlement、Session switch、旧 generation callback、显式用户导航抢占和 inactive Tab memo 隔离。Windows WebView2 与 macOS WKWebView 真机还要验证事件时线和无首句/顶部/底部闪跳；源码审计不能代替真机门禁。

启动衔接回归：`node scripts/verify-chat-startup.mjs webkit`（或 `chrome`）使用真实 Message/Virtuoso 和启动遮罩，覆盖 optimistic 等待、文字、长 query、纯图片和 Fork 旧历史；逐帧记录退场时的 query 可见性，并输出截图、录像与几何证据。

停止后稳定性回归：`node scripts/verify-agent-status-scroll.mjs webkit`（或 `chrome`）使用真实状态卡、输入浮层、消息与滚动控制器，覆盖完成历史、实时结束、跨三个旧淡出周期的零高度/位置变化，以及长尾滚轮可达性。

连续输出回归：`npm run verify:chat-scroll -- webkit` 和 `npm run verify:chat-scroll -- chrome` 使用真实 Message/Markdown/controller/Virtuoso、合成对话及离线本地 Vite；覆盖立即/延迟历史加载后的稳定到底、多帧中间位置、快速输出的有界落后、进行中动画的输入取消、reduced-motion，以及阅读、搜索、footer 与 viewport 变化、长尾缩短后的高度回收与零多余空白；测试会输出临时录像、截图与几何快照目录。Node 补丁测试覆盖两个模块格式、幂等、从旧补丁升级与版本/字节不匹配。

滚动所有权回归：`node scripts/verify-chat-scroll.mjs chrome --ownership-only`（或 `webkit`）记录真实库索引指令和原生滚动指令，验证 auto/smooth 索引向像素跟随交接后无旧索引重放、suspension / Session 撤销和同位置接管仍停止原生动画。完整 scroll 验证默认包含这些用例。该回归确认旧命令越权问题，不等于已复现用户现场的持续白屏闪烁。
