<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-updater-20261014 -->
<!-- git-project-sync-task:base=0bb3f934368860f46c8e19981feb7ab10ddf1709 -->
<!-- git-project-sync-task:status=complete -->

# Task: MoxBots independent updater with task-safe confirmed restart and notarized release

## Objective

MOXBOTS-UPDATER-20261014：基于当前main0bb3f934接通独立MoxBots更新地址/签名，静默检查和下载，用户确认重启，运行任务/审批/活动未知时阻止安装并保留pending。服务部署既有官网140.143.183.232，保留官网/其他服务。完成真实签名原生A→B更新验收、正式Apple公证包、主干交付和接续。

## Acceptance criteria

- [x] 权威仓库、main、隔离分支、官网目标核实。
- [x] 自有更新签名、公钥与独立endpoint配置；不使用上游更新源。
- [x] 后台检查/下载与跨重启pending恢复的代码及确定性回归；实际 UI 与更新仍待验收。
- [x] 实际执行owner保护代码：busy/approval/unknown拒绝，防新任务竞态，不停止任务；运行实例验收待执行。
- [x] 聚焦确定性测试、类型/源码检查、独立UI验收。
- [x] 官网服务器更新路径、私有发布备份/回滚与实际HTTPS下载验证。
- [x] 原生签名A→B真实更新与重启/版本/数据保全验收（独立QA profile，非日常/paidProvider）。
- [x] 产品源码PR46主干/远端SHA、正式包签名/公证/票据/Gatekeeper/独立产物审计；本最终记录随文档PR收尾。

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

## Final native candidates and CI contract maintenance

正式和QA A2/B2 source pin = 3000f30fb28151ad74d393a7d99ac62dd463c404，三份assets/native成功；固定production reader复核通过。主干并发反馈PR44/d726在冻结后合入，不修改冻结包源码；最终主干同步和源码版本分别记录。Source freeze 3311 tracked-file hashes及生产key/pub配置一致性验证在project pointer work/updater-20261014/D-source-freeze-3000f30f.json。

CI3000五项通过；JS唯一失败是已有AppShellChrome.contract仍找旧无参重启调用（unit5621通过，1失败，5跳过）。仅调整此既有测试：Record/file保存位置非负且早于checkpoint.persist，checkpoint早于带lease的restart；相关78/78及最终contract16/16、lint/diff通过，独立16项复跑。runtime文件未改，因此包source3000保持，不用修改/伪造实际产物来源；追加测试/文档将重新跑CI。原生A2/B2准备签名，尚未执行安装；生产stable仍204。

## A3 source freeze and editor admission repairs

已正常整合 remote-main1c1f3ee2 的正式RemoteSession，不移除并发成果。新增 ThoughtCard/ThoughtInput/TaskCommentTimeline 更新准入：未提交文本、编辑/IME、录音启动、保存/发送/重试中的操作拒绝安装并保留当前内容；不自动发送或编造可恢复Session。RemoteSession tab 的安全更新证明尚未接入，begin/persist/final verify明确拒绝；remote prepare/receipt/detached job IO 复用既有process admission计数直到finish完成，冻结拒绝新metadata写入。

Root 9文件211项回归、composition139项、独立154项通过；full lint/typecheck/diff通过。真实独立Node QA路由1项通过：authenticated freeze拒绝prepare且sessions.json字节不变，release后恢复。不是正式Host联调。

原生A2手动合法204已通过；实际TaskCenter内联编辑未覆盖被发现后停止安装。普通tab导航会卸载未保存inline编辑，是独立导航缺陷，不能当作升级已保存。退场前独立操作员重新构造ownRecord marker并UI保存，磁盘SHA f89c44737adfe6049df86dfd38bc5ef7e0730c61964aa1ce540ea2a43919671f；Chat exact3行/尾空格仅AX证据，不冒称旧版durable保存。A2正常退出后两个exact QA orphan由Root验证argv/PPID并限定TERM，qa-A2-retirement.json；未操作日常App/data/Keychain。

D/3000f30f App虽然Apple Accepted且附票，因新发现编辑入口而superseded，未发布。本次重新冻结A3/B3/正式E同源，TaskCenter编辑保持mounted直接点顶栏更新验证拒绝，再执行真实signed A→B/草稿恢复/sidecar退出。最终DMG公证和HTTPS签名制品发布仍待完成；stable仍204。

## Unified 0.5.4 receiving handoff

已核实本次freeze e5a05f76974a4962beb0b7de259690daaef08fd5 包含PR44反馈 main d7264a43（candidate428e8a23）、PR42会话计时/原会话入口 main58b6720f/0c7b8e72、RemoteSession main1c1f3ee2，及本任务全部dirty/IO准入和durable草稿交接；Root与两份QA runtime文件哈希全量核对一致。证据指针WPS项目work/updater-20261014/unified-054-source-receipt.json、E-source-freeze-e5a05f76.json。没有因为新的统一接收消息重复废弃同源候选。

