---
name: myagents-cli
description: >-
  你正在 MyAgents 这款 AI 产品里运行——MyAgents 自带一套"产品能力"（定时任务、任务中心、记录收集、MCP 工具接入、
  模型 Provider、IM Bot 渠道、社区插件、Skills 安装、协作空间、Agent 网络与 Session 协作、Generative UI Widget、Goal 目标模式等），通过内置 `myagents` CLI 操作。
  当用户的需求**落在 MyAgents 产品能力的射程内**，就加载并使用这个 skill，用 CLI 主动帮用户把事情做掉，
  而不是让用户去 GUI 点击。
  典型触发场景：用户说"每天 X 点帮我 Y / 等 X 发生后继续 / 持续盯着，命中才处理"（→ myagents-task-automation）、"记一下这个想法"（→ record）、"派发成任务"（→ task）、
  "接个 X 工具进来"（→ mcp）、"配 X 模型/Provider"（→ model）、"在飞书/钉钉/Telegram 里跟我聊"（→ agent channel）、
  "装个 X 插件 / 装个 X skill"（→ plugin / skill）、"处理 Space Issue / 下载附件 / 回复 Issue"（→ space）、
  "把图发到 IM 里"（→ im send-media）、"用已配置的读图模型理解图片"（→ vision analyze）、"持续执行直到目标完成"（→ goal）、
  "做个图表/仪表盘"
  （→ widget readme）、"看下我有啥任务/定时/Runtime/版本"（→ list / status / version）、"改下应用设置"（→ config）。
  即使用户没说"用 MyAgents 做"几个字，只要意图能映射到上述能力之一，就该走这个 skill。
  反向边界：纯业务任务（立即写代码、查资料、读文件）不归这里；只有需要操作 MyAgents 产品状态或未来自动化时才使用本 Skill。
metadata:
  author: MyAgents
---

# myagents-cli — MyAgents 产品能力的 CLI 入口

MyAgents 是带状态的 Agent 平台：Goal、Task、Record、IM Bot、MCP、Provider、插件、Skill、协作空间、Agent 网络与 Session 协作、Widget。CLI 负责产品操作；使用知识与功能边界查 `/myagents-docs`，登录、入网和开放 Agent 等没有 CLI 写入口的操作使用产品 UI。

**这个 skill 不只是"管理工具"，它是 MyAgents 产品能力的执行入口**。用户表达的需求只要能映射到产品能力，就该用 CLI 主动帮用户做掉，而不是给用户一堆操作步骤让他自己去 Settings 点。这份文档列出全部能力以及"什么时候应该用哪条命令"。

## 前置：CLI 是否可用

CLI 通过 `~/.myagents/bin/myagents` 暴露，App 内 Agent 的 PATH 和调用上下文由产品注入，直接运行命令。它通过 Sidecar Admin API 操作（端口由 `MYAGENTS_PORT` 注入）。外部终端或 AI 需用户在「设置 → 外部调用」主动开启并取得受保护的 `MYAGENTS_API_TOKEN`，只允许公开命令；不要读取内部凭据来绕过授权，也不要输出 token。

- 遇到 `command not found`：让用户重启一次应用触发 CLI 同步
- 遇到 `ECONNREFUSED`：Sidecar 没起来，让用户检查应用是否在运行

## 使用模式

1. **探索先行**：不熟的命令组用 `myagents <group> --help`；不知道某个 runtime 支持什么 model/permissionMode 用 `myagents runtime describe <runtime>`，**不要靠猜**
2. **按 leaf 契约预览**：只有精确 leaf help 明确声明支持的命令才使用 `--dry-run`；不支持的 mutation 会 fail closed，不能声称已预览
3. **机器可读**：加 `--json` 解析结构化输出
4. **按失败阶段恢复**：读取错误 code 与恢复提示；只读查询可重试。写入、发送工作或接纳未知时，先查询真实状态，不能盲目重复执行。

## 安全规范

- **改配置前先读精确 leaf help**——该 leaf 明确支持 `--dry-run` 时先预览；未声明支持时不要假装存在 preview
- **API Key**：用户在对话里明确给了你才写入；没给就引导他去 **设置 → 对应页面** 填，不要追问
- **明确对象与影响**：删除/覆盖等操作应有具体对象与授权；用户已经明确授权时不重复确认。对象含混、超出授权或会中断未说明的活跃工作时，先澄清。

## 生效时机

- 配置写入与当前 Session 实际生效是不同事实。Agent 默认值不改写已有 Session identity；Provider、权限、MCP、Skill 与 Plugin 由对应 Runtime 在自己的边界应用。
- builtin MCP/扩展通常在后续对话边界更新；DSH 与 Managed Codex 按支持的 extension admission 更新，不能承诺全部 Plugin 组件通用。查看 `status`、`skill list --verbose` 与实际工具状态，再说明下轮、新 Session 或重启要求。
- `reload` 请求产品重新读取配置，不能保证当前执行轮立即更换工具，也不能把另一 Session 的状态当验证。

---

## 命令速查 + 何时使用

### AnyDoc 本地文档转换

MyAgents 内置 AnyDoc 本地文档转 Markdown/OCR 能力。先运行 `myagents anydoc --help`；需要详细使用说明时加载 `/myagents-anydoc`。

### 本地附件语音识别

MyAgents 能把当前 Workspace 内的单个本地音频或视频附件提交给 App-owned 离线异步转写任务。先运行 `myagents speech --help`；需要完整 Session 隔离、输入格式与任务生命周期说明时加载 `/myagents-speech-recognition`。Session 与 Workspace 由产品自动绑定，不自行传参。

### MCP 工具（mcp）

网页任务优先使用内置 `myagents-browser`，不要重复 `mcp add`。先安装产品设置中的浏览器资源，再按所需 scope 启用。完整页面操作方法见 `/moxbots-browser`；正式 MoXBots 构建使用 `moxbot` 命令名。`mcp test myagents-browser` 只检查当前 Product Session 的 Host capability，实际网页操作仍需当前 Runtime 的工具清单与调用结果验证。

