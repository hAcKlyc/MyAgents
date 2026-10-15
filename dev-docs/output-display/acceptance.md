# MOXBOTS-OUTPUT-001 输出展示验收

日期：2026-10-15（Asia/Shanghai）。源码基线 main `5ebf2979c77e0d358fe6b3980fb57427028c453c`；隔离分支 `codex/output-display-20261015`。

## 用户可见行为

连续同类过程按原顺序聚合为计划、读取检索、文件修改、测试检查、命令工具、协作、思考阶段。正文仍留在原位置，不按类别重排，不生成尚未执行的未来阶段。Shell只按已知命令入口分类，描述/输出文本不作为通过证据，未知命令留在通用执行阶段。

每阶段显示状态文字、工具调用/思考记录计数、已返回/执行中/失败/中断/未确认统计和最近动作；有文件变更摘要或命令exitCode/duration时展示原有可信投影。多命令阶段的退出码明确绑定最近结果动作，防止其他成功命令的0被误归失败命令。工具返回不升级为任务完成、业务通过或已发布。

阶段详情默认折叠、可再收起，重型工具/思考内容只在展开时挂载。运行/失败/中断行常显；所有子Agent行常显，保留原状态面板导航锚点。行内动作描述及完整文件名优先，工具名退为次级信息，图标+文字区分状态。追加同类调用或新阶段不会重挂载已手动打开的行。

统一状态投影保留Provider归属，使用SDK/DSH别名及现有Shell解析和子Agent生命周期。空字符串结果为有效返回；失败/中断优先；历史遗留loading没有当前执行证据时显示未确认；明确背景子Agent生命周期仍可在父轮结束后执行。正文/attachment/artifact路径、thinking复制导出和会话滚动owner保持既有路径。

## 验证

| 层级 | 结果与边界 |
| --- | --- |
| 单元 | 90项通过：过程状态36、Shell transcript46、正文分组2、子Agent activity6 |
| DOM/回归 | 168项通过：阶段/工具行、Message/MessageList、引用/正文/媒体接线、Task/CollabAgent、聊天滚动 |
| 类型/lint | 完整typecheck、lint（含依赖边界与文档）通过；最终提交前复验 |
| 构建 | MoXBots profile web生产构建及8项主题registry/preset通过；最终提交前复验 |
| 主审实际UI | Codex IAB，生产Message/BlockGroup/ProcessRow，合成数据；默认折叠、双层详情、追加后保留、失败/历史/完成切换通过 |
| 独立审阅 | output_review（未实现源码）代码及UI通过；380×800浅/深色无横向溢出，默认视窗英文、动作换行、状态可辨、回折后失败仍常显通过。viewport已恢复 |
| 原生/真实业务 | 未验证；未启动/退出/替换日常App，未调用Provider或操作真实业务 |

一轮独立复核修复：失败阶段与成功追加命令的无归属exitCode0可能混淆；已加动作归属，并用DOM及实际UI复验。阶段开合及重要行终态收起通知原聊天布局owner。

证据：[执行中](evidence/running.png)、[失败与结果归属](evidence/failed.png)。截图只含合成数据。DOM证明所有子Agent锚点常驻；UI样例无真实子Agent，不声称真实跳转通过。

## 复验样例

`fixture.tsx`直接导入生产组件，不作为App入口/生产路由打包；只含合成数据，不读真实账号、文件或会话。

从仓库创建一个临时 `src/renderer/output-display-qa.html`，用 `script type="module" src="/@fs/<仓库绝对路径>/dev-docs/output-display/fixture.tsx"` 和 `div id="root"`。使用Node24，执行 `MYAGENTS_BUILD_PROFILE=moxbot npm run dev:web -- --host 127.0.0.1 --port 4329`，访问 `/output-display-qa.html`。顶部QA按钮分别模拟running/completed/failed/history、追加检查、明暗、语言，均不发真实工具或模型请求。临时HTML不纳入Git和发布。

## 主干与发布

待PR/CI/main交付。桌面原生统一发布由既有负责人串行进行；当前任务不抢占窗口或替换运行中的客户端。源码交付、构建、原生安装和真实会话验收分开记录。

## 执行记录

主Agent实现/集成/主审；独立审阅者output_review按本地协作技能指定gpt-6.1-sol medium，复杂状态及折叠交互需要独立判断。未调用外部模型。精确token、费用和节省量未知。有效收益是独立发现并复验关闭一次结果归属歧义；下一轮继续以混合成功/失败及流式追加作为首批验收案例。
