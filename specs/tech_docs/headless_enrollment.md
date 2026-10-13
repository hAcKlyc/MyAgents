# Linux Host 基础入网（MAH-ENROLLMENT-20261012）

此阶段让无桌面的 Linux Host 登录同一官方账号并连接现有 AgentNet。没有 Provider 或本地 Agent 时，Host 发布真实空目录；设备在线与可执行模型任务分别验收。固定协议为 1.1.0，此阶段不新增设备管理 wire 方法、不手改 vendor，也不开放公网管理端口。

## Owner 与交付边界

`src-tauri/headless-network/` 是独立 Rust executable，拥有 Host 自己的账号授权、稳定设备身份与出站连接生命周期。它消费原 Rust identity/JWT/transport/policy 等实现与固定协议产物；Desktop 默认 OS credential store 保留在桌面 adapter，Host 显式选择已验证的 systemd KEK 加密存储。账号授权流程复用 Space 的 desktop start/poll/ack API，不能复制桌面 session Token 或从用户目录扫描凭据。

Node Host 继续持有本地 Session 执行与配置。独立 Rust UID 持有账号/设备秘密，Node 不获得 KEK、账号 Token 或私钥。此阶段没有 Agent，因此没有可调用 mount；收到业务通道不得执行任务。未来 Agent 目录必须来自真实本地 owner，读失败不能发布为空目录。

## 授权与状态

基础过程为：安装连接程序 → `auth-start` 生成短时授权链接 → 用户在浏览器登录同一账号 → `auth-wait` 领取并加密持久化账号授权 → 连接服务执行身份签发、Hello、空 catalog、目录 policy 与服务端 Ready 确认 → 桌面设备目录显示该 Host。入网 membership 仍通过既有 join/leave owner 与 revision/receipt 完成，不能将账号设备登记当作网络在线。

CLI 合同：

```text
myagents-host-network <auth-start|auth-wait|auth-cancel|run|status>
  --state-dir ABS --unit UNIT.service --credential identity-kek
  --device-id UUID [--device-name NAME] [--status-file ABS]
```

命令参数全部非秘密。临时登录值与账号 Token 不出现在 Node、renderer、命令行或日志中；授权链接仅交给发起授权的操作者，不写入仓库/证据日志。账号切换、取消与到期必须废弃迟到结果。status 只提供受限非秘密连接投影；只有服务端 Ready 与当前 scope 匹配才报告就绪，连接关闭后不得保留在线状态。

## 测试安装

`scripts/host/network-install.py` 仅管理 `myagents-host-network-test` 的固定测试路径、专用用户、加密 KEK 与 systemd 单元；安装程序验证指定 CI 制品的 source 与可信 SHA，已有未标记路径/账号保留并拒绝复用。重复安装不触发重复授权；版本升级需操作者先备份并停止连接服务。原 `myagents-host-test` 数据与 Node 服务保持。

`scripts/host/network-control.py` 提供固定的授权/状态入口，使用 systemd 的专用 credential projection；不接受任意命令或 Token 参数。只有出站 HTTPS/WSS，不创建 Host TCP listener。具体操作参数以脚本 `--help` 和实际 CLI 为准。

## 验收边界

CI 独立编译并检查依赖不含 Tauri/GTK/keyring/Secret Service，执行关键账号状态、协议就绪与安装安全测试；这些结果不能证明官方服务接入。真实验收需要 Linux systemd、用户浏览器授权、桌面同账号设备目录、在线状态及重启恢复证据。Provider 配置和模型执行后置，不将其未配置当作入网失败；新增远程 Host 管理仍须正式协议与服务端支持。
