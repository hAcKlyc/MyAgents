# MOXBOTS-OUTPUT-002 独立审阅

状态：本地合成 UI 独立审阅已通过；新增输入区组合仅独立代码审阅，实际补验由主 Agent 完成。下文保留首轮发现与复验过程。

## 已检查合同

- 根 CLAUDE、DESIGN 的状态可信、阅读优先、层级稳定与语义 Token 要求。
- 输入要求：结果/当前工作/进度优先；具体时间基于观测事实；不以计时冒充 API 健康；缺失未知；无主观质量分数。
- 关注完成/失败/中断/未知、连续同文件更新、手动展开保留、子 Agent 锚点、TODO 当前项。

## 首轮代码发现（均已修复，复验见后文）

1. **P2 — 通用结果绕过有界投影**：`ProcessRow.tsx` 的 resultFirst 直接将完整 tool.result 传给 ExpandableResult；ToolUse 原有 50k/200k 显示限额被绕过。大 Read/未知工具结果展开可能创建巨大 pre。复现：给普通 Read 设置 16MB 结果并展开。
2. **P2 — 专业结果交互丢失**：同一分支绕过非 Task、非文件结果 renderer，包括 CronTaskCard 的任务入口、WebSearch 的结构化可点击来源等。复现：展开已有 cron 创建任务成功结果或结构化 WebSearch 结果。
3. **P2 — 返回口径与计数不一致**：阶段 progress 将 counts.succeeded 代入“已返回”；一个成功一个失败显示 1/2 已返回，尽管失败也已返回结果。质量面板 checkCounts 也需同样明确“返回/成功”口径。
4. **待确认 — continuable 子 Agent 的时间生命周期**：getProcessOutcome 以子 Agent lifecycle 为权威，但 ProcessTiming 优先使用已终止 executionTiming；再激活 running 可能仍显示旧 finishedAt 与固定耗时。后端 chat:subagent-status 未更新该字段。应采用生命周期的真实时间或明确标注初次调用时间。

## 首轮静态检查边界

首轮仅代码审阅；实际本地 React 合成 UI、浅/深色、380px、英文、键盘及追加/完成保留展开状态尚待 fixture。不能据此声称原生客户端或生产验收完成。

## 修复复验与最终本地 UI 结论（2026-10-16）

首轮 1、2：代码复验通过。ProcessRow 重新调用 ToolUse resultOnly；原 clamp 与专业 WebSearch/Cron 分支保留，Bash 由有界解析器结果投影处理。未以大输出进行浏览器性能压测。

首轮 3：实际页面已明确显示“成功返回”，质量参考亦显示“成功返回 / 失败”，口径已修正。

首轮 4：代码复验已优先读取已验证子 Agent lifecycle；running 清除 launch 的旧 finishedAt；具体再激活由主 Agent 回归测试覆盖，当前 fixture 无子 Agent，不声称浏览器实测。

追加 P2：消息底部 TurnFileEditSummary 未区分累加口径；已修复并实际确认显示“操作累计 +2 −2”/“Cumulative edits +2 −2”。

### 实际 IAB 检查

地址 `http://127.0.0.1:4337/output-results-qa.html`，仅合成数据，生产 React Message / BlockGroup / ProcessRow / AgentStatusPanel。审阅者独占自己的后台 IAB tab，未触碰用户 Chrome 或日常 App。

- [x] 浅色中文、深色英文、380px 内容栏：层级清楚，折叠完成卡紧凑；无主页面横向溢出（main clientWidth=scrollWidth=1280）。380是内容栏宽度，非实际浏览器 viewport。逐次文件 diff 在自身内部横滚。
- [x] 进行中只常显当前工作与一份计时；Elapsed随时间增长，Last activity保持观测时刻，No new event for增长，不冒充API健康。
- [x] completed / failed / stopped / history：成功、断言失败、中断可见；旧历史为未确认、时间未记录，无伪造计时。
- [x] 同文件两次成功修改显示为2 updates，两次结果各自可展开，分别保留内容、时间与逐次 +1/−1。
- [x] 手动打开进行中结果，切completed后仍打开；追加检查后仍保留Tests 24 passed结果与打开状态。
- [x] 键盘Enter打开阶段，Space打开逐次结果，focus轮廓可见。
- [x] 质量默认收起；打开只显示2成功/0失败、执行信号、既有Token输入1200/输出450、fixture-model及内容未评估；无主观分数。
- [x] TODO条显示Todo 1/2和实际进行项；未完成任务不被当前检查成功冒充完成。

截图：`evidence/review-dark-en-narrow.jpg`。

### 当前结论与证据边界

当前未留存已确认、未修复的P1/P2。通过的是本地合成UI与上述代码复验，不代表真实Runtime联调、原生客户端、生产发布或业务验收。fixture未包含ChatInput，无法在此实际验证PR76底部输入横条；需由主 Agent 的输入区回归或统一原生验收补足。子Agent锚点与再激活没有在本fixture浏览器覆盖，需结合主Agent测试证据。

## 输入区补充审阅（仅代码，IAB 不可用）

主 Agent 已将真实 SimpleChatInput、ConfigDataContext、ToastProvider 与 AgentStatusPanel 的 agentStatusSlot 加入合成 fixture；onSend 返回 false，draft 为本地合成输入。

本次补查无法恢复先前 IAB：旧 tab reload 报 browser unavailable；同一 iab 新建亦不可用，inventory 无 IAB。未改用用户 Chrome、Brave 或日常 App。没有新增composer截图，不能将新增组合计入独立浏览器通过。

代码核对：fixture 使用相对定位、minWidth:0 的300px composer容器，宽/窄栏inline maxWidth 896/380；TODO与队列是输入容器外同一flex行，展开不会插入输入内容层；agentStatusSlot仍由原输入owner承接。长URL换行、上下滚动与TODO展开是否遮挡仍需主Agent实际浏览器或项目可复现回归证据。

英文单数 `files_one: Updated {{count}} file` 已存在；上一轮独立IAB AX亦实际确认“Updated 1 file”。
