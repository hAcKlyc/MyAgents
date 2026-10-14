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
- Prepared private HOME/minimum authorized CLI auth/Kimi key, canonical executable SHA pins and loopback proxy. No GUI/model started. Native A1 snapshot build is running; it will not serve as final Title-cancellation acceptance because a real Hono DELETE empty-stream defect is being repaired by its owner.

## Verification

- Integrated typecheck/scoped ESLint, 178 endpoint/composition/Title integration+DOM and 18 NEXT handler/DOM tests passed. These use controlled fixtures and do not prove real models/native acceptance.
- Profile stage independent review, 3 release Rust namespace tests, 7 profile I/O checks; expanded launcher/policy scripts 8/8. Other source-specific evidence retained in their owner docs.

## Blockers and unknowns

- Title owner is repairing a reproduced real Hono wire issue: empty DELETE has a stream and was rejected by the old null-body guard. Final native candidate must include its precise fix SHA. UI/real models/Host remain pending. Community safe cloud maintenance owned by its feature owner; this task never deploys that binary in parallel.
- Daily app has user work; do not restart/kill/overwrite while active.

## Next step

- Merge Title wire-cancellation fix; independent review and fresh native snapshot with verified local SwiftPM overlay, then exclusive GUI lease for serial NEXT/TITLE/Host acceptance. Wait cloud publisher recovery before new remote calls. Merge all accepted sources with CI, freeze 0.5.5, sign/notarize/publish and idle-only update.
