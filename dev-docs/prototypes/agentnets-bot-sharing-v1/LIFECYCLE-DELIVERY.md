# 管理员 Bots 生命周期原型交付记录

任务 BOT-ADMIN-LIFECYCLE-PROTOTYPE-20261013。仓库 https://github.com/heavenzhang/MoXBots.git ，主干main；分支codex/bots-admin-lifecycle-prototype，base5ee8f862。当前规划与合成原型已交付main；无真实服务开发或生产发布。

用户本轮要求新建、配置、启停、删除及所属用户/Host分配，先完善原型和规划，真实服务暂不开发。详细需求 services/agentnet/planning/BOT-ADMIN-LIFECYCLE-V1.md；已有两份规划、TODO和接续同时更新。客户端个人网络入口仍未来称Bots Net，本次不改客户端。

## 验证

先主审新建代表页，再固定HTML hash做独立视觉/交互/1440×900、768×1024、390×844响应式与共享回归，报告LIFECYCLE-UI-REVIEW.md。模拟与真实后端验收分开，未接API、模型、凭据、Host或业务数据。

- 新建代表表单布局、缺项校验、停止/共享关闭默认值已主审实际操作；阶段状态与窄屏详情反馈同一实现者修正。
- 首轮冻结97790已跑主要生命周期和必要共享路径，发现LB01校验后表单导航丢草稿、LB02刷新填回迁移已清空模型引用、LB03删除后全局累计用量下降，集中回交原实现者，不能宣布已接受。
- 最终固定HTML hash4f963fe34183ae1fe78315eec828691b482afe991fa877abb7607d6804cc0e25；独立视觉/交互/响应式接受，18项矩阵通过，LB01–03关闭；主审关键路径通过。
- 本地完整npm run lint通过（Node24/npm11.19）：ESLint、依赖边界0 errors/既有15 warnings、4项文档测试与62文档核对；另手工16份规划/原型文档本地链接通过。脚本ESM，未放宽规则。
- 源头 `159783a53b05c24c07d66d1204bfdd2cc05057be` 七项CI全通过：Test38355093484、Owned AgentNet38355093497。PR #18合入main锚点 `5652048579f776c5eebe9faebdbde212ce2b93c7`，fetch核验源码头为远端main祖先且合并树完全一致，原型hash保持4f963…；源头与远端任务分支一致、handoff gate通过。
- 关闭记录提交只改Markdown，包含准备期历史措辞，相关文档/差异/最终推送gate再核验。最终关闭提交SHA从main/Git获取，不写自身SHA自引用；main push自动复跑状态另从GitHub读取，不能把源码头CI当该头全套重跑。

## 协作执行

| 参与者 | 工作包 | 请求设置与证据边界 |
| --- | --- | --- |
| 主Agent /root | 权限/生命周期规划、代表页与关键路径主审、Git集成/main | 当前模型精确变体和effort未工具确认；未声称切换 |
| /root/sharing_prototype | 独占原型HTML，代表页、完整路径与修复 | 复用原gpt-6-luna / medium请求设置，实际型号/effort未知 |
| /root/sharing_ui_review | 只读实现，独占本轮验收与lifecycle-*证据 | 复用原gpt-6.1-sol / medium请求设置；启停/迁移/删除耦合授权风险，实际型号/effort未知 |

三名原生参与者，没有AIRouter调用或模型升级；token、费用和节约比例未知。已有紧凑设计合同供两位worker共享，没有新增缓存或协调层。准备期反馈与正式冻结后修复分开记录；正式集中修复1轮；首轮脚本选择disabled目标和新submit按钮导致的选择器调整单列，不计产品修复。一次待补验与修复召回重叠，已回到原冻结hash，fresh补验前后核验后再GO，不沿用编辑窗口结果。

复盘：沿用已接受管理员风格并先验新建代表页，使本轮聚焦生命周期。独立审阅识别表单导航、清空引用复活和全局累计遗漏，主审负责对齐状态口径。下一轮应等全部固定版本检查及选择器补验结束，再召回写入修复，减少冻结协调返工。真实平台执行权、双Host迁移恢复和生产能力仍待后续开发。
