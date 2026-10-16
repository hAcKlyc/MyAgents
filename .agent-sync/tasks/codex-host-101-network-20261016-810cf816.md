<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/host-101-network-20261016 -->
<!-- git-project-sync-task:base=5d6a62dd210ac518a343288040c7cc86d50610d3 -->
<!-- git-project-sync-task:status=complete -->


# Task: MOXBOTS-HOST-101-20261016

## Objective

用户2026-10-16明确要求本聊天在101.42.11.29安装Host并配置MoXBots网络，提供受控SSH密钥。核查发现已有MoX Host安装运行正常，owned connector因ACCOUNT_SESSION_EXPIRED离线；因此本轮复用已装版本、既有设备ID和本地配置，恢复网络，不创建重复Host或升级无关组件。

## Acceptance criteria

- [x] SSH ubuntu+sudo、Ubuntu24.04 x86_64及既有安装/服务/状态核验。
- [x] 只读定位过期登录；原MoX Host ID保持cc8fc885-529b-43e9-8a58-ee7c5f2a4c58。
- [x] 原101 owner明确只读并经其human指定本聊天唯一执行；备份和回退记录已保存。
- [x] 原账号PKCE登录与明确同principal renew-management；实际ready、management IPC ESTAB及云端metadata ready/joined核对。
- [x] 连接服务受控重启恢复ready；原HostId/key/config/unit保全，两unit均enabled。
- [ ] 非秘密恢复验收记录提交并经PR85同步远端main；最终合并回执在PR与本地执行状态记录。

## Deployment coordination

本次用户直接指定当前聊天01a13320-dbf9-7c03-b7f3-37e30d15de48执行101 Host安装入网，作为该目标专用操作owner；主干既定桌面部署owner仅覆盖macOS updater/安装，本任务不接管其窗口、不操作日常Mac/140后端或其发布目标。执行前须核对101原owner窗口及Host无活跃任务。已授权向既有网络聊天协调，无新权限/付费模型调用。仅复用已有网络身份/账号及服务原权限，不重设加密身份。

## Completed

源码参考main5d6a62dd，既有Host current=/opt/moxbot-host-test/releases/20261014193216-83e48946bad9，connector current83e48946bad9f31f1aa903a6a58b794acaf9a354。两套myagents旧服务保留。MoX本体active，connector failed/ACCOUNT_SESSION_EXPIRED。密钥仅使用受控附件，已限制0600，原文不回显/入Git。

## Verification

实际原账号登录/auth-wait成功，run正确拒绝旧管理绑定后明确renew-management返回renewed，run ready；重启后PID1921932 ready，Node1921064保持。原principal ea1e144e-a432-48c0-bf5a-cf29d3da3b56、network7b4e69be-f3ef-439a-af6f-5d0acc2b9820，key fingerprint/generation一致，云joined1/presence ready/catalog epoch同connection epoch。11个非秘密/密封配置与unit hash一致，设备私钥sealed hash一致。细节`dev-docs/host101-network-recovery-20261016.md`，私有root备份/root/moxbot-host101-recovery-20261016T141329。源代码未改，不新增模拟测试；实际行为验证已通过。auth URL/token/key不写入Git。


## Blockers and unknowns

安装/恢复入网已完成。主干交付待PR85最终CI/回执。独立peer已复核SSH状态、140:443 ESTAB、IPC及hash保全；真实桌面Bots Ready与authenticated GET /v1/devices未操作，云metadata实际source行不能冒称UI通过。当前云会话固定24小时，本次expiresAt1792217654（北京时间2026-10-17 14:14:14）；未更改TTL或实现自动续期，后续到期需正式再登录。模型执行/调用与cloud_models均未启用。


## Next step

主Agent按PR85最终head检查CI和remote main包含恢复记录；实际运行仍旧83e48946安装，不升级程序或日常Mac。会话到期按既有正式登录/显式renew-management恢复；无人值守自动续期是独立后续功能，不通过延长权限或复制token绕过。另一聊天负责其用户提出的真实Bots Ready界面复核，本任务不宣称已操作该页面。
