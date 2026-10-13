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
- [x] 真实浏览器 pointer/keyboard、1280/900窗口与rail、刷新保留、独立审阅。
- [x] CI、远端main包含交付源码：PR25源头9d879a6e、run38415171294六项成功，main c21e9f43与源头同树，ls-remote/祖先核验。
- [ ] 安装版本/原生重启真实路径：与现有本机Host/凭据安装owner协调后验收。

## Completed

- base/start gate通过；阶段功能fbc6abbb已提交，合并最新main；收尾新增存储失败输入保留与可重试。主/root负责UI、集成与交付；organization_model (Luna/medium) 负责纯规则/prefs；sidebar_ui_review (Sol/medium，嵌套拖拽与混合分区交互)独立验收。

## Verification

- 数据13项/含projection共19项通过；全量tsc通过；侧栏DOM65项及历史搜索16项通过；moxbot web构建和theme8项通过。首轮DOM55通过/6失败，5项为新增拖拽手柄名称与既有模糊查询冲突、1项菜单新增项断言，已更新查询保持语义。独立fixture将实际加载正式组件、使用合成服务数据，不能替代原生发布验收。

## Blockers and unknowns

- 本机安装由“Bots 网络 可用”负责凭据/Host联合更新，本任务不并发退出或换包。用户已授权协调并完整验收，已向两个指定chat发消息；当前运行版未由本任务替换，等待联合包安装后原生侧栏复验；原owner明确保持唯一退出/换包/凭据控制。费用/token未知，未调用AIRouter。

## Next step

- PR25已合远端main c21e9f43；原owner已核实本聊天授权并准备保留6ac923a6凭据修复的联合候选，旧6ac包不含侧栏且未安装。等联合候选验签/具体运行确认/安装回执与UI窗口，执行原生drag/分区/正常重启保留，再关闭发布验收。
