# Theme System

> 本文是 Theme、外观模式及各渲染 surface 的当前架构。修改 Launcher Hero、宿主 CSS Token、xterm、Monaco、Mermaid、Prism、Widget iframe 或 Floating Ball 视觉前必须阅读。

## 1. 领域模型与 owner

三个概念必须保持正交：

| 概念 | 类型 | Owner | 含义 |
|---|---|---|---|
| Theme | `ThemeId` / `ThemeDefinition` | renderer production registry | 一套完整视觉语言 |
| 外观偏好 | `AppearanceMode` | durable `AppConfig.appearanceMode` | `system / light / dark` |
| 已解析明暗 | `ResolvedColorScheme` | 每个 Webview 的 Theme runtime | 当前实际使用的 `light / dark` |

Production registry 的展示顺序与 canonical 注册顺序解耦，当前九套完整 Theme 的产品顺序为：
`myagents-light`（用户可见名 `MyAgents Light`）、`myagents-default`（`MyAgents Classic`）、
`default-black`（`MyAgents Classic2`）、`sage`、`absolutely`（`Claude`）、`linear`、`proof`、
`codex`、`raycast`。canonical package 仍先注册并独立承担 fail-fast fallback。
不得把 light/dark 拆成两个 Theme，也不得重新用 `theme` 字段表达 appearance。

目录：

```text
src/shared/theme.ts                         纯类型、默认值、配置迁移、scheme resolve
src/renderer/theme/index.ts                 consumer 唯一公共入口
src/renderer/theme/types.ts                 Definition / ResolvedTheme / adapter 契约
src/renderer/theme/registry-contract.ts     required Token / xterm / Mermaid / Widget 契约清单
src/renderer/theme/stylesheet-contract.ts   CSS block / selector / declaration 语义解析
src/renderer/theme/registry.ts              校验、注册、整套 resolve/fallback
src/renderer/theme/bootstrap.ts             非敏感、带版本的首帧快照
src/renderer/theme/ThemeRuntime.tsx          root/context/system/跨窗口 owner
src/renderer/theme/themes/myagents-default.* canonical manifest + CSS
src/renderer/theme/themes/<preset>.*          optional manifest + complete CSS
src/renderer/theme/themes/preset-theme.ts     derives complete adapters from each preset CSS
```

`.dependency-cruiser.cjs::theme-consumers-public-api-only` 强制 Theme 目录外的 production consumer 只能 import `@/theme`，不能直引 default manifest、CSS 或 registry 私有实现。

## 2. 配置与迁移

归一形态：

```ts
interface AppConfig {
  themeId: string;
  themeSelectionExplicit?: boolean;
  appearanceMode: 'system' | 'light' | 'dark';
}
```

`src/shared/theme.ts::normalizeThemeConfigRecord()` 是 TypeScript 读取边界的共同语义：

1. 有效 `appearanceMode` 优先；否则读取 legacy `theme`；无效值归一为 `system`。
2. `themeSelectionExplicit:false` 表示用户从未明确选择，`themeId` 每次读取都投影为产品默认 `DEFAULT_THEME_ID`（当前 `myagents-light`）；以后只改该常量及跨进程 bootstrap 镜像即可迁移所有仍跟随默认的用户。
3. `themeSelectionExplicit:true` 永久尊重有效的非空 `themeId`。兼容旧配置时，非 canonical ID 推断为显式选择；历史自动物化的 `myagents-default` 推断为未选择。用户在新选择器中明确选择 `myagents-default` 后会连同显式标记一起保存，不再被迁移。
4. 未知但非空的显式 ID 保留给 renderer registry 做整套 canonical fallback；内存结果删除 legacy `theme`。
5. load 不主动写盘；下一次真实写入由 renderer/Node/Rust 各自的 config lock 路径发布归一结果。

Renderer `loadAppConfig()`、Node `admin-config.ts` 和 Rust `config_io.rs` 必须保持上述规则一致。Settings 分别通过 `ConfigProvider.updateConfig({ appearanceMode })` 与 `ConfigProvider.updateConfig({ themeId, themeSelectionExplicit:true })` 写入两个正交偏好；禁止直接写 localStorage 或用 React stale config 覆盖磁盘。

## 3. ThemeDefinition 完整契约

