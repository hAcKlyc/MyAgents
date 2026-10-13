import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

// These are local Unix-socket owner types, not an AgentNet wire contract.
export type HostSettings = {
  revision: number;
  providerId: string;
  model: string;
  workspace: string;
  executionAuthorized: boolean;
};
export type HostConfig = {
  hostSettings?: HostSettings;
  providerApiKeys?: Record<string, string>;
  hostConfigReceipts?: unknown;
  [key: string]: unknown;
};
export type ConfigReceipt =
  | { mutationId: string; status: 'persisted'; revision: number; effect: 'new-session'; settings: HostSettings }
  | { mutationId: string; status: 'conflict'; revision: number; effect: 'none' };
type ReceiptEntry = { requestHash: string; receipt: ConfigReceipt };
type Ledger = { schemaVersion: 1; hostId: string; entries: ReceiptEntry[] };
export type HostConfigOwner = {
  hostId: string;
  defaultWorkspace: string;
  readConfig(): Promise<HostConfig>;
  writeConfig(config: HostConfig): Promise<void>;
  workspacePath(value: string): Promise<string>;
  busy(): boolean;
  credentialReference?: string;
};
export interface HostConfigMutationOwnerInput extends Omit<HostConfigOwner, 'readConfig' | 'writeConfig'> {
  readConfig(): Promise<HostConfig>;
  atomicModifyConfig(modify: (current: HostConfig) => HostConfig): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class HostConfigError extends Error {
  readonly code = 'HOST_MANAGEMENT_UNCONFIRMED' as const;

  constructor() {
    super('Configuration persistence outcome is unconfirmed; query the original mutation ID before retrying');
    this.name = 'HostConfigError';
  }
}
const MODEL = /^[a-zA-Z0-9._-]{1,128}$/;
const CAPACITY = 256;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function mutationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Mutation ID must be a UUID');
  return value.toLowerCase();
}

function settings(value: unknown): value is HostSettings {
  return object(value) && keys(value, ['revision', 'providerId', 'model', 'workspace', 'executionAuthorized'])
    && revision(value.revision) && value.revision > 0 && value.providerId === 'moonshot-coding'
    && typeof value.model === 'string' && MODEL.test(value.model)
    && typeof value.workspace === 'string' && isAbsolute(value.workspace)
    && typeof value.executionAuthorized === 'boolean';
}

function ledger(config: HostConfig, hostId: string): Ledger {
  if (!object(config)) throw new Error('Host configuration is invalid');
  if (config.hostConfigReceipts === undefined) return { schemaVersion: 1, hostId, entries: [] };
  const value = config.hostConfigReceipts;
  const fail = () => { throw new Error('Host configuration receipt ledger is invalid; repair it without discarding unresolved receipts'); };
  if (!object(value) || !keys(value, ['schemaVersion', 'hostId', 'entries'])
    || value.schemaVersion !== 1 || value.hostId !== hostId || !Array.isArray(value.entries)
    || value.entries.length > CAPACITY) return fail();
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || !keys(entry, ['requestHash', 'receipt'])
      || typeof entry.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.requestHash)
      || !object(entry.receipt)) return fail();
    const receipt = entry.receipt;
    if (typeof receipt.mutationId !== 'string' || !UUID.test(receipt.mutationId)
      || receipt.mutationId !== receipt.mutationId.toLowerCase() || ids.has(receipt.mutationId)
      || !revision(receipt.revision)) return fail();
    if (receipt.status === 'persisted') {
      if (!keys(receipt, ['mutationId', 'status', 'revision', 'effect', 'settings'])
        || receipt.effect !== 'new-session' || !settings(receipt.settings)
        || receipt.settings.revision !== receipt.revision) return fail();
    } else if (receipt.status === 'conflict') {
      if (!keys(receipt, ['mutationId', 'status', 'revision', 'effect']) || receipt.effect !== 'none') return fail();
    } else return fail();
    ids.add(receipt.mutationId);
  }
  return value as Ledger;
}

