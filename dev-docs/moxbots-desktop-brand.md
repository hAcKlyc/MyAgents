# MOXBOTS-DESKTOP-BRAND-001

2026-10-13，用户要求桌面端名称、Logo 与官网入口改为 MoXBots。执行与 UI 验收负责人：当前 Codex /root；本次范围小、改动耦合，单 Agent 串行完成，未调用外部模型。精确运行模型/推理、用量未知。

基线：fork main efb22f16；隔离工作树 /Users/zhangshaohua/Documents/Codex/2026-10-13/moxbots-desktop-brand，分支 feat/moxbots-desktop-brand。官网由其他线程更新，本任务不修改官网或 Host 功能。

- [x] 核对权威源码、并行任务、状态隔离和当前安装包位置。
- [x] MoX profile 名称 MoXBots；侧栏、启动页、关于页及默认品牌图标；官网入口 https://moxbot.mailxf.chatgpt.site。
- [x] 系统 bundle 名称、原生权限说明、托盘/通知名称和独立图标。
- [x] 64 项聚焦品牌/i18n/侧栏测试、typecheck 与改动文件 lint 通过；Web/server/bridge/CLI 与 8 项 theme 测试通过。macOS arm64 原生 release 打包通过，未签名，内部试用。
- [x] 实际原生窗口、菜单、侧栏、启动页、关于页显示 MoXBots 与新图形；展开/折叠和恢复可用。侧栏品牌按钮与关于页网址已实际点击；关于页 AX href 为新站。bundle 名称/ID/图标摘要核验通过。
- [ ] 提交、CI、合入 fork main、核实远端。

保持 com.moxbot.app、~/.moxbot、moxbot://、CLI 名称，避免更名改变用户状态与授权。原 MyAgents profile 保留。原项目版权/许可/社区和网络服务保留上游身份；新网址当前为私有预览，需站点所有者登录。未申请新域名、未修改官网受众、未接管其他线程发布。

图形来源：内置 image_gen，从用户确认 assets/brand/moxbot-logo-v1.png 去掉旧字标，导出透明图标；提示：仅移除 MoxBot 文字，保持蓝色圆角 M 机器人及双眼，居中透明正方形，约 15% 边距，不加文字或背景。源 PNG：src/renderer/assets/brand/moxbots-icon.png；各系统尺寸由 Tauri icon CLI 转换。

验收边界：实际 desktop UI 及系统打开网址需要原生运行验证；DOM fixture 只能证明对应渲染/动作，不能代替原生验收。内部 unsigned 试用包不等于签名公开发行。

不调用外部原因：明确采用 ai-yaoren-local 纯内置模式。

工作分支功能提交：6bf2c23b612bedd4a515a9bc12ba0ecfde4c00af；PR https://github.com/heavenzhang/MyAgents/pull/16。CI 与原生验收待完成。回归首次误用了不存在的社区文案 key，修正为实际 Space 登录 key 后通过；产品无对应缺陷。

## 原生验收证据

构建命令：MYAGENTS_BUILD_PROFILE=moxbot npm run tauri:build:moxbot -- --no-sign --bundles app，exit 0。原生 release 编译 5m08s；这是编译器报告，不是总执行耗时或 Agent 用量。

包：src-tauri/target/release/bundle/macos/MoXBots.app；CFBundleDisplayName=MoXBots，CFBundleIdentifier=com.moxbot.app。应用图标 icns SHA-256 与源码相同：a4aa33d9d73bf433f22d693f24edcb6598aaaf1b8fce03860f2b02947eb0c339。包内 moxbots-build.json 记录实际功能源码提交 6bf2c23b。

当前机器正常退出旧试用包，再用完整路径启动新包，窗口/系统菜单与 UI 正确，原有 Mino 工作区仍可见；没有发送任务或调用模型。当前机器截图位于 MoxBot 工作区 docs/evidence/desktop-brand/{home.png,rail.png,about-website.png}，实际视口约 1200×800（2x PNG 2400×1600）。原始默认 MyAgents 应用未退出或替换。

视觉、品牌控件交互与侧栏适配由主负责人实测通过。未新增布局/页面，因此不创建验收子 Agent。系统默认浏览器页面未接管或自动复验；新站仍是需登录的私有预览，官网页面改版与公网域名是其他任务。应用包为未签名内部版本，没有发布自动更新。

复盘：沿用既有构建 profile，集中产品身份和图标选择，避免跨源码或状态目录更名。初始化时应始终明确 fork 的 --repo，防止 CLI 自动选择 upstream。

CI 38338992077：5/6 作业通过，应用集成测试唯一失败是 app-profile.integration.test.ts 旧显示名称断言 MoX bot。按用户确认的新名称更新断言，并增加实际编译 profile 的两种官网地址验证；原有配置、持久会话和深链隔离断言没有删减。聚焦重跑该集成文件 5 项通过。只改测试和文档，不改变已验收的可执行代码，既有原生包无需重建；完整 CI 重新运行后才合入主干。
