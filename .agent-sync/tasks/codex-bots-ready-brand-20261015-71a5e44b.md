<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-ready-brand-20261015 -->
<!-- git-project-sync-task:base=bf1851e4e2b914211e434f5b921a1bcefb9bba93 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# MOXBOTS-BOTS-READY-056-20261015

## Objective

用户明确确认：MoXBots侧栏菜单Bots Ready；页面标题Bots 网络（英文locale为Bots Network）；欢迎语Your bots are ready.。纳入0.5.6，冻结0.5.5/官网下载发布由原任务继续，日常客户端不操作。本任务的专用worktree为/Users/zhangshaohua/Documents/Codex/2026-10-15/moxbots-bots-ready，与heartbeat使用的metadata worktree分开。

## Acceptance criteria

- [x] canonical仓库https://github.com/heavenzhang/MoXBots.git及start/task-init通过；原055及日常App未改。
- [x] MoXBots profile的中英文菜单/页面/标签及欢迎语接线到i18n；MyAgents profile保留原文字，实际网络名称不被品牌覆盖。
- [x] 页面只有一个h1，真实network picker独立保留；欢迎语不冒充ready状态或把未知计数变成0，说明按钮仍可用。
- [x] 2品牌unit、117相关DOM（header/selector/page/sidebar）、tsc与changed-file ESLint通过；首个新DOM用例因setup已缓存默认profile而失败，beforeEach清module后修复，无产品门禁放松。
- [x] 原样组件隔离浏览器：中英文、宽窄视口、真实network selector/说明弹层及Escape、counts/long-name布局；视图数据合成，不冒称原生或真实Host联调。
- [ ] 同步最新main（056版本接续）、相称CI/PR/main交付及远端SHA/tree核实；告知既有统一打包负责人纳入056，不重打055。

## Completed

moxbotsCopy拥有新文案与owned网络说明；i18n对owned profile覆盖tabs/globalSidebar/agentNetwork，不全局替换protocol/official服务标识。NetworkHeader拥有owned页面标题/欢迎语，NetworkSelector在owned模式只负责连接选择，避免重复h1；上游保留旧结构。onboarding标题改为资源文案。现有tab module用i18n投影静态标题，所以旧持久化标签不需要数据迁移。

## Verification

本轮无付费/外部模型、无GUI/凭据/Host/服务/网站操作。复用完全一致依赖图的既有node_modules（只差release版本字段），不安装/修改共享依赖。私有验证输出在/tmp/moxbots-bots-ready-*.log，脱敏UI证据已保存dev-docs/bots-ready-validation及pointer output/bots-ready-056-20261015；4组浏览器真实组件交互/样式/截图通过，无外部请求，不代表完整App或native安装。

## Blockers and unknowns

原生0.5.6安装不在本任务范围，由统一负责人后续发包；当前客户端不会立即改变。055下载门槛保持原值，与本任务独立。当前primary无法通过本回合支持的控制确认切换模型，未声称切换；零新worker，主Agent负责小范围UI验收。不调用外部原因：沿用ai-yaoren-local纯内置模式；费用未计量。

## Next step

本地与浏览器验收通过；同步最新main（包含056版本及已接受输出显示改动），核组合回归后提交本任务文件并走CI/PR/main。主Agent是UI质量owner，本次是小范围文案及页头层级回归，不安排额外reviewer或原生窗口。
