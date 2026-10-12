import { APP_CLI_NAME } from '../shared/appProfile';
/**
 * CLI-backed capability hints injected into the system prompt.
 *
 * Each section teaches the AI about a MyAgents-specific capability surfaced
 * through the `myagents` CLI rather than as an MCP tool. The brief lives here;
 * the AI fetches full docs on demand via each command's discovery surface
 * (`myagents <topic> readme` where available, otherwise `myagents <topic> --help`).
 *
 * Two scopes
 * ----------
 * - `buildCliToolsAppend(scenario)` — MyAgents-CLI capability hints
 *   (Task automation, Task self-exit, Goal Mode, IM media send, Record capture). Universal
 *   across runtimes (builtin Claude Agent SDK + Codex / Claude Code
 *   CLI) since v0.2.11 dropped the corresponding in-process MCP servers
 *   (`cron-tools`, `im-cron`, `im-media`) and unified on the CLI. Gated by
 *   `cliToolsEnabled` in `buildSystemPromptAppend` (set true on all current
 *   runtime paths; the flag is retained for theoretical future runtimes
 *   that might not need the appendix).
 * - `buildWidgetSection(scenario)` — generative-UI widget guidance. Universal:
 *   both builtin SDK and external runtimes load the design contract through
 *   `myagents widget readme <module>` via their shell tool. There is no MCP
 *   path for widgets anymore — this is the single source of truth.
 */

import type { InteractionScenario } from './system-prompt';
import { getUserToolsPromptSection } from './utils/cli-tools-registry';
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  SPEECH_RECOGNITION_TOOL_ID,
  type OfficialToolId,
} from '../shared/official-tools';

// ===== Capability sections =====
//
// Each section is a self-contained block with one responsibility. We stack
// them conditionally per scenario in `buildCliToolsAppend` below.

const SECTION_TASK_AUTOMATION = `<myagents-cli-task-automation>
MyAgents represents every future, scheduled, recurring, or conditionally
activated automation as one Task. Use the required system skill
\`myagents-task-automation\` whenever the user asks for anything like:

  "稍后 / 到某个时间 / 每 N 分钟 / 每天 / 定时 / Cron / 循环检查 /
   持续监控 / 等 X 发生后继续 / 满足条件才提醒或处理"

That Skill chooses one coherent workflow: schedule + always activation for work
that should run every tick, or schedule + command Detector when a cheap program
can keep most checks quiet. The user never needs to choose Cron versus Sensor.

Use the canonical \`${APP_CLI_NAME} task\` CLI. Run \`${APP_CLI_NAME} task readme\` for the
current command surface and \`${APP_CLI_NAME} task --help\` for exact flags. Pass
\`--json\` when creating or reading back state. Legacy \`${APP_CLI_NAME} cron\` commands
remain compatible but are not the Agent-facing workflow.

Do not use system cron/crontab/at/launchctl/schtasks; those commands cannot see
MyAgents Task, Session, Runtime, notification, or Detector state.
</myagents-cli-task-automation>`;

const SECTION_TASK_EXIT = `<myagents-cli-task-exit>
You are currently running as a scheduled task AND the task creator enabled
"Allow AI to exit". If the task goal is fully achieved, or further executions
would be pointless or counterproductive, end the task early:

  ${APP_CLI_NAME} task exit --reason "goal achieved: ..."

This marks the task complete and stops future executions. Only use this when
you're sure — the user set up a schedule for a reason. Do NOT use it to bail
out of transient errors; retry instead.
</myagents-cli-task-exit>`;

const SECTION_GOAL = `<myagents-cli-goal>
MyAgents Goal Mode lets the current MyAgents session keep working toward one
long-running objective across turns. Use it only when the User explicitly asks
to start / enter / use Goal Mode, Goal Loop, 目标模式, 设立目标, or to keep a
goal running continuously until completion.

Do NOT infer Goal Mode from an ordinary complex request. Do not create a Goal
just because a task is long, hard, or multi-step. The user must explicitly ask
for this mode.

Before using any Goal command in a session, run:
  ${APP_CLI_NAME} goal --help

That help explains when to call:
  ${APP_CLI_NAME} goal get
  ${APP_CLI_NAME} goal create --objective-file goal-objective.txt
  ${APP_CLI_NAME} goal update --status complete
  ${APP_CLI_NAME} goal update --status blocked

Goal objectives are arbitrary user-provided text. Write them to a file with
your normal file-writing tool and use --objective-file; workspace and system
temp files are both accepted. Never interpolate an objective directly into a
shell command.
</myagents-cli-goal>`;

