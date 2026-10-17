import type { ProgressTodo } from '../../../shared/sessionWorkProgress';
import type { InteractionScenario } from '../../system-prompt';
import type { TurnAnalyticsSource } from '../../types/session';
import type { RuntimeType } from '../../../shared/types/runtime';
import type { SystemInitInfo } from '../../../shared/types/system';
import type { SessionOrigin } from '../../../shared/session-origin';
import type { OfficialToolId } from '../../../shared/official-tools';
import { invalidateMcpEffectiveSnapshot, type McpEffectiveSnapshot } from '../../../shared/mcpEffectiveState';
import type { AgentRuntime, RuntimeProcess } from '../types';
import type { ExternalSessionState, ExternalSystemInitPayload } from './types';

let activeProcess: RuntimeProcess | null = null;
let activeRuntime: AgentRuntime | null = null;
let activeOfficialToolIds: OfficialToolId[] | null = null;
let activeCapabilityRevision: string | null = null;
let isRunning = false;
let startingPromise: Promise<void> | null = null;
let startingSessionId: string | null = null;
let userRequestedExternalStop = false;

let lastSessionId = '';
let lastWorkspacePath = '';
let lastScenario: InteractionScenario = { type: 'desktop' };
let lastAnalyticsSource: TurnAnalyticsSource = 'desktop';
let lastAnalyticsOrigin: SessionOrigin | null = null;
let lastRuntimeSessionId = '';

let externalSessionState: ExternalSessionState = 'idle';
let externalSystemInitPayload: ExternalSystemInitPayload | null = null;
let externalMcpEffectiveSnapshot: McpEffectiveSnapshot | null = null;
let externalMcpEffectiveRevision = 0;
let externalRuntimeGeneration = 0;
let isPrewarmingSession = false;
let liveRevision = 0;
let agentPlanTodos: readonly ProgressTodo[] | null = null;
export function setExternalAgentPlan(todos: readonly ProgressTodo[]): void { agentPlanTodos = todos.map(todo => ({ ...todo })); }
export function getExternalAgentPlan(): readonly ProgressTodo[] | null { return agentPlanTodos; }

export function resetExternalLifecycleState(): void {
  agentPlanTodos = null;
  activeProcess = null;
  activeRuntime = null;
  activeOfficialToolIds = null;
  activeCapabilityRevision = null;
  isRunning = false;
  startingPromise = null;
  startingSessionId = null;
  userRequestedExternalStop = false;
  lastRuntimeSessionId = '';
  lastAnalyticsSource = 'desktop';
  lastAnalyticsOrigin = null;
  externalSystemInitPayload = null;
  externalMcpEffectiveSnapshot = null;
  externalMcpEffectiveRevision = 0;
  externalRuntimeGeneration += 1;
  externalSessionState = 'idle';
  isPrewarmingSession = false;
  liveRevision = 0;
}

export function nextExternalLiveRevision(): number {
  liveRevision += 1;
  return liveRevision;
}

export function getExternalLiveRevision(): number {
  return liveRevision;
}

/** Native callback authority survives turn boundaries, but not a process reset. */
export function getExternalRuntimeGeneration(): number {
  return externalRuntimeGeneration;
}

export async function awaitExternalLifecycleStarting(): Promise<void> {
  if (startingPromise) {
    await startingPromise;
  }
}

export function isExternalLifecycleStarting(): boolean {
  return Boolean(startingPromise);
}

export function beginExternalLifecycleStart(sessionId: string): () => void {
  externalRuntimeGeneration += 1;
  externalMcpEffectiveRevision = 0;
  externalMcpEffectiveSnapshot = null;
  let resolveStarting!: () => void;
  startingPromise = new Promise<void>((resolve) => {
    resolveStarting = resolve;
  });
  startingSessionId = sessionId;
  return () => {
    startingPromise = null;
    startingSessionId = null;
    resolveStarting();
  };
}

export function updateExternalLifecycleStartingSessionId(expected: string, next: string): void {
  if (startingSessionId === expected) {
    startingSessionId = next;
  }
}

export function setExternalActiveRuntime(runtime: AgentRuntime | null): void {
  activeRuntime = runtime;
}

export function getExternalActiveRuntime(): AgentRuntime | null {
  return activeRuntime;
}

export function setExternalActiveProcess(
  process: RuntimeProcess | null,
  officialToolIds: readonly OfficialToolId[],
  capabilityRevision?: string,
): void {
  activeProcess = process;
  activeOfficialToolIds = process ? [...officialToolIds] : null;
  activeCapabilityRevision = process ? capabilityRevision ?? null : null;
}

export function getExternalActiveProcess(): RuntimeProcess | null {
  return activeProcess;
}

export function getExternalActiveOfficialToolIds(): readonly OfficialToolId[] | null {
  return activeOfficialToolIds;
}

export function getExternalActiveCapabilityRevision(): string | null {
  return activeCapabilityRevision;
}

export function getExternalActivePair(): { runtime: AgentRuntime; process: RuntimeProcess } | null {
  if (!activeRuntime || !activeProcess) return null;
  return { runtime: activeRuntime, process: activeProcess };
}

export function clearExternalActiveRuntimeProcess(): void {
  activeProcess = null;
  activeRuntime = null;
  activeOfficialToolIds = null;
  activeCapabilityRevision = null;
  isRunning = false;
}

export function setExternalLifecycleRunning(value: boolean): void {
  isRunning = value;
}

