<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-20261014 -->
<!-- git-project-sync-task:base=43994b75ca9278420ecd352af2e0cc663f4a7cdc -->
<!-- git-project-sync-task:status=complete -->


# Task: MOXBOTS-PROJECT-BOARD-001: workspace execution overview from PB-002

## Objective

实现用户已批准的 PB-002 工作区执行看板。当前Agent直接执行；仓库由用户明确确认 https://github.com/heavenzhang/MoXBots.git。主线程实现/集成/验收/主干交付；原生安装与已有活跃owner串行。

## Acceptance criteria / To Do

- [x] 核对仓库/最新main/指令/原型/数据authority，并创建隔离worktree。
- [x] 项目入口不改变展开或原对话行为；每工作区独立看板Tab。
- [x] Task与未关联Session均可见，关联会话不重复计数，不把idle当完成。
- [x] 四组状态、待开始入口、紧凑列表、搜索、窄面板分组和侧边详情。
- [x] run/rerun/status/get/doc使用既有owner接口；问题与权限回原会话处理。
- [x] 实际React页面点击、错误恢复、草稿/筛选保留、键盘与适配检查及独立UI审阅。
- [x] 同步最新main后typecheck/lint/99项相关用例/12组隔离交互/MoXBots build:web通过。
- [x] PR31六项当前头CI及远端main核验；merge cda773cf，16个产品文件hash一致。
- [x] 安装owner交付候选源/签名/回滚对应证据；5f1a8feb已真实安装，项目看板Native关键路径通过。
- [x] 官网公开包匿名全量下载、大小、SHA256及ZIP完整性与本地候选包一致。

## Decisions

Rust TaskStore/TaskApplication保持任务authority。Session列表不含持久实时状态。沿用现有 `session/state` owner-addressed只读接口做有限项目快照；不启动Session，不增加模型Turn，不持续轮询全部Sidecar。快照时间和失败必须可见。普通未关联对话单独保留；idle或无owner只表示未在执行，不代表业务完成。

Tab由现有App/module registry统一管理，新增工作区看板variant，无第二份全局当前页面。问题/权限不跨Tab裸响应，进入原Chat执行既有request-owner handlers。实际字号/主题遵循DESIGN.md，不能照搬原型9/10px字阶或硬编码深色。

## Completed

观察/start/task-init门禁通过；base 43994b75ca9278420ecd352af2e0cc663f4a7cdc。依赖复用既有node_modules，无重新下载。原型及其QA在本地PB-002目录，产品改动只在此隔离worktree。

## Verification / execution record

- 只读数据审计：board_data_audit，请求gpt-6-luna/medium；无写入/部署，报告Task/Session及activity来源。精确运行模型/用量未获工具确认。
- 主Agent负责整体；独立UI审阅后续启动，避免同时占用真实App/浏览器。
- API/布局/真实联调/发布分别记录，不用fixture代替生产证据。

## Blockers and unknowns

安装、桌面验收与官网发布均已完成；其余未验收边界见dev-docs/project-board-native-acceptance.md。没有新增付费模型执行授权，本次未启动模型任务。

## Next step

已完成源码main交付、5f1a8feb统一客户端安装、真实桌面关键路径验收，并独立比对官网匿名全量下载件。PR35已由6项CI通过后合main8f53a6ad；用户手动解锁并重新获得独占UI后，受控正常重启/文档/历史/Task读回与再次归档回收均通过。完成条件满足；最终补验记录作为docs-only跟进交付，真实包仍是5f。

## 当前实现与审阅

真实API接线/产品组件完成，12组隔离交互通过；独立board_ui_review（请求gpt-6.1-sol/medium）完成深浅主题与4视口、失败恢复、回程和焦点审阅，两P2经一轮修复关闭。无真实Task写入、模型执行、Native联调或生产验收。报告与runner见dev-docs/project-board.md和project-board-review.md。完整typecheck/lint/build:web先前通过，修复后复验及同步最新main继续进行。

阶段验证：typecheck、完整lint（既有16条dependency warnings、0 errors）与默认/MoXBots build:web通过。状态/API等20项unit、77项既有DOM及新增入口2项，共99项相关用例已通过（新增rail测试修正初始未展开fixture，发现并修复board入口收起flyout）。12组真实React隔离交互通过，独立UI一轮修复复验、追加rail入口检查通过；真实后台/Native/生产不计通过。

集成结果：并行main只在plan追加产生冲突，双方记录均保留，产品看板/入口相对功能提交没有漂移。合并后typecheck、完整lint、99项unit/DOM、12组实际React隔离交互、MoXBots build:web成功。PR31及handoff门禁已通过；最终CI/main与统一Native包继续追踪。源与产物hash见dev-docs/project-board-validation/source-hashes.json，hash证明代码/制品对应，不代表安装或真实路径验收。

## 2026-10-14 — 已授权统一原生更新与看板Native验收

