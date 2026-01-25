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
import type { Message } from '@/types/chat';
import type { LogEntry } from '@/types/log';
import type { SystemInitInfo } from '../../shared/types/system';
import type { PermissionMode } from '@/config/types';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';

export type SessionState = 'idle' | 'running' | 'error';

/**
 * Tab state - all the state that belongs to a single Tab
 */
export interface TabState {
    tabId: string;
    agentDir: string;
    sessionId: string | null;

    // Chat state
    messages: Message[];
    isLoading: boolean;
    sessionState: SessionState;

    // Agent info
    logs: string[];
    unifiedLogs: LogEntry[];
    systemInitInfo: SystemInitInfo | null;
    agentError: string | null;
    systemStatus: string | null;  // SDK system status (e.g., 'compacting')

    // Tab active state (for focus management)
    isActive: boolean;

    // Permission prompt state
    pendingPermission: PermissionRequest | null;

    // AskUserQuestion prompt state
    pendingAskUserQuestion: AskUserQuestionRequest | null;

    // File operation tool completion counter (triggers workspace refresh)
    toolCompleteCount: number;
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

    // SSE connection management
    isConnected: boolean;
    connectSse: () => Promise<void>;
    disconnectSse: () => void;

    // Chat actions
    sendMessage: (text: string, images?: ImageAttachment[], permissionMode?: PermissionMode, model?: string, providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key' }) => Promise<boolean>;
    stopResponse: () => Promise<boolean>;
    loadSession: (sessionId: string) => Promise<boolean>;
    resetSession: () => Promise<boolean>;

    // Tab-scoped API functions (use this Tab's Sidecar)
    apiGet: <T>(path: string) => Promise<T>;
    apiPost: <T>(path: string, body?: unknown) => Promise<T>;

    // Permission handling
    respondPermission: (decision: 'deny' | 'allow_once' | 'always_allow') => Promise<void>;

    // AskUserQuestion handling
    respondAskUserQuestion: (answers: Record<string, string> | null) => Promise<void>;
}

/**
 * Default context value (should never be used - TabProvider required)
 */
const defaultContextValue: TabContextValue = {
    tabId: '',
    agentDir: '',
    sessionId: null,
    messages: [],
    isLoading: false,
    sessionState: 'idle',
    logs: [],
    unifiedLogs: [],
    systemInitInfo: null,
    agentError: null,
    systemStatus: null,
    isActive: false,
    pendingPermission: null,
    pendingAskUserQuestion: null,
    toolCompleteCount: 0,
    isConnected: false,
    setMessages: () => { },
    setIsLoading: () => { },
    setSessionState: () => { },
    appendLog: () => { },
    appendUnifiedLog: () => { },
    clearUnifiedLogs: () => { },
    setSystemInitInfo: () => { },
    setAgentError: () => { },
    connectSse: async () => { },
    disconnectSse: () => { },
    sendMessage: async () => false,
    stopResponse: async () => false,
    loadSession: async () => false,
    resetSession: async () => false,
    apiGet: async () => { throw new Error('Not in TabProvider'); },
    apiPost: async () => { throw new Error('Not in TabProvider'); },
    respondPermission: async () => { },
    respondAskUserQuestion: async () => { },
};

/**
 * TabContext - must be used within a TabProvider
 */
export const TabContext = createContext<TabContextValue>(defaultContextValue);

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
 */
export function useTabStateOptional(): TabContextValue | null {
    const context = useContext(TabContext);
    return context.tabId ? context : null;
}
