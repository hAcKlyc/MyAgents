import { describe, expect, it } from 'vitest';

import {
  hasRecentSessionActivity,
  shouldRecordAdmissionActivity,
  shouldRecordTerminalActivity,
  type SessionActivityTurnFacts,
} from './session-activity-policy';

const desktop: SessionActivityTurnFacts = {
  origin: { kind: 'desktop', surface: 'launcher_input' },
  inputText: 'ship it',
};

describe('session activity policy', () => {
  it.each([
    ['desktop', desktop],
    ['Space issue delivery', { origin: { kind: 'registered-agent', surface: 'space_issue_delivery', context: { spaceId: 'space-1', registeredAgentId: 'ra-1' } }, inputText: '<system-reminder>hidden</system-reminder>Issue ready' }],
    ['cron', { origin: { kind: 'automation', surface: 'cron' }, inputText: '<system-reminder><CRON_TASK>run</CRON_TASK></system-reminder>' }],
    ['task', { origin: { kind: 'automation', surface: 'task_run' }, inputText: 'run task' }],
    ['Goal', { origin: { kind: 'desktop', surface: 'task_center' }, inputText: '<system-reminder><GOAL_CONTEXT>goal</GOAL_CONTEXT></system-reminder>Advance goal' }],
    ['session inbox', { origin: { kind: 'session-inbox', surface: 'session_send' }, inputText: 'delegated work' }],
    ['attachment-only desktop', { origin: { kind: 'desktop', surface: 'launcher_input' }, inputText: '' }],
  ] satisfies Array<[string, SessionActivityTurnFacts]>)('records meaningful %s turns at admission and terminal', (_name, facts) => {
    expect(shouldRecordAdmissionActivity(facts)).toBe(true);
    expect(shouldRecordTerminalActivity(facts, { text: '' })).toBe(true);
  });

  it.each([
    ['memory origin', { origin: { kind: 'automation', surface: 'memory_update' }, inputText: 'update memory' }],
    ['legacy memory reminder', { inputText: '<system-reminder><MEMORY_UPDATE>maintain</MEMORY_UPDATE></system-reminder>' }],
    ['memory gardener', { origin: { kind: 'automation', surface: 'cron' }, inputText: 'maintain', systemMaintenanceKind: 'memory_gardener' }],
    ['memory molt', { origin: { kind: 'automation', surface: 'task_run' }, inputText: 'maintain', systemMaintenanceKind: 'memory_molt' }],
  ] satisfies Array<[string, SessionActivityTurnFacts]>)('does not record %s', (_name, facts) => {
    expect(shouldRecordAdmissionActivity(facts)).toBe(false);
    expect(shouldRecordTerminalActivity(facts, { text: 'completed' })).toBe(false);
  });

  it('keeps a silent heartbeat out of recency', () => {
    const facts: SessionActivityTurnFacts = {
      origin: { kind: 'agent-channel', surface: 'channel_heartbeat' },
      inputText: '<system-reminder><HEARTBEAT>check</HEARTBEAT></system-reminder>',
    };

    expect(shouldRecordAdmissionActivity(facts)).toBe(false);
    expect(shouldRecordTerminalActivity(facts, { text: '**HEARTBEAT_OK**' })).toBe(false);
    expect(shouldRecordTerminalActivity(facts, { text: '<strong>HEARTBEAT_OK</strong>\n' })).toBe(false);
  });

  it('records heartbeat visible work at both boundaries', () => {
    const facts: SessionActivityTurnFacts = {
      origin: { kind: 'agent-channel', surface: 'channel_heartbeat' },
      inputText: '<system-reminder><HEARTBEAT>relay</HEARTBEAT></system-reminder>Follow up on build failure',
    };

    expect(shouldRecordAdmissionActivity(facts)).toBe(true);
    expect(shouldRecordTerminalActivity(facts, { text: 'HEARTBEAT_OK' })).toBe(true);
  });

  it('treats plain relay text as visible work when heartbeat origin is authoritative', () => {
    const facts: SessionActivityTurnFacts = {
      origin: { kind: 'agent-channel', surface: 'channel_heartbeat' },
      inputText: 'Relay this completed task to the user',
    };

    expect(shouldRecordAdmissionActivity(facts)).toBe(true);
    expect(shouldRecordTerminalActivity(facts, { text: 'HEARTBEAT_OK' })).toBe(true);
  });

  it('records substantive heartbeat output independently of delivery ack length', () => {
    const facts: SessionActivityTurnFacts = {
      origin: { kind: 'agent-channel', surface: 'channel_heartbeat' },
      inputText: '<system-reminder><HEARTBEAT>check</HEARTBEAT></system-reminder>',
    };

    expect(shouldRecordAdmissionActivity(facts)).toBe(false);
    expect(shouldRecordTerminalActivity(facts, { text: '`HEARTBEAT_OK` failed' })).toBe(true);
    expect(shouldRecordTerminalActivity(facts, { text: 'HEARTBEAT_OK x' })).toBe(true);
  });

  it('uses reminder kind only for unknown legacy origins', () => {
    const unknownHeartbeat: SessionActivityTurnFacts = {
      origin: { kind: 'unknown', surface: 'unknown' },
      inputText: '<system-reminder><HEARTBEAT>check</HEARTBEAT></system-reminder>',
    };
    const explicitDesktop: SessionActivityTurnFacts = {
      origin: { kind: 'desktop', surface: 'launcher_input' },
      inputText: '<system-reminder><HEARTBEAT>quoted context</HEARTBEAT></system-reminder>',
    };

    expect(shouldRecordAdmissionActivity(unknownHeartbeat)).toBe(false);
    expect(shouldRecordAdmissionActivity(explicitDesktop)).toBe(true);
  });

  it.each(['complete', 'stopped', 'error'] as const)('records meaningful %s terminal outcomes', (status) => {
    expect(shouldRecordTerminalActivity(desktop, { text: status })).toBe(true);
  });
});

it('defers maintenance after recent work, with legacy timestamp compatibility', () => {
  const now = Date.parse('2026-11-06T01:00:00Z');
  expect(hasRecentSessionActivity('2026-11-06T00:59:41Z', now)).toBe(true);
  expect(hasRecentSessionActivity('2026-11-06T00:30:00Z', now)).toBe(false);
  expect(hasRecentSessionActivity('2026-11-06T01:01:00Z', now)).toBe(true);
  expect(hasRecentSessionActivity(undefined, now)).toBe(false);
  expect(hasRecentSessionActivity('invalid', now)).toBe(false);
});