```bash
myagents mcp list                                       # 看用户配了哪些 MCP
myagents mcp show <id>                                  # 看某个 MCP 的完整配置（command/args/env/headers）
myagents mcp add --id <id> --type <stdio|sse|http> ...  # 新增
myagents mcp remove <id>                                # 删除
myagents mcp enable <id> --scope <global|project|both>  # 启用
myagents mcp disable <id> --scope <global|project|both> # 禁用
myagents mcp test <id>                                  # 实际握手测试连通性
myagents mcp env <id> set KEY=val [KEY2=val2 ...]       # 设环境变量（覆盖）
myagents mcp env <id> get [KEY ...]                     # 读环境变量
myagents mcp env <id> delete KEY [KEY2 ...]             # 删环境变量
myagents mcp oauth discover <id>                        # 探测 MCP server 是否支持 OAuth + 拿到 metadata
myagents mcp oauth start <id> [--clientId X --clientSecret Y --scopes "..." --callbackPort N]
                                                        # 启动 OAuth 授权流程（会打开浏览器）
myagents mcp oauth status <id>                          # 看授权状态（已授权 / token 是否过期）
myagents mcp oauth revoke <id>                          # 撤销授权
```

**何时用：**
- "帮我接个 X 工具" → `mcp add` → `mcp enable --scope both` → `mcp test`
- "看下 playwright 配的啥" → `mcp show playwright`
- "Notion MCP 怎么登录" → `mcp oauth discover` 看支持的 scopes，再 `mcp oauth start`
- "X 工具用不了，是不是登录过期了" → `mcp oauth status <id>`，过期就重跑 `oauth start`
- "给 fetch 加个 API Key 环境变量" → `mcp env fetch set FETCH_API_KEY=sk-xxx`

### CLI 工具注册表（tool） — PRD 0.2.36，实验室开启后可用

这是实验功能，默认关闭。使用前先运行 `myagents tool --help`：

- 如果 help 提示去「设置 → 关于&反馈 → 实验室 → CLI 工具注册表」开启，说明当前会话不能创建、注册或管理用户 CLI 工具；不要继续尝试 `tool-creator` / `myagents tool add`，转而完成一次性任务或请用户打开实验开关。
- 如果 help 返回完整 `list/add/remove/env` 用法，才按下面流程处理。

注册的 CLI 工具会投 shim 到 `~/.myagents/bin/`（全 runtime + 终端的 PATH 上），
description 自动注入所有新 session 的上下文——未来的 AI 会自己发现并使用它。
**写一个新工具**用 `tool-creator` skill（钉死 Agent-CLI 契约：非交互 / 退出码 /
--json / readme 子命令 / ≤800 字 description）；这里只管注册与管理。

```bash
myagents tool list                       # 注册表总览（含 enabled 状态 + 缺失 env key）
myagents tool add <dir>                  # 注册（dir 须含 tool.json + 入口脚本；不在
                                         #  ~/.myagents/tools/ 下会自动拷入）[--dry-run]
myagents tool info <name>                # 看 manifest + enabled + 缺失 env
myagents tool enable <name>              # 进新 session 的上下文
myagents tool disable <name>             # 从上下文隐藏（shim 仍在 PATH，可手动调）
myagents tool remove <name> [--purge]    # 反注册（--purge 连工具目录一起删）
myagents tool env <name> set KEY=val     # 设 per-tool 环境变量（API key；工具启动时读）
myagents tool env <name> get             # 读（值已脱敏）
myagents tool env <name> delete KEY      # 删
```

**何时用：**
- 用户说"把这个脚本/能力注册成工具、以后直接用" → 先走 `tool-creator` skill 把它规范化，再 `tool add`
- "我有哪些自己的工具" → `tool list`
- 工具报缺 API key（退出码 3）→ `tool env <name> set KEY=<用户提供的值>`
- 注册名撞系统命令会被打回（`~/.myagents/bin` 在 PATH 前列，重名会遮蔽系统命令）→ 换带领域前缀的名字
- 注册成功后 MUST 在回复中告知用户：工具名 + 干什么 + 可在 设置 → 工具箱 管理

### 官方图片理解工具（vision）

这是 MyAgents 内置官方 CLI 工具，不属于 MCP，也不属于用户注册 `tool` 实验功能。它用于在当前会话启用“图片理解”工具时，让不支持多模态的主模型把本地工作区图片交给用户在「设置 → 工具箱」里配置好的读图模型分析。

```bash
myagents vision readme
myagents vision analyze --image <path> [--image <path> ...] [--prompt "what to inspect"]
myagents vision analyze --image <path> --prompt-file <workspace-relative-text-file>
myagents vision analyze --image @myagents_files/screenshot.png --prompt "Extract the error text and UI state"
```

**约束：**
- 只接受当前 MyAgents 工作区内的本地图片路径；不要传 URL。
- `--prompt` 是短指令；长/多行/含引号的检查指令写进当前 workspace 内的文本文件，再用 `--prompt-file`。
- `--prompt-file` 路径也按当前 workspace 安全解析；不要传 URL、symlink 或 workspace 外路径。
- 如果报“not enabled / not configured”，让用户在「设置 → 工具箱」启用图片理解并选择支持图片输入的模型。

**何时用：**
- 当前主模型不支持图片，但会话里出现截图 / 图片附件，并且系统提示里说明 vision 工具可用。
- 用户要求“看这张图 / 截图里写了什么 / 读一下错误信息”，先 `vision analyze` 拿文字观察，再基于观察继续回答。

### 模型 Provider（model）

```bash
myagents model list                                     # 看所有 Provider、验证状态、主模型与模型清单
myagents model add --id <id> --name <显示名> --base-url <url> --models <m1,m2,...> [其它]
myagents model remove <id>                              # 删除自定义 Provider（内置的删不掉）
myagents model set-key <id> <apiKey>                    # 设 API Key
myagents model set-default <id>                         # 设为默认 Provider
myagents model verify <id> [--model <某个具体模型>]      # 实际发一条测试消息验证
```

**何时用：**
- "帮我配 DeepSeek" → 内置 Provider 直接 `model set-key deepseek <key>` → `model verify`
- "我要用一个新厂商" → 详见下方 §配置模型服务流程
- "把默认改成智谱" → `model set-default zhipu`
- "我之前加的那个废 Provider 删了吧" → `model remove <id>`

### Agent + Channel（agent）

