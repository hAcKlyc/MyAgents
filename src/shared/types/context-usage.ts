/**
 * 归一化的「当前 context 窗口用量」快照（PRD 0.2.32）。
 *
 * 当前 runtime（builtin / DSH / Codex / Claude Code）取数姿势不同，但都收敛到这
 * 一个 shape，前端用单一 `<ContextUsageIndicator>` 消费。归一化逻辑只在
 * `src/shared/contextUsage.ts::computeContextUsage` 一处纯函数里。
 *
 * 设计要点：
 * - 占用 = **最近一次 API 调用**的 input 系 token（非整 turn 聚合，避免多步工具轮高估）。
 *   两系 cache 语义相反：Anthropic 系（builtin/CC）`input` 不含 cache 需相加；
 *   OpenAI 系（Codex）`inputTokens` 已含 cached，不再加。详见 PRD §3.2。
 * - 分母永远有值：`runtime 报的窗口 ?? registry 查到 ?? 200K`，表示 runtime 窗口或明确标注的 API 压缩预算；
 *   builtin auto-compact 阈值由共享的 90% policy 单独投影，故 `contextWindow` / `usedPercent` 非空。
 */
export interface ContextUsage {
  /** 当前占用 token（最近一次调用的 input[+cache，按系]）。 */
  contextTokens: number;
  /** 有效窗口（分母）。永远有值，最低回落到 SDK 默认 200K。 */
  contextWindow: number;
  /** `min(100, contextTokens / contextWindow * 100)`。 */
  usedPercent: number;
  /** 产出该快照的 runtime。 */
  source: 'builtin' | 'dsh' | 'codex' | 'claude-code';
  /** 窗口来源：runtime 自报 / registry 查到 / 200K 兜底 / API 压缩预算。用于卡片底部弱灰说明。 */
  windowSource: 'runtime' | 'registry' | 'default' | 'safety-budget';
  /** Declared capacity, when a lower operational compaction budget is in use. */
  declaredContextWindow?: number;
  /** 当前模型 id（已 strip `[1m]` 之前的原值，仅展示用）。 */
  model?: string;
}
