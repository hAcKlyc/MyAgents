# MOXBOTS-CHAT-ARCHIVE-20261013 验收合同

## 范围与边界

- 左侧全局聊天任务按 `SessionMetadata.archived?: boolean` 展示归档状态，通过现有 session PATCH 持久化。
- 默认“全部”和“收藏”列表不显示已归档会话；“已归档”列表显示它们，并允许打开与恢复。
- 归档只改变列表可见性；不删除会话、消息、附件或工作区文件，不停止会话正在进行的执行。
- 自动化来源的会话在“已归档”中可见。恢复后保留归档前的收藏与置顶状态。
- 现有“工作区归档”是项目级功能，视觉及语义需与会话归档清晰区分。

## 源码所有权与既有交互基线

- `GlobalSidebar` 是左侧全局导航与会话列表的所有者；默认窄窗口会强制收为 rail（`AUTO_RAIL_QUERY` 为 1080px），需从 rail/flyout 仍能找到归档入口和列表。
- 会话资源菜单由共享组件 `SessionContextMenu` 持有，已有复制 ID、重命名、置顶、收藏、标签、统计、删除动作。若归档入口置于该菜单，应覆盖所有复用入口且不破坏菜单顺序、Escape、外部点击、子菜单和焦点返回行为。
- 会话元数据响应通过 task-center store 的 `beginSessionMetadataMutation` / `applySessionMetadata` 做请求序列隔离和 canonical session 更新。归档/恢复应走同一状态同步路径；过期响应不能覆盖更新状态。
- 侧栏偏好当前为 `GlobalSidebarPreferenceV1`，持久化 session view (`all`/`favorites`)。新视图需兼容旧版本地偏好，损坏/未知偏好应安全回退；“已归档”视图可以记忆或不记忆，但不能让旧偏好失效。

## 验收矩阵

| 场景 | 通过标准 |
|---|---|
| 归档入口 | 普通会话菜单有可辨识的“归档”动作；已归档会话菜单可执行“恢复”。收藏、置顶仍可从列表/菜单触达。 |
| 持久化与同步 | 成功 PATCH 后列表立即一致；切换工作区/刷新或重开后状态仍一致。并发或较旧列表响应不会把状态回滚。 |
| 归档期间执行 | 归档运行中的会话后，执行持续；再次打开能进入同一 session，消息记录仍在。 |
| 列表分区 | all/favorites 排除 archived；archived 只含 archived。自动化来源会话也进入 archived；未归档自动化是否出现在 all 继续服从现有自动化显示偏好。 |
| 恢复 | 从 archived 恢复后退出 archived 列表并进入适用的默认/收藏视图；favorite、pinnedAt 均保持原值。 |
| 失败/重复请求 | PATCH 返回空、失败或超时不造成假成功；给出失败反馈且列表状态与服务端已知状态一致。快速重复点击不会产生反向乱序或重复 toast。再次尝试可成功。 |
| 键盘与焦点 | 菜单项可 Tab/Enter/Space 操作；Escape 关闭菜单；操作后焦点落回触发菜单的按钮或符合现有 layer 管理约定。 |
| 窄窗/rail | 在 `<=1080px` 的强制 rail 下能打开 flyout、切换 archived/all、打开和恢复会话；关闭/切换后无残留遮罩或失焦陷阱。 |
| 工作区归档区分 | 项目归档区和 session archived 列表标签、图标/层级及操作对象明确，不会误把项目归档为会话归档。 |
| 内容保全 | 对同一个 session ID 核对消息/附件/工作区文件引用在归档及恢复前后仍可读取；无删除接口调用。 |

## 实际 UI 验收记录模板

候选冻结版本/commit：
运行入口及版本来源：
窗口宽度（至少 expanded 与 <=1080px rail）：
测试 session（普通/收藏置顶/自动化/正在执行）：
归档后 PATCH 与列表状态：
归档期间执行是否继续：
刷新/重开后的状态：
恢复及收藏/置顶保留：
键盘/焦点结果：
消息、附件、文件引用保全证据：
失败/重复请求结果：
未能验证项及原因：

## 审阅边界

此合同不代表代码、测试或应用已验收。实现冻结并提供可运行入口后，非实现者应对真实交互做实际 UI 验收；仅静态截图或组件测试不能替代交互和状态持久化证据。

## 2026-10-13 冻结候选静态审查（待实际 UI 验收）

候选目录：`/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-chat-task-archive-delivery`
审查基线：HEAD `2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a`，当前工作树包含未提交候选修改。仅只读审查 diff；没有运行/修改代码。

### 发现