export function isExternalLifecycleRunning(): boolean {
  return isRunning;
}

export function isExternalLifecycleActive(): boolean {
  return isRunning && activeProcess !== null && !activeProcess.exited;
}

export function bindExternalSessionContext(input: {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource;
  analyticsOrigin?: SessionOrigin | null;
}): void {
  if (lastSessionId !== input.sessionId) {
    agentPlanTodos = null;
    liveRevision = 0;
    externalMcpEffectiveRevision = 0;
    externalMcpEffectiveSnapshot = null;
  }
  lastSessionId = input.sessionId;
  lastWorkspacePath = input.workspacePath;
  lastScenario = input.scenario;
  lastAnalyticsSource = input.analyticsSource ?? input.scenario.type;
  lastAnalyticsOrigin = input.analyticsOrigin ?? null;
}

export function getExternalLifecycleSessionId(): string {
  return lastSessionId;
}

export function getExternalLifecycleWorkspacePath(): string {
  return lastWorkspacePath;
}

export function getExternalLifecycleScenario(): InteractionScenario {
  return lastScenario;
}

export function setExternalLifecycleScenario(scenario: InteractionScenario): void {
  lastScenario = scenario;
}

export function getExternalLifecycleAnalyticsSource(): TurnAnalyticsSource {
  return lastAnalyticsSource;
}

export function setExternalLifecycleAnalyticsSource(source: TurnAnalyticsSource): void {
  lastAnalyticsSource = source;
}

export function getExternalLifecycleAnalyticsOrigin(): SessionOrigin | null {
  return lastAnalyticsOrigin;
}

export function setExternalLifecycleAnalyticsOrigin(origin: SessionOrigin | null): void {
  lastAnalyticsOrigin = origin;
}

export function setExternalRuntimeSessionId(id: string): void {
  lastRuntimeSessionId = id;
}

export function clearExternalRuntimeSessionId(): void {
  lastRuntimeSessionId = '';
}

export function getExternalRuntimeSessionId(): string {
  return lastRuntimeSessionId;
}

export function getCurrentExternalBoundSessionId(): string {
  return startingSessionId || lastSessionId;
}

export function setExternalLifecycleState(state: ExternalSessionState): void {
  externalSessionState = state;
}

export function getExternalLifecycleState(): ExternalSessionState {
  return externalSessionState;
}

export function setExternalSystemInitPayload(payload: ExternalSystemInitPayload | null): void {
  externalSystemInitPayload = payload;
}

export function getExternalSystemInitPayloadSnapshot(): ExternalSystemInitPayload | null {
  return externalSystemInitPayload;
}

export function setExternalMcpEffectiveSnapshot(
  snapshot: Omit<McpEffectiveSnapshot, 'sessionId' | 'runtime' | 'runtimeSource' | 'runtimeGeneration' | 'revision'>,
  runtime: RuntimeType,
  runtimeSource?: import('../../../shared/types/runtime').RuntimeSource,
): McpEffectiveSnapshot {
  externalMcpEffectiveRevision += 1;
  externalMcpEffectiveSnapshot = {
    ...snapshot,
    sessionId: lastSessionId,
    runtime,
    ...(runtimeSource ? { runtimeSource } : {}),
    runtimeGeneration: externalRuntimeGeneration,
    revision: externalMcpEffectiveRevision,
  };
  return externalMcpEffectiveSnapshot;
}

export function getExternalMcpEffectiveSnapshot(): McpEffectiveSnapshot | null {
  return externalMcpEffectiveSnapshot
    ? {
        ...externalMcpEffectiveSnapshot,
        dispatch: { ...externalMcpEffectiveSnapshot.dispatch },
        servers: externalMcpEffectiveSnapshot.servers.map(server => ({ ...server })),
        tools: [...externalMcpEffectiveSnapshot.tools],
      }
    : null;
}

export function invalidateExternalMcpEffectiveSnapshot(): McpEffectiveSnapshot | null {
  if (!externalMcpEffectiveSnapshot) return null;
  externalMcpEffectiveSnapshot = invalidateMcpEffectiveSnapshot(externalMcpEffectiveSnapshot);
  externalMcpEffectiveRevision = externalMcpEffectiveSnapshot.revision;
  return getExternalMcpEffectiveSnapshot();
}

export function setExternalPrewarmingSession(value: boolean): void {
  isPrewarmingSession = value;
}

export function isExternalPrewarmingSession(): boolean {
  return isPrewarmingSession;
}

export function clearExternalPrewarmingSession(): void {
  isPrewarmingSession = false;
  if (externalSystemInitPayload) {
    externalSystemInitPayload = { ...externalSystemInitPayload, prewarm: undefined };
  }
}

export function markExternalUserRequestedStop(): void {
  userRequestedExternalStop = true;
}

export function getExternalUserRequestedStop(): boolean {
  return userRequestedExternalStop;
}

export function resetExternalUserRequestedStop(): void {
  userRequestedExternalStop = false;
}

export function buildExternalSystemInitPayload(input: {
  info: SystemInitInfo;
  runtime: RuntimeType;
  runtimeSource?: import('../../../shared/types/runtime').RuntimeSource;
}): ExternalSystemInitPayload {
  return {
    info: { ...input.info },
    sessionId: lastSessionId,
    prewarm: isPrewarmingSession || undefined,
    runtime: input.runtime,
    runtimeSource: input.runtimeSource,
  };
}
