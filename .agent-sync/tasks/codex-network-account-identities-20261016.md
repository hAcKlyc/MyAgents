<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/network-account-identities-20261016 -->
<!-- git-project-sync-task:base=deb26c3c6793e7931b010c9f573a78b5b2b0a6ba -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-ACCOUNT-FLOW-001 / MOXBOTS-NET-AUTH-001 接续

目标：先统一用户管理、首次登录、Web/桌面/Linux Host 接入及操作语义，再实施账号/网络设备身份隔离并恢复当前新账号连接。

用户决策：使用刚登录的新账号，保留旧身份；隔离改造纳入开发；新版客户端等任务空闲后启用；管理员直接创建账号并分配初始密码。用户要求主要先梳理整体流程。不得重启 App、停止正在执行的任务、删旧绑定、复制 token 或开放公网注册。

权威仓库 heavenzhang/MoXBots，main。工作树最初从 PR78 d1c57f93 建立，PR78 已于本阶段合并；当前基线 deb26c3c，已 fetch 并验证 origin/main 包含 d1c57f93。流程文档不等于实现；正式客户端发布由已有统一发布 owner 负责。

- [x] PR78 六项 CI 通过，merge 后远端 main deb26c3c 包含提示修复。
- [x] Web 登录入口、真实用户/Host 目录、桌面网络页与个人菜单只读检查；私有截图保留在资料目录 output/account-flow-20261016，不入 Git。
- [x] 确认用户开户方式，编写 `services/agentnet/planning/ACCOUNT-EXPERIENCE-V1.md`，明确现状/目标/各端契约/迁移/验收。
- [x] 流程文档独立审阅，修正六项权限/代次/Host绑定/迁移/断线语义问题；文档链接检查4项通过，所有路由文档存在。
- [ ] 流程文档提交、CI 和远端 main 交付。
- [ ] 桌面账号选择、身份隔离、staged login 原子提交与各端统一状态实现。
- [ ] IdP 管理 adapter、同后台用户创建/停用/恢复/重置、首次改密实现及迁移验证。
- [ ] A/B 多端真实联调、当前新账号 ready 与目录恢复。
- [ ] 统一发布 owner 的新版发布、任务空闲后安装和原生验收。

当前仍阻断于设备身份冲突，不宣称恢复连接。没有编辑真实 config、服务配置或凭据；当前文档不新增权限或生产状态。PR78 本地91项测试、full typecheck/lint/build与渲染验收见其记录。本阶段是流程设计，未运行代表实现功能的测试。

执行：主 Agent 负责现场检查、设计和交付；复用 identity_review 子 Agent 对身份与流程进行只读独立审阅，无生产权限、无源码写权限。未调用外部模型。实际 token、费用及节省数额未知。

下一步：审阅契约后提交文档；按 C/D 实施分阶段交付，保持旧运行实例，更新验收状态。不因文档 merge 宣称统一账号功能上线。
