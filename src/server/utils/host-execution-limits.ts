/** Host opt-in limits apply to the real SDK Query; desktop behavior is unchanged. */
export function hostExecutionLimits(): { maxTurns?: number; maxBudgetUsd?: number } {
  if (process.env.MYAGENTS_HOST_MODE !== '1') return {};
  const maxTurns = Number(process.env.MYAGENTS_HOST_MAX_TURNS ?? '6');
  const maxBudgetUsd = Number(process.env.MYAGENTS_HOST_MAX_BUDGET_USD ?? '0.25');
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100
    || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0 || maxBudgetUsd > 10) {
    throw new Error('Host execution limits are invalid');
  }
  return { maxTurns, maxBudgetUsd };
}
