/** Host-side verification for cloud-signed Bot delegation proofs. */
import {
  verifyGrant as verifySignedGrant,
  verifyIntent as verifySignedIntent,
  verifyLease as verifySignedLease,
  verifyRevocation as verifySignedRevocation,
  MAX_JWT_BYTES,
  type ExecutionScope,
  type GrantClaims,
  type HostContext,
  type IntentClaims,
  type LeaseClaims,
  type RevocationClaims,
} from '../../services/agentnet/execution-core/js/index.mjs';

export interface BotDelegationVerifierOptions {
  /** Public keys pinned by the selected AgentNet service profile. Never a JWKS URL. */
  jwks: Readonly<Record<string, unknown>>;
  /** Actual network Host/device scope, distinct from the local Node Host ID. */
  scope: ExecutionScope;
  /** Current Host-generated challenge and epochs. Undefined means execution is not connected. */
  currentHostContext: () => HostContext | undefined;
  now?: () => number;
}

export interface VerifiedBotCommand {
  intent: IntentClaims;
  lease: LeaseClaims;
}

function currentTime(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('BOT_PROOF_CLOCK_INVALID');
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function sameHostContext(a: HostContext, b: HostContext): boolean {
  return a.challenge_nonce === b.challenge_nonce &&
    a.local_auth_generation === b.local_auth_generation &&
    a.boot_epoch === b.boot_epoch &&
    a.connection_epoch === b.connection_epoch &&
    a.membership_revision === b.membership_revision;
}

/**
 * This is the production proof boundary: all JWTs are verified by execution-core
 * against the configured pinned JWK set and exact scope. No boolean grants,
 * caller-selected key, or mock-proof shortcut is accepted here.
 */
export function createBotDelegationVerifier(options: BotDelegationVerifierOptions) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    verifyGrant(token: string): GrantClaims {
      if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > MAX_JWT_BYTES) throw new Error('BOT_GRANT_INVALID');
      return deepFreeze(verifySignedGrant(token, { jwks: options.jwks, scope: options.scope, now: currentTime(now) }));
    },

    verifyCommand(intentToken: string, leaseToken: string): VerifiedBotCommand {
      if (typeof intentToken !== 'string' || !intentToken || Buffer.byteLength(intentToken, 'utf8') > MAX_JWT_BYTES ||
          typeof leaseToken !== 'string' || !leaseToken || Buffer.byteLength(leaseToken, 'utf8') > MAX_JWT_BYTES) {
        throw new Error('BOT_PROOF_INVALID');
      }
      const instant = currentTime(now);
      const intent = verifySignedIntent(intentToken, { jwks: options.jwks, scope: options.scope, now: instant });
      const hostContext = options.currentHostContext();
      if (!hostContext) throw new Error('HOST_EXECUTION_NOT_CONNECTED');
      const lease = verifySignedLease(leaseToken, {
        jwks: options.jwks,
        scope: options.scope,
        now: instant,
        intent,
        host_context: hostContext,
      });
      return deepFreeze({ intent, lease });
    },

    verifyRevocation(token: string, target: { grant_id: string; bot_id: string; revoked_generation: number }): RevocationClaims {
      if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > MAX_JWT_BYTES) throw new Error('BOT_REVOCATION_INVALID');
      const nowValue = currentTime(now);
      const hostContext = options.currentHostContext();
      if (!hostContext) throw new Error('HOST_EXECUTION_NOT_CONNECTED');
      return deepFreeze(verifySignedRevocation(token, {
        jwks: options.jwks,
        scope: options.scope,
        now: nowValue,
        host_context: hostContext,
        grant_id: target.grant_id,
        bot_id: target.bot_id,
        revoked_generation: target.revoked_generation,
      }));
    },

    assertCurrent(proof: VerifiedBotCommand): void {
      const instant = currentTime(now);
      const current = options.currentHostContext();
      if (!current || !sameHostContext(current, proof.lease.host_context)) throw new Error('BOT_HOST_CONTEXT_STALE');
      if (instant >= proof.intent.exp || instant >= proof.lease.exp || instant < proof.intent.nbf || instant < proof.lease.nbf) {
        throw new Error('BOT_PROOF_EXPIRED');
      }
      const { command } = proof.intent;
      if (proof.lease.grant_id !== command.grant_id ||
          proof.lease.grant_generation !== command.grant_generation ||
          proof.lease.bot_id !== command.bot_id ||
          proof.lease.binding_generation !== command.binding_generation ||
          proof.lease.mutation_id !== command.mutation_id ||
          proof.lease.request_hash !== command.request_hash) throw new Error('BOT_PROOF_BINDING_MISMATCH');
    },
  };
}