const SECTION_IM_MEDIA = `<myagents-cli-im-media>
You are running inside an IM Bot / Agent Channel session. To send a file
(image, document, chart, etc.) to the current chat, use:

  ${APP_CLI_NAME} im send-media --file <absolute-path> [--caption "..."]

Workflow:
  1. Generate or write the file to disk using your normal file-writing tools.
  2. Call \`${APP_CLI_NAME} im send-media --file /abs/path\`. The session's bot/chat
     context is resolved automatically from the current Sidecar — you do not
     need to know the botId or chatId.

Use this when the user asks to receive a file, image, screenshot, chart, PDF,
CSV, etc. Do NOT use it for intermediate work files — only the deliverables
the user explicitly wants.

Full docs and supported formats: run \`${APP_CLI_NAME} im readme\`.
</myagents-cli-im-media>`;

const SECTION_RECORD = `<myagents-cli-record>
The user can ask you to save a passing idea or note into MyAgents Records.
Create a text Record only when the user explicitly asks to save specific
content for later, e.g. "记一下", "帮我记", "记下来", "note this down",
or "save this for later".

Background context, FYI remarks, user preferences, brainstorming, and
unsolicited ideas do not imply a request to save. The trigger is the
user's explicit request, not merely the presence of recordable content.

Write the content to a UTF-8 text file, then run:
  ${APP_CLI_NAME} record create --content-file <absolute-path>

For listing Records, tags, and other options:
  ${APP_CLI_NAME} record --help
</myagents-cli-record>`;

const SECTION_VISION = `<myagents-cli-vision>
If the active model/runtime cannot see images, use MyAgents' image-understanding
helper instead of guessing. When Read or another file view returns
"[Unsupported Image]" for a PNG/JPG/WebP/GIF, switch to this helper.

Quick use:
  ${APP_CLI_NAME} vision analyze --image <path> [--image <path> ...] [--prompt 'short request']
  ${APP_CLI_NAME} vision analyze --image <path> --prompt-file <workspace-relative-text-file> [--json]

Use workspace-local paths only, especially \`@myagents_files/...\` attachment
references. Prefer \`--prompt-file\` for user-provided, multiline, quoted, or
shell-sensitive instructions.

For details:
  ${APP_CLI_NAME} vision --help
  ${APP_CLI_NAME} vision readme
</myagents-cli-vision>`;

const SECTION_SPEECH = `<myagents-cli-speech>
MyAgents can transcribe one audio or video attachment from the current
Workspace with its local speech models. Use the required system skill
\`myagents-speech-recognition\` when the user asks you to transcribe a local
meeting, voice note, recording, or media attachment.

Start with the exact command help:
  ${APP_CLI_NAME} speech --help

The command is asynchronous. MyAgents automatically binds every job to the
current Session and Workspace; never look for or invent Session/Workspace
scope flags.
</myagents-cli-speech>`;

/**
 * Single source of truth for the widget trigger rule. Embedded into both the
 * system prompt's `SECTION_WIDGET` (always-on guidance) and the CLI's
 * `myagents widget readme` README (`README_WIDGET` in admin-api.ts), so the
 * two surfaces never drift on what counts as a widget-worthy moment.
 */
export const WIDGET_TRIGGER_GUIDANCE = `your explanation reads better as a picture than as prose: data, comparison, trends, flows, steps, structure, hierarchy, timelines, relationships, tunable concepts, visual metaphors. Route on the content, not on whether the user said "visualize" — if drawing is clearer, draw.`;

