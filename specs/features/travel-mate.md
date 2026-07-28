# Travel Mate desktop-pet integration

## Product contract

Travel Mode is an opt-in extension of the existing MyAgents desktop pet. When
enabled, a pet schedules an occasional departure, disappears only while no
interaction needs the user, and returns with one deterministic offline
postcard.

The v1 phases are:

1. `disabled`
2. `homeScheduled`
3. `away`
4. `returnedPendingPostcard`

The Rust module `src-tauri/src/travel_mate.rs` is the only authority for the
phase, deadlines, persistence, and native window visibility effects. Renderer
code reports attention state and presents snapshots; it does not run timers or
write travel state.

## Timing and recovery

- A departure is scheduled 4–18 hours after enabling or dismissing a postcard.
- A trip lasts 20–120 minutes.
- Pending approval/question/plan state, blocked work, or an error postpones a
  due departure by 5–20 minutes.
- Attention starts unknown after launch. An overdue departure waits until the
  renderer has reported attention and the native desktop-pet window is
  confirmed enabled and visible.
- `~/.myagents/travel_mate.json` is written under the shared file-lock helper
  before the pet window is hidden or shown. The file and parent directory are
  synced so the visibility effect cannot outrun a crash-durable state commit.
- State-changing commands and timer reconciliation share one operation gate.
  Hide failure durably rolls the pet back to a 5–20 minute home retry.
- Disabling during a trip persists an internal recall-pending marker before
  showing the pet, then clears it durably. A temporary show failure is retried
  by reconciliation, including after restart.
- Startup immediately reconciles overdue deadlines. An away snapshot suppresses
  the normal floating-ball startup path, preventing a restart flash; loading
  that snapshot records the already-hidden trip instead of hiding it twice.
- The returned state remains persisted until the user dismisses its postcard,
  so restart and sleep/wake cannot duplicate or lose the delivery.

## Privacy and content

No network request is made. Destinations and story fragments are bundled in the
Rust module and chosen from the persisted postcard seed.

Only these pet fields may enter the travel store:

- pet pack id
- display name
- inferred species (`cat`, `dog`, or `other`)

Prompts, conversation text, tasks, file paths, workspace data, credentials, and
tool payloads are not accepted by the travel command surface.

## Renderer integration

- Desktop Pet settings exposes Travel Mode only while the desktop pet is
  enabled. Home status is intentionally natural-language-only and does not
  reveal an exact departure deadline.
- `BallWindow` reports the current pending/blocked/error guard and selected pet
  identity.
- `CompanionWindow` listens for `travel-mate://state-changed` and owns the
  postcard presentation.
- Debug builds expose immediate depart/return controls for acceptance testing;
  release builds reject those commands.
- Existing Codex Pets and imported PetPack assets are reused unchanged. Travel
  Mode introduces no new spritesheet or manifest format.

## Verification

The Rust tests cover timing bounds, attention postponement, persist-before-hide
ordering, serialized operations, hide rollback, startup schema validation,
recall-on-disable, idempotent return, strict privacy DTOs, and the shared
`travel-mate-v1.json` protocol vector. Renderer tests cover species inference,
allowlisted command payloads, attention mapping, postcard interaction, and
modal keyboard focus.