```bash
myagents agent list                                     # 发现本机和同账号在线设备的可调用 Agent
myagents agent create --workspacePath /absolute/path    # 把既有目录幂等注册成 Project-backed Agent
myagents agent current --json                          # 只看当前 Agent/workspace/Session
myagents agent list --active                            # 只列出未归档 Agent 工作区
myagents agent list --archived                          # 只列出已归档 Agent 工作区
myagents agent show <id>                                # 看某 Agent 的 effective 默认（runtime/model/permissionMode）
myagents agent enable <id>                              # 启用本机 Agent 主动能力，非网络开放或 Channel 开关
myagents agent disable <id>                             # 暂停主动能力，不关闭显式 Session 协作
myagents agent archive <id>                             # 归档 Agent 工作区，并暂停 proactive Channel
myagents agent unarchive <id>                           # 取消归档；若归档前是 proactive，会恢复启用
myagents agent set <id> <key> <value>                   # 改本机单个字段；合法 JSON 会解析，否则保留字符串
                                                        # key 仅限 enabled/runtime/runtimeConfig/providerId/model/permissionMode
                                                        # id / channels 用专用命令；未知 key 会在写盘前拒绝
myagents agent channel list <agentId>                   # 列出某 Agent 的所有 Channel
myagents agent channel add <agentId> --type <平台> --<凭证flag> ...
                                                        # 添加 Channel（telegram / feishu / dingtalk / openclaw:xxx；先查 help）
myagents agent channel remove <agentId> <channelId>     # 删除 Channel
myagents agent runtime-status                           # 看本机 Channel 运行状态，非 Agent 网络在线状态
```

**何时用：**
- "我那个 Agent 现在啥配置" → `agent show <id>`，按 runtime 正确解析过 effective 值
- "把这个本地目录注册成 Agent 工作区" → `agent create --workspacePath <绝对且已存在的目录>`；不创建目录，不初始化 Git/模板
- "把 Agent X 的 model 改成 Y" → `agent set X model '"Y"'`（注意 JSON 字符串要双层引号）
- "把 permissionMode 改成 plan" → `agent set X permissionMode '"plan"'`
- "项目结束了，先收起来" → `agent archive <id>`；需要恢复时用 `agent unarchive <id>`
- "飞书 Bot 在线吗" → `agent runtime-status`；`agent list` 的网络发现不证明 Channel 在线
- 配 Channel 详见下方 §配置 Agent Channel 流程

`agent show` 读 Agent 的执行默认，`agent set` 写本机单个字段。只使用 canonical key；`provider` / `permission` 不是 alias，分别用 `providerId` / `permissionMode`。Provider/model/permission 会校验后同步 Project 镜像和运行中的 Channel；已有 Session 仍由自己的生命周期管理。权限值先查 `runtime describe` 和 leaf help，不复用旧 Codex 模式映射。复杂 Channel 改动走 `agent channel`；这些写命令不管理远端 Agent。

### Agent Runtime 发现（runtime）

```bash
myagents runtime list                                   # builtin/dsh/claude-code/codex 的装机情况 + 版本
myagents runtime list --json                            # 机读：installed/version/path
myagents runtime describe <runtime>                     # 某 runtime 的 model 清单 + permissionMode 枚举
myagents runtime diagnose codex [--workspacePath PATH]  # Codex 的 auth/features/MCP/apps/effective-env 快照（issue #194）
myagents diagnose runtime codex                         # 同上的 sugar 写法
myagents diagnose runtime dsh                           # 资源校验、当前进程/模型/权限/代理/扩展，不启动新 Session
```

**何时用：**
- 在跑 `task create-direct --runtime X --model Y --permissionMode Z` **之前**先 `runtime describe X` 把合法值查清楚——`--help` 只列 flag，值靠这俩命令现场查，不会因为文档漂移而错
- "我装了哪些 Agent CLI" → `runtime list`
- 用户问"codex 支持什么 model" → `runtime describe codex`
- 「@oai/artifact-tool 我从终端能调用、MyAgents 里就不行」/「Codex MCP 在 MyAgents 里看不到」/「Codex 是不是用错代理了」→ `runtime diagnose codex`。它 spawn 一个临时 codex app-server，跑 `getAuthStatus` / `experimentalFeature/list` / `mcpServerStatus/list` / `app/list` 四个 RPC，把 Codex 自己看到的状态原样吐出来，省得猜。effectiveEnv 节里能看到 MyAgents 注入的代理是不是真到了子进程，feature flag 是不是真生效。

每个 Runtime 有自己的 model 清单、权限模式和计划状态。DSH 模型目录查 `model list`；Codex 模型通过当前 Runtime 查询。不要把旧 CLI 名称、产品权限与 Runtime 原生策略混用；Codex system-cli probe 不能代替 `codex-sub` 的 Managed Codex 诊断。

### Skills（skill）

```bash
myagents skill list [--verbose]                          # 已装 skill（全局 + 项目级）
myagents skill info <name>                              # 某 skill 的详情
myagents skill add <source> [--scope user|project] [--plugin X] [--skill Y] [--force] [--dry-run]
myagents skill remove <name>                            # 删除
myagents skill enable <name>                            # 启用
myagents skill disable <name>                           # 禁用非 Required Skill；Required System Skill 会拒绝
myagents skill sync [name ...]                           # 预览 ~/.claude/skills 的导入候选，不写入
myagents skill sync [name ...] --apply                   # 导入选定候选；新导入默认禁用，需 skill enable
```

**`skill add` 输入形态**（同一 resolver 全吃）：

| 输入 | 说明 |
|------|------|
| `foo/bar` | GitHub owner/repo 简写 |
| `https://github.com/foo/bar` | 完整 URL |
| `https://github.com/foo/bar/tree/main/skills/baz` | 子路径，只装 baz |
| `foo/bar@baz` | 仓库内多 skill 选其一 |
| `"npx skills add foo/bar --skill baz"` | 用户从 README 复制的整条命令（用引号包） |
| `https://example.com/x.zip` | HTTPS 直连 zip |
| `./private-skill` / `../private.skill` | 相对当前 CLI 调用目录的本地目录、`.zip` 或 `.skill`；必须显式写 `./` / `../` |
| `/absolute/path/private-skill` | 本地绝对路径（Windows 也支持 drive-letter 路径） |
| `file:///absolute/path/private.skill` | 本地 file URL |

本地来源会物化复制到 MyAgents 管理目录，不保留 source symlink；`--dry-run` 只解析和预览，不写目标或 staging。

**不支持**：`.tar.gz/.tgz`、GitLab、私有仓库、git SSH。

**何时用：**
- 用户贴 GitHub 链接或 `npx skills add ...` → 直接 `skill add "<原文>"`，resolver 自己剥前缀
- 用户给出私有本地 Skill → 保留显式 `./` / `../` 或绝对路径，直接 `skill add <source>`；不要先复制进 `~/.claude/skills`
- "装 React 最佳实践" → `skill add vercel-labs/skills --skill react-best-practices`
- 报错 `该仓库是 Claude Plugins 市场` → 按提示加 `--plugin <name>`，比如 `skill add anthropics/skills --plugin document-skills` 一次装 docx/pdf/pptx/xlsx
- 报错 `技能 X 已存在` → 跟用户确认要不要 `--force` 覆盖
- 用户在 `~/.claude/skills/` 自己塞了东西 MyAgents 看不见 → `skill sync` 预览，再按授权 `--apply` 导入并启用

