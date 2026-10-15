<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/admin-account-20261016 -->
<!-- git-project-sync-task:base=c225acd830513eb50736f75718f559a9ebda17bc -->
<!-- git-project-sync-task:status=in-progress -->

# Task: MOXBOTS-ADMIN-ACCOUNT-001

## Objective

Allow an operator-provisioned short account identifier in the existing Dex sign-in page. Provision the explicitly requested administrator through private deployment configuration, preserving existing identities, resources and administrator grants. Credentials and private identity records stay outside Git.

## Acceptance criteria

- [x] Required login input accepts both short account identifiers and existing email identifiers, with the existing POST and OIDC flow intact.
- [x] Focused bootstrap checks and real rendered form validity checks pass.
- [ ] Current remote main includes the template change; applicable CI passes.
- [ ] Private account provisioning, consistent backup and rollback path are recorded privately.
- [ ] Actual new-account sign-in, administrator bootstrap, users page and logout pass; existing account remains usable.

## Completed

- Read the current account configuration and administrator allowlist without exposing password hashes or secrets. Existing accounts will be preserved.
- Change only the login identifier label/type/placeholder; no authentication bypass or change to identity ownership.

## Verification

- Bootstrap suite: 5 passed. Real Chromium rendered form validity: empty identifier/password rejected; short identifier and email accepted. UI owner: primary agent; two-line low-risk template change does not warrant an independent worker. Test desktop and narrow form, required-field behavior, short and email identifiers, actual authorized production login and logout.

## Blockers and unknowns

- Service restart is permitted only after checking for unfinished commands and in-flight model requests under the existing cloud upgrade lock. No Host/desktop install or model inference is in scope.

## Next step

- Verify the template, deliver it to remote main, then provision the new identity and grant using its real OIDC-created principal.
