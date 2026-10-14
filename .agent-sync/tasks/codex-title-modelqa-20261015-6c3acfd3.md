<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/title-modelqa-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->

# TITLE-001 modelqa真实utility验收入口

## Objective

沿用户标题概要需求及统一负责人已获人类授权的MOXBOTS-055-UNIFIED-ACCEPTANCE，补独立modelqa中的真实标题utility验收入口。当前root直接执行，权威仓库 https://github.com/heavenzhang/MoXBots.git / main。互斥文件：src/server/modelqa/title.ts、src/renderer/pages/ModelQaTitle.tsx及相邻focused测试；统一负责人独占profile/guard/title-generator signal/index.ts/main.tsx/构建与发布。不会领取日常GUI、调用普通turn或改用户模型配置。

## Acceptance criteria

- [x] 独立worktree/base/仓库核实，root已确认接口与文件所有权。
- [ ] 生产404，仅modelqa处理/api/modelqa/title，GET只安全授权metadata。
- [ ] POST固定合成fixture+显式授权providerId/modelId/requestId，无任意正文/URL/凭据/runtime。
- [ ] 同pathname DELETE精确取消；单活跃operation、AbortController传到底层真实generateTitle。
- [ ] profile自有QA标题receipt持久化/重读，取消或失败不写伪成功；明确不替代普通Session自动标题链路。
- [ ] 模拟关键权限/取消/并发/错误与UI交互；整合真实guard依赖后typecheck/build/CI。
- [ ] 独立真实modelqa原生utility生成概要与持久化验收，随后交统一0.5.5。
- [ ] 提交/远端main包含；生产包和真实更新由统一发布负责人验收。

## Completed

FEEDBACK真实原生入口/账号恢复已完成，文档PR51 CI进行中，与此实现分支隔离。Server闭集授权/fixture/UUID操作、精确取消、单活跃operation、隔离receipt及Renderer页面已写入阶段代码，尚未验证。

## Verification

尚未实现或运行真实模型；不以fixture或源码代替真实Provider结果。

## Blockers and unknowns

统一负责人未提交共享profile依赖：src/shared/updaterQa.isModelQaBuild，APP_DATA_DIR_NAME=.moxbot-modelqa，generateTitle第5signal参数以及utility-only admission由其负责。闭集授权config=modelqaTitleUtilities:[{providerId,modelId}]，负责人seed qa-kimi/k3的最小受控配置，钥匙不回显。本任务只取该allowlist对应enabled api/builtin执行Provider和精确catalog模型，不把所有可用凭据当许可。真实环境的app/profile/home/接口及明确窗口交接待其提供。

## Next step

实现互斥模块及focused测试，等待共享依赖提交后整合、主审和CI。终态与取消在Tauri无法中断invoke的条件下通过明确DELETE协议确认，不能把前端放弃结果当后端退出。