每个 Theme 是一个共置 package：一个 TypeScript manifest、一个 CSS 文件，以及可选的 Vite/Tauri build-bundled assets。manifest 必须同时提供：

- 稳定 ID 与内部描述；
- 共置且由 manifest 实际导入的 stylesheet source；其中声明 `REQUIRED_THEME_CSS_TOKENS` 全集；
- light/dark 两套完整 scheme；
- Launcher Hero：产品名、zh-CN/en-US slogan、每 scheme 背景 asset/position/size/repeat/mask；
- xterm：ANSI palette、cursor/selection、font family/size/line height；颜色值只使用 xterm
  `css.toColor()` 在所有环境都稳定支持的 `#rgb[a]` / `#rrggbb[aa]` / 逗号式 `rgb(a)` 子集，
  透明色不得依赖 Canvas fallback；
- Monaco：冲突安全 name、完整 theme data、font family/size/line height；
- Mermaid：base theme、fontFamily，以及 `primaryColor` / `primaryTextColor` /
  `primaryBorderColor` / `lineColor` / `secondaryColor` / `tertiaryColor` 六个核心颜色变量；
- Prism：完整 syntax style；Theme 内部属性值统一为 string，让 registry 直接按 CSS declaration
  语义校验，不在 Theme System 中复制 React 的数值单位规则；第三方 palette 的旧 vendor/错误键
  只在 concrete Theme 导入边界清洗；
- Widget：`REQUIRED_WIDGET_CSS_VARIABLES` 全集。

canonical Theme 为 React 前首帧兜底可静态导入 CSS；可选 Theme 只能用 `?inline` 把同一份 CSS 源码交给 registry 校验并由 runtime 激活，禁止在注册校验前产生 stylesheet side effect。

可选 package 只在模块求值时导出内联 CSS manifest；Registry 在自己的可选包失败边界内调用
`preset-theme.ts`，从 CSS semantic Token 构造 Definition 并派生 xterm、Monaco、Mermaid、Prism
与 Widget adapter。Widget 的圆角与阴影同样来自该 Theme 的 `--theme-radius-*` / `--theme-shadow-*`，
不保留 canonical 常量。这个 helper 只抽取结构，不导入或 spread canonical Theme；因此宿主和嵌入式
surface 共享同一套视觉事实，构造或校验失败都只拒绝当前可选包，不会在 Registry 接管前中止启动。
构造与校验必须共同消费 `stylesheet-contract.ts` 的语义解析结果，不能依赖 `?inline` CSS 在开发态
保留的引号、空格、换行或末尾分号；Vite production minifier 可以合法改写这些序列化细节。

两个受控比较 Theme 都交付完整、独立、精确 scope 的 light/dark CSS，而不是运行时继承：

- `myagents-light` 是当前产品默认，除 light `--button-primary-bg/hover` 改为中性黑外，host Token
  逐项等于 `absolutely` / Claude；dark 与从 CSS 语义色板派生的五类 embedded adapter 也保持一致；
- `default-black` 的 host Token 除同一组 light 主按钮差异外逐项等于 canonical `myagents-default`；
  因为差异不涉及 embedded surface，其 Factory 直接复用 canonical 的 immutable Hero/adapters。

架构测试分别锁定两组完整 Token 差异白名单，Registry 仍在同一个 optional failure boundary 内验证并
原子注册整套 Definition，避免代码块、终端、编辑器或图表在“只比较按钮”时产生伪差异。

