import { parseSidecarRole, type SidecarRole } from './sidecar-role';

export type SidecarCapability = 'common' | 'global' | 'session';

export type SidecarComposition = Readonly<{
  mode: 'production' | 'development-union';
  role: SidecarRole;
  capabilities: ReadonlySet<SidecarCapability>;
}>;

export type SidecarBootstrapStep = Readonly<{
  capability: SidecarCapability;
  run(): void | Promise<void>;
}>;

const COMMON_CAPABILITIES = ['common'] as const;

/**
 * Resolve the process composition once, before either bootstrap or routing.
 * Rust always supplies a production role. Browser development deliberately
 * opts into the union surface with --dev-union; omission remains the existing
 * fail-safe Session role instead of silently widening process authority.
 */
export function resolveSidecarComposition(
  roleValue: string | null,
  developmentUnion: boolean,
): SidecarComposition {
  if (developmentUnion) {
    if (roleValue !== null) {
      throw new Error('--dev-union cannot be combined with --sidecar-role');
    }
    return {
      mode: 'development-union',
      role: 'session',
      capabilities: new Set<SidecarCapability>([...COMMON_CAPABILITIES, 'global', 'session']),
    };
  }

  const role = parseSidecarRole(roleValue);
  return {
    mode: 'production',
    role,
    capabilities: new Set<SidecarCapability>([...COMMON_CAPABILITIES, role]),
  };
}

export function hasSidecarCapability(
  composition: SidecarComposition,
  capability: SidecarCapability,
): boolean {
  return composition.capabilities.has(capability);
}

/** Execute boot work in source order while omitting work outside this process role. */
export async function runSidecarBootstrap(
  composition: SidecarComposition,
  steps: readonly SidecarBootstrapStep[],
): Promise<void> {
  for (const step of steps) {
    if (hasSidecarCapability(composition, step.capability)) {
      await step.run();
    }
  }
}

const SESSION_EXACT_PATHS = new Set([
  '/agent/switch',
  '/api/ask-user-question/respond',
  '/api/agents/set',
  '/api/cc-plugin/session-enable',
  '/api/enter-plan-mode/respond',
  '/api/exit-plan-mode/respond',
  '/api/generate-session-title',
  '/api/goal/objective',
  '/api/image',
  // Rust delegates live transcript reads to the selected Session owner.
  '/api/internal/session/text-page',
  '/api/audio',
  '/api/interaction-scenario/set',
  '/api/mcp/set',
  '/api/memory/update',
  '/api/model/set',
  '/api/official-tools/session-enable',
  '/api/permission/respond',
  '/api/provider/set',
  '/api/reasoning-effort/set',
  '/api/session-latest-result',
  '/api/session-state',
  '/api/session-watch/manage',
  '/api/session-watch/network-remove',
  '/api/session-watch/register',
  '/api/task/poll-background',
  '/cron/execute-sync',
  '/hook/session-start',
  '/sessions/fork',
]);

const SESSION_PREFIXES = [
  '/api/attachment/',
  '/api/im/',
  '/api/inbox/',
  '/api/runtime/',
  '/api/session/',
  '/chat/',
  '/goal/',
  '/task/',
] as const;

const GLOBAL_EXACT_PATHS = new Set([
  '/api/remote-session/prepare',
  '/agent/upload',
  '/api/assets/qr-code',
  '/api/browser/session/retire',
  '/api/edge-tts/preview',
  '/api/global-stats',
  '/api/grok/verify',
  '/api/logs/export',
  '/api/mcp',
  '/api/mcp/enable',
  '/api/provider/verify',
  '/api/process/graceful-shutdown',
  '/api/session/messages',
  '/api/session-tags',
  '/api/subscription/status',
  '/api/subscription/verify',
  '/api/subscription/login/start',
  '/api/subscription/login/status',
  '/api/subscription/login/submit',
  '/api/subscription/login/cancel',
  '/api/supported-models',
  '/api/unified-log',
  '/mcp/playwright',
]);

const GLOBAL_PREFIXES = ['/api/mcp/oauth/', '/api/session-tags/'] as const;

const COMMON_EXACT_PATHS = new Set([
  // Both Global one-shots and Session engines must attest their own activity.
  // The handler still requires the internal credential and exact generation.
  '/api/process/update-quiesce',
  '/api/remote-session',
  '/api/im/model-options',
  '/api/proxy/set',
  // Both Global one-shots and Session Queries own managed-provider leases.
  '/api/cliproxy/control',
  '/api/runtime/models',
  '/api/runtime/permission-modes',
  '/api/project-capabilities',
  '/debug/logger',
  '/health',
  '/health/functional',
  '/health/live',
  '/health/ready',
]);

