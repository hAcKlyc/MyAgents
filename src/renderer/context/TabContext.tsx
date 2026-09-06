/**
 * TabContext - React Context for per-Tab state isolation
 * 
 * Each Tab gets its own TabProvider which manages:
 * - Message history
 * - Loading state
 * - Session state
 * - Agent logs
 * - System init info
 * - SSE connection
 */

import { createContext, useContext } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { AgentStatusTodoSnapshot, Message } from '@/types/chat';
import type { LogEntry } from '@/types/log';
import type { QueuedMessageInfo } from '@/types/queue';
import type { SystemInitInfo } from '../../shared/types/system';
import type { RuntimeDiagnostics, RuntimeSource } from '../../shared/types/runtime';
import type { PermissionMode } from '@/config/types';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest, EnterPlanModeRequest } from '../../shared/types/planMode';
import type { TerminalReason } from '../../shared/terminalReason';
import type { SessionMetadata } from '@/api/sessionClient';
import type { ContextUsage } from '../../shared/types/context-usage';
import type { SlashCommand } from '../../shared/slashCommands';
import type { ProviderRoute } from '../../shared/providerRoute';
import type { ProductSystemSkillRequirement } from '../../shared/systemSkills';
import type { McpEffectiveSnapshot } from '../../shared/mcpEffectiveState';

type ChatProviderEnv = { providerId?: string; providerName?: string; baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { fable?: string; sonnet?: string; opus?: string; haiku?: string } };

export interface AdoptMigratedSessionOptions {
    /**
     * True when the backend/Rust side has already moved the live sidecar owner
     * to `newSessionId` (for example IM binding migration). False/omitted means
     * the renderer parent must first upgrade the Rust sidecar key before this
     * Tab can safely adopt the id.
     */
    sidecarAlreadyMigrated?: boolean;
}

// (issue #174) 'starting' = SDK subprocess launched, awaiting system_init.
// Distinct from 'running' (= AI actively processing a turn) so the UI can
// surface a "AI 启动中" hint instead of the generic thinking spinner during
// the up-to-10-minute startup-timeout window.
export type SessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export interface SystemNotice {
    kind: 'compact';
    level: 'success' | 'error';
    message: string;
}

export interface LoadOlderMessagesOptions {
    beforePrepend?: (visibleFreshCount: number) => void;
}

export interface CurrentSessionRestoreResult {
    restored: boolean;
    targetMessagePresent: boolean | null;
}

/**
 * Tab state - all the state that belongs to a single Tab
 */
export interface TabState {
    tabId: string;
    agentDir: string;
    sessionId: string | null;

    // Chat state
    messages: Message[];           // Combined view (history + streaming) for backward compat
    historyMessages: Message[];    // Immutable during streaming — zero re-render for history
    streamingMessage: Message | null;  // Only this updates during streaming
    // Pagination (session-load-time): initial load pulls the last N messages;
    // older pages load lazily as the user scrolls up.
    firstItemIndex: number;        // Absolute index of the first visible chat row in Virtuoso
    hasMoreBefore: boolean;        // True if there are older messages available on disk
    isLoading: boolean;
    /** Live active-query time, excluding unresolved human interaction waits. */
    getQueryElapsedSeconds: () => number;
    /**
     * True while a persisted Session is covered by its authoritative restore
     * shell. It starts before REST/SSE effects run and intentionally remains
     * true after failure until that target is recovered or abandoned.
     */
    isSessionLoading: boolean;
    /** Target-scoped persisted-restore failure; never reused for turn errors. */
    sessionRestoreError: string | null;
    /** Initial restore blocks first reveal; live recovery preserves the trusted projection. */
    sessionRestoreMode: 'initial' | 'live-recovery';
    sessionState: SessionState;
    sessionRuntime: string | null;  // Runtime that created this session (null = builtin)
    sessionRuntimeSource: RuntimeSource | null;
    /**
     * Full session metadata — includes v0.1.69 snapshot fields (model / permissionMode /
     * mcpEnabledServers / providerId / configSnapshotAt). Derivation source for Chat.tsx
     * `session ?? agent` precedence. Null while session is not loaded; populated after
     * persisted restore and refreshed after PATCH /sessions/:id.
     */
    sessionMeta: SessionMetadata | null;

