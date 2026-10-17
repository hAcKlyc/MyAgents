# Context recovery release handoff

Task MOXBOTS-CONTEXT-RECOVERY-20261017; PR https://github.com/heavenzhang/MoXBots/pull/96. Feature source commits e71cd994 and a2e086b0; freeze the latest CI-accepted canonical main only after normal integration. These abbreviated anchors are navigation aids; use full verified SHAs for publication receipts.

Existing sole release owner remains `01a12bc2-907a-7702-b6dd-788225c5dfe4` (MoxBots桌面端统一打包负责人). User authorized fixing/validation/main/release, but this development chat has not yet sent a cross-chat message or started another publisher. Existing frozen0.5.8 source/tag12449e47 and its immutable archives must stay untouched; select the next unused version through the existing release process.

## Candidate behavior and acceptance

- Third-party API operational compaction defaults200K, with explicit per-model contextCompactionWindow override; UI distinguishes declared capacity. Managed/OAuth/official authority unchanged.
- Explicit native compact failure becomes a failed Product turn even when SDK outer result says success. Unrecoverable context/invalid request pauses the same Goal with a durable reason, rather than ten blind retries.
- Single inference-only repair archives the original request, preserves instructions/tool pairs and never rewinds/requeues business turns.
- Exact-action gate survives native compaction/new Query. New mutating calls write uncertain reservations before execution and commit receipts after success; missing/corrupt/unwritable ledgers fail closed.
- CI includes real SDK manual/auto compact + restart + new-tool-ID duplicate denial (actual counter remains1), and native failed-compact/outer-success regression. See acceptance.md and ../../specs/tech_docs/context_recovery.md. Semantic changed-argument duplicates still need business-system idempotency.

## Release and user-path gates

Use the existing scripts/moxbot-updates/README.md, signing/notarization/Reader authority and release lock. Verify final main source correspondence, signed artifact, own updater signature, immutable artifact hash, real HTTPS distribution, rollback and retained old version. Do not stop active daily tasks. Install/activate only after fresh activity checks, required manual unlock and valid compatibility backup. Archive and ledger evidence is private runtime data; never include it in Git or public artifacts. Do not downgrade recovered business Goals to an old binary lacking these guards and let them auto-resume.

Verify installed model context budget/label and a synthetic real-provider/tool business path with durable receipts; distinguish this from local loopback and from the original payroll business acceptance. Publication and installation/real-provider acceptance are separately reported. No credential, new public endpoint, permission expansion or unrelated service deployment is authorized by this handoff.
