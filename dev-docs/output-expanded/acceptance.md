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
- 修复后7文件89项定向测试通过；全量DOM首轮4文件10失败/2438通过及一个Toast teardown异常（372秒，含多项超时）；同一代码/断言/timeout，maxWorkers=2/minWorkers=1完整287文件2448项通过（279.58秒）。首轮原始日志保留，不掩盖并发下时序失败；气泡新增另有46项回归和最终CI。
- MoXBots web构建、Theme CSS和8项主题测试通过；typecheck与lint（含依赖/文档检查）通过。
- CI、最新main合入与远端包含核验待完成；不把工作分支或本地通过当作主干交付。
- 桌面发布Required，排既定唯一owner `01a12bc2-907a-7702-b6dd-788225c5dfe4` 下一未冻结批次。无配置/迁移/权限变化，不改已冻结发行版，不并发安装/重启日常App或发布服务器。未向其它聊天发送消息。

## 用户消息补充验收

用户在本任务期间进一步要求改善右侧用户消息展示，纳入同一PR：气泡px3/py2、rounded-xl，普通正文使用已有normal=400，保留字号选择与显式strong语义。复制/回退改为气泡左侧浮动工具栏，预留80px gutter，默认hover/focus淡入，hover:none显示；时间在title及无障碍文本保留。失败文案仍在正常流中，长文折叠渐变跟随padding调整。

主Agent后台IAB tab3，生产Message与合成数据：

- 宽栏普通两行：bubble/userRow高度均60.80px，padding8px12px，正文14px/weight400，操作栏不额外占行。[04实际图](evidence/04-user-bubble-wide.jpg)包含消息与单条结果展开组合。
- 浅色380内容栏：键盘Enter触达回退，本地callback计数1；toolbar right=538.5=bubble left，toolbar left466.5完整在内容栏内，main横溢出0。[05键盘图](evidence/05-user-bubble-narrow-keyboard.jpg)。
- 短消息“好的”气泡52×38.40px，userRow同高；无固定大块或额外动作行。
- 30段长消息实际点展开：collapsed401px→expanded3051.81px，保留30段及user-message-expand布局通知。
- 失败态实际显示发送失败，回退入口0，复制保留，main横溢出0。附件与Markdown格式通过既有消息回归；未声称新增实际图片预览或原生剪贴板联调通过。
- 复制按钮实际可点击；IAB剪贴板工具读回为空，未据此宣称系统剪贴板内容验证。回归mock核对copyPlainText接收原始正文/换行/Markdown，并确认回退绑定正确messageId、strong仍为STRONG。

独立源审发现工具栏外margin产生4px hover断点，已改为工具栏自身padding形成连续命中区域；主Agent验证两盒边界相接、键盘及按钮实际点击，不冒充工具不支持的慢速指针逐帧测试。独立审阅者静态inspect04/05，无剩余确认P1/P2。新增消息/滚动回归46项通过。原生和真实业务仍另验。

最终新增气泡合并后，11文件140项定向全部通过（5.28秒）；typecheck、lint/依赖/文档、MoXBots web和8项theme再次通过。287文件2448全DOM为追加气泡之前同源结果区候选；完整当前候选由PR91 CI再验，不能将前者冒充气泡后全量结果。

最终hover加固：工具栏命中盒覆盖气泡整行高度，按钮仍距顶部4px。主Agent在浅色380内容栏实际把指针移到气泡左下相邻位置，移除键盘focus后读取 `toolbarHovered=true / opacity=1 / pointerEvents=auto / keyboardFocusWithin=false`；底部相邻点命中工具栏。气泡、用户行、工具栏均高83.195px，main横溢出0，见[06实际指针图](evidence/06-user-actions-hover.jpg)及[DOM几何记录](evidence/hover-region.json)。46项消息/滚动回归再次通过（3.10秒），Message单文件eslint通过。独立源审确认该单行样式增量，无新增确定风险。

主干并发更新已整合：登录识别回归14文件180项通过；再同步任务草稿恢复main `47c80242` 后19文件231项通过。最终候选仍需完整CI，以PR91和外部任务记录的最终交付证明为准。
