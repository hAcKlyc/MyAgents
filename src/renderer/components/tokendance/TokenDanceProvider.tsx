import { invoke } from '@tauri-apps/api/core';
import { listenWithCleanup } from '../../utils/tauriListen';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Provider } from '../../../shared/config-types';
import {
  formatTokenDanceBalance,
  type TokenDanceAuthView,
} from '../../../shared/tokendance';
import { useConfigData } from '../../config/useConfigData';
import { useConfigActions } from '../../config/useConfigActions';
import { openExternal } from '../../utils/openExternal';
import { copyPlainText } from '../../utils/clipboard';
import {
  fetchProviderModels,
  isTokenDanceConversationModel,
  type DiscoveredModel,
} from '../../config/services/modelDiscoveryService';
import ModelManagementPanel from '../ModelManagementPanel';
import WebsiteLink from '../ExternalLink';
import {
  TokenDanceDialog,
  TokenDanceBadge,
  iconButton,
  primaryButton,
  secondaryButton,
} from './TokenDanceDialog';
import { TokenDancePayment } from './TokenDancePayment';
import { tokenDanceError, useTokenDanceBalance } from './useTokenDanceBalance';

export default function TokenDanceProvider({
  provider,
  isActive = true,
}: {
  provider: Provider;
  isActive?: boolean;
}) {
  const { t, i18n } = useTranslation('settings', {
    keyPrefix: 'providers.tokendance',
  });
  const { config, apiKeys } = useConfigData();
  const {
    refreshProviderData,
    savePresetCustomModels,
    updateCustomProvider,
    savePrimaryModel,
  } = useConfigActions();
  const apiKey = apiKeys[provider.id];
  const balance = useTokenDanceBalance(apiKey, isActive);
  const [dialog, setDialog] = useState<
    'detail' | 'models' | 'auth' | 'payment' | null
  >(null);
  const [returnToDetail, setReturnToDetail] = useState(false);
  const [accountExpanded, setAccountExpanded] = useState(false);
  const [authView, setAuthView] = useState<TokenDanceAuthView | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [authFailure, setAuthFailure] = useState<string | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [catalog, setCatalog] = useState<DiscoveredModel[]>([]);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [viewerId] = useState(() => crypto.randomUUID());
  const mounted = useRef(false);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const paymentVersion = useRef(balance.version);
  const opening = useRef(false);
  const authRevision = useRef(0);
  const refreshRef = useRef(refreshProviderData);
  refreshRef.current = refreshProviderData;
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  useEffect(() => {
    mounted.current = true;
    const ac = new AbortController();
    const initialRevision = authRevision.current;
    const apply = (view: TokenDanceAuthView | null) => {
      if (!mounted.current) return;
      setAuthView(view);
      if (view?.phase === 'connected') {
        if (dialogRef.current === 'auth') {
          dialogRef.current = null;
          setDialog(null);
          void invoke('cmd_tokendance_auth_close', { viewerId }).catch(
            () => {},
          );
        }
        void refreshRef.current();
      }
    };
    void listenWithCleanup<TokenDanceAuthView>(
      'tokendance:auth-changed',
      (event) => {
        authRevision.current += 1;
        apply(event.payload);
      },
      ac.signal,
    )
      .then(async () => {
        if (ac.signal.aborted) return;
        try {
          const view = await invoke<TokenDanceAuthView | null>(
            'cmd_tokendance_auth_status',
          );
          if (!ac.signal.aborted && initialRevision === authRevision.current)
            apply(view);
        } catch {
          /* First login can retry a temporarily unavailable native host. */
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      ac.abort();
      clearTimeout(copyTimer.current);
      void invoke('cmd_tokendance_auth_close', { viewerId }).catch(() => {});
    };
  }, [viewerId]);

  useEffect(() => {
    if (dialog === 'payment' && paymentVersion.current !== balance.version) {
      setDialog(returnToDetail ? 'detail' : null);
    }
  }, [dialog, balance.version, returnToDetail]);

  useEffect(() => {
    if (dialog !== 'detail') return;
    let active = true;
    setCatalogFailed(false);
    void fetchProviderModels(provider, apiKey)
      .then((models) => {
        if (active) setCatalog(models.filter(isTokenDanceConversationModel));
      })
      .catch(() => {
        if (active) setCatalogFailed(true);
      });
    return () => {
      active = false;
    };
  }, [dialog, provider, apiKey]);

  const closeAuth = useCallback(() => {
    dialogRef.current = null;
    setDialog(null);
    void invoke('cmd_tokendance_auth_close', { viewerId }).catch(() => {});
  }, [viewerId]);
  const showWebsite = async (url: string) => {
    try {
      await openExternal(url);
    } catch {
      setLinkFailure('auth.openFailed');
    }
  };
  const openAuth = async (fresh = false) => {
    if (opening.current) return;
    opening.current = true;
    dialogRef.current = 'auth';
    setDialog('auth');
    setPreparing(true);
    setAuthFailure(null);
    setLinkFailure(null);
    setCopied(false);
    const revision = ++authRevision.current;
    try {
      const result = await invoke<{ view: TokenDanceAuthView; isNew: boolean }>(
        'cmd_tokendance_auth_open',
        { viewerId, fresh },
      );
      if (!mounted.current || dialogRef.current !== 'auth') {
        // Closing while native bind/config IO was pending still starts the
        // promised 15-minute grace, never an invisible indefinite listener.
        void invoke('cmd_tokendance_auth_close', { viewerId }).catch(() => {});
        if (mounted.current && revision === authRevision.current)
          setAuthView(result.view);
        return;
      }
      if (revision === authRevision.current) setAuthView(result.view);
      if (result.isNew && revision === authRevision.current)
        await showWebsite(result.view.authUrl);
    } catch (error) {
      if (mounted.current) setAuthFailure(tokenDanceError(error).code);
    } finally {
      opening.current = false;
      if (mounted.current) setPreparing(false);
    }
  };
  const retrySave = async () => {
    if (!authView) return;
    setAuthFailure(null);
    try {
      await invoke('cmd_tokendance_auth_retry_save', { id: authView.id });
    } catch (error) {
      if (mounted.current) setAuthFailure(tokenDanceError(error).code);
    }
  };
  const openPayment = (fromDetail: boolean) => {
    paymentVersion.current = balance.version;
    setReturnToDetail(fromDetail);
    setDialog('payment');
    void balance.refresh();
  };
  const invalid = balance.error?.recoveryAction === 'reauthorize_api_key';
  const loggedIn = balance.configured && !invalid;
  const activeAuth =
    preparing ||
    Boolean(
      authView && ['waiting', 'exchanging', 'saving'].includes(authView.phase),
    );
  const phase = preparing
    ? 'preparing'
    : authFailure
      ? 'failed'
      : (authView?.phase ?? 'idle');
  const status = invalid
    ? 'invalid'
    : loggedIn
      ? 'connected'
      : phase === 'connected'
        ? 'preparing'
        : phase;
  const failure = authFailure ?? authView?.error?.code;
  const refreshBalance = balance.refresh;
  const onBalanceChanged = useCallback(
    () => refreshBalance(true),
    [refreshBalance],
  );
  const enabledIds = new Set(provider.models.map((m) => m.model));
  const listed = catalog.length
    ? catalog
    : provider.models.map((model) => ({
        id: model.model,
        displayName: model.modelName,
      }));

  const balanceView = (large = false) => {
    const hasValue = balance.data !== undefined;
    const note = balance.loading
      ? hasValue
        ? 'balance.refreshing'
        : 'balance.loading'
      : balance.error
        ? hasValue
          ? 'balance.refreshFailed'
          : 'balance.unavailable'
        : !large && balance.data?.balance === 0
          ? 'balance.empty'
          : null;
    return (
      <div
        className="flex min-h-7 flex-wrap items-baseline gap-x-2 gap-y-1"
        aria-live="polite"
      >
        <span className="text-sm text-[var(--ink-muted)]">
          {t(balance.error && hasValue ? 'balance.previous' : 'balance.label')}
        </span>
        <span
          className={`${large ? 'text-3xl' : 'text-2xl'} leading-[1.3] font-semibold tabular-nums text-[var(--ink)]`}
        >
          {hasValue
            ? `¥${formatTokenDanceBalance(balance.data!.balance)}`
            : '—'}
        </span>
        {note && (
          <span
            className={`text-xs ${balance.error ? 'text-[var(--error)]' : balance.data?.balance === 0 && !balance.loading ? 'text-[var(--warning)]' : 'text-[var(--ink-muted)]'}`}
            title={
              balance.updatedAt
                ? t('balance.updatedAt', {
                    time: new Date(balance.updatedAt).toLocaleString(
                      i18n.resolvedLanguage,
                    ),
                  })
                : undefined
            }
          >
            {t(note)}
          </span>
        )}
      </div>
    );
  };
  const statusBadge = (
    <TokenDanceBadge
      tone={
        loggedIn
          ? 'success'
          : ['failed', 'save-failed', 'expired', 'invalid'].includes(status)
            ? 'error'
            : status === 'idle'
              ? 'muted'
              : 'info'
      }
    >
      {t(`auth.status.${status}`)}
    </TokenDanceBadge>
  );

  return (
    <>
      <div
        className="min-w-0 rounded-xl border p-5"
        style={{
          background: 'var(--featured-card-background)',
          borderColor: 'var(--featured-card-border)',
          boxShadow: 'var(--featured-card-shadow)',
        }}
        data-tokendance-card
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-lg font-semibold text-[var(--ink)]">
                {provider.name}
              </h3>
              <TokenDanceBadge>{t('partner')}</TokenDanceBadge>
            </div>
            <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
              {provider.models.map((m) => m.modelName).join(', ') ||
                t('models.empty')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <WebsiteLink
              href="https://tokendance.space/models"
              className="whitespace-nowrap rounded-lg px-1.5 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              {i18n.t('providers.website', { ns: 'settings' })}
            </WebsiteLink>
            <button
              type="button"
              className={iconButton}
              onClick={() => setDialog('detail')}
              aria-label={t('details')}
            >
              <Settings2 className="h-4 w-4" />
            </button>
          </div>
        </div>
        {balance.configured ? (
          balanceView()
        ) : (
          <p className="min-h-7 text-sm text-[var(--ink-muted)]">
            {t('intro')}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
            <span>{t('account')}</span>
            {statusBadge}
            {loggedIn &&
              (activeAuth ||
                ['failed', 'save-failed', 'expired'].includes(phase)) && (
                <button
                  type="button"
                  onClick={() => void openAuth()}
                  aria-label={t('auth.progress')}
                >
                  <TokenDanceBadge tone={activeAuth ? 'info' : 'error'}>
                    {t(`auth.status.${phase}`)}
                  </TokenDanceBadge>
                </button>
              )}
            {balance.error?.recoveryAction === 'api_key_quota' && (
              <button
                type="button"
                onClick={() => {
                  setAccountExpanded(true);
                  setDialog('detail');
                }}
                className="text-[var(--warning)]"
              >
                {t('quota')}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {loggedIn ? (
              <>
                <button
                  type="button"
                  className={iconButton}
                  disabled={balance.loading}
                  aria-label={t('balance.refresh')}
                  onClick={() => void balance.refresh()}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${balance.loading ? 'animate-spin motion-reduce:animate-none' : ''}`}
                  />
                </button>
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => openPayment(false)}
                >
                  <Plus className="h-4 w-4" />
                  {t('payment.action')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={primaryButton}
                onClick={() => void openAuth()}
              >
                <Link2 className="h-4 w-4" />
                {t(
                  activeAuth
                    ? 'auth.progress'
                    : phase === 'save-failed'
                      ? 'auth.retrySave'
                      : invalid || ['failed', 'expired'].includes(phase)
                        ? 'auth.reconnect'
                        : 'auth.connect',
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {dialog === 'auth' && (
        <TokenDanceDialog
          title={t('auth.title')}
          badge={
            <TokenDanceBadge tone={failure ? 'error' : 'info'}>
              {t(`auth.status.${phase}`)}
            </TokenDanceBadge>
          }
          onClose={closeAuth}
        >
          <section>
            <p className="text-sm font-medium">
              {t(preparing ? 'auth.result.preparing' : 'auth.guide')}
            </p>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              {t('auth.fallback')}
            </p>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ink-muted)]">
                {preparing
                  ? t('auth.preparingLink')
                  : (authView?.authUrl ?? t('auth.preparingLink'))}
              </span>
              <button
                type="button"
                className={iconButton}
                disabled={preparing || !authView?.authUrl}
                onClick={async () => {
                  try {
                    await copyPlainText(authView!.authUrl);
                    setCopied(true);
                    clearTimeout(copyTimer.current);
                    copyTimer.current = setTimeout(
                      () => setCopied(false),
                      2000,
                    );
                  } catch {
                    setLinkFailure('auth.copyFailed');
                  }
                }}
              >
                <Copy className="mr-1 inline h-3.5 w-3.5" />
                <span className="text-xs">
                  {t(copied ? 'auth.copied' : 'auth.copy')}
                </span>
              </button>
              <button
                type="button"
                className={iconButton}
                disabled={preparing || !authView?.authUrl}
                onClick={() => {
                  setLinkFailure(null);
                  void showWebsite(authView!.authUrl);
                }}
              >
                <ExternalLink className="mr-1 inline h-3.5 w-3.5" />
                <span className="text-xs">{t('auth.open')}</span>
              </button>
            </div>
            {linkFailure && (
              <p role="alert" className="mt-2 text-xs text-[var(--error)]">
                {t(linkFailure)}
              </p>
            )}
          </section>
          <section
            role="status"
            className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4"
          >
            <p className="flex items-center gap-2 text-sm font-medium">
              {activeAuth && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent-warm)] motion-reduce:animate-none" />
              )}
              {t(`auth.result.${phase}`)}
            </p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              {t(failure ? `error.${failure}` : `auth.hint.${phase}`, {
                defaultValue: t('error.request_failed'),
              })}
            </p>
            {!activeAuth &&
              (failure ||
                phase === 'expired' ||
                phase === 'failed' ||
                phase === 'save-failed') && (
                <button
                  type="button"
                  className={`${secondaryButton} mt-3`}
                  onClick={() =>
                    phase === 'save-failed'
                      ? void retrySave()
                      : void openAuth(true)
                  }
                >
                  {t(
                    phase === 'save-failed'
                      ? 'auth.retrySave'
                      : 'auth.reconnect',
                  )}
                </button>
              )}
          </section>
          <ol className="flex justify-between gap-2 text-xs">
            {['open', 'authorize', 'complete'].map((step, index) => (
              <li
                key={step}
                className={`flex items-center gap-1.5 ${index === 2 && !['exchanging', 'saving'].includes(phase) ? 'text-[var(--ink-subtle)]' : 'text-[var(--ink)]'}`}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--line)]">
                  {index + 1}
                </span>
                {t(`auth.step.${step}`)}
              </li>
            ))}
          </ol>
        </TokenDanceDialog>
      )}

      {dialog === 'detail' && (
        <TokenDanceDialog
          title={provider.name}
          badge={<TokenDanceBadge>{t('partner')}</TokenDanceBadge>}
          onClose={() => setDialog(null)}
        >
          <section>
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t('account')}</span>
                {statusBadge}
              </div>
              {loggedIn ? (
                <button
                  type="button"
                  className={secondaryButton}
                  aria-expanded={accountExpanded}
                  onClick={() => setAccountExpanded((value) => !value)}
                >
                  {t('manageAccount')}
                </button>
              ) : (
                <button
                  type="button"
                  className={primaryButton}
                  onClick={() => void openAuth()}
                >
                  {t('auth.connect')}
                </button>
              )}
            </div>
            {accountExpanded && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void openAuth(true)}
                >
                  {t('auth.reconnect')}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() =>
                    void showWebsite('https://tokendance.space/keys')
                  }
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('manageOnWebsite')}
                </button>
              </div>
            )}
          </section>
          {balance.configured ? (
            <section className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4">
              {balanceView()}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={balance.loading}
                  onClick={() => void balance.refresh()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('balance.refresh')}
                </button>
                {loggedIn && (
                  <button
                    type="button"
                    className={primaryButton}
                    onClick={() => openPayment(true)}
                  >
                    <Plus className="h-4 w-4" />
                    {t('payment.action')}
                  </button>
                )}
              </div>
            </section>
          ) : (
            <section className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4">
              <p className="text-sm text-[var(--ink-muted)]">
                {t('balance.label')} —
              </p>
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                {t('balance.loginRequired')}
              </p>
            </section>
          )}
          <section className="border-t border-[var(--line-subtle)] pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-medium">{t('models.title')}</h4>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  {t('models.summary', {
                    count: provider.models.length,
                    model:
                      provider.models.find(
                        (m) => m.model === provider.primaryModel,
                      )?.modelName ?? '—',
                  })}
                </p>
              </div>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => setDialog('models')}
              >
                {t('models.manage')}
              </button>
            </div>
            <div className="mt-3 grid max-h-44 grid-cols-2 gap-2 overflow-y-auto">
              {listed.map((model) => (
                <div
                  key={model.id}
                  className="flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink-muted)]"
                  title={model.id}
                >
                  {enabledIds.has(model.id) && (
                    <Check className="h-3 w-3 shrink-0 text-[var(--success)]" />
                  )}
                  <span className="truncate">
                    {model.displayName ?? model.id}
                  </span>
                </div>
              ))}
            </div>
            {catalogFailed && (
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                {t('models.catalogFailed')}
              </p>
            )}
          </section>
          <div className="border-t border-[var(--line-subtle)] pt-4">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-muted)] hover:text-[var(--ink)]"
              onClick={() => void showWebsite('https://tokendance.space')}
            >
              {t('website')}
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            {linkFailure && (
              <p role="alert" className="mt-2 text-xs text-[var(--error)]">
                {t(linkFailure)}
              </p>
            )}
          </div>
        </TokenDanceDialog>
      )}

      {dialog === 'models' && (
        <ModelManagementPanel
          provider={provider}
          apiKey={apiKey}
          config={config}
          onClose={() => setDialog('detail')}
          onSaveCustomModels={savePresetCustomModels}
          onUpdateCustomProvider={updateCustomProvider}
          onSetPrimaryModel={savePrimaryModel}
          onRefresh={refreshProviderData}
        />
      )}
      {dialog === 'payment' && paymentVersion.current === balance.version && (
        <TokenDancePayment
          accountVersion={balance.version}
          balance={balanceView(true)}
          onBalanceChanged={onBalanceChanged}
          onAccountError={balance.reportFailure}
          onClose={() => setDialog(returnToDetail ? 'detail' : null)}
        />
      )}
    </>
  );
}
