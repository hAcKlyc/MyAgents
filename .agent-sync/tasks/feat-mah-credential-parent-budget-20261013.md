# MAH-CREDENTIAL-PARENT-BUDGET-20261013

Repository: https://github.com/heavenzhang/MoXBots
Branch: feat/mah-credential-parent-budget-20261013
Owner: current primary agent; prior task-scoped native worker and chat coordination permissions remain in force. No external platform dispatch.

## Current continuation

2026-10-14 更新：用户明确要求安装并把同包放到官网；仅 5f1a8feb 获本次授权，84fd35f8 未安装或运行。5f 已从 a838 直接备份更新，严格签名与19组资源复核，真实启动成功，内置 Sidecar 来源5f且与构建字节一致。七项 exact-source CI 已通过。旧应用及数据完整备份，原 MyAgents 未改动。

官网 https://moxbot.mailxf.chatgpt.site/download/ 已公开，Sites版本7/source7da419c57642daaf5324cbd35593b77597797b41。下载为固定5f源码的公开试用预发布，Developer ID签名但未公证；ZIP346377153字节，SHA256 e26a8e9a48a9083fe4283c0c6a0538dfd2dd639922a04326f718ff67fd7e220c。IAB实际点击后文件完整落盘并独立核验大小/哈希；官网首页/下载页/manifest及发行页匿名HTTP200。冗余CLI全量下载停止，不算完成证据。发行说明如实保留未验收项。

看板独立owner报告真实任务todo→running→verifying→UI确认done及CLI持久化读回通过，受控user任务已可恢复归档，未调用模型；超窄抽屉未测。root接回窗口后观察云会话 OWNED_SESSION_INVALID，未反复发起钥匙串授权；两次用户操作冲突后停止UI。尚未完成新包凭据迁移、迁移后冷启动、不同构建免提示和远程模型配置/创建Agent。PR14仍草稿，未合入main。下一步：在用户不操作窗口时诊断失效会话，沿产品路径重新认证同一既有账号；遇系统权限/证书提示由用户亲自处理；随后完成Host真实路径、主干交付，不能把本次公开试用当全部验收完成。

非秘密证据：`MoxBot/output/download-page-release/` 的 publication-receipt.json、browser-download-verification.json、anonymous-website-verification.json、public-download-page.png；私有安装及回滚回执留在原QA目录，不纳入Git。官网源码由Sites独立仓库helper提交推送，不属于本Git主干。

## Earlier progress

Goal: finish actual desktop credential migration and prompt-free restart/update recovery, then remote Linux Host configuration and disabled Agent creation with the existing test identity. Keep original MyAgents and all original encrypted credentials/device identity. No model key or paid inference is part of this acceptance.

- [x] Frozen foundation/sidebar candidate a8 preserved; native sidebar independent acceptance and cleanup done.
- [x] Failure evidence retained: actual old account and key validated, no ledger commit; partial OS entry status unknown.
- [x] Controlled synthetic missing/write/cold/slot-ledger diagnostics and exact own-record cleanup; first slot runner lost stdout, do not infer its error cause.
- [x] Parent-only policy bae611a0 with verified input snapshots; original reader binary/manifest/source closure unchanged.
- [x] Parent41 and packaging13 tests, strict parent Clippy, default/MoX production checks, root AgentNet148 after correcting local Apple Swift search paths.
- [x] Latest accepted main cf741f integrated at 4a513ec7 with Host config, sidebar and session recovery intact.
- [ ] Combined checks, full signed package/extraction/provenance and precise software approval.
- [ ] Actual migration, native cold start and different-build update without repeated OS authorization.
- [ ] Server maintenance owner releases window; paired config/credential backup and matching Node/native Host version checked before writes.
- [ ] Actual remote model configuration and disabled Agent create/persist/readback; old sessions/workspaces preserved.
- [ ] PR14 native gate and exact accepted remote-main/source/runtime delivery.

The parent budget is 30 seconds for background transport and 180 for authorization. Parent signature preflight remains synchronously noninterruptible; this is not a hard total latency guarantee. Diagnostics use closed labels, durations and typed result codes only. The change is a resilience candidate, not a proven root-cause fix.

Detailed checklist: specs/tech_docs/MAH-CREDENTIAL-PARENT-BUDGET-20261013.md. Private build/runtime/diagnostic receipts remain outside Git in the existing task QA directory. No credentials, account identity, temporary authorization links or raw logs belong in this record.

Current integration: accepted main 863f4b40 includes title generation and cf741f Host configuration. Windows CI caught a macOS-only parent dev dependency entering its build; both parent dependencies are now target-scoped to macOS. Raw source fingerprints remain enforced. macOS graph includes parent; Windows/Linux graphs exclude it. Installed a8 Shell identity was verified, but installed Node server currently stamps 506be6de/dirty; this invalidates any claim of unified source provenance for that installation. The new package gate must independently check server identity, all freshly built bundles, extraction and installed resources. Native migration still failed after old credential validation; no automatic retry.
