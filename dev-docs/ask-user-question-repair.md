# MOXBOTS-ASK-QUESTION-FIX-20261013

用户明确由当前Agent修复提问加载与回传问题、补回归、合main并更新当前客户端，之后又明确授权与现有Host/钥匙串安装任务跨聊天协调、统一包。源码范围为既有问答链路；不修改Rust、Host配置、凭据或账号。

## 修复行为

- 共享 `normalizeAskUserQuestionInput` 对Builtin、external和UI replay使用同一字段校验；缺少multiSelect补false。逐个option检查label/description/preview，畸形内容返回可修正的输入错误，拒绝重复答案键/选项标签。
- Builtin不再把输入错误返回为“用户取消”；external不会把无法收集答案的提问降级成普通权限卡。正常答案仍经原owner回传，保留index/native id并补Builtin/CC的问题文本键。
- Tab按requestId去重、FIFO展示。成功/expired只删除对应项，失败保留表单与答案，随后显示下一个；会话边界清空队列，具体session身份拒绝旧事件。

## 相称验证

shared/DOM/交互134项、Builtin与external大文件283项、Codex协议5项，共422个独立测试用例。新增取消/AbortSignal、实际表单选项和自定义文字提交、Session切换及过期回执在最终focused检查再次覆盖。新增集成使用真实产品facade、SDK canUseTool callback与Runtime response入口，但SDK/Runtime传输由夹具控制；不称真实模型或原生客户端验收。

TS、完整ESLint、Web/server构建、主题8项、文档链接/路由检查通过。依赖边界检查0 errors/15既有warnings；未压制或修改这些警告。初次测试的HTTP Response对象复用导致已消费body，已修正夹具；SDK callback新类型要求requestId已补。shell默认npm不满足项目版本，后续使用现有App内置Node24/npm11.19，无安装依赖或修改版本限制。

独立reviewer请求gpt-6-luna/medium，负责源码与测试审阅，主代理负责实现/整体验证/main/真实路径。实际运行变体、token、成本及节省未知；无外部模型。审阅建议的Session与cancel/abort缺口已补，原生证据待统一包提供。

## 交付与客户端门槛

PR/main当前头CI与远端包含性待完成，完成后追加不可变锚点。当前MoXBots安装由现有Host/钥匙串任务独占；本任务不并发退出/重启或换包。统一包需叠加本次main源码，保留已安装Host试用能力、归档交付和原owner凭据修复；以实际冻结源及包摘要证明包含关系。

- [x] 实现3项修复、模拟caller回传与相称回归。
- [x] 独立源码/测试审阅、主审、类型/lint/build。
- [ ] PR当前头CI及最新远端main包含修复。
- [ ] 统一客户端包、备份与可逆安装、运行制品对应源码。
- [ ] 原生客户端实际显示提问，提交后真实调用者收到选项/自定义文字；网络/凭据原有状态必要回归。

工作树外日志、审阅与后续原生证据在本机同级 `moxbots-ask-question-fix-evidence/`；不将凭据、用户业务内容、安装包或机器日志提交Git。