    // Agent info
    logs: string[];
    unifiedLogs: LogEntry[];
    systemInitInfo: SystemInitInfo | null;
    mcpEffectiveSnapshot: McpEffectiveSnapshot | null;
    /**
     * Slash commands reported by the active builtin SDK subprocess. This is
     * the dynamic companion to the Rust workspace scan used by SimpleChatInput:
     * plugin skills/commands only exist after SDK plugin resolution, so they
     * arrive over SSE instead of from disk.
     */
    sdkSlashCommands: SlashCommand[];
    /**
     * Issue #194 — external-runtime self-report (auth / features / MCP / apps /
     * effective env). Populated when an external runtime emits the
     * `runtime_diagnostics` UnifiedEvent (Codex today; Claude Code / Gemini later).
     * Null for builtin runtime, and null until the first diagnostic snapshot
     * arrives after session start.
     */
    runtimeDiagnostics: RuntimeDiagnostics | null;
    agentError: string | null;
    systemStatus: string | null;  // SDK system status (e.g., 'compacting')
    systemNotice: SystemNotice | null;
    /**
     * PRD 0.2.32 — 归一化的「当前 context 窗口用量」快照。Set on `chat:context-usage`
     * (builtin 每轮末 / Codex 亚轮流式)，cleared on session switch / reset. Null until
     * the first usage snapshot arrives. Consumed by `<ContextUsageIndicator>` (tab-scoped,
     * 自取数，不穿 SimpleChatInput props 以免 textarea 重渲)。
     */
    contextUsage: ContextUsage | null;
    /**
     * Runtime-native plan/todo snapshot (Codex `turn/plan/updated` today).
     * Transient UI state only; ordinary chat history remains the source for
     * persisted builtin TodoWrite / Task tool todos.
     */
    agentPlanTodos: AgentStatusTodoSnapshot[] | null;
    /**
     * SDK 0.2.91+ terminal_reason of the last turn. Set on chat:message-complete,
     * cleared on next send / session load / reset. `completed` and missing reasons
     * are normalized to null (no banner needed). Typed as `TerminalReason | null`
     * (not `string | null`) so SDK upgrades that add enum values are caught by tsc
     * in consumers. `describeTerminalReason` still tolerates unknown strings at
     * runtime as forward-compat defense. See shared/terminalReason.ts.
     */
    lastTerminalReason: TerminalReason | null;

    // Permission prompt state
    pendingPermission: PermissionRequest | null;

    // AskUserQuestion prompt state
    pendingAskUserQuestion: AskUserQuestionRequest | null;

    // PlanMode prompt states
    pendingExitPlanMode: ExitPlanModeRequest | null;
    pendingEnterPlanMode: EnterPlanModeRequest | null;

    // File operation tool completion counter (triggers workspace refresh)
    toolCompleteCount: number;

    // Message queue state (messages waiting to be processed while AI is responding)
    queuedMessages: QueuedMessageInfo[];
}

/**
 * Tab context value - state + actions
 */
export interface TabContextValue extends TabState {
    // Message management
    setMessages: Dispatch<SetStateAction<Message[]>>;
    // NOTE: clearMessages() was removed from public API
    // Use resetSession() instead to ensure frontend/backend stay in sync

    // Loading state
    setIsLoading: Dispatch<SetStateAction<boolean>>;

    // Session state
    setSessionState: Dispatch<SetStateAction<SessionState>>;

    // Logs
    appendLog: (line: string) => void;
    appendUnifiedLog: (entry: LogEntry) => void;
    clearUnifiedLogs: () => void;

    // System info
    setSystemInitInfo: Dispatch<SetStateAction<SystemInitInfo | null>>;

    // Agent error
    setAgentError: Dispatch<SetStateAction<string | null>>;

    // SDK terminal_reason banner dismissal
    setLastTerminalReason: Dispatch<SetStateAction<TerminalReason | null>>;

    setSystemNotice: Dispatch<SetStateAction<SystemNotice | null>>;

    // v0.1.69 session snapshot — call after PATCH /sessions/:id to refresh derivation source
    setSessionMeta: Dispatch<SetStateAction<SessionMetadata | null>>;

    // SSE connection state — TabProvider owns the lifecycle internally; this
    // flag is the only piece of SSE state external consumers should depend on.
    // (Connect/disconnect are no longer exposed: a session-aware useEffect in
    // TabProvider drives both initial connect and session-switch reconnect, so
    // outside callers cannot accidentally race the owner.)
    isConnected: boolean;

