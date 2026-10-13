export const NAMESPACE: 'moxbot.bot.execution/v1';
export const AUDIENCE: 'moxbot-host-bots/v1';
export const MAX_SAFE_INTEGER: number;
export const MAX_OBJECT_BYTES: number;
export const MAX_JWT_BYTES: number;
export const MAX_COLLECTION_ITEMS: number;
export const MAX_PROOF_SECONDS: number;
export const MAX_LEASE_SECONDS: number;
export class ExecutionError extends Error { readonly code: string; constructor(code?: string); }
export interface ExecutionScope {
  issuer: string; service_id: string; environment: string; network_id: string;
  host_owner_id: string; host_device_id: string; host_key_generation: number; identity_binding_id: string;
}
export type Method = 'create'|'configure'|'enable'|'disable'|'delete'|'restore';
export interface Grant {
  id: string; generation: number; scope: ExecutionScope; bot_id: string; root_id: string; relative_path: string;
  operations: Method[]; allowed_runtimes: string[]; allowed_model_refs: string[]; max_daily_tokens: number; expires_at: number;
}
export interface BotConfig { name: string; description: string; runtime: string; model_ref: string|null; system_prompt: string; daily_tokens: number; }
export type Operation =
  | { method: 'create'; params: BotConfig & {resource_expected_revision: number} }
  | { method: 'configure'; params: BotConfig }
  | { method: 'enable'|'restore'; params: Record<string,never> }
  | { method: 'disable'; params: {policy: 'cancel'} }
  | { method: 'delete'; params: {confirmation: string} };
export interface Command {
  mutation_id: string; request_hash: string; actor_principal_id: string; actor_session_handle: string;
  grant_id: string; grant_generation: number; bot_id: string; binding_generation: number;
  expected_host_revision: number; operation: Operation;
}
export interface ActiveRun { session_id: string; run_generation: string; }
export interface BotSnapshot {
  bot_id: string; agent_id?: string|null; binding_generation: number; revision: number; deleted: boolean;
  admission: 'closed'|'open'; activity: 'idle'|'running'|'stopping'|'stopped'|'unknown';
  configured: boolean; runnable: boolean; unsupported_reason?: string|null; config: BotConfig; active_run?: ActiveRun|null;
}
export interface Receipt {
  mutation_id: string; request_hash: string; grant_id: string; grant_generation: number; bot_id: string;
  agent_id?: string|null; binding_generation: number; revision: number; status: 'persisted'|'conflict'|'failed'|'unconfirmed';
  code?: string|null; snapshot?: BotSnapshot|null;
}
export interface HostContext { challenge_nonce: string; local_auth_generation: number; boot_epoch: string; connection_epoch: string; membership_revision: number; }
export interface HostObservation {
  host_revision: number; resource_revision: number; root_ids: string[]; supported_runtimes: string[];
  allowed_bot_ids: string[]; allowed_model_refs: string[]; max_daily_tokens: number; policy_expires_at: number;
  snapshots: BotSnapshot[];
}
export interface CommonClaims { iss: string; aud: string; namespace: string; iat: number; nbf: number; exp: number; jti: string; }
export interface GrantClaims extends CommonClaims { grant: Grant; }
export interface IntentClaims extends CommonClaims { scope: ExecutionScope; grant: Grant; command: Command; }
export interface LeaseClaims extends CommonClaims {
  scope: ExecutionScope; grant_id: string; grant_generation: number; bot_id: string; binding_generation: number;
  mutation_id: string; request_hash: string; intent_hash: string; host_context: HostContext; lease_id: string;
}
export interface RevocationClaims extends CommonClaims { scope: ExecutionScope; grant_id: string; revoked_generation: number; bot_id: string; host_context: HostContext; }
export interface VerifyOptions { jwks: unknown; scope: ExecutionScope; now: number; }
export interface LeaseVerifyOptions extends VerifyOptions { intent: IntentClaims; host_context: HostContext; }
export interface RevocationVerifyOptions extends VerifyOptions { host_context: HostContext; grant_id: string; bot_id: string; revoked_generation: number; }
export function strictParse(input: string): unknown;
export function canonicalBytes(value: unknown): Uint8Array & { toString(encoding?: string): string; equals(other: Uint8Array): boolean };
export function commandHash(command: Command): string;
export function intentHash(intent: IntentClaims): string;
export function validateScope(value: unknown): ExecutionScope;
export function validateGrant(value: unknown): Grant;
export function validateConfig(value: unknown): BotConfig;
export function validateCommand(value: unknown): Command;
export function validateHostContext(value: unknown): HostContext;
export function validateSnapshot(value: unknown): BotSnapshot;
export function validateReceipt(value: unknown): Receipt;
export function validateHostObservation(value: unknown): HostObservation;
export function validateGrantClaims(value: unknown, options: Pick<VerifyOptions,'scope'|'now'>): GrantClaims;
export function validateIntentClaims(value: unknown, options: Pick<VerifyOptions,'scope'|'now'>): IntentClaims;
export function validateLeaseClaims(value: unknown, options: Omit<LeaseVerifyOptions,'jwks'>): LeaseClaims;
export function validateRevocationClaims(value: unknown, options: Omit<RevocationVerifyOptions,'jwks'>): RevocationClaims;
export function verifyGrant(token: string, options: VerifyOptions): GrantClaims;
export function verifyIntent(token: string, options: VerifyOptions): IntentClaims;
export function verifyLease(token: string, options: LeaseVerifyOptions): LeaseClaims;
export function verifyRevocation(token: string, options: RevocationVerifyOptions): RevocationClaims;
