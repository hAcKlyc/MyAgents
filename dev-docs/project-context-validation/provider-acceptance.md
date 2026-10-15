# PROJECT-CONTEXT-001 真实Provider验收 / 0.5.7

2026-10-16，用户指定将功能和联调结果交统一发布会话纳入 **0.5.7**。本轮不修改生产源码、版本元数据或日常客户端。已测产品源码为main `c225acd830513eb50736f75718f559a9ebda17bc`（PR #68）。

## 结果

真实Kimi Coding / k3，经实际 SessionEngine facade → builtin adapter → Claude Agent SDK 0.3.296 → SessionStore，4次上游消息请求全部HTTP 200、实际terminal `complete`，tools/MCP均为空。来源和目标是不同的真实持久化Session；数据全部为合成验收事实。

| 路径 | 实际请求背景 | 模型回答 | 结果 |
|---|---|---|---|
| 源A | 无其他背景；随机方案编号 | 自行生成新进展码 `C7A3F9E2`，自然语言记录尚未发布 | 通过 |
| 同项目新会话 | 自动带入源用户及助手两条摘录，source Session ID可追溯 | 准确恢复随机方案、助手独有进展码、尚未发布、0.5.7、统一发布职责 | 通过 |
| 另一项目新会话 | 无PROJECT_CONTEXT、方案编号或进展码 | 五字段均null，不猜测 | 通过 |
| A关闭后新会话 | 生产atomicModifyProjects保存false；独立新进程重读，实际请求无上述背景 | 五字段均null | 通过 |

目标提问完全相同，不包含源随机方案、进展码、版本或发布职责的答案；不是把答案放在目标提问里。核对实际Provider wire、typed desktopQuery持久化来源和真实模型回答；不单凭HTTP 200或idle判断成功。`provider-results.json`保留脱敏结果、实际响应、wire和私有证据SHA。独立审阅者project_context_review交叉核读receipt、4份result、4份cleanup和磁盘关闭配置，确认通过以上范围。

## 用量

按上游最后usage的 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，源/同项目/异项目/关闭分别为4675、5232、4591、4591总输入Token；最终输出分别540、198、315、284（含供应商报告的thinking部分）。同一提问在A开启与关闭样本差 **641输入Token**，约为关闭时的14.0%。仅为一个来源、一次Provider样本，不是固定开销或货币账单；缓存命中不同，不能直接按未缓存价计算所有输入。

最终通过套件4次真实请求；前置两个失败验收轮次各有1次真实源请求成功，本轮总计 **6次真实上游请求**，并非只花4次。第二次失败轮次的旧receipt曾把本地拒绝算入realUpstreamRequests=2；核查proxy gate在fetch前拒绝、status=null，实际仅源请求1次。已在脱敏报告明确纠正，不直接累加旧字段。

## 失败记录与修复

- 首次打包未包含vendored TS协议，进程启动失败，0真实请求；改验收bundle解析，未改产品。
- 本地预检曾错误要求认证失败后有完整持久化回合，并把SDK count_tokens可选请求当违规；改为如实本地404拒绝且不转发，实际消息/init仍严格要求空工具。无真凭据/上游调用。
- fOr9VJ：源真实请求成功，但验收脚本读回前误用drain撤销writer。改为flush后读回，finally才drain。产品源码未改，不将该失败记为功能失败或验收通过。
- hbop5H：模型把源JSON放围栏代码块，现有产品会省略代码块，故目标请求缺源助手进展码，被本地门禁拒绝且未转发。改为普通自然语言来源、保留严格随机标记验证；这是样本修正，不是产品修复。**代码块中的进展仍不在自动接续保证范围。**

## 隔离与复现

物理0700临时HOME、独立`.moxbot`、两个空测试项目、标准自定义Provider路由。实际真密钥只由父proxy从已授权0600配置读取到内存；SDK仅获随机本地token。子进程OS网络仅允许两指定loopback端口，禁止直连外网；同一Seatbelt helper已实测父/子对未准许loopback及外网均EPERM。四进程组结束后实际ps成员均为空；超时有SIGTERM→SIGKILL和清理后断言。原始wire/上游/SDK日志/临时配置不进Git。

手动入口（不得纳入自动CI或未经授权调用）：

```sh
node dev-docs/title-session-acceptance/sandbox.mjs --verify
node dev-docs/project-context-validation/provider-run.mjs --local-diagnostic
node dev-docs/project-context-validation/provider-run.mjs --approved-real-provider --credential-config /path/to/authorized-0600-config.json
```

Node≥24.14。参数配置只读取`providerApiKeys['moonshot-coding']`用于固定Kimi端点；无自动模型回退。local-diagnostic用无真密钥trap，不证明真实Provider。通过套件私有目录basename `moxbots-project-context-provider-Wp6pyu`，receipt及各清理文件SHA见provider-results.json，可在本机TMPDIR定位。此前失败目录保留，不做破坏性清理。

## 发布边界

本轮通过仅为builtin/Kimi后台facade和真实持久化/Provider接续；不是HTTP/原生Rust SDK circuit、原生UI点击、安装包或生产验收。其他Runtime仍只有此前adapter mock覆盖。关闭由产品原子配置writer保存并经新进程重读，原生设置点击和正式客户端重启路径仍待发布owner验收。原始进展为合成数据，助手自报不能证明真实项目完成。

唯一发布聊天 `01a12bc2-907a-7702-b6dd-788225c5dfe4`「MoxBots桌面端统一打包负责人」负责0.5.7。当前冻结056不加本功能；0.5.7版本元数据/固定候选/签名公证/安装和发布由它串行安排。此文与task record是发布输入，未宣称已发布。
