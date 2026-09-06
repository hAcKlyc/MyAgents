import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TokenDanceBalance,
  TokenDanceError,
} from '../../../shared/tokendance';

async function credentialVersion(apiKey: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(apiKey.trim()),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function tokenDanceError(error: unknown): TokenDanceError {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error as TokenDanceError;
  }
  return { code: 'network_error', message: 'network_error' };
}

export function useTokenDanceBalance(
  apiKey: string | undefined,
  isActive = true,
) {
  const identity = useMemo(
    () => ({
      configured: Boolean(apiKey?.trim()),
      version: apiKey?.trim() ? credentialVersion(apiKey) : Promise.resolve(''),
    }),
    [apiKey],
  );
  const [state, setState] = useState<{
    identity: typeof identity;
    data?: TokenDanceBalance;
    loading: boolean;
    error?: TokenDanceError;
    updatedAt?: number;
  }>({ identity, loading: false });
  const mounted = useRef(false);
  const current = useRef(identity);
  current.current = identity;
  const pending = useRef<{
    identity: typeof identity;
    promise: Promise<void>;
  } | null>(null);

  const refresh = useCallback(
    function refreshBalance(force = false): Promise<void> {
      if (!identity.configured || !mounted.current) return Promise.resolve();
      if (pending.current?.identity === identity)
        return force
          ? pending.current.promise.then(() => refreshBalance())
          : pending.current.promise;
      const work = (async () => {
        setState((previous) => ({
          ...(previous.identity === identity ? previous : { identity }),
          loading: true,
        }));
        try {
          const accountVersion = await identity.version;
          if (!mounted.current || current.current !== identity) return;
          const data = await invoke<TokenDanceBalance>(
            'cmd_tokendance_balance',
            { accountVersion },
          );
          if (
            data.accountVersion !== accountVersion ||
            ![data.balance, data.credits, data.creditsUsed].every(
              Number.isSafeInteger,
            )
          ) {
            throw { code: 'invalid_response', message: 'invalid_response' };
          }
          if (mounted.current && current.current === identity) {
            setState({ identity, data, loading: false, updatedAt: Date.now() });
          }
        } catch (error) {
          if (mounted.current && current.current === identity) {
            setState((previous) => {
              const sameAccount = previous.identity === identity;
              const failure = tokenDanceError(error);
              return {
                ...(sameAccount ? previous : { identity }),
                loading: false,
                error: {
                  ...failure,
                  recoveryAction:
                    failure.recoveryAction ??
                    (sameAccount ? previous.error?.recoveryAction : undefined),
                },
              };
            });
          }
        }
      })();
      pending.current = { identity, promise: work };
      void work.finally(() => {
        if (pending.current?.promise === work) pending.current = null;
      });
      return work;
    },
    [identity],
  );

  // Account API failures from the open payment panel share the same credential
  // scope. Only a supplier recovery header may alter the account action.
  const reportFailure = useCallback(
    (failure: TokenDanceError) => {
      if (
        !failure.recoveryAction ||
        !mounted.current ||
        current.current !== identity
      )
        return;
      setState((previous) =>
        previous.identity === identity
          ? { ...previous, error: failure }
          : { identity, loading: false, error: failure },
      );
    },
    [identity],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!isActive) return;
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh, isActive]);

  // The previous account's value is never visible while the next effect waits.
  const visible =
    state.identity === identity
      ? state
      : { identity, loading: identity.configured };
  return {
    ...visible,
    configured: identity.configured,
    version: identity.version,
    refresh,
    reportFailure,
  };
}
