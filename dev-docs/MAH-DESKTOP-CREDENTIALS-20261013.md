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
- [ ] 独立复核 Actor 接线与打包 / publisher pin / 不重签策略，真实 root release check。
- [ ] 固定组件实际 build / sign、源码与制品 provenance、最终 App 与解压后 strict seal；两次桌面构建的 reader 字节和 cdhash 完全一致。
- [ ] 新组件首次迁移、冷启动 / 同组件桌面更新后自动在线，不再出现日常授权循环。
- [ ] 当前最终头 CI / 审查、同步最新 main、合入远端并验证祖先与树、安装包和运行版本对应。

模型密钥目前未配置，执行关闭、Agent 无 channels，真实付费调用为 0。真实模型推理由用户后续在产品内配置凭据并明确费用授权，不是本轮配置 / 创建持久化验收的必需项。

## 固定组件交付约束

reader 与 parent 使用不同 identifier，匹配同一发布者叶证书，且验证各自真实运行 hash 对应磁盘签名和同一 App。MoXBots macOS 固定 feature 缺组件必须失败；默认 MyAgents 和非 macOS 保持原后端。清单放在外层 App 的签名封印内；复制组件后仅签外层，禁止 deep / nested 强制重签。

组件 v1 初次构建与签名保存不可变制品及源码 / lock 摘要，正常桌面更新从该制品复制。修改组件代码、依赖或发行者属于组件升级，应显式版本化、重新审查并说明可能需要授权，不以 cache 未命中偷偷重建同一版。会话与设备钥是不同 OS 条目，不保证首次迁移恰好一次密码输入。

后台子管道预算 5 秒、显式恢复总期限 180 秒；同步签名 seal 校验不能由管道循环硬中断，必须在真实大 App 中测量，测试不得声称已验证整链硬期限。

## 接续与协作

集成 owner 保持 `feat/mah-management-device-pairs` / PR #14；固定组件实施在原 crypto 文件范围冻结，独立 packaging 分支从真实 main 建立并经 start / task-init 后纳入已授权 PR14 依赖。原 AgentNet、Host 与云状态不由新组件改写。

本轮主 Agent 负责诊断、Actor 接线、集成、实际版本对照和最终交付；原 crypto worker 实施 / 复核组件及缓存；packaging worker 独占隔离工作树的构建资源。三名 native 参与者，未调用外部模型；实际模型变体、effort、token 和费用未由运行时提供，不作推算。复盘：固定证书被误当成完整更新授权条件导致一次更新验收失败；今后先验证 OS partition 与冷启动 / 跨构建行为，再承诺免提示。

下一步：完成接线 / 打包审查并提交阶段源码，构建固定 reader 与 reviewable App。当前 b116 已恢复可用，暂停新系统授权请求；不要用反复输入密码替代根因修复。
