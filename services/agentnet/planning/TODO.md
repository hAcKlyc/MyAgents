# 当前任务：BOTS-MODEL-CENTER-001

- [x] 独立 core/Host 实际 SDK 隔离验证。
- [x] HTTP/原 owner authority、UI 组合与独立验收。
- [x] PR38 主干/七项 CI/现有云后台发布、真实账号配置/分配/监控及重启保留。
- [ ] 后续用户自行配置供应商，有限 Host 联合升级/授权后真实调用验收；本次不导入、不调用，非当前阻断。

详见 `BOTS-MODEL-CENTER-V1.md`；以下历史清单保留。

# Bots 管理与 Bots Net 规划任务清单

任务：AN-SHARE-PROTOTYPE-20261013。更新：2026-10-13。仓库：https://github.com/heavenzhang/MoXBots.git ，主干 `main`。

## 本次规划同步与原型

- [x] 用户授权仓库更名，GitHub 新名称与 repository ID 核验。
- [x] 从 main `848c0592473a95d7e332b258ff433b11d722a5a3` 建立隔离工作树，保留其他 owner 修改。
- [x] 将[后续规划](AGENTNETS-ROADMAP.md)与[第一版权限设计](AGENTNETS-BOT-SHARING-V1.md)同步到本目录。
- [x] 明确服务端多用户前提、所有权、会话和执行隔离，Host 管理权独立。
- [x] 建立项目地图、共享计划和原型设计约定。
- [x] 更新综合与分支接续记录并保留旧任务事实。
- [x] 制作管理员 Bots 管理原型，覆盖跨用户目录、详情、授权治理和次级 Bots Net 使用结果。
- [x] 独立视觉验收和代表页复核，管理员版两轮修复完成。
- [x] 独立交互、三视口响应式验收，主 Agent 复核关键路径；见原型目录验收记录。
- [x] 检查文档链接、差异范围、原型脚本与浏览器控制台。
- [x] 提交、推送本分支并通过 Git 接续 gate。
- [x] 同步最新 main，完成必需审查和 CI，合入并核验远端 main。
- [x] 用户可打开原型及验收记录；本地预览和离线导出就绪。

仅验收规划保存与合成原型。未接真实认证、模型、Host 或业务接口，无生产发布。

- [x] 用户纠正为平台管理员视角；区分平台管理员、Bot所有者和共享管理员，客户端网络入口后续称 Bots Net。

主干交付锚点：PR #17 合入 `421718d6756cb73dfffaf54e94344a5e497caf8c`，已 fetch 核验包含源码头 `7a977724421f6c2b6923f3b8d1640aac28809185`，合并树与七项 CI 全通过的已审查头一致。HTML hash 与独立接受版一致。后续关闭记录提交仅改文档，不更改原型。

## 管理员生命周期原型补充

任务 BOT-ADMIN-LIFECYCLE-PROTOTYPE-20261013，分支codex/bots-admin-lifecycle-prototype，base main 5ee8f862。仅规划与合成原型，上一轮共享原型交付记录保留。

- [x] 核验最新main、已有工作区和上轮主干CI成功，start/task-init gate通过。
- [x] 明确生命周期、平台权限、成对部署授权、归属影响与逻辑删除规则。
- [x] 新增详细生命周期规划并同步两份既有规划、任务清单和接续入口。
- [x] 新建代表页主审，后续沿用表单与详情模式。
- [x] 新建/配置/启停/删除/恢复及所属用户Host分配实际模拟可操作。
- [x] 与用户共享调用、审批预留和历史结果联动，跨Bot/Host不串用。
- [x] 独立视觉、交互、三视口响应式和键盘验收、主审关键路径通过，正式1轮集中修复。
- [x] 文档链接、脚本语法、完整lint与本任务差异检查通过。
- [x] 提交推送并通过handoff gate，当前头部CI通过后合入并核验远端main。
- [x] 最终任务状态和本地可打开原型导出同步。

