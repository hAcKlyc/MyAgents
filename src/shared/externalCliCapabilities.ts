/**
 * Public, token-authenticated CLI surface for local programs.
 *
 * This is deliberately narrower than the installed CLI command registry. The
 * same declaration owns admission, offline help and the external grammar so a
 * command cannot be documented differently from how it is admitted.
 */
export interface ExternalCliPublicCapability {
  command: string;
  route: string;
  usage: string;
  help: string;
  flags: readonly string[];
  minPositionals?: number;
  maxPositionals?: number;
  aliases?: readonly string[];
}

function publicHelp(
  summary: string,
  effect: string,
  result: string,
  recovery: string,
): string {
  return `Purpose: ${summary}\nEffect: ${effect}\nResult: ${result}\nRecovery: ${recovery}`;
}

const READ_ONLY_RECOVERY = 'Fix the reported selector or input and retry; this command does not mutate product state.';

const TASK_SCHEDULE_FLAGS = [
  'name', 'executor', 'description', 'taskMdFile', 'taskMdContentFile',
  'taskMdContent', 'executionMode', 'runMode', 'preselectedSessionId',
  'triggerFile', 'intervalMinutes', 'cronExpression', 'cronTimezone',
  'dispatchAt', 'startAt', 'tags', 'notificationBotChannelId',
  'notificationBotThread', 'notificationDesktop', 'notificationEvents', 'notificationTarget', 'notificationTargetFile',
  'runtime', 'providerId', 'model', 'permissionMode', 'runtimeConfig',
  'mcpEnabledServers',
] as const;

