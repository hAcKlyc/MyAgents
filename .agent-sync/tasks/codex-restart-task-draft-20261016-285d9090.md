<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/restart-task-draft-20261016 -->
<!-- git-project-sync-task:base=c0f7649d8ca08e017001e24492d46952c23b0159 -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-RESTART-DRAFT-002 Preserve task drafts across update restart

## Objective

用户反馈截图中“未保存任务设置”不应阻止重启。当前确认门禁将所有 cronConfig（包括已保存任务的运行投影）当草稿，真正待提交的 Goal/Cron 设置又未纳入原草稿交接。沿用 SimpleChatInput/Chat/useCronTask 与原 update-composer-drafts.json owner，补齐精确快照及恢复；不停止日常任务，不绕过运行/录音/附件/写盘保护。单Agent实现、主Agent负责UI验收，必要时独立审阅；纯内置，未切换模型，无外部模型调用。

## Acceptance criteria

- [x] 验证canonical repo、干净工作区、main c0f7649d与发布owner。
- [x] 已保存Task配置不再误报未保存草稿。
- [x] Goal/Cron未提交草稿随原检查点落盘，重启后按精确owner恢复且不创建/启动任务。
- [ ] 回归：旧交接兼容、晚到hydrate、现有输入不覆盖、错误/取消保留；类型/lint/build及真实组件合成交互。
- [ ] PR/CI/main远端包含核验。
- [ ] 新未冻结修复版串行发布与原生更新/恢复验收（统一owner）。

## Completed

修正已保存配置误判，沿原检查点新增严格v2 Goal/Cron设置交接，兼容v1，精确owner恢复只回编辑态。恢复等待当前激活两类任务hydrate且拒绝覆盖已有内容；未确认raw设置编辑仍由原弹窗owner保护。specs/tech_docs/auto_update.md记录契约。057已冻结并服务器发布，不能回写原字节。

## Verification

- 定向相关测试 152/152 通过；最后修改后重跑6个文件110/110通过（含A→B→A两类恢复、真实组件恢复、弹窗raw编辑保护、发送回归）。
- npm run typecheck、npm run lint、npm run build:web及构建主题8项回归通过。
- 独立只读审阅发现 Goal晚到hydrate、raw弹窗编辑和A→B→A复用风险，均已修复；最终复核无阻断。
- IAB真实SimpleChatInput合成页初始渲染通过，跨页面重载遇验收适配器/浏览器无响应，尚不计交互通过。原生重启仍未执行。
- 日常客户端0.5.7，HRM任务有持续输出；本任务未停止或重启客户端。
- 本地日志 /tmp/moxbots-restart-draft-{tests,final-tests,typecheck,lint,build}.log，不将本地日志/浏览器存储/个人内容提交Git。

## Blockers and unknowns

当前安装包尚未修复。真实更新和跨进程恢复待统一发布owner；057原生尚未通过，不以截图/模拟当真实安装完成。Launcher/pending Session及其他尚无可恢复owner的草稿继续保留原保护。

## Next step

完成浏览器合成交互、PR/CI/main远端核验，并沿既有授权交统一发行owner安排下一未冻结修复版。

## Deployment request

Required：由统一桌面发布聊天01a12bc2-907a-7702-b6dd-788225c5dfe4处理下一未冻结修复版，不修改已发布0.5.7。该修复解决用户入网修复升级时遇到的草稿门禁；沿用用户已授权发送并安排修复版。无数据库迁移/服务端配置变更。旧客户端没有v2写入能力，必须由发行owner评估安全原生启用路径并备份应用/草稿；保持已运行任务，任务空闲且fresh admission通过后才启用。回滚保留v2交接文件，旧版不能解释时必须保留并拒绝更新，不清理或重建身份。代码主干、候选包、发布和真实重启/入网验收分别记录。
