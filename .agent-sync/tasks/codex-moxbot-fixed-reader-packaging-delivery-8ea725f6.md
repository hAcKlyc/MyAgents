<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/moxbot-fixed-reader-packaging-delivery -->
<!-- git-project-sync-task:base=2796b13eeb1ad69c1b9bd529b7108ecf534a4f7a -->
<!-- git-project-sync-task:status=complete -->

# Task: Package immutable MoXBots credential reader across desktop updates

## Objective

Make every macOS MoXBots app build consume one explicitly supplied, immutable, publisher-pinned credential-reader artifact and preserve its signed bytes through Tauri bundling. Do not compile/sign the helper during app packaging. Keep default MyAgents and non-macOS builds unchanged.

## Acceptance criteria

- A closed release lock pins component/protocol version, bundle IDs, and the dedicated signing leaf certificate digest.
- Artifact input rejects missing/unexpected files, noncanonical or extra manifest fields, digest/signature/certificate/architecture mismatch, symlinks, hardlinks, and unsafe permissions.
- Successful preparation copies exact validated bytes into private staging and injects the fixed `Contents/Helpers` and `Contents/Resources` paths; Mox macOS Tauri invocation enables the Cargo feature and disables Tauri signing.
- The build fails closed when the macOS Mox profile omits the fixed-reader feature or verified artifact. After Tauri bundling, nested reader bytes and signed identity are checked again.
- Focused tests cover valid staging, byte tampering, manifest/publisher/signature/architecture rejection, unsafe filesystem input, build-option injection, and fail-closed feature wiring.
- Real publisher artifact build/sign/cache initialization, outer App signing, ZIP extraction, strict App seal, notarization, and Keychain runtime cold-start remain separate release-owner gates.

## Completed

- Added `scripts/moxbot-credential-reader-release.json`, locking component/protocol v1, `com.moxbot.credential-reader`, parent `com.moxbot.app`, and the verified internal publisher leaf certificate SHA-256 `ef80bf8a1764d1c5e8a36cf83e0bc7ed833b2f79e297ddb634a449242aac6d71`.
- Added `scripts/prepare-moxbot-credential-reader.mjs` to validate a physical immutable two-file artifact, canonical closed manifest, SHA-256, actual codesign identity/CDHash/leaf certificate, and a single thin target architecture; it stages exact bytes and provides a post-Tauri nested-file verifier.
- Updated `scripts/build-moxbot.mjs` to require the artifact on Darwin, inject the helper and manifest with a temporary `bundle.macOS.files` overlay, enable `moxbot-credential-reader`, pass `--no-sign`, and verify the generated `.app` retained the exact reader bytes and signature identity. Other platforms do not get the feature.
- Added a macOS-Mox Cargo build-script guard and updated the resource-preparation specification with cache, signing, trusted ancestor paths, and acceptance boundaries.
- Pinned the accepted arm64 artifact SHA-256/CDHash and signed source-input closure in the release lock. Preparation and post-Tauri verification recompute the current source tree; x86_64 fails until separately pinned.
- The source closure covers `rust-toolchain.toml` and all regular files under the crypto, protocol, and vendored protocol roots; path components named `target` are excluded. Its calculation rejects symlinks and is repeated around preparation and post-Tauri verification.
- No initial component compilation/signing, real App signing, ZIP/notarization, Keychain access, GUI action, or deployment was performed.

## Verification

- `/opt/homebrew/opt/node@24/bin/node --check scripts/prepare-moxbot-credential-reader.mjs` — passed (Node v24.21.0).
- `/opt/homebrew/opt/node@24/bin/node --check scripts/build-moxbot.mjs` — passed.
- `/opt/homebrew/opt/node@24/bin/node --test scripts/prepare-moxbot-credential-reader.test.mjs` — 12 passed, 0 failed, including deterministic source closure, ignored `target` files, source drift before and after staging, trusted artifact/architecture pin mismatch, and a real local signed app path / `codesign` metadata inspection.
- `git diff --check` — passed.
- Most tests use a signature-inspection stub. The real local macOS smoke test inspected only public code-signing metadata from `/Applications/MoXBots.app/Contents/MacOS/myagents`; it does not verify a real credential-reader artifact, `lipo` target, Tauri build, outer App signing/ZIP, or runtime Keychain behavior. The isolated base does not yet contain the crypto crate's `fixed-macos-reader` feature implementation, so Cargo feature resolution/build remains blocked until the crypto owner’s implementation is integrated. A source-policy test checks the build-script guard, but a raw Cargo fail-closed build was not verified.
- This isolated source checkout computes `fe61eeef869c49e61de1fd0bd68e1ce681d004d21d14b245da31ed2d917a9aff`, which intentionally does not match the signed artifact source pin `d653fc71a62428a61803e5380cb9825525aff4527aaf4583929e9e65c5c0c6e6`; real packaging must use the exact reviewed source closure.

## Blockers and unknowns

- The private initial artifact pipeline must produce the exact compact canonical eight-field manifest format required by the prepare helper, with a read-only directory and payload; then perform actual `codesign`/`lipo` verification against the pinned certificate.
- The root Cargo feature references `myagents-agent-network-crypto/fixed-macos-reader`; this dependency feature is being implemented outside this task and must be integrated before Cargo check/build can pass.
- The outer packaging owner must sign the app without `--deep`, verify the app strict seal, and prove the nested helper SHA/CDHash is unchanged after signing and ZIP extraction. This branch has only a mock filesystem test for those mutations.
- `rustfmt --check src-tauri/build.rs` reports pre-existing formatting differences elsewhere in that file; this task did not format unrelated build logic.

## Next step

Integrate the crypto owner’s fixed-reader feature, then run a real macOS Mox build with the pinned signed artifact and prove helper SHA/CDHash stability through outer signing and ZIP extraction before release.
