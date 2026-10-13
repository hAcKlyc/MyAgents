/** Internal local v1 owner. This is not an AgentNet management wire schema. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getHomeDir } from '../server/utils/platform';
import { atomicModifyConfig, loadConfig, loadProjects, type AdminAppConfig } from '../server/utils/admin-config';
import { withWorkspaceAgentRegistrationIntent, type RegisterWorkspaceAgentResult } from '../server/utils/agent-workspace-identity';

const strict = { strict: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD = 'hostResourceIntents';
const LIMIT = 256;
export class HostResourceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HostResourceError'; }
}
export interface HostResourceRequest {
  mutationId: string;
  expectedRevision: number;
  rootId: string;
  relativePath: string;
  operation: 'register' | 'create';
}
export interface HostResourceReceipt {
  mutationId: string;
  revision: number;
  status: 'pending' | 'persisted' | 'conflict';
  effect: 'none' | 'registered-disabled-agent' | 'existing-agent';
  resource?: RegisterWorkspaceAgentResult;
}
export type HostResourceResult = HostResourceReceipt | { mutationId: string; status: 'unconfirmed'; errorCode: 'RESOURCE_UNCONFIRMED' };
interface Intent { request: HostResourceRequest; hash: string; receipt: HostResourceReceipt }
interface Ledger { version: 1; hostId: string; roots: Record<string, string>; revision: number; intents: Intent[] }
interface Options { hostId: string; roots: Record<string, string> }
const fail = (code: string): never => { throw new HostResourceError(code); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function request(value: HostResourceRequest): HostResourceRequest {
  if (!plain(value) || Object.keys(value).some(key => !['mutationId','expectedRevision','rootId','relativePath','operation'].includes(key)) ||
      typeof value.mutationId !== 'string' || !UUID.test(value.mutationId) || !integer(value.expectedRevision) ||
      typeof value.rootId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.rootId) ||
      typeof value.relativePath !== 'string' || value.relativePath.length > 1024 ||
      !value.relativePath.split('/').every(piece => /^[a-zA-Z0-9_.-]{1,128}$/.test(piece) && piece !== '.' && piece !== '..') ||
      (value.operation !== 'create' && value.operation !== 'register')) return fail('RESOURCE_REQUEST_INVALID');
  return { mutationId: value.mutationId.toLowerCase(), expectedRevision: value.expectedRevision, rootId: value.rootId,
    relativePath: value.relativePath, operation: value.operation };
}
function digest(hostId: string, roots: Record<string,string>, body: HostResourceRequest): string {
  return createHash('sha256').update(JSON.stringify({hostId, root: roots[body.rootId], ...body})).digest('hex');
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function ledger(config: AdminAppConfig, options: Options): Ledger {
  const value = config[FIELD];
  if (value === undefined) return { version: 1, hostId: options.hostId, roots: options.roots, revision: 0, intents: [] };
  if (!plain(value) || !keys(value, ['version','hostId','roots','revision','intents']) || value.version !== 1 || value.hostId !== options.hostId || JSON.stringify(value.roots) !== JSON.stringify(options.roots) ||
      !integer(value.revision) || !Array.isArray(value.intents) || value.intents.length > LIMIT) return fail('RESOURCE_LEDGER_CORRUPT');
  const ids = new Set<string>();
  const revisions = new Set<number>();
  for (const raw of value.intents) {
    if (!plain(raw) || !keys(raw, ['request','hash','receipt']) || !plain(raw.request) || !plain(raw.receipt) ||
        !keys(raw.receipt, ['mutationId','revision','status','effect','resource'])) return fail('RESOURCE_LEDGER_CORRUPT');
    let body: HostResourceRequest;
    try { body = request(raw.request as unknown as HostResourceRequest); } catch { return fail('RESOURCE_LEDGER_CORRUPT'); }
    const receipt = raw.receipt;
    if (body.mutationId !== raw.request.mutationId || !Object.hasOwn(options.roots, body.rootId) || ids.has(body.mutationId) ||
        raw.hash !== digest(options.hostId, options.roots, body) || receipt.mutationId !== body.mutationId ||
        !integer(receipt.revision) || receipt.revision > value.revision ||
        typeof receipt.status !== 'string' || !['pending','persisted','conflict'].includes(receipt.status) ||
        typeof receipt.effect !== 'string' || !['none','registered-disabled-agent','existing-agent'].includes(receipt.effect)) return fail('RESOURCE_LEDGER_CORRUPT');
    if (receipt.status === 'conflict') {
      if (body.expectedRevision === receipt.revision) return fail('RESOURCE_LEDGER_CORRUPT');
    } else {
      if (receipt.revision !== body.expectedRevision + 1 || revisions.has(receipt.revision)) return fail('RESOURCE_LEDGER_CORRUPT');
      revisions.add(receipt.revision);
    }
    if (receipt.status === 'persisted') {
      const result = receipt.resource;
      if (!plain(result) || !keys(result, ['created','agentId','projectId','name','workspacePath','enabled','archived']) || typeof result.agentId !== 'string' || !result.agentId || result.agentId.length > 256 ||
          typeof result.projectId !== 'string' || !result.projectId || result.projectId.length > 256 || typeof result.name !== 'string' ||
          typeof result.enabled !== 'boolean' || typeof result.created !== 'boolean' || result.archived !== false ||
          result.workspacePath !== join(options.roots[body.rootId], body.relativePath) ||
          (result.created && result.enabled) || receipt.effect !== (result.created ? 'registered-disabled-agent' : 'existing-agent')) return fail('RESOURCE_LEDGER_CORRUPT');
    } else if (receipt.resource !== undefined || receipt.effect !== 'none') return fail('RESOURCE_LEDGER_CORRUPT');
    ids.add(body.mutationId);
  }
  if (revisions.size !== value.revision) return fail('RESOURCE_LEDGER_CORRUPT');
  return value as unknown as Ledger;
}

/** Linux kernel directory-fd anchoring: no lstat-to-mkdir path traversal fallback. */
function workspace(root: string, relativePath: string, create: boolean, recovering: boolean): { path: string; verify: () => void; close: () => void } {
  if (process.platform !== 'linux') return fail('RESOURCE_PLATFORM_UNSUPPORTED');
  const fds: number[] = [];
  const paths: string[] = [];
  const openDirectory = (target: string, canonical: string, rootDirectory: boolean) => {
    const fd = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fds.push(fd); paths.push(canonical);
    const stat = fstatSync(fd);
    if (stat.uid !== process.geteuid?.() || (stat.mode & (rootDirectory ? 0o077 : 0o022)) !== 0 || (stat.mode & 0o7000) !== 0) fail('RESOURCE_PATH_UNSAFE');
    return fd;
  };
  const verify = () => {
    for (let i = 0; i < fds.length; i++) {
      const stat = lstatSync(paths[i]); const pinned = fstatSync(fds[i]);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() ||
          (stat.mode & (i === 0 ? 0o077 : 0o022)) !== 0 || (stat.mode & 0o7000) !== 0 ||
          stat.dev !== pinned.dev || stat.ino !== pinned.ino || realpathSync(paths[i]) !== paths[i]) fail('RESOURCE_PATH_CHANGED');
    }
  };
  try {
    if (realpathSync(root) !== root) fail('RESOURCE_PATH_UNSAFE');
    let parent = openDirectory(root, root, true);
    const pieces = relativePath.split('/');
    let path = root;
    for (let i = 0; i < pieces.length; i++) {
      verify();
      const target = `/proc/self/fd/${parent}/${pieces[i]}`;
      path = join(path, pieces[i]);
      if (create && i === pieces.length - 1) {
        try { mkdirSync(target, {mode: 0o700}); fsyncSync(parent); }
        catch (error) { if (!recovering || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      parent = openDirectory(target, path, false);
    }
    fsyncSync(parent);
    verify();
    return { path, verify, close: () => { for (const fd of fds.reverse()) closeSync(fd); } };
  } catch (error) {
    for (const fd of fds.reverse()) closeSync(fd);
    if (error instanceof HostResourceError) throw error;
    return fail('RESOURCE_PATH_UNAVAILABLE');
  }
}

export function createHostResourceOwner(input: Options) {
  if (!UUID.test(input.hostId) || !plain(input.roots) || !Object.keys(input.roots).length) fail('RESOURCE_OWNER_INVALID');
  const roots: Record<string,string> = Object.create(null) as Record<string,string>;
  for (const key of Object.keys(input.roots).sort()) {
    const path = input.roots[key];
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || path === '/') fail('RESOURCE_OWNER_INVALID');
    roots[key] = path;
  }
  const options = {hostId: input.hostId.toLowerCase(), roots};
  const authorityHome = getHomeDir();
  const checkAuthority = () => { if (getHomeDir() !== authorityHome) fail('RESOURCE_AUTHORITY_CHANGED'); };
  return {
    async snapshot(): Promise<{version: 1; revision: number}> {
      return withWorkspaceAgentRegistrationIntent(async () => {
        checkAuthority();
        const current = ledger(loadConfig(strict), options); loadProjects(strict);
        return {version: 1, revision: current.revision};
      });
    },
    async receipt(id: string): Promise<HostResourceReceipt | undefined> {
      if (!UUID.test(id)) fail('RESOURCE_REQUEST_INVALID');
      return withWorkspaceAgentRegistrationIntent(async () => {
        checkAuthority();
        const current = ledger(loadConfig(strict), options);
        const result = current.intents.find(item => item.request.mutationId === id.toLowerCase())?.receipt;
        return result ? structuredClone(result) : undefined;
      });
    },
    async mutate(raw: HostResourceRequest): Promise<HostResourceResult> {
      const body = request(raw);
      if (!Object.hasOwn(roots, body.rootId)) fail('RESOURCE_ROOT_UNKNOWN');
      const hash = digest(options.hostId, roots, body);
      let activeWorkspace: ReturnType<typeof workspace> | undefined;
      let handledFailure: { error: unknown; result: Extract<HostResourceResult, {status: 'unconfirmed'}> } | undefined;
      return withWorkspaceAgentRegistrationIntent(async register => {
        checkAuthority();
        const current = ledger(loadConfig(strict), options);
        let intent = current.intents.find(item => item.request.mutationId === body.mutationId);
        if (intent && intent.hash !== hash) fail('RESOURCE_MUTATION_MISMATCH');
        if (intent && intent.receipt.status !== 'pending') return structuredClone(intent.receipt);
        loadProjects(strict); // Reject malformed authority before creating any directories or reserving an intent.
        if (!intent && current.intents.length >= LIMIT) fail('RESOURCE_LEDGER_FULL');
        const recovering = !!intent;
        if (!intent && current.revision === body.expectedRevision) {
          // A fresh create must not silently claim an already existing workspace.
          if (body.operation === 'create') {
            const candidate = join(roots[body.rootId], body.relativePath);
            try { lstatSync(candidate); fail('RESOURCE_ALREADY_EXISTS'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
        try {
          if (!intent) {
            const status = current.revision === body.expectedRevision ? 'pending' : 'conflict';
            await atomicModifyConfig(config => {
              checkAuthority();
              const next = ledger(config, options);
              if (next.revision !== current.revision || next.intents.length !== current.intents.length) fail('RESOURCE_CONCURRENT_CHANGE');
              if (status === 'pending' && next.revision === Number.MAX_SAFE_INTEGER) fail('RESOURCE_REVISION_EXHAUSTED');
              intent = {request: body, hash, receipt: {mutationId: body.mutationId,
                revision: status === 'pending' ? next.revision + 1 : next.revision, status, effect: 'none'}};
              return {...config, [FIELD]: {...next, revision: intent.receipt.revision, intents: [...next.intents, intent]}};
            }, strict);
          }
          if (!intent) return fail('RESOURCE_UNCONFIRMED');
          if (intent.receipt.status === 'conflict') return structuredClone(intent.receipt);
          const target = workspace(roots[body.rootId], body.relativePath, body.operation === 'create', recovering);
          try {
            activeWorkspace = target;
            const resource = await register(target.path);
            target.verify();
            let confirmed: HostResourceReceipt | undefined;
            await atomicModifyConfig(config => {
              target.verify();
              checkAuthority();
              const next = ledger(config, options);
              const index = next.intents.findIndex(item => item.request.mutationId === body.mutationId && item.hash === hash);
              if (index < 0 || next.intents[index].receipt.status !== 'pending') fail('RESOURCE_LEDGER_CORRUPT');
              confirmed = {mutationId: body.mutationId, revision: next.intents[index].receipt.revision,
                status: 'persisted', effect: resource.created ? 'registered-disabled-agent' : 'existing-agent', resource};
              const intents = [...next.intents]; intents[index] = {...intents[index], receipt: confirmed};
              return {...config, [FIELD]: {...next, intents}};
            }, strict);
            if (!confirmed) return fail('RESOURCE_UNCONFIRMED');
            target.verify();
            return structuredClone(confirmed);
          } finally { activeWorkspace = undefined; target.close(); }
        } catch (error) {
          // rename/fsync failures may have committed. The original ID is the only recovery handle.
          const result = {mutationId: body.mutationId, status: 'unconfirmed' as const, errorCode: 'RESOURCE_UNCONFIRMED' as const};
          handledFailure = {error, result};
          return result;
        }
      }, {strictPersistence: true, notify: false, assertWorkspace: path => { const pinned = activeWorkspace; if (!pinned || pinned.path !== path) return fail('RESOURCE_PATH_UNAVAILABLE'); pinned.verify(); }}).catch(error => {
        // The generic scope drains and rethrows failed registrations, including
        // those deliberately handled by its callback. Preserve only this exact
        // handled failure; lock/preflight/unrelated failures still reject.
        if (handledFailure && handledFailure.error === error) return handledFailure.result;
        throw error;
      });
    },
  };
}
