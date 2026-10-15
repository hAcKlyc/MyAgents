# MOXBOTS-UNIFIED-055-DOWNLOAD-20261015 acceptance

The existing [IP download page](https://140.143.183.232/download/) now offers the signed and Apple-notarized MoXBots0.5.5 macOS Apple Silicon ZIP. Public archive and real-page acceptance passed; required CI and canonical-main integration are tracked by this task PR and its final merge receipt. This is a download-channel update, with no native installation or Host business acceptance claimed.

## Archive identity

Frozen source: `52bf61602522fb28715edf620d98ad8e3deee842`. The [immutable manual prerelease](https://github.com/heavenzhang/MoXBots/releases/tag/moxbots-trial-0.5.5-52bf6160) tag resolves to that source, without rebuilding later0.5.6 main. ZIP size344623193 bytes; SHA256 `b2bf83f464e7311869eb31a51db5427d67b7baf9099b6ab91de9672f53f8f4be`. Both GitHub asset digests/sizes matched before publishing. Anonymous normal-TLS/H2 full GET completed with curl exit0, exact size/SHA and all14830 ZIP entries CRC checked, no Range/auth/cookies. See [raw readback receipt](moxbots-055-download-validation/public-zip-readback.json). Local ZIP/CRC and formal App signature, notary ticket and Gatekeeper offline checks passed earlier; no archive or App was executed.

The updater owner's original Linux full HTTPS GET, actual unchanged stat and sha256sum stdout, matching update signature, stable055 CAS and055/054 rollback preservation were verified before this manual release. The owner subsequently published056 and explicitly handed back the website window. This task did not modify or downgrade stable, updater archives, Nginx/TLS/auth/Host or any client.

## Website publication and real page

Fresh pointer/HTML captured after the056 handoff matched the previous054 page. Under the four original nonblocking maintenance locks, the script copied the current release, backed up metadata and created an ownership-checked rollback, then atomically switched only these changed files:

- `download/index.html` SHA `d16765a5fe0cb1c58a1eb649a4bc0ec3a8522cb6ca800519a760953c570085b4` (manifest reference only).
- `download/releases.e9d3e01adbd5.json` SHA `e9d3e01adbd57ef83eb24f42bb4f16792175f72debcc9b3e5f7136d80f15ca62`.

Inventory proved every other website file unchanged, including old hashed manifests. Nginx configuration and cloud PID remained unchanged, with no reload. Private server backup and rollback: `/root/moxbots-download-055-4dac206b`. Rollback checks current pointer ownership and acquires the same locks; do not overwrite a later publication.

Real anonymous browser acceptance at1440x960 and390x844 passed version,344.6MB label, download/source/release-notes links, signature/notary status, SHA, details interaction, no pageerror or mobile horizontal overflow. Primary viewed both final screenshots. Thirteen strictHTTPS route checks passed: home, download, slash308, old/new hashed manifests and JS MIME/hash, health, admin, feedback, unknown/private404 and current updater stable. Baseline comparisons prove routes and current056 stable unchanged by this website update. Evidence: [structured acceptance](moxbots-055-download-validation/acceptance.json), [browser receipt](moxbots-055-download-validation/final-browser.json), [desktop](moxbots-055-download-validation/final-desktop.png), [mobile](moxbots-055-download-validation/final-mobile.png).

## Boundaries and next step

Daily MoXBots/MyAgents were not launched, stopped, installed, modified or automated; no profile/Keychain access, model calls or Host writes. Native installation, Mac/H2 full updater download and full Host business acceptance are separate056 work. Bots Ready source changes belong to056, not this frozen055 ZIP. Zero new workers/external models; existing publisher coordination and primary real-page review were sufficient. Cost not measured.

Finish required CI, merge the metadata task into currentmain and verify remote ancestry/tree plus live HTML/JSON correspondence, then write the final PR/private receipt and pause only `moxbots-0-5-5-2`. The original055 artifact source remains52bf regardless of metadata-main version.