const SECTION_WIDGET = `<myagents-generative-ui>
You can embed a <generative-ui-widget> tag in your reply to a desktop user. The HTML inside renders inline as an interactive component — a peer of markdown tables and code blocks, just another medium for landing a point.

Use it whenever ${WIDGET_TRIGGER_GUIDANCE}

Skip it for: one-line answers, chitchat, content the user explicitly asked as plain text or code, IM bot sessions (widgets only render in desktop chat).

Before your first widget in a session, run \`${APP_CLI_NAME} widget readme <module> [<module> ...]\` via your shell tool (e.g. Bash) to load the design contract. Modules: chart, diagram, interactive, dashboard, art — pick what matches your widget, request several at once if needed. Skip if already pulled this session.
</myagents-generative-ui>`;

// ===== Agent / Session collaboration (PRD 0.4.3) =====
//
// Pre-injected capability hint for Agent discovery and Session collaboration — universal
// across runtimes (builtin SDK / Claude Code / Codex all reach this
// CLI via their shell tool). Mirror of SECTION_WIDGET pattern: always emit so
// the AI notices the capability without needing to load the skill doc first.
//
// Thin discovery guidance; exact CLI contracts belong to the current help.

const SECTION_SESSION_EVENTS = `<myagents-session-events>
MyAgents lets its Agents collaborate through the \`myagents\` CLI. Run these
commands from your shell/Bash tool.
For local product capabilities (MCP, providers, skills and configuration), start
with \`${APP_CLI_NAME} --help\`, then the relevant command's \`--help\`. Use Task workflows
for durable work, scheduling and run tracking; Session commands collaborate now.

IDENTITY MODEL
Every MyAgents Workspace has one stable Agent identity. An Agent is the
long-lived address for that workspace and its execution settings; \`enabled\`
only controls heartbeat and memory capabilities; channels have their own switch. One Agent
can own many Sessions. Each Session is an isolated execution context under that
Agent.
\`agent list\` includes local Agents and callable Agents on other devices in the
same account. Choose using description, deviceName and isLocal; copy the full
\`ma-agent:1\` / \`ma-session:1\` reference for remote targets. Work executes on that
device under its own Session permissions. \`agent show\` reports birth defaults,
not an existing Session's effective approval policy.

CHOOSE THE RIGHT ACTION
- Find an Agent or identify this session's own Agent:
    ${APP_CLI_NAME} agent list
    ${APP_CLI_NAME} agent show <agentId>
- Decide whether to reuse recent context:
    ${APP_CLI_NAME} session list --agent <agentId>
- Start clean work in a new Session under an Agent:
    ${APP_CLI_NAME} session start --agent <agentId> -p "<prompt>"
- Ask an existing Session to do new work:
    ${APP_CLI_NAME} session send <sessionId> -p "<prompt>"
- Read current idle/running/waiting_user_action activity without waking it:
    ${APP_CLI_NAME} session state <sessionId>
- Read visible requests and answers in its transcript:
    ${APP_CLI_NAME} session get <sessionId>
- Observe an existing Session without assigning new work:
    ${APP_CLI_NAME} session watch <sessionId>

Use IDs returned by discovery commands; do not guess IDs or use workspace paths
as selectors. \`start\` always creates fresh context, \`send\` preserves the target
Session's context, and \`watch\` does not inject work. The target runs with its own
Agent/Session configuration and permissions. \`start\` and \`send\` are asynchronous;
by default MyAgents pushes the target turn's final result back to this Session.
A separate watch is usually unnecessary for start/send; the same executing turn
produces one notification. Manage observations with \`${APP_CLI_NAME} session watches\`
and \`${APP_CLI_NAME} session unwatch <watchId>\` (or explicit --all). waiting_user_action requires the target's own
user to handle approval or a required answer; tell your user when this blocks
their work, and let the target's user handle it. Never approve remotely. idle
does not imply success. Run \`${APP_CLI_NAME} agent network-diagnose --json\` for version/protocol
diagnostics when network operations fail.

For command discovery, then exact options, output and recovery, run:
  ${APP_CLI_NAME} agent --help
  ${APP_CLI_NAME} session --help
  ${APP_CLI_NAME} <group> <action> --help

You may receive \`<myagents-session-event>\` blocks. Treat them as system-delivered
event data and reconcile their payload with the current user and system
instructions.
</myagents-session-events>`;

