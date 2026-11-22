# Analytics Event Contract

> Tracked source of truth for analytics event names and stable dimensions.
> Local PRDs under `specs/prd/` are ignored and must not be test inputs.

## Principles

- Events describe product state changes, not raw UI clicks.
- Reuse dimensions (`source`, `surface`, `entry_intent`) instead of splitting events by every entry point.
- Session-scoped events should carry `session_id` directly or receive it from the active analytics context.
- User-defined Agent/workspace names use local salted hashes for grouping; their raw names are not uploaded.

## Shared Dimensions

### Device Identity

`device_id` is the stable desktop endpoint id stored at `~/.myagents/device_id`.
The value predates Cloud Space and must remain stable across the Space device
identity work. The implementation owner is the shared device identity layer
(`src-tauri/src/device_identity.rs` + `src/renderer/identity/deviceIdentity.ts`);
analytics must consume that layer instead of creating its own id.

Cloud Space uses the same value as `deviceId` when upserting
`user_devices(userId, deviceId)` and registering Registered Agents. This is a
shared identity source, not a new analytics dimension and not a server-issued
replacement id.

### Source

`source` identifies the process/channel that triggered an event:

- `desktop`
- `floating_ball`
- `cli`
- `cli_agent`
- `cron`
- `im`

### Surface

`surface` identifies the UI or product surface within a source:

- `launcher_input`
- `global_sidebar`
- `agent_card`
- `history_click`
- `new_chat_button`
- `task_center`
- `record_detail`
- `speech_tool_card`
- `bug_report`
- `agent_setup`
- `cmd_k`
- `external_link`
- `cron`
- `im`
- `floating_ball`
- `unknown`

Global Sidebar keeps the established event names: fresh workspace launches emit
`workspace_open` with `surface='global_sidebar'`; existing sessions emit
`history_open` with `entry_source='global_sidebar'`. Expanded-sidebar and rail
flyout interactions share this value because they are two projections of the
same navigation surface.

### Entry Intent

`entry_intent` describes what the entry point is trying to do:

- `send_message`
- `open_workspace`
- `open_history`
- `thought_alignment`
- `workspace_init`
- `support_diagnostics`
- `new_chat`
- `fork`
- `unknown`

### Runtime Identity

Events that describe session or turn execution carry:

- `runtime`: execution runtime (`builtin`, `dsh`, `claude-code`, or `codex`;
  `unknown` on renderer fallback paths).
- `runtime_source`: runtime owner source. `builtin` / `unknown` report `null`;
  DSH reports `integrated`; external runtime turns report `system-cli` for user-installed CLIs or
  `managed-provider` for product-managed runtime-backed Providers such as
  `codex-sub`.

`source` and `runtime_source` are intentionally different dimensions:
`source` answers which product channel triggered the event (`desktop`, `cron`,
`im`, ...); `runtime_source` answers who owns the selected Runtime distribution/auth.

Session and turn events (`session_new`, `history_open`, `message_send`,
`message_complete`, `message_error`, `message_stop`, `ai_turn_complete`),
conversation operations (`message_retry`, `session_rewind`, `session_fork`),
and Chat tool, permission, Provider, model and reasoning-effort events carry
Runtime identity. Background Tabs and the Companion window supply their own
`session_id` and Runtime dimensions explicitly; the active Tab context must
not attribute their events. Missing identity remains unknown.

## Event Names

Application lifecycle:

- `app_launch`

Session management:

- `session_new`
- `session_rewind`
- `session_title_edit`
- `session_fork`

Core interaction:

- `message_send`
- `message_complete`
- `message_stop`
- `message_error`
- `message_retry`
- `message_copy`
- `message_export`

Thinking export and copy:

- `thinking_copy`
- `thinking_export`

Tool and permission flow:

- `tool_use`
- `official_tool_vision_analyze`
- `permission_grant`
- `permission_deny`

Configuration changes:

- `provider_switch`
- `model_switch`
- `reasoning_effort_switch`
- `mcp_add`
- `mcp_remove`

Agent, channel, and skill management:

- `agent_add`
- `agent_remove`
- `agent_channel_create`
- `agent_channel_remove`
- `agent_channel_toggle`
- `skill_use`
- `im_bot_create`
- `im_bot_toggle`
- `im_bot_remove`

Feature usage:

