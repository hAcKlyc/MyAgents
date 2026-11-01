# 工作区 Markdown 编辑器

工作区可编辑 Markdown 的默认表面是 CodeMirror 6 Live Preview。读取、保存、图片归档和另存副本仍经 `useWorkspaceFileService(workspacePath)` → Rust `workspace_files`；不依赖 Session 或 Sidecar。入口为 `FilePreviewModal`，编辑投影位于 `src/renderer/components/markdown-editor/`。

## Owner 与生命周期

| 事实 | Owner / 修改入口 |
| --- | --- |
| 当前可编辑源码、选区、undo | 主 CM `EditorState`；单元格输入也立即变成父 `ChangeSet` |
| UTF-8 BOM、每个原始换行符 | `sourceFormat` StateField；通过变更映射与 inverted effects 一起撤销 |
| 最近确认的磁盘 baseline、在途保存 | `FilePreviewModal` 的 `executeSave` / `doAutoSave` / `flushForTransition` |
| 外部更新和当前文档路径 | `FilePreviewModal` + `useWorkspaceChangeSignal` / 既有 path-move helper |
| 逐行比较原文、revision / path generation | 宿主的固定 `ConflictSnapshot`；比较组件拥有该快照的逐行选择 |
| 进行中的图片导入 | 主文档的 `ImageImportQueue`；StateField 持有映射后的插入锚点，Rust 裁决实际落盘 |
| 持久文件 | OS / Rust `workspace_files`；编辑器没有永久草稿或资产关联库 |

React 的文本 prop 只负责初始挂载及编辑面卸载时交接。活跃期间不把每次按键复制到一份可独立修改的 React 全文；保存和引用通过 editor handle 物化精确源码。`onDetach` 必须在 CM 销毁前交接，避免宿主关闭时把旧 seed 文本重新写入已保存的文件。

嵌入 / 全屏共用稳定 portal 和同一个 EditorView，移动宿主 DOM，不挂两套可写编辑器。整篇源码通过 `Compartment` 重配装饰，保留 state/history。`CompositionGate` 归当前文档，覆盖主 view 与唯一活跃 cell；改变布局的动作在 compositionend 后、CM 接受最终 DOM 输入后执行，卸载时取消待执行动作。

全屏 portal 脱离 Tab 的 DOM 隐藏边界，因此宿主从既有可选 Tab API scope 与 TabActiveContext 派生展示资格；隐藏时保留同一文档与全屏状态，同时隐藏 portal 和浮动菜单、停用新图片接收，并让关闭快捷键交给当前 Tab。非 Tab 调用方保持可用，不新增可见性 owner。

macOS 编辑菜单的 Undo / Redo 由 `macos_edit_menu` 路由：先用真正的 Window 找到同名应用 Webview，再检查原生 first responder 是否属于该 view。不能枚举 `webview_windows()`，因为添加浏览器子 view 后主窗口会被该 API 过滤。应用编辑面经现有 Tauri 事件送到当前 Webview 的 bootstrap listener，再交给焦点元素的既有 keymap。emit 必须通过系统主队列异步退出 `with_webview` 的 Wry 锁域后执行，否则 emit 内部 eval 会重入同一 dispatcher mutex；主队列维持 Undo/Redo 顺序，不用无序 worker。listener 也必须通过 `listenWithCleanup` 的原生 Options 显式指定同一 Webview target，因为 Tauri 的 Any listener 仍会收到定向 emit；普通文本控件才使用 WebKit history。外部浏览器子 view / 原生对话框保留 AppKit responder 链。复制/剪切/粘贴继续使用原生菜单与系统剪贴板事件。不要用 WebKit undo manager 代替 CM 或 Monaco 的程序化编辑历史。

表格 mini 的键盘和 `beforeinput historyUndo/historyRedo` 都委派父历史；退出 mini 的撤销、结构操作或 TSV 粘贴同时把焦点交回主 view，以便下一次撤销/重做仍到同一文档。选区工具栏仅对非空选区显示，引用用分隔线及共享 Quote 图标区别于格式操作。表格操作菜单复用 `CustomSelect.popoverMinWidth`（208px）避免紧凑触发器截断完整操作名。

