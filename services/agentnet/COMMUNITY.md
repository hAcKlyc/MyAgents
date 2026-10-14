# MoXBots 社区

社区属于现有 owned AgentNet 云服务，与 `/admin`、`/feedback` 复用 `AuthStore`、OIDC 登录和现有 `AdminConfig.admin_principal_ids`。`CommunityService` 不创建账号或第二套权限；每次读写在 `with_valid_session` 的有效会话锁内检查当前 session、network 和管理员名单，撤销立即生效。未配置 administration 时普通社区仍可用，公告与管理 API 返回 `ADMIN_REQUIRED`。

`/community`、`/community/app.js`、`/community/styles.css` 为同源静态页面。`browserReturn:true` 加 `browserReturnPath:"/community"` 只允许精确固定路径，登录发起时绑定到 state；回调参数不能修改返回目标。页面不含用户数据，所有数据接口需要 Bearer session。正常社区接口对任何身份隐藏 hidden 主题；管理员在 `/api/admin/community` 查看隐藏内容。

## API

全部数据响应为 `{ok:true,data:...}`；错误为 `{ok:false,error:{code,message,retryable}}`。

| 方法与路径 | 参数 | data |
| --- | --- | --- |
| `GET /api/community` | 无 | `{items:Topic[]}`，置顶优先，再按创建时间倒序，最多 100 条已发布主题 |
| `GET /api/community/{id}` | UUID | `{topic:Topic,replies:Reply[]}`，最新 200 条回复，按发布顺序正序返回 |
| `POST /api/community` | `mutation_id` UUID、`category`、`title` 1–120 字符、`content` 1–8000 字符 | Topic |
| `POST /api/community/{id}/replies` | `mutation_id` UUID、`content` 1–4000 字符 | Reply |
| `GET /api/admin/community` | 管理员 | `{items:Topic[]}`，包含 hidden，其余排序与上限相同 |
| `GET /api/admin/community/{id}` | 管理员 | `{topic:Topic,replies:Reply[]}`，包含 hidden，回复同样限最新 200 条并正序返回 |
| `PATCH /api/admin/community/{id}` | 管理员，`mutation_id` UUID、`expected_revision`、至少一个 `visibility`/`pinned`/`locked` | Topic |

`category` 为 `discussion`、`question`、`showcase`、`announcement`，公告仅管理员可发。Topic 包含 `id,category,title,content,author_name,created_at,updated_at,revision,reply_count,is_owner,pinned,locked,visibility`；Reply 包含 `id,content,author_name,created_at`。时间为 Unix 毫秒；字符限制按 Unicode 标量计数。内容按纯文本显示。作者名为 network 与 principal 的 SHA-256 派生别名，接口不暴露原始 principal。`is_owner` 按当前会话计算。

成员无法回复 hidden 或 locked 主题；hidden 返回 `COMMUNITY_NOT_FOUND`，管理员可通过管理路径查看 hidden，并可回复 locked 主题。每次新增回复原子更新 reply_count、updated_at、revision；管理修改按 expected_revision CAS，回复发生后旧 revision 也会冲突。首版不提供成员编辑/删除。

错误代码为 `REQUEST_INVALID`、`COMMUNITY_NOT_FOUND`、`COMMUNITY_LOCKED`、`ADMIN_REQUIRED`、`REVISION_CONFLICT`、`MUTATION_CONFLICT`、`UNAUTHORIZED`、`COMMUNITY_UNAVAILABLE`。正文上限 64 KiB；超限使用 HTTP 413 和 `REQUEST_INVALID`；同源校验拒绝不匹配或重复 Origin。缺少 Origin 的原生 Bearer 请求允许。重复 Authorization 拒绝。全服务最多 32 个并发社区操作，超量 HTTP 503。所有响应 no-store，静态页面具备 CSP、nosniff 和 no-referrer。

## 存储、幂等与运维

现有私有 state directory 中新增 `community.sqlite3`（0600，目录为当前用户独占、拒绝软链接和非独占硬链接）。单网络绑定；不同 network 无法重新打开或访问同一库。SQLite DELETE journal、synchronous FULL，写入使用 IMMEDIATE 事务；主题/回复、计数、revision、永久 mutation 回执与不可修改/删除的 audit 同事务提交。audit 只保存在服务端，不进入普通接口。

mutation 以 actor + canonical UUID 唯一；哈希比较完整 JSON body、操作种类与目标实体。完全相同重试返回原始成功响应，内容/操作/目标改变返回 `MUTATION_CONFLICT`。不逐出回执，避免晚到重试重复发布；每 actor 上限 **10,000** 条、全服务上限 **100,000** 条成功变更，达到后新写入返回 `COMMUNITY_UNAVAILABLE`，已有回执重试与读取仍可用。部署运维应监控容量，达到上限前通过经过审查的迁移调整上限；不要删除回执。当前实现保存原始响应，容量还受内容长度影响。

备份与恢复按现有 state directory 流程执行，停服务后完整复制数据库（或 SQLite online backup），保留 0600 权限并验证 network pin。回滚二进制可保留新增数据库；旧版本不会使用它。发布必须先完成本地验证和既有生产备份/服务窗口协调，再核对运行二进制、资源及真实登录/创建/回复/审核路径；本说明不代表已发布。

## 验证

使用仓库固定 Rust 1.92.0：`cargo test --manifest-path services/agentnet/Cargo.toml community`，以及现有反馈/认证回归。测试覆盖持久化、审计防改、Unicode 边界、权限拒绝、session 撤销、管理员关闭、网络隔离、幂等、并发回复与 CAS、读取与写入容量。

浏览器合成验收：`cargo test --manifest-path services/agentnet/Cargo.toml community_browser_fixture -- --ignored --nocapture`，仅监听 `127.0.0.1:5198`，提供 `/community` 和现有 `/admin`。合成上游身份选择器使用真实临时 AuthStore/CommunityStore，不连接生产 OIDC。真实生产账号/授权/持久化验收另行执行，不能由此替代。

2026-10-15 本地后端验证：社区筛选测试 **7 passed / 0 failed / 1 ignored**（ignored 为手动浏览器 fixture）；既有反馈筛选测试 **9 passed / 0 failed / 1 ignored**；`cargo clippy --all-targets -- -D warnings` 通过。验证使用固定 1.92.0 工具链及本机既有 target cache；首次 clippy 发现新增测试的布尔断言风格后已修正并复跑。这些结果不包含生产登录、发布或真实客户端验收。
