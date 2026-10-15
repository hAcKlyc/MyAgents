# MOXBOTS-PROJECT-CONTEXT-001 验收记录

代码实现与本地/隔离验收；生产发布交指定统一发布会话。

- 相关7文件189项单元/DOM回归通过；新增10项真实SessionStore文件持久化集成通过。
- 类型检查、完整lint（含依赖边界/文档链接）、服务端bundle、正式Web构建和主题验证通过。CI/main状态以任务最终记录为准。
- 非实现者独立审查：project_context_review，requested gpt-6.1-sol/medium；发现并修复两项P2：adapter retry绕过准备入口、关键词删行丢失决策适用范围。复审通过，独立Node24运行5文件162项成功。主Agent另核对4Runtime首发和重试链路。
- 浏览器：Codex IAB后台打开 `http://127.0.0.1:8894/__project_context`，实际React组件/实际主题与CSS，配置服务为合成测试替身，无真实项目读写。默认开启、关闭、Space键恢复、模拟失败保持原值并提示均通过。1024×768浅色、540×720深色均可读，无横向溢出（scrollWidth=clientWidth=540）；截图同目录。UI由主Agent复核，低影响单开关不另增UI实现者。
- 重现：Node≥24.14，`node dev-docs/project-context-validation/serve.mjs`，仅loopback8894。服务不是生产交付。

## Token实测

`token-metrics.json` 为 tiktoken0.12.0 对完整新增envelope的合成计数，不是供应商账单：

| 样本 | 附加UTF-8 bytes | o200k_base | cl100k_base |
|---|---:|---:|---:|
| 1个来源会话 | 1802 | 510 | 606 |
| 3个来源会话 | 3350 | 1008 | 1132 |
| 24会话压力、接近预算 | 6010 | 1585 | 1951 |

背景body硬限6000 bytes，外层新增38 bytes。分词器不同结果不同，不把样本上限说成所有模型的Token硬限。若原输入为10000 Token，3会话样本增加约10.1%–11.3%；这是例子，非用户实际账单。若原输入2000则相同比例更高。后续轮次不重新追加，但已带入部分仍可能参与计费；命中cache与compaction会影响实际增量。

可重现文本：`node --import tsx/esm dev-docs/project-context-validation/measure-tokens.mjs`，用指定供应商分词器计数。测量工具仅在临时venv，不给产品增加依赖或模型调用。开发协作token/费用未由runtime提供，未知；上述仅是产品新增上下文的样本测量。

## 开放门槛

真实Provider是否按背景正确回答、签名安装包、正式客户端开关/重启持久化和真实用户路径尚待统一发布会话在安全测试身份中验证。本聊天未安装、启动、退出或测试日常App，未操作生产。第一期仅普通新桌面聊天，既有会话实时更新/跨worktree合并/完整历史穷尽不在范围内。