`ThemeRegistry` 直接校验同一份实际打包的 stylesheet source：可选 Theme 的 required Token 只能来自顶层、精确的 `html[data-theme-id='<id>']` root 与两个顶层精确 scheme root；canonical default 则必须全部来自 `:root, <exact-theme-root>`、`<generic-scheme>, <exact-scheme-root>` 成对 fallback block，禁止再追加 standalone exact block，从结构上保证未知 ID 首帧与注册后的 canonical package 完整同源。这些 root 与 Hero block 只能包含平坦 declaration，CSS Nesting、descendant、不可达 at-rule 与空/CSS-wide 值不能冒充或扩张 root 声明；轻量扫描器遵循 CSS input preprocessing 与 bad-string 换行恢复，不能用跨行坏字符串藏住结构括号。只有 canonical default 可在与精确 Theme selector 成对的 selector list 中使用 `:root`、通用 scheme 和无 scope Hero fallback；可选 Theme 即使把这些 selector 包在条件规则中也会被拒绝，避免未激活包泄漏全局值或污染 Space。Theme stylesheet 禁止 `@theme`、`@property`、`@font-face` 等全局副作用 at-rule；唯一允许的 at-rule 是只包含合法 scoped Hero selector 的顶层 `@media`，用于响应式 Launcher 排版，并且不能替代顶层 Hero 完整性声明。Token 在解析同 Theme `var(...)` 依赖后还必须满足实际消费属性的 CSS 语法。注册时还拒绝重复/非法 ID、缺 Hero selector、缺 scheme/Hero/adapter、空或属性值无效的 Prism、残缺/非 iframe literal/属性语法无效的 Widget variable、无效字体/数值，以及 stylesheet/Hero 中的远程资源；不得用另一份 token 名称元数据代替 CSS 事实。无效的可选包被拒绝但不阻断 canonical registry；未知配置 ID 只记录一次不含秘密的 warning，并把 Definition、CSS root ID、Hero 和全部 adapters **整套**切到 `myagents-default`。pre-React 阶段由 canonical `:root` package globals + 通用 scheme selector 提供完整视觉兜底，禁止出现无 Token root 或逐字段继承形成混合 Theme。

背景 asset 只能是构建打包的 `self` 资源。不得加载远程字体/背景、用户 CSS/JS 或扩大 CSP/asset protocol scope。

## 4. CSS Token owner

`myagents-default.css` 拥有当前视觉运行时数值：包 globals 同时声明在低特异性
`:root` fallback 与精确 Theme root，明暗值在通用首帧 scheme fallback 与精确 scheme root：

```css
:root,
html[data-theme-id='myagents-default'] { ... }
html[data-color-scheme='light'],
html[data-theme-id='myagents-default'][data-color-scheme='light'] { ... }
html[data-color-scheme='dark'],
html[data-theme-id='myagents-default'][data-color-scheme='dark'] { ... }
```

Token 组：

- 字体：body/display/code 运行时角色；
- Ink/Paper、全局 App Shell 侧栏结构面 `--global-sidebar-bg`，以及同色 0-alpha 渐变端点；侧栏值由每套 Theme 的 light/dark 独立设计在 `paper → paper-inset` 之间，页面与卡片不得借此翻转通用 Paper 层级；
- Accent、Heartbeat、Success/Error/Warning/Info；所有实色 action/status surface 都有独立配对 foreground（`--on-*`），不能跨语义借用；
- Button（primary / 固定深色 surface 各自有配对 foreground）、Border、Focus、Toggle；
- `--theme-radius-*`、`--theme-shadow-*`、工具/动作局部 shadow；
- Code、Animation；
- body background/texture/blend；
- Floating Ball 全部 `--fb-*`；
- 产品字标基类与 Launcher Hero title/slogan selector；字标基类拥有跨 Launcher、About、全局侧栏共享的字体、字距和渐变，Hero selector 只拥有展示字号、字重与响应式布局。

`index.css` 只保留 Type Scale、布局/交互结构、使用语义 Token 的通用 selector，以及一个不携带视觉值的 Tailwind v4 `@theme inline` 编译桥。该桥把 `font-sans/mono`、`rounded*`、`shadow*`和 `duration-*` utility 映射到当前 Theme 的 runtime Token；Theme package **禁止**声明 raw `@theme`，因为 runtime 注入的 CSS 不再经 Tailwind 编译，会让 utility 静默退回 framework default。新增会随完整 Theme 改变的颜色、字体、材质、阴影或圆角，必须先进入 Theme contract/default package，再按需要扩展无值桥接，不能落回组件常量。

推荐卡片材质由 `--featured-card-background` / `--featured-card-border` / `--featured-card-shadow` 拥有；目前词元跳动卡片消费这三个 Token。各主题按自己的强调色预计算 sRGB / alpha 色值，并叠加 `--paper-elevated`，深色降低高光强度；required Token 不依赖旧版 WebView 尚未支持的 `color-mix()`，避免 canonical 注册失败阻断启动。组件不读取 Theme ID 或 scheme，不另建配色表。