设置页的 `onSave` 调用方保留预览 / 编辑入口，编辑底座为 CM 源码模式；不因此获得 workspace 图片、watcher 或冲突处理。外部 local 文件只读；其他代码继续 Monaco。文件操作的 context 类型 / 消费 hook 位于 `context/fileActionState.ts`，Provider 仍在 `FileActionContext.tsx`，避免 Markdown 消费者反向导入挂载自身预览的 Provider。

## 文件链接与操作身份

预览导航先传递 `FilePreviewTarget`（文件身份与源码/行号意图），由 Chat 经 `resolveFilePreview` 决定消费者。聊天、目录和 pending preview 不先读取全文：普通 HTML/HTM 在现有浏览器布局中通过 Rust `resolvePreviewPath` / `resolveLocalPreviewPath` 校验并按 canonical 路径加载，网页浏览不使用文本容量门限；明确行号/编辑意图及文本模态框仍走有界源码读取。Browser 只保留文件身份，切换源码时重新走 `useWorkspaceFileService` 的 2 MiB 读取；失败保留网页并显示原始可读原因，不回退到陈旧或未加载的源码。预览发起 surface 的 `isCurrent` 与 `useChatFilePreviewNavigation` 中的 Chat request generation 共同裁决提交；手动面板切换/关闭、路径/布局变化和卸载使旧请求失效，读取与 draft transition 完成后均重新检查。Native browser 的 create/navigate 对本地目标再次复用 local 文件校验；这不构成网页子资源的额外沙箱承诺。

`markdown/ContentLink` 统一普通 Markdown 与反引号文件引用的目标、图标、完整原始地址提示、点击和右键；显式 anchor 的 href 拥有目标，标题内部的 inline code 只呈现格式。原生路径保留字面 `%` / `#` 等字符，URL 在引用边界解码；行/列后缀与文件名分别解析。聊天相对路径以工作区为基准，文档链接以当前文档目录为基准，不模糊搜索同名文件。href 的安全规范化与原始引用呈现分离；hover 与复制保留相对/绝对写法，绝对化/canonical target 仅用于校验和打开。

Chat 的 `FileActionProvider` 覆盖消息、分屏和全屏预览；consumer 不另建文件缓存。缓存刷新只裁决结果是否可写入缓存，用户操作的取消由 workspace identity / 最新导航意图裁决。未找到与校验失败分开，已有负结果在新出现的引用或显式交互时重新检查，并复用有限缓存 lease；不引入后台扫描。

同一 workspace / target 的刷新与 lease 到期只失效校验时效，保留最近一次结果供展示，直到新结果返回；不能把重新校验中的已确认链接降回普通代码，否则图标、底色与正文换行会反复跳变。点击与菜单仍实时校验，不把展示结果当操作授权。切换 workspace 或最后一个 consumer 卸载时释放旧结果。

Rust `check_paths` 返回文件事实与可选 `resolvedPath` / `error`。工作区符号链接指向普通外部文件时返回 canonical local target；预览和菜单沿 local 只读入口，不能由此扩大 workspace mutation 权限。用户主动打开普通本地文件支持其它卷与相邻工作区，保留 canonical credential/system exclusions 和真实 OS 可读性检查。未知格式仍提供系统打开/定位入口；不把文件存在等同于所有格式均可预览。

## Runtime 引用的阅读投影

共享 Markdown pipeline 在 inline grammar 层识别 `U+E200 cite U+E202 source-id U+E201`，代码、链接目标与 HTML 属性仍是字面内容。阅读时只用显式 `ref_id/title/url` 解析来源，URL 限制为无凭据 HTTP(S)；缺映射或冲突显示本地化“来源链接不可用”，不展示控制标记、不编造 URL。部分流式 opener 暂不显示，完整 opener 尚未结束时显示不可用提示。

