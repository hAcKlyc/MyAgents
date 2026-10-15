# MoXBots 0.5.6 正式远程更新

任务`MOXBOTS-056-REMOTE-RELEASE-20261016`，状态accepted（仅正式包与既有own updater服务器分发）。唯一发布聊天见`.agent-sync/plan.md`。用户在本聊天直接要求继续正式打包、公证、发布，且不得打断运行任务；本次未执行任何日常客户端退出/停止/安装/重启。

固定正式源码main `a81d2509fa92968ddaaed63416a2478d21b8a373`，官方tag `v0.5.6`；源码精确主干六CI通过。负责人记录PR67/main178b8047已先经六CI及merge tree等同性核验。之后的main提交不自动进入此冻结包，Project Context另批排队。

本包包含PR59缩放、PR60 Goal分组、PR62输出、PR63 Bots Ready、PR65明确确认后保存/中断/重启及PR66共享Session看板进度去重。后台检查/下载不自动安装；用户确认停止并重启与本次服务器发布是不同动作。

- [x] 生产profile arm64正式构建，4282 tracked输入前后及独审无漂移。
- [x] 自有updater公钥/endpoint连续；正式Reader SHA `284118e3f5e336c24ea35799242dbd277ba396d585e82b7956570a524f21a209`不变。
- [x] Developer ID QJ5URBG9AP、22嵌套Mach-O及外层、runtime/时间戳/entitlements/strict；压缩CLIProxy保留原供应商签名并与Apple票据关联，不冒称QJ签名。
- [x] Apple Accepted `24390592-089c-4557-a0d8-7e7b46ba5204`；上传ZIP SHA `a6ea3a16220da81487e7d06842e3d3942eebb0877957b3a56622b40798549cb5`，log精确对应且issues为空；staple/Gatekeeper通过。
- [x] TAR/ZIP独立解出12493 file/link/execbit及签名、票据一致；真实自有minisign-verify0.2.5通过。
- [x] 不可变归档上传及服务端完整hash/size；独立Linux正常TLS单次完整GET、实际stat→sha256sum→stat、原字节哈希关联和签名身份独审通过。
- [x] 同锁先核旧055完整归档及签名/manifest/receipt，备份旧清单及history/fsync后CAS原子切056；公开manifest/Range/cache/平台204/隐藏404和网站正文未变复验通过；055保留，自有锁已释放。
- [x] 非实现者补充六条合成React旅程及独立验包、发布脚本和公开接口审阅。真实原生与业务边界见下。

| 制品 | 字节 | SHA256 |
|---|---:|---|
| updater TAR | 336158365 | `685134d0a5129cf7d150b20c86e73736db4142ae150376eb8edeea077a6c8549` |
| 同一正式App ZIP | 344739590 | `f9b31491e5bf15b3073c41cd483833ae9c58b99c246b099e3c8f1256d493bdb4` |
| 主程序 | — | `98cddba4fbfe55d7089fac9b765869a662395884c16a83ae47af12c8f4625e75` |
| 公开stable原字节 | — | `af8b16c122bce9e470f5792345c6623ef97623a0ebaf17d65fa6131e0a83b504` |

既有入口`https://140.143.183.232/updates/stable/darwin-aarch64.json`；不可变归档同源`/updates/releases/0.5.6/685134d0a5129cf7d150b20c86e73736db4142ae150376eb8edeea077a6c8549-MoXBots.app.tar.gz`。本次不改Nginx、不新增端口、不部署网站/auth/Host，不另制DMG或覆盖055/官网下载资源。

实测公网GET 2859.27秒、平均117567B/s，只是此次完整传输数据，不代表云购买带宽。外部Linux直连复现慢速，已查活动Nginx无limit_rate、服务器低负载且传输存在较多TCP重传；出口/链路瓶颈是推断，云购买带宽及具体限速原因未确认，未改代理/网络或购买带宽。TAR/签名/ZIP及README、DELIVERY、SHA256SUMS在项目指针`output/updater-056-20261016/final-a81d2509/`；原始证据在`work/release-056-20261016/owner/`，摘要见同目录本Git evidence JSON。凭据、原始业务数据及原生包不入Git。

0.5.5回滚归档SHA `31ee2b5eb9a4afb846dc3b4e211fb153290bc06cd700a69a914734d0a232f731`/336038989B、原清单SHA `2cd4fcea767da9802ed531db996a66e73a1f0b5166c995e8cd353d53258fda66`与原签名完整保留。恢复stable只停止继续分发，不使已升级客户端自动降级；后续源码变化使用新的补丁版本，禁止056同版本换包。

## 验收边界与接续

发布前只读实际发现日常App已为055且主程序等于正式055，覆盖旧054记录的当前事实；本任务不知道其安装事务，不能倒推更新安全验收。没有用PID代替generation，也没有获取或绕过锁屏准入。当前发布只证明056正式制品与服务器分发；客户端后台发现/下载、用户确认安装、实际版本/数据，以及真实Host、薪资/有数据原生看板、精确IME、有任务/录音/草稿与失败恢复均另验。

本轮执行：Root串行签名/服务器操作，复用两个内置独立审阅者做UI与源码/包/分发审阅。独立审阅发现三处下载取证缺口，均在部署前修复复核；本发布任务未触发业务模型或Host任务调用；057来源聊天的Provider补验另记。模型/effort与Token用量运行时未提供，不虚构节省；正式构建实测771.11秒、公证上传61.84秒。Git交付遵守正常PR/CI/main流程，最终实际远端包含SHA保存在外部DELIVERY回执与对用户报告中，避免自引用。
