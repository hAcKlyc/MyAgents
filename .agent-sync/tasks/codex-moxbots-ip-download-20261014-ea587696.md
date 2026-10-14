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
- [x] Reviewed exact overlay source426f14eb; locked immutable static deployment, atomic pointer switch and selective rollback receipt saved.
- [ ] Final source checkpoint CI and remote-main merge (integration owner; no additional binary or server mutation).
- [x] Actual IP download27 version/link/checksum/signing,1440x960 and390x844 browser acceptance, HTML/JSON hashes, /health and /admin200 plus unknown/private-path404 regression.

## Current acceptance and daily-app boundary (2026-10-15)

PR14 merged main878ef665 after seven final checks. This branch deliberately incorporated that main; its remaining delta is download metadata and handoff records only. Public ZIP asset640822013 matches local verified size/SHA. Static overlay426f14eb remains an ancestor and exact source of deployed metadata; later commits only synchronize records/main.

Live pointer: releases/a5cb41f0-download-27d6ed8c-426f14eb. Server backup/manifest/selective rollback: /root/moxbot-ip-download-426f14eb. HTML SHA256cb155326c3ad5bda0b27f3b29a35167fd4df5b73187c1bfe86f7963f28318f29; JSON aa1b8b9858ca34195f7258d9c2e8ecc1cdcd0d93b70f270a13c464bb1981c2fc. Existing four maintenance locks were acquired. Nginx config bytes unchanged, no reload, cloudPID1021478 unchanged. Existing design/layout/JS preserved.

Primary owns this small metadata-only UI check; no new workers or external calls. Fresh headless browser, strict HTTPS and no user profile: visible27 download URL, actual expansion of version/checksum details, correct full SHA and unnotarized signing label; screenshots at1440x960/390x844 reviewed, no horizontal overflow/page errors. Evidence: project-pointer output/auth-host-20261014/ip-download/browser-acceptance.json, download-desktop.png, download-mobile.png, external-verification.json and deployment-receipt.json. Full public network ZIP re-download was not completed; local archive/signature/extraction and GitHub digest/size are separate passed evidence.

The user's daily /Applications/MoXBots.app and ~/.moxbot data/credentials are protected. Do not launch/quit/automate/update or borrow this profile for testing. Historical27 acceptance does not assert the current daily installed version. Further native tests require verified independent bundle/single-instance identity, profile/ports and credential-service names; none are needed for this website metadata delivery.

## Completed

Parent task real29 configuration/disabled-Agent creation and client+Host restart persistence passed. Combined27 package is installed/actually read back; final parent PR14 documentation CI is pending. User corrected the delivery target to the existing IP website, making the old Sites404 irrelevant to this self-hosted publication. Current140 cloudPID1021478 remains untouched.

## Verification

Only download metadata changes here; UI layout and JS remain accepted websitea5cb41f0. Exact JSON schema and existing download-script allowlist will be checked before deployment. Canonical package source27d6ed8cb405f2ccdc905798611df218d18b4caf; signed/extracted ZIP and immutable GitHub digest match. No new binary installation or app-data restore.

## Blockers and unknowns

Parent PR14 and IP deployment/actual browser gates are passed. Only this final source checkpoint CI and main integration remain. Current Sites connector uses another account, but it is not used for the IP publication and no account switch/rebinding is attempted. Whole authenticated-browser download remains separate from digest/size verification.

## Next step

Push this final metadata/record checkpoint; wait for required CI, compare latest-main merge tree and merge PR41, verify remote main contains both PR14 and overlay426f14eb. No additional App update, profile access, server restart or Sites account action is needed.