### 定时与未来自动化 Task

```bash
myagents task readme                                    # 统一自动化模型与当前命令
myagents agent current --json                          # 仅诊断当前 Agent/workspace/Session
myagents task get <taskId> --json                       # 权威配置与运行状态
myagents task run <taskId>                              # 首次启用 Todo Task
myagents task start <taskId>                            # 恢复 schedule；看回执 nextExecutionAt
myagents task stop <taskId>                             # 暂停并停止活跃执行
myagents task runs <taskId> [--limit N]                 # 看 AI 执行历史
myagents task run-now <taskId>                          # 绕过 Detector 立即执行
myagents task exit [--reason "..."]                     # 仅在允许 AI exit 的 Task run 内
```

定时、未来唤醒、循环执行和“满足条件才处理”是同一类 Task 意图。先加载 `myagents-task-automation`，由它选择普通 always 激活或 command Detector，并完成创建、回读和启动。不要让用户先选择 Cron 或 Sensor。

`myagents cron ...` 继续作为旧用户/脚本的兼容 alias，但不是 Agent 新建自动化的规范入口。不要调用系统 `cron/crontab/at/launchctl/schtasks`。

### Goal 目标模式（goal）

Goal 是当前会话内的持续执行模式：宿主会在每轮完成后自动发起下一轮，直到 AI 主动标记完成/受阻，或用户在 UI 中取消。它复用当前 session 上下文，不是独立任务中心任务。

```bash
myagents goal get                                      # 查看当前 session 的 Goal
myagents goal create --objective-file goal-objective.txt --max-executions 12   # 本地任意普通文本文件；可选 deadline/max/AI exit 条件
myagents goal update --status complete                 # AI 判断目标完成时主动退出
myagents goal update --status blocked                  # AI 判断无法继续时主动退出
```

**何时用：**
- 用户明确要求进入 Goal 时，先用标准文件工具把 objective 写入本地文本文件（workspace 或系统 temp 均可），再传 `--objective-file`；不要把用户文本拼入 Shell 命令。可用 `--deadline <ISO-8601-with-offset>`、`--max-executions <正整数>`、`--ai-can-exit <true|false>` 设置已有结束条件；deadline 是最晚停止时间，不是延迟开始。
- 当前会话进入 Goal 后，你完成了用户目标 → `goal update --status complete`
- 你连续尝试后确认缺关键输入/外部状态，无法继续推进 → `goal update --status blocked`
- 用户问"现在目标是什么/状态如何" → `goal get`
- 不要用 `goal update` 表示用户取消；取消由 UI/宿主控制。

### 记录与任务中心（record / task）

用户要定时、未来唤醒、循环执行或满足条件才叫醒 AI 时，统一加载 `myagents-task-automation`。command Detector 的协议、fixture 和测试由该 Skill 按需路由到自己的 reference；这里仅保留 Task Center 的通用命令索引。

```bash
myagents record list [--kind text|audio --tag X --query X --limit N]
                                                        # 列统一记录；省略 --kind 时同时包含文字与音频
myagents record create '...'                            # 记一条文字 Record（首选：单引号包裹防 shell 注入；
                                                        # 用 #xxx 内联打 tag —— 没有 --tag flag）
myagents record create --content '...'                  # 显式 flag 形态，同样使用单引号
myagents record create --content-file <abs-path>        # 内容含多行 / CJK / shell 元字符 /
                                                        # Windows 下单引号失灵时的保底通道

myagents task list [--status X --tag X --query X --limit N --includeDeleted]
                                                        # 默认当前 workspace；JSON 是紧凑投影
myagents task get <taskId>                              # 详情 + statusHistory + 各 .md 文档路径
myagents task create-direct --name "..." \
    [--taskMdFile <path> | --taskMdContent "..."] \
    [--runtime X --providerId X --model X --permissionMode X --runtimeConfig <jsonStr> --mcpEnabledServers a,b] \
    [--executor agent --executionMode once --runMode X --tags x,y --sourceRecordId X]
                                                        # 从完整 task.md 物化普通任务（当前 workspace 可自动继承）
myagents task comments <taskId> [--limit 50 --before <cursor>]
                                                        # 读取本地线性评论时间线
myagents task comment [<taskId>] --body-file <path> [--reply-to <commentId>]
                                                        # Agent 显式写回本地 Task；执行上下文可继承 taskId
myagents task run <taskId>                              # 派发 todo 任务
myagents task start <taskId>                            # 按保留 anchor 恢复，以 nextExecutionAt 为准
myagents task stop <taskId>                             # 暂停 schedule 并停止活跃执行
myagents task runs <taskId> [--limit N]                 # 查看最近 AI 执行历史
myagents task exit [--reason "..."]                     # 仅在允许 AI exit 的 scheduled Task 内
myagents task rerun <taskId>                            # 从 blocked/stopped/done 重新派发
myagents task update-status <taskId> <status> [--message "..."]
                                                        # 状态机：todo→running→verifying→done（或 →blocked/stopped）、done→archived
myagents task append-session <taskId> <sessionId>       # 把一个聊天 session 关联到任务（任务过程中开了新会话用这个登记）
myagents task archive <taskId> [--message "..."]        # 归档（仅用户可操作；AI 走会被拒）
myagents task delete <taskId>                           # 不可恢复地移出产品使用；不删工作区脚本
```

`create-direct` 和 `task list` 正常会继承当前 workspace，不需要先枚举 Agent 再手工拼 `workspaceId/path`；只有明确跨 workspace 时才传两者。`myagents agent current --json` 是紧凑诊断入口，不是 happy path 前置步骤。

创建 scheduled/recurring Task 可用 `--deadline <ISO-8601-with-offset>`、`--maxExecutions <正整数>`、`--aiCanExit true|false` 设置结束条件；quiet Detector 检查不消耗 maxExecutions。固定 interval 第一次 `run` 默认约 2 秒后产生首次 tick；要延后首次机会时传 `--startAt <ISO-8601-with-offset>`。Cron 等下一个墙钟点，scheduled 等 `dispatchAt`。

