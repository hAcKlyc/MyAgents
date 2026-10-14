<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-updater-20261014 -->
<!-- git-project-sync-task:base=0bb3f934368860f46c8e19981feb7ab10ddf1709 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MoxBots independent updater with task-safe confirmed restart and notarized release

## Objective

MOXBOTS-UPDATER-20261014：基于当前main0bb3f934接通独立MoxBots更新地址/签名，静默检查和下载，用户确认重启，运行任务/审批/活动未知时阻止安装并保留pending。服务部署既有官网140.143.183.232，保留官网/其他服务。完成真实签名原生A→B更新验收、正式Apple公证包、主干交付和接续。

## Acceptance criteria

- [x] 权威仓库、main、隔离分支、官网目标核实。
- [x] 自有更新签名、公钥与独立endpoint配置；不使用上游更新源。
- [x] 后台检查/下载与跨重启pending恢复的代码及确定性回归；实际 UI 与更新仍待验收。
- [x] 实际执行owner保护代码：busy/approval/unknown拒绝，防新任务竞态，不停止任务；运行实例验收待执行。
- [ ] 聚焦确定性测试、类型/源码检查、独立UI验收。
- [ ] 官网服务器更新路径、私有发布备份/回滚与实际HTTPS下载验证。
- [ ] 原生签名A→B真实更新与重启/版本/数据保全验收。
- [ ] 主干/远端SHA、正式包签名/公证/票据/Gatekeeper/独立产物审计。

## Completed

base main0bb3f934368860f46c8e19981feb7ab10ddf1709；start/task-init通过。上一正式0.5.2包更新器被禁用，需先手动安装首个支持更新的版本。

## Verification

官网HTTPS curl普通信任验证200。现有update lifecycle仅保护进程创建，不保护已运行Sidecar的新turn；worker负责复用SessionEngine权威admission与Rust执行claim。

## Blockers and unknowns

- [x] 核心更新器主干交付：PR40 / main7ec5b6d4，六项CI通过。
- [x] 独立QA身份、数据/端口/凭据拒绝源码，Node164、typecheck与完整lint通过。
- [x] QA原生A0.5.3编译、deep strict签名、实际1200×800运行与独立bundle/数据/端口确认。
- [ ] QA原生终端环境Rust测试与真实busy/confirm/cancel/A→B数据保全。
- [ ] UI发现manual合法HTTP204误报修复已实施，等待实际B0.5.4复验；正式包升级0.5.4，冻结0.5.3不覆写。
- [ ] 官网更新服务部署204已通过；真实签名制品HTTPS GET与stable原子发布待完成。
- [ ] 0.5.4正式App/DMG公证、票据、Gatekeeper及资源完整性审计。
- [ ] QA修复跟进主干合并/远端SHA/CI。

日常0.5.3已由指定安装聊天安装，持续禁止测试其App、数据、钥匙串或窗口。实际模型运行中不中断仅确定性owner回归，本次native验证用真实隔离QA终端，不能扩写验收边界。Linux手动升级，不纳入macOSarm64原生包。

## Next step

冻结独立QA B0.5.4，修复204手动反馈并补全资源，执行独立UI/真实升级；发布包含修复的正式0.5.4并核实签名/HTTPS，保留日常保护。

## 进度与并行协调

最终聚焦 Node 136/136 独立复跑通过；Rust updater/活动owner9条、独立签名根2条、正常退出1条、lifecycle quiesce3条、exact-generation1条通过，完整原生test编译通过。独立审阅的准入竞态、download恢复与未落盘回答风险已修复复验，ready ref与DSH await后writer复读已确认。TypeScript、聚焦ESLint和产品assets构建通过。独立记录：dev-docs/moxbots-updater-independent-review.md。服务器/srv/moxbots/updates已部署静态路径，尚无stable版本；HTTPS204/no-store与官网200，原官网release a5cb41f0保持，备份/root/moxbots-updater-backup-20261014。初轮Nginx regex未引号导致校验拒绝已自动恢复，修正后nginx -t和reload成功。

用户已批准确认空闲/正常退出/应用数据备份后的真实更新窗口；随后迁移任务MOXBOTS-MIGRATE-001通知临时释放客户端，已停止一切主App启动/退出/UI/安装与~/.moxbot写入，只继续源码测试/构建/公证。迁移完成通知后恢复，必须保留迁移后的8项目/34会话，不用任何旧数据备份覆写。真实更新仍未完成。


## 2026-10-15 日常版本保护与隔离验收

用户通过安装聊天明确变更授权：/Applications/MoXBots.app 为日常使用版，测试不得启动、退出、替换、重签、操作其窗口/进程或借用 ~/.moxbot、真实会话、配置及钥匙串；此前允许用其升级验收的授权失效。安装聊天已按用户新选择安装 0.5.2/27d6ed8cb405f2ccdc905798611df218d18b4caf（Developer ID有效，未Apple公证），回执在项目指针 output/latest-install-20261015/installation-receipt.json。本任务不安装尚未验收的0.5.3到日常路径。

已暂停同com.moxbot.app候选启动。一次此前授权的A启动因品牌试用实例占用单实例而退出，不能算UI/真实更新通过；独立HOME不足以隔离硬编码 /tmp/com_moxbot_app_si.sock。先实现编译期QA身份 com.moxbot.updaterqa、独立数据/CLI/deep-link/sidecar与凭据边界，再运行实际A→B。不存在许可去终止当前未知试用实例。原私有备份留存，仅供取证，不恢复或覆盖新迁移数据。官网聊天已收到用户授权的窗口暂停协调；新的长期保护要求优先。

