# MAH-DESKTOP-CREDENTIALS-20261013

目标：Linux 轻量 Host 能由桌面 AgentNet 配置模型、创建 Agent；MoXBots 保存的云会话和设备钥在日常重连及桌面升级时复用授权，保留原 MyAgents。沿用原 Linux / 云服务目标和授权，不新增模型收费请求、系统密码存储、全局凭据 ACL、系统信任或公网管理端口。

## 当前证据与完成标准

- [x] 已定位恢复实际读取的两类记录：独立云登录 session Token、设备签名私钥；Mac 登录密码只交给系统窗口。
- [x] b116 真实 native snapshot → Kimi 默认设置持久化 revision 2 → 禁用 Agent 创建回执与实际服务器目录 / 配置。
- [x] 仅重启本任务 Host 两项服务；配置字节不变、原服务保全，桌面关闭再打开详情得到新快照和同一 Agent。
- [x] 同发布者 3aa 冷启动授权失败；精确 b116 回滚冷启动无需新授权即 Linux-Host 在线，原 MyAgents 保全。
- [x] Apple primary source 与实际对照一致：self-signed cdhash partition 不能由固定 DR 单独解决。未读取用户真实 ACL。
- [x] 固定 reader v1 的闭集角色、manifest、匿名管道、范围、读写删结果与取消 / 期限代码；固定 38、legacy 33、portable 13 项聚焦验证通过，真实 Keychain 用例仍 ignored。
- [x] 普通 Actor 完整 KeyScope 单项缓存与 binding / generation 接线；断线仍查服务器，不直接复用过期网络身份。
- [x] 独立复核 Actor 接线与打包 / publisher pin / 不重签策略；真实 root 默认及 MoXBots fixed release check --tests 均通过，裸 macOS MoX 无 feature 实际 Cargo fail closed。
- [x] 固定组件 v1 实际 build / sign、publisher / 架构 / SHA / cdhash / 输入 provenance；两个实际 prepare 的复制字节一致，源闭包与受信制品双 pin 实际通过，不读取真实凭据；18 项相关 Node 回归通过。
- [x] 首个完整 4fc9a2b1 App、签名及实际 ZIP 解压 strict seal 通过，reader 与不可变制品完全一致。
- [x] 第二个 07e226a9 完整 App / ZIP / 实际解压 strict seal 通过；与 4fc9a2b1 的 reader 字节、SHA 和 cdhash 完全一致，未安装第二包冒充免提示验收。
- [x] 用户授权首次迁移，两项记录读取及身份校验成功，原云账号恢复、Linux-Host 在线；远程读到 kimi-for-coding 和既有禁用 Agent。
- [ ] 同一 4fc9a2b1 安装冷启动仍返回 AUTHORIZATION_REQUIRED，后台停止且 root 未再次发授权。用户确认两项均选“总是允许”；exact session metadata-only 检查确认 User keychain 已解锁、reader partition 已保存、stored reader requirement 匹配 reader 且不匹配 parent。未读 secret、未改 ACL、UI 禁止；该诊断使用 Apple read-only SPI，不能替代 native 读取验收。不能宣称免提示修复完成。
- [ ] 同组件桌面更新后自动在线，不再出现日常授权循环。
- [ ] 当前最终头 CI / 审查、同步最新 main、合入远端并验证祖先与树、安装包和运行版本对应。

模型密钥目前未配置，执行关闭、Agent 无 channels，真实付费调用为 0。真实模型推理由用户后续在产品内配置凭据并明确费用授权，不是本轮配置 / 创建持久化验收的必需项。

## 固定组件交付约束

reader 与 parent 使用不同 identifier，匹配同一发布者叶证书，且验证各自真实运行 hash 对应磁盘签名和同一 App。MoXBots macOS 固定 feature 缺组件必须失败；默认 MyAgents 和非 macOS 保持原后端。清单放在外层 App 的签名封印内；复制组件后仅签外层，禁止 deep / nested 强制重签。

组件 v1 初次构建与签名保存不可变制品及源码 / lock 摘要，正常桌面更新从该制品复制。修改组件代码、依赖或发行者属于组件升级，应显式版本化、重新审查并说明可能需要授权，不以 cache 未命中偷偷重建同一版。会话与设备钥是不同 OS 条目，不保证首次迁移恰好一次密码输入。

后台子管道预算 5 秒、显式恢复总期限 180 秒；同步签名 seal 校验不能由管道循环硬中断，必须在真实大 App 中测量，测试不得声称已验证整链硬期限。

## 接续与协作