**任务级 runtime/provider/model/permissionMode 覆盖**：`create-direct` 支持仅对该任务生效的覆盖 flag，**不会改 Agent 工作区默认**。典型场景："实现用 Claude Code、review 用 Codex" → 创两个任务，`--runtime` 不一样，工作区配置不变。

| Flag | 语义 |
|------|------|
| `--runtime` | `builtin` / `dsh` / `claude-code` / `codex`，不传则继承 |
| `--providerId` | 目标 Runtime 支持的 Provider id；必须与 `--model` 成对设置，不传则继承 |
| `--model` | 值取决于 runtime，**先 `runtime describe <runtime>` 查** |
| `--permissionMode` | 值取决于 runtime，**同样先 `runtime describe`** |
| `--runtimeConfig` | JSON 对象字符串，runtime 专属配置（罕用） |
| `--mcpEnabledServers` | 逗号分隔 MCP id；`""` 表示该任务显式不用 MCP |

`task update <taskId>` 清覆盖用显式 flag：`--clearProviderOverride` / `--clearRuntimeOverride` / `--clearMcpOverride`。注意 `--mcpEnabledServers ""` 不是清回继承，而是显式无 MCP。

`myagents thought list/create` 只为已发布脚本保留兼容，薄映射到文字 Record。新工作流一律使用 `myagents record`，不要主动生成 legacy 命令。

**何时用：**
- "看我还有啥没做完的" → `task list --status running` / `task list`
- "把这条记录派发出去" → 先将完整任务上下文写入 `task.md`，再用 `task create-direct --taskMdFile ... --sourceRecordId <id>` 创建；是否立即 `task run` 取决于用户已确认的动作
- "创个 review PR 的任务用 codex" → 先 `runtime describe codex`，再 `task create-direct ... --runtime codex --model <现场模型> --permissionMode <现场权限模式>`
- "任务过程中我开了个新对话登记一下" → `task append-session <taskId> <sessionId>`
- "把重要结果回复到本地任务" → 将正文写入文件，再用 `task comment <taskId> --body-file ...`；普通 assistant 输出不会自动复制到 Task
- 正在执行 Task turn 时可以省略 `<taskId>`，Sidecar 会从当前 Session 的精确 Task 上下文解析；收到用户 Task 评论后的后续 turn 应使用隐藏提醒里给出的显式 `<taskId>`，不得猜测
- "标记完成" → `task update-status <taskId> done --message "..."`
- "重新跑一遍" → `task rerun <taskId>`
- `task list --json` 只返回紧凑发现字段和 `sessionCount`，不会展开历史 `sessionIds`；拿到 ID 后用 `task get` 读取完整状态与各 `.md` 文档路径

**验证与恢复**：CLI 在转发给 Rust 前会前置校验 `--runtime` / `--model` / `--permissionMode`，不合法直接拒绝并带 `→ Run: myagents runtime describe <rt>` 指引；输出会打印 `overridesRequested` vs `overridden`，传了 override 但没落到持久化态会明确提示 drift。

**归档与删除**：`task archive` 是仅用户可执行、长期可恢复的归档状态，Agent 调用会被 Task authority 拒绝。执行 `task delete/remove` 前在对话中向用户说明具体对象并取得确认；已有明确删除授权时直接执行，CLI 不弹界面确认框。删除不可恢复，没有 30 天恢复或 undelete 承诺；它会停止调度并清平台 Trigger state/pending activation，但内部 tombstone/审计仍用于 authority 与迁移安全，工作区脚本和脚本自持状态不归 TaskStore 删除。

### MyAgents Cloud Space（space）

```bash
myagents space list --json
myagents space whoami --space <slug> --json
myagents space goal list --space <slug> --json
myagents space assignee list --space <slug> --json
myagents space issue create --space <slug> --title "..." --body-file issue.md \
  [--goal <goalId>] [--assignee agent:<id>|user:<id>] [--attachment <path> ...]
myagents space issue list --space <slug> --goal <goalId> --state todo --limit 30
myagents space issue view <issueId> --space <slug> --comments --json     # current Issue + latest 5 comments
myagents space issue update <issueId> --space <slug> --goal <goalId> --json
myagents space issue update <issueId> --space <slug> --clear-goal --json
myagents space issue update <issueId> --space <slug> --human-only false --json
myagents space issue comments <issueId> --space <slug> --json [--limit 20] [--cursor <opaque-cursor>]
myagents space issue comment get <issueId> <commentId> --space <slug> --json
myagents space issue comment <issueId> --space <slug> \
  [--body-file <path>] [--attachment <path> ...]
myagents space issue claim <issueId> --space <slug> --deliveryId <deliveryId> --create-attached \
  --workspaceId <id> --workspacePath <path> --name "..." --taskMdContent-file task.md
myagents space issue complete <issueId> --space <slug> --workspacePath <path> \
  --taskId <taskId> --body-file result.md [--attachment <path> ...] --message "completed Space issue"
myagents space issue attachment add <issueId> --space <slug> --file <path> [--file <path> ...]
myagents space attachment download <attachmentId> --space <slug> [--output myagents_files/space/file.bin]
```

