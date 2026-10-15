# MOXBOTS-UNIFIED-055-DOWNLOAD-20261015 接续

本任务以分支记录.agent-sync/tasks/codex-moxbots-055-download-20261015-18d63ba5.md为验收清单。用户授权只在统一负责人完成完整HTTPS下载校验及stable0.5.5切换后，更新既有公开IP官网下载页。当前正式055ZIP已公开且完整匿名GET/SHA/CRC通过；网页仍054，等待唯一负责人当前发布租约释放后做两文件静态覆层。以私有execution-status.json的phase为最新状态，不重复上传/下载。

## 权威输入与排除

- Git:https://github.com/heavenzhang/MoXBots.git；本任务自有worktree:/Users/zhangshaohua/Documents/Codex/2026-10-14/moxbots-ip-download，分支codex/moxbots-055-download-20261015。
- 统一负责人thread01a12bc2-907a-7702-b6dd-788225c5dfe4独占055正式制品和/srv/moxbots/updates；本任务只能联系该已获人工授权收件人，不新增其他跨聊天收件方。
- 固定055source52bf61602522fb28715edf620d98ad8e3deee842（PR54），不是未来main0.5.6。正式ZIP344623193bytes/SHA b2bf83f464e7311869eb31a51db5427d67b7baf9099b6ab91de9672f53f8f4be；正式TAR336038989bytes/SHA31ee2b5eb9a4afb846dc3b4e211fb153290bc06cd700a69a914734d0a232f731。TAR与ZIP格式不同，hash不可互换。
- 私有证据位于WPS项目pointer work/unified-055-20261015/release-055-52bf6160，主Agent预检位于output/unified-055-download-20261015。勿输出或读无关credentials/notary private配置、daily profile或业务内容。
- 不启动、退出、替换、自动化或安装/重签日常/QA App，不读Keychain，不读账号手交文件，不执行Host/模型或重试登录，不重启/修改cloud/auth/Nginx/TLS，不改stable。055未完成native项目留056。

## 门槛和后续操作

1. 使用compact wait_threads，只读具体新增原始receipt，避免导入整段会话。负责人Linux完整GET须明确完成和SHA/size/签名成功；partial、Server磁盘一致、HTTP200或自报不够。现有055-release-progress仍in-progress时，停止本次检查，等待下一次。
2. 同时确认负责人stable CAS成功及回滚资料，并对源码配置定义的现有stable/darwin-aarch64.json做一次小JSON GET，核version0.5.5、URL归属055/正确TAR和签名。不得代其切换/解锁/清理锁；冲突锁仍持有则等待明确交回。
3. 门槛通过后先查已有GitHub055资产，复用完全匹配的不可变ZIP，避免重复。若尚无手动包，可沿054流程在已有heavenzhang/MoXBots公开prerelease中上传并发布本次已接受ZIP及SHA256SUMS，不加新公网服务/路由。建议immutable tagmoxbots-trial-0.5.5-52bf6160，使用前查不存在/未被他方占用；不得覆盖或重签已验收文件。上传和完整匿名网络readback只能在负责人完成唯一大GET后开始。先用draft上传验digest/size，公开后完整下载SHA/CRC；不能以服务端digest代替完整readback。
4. 沿用trial schema1更新services/website/trial-release.json，version0.5.5 ·52bf6160、source52bffull、bytes344623193、sha b2bf...、signed/notarized true、真实immutable ZIP URL。更新README/本任务记录中的交付状态，文档不夸大055 native/Host结果。原有check-download.cjs在output/unified-054-20261015可作模板，使用新证据目录和新expected JSON；小范围既有页面回归由主Agent负责，无需新UI框架。
5. 官网发布前再次读取actual/var/www/moxbots-website/current和download/index.html。保留最新设计、全部旧hash清单/旧包。获取四把原顺序非阻塞锁：moxbots-cloud-model-center.lock、moxbots-login-ux.lock、moxbots-nginx-deploy.lock、moxbots-website-release.lock。若被占用结束本次检查，不能force/kill。复制当前静态目录为新immutable release，仅新hashed release JSON+HTML body data-release-manifest引用；所有其他文件库存保持，Nginx config/cloud PID不变，无reload。备份/root/moxbots-055-download-<metadataSHA8>，rollback仅在仍持有自身pointer时恢复旧pointer，不覆盖后来发布。054私有deploy-website.py可作模板但有硬编码，不得直接执行；按本次实际base/source/路径参数重写并复核。
6. 实际strict HTTPS匿名浏览器1440x960和390x844：下载按钮、version/大小/source/notes/SHA/signed/notarized与实际包一致，无pageerror/横向溢出，检查details交互，截图后人工复看。只用新headless profile或Codex浏览器，不接触用户Chrome/daily App。HTTP有限回归root/download/slash308/hashedJSONJS mimehash/保留旧manifest/health/admin/feedback/unknown404；不要把猜测auth或updater路径404当功能成功。
7. staged本任务路径，最小确定性检查+required CI，创建/attach元数据PR，按仓库规则同步最新main和必要CI后合入、不force。验证远端main包含reviewed head、合并tree、liveJSON和HTML引用；App055仍由52bf制成，不因main已有056就换制品。
8. 完成后更新本任务receipt/delivery record/PR，停本任务自己的heartbeat，保留其他自动化及所有其他owner。用户最终报告页面链接、055source、metadata mainSHA、哪些测试通过和daily未动；仅阶段准备或等待不得标complete。

使用已有SSH配置/BJCloud.pem路径，凭据留在受控文件，不复制到Git/通知。发布写入前需确认负责人释放冲突维护租约。服务器在140，本任务无需SSH101或新建隧道。
