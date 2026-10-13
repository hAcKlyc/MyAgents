<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/host-config-delivery-20261013 -->
<!-- git-project-sync-task:base=fb92ce9c43962f56acaf894e72f1a64003f59cc7 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-HOST-CONFIG-20261013

## Objective

当前Agent实现Host远程管理复用设置模型界面、一键应用当前MoXBots客户端主Agent配置、读取远程目录并选择工作区。用户已明确执行主体、主Agent来源及跨聊天协调/统一更新授权。权威源码为MoXBots；本任务不改固定credential reader或账号/登录方案。

## Acceptance criteria

- [ ] 设置和Host使用共享模型配置UI，支持选择已配置Provider/模型，实际支持由Host能力裁决。
- [ ] 一键应用客户端主Agent来源配置，展示来源与目标；本机路径在Host范围内解析/选择，凭据只走既有安全写入，不记录明文。
- [ ] Host允许根目录内真实目录浏览/选择，加载/空/错误/取消/身份变化可用，禁止跳出允许根及符号链接绕过；不新增公网或任意文件读取。
- [ ] 复用现有管理owner、revision、mutation receipt和加密通道；兼容已安装旧Host，不覆盖运行Session出生配置。
- [ ] 类型、相称DOM/Node/Rust回归、lint/build及非实现者UI与主审关键路径验收。
- [ ] 完整源码合远端main，源头/CI/远端祖先核验；基础Host分支交付依赖单独跟踪。
- [ ] 统一候选客户端/Linux Host联调和原生安装验收，由原凭据任务统一安装并协调本任务验收，不并发换包。

## Completed

- 已核对main 2a241591与Host试用远端9149753c，原owner工作树干净；本工作树start/task-init通过。
- 用户允许跨聊天协调；已通知“评估 MyAgents 精简为 Linux Host”模块范围、统一安装顺序及基础分支依赖，不改其未提交/后续工作。

## Verification

UI frozen and independent source/screenshot review closed; primary synthetic IAB covers actual shared components and 900/1280 layout. Final targeted DOM/profile tests37 pass, Settings/model regression48 pass, source/registry unit16 pass, protocol19/headless125 pass, backend58 pass with13 Linux-only skips. Full local lint/build and exact-head CI are tracked separately. Evidence: dev-docs/host-config-primary-acceptance.md.

## Blockers and unknowns

Host foundation PR24 is on main fb92ce9c. Current main also includes sidebar PR25 c21e9f43 and Bot execution PR23 75bb0269; clean delivery integrates both, preserving explicit owner configuration atomic locking and Bot lifecycle. Original credential-reader development experiments remain excluded. Native unified install and actual Host/main Agent configuration acceptance are open under the authorized original installer owner. No real key, execution grant or paid model call has been changed.

## Next step

Resolve PR23 integration, run final type/lint/build and full CI, push/PR/main verify, then provide exact accepted main source to original unified installer and complete actual Host/native paths.

## Verified foundation integration

PR #24 Host基础已交远端main fb92ce9c43962f56acaf894e72f1a64003f59cc7。交付分支从此main独立创建，start/task-init PASS，仅移植本任务166cd4c3和efe27b15，不含开发依赖merge或Mac credential reader实验。唯一append conflict保留双方handoff条目，actor变更自动合并。后续UI提交、整合回归、CI/main与统一安装仍开放。此段替代此前基础未交付阻断。

## Final implementation freeze

Development UI source d829d8d3 cherry-picked only after independent review, 37 final targeted tests, source/schema/headless checks and primary IAB. Source execution flag is preserved; explicit manual owner checkbox retained. Linux skipped cases and real native/Host acceptance remain open. Latest main c21e9f43 sidebar delivery will be merged without replacing concurrent work. Evidence: dev-docs/host-config-primary-acceptance.md and host-config-independent-review.md.

## CI and concurrent resume integration

PR27 source af72570059a0185446b1e76d00f975112bdc90a5 passed all six Test checks (run38422008186), including Linux integration and native Rust/Windows/macOS. Current main subsequently advanced to PR26 resume-boundary fix20e89b6f2ac4de297205d168f0bb72614486e899; clean merge preserved it without conflicts. The final combined head requires CI again; previous source evidence is inherited only for unchanged areas. Local full lint, Web/Server/Bridge/CLI builds passed. Unified installation/real Host acceptance remains open; this task has not replaced the app.
