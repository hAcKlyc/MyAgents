<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-model-center-001 -->
<!-- git-project-sync-task:base=3ee8aab5c185b87d607d4692482d987830c63536 -->
<!-- git-project-sync-task:status=complete -->


# Task: BOTS-MODEL-CENTER-001 统一模型中心、Bot分配与调用监控

## Objective

统一现有云后台模型中心、Bot 分配与调用监控，builtin/API 三协议，设置式交互。详见 services/agentnet/planning/BOTS-MODEL-CENTER-V1.md。

## Acceptance criteria

- [x] API、有限 Host authority、原 Session 行为与密钥保护：135 Rust tests/0 failed，三协议实际 SDK 隔离验证通过。
- [x] 真实 Rust fixture UI、权限、回放与 390/768/1440 独立验收通过。
- [x] PR38 合入远端 main，源码与主干七项 CI 成功；制品与已接受源码整树相同。
- [x] 现有云后台发布，备份/回滚、实际运行二进制与网页资源来源核验。
- [x] 真实受控管理员新建供应商/模型、Bot 分配、重启保留、监控与清理验收。
- [ ] 后续用户自行配置供应商后，另行有限 Host 接入与真实供应商调用验收；用户已明确本次不导入配置、不调用模型。

## Completed

同一 `/admin` 的模型中心、builtin/API 模型分配与调用监控已上线。配置 revision 与 Host effective snapshot 分别显示，历史计量捕获实际模型/供应商版本。有限 Host 执行读取同一 managed catalog；模型停用后的有界队列收尾和未知已租约删除 fence 回归通过。没有新增后台、账号、整机或私人 Session 权限。

源码及云发布锚点、机器可读证据与协作记录见 `dev-docs/bots-model-center-production-acceptance.md`。独立审查见 `dev-docs/bots-model-center-review.md`。任务执行期间新增敏感权限必须另行具体授权，本次未开启实际 Host cloud_models 或调用供应商。

## Verification

Rust 135 passed/3 manual ignored、clippy all-targets -D warnings、fmt 通过。Host targeted12 + lifecycle35 passed/2 Linux-only skipped；真实 installed SDK 隔离池5 cases，三协议、未知结果仅一次调用、凭据扫描及恶意 Grep/Bash、私人 hooks/CLAUDE 不继承通过。TypeScript/ESLint/分类检查通过。上述 SDK 使用 loopback 合成 provider，与生产供应商调用分开。

生产真实测试账号完成配置/分配持久化，受控网络重启 0.287 秒；测试 supplier/model 停用、测试 Bot 软删除，调用记录未增加。凭据、合成 key、数据库和制品不进入 Git。

## Blockers and unknowns

用户最终明确“复用功能，后面自己配置”，覆盖早先配置文件请求；没有缺失配置文件阻断。本任务的云端配置及管理路径已验收，真实 supplier/费用与实际 Host 联合升级属于后续用户配置阶段，不能称作已接通真实 Bot 推理。101 Host/桌面由原 owner 独占，本轮未改变。通用旧注销 actor 队列公平性问题另记 BOTS-EXEC-QUEUE-FAIRNESS-002，保留基线边界。

## Next step

用户在现有模型中心配置供应商、添加模型并分配 builtin Bot。真实推理前由 Host owner 启用限定 cloud_models，并协调当前 Host/桌面交付版本；使用具体测试 Bot、有限额度验证供应商返回和调用计量。本次记录关闭提交仅更新文档，不替换已接受的发布代码。
