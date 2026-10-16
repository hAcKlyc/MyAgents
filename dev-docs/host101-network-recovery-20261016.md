# MOXBOTS-HOST-101-20261016 · 安装核验与原身份入网恢复

2026-10-16，用户明确要求在101.42.11.29安装Host并配置到MoXBots网络，提供SSH附件。目标已有MoX Host安装，Node正常、网络服务因ACCOUNT_SESSION_EXPIRED失败，故复用原安装恢复，不创建重复Host或覆盖工作区。

## 实际交付

- Ubuntu24.04.4/x86_64，ubuntu SSH+sudo通过；附件只读使用并收紧0600，无原文回显/入Git。
- 实际Node current `/opt/moxbot-host-test/releases/20261014193216-83e48946bad9`，connector current `/opt/moxbot-host-network-test/releases/83e48946bad9f31f1aa903a6a58b794acaf9a354`，均未切换。执行binary SHA256 `ffaa6e081a93c29cbcde5310e365e154f0ab238e762090c3cb54e93b69011247`；不是本轮main编译制品，旧安装source标签不替代本轮main状态。
- 原设备ID `cc8fc885-529b-43e9-8a58-ee7c5f2a4c58`，principal `ea1e144e-a432-48c0-bf5a-cf29d3da3b56`，network `7b4e69be-f3ef-439a-af6f-5d0acc2b9820`；设备key generation1，public fingerprint `CDBiHmYyPTkGY39XvppKN4GYy2BpCiu56pWhgcoDObM`。
- 通过既有network-control与受控QA账号正式PKCE浏览器登录/auth-wait，run正确拒绝过期管理绑定；明确同principal `renew-management` 返回renewed后run成功。没有删除pin/context、读取私钥/手工复制token、重建账号或新join。
- network ready/errorCode null，Node doctor agentNet ready。连接服务受控重启PID1920970→1921932自动恢复，Node1921064；两unit active且enabled。management.sock双方ESTAB、connector到140:443 ESTAB经独立网络聊天复核。
- Host/config/provider credential/KEK/units11项hash保持，原sealed私钥hash保持；settings revision6/model k3/workspace/executionAuthorized false不变，无activeSession、无模型调用、cloud_models不变。旧myagents服务PID3022083/3304540保持。

## 云端在线与证据边界

只读查询140实际DeviceStore/MetadataStore的目标行，joined=1、presence=ready、catalog_seq1且catalog_epoch=connection_epoch；相同device/principal/network/public fingerprint/generation与Host对应。`GET /v1/devices`在network_http读取同一MetadataStore.list_devices，Bots Ready投影来自该目录。

这证明实际服务端目录source在线；没有为验收新建账号设备或操作日常Mac，也没有完成authenticated HTTP目录完整分页或native Bots Ready界面。不得将source行和本地ready替换为已完成UI验收。另一聊天可在其既有授权的隔离客户端补只读真实界面验收。

## 备份、回退与权限

恢复前确认activeSession null、connector PID0，使用原统一安装锁串行；root0700备份 `/root/moxbot-host101-recovery-20261016T141329`含原identity/config/encrypted state/unit及before.json hashes。恢复仅更新正式登录与其管理绑定，以及受控服务启动/重启；程序路径、unit、模型权限和原私钥均不变。owned-policy-context因登录binding变更合法更新，不计入字节不变声明。

如恢复异常：先检查任务空闲并取得同目标维护锁；停止connector、保留当前加密state/receipt及日志，用备份核对identity/config/unit。不要以恢复备份中的已过期登录状态冒充恢复连接；账号恢复使用正式auth-start/wait/renew-management流程。无需二进制回滚，因为没有升级。正常完成后窗口释放，无其他目标写入。

## 真实使用限制

当前云登录会话TTL86400秒，实际本次createdAt1792131254、expiresAt1792217654，即北京时间2026-10-17 14:14:14到期。开机自启/进程重启不会延长云登录会话；本任务没有更改服务端TTL或实现自动续期，到期仍需正式重新登录。真实模型执行仍未授权/验证，本次只恢复Host入网。

## 协调、验证与记录

用户在两个聊天提出同目标；网络聊天中的人类明确选择当前聊天为唯一执行方、网络聊天只读验收。当前操作owner01a13320-dbf9-7c03-b7f3-37e30d15de48，独立只读peer01a12b99-7b38-78b1-831f-9c60257d386a。既定桌面部署owner目标不变，未碰日常Mac、140配置/后端或模型权限。

本轮无产品代码改动；不新增模拟测试替代真实验收。系统/原安装/真实PKCE/启动/重启/保全通过。最初run的管理绑定拒绝已通过正式续接解决；首次保全脚本误将必需变化的owned-policy-context计为不变量，校正验收范围后其余hash复验通过，没有回退或放松身份/权限条件。

私有机器可读证据位于项目pointer `output/host101-network-20261016`：host-verification.json、cloud-directory-source.json、restore-result.json。auth URL与token未保存，SSH密钥不提交；root备份不复制到Git。分支任务记录 `.agent-sync/tasks/codex-host-101-network-20261016-810cf816.md`，Git PR85仅文档交付，最终remote main回执与CI另核。

执行选择：当前primary串行，零新subagent；采用ai-yaoren-local纯内置模式，没有外部模型或付费调用。复用已有网络聊天做只读独立核验，精确模型/effort及总tokens/成本未知，未升级模型；两个具体诊断/验证修正见上文，不能以之估算总成本。分工收益为避免双登录/重启；下次先核对同目标活跃owner并检查显式管理绑定续接要求，再启动登录。
