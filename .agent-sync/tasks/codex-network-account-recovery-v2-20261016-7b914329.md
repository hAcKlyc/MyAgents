<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/network-account-recovery-v2-20261016 -->
<!-- git-project-sync-task:base=e872eb5340a987c901ad08287228dff903604c64 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-NET-AUTH-001 — 设备入网恢复实现

## Objective

用户2026-10-16再次要求继续修复并确保Bots网络可用。沿用已批准的新账号、每账号/网络独立设备身份、保留旧身份和任务空闲后启用新版的约束。合同见 `services/agentnet/planning/ACCOUNT-EXPERIENCE-V1.md`；此阶段集中入网，不扩大为完整用户管理开发。

主Agent拥有登录manager、registry、commands及Renderer；既有identity_review worker独占 account/identity/admission/identity_desktop/actor/discovery/source七文件，职责为连接身份引用与局部回归。不操作日常App、真实凭据或服务。原生安装仍遵守统一发布owner；锁屏不妨碍源码和模拟验证，真实UI需要解锁。

## Acceptance criteria

- [x] fetch并核实远端main e872eb53，干净工作树建立独立分支。
- [x] 公开服务当前TLS/实例标识正常；日常App与原sidecars PID/启动时间未变。
- [x] Owned登录使用账号独立设备ID，候选查询完整成功才新建，已有身份显式恢复；保留旧凭据。
- [x] poll结果暂存到最终提交，取消/过期/晚结果不覆盖旧会话；注册配置和guard发布按既有owner裁决。
- [x] 身份/目录/本机标识与登录后的选中连接一致，修复同URL首条匹配导致的选错账号。
- [x] 相称回归、类型/lint/build、独立源码审阅；真实组件合成IAB恢复/取消交互通过，原生真实账号验收仍开放。
- [ ] CI、main提交/合并/推送及远端包含核验。
- [ ] 新版串行发布、任务空闲后安装与真实账号ready、目录、可调用链路验收。

完成标准：源码/模拟通过不代替真实入网；必须分别证明用户session、设备身份、membership、relay ready及目录完整。远程Agent执行只在既有授权scope使用可控任务验证，不扩大Host/模型权限。

当前实现前状态：新账号已登录，设备冲突未恢复；未修改生产配置、旧绑定或全局deviceId。无新增外部模型调用，实际token/费用未知。

## Completed

原登录 manager / registry 继续拥有会话提交；无新进程、协议或服务权限。每 binding 新 OS 凭据槽与原子配置指针避免覆盖旧 session；提交与回滚均未知时保留两个槽和 token，阻止继续登录。旧记录缺省 `sessionBound: false`，新记录 true；回退旧版必须恢复启用前配置备份、保留当前业务数据。恢复已有登记需第二轮同 principal 授权，保持服务端 device-bound token 不变。

## Verification

- 网络 Rust：184通过、1既有忽略，使用 `DOCS_RS=1 cargo test --lib agent_network::` 跳过本机不相关 Swift bridge 构建；不是完整原生构建。包括崩溃/回滚未知、取消、隔离和旧槽兼容。
- Headless Rust：157通过；Renderer API34、DOM79通过；typecheck/lint/web build通过（既有依赖警告）。
- IAB：真实 JoinNetworkDialog + 生产构建CSS，合成数据验证第一次请求 → 恢复旧设备提示/更新URL → 打开第二轮 → 取消仍使用同一逻辑attempt；未访问真实账号。私有截图在用户项目 output/network-recovery-20261016/restore-identity.jpg，不入Git。
- 本机完整 native 构建被现有 CLT Swift PackageDescription ABI不一致阻断；未修改系统工具链，交由健康CI验证默认原生代码。
- identity_review完成三轮只读安全审阅；前两轮共四项实质风险已由主Agent修复，最后一轮未发现新增风险；独立审阅不代替真实联调。主Agent集成/验收，原worker实现七处身份引用和三个隔离回归；实际费用、token未知，无额外外部模型调用。
- 日常App PID48419及global/session sidecar48462/50158启动时间仍为07:39:18/07:39:22/07:40:51，未stop/restart/移除旧连接。Mac仍锁定，工具明确无法自动解锁。

## Blockers and unknowns

### 串行发布请求（queued）

需要新版macOS arm64客户端恢复已登录新账号的设备入网；仅纳入统一owner下一未冻结批次，不重写056归档，不操作云服务或Host。发布owner `.agent-sync/plan.md#deployment-coordination`；本记录不会通知该聊天。依赖：CI/main、启用前配置私有备份、正式Reader/签名制品与回滚准备、任务空闲和手动解锁。安装后用原新账号验证session有效、独立设备登记/identity、membership、relay ready、设备目录及既有权限范围的可调用路径；另验同账号重登恢复与旧账号身份保留。当前未安装、未恢复ready、未完成生产验收。

## Next step

推送并经CI合入真实main，记录远端包含结果；发布和原生验收仍按上述依赖开放，不能以公开instance HTTP200替代入网。
