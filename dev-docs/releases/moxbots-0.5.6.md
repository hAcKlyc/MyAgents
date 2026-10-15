# MoXBots 0.5.6 远程更新发行

任务：MOXBOTS-056-REMOTE-RELEASE-20261016。唯一发布聊天和人类授权见canonical `.agent-sync/plan.md` 的Deployment coordination；当前状态 preparing，尚未声明远程发布。

固定源码候选main `a81d2509fa92968ddaaed63416a2478d21b8a373`；版本0.5.6。包含PR59缩放、PR60 Goal分组、PR62输出、PR63 Bots Ready、PR65明确确认后保存/中断/重启及PR66共享Session看板进度去重。正式包仅取此快照；后续main不会静默进入。

- [x] 实际核读用户发布及负责人选择原文，核实仓库/版本/候选，保留旧工作区。
- [ ] Deployment coordination记录合入main并复核；源码/精确CI及变更范围审阅。
- [ ] 现有publisher/锁/磁盘、正常TLS stable055、055回滚归档及原签名核验。
- [ ] 正式生产profile arm64构建；原Reader固定字节、自有公钥连续、Developer ID/hardened runtime/entitlements/严格签名。
- [ ] Apple Accepted、staple和Gatekeeper；最终TAR及自己的签名、解出内容一致。
- [ ] 不可变056上传后远端完整hash/size，正常TLS公网实际完整GET及真实文件hash/签名独审。
- [ ] 同任务锁内前置055回滚核验、旧stable CAS/备份/fsync/原子切换；公开manifest、Range/cache、平台204及隐藏路径404复验。
- [ ] 最终Git/发布记录与实际制品版本/hash对应，释放自有发布锁。

本次范围不含日常客户端安装/退出/任务中断。旧055是否已安装、未来056后台发现/下载、用户确认安装、真实薪资看板/Host/精确IME等均须独立实际证据；锁屏不能绕过，也不将静态构建、公证或服务器发布当作这些路径通过。

原始私有记录和产物位于项目指针`work/release-056-20261016/owner/`及`output/updater-056-20261016/`；不提交私钥、凭据、原生包或业务数据。
