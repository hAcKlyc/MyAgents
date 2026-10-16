# MoXBots 0.5.7 正式发行记录

任务 `MOXBOTS-057-NETWORK-RELEASE-20261016`；唯一发布 owner 为聊天 `01a12bc2-907a-7702-b6dd-788225c5dfe4`。本轮仅现有 macOS arm64 own updater；本机打包、公证并直接上传 `140.143.183.232`，GitHub 仅保存源码、CI 和交付记录。

## 当前状态

**0.5.7 已直接发布到自有更新服务器，完整公网回下载/签名与公开接口复验通过。未安装、启用或重启客户端，未打断运行任务；真实入网和业务验收仍待原生门禁。**

| 层次 | 结果与证据 |
| --- | --- |
| 冻结源码 | `ee055458af8823a611503450424ecadd30be0f4e`，PR83 合入 main `40f7de8f11a7c848a5f0b98aff3e4969af3fd068`；二者 tree `a5c5889596636ce0103e681bf96fd143f8fb8218` 相同 |
| 源码验证 | 精确源码七项 CI 通过；原 JS job 的复制反馈瞬态断言失败原件保留，未改代码重跑该失败 job 一次后全链通过；根因未证实 |
| 实际组件 UI | 独立合成 fixture 九项通过、零页面错误，含 1280×720 与正式支持最小 660×400、长错误、内部滚动、取消和焦点返回；不是原生或真实账号验收 |
| 完整 native 构建 | 本机 353.51 秒，4391 项冻结输入未变；未使用 DOCS_RS/stub，不修改系统工具链 |
| 正式制品 | Developer ID `QJ5URBG9AP`、正式 Reader、自有 updater 公钥及地址连续，Apple Accepted、staple、Gatekeeper 和实际 TAR/ZIP 完整回解均通过 |
| 独立实际验包 | PASS；Root 重核 119 项原始证据摘要，自有 minisign 真实验签通过 |
| 服务器分发 | 既有 owned lock、同文件系统原子 stable CAS；正常 TLS 完整公网 GET、实际文件 stat/hash、自有签名、17 原件独审和 Root 复核通过；公开 stable 057/no-store、Range206/内容、隐藏404、Windows204及网站未变复验通过 |
| 客户端启用 | 待手动解锁、fresh 完整空闲准入和兼容配置/应用备份；未执行 |
| 真实入网/业务 | 未验；源码、签名和服务器分发均不替代这层验收 |

## 发布制品