Code Token 必须在每套 Theme 的 light/dark scheme 内分别设计：light 代码面位于 `paper → paper-inset`
之间，dark 代码面位于或略高于 `paper-inset`，Header 再向对应方向推进一级。Prism 由同一组
Theme 语义色生成并在各自代码背景上满足正文对比度；CodeBlock、Mermaid、Bash、FilePatch
只消费 Token / Adapter，禁止用 Theme ID 或 DOM scheme 分支补本地 palette。

## 5. Runtime 与首帧

### 5.0 设置选择入口

公开的“设置 → 通用设置 → 界面外观”卡片末尾提供 Theme `CustomSelect`。它从
`themeRegistry.getAcceptedDefinitions()` 读取实际已校验列表，并直接按 Registry 产品顺序显示为
单层列表。每个选项右侧的两枚色块分别展示 light/dark `--button-primary-bg`；颜色由 Registry 从
Theme package stylesheet 解析，不在 Settings 维护第二份 palette。选择时只
调用 `ConfigProvider.updateConfig({ themeId, themeSelectionExplicit:true })`；控件显示 `ResolvedTheme.themeId`，所以未知配置和
无效 optional package 会显示 canonical fallback。写盘失败不做 optimistic selection，并使用 Settings
toast 报错。选中标记紧跟主题名称，light/dark 色块保持在行尾。`appearanceMode` 由公开外观控件独立写入。

### 5.1 主窗口

`ConfigProvider → ConfiguredThemeRuntime → App`。Config 尚未加载时，runtime 保留 bootstrap snapshot；durable config 就绪后才校正选择，避免先闪 default light。

`main.tsx` 在创建 React root 前调用 `primeThemeRuntimeFromBootstrap()`：它从 versioned snapshot
解析并经 production Registry resolve 后激活可选 stylesheet 与 root scheme。可选 package 仍不在
模块加载时产生 CSS side effect，但首个 React paint 已使用已验证的目标 Theme；未知 ID 继续整套
回退 canonical。

runtime 一次 resolve 后同步投影：

- 通过 `useInsertionEffect` 激活 Definition 中已校验的实际 stylesheet source；canonical CSS 仍静态导入以保护 React 前首帧；
- `<html data-theme-id data-color-scheme>`；
- `.dark`（只为 Tailwind `dark:` 兼容）；
- `style.colorScheme`；
- main native Window background（读取已激活 Theme 的 resolved `--paper`；浮窗不参与）；
- stable `ResolvedTheme` React context；
- versioned localStorage snapshot；
- Tauri `theme:selection-changed` 精简事件。

`system` 用 `useSyncExternalStore` 订阅 `prefers-color-scheme`。Terminal、Monaco、Mermaid、Widget 等禁止观察 DOM class 反推状态。

### 5.2 pre-React bootstrap

`index.html` 只读取 `myagents:theme-bootstrap`：

```json
{ "version": 2, "themeId": "myagents-light", "appearanceMode": "system", "themeSelectionExplicit": false }
```

快照不得包含 AppConfig、API key 或 MCP env。新快照不存在时可一次读取 legacy localStorage `theme`；durable runtime 第一次发布后删除 legacy key。快照损坏/版本不支持时首帧回退 default + system，应用不能因此阻断。

runtime 写入的是 registry 已解析的 Theme ID，并同时写入显式选择状态；因此未知 durable ID 的下一次冷启动也直接得到 canonical fallback，而未选择用户会按当前编译版本的产品默认重算，不会被旧快照钉死。

Tauri 主窗口还存在一个早于 `index.html` 的原生空白 surface。Rust 在创建主窗口前只读取
`config.json` 中归一后的非敏感 `appearanceMode`，不在读取边界写盘；随后：

1. 先隐藏构建窗口，把 canonical Theme 的 `--paper` 投影为原生 Webview background；
2. `system` 模式从 native window theme 解析首帧明暗，显式 light/dark 直接使用 durable 选择；
3. 用 initialization script 在 HTML 解析前对齐同一个 versioned localStorage snapshot；Theme ID
   保留 renderer registry 上次发布的 resolved ID；无有效快照或快照标记为未显式选择时使用当前产品默认，Rust 不用
   未经 registry 验证的 durable Theme ID 覆盖它；
