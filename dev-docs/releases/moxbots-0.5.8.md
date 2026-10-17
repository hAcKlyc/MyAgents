# MoXBots 0.5.8 统一桌面发行

任务 `MOXBOTS-058-COMMUNITY-RELEASE-20261016`。唯一桌面发布 owner 仍为聊天 `01a12bc2-907a-7702-b6dd-788225c5dfe4`。

当前状态：正式签名/公证制品和隔离原生、真实社区验收完成；自有服务器不可变归档已 stage，外部完整下载验签进行中，stable 仍为 0.5.7。日常客户端仍为 0.5.7，未安装、退出或重启。后续生产状态以本记录的最终更新为准。

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
- [ ] 自有服务器外部完整正常 TLS GET、真实文件 stat→SHA256→stat 原文和独立核验。
- [ ] 057 完整回滚 proof、owned lock/CAS stable promotion、公开小型复验和释放本任务锁。
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