export const EXTERNAL_CLI_PUBLIC_CAPABILITIES = [
  { command: 'status', route: 'status', usage: 'myagents status [--json]', help: publicHelp('Read whether the local MyAgents Host is ready.', 'Read-only; does not start AI or change state.', 'Returns Host readiness and connection information.', READ_ONLY_RECOVERY), flags: [], maxPositionals: 0 },
  { command: 'version', route: 'version', usage: 'myagents version [--json]', help: publicHelp('Read the running MyAgents version.', 'Read-only; does not start AI or change state.', 'Returns version and build information.', READ_ONLY_RECOVERY), flags: [], maxPositionals: 0 },
  { command: 'agent create', route: 'agent/create', usage: 'myagents agent create (--name <name> [--template <id>] | --workspacePath <abs> [--name <name>]) [--runtime <rt>] [--providerId <id>] [--model <id>] [--permissionMode <m>] [--reasoningEffort <e>] [--json]', help: publicHelp('Create a managed Agent workspace under ~/.myagents/projects/<name> (default empty dir, optional --template) or register an existing directory.', 'Writes Agent/Project registration (fixed enabled=false); fails closed on directory conflict and never starts AI.', 'Returns the stable Agent identity, canonical workspace path, and effectiveDefaults.', 'Inspect agent list or agent templates before retrying if the response is interrupted.'), flags: ['workspacePath', 'name', 'template', 'runtime', 'providerId', 'model', 'permissionMode', 'reasoningEffort'], maxPositionals: 0 },
  { command: 'agent templates', route: 'agent/templates', usage: 'myagents agent templates [--json]', help: publicHelp('List available built-in and user workspace templates for agent create --template.', 'Read-only; does not start AI or change state.', 'Returns template ids, names, sources, and descriptions.', READ_ONLY_RECOVERY), flags: [], maxPositionals: 0 },
  { command: 'agent list', route: 'agent/list', usage: 'myagents agent list [--active | --archived] [--json]', help: publicHelp('Discover local workspace Agents and callable Agents on other devices in the same account.', 'Read-only; does not start AI or change state.', 'Returns local IDs and complete ma-agent:1 references; networkStatus/complete describe discovery. --archived is local only.', READ_ONLY_RECOVERY), flags: ['active', 'archived'], maxPositionals: 0 },
  { command: 'agent show', route: 'agent/show', usage: 'myagents agent show <agentId> [--json]', help: publicHelp('Read one Agent using its local ID or complete ma-agent:1 reference from agent list.', 'Read-only; does not start AI or change state.', 'Returns Agent defaults for future Sessions; local Agents also include canonical workspace details.', READ_ONLY_RECOVERY), flags: ['agentId', 'id'], maxPositionals: 1 },
  { command: 'runtime list', route: 'runtime/list', usage: 'myagents runtime list [--json]', help: publicHelp('List Runtime types available to registered Agents.', 'Read-only; does not start AI or change state.', 'Returns Runtime availability and configuration summaries.', READ_ONLY_RECOVERY), flags: [], maxPositionals: 0 },
  { command: 'runtime describe', route: 'runtime/describe', usage: 'myagents runtime describe <runtime> [--json]', help: publicHelp('Describe one Runtime and its accepted configuration.', 'Read-only; does not start AI or change state.', 'Returns capabilities, defaults and supported options.', READ_ONLY_RECOVERY), flags: ['runtime'], maxPositionals: 1 },
  { command: 'session list', route: 'session/list', usage: 'myagents session list --agent <agentId> [--limit N] [--json]', help: publicHelp('List Sessions belonging to a registered Agent.', 'Read-only; does not start AI or change state.', 'Returns durable Session identities, newest first.', READ_ONLY_RECOVERY), flags: ['agent', 'agentId', 'limit'], maxPositionals: 0 },
  { command: 'session start', route: 'session/start', usage: 'myagents session start --agent <agentId> (--prompt <text> | --prompt-file <path|->) [--runtime <rt>] [--providerId <id>] [--model <id>] [--reasoningEffort <level>] [--permissionMode <mode>] [--json]', help: publicHelp('Create a fresh Session and admit its first prompt, with optional one-shot local execution overrides.', 'Creates Session state and starts an AI turn asynchronously. Local overrides apply only to this new Session birth snapshot and never modify Agent defaults; remote ma-agent:1 targets forbid overrides.', 'Success confirms admission and returns agentId, sessionId, messageId and effectiveConfig; it does not mean the turn finished.', 'If admission is unconfirmed, inspect session list/get and do not automatically resend.'), flags: ['agent', 'agentId', 'prompt', 'promptFile', 'noReply', 'runtime', 'providerId', 'model', 'reasoningEffort', 'permissionMode'], maxPositionals: 0 },
  { command: 'session send', route: 'session/send', usage: 'myagents session send <sessionId> (--prompt <text> | --prompt-file <path|->) [--json]', help: publicHelp('Admit a prompt to an existing Session.', 'Mutates the target Session and starts or resumes an AI turn asynchronously.', 'Success confirms delivery and returns messageId; it does not mean the turn finished.', 'If admission is unconfirmed, inspect session get and do not automatically resend.'), flags: ['toSessionId', 'to', 'prompt', 'promptFile', 'noReply'], maxPositionals: 1 },
  { command: 'session state', route: 'session/state', usage: 'myagents session state <sessionId> [--json]', help: publicHelp('Read idle, running or waiting_user_action from the current Session owner. waiting_user_action requires the target user to approve, confirm or answer before root work continues.', 'Read-only; never wakes the model or approves an interaction.', 'Unreadable state returns a query error; idle does not imply success.', READ_ONLY_RECOVERY), flags: ['sessionId'], maxPositionals: 1 },
  { command: 'session get', route: 'session/get', usage: 'myagents session get <sessionId> [--limit 1..500] [--before <messageId>] [--json]', help: publicHelp('Read a Session text page from its live owner or durable snapshot.', 'Read-only; filters tool calls, thinking and non-text blocks.', 'Returns text messages, pagination state and whether the projection is live.', READ_ONLY_RECOVERY), flags: ['sessionId', 'limit', 'before'], maxPositionals: 1 },
  { command: 'task list', route: 'task/list', usage: 'myagents task list (--workspaceId <id> | --workspacePath <path>) [--query <text>] [--limit 1..200] [--json]', help: publicHelp('List Tasks in one explicitly selected registered workspace.', 'Read-only; does not start AI or change Task state.', 'Returns matching Tasks; either workspace selector is sufficient and a supplied pair must match.', READ_ONLY_RECOVERY), flags: ['workspaceId', 'workspacePath', 'status', 'tag', 'query', 'limit', 'includeDeleted'], maxPositionals: 0 },
  { command: 'task notification', route: 'task/notification', usage: 'myagents task notification <taskId> --deliveryId <id> --action retry|resend|cancel [--json]', help: publicHelp('Retry or cancel one Task notification.', 'Changes only delivery, never reruns the task. Resend may duplicate an unconfirmed message.', 'Returns the stored notification receipt.', 'Inspect task get before repeating a delivery operation.'), flags: ['id', 'deliveryId', 'action'], maxPositionals: 1 },
  { command: 'task get', route: 'task/get', usage: 'myagents task get <taskId> [--json]', help: publicHelp('Read one Task by stable id.', 'Read-only; TaskStore resolves its workspace globally.', 'Returns the Task definition and current state.', READ_ONLY_RECOVERY), flags: ['id'], maxPositionals: 1 },
  { command: 'task comments', route: 'task/comments', usage: 'myagents task comments <taskId> [--before <commentId>] [--limit 1..100] [--json]', help: publicHelp('Read paginated Task comments.', 'Read-only; does not start AI or change Task state.', 'Returns comments and pagination information.', READ_ONLY_RECOVERY), flags: ['id', 'before', 'limit'], maxPositionals: 1 },
  { command: 'task create-direct', route: 'task/create-direct', usage: 'myagents task create-direct --name <name> (--workspaceId <id> | --workspacePath <path>) (--taskMdFile <path> | --taskMdContentFile <path> | --taskMdContent <text>) [--json]', help: publicHelp('Create a Task directly in one registered workspace.', 'Writes Task definition and schedule; AI runs only when the configured execution is dispatched.', 'Returns the stable Task id and stored Task state.', 'Inspect task list before retrying if the response is interrupted.'), flags: ['workspaceId', 'workspacePath', 'sourceRecordId', 'deadline', 'maxExecutions', 'aiCanExit', ...TASK_SCHEDULE_FLAGS], maxPositionals: 0 },
  { command: 'task update', route: 'task/update', usage: 'myagents task update <taskId> [--json]', help: publicHelp('Patch fields on an existing Task.', 'Writes only supplied Task fields; it does not itself start AI.', 'Returns the updated Task state.', 'Read task get to confirm state before retrying an interrupted mutation.'), flags: ['id', ...TASK_SCHEDULE_FLAGS, 'clearProviderOverride', 'clearRuntimeOverride', 'clearMcpOverride', 'clearTrigger'], maxPositionals: 1 },
  { command: 'task update-status', route: 'task/update-status', usage: 'myagents task update-status <taskId> <status> [--message <text>] [--json]', help: publicHelp('Apply an explicit Task lifecycle status.', 'Writes Task state and optional audit message; does not directly start AI.', 'Returns the updated lifecycle state.', 'Read task get before retrying an interrupted mutation.'), flags: ['message'], minPositionals: 2, maxPositionals: 2 },
  { command: 'task run', route: 'task/run', usage: 'myagents task run <taskId> [--json]', help: publicHelp('Dispatch a Task execution now.', 'Starts an AI Task run asynchronously using the stored Task configuration.', 'Success is an accepted-run receipt, not terminal completion.', 'Inspect task runs before retrying an interrupted request.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task rerun', route: 'task/rerun', usage: 'myagents task rerun <taskId> [--json]', help: publicHelp('Dispatch another execution of a Task.', 'Starts an AI Task run asynchronously using the stored Task configuration.', 'Success is an accepted-run receipt, not terminal completion.', 'Inspect task runs before retrying an interrupted request.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task run-now', route: 'task/run-now', usage: 'myagents task run-now <taskId> [--json]', help: publicHelp('Dispatch a Task execution immediately.', 'Starts an AI Task run asynchronously using the stored Task configuration.', 'Success is an accepted-run receipt, not terminal completion.', 'Inspect task runs before retrying an interrupted request.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task start', route: 'task/start', usage: 'myagents task start <taskId> [--json]', help: publicHelp('Enable a stopped Task schedule.', 'Writes Task scheduling state; it does not guarantee an immediate AI run.', 'Returns the updated scheduling state.', 'Read task get before retrying an interrupted mutation.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task stop', route: 'task/stop', usage: 'myagents task stop <taskId> [--json]', help: publicHelp('Stop a Task.', 'Stops future scheduling and requests cancellation of the current active execution.', 'Returns the updated Task state or a precise stop diagnostic.', 'Read task get before retrying an interrupted mutation.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task runs', route: 'task/runs', usage: 'myagents task runs <taskId> [--limit N] [--full] [--json]', help: publicHelp('Read execution history for one Task.', 'Read-only; does not start AI or change Task state.', 'Returns recent run receipts and statuses; --full includes full stored entries.', READ_ONLY_RECOVERY), flags: ['id', 'limit', 'full'], maxPositionals: 1 },
  { command: 'task trigger validate', route: 'task/trigger/validate', usage: 'myagents task trigger validate --spec-file <path> [--json]', help: publicHelp('Validate a detector trigger specification.', 'Runs validation only; it does not commit Task state or start AI.', 'Returns validation diagnostics.', READ_ONLY_RECOVERY), flags: ['specFile'], maxPositionals: 0 },
  { command: 'task trigger test', route: 'task/trigger/test', usage: 'myagents task trigger test (<taskId> | --spec-file <path> --workspacePath <path>) [--expect quiet|activate] [--json]', help: publicHelp('Execute a detector once for diagnosis.', 'Does not commit MyAgents checkpoint or activation state, but the detector command can have external side effects.', 'Returns detector output, decision and diagnostics.', 'Inspect detector diagnostics and external effects before running it again.'), flags: ['id', 'specFile', 'workspacePath', 'expect', 'checkpointFile'], maxPositionals: 1 },
  { command: 'task check-now', route: 'task/check-now', usage: 'myagents task check-now <taskId> [--json]', help: publicHelp('Run a detector-backed Task check immediately.', 'Updates checkpoint state and may asynchronously start AI when the detector activates.', 'Returns the detector outcome and accepted activation state.', 'Inspect task runs and task get before retrying an interrupted check.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task reset-checkpoint', route: 'task/reset-checkpoint', usage: 'myagents task reset-checkpoint <taskId> [--json]', help: publicHelp('Reset a detector Task checkpoint.', 'Writes detector checkpoint state; does not start AI.', 'Returns confirmation of the reset.', 'Read task get before retrying an interrupted reset.'), flags: ['id'], maxPositionals: 1 },
  { command: 'task append-session', route: 'task/append-session', usage: 'myagents task append-session <taskId> (<sessionId> | --sessionId <id>) [--json]', help: publicHelp('Attach a Session reference to a Task.', 'Writes Task history metadata; does not start AI.', 'Returns the updated Task/session association.', 'Read task get before retrying an interrupted mutation.'), flags: ['sessionId'], minPositionals: 1, maxPositionals: 2 },
  { command: 'task archive', route: 'task/archive', usage: 'myagents task archive <taskId> [--message <text>] [--json]', help: publicHelp('Archive a Task.', 'Writes Task lifecycle state and stops future normal use; does not start AI.', 'Returns the archived Task state.', 'Read task get before retrying an interrupted archive.'), flags: ['id', 'message'], maxPositionals: 1 },
  { command: 'task delete', route: 'task/delete', usage: 'myagents task delete <taskId> [--json]', help: publicHelp('Delete a Task through the TaskStore lifecycle.', 'Writes Task deletion state; does not start AI.', 'Returns deletion confirmation.', 'Read task list with --includeDeleted before retrying an interrupted delete.'), flags: ['id'], aliases: ['task remove'], maxPositionals: 1 },
  { command: 'task readme', route: 'readme/task', usage: 'myagents task readme [--json]', help: publicHelp('Read the bundled Task command guide.', 'Read-only; does not start AI or change state.', 'Returns the versioned Task guide text.', READ_ONLY_RECOVERY), flags: [], maxPositionals: 0 },
  { command: 'record list', route: 'record/list', usage: 'myagents record list [--kind text|audio] [--tag <tag>] [--query <text>] [--limit N] [--archived | --all] [--json]', help: publicHelp('List Records with optional filters.', 'Read-only; does not start AI or change Record state.', 'Returns matching text/audio Records.', READ_ONLY_RECOVERY), flags: ['kind', 'tag', 'query', 'limit', 'archived', 'all'], maxPositionals: 0 },
  { command: 'record get', route: 'record/get', usage: 'myagents record get <recordId> [--json]', help: publicHelp('Read a Record including its full content.', 'Read-only; uses the Host RecordStore.', 'Returns the stored Record.', READ_ONLY_RECOVERY), flags: ['id'], maxPositionals: 1 },
  { command: 'record delete', route: 'record/delete', usage: 'myagents record delete <recordId> [--json]', help: publicHelp('Delete one Record.', 'Cancels pending processing and removes the Record through the Host owner.', 'Returns a deletion receipt.', 'Inspect record list before retrying an interrupted deletion.'), flags: ['id'], maxPositionals: 1 },
  { command: 'record create', route: 'record/create', usage: 'myagents record create (--content-file <path> | --content <text> | <text>) [--json]', help: publicHelp('Create a text Record.', 'Writes a Record; does not start AI.', 'Returns the stable Record identity and stored content metadata.', 'Inspect record list before retrying if the response is interrupted.'), flags: ['content', 'contentFile'] },
] as const satisfies readonly ExternalCliPublicCapability[];

export type ExternalCliPublicRoute = typeof EXTERNAL_CLI_PUBLIC_CAPABILITIES[number]['route'];

export const EXTERNAL_CLI_PUBLIC_ROUTES: readonly ExternalCliPublicRoute[] =
  EXTERNAL_CLI_PUBLIC_CAPABILITIES.map(({ route }) => route);

const EXTERNAL_CLI_PUBLIC_ROUTE_SET = new Set<string>(EXTERNAL_CLI_PUBLIC_ROUTES);

export function isExternalCliPublicRoute(route: string): route is ExternalCliPublicRoute {
  return EXTERNAL_CLI_PUBLIC_ROUTE_SET.has(route);
}

export const EXTERNAL_CLI_PUBLIC_COMMANDS = (
  EXTERNAL_CLI_PUBLIC_CAPABILITIES as readonly ExternalCliPublicCapability[]
).flatMap(({ command, aliases = [] }) => [command, ...aliases]);

export function findExternalCliPublicCapability(
  positional: readonly string[],
): { capability: ExternalCliPublicCapability; commandLength: number } | undefined {
  const candidates = (
    EXTERNAL_CLI_PUBLIC_CAPABILITIES as readonly ExternalCliPublicCapability[]
  ).flatMap((capability) =>
    [capability.command, ...(capability.aliases ?? [])].map((command) => ({
      capability,
      commandParts: command.split(' '),
    })),
  ).sort((left, right) => right.commandParts.length - left.commandParts.length);
  const matched = candidates.find(({ commandParts }) =>
    commandParts.every((part, index) => positional[index] === part),
  );
  return matched
    ? { capability: matched.capability, commandLength: matched.commandParts.length }
    : undefined;
}

export const EXTERNAL_CLI_TOKEN_ENV = 'MYAGENTS_API_TOKEN';
export const INTERNAL_CLI_TOKEN_ENV = 'MYAGENTS_INTERNAL_CLI_TOKEN';
export const INTERNAL_CLI_TOKEN_HEADER = 'x-myagents-internal-cli-token';
