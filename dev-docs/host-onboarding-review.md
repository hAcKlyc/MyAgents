# MOXBOTS-HOST-ONBOARDING-001 独立审查

日期：2026-10-16。范围：只读核实 Host 安装路径和目录状态证据；不安装 Host，不授权登录/入网，不发送模型任务，不生产写入。

## 安装入口核查

- `scripts/host/README.md:5-9`：Linux x64/glibc 无签名测试产物；MyAgents 与 MoX 测试 profile 分离。发布 bootstrap 不配置网络，不安装桌面组件。
- `scripts/host/bootstrap.mjs:4`：生成器固定仓库 `heavenzhang/MyAgents`，当前 GitHub 读取会转到 `heavenzhang/MoXBots`。不应因名称重定向就推断历史产物具备新 profile 或 owned 网络配置。
- `scripts/host/README.md:27-43`：自建网络需要 unified installer、匹配 Host 包、单独 AgentNet 制品、两个独立可信摘要、网络源码 commit 和明确 HTTPS origin。安装不启动 AgentNet，不登录、不加入网络。
- `scripts/host/README.md:45-56`：登录和入网使用显式 `network-control.py --profile moxbot-test start`、`wait`、`join`；profile 必须与已安装环境一致，不建议界面呈现省略先决条件的可复制安装命令。
- `gh release list` 和 `gh release view` 当前核实：最新已发布 Host 测试 release 为 `host-test-20261011193120-8b5b7820263f`，source `8b5b7820263fd9a96361e58d50072c5a05436946`。四个 assets 仅含 `myagents-host-test-…tar.gz`、`install-…sh` 与两个摘要，无单独 AgentNet 或 MoX profile 资产。此核查只覆盖公开 release 元数据，不等于下载验证安装内容。
- Release 链接：https://github.com/heavenzhang/MoXBots/releases/tag/host-test-20261011193120-8b5b7820263f

结论：当前证据不支持展示“MoXBots 自建网络一键安装”命令。可以提供源码/维护者部署文档入口，并明确 Linux 仅测试部署、需要管理员准备匹配制品；macOS/Windows 应说明使用目标设备的桌面客户端，并区分实际可获取版本与已完成原生安装验收。

## 在线与执行边界

- `src/renderer/api/agentNetwork.ts:7-16`：设备、Agent 与 callable 来自固定 vendor metadata schema。
- `src/renderer/api/agentNetwork.ts:23-31,46-50,87-104`：连接 snapshot 的 ready 属于当前 connection/account/network scope；callable 请求另带 networkId；账号、revision 和连接状态变化会清除读取 scope。
- vendor 固定包 `vendor/agent-network-protocol/myagents-agent-network-protocol-1.1.0-445fb9d0e1e1e9f8.tgz` 内 `package/schemas/metadata-devices.json:24-30,96-114`：`joined`、`connectionState`（ready/syncing/offline）、`onlineAgentCount` 是不同字段，不能互相替代。
- 同包 `package/schemas/metadata-callableAgent.json:40-107`：只含目录身份、source、membership/enable revision、selector、epoch、generation、可空 binding；没有 Provider、模型凭据有效性、费用/执行授权或任务执行成功字段。
- `specs/tech_docs/headless_enrollment.md:3,9,13,33`：Host 可以发布真实空目录；账号设备登记不等于网络在线，设备在线与可执行模型任务分别验收。
- `specs/tech_docs/headless_remote_management.md:58,74-77`：owned connector 当前文档限定空 catalog/管理通道，callable 寻址信息不能替代零 Agent Host 的执行能力证据。历史进度条目存在不同阶段，不能仅取较早未完成项推断当前全部能力。

建议界面明确分别显示“设备连接”“网络成员”“Agent 可调用目录”“真实执行未验证”；callable 非零可证明当前服务返回目录条目，不可标为真实任务执行通过。失败、未完整分页、scope 变化均应使旧目录计数失效或明确标注未知。

## UI 验收

- [x] 安装产物、协议字段和证据边界只读核查。
- [ ] 等待主 Agent 提供本地运行 URL，再通过 Codex 内置浏览器独立验收四步、状态区分、键盘和窄屏。
- [ ] 记录结果和截图证据；不使用用户 Chrome，不触发登录、入网或模型调用。