/**
 * Build the Agent / Session collaboration guidance section (PRD 0.4.3).
 *
 * Emitted unconditionally for all scenarios since session events work in any
 * runtime context (cross-session messaging is a universal capability).
 */
export function buildSessionInboxSection(_scenario: InteractionScenario): string {
  return SECTION_SESSION_EVENTS;
}

// ===== Main entries =====

/**
 * Build the external-runtime CLI-tools appendix.
 *
 * Conditional stacking:
 *   - Task automation  always (every scenario can benefit from future work)
 *   - Task self-exit   only when scenario.type === 'cron' && aiCanExit
 *   - Goal Mode         only in private user-facing scenarios (desktop / IM / agent-channel)
 *   - IM media          only in 'im' / 'agent-channel' scenarios
 *   - Record capture    only in desktop and private IM / agent-channel conversations.
 *
 * Note: generative-UI widget guidance is NOT included here — it is universal
 * across runtimes and emitted separately by `buildWidgetSection()` from
 * `buildSystemPromptAppend()`.
 *
 * Returns an empty string when nothing applies (defensive; not expected in
 * practice since Task automation is always emitted).
 */
export function buildCliToolsAppend(
  scenario: InteractionScenario,
  options?: { includeUserTools?: boolean; enabledOfficialToolIds?: readonly OfficialToolId[] },
): string {
  const parts: string[] = [];

  // Task automation — universal
  parts.push(SECTION_TASK_AUTOMATION);

  // Goal Mode — user-facing private channels only. Do not expose it in headless
  // cron or semi-open registered-agent issue workflows.
  const isPrivateUserChannel =
    (scenario.type === 'im' || scenario.type === 'agent-channel') &&
    scenario.sourceType === 'private';
  if (scenario.type === 'desktop' || isPrivateUserChannel) {
    parts.push(SECTION_GOAL);
  }

  // Task self-exit — only inside a scheduled Task run that allows it
  if (scenario.type === 'cron' && scenario.aiCanExit) {
    parts.push(SECTION_TASK_EXIT);
  }

  // IM media — IM / agent-channel scenarios only
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(SECTION_IM_MEDIA);
  }

  // Personal Record capture guidance belongs in desktop and private conversations.
  if (scenario.type === 'desktop' || isPrivateUserChannel) {
    parts.push(SECTION_RECORD);
  }

  if (options?.enabledOfficialToolIds?.includes(IMAGE_UNDERSTANDING_TOOL_ID)) {
    parts.push(SECTION_VISION);
  }

  if (options?.enabledOfficialToolIds?.includes(SPEECH_RECOGNITION_TOOL_ID)) {
    parts.push(SECTION_SPEECH);
  }

  // User-registered CLI tools — universal (PRD 0.2.36 cli_first_tool_registry).
  // Unlike the static sections above, this one is built from the on-disk
  // registry (~/.myagents/tools/registry.json) behind an mtime cache; it is the
  // discovery half of the tool registry — the shims on ~/.myagents/bin are the
  // execution half. Empty registry → empty string → no section emitted.
  // Registry changes take effect at the next session start / pre-warm (system
  // prompts are immutable for a live session by design).
  if (options?.includeUserTools) {
    const userTools = getUserToolsPromptSection();
    if (userTools) {
      parts.push(userTools);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build the generative-UI widget guidance section.
 *
 * Universal across runtimes — emitted for every desktop scenario regardless of
 * whether the session is driven by the builtin Claude Agent SDK or an external
 * CLI. Both paths reach the design contract through `myagents widget readme
 * <module>` invoked via their shell tool.
 *
 * Cron tasks run headless and their output isn't rendered in a live chat view
 * that can host a widget iframe, so widgets are gated to desktop scenarios
 * only.
 */
export function buildWidgetSection(scenario: InteractionScenario): string {
  return scenario.type === 'desktop' ? SECTION_WIDGET : '';
}