桌面 Chat 的 MessageList 从已加载根消息的 WebSearch tool-result 派生来源表，按 Product `turnId` 隔离并通过 Virtuoso context 进入行失效边界；旧消息缺 turnId 时只使用自身消息来源。子 Agent 的 source ID 不借给根回答；未传入映射的 Markdown 表面仍可明确降级。不可变 tool 的解析与相同 turn 来源表复用，逐字 delta 不重复解析工具 JSON或使全部历史正文重渲染。消息复制/单条回复 Markdown 导出只替换 citation 源范围，其余 Markdown 和代码源码保持原字节；canonical transcript、原始 Session API 和 IM/latest-result 仍保留 execution text。已丢失来源数据的历史不扫描 native rollout、不写盘迁移。

## 源码与投影

CM 内部位置统一为 LF 坐标，`decodeSource` / `encodeSource` 是 IO / 比较 / 引用边界。不要直接用 `state.doc.toString()` 保存原文件：它会归一化混合换行。未编辑语法、空白、末尾换行和 BOM 均不得被片段渲染或 AST 序列化改写。删除使独立 CR 与 LF 新相邻时，只把该 CR 显式化为 CRLF，以免两个逻辑换行落盘后合成一个；格式变更仍随同一历史撤销。

`livePreview` 的直接装饰 StateField 将文档布局与视口内的轻量语法装饰分开：已解析的块、图片、HTML、跨行公式、引用链接、标题与围栏几何不随滚动撤销，CM 自己虚拟化离屏 DOM。不能由 `posAtCoords` 反推块是否存在（大表内部的坐标只会映射到块首/尾），否则会把前文投影恢复成源码并破坏滚动锚点。viewport plugin 只更新局部行内装饰范围；软折行的长物理行通过实际屏幕坐标收窄投影范围，不能因整个物理行属于 viewport 就挂载数千个离屏公式。几何读取归 CM `requestMeasure.read`，保持请求 pending 直到 write 后提交事务；不能在递归 microtask 中调用 `posAtCoords` 强制测量，否则 inline 投影宽度与折行会形成反馈循环。测量结果只适用于同一个 immutable Text，销毁后丢弃。React portal 复用 CM widget 容器，`destroy` 释放对应投影；块容器用 flow-root 包住后代 margin，行内图片/公式用可测量的 inline-block，HTML 保留原生 inline 流，按解析标签/文本声明 lineBreaks（属性中的伪标签不计数）；所有行内 widget 提供有效高度估计，异步内容提交/尺寸变化仍由 ProjectionFrame 请求 CM 测量；未知、不完整语法保持源码。代码标题只保存首行，复制时从当前 CM 文档按范围读取完整代码；避免全局布局扫描重复物化离屏代码正文。公式、Mermaid、HTML、图片沿用共享 `Markdown` 的 remark / rehype / sanitize / 资源组件。文档级引用与脚注索引取自语法树，按不可变 subtree 缓存相对位置，解析进度变化也刷新索引；不能把代码 / 表格中的相似字符串当成定义。

GFM 默认 Table 是单个 leaf，编辑大表时会同步重解析整个 leaf。`incrementalTables` 使用公开 composite extension 建立可复用 row tree；逐节点坐标测试与上游 GFM 对齐，包括引用 / 列表。composite 回调记录外层容器是否接受了下一行；缺少前缀的 lazy continuation 通过公开 PartialParse wrapper 每次 advance 消费有上限的一组行（128 行 / 16 KiB），再交还 CM 的解析预算；避免外层 quote/list 被提前结束，也避免单次 eager 消费超长链。Language base 先配置行调度，markdown() 的代码/HTML mixed parser 再包在外侧。正文行包在 LiveTableRowGroup block 中，让 FragmentCursor 直接复用整组，避免匿名 balance 节点被展开后逐行重建树；组节点不承载产品状态。块中断规则保留同级列表语义；不读写 parser 私有字段，不改写 AST。

表格模型的单元格范围来自语法节点 / delimiter；空格子和缺失格子通过源范围补齐。结构修改和 TSV 粘贴组合成父文档一次事务。只有一个活跃 mini CM，无独立 history / 保存；父 CM 的 `cellEditRange` 保存当前精确输入范围，不能把 parser 去掉布局 padding 后的范围当作活跃输入真源，否则逐键空格会被吞掉。父文档操作后重新投影，结构分隔符不能被 cell 末尾反斜杠转义。大量行使用主 scroller 的行虚拟化，初始块高度按源码行数估计。`tableGeometry` 只索引已测行相对默认行高的修正量，通过二分查找计算偏移与可见行；不因几十个可见行的测量而分配/重建整表行高数组。宽度溢出只增加局部水平滚动。

