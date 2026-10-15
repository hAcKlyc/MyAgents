# MOXBOTS-NEXT-PROMPT-002

目标：Codex/system+managed、Claude Code、DSH灰字下一步建议，保留Enter草稿/Esc忽略。实现不执行工具、不改原对话/配置，不借用其它Runtime认证。当前base c7bab285，隔离task branch codex/next-prompt-runtimes-20261015。

## 已验证与门槛

- 已实现：SessionEngine可选runTextUtility把建议交给原Runtime owner；builtin原隔离SDK路径保留。
- CC真实合成调用成功8.2s，保原CLI已配置认证与模型默认。首次全禁settings导致原CLI认证env丢失，返回is_error=true已被拒；修复为精确auth/model env投影，仍禁tools/MCP/hooks/skills/persist。不得把auth status的oauth_token分类等同真实订阅模型身份，实际provider配置由原CLI拥有。
- DSH按正式0.5.4 validated release0.1.17 selection编译测试bundle后，真实Kimi Code/k3 utility/run成功6.9s；原生Session文件哈希未变、工作目录空、reverse仅credential/resolve。未触发root turn或真实App操作。
- Codex原native system-cli/gpt-6.1-sol使用生产提示词真实成功15.997s。独立网关保留原auth/endpoint，只允许空工具请求和完整纯文本成功响应；已修复undici major、builtin reserved provider覆盖、MCP literal override、native压缩/SSE误标兼容问题。失败null全部保留在私有诊断，不当成功。
- 当前81项聚焦unit/DOM、32项既有回归、scoped lint通过；dep-cruiser 0errors/16既有orphanwarnings。modelqa闭集route/page新增15unit+3DOM属于该81项；真实服务合成anchor与真实输入框使用同一owner路径，尚待统一入口和原生验收。
- 最终三runtime受控receipt/sourcehash见real-model-receipts.json，独立审阅见independent-review.md。阶段保存后merge统一profile af6c790依赖，不加临时stub。


## 实测限制

上述真实调用使用合成对话、临时运行目录和已授权既有配置，证明utility native/model路径；不等于新安装客户端输入框已验收。初次DSH source未prepared用旧lock，严格拒绝；对齐正式prepared选择后通过，未绕过身份检查。

## 统一交付

用户本聊天明确授权向“MyAgents 桌面端 Host 远程管理改造”协调；其主聊天又给总任务MOXBOTS-055-UNIFIED-ACCEPTANCE。该owner负责modelqa隔离profile、原生窗口队列、统一0.5.5 build/sign/notary/更新；本任务不改构建profile/身份/dataRoot/单实例，不并发操作日常App。TITLE external旧Agent loop在modelqa应failclosed，不能借本任务验收放行。

主/root负责CC/DSH、集成、最终验收和main；next_prompt_runtime_audit requested Sol medium，独占Codex两新文件，先发现零工具API缺口再实现网关；next_prompt_review requested Sol medium，非实现者审review并只写报告。精确token/费用未知；不调用外部原因：明确采用ai-yaoren-local纯内置模式。真实模型调用费用由既有账户计费，未获取精确账单，不估算金额。

DSH modelqa准备本身创建独立profile随机native session/attachment工件并保留取证，receipt明确标记；正式utility零工具/不改原native会话与整个准备流程零落盘是不同范围。0.5.5与main交付仍开放。

统一owner要求的隔离CLI路径增量：只在compile-time modelqa且system-cli utility读取两条受控完整executable env；要求absolute/canonical/regular/X_OK，launcher另校验SHA。普通prod/updaterqa/managed不读取override，模型/auth/home不变。新增8项独立测试及39项聚焦回归、tsc/scopedlint通过；此增量不重复计作真实模型调用。首轮PR53 JS CI被af6 profile的Mac-only /private/tmp测试在Linux拒绝，准备同步owner ab935修复后精确HEAD重跑。

已同步ab935 profile跨平台修复；route unit因mock编译开关与真实profile宏不匹配触发guard，已只在unit固定同一隔离profile常量，未改production一致性检查。最终9文件89项组合测试通过，4项modelqa构建脚本测试通过；native helper未因测试修订变化。

A4原生非实现者验收：Codex15.039s、Claude Code4.725s真实灰字与草稿通过；DSH10ms空值失败不计通过。已只读核对PNG，未操作窗口。确定接线错误：QA handler传入CLI plan权限名，但actual DSH compileConfiguration仅接受本Runtime权限；旧值在credential resolution之前拒绝，早期unit mock未验证该跨Runtime契约。最小产品变化只把QA准备权限改为approval-required，仍无initialTurn/扩展，utility tools[]/无普通任务约束不变。回归先红（真实公开权限契约拒plan），后99项组合通过；新增actual compileConfiguration仅synthetic mocks验证旧plan拒绝/新Kimi k3审批模式接受，不读真实配置或发请求。tsc/lint通过，独立增量review3项通过。等待Root新候选仅补DSH原生真实生成验收；不重复付费helper，不把源码修复算成native通过。
