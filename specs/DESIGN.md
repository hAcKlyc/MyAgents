# MyAgents Design System

> **Status**: Active
>
> **Scope**: macOS / Windows Desktop Client
>
> **Last reviewed against implementation**: 2026-08-30

本文只描述 MyAgents 当前有效的全局设计系统：品牌原则、视觉语义、通用组件、跨页面交互、可访问性、布局与内容呈现。它不是功能 PRD、技术架构说明或变更日志。

精确 Token 值、Theme 清单和组件 API 以代码为准；复杂功能的当前交互放在 `specs/design/`，owner、状态机、进程边界和事故防复发规则放在 `specs/tech_docs/`。历史动机通过 Git 和 PRD 查询，不在本文保留已经失效的旧规范。

## 1. 文档边界与决策顺序

| 要回答的问题 | 权威来源 |
|---|---|
| 产品应呈现怎样的共同视觉与交互语言 | 本文 |
| 某个核心产品面当前怎样操作、有哪些状态 | [`specs/design/`](design/) 下对应文档 |
| 谁拥有状态、如何持久化、如何并发和恢复 | [`specs/ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`specs/tech_docs/`](tech_docs/) |
| Theme、Token、组件当前有哪些精确值和 API | `src/renderer/` 源码、类型与测试 |
| 为什么曾经做过某次改变 | Git 历史、对应 PRD 或 issue |

发生冲突时，不任选一处继续：先核对代码、测试与模块文档，修正已经漂移的规范。新增设计规则时应优先提炼可跨页面复用的原则；只服务一个功能的流程留在功能交互文档。

## 2. 设计理念

MyAgents 是以长时间阅读、持续协作和多任务切换为核心的桌面 AI Agent。视觉使用温暖、克制、有纸张层次的语言，但不把品牌风格等同于固定浅色调。

核心原则：

- **阅读优先**：AI 输出通常较长，正文节奏、宽度和层级高于装饰密度。
- **状态可信**：界面只显示真实状态；运行、失败、未读和选中不能互相冒充。
- **结构稳定**：异步加载、hover 动作和模式切换不应推动主要内容或改变已建立的几何。
- **动作克制**：一个区域只突出一个主动作；低频和危险操作进入次级菜单。
- **统一而不抹平语义**：复用共同组件和视觉语言，但不为统一外观虚构业务状态。
- **跨平台尊重原生**：保持产品语义一致，同时尊重窗口、字体、输入和滚动的系统行为。

## 3. Theme 与视觉语义

### 3.1 Theme、Appearance 与内容边界

`Theme` 是一套完整视觉语言；`system / light / dark` 是 `AppearanceMode`。每套 Theme 必须同时交付 light 和 dark，system 只解析当前系统明暗，不产生第三套 Theme。

当前生产目录包含 MyAgents Light、MyAgents Classic、MyAgents Classic2、Sage、Claude、Linear、Proof、Codex、Raycast 九套 Theme。产品顺序、默认值、fallback、完整 Token 与 embedded adapters 由 `src/renderer/theme/registry.ts` 和 [`tech_docs/theme_system.md`](tech_docs/theme_system.md) 负责，本文不复制注册表。

组件必须消费语义 Token 或 `useResolvedTheme()`，不得：

- 观察 `.dark` 后自行选择 palette；
- 在业务组件中硬编码 light/dark 颜色；
- 将 Accent、Primary CTA 和 success/error 等业务状态混为一组；
- 让用户从不同 Theme 中任意拼装颜色、字体和背景；
- 用 Theme 改写布局、业务状态机、用户内容或第三方品牌资产。

### 3.2 颜色角色

精确色值以每套 Theme 的 CSS package 和 `registry-contract.ts` 为准。设计与评审按角色判断：

| 角色 | 语义 |
|---|---|
| Ink | `ink` 为正文；`ink-secondary` 为次级正文；`ink-muted/subtle/faint` 依次降低注意力 |
| Paper | `paper` 为页面；`paper-elevated` 为浮起内容；`paper-inset` 为内嵌和控件面；`message-user-bg` 为用户消息 |
| Shell | `global-sidebar-bg` 只服务 App Shell chrome，不替代通用 Paper 层级 |
| Accent | 链接、Focus、关键选中、Toggle 启用和进行中状态 |
| Primary | `button-primary-*` 只服务当前区域的主动作，不等同于 Accent |
| Semantic | success/error/warning/info 只表达真实业务状态，并使用各自配对前景色 |
| Line | `line/subtle/strong` 表达结构边界；能用表面层级表达时不额外描边 |

颜色只作为状态辅助，重要状态同时提供文字或图标。优先使用语义层级，不为了制造更多灰度随意叠加透明度。

### 3.3 字体与字号

字体角色由 Theme 提供：正文使用 `--font-body`，品牌与展示使用 `--font-display`，代码和终端使用 `--font-code`。不在组件内复制平台字体栈。

产品字号由 `src/renderer/index.css` 的 `@theme` 定义：

| 档位 | Utility | 大小 / 默认行高 | 主要职责 |
|---|---|---|---|
| meta | `text-xs` | 12px / 1.45 | 时间、badge、计数、描述、hint、分类头 |
| ui | `text-sm` | 14px / 1.5 | 按钮、菜单、Tab、树节点、紧凑卡片、Markdown 表格 |
| prose | `text-base` | 16px / 1.7 | AI 正文、用户消息、输入正文、Widget body |
| display | `text-lg/xl/2xl` | 18/20/22px | 弹窗标题与 Markdown H3/H2/H1 |
| stat | `text-3xl` | 28px / 1.2 | 数据大数字和页面大标题 |
| brand | `text-brand` | 56px / 1.1 | Launcher 品牌展示 |

约束：

- 新场景先归入现有档位，禁止新增 `text-[Npx]` 孤立字阶。
- AI 与文档 Markdown 正文默认使用「标准字号」14px / 1.6；「大字号」为 16px / 1.7，随设置切换，保留用户已保存的选择。聊天输入框仍使用 26px 整数行高以稳定自适应测量。
- 紧凑 Task/Record 流可使用 14px 正文，但不能反向降低 Launcher 和 Chat 的正文档位。
- 按钮和菜单正文统一为 14px，时间、状态、hint 统一为 12px。
- Markdown 标准字号 H1/H2/H3 为 20/18/16px，H4–H6 为 14px；大字号依次为 22/20/18px、H4–H6 为 16px。标题用层级和间距表达，不依赖过重字重。
- 模型供应商卡片标题统一 `text-lg font-semibold`（18px / 27px、600），包括订阅、API、自定义供应商；保留单行省略。
- Theme-owned Launcher Hero 可拥有经注册校验的展示字号；这是品牌层例外，不构成业务组件新增孤立字阶的先例。
- 中英文混排使用 Theme 的 CJK fallback；代码块不得继承纯西文字体后落入宋体。

### 3.4 间距、圆角与阴影

布局采用 4px 基准网格。结构 Token 定义在 `src/renderer/index.css`：

| Token | 值 | 常见职责 |
|---|---:|---|
| `--space-0-5` | 2px | 极小视觉校正 |
| `--space-1` | 4px | 紧凑元素 |
| `--space-1-5` | 6px | 图标与文字、紧凑控件 |
| `--space-2` / `--space-3` / `--space-4` | 8 / 12 / 16px | 行间、控件和卡片内距 |
| `--space-5` / `--space-6` | 20 / 24px | 区块内距 |
| `--space-8` / `--space-10` / `--space-12` | 32 / 40 / 48px | 页面和大区块分隔 |

圆角和阴影由 Theme 提供，按层级使用：

- `--radius-sm` / `--radius-md`：输入、菜单项、紧凑控件；
- `--radius-lg` / `--radius-xl`：卡片、面板、较大输入容器；
- `--radius-full`：胶囊 Tag、圆形按钮和明确的 pill 选择器；
- `--shadow-xs` / `--shadow-sm`：局部 hover 或低层浮起；
- `--shadow-md` / `--shadow-lg` / `--shadow-xl`：菜单、Popover、Overlay 面板逐级提升。

阴影只表达高度，不与无意义位移、描边和高饱和底色叠加制造噪音。

## 4. 通用交互与可访问性

### 4.1 状态反馈

所有可交互组件至少明确以下适用状态：

| 状态 | 规则 |
|---|---|
| Hover | 提示可操作性，不改变主要布局，不作为唯一信息来源 |
| Focus | 使用可见 Focus ring 或边框；键盘操作与鼠标操作获得同等能力 |
| Active/Selected | 只表达当前选中或按下，不与“运行中”“未读”混用 |
| Disabled | 同时禁用事件和语义；必要时通过相邻说明或 Tip 解释原因 |
| Loading | 保持容器几何稳定；可取消或可重试时给出对应动作 |
| Success | 当前区域已经清晰出现结果时，不重复弹 Toast |
| Error | 保留用户输入和可恢复上下文；终态错误不能被无限 spinner 遮蔽 |

Toast 用于跨区域、短暂且无法从当前表面直接确认的结果。保存后列表或内容立即变化、现场笔记已经出现、重点已经标出等情况使用页面内反馈，不重复 Toast。复制动作优先在原按钮显示短暂“已复制”。

### 4.2 键盘、焦点与语义

- 原生按钮、链接、输入优先于模拟元素；整卡动作不得用 `<button>` 包住内部按钮。
- 可点击容器必须可聚焦，并支持 Enter/Space；内部菜单和快捷动作阻止父级主动作。
- Dialog/Overlay 打开后移动到合理首焦点，Escape 关闭，关闭后回到触发入口。
- Tab、Menu、Dialog、Tree 等使用匹配的 ARIA role、状态和 roving focus，不只靠视觉模拟。
- 文本输入的应用快捷键先用 `isImeComposingEvent`（`utils/imeKeyboard.ts`）判断输入法状态；组词确认、候选导航与取消交给原生输入法，不触发提交、保存或关闭。祖先和全局键盘监听器同样遵守，不能只保护最终发送分支。
- Hover 才出现的动作在 `focus-within` 时同样可见；触屏场景必须有稳定入口。
- 需要保留当前输入焦点的鼠标动作使用共享 `retainFocusOnMouseDown`，不在 click 后强行抢焦点。
- 状态颜色必须伴随文字、形状或图标；内容和主动作需满足当前 Theme 的对比度测试。

macOS 输入出现不可见控制字符时，遵循 [WKWebView 输入防护](tech_docs/macos_arrow_key_leak_investigation.md) 的共享策略，不在单个输入组件复制过滤逻辑。

### 4.3 减少运动与稳定几何

- `prefers-reduced-motion` 下取消非必要动画，功能和信息不能依赖动画完成。
- 异步内容使用同尺寸 skeleton、静默占位或局部加载，禁止“出现—消失—再次出现”。
- Hover/focus 动作优先绝对覆盖并带渐变遮罩，不静态抢占正文宽度。
- 展开、切换和侧栏变宽时先提交最终布局，动画尽量留在 paint/transform 层，避免逐帧重排重型内容。
- 主动拖拽调整侧栏时布局按帧跟随指针，不叠加上述收展动画；只在交互提交时保存宽度，重型内容仅响应必要的几何与布局决策变化。
- 用户主动导航、滚动或切换优先于迟到异步结果，旧请求不能把界面拉回旧状态。

## 5. 通用组件

### 5.1 按钮

- 默认正文为 `text-sm`，图标通常为 14–16px；命中区域由按钮/行高承担，不以小图标尺寸代替点击区域。
- 一个区域只突出一个 Primary。Secondary 用于并列但较弱动作，Ghost 用于工具栏和行内动作。
- Danger 只用于删除、不可逆和高风险操作，通常放在菜单尾部或确认对话框中。
- Text Link 用于导航、展开和辅助入口，不伪装成主 CTA。
- 对话消息/思考操作、右侧工作区和文件预览工具条使用 `compact-action` 共享 32px 高、至少 32px 宽的热区，图标保持 14–16px；颜色与选中/运行态由各按钮负责。
- 图标按钮必须有 accessible name；即时说明使用共享 `Tip`，不同时叠加浏览器 `title`。

### 5.2 输入与 Composer

- 普通正文输入使用 16px；高密度设置表单和紧凑流允许 14px。
- 输入表面使用 Paper/Line 语义，Focus 使用 `focus-border`/Accent，不硬编码黑色。
- Placeholder 只提供示例或提示，不能承担字段名和必要约束。
- 提交失败保留输入；连续录入场景提交成功后保持焦点。
- 文本域自增长必须有上限，超过后由自身滚动，不持续推走主要内容。

### 5.3 卡片与资源行

主卡片用于设置区块和独立资源：`paper-elevated`、`radius-lg`，需要结构边界时使用 `line`。紧凑列表卡片默认无描边、无静态阴影，hover 只提升到 `shadow-sm`，不位移。

整卡有主动作时：

- 非控件区域全部可点击且支持键盘；
- 右上角菜单、hover 快捷动作、标签和编辑按钮保持独立事件边界；
- 动作层不参与标题静态宽度计算；
- 虚拟列表 item 自己承担水平留白，不通过滚动根节点 padding 制造溢出。

### 5.4 Tag 与状态

Tag 用于类型、来源或紧凑元信息，通常使用 12px。状态 Tag 只能显示真实且用户需要辨认的状态；如果列表分组已经表达生命周期，不在每行重复同一状态。

运行中、未读、选中属于三个维度：运行中可使用 success 动态点，未读使用 Accent 静态点，选中使用背景或指示线，不能复用一个圆点解释全部含义。

### 5.5 Menu、Select、Tip 与 Overlay

共享 `Popover` 在首次定位完成前隐藏内容，定位用的 `transform` 由 Floating UI 独占，视觉动效不能覆写同一属性。需要移入焦点的调用方通过 `onPositioned` 在定位后执行，并使用 `preventScroll`，避免零坐标阶段的聚焦带动页面。

优先复用：

| 场景 | 共享实现 |
|---|---|
| 动作菜单 | `components/ui/DropdownMenu.tsx` |
| 表单选择器 | `components/CustomSelect.tsx` |
| 即时说明 | `components/Tip.tsx` |
| 模态遮罩 | `components/OverlayBackdrop.tsx` |
| 界面图标 | `components/icons/`（`AppIcons.tsx`） |
| 文件身份 | `components/file-icon/` |

菜单按高频到低频排列，危险动作尾置并用分隔表达。共享 `ContextMenu` 自身 portal 到 body，默认层级 320，避免工作树/能力面板的裁切与文档预览遮挡；Tab 内菜单遵循当前 Tab 的可见性与关闭顺序。Popover/Dropdown 必须逃逸滚动裁切、留在 viewport 内，并由统一 close-layer 处理外部点击与 Escape。共享 `Popover` 沿 Floating UI size 约束 anchor 侧可用高度；容器高度上限使用 `maxHeight` 参数（可用空间与产品上限取较小值），为顶部栏预留空间时使用 `viewportPadding`。内容不能因收缩丢失访问路径；固定高度的结果面板由调用方给出 height，搜索结果只在内部滚动。

侧向子菜单（如模型菜单的推理强度）单独使用共享 `Popover`，由其 portal、flip/shift 和高度约束保证可见；窗口左右都放不下时，通过 `fallbackAxisSideDirection` 允许转到上方或下方，避免横向越界。`unstyled` 只控制外观，不能作为逃逸父菜单滚动裁切的方式。子菜单层级高于父菜单，使选项的按下不会提前关闭父菜单；悬停与点击都请求展开，点击不能反转悬停刚建立的展开状态。

Tip 在悬停或聚焦时显示；触发动作后立即关闭，保留按钮焦点，直到新的悬停或聚焦事件再显示。关闭由共享 Tip 在点击捕获阶段处理，避免业务按钮停止冒泡、隐藏或移动面板后残留提示。

`OverlayBackdrop` 是模态遮罩 owner。业务面板不重复实现 backdrop click 判断；嵌套 Overlay 只关闭顶层，背景滚动和点击必须被隔离。大内容区在面板内部滚动，不能让页面和面板竞争同一主滚动。

### 5.6 Toggle、Section Header 与 Heartbeat

- Toggle 只表达立即生效的二元状态；需要确认或有多状态时改用按钮或选择器。
- Section Header 使用 14px semibold；静态标题为 muted，Tab 式未选中态进一步弱化，选中态不得只靠颜色。
- Heartbeat 只表达 AI/任务真实活动：核心点 8px、外圈脉冲；错误和空闲使用各自静态状态，不播放假动画。

### 5.7 图标与产品文案

- 界面图标只来自 `components/icons/` 的 MyAgents 自绘图标集（ESLint 禁止 `lucide-react`）：20 网格、圆头圆角、容器圆角 3–3.5，经 16.5 单位裁切显示，默认线宽在 16px 下约 1.31px。缺图标时在 `AppIcons.tsx` 按同一规格补画，不从其它图标库混入。`strokeWidth` 沿用 lucide 等效单位（2 为默认），选中态通过 `--app-icon-tint` 浮出主体淡填充，而不是另换实心图标或加强调条。
- 文字按钮和工具栏图标通常为 14px，导航与列表图标通常为 16px，独立空态图标通常为 24px；视觉尺寸不能代替至少 32px 的命中区域。
- 图标默认使用 `--ink-muted`，hover 提升到 `--ink`；success/error 等颜色只表达真实业务状态。
- Agent 工作区身份统一使用 `WorkspaceIcon`（资源在 `assets/workspace-icons/`）：原有字形保持“点睛”风格，即彩色线条（1.3）、主体 14% 淡填充，再加一处实心焦点，动物的眼睛统一尺寸；另提供九个抽象小伙伴图片作为附加候选，本地随包、等比显示，圆角为边长的 25%。颜色跟图标绑定，配置只存图标 ID；未设置图标时（如添加本地文件夹）显示中性的“项目文件夹”，颜色跟随 Theme 主色；模板创建的 Agent 使用模板图标（Mino 为闪电），旧 Phosphor ID 在渲染时映射，不改写用户配置。解析、渲染与候选集使用同一注册表；选择器是一个不分组的网格，只有 `WorkspaceIconGrid` 一份实现（Agent 设置与新建 Agent 面板共用），选默认图标时不写入图标字段。
- Team AI 私聊联系人用圆形底色加昵称字，底色按稳定的渠道用户 ID 派生，不从昵称或性别推断。`peerAvatarPalette` 的背景 / 文字成对配色取自小伙伴和多人插画的柔和色系，作为头像内容在明暗 Theme 中保持一致，文字对比度至少 4.5:1；平台角标与真实活动状态独立呈现。
- 具体文件和文件夹统一使用 `components/file-icon/`。调用方只提供文件身份和语义尺寸，不自行维护扩展名映射或颜色。文件图标是与界面图标同网格的内联字形，类型色来自 `--file-icon-<tone>` token（浅/深两套），颜色是 16px 文件树里的主要类型信号；不使用第三方品牌 logo，生态差异用共享字形或字母标记加颜色表达。
- 稳定的按钮、菜单、Tip、Placeholder 与 accessible name 进入 i18n resource；用户内容、日志原文和上游原始错误不强行翻译。
- 时间、数量和调度摘要使用 locale-aware formatter，不手拼只适合单一语言的单位与语序。多语言容器必须允许合理伸缩或截断，不能按中文短文案锁死宽度。

## 6. 布局、滚动与响应式

`--breakpoint-mobile: 640px` 是共享窄窗断点，但桌面布局不能只依赖单一媒体查询。宽度不足时按优先级处理：先压缩弹性空白，再让次级栏变为 Sheet/Overlay，最后才隐藏非关键说明；主内容和主动作始终可达。

App Shell 使用“全局侧栏 + 顶部 Tab”的双层注意力模型，完整交互见 [`design/app_shell.md`](design/app_shell.md)。页面遵循：

- 主内容 `min-width: 0`，长标题省略；代码、表格和媒体自己承担横向滚动。
- 页面只有一个主滚动 owner；固定 Header、吸底 Composer 和内部预览需要明确各自边界。
- 左侧资源、中央对话、右侧工作区可以独立滚动，但不能建立重叠 DOM scroller。
- 普通 WebView 使用平台原生滚动条和 `scrollbar-gutter: stable`；不全局自绘窄滚动条或透明 thumb。
- 侧栏、Tab、Drawer、Sheet 的显隐不得造成内容宽度反复抖动。

## 7. 动效

| Token | 时长 | 用途 |
|---|---:|---|
| `--duration-fast` | 150ms | Hover、颜色和轻反馈 |
| `--duration-normal` | 200ms | Menu、Popover、展开和常规切换 |
| `--duration-slow` | 300ms | 大面板和页面级过渡，谨慎使用 |

默认 easing 为自然的 ease-out。菜单使用 opacity + 小幅纵向 translate，不使用会改变 Floating UI 定位 transform 的 scale。列表不逐项 stagger；长任务通过真实状态变化而非无限装饰动画表达进度。

## 8. AI 内容与长文本

### 8.1 消息与正文层级

- AI 消息融入页面阅读流，不使用普通聊天气泡边框；正文最大宽度由阅读容器控制。
- 用户消息使用无边框圆角气泡；`message-user-bg` 及透明渐变端点在生产主题中映射到全局侧栏同色 token，与 AI 内容形成清晰区隔。
- 用户气泡只通过显式 ATX（`# `、`## ` 等）语法声明 Markdown 标题；正文紧接独立 `---` 行时渲染分割线，不将前一段提升为 Setext 标题。此规则由 Markdown 解析层按气泡 scope 声明，AI 回复和文档预览仍保留标准 Setext 语义。共享预处理不得为句中 `#` 插入换行或补空格来制造标题。
- 正文为 16px / 1.7；段落、列表、引用、标题使用单向间距，首尾不额外撑开消息。
- 长正文避免超过舒适阅读宽度；宽屏增加留白而不是无限拉长行宽。
- Rewind/Fork 等消息级动作只在 hover/focus 出现，执行中隐藏，避免与流式内容竞争。

### 8.2 工具、思考与权限块

- 工具调用以紧凑状态行或展开块呈现，名称、参数、输出和错误形成清晰层级。
- running/success/error 使用真实语义色和文字，terminal error 保留重试或诊断入口。
- Thinking 默认折叠，展示简短摘要和耗时；正文弱于最终回答，但仍可读。
- Permission Prompt 必须突出请求动作、风险边界和允许/拒绝选择，不能与普通工具输出混在一起。

### 8.3 Markdown、代码与表格

工作区可编辑文档的源码、保存与预览生命周期见 [Markdown 编辑器](tech_docs/workspace_markdown_editor.md)；以下规则负责通用视觉呈现。

- Markdown H1/H2/H3/H4–H6 使用统一 Type Scale 和主文字色 `ink`；正文、列表、引用与表格正文使用阅读角色 `--font-weight-prose`（500），标题、`strong` 与表头使用 `--font-weight-emphasis`（600）。这些角色只作用于 Markdown，不改变外围 UI 字重。
- 大字号：标题与内容间距为 8px，连续标题同样收紧；正文段落间距为 16px，引用、表格、代码块等与前文的间距为 12px，普通列表项间距为 8px，带段落的松散列表为 12px，列表后接正文为 20px。标准字号下，这些间距依次为 6px、14px、10px、6px、8px、16px；嵌套列表以缩进和标记区分层级。compact 按自身密度独立排版，不受阅读字号设置影响。
- 阅读视图的灰底行内代码使用 code surface 和 `--font-code`，字号为父文字的 90%、字重为 500，随自然基线对齐；代码样式文件链接为 95% / 500。Live-edit 投影保留原有 90% / 400，以匹配进入编辑时的 CodeMirror 字形。多行代码块拥有 Header、语言、复制和独立横向滚动；多行代码、公式与辅助工具栏保持 normal 字重，不继承正文增重。
- 常规 Markdown 表格正文和表头大字号使用 14px，默认标准字号与 compact 均使用 12px；表格容器自己横向滚动，不撑破所在面板或 Drawer。阅读字号只作用于渲染后的 Markdown，不改变源码编辑器的固定行高。
- 表格列宽由内容决定：短值和表头保持自然宽度；长文字的最小内容宽度贡献以 `--markdown-table-readable-width`（16em）封顶，padding 另计，宽屏仍可继续展开。达到各列内容下限后仅表格横滚；不使用统一像素列宽或按列数相乘的最小总宽度。
- 表格保留 Markdown 作者指定的左/中/右对齐，多行单元格顶端对齐；表头不强制大写或加字距。
- Markdown 链接使用 Accent，不显示常驻下划线；明确的文件/网页以文件类型图标/链接图标提供非颜色识别。文件复用 `FileIcon` 的 `inline` 尺寸（1.2em）和相对基线跟随标题、正文及表格字号;网页与普通链接图标保持 1em，按真实目标而非展示标题分类。hover/focus 与右键复制保留完整原始引用（相对/绝对路径、行号或 URL），实际打开时才解析目标，长地址在有界提示框内换行，点击立即收起。可点击代码文件名在正文、列表和表格中统一去掉底色，普通非链接代码保留原样。普通未确认文件的行内代码保留 code 外观；引用使用 `ink-secondary` 和结构边界，不降低到不可读灰度。
- `mark` 使用 Accent 弱背景和主文字色；`kbd` 使用代码字体、Inset 表面和描边；`details/summary` 保留原生展开与键盘语义，映射现有表面、边框和 focus token；脚注保留隐藏标题并使用分隔线和次级文字色。图片保持比例与容器内最大宽度。

- 顶层宽表格可使用 Chat / 编辑器面板的横向留白，正文宽度保持不变；宽度由所在面板的 inline-size container 决定，不使用窗口宽度穿透侧栏。窄面板和嵌套/紧凑内容保留自身边界，超宽内容仅在表格内横向滚动。横向滚动容器显式使用 `overflow-x-auto` / `overflow-auto` utility 接入 App 手势归属判断；内容溢出时（包括左右边缘）优先于顶部 Tab 切换，无溢出时保留 Tab 手势。
- 表格的复制/下载控件在 hover 或 focus-within 显示，宽面板放在右侧留白，窄面板预留右侧操作位；表格到控件之间的视觉间隙须保持连续的鼠标命中区域。复制成功在原按钮短暂显示对号和“已复制表格”，与消息复制反馈一致，不重复弹成功 Toast。复制只包含当前表格，以 HTML + TSV 双格式写入剪贴板；下载为 XLSX，值按文本保存，不推断公式/日期/数字。富文本粘贴的最终格式由目标应用决定。

- Live-edit 共用正文500、标题/强调600的字重角色和标题字阶行高；表格单元格进入编辑后保持相同角色，源码与代码保持400。原生CM文本采用同一语义色，HTML/公式等投影直接复用Markdown内容样式，不另覆写mark/kbd。
- Live-edit保留源码空行与缩进，由CM管理行几何；标题行高靠齐阅读样式，列表根据语法嵌套层级显示实心圆/空心圆/方形标记，不给每一源码行附加段落margin。

### 8.4 流式、恢复与空态

- 流式文本使用稳定尾部淡化，不显示持续跳动的装饰光标。
- 已有 Session 恢复期间保持最终消息几何，不先显示 raw Markdown 再替换。
- 空态说明下一步，不把“没有内容”和“仍在加载”混为一态。
- 局部失败留在对应内容区重试，不能用全页错误拖垮 App Shell。

## 9. 跨平台原则

- macOS 使用原生红绿灯，Windows 使用原生窗口按钮；产品布局为各自安全区预留空间。
- 字体使用 Theme 的平台 fallback，信任系统渲染，不为追求一致而全局加载远程字体。
- macOS/Linux 保持系统滚动行为；Windows WebView2 的具体策略见 [`tech_docs/windows_platform.md`](tech_docs/windows_platform.md)。
- 原生权限失败必须给出可执行的设置入口和重试路径，不把权限问题包装成业务失败。
- 系统不支持某项能力时明确降级；不以无反应、隐藏错误或伪成功代替。

## 10. 核心产品面索引

### 10.1 功能交互

| 产品面 | 当前交互规范 |
|---|---|
| 全局侧栏、顶部 Tab、工作区与 Session 树、通知 | [`design/app_shell.md`](design/app_shell.md) |
| Launcher、Chat/Record 模式与共享 Composer | [`design/launcher_and_composer.md`](design/launcher_and_composer.md) |
| Task 创建、列表、详情与评论 | [`design/task_center.md`](design/task_center.md) |
| text/audio Record、录音、播放、转录、笔记与 AI 讨论 | [`design/records_and_recording.md`](design/records_and_recording.md) |

### 10.2 技术架构

| 领域 | 技术文档 |
|---|---|
| Theme 与 embedded adapter | [`tech_docs/theme_system.md`](tech_docs/theme_system.md) |
| Task/Record store、调度和 Session 边界 | [`tech_docs/task_center.md`](tech_docs/task_center.md) |
| Recording/Speech owner、Worker 与资源生命周期 | [`tech_docs/recording_and_speech_recognition.md`](tech_docs/recording_and_speech_recognition.md) |
| Chat 滚动与窗口呈现 | [`tech_docs/chat_scroll_presentation_lifecycle.md`](tech_docs/chat_scroll_presentation_lifecycle.md) |
| 搜索与虚拟列表数据链路 | [`tech_docs/search_architecture.md`](tech_docs/search_architecture.md) |
| 国际化同步 | [`tech_docs/i18n_architecture.md`](tech_docs/i18n_architecture.md) |

## 11. 设计变更检查

提交新的前端设计前确认：

1. 是否复用了现有语义 Token、Type Scale 和共享组件？
2. Hover/focus/loading 是否保持主要几何稳定？
3. 键盘、读屏、Reduced Motion 和触屏是否仍有等价路径？
4. 状态是否来自真实 owner，而不是 UI 自行推断？
5. 页面内已经能看到结果时，是否避免了重复 Toast？
6. 规则是跨产品通用、功能交互，还是技术不变量，并写入了正确文档？
7. 精确值是否已经由代码和测试拥有，避免在文档复制第二份易漂移清单？
