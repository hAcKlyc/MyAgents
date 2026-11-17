# Claude Plugin 加载架构

> 本文描述 Claude Plugin 的安装、启用和 Runtime projection。MyAgents 拥有插件目录与启用状态；Builtin Runtime 把本地插件目录交给 Claude Agent SDK，Managed Codex 与 Integrated DSH 通过共享 Product Extension discovery 向各自原生协议转换可表达的组件。

## 系统边界

Claude Plugin 与 OpenClaw Plugin 是两套独立体系：

| 体系 | 用途 | CLI / API | Owner |
|------|------|-----------|-------|
| Claude Plugin | Claude 协议的 Skills、Commands、Agents、MCP、Hooks 等组件 | `myagents cc-plugin *`、`/api/cc-plugin/*` | Node Plugin Store + AppConfig |
| OpenClaw Plugin | Agent Channel 的第三方渠道适配器 | `myagents plugin *`、Rust `/api/plugin/*` | Rust Plugin Bridge lifecycle |

Builtin Runtime 不解析 Plugin 内部组件，也不复制 SDK 的 manifest、hook 或 MCP 语义。MyAgents 只校验受控安装目录并向 SDK 传递 `{ type: 'local', path }`。Managed Codex 与 Integrated DSH 是显式 projection 路径：各自的 Product Extension compiler 从可信安装目录读取组件，并逐项报告 converted、unsupported 或 conflict。

## Owner 与启用模型

安装清单和全局可见性位于 `config.json`：

- `AppConfig.plugins`：已安装插件及其目录元数据；
- `AppConfig.enabledPlugins`：全局可见性 gate；关闭后任何工作区都不能启用；
- `AppConfig.pluginConfigs`：插件级配置。

实际参与某个工作区或 Session 的插件由第二层状态决定：

- `Agent.enabledPluginIds` 优先，缺失时使用 `Project.enabledPluginIds`；
- Chat 内修改通过 `/api/cc-plugin/session-enable` 进入 `SessionEngine.updateEnabledPluginIds()`，成为当前 Product Session 的配置；
- Plugin Store 与 Session enabled-id snapshot 是 authority，SDK initialization result 只是某次 Runtime generation 的诊断快照。

内置 CLI 的 `cc-plugin install` 安装插件并打开其全局开关，`cc-plugin enable/disable` 管理全局可用性。用 `cc-plugin list` 查看完整插件 ID，用 `agent show <agentId>` 查看 Agent 当前选择。以下命令替换该 Agent 的完整插件名单，`'[]'` 清空名单。

```sh
myagents agent set <agentId> enabledPluginIds '["my-plugin@local"]'
```

这条命令通过 Agent 配置写入路径保存未来 Session 的默认选择并同步关联的 Project。已有配置快照的 Session 继续使用快照中的选择。全局关闭的插件仍可保留在默认名单里。

所有 AppConfig 修改必须经过 `withConfigLock`。写入路径在锁内重读并合并磁盘状态，不能用 Renderer 的旧副本覆盖其它 writer。

## 模块布局

```text
src/server/plugins/
├── url-resolver.ts   source URL / owner-repo / zip / file 解析
├── fetcher.ts        拉取并生成受限 ExtractedTree
├── manifest.ts       plugin.json 与展示用组件清单
├── installer.ts      plugin / multi-plugin / marketplace 探测与写盘准备
└── store.ts          inspect、install、uninstall、toggle、list 与配置锁

src/shared/types/plugin.ts
src/server/runtimes/managed-codex/extensions/
```

## 探测与安装

Renderer 先调用 `POST /api/cc-plugin/inspect`。`inspectPluginSource()` 只解析和拉取，不写磁盘，返回以下形态之一：

| mode | 当前行为 |
|------|----------|
| `plugin` | 直接进入单插件安装 |
| `multi-plugin` | 展示候选项；用户选择后逐个带 `subPath` 安装 |
| `marketplace` | 识别 marketplace，但不直接安装 marketplace 仓库；要求提供单插件子目录 |
| `no-plugin` | 返回可展示的校验错误 |

批量安装由 Renderer 串行调用 `POST /api/cc-plugin/install`。每次安装都重新解析 source 与 `subPath`，然后执行：

```text
resolvePluginUrl
  → fetchPluginTree
  → analysePluginTree
  → 校验 manifest 与目标名称
  → 清理目标位置的 broken symlink
  → 受限写入 staging / install directory
  → withConfigLock 发布 PluginEntry 与 enabledPlugins
```

安装不得依赖用户系统 Node。远端获取复用公共 URL/SSRF policy，归档展开复用受限树与 zip-slip 防护；安装提交负责 broken-symlink 清理、staging 校验与锁内 rename/config 发布。`lstat + realpath` canonical 校验发生在向 SDK、Managed Codex 或 DSH 投影前：目录若在安装后被 symlink swap，必须拒绝执行，而不是把它交给 Runtime。插件最终位于：

```text
~/.myagents/
├── config.json
└── plugins/
    ├── <plugin-name>/
    │   ├── .claude-plugin/plugin.json
    │   ├── skills/
    │   ├── agents/
    │   ├── commands/
    │   ├── .mcp.json
    │   └── hooks/
    └── data/<sanitized-id>/
```