export function readConfigReceipt(config: HostConfig, hostId: string, body: Record<string, unknown>): ConfigReceipt | { mutationId: string; status: 'not-found' } {
  if (!keys(body, ['mutationId'])) throw new Error('Receipt lookup accepts only its original mutation ID');
  const id = mutationId(body.mutationId);
  return ledger(config, hostId).entries.find(entry => entry.receipt.mutationId === id)?.receipt
    ?? { mutationId: id, status: 'not-found' };
}

function sameField(left: HostConfig, right: HostConfig, key: string): boolean {
  return Object.hasOwn(left, key) === Object.hasOwn(right, key)
    && JSON.stringify(left[key]) === JSON.stringify(right[key]);
}

/**
 * Merge the Host configuration owner's changed fields into the latest shared
 * config under atomicModifyConfig. Other owners may have updated their
 * projections since the Host read; those fields must never be overwritten.
 */
export function mergeHostConfigMutation(current: HostConfig, observed: HostConfig, next: HostConfig): HostConfig {
  for (const field of ['hostSettings', 'hostConfigReceipts'] as const) {
    if (!sameField(current, observed, field)) throw new HostConfigError();
  }
  const currentKeys = current.providerApiKeys;
  const observedKeys = observed.providerApiKeys;
  const nextKeys = next.providerApiKeys;
  const currentHasKey = object(currentKeys) && Object.hasOwn(currentKeys, 'moonshot-coding');
  const observedHasKey = object(observedKeys) && Object.hasOwn(observedKeys, 'moonshot-coding');
  const nextHasKey = object(nextKeys) && Object.hasOwn(nextKeys, 'moonshot-coding');
  const currentKey = object(currentKeys) ? currentKeys['moonshot-coding'] : undefined;
  const observedKey = object(observedKeys) ? observedKeys['moonshot-coding'] : undefined;
  const nextKey = object(nextKeys) ? nextKeys['moonshot-coding'] : undefined;
  if (currentHasKey !== observedHasKey || currentKey !== observedKey) throw new HostConfigError();

  const merged: HostConfig = { ...current };
  if (!sameField(observed, next, 'hostSettings')) {
    if (Object.hasOwn(next, 'hostSettings')) merged.hostSettings = next.hostSettings;
    else delete merged.hostSettings;
  }
  if (!sameField(observed, next, 'hostConfigReceipts')) {
    if (Object.hasOwn(next, 'hostConfigReceipts')) merged.hostConfigReceipts = next.hostConfigReceipts;
    else delete merged.hostConfigReceipts;
  }
  if (currentHasKey !== nextHasKey || currentKey !== nextKey) {
    const providerApiKeys = object(currentKeys) ? { ...currentKeys } : {};
    if (nextHasKey) providerApiKeys['moonshot-coding'] = nextKey as string;
    else delete providerApiKeys['moonshot-coding'];
    merged.providerApiKeys = providerApiKeys;
  }
  return merged;
}

/** Builds the Host config owner over the shared config.json atomic modifier. */
export function createHostConfigMutationOwner(input: HostConfigMutationOwnerInput): HostConfigOwner {
  let observed: HostConfig | undefined;
  return {
    hostId: input.hostId,
    defaultWorkspace: input.defaultWorkspace,
    workspacePath: input.workspacePath,
    busy: input.busy,
    credentialReference: input.credentialReference,
    async readConfig() {
      observed = await input.readConfig();
      return observed;
    },
    async writeConfig(next) {
      if (!observed) throw new Error('Host configuration read is required before write');
      await input.atomicModifyConfig(current => mergeHostConfigMutation(current, observed!, next));
    },
  };
}

/** Enforces registration-intent -> supervisor order for Host config writes. */
export function withHostConfigurationLocks<T>(
  withRegistrationIntent: (operation: () => Promise<T>) => Promise<T>,
  withSupervisor: (operation: () => Promise<T>) => Promise<T>,
  operation: () => Promise<T>,
): Promise<T> {
  return withRegistrationIntent(() => withSupervisor(operation));
}

