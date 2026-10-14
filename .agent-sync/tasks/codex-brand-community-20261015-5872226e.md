<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/brand-community-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-BRAND-COMMUNITY-001 — independent brand and owned community

## Objective

MOXBOTS-BRAND-COMMUNITY-001：清理 MoXBots 用户可见的原项目品牌与介绍，将协作社区接入现有 owned 云服务、同一 AuthStore 与管理后台。保留原项目许可/版权及内部兼容标识，不迁移原 Space 用户数据。

## Acceptance criteria / To Do

- [x] 仓库/主干/并行任务核实；隔离分支；start gate。
- [ ] 桌面关于页、链接、主题名、导出与诊断文案清理；中文/英文验证。
- [ ] 同账号社区话题、回复、分类、管理员置顶/锁定/隐藏；持久化、鉴权、幂等与CAS。
- [ ] 桌面社区入口只打开配置的 owned issuer；不依赖旧 Space capability。
- [ ] 构建、相称回归、独立 UI 真实渲染/交互/适配审阅。
- [ ] 提交、CI、合入并核实远端 main。
- [ ] 核实活动发布任务和维护锁、备份/回滚后云服务发布与真实账号路径复验。
- [ ] 桌面打包发布与原生验收；与现有统一安装 owner 串行，未完成不得称已发布。

## Ownership

主Agent：桌面品牌、接口合同、集成、验收、main及发布。community_backend：仅 Rust 社区服务与测试/COMMUNITY.md。community_web：仅 community-web 和现有 admin-web。请求模型均 gpt-6.1-sol/high；运行标识与用量未暴露。UI reviewer稍后按候选进行独立验收。当前不调用外部模型。

## Decisions

社区为同云账号可见的交流区；话题三类（讨论/问答/实践），公告仅管理员发布；不自动发布测试内容。普通成员不获得管理权限。云端导航只取 networkConnections().ownedServiceUrl 并严格验证 HTTPS origin。新服务保留持久幂等回执，满额拒绝新增而不逐出回执。未知结果重试保留原 mutation，不自动重放。现有反馈保持私有，不转为社区公开内容。

## Verification

Base c7bab28594a03dfba7167200a90ae73ad0a6b5aa；start/task-init gate passed。后续证据将更新本记录及 dev-docs/brand-community-*。

## Next action

完成桌面代码与社区合同集成，运行针对性测试并交独立 UI 审阅。生产/安装验收保持开放。
