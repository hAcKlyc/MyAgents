# MOXBOTS-BRAND-COMMUNITY-001 交付与接续

2026-10-15。功能已合入远端main并发布云端；桌面改动已纳入用户明确授权的统一0.5.5流程，原生验收、正式包和安装仍由统一负责人完成，不宣称已安装。

## 源码与运行版本

- PR50已合并，功能main锚点`b5b9c9c49da3a6a846f35196660abf6fb37557eb`包含冻结head`11894a8daffc8e976cb6485c2f82333ef36c3372`，已fetch和ancestor核实。
- 七项CI全成功：Test38655694769、Owned38655694817。
- Linux制品source`ace5141860ae2a3da748ce226a9bcb9027175119`与功能main完整tree一致；运行binary SHA256为`dd4f8c31336d5c4fe94a15e0b9e52bc6d6149aca556dee61c09e48871e1861e8`。
- 线上入口：`https://140.143.183.232/community`；管理员复用`https://140.143.183.232/admin`内协作社区。

## 已交付行为

MoXBots版本使用独立介绍、关于页、主题名、导出署名、源码和联系入口、小助理资源文案。原作者和第三方许可/版权及内部兼容identity保留。社区从配置的owned issuer打开；旧Space首页转社区，旧资源深链提示不兼容，旧市集不再宣传或误跳讨论区。

社区话题/回复/分类/搜索与后台置顶/锁定/隐藏使用现有AuthStore/OIDC及管理员授权。上游Space数据不迁移；私有反馈不公开。列表最多100话题，详情最新200回复；永久幂等回执及容量限制见服务COMMUNITY.md。

## 验证边界

- TypeScript、完整lint（含依赖边界与文档检查）、许可、品牌/导航/i18n18项、资源投影6项、主题8项、相邻97项DOM/单元回归、同步main后的20项回归通过；追加旧市集双profile DOM2项通过。
- 最终owned Web build通过，使用独立临时输出目录，工作树旧dist曾ENOTEMPTY且不作为安装制品。
- 云服务全库151 passed / 0 failed / 5 ignored；社区focused7、反馈9和clippy通过。
- 独立UI39项和后续旧入口profile复核通过，详见brand-community-review.md。真实本地HTTP/数据库使用合成OIDC，覆盖发帖回复、跨主体、管理、未知结果/401/原mutation恢复。About使用原样JSX抽取，不冒充完整Settings或原生验收。
- 生产复验7项：6assets逐字节对source；现有获授权QA身份真实OIDC/PKCE与/community回跳；用户社区列表；管理员社区列表；既有admin bootstrap/模型目录；私有反馈读取；退出后同token401。主Agent还在内置浏览器检查线上登录界面。此HTTP验收不声称完整生产已登录浏览器交互。
- 生产没有测试发帖、回复、模型调用或Host配置修改。9个SQLite完整性通过；新社区仍0话题/0回复，2条设备连接已恢复。生产普通成员身份未新增，多主体权限由本地真实服务验证。

## 发布与回滚

统一负责人先hold远程/Host新调用。主Agent持两个既有维护锁，核实单principal、2设备、空Agent目录、业务0与空TCP队列；关闭新准入并持两个业务库writer锁后，仅发送SIGINT并确认success/exit0，再做一致备份、切换和恢复入口。没有SIGTERM、强杀或重启日常客户端。现有服务/Dex配置摘要未变。已向统一负责人发出恢复回执并释放hold。

备份和机器证据在原私有运维目录；本机`/Users/zhangshaohua/Documents/Codex/2026-10-15/moxbots-brand-community-private/`包含release pin、deployment receipt、production-readonly-results、production-state和经过分支故障测试的维护脚本。凭据与实际身份不进入本文件。回滚恢复备份的unit/nginx并保留live数据库，不把认证或业务库覆回旧快照。

## 原生接续

统一负责人聊天已接受本任务纳入MOXBOTS-055-UNIFIED-ACCEPTANCE，并在独立集成工作树合入11894a8d；主聊天已获用户明确授权协调。检查关于页介绍/链接/主题名、更多→所属云社区、无旧QR/邮箱，以及旧资源链接不兼容提示；无需生产发帖。0.5.5最终build/sign/notary/安装及相应真实原生回执由其继续维护；本任务不并行换包。

## 执行记录

主Agent负责桌面、接口、集成、主干、发布和最终校验；community_backend负责Rust服务，community_web负责用户页/后台，community_review独立审阅。worker请求模型为gpt-6.1-sol（实现high、审阅medium）；运行变体、token及费用未暴露，未调用外部AIRouter。两项状态缺陷和一项窄宽问题经独立复验关闭，主Agent补修相邻旧市集导航；没有把worker自报作为验收结论。

复盘：真实提交后丢响应再401的恢复旅程发现了幂等缺陷；发布脚本的停前竞态经只读审阅和隔离分支测试修正。下一轮应在首次CI前一次性补齐冻结代码、必要记录标题及相邻入口审查，减少文档/合并导致的重复CI；本轮未测算成本节省。
