# MoX bot 并行试用版

任务：MAH-MOXBOT-ISOLATION-20261013。范围：macOS Apple Silicon 内部试用包。

使用独立应用标识 `com.moxbot.app`、`~/.moxbot`、`moxbot://` 和 `~/.moxbot/bin/moxbot`。不导入 MyAgents 的配置、凭据或会话；首次使用需在新应用中独立配置和登录。

统一构建入口：`npm run tauri:build:moxbot -- --no-sign --bundles app`。先按既有流程准备原生资源。该入口固定 Vite、esbuild、Cargo 的 `MYAGENTS_BUILD_PROFILE=moxbot`；既有默认构建保持 MyAgents。

MoX bot 关闭 MyAgents 官方应用更新通道，后续试用版本手动替换 MoX bot 应用包。

## 验收

- [x] 应用标识、实际状态路径、设备身份、CLI 和 OS 深链隔离代码。
- [x] MoX bot 启动恢复只清理自身资源和状态目录中的残留进程。
- [x] 默认 MyAgents 回归与 MoX bot 构建 profile 测试（CI 38313991914 全部通过，双 JS profile 构建成功）。
- [x] 原生包 ad-hoc 签名、精确资源和 ZIP CRC/解压验证；未 Developer ID 签名或公证。
- [x] `50f3722c` 试用包真实启动并与原 MyAgents 同时运行；当前二进制摘要与交付包一致，原进程、设备身份、启动锁和 Sidecar 端口保留。
- [ ] MoX bot 登录后配置持久化和重启检查。
- [ ] 提交、CI、合入 fork main、远端同步核实。
- [x] 最新试用包 `MoX-bot-Trial-macos-arm64-50f3722c.zip` 已交付，源码 `50f3722caac85f6b936cbb89832f918d1ec2cb43`，346617942 bytes，SHA-256 `e351e69be77af2287d04b5a332c72188802cfd6fdf8994a5293d4e54b4969be5`；原生构建、19 类资源逐字检查、ZIP CRC、macOS 解压和严格 ad-hoc 签名验证通过。旧 `76ce62dc` 包保留。

远程模型配置及创建 Linux Agent 的独立服务联调仍属于 MAH-SELFHOST-SERVICE-20261012，不能用本次并行启动验收代替。

## 进入自部署网络

在“设置 → 关于”连续点击应用 logo 五次，进入“开发者”，开启“AgentNet 多网络（实验性）”。随后打开 AgentNet 顶部网络选择菜单，选择“加入自部署网络 → 账号登录”。该开关默认关闭；启用入口本身不会登录或加入网络。

本次已通过实际窗口验证入口和账号登录请求创建。隔离服务通过 SSH 的本机回环隧道连接，私有测试 CA 在桌面连接内显式指定；内置浏览器因未知 CA 拒绝导航，浏览器证书警告需用户接管。未安装全局 CA、未关闭证书校验、未新增公网监听。实际登录、Linux Host 入网、管理表单与真实模型执行仍待验收。
