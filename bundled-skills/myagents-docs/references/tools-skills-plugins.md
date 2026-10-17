# 工具、Skills 与插件生态

## 选择哪种扩展方式

| 能力形态 | 适合什么 |
|---|---|
| MCP | 让模型在回合里调用结构化工具或访问外部服务 |
| Skill | 教 Agent 稳定地执行一套方法、流程或领域任务 |
| 官方 CLI Tool | MyAgents 内置、跨 Runtime 可调用的产品工具，例如图片理解 |
| 用户 CLI Tool | 用户封装的本地非交互命令，注册后进入 Agent 可发现能力（实验室） |
| Claude Plugin | 一包包含 Skills、Agents、MCP、Hooks 等 Claude 生态组件 |
| OpenClaw Plugin | 给 Agent Channel 增加新的 IM 平台或渠道能力 |
| Generative UI Widget | 让 Agent 按产品协议输出图表、仪表盘、交互卡或 SVG 视觉内容 |

这些概念可以组合，但不要把它们当成同一种安装包。

## MCP

MyAgents 支持 STDIO、HTTP、SSE 类型的 MCP，也带有若干预置或内置能力。MCP 可以在全局启用，也可以针对 Workspace 启用。

典型使用过程：

1. 添加 server 定义或选择预置 MCP。
2. 配置必要的环境变量、URL、headers 或 OAuth。
3. 在用户/项目作用域启用。
4. 做一次连接测试。
5. 发下一条消息，让 Session 在新的回合边界应用工具配置。

`enabled` 不等于 OAuth token 仍有效；远程 MCP 登录问题要单独检查授权状态。MCP test 会实际启动或连接服务，属于 active probe。

Claude Agent SDK 与托管 Codex 的会话内工具状态可显示失败原因，并在空闲时重连失败 MCP；重连不等于修改全局配置，也不需要先删除整个 Session。

外部 Runtime 不一定消费 MyAgents MCP，具体见 `models-providers-runtimes.md`。

### 应用托管浏览器与 Playwright

「浏览器」对应内置 MCP `myagents-browser`，是应用管理 Chromium、登录 Cookie 与 Session Context 的工具；普通 Playwright MCP preset ID 是 `playwright`，右侧 BrowserPanel 则是网页预览面板。三者的配置、运行时和登录边界不同。托管浏览器和普通 Playwright preset 可在全局同时启用，但具体 Session/执行配置中二者互斥；通常优先选择托管浏览器。具体工具名以当前 Runtime 的实时工具清单为准。

托管浏览器的 Context 按 Product Session 隔离，而登录 Cookie 在当前 OS 用户的身份存储中共享；成功工具调用及关闭边界会自动保存 Cookie，不需要 Agent 调用存储工具。localStorage、IndexedDB 不保证跨 Session 恢复。侧栏 WebView Cookie 不会被托管浏览器读取。普通 Playwright preset 遵循自身浏览器配置，不继承托管浏览器的登录承诺。资源安装与修复使用产品浏览器设置入口；不要直接调用 `browser_install` 或绕过产品入口安装。

MoXBots 正式构建的 CLI 命令名为 `moxbot`。用 `moxbot mcp list` 或 `moxbot mcp show myagents-browser` 检查配置。合法启用命令为 `moxbot mcp enable myagents-browser --scope global`、`moxbot mcp enable myagents-browser --scope project` 或 `moxbot mcp enable myagents-browser --scope both`；handler 只接受这三个 scope，CLI 默认 `both`。有效 Session 配置按全局与项目启用状态取交集。用户要求执行浏览器任务时，可为该任务启用托管浏览器；优先只改这一 MCP，并依据当前 workspace 和已有全局状态选择所需 scope。配置启用不证明当前 Session 已加载工具。

## Skills

Skill 是给 Agent 的可复用工作方法，核心是 `SKILL.md`，还可以带 references、scripts 和 assets。MyAgents 支持：

- 系统 Skill：随应用版本维护，用户不应把它当普通个人 Skill 修改
- 用户级 Skill：在所有工作区可用
- 项目级 Skill：只在当前 Workspace 可用
- Claude Plugin 内的 Skill：随该 Plugin 启用
- Cloud Space 共享 Skill：从 Space 发布或安装到本地

