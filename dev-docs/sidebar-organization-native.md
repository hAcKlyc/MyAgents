# MOXBOTS-SIDEBAR-ORG-001 原生联合包验收

本报告覆盖实际 `/Applications/MoXBots.app` 的侧栏，未发送消息、调用模型、改网络配置或操作系统凭据。安装/退出/重启由既有安装owner串行负责，主Agent在明确交出的UI窗口内独立验收。

## 安装对应关系

- 用户在本任务明确允许精确联合包a8a60f1c安装和验收；该内部包本地签名、未Apple公证，未发布正式自动更新。
- 联合source `a8a60f1c923506ba97fde6ddcbedbdac6c0b2e93` 含侧栏main `c21e9f43f9f8ffb629f88fd09e4c680b86de5b30` 和原owner凭据修复。五份core产品hash、中英文16个变更键与侧栏验收源码相符；不声称联合包包含后续每一条main提交。
- ZIP SHA256 `d7945d31cf67ed439bc3288f4af69518438d2b31213367d6d7236e8e03f44f8c`，346132107 bytes，主Agent独立重算匹配。
- 实际运行 `/Applications/MoXBots.app/Contents/MacOS/myagents`，签名exe SHA256 `fedd00d99d5e24d11f1bb9db6a983f42d406827bef43555ca81b4205983e1677`。主Agent验deep/strict签名及运行路径，重启前PID96746、后PID5700，同一binary hash。
- owner保留前一6ac App及原b116回滚；未触碰原MyAgents。原生完整AX/截图/installer回执保存在主Agent私有验收目录，不提交真实环境截图/身份/内容到Git。

## 实际行为

| 路径 | 结果 |
| --- | --- |
| 新建两个临时分区 | 通过 |
| 整行拖现有可控合成聊天到分区接收区域 | 通过 |
| 从分区打开原聊天、项目归属、原内容和附件引用 | 通过 |
| 更多→移动到分区→原Agent下→保存 | 通过 |
| 整行拖Agent进分区，携带未单独整理的子聊天 | 通过 |
| 分区重命名、折叠与展开 | 通过 |
| Space/Up/Space分区排序 | 通过 |
| owner正常CmdQ退出后重开，名称、顺序与折叠保留 | 通过 |
| 产品恢复上次标签页，原合成聊天/内容/项目保留 | 通过 |
| 删除含Agent分区，资源回原侧栏；清理两处临时分区 | 通过 |

本次只有一个实际Agent及一个既有可控聊天，没有创建真实业务Agent或第二条会话。原生不重复声明成对任务/Agent排序已测；该行为已由合成renderer的真实pointer/keyboard用例覆盖。

分区原生CUA pointer尝试未改变顺序，未列为通过；分区键盘排序及同产品renderer的分步真实pointer排序通过。未据工具动作成功推断界面已排序，也未把原因未经证实的自动化结果称产品缺陷。Task/Agent整行原生拖入分区的结果由实际AX与导航/资源状态验证。

## 统一更新尚未关闭的门槛

前置6ac迁移中，旧云会话及签名钥读取验证成功，但新slot保存失败，ledger未提交；该问题由原owner继续处理。侧栏重启没有发起凭据授权，主AgentUI窗口未见权限窗；这不证明凭据恢复或网络联调成功。当前侧栏原生行为完成上述覆盖，统一凭据/网络更新验收仍未完成。

补充证据PR28首轮CI：五项成功，typecheck/lint/tests/build job在未改动的PermissionPrompt复制测试失败（DOM2221通过/1失败，未找到copied提示）。完整失败日志保留本地，主Agent同文件11项针对性复验通过；未改该组件/测试，精确收尾HEAD CI继续追踪，失败不被忽略。