1. **P1：已归档工作区内的会话无法从新归档视图访问。** `WorkspaceTree` 的 `sessionsByWorkspace` 会收集全局 session 数据，但渲染会话分支只发生在活动 `projects.map(...)` 的 `WorkspaceRow` 中。`archivedProjects` 使用独立 `ArchivedWorkspaceRow`，不渲染其 session 分支。因此会话所属 Project 已归档时，即便 `archived: true` 也没有入口可打开/恢复。建议在 archived session view 中同时为 archivedProjects 渲染对应 session 分支，或使用独立的归档会话分组，不要改变项目本身的归档状态。

2. **P2：过期 PATCH 响应可能给出假成功提示。** `onSessionUpdated(updated, sequence)` 返回 `false` 时代表 store 的 mutation sequence 已被更新操作超越，但 `toggleArchive` 忽略返回值，仍关闭菜单、触发焦点回调并 toast “已归档/已恢复”。这是共享 `SessionContextMenu` 上的可见反馈错误；跨菜单/搜索视图并发更新时，响应被丢弃但界面仍宣称成功。建议遇到 false 时不确认成功并刷新该 session 的 canonical 元数据，或让 archive action 有可判定的一致成功语义；覆盖交叉 PATCH 延迟/乱序用例。

3. **P2：窄窗/菜单焦点仍需真实交互验收。** 当前 archive 成功先调用 `onClose`，其上层会 focus 会话行的 more 按钮；随后 `onArchiveChanged` focus `viewMenuRef`。该焦点目标在 archived 工作区缺少对应 session branch 的场景本来也不可达；其余场景需确认列表过滤导致 SessionRow 卸载后焦点仍稳定落在视图选项入口，键盘 Enter/Escape 与 rail flyout 一致。

### 静态检查通过的部分

- `SessionMetadata`、PATCH API、server route 和 store 已加入 archived 字段；仅 `true` 持久化，false 清除；该字段未触发 recency 更新。
- 归档筛选在活动工作区会话集合中排除默认/收藏视图里的 archived 项；archived 视图绕过自动化来源隐藏逻辑，符合自动化会话可恢复目标。
- 视图偏好解析接受 `all`、`favorites`、`archived`，旧 V1 偏好和未知值仍回退 `all`。
- SessionContextMenu 使用 mutation sequence 提交 canonical metadata；网络失败会 toast 错误，组件内同步请求有 pending guard。服务端路径把 PATCH 视为组织元数据而不刷新 lastActiveAt。

### 旧版应用视觉基线（非候选验收）

`/Applications/MoXBots.app` 当前显示 AgentNet 网络选择浮层，页面同时显示“系统凭据需要一次授权。后台恢复已停止，不会反复请求密码。”本次只读取 AX 与截图，没有选择网络、恢复授权或修改用户数据/应用设置。旧版界面不含本次归档控件，不能作为候选交互证据。

### 实际候选 UI 状态

待主 Agent 提供已构建的候选版本、可控合成聊天路径，并串行交接原生窗口。候选归档/恢复、刷新持久化、窄窗键盘焦点和内容保全尚未进行实际 UI 验收。

## 2026-10-13 第二次静态复审：`59037d91cf130caf9a91fafb346e5b305d9b2883`

复审结论：前述两项代码问题已按预期修正，静态复审通过；候选原生 App 仍待重新打包交接，尚未进行产品交互验收。

- **已归档工作区会话可达：** archived session view 下 `expandedWorkspacePaths` 取所有 `sortedProjects`（含已归档工作区），会话分支同时渲染 active 与 archived projects；其它视图仍只查询活动工作区。偏好修剪也基于完整可见 `sortedProjects`，所以只要项目仍存在于该集合，就会保留展开路径。工作区恢复菜单在归档视图可用，已归档工作区不显示“新建聊天”动作。恢复单条会话走 `updateSession(archived:false)`，不会调用 project patch/restore。新增测试覆盖“已归档工作区中恢复会话但不恢复工作区”及无活动工作区可达。
- **过期元数据响应反馈：** 当 `onSessionUpdated` 返回 false，菜单现在请求刷新会话状态并提示“归档状态正在刷新”，不会提示归档/恢复成功。HistorySearchOverlay 同时刷新 task-center 与 search provider；侧栏使用 task-center refresh。新增测试覆盖该分支。
- **边界说明：** 扩展归档查询依赖用户展开工作区行，符合当前树形列表加载方式；提交新增测试检查状态与焦点，但实际窄窗、键盘操作和安装包表现仍需 UI 验收。`sortedProjects` 是当前可见/可用 workspace 集合；因权限隐藏的既存 workspace 路径是否应继续保留偏好，单靠此 diff 无法证明，当前修正保证包含可见的 archived workspaces。

