// Channel detail view — adapted from ImBotDetail for Agent+Channel architecture.
// Keeps: credentials, binding, groups, platform-specific options, start/stop, enable/disable.
// Removes: workspace, MCP, heartbeat (all Agent-level).
// Execution settings belong to Agent defaults and individual Sessions.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDownIcon,
  LoaderIcon,
  PowerIcon,
  PowerOffIcon,
  TrashIcon,
} from '@/components/icons';
import QRCode from 'qrcode';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import feishuIcon from '../../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';
import { track } from '@/analytics';
import ConfirmDialog from '@/components/ConfirmDialog';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import {
    applyAgentChannelCredentialProvisioning,
    channelHasCredentials,
    invokeStartAgentChannel,
    patchAgentChannelConfig,
    patchAgentChannelOpenClawConfig,
    removeAgentChannelConfig,
    startAndEnableAgentChannel,
    stopAndDisableAgentChannel,
    type OpenClawPluginConfigMutation,
} from '@/config/services/agentConfigService';
import BotTokenInput from '../../ImSettings/components/BotTokenInput';
import FeishuCredentialInput from '../../ImSettings/components/FeishuCredentialInput';
import DingtalkCredentialInput from '../../ImSettings/components/DingtalkCredentialInput';
import WhitelistManager from '../../ImSettings/components/WhitelistManager';
import BindQrPanel from '../../ImSettings/components/BindQrPanel';
import BindCodePanel from '../../ImSettings/components/BindCodePanel';
import DingtalkCardConfig from '../../ImSettings/components/DingtalkCardConfig';
import GroupPermissionList from '../../ImSettings/components/GroupPermissionList';
import { resolveChannelDisplayName, isDirtyDisplayName } from '@/utils/channelDisplayName';
import type { AgentConfig, ChannelConfig } from '../../../../shared/types/agent';
import type { GroupActivation } from '../../../../shared/types/im';
import type { ChannelStatusData } from '@/hooks/useAgentStatuses';
import { isOpenClawPlatform } from '../../../../shared/types/im';
import type { InstalledPlugin } from '../../../../shared/types/im';
import { findPromotedByPlatform } from '../../ImSettings/promotedPlugins';
import { FEISHU_PERMISSIONS_JSON } from './ChannelWizard';
import { copyPlainText } from '@/utils/clipboard';
import OpenClawToolGroupsSelector from './OpenClawToolGroupsSelector';
import OpenClawScalarField from './OpenClawScalarField';
import {
    coerceOpenClawConfigValue,
    inferOpenClawSchemaField,
    isOpenClawConfigValueInvalid,
    isOpenClawConfigValueMissing,
    mergeOpenClawSchemaProperties,
    type OpenClawSchemaProperties,
} from './openclawConfigScalars';
import {
    credentialQrFailureMessageKey,
    type CredentialQrRunFailure,
    restartProvisionedChannelIfRunning,
    runCredentialQrProvisioning,
} from './credentialQrProvisioning';

// ===== OpenClaw Plugin Config Editor =====
export function OpenClawConfigEditor({
    pluginConfig,
    pluginId,
    npmSpec,
    schemaProperties,
    onChange,
}: {
    pluginConfig: Record<string, unknown>;
    pluginId: string;
    npmSpec: string;
    schemaProperties?: OpenClawSchemaProperties;
    onChange: (mutation: OpenClawPluginConfigMutation) => Promise<Record<string, unknown>>;
}) {
    const { t } = useTranslation('settings');
    const [draftConfig, setDraftConfig] = useState(pluginConfig);
    const [saveError, setSaveError] = useState<string | null>(null);
    const desiredConfigRef = useRef(pluginConfig);
    const persistedConfigRef = useRef(pluginConfig);
    const fieldRevisionRef = useRef<Record<string, number>>({});
    const fieldNames = Array.from(new Set([
        ...Object.keys(schemaProperties ?? {}),
        ...Object.keys(draftConfig),
    ]));

    const commitConfig = (
        nextConfig: Record<string, unknown>,
        mutation: OpenClawPluginConfigMutation,
    ) => {
        desiredConfigRef.current = nextConfig;
        const revision = (fieldRevisionRef.current[mutation.key] ?? 0) + 1;
        fieldRevisionRef.current[mutation.key] = revision;
        setSaveError(null);
        void (async () => {
            try {
                persistedConfigRef.current = await onChange(mutation);
            } catch (error) {
                // Roll back only this field, and only if the user has not
                // submitted a newer value for the same field. Other field
                // mutations are independent disk-latest transactions.
                if (fieldRevisionRef.current[mutation.key] === revision) {
                    const rollback = { ...desiredConfigRef.current };
                    if (Object.prototype.hasOwnProperty.call(persistedConfigRef.current, mutation.key)) {
                        rollback[mutation.key] = persistedConfigRef.current[mutation.key];
                    } else {
                        delete rollback[mutation.key];
                    }
                    desiredConfigRef.current = rollback;
                    setDraftConfig(rollback);
                    setSaveError(t('agentSettings.channelDetail.operationFailed', { message: String(error) }));
                }
            }
        })();
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                <span>{t('agentSettings.channelDetail.pluginLabel', { name: npmSpec || pluginId })}</span>
            </div>
            {fieldNames.length === 0 ? (
                <p className="text-sm text-[var(--ink-muted)]">{t('agentSettings.channelDetail.noExtraConfig')}</p>
            ) : (
                <div className="space-y-3">
                    {fieldNames.map((key) => {
                        const value = draftConfig[key];
                        const field = schemaProperties?.[key] ?? inferOpenClawSchemaField(value);
                        return (
                            <OpenClawScalarField
                                key={key}
                                name={key}
                                field={field}
                                value={value}
                                onChange={(nextValue) => {
                                    const nextDraft = { ...draftConfig, [key]: nextValue };
                                    setDraftConfig(nextDraft);
                                    if (isOpenClawConfigValueInvalid(nextValue, field)) return;
                                    if (isOpenClawConfigValueMissing(nextValue)) {
                                        const nextConfig = { ...desiredConfigRef.current };
                                        delete nextConfig[key];
                                        commitConfig(nextConfig, { type: 'delete', key });
                                        return;
                                    }
                                    const typedValue = field.type === 'string'
                                        ? nextValue
                                        : coerceOpenClawConfigValue(nextValue, field);
                                    commitConfig(
                                        { ...desiredConfigRef.current, [key]: typedValue },
                                        { type: 'set', key, value: typedValue },
                                    );
                                }}
                                placeholder={t('agentSettings.channelDetail.inputPlaceholder', { key })}
                            />
                        );
                    })}
                </div>
            )}
            {saveError && <p role="alert" className="text-xs text-[var(--error)]">{saveError}</p>}
            <p className="text-xs text-[var(--ink-muted)]">
                {t('agentSettings.channelDetail.restartRequired')}
            </p>
        </div>
    );
}

