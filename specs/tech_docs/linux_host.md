# Linux Host（MAH-LINUX-20261012）

目标：Linux 无桌面安装、常驻与真实本地执行，随后复用 AgentNet 连接和设备权限完成远程配置。首个测试平台是 Ubuntu 24.04 x86_64。当前阶段不是正式签名发行，也不是 AgentNet 联调完成。

## Owner 与第一阶段边界

`src/host/main.ts` 拥有 Host 生命周期、单实例锁下的配置变更准入和活跃 Session 子进程。每个 Session 至多一个子进程，第一版最多同时活跃一个 Session；替换必须等待旧进程退出。`src/server/host-session-worker.ts` 通过原 SessionEngine facade 执行，原 SessionStore 拥有 Session metadata/transcript，SDK 拥有原生 resume 历史。Host 不建立第二套执行队列或 Session 数据库。

Host 使用独立 HOME 和原 `.myagents/config.json` 配置 authority；`hostSettings` 记录 Host 配置 revision 与默认 workspace/provider/model。Host identity 只保存稳定非秘密 UUID，尚不是 AgentNet 签发身份。所有控制请求使用权限为 0600 的 Unix socket，无公网监听。只接受指定工作区根目录下的真实目录，权限响应复用真实 requestId。

Provider 配置保留 `systemd-credential:<name>` 引用。只有开启 Host mode 的进程才能从 systemd tmpfs credential directory 解析引用。原始 Key 不写 config、Session 快照、Git 或日志。新 Session 固化 concrete ProviderRoute，已有 Session 保留 birth snapshot。安装器只接受调用者提供的归档 SHA-256，并在执行归档代码前验证清单；SHA-256 不等于发布者签名。

## 完成标准与 To Do

- [x] fork 到当前授权 GitHub 账号，已有桌面 Host 管理界面交付 fork main（4267bdb9）。
- [x] 核查 SessionEngine 独立运行 seam；保留一进程一 Session、不以 idle 代替 terminal。
- [x] Host supervisor、Unix socket CLI、配置 CAS 和无秘密身份持久化。
- [x] 原 SessionEngine worker、权限/停止/terminal、持久化与恢复。
- [x] 无 GUI 的 Linux 自包含包、幂等 systemd 安装、校验与回滚。
- [x] 本地自动测试、桌面相关回归；非实现者审查。
- [x] Linux 真机安装、进程/权限/端口/身份重启验收。
- [ ] Kimi 小规模真实任务、受控文件结果、权限往返、重启续接与失败停止验收。
- [ ] 本阶段提交、fork main 合入推送、核实远端主干与服务器制品来源。
- [ ] Agenthub 协议源码与测试实例依赖可用；设备 enrollment、远程配置权限/回执、桌面联调。
- [ ] 正式签名 release、upgrade/schema rollback 与完整平台支持（不属于首个测试包验收）。

## 执行记录

主智能体负责 supervisor、credential helper、集成与服务器验收；`headless_runtime_review`（请求 GPT-6.1 Sol / medium，跨进程 owner 核查与 worker 实现）只负责 worker/protocol/测试；`host_packaging`（请求 GPT-6 Luna / medium）只负责 `scripts/host/`。当前用量与费用未知，不将请求配置当实际计费。选用 ai-yaoren-local，未派发外部模型开发包；Kimi 仅用于用户指定的 Host 真实运行测试。

服务器是获授权隔离测试环境，已有服务不改动。首个测试包不包含 Tauri、WebView、Renderer、媒体模型和浏览器制品；当前未启用 Task/Goal/IM/DSH 或跨设备功能，不宣传这些能力已经移植。AgentNet 后续以 Agenthub 的协议源码与固定产物为 authority，不手改 vendor 契约。

本地证据：Host 专项 10 项、相关 Provider/Session 回归 37 项通过；完整 lint 与 typecheck 通过。独立复核发现并修复 ESM bundle 启动、就绪回滚、凭据目录权限和 Linux 单实例锁四项问题；静态复核无剩余阻断。systemd 真机行为和真实模型执行另行验收。

## Ubuntu 真机阶段验收（2026-10-12）

代码提交 `000e9632` 对应测试包已实际安装。已验证独立 systemd 服务、Node 24.20.0、原生 SDK CLI 2.1.296（wrapper 0.3.296）、Unix socket 0600、私有状态目录 0700、无新增 TCP 监听、现有服务保持运行。配置 CAS/冲突与重启持久化、稳定身份、同包内容核验及不重启进程、错误归档校验拒绝、内核锁防重复进程/伪造标记、活跃时更新拒绝、强制启动失败后的旧版本/服务/配置恢复均通过。

systemd 255 将凭据投影为 root-owned 0440 文件与 ACL；修复仅接受精确私有只读 tmpfs 挂载，普通目录中的组可读文件仍拒绝。用合成加密凭据、关闭 executionAuthorized 验证真实 Session 创建、禁止 send、释放及服务重启后同身份恢复，未发模型请求；测试凭据已移除。该证据不能代替真实 Kimi 执行、SDK 原生会话续接、权限往返或停止验收。

首包约153 MiB，安装约377 MiB，空闲服务约17 MiB内存（单次测量，不包含执行峰值）；主要体积来自固定 Node/SDK，未包含桌面组件。完整本地 unit 5429、DOM 2135、integration 866 项通过（另有跳过项）；相关桌面构建冒烟通过。macOS完整构建脚本的一项未修改 DSH 测试预期 xattr 权限失败，但本机返回成功；Host专项通过，Linux CI另行门禁。服务器地址、凭据位置和原始验收日志只留主聊天私有记录。

AgentNet 下一阶段详见 [linux_host_agentnet.md](linux_host_agentnet.md)。凭据路径与 Agenthub authority 访问仍是外部依赖；主 Goal 保持进行中。