Theme 经 `@/theme` 公共 API 读取；CM syntax colors 从既有 `adapters.prism` 派生，正文和控件使用语义 CSS token。切换 theme 重配 extension，不重建文档。

阅读角色与共享Markdown一致：正文500、标题/强调700；CM语法高亮也消费同一字重token。mini cell使用所在th/td的字体角色，避免进入编辑时回退normal；代码、整篇/局部源码明确保持normal。mark/kbd投影直接服从共享Markdown样式。列表标记由语法祖先深度决定，widget equality包含深度以支持缩进变化；只改变装饰，不改写源码空白。标题行高消费现有Type Scale，源码空行保持原编辑语义，不把阅读段落margin施加到每一cm-line。

整表复制/下载复用阅读表格的 TableActions、剪贴板及下载 transport。动作经 CompositionGate 等待已开始的输入完成，然后只读当前 CM 文档；按源位置用共享 Markdown pipeline 定位对应表格，避免虚拟 DOM 或尚未完成的增量语法树截断导出行，并保留文档级引用定义。解析仅在显式导出时发生，不进入逐键/逐帧渲染。宽表使用面板 container 的可用宽度与表格自然列宽；阅读和编辑共用局部 `useTableIntrinsicSizing`，将已挂载单元格的呈现文本映射为不可见、零高度的 CSS 宽度探针。探针自然宽度以16em封顶，只贡献最小内容宽度，不限制宽屏展开，也不进入复制/下载数据；DOM内容变化才更新，不读取几何或扫描全文。虚拟行只在挂载时参与布局，不提供离屏列宽索引；mini编辑与只读内容遵循同一规则，取消固定96px列宽；嵌套由语法祖先判定（包括列表续段），表格不越出引用/列表边界。

查找仍以 CM SearchQuery / Panel 为 authority，`EditorSearchPanel` 仅把 panel 当前 query/readOnly 投影进 React portal；修改查询、前后导航、多选和替换调用原生 CM effect/command，替换进入同一父文档 history。主 CM 开启多选及原生 drawSelection，避免“选择全部匹配”被归一化为单选。快捷键使用 search-panel scope；选择工具栏不包含查找。面板占用顶部布局槽并靠右，避免覆盖正文；进阶选项/替换复用 Popover，实际 portal DOM 挂载时移动焦点，Escape 先关闭选项并返回触发按钮，再关闭查找。

全局/局部源码的退出控件由编辑器统一作为顶部居中的独立浮层显示，覆盖正文而不占文档流、不增加标题栏或正文顶部留白；只有按钮接收指针事件，外围区域可穿透到正文，层级低于查找/链接浮层。退出后焦点回到同一个文档。圆角、面板和搜索高亮引用既有主题 token；表格圆角在水平滚动容器外框裁切，虚拟占位行不增加边框/间距；代码首部与末行分别应用相同圆角，不改写源码或增加每行垂直间距。

## 文档目录速览

Live Preview 左缘的短横线入口不占正文布局，悬停展开共享 `Popover`，点击标题先校验当前 CM 索引中的项身份，再在同一个 CM 文档中导航；源码模式、隐藏或暂停时卸载目录呈现和全局解析任务。目录浮层复用 viewport 定位、外部点击/Escape 与 close-layer，支持按钮/键盘入口。无标题不显示；仅展开时构建完整目录列表；长目录内部滚动，边缘标记最多24条并按标题区间指示当前章节。

`definitions.outline` 与现有 anchor 索引共用语法树和 subtree 缓存，保存当前源码的标题范围、级别、纯文本标签，覆盖 ATX H1–H6、Setext 与容器内标题；代码、HTML块和frontmatter不产生伪标题。标题范围独立于 slug，重复标题可分别导航；与标题无关的变更复用相同数组引用。React 不重新解析全文。

