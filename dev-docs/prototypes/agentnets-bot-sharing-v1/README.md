# MoXBots 平台管理员 Bots 管理原型

这是服务端平台管理员视角的 Bots 管理控制台原型，所有账号、Bots、Host、任务、资料和用量均为合成数据。真实共享服务仍待开发；模拟角色和浏览器存储不构成真实认证、隔离或业务持久化。

## 打开方式

直接用浏览器打开本目录 index.html，无需 npm、外部 CDN 或模型。也可从仓库根启动仅回环预览：

```sh
python3 -m http.server 5197 --bind 127.0.0.1 --directory dev-docs/prototypes/agentnets-bot-sharing-v1
```

打开 http://127.0.0.1:5197/ 。端口占用时请选空闲端口，不停止其他任务。不同浏览器或file/HTTP来源的状态独立；使用重置演示恢复本原型数据。

## 管理员体验顺序

1. 进入Bots目录，搜索/筛选不同用户和Host上的Bots，打开客户研究Bot详情。
2. 在共享成员中邀请指定用户，配置角色、资料范围、有效期、额度和审批阈值，查看授权摘要。
3. 从次级“体验用户视角”进入Bots Net模拟，目标账号接受并执行任务；高成本请求等待管理员审批。
4. 返回管理控制台处理审批、编辑授权、暂停共享或撤销成员，再验证次级用户调用结果和用量审计。
5. 切换其他Bot验证配置不串用、资源上限不可突破及离线/空态；查看全局审计，最后重置演示。

## 产品边界

管理员控制台不是个人Bot首页。客户端个人网络协作仍在现有Agent Net入口，后续产品名称规划为Bots Net；本次不改真实客户端、协议或服务。平台管理员与Bot共享管理员不同，纳管权限不自动包含私人会话、凭据和Host OS权限。

规划见 [第一版权限设计](../../../services/agentnet/planning/AGENTNETS-BOT-SHARING-V1.md)、[任务清单](../../../services/agentnet/planning/TODO.md)；设计约定见 [DESIGN-BRIEF.md](DESIGN-BRIEF.md)。旧个人版在archive/仅作方向对照，不是当前方案。

验收记录分别说明视觉、交互、响应式、修复轮次及范围，不以原型通过代表真实共享已发布。

## 管理员生命周期补充

当前新增任务BOT-ADMIN-LIFECYCLE-PROTOTYPE-20261013：目录新建→查看/修改配置→启动/停止→分配所属用户/Host→重配→逻辑删除→回收站恢复。Bot启停与共享暂停分开；分配需部署授权和影响确认，恢复不复活原共享。详细流程见[LIFECYCLE-DESIGN-BRIEF.md](LIFECYCLE-DESIGN-BRIEF.md)，新验收/交付见LIFECYCLE-UI-REVIEW.md与LIFECYCLE-DELIVERY.md。旧DELIVERY.md与INDEPENDENT-UI-REVIEW.md是共享v1历史接受证据，不能作为当前扩展版全部通过的依据。
