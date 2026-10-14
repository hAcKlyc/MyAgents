<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/title-modelqa-20261015 -->
<!-- git-project-sync-task:base=c7bab28594a03dfba7167200a90ae73ad0a6b5aa -->
<!-- git-project-sync-task:status=in-progress -->

# TITLE-001 modelqa真实utility验收入口

## Objective

沿用户标题概要需求及统一负责人已获人类授权的MOXBOTS-055-UNIFIED-ACCEPTANCE，补独立modelqa中的真实标题utility验收入口。当前root直接执行，权威仓库 https://github.com/heavenzhang/MoXBots.git / main。互斥文件：src/server/modelqa/title.ts、src/renderer/pages/ModelQaTitle.tsx及相邻focused测试；统一负责人独占profile/guard/title-generator signal/index.ts/main.tsx/构建与发布。不会领取日常GUI、调用普通turn或改用户模型配置。

## Acceptance criteria

- [x] 独立worktree/base/仓库核实，root已确认接口与文件所有权。
- [x] 生产404，仅modelqa处理/api/modelqa/title，GET只安全授权metadata。
- [x] POST固定合成fixture+显式授权providerId/modelId/requestId，无任意正文/URL/凭据/runtime。
- [x] 同pathname DELETE精确取消；单活跃operation、AbortController传到底层真实generateTitle。
- [x] profile自有QA标题receipt持久化/重读，取消或失败不写伪成功；明确不替代普通Session自动标题链路。
- [ ] 模拟关键权限/取消/并发/错误与UI交互；整合真实guard依赖后typecheck/build/CI。
- [ ] 独立真实modelqa原生utility生成概要与持久化验收，随后交统一0.5.5。
- [ ] 提交/远端main包含；生产包和真实更新由统一发布负责人验收。

## Completed

FEEDBACK真实原生入口/账号恢复已完成，文档PR51 CI进行中，与此实现分支隔离。Server闭集授权/fixture/UUID操作、精确取消、单活跃operation、隔离receipt及Renderer页面已写入阶段代码，已通过28实际HTTP/文件IO联调、8真实组件DOM及61原title/context/admission unit；完整typecheck通过。UI首轮原生select被lint拒绝后改既有CustomSelect与主题token，DOM复验通过；测试多余ByRole exact参数被typecheck发现并移除，未改运行断言。

## Verification

28 HTTP/profile文件IO联调、8 DOM、61 title/context/admission unit、完整typecheck、相邻4文件ESLint、测试分类通过。Node初次默认v22被devEngines拒绝，改用已安装Node24.21.0，不降低门禁。依赖边界待最终结果。测试mock实际Provider调用，未运行真实模型；不把这些当真实Provider验收。

## Blockers and unknowns

共享依赖af6c790081efcc1fb21b099bd795aca2b31f4be2已按真实ancestry合入；接口来自src/shared/updaterQa.isModelQaBuild，APP_DATA_DIR_NAME=.moxbot-modelqa，generateTitle第5signal参数以及utility-only admission由其负责。闭集授权config=modelqaTitleUtilities:[{providerId,modelId}]，负责人最终指定moonshot-coding/k3，独占seed最小受控配置，钥匙不回显。本任务只取该allowlist对应enabled api/builtin执行Provider和精确catalog模型，不把所有可用凭据当许可。真实环境的app/profile/home/接口及明确窗口交接待其提供。

## Next step

将此源码候选交统一负责人接线并独立审阅、整合最终依赖和CI。终态与取消在Tauri无法中断invoke的条件下通过明确DELETE协议确认，不能把前端放弃结果当后端退出。
