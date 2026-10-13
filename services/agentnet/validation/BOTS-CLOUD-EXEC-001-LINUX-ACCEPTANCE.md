# BOTS-CLOUD-EXEC-001 — Linux 实际生命周期交付

2026-10-14：本次有限生命周期范围已发布并经真实账号验收。共享、收费模型调用、其他 Runtime 与第二个真实账号不属于本次验收结论。

## 源码与制品

- PR23 / main `75bb0269ff471973f1b7e594ab279f824b777e9e` 包含有限执行、原操作账本、Linux Node/native hooks 和管理员 UI。最终任务源035719f2与前置c5f6c9bf均通过七项检查。
- main Test [38420752527](https://github.com/heavenzhang/MoXBots/actions/runs/38420752527) 全部成功；最初只有macOS队列取消的零步骤job失败，单独重跑后成功。Owned [38420752530](https://github.com/heavenzhang/MoXBots/actions/runs/38420752530) 成功。
- 云端运行main75的CI制品11826533779，ZIP SHA256 `1badef1b6f6d1575b5f25b19ffbf1b6a75efdd77a3e51e0551205752838fb98f`，binary SHA256 `59d7db6dbb482c73ba7383241da4020190096c6dd59e6fad47e2737c6d4312ed`。认证GitHub API摘要、归档成员、source-commit、SHA256SUMS及实际运行exe独立匹配；目标glibc2.38满足最高GLIBC2.34，ldd全部解析。
- Linux native运行已验收PR CI制品11824674341 / test-merge sourceb0235d7d；其完整源码tree与main75相同，binary SHA256 `2db7a2769442006c88b3c662d73e8ba66c5580b2c15e1069d0fee84484000c3b`。
- Linux Node运行本地干净sourcec5f6c9bf构建的myagents-test包，不是Node CI制品；Host关键源码tree与main75相同。Node24.20.0、SDK0.3.296与官方摘要/manifest校验通过。保留原安装profile、薄启动器、私人配置及原UID/group。
- 此后并发主干新增的Host模型/目录UI等改动另有owner和发布记录；本次实际运行基线为75，不宣称安装了主干所有后续提交。

## 授权与发布

用户已分别明确批准首位既有测试管理员、有限委派架构，以及具体单Bot/固定UUID路径/最长24h的Host白名单。实际期限还受原Host账户有效期约束，未扩大用户、Root、Runtime、模型引用或六项操作范围。

先升级默认关闭版本，复验原管理路径；再在原service UID的0700 state下安装0600策略，复用原IPC组，专用socket660、父目录750，不新增公网端口。云配置仅启用execution和单个不允许模型调用的生命周期引用，管理员名单与身份配置保留；既有HTTPS入口增加六个精确的认证执行路由。备份为root私有一致快照，保留二进制、配置、units、状态和回滚指针。

两次默认关闭升级曾因软件目录执行/读取权限失败，均恢复原服务，失败证据保留；随后增加service UID可执行/可读预检，实际升级通过。大制品SCP传输超时后改用GitHub签发的短时下载地址，目标独立重验归档和二进制摘要，GitHub凭据没有传到目标服务器。

## 真实验收

同一个经授权的测试账号分别承担平台管理员与该Host/Bot Owner角色。IAB真实OIDC PKCE登录，服务端现有账户/Host部署范围，以及实际Node/native/云桥接均参与；没有使用测试fixture冒充Host。

| 路径 | 实际证据 |
| --- | --- |
| Owner授权 | UI提交固定Bot、Root、相对路径、builtin、有限模型引用、额度和期限；Host实际收到该代grant |
| create | 管理员UI排队原mutation；受限UUID路径产生绑定的停止Agent，Host revision1、原回执persisted |
| configure | UI修改Host配置为500上限及说明；Host revision2和持久化配置匹配，独立登记投影仍保持原值 |
| enable | 实际Product Session出生；session_id匹配Host快照，专用worker UID正确、进程存活，无模型子进程，revision3 |
| disable | UI关闭准入并停止；原worker PID/start-ticks身份确认退出，active_run及runtime_entry清除，revision4、原回执persisted |
| 幂等与CAS | 原操作/原body重放得到相同回执；同编号改body返回409；新操作携带旧revision由真实Host回传HOST_REVISION_CONFLICT，快照不变 |
| 重启 | Node/native实际停止/启动；Bot快照、原mutation/receipt/ACK、有限grant、策略和unit保持一致；仅短时签名proof的jti按既有owner逻辑更新 |
| delete | 停止后UI软删除，revision5；无worker，保留路径/账本和恢复能力 |
| restore | 旧授权撤销收到有效Host ACK后，Owner在同一有限范围签署新grant generation2；UI恢复产生binding generation2/revision7，保留配置，未复活旧Session |
| 最终撤销 | 第二代授权也收到有效Host ACK；最终revision8、未删除且准入关闭，无活动Session/worker，无pending mutation，七条操作回执全部ACK（六成功、一CAS冲突） |
| logout | 实际验收API会话注销后，原token请求bootstrap返回401 |

未通过修改SQLite、SSH写marker或伪造Session代替业务API。身份/账号原始信息、真实UUID、原回执、进程证据、截图、部署脚本和备份指针保存在原owner私有证据目录，公共Git不包含凭据、访问令牌或带访问权的下载地址。

验收脚本曾错误假设错误code嵌套、可选active_run始终存在、完整ledger不含短时proof更新；均按实际源码/响应结构修正并复核，失败保留。没有放宽业务权限、CAS或账本校验。

## 界面与边界

独立Chromium合成验收覆盖完整路径、unknown保留原操作、focus以及390/768/1440适配；见BOTS-CLOUD-EXEC-UI.md。生产IAB实际验收覆盖登录、Owner grant和全部六项生命周期/有效撤销，主Agent复验真实状态与截图。合成ordinary403不能替代第二真实普通账号的生产验收。

运行首阶段仍只管理builtin Product Session生命周期；worker.send拒绝，未调用模型。共享、IM、定时任务、其他Runtime及多Bot并行不开放。原型是历史设计资产，部署制品与实际平台为独立证据层。

## 统一后台及后续

用户于2026-10-14明确：只保留一个MoXBots云管理后台。用户、Hosts、Bots、部署授权/平台角色与审计统一在此平台扩展，不新建账号后台、Bot后台或登录后台。既有认证组件属于内部运行依赖，不是另一个管理入口；普通用户在客户端登录，个人网络后续称Bots Net。

本次复用现有登录服务/AuthStore，没有替换客户端登录界面、迁移账号或改写私有凭据。当前用户模块查询已注册账号；账号停用、登录策略配置、角色维护及真正多用户业务验收属于同一后台的后续模块，不能因统一入口而提前宣称这些写能力已实现。

实际效果发生后，回滚先确认关闭精确Bot并等待有效撤销/receipt ACK；保留已发生的操作、审计和认证事实，不以旧快照覆盖历史。操作脚本重新生成unit时须保留已批准的finite/context flags；具体有限权限不可由云端或后续升级隐式加宽。

执行采用ai-yaoren-local纯内置模式。主Agent负责集成/部署/实测；既有native/core worker审查Host策略与发布脚本，backend worker独立审查云脚本，UI worker负责合成门禁。请求过Luna/medium与Sol/high；实际运行型号、effort、token和费用未提供，不作节省测算。后续先做Linux service UID软件目录预检、提前运行政策/回执门禁，并按owner区分持久状态与短时proof，减少无效重试。
