# BOTS-MODEL-CENTER-001 生产管理路径验收

2026-10-14，用户要求 builtin/API 模型中心、Bot 分配、调用监控统一在既有管理控制台，配置交互参考设置。用户最终选择后续自行配置供应商，因此本次复用功能，不导入私人配置、不执行供应商推理。

## 主干与制品

- PR38：https://github.com/heavenzhang/MoXBots/pull/38 。已审源码 `7352bb631833c3a3b2829dd381a196d2cf04a90b`，发布主干锚点 `0bb3f934368860f46c8e19981feb7ab10ddf1709`。
- 源码 Test run38572569419、Owned run38572569281，主干 Test38574626611、Owned38574626613，源码及主干各七项检查成功。
- 发布 artifact11899146209 来自成功的 Owned run38572569281；synthetic merge `9e38917efaa8bff6752ae306f4fc86b036c0ecb4`、已审源码和主干完整 tree 均为 `87458eefb3505b6d9f9f21f3afe4565ea2396e19`。
- archive SHA256 `8d7c7037b3bbad923bdbd70ba7326d5148076c8feb2f367282b539009c08e1d6`；运行 binary SHA256 `a871bdfc86f585b58c1fa574a366a009ca0fd04038e38be82ee954d9461550c9`。实际 `/proc/PID/exe` 与目标路径/hash 一致，不仅检查磁盘候选。
- HTTPS `/admin` 及静态资源与已审源码一致：app.js `90925ad993ac2027c63cfb67ba902cdac24126ea93100bf3300124c4dc30421a`，styles.css `e31a21044b2ada865ec5364ec16cd45997ff3e892a78faf217c9deca24b3b997`，index.html `4e7d2db26246d9f327b2fa8901752977dc6babdc6bc80f4d04498817f08fe99c`。没有忽略 TLS 错误。

## 发布与恢复

目标为既有 `https://140.143.183.232/admin`，仅升级网络服务、同源管理页面和既有 HTTPS 路由；没有新增监听器、账号或 Dex 权限。原 owner 明确释放140维护窗口，101 Host/本机更新仍由原 owner独占。发布锁、无悬挂 execution receipt、无活跃模型请求、停止网络后的再检查通过；数据库在唯一写入服务停止后备份并检查 integrity。

备份 `/root/moxbots-model-center-backup-20261014T220907` 私有0700，保存 network.service、service.json、nginx.conf、agentnet-state。发布仅添加 model_center.enabled/concurrency_limit2，保留其余配置；密钥/SQLite/lock 为服务身份0600。Dex配置/hash与认证服务不变。

回滚：在相同维护锁和静默条件下停止网络，恢复备份的unit/config/nginx，daemon-reload、nginx -t，重启网络并reload nginx；保留当前业务数据库，不直接覆盖为旧快照。重启后核对原binary、认证与管理员路径。源服务路径 `/opt/moxbots-model-center-0bb3f9343688/myagents-agentnet-service`。持久化验收再重启仅耗时0.287秒，PID1021039→1021478，二进制/hash和Dex/config/nginx均不变。

## 真实管理员路径

主Agent使用独立 Playwright Chromium 和既有获授权测试管理员，通过实际中文同标签页 OIDC 登录，固定返回 `/admin`。没有使用用户 Chrome、导出 cookie、保存 bearer 或读取私人供应商 key。