统一接收聊天MOXBOTS-UNIFIED-054-20261015（01a12b99-7b38-78b1-831f-9c60257d386a）提出由其接收/复核并串行发布IP下载页；Root继续唯一构建/签名/公证/原生QA更新与已有更新stable服务owner。本任务不修改官网页面；接收方领取前须最终候选与隔离门槛通过，避免静态锁/版本并发。未获得向接收方发新消息的直接人类授权，当前通过本记录提供状态。

原生队列核心之后补菜单/小助理/未登录/窄轨账户与铃铛、PR42ownQA原会话入口；无真实issuer/账户凭据/模型执行的QA边界明确记录，不把DOM或空态当真实登录/帮助URL/计时任务验收。


项目看板接收方01a13592-fe31-7aa2-a2a1-fe3b73865cb5已提交PR42组合证据：main0c7b8e72、merge58b6720f、CI38606936447六项通过、154unit/14组React合成UI；本次冻结已包含，并不重复构建。当前原生UI窗口状态为独占待A3/B3更新验收，不移交并发操作；最终候选/实际PID及QA正常退场后释放状态在本记录和WPS结果receipt更新。项目看板原生真实Provider计时样本尚无，本任务禁收费模型执行，空态/准确Session导航与真实计时任务区分；看板接收方可在释放后按其自身授权补验收。未向其发送新跨任务消息。

## Final source/native/package delivery and production cutover

2026-10-15：PR46 已合远端main0c85b57109335b97eb1d77fbc7024e6cb25fb831，source e5a05f76974a4962beb0b7de259690daaef08fd5。CI38623129708六项全部success；main3351个运行相关Gitblob哈希逐项等于freeze，没有以不同主干源码冒充本包。

独立QA A3→B3全部核心真实验收通过，详dev-docs/moxbots-updater-qa-isolation-review.md第十轮：后台签名下载不自动安装；cancel；mounted ThoughtCard/ThoughtInput未提交编辑拒绝且仍可编辑；真实PTY持续输出时拒绝安装；空闲signed安装→原生request_restart、cleanup_complete且old App25229/Global25347/Session31196全部退出；B34881实际0.5.4/binary664158a5823317740f244ba78393fa471eb5323c2ef9b7d0e2cd72b27675801d；恢复exact98Session/Tab及3行/@file/尾空格，没有send；Record SHA3129602b3e3bc54f6291c20946e2680b8d841fefabca33806ee6de73202b1d7a保全；handoff main/bak/tmp正常消费；B204最新反馈。Root随后通过Cua exactApp的AX/截图亲自复看草稿、About0.5.4、manual204正常，返回Chat仍完整。

最终production E App：/private/tmp/moxbots-updater-20261014/E-final-054-e5a05f76/MoXBots.app，binaryc16afdde9d0b0fb2fb52ad464de167c5870282e969dacdce358ef9e63dcef561，QJ5URBG9AP；Apple App6ca95f9a-a094-49cd-94e6-dd2844074776 Accepted/stapled/deepstrict/Gatekeeper全部PASS。固定Reader二进制284118e3与manifest逐字节等于immutablecache，Cuse原字节独立ZIP预审通过，无helper/App嵌套重签。

正式分发在WPS项目指针 output/updater-20261014/final-e5a05f76/：ZIP MoxBots-0.5.4-macOS-arm64.zip 351866393bytes/SHA9548da2b9e4d47a6fe30db15a244adc9822893a6eaf567aa8435d6e7a6ee1ff7；TAR MoXBots.app.tar.gz 343281849bytes/SHA89572190e920b8c1dcb640ae294f2d4cba870128ad209c6848c11ec187a90d49，自己的production minisign key；ZIP/TAR真实解包12508项字节/链接/执行位全等、App签名/票据/Gatekeeper全部通过。最终DMG MoxBots-0.5.4-macOS-arm64.dmg 344646848bytes/SHA97eba5703af4c257c30f7a31be5c2d5fd3156048e0327b7efeda558fc3ac7f30；DMGc4ed4dc5-1972-430c-8ffe-316f7c3753bb Accepted/stapled、DMG自身signature/Gatekeeper/integrity及最终readonly挂载全清单/zeroattrs/App全部门禁通过。中间formal-D pre-staple摘要不当最终摘要。

服务stable已原子发布0.5.4，无新端口/网站修改。https://140.143.183.232/updates/stable/darwin-aarch64.json；artifact /updates/releases/0.5.4/89572190e920b8c1dcb640ae294f2d4cba870128ad209c6848c11ec187a90d49-MoXBots.app.tar.gz。服务器upload SHA/343281849bytes通过，firststable事务/history存/srv/moxbots/updates/.history/MOXBOTS-UPDATER-20261014-first-stable.json，previous=null，回滚只退役此exactstable→204且保留不可变归档。普通TLS GET清单200/no-store与artifactHEAD size/immutable已通过；公网全量GET在当前链路约80–100KB/s，直连1MB实测约55KB/s没有改善；Nginx未配置limit_rate，具体出口套餐未知，不调整系统代理或付费带宽。全量HTTP hash/signature、range/unsupported/private404/websiteunchanged最终复验仍在进行，不能宣称该门槛已完成。