**何时用：**
- 普通会话先 `myagents space list --json` 选择明确的 slug；所有 Space 业务命令都必须带 `--space <slug>`，不猜“默认社区”或上次使用的 Space。
- 官方社区反馈使用发现结果中 `spaceKind=official` 的实际 `slug`（当前通常为 `myagents`），`id` 可用于资源导航。`official` 仅为导航别名，不能替代 CLI 的 canonical slug。对话入口：`myagents://open/v1/spaces` 打开/聚焦 Space Tab；`myagents://open/v1/spaces/official/issues` 打开官方列表；详情末尾追加服务端真实 Issue ID。
- CLI 只有在当前 Session 持久化了精确的 `spaceId + registeredAgentId` origin 时，才以该 Registered Agent 身份执行；显式 legacy Agent ID 仅作旧调用兼容。workspace 只校验执行边界，绝不用于猜测 actor。没有 Registered Agent origin 的普通 Session 始终使用当前 User 身份；origin、Space 或 workspace 不匹配会直接拒绝，不会静默降级。身份不确定时先 `space whoami`。
- 需要创建、筛选或移动 Issue 时，先 `space goal list --json`，只复制 active `data.items[].id`；不要把 Goal title 或 `goalPathLabel` 当 ID。`myagents goal ...` 是本地 Session Goal Mode，`myagents space goal ...` 是 Cloud Space Goal，两者不是同一资源。
- `issue create` 不传 `--goal` 会进入 Inbox；已发布 Issue 用 `issue update --goal <goalId>` 移动，使用 `--clear-goal` 清回 Inbox。不要用 `--goal null`、`--goal inbox` 或空字符串表达清除。更新后用 `issue view --json` 核对权威 `goalId/goalPathLabel`。
- 具体命令参数优先运行精确 leaf help，例如 `myagents space issue comment --help`；这些 help 是给 Agent 的完整调用说明。
- 收到 Space delivery → 先 `myagents space issue view <issueId> --space <slug> --comments --json` 读取当前服务端状态；delivery trigger 只用于定位，不替代当前状态。
- trigger 的 comment 标记为截断 → 用 `myagents space issue comment get <issueId> <commentId> --space <slug> --json` 精确读取，不要扫描分页猜触发评论。
- subscription 通知只表示该 Issue 在路由时匹配订阅，不等于已经指派责任。读取当前 Issue 后，可以不做进一步动作、评论或更新而不 claim；只有确认该 Agent 应负责完成时，才用 `claim`（需要持久本地执行跟踪时再加 `--create-attached`）。Delivery 会由本地 connector 自动确认，不存在 Agent-facing ignore/handled/acknowledge 命令。
- assignment 表示责任已经明确交给当前 Agent；仍用 `claim --create-attached` 确认并建立本地 Task/Session 关联，不要 ignore 或自行取消指派。
- Issue/评论里有附件 → 用 `myagents space attachment download <attachmentId> --space <slug>` 下载到当前工作区，再读取本地文件。
- 需要回写结论 → `space issue comment` 可原子提交正文和附件；只有附件也合法。评论附件只属于该评论，不会跑到 Issue 顶部。
- 需要给已发布的 Issue 正文单独补附件 → 用 `space issue attachment add`，它会立即生效并触发正常的 Issue 更新投送。
- 工作完成 → 使用一次 `space issue complete --taskId ... --body-file ...`，它会原子完成 Cloud 结果评论 + Issue，再将 attached Task 标为 done；成功后不要再调用 `task update-status done`。

**安全边界：**
- CLI 在 Rust 内解析并持有 User/Registered Agent token；不要让用户提供 token，也不要传显式 actor。
- Space mutation 当前不支持 preview；携带 `--dry-run` 会在网络前返回 `DRY_RUN_UNSUPPORTED`。确认写入意图后按精确 leaf help 调用，不能把失败说成已经预览。
- `--body-file`、`--taskMdContent-file` 与附件只能读取当前 workspace 内的普通文件，拒绝 symlink 和 workspace 外路径；每次最多 5 个附件、每个最多 25 MB；`attachment download --output` 也只能写在当前 workspace 内。
- `view --comments` 固定最新 5 条；更早历史使用 `issue comments --limit 20 --cursor <opaque-cursor>`，有 `nextCursor` 再继续拉。

### 社区插件（plugin）

```bash
myagents plugin list                                    # 已装的 OpenClaw 社区插件
myagents plugin install <npmSpec>                       # 从 npm 安装（如 @anthropic/wechat）
myagents plugin remove <pluginId>                       # 卸载
```

**何时用：**
- "装个微信插件" → `plugin install <npm 包名>`
- 飞书可走内置 Channel 和扫码配置；只有明确需要社区实现时再查 OpenClaw 插件来源并安装，见 `/myagents-docs`

安装走内置 Node.js 的 npm，可能需要 10-30 秒。卸载前会检查是否有 Channel 还在用这个插件——有的话先把 Channel 移掉。

### Claude 插件（cc-plugin） — PRD 0.2.17

```bash
myagents cc-plugin list                                 # 已装 Claude 插件 + 启停状态
myagents cc-plugin install <source>                     # 来源：owner/repo / GitHub URL / 直链 zip / file:///abs
myagents cc-plugin uninstall <name> [--purgeData]       # 卸载（数据目录默认保留）
myagents cc-plugin enable <name>                        # 启用；按 Runtime 支持的扩展边界应用
myagents cc-plugin disable <name>                       # 禁用
myagents cc-plugin show <id|name>                       # 详情（含 manifest + 组件清单）
```

**与上面 `plugin` 的区别：** `cc-plugin` 是 Claude Plugin 协议（skills/agents/MCP/hooks），落在 `~/.myagents/plugins/<name>/`；SDK 加载支持的组件，DSH/Managed Codex 按各自 admission 支持部分扩展，不保证 SDK hooks 等价。`plugin`（无前缀）是 OpenClaw IM 渠道插件。

**何时用：**
- "粘个 GitHub URL 装个插件" → `cc-plugin install owner/repo`
- "装本地正在调的插件" → `cc-plugin install file:///path/to/plugin`
- "禁掉 X 插件" → `cc-plugin disable X`

启停 / 安装 / 卸载后会触发 SDK 柔性重启（500ms 防抖），下一次发消息时 plugin 内组件才生效。外部 Runtime（Claude Code CLI / Codex）下不读取这里——它们各自管自己的 plugin 体系。

### 通用配置 + 状态（config / status / version / reload）

```bash
myagents config list [prefix]                           # 发现当前配置键、类型、说明；不返回值
myagents config get <key>                               # 读，支持点号路径如 proxySettings.host
myagents config set <key> <value> [--dry-run]           # 写，value 是 JSON 字面量（字符串要带引号）
myagents status                                         # 应用整体运行状态
myagents version                                        # App 与 Sidecar 版本、构建/启动时固定的代码身份
myagents reload [--workspacePath <abs>]                 # 请求重读配置，实际应用按当前 Runtime 边界
```

**何时用：**
- "现在配的代理是啥" → `config get proxySettings`
- "把代理 host 改成 X" → `config set proxySettings.host '"X"'`
- "应用版本" → `version`
- "改完手动让它生效" → `reload`（多数命令已经自动 broadcast，这个是兜底）

`status` 分别显示全局 MCP 配置、工作区选择和当前 Session 实际观测；unknown 表示没有可信的当前观测，不表示 0 个服务器。`skill list` 默认收起正常 admission 详情，异常和不可用原因仍显示；`--verbose` 展开，`--json` 保留完整结构。DSH 的模型目录由所选 Provider 提供，使用 `model list` 查询。