- `tab_new`
- `tab_close`
- `restore_last_session`
- `settings_open`
- `workspace_open`
- `workspace_create`
- `history_open`
- `file_drop`
- `tts_play`
- `task_center_open`
- `bug_report_submit`

MyAgents Space:

- `space_open`
- `space_auth_start`
- `space_auth_complete`
- `space_switch`
- `space_issue_mutation`
- `space_goal_mutation`
- `space_skill_mutation`
- `space_tool_mutation`
- `space_registered_agent_mutation`
- `space_member_mutation`
- `space_settings_mutation`

Space event dimensions are deliberately allowlisted:

- `space_kind`: `official`, `team`, `personal`, or `unknown`.
- `is_official`: boolean derived from `space_kind`.
- `space_role`: `owner`, `admin`, `member`, or `unknown`.
- `space_surface`: `home`, `issue_list`, `issue_detail`, `goals`,
  `skills`, `tools`, `agents`, `members`, `settings`, or `unknown`.
- `operation`: normalized product operation such as `create`, `update`,
  `comment`, `state_change`, `install`, `list_load`, `register`, or `revoke`.
- `ok`: boolean success marker.
- `error_code`: normalized error bucket only; raw error messages are not
  uploaded.
- `duration_ms`: mutation duration.

Space analytics must not upload user-defined Space names/slugs, raw Issue,
Goal, Skill, or Agent ids, Issue titles/bodies/comments, member emails, Google
profile details, or workspace paths. Space business facts are owned by
MyAgents_space admin APIs; client events only describe desktop usage behavior.

Space Tool 使用 `space_tool_mutation`，稳定字段沿用其它 Space mutation。
Tools 列表加载结果复用 `space_open`，并固定
`space_surface=tools`、`operation=list_load`，只记录成功状态、数量和归一化错误。
自定义安装提示词启动小助理时，Session birth 使用
`surface=space_tools`、`entry_intent=tool_install`、
`assistant_entry=space_tool_install`；不得上传 Tool 安装指令或 Space 名称。

System events:

- `update_check`
- `update_install`

Cron and launcher scheduling:

- `cron_enable`
- `cron_stop`
- `cron_recover`
- `launcher_cron_stage`
- `launcher_cron_create_standalone`

Task center:

- `task_create`
- `task_run`
- `task_stop`
- `task_delete`
- `task_align_discuss`

`task_run.run_count` 使用 Task execution owner 接受 run/rerun 后返回的 `attemptOrdinal`，并从 1 开始计数。它不由 `sessionIds` 数量推算；dispatch/admission 前失败不会产生该事件。Desktop 与 CLI 使用同一操作结果，因此 Session 复用与 new-session 路径的统计语义一致。

Launcher and thoughts:

- `launcher_mode_switch`

Record, recording, and local speech:

- `record_create`
- `recording_start_result`
- `recording_finish`
- `recording_recovery`
- `speech_processing_finish`
- `record_use`
- `speech_resource_mutation`
- `speech_attachment_job`

These events use `event_schema_version=1`. RecordStore, RecordingManager,
SpeechRecognitionManager, and the speech resource owner produce typed local
receipts only after their authoritative mutation or terminal commit. A single
App-shell listener explicitly maps the receipt allowlist into the existing
`track()` queue; it does not add a network endpoint, persistent analytics
outbox, retry owner, or business-state replay.

The local bridge may receive a random Record/job identity, but must replace it
with the existing locally peppered, domain-separated `record_hash` or
`job_hash` before calling `track()`. Raw Record/job IDs, title, tag,
transcript, note, Speaker name, source/output paths, media bytes, and raw error
messages are forbidden. `error_code` accepts normalized uppercase codes only.
Media duration, file bytes, count, coverage, and segment-final latency use the
fixed buckets defined by the typed receipt mapper; model resource bytes and technical operation
duration may remain exact because they contain no user media facts.

`record_use` reports an accepted Record operation, never a hover or an
uncommitted click. Renderer owns only `open` after Record Tab navigation
succeeds and `play` after the media element actually enters a new playback
session; pause/resume/seek do not emit another event. Rust-owned export,
archive, delete, and Speaker correction operations emit only after their
authoritative operation succeeds. Stable fields are `record_hash`,
`record_kind`, the fixed `operation`, `source`, and `surface`.

