<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/unified-055-integration-20261015 -->
<!-- git-project-sync-task:base=afa7d819aaca1fb2755ff5ae0ae23266c67dceb5 -->
<!-- git-project-sync-task:status=in-progress -->


# Task: MOXBOTS-055 combined native acceptance and release

## Objective

MOXBOTS-055-UNIFIED-ACCEPTANCE integration owner: combine accepted profile/runtime/title/Host/brand changes for serial native model/Host/UI acceptance, exact 0.5.5 source freeze, signed/notarized release and idle-only actual update.

## Acceptance criteria

- All related code reviewed/CI/main; separate modelqa native utility and real Host acceptance.
- Formal 0.5.5 App/DMG/signature/notary/archive/own-update gates plus actual safe client update.

## Completed

- Base main afa7d819 includes PR49 compatibility. Locally merged profile ab935 and NEXT772f preserving ancestry; not proof of their main delivery.
- Locally merged brand 11894a8d and Title 7f4a1b97; exact modelqa endpoint authorization and renderer entry wiring implemented. These are candidate merges, not mainline delivery.
- Prepared private HOME/minimum authorized CLI auth/Kimi key, canonical executable SHA pins and loopback proxy. No GUI/model started. Native A1/A2 release bundles passed; final fresh A3 also includes compile-gated QA navigation. A4 is now running privately; A1/A2/A3 are not the final utility UI evidence.

## Verification

- Integrated typecheck/scoped ESLint, 178 endpoint/composition/Title integration+DOM and 18 NEXT handler/DOM tests passed. These use controlled fixtures and do not prove real models/native acceptance.
- Profile stage independent review, 3 release Rust namespace tests, 7 profile I/O checks; expanded launcher/policy scripts 8/8. Other source-specific evidence retained in their owner docs.

## Blockers and unknowns

- Wire fix a3e51fd7 integrated and independently verified with real Hono HTTP; Root 32 routes/wire and reviewer 171 routes/wire/composition passed. Main b5b9c9c4 includes final brand. UI/real models/Host remain pending. Community safe cloud maintenance owned by its feature owner; this task never deploys that binary in parallel.
- Daily app has user work; do not restart/kill/overwrite while active.

## Next step

- Complete independently leased A4 native NEXT/TITLE, resolve normal owned-login network path, then dedicated Host approval/model acceptance; independent review and fresh native snapshot with verified local SwiftPM overlay, then exclusive GUI lease for serial NEXT/TITLE/Host acceptance. Wait cloud publisher recovery before new remote calls. Merge all accepted sources with CI, freeze 0.5.5, sign/notarize/publish and idle-only update.

## Unified merge queue

PR54 contains the actual final feature heads/records: NEXT58c819b4, TITLE9ff0ba28, FEEDBACKbc5ebb71, profiled97449c2, brand recordad3b0bb3. Final review/CI/native acceptance, one main merge and source hash verification precede formal 0.5.5 packaging. No feature branch is delivered merely by its own PR. Production community is already deployed by its sole publisher; cloud maintenance hold was explicitly released, dedicated Host CLI preparation resumed, GUI/model business acceptance still awaits A3.


## A4 / main-board checkpoint

- [x] Main20593924/boardPR56 merged into integration9f943354; board focused25 tests passed. Final installed board native remains open.
- [x] A4 source2b2f12cd external3378-file closure, DeveloperID strict signature and no-production-Reader checks passed. Includes await-Global bootstrap; not final board graph or distribution.
- [x] Human confirmed manual QA `test`; ordinary task correctly refused by utility-only guard, preserved. GUI lease transferred solely to independent reviewer; Root/feature owners stopped UI.
- [ ] Independent native NEXT three runtimes/IME/Enter and Title persistence/cancellation: in progress.
- [ ] Normal owned login: native5s GET connect timeout observed; curl alone does not resolve native PKCE. Dedicated Host model/approval pending.
- [ ] HRM live activity and safe-install owner gate; history terminal logs do not establish current idle. No task interrupted, no external CLI permission expanded.
- [ ] PR54 final CI/native gates/main; formal0.5.5/source freeze, signing/notary/own updater/client installation still open.

Private receipts are under the pointer workspace `work/unified-055-20261015/`; A4-native-candidate.json, A4-source-snapshot.json and independent private UI evidence distinguish source/build/model/native/install gates. Do not commit private HOME/auth/PKCE or business logs.
