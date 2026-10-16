import { z } from 'zod';
import { VALID_RUNTIMES } from '@/../shared/types/runtime';
import type { CronTaskDraftConfig } from '@/types/cronTask';
import type { SessionGoalDraftConfig } from '@/types/sessionGoal';

/** Creation drafts only. Restoring this data never admits a Task or Goal. */
export type ComposerWorkflowDraft =
  | { kind: 'goal'; config: SessionGoalDraftConfig }
  | { kind: 'scheduled'; config: CronTaskDraftConfig };

const endConditions = z.strictObject({
  deadline: z.string().optional(), maxExecutions: z.number().optional(), aiCanExit: z.boolean(),
});
const runtime = z.enum(VALID_RUNTIMES).optional();
const runtimeConfig = z.strictObject({
  source: z.enum(['integrated', 'system-cli', 'managed-provider']).optional(),
  model: z.string().optional(), permissionMode: z.string().optional(),
  reasoningEffort: z.string().optional(), additionalArgs: z.array(z.string()).optional(),
  envPolicy: z.strictObject({ proxy: z.enum(['myagents', 'terminal']).optional() }).optional(),
});
const schedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: z.string() }),
  z.strictObject({ kind: z.literal('every'), minutes: z.number(), startAt: z.string().optional(),
    catchUpWindow: z.strictObject({ timezone: z.string(), start: z.string(), end: z.string() }).optional() }),
  z.strictObject({ kind: z.literal('cron'), expr: z.string(), tz: z.string().optional() }),
  z.strictObject({ kind: z.literal('loop') }),
]);

// Strict shapes preserve configuration without silently flattening unknown
// fields or copying legacy providerEnv credentials into the handoff.
export const composerWorkflowDraftSchema: z.ZodType<ComposerWorkflowDraft> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('goal'), config: z.strictObject({
    taskKind: z.literal('goal'), prompt: z.string(), endConditions, notifyEnabled: z.boolean(),
    permissionMode: z.string().optional(), runtime,
  }) }),
  z.strictObject({ kind: z.literal('scheduled'), config: z.strictObject({
    taskKind: z.enum(['cron', 'goal']), prompt: z.string(), intervalMinutes: z.number(),
    endConditions, runMode: z.enum(['single_session', 'new_session']), notifyEnabled: z.boolean(),
    model: z.string().optional(), permissionMode: z.string().optional(), providerId: z.string().optional(),
    runtime, runtimeConfig: runtimeConfig.optional(), schedule: schedule.optional(),
    executionTarget: z.enum(['current_session', 'new_task']).optional(),
    delivery: z.strictObject({ botId: z.string(), chatId: z.string(), platform: z.string() }).optional(),
    mcpEnabledServers: z.array(z.string()).optional(),
  }) }),
]);
