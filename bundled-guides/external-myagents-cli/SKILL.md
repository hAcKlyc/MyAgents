---
name: external-myagents-cli
description: >-
  为不了解 MyAgents 的本机外部 AI 补充产品背景、能力模型和公开 CLI 使用方式。
  收到 MyAgents 设置页的交接 Prompt 后读取；使用其中给出的绝对 CLI 路径和
  MYAGENTS_API_TOKEN 发现本地与同账号跨设备 Agent、委托和读取 Session，
  以及操作本机 Task、Record 与 Runtime 发现。
metadata:
  author: MyAgents
---

# MyAgents 外部调用指南

## 1. MyAgents 是什么

MyAgents 是一个在用户电脑上运行的桌面 Agent 产品。它把本地目录、AI 执行环境和长期工作状态组织成几个可以组合的产品实体：

- **Workspace Agent**：绑定一个已有本地目录的长期 Agent 身份。它是工作区、默认 Runtime 和后续 Session 的稳定地址。
- **Session**：某个 Agent 下相互隔离的对话与执行上下文。可以新建干净上下文，也可以向已知 Session 继续发送任务并读取文本历史。
- **Task**：可持久化、可执行、可调度的工作项。适合待办、一次性执行、定时执行和满足条件后激活的自动化。
- **Record**：轻量的信息收集入口，用来保存文字记录，之后可以再整理或转成 Task。
- **Runtime**：真正执行 Agent 的运行环境。MyAgents 可以发现本机已支持的 Runtime，以及它们各自可用的模型和权限模式。

MyAgents App 是这些状态和执行生命周期的本机 Host；CLI 只是调用入口。你是运行在 MyAgents 之外的 AI，能够通过公开 CLI 委托和观察工作，但不会因此获得 MyAgents 内部 Session 身份、全部管理能力或隐藏 API 权限。

MyAgents 产品内部还可以管理模型 Provider、MCP/工具、Skill/Plugin、IM Channel、Cloud Space、Goal、文档与语音等能力；它们帮助 Agent 接入模型、工具、外部沟通渠道和更丰富的工作流。但当前外部 token 契约只开放本文后面介绍的 Agent、Runtime discovery、Session、Task、Record、已保存网络连接和状态查询。知道某项产品能力存在，不等于可以从外部 CLI 调用它。

## 2. MyAgents 能解决什么任务

把这些能力组合起来，可以完成几类典型工作：

| 用户意图 | 能力组合 | 结果 |
| --- | --- | --- |
| 让一个本地项目拥有可持续对话的 AI | 注册目录为 Workspace Agent → 新建 Session → 后续 send/get | 获得稳定 Agent ID 和可继续的独立上下文 |
| 把一件工作交给另一个 Agent 完成 | 找到目标 Agent → start 新 Session → 保存 Session ID → get 结果 | 当前 AI 不需要自己进入目标工作区 |
| 委托同账号另一台设备上的 Agent | agent list 发现在线目标 → 使用完整跨设备 ID → start/send/get | 由目标设备的 MyAgents 执行，并可主动读取结果 |
| 创建待办、定时任务或条件自动化 | 明确 Workspace → 创建 Task → 配置/启动 → get/runs 查看状态 | 工作进入 MyAgents 的持久 Task 生命周期 |
| 先记下来，稍后再处理 | 创建 Record → 后续查看并整理为 Task | 信息不会只停留在当前对话里 |
| 在创建 Task 前选择执行环境 | runtime list/describe → 使用返回的合法值 | 避免猜测 Runtime、模型或权限模式 |

最常见的主链路是：

```text
已有本地目录 → Workspace Agent → Session start → Session send → Session get
```

Task 和 Record 可以在这条链路之外保存更长期的工作意图；Runtime discovery 用来了解当前机器真实支持的环境，并为支持 override 的 Task 选择合法值。新 Session 继承目标 Agent 的配置，已有 Session 继续使用自己的执行配置；外部 Session 调用不能临时覆盖。

### 开始调用前