Skill 可从 GitHub 仓库、支持的压缩包或本地来源安装。安装成功不必然代表当前 Session 已重新加载它；新 Session 或下一次合适的 Session 重启后最可靠。

如果用户需要把一段稳定流程沉淀下来，应选择 Skill；如果只是一次性执行，不必为了复用而强行创建 Skill。

## 官方与用户 CLI Tool

### MyAgents 官方 CLI

`myagents` 是产品管理入口，用于查询和操作 Provider、MCP、Task、Agent、Space 等能力。它不是用户 CLI Tool 注册表的一部分。

### 官方图片理解

当主模型不能直接看图、但用户在「设置 → 工具箱」配置并启用了图片理解时，Agent 可以把当前 Workspace 内图片交给读图模型分析。只接受本地工作区图片，不把 URL 或凭据路径当输入。

### 本地文档与音视频附件

AnyDoc 可离线转换本地文档/OCR，使用 `/myagents-anydoc`。`/myagents-speech-recognition` 可异步转写当前 Workspace 中的单个音频或视频附件，查询/等待/取消并取得带时间戳结果；它不录制会议，也不等于音频 Record 的播放器或说话人编辑。

### 桌面操作

macOS/Windows 随应用提供 Cuse Skill 与桌面操作 CLI，可在全局 Skills 启停。是否启用、系统权限和当前平台支持需现场确认；普通用户不应为此寻找已移除的内置 Cuse MCP。

### 用户 CLI Tool（实验室）

用户可以把符合 Agent-CLI 契约的非交互工具注册到 MyAgents。启用后，新 Session 能看到工具描述并从 PATH 调用。该能力受「CLI 工具注册表」实验开关控制；关闭时不会自动发现或管理用户工具，但官方 `myagents` CLI 不受影响。

适合：已经有稳定命令，希望多个 Runtime 和工作区都能调用。复杂的模型工具协议或持续服务更适合 MCP。

## 两种 Plugin

### Claude Plugin

遵循 Anthropic Claude Plugin 目录协议，可以包含 Skills、Agents、MCP 和 Hooks。MyAgents 在 Claude Agent SDK 中提供这套集成；DSH 与托管 Codex 可接入其中支持的产品扩展组件，具体 admission 以现场列表为准，不能保证整包 Hooks/Agents 等都有同等能力。启停后按 Runtime 的扩展更新边界生效。系统 Claude Code/Codex 自己管理其插件，不自动读取这里的 Claude Plugin。

### OpenClaw Plugin

用于 IM/Channel 生态，例如微信、QQ 等社区适配器。它有自己的安装、登录和 Channel 在线状态，不为普通 Chat 注入 Claude Plugin 组件。

## 工具产物与富媒体

工具生成的图片、音频、PDF 等会用统一的附件形式展示，不需要用户为不同工具寻找不同入口。常见结果：

- 媒体画廊直接出现在工具结果后
- 产物保存到 Workspace 的 `myagents_files/<tool>/`
- 外部 Runtime 保存原始文件，再由当前 Session 安全引用

附件可能先显示“处理中”，再异步更新为真实文件。大文件会保存为可引用文件，而不是把完整内容直接塞进 Session 历史。

## Generative UI Widget

当用户要求图表、流程图、交互计算器、Dashboard 或 SVG 插画时，Agent应先读取对应 Widget module 的当前输出契约，再生成 `<generative-ui-widget>` 内容。它是渲染协议，不是 MCP，也不代表把一个长期应用部署上线。

## 常见误解

- “装了 Skill 就多了一个可执行程序”：不一定。Skill 可以只是方法说明。
- “Plugin 都是 IM 插件”：Claude Plugin 与 OpenClaw Channel Plugin 是两套体系。
- “MCP 刚启用，当前正在生成的回复就能调用”：不会 retroactive 改变已经开始的回合。
- “CLI 工具注册表关了，`myagents` 也不能用”：官方 CLI 始终可用。
- “媒体路径出现在文本里就算附件成功”：还要能在工具结果中打开或预览真实文件。
