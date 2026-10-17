# MOXBOTS-NET-AUTH-001 acceptance

Primary agent owns implementation and UI acceptance; this bounded state/entry fix uses no subagents. Existing theme, network selector, account-only dialog and Rust registry remain the owners; no new auth state, device identity, protocol or transport is introduced.

## Source and isolated checks

- Registry `ownedAccount.state=signInRequired` takes precedence over a stale transport snapshot. Closed auth and identity-conflict errors receive fixed, translated messages; ordinary disconnects retain automatic reconnect wording.
- A direct Sign in again button reuses the selected connection's existing account-only login flow, pinned URL, generation fences and cancel path. Opening/cancelling does not enroll/remove a device or start a login automatically.
- Focused API/DOM: 91 passed across AgentNetwork, NetworkSelector and agentNetwork API. Includes auth error mapping, stale transport projection, recovery clearing, no metadata access while disconnected, cancel, connection isolation and existing late-login/generation fencing.
- Full typecheck/lint and production web build are tracked in the task record.
- Real rendered fixture at `http://127.0.0.1:5208/`: zh-CN desktop1280×720 expired → direct login → pinned URL → pending → simulated authentication → ready/empty directory and no stale login button/status. Transport and identity-conflict states show distinct messages. en-US390×844: readable status and action, scrollWidth=390; open/close dialog returns focus to Sign in again.
- This fixture uses synthetic state and excludes OS credential access, real URLs and network writes. It is not authenticated native acceptance or proof of task execution.

Run locally using the repository's Node24 and installed dependencies:

```sh
MYAGENTS_BUILD_PROFILE=moxbot npx vite --config dev-docs/network-auth-validation/vite.config.mjs
```

## Actual installed client and operational boundary

User completed sign-in through the original native owner and chose to continue with the newly signed-in account. The app retained the previous account connection and selected a distinct new-account connection. A read-only native snapshot returned `disconnected / KEY_GENERATION_CONFLICT`; no secret was extracted. Current device-core claims are unique by network/device, and read_state hides another account's record. This explains why an existing physical device cannot be enrolled under a different account with the same device ID. Original account/device ownership was not changed.

The daily App, global sidecar and original HRM session sidecar PIDs/start times remained unchanged from the pre-task snapshot. No stop, logout, app restart, credential deletion, global device-ID change, server deployment or identity transfer was performed. Current desktop has the old frontend until a separately coordinated signed client update; do not claim this fix is installed.

Remaining: safe account/device-identity migration or per-account identity design requires an explicit architecture decision and its own authenticated checks. Do not bypass the conflict with database edits, original-account revocation or global identity replacement. Unified desktop release ownership and the no-interruption constraint continue to apply.