DSH 会话的 MCP 排查先用 `myagents diagnose runtime dsh --json` 查看 `extensions` 的 admission / prepare 状态，再用 `myagents mcp show <id>` 核对配置。全局 `enabled` 只是开关，不证明当前会话已连接；`prepare_failed` 表示扩展准备失败。当前 DSH 尚未发布统一 `sessionMcp` effective snapshot，因此 `status` 的 unavailable / not observed 不能当作无服务器，也不能用配置或扁平工具名猜工具数量。诊断若只给泛化 reason，需保留该会话与对应时间的日志继续定位，不能宣称原始根因已经确定。

### IM 媒体下发（im）

```bash
myagents im send-media --file <绝对路径> [--caption "..."]
                                                        # 仅在 IM Bot / Agent Channel session 内可用
myagents im readme                                      # 拉 IM 工具完整文档
```

**何时用：**
- 你正在某个 IM 渠道（Telegram / 飞书 / 钉钉 / OpenClaw）的会话里跟用户聊，要发图片 / 视频 / 文件给对方时用 `im send-media`
- `--file` 必须是绝对路径，且路径白名单：必须落在 workspace / `/tmp` / MyAgents scratch 目录之一——这是为了防 prompt injection 把 `~/.ssh/id_rsa` 之类发给聊天对方
- 不在 IM session 内调用会返回 "No IM context"，正常——这命令本来就是 session-scoped

### Agent 网络与 Session 协作（agent / session）

每个 user-visible Workspace 都有一个稳定 Agent identity。Agent 是工作区
及其执行默认的长期地址；`enabled=false` 只关闭 Heartbeat、Memory Update、
Memory Evo 三项主动能力，不会关闭由 `channel.enabled` 独立控制的 Channel，
也不会取消身份或妨碍显式发起 Session。一个 Agent 可以拥有多个相互隔离的 Session。

```bash
# 先发现 Agent，并确认哪个是当前 CLI 调用方
myagents agent list
myagents agent show <agentId>
myagents agent network-diagnose --json                 # 本机连接、协议与设备目录；只读，不能开放远端 Agent

# 查看某 Agent 最近可复用的历史上下文（只读，不唤醒）
myagents session list --agent <agentId> [--limit 10]

# 在目标 Agent 下开启干净的新上下文
myagents session start --agent <agentId> -p "<prompt>"
myagents session start --agent <agentId> --prompt-file <abs-path>

# 在已知 Session 的既有上下文里继续做新工作
myagents session send <sessionId> -p "<prompt>"
myagents session send <sessionId> --prompt-file <abs-path>   # 多行/长文本(>4KB)必用,跨平台稳定

# start / send 默认在目标 turn 结束后把结果推回当前 Session
# 仅通知、不需要结果回流时加 --no-reply
myagents session start --agent <agentId> -p "<prompt>" --no-reply

# 只观察另一个 Session；不注入新工作
myagents session watch <sessionId>
myagents session state <sessionId> --json                # idle / running / waiting_user_action；不启动 AI
myagents session get <sessionId> --limit 5 --json         # 分页读取可见正文
myagents session watches --json                         # 仅当前调用方的观察
myagents session unwatch <watchId>                       # 或 --all；不停止目标工作
myagents agent --help                                        # Agent identity 完整契约
myagents session --help                                      # 完整用法 / EXIT CODES / 示例
```

**何时用:**
- 使用 `agent list/show`: 发现目标 Agent、当前调用方身份和目标执行默认
- 使用 `session list --agent`: 判断最近上下文是否值得复用；它不证明目标正在运行
- 使用 `start`: 需要目标 Agent 在全新隔离上下文中执行
- 使用 `send`: 另一个 session 需要做新工作、接收通知、澄清或后续指令
- 使用 `watch`: 当前任务依赖另一个 session 的工作,或用户明确希望你监听另一个 session 的当前/最新结果
- `start` 创建 fresh context；`send` 保留现有 context；`watch` 不注入工作
- **不要用**于答复当前用户(直接回复就行);不要用于给 IM peer 发消息(用 `im send-media`)
- AI 身份(from label)系统会自动从你所在 session 元数据推导——你不需要也不应该手动指定
- 只使用 discovery 返回的完整 ID，不猜 ID，不用名称或 workspace path 充当 selector。远端使用完整 `ma-agent:1:...` / `ma-session:1:...`，不截短
- 同账号远端设备必须入网、在线且开放目标 Agent；`enabled`、IM Channel 与网络开放互相独立。发现结果 `complete=false` 时不要把缺项当作不存在
- `session get` 默认最近 5 条按旧到新返回；`before` 排除锚点，用当前页第一条 message id 向前翻页。只读可见正文，不含工具、思考与隐藏控制事件

**异步语义(关键):**
- `start` / `send` CLI 成功只表示首条请求已接纳，**不表示工作完成**
- App 内真实 Session 发起 `start/send` 默认回传；授权的外部终端为单向投递，不支持 watch/观察管理。目标按自己的 runtime/model/permission/MCP/plugin/tool 配置执行，不接受调用方覆盖
- `start` receipt 返回新的 `sessionId`、`messageId`；`messageId` 对应稍后 `send.result.requestEventId`
- 默认期待结果推回：对方处理完后，系统向来源 Session 投递 `<myagents-session-event type="send.result">`，不需要主动轮询或再发工作
- `--no-reply`:仅通知,reply 不回流(对方按自己呈现路径输出)
- `send` 的 target session idle/dead 不影响投递——系统会自动唤起
- `watch` 一次性观察目标真实轮次；idle 时直接返回 `watch.already_idle` 与最近结果，按 live/history/none/unavailable 和 terminalStatus 判断，不能当作某次请求的成功证明
- `watch` 不会向目标 session 注入新 prompt；需要新工作时用 `send`
- 接纳不等于 Runtime 消费，消费也不等于成功；结果关联实际消费轮次。协作 Inbox 与手动输入的队列设置独立，在支持的安全点实时进入
- 默认回传通常无需另加 watch；同轮重复观察可合并。unwatch 只取消观察，不取消默认回传、撤回已接纳消息或停止目标
- `waiting_user_action` 需要目标用户审批/确认/回答；来源不能代批。`idle` 不是成功状态
- start/send 接纳未知或回执丢失时保留 receipt/request IDs，先用 get/state/list 观察，**不要自动重试**。真实断线无离线补投，目标已接纳工作仍可能继续

**Windows 安全:**
- `-p` 内容含 `\n` 或 > 4KB → CLI 立即 fail-fast(exit 3),提示切到 `--prompt-file`
- 习惯上长 / 多行内容**永远**走 `--prompt-file`,跨平台一致

### Generative UI Widget 设计文档（widget）

