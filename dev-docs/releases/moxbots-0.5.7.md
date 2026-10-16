# MoXBots 0.5.7 入网恢复正式修复版

任务`MOXBOTS-057-NETWORK-RELEASE-20261016`，当前`preparing`；唯一发布聊天和直接人类授权见canonical `.agent-sync/plan.md`。基线main `b1001048bc5877ccaae0ab7af137cd94b2ddbde2`，正式构建SHA在版本与协调PR通过后固定，不自动跟随后来main。已发布0.5.6/a81与055不可变。

## 本批次

- PR78/79/81：按Owned账号/网络隔离device identity，按实际登录连接选中账号；显式第二轮同principal恢复旧登记设备，保持服务端device-bound token。临时登录到registry最终提交才有效；binding使用不可变凭据槽与原子配置，取消/晚结果/未知提交保留旧身份与可能已提交token。
- 已在当前主干的057队列：Project Context和Provider隔离证据（PR68/71）、Host引导/兼容（PR69/72，仅随桌面源码，不部署远端Host）、默认关闭的主备模型（PR73）、缩放输入框横滚动修复（PR76）、结果/时间/质量参考（PR80）。相关来源任务/真实原生边界不因打包自动关闭。
- 本任务只推进统一版本、正式制品和发行记录，不新增云服务、Host部署、网络权限或公网路径。官网manual ZIP由其独立授权lane决定，不能因本次updater发行自动覆盖网站。

## To Do

- [ ] 版本元数据/七CI/main及冻结源码。
- [ ] 正式native构建、自有Reader/key/endpoint连续、Developer ID、公证票据/独立验包。
- [ ] 056可验签回滚及同锁不可变上传、完整公网字节与签名独审、受审CAS发布和公开复验。
- [ ] 当前配置/凭据槽私有备份及可执行回退；fresh空闲/手动解锁后启用，不主动停止任务。
- [ ] 真实session、独立identity/登记、membership、relay ready、目录及已授权可调用路径；同账号重登/旧身份保留。
- [ ] 最终交付main/制品/服务器/安装/真实业务分别报告并保存接续。

## 门禁与回退

不得用旧PID/进程端口或Task行状态证明当前generation空闲，也不得为只读观测提前freeze/ensure/create/启用External Calls。当前修复源码与CI/合成组件通过不等于真实网络恢复；实际联调需要用户已选的新账号和现有授权scope，不扩大模型/Host或调用付费模型造状态。

新记录含sessionBound；回退旧客户端时恢复启用前兼容配置，同时保留迁移后的业务数据与新旧凭据槽。严禁恢复旧业务数据库或删除旧身份。stable回退只是停止继续分发，不会自动降级已启用客户端。

正式构建不能用DOCS_RS/ScreenCaptureKit stub等跳过native能力，不能修改系统CLT。已验证任务私有SwiftPM兼容wrapper仍需复验当前接口和实际完整build结果；若失败，保留证据并继续独立准备，原生门禁不绕过。

私有证据与产物在项目指针`work/release-057-20261016/owner/`及未来`output/updater-057-20261016/`；凭据、业务数据与原生包不入Git。

## 候选验收修正（2026-10-16）

PR82/候选aeaebda2已通过七CI并合入main2e9fef6c（与候选同tree）；完整native构建及Developer ID独立内容/签名审计通过，但均不代表公证或实际入网通过。该未公证候选已保留，不能发行。

独立UI在正式支持最小窗口660×400发现恢复身份弹窗高556.56、顶部和取消按钮被裁、无可用滚动。此修正版仅给JoinNetworkDialog限高到视口减32px、开启内部滚动及边距；不改变账号/身份/网络/取消执行协议。使用同一实际组件与私有合成fixture复验，另建精确新SHA的候选包；旧候选hash不复用。

用户明确“稍后解锁，先继续准备候选包”。未公证/未发布/未安装/未启用/未真实入网验收；不再重复锁屏探测。既有moxbots-notary暂不可读取，手动解锁后先重试原配置。
