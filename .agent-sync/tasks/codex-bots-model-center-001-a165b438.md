<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-model-center-001 -->
<!-- git-project-sync-task:base=3ee8aab5c185b87d607d4692482d987830c63536 -->
<!-- git-project-sync-task:status=in-progress -->


# Task: BOTS-MODEL-CENTER-001 统一模型中心、Bot分配与调用监控

## Objective

统一现有云后台模型中心、Bot 分配与调用监控，builtin/API 三协议，设置式交互。详见 services/agentnet/planning/BOTS-MODEL-CENTER-V1.md。

## Acceptance criteria

- [x] API/有限 Host authority/新旧 Session 版本行为通过，128 Rust tests/0failed。
- [x] 真实 Rust fixture UI/权限/响应式独立验收，390/768/1440与CRUD/replay/unknown计量/ordinary403/logout401通过。
- [ ] 远端 main、CI、云端发布和真实管理员路径。
- [ ] 获授权的单 Bot 真实供应商调用/监控验证，明确费用边界。

## Completed

有限 Host 执行服务现在读取同一 managed Model catalog；新增 3 项动态资源/禁用影子/旧目录回归通过。主体代码已集成，最终源码本地回归通过；独立浏览器验收通过，主干和生产未交付。三个worker分别负责core/Host/UI-HTTP，primary负责原owner authority、集成和交付；非实现者审查修复assignment P1。

## Verification

`cargo test --manifest-path services/agentnet/Cargo.toml`：128 passed/3 manual ignored；clippy --all-targets -D warnings通过。Host targeted12 + lifecycle35 passed/2 Linux-only skipped；真实installedSDK credentialed池5 cases三协议/重试/未知结果仅一次调用/secret扫描以及恶意Grep/Bash、私人hooks/CLAUDE不继承通过。TypeScript/ESLint/分类检查通过。皆隔离loopback/合成provider，不能替代真实费用。

执行记录：native-only；core和Host请求Sol/high、UI-HTTP请求Luna/medium，实际worker运行模型/费用不可确认。并发选择依据是互斥owner模块与独立验证收益；SDK实证促成unknown lease隔离与count_tokens修复，未调用外部模型。

## Blockers and unknowns

平台 API Key/上游模型尚未由用户指定；无实际模型费用授权及新 Host cloud_models opt-in。既有生命周期授权不能复用为模型调用授权。云端与 peer 窗口需实时复核。

## Next step

最新main5315官网增量已合入；PR38补接有限执行 catalog 并修 CI unused-variable，推送最终精确 head CI；准备现有云服务保护备份/回滚，窗口与实际runtime重新核验；不自动启用真实Host或收费模型。
