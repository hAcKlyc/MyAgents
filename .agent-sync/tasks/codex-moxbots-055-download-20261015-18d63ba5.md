<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-055-download-20261015 -->
<!-- git-project-sync-task:base=bf1851e4e2b914211e434f5b921a1bcefb9bba93 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-UNIFIED-055-DOWNLOAD-20261015

## Objective

用户于2026-10-15直接授权：继续跟进唯一发布负责人01a12bc2-907a-7702-b6dd-788225c5dfe4，完整下载校验和stable切换完成后，再把 https://140.143.183.232/download/ 更新到0.5.5；不动日常客户端。本任务只负责公开手动ZIP下载的发布接收、网站元数据、保留现有设计的静态覆层和远端main交付。负责人独占/srv/moxbots/updates、签名/公证及stable发布，本任务不切stable、不写该目录、不重启任何服务、不操作App/GUI/凭据、不执行模型或Host业务。后续0.5.6源码不得混入冻结0.5.5制品。

## Acceptance criteria

- [x] 指定仓库https://github.com/heavenzhang/MoXBots.git、clean分支/base/remote和start/task-init已核实；沿用自有metadata worktree，不改其他工作区。
- [x] 用户授权的唯一负责人已收到接续消息，确认本任务负责IP网站串行overlay；尚未开始网络大包传输或拿服务器写锁。
- [x] 冻结055源码52bf61602522fb28715edf620d98ad8e3deee842已在远端main历史；正式ZIP本地size/SHA/CRC与发布回执一致，formal App签名/票据/Gatekeeper独立只读复验通过，未启动App。
- [x] 负责人完成唯一Linux完整HTTPS GET，读取完整原始回执确认336038989-byte TAR/SHA31ee2b5eb9a4afb846dc3b4e211fb153290bc06cd700a69a914734d0a232f731和自身更新签名，不能用partial或server磁盘hash代替。
- [x] 负责人完成stable CAS0.5.5，核原始promote/rollback回执和实际 https://140.143.183.232/updates/stable/darwin-aarch64.json version/URL/signature与冻结055一致；等其释放冲突维护锁。
- [ ] 门槛通过后发布或复用匹配的immutable公开GitHub ZIP，完整匿名网络下载/SHA/CRC、签名公证及制品对应关系通过；禁止覆盖旧055/054资产。
- [ ] 更新services/website/trial-release.json及必要记录；最新main只作metadata集成基础，不重新构建055。现有静态设计不改。
- [ ] 重新读取live symlink/HTML，四把既有锁、backup/ownership-checked rollback、CAS覆层仅新content-addressed JSON及HTML引用；不改Nginx/TLS/auth/cloud/updates或其他服务路径。
- [ ] 真实IP网页桌面1440x960/手机390x844版本、大小、下载/源码/发行说明、签名/SHA、无JS错误/横溢和有限route回归；PR/必要CI通过、main合并及远端tree/live manifest核实。

## Completed

负责人已确认正式ZIP路径为项目pointer output/updater-055-20261015/final-52bf6160/MoxBots-0.5.5-macOS-arm64.zip，344623193bytes，SHA b2bf83f464e7311869eb31a51db5427d67b7baf9099b6ab91de9672f53f8f4be。发布source52bf6160、tested CI headcd473c88，PR54已交main。源freeze及签名/公证/roundtrip/独立DMG回执在work/unified-055-20261015/release-055-52bf6160。主Agent只读复验精确ZIP和formal App，不读daily App/profile/Keychain。

## Verification

私有本任务证据 output/unified-055-download-20261015/local-candidate-audit.json：ZIP size/hash/CRC通过；formal App /private/tmp/moxbots-055-release-52bf6160/MoXBots.app version0.5.5/com.moxbot.app，codesign deep strict、stapler和Gatekeeper通过。此项没有运行App，ZIP完整roundtrip由发布负责人已有回执负责，不能冒称native Host或真实模型验收通过。

只读官网preflight仍为releases/e7e283c096a1654bad1dddd7f1e9de874fcf1a21-download-054-ce86cc4f，index SHA2f17d477df3d3b51709b510cf43c1a016bc35e3e05dd9bc494cfa91eee9143b2；发布时必须重读，不能盲用此snapshot。当前官网下载和stable保持054，未执行任何公开切换。详细门槛与恢复顺序见dev-docs/moxbots-055-download-handoff.md。

选择依据：唯一负责人已承担复杂打包/服务发布，本任务是小范围顺序metadata/UI回归，零新增worker、主Agent负责页面验收，避免重复构建及140大包流量。未发生模型切换；不调用外部原因：明确采用ai-yaoren-local纯内置模式。费用未知，不以旧Goal或其他聊天token统计冒称本轮成本。

## Blockers and unknowns

负责人原始进度055-release-progress.json仍显示完整HTTPS下载进行中、stable等待其结果，实测约120KB/s。未证明云限速；不并行大包、不重试叠加流量。已有另一聊天的moxbots-0-5-5 heartbeat负责其看板/客户端验收，非本任务；不得修改或重复其工作。本聊天的跟进只负责上述公网下载页依赖。

055未完成真实Host/native项目继续明确留在056，不能反过来扩张本次网站更新范围或宣称其通过。不可用其他聊天转述作为日常安装/新账号/付费调用授权。

## Next step

按10分钟有界跟进唯一负责人/原始发布回执；状态未变化则结束本次检查，继续保留054网站。不拿服务器写锁。两项负责人门槛均通过后再执行手动ZIP发布、下载页metadata/静态覆层、真实页面检查及main交付。只在完成、失败或需要用户行动时汇报。完成后停止本任务自己的heartbeat，不改其他任务自动化。

## 已启用的接续

本聊天heartbeat moxbots-0-5-5-2已由App确认ACTIVE，每10分钟执行上述受限跟进；状态不变时静默，满足两项负责人门槛后才进行已授权的网站交付。现有其他聊天的moxbots-0-5-5自动化未改。最终完成后只暂停moxbots-0-5-5-2，不暂停他人任务或任何Goal。

## 2026-10-15 发布门槛已解除

已逐项核对public-archive-gates及其原始curl、stat前后、sha256sum输出，所有evidenceHashes一致；完整336038989-byte TAR通过正常TLS，非Range和partial。stable实际小JSON的SHA2cd4fcea767da9802ed531db996a66e73a1f0b5166c995e8cd353d53258fda66、version055、URL和signature与冻结回执一致；server-promote/server-finish确认CAS及Root租约释放。当前正发布手动ZIP，网站尚为054；不操作updates或客户端。

## 2026-10-15 ZIP 上传 checkpoint

上述历史进度中的下载阻断已解除；本轮的阻断为GitHub ZIP上传仍在进行。候选metadata提交4dac206b，draft tag moxbots-trial-0.5.5-52bf6160已建立且target52bf正确；校验文件已uploaded，ZIP尚未完成。保持现有上传，不新增重复大传输、不覆盖资产；后续从私有execution-status.json中的PID/session和GitHub资产状态接续。第一次代理上传已仅停止自有未完成进程；小请求证实直连可用后改为单次upload进程NO_PROXY=uploads.github.com，未修改系统代理或新增隧道。官网仍054，无服务器写锁或部署。完整接续边界/已过和待验项见dev-docs/moxbots-055-download-acceptance.md。