1. MyAgents App 必须保持运行。
2. 用户在 MyAgents 的「设置 → 外部调用」中开启 **MyAgents CLI 外部调用**。
3. 设置页复制的交接 Prompt 可能已经携带当前 `MYAGENTS_API_TOKEN` 设置命令。只用它配置调用进程环境；你不能通过 CLI 读取 token，也不要在后续回复、命令输出或文件中复述、记录它。
4. 始终使用交接 Prompt 给出的 **CLI 绝对路径**。普通终端和外部 Agent 的 PATH 不保证能发现 `myagents`。

POSIX shell：

```sh
export MYAGENTS_API_TOKEN="<token>"
```

PowerShell：

```powershell
$env:MYAGENTS_API_TOKEN = "<token>"
```

下文用 `<CLI>` 代表交接 Prompt 给出的绝对路径。实际执行时替换它，并按当前 shell 安全引用路径：POSIX 可用 `"/absolute/path/myagents" ...`，PowerShell 可用 `& "C:\\...\\myagents.cmd" ...`。

### 先用帮助发现，再调用

不要靠记忆猜参数。按层级读取当前安装版本的帮助：

```text
<CLI> --help
<CLI> agent --help
<CLI> agent create --help
```

- 顶层帮助列出当前外部公开能力。
- group help 用来选择子功能；leaf help 是 flags、输入要求和失败语义的权威。
- 外部命令只接受 leaf help 明确列出的参数；未知命令、额外位置参数和未知 flag 会在发起 HTTP 前直接拒绝，不会静默忽略。
- 业务调用优先加 `--json`。stdout 返回一份机器可解析 JSON，诊断信息走 stderr。
- 退出状态 `0` 只表示该命令达到自身定义的成功边界；非零状态必须按失败处理，并优先读取 JSON 中的稳定 `code`。精确退出码以 leaf help 为准。

## 3. CLI 能力入口

### App 状态与版本

适合在工作开始前确认 MyAgents Host 是否可用，以及记录当前 App 版本。

```text
<CLI> status --json
<CLI> version --json
```

`status` 只表示 Host 状态，不代表某个 Session 或 Task 已经完成。

### Workspace Agent

适合把一个已经存在的本地目录注册成长期 Agent、发现已有 Agent，或确认目标 Agent 的默认执行配置。

先读：

```text
<CLI> agent --help
<CLI> agent create --help
```

核心动作：

```text
<CLI> agent create --workspacePath <absolute-existing-directory> --json
<CLI> agent list --json
<CLI> agent show <agentId> --json
```

`agent create` 不会创建目录、初始化 Git、复制模板或自动启动 Session。同一未归档、正常可见的 workspace 重复注册会返回同一个 Agent。保存成功响应中的 `agentId`；不要用显示名称或路径猜 ID。

### 同账号跨设备 Agent

`agent list` 合并本地 Agent 与同账号其它设备上在线、已开放调用的 Agent；`--archived` 只列本地归档对象。JSON 中 `isLocal` 区分归属，`deviceName` 帮助选择目标，`agentId` / `selector` 才是调用地址。`networkStatus` 和 `complete` 表示网络发现状态与目录是否完整；网络异常时本地结果仍可返回，不能把不完整目录当作没有远端 Agent。

- 本地 Agent 使用返回的普通 ID；跨设备 Agent 使用完整的 `ma-agent:1:...` ID，跨设备 Session 使用完整的 `ma-session:1:...` ID。原样保存和传递，不截短、解码或按名称拼接。
- `agent show`、`session list/start` 接受 Agent ID；`session send/get/state` 接受 Session ID。本地和跨设备使用相同命令，无需额外网络参数。
- 跨设备调用要求本机网络连接可用，目标设备在线且目标 Agent 已开放。目标离线时调用失败，没有离线补投或自动重发。
- Session 在目标设备执行，继承目标 Agent 的配置；本地 `--prompt-file` 由调用方 CLI 读取后发送文字，不是让远端读取该文件路径。

跨设备路径同样先从成功 discovery 响应选目标：

```text
<CLI> agent list --json
<CLI> agent show <returned-agentId> --json
<CLI> session list --agent <returned-agentId> --json
<CLI> session start --agent <returned-agentId> --prompt-file <local-request-file> --json
<CLI> session get <returned-sessionId> --json
```

Agent 的注册、Task、Record 与 Runtime discovery 仍操作本机 Host；跨设备寻址不开放远端配置或文件管理。