/** Read registration-owned data before acquiring the supervisor lock. */
export async function withHostSnapshotLocks<R, T>(
  readResources: () => Promise<R>,
  withSupervisor: (operation: () => Promise<T>) => Promise<T>,
  readSupervisor: (resources: R) => Promise<T>,
): Promise<T> {
  const resources = await readResources();
  return withSupervisor(() => readSupervisor(resources));
}

// The supervisor must call this under its existing lifecycle/configuration lock.
// Config and receipt are one atomic config.json commit, never two stores.
export async function configureHost(owner: HostConfigOwner, body: Record<string, unknown>): Promise<ConfigReceipt | { persisted: true; revision: number; effect: 'new-session'; settings: HostSettings }> {
  if (!keys(body, ['expectedRevision', 'providerId', 'model', 'workspace', 'executionAuthorized', 'mutationId'])) throw new Error('Unsupported configuration field');
  if (!revision(body.expectedRevision) || body.expectedRevision === Number.MAX_SAFE_INTEGER
    || body.providerId !== 'moonshot-coding' || typeof body.model !== 'string' || !MODEL.test(body.model)
    || typeof body.executionAuthorized !== 'boolean'
    || (body.workspace !== undefined && (typeof body.workspace !== 'string' || !isAbsolute(body.workspace)))) {
    throw new Error('First version requires a Kimi Code model, valid revision/workspace and explicit execution authorization');
  }
  const workspaceIntent = (body.workspace as string | undefined) ?? owner.defaultWorkspace;
  const id = body.mutationId === undefined ? undefined : mutationId(body.mutationId);
  const requestHash = createHash('sha256').update(JSON.stringify([
    'host-local-config-v1', owner.hostId, body.expectedRevision, body.providerId, body.model, workspaceIntent, body.executionAuthorized,
  ])).digest('hex');
  const config = await owner.readConfig();
  const receipts = ledger(config, owner.hostId);
  const persist = async (next: HostConfig) => {
    try { await owner.writeConfig(next); }
    catch (error) {
      if (!id) throw error;
      throw new HostConfigError();
    }
  };
  const prior = id ? receipts.entries.find(entry => entry.receipt.mutationId === id) : undefined;
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error('Mutation ID is already bound to a different configuration request');
    // Recovery must work even after a Session starts or a workspace disappears.
    return prior.receipt;
  }
  if (owner.busy()) throw new Error('Release the active Session before configuring the Host');
  if (id && receipts.entries.length === CAPACITY) throw new Error('Configuration receipt capacity reached; existing receipts remain available');
  const currentRevision = config.hostSettings?.revision ?? 0;
  if (!revision(currentRevision) || currentRevision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid or exhausted Host configuration revision');
  if (body.expectedRevision !== currentRevision) {
    if (!id) throw new Error('Configuration conflict: inspect the latest revision');
    const receipt: ConfigReceipt = { mutationId: id, status: 'conflict', revision: currentRevision, effect: 'none' };
    await persist({ ...config, hostConfigReceipts: { ...receipts, entries: [...receipts.entries, { requestHash, receipt }] } });
    return receipt;
  }
  const workspace = await owner.workspacePath(workspaceIntent);
  const next: HostSettings = {
    revision: currentRevision + 1, providerId: body.providerId, model: body.model, workspace, executionAuthorized: body.executionAuthorized,
  };
  const receipt: ConfigReceipt | undefined = id ? { mutationId: id, status: 'persisted', revision: next.revision, effect: 'new-session', settings: next } : undefined;
  await persist({ ...config,
    providerApiKeys: { ...config.providerApiKeys, 'moonshot-coding': owner.credentialReference ?? 'systemd-credential:kimi' },
    hostSettings: next,
    ...(receipt ? { hostConfigReceipts: { ...receipts, entries: [...receipts.entries, { requestHash, receipt }] } } : {}),
  });
  return receipt ?? { persisted: true, revision: next.revision, effect: 'new-session', settings: next };
}
