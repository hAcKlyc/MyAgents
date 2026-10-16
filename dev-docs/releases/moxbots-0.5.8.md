# MoXBots 0.5.8 社区账号复用候选

任务`MOXBOTS-058-COMMUNITY-RELEASE-20261016`，当前`preparing-candidate`。统一桌面发布owner仍为聊天`01a12bc2-907a-7702-b6dd-788225c5dfe4`。本次准备当前主干的macOS arm64候选；不更新或重启日常客户端，不回写055/056/057，不改云/Host服务或网络权限。

## 来源与范围

- PR87：[社区账号复用](https://github.com/heavenzhang/MoXBots/pull/87)，最终head`303fb76b5abff4b1f67c5c958e7b0abf4bbad645`，main`c0f7649d8ca08e017001e24492d46952c23b0159`，二者tree`4542be1279728d0a8e69e7dc4d1b0c1d4c86cb85`相同；六CI与fresh远端包含核验通过。早期09ad候选接收记录保留，已经被最终head取代。
- 内置社区Tab复用Rust Owned账号及现有native bearer API；个人菜单、更多、设置入口汇合。凭据留在Rust owner，不进入Renderer、URL或storage；按issuer/principal/binding/actor隔离，relay未连接仍可访问社区。提交后不确定结果保留完全相同mutationId/body以便显式重试。最终修正隔离上游Space清理gate和Tab标题，其他发行保留原行为。无新云协议或服务部署。
- 基线main还包含未随冻结057发行的PR84 macOS网络CLI；其source/CI与真实Keychain/连接运行验收边界见`dev-docs/mac-network-cli-acceptance.md`。本次候选包含该主干源码，不把它算成已安装或真实账号通过。
- 本提交只同步058发行元数据与记录，不修改社区/CLI协议实现；正式构建固定之后的精确SHA，后来main不自动混入。

## To Do与验收状态

- [x] 实际仓库/唯一桌面owner/主干c0f/PR87最终head、六CI及远端包含核验。
- [ ] 058版本元数据、精确源码CI/main、固定候选SHA与完整树。
- [ ] 独立实际组件UI：个人菜单/更多、列表/详情、发帖/回复、不确定提交、切账号/退出及660×400最小窗口；合成数据与原生验收分开。
- [ ] 正式完整native构建、固定生产Reader、公钥/endpoint连续、Developer ID、Apple Accepted/staple/Gatekeeper、最终归档与自有签名/独立实际验包。
- [ ] 手动解锁、当前完整活动owner确认空闲、兼容配置/实际应用私有备份和回退；不强退、不主动停止任务。
- [ ] 获授权正确测试身份：个人菜单/更多进入同一社区且无需二次密码；真实列表/详情；受控话题/回复持久化；切换账号或退出后不再显示旧内容或保留旧写入权限。
- [ ] 适用UI/真实联调门禁满足后，既有own updater完整公网GET/真实stat+SHA/签名独审、旧057回滚、同锁CAS/公开复验及交付main记录。

源码方报告55项前端、199 native AgentNet（1个由parent调用的私有child entry ignored）、163 headless及5项实际组件+合成IPC交互通过；独立源码/截图复审通过。Root已读取其最终回执与CI，但这些不代替正式签名包或真实账号写入。源码单测使用任务私有SwiftPM overlay/CLT兼容库，已有dyld重复Swift类warning；正式构建不得使用DOCS_RS/ScreenCaptureKit stub或修改系统工具链。

## 门禁与回退

本机之前明确“稍后解锁，先继续准备候选包”；不以截图、旧PID、端口、Task行或时间经过猜测当前解锁/空闲，也不为观测提前freeze/ensure/create或扩大External Calls。候选准备不等于客户端已升级。真实社区写入仅用已获授权的测试身份与受控数据，不用真实业务数据凑验收。缺少窗口/权限时保留具体门禁，不将合成结果当通过。

沿用自有更新公钥与endpoint、Developer ID和明确login钥匙串的moxbots-notary；凭据不入Git或日志。旧057源ee055458/正式TAR b48604872eb967e3419aef0a8da1a33101603fa5883b08c4aadb0a0fe21c6c82不可变。回退须恢复启用前兼容配置并保留当前业务库及新旧身份/凭据槽，禁止恢复旧业务数据库；stable回退仅阻止新分发，不会自动降级已安装客户端。

本机公网路径曾有TLS握手间歇超时，完整GET约118KB/s；这是网络待验证边界，不修改代理/带宽或用TLS绕过代替验收。本次正式候选与原始证据保存于项目指针`work/release-058-20261016/owner/`及`output/updater-058-20261016/`，不将原生包、运行数据或密钥提交Git。