4. 原生 background、bootstrap snapshot 就绪后再同步显示窗口，之后由 renderer runtime 接管完整 Theme，
   并在每次 Theme / scheme 切换后把 resolved `--paper` 同步到 main native Window background。

Tauri initialization script 会在 reload 时再次执行，因此每次 native process 生成唯一 run ID；同一
Webview reload 发现该 ID 已完成对齐后必须保留 ThemeRuntime 发布的更新快照，新 native process 才
重新用 disk appearance 对齐。损坏 snapshot 的解析单独 fail-soft，不能跳过 canonical fallback 与
durable appearance 写入。

initialization script 同时在模块执行前安装只观测的 `error` / `unhandledrejection` 监听，并通过受限 `cmd_record_renderer_boot_event` 让 Rust unified logger 写入带 window label 的有界 `[boot] stage=...` 证据；renderer entry、Theme prime、React root 与真实 commit 也走同一早期 ingress，因此不依赖 App/Sidecar logger 已挂载。观测失败必须静默，不能成为 Theme 或窗口启动依赖；这些标签不拥有 fallback 决策，也禁止触发 reload/retry。

该 native bridge 不是第二个 Theme owner：Rust 不复制 palette、材质或 adapter，只投影一个避免
Webview ready 前反色闪帧的平面 `--paper` 值；Rust unit test 从 canonical Theme CSS 解析两个
scheme 的实际 `--paper` 并与 native `Color` 比对，防止跨语言投影静默漂移。启动读取失败时回退
default + system，不能阻断窗口创建。

### 5.3 Floating Ball Webviews

`fb-ball / fb-companion / fb-shield` 各自挂轻量 `FloatingThemeRuntime`，不挂完整 ConfigProvider：

1. 同步读取 bootstrap snapshot；
2. 先注册 `theme:selection-changed` listener，再异步 `loadAppConfig()` 自校正；
3. hydration 期间收到的 live event 具有更高 freshness，旧 hydration 结果不得反向覆盖；
4. 各自订阅 OS scheme。

事件 payload 只能含当前生效的 `themeId + appearanceMode`。`themeSelectionExplicit` 只属于 durable config 与首帧快照，浮窗无需拥有默认选择策略。主窗口与浮窗不得通过 Sidecar/HTTP/SSE 同步 Theme。

## 6. 消费者不变量

| Surface | 正确消费方式 | 切换约束 |
|---|---|---|
| Launcher / About / GlobalSidebar 品牌 | `ResolvedTheme.hero` + Theme 产品字标/Hero CSS selector | 产品字标字体、字距和渐变同源；Hero 与紧凑侧栏只分离尺寸/字重角色，不复制品牌配色；背景不改变布局 |
| CSS host / Space / Floating Ball | root semantic Token | `.dark` 不是状态源；Space 不建立局部 Theme scope |
| xterm | `adapters.xterm` | 原位改 options；字体 family/size/lineHeight 变化后复用唯一 fit-and-resize owner 重算 cols/rows 并同步现有 PTY；split 首次展示/变宽以 ResizeObserver 的 geometry quiet window 判稳后再创建或 resize PTY，不复制 Theme-owned transition duration；不重建 Terminal/PTY/buffer |
| Monaco | `adapters.monaco` | define 冲突安全名称并 `setTheme`；不换 model/editor |
| Mermaid | `adapters.mermaid` | Theme key 变化重渲染；保留 strict/timeout/last-valid |
| Prism | `adapters.prism` | CodeBlock、Mermaid code、Bash/FilePatch 派生同一 palette |
| Widget | `adapters.widget` 的 scheme literal → `widget:theme` | 禁止 render 时读宿主 computed style；只 postMessage CSS，不替换 iframe/srcdoc/内容 |

## 7. Space 与非 Theme 内容

Space 是全局 Theme 的标准 CSS host surface：组件直接消费 root semantic Token，Popover portal 也自然从 `<html>` 继承同一套值。不得为 Space 添加局部 Theme ID、独立 palette、Theme 映射表或逐字段 fallback。切换 Theme / scheme 时，Space 的 paper、文字、字体、圆角、阴影、动作色与 success/error/warning/info 状态组必须原子变化；布局、信息架构和业务状态机保持不变。