交付锚点：[PR #18](https://github.com/heavenzhang/MoXBots/pull/18) 已合入 main `5652048579f776c5eebe9faebdbde212ce2b93c7`，源头 `159783a53b05c24c07d66d1204bfdd2cc05057be` 七项CI成功，fetch核验源头祖先与合并树一致；HTML保持独立接受版4f963…，关闭记录不改产品。

## 后续开发待办

用户于2026-10-13明确启动真实实现，任务 **BOTS-CLOUD-ADMIN-001**；实施合同和逐阶段状态见 [BOTS-CLOUD-ADMIN-IMPLEMENTATION.md](BOTS-CLOUD-ADMIN-IMPLEMENTATION.md)。统一已有云服务后台为服务端管理员入口，个人 Bots Net 留在客户端。以下整体开发项不能仅因控制面登记完成而提前勾选。

- [x] BOTS-CLOUD-ADMIN-001 本地阶段：真实鉴权/管理登记API与同源后台、隔离数据库联调及独立UI验收。
- [x] BOTS-CLOUD-ADMIN-001 登记控制面交付：PR20/22、远端main、授权首位管理员、发布及真实OIDC/UI/API验收。
- [x] 现有云服务登记后台集成：保留中继修复，备份/回滚与真实账号验收；Host执行仍另列开放。

- [ ] BOT-ADMIN-LIFECYCLE-001：真实生命周期权限/配置/启停/分配、双Host运行防护、逻辑删除和恢复按新规划实现并多账号验收。

- [ ] BNET-NAME-001：客户端现有 Agent Net 显示名称改为 Bots Net，核对导航、说明和国际化；协议及源码 namespace 是否变更另行评审，不全局替换。

- [ ] 设计并实现平台管理员认证与治理范围，服务端 Bots 控制台与客户端 Bots Net 使用端分开授权。
- [ ] AN-MULTIUSER-001：核实最新 principal、network、device、Bot、Session 和资源所有权。
- [ ] 明确 Bot 与 Agent、工作区、Host 映射及兼容迁移。
- [ ] 实现指定账号邀请、主动接受、有效期与防重复。
- [ ] 实现角色和资源范围授权，防止管理员扩权及取得 Host 管理权。
- [ ] 实现跨用户 Bot 级调用授权，保留同账号设备管理边界。
- [ ] 落实 Host 会话、记忆、文件、工具、浏览器、凭据和后台任务隔离。
- [ ] 实现额度预占、并发限制、审批和费用归属，未知用量不计零。
- [ ] 实现撤销、过期、旧凭证和订阅失效、任务取消及重启恢复。
- [ ] 实现审计元数据及授权内查询，不默认开放私人会话正文。
- [ ] 获授权身份与可控数据下，完成至少三个独立账号真实端到端验收。
- [ ] 分别完成实现、模拟验证、真实联调、主干交付、生产发布和路径复验。

依赖、角色矩阵和详细标准以两份规划为准，原型通过不能提前完成后续开发项。

## 已实现登记后台与剩余执行（2026-10-13）

- [x] BOTS-CLOUD-ADMIN-001 PR20/main be48a22b及现网制品、私有一致性备份/回滚核验。
- [x] 用户首位测试管理员角色确认；真实OIDC/admin API停止态管理与撤销session验收。
- [x] BOTS-ADMIN-LOGIN-002独立标签页辅助登录：PR22/main1cfa2f85、CI发布制品和真实IAB登录/管理路径已验收。
- [x] BOTS-CLOUD-EXEC-001有限单Bot委派、真实Session启停、原请求/CAS、重启持久化、软删/新授权恢复及有效撤销：PR23/main75已发布并真实验收。
- [ ] 客户端Bots Net命名与个人共享；跨用户多账号与收费模型路径另行验收。

### 2026-10-13 — administrator release and real browser acceptance

PR20 plus PR22 are in remote main. Login source `60e3a52c08bf79d3985e1453449719269a35fb1a` passed seven exact-head checks; PR22 merge `1cfa2f85dc6c936c02b86f1f40945961665608a7` passed Owned AgentNet run38396057654. Its CI artifact11812672883 has verified API archive digest5198fa3f… and binary SHA256 `9b9320f57685a938cee53492eec412567df8076a273e7ef72a12a461ca5f06bc`; complete source tree matches that accepted main commit. Subsequent main documentation changes do not alter the deployed service.

The user explicitly authorized the existing integration test account as this instance's first platform administrator. The binary-only release preserved exact existing role/config and ingress hashes, stopped only the dedicated network service, created consistent private SQLite/state backups and retained the previous binary and rollback. Dex, Mori and Linux Host were not restarted. Runtime executable/source/hash and health were independently verified.

Real OIDC PKCE login through the in-app browser's independent sign-in tab succeeded. Authenticated UI create/configure and approved owner/Host selection succeeded, revisions persisted, and disconnected start was truthfully rejected. Actual API verification also passed original mutation replay, reload persistence, recoverable delete/restore and logout token revocation. Controlled drafts only; no model calls. Real ordinary-user production login and actual Host execution remain unverified; fixture ordinary403 is not substituted for production evidence. Private production evidence is under `/Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-cloud-admin-evidence/deployment/`; raw accounts, tokens, credentials and Host identifiers remain outside Git.

BOTS-CLOUD-EXEC-001 continues separately: protected owner opt-in, current Host source preservation, Linux gates and true Session lifecycle release are open. Shared usage remains future planning.

## 2026-10-14 — 当前完成及统一后台约束

- [x] 实际Owner/admin登录与有限授权、六生命周期效果、精确worker退出和最终Host ACK；六成功及一CAS冲突回执全部确认。
- [x] 云制品/源码/ABI、Host Node/native与本地策略、私有备份/回滚核验。
- [x] 单Bot验收收尾：恢复后准入关闭，没有活动Session，两代授权有效撤销，无模型调用。
- [x] 用户明确：统一为唯一MoXBots云管理后台；普通用户登录与原认证复用，不增设登录后台、账号后台或Bot后台。
- [ ] 在同一后台扩展账号停用、登录策略及角色维护，先定义现有认证owner的权限/撤销不变量；当前用户页仅查询已注册账号。
- [ ] 第二真实账号/普通Owner产品入口、共享、收费模型授权等后续范围，不能用合成403代替真实联调。

验收分层与运行版本见 `../validation/BOTS-CLOUD-EXEC-001-LINUX-ACCEPTANCE.md`；前述未发布条目仅为历史准备状态，由此记录更新。

## BOTS-EXEC-QUEUE-FAIRNESS-002（后续）

- [ ] 原 queued_for 最早窗口在超过 8 条旧注销 actor、catalog 正常时不推进，后排 cleanup 可长期等待。基线5315已存在；设计有界公平推进，保持原 actor 门禁、正常 FIFO、未知 lease/receipt 和 Delete 安全，不新增授权 owner。与本轮仅 catalog 故障隔离区别验收。