当前交付工作树 HEAD 为 `59037d91cf130caf9a91fafb346e5b305d9b2883`；我只查看了 commit diff 与关联代码，没有运行测试或修改产品源码。旧版 App 视觉基线记录见上节。

## 2026-10-13 隔离 UI 实测尝试与环境阻断

主 Agent 交接的隔离 UI 地址为 `http://127.0.0.1:5199/`，对应正式源码 `59037d91` 与独立 fixture home。尝试用 CUA 创建本任务自己的 IAB tab 时返回 `Browser is not available: iab`；枚举仅见用户 Chrome/Brave 扩展浏览器，不能用于本次验收。`mcpapps` browser 也不可用。请求用 Codex panel 打开该地址只返回 `queued`，没有可绑定的页面；CUA 读取 ChatGPT/Codex 原生 App 被平台拒绝（`Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons`）。

因此没有进行任何归档/恢复写操作，没有碰正式 App、用户 Chrome、用户数据或 fixture 数据。该轮 UI 验收阻断在“无法获得隔离 IAB”，不是产品测试失败。待提供本任务可用的内置浏览器实例/授权的独立窗口后，按主 Agent 流程完成：恢复活动聊天并检查 all/favorites 的收藏/置顶；归档、刷新持久化、恢复；恢复归档工作区中的聊天并核对 Project 未变；<=1080 rail/flyout 与键盘焦点/Escape。

主 Agent 随后提供已知 IAB `browserId=4, tabId=1` 并明确允许只绑定尝试一次；本 worker 的 `cua.getTab('1', { browser: '4' })` 返回 `Browser is not available: 4`。按交接要求停止，未尝试其它浏览器或新增窗口。UI 由主 Agent 验收；本报告仍不声称独立 UI 验收。

## 2026-10-13 原生候选 UI 非实现者验收

运行实例由主 Agent 交接：`/Applications/MoXBots.app`，运行构建 `33992eb0`（主 Agent 核对 app binary/server bundle 与冻结制品一致；归档实现源码为 `59037d91`，包含已接受的既有 Host/凭据基线）。本次仅操作合成 session `fabc32af-6f06-4c5e-b3a5-329282d78a97`，标题“归档功能验收（合成聊天）”。未发消息、未调用模型/执行任务、未操作授权流程。

实际交互结果：

- 初始视图是“全部会话”，指定合成聊天出现且保留星标与“已置顶”标记。会话菜单显示“归档对话”。
- 执行归档后显示“对话已归档”toast；切换全部会话及只看收藏时该聊天均不可见；归档动作后焦点落在“工作区与会话显示选项”。
- “已归档会话”显示该聊天并保留“已置顶”标记。打开聊天可读取两段合成消息和 `archive-acceptance-file.txt` 附件卡片（0 B）；消息明确标注未调用模型，附件文案说明归档/恢复后应保留。没有编辑或删除消息/附件。
- 从归档列表执行恢复后显示“对话已恢复”toast，聊天退出归档视图；焦点回到“工作区与会话显示选项”。随后全部与收藏视图均显示该聊天，收藏星标及置顶标记仍在。
- 再次归档后显示成功 toast，并留在归档状态供主 Agent 关闭重开后做持久化复验。**本 worker 没有关闭或重启 App，也没有声称完成重启持久化验收。**
- 窗口临时缩窄到约 950 CSS px 后进入折叠 rail；展开 Agent 工作区 flyout，在视图菜单切至归档后聊天可见。用 Escape 关闭视图菜单，焦点环回到视图选项按钮；打开聊天行操作菜单显示“恢复对话”，用 Escape 关闭后 AX focus 回到该行的“更多”按钮。随后已把窗口宽度恢复至原尺寸。
- 只读打开既有 AgentNet 页面后，页面显示“系统凭据需要一次授权。后台恢复已停止，不会反复请求密码。”未打开网络选择器或点击授权/恢复；未发现本次验收触发额外授权恢复。

该验收是原生 App、真实渲染界面与隔离合成 session/SessionStore 的交互联调证据；不是正式账号、模型执行、真实聊天数据或生产环境验收。安装包构建来自 `33992eb0`，不能表述为归档实现源码 `59037d91` 的字节级构建；重启后的持久化复验由主 Agent 后续执行。本报告未保存截图，因为可见截图同时包含 Mino 项目文件树与用户主目录路径；未能在不携带这些额外内容的条件下生成合适证据图。
