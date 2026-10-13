<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/host-config-20261013 -->
<!-- git-project-sync-task:base=2a2415916959957f4bf2614f66fee75989b875a1 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-HOST-CONFIG-20261013

## Objective

当前Agent实现Host远程管理复用设置模型界面、一键应用当前MoXBots客户端主Agent配置、读取远程目录并选择工作区。用户已明确执行主体、主Agent来源及跨聊天协调/统一更新授权。权威源码为MoXBots；本任务不改固定credential reader或账号/登录方案。

## Acceptance criteria

- [ ] 设置和Host使用共享模型配置UI，支持选择已配置Provider/模型，实际支持由Host能力裁决。
- [ ] 一键应用客户端主Agent来源配置，展示来源与目标；本机路径在Host范围内解析/选择，凭据只走既有安全写入，不记录明文。
- [ ] Host允许根目录内真实目录浏览/选择，加载/空/错误/取消/身份变化可用，禁止跳出允许根及符号链接绕过；不新增公网或任意文件读取。
- [ ] 复用现有管理owner、revision、mutation receipt和加密通道；兼容已安装旧Host，不覆盖运行Session出生配置。
- [ ] 类型、相称DOM/Node/Rust回归、lint/build及非实现者UI与主审关键路径验收。
- [ ] 完整源码合远端main，源头/CI/远端祖先核验；基础Host分支交付依赖单独跟踪。
- [ ] 统一候选客户端/Linux Host联调和原生安装验收，由原凭据任务统一安装并协调本任务验收，不并发换包。

## Completed

- 已核对main 2a241591与Host试用远端9149753c，原owner工作树干净；本工作树start/task-init通过。
- 用户允许跨聊天协调；已通知“评估 MyAgents 精简为 Linux Host”模块范围、统一安装顺序及基础分支依赖，不改其未提交/后续工作。

## Verification

已实现封闭扩展方法、Provider 元数据回显、不可变版本配置、按 Provider 绑定的既有加密凭据 owner、受限目录浏览/选择与注册。共享 Settings 连接字段和模型组件已接线，独立源码审查发现的七项 UI 问题正在修复，尚未冻结。

主Agent本轮核验：来源/registry/shared unit 16项通过；Node六文件42项通过、13项Linux目录测试因macOS跳过；协议19项和Headless125项通过；后端与来源文件lint通过。实际 bundled supervisor IPC、真实SessionStore birth/resume与未授权执行拒绝属于隔离联调，未调用模型。完整native构建此前被本机Swift PackageDescription缺符号阻断；本轮协议format check另发现依赖原有codec.rs导入排序，不将其报为通过。

隔离 UI harness 在 ignored playground/host-config-qa，仅127.0.0.1:5187，真实组件与样式、合成transport/source；主AgentIAB可用，独立reviewer环境仅有未授权真实浏览器，无法做独立IAB视觉验收。实际 UI 验收待修复冻结后执行，报告 dev-docs/host-config-independent-review.md。

## Blockers and unknowns

截至远端main e9767263仍无OwnedHostManagement/Host管理IPC。本地merge 5a9dd9b0引入冻结9149753c仅为开发依赖，不能独自把未验收凭据方案发布。原owner正在拆分Host基础与修复新凭据迁移Linux CI；最终Git集成与统一客户端依赖其验证后交付。当前安装原在线b116404e，本任务不并发换包或重启。

## Next step

完成七项UI修复与独立源码复验，主Agent实际IAB检查交互/响应式；保存阶段提交并推送工作分支，Linux CI补齐跳过用例。等待原owner已验证基础锚点后集成最新main，统一安装与真实Host/旧Host兼容及模型执行另行按门槛验收。
