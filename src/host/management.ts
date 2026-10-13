import { resolveSessionModelAliases } from '../server/utils/model-aliases';
import { completeModelAliases, PRESET_PROVIDERS } from '../shared/config-types';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { HOST_PROVIDER_LIMIT, isHostProviderId, isHostModelId, isHostProviderProfile, isHostWorkspaceSelection, type HostProviderProfile, type HostWorkspaceSelection } from '../shared/hostProviderConfig';

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
type Owner = {
  hostId: string;
  defaultWorkspace: string;
  readConfig(): Promise<HostConfig>;
  writeConfig(config: HostConfig): Promise<void>;
  workspacePath(value: string): Promise<string>;
  busy(): boolean;
  credentialReference?: string;
};
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
  if (genericLedger(config, hostId).some(e => e.receipt.mutationId === id)) throw new HostManagementUpgradeRequired();
  return ledger(config, hostId).entries.find(entry => entry.receipt.mutationId === id)?.receipt
    ?? { mutationId: id, status: 'not-found' };
}

// The supervisor must call this under its existing lifecycle/configuration lock.
// Config and receipt are one atomic config.json commit, never two stores.
export async function configureHost(owner: Owner, body: Record<string, unknown>): Promise<ConfigReceipt | { persisted: true; revision: number; effect: 'new-session'; settings: HostSettings }> {
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
  if (!legacyHostRepresentable(config)) throw new HostManagementUpgradeRequired();
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

export type GenericHostSettings = {revision: number; providerId: string; model: string; workspace: HostWorkspaceSelection; executionAuthorized: boolean};
export type GenericConfigReceipt = {kind: 'provider-config-receipt'; mutationId: string; status: 'persisted' | 'conflict'; revision: number; effect: 'new-session' | 'none'; settings?: GenericHostSettings};
type GenericEntry = {providerId: string; requestHash: string; receipt: GenericConfigReceipt};
export class HostManagementUpgradeRequired extends Error {
  readonly code = 'HOST_MANAGEMENT_UPGRADE_REQUIRED';
  constructor() { super('HOST_MANAGEMENT_UPGRADE_REQUIRED'); }
}
export function legacyHostRepresentable(config: HostConfig): boolean {
  return !config.hostSettings || (settings(config.hostSettings) && !config.hostProviderWorkspace);
}
function genericLedger(config: HostConfig, hostId: string): GenericEntry[] {
  const raw = config.hostProviderConfigReceipts;
  if (raw === undefined) return [];
  if (!object(raw) || !keys(raw, ['version','hostId','entries']) || raw.version !== 1 || raw.hostId !== hostId || !Array.isArray(raw.entries) || raw.entries.length > CAPACITY) throw new Error('Host provider receipt ledger is invalid');
  const ids = new Set<string>();
  for (const e of raw.entries) {
    if (!object(e) || !keys(e,['providerId','requestHash','receipt']) || !isHostProviderId(e.providerId) || typeof e.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(e.requestHash) || !object(e.receipt)) throw new Error('Host provider receipt ledger is invalid');
    const r = e.receipt;
    if (!keys(r,['kind','mutationId','status','revision','effect','settings']) || r.kind !== 'provider-config-receipt' || typeof r.mutationId !== 'string' || mutationId(r.mutationId) !== r.mutationId || ids.has(r.mutationId) || !revision(r.revision)) throw new Error('Host provider receipt ledger is invalid');
    if (r.status === 'persisted') {
      const s = r.settings;
      if (r.effect !== 'new-session' || !object(s) || !keys(s,['revision','providerId','model','workspace','executionAuthorized']) || s.revision !== r.revision || r.revision < 1 || s.providerId !== e.providerId || !isHostModelId(s.model) || !isHostWorkspaceSelection(s.workspace) || typeof s.executionAuthorized !== 'boolean') throw new Error('Host provider receipt ledger is invalid');
    } else if (r.status !== 'conflict' || r.effect !== 'none' || r.settings !== undefined) throw new Error('Host provider receipt ledger is invalid');
    ids.add(r.mutationId);
  }
  return raw.entries as GenericEntry[];
}
export function readProviderConfigReceipt(config: HostConfig, hostId: string, providerId: unknown, mutation: unknown) {
  if (!isHostProviderId(providerId)) throw new Error('Invalid provider ID');
  const id = mutationId(mutation);
  return genericLedger(config,hostId).find(e => e.providerId === providerId && e.receipt.mutationId === id)?.receipt ?? {mutationId:id,status:'not-found' as const};
}
export function extendedHostSettings(config: HostConfig, roots: Record<string,string> = {}): GenericHostSettings | null {
  const s = config.hostSettings;
  if (!s) return null;
  if (config.hostProviderWorkspace !== undefined) {
    if (!isHostWorkspaceSelection(config.hostProviderWorkspace) || !isHostProviderId(s.providerId) || !isHostModelId(s.model) || !revision(s.revision) || typeof s.executionAuthorized !== 'boolean') throw new Error('Invalid Host provider settings');
    return {...s, workspace: config.hostProviderWorkspace};
  }
  for (const [rootId,root] of Object.entries(roots)) {
    const workspace = {rootId,relativePath:relative(root,s.workspace)};
    if (isHostWorkspaceSelection(workspace)) return {...s,workspace};
  }
  throw new Error('Host workspace is outside declared roots');
}
/** Read only selected owner metadata; never keys, references or arbitrary config. */
export function selectedHostProviderProfile(config: HostConfig): HostProviderProfile | null {
  const selected = config.hostSettings;
  if (!selected) return null;
  if (!isHostProviderId(selected.providerId) || !isHostModelId(selected.model)) throw new Error('Host selected provider profile is invalid');
  if (config.hostProviderProfiles !== undefined) {
    if (!object(config.hostProviderProfiles) || Object.keys(config.hostProviderProfiles).length > HOST_PROVIDER_LIMIT) throw new Error('Host selected provider profile is invalid');
    if (Object.hasOwn(config.hostProviderProfiles,selected.providerId)) {
      const profile=config.hostProviderProfiles[selected.providerId];
      if (!isHostProviderProfile(profile) || profile.id !== selected.providerId) throw new Error('Host selected provider profile is invalid');
      return structuredClone(profile);
    }
  }
  if (!legacyHostRepresentable(config)) throw new Error('Host selected provider profile is invalid');
  const preset=PRESET_PROVIDERS.find(provider=>provider.id === 'moonshot-coding');
  if (!preset) throw new Error('Host selected provider profile is invalid');
  const profile = {
    id:preset.id,sourceProviderId:preset.id,name:preset.name,apiProtocol:preset.apiProtocol ?? 'anthropic',
    baseUrl:preset.config?.baseUrl,authType:preset.authType ?? 'both',
    ...(preset.upstreamFormat ? {upstreamFormat:preset.upstreamFormat} : {}),
    ...(preset.maxOutputTokens !== undefined ? {maxOutputTokens:preset.maxOutputTokens} : {}),
    ...(preset.maxOutputTokensParamName ? {maxOutputTokensParamName:preset.maxOutputTokensParamName} : {}),
    modelAliases:completeModelAliases(resolveSessionModelAliases(preset.modelAliases,selected.model),selected.model),
  };
  if (!isHostProviderProfile(profile)) throw new Error('Host selected provider profile is invalid');
  return profile;
}

export async function configureProviderHost(owner: Owner & {selectWorkspace(selection: HostWorkspaceSelection): Promise<{path:string; verify():void; close():void}>}, body: Record<string, unknown>): Promise<GenericConfigReceipt> {
  if (!keys(body,['provider','model','workspace','executionAuthorized','expectedRevision','mutationId']) || !isHostProviderProfile(body.provider) || !isHostModelId(body.model) || !isHostWorkspaceSelection(body.workspace) || !revision(body.expectedRevision) || body.expectedRevision === Number.MAX_SAFE_INTEGER || typeof body.executionAuthorized !== 'boolean') throw new Error('Invalid portable Host configuration');
  const id = mutationId(body.mutationId); const profile: HostProviderProfile = {...body.provider,modelAliases:completeModelAliases(body.provider.modelAliases,body.model)};
  const config = await owner.readConfig(); const entries = genericLedger(config,owner.hostId);
  const canonical = (value: HostProviderProfile) => Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,k === 'modelAliases' && object(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v]));
  const canonicalProfile = canonical(profile);
  const hash = createHash('sha256').update(JSON.stringify(['host-provider-config-v1',owner.hostId,canonicalProfile,body.model,body.workspace.rootId,body.workspace.relativePath,body.executionAuthorized,body.expectedRevision])).digest('hex');
  const prior = entries.find(e => e.receipt.mutationId === id);
  if (prior) { if (prior.requestHash !== hash || prior.providerId !== profile.id) throw new Error('Mutation ID is bound to a different provider configuration'); return structuredClone(prior.receipt); }
  if (owner.busy()) throw new Error('Release the active Session before configuring the Host');
  if (entries.length >= CAPACITY) throw new Error('Host provider receipt capacity reached');
  const currentRevision = config.hostSettings?.revision ?? 0;
  if (!revision(currentRevision) || currentRevision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid Host revision');
  const persist = async (next: HostConfig) => {try { await owner.writeConfig(next); } catch { throw new HostConfigError(); }};
  const append = (receipt: GenericConfigReceipt) => ({version:1,hostId:owner.hostId,entries:[...entries,{providerId:profile.id,requestHash:hash,receipt}]});
  if (currentRevision !== body.expectedRevision) {
    const receipt: GenericConfigReceipt = {kind:'provider-config-receipt',mutationId:id,status:'conflict',revision:currentRevision,effect:'none'};
    await persist({...config,hostProviderConfigReceipts:append(receipt)}); return receipt;
  }
  // Source application may revoke, but never grants Host execution implicitly.
  if (body.executionAuthorized && !config.hostSettings?.executionAuthorized) throw new Error('Source reuse cannot authorize Host execution');
  const profiles = object(config.hostProviderProfiles) ? config.hostProviderProfiles : {};
  if (Object.keys(profiles).some(k => !isHostProviderProfile(profiles[k]) || (profiles[k] as HostProviderProfile).id !== k) || Object.keys(profiles).length > HOST_PROVIDER_LIMIT) throw new Error('Invalid Host profile registry');
  if (Object.hasOwn(profiles,profile.id) && JSON.stringify(canonical(profiles[profile.id] as HostProviderProfile)) !== JSON.stringify(canonical(profile))) throw new Error('Host provider profile is immutable; select a new versioned Provider ID');
  if (!Object.hasOwn(profiles,profile.id) && Object.keys(profiles).length >= HOST_PROVIDER_LIMIT) throw new Error('Host provider profile capacity reached');
  const target = await owner.selectWorkspace(body.workspace);
  try {
    target.verify();
    const next = {revision:currentRevision+1,providerId:profile.id,model:body.model,workspace:body.workspace,executionAuthorized:body.executionAuthorized};
    const receipt: GenericConfigReceipt = {kind:'provider-config-receipt',status:'persisted',mutationId:id,revision:next.revision,effect:'new-session',settings:next};
    await persist({...config,hostSettings:{...next,workspace:target.path},hostProviderWorkspace:body.workspace,hostProviderProfiles:{...profiles,[profile.id]:profile},providerApiKeys:{...config.providerApiKeys,[profile.id]:`host-provider-credential:${profile.id}`},hostProviderConfigReceipts:append(receipt)});
    try { target.verify(); } catch { throw new HostConfigError(); }
    return receipt;
  } finally {target.close();}
}