`outlineProjection` 的 ViewPlugin 按15ms预算、80ms间隔推进同一个CM parser，补全默认后台解析可能止步于视口之外的目录；输入时重新安排，销毁时取消。滚动只在 `requestMeasure.read` 读取CM行块位置并按物理行末位置二分查找当前标题（包含引用/列表前缀后的标题），标题/当前章节/解析完成状态变化才向React发布。导航通过 `CompositionGate` 和 `EditorView.scrollIntoView`，清除局部源码展开，不写正文或历史；等待输入法期间文档已改变则丢弃旧坐标，避免错位跳转。

## 保存与比较

普通自动保存串行，写入携带最近确认的 `expectedContent`；这不是跨进程强 CAS，Rust 的校验 / 路径锁不能约束任意外部 writer。dirty draft 与磁盘同时变化时暂停自动保存。

比较区域上下排列，选择键是源码行对 ID，不是展示块。展示块仅负责导航 / 上下文；空白行与不存在的一侧不同，BOM / 行尾格式参与选择。对齐超预算时保留两侧完整行顺序并提示简化；只对可见行做有预算的词级高亮。上下滚动按共同 row ID 和行内偏移映射。

混选拼合时按最终连接的分隔符保留逻辑行，包括为原 EOF 行补上的分隔符；若新相邻的 CR 与空白 LF 行会合成单个 CRLF，只将前一个 CR 显式化为 CRLF，避免吞掉用户选中的空行。全选任一侧仍逐字还原原快照。

比较打开时暂停文档输入。关闭比较保留快照 / 选择；本地 revision、磁盘版本或路径变化使其过期，刷新会明确建立新快照并清空选择。用户先检查组合结果，再提交。宿主提交前重读磁盘并校验 snapshot；组合结果在确认落盘后才进入主文档的一次 history entry，全选磁盘则建立 external reload history boundary。失败保留原 L / D / 选择；回执不确定时保留 proposed result，重读确认后才能重试，不能盲目写第二次。

`documentGeneration` 防止异步结果跨文档写回，`pathGeneration` 使旧路径上的比较失效。成功移动同一文档时，不能仅因 path generation 变化就丢弃已完成的正常保存回执。关闭 / 重命名 / 整文件引用经过 `flushForTransition`，先停止接收图片并等待已接受的操作和在途保存。Chat、DirectoryPanel 和 FileActionProvider 在替换文件 identity 之前调用 handle 的 `prepareTransition`；失败保留旧文档。同 path/scope 的 FileAction 自文件链接仅更新 focus 意图，禁止用 loading 卸载活跃草稿。Chat 的关闭 admission 接到既有 TabCloseController.prepareClose，App 只保存 submitter 回调，不拥有源码。工作区 Markdown 不在卸载后用 best-effort 写盘来替代 admission。

## 图片与普通文件

`cmd_workspace_import_markdown_image` 一次处理一项，宿主串行传递剩余批次预算：每项 10 MiB、每批 10 项 / 50 MiB。Rust 有界读取 / base64 解码并核对类型，采用 workspace path guard、mutation lock 和不跟随 symlink 的独占发布原语。图像保留原始字节，SVG 仅作为受控图片资源显示。确定失败逐项报告文件名 / 原因并继续后续项，重试只针对失败项；回执未知时停止批次，不猜测剩余预算或再次创建同一文件。

图片写入 Markdown 同级 `<stem>_assets/`，重名返回实际新名称；只有收到成功结果、文档 generation 和映射锚点仍有效，才插入按路径段编码的相对 URL。选区删除 / 文档切换 / 取消使插入资格失效，已创建的普通文件不自动删除。撤销只撤销 Markdown 文本。文档改名不搬旧 assets，新导入使用新 stem。

`cmd_workspace_save_markdown_copy` 在同目录独占创建 `_local-copy` 文件，即使原 Markdown 已被删除也可保留内存草稿。它不覆盖原文件，也不建立恢复数据库。宿主捕获 identity/revision，成功后仅在草稿仍匹配时采用重读后的原文件；确认原文件不存在时，已覆盖当前 revision 的副本允许关闭原文档。较新的输入不因旧副本成功而被清除。

