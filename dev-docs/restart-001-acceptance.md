# MOXBOTS-RESTART-001：手动重启行为修复

用户要求：无执行任务时不得被长期拦住；即使有任务，用户确认中断后也允许重启。代码进入056，不改已发布的055。日常客户端尚未安装本改动。

## 行为

- 两个更新入口共用确认框，明确任务/终端会停止、录音会停止并保存；Enter不自动确认，稍后不调用停止或安装。
- 确认才传interruptWork，验版本/签名成功后关闭资源准入；普通freeze保持不打断，检查/下载不自动安装。
- 精确generation的DispatchLease防Task-only进程早退；Node停止全Query/外部进程（包括idle后台）、等待既有IO、保存会话并flush writer。失效token后续回执不能覆盖新事务。
- 写盘证明后才释放Task后台。正在运行的持久Task走已有用户Stop转换，状态和审计为Stopped；未执行的定时任务保持调度。更新gate拒绝pending activation时临时等待，不把Task误记Blocked。
- 文档/语音更新专用停止验证精确进程树；失败保留句柄供重试。安装/准备失败释放Node冻结、恢复服务准入、再开放资源准入；不会重跑刚中断的turn。
- 代次、保存、进程收敛或签名失败仍拒绝安装，保留有效pending供重试。remote-session的独立草稿安全限制仍保留。

## 验证状态

- [x] Node24：selector/草稿/确认框/Hook 160项；另50项持久化/停止/真实loopback路由回归通过。
- [x] TypeScript、相关eslint、MoXBots web/server构建。
- [x] 实际浏览器：1280×720测试环境，确认框视觉、稍后取消、显式确认回调；独立真实组件DOM验证误按Enter/Escape。桌面任务不扩展移动设备认证。
- [x] 初版Rust release cargo check、生命周期3项、Task-only进程lease回归。
- [x] 最终Rust更新相关50项、Task scheduler39项和独立复审通过；扩大筛选另有CLIProxy旧签名fixture的provider_disabled失败，正在基线核对，不声称全量通过。
- [ ] CI与远端main：PR65执行中，以后续记录为准。
- [ ] 已签名056包：有活动任务/PTY、录音保存、失败恢复、草稿/会话恢复及真实更新全过程。没有把测试进程/HTTP/截图称原生发布验收。

原始证据位于本机MoxBot工作区 `work/restart-001-20261015/`；不入Git的截图、构建日志和合成UI fixture在该目录。未停止或替换日常应用，未发起真实供应商调用。

## 独立审查及执行记录

主Agent实现、主审、集成和UI验收；restart_safety_review只读检查跨进程停止/保存/失败恢复。审查明确发现并修复：旧token迟到复活、失败后服务拒绝新工作、worker停止失败被吞、未来调度失效。完成4轮修复复核，最终无剩余确定P1/P2，CI/原生门禁仍开放。选择依据是跨进程风险，审查请求模型gpt-6.1-sol/high；实际模型细分、token和费用未由工具确认。升级原因：无中途模型升级。不调用外部原因：明确采用ai-yaoren-local纯内置模式。

回顾：独立审查找到了单靠正常成功路径测试不会出现的超时与失败恢复问题；类似改动应先列取消、超时、写盘失败、安装失败四条路径，再实现正常重启。