### 已保存网络连接：登录与恢复

仅操作 App 已保存的 Owned 网络连接；先查询状态取得准确 connection ID 和 registry revision，不接受密码、token 或 issuer 参数，不创建 Session，不自动打开浏览器。

```text
<CLI> network --help
<CLI> network status --json
<CLI> network login --connection <saved-owned-connectionId> --revision <N> --json
<CLI> network poll --attempt <returned-attempt-UUID> --json
<CLI> network cancel --attempt <returned-attempt-UUID> --json
<CLI> network restore --connection <saved-owned-connectionId> --revision <N> --operation-id <new-UUID> --json
<CLI> network cancel-restore --operation-id <same-operation-UUID> --json
```

- `login` 返回 `authorization-required`，其中 `started` 包含 attemptId、authorizationUrl、expiresAt。由用户完成浏览器授权，再以同一 attemptId 显式 `poll`；`pending` 表示仍在等待，同时保留 `started` 供取回原授权链接；`authenticated` 才表示登录提交成功。
- 登录固定到原连接的账号和设备；不能用这些命令创建新连接、切换账号或替换设备身份。
- `restore` 使用已有凭据在后台恢复，可能耗时约 40 秒；不会弹出系统凭据授权窗口。需要系统授权时按错误停止，并由用户在 App 内处理。
- 保存 attemptId / operationId；`login` 回复丢失时，先通过 `network status` 的 `loginAttempts` 找回原 attemptId、connectionId 和 expiresAt，再查询或取消原 attempt；状态列表不含授权 URL。取消必须精确使用对应 ID。没有 `--wait` 自动编排；响应中断不证明操作未执行，先查状态，不自动重发 mutation。恢复接纳与真实服务连接 ready 分别判断。

### Runtime 发现

适合查看当前机器安装了哪些执行 Runtime，以及某个 Runtime 支持哪些模型和权限模式。它只做发现，不修改 Provider 或 Agent 配置。

```text
<CLI> runtime --help
<CLI> runtime list --json
<CLI> runtime describe <runtime> --json
```

在为支持 override 的 Task 选择 runtime/model/permissionMode 前先 describe，不要凭经验硬编码值。`models` 可能为空，例如 builtin 的模型来自 Provider；这不表示 Runtime 不支持模型。外部调用可读取 `agent show` 的未来 Session 默认值，未公开的 Provider 目录或诊断需在 App 内查看，不因响应中的恢复建议而调用非公开命令。Session start 不接受临时 override，而是继承目标 Agent 的配置。

### Session：委托、续聊与读取结果

适合把工作交给一个 Agent 的新上下文、向已知上下文追加指令，或读取当前可见的文本历史。

先读：

```text
<CLI> session --help
<CLI> session list --help
<CLI> session start --help
<CLI> session send --help
<CLI> session get --help
<CLI> session state --help
```

核心链路：

```text
<CLI> session list --agent <agentId> --limit 5 --json
<CLI> session start --agent <agentId> --prompt-file <request-file> --json
<CLI> session send <sessionId> --prompt-file <follow-up-file> --json
<CLI> session state <sessionId> --json
<CLI> session get <sessionId> --limit 5 --json
```

- 保存 `start` 返回的 Product Session ID；后续 `send/get` 都使用这个 ID，不要替换成 Runtime 自己的 session 标识或投递 messageId。
- 多行、较长或来自外部输入的 prompt 优先写入普通文本文件，再使用 `--prompt-file`，避免 shell 转义和注入。
- 外部 `start/send` 是 one-way。成功回执只表示请求已接受或投递，不代表 AI 已执行成功；需要结果时主动 `session get`。外部调用不提供自动结果回调或 `session watch/watches/unwatch`。
- `session state` 只读返回 `idle`、`running` 或 `waiting_user_action`；后者要求目标用户处理审批、确认或必须回答的问题。查询不唤醒模型、不代替用户批准，`idle` 也不表示任务成功。
- 状态不可读时返回查询错误，可按错误提示重试读取；不要把查询失败解释成目标 idle。
- `session get` 默认返回最近 5 条非空 user/assistant 文本，按旧到新排列；工具调用、thinking 和隐藏协议不会作为正文返回。`isLive=true` 时 `liveSessionState` 投影目标当前状态；`isLive=false` 时它为 `null`，不代表错误。暂时没有新 assistant 正文不等于失败或完成。更早内容按 leaf help 使用 `before` 分页。
- transport failure 或 `admission_unconfirmed` 可能表示结果不确定。保留已取得的 ID 并先查询，**不要自动重发**。

