# MoXBots 0.5.8 统一桌面发行

任务 `MOXBOTS-058-COMMUNITY-RELEASE-20261016`。唯一桌面发布 owner 仍为聊天 `01a12bc2-907a-7702-b6dd-788225c5dfe4`。

当前状态：**自有更新服务器已发布并核验分发 0.5.8**（2026-10-17）。正式签名/公证制品和同源码隔离原生、真实社区验收已完成，完整外部 GET、实际文件哈希、自有签名和公开更新路径通过。日常客户端仍为 0.5.7，未安装、退出或重启；正式安装运行验收边界如下。

## 冻结源码与制品

源码固定为已交 main 的 `12449e4741d8f225a73ee540f68331b1bb8e24ac`，tree `2e710a308e5695cc65f241b1f5ec77c0386d8388`；精确源码六项 CI 通过。PR87 社区账号复用、PR89 浏览器登录自动检测、PR90 Goal/Cron v2 草稿、PR91 结果展开与时间口径，以及 PR88 非中断重启确认均包含。后来 main 的 PR92/PR93 等不自动进入此包，须下一未冻结发行单独验收。

- macOS arm64，0.5.8，bundle `com.moxbot.app`。
- 主程序 SHA256 `281c0a8477a55c8136a66e3b8f5106f4b6eea87002e0dd0acd7ecf10505b8617`。
- TAR `MoxBots-0.5.8-macOS-arm64.app.tar.gz`：336,365,173 bytes，SHA256 `155e6a68e2050df6fa6bf984ae7e2a7b2854e8d737997ad359727316993d2d19`。
- ZIP：344,959,688 bytes，SHA256 `dd33e0879fee388af92d315c477d8a6e2d52da9c19d97dfd64ab7c22adf69b59`，仅本地候选交付，非更新服务下载载荷。
- Developer ID 团队 `QJ5URBG9AP`；Apple submission `fdaafae0-7f7b-4598-bfde-4020eaf1a867` Accepted，staple/validate/Gatekeeper 通过。
- 自有签名公钥和 endpoint 延续；正式 Reader 精确字节/签名延续，未重建、重签或替换。

本机制品在项目指针 `output/updater-058-20261016/final-12449e47/`；详细证据在 `work/release-058-20261016/owner/native-12449e47/`。原生包、密钥、运行数据及真实账号原始证据不入 Git。

## 验收及明确边界

- [x] 精确源码 CI/main/完整源输入闭包、实际组件合成 UI 和独立最小窗口审阅。
- [x] 正式完整构建、固定生产 Reader/签名根、Apple 公证、自有更新签名；非实现者独立解包校验实际 TAR/ZIP 与 App。
- [x] 同源码 UpdaterQA：后台完整下载并验签，不自动安装；Enter 不确认重启；空 PTY 运行时普通非中断入口拒绝、保留进程及草稿；正常 EOF 后，由真实 Renderer checkpoint 和原生 admission 执行安装/托管重启，Goal/Cron 文本及完整设置恢复且可编辑，没有发送消息或创建 Goal/Cron 任务。
- [x] 同源码 ModelQA：正常浏览器授权并自动检测登录完成，无手动点击“检查登录状态”；已授权 cloud trial 测试身份创建唯一话题“0.5.8 发布验收（测试）”和唯一回复“用于验证桌面社区持久化，无需处理”；刷新、正常退出再启动后的列表/详情均回读相同内容；仅退出当前 QA 实例后旧内容清空且无发帖/回复入口。
- [x] Root 和非实现者独立核对 67 项原件及 Root 收据，共 68 项绑定；候选聚合验收通过。
- [x] 自有服务器外部完整正常 TLS GET、真实文件 stat→SHA256→stat 原文和独立核验。
- [x] 057 完整回滚 proof、owned lock/CAS stable promotion、公开小型复验及同任务 owned lock 释放。
- [ ] 最终交付记录合入远端 main。

这是“精确正式制品独审＋同源码隔离原生更新＋真实云端社区”的聚合验收，**不是正式安装运行验收**。正式发行主程序没有启动，production Reader 运行、日常 0.5.7→0.5.8 启用、真实 Host/模型执行、ASR 干净机器加载均未测。QA 含独立验收导航浮层，截图不能证明正式包外观一致性。原生 IME 本轮未重复；Escape 由 Root 观察，但缺单独封存原始动作证据，不能称独立复现。

UpdaterQA 的 0.5.8→0.5.9 是隔离测试版本，**不存在正式 0.5.9 发布**。Goal/Cron 恢复证明对应 QA058 的 v2 捕获，不声称旧日常057已经具备 v2 捕获。TaskStore 在捕获更新前后相同；后来已有 Memory Auto-Update 正常定时执行仅改变运行元数据，不应说当前字节永远不变。

测试钥匙串由验收环境生成密码并保存在受控位置，不是用户 Mac 登录密码。旧 v3 普通解锁失败 `-25293` 原因未知，原环境和备份保留；新 v4 单独受控创建/普通解锁通过，不修改日常钥匙串、ACL、搜索列表或锁策略。冷启动回读的前提是该隔离钥匙串已解锁，未证明锁定状态下恢复或生产 Reader 路径。

