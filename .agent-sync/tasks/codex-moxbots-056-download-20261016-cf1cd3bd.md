<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-056-download-20261016 -->
<!-- git-project-sync-task:base=1c13a06877846da03f9a1c3d9f00dac4e10e7828 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# MOXBOTS-DOWNLOAD-056-20261016

## Objective and authority

用户直接要求官网下载包更新0.5.6、包含Bots Ready，完整校验后才上架，不动日常客户端。当前聊天01a12b99-7b38-78b1-831f-9c60257d386a继续既有人类明确授权的manual ZIP/IP官网下载lane；唯一正式App/updater发布聊天01a12bc2-907a-7702-b6dd-788225c5dfe4继续拥有签名、公证和updates。已联系其协调冲突窗口，不把其消息当新增授权。本任务不重打/重签0.5.6、不写updates、不操作auth/Host/GUI/profile/Keychain、日常客户端或模型。

## Acceptance criteria

- [x] canonical Git https://github.com/heavenzhang/MoXBots.git、clean独立任务分支、base1c13a068及start/task-init通过；保留已完成055分支。
- [x] frozen正式source a81d2509fa92968ddaaed63416a2478d21b8a373包含PR63/Bots Ready，main发行记录与ZIP344739590B/SHA f9b31491e5bf15b3073c41cd483833ae9c58b99c246b099e3c8f1256d493bdb4已核；精确本地制品仍需独立验收。
- [x] 正式ZIP完整SHA/CRC、独立解出、Info版本/identifier、主程序SHA、签名/Apple票据/Gatekeeper、实际打包renderer中Bots Ready/Bots 网络/Your bots are ready.验证。
- [x] 核现有GitHub056 asset，复用精确不可变包；缺失时draft上传已验收ZIP+SHA256SUMS，上传digest/size通过才公开；完整匿名HTTPS GET、SHA/CRC及source tag核验通过才官网上架，不覆盖055。
- [x] 正式owner确认无冲突发布；重新采live pointer/HTML，现有4非阻塞锁、backup/ownership rollback、CAS仅新hashed JSON+HTML引用，保留设计/旧manifest/其他路由，无reload及其他服务变更。
- [x] 主Agent真实匿名1440x960/390x844页面版本/344.7MB/链接/源码/发行说明/签名/SHA/details/no errors或横溢，截图实际复看、相称路由回归。
- [ ] 只提交task/website metadata/验收资料，CI/PR附加、同步最新main/正常合入并核remote ancestry/tree/live metadata完全对应；正式ZIP仍a81而非后续main重建。

## Completed

正式056原包/公开完整GET和官网已接受。required CI/main交付待本任务PR；所有旧包保留。独立验证后已public release，不因已有正式TAR/updater通过就冒称manual ZIP完整网络验收；不重复另一owner的大传输，不持锁等待上传。私有证据project pointer output/website-download-056-20261016；旧055证据只作流程模板，不照搬结果或硬编码部署脚本。

单Agent串行：可复用既有流程，零新worker避免争抢发布资源，主Agent负责UI质量和整体验收。代码实现/独立制品验证/真实公开页面/main/原生安装分别追踪，原生安装和Host真实业务不在本任务范围。不调用外部原因：明确采用ai-yaoren-local纯内置模式；未声称切换模型/effort，用量与费用未计量。

## Verification

源a81包含PR63已核。正式ZIP size/SHA/CRC已实测，包内无assets目录（Tauri内嵌前端），首次文件路径假设断言失败，尚未把该项算通过；按真实嵌入格式核验。首个handoff因task scaffold/header模板漏改被gate拒绝，已补齐规定章节并重新走正常提交，不放宽gate。

## Blockers and unknowns

证据dev-docs/moxbots-056-download-acceptance.md及同名前缀validation/。公开全GET/SHA/CRC、四锁两文件CAS、主Agent真实桌面/手机截图复看与13路由PASS。主干交付待CI。本地完整校验已PASS：344739590B/SHA f9b31491、14830 CRC；独立解包0.5.6/com.moxbot.app、binary98cddba4，Developer ID/strict签名/票据/Gatekeeper均通过。实际Mach-O内完整Brotli资源匹配并解压核出三条Bots Ready文案及页面i18n引用；未启动App。公开完整GET及官网验证均通过。

## Next step

required CI通过后核最新main，正常match-head合入，核remote ancestry/tree/live对应并更新最终PR回执。