### Task Center 与自动化

适合创建持久工作项、派发执行、维护状态、查看运行历史，以及配置定时或条件触发。Task 子能力较多，不要一次加载或猜测全部命令。

先从产品说明和 group help 选择路径：

```text
<CLI> task readme
<CLI> task --help
```

常用入口：

```text
<CLI> task create-direct --help
<CLI> task get <taskId> --json
<CLI> task runs <taskId> --limit 5 --json
```

- 外部进程没有“当前 MyAgents Workspace/Session”上下文。`task list` 和 `task create-direct` 至少显式提供 `--workspaceId` 或 `--workspacePath` 之一；MyAgents 会补齐并核对这对 identity。不要用 shell cwd 猜目标。
- `task get/start/stop/runs/run/rerun/run-now/update/archive/delete` 等精确 Task ID 操作以该 ID 为 selector，不要求附带当前 workspace；`task remove` 是 `task delete` 的显式兼容别名。Cron 命令不是外部公开面。
- `task readme` 解释 Task/自动化模型；`task --help` 列出当前公开动作；选定动作后再读该 leaf help。
- 调度、trigger、checkpoint、运行控制、状态更新、归档和删除等细节都按需发现，不需要预先注入整张命令表。
- 执行接纳不等于最终成功。使用 `task get` 查看权威状态，使用 `task runs` 查看执行历史。
- 删除等不可逆动作前，核对准确目标并取得用户授权；已有明确授权时不重复确认。

### Record：轻量记录

适合把想法、材料或待整理的信息先存进 MyAgents，而不是只留在当前聊天里。

```text
<CLI> record --help
<CLI> record create --help
<CLI> record list --json
<CLI> record get <recordId> --json
```

创建多行、CJK 或包含 shell 元字符的文字时，优先按 leaf help 使用 content-file 输入。外部公开面提供文字 Record 创建、已有文字/音频 Record 的列表与详情读取，以及精确 ID 删除；不提供录音发起、转录任务控制或修改。

确需删除时，先读取详情核对准确目标并取得用户授权，再查 leaf help：

```text
<CLI> record delete --help
<CLI> record delete <recordId> --json
```

## 4. 调用边界与失败恢复

- 访问 token 只从 `MYAGENTS_API_TOKEN` 读取。交接 Prompt 是一次性的凭据传递入口；不要在后续 prompt、回复、命令参数、日志、文件或 transcript 中再次传播它。
- 只使用顶层外部帮助展示的命令。token 不会解锁内部命令、内部 Session 身份或隐藏 API；不要探测端口、伪造来源或直连 localhost 管理路由。
- ID 只能来自成功响应或公开 discovery 命令。不要猜 ID，也不要把 Workspace path、显示名称或投递 messageId 当作其它资源的 selector。
- App 不可用时请用户启动 MyAgents；CLI 不会自动启动或聚焦 App。
- 开关关闭或 token 失效时，请用户在「设置 → 外部调用」重新开启或注入当前 token，不要尝试绕过。
- 参数、路径或 lifecycle 冲突时，根据 JSON `code`、错误说明和 suggestion 修正输入。mutation 响应丢失时先用只读命令核实，不自动重放。

外部 token 只用于本机 CLI 访问本机 Host；CLI 可借助 MyAgents Agent 网络委托同账号其它设备上的已开放 Agent。这不提供远程直连 Host 的 HTTP/OpenAPI/SDK/MCP 接口。当前公开面不提供自动结果回调、exactly-once、Provider/MCP/Plugin/Skill/Tool/Channel/Space/Goal/Speech 管理，也不自动创建目录、初始化 Workspace 模板或 Git。目标超出公开帮助时，明确告诉用户需要在 MyAgents App 或 MyAgents 内部 Agent 中完成。
