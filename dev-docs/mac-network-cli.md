# Mac Bots 网络命令行登录与恢复

任务：MOXBOTS-MAC-NETWORK-CLI-20261016。

CLI 经原 Sidecar Admin admission、Management capability 和当前 Sidecar generation 调用仍在运行的 Rust App owner。没有新增 daemon、listener、配置 writer、私钥存储或安装流程。Mac App 必须已运行，且操作者此前已启用「External Calls」并持有其现有授权 token；沿用 `MYAGENTS_API_TOKEN`，不要把 token、账号密码或私钥放入命令参数。薄启动器负责定位 App 和 Sidecar，直接 App binary 的 `network` 组也在 GUI 初始化之前分流。

```sh
moxbot network status --json
moxbot network restore --connection <connectionId> --revision <registryRevision> --operation-id <UUID> --json
moxbot network login --connection <connectionId> --revision <registryRevision> --json
moxbot network poll --attempt <attemptId> --json
moxbot network cancel --attempt <attemptId> --json
moxbot network cancel-restore --operation-id <UUID> --json
```

使用实际产品 CLI 名；MyAgents profile 的名称是 `myagents`。UUID 接受大小写并在客户端/服务端规范化。`status` 只读当前 registry revision、各连接真实 state、账号认证投影，以及尚未结束的 CLI `loginAttempts`（只有 attemptId、connectionId、expiresAt）。`authenticated` 不能替代服务器的 `ready`；`restore-accepted` 也只表示原生 owner 接纳并启动恢复，须查询 status 看到目标连接 `state: ready` 才证明网络就绪。

先尝试 restore：它只加载原连接完整 scope 的已保存账号和原设备私钥，核对云端现有 key generation/fingerprint。它不请求系统授权、不迁移凭据槽、不生成/轮换 key、不新建账号或设备、不恢复 membership。已 ready/connecting 的 actor 保持原样；后台恢复不能替换它。已注销、过期、钥匙串锁定或缺少访问许可时返回原有 typed error，保留配置与数据；不能绕过系统授权。

需要重新登录时用 login：只接受已有且已获授权的 Owned connection ID 和当前 revision，不接受 issuer、设备 ID、账号或 CA 覆盖。PKCE 从开始就固定原 principal/device/issuer/trust，不先注册临时设备。命令返回 `authorization-required` 和 `started {attemptId, authorizationUrl, expiresAt}`，操作者可在另一台能使用的浏览器打开该链接，用原账号完成登录，然后在本机执行 poll。不会自动打开本机浏览器。不同账号、变化的信任根、缺失或变化的设备 key、已退出的 membership 都不会静默变成新设备/入网；需要相应的原产品授权流程。最终发布复用原连接 ID、原 device ID、原私钥和选择状态；仅轮换原账号会话的不可变 binding 凭据槽。

新登录和恢复均可取消；旧 revision、原记录变化、关闭/退休、迟到回包由原 owner 边界拒绝。恢复由 operation ID 防止重复/提前取消后的迟到发布；登录重复提交不会自动重试。网络请求断开不证明原命令失败：用 status 找回原 loginAttempts，再用同一 attemptId poll/cancel；恢复则查目标 state/revision 或取消原 operation ID，不能直接重放 mutation。pending 的 poll 也返回原 started 链接。取消已完成/不存在的登录可能返回 not-found，应以 status 为准，不能据此撤销已经提交的登录。

安全边界：本能力不启用 External Calls，不读取/导出授权 token，不接收账号密码，不发放新 Host 权限，不启动模型、Session、安装或 App 重启。尚未配置 CLI token 或未获钥匙串访问时仍需原有用户授权。新代码合入 main 不会将能力注入旧版正在运行的 App。

## 验证与交付状态

- 实现：原生已有连接 PKCE、后台只读恢复、六个 exact CLI/Admin routes、严格参数和有界无秘密投影。
- 自动验证：结果维护于同任务 acceptance 文档；包含真实 Sidecar classification/admission/HTTP adapter 的 loopback 合成联调，native scope/key/取消/注册边界回归，以及既有 macOS CI 的 native tests。
- 本次范围：源码、测试、PR/CI/main；不发布、不安装、不重启日常客户端。不把合成服务、类型检查或源码审查当作真实账号/系统钥匙串/生产连接验收。
