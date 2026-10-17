# Direct remote Agent conversations

The independent `remote-session` Tab opens a same-account Agent through the
existing owned encrypted management channel. It never acquires a local Session
Sidecar, forwards local Provider credentials, mounts a remote workspace or uses
an `@` invocation. Its messages and execution remain owned by the target's
original SessionEngine and SessionStore.

## Contract and authority

`session.remote` is an owned Host-management extension. Its strict requests are
capabilities, list, get, start, send, receipt, respond and stop. TypeScript source
is `src/shared/remoteSession.ts`; the Rust codec, owned schema and shared fixtures
are in `src-tauri/host-management-protocol/`. The fixed Agenthub protocol archive
is unchanged. Older targets reject the method and the Tab reports unsupported.

The existing authenticated channel binds service, environment, principal,
network, device and key generation. The inspected target scope becomes mandatory
after capabilities. Controller/target channel roles are explicit. Desktop
targets accept only this Session extension, not Host configuration methods.
Every request revalidates the local registered enabled Agent, project visibility
and workspace association. Callers cannot provide a path, runtime configuration,
credentials or another caller identity. Private Host Bot Sessions are excluded
by their persistent `hostBotBinding` birth marker and existing delegation owner.

The internal desktop routes require the existing internal CLI credential.
`/api/remote-session/prepare` is Global-only: it freezes the original owned birth
snapshot, writes an invisible prepared Session, then calls the original V2
`publishSessionForHandoff` flush/close barrier. Rust starts the exact Session
Sidecar from that persisted runtime identity. Only the original engine's
beforeDispatch prepared CAS makes the new Session visible. Existing Sessions
retain their own snapshots. Host uses its original supervisor and supports only
its compatible builtin runtime; it can release an idle worker but never replaces
a running/waiting worker implicitly.

## Admission and recovery

Mutation UUIDs are durable before effects. The local receipt ledger stores only
request digests, bounded receipt metadata and owner liveness, never prompts,
answers or credentials. Reusing an ID with different intent fails. Completed
IDs cannot execute again; uncertain IDs are queried without replay. A receipt
not found is not proof of non-execution. Each file is private and at most 4 KiB;
the aggregate ledger admits at most 10,000 records and refuses new IDs when full.
It does not expire unknown deduplication records. Failed temporary writes clean
only their own candidate, preserving the previous durable receipt.

The processing observation lease is refreshed by the original process
incarnation every 3 seconds. Dead owners, expired preparation or a lease stale
for 12 seconds become unconfirmed; PID existence alone is insufficient. The
desktop prepared handoff expires after 60 seconds without adoption. These
observation deadlines never authorize replay or mean the operation was stopped.

HTTP returns processing without waiting for a turn. A new Session is bound only
after actual dispatch acceptance. An existing send with a real queueId may be
acknowledged at original queue acceptance so approval of an earlier turn remains
reachable. Acceptance is not completion. Rust retains an independent admission
owner until receipt/queue evidence permits transfer to original
BackgroundCompletion; closing a Tab or encrypted channel cannot cancel it.
Host reserves control slots so pending sends cannot consume approval/stop capacity.

Only pending remote permission, plan and question requests appear. Responses
match process generation, turn and request ID. Permissions are allow-once or
deny. Truncated, secret or unprojected native review requests cannot be approved;
the target's original UI must handle them. Stop matches the exact active turn.

The Renderer persists only scoped operation ID/kind/status before sending.
Storage failure or corruption disables new writes rather than guessing success.
Tab close/restart preserves unknown IDs; explicit account boundaries remove
their scope. Cold network hydration keeps a locked Tab until account identity
can be verified. Draft text and answers are not persisted by this feature.

## Observation and UI

Active Tabs synchronize bounded complete snapshots, about 1.5 seconds after the
previous request finishes. This is not token streaming. A page contains at most
30 messages and the Session result body is at most 48 KiB, leaving envelope room
under the existing 64 KiB transport limit. Oversized or unreadable projections
fail explicitly. Native thinking and raw tool inputs are not message projections.
Remote Markdown disables local files, attachment/image loads and active preview
actions. Latest history lists replace their baseline; explicitly loaded older
list pages are marked cached and are cleared by manual refresh.

Component simulation and loopback owner tests do not prove real encrypted
dual-device use, Provider execution or an installed signed client. Their evidence
and the outstanding release gates are recorded in the task and
`dev-docs/remote-session/`.
