<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/plan-review-content-20261015 -->
<!-- git-project-sync-task:base=205939249c057363d01163c6b0e4b6df717d5064 -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-PLAN-REVIEW-001: require visible plan content before approval

## Objective

MOXBOTS-PLAN-REVIEW-001：修复方案审核空卡。用户确认目标仓库 https://github.com/heavenzhang/MoXBots.git。当前 Agent 单独负责实现、UI、回归与 main 交付；不调用外部原因：明确采用 ai-yaoren-local 纯内置模式。模型精确标识/effort、token/费用未知，无模型切换或子代理。

## Acceptance criteria / To Do

- [x] 核实截图对应本机 2026-10-15 日志、产品 transcript：Write 项目 .agent-sync/plan.md 被 Plan hook 拦截，ExitPlanMode 未携带正文，仍广播空审核请求。私有业务内容不进入 Git。
- [x] 核实 origin/main20593924、隔离分支与工作树；observe/start/task-init PASS。
- [x] 仅允许 Write/Edit 当前 Product Session 专用目录的 Markdown，保持项目源文件及其他 Session 拒绝；符号链接/硬链接不可绕过。
- [x] 缺失/空白/读取失败/截断的方案返回可修复工具错误，不能发空审核卡或当作用户拒绝；完整方案先展示再批准。
- [x] 前端对 legacy 空请求明确提示并禁用批准，保留反馈与拒绝；长文、窄屏可读。
- [x] 相邻单元/真实 SDK callback 模拟集成/DOM 测试、tsc/lint/build；实际浏览器视觉与交互（主Agent负责，小范围缺陷不另设worker）。
- [ ] CI/review/main/远端包含性核实。
- [ ] 原生安装与真实模型验收：单独追踪，当前统一055安装任务活动且日常业务运行，不能替换、退出或重启客户端；不借用其QA窗口。

## Completed

实现、相邻回归、SDK callback synthetic集成、实际渲染UI、自审、web/server构建已完成并提交。PR：https://github.com/heavenzhang/MoXBots/pull/57 。CI/main尚待核实；原生安装/真实模型保持开放，不因源码交付宣称已发布。Git交付以PR实际merge状态、远端main包含性与外部delivery.json收据为准。

## Verification

- 本机日志明确 No session plan markdown found for current turn；真实 Write 结果为 Plan hook denied。业务正文恢复仅存项目本地 output，不提交 Git。
- SDK0.3.296 本地 sdk.d.ts / sdk-tools.d.ts 与官方 [hooks](https://code.claude.com/docs/en/agent-sdk/hooks)、[permissions](https://code.claude.com/docs/en/agent-sdk/permissions) 已核对。
- `vitest --project unit plan-files/plan-mode-gate`：34/34；`--project dom ExitPlanModePrompt`：5/5。最终空态副标题调整后 DOM5/5复验通过。
- `vitest --project integration session-transcript/builtin.integration.test.ts`：98/98，包括真实产品 canUseTool/PreToolUse 回调：空内容不发审核/不改模式；当前 Session 方案写入；项目文件拒绝；方案→反馈→修订→批准；超长正文拒绝。SDK transport synthetic，不冒充真实模型。
- 独立 loopback Vite fixture 导入产品 ExitPlanModePrompt、真实 Markdown、i18n与CSS；1100×850/390×850共4条完整/空态流程通过，长文末尾验收/回滚可滚动到、无页面横溢出、正文批准后保留、Enter反馈通过、0 page errors。最终空态文案另复验两尺寸。主Agent实现并验收，无独立worker；小范围缺陷使用主Agent拥有UI gate。
- 真实 SDK0.3.296 子进程+loopback脚本化API补测通过：沿用原生规划提示的指定方案路径，实际Write落盘→ExitPlanMode自动附正文→审核回调读到相同完整内容→允许后获得成功结果，3次本地脚本化响应，无真实供应商调用。首次fixture使用自行命名文件触发SDK自身保护，不计产品通过；纠正fixture后无需放宽SDK权限，失败日志保留。native-sdk-loopback.json / 脚本留本机证据目录。
- 最终 `tsc --noEmit`、changed-file eslint、`npm run build:web`（含license/theme验证）、`npm run build:server`通过。初次TS2745已修复并复验，repair-note.md留证。
- 本机证据：`/Users/zhangshaohua/Documents/WPS Cloud/【项目】目录/MoxBot/output/plan-review-001/`（browser-qa.json、full/empty截图、focused/integration/dom日志、临时fixture副本）。仓库不含QA入口、业务正文、账号或凭据。
- 选择依据：同一路径有顺序依赖，单Agent可直接完成；零子代理，无升级。不调用外部原因：明确采用 ai-yaoren-local 纯内置模式。精确模型/effort、token/费用未暴露，未知；没有成本节省测算。复盘：先读真实工具结果发现写入被拒绝，避免只补前端占位；后续沿用服务端与UI双门禁。

## Blockers and unknowns

正式客户端由统一055发布 owner 管理；本任务不并发打包/安装/操作活动业务 Session。UI mock与callback集成不冒充真实模型/原生验收。

## Next step

核实最终 tsc/lint/build；提交任务分支并完成CI/main交付；原生安装和真实模型验收交统一055发布窗口，不并发占用。
