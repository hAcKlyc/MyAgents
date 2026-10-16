# MOXBOTS-OUTPUT-002

2026-10-16，用户接受六项截图优化并补充：只突出当前工作/结果/进度、逐项具体时间、低干扰模型执行质量信息。基线 origin/main 925947e8252467392685e5b9dc6231476d1e0d75，任务分支 `codex/output-results-20261016`。

## 用户可见行为

- 连续阶段顺序、失败/中断常显、子任务锚点仍由原呈现链路承接；完成卡在749px viewport实测约60px高。主视图移除“最近动作”、工具/命令名称；默认展示结果，进行中展示已有任务目的。展开只查看结果、差异和每次时间；搜索来源/任务管理卡和大结果显示上限保留。
- 连续同一完整路径的成功修改聚合；失败、不同目录同名文件和中间其他结果不合并。每次结果可单独打开，完成引发重分组时按事件ID保留用户打开状态。阶段不显示最后一次增删冒充总数；消息底部既有统计显式称“操作累计”，不称工作区净差异。
- TODO条展示真正的in_progress项，优先activeForm；不会把pending项或全勾TODO推导成整个任务通过。输入区横轴策略沿用main PR76，未重写输入或滚动owner。
- 质量参考默认收起，展示检查成功返回/失败、执行失败/中断/未确认及已有模型/Token用量；内容质量没有评估则显示“未评估”。重复工具不是重试证据，缺少请求边界不计算API延迟、吞吐或主观分数。

## 时间事实与所有权

`src/shared/executionTiming.ts`只定义可选事实；`ProductTranscriptContent`在原adapter事件创建入口记录startedAt，真实结果/内容终止事件记录finishedAt，正文/输入/结果实际事件采样lastActivityAt。均为epoch毫秒、source=observed，不代表供应商开始执行或纯API延迟。中间活动每epoch秒最多一次，距同秒最后事件小于1秒；start/finish保持精确毫秒。

沿原TranscriptWriter/SessionStore V2操作、持久化及renderer字段透传，不新增SSE事件、存储writer或执行owner。旧历史缺值未知，不用消息时间、Task旧fallback或UI挂载时间补造；冷恢复不伪造结束；附件晚更新不刷新时间；父轮结束不冻结仍在执行的child。重新激活子任务使用其当前可信生命周期时间，timingVerified=false保持未知。

每次结果可看开始/结束、耗时；运行时另显示已用时、最近活动和未见新事件的时间。并行阶段按墙钟跨度，不把并行耗时相加。已用时增长与最近活动固定分别表达等待和真实事件，不推断服务健康。

## 验证

| 层级 | 实际结果和边界 |
| --- | --- |
| 定向unit/DOM | 14文件158项通过，覆盖结果分组、历史/并行/错误、重分组保持打开、时钟、子任务再激活、bounded result和既有专业renderer |
| 消息/输入回归 | 16文件172项通过，覆盖Message/MessageList、流式正文/引用、输入发送/IME/建议/草稿及队列；额外状态/来源链接36项通过（部分重叠，不累加总数） |
| 持久化 | Store integration 25项通过，真实临时文件IO与冷恢复保持时间事实；这是合成runtime事件，非真实供应商/原生业务验收 |
| 时间写放大 | 新增1000个同秒delta回归先失败后通过：额外timing操作1000→0，跨秒真实事件1条，真实finish再1条且精确毫秒；不是整机性能基准 |
| 类型/lint/构建 | 完整typecheck、lint（含依赖边界/文档）、MoXBots web生产构建及8项主题检查、server构建通过；集成最新main后再记录组合结果 |
| 独立UI | 见review.md：生产React组件，本地合成数据；明暗、中英、380内容栏、键盘、失败/中断/历史、逐次diff、完成/追加保持打开通过 |
| 主审实际UI | 同一候选IAB补查真实SimpleChatInput+TODO组合；749×974 viewport、380内容栏，长URL换行与20行草稿，input overflowX=hidden/overflowY=auto，scrollLeft=0，scrollTop=1455.56>0，主main clientWidth=scrollWidth=732，TODO在textarea上方。补查为主Agent验证，非独立审阅 |
| 原生/真实供应商 | 未验证。未使用真实用户账号/付费请求、未安装或停止日常App，不能称已发布或业务验收 |

截图：[完成结果及手动展开质量参考](evidence/results-overview.jpg)、[长输入与TODO](evidence/composer-narrow.jpg)、[独立深色英文窄栏](evidence/review-dark-en-narrow.jpg)。均为合成数据。完成预览中质量面板由操作者手动展开，产品默认仍收起。

## 复验入口

`fixture.tsx`导入生产组件，不是发布入口。临时在 `src/renderer/output-results-qa.html` 写入root元素与script模块指向 `/@fs/<本仓库绝对路径>/dev-docs/output-results/fixture.tsx`，使用Node24与 `MYAGENTS_BUILD_PROFILE=moxbot npm run dev:web -- --host 127.0.0.1 --port 4337 --strictPort`，访问 `/output-results-qa.html`。开关覆盖完成/失败/中断/历史、追加、明暗/语言、380内容栏与实际输入组合；onSend=false，不发送模型请求。fixture按原输入owner报告的overlay高度预留空间，main自己纵向滚动；不使用固定300px掩盖输入增长。临时HTML不进入Git/生产路由。

## 交付与发布

主Agent负责集成、整体验收和main交付；timing_owner实现时间链路，output_review未参与实现并完成独立代码/实际UI审阅。两worker请求gpt-6.1-sol/medium；没有外部模型调用，精确token/费用未暴露，未知。独立发现关闭结果截断、专业结果交互、成功口径、child旧时钟和累计增删歧义，主审再补输入组合与采样性能。

CI/main以任务记录及实际远端状态为准。既定统一部署聊天 `01a12bc2-907a-7702-b6dd-788225c5dfe4` 独占own updater；本任务把发布请求queued到下一未冻结批次，冻结056不变，不自行签名、部署、重启、修改账号或向其他聊天发送消息。原生发布需验证逐项时间持久化、真实runtime普通对话、长结果/输入/TODO及业务路径，原候选/主干包为回滚依据。

## CI 首轮修复

首轮JS门禁在576文件单元池发现英文新增8个单复数键未在中文保持对齐（5866通过、1失败、5跳过）；属本任务遗漏，未放宽资源键/插值一致性断言。补齐中文对应键并保留中文原措辞，重新验证resourceParity与结果区回归后重新提交完整CI。原始失败日志由本地任务输出留存。
