# MOXBOTS-OUTPUT-003 独立审阅

基线：`c0f7649d8ca08e017001e24492d46952c23b0159`，分支 `codex/output-expanded-20261016`。只读产品源码，不提交推送，不操作真实App/用户Chrome。

## 验证边界

独立IAB未建立：`createBrowserTab('iab',...)`及按主Agent已验证browser ID `4`新建自己的后台tab均返回browser unavailable。未复用主Agent tab2或切换用户浏览器。**实际独立点击/响应式/键盘/UI gate未知**。主Agent自己的实际浏览器验收另记，不与本审阅合并为独立通过。

## 发现

| 严重度 | 具体复现与路径 | 状态 |
|---|---|---|
| P2 | 展开fixture `verify-runtime`，ProcessTiming显示执行耗时2340ms；BashTool resultOnly仍保留model.meta.durationMs，buildMetaItems再次显示耗时。`src/renderer/components/tools/BashTool.tsx` resultOnly投影及buildMetaItems。 | 已发送主Agent，待复验 |
| P2 | Grep result为`{"numLines":0,"content":""}`时，ProcessRow用原始JSON非空判hasContent；ToolUse resultOnly→ExpandableResult→unwrapSdkResult解成空字符串，箭头打开空白body。`src/renderer/components/ProcessRow.tsx` hasContent，`tools/utils.tsx` content解包分支。 | 已发送主Agent，待复验 |

## 已读代码及测试合同

- BlockGroup单条不再创建phase外层disclosure，直接展示ProcessRow；同一phase owner保留rowExpansions，并在手动打开时setExpanded，单条→多条追加时可保留展开。
- 多条展开时组摘要、组时间、组结果状态隐藏，逐条保留时间；按事件ID记录同文件重分组展开选择。相邻同文件成功修改仍保留逐次diff。
- ProcessRow空白thinking/raw空结果禁用按钮、无aria-expanded；Read结果标签使用原始file_path basename；thinking使用更紧凑间距。
- 计时权威链：Codex `item/completed.commandExecution.durationMs`→metadata，DSH `toolMetadata`有限投影→resultMeta；renderer仅取单条非child终态resultMeta.durationMs作为执行耗时，允许0。observed started/finished只生成观测跨度；thinkingDurationMs不再冒充执行时间；group不sum并行耗时。
- 源头代码：`src/server/runtimes/codex.ts` commandExecution分支；`src/server/integrated-runtimes/dsh/event-projector.ts` toolMetadata；`src/renderer/utils/processTiming.ts`；`src/renderer/components/ProcessTiming.tsx`。
- 新测试覆盖单条直接正文/时间一次、多条展开组摘要时间消失、raw空结果、active→complete、单条→多条、同文件重分组、观测0/1ms≠执行耗时、runtime0ms及组span。审阅者未重复运行主Agent正在执行的测试，不以读测试代替测试通过。

## 修复复核

- P2重复Bash耗时：已代码复核，resultOnly模型投影将durationMs置undefined，执行结果保留exit等有用状态；等待主Agent实际展开截图/测试结果补证。
- P2结构化空结果：已代码复核，ToolUse导出hasToolResultContent，共用usesPlainResult及unwrapSdkResult；对≤200k有界解析后判正文，ProcessRow调用相同投影判断；不再仅凭原始JSON非空产生箭头。

## 主Agent截图的独立静态复核

已用view_image查看 `evidence/01-single-expanded.jpg`（主Agent实际操作所得，非审阅者截图）：单条Grep已展开直接显示两行匹配正文，没有第二层工具卡fold；空thinking/raw空Read无箭头；非空Read保留basename；观测1ms没有展示成执行耗时；runtime明确0ms仍显示。所见截图布局清晰、thinking比工具结果紧凑。

该图中命名为history的fixture块在整个message仍live时显示running，符合现有outcome合同，但本图不能作为unknown状态验收；需切整个fixture执行完成后检查缺失结果为未确认。

## 最终三张截图静态复核

审阅者已逐张用 `view_image` 查看最终覆盖版 `01-single-expanded.jpg`、`02-light-narrow-expanded.jpg`、`03-english-narrow-expanded.jpg`。这些均由主Agent实际操作截图，**本节是非实现者静态视觉复核，不是独立点击验收**。

