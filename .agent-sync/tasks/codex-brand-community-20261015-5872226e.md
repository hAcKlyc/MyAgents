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
- [ ] 提交、CI、合入并核实远端 main。
- [ ] 核实活动发布任务和维护锁、备份/回滚后云服务发布与真实账号路径复验。
- [ ] 桌面打包发布与原生验收；与现有统一安装 owner 串行，未完成不得称已发布。

## Ownership

主Agent：桌面品牌、接口合同、集成、验收、main及发布。community_backend：仅 Rust 社区服务与测试/COMMUNITY.md。community_web：仅 community-web 和现有 admin-web。请求模型均 gpt-6.1-sol/high；运行标识与用量未暴露。UI reviewer稍后按候选进行独立验收。当前不调用外部模型。

## Decisions

社区为同云账号可见的交流区；话题三类（讨论/问答/实践），公告仅管理员发布；不自动发布测试内容。普通成员不获得管理权限。云端导航只取 networkConnections().ownedServiceUrl 并严格验证 HTTPS origin。新服务保留持久幂等回执，满额拒绝新增而不逐出回执。未知结果重试保留原 mutation，不自动重放。现有反馈保持私有，不转为社区公开内容。

## Verification

Base c7bab28594a03dfba7167200a90ae73ad0a6b5aa；start/task-init gate passed。代码48f458fd已推送并创建PR50。TypeScript、完整lint（含依赖边界/文档链接）、两profile Web构建、品牌/导航/i18n 18项、主题8项、资源投影6项及许可合同通过。独立UI 39/39通过，报告`dev-docs/brand-community-review.md`；后端社区7/反馈9及clippy通过。主Agent亦在内置浏览器使用真实本地HTTP/临时库发布合成话题与回复并核对结果。生产OIDC/原生不由这些证据推断。

## Completed

实现、前述确定性验证与独立39项验收已完成；产品48f458fd和证据29fe738a已同步任务分支。

## Blockers and unknowns

CI和main合入尚未完成。统一0.5.5负责人已接受纳入，但原生验收/打包尚未执行。用户已明确授权跨聊天协调。云端停服现SIGTERM/5s；remote-session等共享中转可能仍在使用，现暂不发布，须确认维护窗口、有效连接排空和Graceful stop，不强杀。备份/rollback准备中。生产不写测试话题。

## Next step

等待最终CI，合main后比对Linux制品tree再发布。已只读核实线上feedback-d7264a版本、两个维护锁可用、pending执行/活动模型均0、社区库尚不存在；正式停服前需防止新请求进入，确保已有业务排空。跨聊天发消息纳入0.5.5已向用户申请明确授权，未收到不发送；客户端安装保持统一owner串行。