全量视觉字面量审计中的合法非 Theme 类别：

- QR 黑白模块、第三方平台品牌色与 Logo；
- Markdown clipboard 导出 HTML 的自包含颜色（目标是外部文档，不是宿主 UI）；
- AppErrorBoundary 在 Theme CSS 整体失败时的应急 fallback；
- selection/fade/mask 的纯 alpha 几何；
- 用户内容、宠物图像、Browser 子 Webview 网页；
- 布局尺寸、z-index、业务交互与组件状态。

## 8. 新增完整 Theme checklist

1. 在 `src/renderer/theme/themes/` 下共置 `<id>.ts`、`<id>.css` 与可选 bundled assets；manifest 导入同一 CSS source，runtime 会直接激活它，不能只靠 entry 的全局 import。
2. 明确复制并重新设计全部 required runtime Token；不要通过 spread default Theme 补缺项，不要把 `@theme` 编译指令放进 Theme CSS。
3. 同时设计 light/dark；校验 Windows CJK generic 只在完整字体链末尾。
4. 提供 Hero 两种语言、两个 scheme 的 self/bundled 背景槽与全部五类 adapter；Widget variable 全部给 iframe-ready literal，禁止宿主 `var(...)`。
5. 只在 production registry 注册 definition；consumer 不做任何 Theme ID 分支。
6. 补 registry DOM contract、runtime DOM 与所有 adapter component tests；新增 utility 桥接时同步扩展 production generated-CSS 契约校验。
7. 跑 light/dark 全场景视觉矩阵、system 冷启动、主/浮窗 live update，以及 Space 登录、导航、列表、详情和弹层场景。
8. 在 macOS WebKit 与 Windows WebView2 实测字体、透明窗、Monaco/xterm。
9. 确认 production bundle 没有 test fixture/asset，CSP/asset scope 未扩大。

## 9. 自动化护栏

- shared unit：appearance resolve、legacy migration、幂等；
- registry DOM contract：用与 production 相同的 CSS declaration parser 验证完整 synthetic Theme、属性语法、重复/缺项拒绝和未知 ID 整套回退；
- runtime DOM：root attributes、`.dark`、system media、context/snapshot；
- component DOM：Hero、xterm、Monaco、Mermaid、Prism、Widget 原位更新；
- floating DOM：snapshot → durable config → Tauri live event；
- architecture unit + dependency-cruiser：禁止 consumer 直引 internals、禁止本地 palette/MutationObserver 回流；
- preset contract：accepted IDs/名称/顺序精确等于九套，设置下拉直接映射 Registry 的显式产品顺序；七套 preset-built
  Theme 的正文和实色主动作对比度不低于 4.5:1，`myagents-light` / `default-black` 分别验证新增黑色主按钮对比度并
  逐 Token 锁定其余值等于 Claude / canonical；`verify:theme-presets` 先按 Vite production 使用的
  esbuild CSS minifier 序列化八套实际 optional stylesheet，再经 optional factory 完成精确九套 Registry
  注册并逐套 resolve light/dark；
- structural surface contract：九套生产 Theme 的 light/dark 都必须让 `--global-sidebar-bg` 的亮度严格位于 `--paper` 与 `--paper-inset` 之间，并与 `--paper-elevated` 保持不同值；`GlobalSidebar` 是唯一宿主消费点，右侧页面、卡片和顶部 Tab 栏不随该 Token 改写；
- dark control contrast：九套 Theme 的 Primary 正常/hover 均验证 4.5:1，深色 action
  surface 锁定白色/近白前景；全部 production Theme 的 dark Switch thumb 锁定为白色/近白控制面；
- build smoke：`build:web` 串行执行 `verify:theme-css` 与 `verify:theme-presets`；前者读取实际
  `dist/assets/*.css`，验证 font/radius/shadow/duration utility 仍引用 runtime Theme Token，且 bundle
  不存在未编译 raw `@theme`，后者防止 production `?inline` 序列化导致 preset catalog 启动时被拒绝。

发布前仍必须完成视觉截图矩阵、browser dev 和 macOS/Windows 实机验证；自动化不能替代真实渲染验证。
