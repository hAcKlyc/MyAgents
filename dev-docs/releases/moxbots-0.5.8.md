# MoXBots 0.5.8 统一桌面发行

任务`MOXBOTS-058-COMMUNITY-RELEASE-20261016`，当前`preparing-candidate`。统一桌面发布owner仍为聊天`01a12bc2-907a-7702-b6dd-788225c5dfe4`。本次统一接收社区、登录与任务草稿修复，准备macOS arm64正式包，完成真实验收后发布既有更新服务器。候选准备不触动日常客户端；真实更新仅在重新确认空闲、备份和回退后进行，不停止正在执行的任务，不回写055/056/057，不改云/Host服务或网络权限。

## 来源与范围

- PR87：[社区账号复用](https://github.com/heavenzhang/MoXBots/pull/87)，最终head`303fb76b5abff4b1f67c5c958e7b0abf4bbad645`，main`c0f7649d8ca08e017001e24492d46952c23b0159`，二者tree`4542be1279728d0a8e69e7dc4d1b0c1d4c86cb85`相同；六CI与fresh远端包含核验通过。早期09ad候选接收记录保留，已经被最终head取代。
- 内置社区Tab复用Rust Owned账号及现有native bearer API；个人菜单、更多、设置入口汇合。凭据留在Rust owner，不进入Renderer、URL或storage；按issuer/principal/binding/actor隔离，relay未连接仍可访问社区。提交后不确定结果保留完全相同mutationId/body以便显式重试。最终修正隔离上游Space清理gate和Tab标题，其他发行保留原行为。无新云协议或服务部署。
- 基线main还包含未随冻结057发行的PR84 macOS网络CLI；其source/CI与真实Keychain/连接运行验收边界见`dev-docs/mac-network-cli-acceptance.md`。本次候选包含该主干源码，不把它算成已安装或真实账号通过。
- PR89：[自动检测浏览器登录完成](https://github.com/heavenzhang/MoXBots/pull/89)，审核head`68fd790aae4b31081388286f8d799d06c4be89e5`，合入main`78752f659efe20c5ff9e176c3368d481f412e3cd`；Root独立核实六CI、同tree和远端包含。自动打开既有授权、串行检测、成功关闭；手动检查/重开备用，授权链接默认折叠；取消、到期、迟到结果仍守原owner。未改Rust/OIDC/凭据authority；真实浏览器/OIDC/OS凭据及installed native另验。
- PR90：[任务更新草稿交接](https://github.com/heavenzhang/MoXBots/pull/90)，最终head`ea3718567202413271a1090de0ee2b5cc2dec3c7`，main`47c802426f9e86d0b9cec45adf32745b2aafae40`；Root独立核实六CI、同tree及远端包含，原9dbf候选保留为历史。修复已保存cronConfig被误判为未保存草稿，v2交接Goal/Cron设置，恢复编辑态不启动任务，兼容v1。来源152定向/110回归和三条合成重载不代替原生跨进程验收。
- 正式确认框新增普通「重启更新」：完整草稿交接后使用原Rust非中断admission，活动未结束或状态未知时拒绝安装并释放checkpoint；保留单独明确标注的停止动作。Root本次不操作停止入口，不新增IPC或改Rust生命周期。
- 本发行分支集成已验收主干，维护058元数据、确认框及交付记录；最终CI/独立UI后固定正式构建SHA，后来main不自动混入。

## To Do与验收状态

- [x] 实际仓库/唯一桌面owner/主干c0f/PR87最终head、六CI及远端包含核验。
- [ ] 058版本元数据、精确源码CI/main、固定候选SHA与完整树。
- [ ] 最终固定源码独立实际组件UI：社区个人菜单/更多、列表/详情、发帖/回复、不确定提交和账号隔离；登录自动检测/取消到期；Goal/Cron草稿重载；1280×720和660×400；合成与原生验收分开。
- [ ] 正式完整native构建、固定生产Reader、公钥/endpoint连续、Developer ID、Apple Accepted/staple/Gatekeeper、最终归档与自有签名/独立实际验包。
- [ ] 手动解锁、当前完整活动owner确认空闲、兼容配置/实际应用私有备份和回退；不强退、不主动停止任务。
- [ ] 获授权正确测试身份：个人菜单/更多进入同一社区且无需二次密码；真实列表/详情；受控话题/回复持久化；切换账号或退出后不再显示旧内容或保留旧写入权限。
- [ ] 真实浏览器授权→无需手点检查即关闭登录、备用检查、取消/到期、原账号恢复；原生跨进程Goal/Cron草稿保留且不自动启动任务。
- [ ] 适用UI/真实联调门禁满足后，既有own updater完整公网GET/真实stat+SHA/签名独审、旧057回滚、同锁CAS/公开复验及交付main记录。

源码方报告55项前端、199 native AgentNet（1个由parent调用的私有child entry ignored）、163 headless及5项实际组件+合成IPC交互通过；独立源码/截图复审通过。Root已读取其最终回执与CI，但这些不代替正式签名包或真实账号写入。源码单测使用任务私有SwiftPM overlay/CLT兼容库，已有dyld重复Swift类warning；正式构建不得使用DOCS_RS/ScreenCaptureKit stub或修改系统工具链。

## 门禁与回退

本机之前明确“稍后解锁，先继续准备候选包”；不以截图、旧PID、端口、Task行或时间经过猜测当前解锁/空闲，也不为观测提前freeze/ensure/create或扩大External Calls。候选准备不等于客户端已升级。真实社区写入仅用已获授权的测试身份与受控数据，不用真实业务数据凑验收。缺少窗口/权限时保留具体门禁，不将合成结果当通过。

沿用自有更新公钥与endpoint、Developer ID和明确login钥匙串的moxbots-notary；凭据不入Git或日志。旧057源ee055458/正式TAR b48604872eb967e3419aef0a8da1a33101603fa5883b08c4aadb0a0fe21c6c82不可变。回退须恢复启用前兼容配置并保留当前业务库及新旧身份/凭据槽，禁止恢复旧业务数据库；stable回退仅阻止新分发，不会自动降级已安装客户端。

本机公网路径曾有TLS握手间歇超时，完整GET约118KB/s；这是网络待验证边界，不修改代理/带宽或用TLS绕过代替验收。本次正式候选与原始证据保存于项目指针`work/release-058-20261016/owner/`及`output/updater-058-20261016/`，不将原生包、运行数据或密钥提交Git。

## 构建前证据门禁

独立配方审阅先后发现ENV-01继承动态库环境、GATE-01证据覆盖遗漏、GATE-02缺截图仍可能通过，首轮失败原件均保留。修复后v3独审与25项纯合成门禁夹具通过；四必需CI/main/UI/Root角色、PR89/90祖先、固定源码及同tree、全部原件哈希、执行场景与PNG实际尺寸绑定均受检。此为配方验收，不代表实物包通过；最终源码及原件仍须重新绑定。旧f31合成UI已通过并记录UI-058-01可滚动到达的不确定回执提示建议，最终源码需重新复核，不能复用其PASS代替新增登录/草稿验收。