集成 owner 保持 `feat/mah-management-device-pairs` / PR #14；固定组件实施在原 crypto 文件范围冻结，独立 packaging 分支从真实 main 建立并经 start / task-init 后纳入已授权 PR14 依赖。原 AgentNet、Host 与云状态不由新组件改写。

本轮主 Agent 负责诊断、Actor 接线、集成、实际版本对照和最终交付；原 crypto worker 实施 / 复核组件及缓存；packaging worker 独占隔离工作树的构建资源。三名 native 参与者，未调用外部模型；实际模型变体、effort、token 和费用未由运行时提供，不作推算。复盘：固定证书被误当成完整更新授权条件导致一次更新验收失败；今后先验证 OS partition 与冷启动 / 跨构建行为，再承诺免提示。

下一步：本机安装与窗口 owner 已归还 root；4fc9a2b1 首次迁移在线而同构建冷启动失败；root 已精确恢复 b116404e 并真实验证两设备 / Linux-Host 自动在线、模型 / 既有 Agent 可读，未再发授权，原 MyAgents 保全。失败试用包及两个新包的签名制品已保留。已反证“未选择总是允许”“钥匙串当前锁定”“helper ACL 错捕获 parent requirement”这三种解释；继续核对非交互读取路径，不自动重发授权。已同步 main 的管理后台源码但不部署其新增模块；免提示关键门禁通过后再完成第二桌面构建、当前 CI 和 PR14 主干交付。

CI 修复：07e226a9 的 DOM 用例只等 adapter promise 而未等父组件提交，改为等待实际异常标题和撤权提示；不放宽权限断言。完整 DOM 261 文件、2213 项通过，修复提交 0fb5f31f。该头的远端 CI 另行等待；此前其余平台及独立云服务检查成功。


## 新记录迁移修复（实施中）

- [x] 用户再次确认两项均选择“总是允许”；停止重复真实授权与旧记录读取，当前桌面保留已在线 b116。
- [x] 独立 Host 基础拆为 PR #24：精确 b116 与最新 main 组合，不包含固定 reader / 新记录迁移；源码检查及相关 Node/DOM 通过，完整 CI、main 交付仍等待。
- [x] 固定 reader v1 的源闭包与签名字节 SHA 再核验一致；不重签、不更换发行者、不更改旧 ACL。
- [x] 新本地 slot：完整原协议 scope 仅映射为本地 OS 条目，原协议身份/CSR/服务器绑定不变；非秘密路由台账原子提交，删除后不回落旧条目。旧记录保留回滚。
- [x] 已验证 session/key 的本地复制、同锁 write/readback/route 提交、不同新绑定拒绝覆盖、删除屏障与只读 seed 接线；独立审阅关闭已确认 P2。主 Agent MoX production release check 通过，实际源 portable harness 19 passed / 1 subprocess helper ignored（含真实进程锁测试），worker Clippy 通过，reader prepare 13 项通过。完整 App 单元验证仍在编译；真实 OS 读取/冷启动尚未验收。
- [ ] 新候选真实首次迁移、同包冷启动、另一个桌面构建更新后自动恢复；未安装新代码，不能称免提示已解决。

此前临时钥匙串 cold 测试的子进程在查询前调用过仅针对自己随机密码的 Unlock。因此成功不能排除解锁凭据缓存影响，不能单独排除真实 ACL 路径差异。正在准备不向 cold 子进程提供密码、不调用 Unlock，且包含不同签名 identifier 的拒绝对照；这仍是隔离 OS 诊断，不是产品验收。


隔离拒绝对照已实际运行：同一 hardened-runtime C 源分别签为 A/B 不同 identifier、同一发行者；cold 子进程不接收密码或 Unlock。仅 A 受信的随机临时条目，A 读取成功，B 返回 -25293；临时 keychain 经 API 删除，默认项/搜索列表保全、私有目录删除均通过。证据仅证明本机这种新建条目的 ACL 可区分两个进程，不证明用户旧记录或真实 MoXBots 冷启动已修复。受限原文为 SYNTHETIC-KEYCHAIN-NO-UNLOCK-PROOF.json，不入 Git。


编译/CI 接续：主 Agent 真实 release App 构建 0b9c2cf9 成功，来源与 clean tree 过程一致；尚未签名/安装，不视为免提示完成。本机 AgentNet 单元 146 passed / 1 helper ignored，caller 针对性 3 项通过。该头 Linux 完整测试通过，但 Clippy 拒绝测试中的直接 Command::new；已改用项目 process_cmd 封装，独立实际 process_cmd/process_cleanup harness 的 12 项及项目 redline/strict Clippy 通过，不放宽规则。下一包基于本 test-only 修复重新冻结构建，当前头 CI 仍需等待。
