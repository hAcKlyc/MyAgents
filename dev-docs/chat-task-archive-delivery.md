# MOXBOTS-CHAT-ARCHIVE-20261013

用户已明确当前Agent实现MoXBots左侧聊天任务归档、已归档列表与恢复，并授权协调另一个本机安装任务，由本任务完成安装验收。

## 用户路径与边界

聊天行的更多菜单选择“归档对话”。它从“全部会话”和“只看收藏”移除；工作区显示选项选择“已归档会话”可查看，再从聊天更多菜单“恢复对话”。归档不删除聊天/附件/文件，不停止执行，不改变最近活动时间、收藏或置顶。已归档工作区内的聊天也可访问和恢复；单条聊天恢复不隐式恢复工作区。

复用SessionStore、现有PATCH、Rust元数据投影和共享菜单，不新建业务存储。旧记录默认未归档；false移除标志；新分叉不继承归档。乱序响应被renderer权威更新拒绝时刷新最新状态，不报操作完成。

## 源码与验证

- PR #19源头59037d91cf130caf9a91fafb346e5b305d9b2883，六项CI全成功；main合并bd567cd666a97e6b09d7c2e81270378b6767b899，与源头Git tree完全一致，远端已核验。
- 156项相称回归通过：侧栏61/搜索16/偏好5/共享缓存34/客户端10/元数据策略2/存储5/V2并发与分叉23。TypeScript、完整lint、Web/server/bridge/CLI构建通过。安装基线b116404e上的112项核心回归与tsc也通过。
- 主审实际完整renderer+隔离SessionStore验收1280×720和900×800：归档、刷新保留、恢复、收藏置顶、归档工作区、Enter/Escape与焦点回到显示入口。夹具模型/执行接口禁用；隔离模式只确认Tab导航，不声称SDK内容恢复和正式身份验收。
- 非实现者源码审阅发现两个边界问题，经修复及复审关闭；其IAB环境不可用，不把源码审阅冒充独立实际UI验收。原生独立验收另见chat-task-archive-review.md。

## 本机安装

最初参考1c3449ab历史品牌包，实际核对发现另一个任务正在换包/回滚，停止旧基线安装。经用户授权发送协调消息，原owner确认接受的b116404e已在线且无待处理钥匙串授权，并暂缓本机安装/退出/重启。

本次实际构建源33992eb0aa6d269c2a25baf2127774cfc55ea16b（试用分支feat/moxbots-chat-archive-current-installed已推送），只在b116404e叠加归档源码与测试，不把Host或凭据改造合main。原生release构建4m32s；沿用已有本地试用证书/同一publisher，严格签名校验和ZIP CRC通过，尚未Apple公证。

本机/Applications/MoXBots.app已可逆替换；旧包独立保留，installed binary和server bundle与验收制品一致，实际进程路径已核对。用户数据、原MyAgents、账号和Host配置保留。独立原生归档/恢复、约950 CSS px rail/flyout及Escape/focus通过；主审正常退出、确认零进程后重启，已归档列表及同一聊天仍在，两段消息与附件引用仍可读取。恢复后默认列表可见、收藏及置顶时间不变；磁盘附件85字节，SHA-256 ef220a3fb398ba3c11538c553879b41a4b693799286c5536c98d4e74f5f5513e不变。附件卡片0 B是合成夹具未填大小字段，不代表文件丢失。没有调用模型、发送消息或测试正式业务账号。

可交付ZIP位于本任务moxbots-chat-archive-evidence/delivery/MoXBots-Chat-Archive-macos-arm64-33992eb0.zip，345940488 bytes，详细摘要和发布者/源码对应见同目录DELIVERY-VERIFICATION.json；安装回执INSTALLED-APP-UPDATE.json，备份及回滚在该证据目录rollback与/Applications隐藏归档回滚目录。没有提交包、签名材料、私密账户或凭据到Git。

## 尚未关闭的客户端回归

安装前接受的b116404e在只读AgentNet页面显示两设备在线。新版33992eb0显示“系统凭据需要一次授权。后台恢复已停止，不会反复请求密码。”归档功能局部原生验收通过，既有网络自动恢复回归未通过，不称整包已验收。没有点击授权、修改凭据或再次请求系统密码。

已按本任务授权向“评估 MyAgents 精简为 Linux Host”聊天发送协调消息；对方暂停本机替换/退出/重启，继续其凭据诊断。已向用户询问回退接受的旧包还是保留新版交该任务继续恢复，截至本记录等待用户选择。本机当前仍33992eb0；未自行回退或宣称用户接受网络回归。原包保留于`/Applications/.MoXBots.chat-archive-rollback-cd5e602fe41c.app`及本地证据rollback/cd5e602fe41c目录。下一步依据用户选择核验最终安装状态并释放安装所有权；后续凭据构建应同步origin/main保留PR #19。

打包时DELIVERY-VERIFICATION.json/ZIP内provenance记录未安装是当时快照；实际安装与分项验收以证据根目录最新INSTALLED-APP-UPDATE.json为准。归档与网络验收分别记录。

## 执行记录

主/root负责renderer、集成、主审、main交付、打包与安装；archive_persistence负责后端与并发/分叉回归；archive_review只做独立审阅与其报告。两个worker请求Luna/medium；运行时实际精确变体、费用和节省未知。未调用外部模型。

源码审阅修复一轮（两项问题）；新增恢复图标漏导入由类型/回归发现并纠正。首轮历史菜单旧断言加入新增归档项后通过。签名失败保留诊断：Documents下File Provider重新附加FinderInfo，改到private临时目录清理仅打包元数据后签名通过；不清用户数据或系统安全属性。后续桌面改动应先绑定实际已安装来源与当前安装owner，再开始打包，避免历史记录导致重复构建。
