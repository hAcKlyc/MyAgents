import { APP_CLI_NAME } from '../../shared/appProfile';
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from '../../shared/systemReminder';
import { neutralizeInboxStructuralTags, sanitizeInboxLabel } from '../inbox/sanitize-label';

export interface CronRelayEvent {
  event: string;
  content: string;
  timestamp: number;
  taskId?: string;
  fromSessionId?: string;
  fromLabel?: string;
}

export interface CronRelayMessageOptions {
  now?: string;
}

const VISIBLE_CRON_RELAY_NOTICE = '[System]收到来自系统投送的信息';
const CRON_RELAY_STRUCTURAL_TAGS = [
  'system-reminder',
  'HEARTBEAT',
  'instruction',
  'task-meta',
  'task-result',
];

const TAG_BRACKET_OPEN = '[<\\uFF1C]';
const TAG_BRACKET_CLOSE = '[>\\uFF1E]';

function currentLocalTime(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function escapeTagText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function neutralizeSystemReminderStructuralTags(body: string): string {
  let safe = neutralizeInboxStructuralTags(body);
  for (const tag of CRON_RELAY_STRUCTURAL_TAGS) {
    safe = safe
      .replace(
        new RegExp(`${TAG_BRACKET_OPEN}/${tag}\\s*${TAG_BRACKET_CLOSE}`, 'gi'),
        `&lt;/${tag}&gt;`,
      )
      .replace(
        new RegExp(`${TAG_BRACKET_OPEN}${tag}\\b`, 'gi'),
        `&lt;${tag}`,
      );
  }
  return safe;
}

function wrapInboxIfNeeded(e: CronRelayEvent): string {
  const safeBody = neutralizeSystemReminderStructuralTags(e.content);
  if (!e.fromSessionId || !e.fromLabel) return safeBody;
  const label = sanitizeInboxLabel(e.fromLabel);
  return `<inbox-message from="${label}" reply_back="false">\n${safeBody}\n</inbox-message>`;
}

function taskMetaLines(e: CronRelayEvent, now: string): string[] {
  const lines = [`Task id: ${escapeTagText(e.taskId || 'unknown')}`];
  if (e.fromSessionId) {
    const sid = escapeTagText(e.fromSessionId);
    lines.push(`Source session id: ${sid} (use \`${APP_CLI_NAME} session send ${sid} -p "..."\` to follow up)`);
  }
  lines.push(`Current time: ${escapeTagText(now)}`);
  return lines;
}

function taskBlock(e: CronRelayEvent, now: string): string[] {
  return [
    '<task-meta>',
    ...taskMetaLines(e, now),
    '</task-meta>',
    '<task-result>',
    wrapInboxIfNeeded(e),
    '</task-result>',
  ];
}

export function buildCronEventRelayMessage(
  cronEvents: CronRelayEvent[],
  options: CronRelayMessageOptions = {},
): string {
  const now = options.now ?? currentLocalTime();
  const instruction = cronEvents.length === 1
    ? 'A scheduled task has been triggered and completed. Please relay these results to the user in a helpful and friendly way.'
    : 'Scheduled tasks have been triggered and completed. Please relay these results to the user in a helpful and friendly way.';

  return [
    SYSTEM_REMINDER_OPEN,
    '<HEARTBEAT>',
    '<instruction>',
    instruction,
    '</instruction>',
    ...cronEvents.flatMap((event) => taskBlock(event, now)),
    '</HEARTBEAT>',
    SYSTEM_REMINDER_CLOSE,
    VISIBLE_CRON_RELAY_NOTICE,
  ].join('\n');
}