const COMMON_PREFIXES = [
  '/api/agent/',
  '/api/agents',
  '/api/cc-plugin/',
  '/api/command-item/',
  '/api/command-items',
  '/api/project-capability/',
  '/api/rules',
  '/api/skill/',
  '/api/skills',
  '/bridge/',
  '/refs/',
] as const;

const SESSION_ADMIN_ROUTES = new Set([
  'cron/exit',
  'im/send-media',
  'im/wake',
  'reload',
  'task/create-attached',
]);

const SESSION_ADMIN_PREFIXES = ['goal/', 'session/'] as const;

const COMMON_ADMIN_PREFIXES = [
  'agent/',
  'anydoc/',
  'cc-plugin/',
  'config/',
  'cron/',
  'diagnose/',
  'im/',
  'mcp/',
  'model/',
  'plugin/',
  'readme/',
  'record/',
  'runtime/',
  'skill/',
  'speech/',
  'space/',
  'task/',
  'thought/',
  'tool/',
  'vision/',
] as const;

const COMMON_ADMIN_ROUTES = new Set([
  'help',
  'status',
  'version',
  // Addressed Session operations resolve their explicit target through Rust;
  // they do not require the caller process to own a Product Session. This is
  // what lets the authenticated Global Host serve ordinary local programs.
  'session/list',
  'session/start',
  'session/send',
  'session/get',
  'session/state',
]);

function startsWithAny(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => pathname.startsWith(prefix));
}

function classifySessionsRoute(pathname: string, method: string): SidecarCapability | null {
  if (pathname === '/sessions/fork') return 'session';
  if (pathname === '/sessions') {
    return method === 'GET' || method === 'POST' ? 'global' : null;
  }
  if (/^\/sessions\/[^/]+$/.test(pathname)) {
    if (method === 'GET' || method === 'PATCH') return 'common';
    if (method === 'DELETE') return 'global';
    return null;
  }
  if (/^\/sessions\/[^/]+\/(?:stats|since\/[^/]+)$/.test(pathname) && method === 'GET') {
    return 'common';
  }
  return null;
}

/**
 * Production-consumed route ownership. This is intentionally the only role
 * table: tests exercise this gate and then the real handler, rather than
 * maintaining a second descriptive registry that can drift from production.
 */
export function classifySidecarRequest(request: Request): SidecarCapability | null {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return 'common';

  const sessionsCapability = classifySessionsRoute(pathname, method);
  if (sessionsCapability) return sessionsCapability;

  if (pathname.startsWith('/api/admin/')) {
    const route = pathname.slice('/api/admin/'.length);
    if (COMMON_ADMIN_ROUTES.has(route)) {
      return 'common';
    }
    if (SESSION_ADMIN_ROUTES.has(route) || startsWithAny(route, SESSION_ADMIN_PREFIXES)) {
      return 'session';
    }
    if (startsWithAny(route, COMMON_ADMIN_PREFIXES)) {
      return 'common';
    }
    return null;
  }

  // Global exceptions such as historical /api/session/messages must win over
  // broad current-Session prefixes.
  if (GLOBAL_EXACT_PATHS.has(pathname) || startsWithAny(pathname, GLOBAL_PREFIXES)) {
    return 'global';
  }
  if (COMMON_EXACT_PATHS.has(pathname)) {
    return 'common';
  }
  // More-specific current-Session routes must win over shared catalogue
  // prefixes such as /api/agents and /api/cc-plugin.
  if (SESSION_EXACT_PATHS.has(pathname) || startsWithAny(pathname, SESSION_PREFIXES)) {
    return 'session';
  }
  if (startsWithAny(pathname, COMMON_PREFIXES)) {
    return 'common';
  }

  // The Node server also hosts the built frontend in browser development.
  // Internal control prefixes never fall through to static-file authority.
  if (
    method === 'GET'
    && !startsWithAny(pathname, [
      '/agent/',
      '/api/',
      '/chat/',
      '/cron/',
      '/debug/',
      '/goal/',
      '/health',
      '/hook/',
      '/refs/',
      '/sessions',
      '/task/',
    ])
  ) {
    return 'common';
  }

  return null;
}

export type SidecarRequestHandler = (request: Request) => Promise<Response>;

/** Reject unknown or wrong-role paths before the union handler can run side effects. */
export function composeSidecarRequestHandler(
  composition: SidecarComposition,
  handler: SidecarRequestHandler,
): SidecarRequestHandler {
  return async (request) => {
    const capability = classifySidecarRequest(request);
    if (!capability || !hasSidecarCapability(composition, capability)) {
      return new Response('Not Found', { status: 404 });
    }
    return handler(request);
  };
}
