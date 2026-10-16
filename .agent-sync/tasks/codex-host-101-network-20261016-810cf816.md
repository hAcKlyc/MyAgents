<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/host-101-network-20261016 -->
<!-- git-project-sync-task:base=5d6a62dd210ac518a343288040c7cc86d50610d3 -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-HOST-101-20261016

## Objective

用户2026-10-16明确要求本聊天在101.42.11.29安装Host并配置MoXBots网络，提供受控SSH密钥。核查发现已有MoX Host安装运行正常，owned connector因ACCOUNT_SESSION_EXPIRED离线；因此本轮复用已装版本、既有设备ID和本地配置，恢复网络，不创建重复Host或升级无关组件。

## Acceptance criteria

- [x] SSH ubuntu+sudo、Ubuntu24.04 x86_64及既有安装/服务/状态核验。
- [x] 只读定位过期登录；原MoX Host ID保持cc8fc885-529b-43e9-8a58-ee7c5f2a4c58。
- [ ] 核对原101维护owner无并发操作、备份和回退。
- [ ] 原账号授权恢复、实际network ready/management IPC及云端在线核对。
- [ ] 主机/config/identity保全和开机自启复核。
- [ ] 非秘密任务/部署记录同步main，实际运行版本不以源码HEAD代替。

## Deployment coordination

本次用户直接指定当前聊天01a13320-dbf9-7c03-b7f3-37e30d15de48执行101 Host安装入网，作为该目标专用操作owner；主干既定桌面部署owner仅覆盖macOS updater/安装，本任务不接管其窗口、不操作日常Mac/140后端或其发布目标。执行前须核对101原owner窗口及Host无活跃任务。已授权向既有网络聊天协调，无新权限/付费模型调用。仅复用已有网络身份/账号及服务原权限，不重设加密身份。

## Completed

源码参考main5d6a62dd，既有Host current=/opt/moxbot-host-test/releases/20261014193216-83e48946bad9，connector current83e48946bad9f31f1aa903a6a58b794acaf9a354。两套myagents旧服务保留。MoX本体active，connector failed/ACCOUNT_SESSION_EXPIRED。密钥仅使用受控附件，已限制0600，原文不回显/入Git。

## Verification

只读SSH/sysunit/受限日志检查；尚未变更服务或完成入网。敏感auth URL、账号令牌、密钥和备份仅存原服务器私有路径，不提交Git。

## Blockers and unknowns

等待原维护owner确认101窗口；精确登录账号以既有授权账号及原加密身份owner校验，不能任意切换。实际网络恢复尚未完成。

## Next step

原owner释放101后，检查Host空闲并备份既有identity/config/state/unit；通过正式network-control登录恢复和原run流程验收。若产品必须交互登录则给用户具体短时入口，不以复制token绕过。
