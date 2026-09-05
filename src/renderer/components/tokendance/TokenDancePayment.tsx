import { invoke } from '@tauri-apps/api/core';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import type {
  TokenDanceError,
  TokenDancePaymentSession,
} from '../../../shared/tokendance';
import { tokenDanceError } from './useTokenDanceBalance';
import {
  primaryButton,
  secondaryButton,
  TokenDanceBadge,
  TokenDanceDialog,
} from './TokenDanceDialog';

export function TokenDancePayment({
  accountVersion,
  balance,
  onBalanceChanged,
  onAccountError,
  onClose,
}: {
  accountVersion: Promise<string>;
  balance: ReactNode;
  onBalanceChanged: () => Promise<void>;
  onAccountError?: (error: TokenDanceError) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings', {
    keyPrefix: 'providers.tokendance',
  });
  const [amount, setAmount] = useState('50');
  const [creating, setCreating] = useState(false);
  const [session, setSession] = useState<TokenDancePaymentSession | null>(null);
  const [failure, setFailure] = useState<TokenDanceError | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const requestId = useRef<string | null>(null);
  const requestPending = useRef(false);
  const epoch = useRef(0);
  const onBalanceChangedRef = useRef(onBalanceChanged);
  onBalanceChangedRef.current = onBalanceChanged;
  const validAmount =
    /^\d+$/.test(amount) && Number(amount) >= 1 && Number(amount) <= 100_000;
  const expired =
    session?.status === 'pending' && now >= session.expired_at * 1000;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      if (requestId.current)
        void invoke('cmd_tokendance_cancel_payment_request', {
          requestId: requestId.current,
        }).catch(() => {});
    };
  }, []);

  const query = useCallback(async () => {
    if (
      !session ||
      session.status !== 'pending' ||
      Date.now() >= session.expired_at * 1000 ||
      requestPending.current
    )
      return;
    const thisEpoch = epoch.current;
    let id: string | null = null;
    requestPending.current = true;
    try {
      const version = await accountVersion;
      if (!mounted.current || epoch.current !== thisEpoch) return;
      id = await invoke<string>('cmd_tokendance_prepare_payment_request');
      if (!mounted.current || epoch.current !== thisEpoch) {
        void invoke('cmd_tokendance_cancel_payment_request', {
          requestId: id,
        }).catch(() => {});
        return;
      }
      requestId.current = id;
      const next = await invoke<TokenDancePaymentSession>(
        'cmd_tokendance_payment',
        {
          requestId: id,
          accountVersion: version,
          amount: null,
          sessionId: session.id,
        },
      );
      if (!mounted.current || epoch.current !== thisEpoch) return;
      setFailure(null);
      if (next.status !== 'pending') setSession(next);
    } catch (error) {
      if (mounted.current && epoch.current === thisEpoch) {
        const failure = tokenDanceError(error);
        setFailure(failure);
        onAccountError?.(failure);
      }
    } finally {
      if (requestId.current === id) requestId.current = null;
      requestPending.current = false;
    }
  }, [session, accountVersion, onAccountError]);

  useEffect(() => {
    if (!session || session.status !== 'pending') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!active || Date.now() >= session.expired_at * 1000) return;
      await query();
      if (active)
        timer = setTimeout(() => {
          void poll();
        }, 3000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 3000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [session, query]);

  useEffect(() => {
    if (session?.status === 'paid' || session?.status === 'refunded')
      void onBalanceChangedRef.current();
  }, [session?.id, session?.status]);

  useEffect(() => {
    let active = true;
    setQr(null);
    setQrFailed(false);
    if (session?.payment_url && session.status === 'pending') {
      void QRCode.toDataURL(session.payment_url, {
        width: 360,
        margin: 2,
        color: { dark: '#111111', light: '#ffffff' },
      })
        .then((url) => {
          if (active) setQr(url);
        })
        .catch(() => {
          if (active) setQrFailed(true);
        });
    }
    return () => {
      active = false;
    };
  }, [session?.id, session?.payment_url, session?.status]);

  const create = async () => {
    if (!validAmount || requestPending.current || creating) return;
    const thisEpoch = ++epoch.current;
    let id: string | null = null;
    requestPending.current = true;
    setCreating(true);
    setFailure(null);
    try {
      const version = await accountVersion;
      if (!mounted.current || epoch.current !== thisEpoch) return;
      id = await invoke<string>('cmd_tokendance_prepare_payment_request');
      if (!mounted.current || epoch.current !== thisEpoch) {
        void invoke('cmd_tokendance_cancel_payment_request', {
          requestId: id,
        }).catch(() => {});
        return;
      }
      requestId.current = id;
      const next = await invoke<TokenDancePaymentSession>(
        'cmd_tokendance_payment',
        {
          requestId: id,
          accountVersion: version,
          amount: Number(amount),
          sessionId: null,
        },
      );
      if (!mounted.current || epoch.current !== thisEpoch) return;
      setNow(Date.now());
      setSession(next);
    } catch (error) {
      if (mounted.current && epoch.current === thisEpoch) {
        const failure = tokenDanceError(error);
        setFailure(failure);
        onAccountError?.(failure);
      }
    } finally {
      if (requestId.current === id) requestId.current = null;
      requestPending.current = false;
      if (mounted.current && epoch.current === thisEpoch) setCreating(false);
    }
  };
  const status = expired ? 'expired' : session?.status;
  const terminal = Boolean(
    session && (session.status !== 'pending' || expired),
  );
  const seconds = session
    ? Math.max(0, Math.ceil((session.expired_at * 1000 - now) / 1000))
    : 0;
  const countdown = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;

  return (
    <TokenDanceDialog
      title={t('payment.title')}
      subtitle={t('payment.subtitle')}
      onClose={onClose}
      badge={
        status ? (
          <TokenDanceBadge
            tone={
              status === 'paid'
                ? 'success'
                : status === 'pending'
                  ? 'info'
                  : 'error'
            }
          >
            {t(`payment.status.${status}`)}
          </TokenDanceBadge>
        ) : undefined
      }
      footer={
        !session ? (
          <>
            <span className="text-xs text-[var(--ink-muted)]">
              {t('payment.scan')}
            </span>
            <button
              type="button"
              className={primaryButton}
              disabled={!validAmount || creating}
              onClick={() => void create()}
            >
              {creating && (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {t(creating ? 'payment.creating' : 'payment.generate')}
            </button>
          </>
        ) : terminal ? (
          <>
            <span />
            {session.status === 'paid' || session.status === 'refunded' ? (
              <button type="button" className={primaryButton} onClick={onClose}>
                {t('done')}
              </button>
            ) : (
              <button
                type="button"
                className={secondaryButton}
                onClick={() => {
                  epoch.current += 1;
                  if (requestId.current)
                    void invoke('cmd_tokendance_cancel_payment_request', {
                      requestId: requestId.current,
                    }).catch(() => {});
                  requestId.current = null;
                  setSession(null);
                  setFailure(null);
                }}
              >
                {t('payment.again')}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      {!session ? (
        <>
          {balance}
          <div>
            <p className="mb-3 text-xs text-[var(--ink-muted)]">
              {t('payment.choose')}
            </p>
            <div className="grid grid-cols-3 gap-2.5">
              {[10, 50, 100].map((value) => (
                <button
                  type="button"
                  key={value}
                  disabled={creating}
                  aria-pressed={Number(amount) === value}
                  onClick={() => setAmount(String(value))}
                  className={`rounded-lg border py-3 text-lg ${Number(amount) === value ? 'border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]' : 'border-[var(--line)] bg-[var(--paper)]'}`}
                >
                  ¥{value}
                </button>
              ))}
            </div>
          </div>
          <label className="block text-xs text-[var(--ink-muted)]">
            {t('payment.custom')}
            <input
              aria-label={t('payment.custom')}
              type="text"
              inputMode="numeric"
              value={amount}
              disabled={creating}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-2 block w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-sm text-[var(--ink)] focus:border-[var(--focus-border)] focus:outline-none"
            />
            <span className="mt-2 block">{t('payment.range')}</span>
          </label>
          {failure && (
            <p role="alert" className="text-xs text-[var(--error)]">
              {t(
                failure.recoveryAction
                  ? `payment.recovery.${failure.recoveryAction}`
                  : 'payment.createUnknown',
              )}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="text-center">
            <p className="text-xs text-[var(--ink-muted)]">
              {t('payment.recipient')}
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">
              ¥{session.amount.toFixed(2)}
            </p>
            {!terminal && (
              <>
                <div className="mx-auto my-5 flex h-[180px] w-[180px] items-center justify-center rounded-xl border border-[var(--line)] bg-white">
                  {qr ? (
                    <img
                      src={qr}
                      alt={t('payment.qrAlt')}
                      className="h-[170px] w-[170px]"
                    />
                  ) : qrFailed ? (
                    <span className="p-4 text-xs text-[var(--error)]">
                      {t('payment.qrFailed')}
                    </span>
                  ) : (
                    <Loader2 className="h-5 w-5 animate-spin text-gray-500 motion-reduce:animate-none" />
                  )}
                </div>
                <p className="text-xs text-[var(--ink-muted)]">
                  {t('payment.scan')}
                </p>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {t('payment.countdown', { time: countdown })}
                </p>
              </>
            )}
          </div>
          <div
            role="status"
            className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4"
          >
            <p className="flex items-center gap-2 text-sm font-medium">
              {session.status === 'paid' ? (
                <Check className="h-4 w-4 text-[var(--success)]" />
              ) : !terminal ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t(`payment.result.${status ?? 'pending'}`)}
            </p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              {t(`payment.hint.${status ?? 'pending'}`)}
            </p>
            {failure && !terminal && (
              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--error)]">
                <span>
                  {t(
                    failure.recoveryAction
                      ? `payment.recovery.${failure.recoveryAction}`
                      : 'payment.queryFailed',
                  )}
                </span>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void query()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('retry')}
                </button>
              </div>
            )}
          </div>
          {(session.status === 'paid' || session.status === 'refunded') &&
            balance}
        </>
      )}
    </TokenDanceDialog>
  );
}