- 源码：[PR83](https://github.com/heavenzhang/MoXBots/pull/83)。后来的 main 提交不自动进入本包；尤其 PR84 的 macOS 网络 CLI 不在冻结 0.5.7 中。
- TAR：`MoxBots-0.5.7-macOS-arm64.app.tar.gz`，336184128 bytes，SHA-256 `b48604872eb967e3419aef0a8da1a33101603fa5883b08c4aadb0a0fe21c6c82`。
- ZIP：`MoxBots-0.5.7-macOS-arm64.zip`，344783345 bytes，SHA-256 `379e99a99991665e2b5e0a32b8fabc8bda8bacf78276f279ad62a992b298be00`。ZIP 为本机正式制品，本次不替独立官网 lane 发布 manual ZIP。
- Apple submission：`ad08deeb-c589-4633-8910-a3a9d9ffea1f`，Accepted，无 issues。Apple 上传的 pre-staple ZIP 摘要 `dc6df803e5166799941b8f9bd1b8fe36d92f2776debefd47b09002cfb8977237`，与最终发行归档区别记录。
- 更新地址：<https://140.143.183.232/updates/stable/darwin-aarch64.json>。
- 不可变归档：<https://140.143.183.232/updates/releases/0.5.7/b48604872eb967e3419aef0a8da1a33101603fa5883b08c4aadb0a0fe21c6c82-MoXBots.app.tar.gz>。

## 本批次内容和修正

PR78/79/81：按 Owned 账号/网络隔离 device identity、按实际登录连接选中账号，显式第二轮同 principal 恢复旧登记设备；最终 registry 提交前临时登录不成为当前连接，取消和晚结果保留旧身份与可能已提交 token。

冻结主干还包含 Project Context 及隔离 Provider 记录（PR68/71）、Host 引导/兼容（PR69/72，仅随桌面源码，不部署 Host）、默认关闭的主备模型（PR73）、缩放输入框横滚修复（PR76）、结果/时间/质量参考（PR80）。各来源任务的真实验收边界保留。

首轮 aeaebda2 未公证候选被独立 UI 拦下：660×400 恢复身份弹窗顶部/取消按钮被裁且无可用滚动。PR83 仅为 JoinNetworkDialog 增加视口限高、内部滚动和边距，不改变账号/身份/取消协议；ee055458 全量重建。首轮原 PNG/JSON 曾被 reviewer 覆写，原报告读数保留，后来 exact git-show 复现明确标为重新复现；不将其冒充原始截图。当前 ee 的 UI 取证为真实当前组件合成数据。

发布脚本首审发现 pre-stage 内容与独立包证据未绑定（PUBSCRIPT-01），在服务器写入前修复。当前发布器在锁/SCP 前核对精确三文件、归档全量 SHA/大小、manifest/receipt/签名身份和 119 项独立证据；13 项私有 fixture 回归和独立复审通过。此修正限私有发布器，不改变冻结产品字节。

## 边界和回退

不强退、不停止任务、不安装/启动候选来绕过锁屏。客户端启用必须重新由完整活动 owner 确认当前 generation 空闲，手动解锁并做当前兼容配置与实际应用私有备份；旧 PID、端口和 Task 行不能替代准入。

真实新账号 session、独立 identity/登记、membership、relay ready、目录、既有 scope 可调用路径及同账号恢复/旧身份保留仍待原生验收。PB004 看板/历史/导航与其他真实 Provider/Runtime 等边界继续由来源任务追踪。不扩大云/Host/External Calls/模型权限，不部署其他服务或增加公网路径。

保留 0.5.5/0.5.6 不可变归档。已验签 0.5.6 TAR 为 336158365 bytes / `685134d0a5129cf7d150b20c86e73736db4142ae150376eb8edeea077a6c8549`，旧 stable 精确 SHA `af8b16c122bce9e470f5792345c6623ef97623a0ebaf17d65fa6131e0a83b504`。stable 回退仅停止新分发，不会自动降级已升级客户端。新 `sessionBound` 配置回退旧客户端需恢复启用前兼容配置并保留当前业务库、新旧身份和凭据槽，禁止恢复旧业务数据库。

## 证据和接续

项目指针 `Documents/WPS Cloud/【项目】目录/MoxBot/` 中：正式制品 `output/updater-057-20261016/final-ee055458/`（README、DELIVERY、SHA256SUMS）；当前原始验收 `work/release-057-20261016/owner/round2-ee055458/`，独立组件 UI `owner/independent-ui/round2-ee055458/`，接续 `owner/CONTINUE.md`。凭据只使用本机钥匙串的用途配置，密钥、运行数据、完整业务日志与原生包不入 Git。

下一步：保持冻结包及历史版本不可变；客户端启用继续等待手动解锁、fresh 完整空闲准入和兼容配置/应用备份，再逐项验收真实入网及业务路径。服务器分发完成不等于客户端已启用。

## 公网实测与下载速度

唯一完整公网 GET 由现有独立 Linux `101.42.11.29` 直接访问 `140.143.183.232`，2026-10-16 06:05:37–06:53:01 UTC，2843.672468 秒（47 分 23.67 秒），平均 118221 bytes/s。实际下载文件的 stat→sha256sum→stat 原始输出和 17 个取证文件全部保留；独立 reviewer 又只读 SSH 对同一文件重查 stat/hash，inode、mtime、完整大小和摘要一致。没有 Range、重试、重定向、TLS 绕过或 GitHub 包分发。自有 minisign 在与远端完整 SHA 完全相同的本机归档上真实验签。

云后台与下载源已在同一台 `140.143.183.232`，移动目录不会增加出口带宽。Nginx 未设置 rate 限制、机器负载低；当前连接观测到约 15 MB TCP 重传，本机并行 1 MiB 小样本也仅约 54 KB/s。源站公网出口整形/路径丢包是待确认原因，不能把约 1 Mbps 的观测当成已核实的购买套餐。未修改代理、服务器网络、Nginx或付费 CDN/带宽配置。小样本仅诊断，不能替代前述完整发行取证。

## 记录封存与补充路径检查

记录独审发现 RECORD-REF-01：Root在独立报告最终封存前读取了摘要，报告随后补充四个取证元数据字段。首轮审阅及原Root回执保留；当前报告封存，20项原始公开请求与5项辅助证据重新逐项核验，删除所述新增字段后的序列化摘要精确匹配此前观察摘要，证实元数据差异。Root回执与脱敏evidence引用已修正；包、服务器与原始GET字节未变，没有把重构数据冒充原件。

补查时本机直连stable出现两次TLS握手超时，失败原件保留；既有Linux正常TLS返回057，本机沿用既有Clash代理后约0.75秒正常TLS返回相同清单，未修改代理或服务器。小清单正常不能证明整包高速，也不代替原生客户端更新验收。脱敏摘要见 [moxbots-0.5.7-evidence.json](moxbots-0.5.7-evidence.json)。
