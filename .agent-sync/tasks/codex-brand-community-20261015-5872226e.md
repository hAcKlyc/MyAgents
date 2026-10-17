<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/brand-community-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-BRAND-COMMUNITY-001 — independent brand and owned community

## Objective

MOXBOTS-BRAND-COMMUNITY-001：清理 MoXBots 用户可见的原项目品牌与介绍，将协作社区接入现有 owned 云服务、同一 AuthStore 与管理后台。保留原项目许可/版权及内部兼容标识，不迁移原 Space 用户数据。

## Acceptance criteria / To Do

- [x] 仓库/主干/并行任务核实；隔离分支；start gate。
- [x] 桌面关于页、链接、主题名、导出与诊断文案清理；中文/英文验证。
- [x] 同账号社区话题、回复、分类、管理员置顶/锁定/隐藏；持久化、鉴权、幂等与CAS。
- [x] 桌面社区入口只打开配置的 owned issuer；不依赖旧 Space capability。
- [x] 构建、相称回归、独立 UI 真实渲染/交互/适配审阅。
- [x] 提交、CI、合入并核实远端 main。
- [x] 核实活动发布任务和维护锁、备份/回滚后云服务发布与真实账号只读路径复验。
- [ ] 桌面打包发布与原生验收；与现有统一安装 owner 串行，未完成不得称已发布。

## Ownership

主Agent：桌面品牌、接口合同、集成、验收、main及发布。community_backend：仅 Rust 社区服务与测试/COMMUNITY.md。community_web：仅 community-web 和现有 admin-web。请求模型均 gpt-6.1-sol/high；运行标识与用量未暴露。UI reviewer稍后按候选进行独立验收。当前不调用外部模型。

## Decisions

社区为同云账号可见的交流区；话题三类（讨论/问答/实践），公告仅管理员发布；不自动发布测试内容。普通成员不获得管理权限。云端导航只取 networkConnections().ownedServiceUrl 并严格验证 HTTPS origin。新服务保留持久幂等回执，满额拒绝新增而不逐出回执。未知结果重试保留原 mutation，不自动重放。现有反馈保持私有，不转为社区公开内容。

## Verification

Base c7bab28594a03dfba7167200a90ae73ad0a6b5aa；start/task-init gate passed。代码48f458fd已推送并创建PR50。TypeScript、完整lint（含依赖边界/文档链接）、两profile Web构建、品牌/导航/i18n 18项、主题8项、资源投影6项及许可合同通过。独立UI 39/39通过，报告`dev-docs/brand-community-review.md`；后端社区7/反馈9及clippy通过。主Agent亦在内置浏览器使用真实本地HTTP/临时库发布合成话题与回复并核对结果。生产OIDC/原生不由这些证据推断。

## Completed

旧工具市集在MoXBots不再宣传或误跳社区；旧Space资源深链给出不兼容提示，首页仍进入owned社区。2项动态profile DOM和相关品牌回归/独立源审通过。主干afa7d819无冲突集成，20项Host/品牌回归通过。

实现、前述确定性验证与独立39项验收已完成；产品48f458fd和证据29fe738a已同步任务分支。

## Blockers and unknowns

功能已由PR50交远端main b5b9c9c49da3a6a846f35196660abf6fb37557eb；云端发布与真实账号只读路径已复核，详见`dev-docs/brand-community-delivery.md`。源码/制品/运行binary映射已核实，维护hold已释放。生产没有发帖写入；普通成员生产路径没有新增账号验证。完整生产已登录浏览器交互与原生客户端仍未由本任务宣称通过。

用户已授权协调并纳入统一0.5.5，统一负责人已接受且完成本地集成。原生验收、正式打包与安装仍开放，状态保持in-progress；不并行替换日常App。

## Next step

统一负责人继续0.5.5原生About/所属社区/旧资源提示验收，合入最终交付记录并完成签名/公证/安装。若发现本任务缺陷，由本主Agent按复现修复；云服务不重复部署。