```bash
myagents widget readme                                  # 看有哪些 widget 模块（chart/diagram/interactive/dashboard/art）
myagents widget readme <module1> [<module2> ...]        # 拉具体模块的完整设计规范
```

**何时用：**
- 用户让你"做个图表 / 仪表盘 / SVG 流程图"前，先 `widget readme <module>` 拉对应模块的完整规范（含输出格式契约、palette、组件库），**不要凭印象写**
- 模块清单：`chart`（Chart.js 图表）/ `diagram`（SVG 流程图）/ `interactive`（滑块/计算器/对比卡）/ `dashboard`（多图表 + 控件）/ `art`（SVG 插画）
- 渲染输出有严格 `<generative-ui-widget>` 格式契约——readme 开头会说明，跳读会出错

`task readme` / `im readme` / `widget readme` 都是 progressive disclosure：brief 已经在系统 prompt 里，要用时才 fetch full doc。

---

## 典型工作流

### 接入 MCP 工具

1. 从用户给的文档提取：server ID、类型（stdio/sse/http）、command 或 URL、所需环境变量
2. `myagents mcp add --dry-run ...` 预览
3. 核对预览是否符合已授权目标；仍有关键缺项或超出授权时再澄清
4. 执行：`mcp add` → `mcp enable --scope both` → 配 env（如需）→ 如果是 OAuth 类的再 `mcp oauth start`
5. `myagents mcp test <id>` 实际握手测试
6. `myagents reload`
7. 读取实际工具/admission 状态，说明当前 Runtime 的生效边界

### 配置模型服务（最常见、最有价值）

#### 按 Runtime 与模型声明选择协议

Claude Agent SDK 的原生协议是 Anthropic Messages API；DSH 可使用 Provider 声明的原生协议。先确认目标 Runtime 与模型元数据。对 SDK 路径接入第三方 API 时：

1. **Anthropic 协议**：SDK 原生路径，优先使用服务商明确支持的接口；工具、流式和 Thinking 仍受具体模型能力限制。
2. **OpenAI 兼容**：按服务商声明选择 Chat Completions 或 Responses，SDK 路径经过兼容桥；不以模型名称猜协议。

#### 从文档提取配置

**第一步：找 Anthropic / Claude Code 接入板块（优先）**

大多数支持 Anthropic 协议的服务商，会在文档里以「接入 Claude Code」的形式呈现——MyAgents 和 Claude Code 共享 SDK，所以 Claude Code 的接入方式就是我们最原生的接入方式。

文档里搜：`Claude Code` / `Anthropic` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `/anthropic`。

提取：
- `ANTHROPIC_BASE_URL` → `--base-url`
- 认证方式（Bearer Token vs API Key）→ `--auth-type`
- 模型名称列表 → `--models`

**即使文档同时给了 OpenAI 兼容方式，只要有 Anthropic 方式就用 Anthropic。**

**第二步：实在没 Anthropic 才用 OpenAI 兼容**

搜：`OpenAI 兼容` / `/v1/chat/completions` / `chat completions`。

- API base → `--base-url`（通常 `/v1` 结尾或去掉 `/chat/completions`）
- 加 `--protocol openai`
- `--upstream-format`：多数 `chat_completions`（默认），少数新服务商支持 `responses`

#### Claude Code 环境变量 → CLI flag 映射

| Claude Code 环境变量 | MyAgents CLI |
|---------------------|------------|
| `ANTHROPIC_BASE_URL` | `--base-url` |
| `ANTHROPIC_API_KEY` | `model set-key` 设置 |
| `ANTHROPIC_AUTH_TOKEN` | 同上，区别在 `--auth-type` |

**`--auth-type` 选择**：
- 文档说设 `ANTHROPIC_AUTH_TOKEN` → `auth_token`
- 文档说设 `ANTHROPIC_API_KEY` → `api_key`
- 文档要求两个都设 → `both`；没说清先核对文档或已有 Provider，不能把默认值称为普适最安全
- OpenRouter 等特殊服务商 → `auth_token_clear_api_key`

#### model add 完整 flag

```
myagents model add \
  --id <唯一ID>              # 必填
  --name <显示名>             # 必填
  --base-url <API地址>        # 必填
  --models <模型ID列表>       # 必填，逗号分隔或多次 --models
  --model-names <显示名列表>   # 可选，与 models 一一对应
  --model-series <系列名>      # 可选，默认取 provider ID
  --primary-model <默认模型>   # 可选，默认取第一个 model
  --auth-type <认证类型>       # 可选，默认 auth_token
  --protocol <协议>           # 可选，anthropic(默认) 或 openai
  --upstream-format <格式>     # 可选（仅 openai），chat_completions(默认) 或 responses
  --max-output-tokens <数字>   # 可选（仅 openai），默认 8192
  --vendor <供应商名>          # 可选，默认取 name
  --website-url <官网>         # 可选
  --dry-run
```

#### 免费模型优先策略

很多 Provider 同时提供付费模型和免费模型。`model verify` 会用 `primaryModel` 发一条测试消息——如果用户还没充值，验付费模型会失败。

**策略**：Provider 既有免费也有付费时，把免费模型放在 `--models` 列表第一位，`primaryModel` 自动选中免费模型，验证更易过。**例外**：用户明确说要哪个就用哪个。

#### 完整流程

1. `model list` 看是不是已有内置 Provider
2. 是内置 → 直接 `model set-key`
3. 要新增 → `model add --dry-run ...` 预览
4. 核对预览是否符合已授权目标；有协议/覆盖等未确定事项时再澄清
5. `model add ...` 正式加
6. `model set-key <id> <key>`
7. `model verify <id>`
8. 验证失败按报错排查：
   - 认证失败 → 检查 Key 和 `--auth-type`
   - 模型不存在 → 检查模型名称
   - 余额不足 → 切到免费模型验证
   - 协议不对 → 核对模型元数据、服务商文档与已保存协议，修正真实不一致，不盲目轮换接口
9. 视情况 `model set-default <id>`

### 配置 Agent Channel

```bash
myagents agent channel list <agentId>                                       # 看现有
myagents agent channel add --help                       # 查当前版本支持的字段/凭据 flag
myagents agent channel add <agentId> --type <平台> ...   # 使用 help 声明的字段，不猜平台专用 flag
myagents agent channel remove <agentId> <channelId>
```

不同平台需要不同凭证；飞书也提供 UI 扫码创建。OpenClaw 社区实现使用 `openclaw:<pluginId>`，先安装对应插件；不要把内置飞书与社区飞书当同一条登录链路。