    // Chat actions
    sendMessage: (text: string, images?: ImageAttachment[], permissionMode?: PermissionMode, model?: string, providerEnv?: ChatProviderEnv, isCron?: boolean, reasoningEffort?: string, providerRoute?: ProviderRoute, requiredSystemSkill?: ProductSystemSkillRequirement) => Promise<boolean>;
    stopResponse: () => Promise<{ success: boolean; alreadyStopped: boolean }>;
    retryCurrentSessionRestore: (targetMessageId?: string) => Promise<CurrentSessionRestoreResult>;
    /** Prepend the next page of older messages. Safe to call repeatedly — guarded internally. */
    loadOlderMessages: (options?: LoadOlderMessagesOptions) => Promise<void>;
    resetSession: () => Promise<boolean>;
    /**
     * Soft session swap for the IM-handover "新对话保留绑定" flow.
     *
     * Used when the Rust handover (`cmd_session_new_with_surface_migration`)
     * has ALREADY migrated the exact Tab + Agent owners and minted a fresh
     * session_id through the proof-bearing surface-migration endpoint. The renderer
     * MUST NOT call `resetSession()` afterwards — that would POST `/chat/reset`
     * and mint yet another session id, leaving the channel binding pointing
     * at the migrate-minted id while the tab adopts the second mint
     * (PRD 0.2.14 cross-bugfix; manifests as "tag disappears after 新对话").
     *
     * This helper does the local UI clear that resetSession does, swaps
     * `currentSessionId` to `newSessionId`, and notifies the parent via
     * `onSessionIdChange` so the SSE auto-reconnect effect picks up the new
     * session. No backend call is made.
     */
    adoptMigratedSession: (newSessionId: string, options?: AdoptMigratedSessionOptions) => Promise<boolean>;

    // Tab-scoped API functions (use this Tab's Sidecar)
    // `opts.signal` cancels the call from the renderer side (e.g., useEffect
    // cleanup on tab close) without surfacing a "Sidecar gone" warning.
    apiGet: <T>(path: string, opts?: { signal?: AbortSignal }) => Promise<T>;
    apiPost: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) => Promise<T>;
    apiPut: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) => Promise<T>;
    apiDelete: <T>(path: string, opts?: { signal?: AbortSignal }) => Promise<T>;

    // Permission handling
    respondPermission: (decision: 'deny' | 'allow_once' | 'always_allow', requestId?: string) => Promise<void>;

    // AskUserQuestion handling
    respondAskUserQuestion: (answers: Record<string, string> | null) => Promise<void>;

    // PlanMode handling.
    // `feedback` (issue #182): user's optional 「修改意见」 forwarded only on
    // rejection; lets the AI revise the plan in the same turn.
    // Returns true on success, false if the backend rejected the response or
    // the network failed — caller should toast and let the user retry.
    respondExitPlanMode: (approved: boolean, feedback?: string) => Promise<boolean>;

    // Queue actions
    cancelQueuedMessage: (queueId: string) => Promise<string | null>;
    forceExecuteQueuedMessage: (queueId: string) => Promise<boolean>;

    // Cron task exit event handler (set by useCronTask hook)
}

/**
 * Default context value (should never be used - TabProvider required)
 */
const defaultContextValue: TabContextValue = {
    tabId: '',
    agentDir: '',
    sessionId: null,
    messages: [],
    historyMessages: [],
    streamingMessage: null,
    firstItemIndex: 0,
    hasMoreBefore: false,
    isLoading: false,
    getQueryElapsedSeconds: () => 0,
    isSessionLoading: false,
    sessionRestoreError: null,
    sessionRestoreMode: 'initial',
    sessionState: 'idle',
    sessionRuntime: null,
    sessionRuntimeSource: null,
    sessionMeta: null,
    logs: [],
    unifiedLogs: [],
    systemInitInfo: null,
    mcpEffectiveSnapshot: null,
    sdkSlashCommands: [],
    runtimeDiagnostics: null,
    agentError: null,
    systemStatus: null,
    systemNotice: null,
    contextUsage: null,
    agentPlanTodos: null,
    lastTerminalReason: null,
    pendingPermission: null,
    pendingAskUserQuestion: null,
    pendingExitPlanMode: null,
    pendingEnterPlanMode: null,
    toolCompleteCount: 0,
    queuedMessages: [],
    isConnected: false,
    setMessages: () => { },
    setIsLoading: () => { },
    setSessionState: () => { },
    appendLog: () => { },
    appendUnifiedLog: () => { },
    clearUnifiedLogs: () => { },
    setSystemInitInfo: () => { },
    setAgentError: () => { },
    setLastTerminalReason: () => { },
    setSystemNotice: () => { },
    setSessionMeta: () => { },
    sendMessage: async () => false,
    stopResponse: async () => ({ success: false, alreadyStopped: true }),
    retryCurrentSessionRestore: async () => ({ restored: false, targetMessagePresent: null }),
    loadOlderMessages: async () => { },
    resetSession: async () => false,
    adoptMigratedSession: async () => false,
    apiGet: async () => { throw new Error('Not in TabProvider'); },
    apiPost: async () => { throw new Error('Not in TabProvider'); },
    apiPut: async () => { throw new Error('Not in TabProvider'); },
    apiDelete: async () => { throw new Error('Not in TabProvider'); },
    respondPermission: async () => { },
    respondAskUserQuestion: async () => { },
    respondExitPlanMode: async () => false,
    cancelQueuedMessage: async () => null,
    forceExecuteQueuedMessage: async () => false,
};

