<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/output-expanded-20261016 -->
<!-- git-project-sync-task:base=c0f7649d8ca08e017001e24492d46952c23b0159 -->
<!-- git-project-sync-task:status=ready-for-review -->

# MOXBOTS-OUTPUT-003 — 展开结果去重与可信时间

## Objective

用户接受展开区审阅方案，重点修复单条结果双层展开、重复信息和耗时口径，并要求改完实际展开验收。权威仓库 https://github.com/heavenzhang/MoXBots.git；分支 codex/output-expanded-20261016；base c0f7649d8ca08e017001e24492d46952c23b0159。

## Acceptance criteria / To Do

- [x] 核实源码/main/remote及隔离分支，保留其他任务工作树。
- [x] 单条结果只展开一次直接见正文；无内容无箭头；多条保留合理分组。
- [x] 展开后无重复摘要/组级时间；用户展开选择在追加/完成/聚合后保留。
- [x] 实际执行耗时仅采用runtime报告；观测时刻/跨度与等待明确区分；未知不伪造。
- [x] 最终11文件140项定向、typecheck、lint/依赖/文档、MoXBots web及8项theme通过。
- [x] 主Agent实际生产React页面中文浅/深、英文、窄栏，逐项点击/键盘/迁移通过；独立代码与截图审阅完成。
- [ ] 独立浏览器点击：reviewer IAB不可用，未转用Chrome；主Agent已补齐实际UI矩阵，限制保留。
- [ ] CI通过、同步最新main、提交/合入/推送且远端main包含核验。
- [ ] 原生发行和真实用户路径：交既定统一发布owner下一未冻结批次，不并发发布/安装日常App。

## 会话消息补充范围（用户新反馈）

2026-10-16用户进一步指出红框用户消息展示不友好，纳入同一呈现修复：减少气泡内边距，复制/回退操作在左侧预留gutter悬停/键盘focus浮现，不再占气泡下独立一行；普通正文遵守原prose字重，保留显式强调、附件、长文折叠、失败态和复制/回退能力。不变更会话标题或业务审批规则。新增实际宽窄/短长/失败/键盘验收后再最终提交。

- [x] 用户气泡/操作栏宽窄、短长/失败/键盘实际验收，46项消息/滚动回归；附件既有回归。独立源审及04/05图静态复核。

## Completed

单条直达正文、多条展开去组级摘要与时间、空结构化结果无箭头、Bash内部耗时去重已实现。运行时duration与观测span/等待已分离。主Agent实际IAB矩阵及非实现者代码/截图审阅完成，详见dev-docs/output-expanded/acceptance.md。用户气泡新增最终full-height hover命中盒，主Agent实际指针移入底部gutter、无键盘focus时仍保持工具栏可见；46项消息/滚动回归再次通过，独立源审完成。已同步main47c80242及19文件231项关联回归。

## Ownership / contract

主Agent实现BlockGroup/ProcessRow/结果来源、测试fixture、整体验收与Git集成。timing_owner独占processTiming/ProcessTiming及相邻测试、chat.json时间文案；请求沿用gpt-6.1-sol medium。output_review将在实现后独立只读UI审查（重复缺陷涉及交互层级和时间语义，使用既有sol medium角色），浏览器各自独立tab串行验证。纯内置，不外调；主Agent模型未切换，token/费用未知。

UI基线：沿DESIGN语义token与14px正文/12px元信息；单条直出结果行；多条展开仅保留组标题与真实计数，正文行各自一次时间；思考记录紧凑。时间span是观测事实，不冒充API延迟或健康。

## Verification

记录于 dev-docs/output-expanded/acceptance.md；初轮33项UI和11项时间、修复后89项定向、5项i18n、全量287file2448项通过；新增气泡46项通过，web/theme通过。矩阵：单条Read/Grep/thinking/empty；多条折叠/展开；active→complete、单条→多条、同文件聚合；failed/stopped/legacy；runtime 0ms和observed 1ms；keyboard Enter/Space；896/380内容栏、浅/深和中英。均合成数据，不能替代原生/真实Provider。

## Blockers and unknowns

首轮全量DOM287文件出现4文件10失败和一个Toast环境销毁后异常（372秒，多项超时）；日志保留。同一结果区代码、相同断言/超时，maxWorkers=2/minWorkers=1全量287文件2448测试全部通过（279.58秒）。用户气泡新增改动另验。独立reviewer IAB不可用，未冒充独立点击通过。原生/真实Provider/生产仍由统一owner另验，发布排队不计作本地通过。

## Deployment request

Required：桌面执行结果区。排入唯一桌面发布聊天01a12bc2-907a-7702-b6dd-788225c5dfe4下一未冻结批次；既有冻结包不变。无配置/迁移/权限变化，回退沿既有发行机制。源码/main、local UI、真实Provider、签名原生、生产验收分开。未向其它聊天发送消息。

## Next step

等待PR91最终候选完整CI，合入并核实远端main包含。部署请求保持下一未冻结批次。
