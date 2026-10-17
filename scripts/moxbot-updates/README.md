# MoxBots updater publication

Scope: production macOS arm64 Tauri updater archives only. This tool prepares and verifies
static publication files. It does not sign, notarize, upload, restart an application, modify
Nginx or publish stable by default. A prepared artifact is not proof of real update acceptance.

The own endpoint is `https://140.143.183.232/updates/stable/darwin-aarch64.json`.
Artifacts use `/updates/releases/<version>/<sha256>-MoXBots.app.tar.gz`; releases are immutable.
Only the flat Tauri manifest `{version, notes, pub_date, url, signature}` is returned.
Other platforms return HTTP 204 until a separately verified formal release exists.

## Prerequisites

- Node.js, Python 3 standard library, Rust Cargo and cached `minisign-verify` 0.2.5.
  The helper builds with `--offline --locked`, with no network dependency resolution.
- A genuine `.app.tar.gz` plus its Tauri `.sig`, produced from the signed, Apple Accepted
  and stapled `MoXBots.app`. Sign the exact final archive; no archive mutation after signing.
- `src-tauri/tauri.moxbot.conf.json` contains the genuine own `plugins.updater.pubkey`.
  It must be base64 of the entire minisign public-key text, as expected by the Tauri CLI.
  This tool reads no private key or signing environment variables. Never place private
  keys/passwords in deployment files, shell arguments, Git, receipts or manifests.
- Production versions are strict `MAJOR.MINOR.PATCH`; prereleases are intentionally excluded.
  `--version` checks the requested version against `CFBundleShortVersionString`.

## Prepare without publishing

```sh
node scripts/moxbot-updates/release.mjs prepare \
  --out /private/tmp/moxbots-update-publication/updates \
  --archive /path/to/MoXBots.app.tar.gz \
  --signature /path/to/MoXBots.app.tar.gz.sig \
  --version 0.5.3 \
  --notes /path/to/release-notes.txt
```

Each preparation snapshots the archive, fully verifies the minisign signature and trusted
comment, inspects all archive paths/links without extracting or executing them, checks the
App name, bundle identifier and thin arm64 Mach-O, then writes SHA-256/byte size/verification
receipt and manifest alongside the immutable archive. App contents must stay inside
`MoXBots.app`; device entries, duplicate paths, link parents and escaping links are rejected.
An existing version is reusable only for the exact same verified archive and signature.
Preparing a version below current stable, or a same-version different artifact, fails.

`--config /absolute/path/profile.json` can select the frozen production profile for packaging
or an isolated test profile. Production publication must use the exact public key embedded
in the actual installed updater-enabled baseline. Tests use a disposable keypair and synthetic
archives; these fixtures cannot prove signing, notarization or installation acceptance.

## Deploy and promote

1. Confirm the existing website server/certificate and current active publishers; back up
   its exact Nginx site config. HTTPS must validate normally; no insecure certificate bypass.
2. Copy the prepared immutable release directory to the existing website server under
   `/srv/moxbots/updates/releases/<version>/`. Preserve any previous releases. Upload into
   a private staging directory, validate transferred SHA/size/signature, then rename the
   complete directory into place. Do not overwrite an existing version.
3. Review `nginx-locations.conf` against the actual root; include only these `/updates/`
   locations in the existing HTTPS site, run `nginx -t`, then reload Nginx. Keep all existing
   website routes/listeners/upstreams unchanged. Hidden receipts/history are never served.
4. With a verified release tree available locally on the publishing machine, run:

```sh
node scripts/moxbot-updates/release.mjs promote \
  --out /srv/moxbots/updates --version 0.5.3
```

Promotion rechecks the artifact, signature and receipt against the profile public key;
backs up previous/next manifests under `.history/`; fsyncs and atomically renames the new
stable JSON. This operation is explicit and distinct from `prepare`.
If the server does not have the offline helper toolchain, promote in an isolated local
mirror of the exact deployed release tree, upload the history backup and a temporary stable
JSON, then perform a server-side same-filesystem atomic rename. Never partially rewrite
live stable JSON with streaming copy. The accountable publisher must verify artifact hashes
on the server and genuine HTTPS response afterward.

Check real HTTPS stable JSON, artifact HEAD and GET hash, byte ranges/resume if used,
unsupported target HTTP 204, no cache on stable, immutable cache on artifacts, and unchanged
website routes. Then exercise real A-to-B update through the installed desktop application:
background check/download, activity deferral, user-confirmed restart, persisted data and
actual updated binary version. Record these results separately from static publication.

## Rollback / interruption

```sh
node scripts/moxbot-updates/release.mjs rollback \
  --out /srv/moxbots/updates --version 0.5.3
```

Rollback is explicit, validates the retained target artifact/signature and atomically swaps
stable while retaining all release and history files. Already upgraded clients do not
automatically downgrade: restoring stable stops further rollout; fix-forward with a greater
version is required for those clients. Never republish a different artifact under the same
version or enable a permissive client version comparator to force rollback.

The `.release-lock/owner.json` records only PID/time. When present, inspect the active
publisher before acting. An interrupted process can leave this lock or a `.prepare-*`
directory; do not remove it while publication is active. Staging/locks/history are not
publicly served. After confirming no publisher is active, retain evidence, remove only
the stale task lock/staging and rerun preparation. Successful commands release the lock.
For Nginx rollback restore the exact site backup, validate `nginx -t` and reload; do not
restart the entire website stack or delete existing artifact directories.

## Test

```sh
node --test scripts/moxbot-updates/release.test.mjs
```

Tests generate disposable Tauri CLI keys with all CLI output captured, sign synthetic archives,
then cover actual cryptographic verification (including tampered archive/trusted comment and
wrong key), archive identity/architecture/traversal/link rejection, same-version immutability,
promotion, downgrade rejection, explicit rollback and preservation of prior release files.
No production stable endpoint or application is changed by these tests.

## Isolated native acceptance

Use `npm run tauri:build:moxbot-updaterqa -- --qa-workspace /private/tmp/<new-directory>
--qa-public-key /absolute/path/temporary.key.pub --qa-endpoint
'http://127.0.0.1:<port>/updates/{{target}}.json' --qa-version <A-version> --
--target aarch64-apple-darwin --bundles app` (as one shell invocation).
The wrapper requires a fresh APFS workspace and a temporary key distinct from production.
It rebuilds every asset with the closed QA profile. Keep the private key outside Git.

The native app uses `com.moxbot.updaterqa`, `MoXBots Updater QA`, `.moxbot-updaterqa`,
its own CLI/scheme/sidecar marker and port range. Launch with a clean environment and a
separate test HOME. Do not copy daily configuration, credentials or history. QA forbids
production credential readers, OS account stores, model probes, SDK/DSH/external runtime
execution and auxiliary model utilities. Its terminal clears inherited environment and
uses a non-login system shell. Verify the compiled identity and these boundaries before
launch; moving a production app into a temporary directory does not isolate it.

Native acceptance may exercise updater signing/download/pending/confirmation and a real
QA terminal busy owner. Model execution-owner regressions are deterministic tests; they
are not proof of an active paid Provider task surviving a native update. Never use daily
`/Applications/MoXBots.app`, `.moxbot`, or shared Keychain state for this acceptance.
