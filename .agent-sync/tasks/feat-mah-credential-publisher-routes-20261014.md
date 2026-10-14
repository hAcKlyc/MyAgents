# MAH-CREDENTIAL-PUBLISHER-ROUTES-20261014

Repository: https://github.com/heavenzhang/MoXBots. Current branch: feat/mah-credential-parent-budget-20261013, integrated into draft PR14 feat/mah-management-device-pairs. Root owns integration, artifact creation, installation, native acceptance and main delivery. Do not rebuild frozen a838 from a later documentation HEAD.

## Scope and current result

User approved a838 installation; App/data backups and actual installed sidecar source verification completed. Explicit old session/key reads succeeded; identity target save returned authorizationRequired and no route was committed. No automatic retry or password collection. Original MyAgents stays running.

The repair separates physical storage by the closed publisher family while preserving logical scope IDs and immutable reader/protocol inputs. Explicit migration holds the route lock across source authorization, validation, target write/readback and atomic switch. Missing/deleted selected records cannot fall back; fresh authentication is distinct from restore. Non-MoX storage behavior remains unchanged.

- [x] Diagnose actual installed candidate and stop failed automatic retries.
- [x] Implement closed reader → compile-time writer family mapping; reader packaging 17 checks pass.
- [x] Independent review: address same-key save idempotence and source reread risk; identify final expiry fence and behavior fixture failures.
- [x] Source-exact temporary-ledger tests 25 per family; primary native slots25/owned15/identity2 passed with unchanged source hashes; final review clear. Actual profile/feature production compile passed; packaging17 passed.
- [x] Implementation submitted and pushed at 84fd35f8cfb35c1d3de19268ef8ae64021f474a7, preserving main d86f7505 and project board.
- [ ] Exact-head CI and frozen artifact acceptance (separate gates).
- [ ] Two full signed builds with distinct CodeDirectories for one concrete migration/cold-start/update approval batch; exact resources, reader pin, archive and extraction checks.
- [ ] Actual desktop/Linux remote config and disabled Agent create/persist/readback; no paid inference.
- [ ] PR14 main delivery and installed artifact/source correspondence.
- [ ] MOXBOTS-DOWNLOAD-001: user explicitly authorized public website and GitHub trial download. Publish accepted package and exact metadata through existing Site source workflow, verify actual download.

Website source is a separate Sites checkout. Primary IAB page/fixture behavior and independent visual/content review passed; actual installer remains pending. Cloud login owner has a separate maintenance window; do not concurrently deploy its services. Private backup/runtime/credential evidence stays outside Git.

Details: `specs/tech_docs/credential_publisher_routes.md`. Follow that checklist and current runtime receipts rather than interpreting old pending approval as still unanswered.

First full candidate is frozen at 84fd35f8 in a detached worktree. A second full build follows this documentation-only handoff update, with unchanged functional inputs; compare both signed CodeDirectories before requesting one concrete approval for the migration/cold-start/update sequence. Native tests and source-exact ledgers are passing, while installed migration, both signed artifacts and public release remain pending.
