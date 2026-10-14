/** Supervisor-owned immutable bootstrap; cloud requests never choose a route or workspace. */
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { canonicalBytes, validateConfig } from '../../services/agentnet/execution-core/js/index.mjs';
import { parseCloudModelLease, cloudSessionProviderId, type CloudModelLease } from './cloud-model';
import type { ImmutableBotSnapshot } from './bot-runtime';

export interface HostBotBootstrap {
  version: 1;
  cloud_model?: CloudModelLease;
  snapshot: ImmutableBotSnapshot;
  workspace: string;
  provider_id: string;
  model: string;
  run_generation: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' &&
  !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() &&
  v === v.trim() && Buffer.byteLength(v) <= max && [...v].every(c=>c.charCodeAt(0)>=32 && c.charCodeAt(0)!==127);

export function parseHostBotBootstrap(raw: unknown): HostBotBootstrap {
  const candidate=raw && typeof raw==='object' && !Array.isArray(raw) ? raw as Record<string,unknown> : {};
  const fields=['version','snapshot','workspace','provider_id','model','run_generation',...(Object.hasOwn(candidate,'cloud_model')?['cloud_model']:[])];
  if (!exact(raw, fields) || raw.version !== 1 ||
      !text(raw.workspace, 4096) || !isAbsolute(raw.workspace) || resolve(raw.workspace) !== raw.workspace ||
      !text(raw.provider_id, 256) || !text(raw.model, 256) || typeof raw.run_generation !== 'string' || !uuid.test(raw.run_generation) ||
      !exact(raw.snapshot, ['bot_id','agent_id','binding_generation','revision','runtime','config','snapshot_hash'])) throw new Error('BOT_BOOTSTRAP_INVALID');
  const s = raw.snapshot;
  if (typeof s.bot_id !== 'string' || !uuid.test(s.bot_id) || !text(s.agent_id, 256) ||
      !Number.isSafeInteger(s.binding_generation) || (s.binding_generation as number) < 1 ||
      !Number.isSafeInteger(s.revision) || (s.revision as number) < 0 || s.runtime !== 'builtin' ||
      typeof s.snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(s.snapshot_hash)) throw new Error('BOT_BOOTSTRAP_INVALID');
  validateConfig(s.config);
  const config = s.config as ImmutableBotSnapshot['config'];
  if (config.runtime !== 'builtin' || !config.model_ref || !config.system_prompt.trim()) throw new Error('BOT_BOOTSTRAP_INVALID');
  const {snapshot_hash, ...payload} = s;
  if (createHash('sha256').update(canonicalBytes(payload)).digest('hex') !== snapshot_hash) throw new Error('BOT_BOOTSTRAP_HASH_MISMATCH');
  if(raw.cloud_model!==undefined){
    const origin=new URL((raw.cloud_model as CloudModelLease).gateway_base_url).origin;
    const lease=parseCloudModelLease(raw.cloud_model,origin);
    if(lease.model_ref!==config.model_ref||raw.provider_id!==cloudSessionProviderId(lease)||raw.model!==lease.model)throw new Error('BOT_BOOTSTRAP_INVALID');
  }
  const value = structuredClone(raw) as unknown as HostBotBootstrap;
  if(value.cloud_model)Object.freeze(value.cloud_model);
  Object.freeze(value.snapshot.config); Object.freeze(value.snapshot); return Object.freeze(value);
}

export function bootstrapFromEnvironment(): HostBotBootstrap | undefined {
  const raw = process.env.MYAGENTS_HOST_BOT_BOOTSTRAP;
  if (!raw) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.byteLength(raw) > 96 * 1024) throw new Error('BOT_BOOTSTRAP_INVALID');
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw || bytes.length > 64 * 1024) throw new Error('BOT_BOOTSTRAP_INVALID');
  return parseHostBotBootstrap(JSON.parse(bytes.toString('utf8')));
}
