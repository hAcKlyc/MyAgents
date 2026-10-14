<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-updater-20261014 -->
<!-- git-project-sync-task:base=0bb3f934368860f46c8e19981feb7ab10ddf1709 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MoxBots independent updater with task-safe confirmed restart and notarized release

## Objective

MOXBOTS-UPDATER-20261014：基于当前main0bb3f934接通独立MoxBots更新地址/签名，静默检查和下载，用户确认重启，运行任务/审批/活动未知时阻止安装并保留pending。服务部署既有官网140.143.183.232，保留官网/其他服务。完成真实签名原生A→B更新验收、正式Apple公证包、主干交付和接续。

## Acceptance criteria

- [x] 权威仓库、main、隔离分支、官网目标核实。
- [ ] 自有更新签名、公钥与独立endpoint配置；不使用上游更新源。
- [ ] 后台检查/下载与跨重启pending恢复，用户确认后安装。
- [ ] 实际执行owner保护：busy/approval/unknown拒绝，防新任务竞态，不停止任务。
- [ ] 聚焦确定性测试、类型/源码检查、独立UI验收。
- [ ] 官网服务器更新路径、私有发布备份/回滚与实际HTTPS下载验证。
- [ ] 原生签名A→B真实更新与重启/版本/数据保全验收。
- [ ] 主干/远端SHA、正式包签名/公证/票据/Gatekeeper/独立产物审计。

## Completed

base main0bb3f934368860f46c8e19981feb7ab10ddf1709；start/task-init通过。上一正式0.5.2包更新器被禁用，需先手动安装首个支持更新的版本。

## Verification

官网HTTPS curl普通信任验证200。现有update lifecycle仅保护进程创建，不保护已运行Sidecar的新turn；worker负责复用SessionEngine权威admission与Rust执行claim。

## Blockers and unknowns

官网root访问凭据正在定位；现有安装正在另一聊天升级，真实更新测试需使用隔离App/数据根，不并发覆盖当前实例。平台本轮正式包目标macOS arm64；Linux仍手动deb。

## Next step

实现自有endpoint/签名与任务安全准入，核实既有官网SSH凭据并只读现网发布结构。

## 进度与并行协调

聚焦Node 124条通过；Rust updater/活动owner9条、独立签名根2条通过，完整原生test编译通过。独立审阅两类准入竞态、download恢复与未落盘回答风险已推动修复复验，最终ready ref与DSH await后writer复读补充中。服务器/srv/moxbots/updates已部署静态路径，尚无stable版本；HTTPS204/no-store与官网200，原官网release a5cb41f0保持，备份/root/moxbots-updater-backup-20261014。初轮Nginx regex未引号导致校验拒绝已自动恢复，修正后nginx -t和reload成功。

用户已批准确认空闲/正常退出/应用数据备份后的真实更新窗口；随后迁移任务MOXBOTS-MIGRATE-001通知临时释放客户端，已停止一切主App启动/退出/UI/安装与~/.moxbot写入，只继续源码测试/构建/公证。迁移完成通知后恢复，必须保留迁移后的8项目/34会话，不用任何旧数据备份覆写。真实更新仍未完成。
