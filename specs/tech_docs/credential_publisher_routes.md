# MAH-CREDENTIAL-PUBLISHER-ROUTES-20261014

目标：MoXBots 的正式签名更新可以恢复既有云会话和设备身份；迁移成功后普通启动不重复触发系统授权。保留原 MyAgents、旧凭据及固定 reader 的协议和源闭包。

## 当前实测与边界

正式签名候选 a83874482a97ec282531caf58f6ca2adbc0084e2 已经用户批准、备份后安装，实际 Node sidecar 源提交与候选一致。显式恢复的两项旧凭据读取成功；随后 identity-save / identity-route 返回 authorizationRequired，未提交新路由。当前未通过真实迁移、冷启动及不同构建更新验收，不作为可接受的下载版本。

核对 a838 实际源码：`identity-save` 直接调用目标 scope 的 `OsIdentityStore::save_pending`，没有再次读取来源；该保存函数先非交互读取目标，失败发生在这一路径，早于云会话目标的保存。旧本地签名与正式签名共用物理 slot 是需要消除的冲突条件，但没有读取系统 ACL 内容，不把 ACL 的具体绑定或用户是否选择永久允许当作已证实原因。已停止自动授权重试。新跨发布者迁移也不得新增“显式授权来源成功后再后台重读来源”的依赖；采用账本事务锁内授权、验证和切换。旧 v1 格式未保存删除状态，不能从其 route ID 恢复从未记录的历史删除信息；已选条目缺失时仍拒绝回退。

## 改动约束

- 逻辑 scope/route ID 保持原字节；物理 slot 采用 local-v1 / developer-id-v2 的闭集发布者族。
- v1 账本指向既有 local-v1。新账本显式记录已提交的族和删除屏障；已选路由缺失或不可访问时不回退到其他族或原始记录。
- preserve-existing 迁移在同一跨进程账本事务锁内读取并验证当前源，写入编译期目标族，确认身份与绑定仍一致后原子切换。显式授权恢复在锁内授权读取一次，直接使用已验证的内存值；普通启动不触发授权。失败、取消或写入结果未知均不切换。
- 身份的 Deleted route 不允许同 generation 复活。云会话只有既有完整 fresh-auth 流程可以建立新授权；恢复不解除删除屏障。
- 编译脚本从同一个固定 reader release 选择 writer family，macOS MoXBots 缺失或未知值拒绝构建；运行时环境不能更换目标族。MyAgents 和 Linux 存储路径不启用桌面路由。
- 不重签固定 reader，不修改原始 crypto/protocol 源闭包，不输出或写出明文凭据，不修改系统 ACL，不删除旧记录来规避授权。

## To Do / 验收

- [x] 安装 a838 并记录实际失败边界，停止自动重试。
- [x] 实现打包 reader release → 编译期 writer family 绑定，17 项 reader 打包检查通过。
- [x] 完成存储路由与调用者实现、故障/删除/并发验证及独立代码审阅；包含最终过期 fence 和容量副作用前预检。
- [ ] 同步主干，提交并通过准确提交的 CI。
- [ ] 冻结统一源码（包含项目看板），完整重建 Web/Node/bridge/CLI/native，正式签名、资源和解压校验。
- [ ] 准备两个完整重建、正式签名且 CodeDirectory 不同的候选用于首次迁移与跨包更新；保持桌面/Host功能源码一致，第二构建追加验收记录并同步主干的独立云后台登录更新。两包来源、哈希和回退准备好后合并一次具体运行确认，再备份安装与真实迁移、冷启动、更新验证。
- [ ] 真实桌面远程配置模型参数、创建禁用测试 Agent、重启后持久化；不调用收费模型。
- [ ] 完成主干交付及远端验证，独立记录已发布与实际验收状态。
- [ ] MOXBOTS-DOWNLOAD-001：将已接受新包发布为 GitHub 试用版，官网新增真实下载页并公开，核验匿名下载及 SHA-256。

用户已明确授权官网和试用下载公开。官网源位于独立 Sites 工作区；公开内容不含账号、测试服务器、凭据或授权链接。候选包未通过前不将旧失败候选标记为可下载的当前版本。

行为测试首轮：source-exact 临时账本测试在 local-v1 / developer-id-v2 下均为 18 通过、7 失败、1 私有子进程入口忽略；已保留失败源码哈希和日志。失败涉及测试创建 v1 账本的权限、v2 删除屏障断言及取消场景复用已存在目标，正在修正 fixture，生产严格权限不放宽。实际 Tauri 测试已完成链接并复现相同失败；本机需要临时 Swift 库搜索路径及系统 Swift dyld fallback，不修改全局配置。检查通过不替代这些行为测试。

修复后：两个编译期 family 各 25 项 source-exact 临时账本测试通过，来源文件前后哈希一致，测试依赖均来自生产 Cargo.lock。主审实际 Tauri 测试为 credential slots 25、owned account 15、identity authorization 2 项通过；一项私有子进程入口只由父测试定向调用。reader 打包 17 项通过。真实 `MYAGENTS_BUILD_PROFILE=moxbot` + `moxbot-credential-reader` feature + developer-id-v2 编译检查通过，CI 新增相同配置检查，未用手工 cfg 替代正式构建门禁。独立末轮源码审阅无剩余确认阻断。真实钥匙串迁移与冷启动仍开放。