- `01`：非空分析、单条Grep、Read都已直接展示真实正文；没有夹在结果行与正文之间的第二层工具折叠。Read显示PayrollService.ts；空分析只有状态行无箭头；观测开始与执行耗时未记录清楚分开。截图所见无新增必修问题。
- `02`：浅色中文380px内容栏，追加后Grep变多条组且原正文仍可见；组标题只有类型与成功计数，没有重复组摘要/组时间；代码/匹配文本在窄栏自然换行，没有从卡片侧面伸出。空分析无箭头。层级、间距和展开方向清楚。
- `03`：深色英文380px内容栏，同文件两次更新保留逐次结果；首个diff直接显示，横滚条限定在diff内部。组标题无重复时间；Read CurrentCheck.ts已经完成并保持正文打开。Quality reference保持默认折叠，footer明确Cumulative edits。窄栏英文时间会自然换成两行，未遮挡状态/箭头。

当前没有从最终截图确认新的P1/P2。两项已报P2均已代码复验修复，主Agent报告已实际复验terminal页脚仅exit0、结构化零匹配无箭头。主Agent另报告已完成Enter组/Space逐次diff、active→complete、未知状态、宽/窄和主main无横溢出（clientWidth=scrollWidth=1265）；此处作为**主Agent执行记录**保留，不改写成审阅者独立实测。

独立浏览器gate仍未知：审阅者IAB不可用。可合并判断为“代码审阅与截图静态复核无剩余确认P1/P2，主Agent实际UI矩阵另有执行证据”；不能称独立浏览器完整通过，也不代表真实Provider/原生发行/生产验收。

## 用户气泡增量源审

用户新增截图指出气泡文字/留白和操作栏展示不友好，主Agent将Message用户分支纳入同一任务。审阅者读取了该用户截图与Message.tsx / Message.userbubble.test.tsx增量，不触碰产品源码。独立IAB仍不可用，未重新尝试。

源审：气泡px3/py2、rounded-xl，正文局部`--font-weight-prose`→normal400，strong保留既有emphasis600，Markdown字号选择不变；长文fade负margin同步新padding；发送失败说明保留flow且不出现rewind。操作栏改absolute后不再占气泡下方空行；80px预留可容纳两32px按钮+gap4+间距4。

**P2待修 — 鼠标hover可达性**：actions `right-full mr-1`在bubble与操作栏之间形成4px空隙，同时默认pointer-events-none只在group-hover/focus时恢复。鼠标慢速从bubble向左移到按钮，经过空隙时group:hover失效，toolbar立即不可命中，可能出现消失/点不到。已建议将间距移为toolbar自身padding-right（连续命中盒）或增加hover桥；需主Agent实际移动复验。键盘focus与hover:none触屏路径具有独立可达机制，不以此代替鼠标路径。

### 用户气泡修复与截图静态复验

P2 hover gap已修复：操作栏改为`right-full pr-1`，将原margin空隙纳入自身命中盒；预留宽度仍足够。审阅者已读最终class，未进行独立鼠标移动。

已用view_image查看主Agent新增 `04-user-bubble-wide.jpg`、`05-user-bubble-narrow-keyboard.jpg`：宽栏正文/气泡更紧凑且没有下占操作空行；浅色380内容栏回退与复制完整留在左gutter，键盘焦点轮廓清晰，合成本地回退计数1可见。没有从两图发现新增必修P1/P2。

截图证明所见布局和焦点状态；长文展开、failed说明flow、鼠标连续hover和触屏可达性的实际行为仍以主Agent的浏览器执行记录为准。本审阅对这些新气泡变更仅为源码+静态截图复核，不改写为独立点击验收。未新增运行时/审批/标题逻辑改动。

### 最终hover命中盒加固源审

已只读核对Message.tsx单行增量：`top-1 + items-center`改为`inset-y-0 + items-start + pt-1`，保留`right-full/pr-1`。absolute操作栏的命中盒覆盖整个气泡行高度，按钮仍位于顶部4px；不参与正常流、不增加消息高度，仍使用此前80px横向预留。可以覆盖从较低正文位置先向左移入gutter再向上到按钮的连续hover路径。未发现新的确定风险。elementFromPoint命中、rowHeight与实际hover行为由主Agent复验，本段不构成独立浏览器验证；未重复运行测试或重试浏览器。