Plugin 以当前用户权限执行。安装 UI 必须明确提示它可以运行代码、启动 MCP 进程或触发 hook；Plugin data 不因普通卸载自动获得超出当前 API 定义的清理语义。

## Runtime projection

### Builtin Runtime

`agent-session.ts` 构建 Query options 时确定 enabled ids：当前 Session 已有 snapshot 就使用 snapshot，否则由 `getDefaultEnabledPluginIdsForWorkspace()` 从 Agent/Project 读取默认值。`getEnabledPluginSdkConfigs()` 再同时应用全局可见性 gate，并对安装目录做 canonical path 校验，最后把本地配置传给 `Options.plugins`。Query 使用 `pluginDelivery: initialize`，由 SDK 初始化消息传递插件路径，避免多插件或长路径触发 Windows 命令行长度限制。

Plugin 变更不能原地修改正在运行的 SDK Query。Builtin adapter 在安全边界 restart/pre-warm，让下一代 Query 读取新的插件集合；正在执行的 turn 先按既有 deferred-restart 协议结算。

### Managed Codex

`runtime='codex' + runtimeSource='managed-provider'` 消费 Managed Codex Extension compiler。compiler 从 enabled Plugin 的 canonical 安装目录读取：

- Skills、Commands、Agents 按 project > user > plugin 的优先级合并；
- MCP 按 server id 独立合并并报告冲突；
- manifest 的可信相对路径只能落在该 Plugin 目录内；
- Hooks、LSP、monitors、bin、SSE MCP 和不能忠实映射的 Agent 字段按组件报告 unsupported；
- 单个组件失败不能冒充整包成功，也不能阻断其它可转换组件。

其它 `system-cli` Runtime 不消费 MyAgents-owned Claude Plugin projection。

### Integrated DSH

DSH 与 Managed Codex 共用 Product capability inventory、Plugin 组件 discovery 与 Host dispatcher，由 `integrated-runtimes/dsh/extension-compiler.ts` 输出原生声明。当前可用投影包括 Skills、Commands、MCP 和 Host tools。Host 会生成 Agent descriptor，但当前 DSH 尚无角色编译器，对应组件返回 `unsupported`；Plugin Hooks/LSP 等不可表达组件也保留逐项诊断，不能假装已经应用。原生 replacement 与 catalog/read-back 决定实际可用状态，Host 不重建 DSH 工具或子 Agent loop。详细边界见 [DSH 集成指南](myagents_dsh_integrated_runtime.md#6-prompt-与扩展)。

## Slash Command projection

Chat 的 slash menu 合并两类快照：

1. 工作区/用户静态 commands 与 skills。Launcher 由 Rust `cmd_list_slash_commands` 扫描；Chat 使用 `/api/project-capabilities` 的 enabled snapshot。
2. Builtin SDK 的 `initializationResult().commands` 与 `commands_changed.commands`。Sidecar 通过 `chat:slash-commands` 发布全量替换快照；空数组同样有效。

SDK 0.3.277 起同名 command 可能同时返回内置与插件/项目来源。Sidecar 按 SDK 的 `builtin` 标记保留内置项，让菜单描述与输入 `/name` 后真正执行的命令一致；别名仍按 SDK 自身解析，不参与同名优先级判断。

本地静态命令优先，SDK 只补充同名项之外的命令，不能覆盖 Renderer client action 或本地自定义命令。Renderer 不扫描 Plugin 安装目录重建 SDK 语义。Managed Codex 由 compiler 在 turn admission 时展开 Plugin Command，不消费这条 SSE。

`pending-* → UUID` 的 Session birth upgrade 只有在内部 state 已采纳真实 id、父级 prop 只是补同步时才能保留对应 SDK command snapshot。真实 target replacement、reset 或切换 external Runtime 必须清空旧 snapshot；普通历史导航不能伪装成 birth upgrade。

## 事件与失效

| Event | 语义 |
|-------|------|
| `plugin:install-progress` | 单次安装的有界阶段与短错误摘要 |
| `plugins:changed` | install、uninstall、global toggle 或 workspace enable 后的失效信号 |
| `chat:slash-commands` | 当前 Builtin Runtime 的 slash-command 全量快照 |

这些事件必须同时登记在 Node SSE priority 和 Renderer JSON event allowlist。`plugins:changed` 只触发权威配置重读，不能携带一份新的 AppConfig 作为第二个状态源。

## 不变量

- `/api/plugin/*` 只属于 OpenClaw；Claude Plugin 端点全部使用 `/api/cc-plugin/*`。
- Plugin Store 决定安装与启用状态；SDK `system/init.plugins` 不回写 Store。
- 所有安装源先经过 SSRF、归档路径和大小限制；目标目录必须防 broken symlink 与 symlink swap。
- Session 配置变化通过 SessionEngine adapter 生效，route handler 不自行分支 Runtime。
- 新 SSE 事件必须同时注册 producer priority 与 Renderer allowlist。
- 不支持的 marketplace、project-scope settings、userConfig、升级或 source 类型应返回明确的当前能力错误，不写半成品目录或隐式采用 Claude Code 用户配置。