用户明确授权跨聊天协调与原生验收；已向「Bots 网络 可用」发送main提交、源码hash、验收记录与受控Task规则。owner独占负责退出/备份/替换/安装/启动。最终候选为source 5f1a8feb879775a9655c7e5cf848661f692be542，macOS ARM64 ZIP SHA256 e26a8e9a48a9083fe4283c0c6a0538dfd2dd639922a04326f718ff67fd7e220c。安装路径 /Applications/MoXBots.app；owner复核19个资源和Developer ID签名（Team QJ5URBG9AP），未经过Apple公证；安装二进制SHA256 a289686ab5c2b7605b9951c4215b3135efdfb6974eb77e5d80a7e056c3c9cea3，保留回滚App /Applications/.MoXBots.previous-8b9f734d-before-5f1a8feb.app。原MyAgents未改动。

真实Native操作经CUA在安装后的MoXBots窗口完成：从Mino侧栏入口打开唯一 Mino · 看板 标签；看到真实项目汇总、四组状态和独立“其他任务与会话”分组。搜索与列表视图返回时保留过滤、选择和详情；打开已有空闲会话返回原对话，无输入/模型执行。超过快照新鲜期时该会话先如实显示“执行状态未知”，手动刷新后回到“当前空闲”。

通过MoXBots集成终端的正式CLI创建受控本地Task PB-NATIVE-QA-20261014（ID 5dc7e135-3d4f-4fbd-a351-077fd22e395d，executor user），无Agent dispatch、模型调用或业务数据变更。真实看板读到Task；todo→running→verifying后在UI提交验收说明并点“确认验收完成”，看板状态/需要我计数与CLI task get读回的done一致；随后对这条受控Task作recoverable archive，CLI读回archived。初次验收时未覆盖的恢复、受控重启与键盘路径已在后续补验关闭。原生最窄支持窗口为800 CSS px，≤700抽屉低于原生下限，因此只计Web/fixture验证，不伪报Native通过。其余矩阵见 dev-docs/project-board-native-acceptance.md。

官网owner确认Sites公开部署：https://moxbot.mailxf.chatgpt.site/download/，发行页 https://github.com/heavenzhang/MoXBots/releases/tag/moxbots-trial-20261014-5f1a8feb。安装/发布owner在IAB点击官网真实下载链接取得完整文件，主Agent对取回文件独立复核：346377153字节、SHA256 e26a8e9a48a9083fe4283c0c6a0538dfd2dd639922a04326f718ff67fd7e220c，与本机候选ZIP完全一致；`unzip -tq`通过。匿名页面与manifest HTTP 200证据见发布凭证；本次shell客户端直接GET静态manifest遭403，但不影响IAB匿名下载得到完整ZIP及其hash核验。公开页面注明包未经过Apple公证。包凭据迁移、远程设置等其它产品路径未纳入本次看板验收。

真实运行/桌面证据详见私有目录 /Users/zhangshaohua/Documents/Codex/2026-10-14/moxbots-project-board-native-evidence/ 与owner发布回执 /Users/zhangshaohua/Documents/WPS Cloud/【项目】目录/MoxBot/output/download-page-release/；目录外的系统备份/回滚数据不进入Git。

## 2026-10-14 — PR35 CI修复与原生补验

- [x] 读取完整失败日志：Chocolatey V2 feed获取NSIS3.13收到HTTP406、安装0包；后续编译器缺失与Rust诊断无产物均为次生错误。
- [x] CI worker在独立main基线工作树交付修复：固定Tauri官方portable3.13、size/SHA256校验后解压、compiler存在及v3.13探测，保留真实Windows install/upgrade/reinstall/uninstall/deletion-failure用例。主Agentreview/cherry-pick、12项本机检查通过，Windows原生3项只在CI验证。
- [x] PR35最终head b4a86be的6项CI全部通过，run38536820445；Windows真实NSIS6项pass、0skip，cargo check/native IO也通过。
- [x] 原生800 CSS px最窄支持窗口、详情键盘Tab/Escape/focus-return、正式authority的Task archived→todo恢复和UI回读通过。
- [x] 用户手动解锁并重新接回owner窗口后，主Agent受控Cmd+Q正常退出→同一5f cold start→看板/CLI todo/6条history/TaskDoc实际文件hash读回→合法状态链再次archived。最终执行0、sessionIds[]，9条history、原文档hash保留；UI总数1/待开始0。
- [x] PR35当前头6CI通过、合main8f53a6ada103c780cc061bb8f97e52e24bfbdb64，远端main包含head，本任务7项blob完全一致。最后受控重启记录作为docs-only follow-up同步。

不调用外部原因：明确采用ai-yaoren-local纯内置模式。CI worker只写CI与自己的分支记录，主Agent独占Native并负责集成/最终验收。执行模型及token费用不作未测量报告。Native≤700CSS和第二项目主窗口超出当前客户端支持边界，不伪报原生通过；已支持的最窄800CSS与单main多项目Tab按实际路径验收。详细补验见dev-docs/project-board-native-acceptance.md。

最终主Agent冷启动时无系统钥匙串/恢复弹窗，未登录/恢复/授权；只读网络页面显示本机与Linux-Host在线。已归还唯一本机安装owner；不会把5f声明为另一任务114e2ac5新统一包或所有近期改进已发布。私有最终凭证native-followup-complete.json记录Task9条history、执行0、doc hash保留及最终archived；此机器状态不进入Git。
