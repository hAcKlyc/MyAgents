# MoXBots 0.5.5 发行记录

任务：MOXBOTS-055-RELEASE-FREEZE。用户要求先发布冻结0.5.5到既有更新服务器，后续改动进0.5.6。服务器发布、客户端安装和后续真实业务验收分别追踪。

## 发行状态

**2026-10-15 16:39（Asia/Shanghai）：055已发布并完成公开接口复验；客户端仍054，未安装或重启。**

- [x] 发行源码是远端main `52bf61602522fb28715edf620d98ad8e3deee842`（PR54），该确切main的六项CI全部成功。4233项tracked输入与构建前冻结一致。
- [x] arm64正式App：22个嵌套Mach-O及外层Developer ID、strict/deep、hardened runtime、时间戳与正式entitlements通过；生产Reader固定字节及manifest保持。
- [x] App公证 `23adaceb-da79-4d2f-81e4-54aedb8c6046` Accepted，staple/Gatekeeper通过。TAR/ZIP完整解出后文件/链接/执行位相等，票据/签名通过。
- [x] 最终TAR已用MoXBots自己的更新私钥签名；Root与非实现owner以实际minisign-verify0.2.5和生产公钥独立验签通过。公钥与已安装0.5.4信任根一致。
- [x] DMG公证 `4090bc89-0ef7-4ba8-9150-23b834a396fb` Accepted，staple/Gatekeeper通过；独立只读挂载核验包内App内容、二进制及Reader不变。
- [x] 055不可变归档已完整上传既有服务器；服务端全量SHA、大小及manifest/receipt一致，054归档保留。
- [x] 外部Linux正常TLS HTTP/1.1一次完整GET，336038989字节、SHA精确匹配。原始stat→sha256sum→stat确认文件身份；同SHA正式归档以minisign0.2.5独立验签，Root/NEXT实际审原文后通过。Mac/H2 partial不计全量通过。
- [x] 同任务锁内复核旧054清单exact SHA、旧归档完整hash/原签名/manifest/receipt，history及临时文件fsync后CAS原子切换055。公开055/no-store/immutable/Range206、隐藏文件404、其他平台204、网站未变及054回滚保留均通过，Root发布锁已释放；非实现者另行复验公开接口通过。
- [ ] 实际日常客户端0.5.4→0.5.5安装/重启及数据保留。未取得fresh完整idle/generation准入和一致备份前，不安装或退出，不把服务器发布当成安装验收。

## 不可变产物

| 产物 | 字节 | SHA256 |
| --- | ---: | --- |
| own updater TAR | 336038989 | `31ee2b5eb9a4afb846dc3b4e211fb153290bc06cd700a69a914734d0a232f731` |
| ZIP | 344623193 | `b2bf83f464e7311869eb31a51db5427d67b7baf9099b6ab91de9672f53f8f4be` |
| 已staple DMG | 337463827 | `488bda7275b7194f2c0decf9615f55a2b0c40a4dfd24af4ab397f03756082de1` |
| App主程序 | — | `bc2cf463c5a00e007f2a434cce91c03bd0f94054c97e9fc570335caeec6b4840` |

既有更新入口：`https://140.143.183.232/updates/stable/darwin-aarch64.json`。055归档为同源`/updates/releases/0.5.5/<上述TAR SHA>-MoXBots.app.tar.gz`，不得同版本换包。DMG本地交付，不扩大现有updates公开路径。

本机交付目录：WPS项目指针 `MoxBot/output/updater-055-20261015/final-52bf6160/`。原始私有证据：`work/unified-055-20261015/release-055-52bf6160/`，不提交账号、密钥、用户数据或原生包。055构建使用生产profile，未携带Model QA HOME，也未作为QA/日常App启动。

## 验收边界及回滚

A7真实DSH/键盘草稿接纳与普通Session模型标题后端证据保留；A8空看板/导航、fresh PKCE和在线发现通过各自有限范围。中文可用性由人确认，精确组合态序列仍待验。真实Host完整路径、带数据/运行态看板、原生标题/方案审核等进入056，不能改记为055已全部通过。

旧054归档SHA `89572190e920b8c1dcb640ae294f2d4cba870128ad209c6848c11ec187a90d49` 保留；旧stable确切字节SHA `731d13a24c946510ad20ee44e001a77d2e66fc589c35f8a9ec5a37e26d578878`。服务端hidden history保留前后清单，必要时通过既有release.mjs rollback流程验证并原子恢复054清单；已更新客户端不会自动降级，修复需更高版本。不得删除旧产物或将QA包上线。

冻结后main已合入的字体缩放PR59及以后改动属于056，055不包含。接续见 `moxbots-0.5.6-handoff.md`。

## 发布实证与接续

公开stable exact SHA：`2cd4fcea767da9802ed531db996a66e73a1f0b5166c995e8cd353d53258fda66`，指向上述055不可变TAR及原最终签名。官方远端tag `v0.5.5` 解引用精确为52bf6160。此次发布不改Nginx，不新增端口，未改网站正文或覆盖旧归档。

Linux单GET时间15:44:28→16:31:32，2823.128501秒，平均119030B/s；正常CA验证、IP SAN匹配、HTTP1.1 200、无Range/重试/代理/redirect/证书绕过。真实完整文件stat前后device/inode/size/mtime不变，实际sha256sum stdout与URL/已独立验签字节一致。不能凭吞吐推定云购买带宽，也不宣称Mac/H2完整GET或真正客户端A→B安装通过。

发布前独立脚本审阅发现的“archive PASS未消费原证据”和“回滚完整hash晚于切换”已修复并复核：promote/final强制消费冻结原始证据及独立审阅；054完整性与签名可用性前置同锁CAS。完整证据、脚本快照与公开接口复验在指针私有`work/unified-055-20261015/release-055-52bf6160/`：`public-archive-gates.json`、`public-get-originals/`、`rollback054-crypto.json`、`server-promote.json`、`public-final-gates.json`、`server-finish.json`。本机交付目录有README、DELIVERY及SHA256SUMS。

16:26:56日常准确HRM owner仍running/isBusy=true，queue0、terminalnull、children/pending unknown；日常App仍054。不可据此推断未来idle，继续等fresh完整活动/generation准入、有效一致备份及用户确认重启。服务器发布已完成，客户端不被强制退出。

下载机的**网络测试服务**后检failed/MainPID0，16:22:02退出；只读journal显示ACCOUNT_SESSION_EXPIRED后exit1及systemd重试限制。Node测试服务仍active，无活动Session。原先“两个PID保持/ready”口头描述已按原JSON纠正，原因不能归给下载；未重启/续期/改该服务。此项明确留056业务验收，不污染归档下载结论。

官网手动ZIP由原官网owner按独立人类授权串行发布；Root仅发own updater TAR及源码tag，不创建Github Release/ZIP asset。本记录不替该官网owner宣称页面已更新。