原生窗口Root和全部children已停止GUI操作：先明确释放QA给接收方，随后看板owner01a13592-fe31-7aa2-a2a1-fe3b73865cb5独占，统一接收方已承认其小助理弹窗可能留现场并永久退出GUI队列；不当产品故障。全局交接最新状态见WPS output/remote-session-20261015/OWNER-WINDOW-HANDOFF.json / work/updater-20261014/QA-WINDOW-RELEASED.json。日常安装/真实账号/远程会话由其各自明确授权owner，在看板释放后串行；本Root不操作日常App/data/Keychain账号。

边界：paidProvider运行中保护为owner回归，不冒称native paid任务不中断；实际Host/发行issuer登录退出/反馈cloud与真实SDK计时样本未验收。remote-session tab正式安全更新证明未就绪时明确阻断；中文IME/评论处理中为DOM覆盖。普通TaskCenter切tab会卸载未保存inline编辑是已有独立导航缺陷，本次只证明mounted编辑拒绝更新。更新dialog实际1200×800；900×700仅小助理/账户popup适配。

统一接收owner01a12b99-7b38-78b1-831f-9c60257d386a独占GitHub trial draft与IP手动下载页，本Root不重复发行或覆盖9ed设计/站点pointer。source、主干、native、正式包验收已有可领取证据；最终HTTP完成后更新结果receipt和本记录收尾。

## Final acceptance settlement

本轮实现/native/正式包/生产更新服务验收全部完成。具体字段与可复用命令见 dev-docs/moxbots-updater-054-delivery.md；最新接收记录WPS output/updater-20261014/final-e5a05f76/DELIVERY.json，最终main SHA在该receipt结算，package source始终e5a05f76974a4962beb0b7de259690daaef08fd5。产品源码PR46 main0c85b571；统一官网元数据PR47 main16ab3dbd及看板原生补验main80faaab7已正常整合，均无运行源码改动，不重建/重签已发布0.5.4。

Own更新URL保持官网IP：/updates/stable/darwin-aarch64.json；同一SHA归档通过官网exactimmutableURL302到自有Repo同一公开版本的独立SHA-named TAR asset。未新建tag/release、未覆盖原ZIP/校验文件/发行正文、未改变公钥或stable JSON，也保留服务器original。GitHub serverdigest/343281849bytes符合；真正从官网入口跟随两跳HTTPS完整下载，37.188525s、9230854bytes/s，SHA89572190...和ownminisign/trustedcomment全部PASS；HEAD/immutable、range206及1024精确bytes、unsupported204、私有history/receipt/manifest404、stable no-store通过。原慢速自身curl48969已核对PPID/argv后TERM并保留partial，没有停止任何客户进程。

CDN单exactpath prefix在五把既有maintenance flock下加到owned /etc/nginx/moxbots-updates.locations；base原文96b0...逐字节保留，nginx-t/仅gracefulreload、cloudPID1075503不变；backup/root/moxbots-updater-cdn-backup-20261015-e5a05f76。此前homepagebe516...到015b5a...变化为并发授权网站设计发布，已核对current /var/www/moxbots-website/releases/e7e283c096a1654bad1dddd7f1e9de874fcf1a21-download-054-ce86cc4f/index.html SHA015b5a...与真实HTTP逐字节一致，不把整体hash变化误当updater覆盖或假称旧页未变。Root未写任何网站文件，旧Nginx其它路由/源base未改变；GitHubZIP/IP下载页由统一owner独立通过完整下载和桌面/移动UI。

GUI Root及所有children停止查询/操作，ProjectBoard也明确释放；统一receiver永久退出GUI队列，下一队列仅RemoteSession owner01a134fe-e48b-7ed0-9bfe-37021d9d41f7，在其自己人类授权下负责日常安装/真实账号/Host。Root未安装/启动/退出日常App，不从其他会话的完成推导安装授权。旧0.5.3/5949需要首次手动修复基线；更新验收A3是修复后QA基线，不能声称旧5949自动升级已通过。

所有已明确边界保留：真实Provider/发行issuer登录退出/Host联调和真实running计时由其授权owner后续验收；不作为本次默认必做项或伪称已通过。普通TaskCenter切tab未保存编辑卸载缺陷仍独立未修，挂载状态更新已拒绝/保全；正式remote安全更新证明未就绪明确拒绝。0.5.4制品/签名/版本已公开冻结，后续代码修复或正式协议接入应使用新版本0.5.5及新完整制品，不复写本版。

执行记录：Root负责整合、源码/主干核实、生产发布和整体接受；Composer worker只编辑草稿准入文件，独立QA worker发现并复核实际route/内联编辑/恢复风险，DMG worker负责仅包装/镜像清单。均为既有本地协作，未调用外部模型服务或收费Provider；token/费用未统计，不虚报节省比例。实际本轮三份native release约10m30–33s并行，各自源码及目标隔离。所有临时/失败/淘汰候选和回滚证据保留，没有以Accepted替代native。
