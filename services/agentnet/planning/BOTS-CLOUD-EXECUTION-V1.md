# BOTS-CLOUD-EXEC-001 · 有限 Host 委派实施规划

状态：用户已确认按有限 Bot 委派实施；源码和本地联调推进中，尚未发布真实 Host 执行。已发布的管理员后台只提供登记管理。具体线协议见 BOTS-CLOUD-EXECUTION-CONTRACT.md；不更改既有设备配对的同账号权限。

## 目标与推荐范围

统一云后台负责跨用户 Bots 登记和治理；Host 是本机 Bot 配置、工作区、凭据和运行结果的最终 owner。推荐第一版只允许管理由 Host 所有者明确纳管的 Bot：创建受限工作区内的停止草稿、修改该 Bot 的允许配置、启停该 Bot 的准入和活动执行、查询原操作回执、逻辑删除或恢复。管理员角色不自动获得整机操作、私人会话/记忆、原始密钥或未纳管 Agent 的管理权。

个人客户端 Bots Net 的使用权限继续与平台管理权限分开。跨用户共享调用另用 Bot 级 grant；不借平台管理员身份、同账号设备管理或 Host 的整体执行授权实现共享。

## 已核实的接口缺口

本仓库 main 的 `host-management/v1` 固定 codec 包含 host.snapshot、config.set、resources.create、receipt.get。现有 Host owner 与配对链路在并行任务中已完成受控创建 disabled Agent 的真机验证，但尚无云端服务 controller、Bot 级委派授权和真实生命周期接口。云服务目前是身份/目录/中继 owner，不持有设备对端的解密身份；不能通过读取它的数据库实现 Host 管理。

因此必须新增受授权的 controller/delegation 能力，并由原 Host/协议 owner 共同定义接口。不手改 vendored AgentNet 1.1.0 包，不使用 SSH 写 Host 配置/SQLite 来代替用户路径，不从登记状态生成虚假的运行回执。

## 权限和身份设计

- 云后台仅接收实时有效的人类平台管理员会话。实际 actor 和原操作编号进入审计及请求绑定，不能改写成 Bot 所有者身份。
- Host 使用已有 owned device identity、JWT/DPoP 和实际连接 epoch 出站轮询；云端原 ServiceKeys 只签发受约束的 grant、intent、短 lease 和 revocation，不建立虚拟人类或整机 controller。签名密钥由原服务 owner 保管。浏览器只持有人类会话，不持有 controller 私钥或 Host 凭据。不持久保存用户 bearer 以充当机器授权。
- Host 所有者在已有受认证客户端内明确纳管指定 Bot/允许根和 controller，授予有限 operation scope、期限、permission generation；Host 在每次读写前校验，不因为设备在线或服务端角色成功而自动授权。
- 委派绑定 service instance、network、owner、目标 Host device/key generation、Bot ID 与 Host Agent ID。跨用户需要独立的授权路径，不能放宽现有同principal设备配对校验。
- 拒绝未知 operation、过期或撤销 grant、旧设备身份、错误 Bot/Host/网络、越界路径；所有凭据只经现有 write-only owner 接口，不返回原文。

## 操作与一致性

云登记 revision 与 Host effective revision 分别记录。命令携带 mutation ID、原始请求 hash、actor、目标 locator、期望 Host revision 和权限代次；Host 持久化原回执，先裁决后执行。断线/超时保持结果未知，只查原操作或用原请求重试，不新建操作编号、改目标或重置 revision 猜测成功。

创建先由 Host 验证可用根、用户部署授权和无敏感继承，再持久化 disabled Agent；成功回读后建立 Bot/Agent 映射。配置由 Host 校验真实 runtime/model/credential owner；登记引用不证明模型可执行。开始运行必须取得 Host 的接受与有效运行 generation；停止须确认准入关闭、活动任务终止/排空的实际结果。界面区分停止意图、停止中、未知、实际停止和失败。

Host 分配变更采用停止旧绑定→确认活动执行已处理→撤销旧权限→清空旧模型/指令→目标Host重新授权→新映射的流程。旧 Host 未确认时拒绝新 Host 运行，避免双Host。逻辑删除先禁止新调用，再按授权处理活动任务；恢复保持停止，重新授权，不恢复历史共享 grant。

## 实施顺序与验收

1. 已确认有限范围；主 owner 与既有 Host 任务协调固定源码基线，按版本契约与互斥文件实施。
2. 实现 Bot grant、短 lease、撤销与 Host 出站轮询，保留原 pair/relay 权限与管理路径。首阶段只启动/停止真实 Host Product Session，拒绝模型调用、IM、定时任务与共享。
3. 受控测试身份完成真实创建/配置/启动/停止/删除恢复；确认 Host 持久化、进程/Session generation、重启与原回执。
4. 至少两用户、两Host检查越权、身份切换、撤销、CAS、断线未知和迁移双运行防护。执行任何付费模型前沿用现有费用授权。
5. 交付main、锁定串行云/Host发布与备份回滚，再完成真实客户端和统一后台路径验收。共享邀请/调用与用量另按既有共享V1规划验收。

任何本地fixture、HTTP200或单次文件创建都不能替代上述真实执行验收。
