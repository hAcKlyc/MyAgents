# MOXBOTS-SIDEBAR-ORG-001

用户明确由当前Agent为MoXBots桌面开发任务/Agent拖拽和Codex风格分区，并授权向“Bots 网络 可用”“增加任务归档功能”协调统一安装验收。权威仓库 https://github.com/heavenzhang/MoXBots.git，主干main；本任务采用隔离工作树，保留并行任务。

## 用户可见行为

- 工作区显示选项 → 新建分区。分区可改名、折叠、拖拽排序、删除；删除后保留实际任务和Agent。
- Agent和聊天任务可拖整行或左侧手柄排序/移区，也可从更多菜单“移动到分区”。任务可回原Agent下，未单独移出的子任务跟随Agent移动。
- 拖到其他Agent头部或侧栏外取消，不改任务的工作目录/执行身份。已有导航/归档/收藏入口保持真实行为。
- 使用既有本机sidebar preference，兼容旧v1偏好；部分加载和收藏过滤保留隐藏条目排序。保存失败保持旧投影与对话框输入，允许重试。此设置不提供跨设备同步。

## 分项验证与发布状态

- 实现：阶段功能fbc6abbb，已合并当时最新main fb92ce9c；后续收尾增加失败重试与归档视图创建保护。
- 单元/DOM：19项整理/偏好/导航投影，65项侧栏（含旧回归与新故障路径），16项历史搜索通过；MoXBots Web构建和8项主题检查通过；合并后的全量typecheck/lint和Web构建通过（失败恢复只改renderer，受影响DOM65及独立23项已复验）。
- 独立实际UI：首轮22项正式renderer/合成service通过，发现的两项嵌套误命中均修复复验；收尾23项含真实浏览器Storage故障恢复全部通过，源码hash与45ad14d0一致。详见 [独立报告](sidebar-organization-review.md) 与 [证据](sidebar-organization-validation/results.json)。
- 主审IAB：实际任务向下排序、拖入分区、reload保留、菜单入口及视觉核对。fixture仅合成数据，不能替代Tauri原生重启/已安装用户路径。
- CI/远端main：PR25已合入远端main c21e9f43f9f8ffb629f88fd09e4c680b86de5b30；源头9d879a6e的run38415171294六项全部成功，合并树与其完全相同，ls-remote/祖先核验通过。main push的重复CI另行追踪，不把源头CI说成重复跑已完成。
- 原生安装：原Host/凭据owner负责统一换包，当前客户端未由本任务替换；用户已授权协调与完整验收，原owner已从实际用户消息核实授权，正在保留6ac923a6凭据修复的独立联合源；其旧6ac包不含侧栏且未安装。等待联合包/具体运行确认/实际安装回执与UI窗口，不把本地Web/CI当已安装。

## 执行记录

主/root负责UI、集成、主审、Git交付及安装后侧栏验收；organization_model requested gpt-6-luna/medium，独占纯数据/prefs与测试；sidebar_ui_review requested gpt-6.1-sol/medium，独立判断嵌套拖拽/混合树/焦点与窄窗口，独占合成验收支架与报告。运行时精确消耗/token/费用未暴露，不编造节省。采用ai-yaoren-local，未调用AIRouter。两项真实拖拽缺陷返修；存储失败输入保留由主审补齐并回到独立实际复验。
