# MOXBOTS-PROJECT-BOARD-001 原生与发布验收

日期：2026-10-14

## 制品与安装

- 候选源码：`5f1a8feb879775a9655c7e5cf848661f692be542`。
- 本机已安装：`/Applications/MoXBots.app`；owner核验Developer ID Team `QJ5URBG9AP`、19项包资源一致。签名有效；Apple公证状态为未公证。
- ARM64 ZIP：`MoXBots-Trial-macos-arm64-5f1a8feb.zip`，346,377,153 字节，SHA-256 `e26a8e9a48a9083fe4283c0c6a0538dfd2dd639922a04326f718ff67fd7e220c`。
- 主Agent从公开下载页点击真实下载链接取得完整ZIP，并独立计算大小与SHA-256；与候选ZIP逐字节摘要一致，`unzip -tq`无错误。匿名下载记录及发布回执保存在本机 `MoxBot/output/download-page-release/`。
- 官网：[下载页面](https://moxbot.mailxf.chatgpt.site/download/)；[GitHub发行页](https://github.com/heavenzhang/MoXBots/releases/tag/moxbots-trial-20261014-5f1a8feb)。

## 真实桌面路径

经CUA在安装后的MoXBots窗口完成：从Mino项目入口打开唯一看板Tab；观察真实状态分组及未关联会话；列表/搜索切换保留选择、详情与筛选；返回原空闲会话不输入、不触发模型；快照过期时显示状态未知，刷新后恢复为空闲。

创建受控本地Task `PB-NATIVE-QA-20261014`（ID `5dc7e135-3d4f-4fbd-a351-077fd22e395d`，executor `user`），在看板读到后依次更新 `todo → running → verifying → done`。`verifying`阶段在UI记录验收说明并确认完成，CLI回读为`done`。随后归档该受控Task，CLI回读`archived`。没有Agent派发、模型执行或业务数据写入。

## 边界

- 没有跨应用重启验证看板；受控归档Task未执行unarchive恢复验收。
- 本机可用窗口宽度只验证到单列折叠布局；≤700 CSS px抽屉、键盘遮罩和多窗口路径未覆盖。
- 未覆盖活动中Session、所有Host组合及生产数据写入；看板读取与受控Task状态闭环不能替代这些场景。
- 本次公开包已核对完整内容；它未经过Apple公证。官网发布和安装不意味着包凭据迁移、远程设置等其他功能已完成。