远端main878ef665已包含27d6 Host/账号成果，已正常合并到更新分支并保留两份共享计划。整合代码聚焦145条及typecheck通过；固定Developer ID reader由受信immutable cache读取并保留字节，不改变其source closure。整合正式B正在构建；旧独立A0.5.2与旧B0.5.3 App公证Accepted不代表最终整合制品。更新服务仍无stable，未公开正式更新版本。

下一步：完成QA隔离入口与门禁，整合源码/CI；隔离原生UI及真实A→B、正式包公证/归档/签名与HTTPS下载，再主干交付与正式更新发布。安装日常应用由用户指定安装聊天负责。


## 最新交付与授权（2026-10-15）

核心更新器PR40已正常合入远端main7ec5b6d47c968e7dbde71b8dbf1ad29b52b644c4，5949b7f1a47bbe285ed47edc632fab88aec95793为整合源码，六项CI全部通过。用户随后明确要求先使用，不等待完整原生UI/A→B：已交付 output/updater-20261014/preview-5949b7f1/MoxBots-0.5.3-macOS-arm64-trial.zip（344344572字节，SHA256 42d540fdc8436f74167c02032e216749a1a87c41976cd6fa953f42bc27b91d30），签名及CRC通过，未混入后续QA未提交修改。指定安装聊天已将0.5.3/5949作为当前日常版安装，二进制SHA256084c54fa8f182482cb0428deea50f26b3dd53d6d149f3a071794176fed8159ef，回执output/immediate-053-20261015/installation-receipt.json。本任务不重复安装、启动或测试此日常版。

Apple整合App公证49b80e6b-523a-424b-aed3-f441f8ed2a94现Accepted。另存副本 /private/tmp/moxbots-updater-20261014/B-integrated-main-notarized/MoXBots.app 已附票，stapler/codesign/Gatekeeper通过；已交付的原App与ZIP保持冻结，不能改写已交付摘要。原生UI/A→B仍未通过，不冒称完整正式验收。用户“不要备份旧包”由安装聊天处理；不要求改变更新发布内部不可变产物、原子稳定清单和回滚事务。

QA追加隔离正在工作树，暂未主干交付。独立审阅初轮终端ENV/PATH、辅助模型入口、builtin恢复三项已修并复验164条，typecheck/diff通过。自身QA config初始化读取不属于用户数据探测；对应测试禁止其他目录读取及Provider IO。新的QA workspace只在/private/tmp，独立key与仅loopback HTTP，不含用户数据，运行测试不获取生产OS凭据。模型与SDK执行关闭，因此实际busy验收用真实QA终端；模型owner状态通过确定性回归，真实Provider任务更新不中断仍不能凭此冒称已验收。首次QA Cargo发现registry的已裁剪promote_account调用，已加一致cfg并在独立snapshot重建。后续须QA native build/test、独立UI/A→B、DMG及HTTPS版本发布；生产stable仍204。

## Native acceptance repair 2026-10-15

独立真实QA已证明：篡改签名下载被拒绝且可重试；合法342389840字节包完成签名下载并ready；取消不安装，真实PTY循环时安装busy拒绝而循环继续。主动结束并关闭测试PTY后，空闲安装因update-quiesce接口未列入production role composition而实际404：Global33415与Session33416均复现，不能把unknown当idle。已只添加exact common路由，保留internal credential及exact generation认证；260项相关回归通过。待新的修复基线A2→B2实测，旧失败结果保留，不以关Session绕过。

旧QA正常退出工具后App PID退出，但两个可精确归属QA的sidecars残留；owner已移交root限定cleanup。未发送Chat草稿缺少durable checkpoint，退出前可见不等于已保存；独立实现者补主窗口composer交接，Root再做UI/重启复验。日常0.5.3/5949试用版包含旧route缺陷，需要首次手动安装修复正式包作为自动更新基线；本任务不操作日常App。私有0.5.4/17e0公证候选已标superseded，尚未任何stable发布；不能覆盖已交付0.5.3或把AppleAccepted当功能验收。

源码PR43已合入远端main37279ce45e737966312271c3c88b4d6c5d195c10，六CI通过；draft/route追加修复独立追踪。模型执行本轮仍禁用，native busy仅真实QA terminal，paidProvider运行中保护仍仅owner回归证据。

## Composer checkpoint source freeze 2026-10-15

确认更新前新增MoxBots composer持久交接：exact Tab/Session/workspace/context，durable tmp/fsync/rename及最后复读；图片、IME、发送或导入处理中、不能恢复的Launcher草稿拒绝安装，原内容保留。损坏/未消费handoff保留并阻断，默认MyAgents不读写。独立关键123条通过；Root新增owner变更后的解冻回归，最终unit19+DOM6共25条与typecheck通过。独立复核继续，待新A2→B2原生实际恢复，未宣称生产草稿验收。当前main0c7b8e72已正常整合，PR46补路由与composer后执行六CI。

## CI dependency repair 2026-10-15

CI c46 head发现composer runtime导入tabPersistence→builtin UI composition的四个循环；已将serializer/parser通过App既有owner注入，checkpoint仅保留type import，没有复制协议/serializer或放宽schema。Root与独立复核相关62/62通过；bundled Node24 fullLint通过（0依赖错误，16已有orphan警告）、typecheck/diff通过。c46三份尚在编译的候选以精确本任务PGID SIGINT停止，未发布；所有最终资源及native重建用追加修复source pin，保留失败证据。
