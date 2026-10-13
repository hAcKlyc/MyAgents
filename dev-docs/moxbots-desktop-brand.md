# MOXBOTS-DESKTOP-BRAND-001

2026-10-13，用户要求桌面端名称、Logo 与官网入口改为 MoXBots。执行与 UI 验收负责人：当前 Codex /root；本次范围小、改动耦合，单 Agent 串行完成，未调用外部模型。精确运行模型/推理、用量未知。

基线：fork main efb22f16；隔离工作树 /Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-desktop-brand，分支 feat/moxbots-desktop-brand。官网由其他线程更新，本任务不修改官网或 Host 功能。

- [x] 核对权威源码、并行任务、状态隔离和当前安装包位置。
- [x] MoX profile 名称 MoXBots；侧栏、启动页、关于页及默认品牌图标；官网入口 https://moxbot.mailxf.chatgpt.site。
- [x] 系统 bundle 名称、原生权限说明、托盘/通知名称和独立图标。
- [ ] 聚焦回归、typecheck、lint、构建。
- [ ] 实际桌面布局、官网入口点击和原生包验证。
- [ ] 提交、CI、合入 fork main、核实远端。

保持 com.moxbot.app、~/.moxbot、moxbot://、CLI 名称，避免更名改变用户状态与授权。原 MyAgents profile 保留。原项目版权/许可/社区和网络服务保留上游身份；新网址当前为私有预览，需站点所有者登录。未申请新域名、未修改官网受众、未接管其他线程发布。

图形来源：内置 image_gen，从用户确认 assets/brand/moxbot-logo-v1.png 去掉旧字标，导出透明图标；提示：仅移除 MoxBot 文字，保持蓝色圆角 M 机器人及双眼，居中透明正方形，约 15% 边距，不加文字或背景。源 PNG：src/renderer/assets/brand/moxbots-icon.png；各系统尺寸由 Tauri icon CLI 转换。

验收边界：实际 desktop UI 及系统打开网址需要原生运行验证；DOM fixture 只能证明对应渲染/动作，不能代替原生验收。内部 unsigned 试用包不等于签名公开发行。

不调用外部原因：明确采用 ai-yaoren-local 纯内置模式。
