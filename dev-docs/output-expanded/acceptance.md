# MOXBOTS-OUTPUT-003 — 单条展开、信息去重与时间口径

2026-10-16。用户接受输出区审阅方案，要求优先修复单条结果双层展开、重复信息和时间口径，改完实际展开验收。本文记录当前分支的本地验收，CI/main和统一原生发行分别追踪。

## 实现与口径

- 单条 chronological phase直接呈现一个ProcessRow，无阶段折叠、1/1和第二份摘要。一次点击直接正文；无实际正文（包括结构化空Grep/Read）无箭头。
- 多条展开保留组标题和真实计数，隐藏组级结果摘要/时间/成功图标；每行独有时间。关闭再开、单条追加成多条、运行转完成及同文件聚合保留用户选择，未重排原始事件。
- 完成分析使用紧凑行；Read有真实file_path时显示文件basename，不生成未经验证的业务结论。
- `resultMeta.durationMs`来自Codex item.durationMs或DSH result metadata，仅作为运行时报告的执行耗时；真实0合法。`thinkingDurationMs`由Date.now差生成，不能冒充runtime耗时。
- `executionTiming`只描述观测开始/结束；UI行内显示观测开始和执行耗时/未记录，结束完整日期、观测跨度和来源在title。运行时分别显示已等待/最近事件/静默；不推断服务健康。多条仅显示整段跨度，绝不相加并行耗时。
- Bash resultOnly内部页脚不再重复duration，保留exit证据；专业结果renderer、有界正文与媒体保留。

## 实际页面验收

主Agent拥有实际UI验收。地址 `http://127.0.0.1:4338/output-expanded-qa.html`，当前隔离工作树Vite、生产Message/BlockGroup/ProcessRow/ToolUse；fixture见同目录fixture.tsx。后台IAB tab2，未使用用户Chrome/日常App。合成数据不调用真实Provider，不代表原生或生产业务。

| 步骤 | 动作与预期 | 实际结果 |
| --- | --- | --- |
| 1 | 单条Grep点一次，直接看到匹配正文 | 通过；仅一份结果标签/时间，无组级标题/第二fold，01图 |
| 2 | 展开单条thinking及Read | 通过；真实分析/文件正文，复制导出入口保留，01图 |
| 3 | 空thinking、原始空输出及JSON零匹配 | 通过；无展开箭头；零匹配展示0条，回归同时覆盖Read空file.content |
| 4 | 已展开单条追加同类结果成为多条 | 通过；原正文保留；组头无摘要/时间，02图 |
| 5 | 展开命令结果 | 通过；外部执行耗时2.3s，内部只有exit0，没有第二份耗时 |
| 6 | 当前执行partial打开，再切完成 | 通过；正文替换为完成结果且仍打开；等待/静默停止，03图 |
| 7 | 多条变更组Enter，第一条结果Space | 通过；一次逐次展开显示diff；组头无重复时间，03图 |
| 8 | 中文浅色380内容栏、英文深色380内容栏 | 通过；元信息换行、focus可见；main clientWidth=scrollWidth=1265，diff自身内部横滚，02/03图 |
| 9 | 失败/中断/未知及时间 | 通过；保留失败/中断/unknown；旧数据时间未记录；观测0/1ms不显示为执行耗时，runtime0ms保留 |
| 10 | 质量参考 | 默认收起；既有证据口径不变，未生成主观质量分数 |

浏览器viewport为1280×720，896/380是内容栏maxWidth，不冒充实际380px设备viewport。截图JPEG原始1280×720，保存后逐张view_image检查：

- [01 单条实际展开](evidence/01-single-expanded.jpg)
- [02 浅色窄栏追加结果](evidence/02-light-narrow-expanded.jpg)
- [03 英文深色窄栏差异与完成保留](evidence/03-english-narrow-expanded.jpg)

## 独立审阅与修复

output_review请求沿用gpt-6.1-sol medium，因重复交互缺陷和时间语义需非实现者判断。发现并复验修复：Bash内部重复duration、JSON空匹配有箭头。其IAB不可用（新建iab及已知browser4均失败），未转用Chrome；因此独立点击gate未覆盖，代码和最终三图静态复核完成。主Agent补齐上表实际点击、键盘和窄栏验证。详细边界见[review.md](review.md)。

主Agent实现UI/集成/实际验收；timing_owner实现时间及测试，请求沿用gpt-6.1-sol medium。没有可确认的主Agent模型切换；不外调。token/费用未知，不声称节省比例。复盘：结构化空结果必须按最终renderer投影判断；测试fixture必须同时包含单条与多条，不能仅测折叠态。

## 自动验证和交付

- 时间11项和主UI33项初轮通过。
- 修复后7文件89项定向测试通过；全量DOM首轮4文件10失败/2438通过及一个Toast teardown异常（372秒，含多项超时）；原始日志保留，maxWorkers=2/minWorkers=1完整复验中，不放宽断言或timeout。
- MoXBots web构建、Theme CSS和8项主题测试通过；typecheck与lint（含依赖/文档检查）通过。
- CI、最新main合入与远端包含核验待完成；不把工作分支或本地通过当作主干交付。
- 桌面发布Required，排既定唯一owner `01a12bc2-907a-7702-b6dd-788225c5dfe4` 下一未冻结批次。无配置/迁移/权限变化，不改已冻结发行版，不并发安装/重启日常App或发布服务器。未向其它聊天发送消息。
