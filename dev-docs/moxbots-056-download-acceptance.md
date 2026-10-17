# MOXBOTS-DOWNLOAD-056-20261016 acceptance

The [IP download page](https://140.143.183.232/download/) offers the signed and Apple-notarized MoXBots 0.5.6 macOS Apple Silicon ZIP, including Bots Ready. Archive and production-page acceptance passed. Required CI and canonical-main delivery proceed through this task PR; its final merge receipt records the remote main SHA. No client was launched, installed, stopped, or upgraded.

## Exact archive and Bots Ready proof

Frozen official source/tag: `a81d2509fa92968ddaaed63416a2478d21b8a373` / `v0.5.6`. PR63 merge `963c4b51672ff0d904e310d473df4729e2c482d3` is its ancestor. Later model-failover and project-context main changes were not rebuilt into 0.5.6. The [immutable manual prerelease](https://github.com/heavenzhang/MoXBots/releases/tag/moxbots-trial-0.5.6-a81d2509) resolves to the same frozen source.

ZIP `MoxBots-0.5.6-macOS-arm64.zip`: **344739590 bytes**; SHA256 `f9b31491e5bf15b3073c41cd483833ae9c58b99c246b099e3c8f1256d493bdb4`. Independent full ZIP CRC passed all 14830 entries. Independent extraction verified version 0.5.6 / com.moxbot.app, binary SHA `98cddba4fbfe55d7089fac9b765869a662395884c16a83ae47af12c8f4625e75`, strict Developer ID signature (QJ5URBG9AP), stapled Apple ticket, and Gatekeeper Notarized Developer ID. No re-signing or App launch occurred.

Tauri embeds Brotli-compressed frontend resources in the executable. An initial attempt to locate `/assets/*.js` in the ZIP failed because that path is not the production embedding format. The corrected check required each complete compressed asset to exist byte-for-byte inside the independently extracted accepted Mach-O, then decompressed it. It found **Bots Ready**, **Bots 网络**, **Your bots are ready.**, and the actual page's `agentNetwork.pageTitle` / `agentNetwork.welcome` references. Cached build assets alone cannot satisfy binary membership. Proof, byte offsets and compressed/decoded SHA values are in [local archive receipt](moxbots-056-download-validation/local-zip-audit.json); [source ancestry](moxbots-056-download-validation/source-proof.json) is separate. This offline proof does not claim a native GUI journey.

GitHub reported both ZIP/SHA256SUMS exact uploaded size/digests before draft publication. The public anonymous HTTPS full GET then completed with normal certificate validation, curl exit0 / HTTP200 / H2, 344739590 downloaded bytes, exact SHA and 14830 CRC entries, without Range, authentication or cookies. Actual download time30.83s / speed11181612B/s is this transfer only. See [public full-download receipt](moxbots-056-download-validation/public-zip-readback.json), [GitHub assets](moxbots-056-download-validation/github-public.json), and [manual tag](moxbots-056-download-validation/github-tag-verified.json). Public release-notes and source pages also returned normal-TLS200; release notes name Bots Ready and frozen source.

## Website and production regression

After the accepted public ZIP, fresh live pointer/HTML and absence of the updater owner's lease were checked. The four original nonblocking maintenance locks guarded backup, copying the current immutable website release, inventory comparison, ownership-checked rollback and CAS. Only these two files changed:

- `download/releases.98f42775b3e8.json`: SHA `98f42775b3e8ab59a38ec56591bba57a9e6f8dacc3d067e4ce88aa811015c08e`, byte-identical to `services/website/trial-release.json`.
- `download/index.html`: SHA `623bc1a37d5361de04cd0499e7dbd4f6ae47a7d32e377e47ce480d5880ceebaf`, only its manifest reference changed.

All other website files, old manifests, design, Nginx configuration, cloud PID1380996 and current 0.5.6 updater stable remained unchanged. No reload. Private server rollback `/root/moxbots-download-056-98f42775/rollback.py` checks ownership of its pointer and takes the same locks; it must not override a later publisher. [Deployment receipt](moxbots-056-download-validation/website-deployment.json).

Primary-owned real anonymous Chromium acceptance at1440x960 and390x844 checked version0.5.6 · a81d2509, 344.7MB, download/source/notes links, SHA, signed/notarized label, details open/close, no pageerror and no horizontal overflow. Both final screenshots were actually reviewed: [desktop](moxbots-056-download-validation/final-desktop.png), [mobile](moxbots-056-download-validation/final-mobile.png), [browser receipt](moxbots-056-download-validation/final-browser.json). Thirteen normal-TLS route checks passed, covering home/download/slash308, old/new hashed JSON and JS MIME/hash, health/admin/feedback, unknown/private404 and unchanged stable. [Baseline](moxbots-056-download-validation/baseline-routes.json), [final](moxbots-056-download-validation/final-routes.json). The public full ZIP GET separately verifies the download action's target; no browser-triggered duplicate large transfer.

## Scope, execution and final gate

The human explicitly authorized this separate manual GitHub ZIP/IP website lane and repeated that the daily client must remain untouched. The unified publisher retains own-updater authority. No daily App, MyAgents profile, Keychain, Host, model, auth or cloud-service mutation occurred. Native installation, client-data migration, Host and actual business journeys remain outside this download-channel acceptance.

Single primary agent, zero new workers: bounded metadata and existing-design regression made serial execution appropriate. No external models; no runtime-confirmed model/effort switch or measured token/cost claim. The archive-path assumption and task-header gate failure were diagnosed and corrected, without lowering checks. Small script edits improved neutral screenshot capture and both viewport checks; no product-design changes. Final CI/main/remote tree plus live correspondence must pass before marking the task complete.
