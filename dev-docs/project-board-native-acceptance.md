# MOXBOTS-PROJECT-BOARD-001 原生与发布验收

日期：2026-10-14

## 制品与安装

- 候选源码：`5f1a8feb879775a9655c7e5cf848661f692be542`。
- 本机已安装：`/Applications/MoXBots.app`；owner核验Developer ID Team `QJ5URBG9AP`、19项包资源一致。签名有效；Apple公证状态为未公证。
- ARM64 ZIP：`MoXBots-Trial-macos-arm64-5f1a8feb.zip`，346,377,153 字节，SHA-256 `e26a8e9a48a9083fe4283c0c6a0538dfd2dd639922a04326f718ff67fd7e220c`。
- 安装/发布owner通过IAB在公开下载页点击真实下载链接取得完整ZIP；主Agent独立计算取回件大小与SHA-256，与候选ZIP逐字节摘要一致，`unzip -tq`无错误。匿名下载记录及发布回执保存在本机 `MoxBot/output/download-page-release/`。
- 官网：[下载页面](https://moxbot.mailxf.chatgpt.site/download/)；[GitHub发行页](https://github.com/heavenzhang/MoXBots/releases/tag/moxbots-trial-20261014-5f1a8feb)。

## 真实桌面路径

经CUA在安装后的MoXBots窗口完成：从Mino项目入口打开唯一看板Tab；观察真实状态分组及未关联会话；列表/搜索切换保留选择、详情与筛选；返回原空闲会话不输入、不触发模型；快照过期时显示状态未知，刷新后恢复为空闲。

创建受控本地Task `PB-NATIVE-QA-20261014`（ID `5dc7e135-3d4f-4fbd-a351-077fd22e395d`，executor `user`），在看板读到后依次更新 `todo → running → verifying → done`。`verifying`阶段在UI记录验收说明并确认完成，CLI回读为`done`。随后归档该受控Task，CLI回读`archived`。没有Agent派发、模型执行或业务数据写入。

## 2026-10-14 补验进度

- 归档恢复：正式CLI回读既有Task为`archived`；`archived → done`被authority拒绝且无变更。依合法迁移`archived → todo`恢复同一Task（不run、不rerun），看板与列表重新显示`PB-NATIVE-QA-20261014`，项目总数由1回到2、待开始数为1。恢复阶段Task为todo；后续受控正常重启读回成功，并已再次归档回收。
- 最窄支持布局：CUA真实拖动安装窗口至1600×1600设备像素（2×屏幕，即800×800 CSS px），自动rail、单列状态折叠、会话卡片、400 CSS px侧边详情均实际显示，文字和操作可读。
- 键盘：打开会话详情后初始焦点在关闭按钮；Tab进入概览，并依次经过执行记录、交付与验收、原会话入口。Escape关闭详情后焦点回到原卡片。
- 原生适用范围：`src-tauri/src/lib.rs`的main窗口为`.min_inner_size(800.0, 600.0)`，项目看板`useBoardOverlay`的≤700 CSS px断点低于原生下限；该模态抽屉/焦点陷阱属于浏览器布局，已有Web/fixture验证，不能称为Native通过。原生支持单一main工作窗口，其他native builder为悬浮球/遮罩/companion，并无第二个项目工作窗口入口；本任务多主窗口验收不适用。
- 用户新建的UnisModel项目保留不动，实际空看板显示0项任务与会话和新建引导。
- 跨正常退出/重启及任务状态读回：锁屏后暂停，用户明确回复已解锁；重新从安装owner接回独占UI。主Agent通过Cmd+Q正常退出，进程检查确认安装App不再运行，再用CUA exact app path冷启动同一5f客户端（新PID65620，binary SHA-256仍为`a289686ab5c2b7605b9951c4215b3135efdfb6974eb77e5d80a7e056c3c9cea3`）。真实看板/列表与集成终端正式CLI均读到同一Task为todo，6条状态历史包含初始创建、前次验收及归档/恢复说明。

## 边界

- 文档读回：TaskDoc UI显示实际`Agent`占位正文，文件SHA-256`0f0f9d17eccf79315525ac937b9b880c1ebecc37bf431a630819d379d1605c94`与重启前一致；该文件创建以来为6字节，本次以实际文件为保留基线，不把聊天摘要中的中文预期Prompt当成已验证原始正文。
- 回收：`todo → archived`被authority拒绝且无修改；按受控user任务的合法链`todo → running → done → archived`关闭，未调用task run/rerun。最终CLI回读archived，磁盘执行次数0、sessionIds为空、历史9条；看板总数回到1、待开始0，原合成聊天/附件仍可见。
- 启动期间没有出现系统钥匙串或授权恢复提示，未进行登录、恢复或系统授权；只读AgentNet页面自动显示本机与Linux-Host在线。这是一次正常冷启动观察，不替代其他任务的全部凭据/远程管理验收。
- 原生补验已完成并归还安装owner独占UI，5f未被替换。

## 验收边界

- 支持的单main桌面窗口、800 CSS px最窄布局、任务归档/恢复/跨正常重启和键盘退出/焦点返回已通过。≤700模态布局与第二项目主窗口不属于当前Native支持范围，未伪报Native通过。
- 未覆盖活动中Session、所有Host组合及生产数据写入；看板读取与受控Task状态闭环不能替代这些场景。
- 本次公开包已核对完整内容；它未经过Apple公证。官网发布和安装不意味着包凭据迁移、远程设置等其他功能已完成。
