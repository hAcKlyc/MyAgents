# BOTS-CLOUD-ADMIN-001 统一后台实现

用户于2026-10-13启动真实实现，覆盖此前“暂不开发”的限制。Git目标为 https://github.com/heavenzhang/MoXBots.git ，base main `2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a`，隔离分支 `codex/bots-cloud-admin`。此前原型仍保存为设计参考，不冒充当前产品。

统一入口基于本仓库 owned AgentNet 服务，复用 OIDC、会话及同源路由。用户已选择接入已有云服务；从同项目最新私有接续记录定位现有云实例的 Dex 与 owned AgentNet（访问指针仅保留私有协调记录），本轮只读 HTTPS `/health` 返回200和 authentication阶段。已向用户说明接现有实例；用户明确授权向“评估 MyAgents 精简为 Linux Host”聊天同步云端访问、版本和部署接口，协作消息已发送，其共享私有记录已返回并经本任务只读核实。运行版本含另一个任务未合入main的修复，不能从main构建盲目覆盖该服务。MyAgents Space 是另一个云端 owner，不擅改其身份、数据或客户端协议。管理员与个人 Bots Net 是两个权限视角。

## 完成标准与依赖

- [x] 实际会话校验、平台管理员白名单、普通用户/已撤销身份拒绝访问。
- [x] 真实已注册用户投影、显式纳管 Host/用户部署配对、模型配置引用授权。
- [x] Bot 新建、配置、分配、逻辑删除/恢复的私有 SQLite 持久化、CAS、幂等和审计。
- [x] 同源后台界面登录、管理、错误恢复、刷新及响应式实际验证。
- [x] 独立非实现者审阅与主智能体关键路径复核。
- [ ] 相关测试、CI、最新 main 集成、远端主干核验。
- [ ] Host 执行适配与真实启停回执：依赖现有 Host owner 的授权控制链路，未接通时拒绝启动，界面不能声称运行成功。
- [ ] 真实跨用户共享调用、隔离、审批和用量：依赖 Host 执行及资源授权链路，第一轮不从 metadata CRUD 推断完成。
- [ ] 现有云实例访问、备份/回滚、发布与真实用户验收：云访问与现网版本已核实，正在准备串行发布；不得在Host owner维护窗口内重启云服务。

控制面第一轮可以独立交付，不将其称作整个云平台/共享执行完成。生产不灌入原型合成账号、Hosts或模型。模型引用仅命名，不携带密钥；用户预算上限由私有配置声明。所有操作采用实时服务端 authority，浏览器不持久保存 bearer、不用 localStorage 管业务状态。

## 接口约定

成功 `{ok:true,data:...}`；失败 `{ok:false,error:{code,message,retryable:false}}`。实体 snake_case。`GET /api/admin/bootstrap` 返回 principal_id/users/hosts/model_refs/bots/audit/capabilities。写操作带 mutation_id、expected_revision，发生未知结果先查询原 operation ID，不能自动生成新 ID 重试。create、configure、assign、start、stop、delete、restore 分别校验；归属变化清空模型/指令，删除精确名称确认，恢复不复活旧共享。

当前 Host 的执行连接必须标未接入；纳管配置不等于真实在线。启动请求返回 `HOST_EXECUTION_NOT_CONNECTED`，停止只关闭准入意图，不宣称停止 OS 进程。没有执行实例的登记草稿可维护/删除。所有私有历史、会话正文、凭据和 Host OS 能力不进入后台接口。

## UI 验收矩阵

视觉基线沿用已审阅管理员原型：深色导航、浅色内容、蓝色主操作，统一云后台入口；1440×900、768×1024、390×844。实际产品只显示真实数据，不复制原型种子。

| 路径 | 身份/初态 | 行为与预期 | owner/状态 |
| --- | --- | --- | --- |
| /admin | 未登录 | OIDC 启动/轮询、失败可重试、刷新重新登录 | primary，fixture通过 |
| Bots 目录 | 管理员/空数据 | 明确空态、新建入口、用户或Host缺失解释 | primary，fixture通过 |
| Bot 编辑 | 管理员 | 创建停止草稿、配置校验保留输入、CAS冲突不覆盖 | primary+独立review，fixture通过 |
| 分配/回收站 | 管理员 | 影响确认、执行引用清空、删除名称确认、恢复默认停止 | primary+独立review，fixture通过 |
| 启停 | 未接入Host | 明确失败、真实状态不变；停止不声称OS进程终止 | primary+独立review，fixture通过 |
| 访问控制 | 普通/撤销会话 | 403/401，清理界面敏感投影，不自动扩权 | backend+primary，fixture通过 |

## 执行记录

不调用外部原因：明确采用 ai-yaoren-local 纯内置模式。主智能体型号/effort无可确认运行元数据，不能切换。`cloud_backend` 请求 gpt-6.1-sol/medium，只读核查后发生容量错误；继任 `cloud_backend_impl` 请求 gpt-6-luna/medium，独占 Rust admin 模块与server/lib/store接线。primary独占 admin-web、接口合同、文档、集成与发布。`cloud_ui_acceptance` 请求 gpt-6-luna/medium，独立浏览器验收及只读交付复核完成；不争抢同一浏览器。Rust文件ownership现已交回primary。

模型实际运行值、token和费用未知。暂不建立共享缓存：两个实现者文件互斥，接口约定较短，直接传递该约定成本更低。权限与真实状态的风险由primary审查和测试承担，不为容量失败降低验收标准。


## 已观察的阶段证据

- 组合源码服务端测试73项通过、1项手动浏览器fixture默认忽略；metadata-core20项通过。生产router组合测试验证静态页CSP/no-store和匿名管理接口401，随后聚焦复验通过。
- 服务端clippy `-D warnings`、fmt、完整npm lint通过；原有依赖孤立模块15条warning保留。新增便携浏览器脚本另行通过ESLint。
- 独立实际浏览器三个gate通过，primary另外验证创建/配置/拒绝启动/重新分配清空旧引用/重新登录持久化/删除名称拒绝/删除恢复。仅合成身份和真实临时AuthStore/AdminStore，不是现网OIDC或Host执行验收。
- 正式修复轮次：后台2轮（集中权限/持久化review、BR02名称边界），UI2轮（未知结果modal阻挡、窄屏操作可达性）。Fixture完善和测试locator更正不计为产品修复。
- UI文件hash及完整证据见 [UI验收记录](../validation/BOTS-CLOUD-ADMIN-UI.md)，可复現脚本见 [validation](../validation/README.md)。
- 现网源码04faeb1d对应四个服务文件被原样保留，与新增后台组合验收，避免从旧main发布造成中继/首次初始化回退；不导入其他Host/桌面改动，也不放宽同principal设备管理规则。

实际平台管理员角色尚未授予；Host委派执行与跨用户共享仍开放。新执行通信/权限owner方案见 [执行接入提案](BOTS-CLOUD-EXECUTION-V1.md)，提案不作为当前接口authority。
