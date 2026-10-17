# MOXBOTS-BROWSER-001

2026-10-17。范围：浏览器操作技能、对话/启动器工具菜单入口、资源状态恢复与 CLI 项目选择。权威仓库 heavenzhang/MoXBots；base main 348251b3。未接管统一桌面发布或修改日常数据。

## 用户可见结果

- 对话/启动器的工具菜单始终显示「Agent 浏览器」，不再因资源/全局开关未就绪而消失。安装/状态动作定位能力页的实际浏览器卡片，不打开无效的通用 MCP 参数弹窗。资源、全局可用、对话选择与 Runtime 连接分别显示；只有有效且新鲜的 ready 观测才称已连接。
- 工具页显示未安装、安装/更新、失败、ready 和 unsupported；ready 后说明如何回到对话选择。资源读失败有明确反馈和重新检查，旧查询失败不覆盖较新 owner 事件。unsupported 不提供无效安装按钮；窄区域工具卡片使用单列。
- 新增可自动发现的 `moxbots-browser` Skill，随系统 Skill v61 更新，可按普通 optional Skill 关闭发现；未扩充 required Skills。技能覆盖快照、导航、表单、截图、标签、失败恢复、Cookie 边界与不可信网页。更正 CLI Skill 的 MCP scope 和顶层示例；CLI 切换 browser preset 与 UI 使用相同项目互斥选择，全局可用状态不互斥。

## 验证

| 验证 | 结果与证据 |
| --- | --- |
| 定向回归 | 16文件531项通过：CLI、admin handler、Browser Host/Registry、工具状态、完整 composer、Settings 深链/查询竞态、browser 入口与系统技能合同。 |
| 类型/lint/Web 构建 | TypeScript noEmit、改动 TS/TSX eslint、MoXBots build:web 通过。最后相关修改后的确认见任务记录/PR CI；无新增依赖。 |
| 技能静态检查 | skill-creator quick_validate 用真实 PyYAML 环境复核通过（Skill is valid）。 |
| 主 Agent 实际 UI | Codex IAB，1280×720，现有 light/dark theme；真实 BrowserToolEntry/ToolboxSection、合成资源状态。执行安装入口、42%进度、就绪、全局开启、返回与选择、失败重试、unsupported。截图 ui-dark-settings.png；运行 `node dev-docs/browser-001/serve.mjs` 后访问 loopback8897/__browser。 |
| 设置接线 | 真实 Settings React DOM 测试证明深链滚动/focus资源卡片，不打开generic dialog；事件先到、旧read后失败时仍可开启。非原生系统 UI 验收。 |
| 独立审阅 | browser_skill 未参与UI实现；源码发现并复核两项查询失败/时序P2。该worker没有IAB，故未独立点击。最终源码结论见 ui-review.md；主Agent负责实际交互。 |
| 真实模型/浏览器 | Kimi Coding k3 → 生产 SessionEngine/SDK → `myagents-browser` → 生产 PlaywrightBrowserHost/Registry → 真实锁定官方 Chromium146.0.7680.0。加载新增Skill，导航本地合成站点、中文输入、点击提交、读随机回执、截图；terminal complete、页面回执、实际截图内容一致。见 provider-results.json / model-receipt.png。 |
| 新 Session | 原Context关闭并checkpoint后，新Product Session导航cookie-check，恢复合成Cookie，结果 RESTORED。仅证明Registry与合成identity服务交互，不证明真实Rust identity持久化。 |

真实测试采用独立0700临时HOME与配置、独立空workspace，只有父代理在内存读取既有授权Kimi key，SDK只收到随机loopback token。SDK子进程经既有Seatbelt profile仅允许两指定loopback服务；浏览器使用临时Context和受限测试代理。测试Session使用fullAgency但不是日常账号/配置的权限变更；workspace显式deny Bash/写文件等内置工具，实际执行只有Skill与browser MCP。没有业务账号登录、外部提交或生产数据写入。观察到的Node进程/进程组在清理后为空。模型工具的截图路径叙述并非路径authority；实际截图在workspace/browser-test-receipt.png，已按文件字节与视觉核实。

## 失败与资源记录

首轮CI拦截了验收MJS中的未用导入/空catch，以及Rust系统Skill版本测试仍固定60的遗漏；已清理脚本并将版本断言更新为61，同时验证浏览器Skill为optional而非required。随后完整`npm run lint`（包含依赖边界与agent-docs）本地通过。最终CI以PR最新头为准。


真实模型成功套件6个上游请求。之前HOME断言失败0请求、测试JSON响应头缺失2请求、合成表单缺UTF-8导致中文提交转义11请求；后者及时停止自有测试进程，未降低中文验收。总计19个真实上游请求，均已计入provider-results.json；不得只报成功6次。Token为上游各请求报告，货币账单未知。官方资源初次单连接下载与部分分段超时后按Range续传，最终176745207B及锁定SHA完整匹配后才解包运行，未把半包视为可用。

手动真实入口（不得进入自动CI；必须明确授权使用指定凭据）：

```sh
node dev-docs/browser-001/provider-run.mjs --approved-real-provider /path/to/authorized-config.json /path/to/locked-official-chromium
```

原始wire、配置、身份快照与SDK日志留在provider-results.json指向的私有临时目录，不进Git。公开/版本化证据只有合成网页内容、脱敏统计与哈希。

## 发行与验收边界

本次真实浏览器运行是headless；Rust capability/resource/identity authority为测试替身，模型使用真实产品facade与adapter。没有声明整个原生安装/真实账号生产流程已通过，也未证明其他Runtime或平台。窗口内实际WebView预览及真实登录Cookie不在本次成功范围。

桌面发布仍由唯一owner `01a12bc2-907a-7702-b6dd-788225c5dfe4` 执行，纳入下一未冻结版本；不修改0.5.8/0.5.9冻结包、不重启日常App、不改变公网/外部调用/模型权限。发布前需在精确候选原生包验证安装资源→全局启用→返回对话→Agent真实调用，再验系统技能v61同步和任务/会话配置兼容；生产是否更新以owner运行版本与回执为准。未获用户消息授权前不会主动通知另一聊天。
