import type { AntigravityChildSnapshot } from './antigravity-children';
import {
  decodeAntigravityGenericResult,
  decodeAntigravityPlannerText,
  decodeAntigravityPlannerToolCalls,
  decodeAntigravityToolCall,
  openAntigravityConversation,
  type AntigravityToolCall,
} from './antigravity-native-result';
import { presentAntigravityTool } from './antigravity-tool';
import type { SubAgentScope, UnifiedEvent, UnifiedEventCallback } from './types';

// Current agy CortexStepType and CortexStepStatus values in the native journal.
const PLANNER_RESPONSE = 15;
const GENERIC_TOOL = 132;
const TERMINAL_STATUS: ReadonlyMap<number, string> = new Map([
  [3, 'completed'], // DONE
  [4, 'failed'], // INVALID
  [5, 'stopped'], // CLEARED
  [6, 'cancelled'], // CANCELED
  [7, 'failed'], // ERROR
  [12, 'interrupted'],
]);

type ChildStep = {
  idx: number;
  step_type: number;
  status: number;
  metadata: Uint8Array | null;
  step_payload: Uint8Array | null;
};

function decodeArguments(argumentsJson: string | undefined): unknown {
  if (!argumentsJson) return;
  try {
    return JSON.parse(argumentsJson);
  } catch {
    // This planner tool call has an identity even if its value isn't valid JSON.
    return argumentsJson;
  }
}

function presentNativeCall(call: AntigravityToolCall) {
  return presentAntigravityTool({
    toolCallId: call.id,
    name: call.name,
    rawInput: decodeArguments(call.argumentsJson),
  });
}

/**
 * Incrementally project a bound detached child's committed native records.
 * This runs on the existing Antigravity child observation tick. Model text is
 * keyed by native step, and tool starts/results by the exact native call ID.
 */
export class AntigravityChildTrace {
  private lastStep = -1;
  private readonly pendingSteps = new Set<number>();
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly subAgent: SubAgentScope;

  constructor(private readonly child: AntigravityChildSnapshot) {
    this.subAgent = { parentToolUseId: child.toolCallId, role: child.role };
  }

  observe(brainDirectory: string, emit: UnifiedEventCallback): void {
    const database = openAntigravityConversation(brainDirectory, this.child.sessionId);
    if (!database) return;
    try {
      const readExisting = database.prepare('SELECT idx, step_type, status, metadata, step_payload FROM steps WHERE idx = ?');
      for (const idx of this.pendingSteps) {
        const step = readExisting.get(idx) as ChildStep | undefined;
        if (step) this.project(step, emit);
      }
      const readNew = database.prepare(`
        SELECT idx, step_type, status, metadata, step_payload FROM steps
        WHERE idx > ? AND step_type IN (${PLANNER_RESPONSE}, ${GENERIC_TOOL}) ORDER BY idx
      `);
      for (const row of readNew.iterate(this.lastStep)) {
        const step = row as ChildStep;
        this.project(step, emit);
        this.lastStep = step.idx;
      }
    } finally {
      database.close();
    }
  }

  private project(step: ChildStep, emit: UnifiedEventCallback): void {
    const terminal = TERMINAL_STATUS.get(step.status);
    if (!terminal) this.pendingSteps.add(step.idx);
    else this.pendingSteps.delete(step.idx);

    if (step.step_type === PLANNER_RESPONSE && terminal && step.step_payload) {
      const { text, thinking } = decodeAntigravityPlannerText(step.step_payload);
      const traceId = `${this.child.sessionId}:${step.idx}`;
      const subAgent = this.subAgent;
      if (thinking) {
        emit({ kind: 'thinking_start', index: step.idx, traceId, subAgent });
        emit({ kind: 'thinking_delta', index: step.idx, traceId, subAgent, text: thinking });
        emit({ kind: 'thinking_stop', index: step.idx, traceId, subAgent });
      }
      if (text) {
        emit({ kind: 'text_delta', traceId, subAgent, text });
        emit({ kind: 'text_stop', traceId, subAgent, nativeText: text });
      }
      for (const call of decodeAntigravityPlannerToolCalls(step.step_payload)) this.startTool(call, emit);
    }

    if (step.step_type !== GENERIC_TOOL || !step.metadata) return;
    const call = decodeAntigravityToolCall(step.metadata);
    if (!call || this.completedTools.has(call.id)) return;
    const toolUseId = this.startTool(call, emit);
    if (!terminal) return;
    const { input } = presentNativeCall(call);
    const result: Extract<UnifiedEvent, { kind: 'tool_result' }> = {
      kind: 'tool_result',
      toolUseId,
      content: step.step_payload ? decodeAntigravityGenericResult(step.step_payload) ?? '' : '',
      metadata: { status: terminal },
      isError: terminal !== 'completed',
      subAgent: this.subAgent,
    };
    emit({ kind: 'tool_use_stop', toolUseId, input, subAgent: this.subAgent });
    emit(result);
    this.completedTools.add(call.id);
  }

  private startTool(call: AntigravityToolCall, emit: UnifiedEventCallback): string {
    const toolUseId = `${this.child.sessionId}:${call.id}`;
    if (!this.startedTools.has(call.id)) {
      const { toolName, input } = presentNativeCall(call);
      emit({ kind: 'tool_use_start', toolUseId, toolName, input, subAgent: this.subAgent });
      this.startedTools.add(call.id);
    }
    return toolUseId;
  }
}