`path_safety::create_workspace_file_no_follow` 将完整临时文件独占发布到最终名称；`files_b64::write_unique_file` 复用此原语，避免检测重名后创建的竞态和暴露半写文件。Windows 使用相对 directory handle / 不替换目标的 rename；Unix 使用独占 rename 或 hard-link 发布。Windows rename 成功即已发布，之后 sync / parent 验证失败必须返回已有的 unknown receipt 语义，不能作为确定未写入允许再次导入。

原生 drop 由 `useTauriFileDrop` 按当前 DPR、命中元素和最近的注册 surface token 裁决。隐藏、被覆盖或 inert 的编辑面不接收；嵌套 Markdown 区域不会再落入 Chat 的未知区域 fallback。

## 验证入口

`@codemirror/view` 精确固定 `6.43.11`，安装时运行 `scripts/patch-codemirror-view.mjs` 修复该版本的长行 resize 空洞：`measure` 必须在更新宽度前保留旧宽度；`HeightOracle.refresh` 必须把 wrapping 宽度变化算作失效，否则继续复用旧 gap 高度。纯 CM 默认 CSS 也能复现，修复保留在依赖的几何 owner，不在应用读取私有 viewState 或重建编辑器。脚本仅接受 npm 原始 / 修复后两组 SHA-256，同时校验 ESM/CJS 与版本；dev/build/typecheck 缺补丁时失败并给出恢复命令，`--ignore-scripts` 安装后需显式 `npm run postinstall`。

升级 / 删除补丁前运行 `npm run verify:markdown-resize -- chrome`（或省略 channel 使用已安装 Playwright browser）：24,000 字符单行，390→250→600px resize / scroll 后 50 个可见坐标往返不能落进空洞。再验实际 Markdown 的密集公式、普通输入、表格及全屏；上游版本包含修复并通过相同回归后，删除脚本、安装/校验 hook、start_dev.sh 校验入口和版本 pin。本地补丁是发布阻塞缺陷的临时依赖维护，没有新的运行时 owner、重试或 viewport 恢复机制。

- `node scripts/verify-markdown-live-preview.mjs chrome` / `webkit`：真实 parser/CM 布局回归及 React + Markdown + TableProjection + 生产 CSS 的离线浏览器验证，覆盖多长表滚动、虚拟行数量、混合 HTML/图片和仓库 README 的点击源码坐标；系统文件/链接操作使用 fixture，不能代替 Tauri 文件 IO 验收。
- `markdown-editor/*.test.*`：格式保真 / undo、GFM 坐标与树复用、表格结构事务、行组合、图片锚点与预算、引用语义、真实 CM 模式 / cell / search。
- `FilePreviewModal.liveReload.test.tsx`：保存失败、移动 / 关闭 / 全屏、冲突重试和未知回执、编辑面卸载交接。
- `useTauriFileDrop.test.tsx`：DPR、可用性、嵌套 surface / overlay / inert 与 listener cleanup。
- Rust `workspace_files::`：路径 / symlink / 并发独占创建、图片约束、原文件保留和副本。

DOM composition 事件仅证明调度和 view identity，不能代替真实输入法验收。Chrome 或独立 WKWebView 的开发态 harness 也不能证明真实 Tauri OS drop、Windows WebView2 或完整 cold 性能。具体发布证据与尚未关闭的 mandatory 检查留在对应 PRD 执行台账，不把未测项写成实现已通过。

表格模型利用 CM Text 的行索引和语法树按需解析 `rows.at(index)`，渲染/编辑热路径中仅结构性列操作才遍历全部行；投影以 immutable Text 身份失效，不在每次输入时把整表拷成字符串。定义索引包含匿名子树以复用稳定分组；可见行出现额外 GFM cell 时提示源码出口。

多单元格 TSV 粘贴通过一系列临时 `EditorState` 组合父文档的 `ChangeSet`。临时状态没有 View 推进后台解析，限时解析得到的 `syntaxTree(state)` 可能不完整。每步结构或单元格变更后，必须补全到映射后的当前表格末尾，再用 `ensureSyntaxTree` 返回的树计算下一步坐标；该函数不会同步替换状态中原有的树快照。正常输入与渲染仍按解析时间预算执行，最终只向父文档提交一次事务。