## 分发、启用和回退

仅使用自有更新地址 `https://140.143.183.232/updates/stable/darwin-aarch64.json` 和 `/srv/moxbots/updates`；不向 GitHub 上传二进制。归档地址按完整 SHA 固定，stable 切换须同一任务锁、精确旧057 SHA 比较、完整归档和签名/公开路径证据通过后原子替换。055/056/057 的归档与历史保持不可变。官网静态下载页、云服务和 Host 不在本次部署范围。

旧 stable SHA256 `67ed1f03d00f78e949063f15a983a2ca58fcc4b72158cf22801e680a47bd4300`；057 TAR SHA256 `b48604872eb967e3419aef0a8da1a33101603fa5883b08c4aadb0a0fe21c6c82`（336,184,128 bytes）保留。stable 回退阻止新分发，不会自动降级已安装客户端。实际启用仍须原 Renderer/执行 owner 判断空闲、兼容配置和 App 备份就绪，保留现有业务库与身份/凭据槽；未知或忙碌则保持 pending，不调用 stop/interruptWork=true。

## 私有证据索引

以下为可追溯摘要，不将其等同于 Git 内完整原件：

| 证据 | SHA256 | 结论 |
| --- | --- | --- |
| `independent-package-audit.json` | `44cad324e8777402885466f3f0dbd450d2f6f68c3c01f78a6772d92db15dfc8a` | 精确正式制品 PASS |
| `independent-qa-native-review.json` | `0b1f0963f9fa555deb0aed82108e32016c7c6f332d74500569bbb6440a7bf094` | 隔离原生更新 PASS_WITH_LIMITATIONS |
| `publication-preparation-v3/root-native-ui-business-acceptance.json` | `9cd63dd0d544255b6d824fb1b95003f21aae3b960d2a73c9024185cf30353761` | Root 聚合 PASS |
| `publication-preparation-v3/independent-native-ui-business-review.json` | `6a8134caf2c45cfdf5e006bc594d60fc97e930aad99a3255d38b9922f44a9e59` | 独立聚合 PASS，保留上列范围 |

失败和旧候选证据未覆盖：旧外层临时签名、旧 v3 解锁、v2 发布脚本跨目录路径错误均有封存记录；当前发布只使用独审通过的 v3 配方。

## 2026-10-17 实际分发结果

外部 Linux 101.42.11.29 于 02:26:31→03:13:41 UTC 单次完整正常 TLS GET；2828.742409 秒，118909 bytes/s（约 116 KiB/s）。这是本次实测吞吐，不代表已核实的云购买带宽。无代理、证书绕过、Range、重试或 redirect。HTTP/1.1 200、TLS verify 0、Content-Length 与实际文件336365173B一致，真实 inode/mtime/size 在完整 sha256sum 前后不变。17份原件独审通过后，Mac 用现有 minisign-verify 0.2.5 对同 SHA 全包实际验签通过。

03:18:51 UTC 更新源已核为0.5.8：stable SHA256 `51eb69bf88afd2a0490ac43d6e3d432617e3b2dd0e10d95961fe3de5f64753f8`、no-store；TAR immutable，两段1024B Range分别206且匹配归档偏移；不支持平台204；receipt/manifest/锁/历史路径404。旧057 stable的精确备份与完整旧归档保留，原子切换前再次完整hash验证。

完整公网归档：`https://140.143.183.232/updates/releases/0.5.8/155e6a68e2050df6fa6bf984ae7e2a7b2854e8d737997ad359727316993d2d19-MoXBots.app.tar.gz`。源码tag `v0.5.8`绑定冻结12449，不包含本记录之后的源码；GitHub不承载二进制。

下载原件独审 `independent-public-download-review.json` SHA256 `1c244e19640a4c01ab56b941f8606be238fef69d74423f026728ee2146a414be`；完整下载/验签proof `public-archive-gates.json` SHA256 `e8f2491a286d2695df1552055d86da49043e52adb9aff298c4de2b9e1ff7dc41`。原始证据和发布后独审仍保存在上述私有publication-preparation-v3目录。

客户端可检查更新并在后台下载，重启由用户确认；busy/unknown由原执行owner门禁暂缓。发布到stable不代表本机已启用，Root没有自动重启日常客户端。官网静态下载指针本次未改。

发布后独审 `independent-postpublication-review.json` SHA256 `012f22b2815e6fda8816fa339e7842d4a4c11cf8b38ce124be58d31e4f33e0a6` 已由 Root 重核全部原件后接受；其观察时锁尚未释放，随后 Root 的 `server-finish.json` 实际核验同任务锁释放、stable058及完整057归档不变。源码tag远端peeled SHA已核为12449。文档交付经正常PR/CI合入，最终main SHA以远端ref为准，不将文档提交SHA冒作制品源码。