- 创建虚拟供应商，地址 `https://model-center-validation.invalid/v1`，随机合成 key；真实后台写入后 `has_key=true`，API与编辑器均不会回显 key。
- 创建 OpenAI Chat 模型并设置输入1.25/输出4.5 USD/百万 tokens；真实API回读为1,250,000/4,500,000 microUSD。
- 新建仅云登记的受控 builtin Bot，绑定已授权 owner/Host，通过“分配模型”保存；API回读 model_ref相同，UI保留 Host有效模型未知，没有创建/执行 Host Session。
- 发布后受控重启，重新读取模型/key存在状态、价格与Bot分配全部保留。对上述无效域名进行一次仅GET目录探测，被安全上游检查拒绝；此路径读取/解密保存的key，但没有供应商推理。
- 调用监控实际API返回0条，测试期间不增加记录。390/768/1440 document宽度分别等于视口，无页面级溢出；截图主审通过，无pageerror。非空计量/历史版本/未知费用展示已在真实Rust store loopback独立审查覆盖，不能说成生产供应商返回。
- 测试模型/供应商停用、测试Bot软删除，真实回读已确认；保留停用记录及审计。原Host、Bot委派、模型调用权限及数据未改。
- 退出网络响应204后，旧bearer访问模型中心为401。首轮脚本在页面清除登录UI后立即检查，先于远端撤销完成而断言失败；改为等待实际退出响应后，仅重验登录/退出通过，没有重复创建数据。一次独立脚本进程137退出原因未知，未据此归因产品缺陷。

私有机器可读证据与截图位于 `/Users/zhangshaohua/Documents/Codex/2026-10-14/moxbots-model-center-private`：`release-receipt.json`、`restart-receipt.json`、`production-assets.json`、`production-ui-acceptance.json`、`production-assignment.png`、`production-model-center.png`、`production-monitor-{390,768,1440}.png`。文件不含供应商真key或bearer，私有目录0700，不提交二进制、数据库或凭据。

## 验收边界与接续

管理功能代码/主干/发布/真实管理员配置路径已通过。Host消费代码已通过实际SDK隔离验证，但101 Host仍由另一个交付owner联合升级；本次没有安装该Host代码、开启cloud_models或实测付费供应商。因此“已保存期望模型”不等于真实Bot已使用平台模型。用户下一步在模型中心填供应商和模型，实际使用前需Host owner的有限Bot/model白名单、额度、到期及本地opt-in；另测一个指定Bot的真实返回及计量。

模型停用收尾回归135 Rust passed/3手动ignored、clippy/fmt及Node/SDK验证通过。通用超过8个旧失效actor的队列公平性基线缺口保持后续 BOTS-EXEC-QUEUE-FAIRNESS-002，本次不宣称全量清理。跨用户共享、其他runtime和平台Bot工具执行不在第一版。

## 内置协作执行记录

本任务按 ai-yaoren-local 内置模式。主Agent负责整体验收、主干及发布；早期实现拆分由互斥模块与独立审查收益决定，后期依赖/生产操作串行，无外部模型调用。

| 实际参与者 | 工作包及验收 | 请求模型/effort | 运行确认 |
| --- | --- | --- | --- |
| /root | owner整合、权限/队列集成、CI/main、云发布与真实管理员UI | 当前primary精确型号/effort未暴露 | 未确认 |
| model_center_backend | core、存储、三协议与队列回归；135 Rust通过 | gpt-6.1-sol/high | 未确认 |
| model_center_host | 有限Host、实际SDK、凭据/工具隔离；5 SDK cases通过 | gpt-6.1-sol/high | 未确认 |
| model_center_ui | 设置式UI、HTTP接线与UI修复 | gpt-6-luna/medium | 未确认 |
| cloud_backend_impl | 非实现者真实fixture UI/回放/响应式审查 | 既有worker请求记录不完整 | 未确认 |
| cloud_execution_contract | 非实现者发布脚本及最终队列独立核验 | 既有worker请求记录不完整 | 未确认 |

总repair轮数、token、成本和节省时间未暴露，未知，不以检查次数估算。可追踪修复包括assignment回放P1、监控空态异常/移动溢出、真实SDK未知调用/计量处理以及停用收尾队列；最终均由主Agent或非实现者复验。最终生产验收仅主Agent执行。

复盘：真实SDK与真实store浏览器审查发现了单元测试之外的实际问题；晚期队列修复导致重复CI成本。下一轮先固定原receipt重放、模型停用→收尾、历史模型名以及空/移动布局关键验收集，再冻结发布源码，减少重复整轮CI。供应商由用户后续配置，无本轮真实模型费用。
