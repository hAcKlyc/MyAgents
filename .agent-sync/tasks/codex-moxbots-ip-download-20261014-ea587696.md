<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbots-ip-download-20261014 -->
<!-- git-project-sync-task:base=da4ed114275fc73b1aa9bb0f911c95259beb0a6b -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# MOXBOTS-IP-DOWNLOAD-20261014

Repository: https://github.com/heavenzhang/MoXBots.git
Branch: codex/moxbots-ip-download-20261014
Base: da4ed114275fc73b1aa9bb0f911c95259beb0a6b
Status: in-progress

## Objective

Continue the explicitly public trial delivery through the user's chosen IP website140.143.183.232. Root owns source, deployment and acceptance; this low-impact metadata-only step has no new workers or external model calls. Preserve existing website design, backend routes/TLS, credentials, updater and Host scope.

## Acceptance criteria

- [x] Verify actual Nginx/static ownership: current website sourcea5cb41f0; /admin,/auth,/dex,/api,/execution and updater are distinct existing routes.
- [x] Verify accepted signed27d6ed8c macOS package and GitHub full asset346343830bytes/SHA256416bad4edaa83c210f7e5c63ef2e79481198d862a61b9e9a5a9ecd9dcc022d78.
- [x] Store versioned public trial metadata in canonical MoXBots Git source; old Sites source remains an immutable static build input.
- [ ] Reviewed CI/main delivery and immutable static overlay/atomic pointer switch with rollback.
- [ ] Actual IP download version/link, MIME/hash and backend-route regression.

## Completed

Parent task real29 configuration/disabled-Agent creation and client+Host restart persistence passed. Combined27 package is installed/actually read back; final parent PR14 documentation CI is pending. User corrected the delivery target to the existing IP website, making the old Sites404 irrelevant to this self-hosted publication. Current140 cloudPID1021478 remains untouched.

## Verification

Only download metadata changes here; UI layout and JS remain accepted websitea5cb41f0. Exact JSON schema and existing download-script allowlist will be checked before deployment. Canonical package source27d6ed8cb405f2ccdc905798611df218d18b4caf; signed/extracted ZIP and immutable GitHub digest match. No new binary installation or app-data restore.

## Blockers and unknowns

Parent PR14 final CI and this step's source/main/deployment gates are open. Current Sites connector uses another account, but it is not used for the IP publication and no account switch/rebinding is attempted. Whole authenticated-browser download remains separate from digest/size verification.

## Next step

Commit/push this metadata checkpoint, validate the small overlay, synchronize latest main after parent integration, then publish/deploy under existing locks and verify the real IP download UI and backend routes.