本记录不代表真实新 Host 安装、桌面原生生命周期、真实 Agent 调用或生产验收完成。

## 实现代码复核

复核 `src/renderer/features/agent-network/HostOnboarding.tsx`、API 的新增 callable 分页、页面入口与 `CustomSelect`/Popover。

- `HostOnboarding.tsx:68-102,118-150`：结果绑定 connection、account generation、principal、network、revision、state；按当前 scope 投影结果，requestId 与 store generation 再拒绝迟到请求。设备条目必须属于当前 principal/network。未发现旧 scope 成功被当成当前成功的可复现路径。
- `src/renderer/api/agentNetwork.ts:231-253`：callable 使用指定 connection，分页 schema 校验、network 绑定、mount 去重、cursor 循环拒绝和条目预算；无法完整读取时保留 complete=false。
- `HostOnboarding.tsx:152-178,413-425,442-448,488-496`：ready/joined 独立判断；离线/同步不显示 stale callable 成功；callable 读取失败不抹除设备在线证据；零条不完整目录不会显示“尚无可调用 Agent”；完成只表示设备连接，有显式后续执行验收提示。
- `HostOnboarding.tsx:297-305,350-358,475-484`：安装和登录/入网均要求用户显式勾选；进入第四步不自动选择任何现有设备。
- `src/renderer/pages/AgentNetwork.tsx:570-586`：账号/网络变化重建向导；打开设备管理只把当前检查目标交给既有详情流程。
- 下载仅调用既有 `APP_WEBSITE_URL` 的 `/download/`，安装说明锁定当前基线 commit；未点击外部下载或授权。

确认缺陷：暂无 P1/P2。曾指出 P3：`HostOnboarding.tsx:168-169` 将 syncing 的执行状态写成“设备离线”；复核当前文件已改为 `syncing`，修复确认。Linux 命令说明亦已明确“目标服务器的源码仓库根目录（包含 scripts/host）”，避免用户在安装制品目录中执行不存在的脚本。

需要浏览器验证的风险点：CustomSelect 的选项 Popover portal 到 body，向导使用 modal FloatingFocusManager；须实测菜单可点击、Tab 能进入、Escape 仅先关菜单并返回触发器，不能以 fireEvent 测试替代焦点和模态交互验收。

### 独立 UI 工具边界

本审查 agent 通过 cua_repl 尝试创建自己的 `iab` 标签页，返回 `Browser is not available: iab`；一次 reset 后相同。inventory 仅列用户 Chrome/Brave 扩展。遵守授权未使用这些浏览器，也未触碰主 Agent 的 tab2。因此本人没有独立执行四步/窄屏/键盘交互，不将主 Agent 或 DOM 测试结果冒充独立交互验收。已将具体风险点交给具有 IAB 的主 Agent；待其截图做独立视觉复核。

### 截图独立视觉复核与最终源码结论

最后复核来源：工作区 HEAD `178b8047f78e51f843e5c0636d2e0182f192c8b1` 加当前尚未提交的 HostOnboarding/API/页面/双语文案改动；此记录不是合并后主干验收。复核最新源码没有确认的 P1/P2 遗留。

已实际通过 `view_image` 独立查看以下主 Agent IAB 截图：`host-onboarding-validation/step1-desktop.png`、`step2-linux.png`、`step3-linux.png`、`step4-online-empty.png`、`linux-760.png`。四步骤层级清楚，当前步骤与按钮状态明确；安装测试限制可见；在线状态绿色、空 Agent 独立呈现，未把“完成引导”表述为模型执行通过；760×760 截图中对话框、页脚与命令块均在视口内，无可见水平溢出或关键按钮遮挡，长内容使用内部滚动。截图未发现阻断视觉问题。

主 Agent 另报告真实 IAB 点选 CustomSelect 成功、Escape 关闭后焦点回到“+ 添加 Host”，760 宽 document.scrollWidth=760、modal 高684。此处将其作为主 Agent 的交互证据引用；本人仅独立审阅静态截图和实现，未独立执行这些交互，也未验证小于760宽的页面。截图中的网络地址/设备为本地模拟元数据，不是已加入真实 Host 的证明。