/**
 * TabContext - must be used within a TabProvider
 */
export const TabContext = createContext<TabContextValue>(defaultContextValue);

// ─── TabApiContext (lightweight, stable during streaming) ───

/**
 * Lightweight context containing only tabId, agentDir, and API functions.
 * This context does NOT include `messages` or other frequently-changing state,
 * so consumers subscribed to it won't re-render on every SSE chunk.
 */
export interface TabApiContextValue {
    tabId: string;
    agentDir: string;
    apiGet: <T>(path: string, opts?: { signal?: AbortSignal }) => Promise<T>;
    apiPost: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) => Promise<T>;
    apiPut: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) => Promise<T>;
    apiDelete: <T>(path: string, opts?: { signal?: AbortSignal }) => Promise<T>;
}

const defaultApiContextValue: TabApiContextValue = {
    tabId: '',
    agentDir: '',
    apiGet: async () => { throw new Error('Not in TabProvider'); },
    apiPost: async () => { throw new Error('Not in TabProvider'); },
    apiPut: async () => { throw new Error('Not in TabProvider'); },
    apiDelete: async () => { throw new Error('Not in TabProvider'); },
};

export const TabApiContext = createContext<TabApiContextValue>(defaultApiContextValue);

// ─── TabActiveContext (isolated from main context to prevent re-render cascade) ───

/**
 * Separate context for Tab active state.
 * isActive changes on every Tab switch. If it were in the main TabContext,
 * switching tabs would rebuild the entire context object and force ALL
 * useTabState() consumers (Chat, MessageList, SimpleChatInput…) to re-render.
 * Isolating it means only useTabActive() subscribers re-render on tab switch.
 */
export const TabActiveContext = createContext<boolean>(false);

// ─── Hooks ───

/**
 * Hook to access Tab state - throws if used outside TabProvider
 */
export function useTabState(): TabContextValue {
    const context = useContext(TabContext);
    if (!context.tabId) {
        throw new Error('useTabState must be used within a TabProvider');
    }
    return context;
}

/**
 * Hook to check if inside a TabProvider (safe version)
 *
 * Returns the TabContext value if inside a TabProvider, null otherwise.
 * Use this in components that may or may not be rendered within a Tab context.
 */
export function useTabStateOptional(): TabContextValue | null {
    const context = useContext(TabContext);
    return context.tabId ? context : null;
}

/**
 * Hook to access only Tab API functions (lightweight, stable during streaming).
 * Use this in components that only need tabId + API functions to avoid
 * unnecessary re-renders when messages/loading state changes.
 * Throws if used outside TabProvider.
 */
export function useTabApi(): TabApiContextValue {
    const context = useContext(TabApiContext);
    if (!context.tabId) {
        throw new Error('useTabApi must be used within a TabProvider');
    }
    return context;
}

/**
 * Safe version of useTabApi - returns null if outside TabProvider.
 * Use this in components that may or may not be rendered within a Tab context.
 */
export function useTabApiOptional(): TabApiContextValue | null {
    const context = useContext(TabApiContext);
    return context.tabId ? context : null;
}

/**
 * Hook to access Tab active state (whether this Tab is currently visible).
 * Isolated from main context so Tab switches don't trigger re-renders
 * in all useTabState() consumers.
 */
export function useTabActive(): boolean {
    return useContext(TabActiveContext);
}