/** Inline collapsible button to view/copy Feishu permissions JSON */
function FeishuPermissionsButton() {
    const { t } = useTranslation('settings');
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    return (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
                <ChevronDownIcon className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                {t('agentSettings.channelDetail.feishuPermissionsJson')}
            </button>
            {expanded && (
                <div className="relative rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-3">
                    <button
                        type="button"
                        onClick={async () => {
                            try {
                                await copyPlainText(FEISHU_PERMISSIONS_JSON);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 1500);
                            } catch (error) {
                                console.warn('[ChannelDetail] Failed to copy permissions:', error);
                            }
                        }}
                        className="absolute right-2 top-2 rounded-md px-2 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                    >
                        {copied ? t('agentSettings.channelDetail.copied') : t('agentSettings.channelDetail.copy')}
                    </button>
                    <pre className="max-h-[240px] overflow-auto text-xs leading-relaxed text-[var(--ink-muted)]">
                        {FEISHU_PERMISSIONS_JSON}
                    </pre>
                </div>
            )}
        </div>
    );
}

interface ChannelDetailViewProps {
    agent: AgentConfig;
    channelId: string;
    onBack: () => void;
    onChanged: () => void;
}

export default function ChannelDetailView({
    agent,
    channelId,
    onBack,
    onChanged,
}: ChannelDetailViewProps) {
    const { t } = useTranslation('settings');
    const { config, refreshConfig } = useConfig();
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);
    const nameSyncedRef = useRef(false);

    // Find channel from agent config
    const channel = useMemo(
        () => agent.channels?.find(c => c.id === channelId),
        [agent.channels, channelId],
    );

    // Bot runtime status (uses channelId as botId)
    const [botStatus, setBotStatus] = useState<ChannelStatusData | null>(null);
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [toggling, setToggling] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [credentialsExpanded, setCredentialsExpanded] = useState<boolean | null>(null);
    const [bindingExpanded, setBindingExpanded] = useState<boolean | null>(null);
    const [groupsExpanded, setGroupsExpanded] = useState<boolean | null>(null);
    const [pluginMissing, setPluginMissing] = useState(false);
    const [installedPlugin, setInstalledPlugin] = useState<InstalledPlugin | null>(null);
    const [dualDetailMode, setDualDetailMode] = useState<'view' | 'qr' | 'edit'>('view');
    const [credentialQrImageUrl, setCredentialQrImageUrl] = useState<string | null>(null);
    const [credentialQrStatus, setCredentialQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'success' | 'error' | 'restart-error'>('idle');
    const [credentialQrErrorReason, setCredentialQrErrorReason] = useState<CredentialQrRunFailure['reason']>();
    const credentialQrRunIdRef = useRef(0);

    // Whether credentials are filled
    const hasCredentials = channel
        ? channel.type === 'feishu'
            ? !!(channel.feishuAppId && channel.feishuAppSecret)
            : channel.type === 'dingtalk'
                ? !!(channel.dingtalkClientId && channel.dingtalkClientSecret)
                : channel.type.startsWith('openclaw:')
                    ? !!channel.openclawPluginId
                    : !!channel.botToken
        : false;
    const hasUsers = (channel?.allowedUsers?.length ?? 0) > 0;

    // Auto-collapse: default collapsed when filled, expanded when empty
    const isCredentialsExpanded = credentialsExpanded ?? !hasCredentials;
    const isBindingExpanded = bindingExpanded ?? !hasUsers;

    useEffect(() => {
        const mountedRef = isMountedRef;
        const qrRunIdRef = credentialQrRunIdRef;
        return () => { mountedRef.current = false; qrRunIdRef.current++; };
    }, []);

    // Check if OpenClaw plugin is still installed
    useEffect(() => {
        if (!isTauriEnvironment() || !channel?.openclawPluginId || !channel.type.startsWith('openclaw:')) return;
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
                if (!cancelled) {
                    const found = plugins.find(p => p.pluginId === channel.openclawPluginId);
                    setPluginMissing(!found);
                    if (found) setInstalledPlugin(found);
                }
            } catch {
                // Ignore
            }
        })();
        return () => { cancelled = true; };
    }, [channel?.openclawPluginId, channel?.type]);

    // Patch channel config in agent
    const patchChannel = useCallback(async (patch: Partial<ChannelConfig>) => {
        await patchAgentChannelConfig(agent.id, channelId, patch);
        if (isMountedRef.current) onChanged();
    }, [agent.id, channelId, onChanged]);

    const patchOpenClawConfig = useCallback(async (mutation: OpenClawPluginConfigMutation) => {
        const updated = await patchAgentChannelOpenClawConfig(agent.id, channelId, mutation);
        if (isMountedRef.current) onChanged();
        return updated.openclawPluginConfig ?? {};
    }, [agent.id, channelId, onChanged]);

    // Ref for channel (used in effects without re-triggering)
    const channelRef = useRef(channel);
    channelRef.current = channel;

    // Poll bot status (skip while toggling to avoid overwriting optimistic update)
    const togglingRef = useRef(toggling);
    togglingRef.current = toggling;

    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const fetchStatus = async () => {
            if (togglingRef.current) return;
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ChannelStatusData | null>('cmd_agent_channel_status', { agentId: agent.id, channelId });
                if (isMountedRef.current && !togglingRef.current) {
                    setBotStatus(status);
                    if (status?.botUsername) {
                        const ch = channelRef.current;
                        // Skip dirty botUsername values (historical npm-spec dirt loaded
                        // from im_<botId>/state.json). Without this guard, auto-sync
                        // would persist dirt back into channel.name on disk — pre-v0.2.10
                        // bridges wrote pluginName ("wecom/wecom-openclaw-plugin") to
                        // bot_username, and HealthManager re-loads that on restart.
                        const dirty = isDirtyDisplayName(status.botUsername, ch?.openclawNpmSpec);
                        if (!dirty) {
                            setBotUsername(status.botUsername);
                            setVerifyStatus('valid');
                            // Auto-sync channel name from platform username (once)
                            if (!nameSyncedRef.current && !togglingRef.current) {
                                nameSyncedRef.current = true;
                                const displayName = ch?.type === 'telegram'
                                    ? `@${status.botUsername}`
                                    : status.botUsername;
                                if (ch?.name !== displayName) {
                                    patchAgentChannelConfig(agent.id, channelId, { name: displayName })
                                        .then(() => { if (isMountedRef.current) onChanged(); })
                                        .catch(err => {
                                            console.error('[ChannelDetail] Failed to sync channel name:', err);
                                        });
                                }
                            }
                        }
                    }
                }
            } catch {
                if (isMountedRef.current && !togglingRef.current) setBotStatus(null);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [channelId, agent.id]); // eslint-disable-line react-hooks/exhaustive-deps -- agent.channels excluded to prevent poll resets on every config change; channelRef tracks latest

    // Listen for user-bound events
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ botId: string; userId: string; username?: string }>(
            'im:user-bound',
            (event) => {
                if (!isMountedRef.current || event.payload.botId !== channelId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;
                toastRef.current.success(t('agentSettings.channelDetail.userBound', { name: displayName }));
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [channelId, t]);

    // Listen for group permission changes
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        const ac = new AbortController();
        void listenWithCleanup<{ botId: string; event: string; groupName?: string }>(
            'im:group-permission-changed',
            (ev) => {
                if (!isMountedRef.current || ev.payload.botId !== channelId) return;
                if (ev.payload.event === 'added') {
                    toastRef.current.info(t('agentSettings.channelDetail.groupPending', { name: ev.payload.groupName ?? '' }));
                }
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [channelId, t]);

    // Toggle channel start/stop
    const botStatusRef = useRef(botStatus);
    botStatusRef.current = botStatus;

    const toggleChannel = useCallback(async () => {
        if (!isTauriEnvironment() || !channelRef.current) return;

        setToggling(true);
        try {
            const isRunning = botStatusRef.current?.status === 'online' || botStatusRef.current?.status === 'connecting';

            if (channelRef.current.enabled || isRunning) {
                // Disable desired intent even after connection failure so the
                // backend monitor cannot restart a channel the user stopped.
                await stopAndDisableAgentChannel(agent.id, channelId);
                if (isMountedRef.current) {
                    track('agent_channel_toggle', { platform: channelRef.current.type, enabled: false });
                    toastRef.current.success(t('agentSettings.channelDetail.stopped'));
                    setBotStatus(null);
                }
            } else {
                const ch = channelRef.current;
                if (!channelHasCredentials(ch)) {
                    toastRef.current.error(ch.type === 'telegram'
                        ? t('agentSettings.channelDetail.missingBotToken')
                        : t('agentSettings.channelDetail.missingCredentials'));
                    setToggling(false);
                    return;
                }
                // issue #219 v2 symmetric: persist enabled=true + start with the fresh
                // post-write snapshot in one operation. Replaces the prior
                // (startChannelCmd + patchChannel{enabled:true}) inline pair which had
                // the same stale-array clobber risk as the old stop path.
                await startAndEnableAgentChannel(agent.id, channelId);
                if (isMountedRef.current) {
                    track('agent_channel_toggle', { platform: channelRef.current.type, enabled: true });
                    toastRef.current.success(t('agentSettings.channelDetail.started'));
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(t('agentSettings.channelDetail.operationFailed', { message: String(err) }));
            }
        } finally {
            if (isMountedRef.current) {
                setToggling(false);
                onChanged();
            }
        }
    }, [agent.id, channelId, onChanged, t]);

    // Delete channel
    const executeDelete = useCallback(async () => {
        setDeleting(true);
        try {
            await removeAgentChannelConfig(agent.id, channelId);
            track('agent_channel_remove', {
                source: 'desktop',
                platform: channelRef.current?.type ?? 'unknown',
            });
            toastRef.current.success(t('agentSettings.channelDetail.deleted'));
            onChanged();
            onBack();
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(t('agentSettings.channelDetail.deleteFailed', { message: String(err) }));
                setDeleting(false);
                setShowDeleteConfirm(false);
                onChanged();
            }
        }
    }, [agent.id, channelId, onChanged, onBack, t]);

    // Derived values that depend on channel (safe with optional chaining before early return)
    const isRunning = botStatus?.status === 'online' || botStatus?.status === 'connecting';
    const shouldStop = Boolean(channel?.enabled) || isRunning;
    const isOpenClaw = channel ? isOpenClawPlatform(channel.type) : false;
    const promoted = isOpenClaw && channel ? findPromotedByPlatform(channel.type) : undefined;
    const openclawSchemaProperties = useMemo(
        () => mergeOpenClawSchemaProperties(
            installedPlugin?.manifest?.configSchema?.properties,
            promoted?.defaultConfig,
        ),
        [installedPlugin?.manifest?.configSchema?.properties, promoted?.defaultConfig],
    );
    const isQrLoginPlugin = promoted?.authType === 'qrLogin' || installedPlugin?.supportsQrLogin === true;
    const isDualConfigPlugin = promoted?.authType === 'dualConfig';
    const credentialQrProvider = isDualConfigPlugin ? promoted?.credentialQrProvider : undefined;

    // Existing credentials remain authoritative until a complete new
    // provisioning result commits atomically.
    const startCredentialQrRescan = useCallback(async () => {
        if (!isTauriEnvironment() || !credentialQrProvider) return;
        const runId = ++credentialQrRunIdRef.current;
        const isCancelled = () => !isMountedRef.current || credentialQrRunIdRef.current !== runId;
        let credentialsPersisted = false;
        setCredentialQrStatus('loading');
        setCredentialQrErrorReason(undefined);
        setCredentialQrImageUrl(null);
        setDualDetailMode('qr');
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const result = await runCredentialQrProvisioning({
                provider: credentialQrProvider,
                invoke,
                isCancelled,
                onPhase: phase => {
                    if (!isCancelled()) setCredentialQrStatus(phase);
                },
                onQrUrl: async url => {
                    const dataUrl = await QRCode.toDataURL(url, {
                        width: 200,
                        margin: 2,
                        color: { dark: '#000000', light: '#ffffff' },
                    });
                    if (!isCancelled()) setCredentialQrImageUrl(dataUrl);
                },
            });
            if (isCancelled() || result.kind === 'cancelled') return;
            if (result.kind === 'success') {
                // Runtime status is an execution-layer fact. Read it at commit
                // time instead of using the potentially minutes-old render
                // snapshot captured before the user scanned the QR code.
                const currentStatus = await invoke<ChannelStatusData | null>(
                    'cmd_agent_channel_status',
                    { agentId: agent.id, channelId },
                );
                if (isCancelled()) return;
                const updatedChannel = await applyAgentChannelCredentialProvisioning(
                    agent.id,
                    channelId,
                    result.result.configValues,
                    result.result.allowedUserId,
                );
                credentialsPersisted = true;
                if (isMountedRef.current) onChanged();
                if (isCancelled()) return;
                await restartProvisionedChannelIfRunning(
                    currentStatus,
                    () => invoke<void>('cmd_stop_agent_channel', { agentId: agent.id, channelId }),
                    () => invokeStartAgentChannel(agent, updatedChannel),
                );
                setCredentialQrStatus('success');
                toastRef.current.success(t('agentSettings.channelDetail.credentialsUpdated'));
                setDualDetailMode('view');
                return;
            }
            setCredentialQrErrorReason(result.reason);
            setCredentialQrStatus('error');
        } catch (error) {
            if (!isCancelled()) {
                if (credentialsPersisted) {
                    setCredentialQrStatus('restart-error');
                    toastRef.current.error(t('agentSettings.channelDetail.credentialsUpdatedRestartFailed', { message: String(error) }));
                } else {
                    setCredentialQrStatus('error');
                    toastRef.current.error(t('agentSettings.channelDetail.operationFailed', { message: String(error) }));
                }
            }
        }
    }, [agent, channelId, credentialQrProvider, onChanged, t]);

    // QR Login state — must be declared before any early return (rules-of-hooks)
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [qrMessage, setQrMessage] = useState('');
    const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'connected' | 'error'>('idle');
    const qrAbortRef = useRef(false);
    const qrSessionKeyRef = useRef<string | undefined>(undefined);
    const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);

    // Convert qrDataUrl to renderable image (URL → QR-encode, data:image → pass through)
    useEffect(() => {
        if (!qrDataUrl) { setQrImageUrl(null); return; }
        if (qrDataUrl.startsWith('data:image/')) { setQrImageUrl(qrDataUrl); return; }
        let cancelled = false;
        QRCode.toDataURL(qrDataUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
            .then((url: string) => { if (!cancelled) setQrImageUrl(url); })
            .catch(() => { if (!cancelled) setQrImageUrl(null); });
        return () => { cancelled = true; };
    }, [qrDataUrl]);

    const startDetailQrLogin = useCallback(async () => {
        if (!channel || !isTauriEnvironment() || !isRunning) return;
        qrAbortRef.current = false;
        setQrStatus('loading');
        setQrMessage(t('agentSettings.channelDetail.gettingQr'));
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const startResult = await invoke<{ ok: boolean; qrDataUrl?: string; message?: string; sessionKey?: string }>(
                'cmd_plugin_qr_login_start', { agentId: agent.id, channelId: channel.id }
            );
            if (!startResult.ok || !startResult.qrDataUrl) {
                throw new Error(startResult.message || t('agentSettings.channelDetail.qrFetchFailed'));
            }
            if (!isMountedRef.current) return;
            qrSessionKeyRef.current = startResult.sessionKey;
            setQrDataUrl(startResult.qrDataUrl);
            setQrStatus('waiting');
            setQrMessage(t('agentSettings.channelDetail.scanWithName', { name: promoted?.name || channel.name || 'App' }));
            // Poll for scan completion (pass sessionKey — WeChat requires it)
            const MAX_QR_RETRIES = 10;
            let qrRetryCount = 0;
            while (!qrAbortRef.current && isMountedRef.current) {
                try {
                    const waitResult = await invoke<{ ok: boolean; connected?: boolean; message?: string; accountId?: string }>(
                        'cmd_plugin_qr_login_wait', { agentId: agent.id, channelId: channel.id, sessionKey: qrSessionKeyRef.current }
                    );
                    if (!isMountedRef.current || qrAbortRef.current) return;
                    if (waitResult.connected) {
                        setQrStatus('connected');
                        setQrMessage(t('agentSettings.channelDetail.loginSuccess'));
                        await invoke('cmd_plugin_restart_gateway', { agentId: agent.id, channelId: channel.id, accountId: waitResult.accountId });
                        // Persist accountId so Bridge finds credentials on restart
                        if (waitResult.accountId) {
                            await patchAgentChannelOpenClawConfig(
                                agent.id,
                                channel.id,
                                { type: 'set', key: 'accountId', value: waitResult.accountId },
                            );
                            await refreshConfig();
                        }
                        toastRef.current.success(t('agentSettings.channelDetail.scanLoginSuccess'));
                        return;
                    }
                    if (waitResult.message) setQrMessage(waitResult.message);
                    await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                    if (!isMountedRef.current || qrAbortRef.current) return;
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isTerminal = /ECONNREFUSED|not support|501/i.test(errMsg);
                    if (isTerminal || qrRetryCount >= MAX_QR_RETRIES) {
                        setQrStatus('error');
                        setQrMessage(qrRetryCount >= MAX_QR_RETRIES
                            ? t('agentSettings.channelDetail.qrMaxRetries', { count: MAX_QR_RETRIES })
                            : t('agentSettings.channelDetail.loginFailed', { message: errMsg }));
                        return;
                    }
                    qrRetryCount++;
                    try {
                        const r = await invoke<{ ok: boolean; qrDataUrl?: string; sessionKey?: string }>('cmd_plugin_qr_login_start', { agentId: agent.id, channelId: channel.id });
                        if (r.ok && r.qrDataUrl) { qrSessionKeyRef.current = r.sessionKey; setQrDataUrl(r.qrDataUrl); setQrMessage(t('agentSettings.channelDetail.qrRefreshed', { current: qrRetryCount, max: MAX_QR_RETRIES })); }
                    } catch { setQrStatus('error'); setQrMessage(t('agentSettings.channelDetail.qrFetchFailed')); return; }
                }
            }
        } catch (err) {
            if (isMountedRef.current) { setQrStatus('error'); setQrMessage(t('agentSettings.channelDetail.detailQrFailed', { message: String(err) })); }
        }
    }, [isRunning, agent.id, channel, promoted?.name, refreshConfig, t]);

    // Early return AFTER all hooks (rules-of-hooks compliance)
    if (!channel) {
        return (
            <div className="text-center py-12">
                <p className="text-sm text-[var(--ink-muted)]">{t('agentSettings.channelDetail.channelNotFound')}</p>
                <button onClick={onBack} className="mt-4 text-sm text-[var(--button-primary-bg)] hover:underline">
                    {t('agentSettings.channelDetail.backToList')}
                </button>
            </div>
        );
    }

    // Platform icon for header
    const detailPlatformIcon = (() => {
        if (channel.type === 'telegram') return telegramIcon;
        if (channel.type === 'feishu') return feishuIcon;
        if (channel.type === 'dingtalk') return dingtalkIcon;
        const promoted = findPromotedByPlatform(channel.type);
        if (promoted) return promoted.icon;
        return undefined;
    })();

    const platformLabel = channel.type === 'telegram' ? 'Telegram'
        : channel.type === 'feishu' ? '飞书'
        : channel.type === 'dingtalk' ? '钉钉'
        : findPromotedByPlatform(channel.type)?.name || channel.type;

    // Status summary for header
    const statusText = botStatus?.status === 'online' ? t('agentSettings.channelDetail.statusRunning')
        : botStatus?.status === 'connecting' ? t('agentSettings.channelDetail.statusConnecting')
        : botStatus?.status === 'error' ? t('agentSettings.channelDetail.statusError')
        : t('agentSettings.channelDetail.statusStopped');
    const statusColor = botStatus?.status === 'online' ? 'var(--success)'
        : botStatus?.status === 'connecting' ? 'var(--warning)'
        : botStatus?.status === 'error' ? 'var(--error)'
        : 'var(--ink-subtle)';
    const uptimeText = botStatus && botStatus.uptimeSeconds > 0
        ? (botStatus.uptimeSeconds >= 3600
            ? `${Math.floor(botStatus.uptimeSeconds / 3600)}h`
            : botStatus.uptimeSeconds >= 60
                ? `${Math.floor(botStatus.uptimeSeconds / 60)}m`
                : '<1m')
        : undefined;
    const sessionCount = botStatus?.activeSessions?.length ?? 0;

    return (
        <div className="space-y-6">
            {/* Header: icon + name + status + start/stop */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    {detailPlatformIcon && (
                        <img src={detailPlatformIcon} alt={platformLabel} className="h-8 w-8 rounded-lg" />
                    )}
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-[var(--ink)]">
                                {resolveChannelDisplayName(channel, botStatus, platformLabel)}
                            </h2>
                            <div className="flex items-center gap-1.5">
                                <div className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
                                <span className="text-xs" style={{ color: statusColor }}>{statusText}</span>
                            </div>
                            {uptimeText && (
                                <span className="text-xs text-[var(--ink-subtle)]">{uptimeText}</span>
                            )}
                            {sessionCount > 0 && (
                                <span className="text-xs text-[var(--ink-subtle)]">
                                    {t('agentSettings.channelDetail.sessionCount', { count: sessionCount })}
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-[var(--ink-muted)]">{platformLabel} Channel</p>
                    </div>
                </div>
                <button
                    onClick={toggleChannel}
                    disabled={toggling || (!shouldStop && (pluginMissing || !hasCredentials))}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        shouldStop
                            ? 'bg-[var(--error-bg)] text-[var(--error)] hover:brightness-95'
                            : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                    } disabled:opacity-50`}
                >
                    {toggling ? (
                        <LoaderIcon className="h-4 w-4 animate-spin" />
                    ) : shouldStop ? (
                        <PowerOffIcon className="h-4 w-4" />
                    ) : (
                        <PowerIcon className="h-4 w-4" />
                    )}
                    {shouldStop ? t('agentSettings.channelDetail.stop') : t('agentSettings.channelDetail.start')}
                </button>
            </div>

            {/* Plugin missing warning */}
            {pluginMissing && (
                <div className="flex items-center gap-3 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-3">
                    <span className="text-base">⚠️</span>
                    <div>
                        <p className="text-sm font-medium text-[var(--warning)]">{t('agentSettings.channelDetail.pluginUninstalledTitle')}</p>
                        <p className="text-xs text-[var(--ink-muted)]">
                            {t('agentSettings.channelDetail.pluginUninstalledDescription')}
                        </p>
                    </div>
                </div>
            )}

            {/* Platform credentials / Plugin config */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setCredentialsExpanded(!isCredentialsExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">
                            {isOpenClaw
                                ? (findPromotedByPlatform(channel.type)?.setupGuide?.credentialTitle || t('agentSettings.channelDetail.pluginConfig'))
                                : channel.type === 'feishu' ? t('agentSettings.channelDetail.credentialTitleFeishu') : channel.type === 'dingtalk' ? t('agentSettings.channelDetail.credentialTitleDingtalk') : t('agentSettings.channelDetail.credentialTitleTelegram')}
                        </h3>
                        {!isCredentialsExpanded && hasCredentials && (
                            <span className="text-xs text-[var(--success)]">
                                {isOpenClaw ? t('agentSettings.channelDetail.configured') : botUsername ? t('agentSettings.channelDetail.verified', { name: botUsername }) : t('agentSettings.channelDetail.configured')}
                            </span>
                        )}
                    </div>
                    <ChevronDownIcon className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isCredentialsExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isCredentialsExpanded && (
                    <div className="px-5 pb-5">
                        {isOpenClaw && isDualConfigPlugin ? (
                            /* dualConfig: existing summary by default, with explicit re-provision/edit actions */
                            <div className="space-y-4">
                                {dualDetailMode === 'view' && (
                                    <>
                                        <div className="space-y-2">
                                            {(promoted?.requiredFields ?? ['botId', 'secret']).map((key) => {
                                                const val = channel.openclawPluginConfig?.[key] ?? '';
                                                const displayValue = String(val);
                                                const masked = /secret|token|password|key/i.test(key)
                                                    ? (val ? '••••••••••••' : t('agentSettings.channelDetail.notConfigured'))
                                                    : (displayValue || t('agentSettings.channelDetail.notConfigured'));
                                                return (
                                                    <div key={key} className="flex items-center justify-between">
                                                        <span className="text-sm text-[var(--ink-muted)]">{key}</span>
                                                        <span className={`text-sm font-mono ${val ? 'text-[var(--ink)]' : 'text-[var(--ink-subtle)]'}`}>{masked}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={startCredentialQrRescan}
                                                disabled={!credentialQrProvider}
                                                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            >
                                                {t('agentSettings.channelDetail.rescan')}
                                            </button>
                                            <button
                                                onClick={() => setDualDetailMode('edit')}
                                                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            >
                                                {t('agentSettings.channelDetail.editCredentials')}
                                            </button>
                                        </div>
                                    </>
                                )}
                                {dualDetailMode === 'qr' && (
                                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)] p-4">
                                        {credentialQrStatus === 'loading' && <LoaderIcon className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />}
                                        {credentialQrStatus === 'waiting' && credentialQrImageUrl && (
                                            <div className="rounded-xl border border-[var(--line)] bg-white p-1">
                                                <img src={credentialQrImageUrl} alt={t('agentSettings.channelDetail.qrAlt')} className="h-[180px] w-[180px] rounded-lg" />
                                            </div>
                                        )}
                                        {credentialQrStatus === 'error' && <p className="text-sm text-[var(--error)]">{t(credentialQrFailureMessageKey(credentialQrErrorReason))}</p>}
                                        {credentialQrStatus === 'restart-error' && (
                                            <p className="text-sm text-[var(--warning)]">{t('agentSettings.channelDetail.credentialsUpdatedRestartFailedInline')}</p>
                                        )}
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {credentialQrStatus === 'loading'
                                                ? t('agentSettings.channelDetail.loadingQr')
                                                : credentialQrStatus === 'waiting'
                                                    ? t('agentSettings.channelDetail.scanWithNamedApp', { app: promoted?.name })
                                                    : ''}
                                        </p>
                                        <button
                                            onClick={() => { credentialQrRunIdRef.current++; setDualDetailMode('view'); }}
                                            className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] hover:underline"
                                        >
                                            {credentialQrStatus === 'restart-error'
                                                ? t('agentSettings.channelDetail.back')
                                                : t('agentSettings.channelDetail.cancel')}
                                        </button>
                                    </div>
                                )}
                                {dualDetailMode === 'edit' && (
                                    <div className="space-y-3">
                                        <OpenClawConfigEditor
                                            key={channel.id}
                                            pluginConfig={channel.openclawPluginConfig ?? {}}
                                            pluginId={channel.openclawPluginId ?? ''}
                                            npmSpec={channel.openclawNpmSpec ?? ''}
                                            schemaProperties={openclawSchemaProperties}
                                            onChange={patchOpenClawConfig}
                                        />
                                        <button
                                            onClick={() => setDualDetailMode('view')}
                                            className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] hover:underline"
                                        >
                                            {t('agentSettings.channelDetail.back')}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : isOpenClaw ? (
                            <OpenClawConfigEditor
                                key={channel.id}
                                pluginConfig={channel.openclawPluginConfig ?? {}}
                                pluginId={channel.openclawPluginId ?? ''}
                                npmSpec={channel.openclawNpmSpec ?? ''}
                                schemaProperties={openclawSchemaProperties}
                                onChange={patchOpenClawConfig}
                            />
                        ) : channel.type === 'dingtalk' ? (
                            <DingtalkCredentialInput
                                clientId={channel.dingtalkClientId ?? ''}
                                clientSecret={channel.dingtalkClientSecret ?? ''}
                                onClientIdChange={(clientId) => {
                                    // Check for dups across all agents' channels
                                    const allChannels = (config.agents ?? [])
                                        .flatMap(a => a.channels)
                                        .filter(ch => ch.id !== channelId && ch.setupCompleted);
                                    if (allChannels.some(ch => ch.dingtalkClientId === clientId)) {
                                        toastRef.current.error(t('agentSettings.channelDetail.duplicateDingtalk'));
                                        return;
                                    }
                                    patchChannel({ dingtalkClientId: clientId });
                                }}
                                onClientSecretChange={(clientSecret) => patchChannel({ dingtalkClientSecret: clientSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : channel.type === 'feishu' ? (
                            <FeishuCredentialInput
                                appId={channel.feishuAppId ?? ''}
                                appSecret={channel.feishuAppSecret ?? ''}
                                onAppIdChange={(appId) => {
                                    const allChannels = (config.agents ?? [])
                                        .flatMap(a => a.channels)
                                        .filter(ch => ch.id !== channelId && ch.setupCompleted);
                                    if (allChannels.some(ch => ch.feishuAppId === appId)) {
                                        toastRef.current.error(t('agentSettings.channelDetail.duplicateFeishu'));
                                        return;
                                    }
                                    patchChannel({ feishuAppId: appId });
                                }}
                                onAppSecretChange={(appSecret) => patchChannel({ feishuAppSecret: appSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : (
                            <BotTokenInput
                                value={channel.botToken ?? ''}
                                onChange={(token) => {
                                    const allChannels = (config.agents ?? [])
                                        .flatMap(a => a.channels)
                                        .filter(ch => ch.id !== channelId && ch.setupCompleted);
                                    if (allChannels.some(ch => ch.botToken === token)) {
                                        toastRef.current.error(t('agentSettings.channelDetail.duplicateBotToken'));
                                        return;
                                    }
                                    patchChannel({ botToken: token });
                                }}
                                verifyStatus={verifyStatus}
                                botUsername={botUsername}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* Feishu permissions JSON — quick access for existing configurations */}
            {(channel.type === 'feishu' || channel.openclawPluginId === 'openclaw-lark') && (
                <FeishuPermissionsButton />
            )}

            {/* OpenClaw Tool Groups (e.g. feishu) */}
            {isOpenClaw && channel.openclawPluginId && (
                <OpenClawToolGroupsSelector
                    enabledGroups={channel.openclawEnabledToolGroups}
                    onChange={async (newGroups) => {
                        await patchChannel({ openclawEnabledToolGroups: newGroups });
                    }}
                    pluginId={channel.openclawPluginId}
                />
            )}

            {/* User binding — all platforms including OpenClaw (Rust handles BIND codes) */}
            {(
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setBindingExpanded(!isBindingExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.channelDetail.userBinding')}</h3>
                        {!isBindingExpanded && hasUsers && (
                            <span className="text-xs text-[var(--ink-muted)]">
                                {t('agentSettings.channelDetail.usersCount', { count: channel.allowedUsers!.length })}
                            </span>
                        )}
                    </div>
                    <ChevronDownIcon className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isBindingExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isBindingExpanded && (
                    <div className="space-y-5 px-5 pb-5">
                        {/* QR Login section for plugins that use QR authentication (e.g. WeChat) */}
                        {isRunning && isQrLoginPlugin && (
                            <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)] p-4">
                                <div className="flex flex-col items-center gap-3">
                                    {qrStatus === 'idle' && (() => {
                                        const savedAccountId = (channel.openclawPluginConfig as Record<string, unknown> | undefined)?.accountId as string | undefined;
                                        if (savedAccountId) {
                                            return (
                                                <>
                                                    <div className="flex items-center gap-2">
                                                        <span className="h-2 w-2 rounded-full bg-[var(--accent-success)]" />
                                                        <span className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelDetail.loggedIn')}</span>
                                                    </div>
                                                    <p className="text-xs text-[var(--ink-muted)] font-mono">{savedAccountId}</p>
                                                    <button
                                                        onClick={startDetailQrLogin}
                                                        className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                                                    >
                                                        {t('agentSettings.channelDetail.rescan')}
                                                    </button>
                                                </>
                                            );
                                        }
                                        return (
                                            <button
                                                onClick={startDetailQrLogin}
                                                className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                            >
                                                {t('agentSettings.channelDetail.scanLogin')}
                                            </button>
                                        );
                                    })()}
                                    {qrStatus === 'loading' && (
                                        <LoaderIcon className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                    )}
                                    {(qrStatus === 'waiting') && qrImageUrl && (
                                        <div className="rounded-lg border border-[var(--line)] bg-white p-1">
                                            <img src={qrImageUrl} alt={t('agentSettings.channelDetail.qrAlt')} className="h-40 w-40 rounded-md" />
                                        </div>
                                    )}
                                    {qrStatus === 'connected' && (
                                        <p className="text-sm font-medium text-[var(--accent-success)]">{t('agentSettings.channelDetail.loginSuccess')}</p>
                                    )}
                                    {qrStatus === 'error' && (
                                        <button
                                            onClick={() => { setQrStatus('idle'); }}
                                            className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                        >
                                            {t('agentSettings.channelDetail.retry')}
                                        </button>
                                    )}
                                    {qrMessage && <p className="text-xs text-[var(--ink-muted)]">{qrMessage}</p>}
                                </div>
                            </div>
                        )}
                        {isRunning && (channel.type === 'feishu' || channel.type === 'dingtalk' || (isOpenClaw && !isQrLoginPlugin)) && botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={(channel.allowedUsers?.length ?? 0) > 0}
                                platformName={channel.type === 'dingtalk' ? '钉钉' : channel.type === 'feishu' ? '飞书' : (channel.name || t('agentSettings.channelDetail.pluginBot'))}
                            />
                        )}
                        {isRunning && channel.type === 'telegram' && botStatus?.bindUrl && (
                            <BindQrPanel
                                bindUrl={botStatus.bindUrl}
                                hasWhitelistUsers={(channel.allowedUsers?.length ?? 0) > 0}
                            />
                        )}
                        {isQrLoginPlugin ? (
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelDetail.userBinding')}</label>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    {t('agentSettings.channelDetail.qrBindingOnly')}
                                </p>
                            </div>
                        ) : (
                            <WhitelistManager
                                users={channel.allowedUsers ?? []}
                                onChange={async (users) => {
                                    await patchChannel({ allowedUsers: users });
                                }}
                                platform={channel.type}
                            />
                        )}
                    </div>
                )}
            </div>
            )}

            {/* Group Permissions */}
            {(() => {
                const groupPerms = channel.groupPermissions ?? [];
                const hasGroups = groupPerms.length > 0;
                const pendingCount = groupPerms.filter(g => g.status === 'pending').length;
                const approvedCount = groupPerms.filter(g => g.status === 'approved').length;
                const isGroupsExpanded_ = groupsExpanded ?? (pendingCount > 0 || hasGroups);
                return (
                    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                        <button
                            type="button"
                            onClick={() => setGroupsExpanded(!isGroupsExpanded_)}
                            className="flex w-full items-center justify-between p-5"
                        >
                            <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-[var(--ink)]">{t('agentSettings.channelDetail.groupManagement')}</h3>
                                {!isGroupsExpanded_ && hasGroups && (
                                    <span className="text-xs text-[var(--ink-muted)]">
                                        {approvedCount > 0 && t('agentSettings.channelDetail.groupsCount', { count: approvedCount })}
                                        {pendingCount > 0 && approvedCount > 0 && ' · '}
                                        {pendingCount > 0 && t('agentSettings.channelDetail.pendingCount', { count: pendingCount })}
                                    </span>
                                )}
                                {pendingCount > 0 && (
                                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--warning)] px-1.5 text-xs font-bold text-[var(--on-warning)]">
                                        {pendingCount}
                                    </span>
                                )}
                            </div>
                            <ChevronDownIcon className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isGroupsExpanded_ ? '' : '-rotate-90'}`} />
                        </button>
                        {isGroupsExpanded_ && (
                            <div className="space-y-4 px-5 pb-5">
                                {/* Group activation mode */}
                                {(() => {
                                    const isWecom = channel.type === 'openclaw:wecom';
                                    const effectiveMode: GroupActivation = isWecom ? 'mention' : (channel.groupActivation ?? 'mention');
                                    return (
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <p className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelDetail.groupActivation')}</p>
                                                <p className="text-xs text-[var(--ink-muted)]">
                                                    {isWecom
                                                        ? t('agentSettings.channelDetail.wecomMentionOnlyDescription')
                                                        : effectiveMode === 'mention'
                                                            ? t('agentSettings.channelDetail.mentionOnlyDescription')
                                                            : t('agentSettings.channelDetail.alwaysDescription')}
                                                </p>
                                            </div>
                                            <div className="flex rounded-lg bg-[var(--paper-inset)] p-0.5">
                                                {(['mention', 'always'] as GroupActivation[]).map(mode => {
                                                    const disabled = isWecom && mode === 'always';
                                                    const selected = effectiveMode === mode;
                                                    return (
                                                        <button
                                                            key={mode}
                                                            disabled={disabled}
                                                            title={disabled ? t('agentSettings.channelDetail.wecomModeDisabledTitle') : undefined}
                                                            onClick={async () => {
                                                                if (disabled) return;
                                                                await patchChannel({ groupActivation: mode });
                                                            }}
                                                            className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                                                                disabled
                                                                    ? 'cursor-not-allowed text-[var(--ink-muted)] opacity-40'
                                                                    : selected
                                                                        ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                                                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                                            }`}
                                                        >
                                                            {mode === 'mention' ? t('agentSettings.channelDetail.mentionMode') : t('agentSettings.channelDetail.alwaysMode')}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })()}
                                {/* Group list */}
                                <GroupPermissionList
                                    permissions={groupPerms}
                                    onApprove={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_approve_group', { botId: channelId, groupId });
                                    }}
                                    onReject={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_reject_group', { botId: channelId, groupId });
                                    }}
                                    onRemove={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_remove_group', { botId: channelId, groupId });
                                    }}
                                />
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* DingTalk AI Card Config */}
            {channel.type === 'dingtalk' && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <DingtalkCardConfig
                        useAiCard={channel.dingtalkUseAiCard ?? false}
                        cardTemplateId={channel.dingtalkCardTemplateId ?? ''}
                        onUseAiCardChange={async (value) => {
                            await patchChannel({ dingtalkUseAiCard: value });
                        }}
                        onCardTemplateIdChange={async (value) => {
                            await patchChannel({ dingtalkCardTemplateId: value || undefined });
                        }}
                    />
                </div>
            )}

            {/* Telegram Draft Streaming */}
            {channel.type === 'telegram' && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-[var(--ink)]">{t('agentSettings.channelDetail.draftStreamingTitle')}</p>
                            <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                                {t('agentSettings.channelDetail.draftStreamingDescription')}
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={channel.telegramUseDraft ?? true}
                            onClick={async () => {
                                await patchChannel({ telegramUseDraft: !(channel.telegramUseDraft ?? true) });
                            }}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                (channel.telegramUseDraft ?? true) ? 'bg-[var(--accent)]' : 'bg-[var(--ink-muted)]/30'
                            }`}
                        >
                            <span
                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[var(--toggle-thumb)] shadow ring-0 transition duration-200 ease-in-out ${
                                    (channel.telegramUseDraft ?? true) ? 'translate-x-4' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </div>
            )}

            {/* Danger zone */}
            <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error-bg)]/50 p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--error)]">{t('agentSettings.channelDetail.dangerZone')}</h3>
                <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:brightness-95"
                >
                    <TrashIcon className="h-4 w-4" />
                    {t('agentSettings.channelDetail.deleteChannel')}
                </button>
            </div>

            {/* Delete confirmation dialog */}
            {showDeleteConfirm && (
                <ConfirmDialog
                    title={t('agentSettings.channelDetail.deleteConfirmTitle')}
                    message={t('agentSettings.channelDetail.deleteConfirmMessage')}
                    confirmText={t('agentSettings.channelDetail.deleteConfirm')}
                    cancelText={t('agentSettings.channelDetail.cancel')}
                    confirmVariant="danger"
                    loading={deleting}
                    onConfirm={executeDelete}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            )}
        </div>
    );
}
