export const STANDARD_PLAYWRIGHT_MCP_ID = 'playwright' as const;
export const MANAGED_BROWSER_MCP_ID = 'myagents-browser' as const;

export const DEFAULT_STANDARD_PLAYWRIGHT_ARGS = ['--isolated'] as const;

export type StandardPlaywrightProfileMode = 'isolated' | 'persistent';

export interface StandardPlaywrightProfileArgs {
  mode: StandardPlaywrightProfileMode;
  userDataDir: string;
  remainingArgs: string[];
}

/**
 * Keep the settings UI at two user-facing profile modes while preserving the
 * upstream argv distinction: an explicit empty argv is persistent with an
 * upstream-managed directory; only an absent config receives our isolated
 * default.
 */
export function splitStandardPlaywrightProfileArgs(configuredArgs: readonly string[] | undefined): StandardPlaywrightProfileArgs {
  const args = configuredArgs ?? DEFAULT_STANDARD_PLAYWRIGHT_ARGS;
  let mode: StandardPlaywrightProfileMode = configuredArgs === undefined ? 'isolated' : 'persistent';
  let userDataDir = '';
  const remainingArgs: string[] = [];

  for (const arg of args) {
    if (arg === '--isolated') {
      mode = 'isolated';
      userDataDir = '';
    } else if (arg.startsWith('--user-data-dir=')) {
      mode = 'persistent';
      userDataDir = arg.slice('--user-data-dir='.length);
    } else {
      remainingArgs.push(arg);
    }
  }

  return { mode, userDataDir, remainingArgs };
}

export function standardPlaywrightProfileArgs(mode: StandardPlaywrightProfileMode, userDataDir: string): string[] {
  if (mode === 'isolated') return ['--isolated'];
  const directory = userDataDir.trim();
  return directory ? [`--user-data-dir=${directory}`] : [];
}

/** These product-owned catalogue identities cannot be shadowed by custom MCPs. */
export function isReservedBuiltinBrowserMcpId(serverId: string): boolean {
  return serverId === STANDARD_PLAYWRIGHT_MCP_ID || serverId === MANAGED_BROWSER_MCP_ID;
}

/**
 * The managed Browser has a fixed product-owned runtime contract. Generic MCP
 * args/env are not Browser settings and must not be exposed as if they were.
 */
export function hasUserEditableMcpSettings(serverId: string): boolean {
  return serverId !== MANAGED_BROWSER_MCP_ID;
}

/**
 * The two MyAgents-owned browser entries intentionally expose overlapping
 * browser_* tools. Keep a single execution selection (Session, Agent default,
 * Launcher, or Task override) mutually exclusive for these exact preset IDs:
 * selecting one removes the other; deselecting one never changes its peer.
 * Global MCP availability and custom MCPs are deliberately outside this rule.
 */
export function applyBuiltinBrowserExecutionToolToggle(current: readonly string[], serverId: string, enabled: boolean, managedBrowserReady: boolean): string[] {
  const next = new Set(current);
  if (!enabled) {
    next.delete(serverId);
    return [...next];
  }

  if (serverId === MANAGED_BROWSER_MCP_ID && !managedBrowserReady) {
    return [...next];
  }

  return selectBrowserExecutionTool(current, serverId);
}

/** Desired execution selection, also used by CLI before resources are ready. */
export function selectBrowserExecutionTool(current: readonly string[], serverId: string): string[] {
  const next = new Set(current);
  next.add(serverId);
  if (serverId === STANDARD_PLAYWRIGHT_MCP_ID) {
    next.delete(MANAGED_BROWSER_MCP_ID);
  } else if (serverId === MANAGED_BROWSER_MCP_ID) {
    next.delete(STANDARD_PLAYWRIGHT_MCP_ID);
  }
  return [...next];
}

export type BrowserResourceState =
  | 'never_installed'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'updating'
  | 'install_failed'
  | 'update_failed'
  | 'unsupported';

export interface BrowserResourceStatus {
  platform?: string;
  requiredRevision: string;
  installedRevision?: string;
  installAuthorized: boolean;
  state: BrowserResourceState;
  operationId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  progressPercent?: number;
  errorCode?: string;
  retryable: boolean;
  automaticRetryCount: number;
  statusRevision: number;
  updatedAt: string;
}

export function isBrowserResourceReady(status: BrowserResourceStatus | null | undefined): boolean {
  return status?.state === 'ready' && status.installAuthorized && status.installedRevision === status.requiredRevision;
}

export function selectLatestBrowserResourceStatus(current: BrowserResourceStatus | null | undefined, incoming: BrowserResourceStatus): BrowserResourceStatus {
  if (!current || incoming.statusRevision >= current.statusRevision) return incoming;
  return current;
}

export function shouldAutoMaintainBrowserResource(status: BrowserResourceStatus | null | undefined): boolean {
  if (!status?.installAuthorized) return false;
  return (
    !isBrowserResourceReady(status) &&
    status.state !== 'downloading' &&
    status.state !== 'verifying' &&
    status.state !== 'installing' &&
    status.state !== 'updating' &&
    status.state !== 'unsupported'
  );
}
