# MoXBots 统一云管理后台

该模块复用本实例 owned AgentNet 的 OIDC 登录与实时会话，页面为 `/admin`。默认关闭；仅私有服务配置的 `administration.admin_principal_ids` 可访问管理 API。普通账号登录成功不等于平台管理员。此白名单只控制本实例纳管登记，不授予 Host OS、私人会话或凭据读取权。

第一阶段提供 Bot 管理登记、新建停止草稿、配置、所属用户/Host成对分配、逻辑删除、恢复、幂等回执与审计。Host 配置是运营方声明的授权清单，不是在线发现，也不证明执行端已经接入。启动返回 `HOST_EXECUTION_NOT_CONNECTED`；关闭准入不表示 OS 进程已经停止。可选有限执行模块已在PR23/main75接入并真实验收；不能拿登记状态替代实际Host回执。共享调用与收费模型仍未开放。

## 私有配置

在现有服务私有配置中添加可选 `administration`。下面 UUID 仅为格式示例，不能直接复制作为真实授权；账号 ID 必须取自本实例实际已注册 principal，Host和模型引用须由运营方明确声明。

```json
{
  "administration": {
    "admin_principal_ids": ["11111111-1111-4111-8111-111111111111"],
    "hosts": [
      {
        "id": "22222222-2222-4222-8222-222222222222",
        "name": "Managed Host",
        "owner_ids": ["11111111-1111-4111-8111-111111111111"],
        "runtimes": ["builtin", "codex"]
      }
    ],
    "model_refs": [
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "label": "Approved model reference",
        "owner_ids": ["11111111-1111-4111-8111-111111111111"],
        "runtimes": ["builtin"]
      }
    ],
    "max_daily_tokens": 100000
  }
}
```

示例额度不是商业价格或默认承诺。模型引用没有 API Key，也不代表 Host 已安装该模型；执行接线后还要由真实模型与凭据 owner 校验。不可把原型的合成账号、Hosts和模型灌入生产。

配置继续使用既有私有文件权限与 loopback 监听；页面、API 和登录共享既有 HTTPS 入口，不增加公网端口。平台管理员名单由运营方维护，不能通过浏览器自行扩权。Nginx 应把 `/admin`、`/admin/` 下静态资源以及 `/api/admin/` 代理到同一现有后端，保留既有 Dex、AgentNet和其他应用路由。

## 数据与操作

管理登记写入原私有 `state_dir` 的 `admin.sqlite3`，独立于账号、设备和中继数据库。保留稳定 Bot ID、配置版本、所属用户、Host、模型引用、系统指令、预算及逻辑删除状态。审计只记录动作、主体、对象和修订等元数据，不写系统指令、凭据或私人会话。

每次写入携带 UUID `mutation_id` 和 `expected_revision`。新建为0，其余用刚读取的版本；冲突不覆盖当前数据。操作编号绑定管理员、动作与原请求，成功重放返回原回执；冲突编号不可被重新解释。网络断开时先查询 `GET /api/admin/mutations/{id}` 或以原编号/原请求重试，不生成新编号猜测成功与否。查询不存在不证明此前请求永远不会执行。

归属或Host变化必须确认影响、校验目标用户部署授权，清空模型引用与系统指令，保持停止草稿；不搬运原用户私人数据。删除输入完整名称确认，仅进入回收站，保留历史审计。恢复校验同名冲突，保持未部署/共享关闭，不复活旧授权。当前尚无真实共享表或执行实例，不能从上述状态推断已关闭外部系统中的历史任务。

## 验收和上线

常规 Rust test/clippy/fmt 使用仓库1.92.0固定工具链；浏览器验收使用仅测试构建的隔离 loopback fixture。fixture登录使用合成测试身份，真实管理 API、AuthStore与私有管理数据库接受检查；它不能替代现网 OIDC 或真实 Host 验收。

发布前以实际运行二进制与源码为基线，保留现网尚未合入的修复，锁定部署所有权；备份私有配置、全部数据库及 systemd unit，记录旧二进制摘要。更改私有配置需要相称审批，不在公共Git记录原始凭据。升级失败恢复旧二进制和匹配配置；新管理库留存私有备份，不覆盖旧认证状态或回滚其他应用。

完整目标、阶段验收和开放依赖见 [BOTS-CLOUD-ADMIN-IMPLEMENTATION.md](planning/BOTS-CLOUD-ADMIN-IMPLEMENTATION.md)。

## 有限 Host 生命周期及统一入口

`execution=true` 是同一后台的可选执行模块，默认关闭。只由运营方在已获明确授权的scope安装Host本地私有策略；Owner签署具体Bot/Root/相对路径/Runtime/模型引用/额度/期限，管理员再用原mutation和当前Host revision排队六种生命周期操作。真实Host proof/lease/receipt和最新观察决定结果，unknown保留原请求，历史回执不当作当前运行状态。运行scope及完整验收见 [Linux实际验收](validation/BOTS-CLOUD-EXEC-001-LINUX-ACCEPTANCE.md)。

恢复须先等旧grant有效撤销，再由Owner签署更高generation的新grant、提高binding generation；保持准入关闭，不复活旧Session。声明模型引用不是调用授权；首阶段worker.send拒绝，管理Product Session不执行模型。跨Owner/Host重新分配仍要等有效Host ACK；保持现有角色、账号和私人会话边界。

Nginx在既有HTTPS入口添加精确的 `/api/bots/grants/accept`、`/api/bots/grants/revoke`、`/execution/self/pull`、`/execution/self/lease`、`/execution/self/receipt`、`/execution/self/observe`。人类端仍校验原认证会话/Owner/admin，Host端仍校验原DPoP/设备/WS上下文，不新增监听端口或绕过认证。

只保留此一个云管理后台。用户、Hosts、Bots、权限与审计，以及后续账号停用/登录策略/角色维护均扩展在此平台；现有OIDC等组件是内部依赖，客户端普通用户登录是产品入口，不另建“登录后台”。当前用户模块仅查询已注册账号，不能据此宣称IAM写能力已交付。历史原型不是第二套生产后台。


## 网页登录交互

管理员点击登录后在当前标签页进入现有 OIDC 身份页；`browserReturn: true` 仅为既有登录事务的 UI 选项，回调按绑定 state 返回固定 `/admin?login=complete|failed`，不接受任意 return URL。客户端未传选项时保持原回调行为。

仅临时事务（id/device/PKCE verifier/expiry）放入 tab-scoped sessionStorage，以跨页面完成现有单次消费；成功、取消、过期或错误时清除，会话 bearer 始终只在内存。刷新已登录页面仍需再次认证。中文 Dex 模板及部署说明见 `deploy/dex-web/README.md`；既有部署增量更新 frontend 配置，禁止用 bootstrap 重建账号、密钥或数据库。