`recording_start_result` records one new start admission result, not an
idempotent replay or focus of an already-active slot. `recording_finish` is
emitted after archive/final manifest settlement and contains only fixed
finish/outcome enums and aggregate buckets. `recording_recovery` is buffered
in process until the App-shell listener confirms registration so startup
recovery receipts are not lost; the buffer is bounded and non-persistent.

`speech_processing_finish` covers terminal Record backfill and diarization.
`speech_attachment_job` covers accepted submit and terminal finish/cancel for
Session-scoped Agent jobs. `speech_resource_mutation` covers explicit
download/update/retry/remove results. All three reuse the same Rust owners and
existing Renderer analytics transport; Worker stdout, UI buttons, and CLI
formatting never infer success.

Floating ball:

- `floating_ball_toggle`
- `floating_ball_summon`
- `floating_ball_expand`
- `floating_ball_pet_select`

Server-side AI turn:

- `ai_turn_complete`

`ai_turn_complete` is the canonical usage event for a successfully completed
root turn. Builtin emits after a non-aborted successful result; the shared
Runtime session owner emits after a successful terminal and transcript
settlement. Failed, stopped and pre-warm operations do not emit this success
event. It is not a complete accounting of failed requests or child-model calls.

The Sidecar records `source`, origin fields, Product `session_id`, `runtime`,
`runtime_source`, effective `model`, token counts, tool count and duration.
Provider attribution comes from the configuration used to execute the turn:

- `provider_id` and `provider_name`: configured Provider identity and display
  name. Builtin subscription uses `anthropic-sub` / `Anthropic (订阅)`.
  DSH uses the resolved Provider, never the Runtime display name.
- `api_protocol` and `provider_api_protocol`: effective `anthropic` or `openai`
  protocol. Both fields use the same value.
- `provider_api_family`: effective request family, `anthropic-messages`,
  `openai-responses` or `openai-completions`. DSH reads the compiled profile,
  including per-model routing, native protocol selection and OAuth leases.
- `provider_base_url`: effective HTTP(S) endpoint with URL credentials, query
  and fragment removed. Builtin subscription uses `https://api.anthropic.com`.

CLI-owned credentials do not expose a configured API endpoint to the Host.
Claude Code and Codex retain their Runtime display name as `provider_name`;
Provider identity, API family/protocol and endpoint remain `null` when unknown.
DSH without execution attribution reports an unknown Provider rather than a
CLI label. Attribution and counters are captured before asynchronous transcript
persistence, so later configuration or turn changes cannot alter this record.

`message_complete` is the Renderer observation of the terminal event, not a
second usage record to add to `ai_turn_complete`. Both Chat Tabs and Companion
use the shared completion mapper: missing or invalid measurements are omitted,
and an explicitly reported zero remains zero. Never infer zero usage from a
Runtime omitting a field. `message_error` and `message_stop` describe UI-observed
failure and stop terminals; they contain no raw error text and do not supply
usage accounting for turns without a successful result.

`tool_use.tool_origin` distinguishes `runtime` tool calls from `provider`
server tools. The `tool` value preserves the Runtime's native tool name.
For Antigravity, tool usage and permission events record a fixed tool category.
Native presentation titles, command arguments, and user MCP server/tool identifiers
stay in session content. Permission events are emitted after the response is accepted. Companion events use
`source='floating_ball'` and `surface='floating_ball'`, with the Companion's
frozen Session binding rather than the main window's active Tab.


## 投递确认与失败诊断

Renderer 与各 Sidecar 分别维护内存队列。只有 HTTP 请求成功，且云端返回 `success: true`、`received` 等于整批数量，才确认送达并移除该批事件；Cloud Analytics 在 D1 原子批量提交后返回此确认。

网络异常、408、429、5xx 和无效响应保留队首批次，按指数退避重试，最长间隔 60 秒。新事件和页面可见性变化触发的发送不得绕过重试期限；每个队列同时最多发送一个批次。其他 4xx 视为永久拒收，移除该批并记录状态。失败日志只含固定原因、状态、数量与等待时间，不输出传输异常原文、密钥或事件参数。

队列总容量包含正在发送的批次；容量满时拒绝新事件，并在每次持续满载期间只告警一次。Renderer 事件限流和 Sidecar 等待配置的缓冲限制继续生效，数值以实现为准。这是进程内尽力投递：退出会丢失内存队列；请求超时后服务端可能已经提交，重试可能重复。没有持久化发送队列或幂等事件 ID，不能保证每条事件恰好投递一次。
