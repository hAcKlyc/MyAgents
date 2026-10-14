# MAH-CREDENTIAL-PUBLISHER-ROUTES-20261014

Repository: https://github.com/heavenzhang/MoXBots. Current branch: feat/mah-credential-parent-budget-20261013, integrated into draft PR14 feat/mah-management-device-pairs. Root owns integration, artifact creation, installation, native acceptance and main delivery. Do not rebuild frozen a838 from a later documentation HEAD.

## Latest installation and public trial delivery

2026-10-14 更新：用户明确要求安装并把同包放到官网；仅 5f1a8feb 获本次授权，84fd35f8 未安装或运行。5f 已从 a838 直接备份更新，严格签名与19组资源复核，真实启动成功，内置 Sidecar 来源5f且与构建字节一致。七项 exact-source CI 已通过。旧应用及数据完整备份，原 MyAgents 未改动。

官网 https://moxbot.mailxf.chatgpt.site/download/ 已公开，Sites版本7/source7da419c57642daaf5324cbd35593b77597797b41。下载为固定5f源码的公开试用预发布，Developer ID签名但未公证；ZIP346377153字节，SHA256 e26a8e9a48a9083fe4283c0c6a0538dfd2dd639922a04326f718ff67fd7e220c。IAB实际点击后文件完整落盘并独立核验大小/哈希；官网首页/下载页/manifest及发行页匿名HTTP200。冗余CLI全量下载停止，不算完成证据。发行说明如实保留未验收项。

看板独立owner报告真实任务todo→running→verifying→UI确认done及CLI持久化读回通过，受控user任务已可恢复归档，未调用模型；超窄抽屉未测。root接回窗口后观察云会话 OWNED_SESSION_INVALID，未反复发起钥匙串授权；两次用户操作冲突后停止UI。尚未完成新包凭据迁移、迁移后冷启动、不同构建免提示和远程模型配置/创建Agent。PR14仍草稿，未合入main。下一步：在用户不操作窗口时诊断失效会话，沿产品路径重新认证同一既有账号；遇系统权限/证书提示由用户亲自处理；随后完成Host真实路径、主干交付，不能把本次公开试用当全部验收完成。

非秘密证据：`MoxBot/output/download-page-release/` 的 publication-receipt.json、browser-download-verification.json、anonymous-website-verification.json、public-download-page.png；私有安装及回滚回执留在原QA目录，不纳入Git。官网源码由Sites独立仓库helper提交推送，不属于本Git主干。

## Scope and earlier result

User approved a838 installation; App/data backups and actual installed sidecar source verification completed. Explicit old session/key reads succeeded; identity target save returned authorizationRequired and no route was committed. No automatic retry or password collection. Original MyAgents stays running.

The repair separates physical storage by the closed publisher family while preserving logical scope IDs and immutable reader/protocol inputs. Explicit migration holds the route lock across source authorization, validation, target write/readback and atomic switch. Missing/deleted selected records cannot fall back; fresh authentication is distinct from restore. Non-MoX storage behavior remains unchanged.

- [x] Diagnose actual installed candidate and stop failed automatic retries.
- [x] Implement closed reader → compile-time writer family mapping; reader packaging 17 checks pass.
- [x] Independent review: address same-key save idempotence and source reread risk; identify final expiry fence and behavior fixture failures.
- [x] Source-exact temporary-ledger tests 25 per family; primary native slots25/owned15/identity2 passed with unchanged source hashes; final review clear. Actual profile/feature production compile passed; packaging17 passed.
- [x] Implementation submitted and pushed at 84fd35f8cfb35c1d3de19268ef8ae64021f474a7, preserving main d86f7505 and project board.
- [x] Exact 5f source seven CI checks and both frozen artifact signature/resources/archive checks; runtime gates remain separate.
- [x] Two signed builds with distinct CodeDirectories verified. Only 5f received the later install/publication instruction and was installed; 84fd remains unrun.
- [ ] Actual desktop/Linux remote config and disabled Agent create/persist/readback; no paid inference.
- [ ] PR14 main delivery and installed artifact/source correspondence.
- [x] MOXBOTS-DOWNLOAD-001: the user explicitly requested installation/publication of the fixed 5f trial. Same ZIP published, public website v7 deployed and actual downloaded ZIP size/hash verified; no claim that all product acceptance passed.

Website source is a separate Sites checkout. Primary IAB page/fixture behavior and independent visual/content review passed; actual installer remains pending. Cloud login owner has a separate maintenance window; do not concurrently deploy its services. Private backup/runtime/credential evidence stays outside Git.

Details: `specs/tech_docs/credential_publisher_routes.md`. Follow that checklist and current runtime receipts rather than interpreting old pending approval as still unanswered.

First full candidate is frozen at 84fd35f8 in a detached worktree. A second full build follows the handoff update and main1ece497d cloud-login synchronization, with unchanged desktop/Host functional source; compare both signed CodeDirectories before requesting one concrete approval for the migration/cold-start/update sequence. Native tests and source-exact ledgers are passing, while installed migration, both signed artifacts and public release remain pending.
