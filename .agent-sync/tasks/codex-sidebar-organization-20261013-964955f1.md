<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/sidebar-organization-20261013 -->
<!-- git-project-sync-task:base=e976726355918cd37fa832641028c84b78786234 -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-SIDEBAR-ORG-001

## Objective

任务与Agent拖拽、自定义分区创建/重命名/折叠/删除/排序、混合条目整理及本机重启保留。当前Agent执行；只改变侧栏偏好，不改变执行Agent/工作目录/Session身份。

## Acceptance criteria

- [x] 实现任务/Agent/分区排序、跨分区移动与菜单替代，删除分区保留真实条目。
- [x] 偏好v1兼容、异常输入、隐藏条目排序、存储失败及导航回归。
- [ ] 真实浏览器 pointer/keyboard、1280/900窗口与rail、刷新保留、独立审阅。
- [ ] CI、远端main包含交付源码。
- [ ] 安装版本/原生重启真实路径：与现有本机Host/凭据安装owner协调后验收。

## Completed

- base/start gate通过；阶段功能fbc6abbb已提交，合并最新main；收尾新增存储失败输入保留与可重试。主/root负责UI、集成与交付；organization_model (Luna/medium) 负责纯规则/prefs；sidebar_ui_review (Sol/medium，嵌套拖拽与混合分区交互)独立验收。

## Verification

- 数据13项/含projection共19项通过；全量tsc通过；侧栏DOM65项及历史搜索16项通过；moxbot web构建和theme8项通过。首轮DOM55通过/6失败，5项为新增拖拽手柄名称与既有模糊查询冲突、1项菜单新增项断言，已更新查询保持语义。独立fixture将实际加载正式组件、使用合成服务数据，不能替代原生发布验收。

## Blockers and unknowns

- 本机安装由“Bots 网络 可用”负责凭据/Host联合更新，目前该chat活跃；本任务不并发退出或换包。未取得跨chat发消息授权，先完成可审阅源码/验收。费用/token未知，未调用AIRouter。

## Next step

- 保存阶段提交并合并最新main，完成独立实际UI复验/CI；再协调统一客户端发布。
