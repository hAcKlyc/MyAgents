import { Check, KeyRound, Loader2, Plus, RefreshCw, Trash2, X, AlertCircle, Globe, ExternalLink as ExternalLinkIcon, Settings2 } from 'lucide-react';
import { ExternalLink } from '@/components/ExternalLink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import GlobalSkillsPanel from '@/components/GlobalSkillsPanel';
import {
    getModelsDisplay,
    PRESET_PROVIDERS,
    type Provider,
    type ProviderVerifyStatus,
    type McpServerDefinition,
    type McpServerType,
    PRESET_MCP_SERVERS,
    MCP_DISCOVERY_LINKS,
    type McpInstallState,
    isVerifyExpired,
    SUBSCRIPTION_PROVIDER_ID,
    PROXY_DEFAULTS,
    isValidProxyHost,
} from '@/config/types';
import {
    getAllMcpServers,
    getEnabledMcpServerIds,
    toggleMcpServerEnabled,
    addCustomMcpServer,
    deleteCustomMcpServer,
    getAllMcpInstallStatus,
    setMcpInstallStatus,
} from '@/config/configService';
import { useConfig } from '@/hooks/useConfig';
import { isDebugMode, getBuildVersions } from '@/utils/debug';
import {
    isDeveloperSectionUnlocked,
    unlockDeveloperSection,
    UNLOCK_CONFIG,
} from '@/utils/developerMode';
import { REACT_LOG_EVENT } from '@/utils/frontendLogger';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { LogEntry } from '@/types/log';
import { compareVersions } from '../../shared/utils';

// Settings sub-sections
type SettingsSection = 'providers' | 'mcp' | 'skills' | 'about';

import type { SubscriptionStatusWithVerify } from '@/types/subscription';

// Verification status for each provider
type VerifyStatus = 'idle' | 'loading' | 'valid' | 'invalid';

// Use shared type with verification state
type SubscriptionStatus = SubscriptionStatusWithVerify;

// Custom provider form data
interface CustomProviderForm {
    name: string;
    cloudProvider: string;  // 服务商标签
    baseUrl: string;
    models: string[];  // 支持多个模型 ID
    newModelInput: string;  // 用于输入新模型的临时值
    apiKey: string;
}

const EMPTY_CUSTOM_FORM: CustomProviderForm = {
    name: '',
    cloudProvider: '',
    baseUrl: '',
    models: [],
    newModelInput: '',
    apiKey: '',
};

// Provider edit form data (for managing existing providers)
interface ProviderEditForm {
    provider: Provider;
    customModels: string[];  // 用户添加的自定义模型
    removedModels: string[]; // 用户标记删除的已保存模型（model ID）
    newModelInput: string;
    // 自定义供应商编辑字段
    editName?: string;
    editCloudProvider?: string;
    editBaseUrl?: string;
}

interface SettingsProps {
    /** Initial section to display (e.g., 'providers') */
    initialSection?: string;
    /** Callback when section changes (to clear initialSection) */
    onSectionChange?: () => void;
}

const VALID_SECTIONS: SettingsSection[] = ['providers', 'mcp', 'skills', 'about'];

// Memoized component for model tag list to avoid recreating presetModelIds on every render
const ModelTagList = React.memo(function ModelTagList({
    provider,
    removedModels,
    onRemove,
    customModels,
    onRemoveCustomModel,
}: {
    provider: Provider;
    removedModels: string[];
    onRemove: (modelId: string) => void;
    customModels: string[];           // Newly added models (not yet saved)
    onRemoveCustomModel: (modelId: string) => void;
}) {
    // For preset providers, determine which models are preset vs user-added
    const presetModelIds = useMemo(() => {
        if (!provider.isBuiltin) return new Set<string>();
        const presetProvider = PRESET_PROVIDERS.find(p => p.id === provider.id);
        return new Set(presetProvider?.models.map(m => m.model) ?? []);
    }, [provider.id, provider.isBuiltin]);

    const visibleModels = useMemo(
        () => provider.models.filter(m => !removedModels.includes(m.model)),
        [provider.models, removedModels]
    );

    return (
        <>
            {/* Existing saved models */}
            {visibleModels.map((model) => {
                const isPresetModel = presetModelIds.has(model.model);
                const canDelete = !isPresetModel;

                return (
                    <div
                        key={model.model}
                        className={`group flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--ink)] ${
                            canDelete
                                ? 'bg-[var(--paper-contrast)] hover:bg-[var(--paper-inset)]'
                                : 'bg-[var(--paper-contrast)]'
                        }`}
                    >
                        <span>{model.modelName}</span>
                        {isPresetModel ? (
                            <span className="text-[9px] text-[var(--ink-muted)]">预设</span>
                        ) : (
                            <button
                                type="button"
                                onClick={() => onRemove(model.model)}
                                className="ml-0.5 rounded p-0.5 text-[var(--ink-muted)] opacity-0 transition-opacity hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] group-hover:opacity-100"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                );
            })}
            {/* Newly added models (not yet saved) */}
            {customModels.map((model) => (
                <div
                    key={`custom-${model}`}
                    className="group flex items-center gap-1 rounded-md bg-[var(--paper-contrast)] px-2 py-1 text-xs font-medium text-[var(--ink)] hover:bg-[var(--paper-inset)]"
                >
                    <span>{model}</span>
                    <button
                        type="button"
                        onClick={() => onRemoveCustomModel(model)}
                        className="ml-0.5 rounded p-0.5 text-[var(--ink-muted)] opacity-0 transition-opacity hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] group-hover:opacity-100"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ))}
        </>
    );
});

export default function Settings({ initialSection, onSectionChange }: SettingsProps) {
    const {
        apiKeys,
        saveApiKey,
        deleteApiKey: deleteApiKeyService,
        providerVerifyStatus,
        saveProviderVerifyStatus,
        config,
        updateConfig,
        providers,
        projects,
        updateProject,
        addCustomProvider,
        updateCustomProvider,
        deleteCustomProvider: deleteCustomProviderService,
        savePresetCustomModels,
        removePresetCustomModel,
    } = useConfig();
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    // Determine initial section: use initialSection if valid, otherwise default to 'providers'
    const getInitialSection = (): SettingsSection => {
        if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
            return initialSection as SettingsSection;
        }
        return 'providers';
    };

    const [activeSection, setActiveSection] = useState<SettingsSection>(getInitialSection);

    // Stable callback ref for onSectionChange (avoids unnecessary effect triggers)
    const onSectionChangeRef = useRef(onSectionChange);
    onSectionChangeRef.current = onSectionChange;

    // Handle initial section from props (for deep linking)
    useEffect(() => {
        if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
            setActiveSection(initialSection as SettingsSection);
            onSectionChangeRef.current?.();
        }
    }, [initialSection]);
    const [showCustomForm, setShowCustomForm] = useState(false);
    const [customForm, setCustomForm] = useState<CustomProviderForm>(EMPTY_CUSTOM_FORM);
    // Provider edit/manage panel state
    const [editingProvider, setEditingProvider] = useState<ProviderEditForm | null>(null);
    // 删除确认弹窗状态
    const [deleteConfirmProvider, setDeleteConfirmProvider] = useState<Provider | null>(null);

    // UI-only loading state (not persisted)
    const [verifyLoading, setVerifyLoading] = useState<Record<string, boolean>>({});
    const [verifyError, setVerifyError] = useState<Record<string, string>>({});

    // Dev-only: Logs panel
    const [showLogs, setShowLogs] = useState(false);
    const [sseLogs, setSseLogs] = useState<LogEntry[]>([]);

    // App version from Tauri
    const [appVersion, setAppVersion] = useState<string>('');
    useEffect(() => {
        if (!isTauriEnvironment()) {
            setAppVersion('dev');
            return;
        }
        getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'));
    }, []);

    // QR code URL for user community section
    // Tauri: Downloads on first launch and caches locally, CDN in browser
    const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);

    // Load QR code when entering about section
    useEffect(() => {
        if (activeSection !== 'about') return;

        let cancelled = false;

        if (isTauriEnvironment()) {
            // Tauri mode: Call backend API to download & cache QR code
            // The API downloads from CDN on first call, then serves from cache
            apiGetJson<{ success: boolean; dataUrl?: string }>('/api/assets/qr-code')
                .then(result => {
                    if (cancelled) return;
                    if (result.success && result.dataUrl) {
                        setQrCodeDataUrl(result.dataUrl);
                    }
                })
                .catch((error) => {
                    console.error('[Settings] Failed to load QR code:', error);
                    // Silently fail - QR code section will remain hidden
                });
        } else {
            // Browser mode: Direct CDN URL
            setQrCodeDataUrl('https://download.myagents.io/assets/feedback_qr_code.png');
        }

        return () => {
            cancelled = true;
            if (!isTauriEnvironment()) {
                setQrCodeDataUrl(null);
            }
        };
    }, [activeSection]);

    // Manual update state (Developer section)
    type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'no-update' | 'error';
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
    const [remoteVersion, setRemoteVersion] = useState<string>('');
    const [updateError, setUpdateError] = useState<string>('');

    // Check for updates (fetch remote version info)
    const handleCheckUpdate = useCallback(async () => {
        if (!isTauriEnvironment()) {
            toast.error('此功能仅在桌面应用中可用');
            return;
        }

        setUpdateStatus('checking');
        setUpdateError('');

        try {
            const { invoke } = await import('@tauri-apps/api/core');

            // First, test connectivity and get remote version
            const result = await invoke('test_update_connectivity') as string;
            console.log('[Settings] Update check result:', result);

            // Parse version from result
            const versionMatch = result.match(/version:\s*([^\n]+)/);
            if (versionMatch) {
                const remote = versionMatch[1].trim();
                setRemoteVersion(remote);

                // Compare versions using semantic versioning
                const comparison = compareVersions(remote, appVersion);

                if (comparison === 0) {
                    setUpdateStatus('no-update');
                    toast.info('当前已是最新版本');
                } else if (comparison < 0) {
                    setUpdateStatus('no-update');
                    toast.info('当前版本比服务器版本更新');
                } else {
                    // New version available, start download
                    setUpdateStatus('downloading');
                    toast.info(`发现新版本 v${remote}，正在下载...`);

                    const downloaded = await invoke('check_and_download_update') as boolean;
                    if (downloaded) {
                        setUpdateStatus('ready');
                        toastRef.current.success('下载完成，可以重启更新');
                    } else {
                        setUpdateStatus('no-update');
                        toastRef.current.info('没有可用更新');
                    }
                }
            } else {
                throw new Error('无法解析远程版本信息');
            }
        } catch (err) {
            console.error('[Settings] Update check failed:', err);
            setUpdateStatus('error');
            setUpdateError(String(err));
            toastRef.current.error(`检查更新失败: ${err}`);
        }
    }, [appVersion]);

    // Restart to apply update
    const handleRestartUpdate = useCallback(async () => {
        if (!isTauriEnvironment()) return;

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('restart_app');
        } catch (err) {
            console.error('[Settings] Restart failed:', err);
            toastRef.current.error(`重启失败: ${err}`);
        }
    }, []);

    // Collect React and Rust logs for Settings page (since we don't have TabProvider)
    // Limit to 3000 logs to prevent memory issues (matches UnifiedLogsPanel MAX_DISPLAY_LOGS)
    const MAX_LOGS = 3000;
    useEffect(() => {
        const handleReactLog = (event: Event) => {
            const customEvent = event as CustomEvent<LogEntry>;
            setSseLogs(prev => {
                const next = [...prev, customEvent.detail];
                return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
            });
        };
        window.addEventListener(REACT_LOG_EVENT, handleReactLog);
        return () => {
            window.removeEventListener(REACT_LOG_EVENT, handleReactLog);
        };
    }, []);

    // Listen for Rust logs (Tauri only)
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        let isMounted = true;
        let unlisten: (() => void) | null = null;

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            // 防止组件卸载后设置监听器（竞态条件）
            if (!isMounted) return;
            unlisten = await listen<LogEntry>('log:rust', (event) => {
                setSseLogs(prev => {
                    const next = [...prev, event.payload];
                    return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
                });
            });
        })();

        return () => {
            isMounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    const clearLogs = useCallback(() => {
        setSseLogs([]);
    }, []);

    // Developer section unlock state
    const [devSectionVisible, setDevSectionVisible] = useState(isDeveloperSectionUnlocked);
    const logoTapCountRef = useRef(0);
    const logoTapTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Handle logo tap to unlock developer section
    const handleLogoTap = useCallback(() => {
        if (devSectionVisible) return; // Already unlocked

        logoTapCountRef.current += 1;

        // Clear existing timer and start new one
        if (logoTapTimerRef.current) {
            clearTimeout(logoTapTimerRef.current);
        }

        // Check if unlock threshold reached
        if (logoTapCountRef.current >= UNLOCK_CONFIG.requiredTaps) {
            unlockDeveloperSection();
            setDevSectionVisible(true);
            logoTapCountRef.current = 0;
            return;
        }

        // Reset counter after time window expires
        logoTapTimerRef.current = setTimeout(() => {
            logoTapCountRef.current = 0;
        }, UNLOCK_CONFIG.timeWindowMs);
    }, [devSectionVisible]);

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (logoTapTimerRef.current) {
                clearTimeout(logoTapTimerRef.current);
            }
        };
    }, []);

    // Anthropic subscription status
    const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);

    // Ref for verify timeout cleanup
    const verifyTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});

    // MCP state
    const [mcpServers, setMcpServersState] = useState<McpServerDefinition[]>([]);
    const [mcpEnabledIds, setMcpEnabledIds] = useState<string[]>([]);
    const [mcpInstallStatus, setMcpInstallStatusState] = useState<Record<string, McpInstallState>>({});
    const [showMcpForm, setShowMcpForm] = useState(false);
    const [mcpForm, setMcpForm] = useState<{
        id: string;
        name: string;
        type: McpServerType;
        command: string;
        args: string[];
        newArg: string;
        url: string;
        env: Record<string, string>;
        newEnvKey: string;
        headers: Record<string, string>;
        newHeaderKey: string;
    }>({
        id: '',
        name: '',
        type: 'stdio',
        command: '',
        args: [],
        newArg: '',
        url: '',
        env: {},
        newEnvKey: '',
        headers: {},
        newHeaderKey: '',
    });

    // Load MCP config on mount
    useEffect(() => {
        const loadMcp = async () => {
            try {
                const servers = await getAllMcpServers();
                const enabledIds = await getEnabledMcpServerIds();
                const installStatus = await getAllMcpInstallStatus();
                setMcpServersState(servers);
                setMcpEnabledIds(enabledIds);
                setMcpInstallStatusState(installStatus);
            } catch (err) {
                console.error('[Settings] Failed to load MCP config:', err);
            }
        };
        loadMcp();
    }, []);

    // Install MCP package
    const installMcp = async (server: McpServerDefinition): Promise<boolean> => {
        if (!server.command) return false;

        // Set installing status
        setMcpInstallStatusState(prev => ({ ...prev, [server.id]: { status: 'installing' } }));
        await setMcpInstallStatus(server.id, 'installing');

        try {
            const result = await apiPostJson<{ success: boolean; error?: string }>('/api/mcp/install', {
                serverId: server.id,
                command: server.command,
                args: server.args,
            });

            if (result.success) {
                setMcpInstallStatusState(prev => ({
                    ...prev,
                    [server.id]: { status: 'ready', installedAt: new Date().toISOString() }
                }));
                await setMcpInstallStatus(server.id, 'ready');
                return true;
            } else {
                setMcpInstallStatusState(prev => ({
                    ...prev,
                    [server.id]: { status: 'error', error: result.error }
                }));
                await setMcpInstallStatus(server.id, 'error', result.error);
                toast.error(`安装失败: ${result.error}`);
                return false;
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : '安装失败';
            setMcpInstallStatusState(prev => ({
                ...prev,
                [server.id]: { status: 'error', error: errorMsg }
            }));
            await setMcpInstallStatus(server.id, 'error', errorMsg);
            toast.error(errorMsg);
            return false;
        }
    };

    // Toggle MCP server enabled status - triggers install if enabling
    const handleMcpToggle = async (server: McpServerDefinition, enabled: boolean) => {
        if (!enabled) {
            // Just disable
            await toggleMcpServerEnabled(server.id, false);
            setMcpEnabledIds(prev => prev.filter(id => id !== server.id));
            toast.success('MCP 已禁用');
            return;
        }

        // Always check if actually installed locally (don't trust persisted status)
        setMcpInstallStatusState(prev => ({ ...prev, [server.id]: { status: 'installing' } }));

        try {
            // Check if package is actually installed locally
            const checkResult = await apiPostJson<{ installed: boolean; version?: string }>('/api/mcp/check', {
                serverId: server.id,
                args: server.args,
            });

            if (checkResult.installed) {
                // Already installed locally, just enable
                setMcpInstallStatusState(prev => ({
                    ...prev,
                    [server.id]: { status: 'ready', installedAt: new Date().toISOString() }
                }));
                await setMcpInstallStatus(server.id, 'ready');
                await toggleMcpServerEnabled(server.id, true);
                setMcpEnabledIds(prev => [...prev, server.id]);
                toast.success(`MCP 已启用 (v${checkResult.version || 'unknown'})`);
                return;
            }

            // Need to install - call install API
            const installResult = await apiPostJson<{ success: boolean; error?: string }>('/api/mcp/install', {
                serverId: server.id,
                command: server.command,
                args: server.args,
            });

            if (installResult.success) {
                setMcpInstallStatusState(prev => ({
                    ...prev,
                    [server.id]: { status: 'ready', installedAt: new Date().toISOString() }
                }));
                await setMcpInstallStatus(server.id, 'ready');
                await toggleMcpServerEnabled(server.id, true);
                setMcpEnabledIds(prev => [...prev, server.id]);
                toast.success('MCP 安装成功并已启用');
            } else {
                setMcpInstallStatusState(prev => ({
                    ...prev,
                    [server.id]: { status: 'error', error: installResult.error }
                }));
                await setMcpInstallStatus(server.id, 'error', installResult.error);
                toast.error(`安装失败: ${installResult.error}`);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : '操作失败';
            setMcpInstallStatusState(prev => ({
                ...prev,
                [server.id]: { status: 'error', error: errorMsg }
            }));
            await setMcpInstallStatus(server.id, 'error', errorMsg);
            toast.error(errorMsg);
        }
    };

    // Add custom MCP server - auto-install after adding
    const handleAddMcp = async () => {
        // Validate based on transport type
        if (!mcpForm.id || !mcpForm.name) return;
        if (mcpForm.type === 'stdio' && !mcpForm.command) return;
        if ((mcpForm.type === 'http' || mcpForm.type === 'sse') && !mcpForm.url) return;

        const newServer: McpServerDefinition = {
            id: mcpForm.id,
            name: mcpForm.name,
            type: mcpForm.type,
            isBuiltin: false,
            // stdio fields
            ...(mcpForm.type === 'stdio' && {
                command: mcpForm.command,
                args: mcpForm.args.length > 0 ? mcpForm.args : undefined,
                env: Object.keys(mcpForm.env).length > 0 ? mcpForm.env : undefined,
            }),
            // http/sse fields
            ...((mcpForm.type === 'http' || mcpForm.type === 'sse') && {
                url: mcpForm.url,
                headers: Object.keys(mcpForm.headers).length > 0 ? mcpForm.headers : undefined,
            }),
        };
        try {
            await addCustomMcpServer(newServer);
            setMcpServersState(prev => [...prev, newServer]);
            setMcpForm({
                id: '', name: '', type: 'stdio', command: '', args: [], newArg: '', url: '',
                env: {}, newEnvKey: '', headers: {}, newHeaderKey: ''
            });
            setShowMcpForm(false);

            if (mcpForm.type === 'stdio') {
                toast.success('MCP 服务器已添加，开始安装...');
                await installMcp(newServer);
            } else {
                toast.success('MCP 服务器已添加');
            }
        } catch (err) {
            toast.error('添加失败');
        }
    };

    // Delete custom MCP server
    const handleDeleteMcp = async (serverId: string) => {
        try {
            await deleteCustomMcpServer(serverId);
            setMcpServersState(prev => prev.filter(s => s.id !== serverId));
            setMcpEnabledIds(prev => prev.filter(id => id !== serverId));
            toast.success('已删除');
        } catch (err) {
            toast.error('删除失败');
        }
    };

    // Use refs to avoid useEffect dependency issues (P1 fix)
    const providerVerifyStatusRef = useRef(providerVerifyStatus);
    providerVerifyStatusRef.current = providerVerifyStatus;
    const saveProviderVerifyStatusRef = useRef(saveProviderVerifyStatus);
    saveProviderVerifyStatusRef.current = saveProviderVerifyStatus;

    // Check subscription status on mount (with retry for sidecar startup)
    // Uses cached verification result if valid and not expired (30 days)
    useEffect(() => {
        let isMounted = true;
        let retryCount = 0;
        const maxRetries = 3;
        const retryDelay = 1500; // 1.5s between retries

        const verifySubscriptionCredentials = async (status: SubscriptionStatus, forceVerify = false) => {
            // Only verify if oauthAccount exists
            if (!status.available || !status.info) {
                return;
            }

            const currentEmail = status.info.email;
            const cached = providerVerifyStatusRef.current[SUBSCRIPTION_PROVIDER_ID];

            // Check if we can use cached result
            if (!forceVerify && cached) {
                const isExpired = isVerifyExpired(cached.verifiedAt);
                const isSameAccount = cached.accountEmail === currentEmail;

                if (!isExpired && isSameAccount) {
                    // Use cached result
                    console.log('[Settings] Using cached subscription verification:', cached.status);
                    if (isMounted) {
                        setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? {
                            ...prev,
                            verifyStatus: cached.status,
                        } : prev);
                    }
                    return;
                }

                // Log reason for re-verification
                if (isExpired) {
                    console.log('[Settings] Subscription verification expired, re-verifying...');
                } else if (!isSameAccount) {
                    console.log('[Settings] Subscription account changed, re-verifying...');
                }
            }

            // Set loading state
            if (isMounted) {
                setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? { ...prev, verifyStatus: 'loading' } : prev);
            }

            try {
                const result = await apiPostJson<{ success: boolean; error?: string }>('/api/subscription/verify', {});
                const newStatus = result.success ? 'valid' : 'invalid';

                // Save to cache with account email
                await saveProviderVerifyStatusRef.current(SUBSCRIPTION_PROVIDER_ID, newStatus, currentEmail);

                if (isMounted) {
                    setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? {
                        ...prev,
                        verifyStatus: newStatus,
                        verifyError: result.error
                    } : prev);
                }
            } catch (err) {
                console.error('[Settings] Subscription verify failed:', err);
                // Save failure to cache
                await saveProviderVerifyStatusRef.current(SUBSCRIPTION_PROVIDER_ID, 'invalid', currentEmail);

                if (isMounted) {
                    setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? {
                        ...prev,
                        verifyStatus: 'invalid',
                        verifyError: err instanceof Error ? err.message : '验证失败'
                    } : prev);
                }
            }
        };

        const checkSubscription = () => {
            apiGetJson<SubscriptionStatus>('/api/subscription/status')
                .then((status) => {
                    if (!isMounted) return;
                    setSubscriptionStatus({ ...status, verifyStatus: 'idle' });
                    // Auto-verify if oauthAccount exists
                    if (status.available && status.info) {
                        verifySubscriptionCredentials(status);
                    }
                })
                .catch((err) => {
                    if (!isMounted) return;
                    // Retry if sidecar not ready
                    if (retryCount < maxRetries && err.message?.includes('sidecar')) {
                        retryCount++;
                        console.log(`[Settings] Subscription check retry ${retryCount}/${maxRetries}...`);
                        setTimeout(checkSubscription, retryDelay);
                    } else {
                        console.error('[Settings] Failed to check subscription:', err);
                        setSubscriptionStatus({ available: false });
                    }
                });
        };

        // Initial delay to let sidecar start
        const timer = setTimeout(checkSubscription, 500);
        return () => {
            isMounted = false;
            clearTimeout(timer);
        };
    }, []); // Only run on mount - refs handle the latest values

    // Verify API key for a provider
    const verifyProvider = useCallback(async (provider: Provider, apiKey: string) => {
        if (!apiKey || !provider.config.baseUrl) {
            console.warn('[verifyProvider] Missing apiKey or baseUrl');
            return;
        }

        console.log('[verifyProvider] ========================');
        console.log('[verifyProvider] Provider:', provider.id, provider.name);
        console.log('[verifyProvider] baseUrl:', provider.config.baseUrl);
        console.log('[verifyProvider] model:', provider.primaryModel);
        console.log('[verifyProvider] apiKey:', apiKey.slice(0, 10) + '...');

        setVerifyLoading((prev) => ({ ...prev, [provider.id]: true }));
        setVerifyError((prev) => ({ ...prev, [provider.id]: '' }));

        try {
            const result = await apiPostJson<{ success: boolean; error?: string; debug?: unknown }>('/api/provider/verify', {
                baseUrl: provider.config.baseUrl,
                apiKey,
                model: provider.primaryModel,
            });

            console.log('[verifyProvider] Result:', JSON.stringify(result, null, 2));
            console.log('[verifyProvider] ========================');

            if (result.success) {
                await saveProviderVerifyStatus(provider.id, 'valid');
            } else {
                await saveProviderVerifyStatus(provider.id, 'invalid');
                // Extract error message and show as toast
                const errorMsg = result.error || '验证失败';
                setVerifyError((prev) => ({ ...prev, [provider.id]: errorMsg }));
                toastRef.current.error(`${provider.name}: ${errorMsg}`);
            }
        } catch (err) {
            console.error('[verifyProvider] Exception:', err);
            await saveProviderVerifyStatus(provider.id, 'invalid');
            const errorMsg = err instanceof Error ? err.message : '验证失败';
            setVerifyError((prev) => ({
                ...prev,
                [provider.id]: errorMsg
            }));
            toastRef.current.error(`${provider.name}: ${errorMsg}`);
        } finally {
            setVerifyLoading((prev) => ({ ...prev, [provider.id]: false }));
        }
    }, [saveProviderVerifyStatus]);

    // Auto-verify when API key changes (with debounce)
    const handleSaveApiKey = useCallback(async (provider: Provider, key: string) => {
        await saveApiKey(provider.id, key);

        // Clear previous timeout for this provider
        if (verifyTimeoutRef.current[provider.id]) {
            clearTimeout(verifyTimeoutRef.current[provider.id]);
        }

        // Clear verification status when key changes - will re-verify
        if (key) {
            // Debounce verification
            verifyTimeoutRef.current[provider.id] = setTimeout(() => {
                verifyProvider(provider, key);
            }, 500);
        }
    }, [saveApiKey, verifyProvider]);

    // Cleanup timeouts on unmount
    useEffect(() => {
        return () => {
            Object.values(verifyTimeoutRef.current).forEach(clearTimeout);
        };
    }, []);

    const handleAddCustomProvider = async () => {
        if (!customForm.name || !customForm.baseUrl || customForm.models.length === 0) {
            return;
        }
        const newProvider: Provider = {
            id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            name: customForm.name,
            vendor: 'Custom',  // 内部保留但不在 UI 显示
            cloudProvider: customForm.cloudProvider || '自定义',
            type: 'api',
            primaryModel: customForm.models[0],
            isBuiltin: false,
            authType: 'auth_token',  // 默认使用 auth_token
            config: {
                baseUrl: customForm.baseUrl,
            },
            models: customForm.models.map((m) => ({
                model: m,
                modelName: m,
                modelSeries: 'custom',
            })),
        };

        try {
            // Persist to disk and refresh providers list
            await addCustomProvider(newProvider);
            // Save API key if provided
            if (customForm.apiKey) {
                await handleSaveApiKey(newProvider, customForm.apiKey);
            }
            toast.success('服务商添加成功');
        } catch (error) {
            console.error('[Settings] Failed to add custom provider:', error);
            toast.error('添加服务商失败');
            return;
        }

        setCustomForm(EMPTY_CUSTOM_FORM);
        setShowCustomForm(false);
    };

    // 确认删除自定义供应商
    const confirmDeleteCustomProvider = async () => {
        if (!deleteConfirmProvider) return;
        const providerId = deleteConfirmProvider.id;

        try {
            // 检查是否有项目正在使用该供应商，如果有则切换到其他供应商
            const affectedProjects = projects.filter(p => p.providerId === providerId);
            if (affectedProjects.length > 0) {
                // 找到第一个可用的其他供应商
                const alternativeProvider = providers.find(p => p.id !== providerId);
                if (alternativeProvider) {
                    // 更新所有受影响的项目
                    for (const project of affectedProjects) {
                        await updateProject({
                            ...project,
                            providerId: alternativeProvider.id,
                        });
                    }
                    console.log(`[Settings] Switched ${affectedProjects.length} project(s) to ${alternativeProvider.name}`);
                }
            }

            // Delete from disk, remove API key, and refresh providers list
            await deleteCustomProviderService(providerId);
            toast.success('服务商已删除');
        } catch (error) {
            console.error('[Settings] Failed to delete custom provider:', error);
            toast.error('删除服务商失败');
        }
        setDeleteConfirmProvider(null);
        setEditingProvider(null);
    };

    // Open provider management panel
    const openProviderManage = (provider: Provider) => {
        // For preset providers, we allow adding custom models
        // For custom providers, we can edit all fields
        setEditingProvider({
            provider,
            customModels: [],  // TODO: Load from persisted custom models if any
            removedModels: [], // 标记要删除的已保存模型
            newModelInput: '',
            // 为自定义供应商初始化编辑字段
            ...(provider.isBuiltin ? {} : {
                editName: provider.name,
                editCloudProvider: provider.cloudProvider,
                editBaseUrl: provider.config.baseUrl || '',
            }),
        });
    };

    // Add custom model to editing provider
    const addCustomModelToProvider = () => {
        if (!editingProvider || !editingProvider.newModelInput.trim()) return;
        const newModel = editingProvider.newModelInput.trim();
        // Check if model already exists
        const existingModels = editingProvider.provider.models.map((m) => m.model);
        if (existingModels.includes(newModel) || editingProvider.customModels.includes(newModel)) {
            toast.error('该模型 ID 已存在');
            return;
        }
        setEditingProvider({
            ...editingProvider,
            customModels: [...editingProvider.customModels, newModel],
            newModelInput: '',
        });
    };

    // Remove custom model from editing provider
    const removeCustomModelFromProvider = (modelId: string) => {
        if (!editingProvider) return;
        setEditingProvider({
            ...editingProvider,
            customModels: editingProvider.customModels.filter((m) => m !== modelId),
        });
    };

    // Remove existing (saved) model from editing provider
    // For custom providers: any model can be removed
    // For preset providers: only user-added models can be removed (not preset models)
    const removeExistingModel = (modelId: string) => {
        if (!editingProvider) return;
        setEditingProvider({
            ...editingProvider,
            removedModels: [...editingProvider.removedModels, modelId],
        });
    };

    // Save provider edits
    const saveProviderEdits = async () => {
        if (!editingProvider) return;
        const { provider, customModels, removedModels, editName, editCloudProvider, editBaseUrl } = editingProvider;

        if (provider.isBuiltin) {
            // For preset providers: save user-added custom models
            // 1. Get existing user-added models (from config.presetCustomModels)
            const existingCustomModels = config.presetCustomModels?.[provider.id] ?? [];
            // 2. Filter out removed models
            const remainingCustomModels = existingCustomModels.filter(m => !removedModels.includes(m.model));
            // 3. Add newly added models
            const newCustomModels = customModels.map(m => ({
                model: m,
                modelName: m,
                modelSeries: 'custom' as const,
            }));
            const finalCustomModels = [...remainingCustomModels, ...newCustomModels];
            // 4. Save
            try {
                await savePresetCustomModels(provider.id, finalCustomModels);
                if (customModels.length > 0 || removedModels.length > 0) {
                    toast.success('模型配置已更新');
                }
            } catch (error) {
                console.error('[Settings] Failed to save preset custom models:', error);
                toast.error('保存失败');
                return;
            }
        } else {
            // 验证必填字段
            if (!editName?.trim() || !editBaseUrl?.trim()) {
                toast.error('名称和 Base URL 不能为空');
                return;
            }
            // 验证 Base URL 格式
            const trimmedUrl = editBaseUrl.trim();
            if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
                toast.error('Base URL 必须以 http:// 或 https:// 开头');
                return;
            }
            // Filter out removed models from existing list, then add new custom models
            const remainingModels = provider.models.filter(m => !removedModels.includes(m.model));
            // Validate: at least one model must remain
            if (remainingModels.length === 0 && customModels.length === 0) {
                toast.error('供应商至少需要保留一个模型');
                return;
            }
            // For custom providers, update the provider and persist to disk
            const updatedProvider: Provider = {
                ...provider,
                name: editName.trim(),
                cloudProvider: editCloudProvider?.trim() || '自定义',
                config: {
                    ...provider.config,
                    baseUrl: editBaseUrl.trim(),
                },
                models: [
                    ...remainingModels,
                    ...customModels.map((m) => ({
                        model: m,
                        modelName: m,
                        modelSeries: 'custom',
                    })),
                ],
            };
            try {
                await updateCustomProvider(updatedProvider);
                toast.success('服务商已更新');
            } catch (error) {
                console.error('[Settings] Failed to update custom provider:', error);
                toast.error('更新服务商失败');
            }
        }
        setEditingProvider(null);
    };

    // providers from useConfig includes both preset and custom providers
    const allProviders = providers;

    // Refs for API Key expiry check (P2 fix - avoid stale closures)
    const allProvidersRef = useRef(allProviders);
    allProvidersRef.current = allProviders;
    const apiKeysRef = useRef(apiKeys);
    apiKeysRef.current = apiKeys;
    const verifyProviderRef = useRef(verifyProvider);
    verifyProviderRef.current = verifyProvider;

    // Check for expired API Key verifications on mount (30-day expiry)
    useEffect(() => {
        // Delay to let component stabilize
        const timer = setTimeout(() => {
            allProvidersRef.current.forEach((provider: Provider) => {
                // Skip subscription type (handled separately)
                if (provider.type === 'subscription') return;

                const apiKey = apiKeysRef.current[provider.id];
                const cached = providerVerifyStatusRef.current[provider.id];

                // Only check if has API key and has cached verification
                if (apiKey && cached?.verifiedAt) {
                    if (isVerifyExpired(cached.verifiedAt)) {
                        console.log(`[Settings] Provider ${provider.id} verification expired, re-verifying...`);
                        verifyProviderRef.current(provider, apiKey);
                    }
                }
            });
        }, 1000); // 1s delay to avoid race conditions

        return () => clearTimeout(timer);
    }, []); // Only run on mount - refs handle the latest values

    // Render verification status indicator
    const renderVerifyStatus = (provider: Provider) => {
        const isLoading = verifyLoading[provider.id];
        const cached = providerVerifyStatus[provider.id];
        const verifyStatus = cached?.status; // 'valid' | 'invalid' | undefined
        const error = verifyError[provider.id];
        const hasKey = !!apiKeys[provider.id];

        if (!hasKey) {
            return null;
        }

        return (
            <div className="flex items-center gap-1">
                {isLoading && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--info-bg)]">
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--info)]" />
                    </div>
                )}
                {!isLoading && verifyStatus === 'valid' && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--success-bg)]">
                        <Check className="h-4 w-4 text-[var(--success)]" />
                    </div>
                )}
                {!isLoading && verifyStatus === 'invalid' && (
                    <div
                        className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--error-bg)]"
                        title={error || '验证失败'}
                    >
                        <AlertCircle className="h-4 w-4 text-[var(--error)]" />
                    </div>
                )}
                {!isLoading && !verifyStatus && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--warning-bg)]" title="待验证">
                        <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
                    </div>
                )}
                {/* Refresh button for re-verification - hide if already valid */}
                {verifyStatus !== 'valid' && (
                    <button
                        type="button"
                        onClick={() => verifyProvider(provider, apiKeys[provider.id])}
                        disabled={isLoading}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)] disabled:opacity-50"
                        title="重新验证"
                    >
                        <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                    </button>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-full bg-[var(--paper)]">
            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={sseLogs}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
                onClearAll={clearLogs}
            />

            {/* Left sidebar */}
            <div className="w-52 shrink-0 border-r border-[var(--line)] p-6">
                <div className="mb-6 flex items-center justify-between">
                    <h1 className="text-xl font-semibold text-[var(--ink)]">设置</h1>
                    {config.showDevTools && (
                        <button
                            onClick={() => setShowLogs(true)}
                            className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                            title="查看 Rust 日志"
                        >
                            Logs
                        </button>
                    )}
                </div>

                <nav className="space-y-1">
                    <button
                        onClick={() => setActiveSection('providers')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-[15px] font-medium transition-colors ${activeSection === 'providers'
                            ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        模型供应商
                    </button>
                    <button
                        onClick={() => setActiveSection('skills')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-[15px] font-medium transition-colors ${activeSection === 'skills'
                            ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        技能 Skills
                    </button>
                    <button
                        onClick={() => setActiveSection('mcp')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-[15px] font-medium transition-colors ${activeSection === 'mcp'
                            ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        工具 & MCP
                    </button>
                    <button
                        onClick={() => setActiveSection('about')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-[15px] font-medium transition-colors ${activeSection === 'about'
                            ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        关于
                    </button>
                </nav>
            </div>

            {/* Right content area */}
            <div className="flex-1 overflow-y-auto">
                {/* Skills section uses wider layout */}
                {activeSection === 'skills' && (
                    <div className="px-8 py-8">
                        <GlobalSkillsPanel />
                    </div>
                )}

                {/* Other sections use narrower layout */}
                <div className={`mx-auto max-w-xl px-8 py-8 ${activeSection === 'skills' ? 'hidden' : ''}`}>

                    {activeSection === 'about' && (
                        <div className="space-y-6">
                            {/* Brand Header */}
                            <div className="rounded-2xl border border-[var(--line)] bg-gradient-to-br from-[var(--paper-contrast)] to-[var(--paper)] p-8">
                                <div className="flex flex-col items-center text-center">
                                    <h1
                                        className="text-[3rem] font-light tracking-tight text-[var(--ink)] cursor-default select-none"
                                        onClick={handleLogoTap}
                                    >
                                        MyAgents
                                    </h1>
                                    <p className="mt-1 text-sm font-medium text-[var(--ink-muted)]">
                                        Version {appVersion || '...'}
                                    </p>
                                    <p className="mt-3 text-base text-[var(--ink-secondary)]">
                                        Your Universal AI Assistant
                                    </p>
                                </div>
                            </div>

                            {/* Product Description */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-6">
                                <div className="space-y-4 text-sm leading-relaxed text-[var(--ink-secondary)]">
                                    <p>
                                        <span className="font-medium text-[var(--ink)]">MyAgents</span> 是一款本地运行的 AI Agent 桌面客户端，基于 Claude Agent SDK 运行，同时支持接入各家大模型与快速切换服务。
                                    </p>
                                    <p>
                                        MyAgents 已支持多标签页、多项目管理，让大家可以同时在电脑上跑若干个 Agent。Agent 可以读取文件、创建文档、执行命令——所有操作都在本地完成，让数据始终留在你的电脑里。
                                    </p>
                                    <p className="text-[var(--ink-muted)] italic">
                                        Claude Code 这类 Agent 让开发者首先见识到了 AGI 的雏形，那么我们希望 MyAgents 成为让更多的非开发者也能体会到创作的乐趣，体会到来自 AI 智能的推背感，成就更好的自己。
                                    </p>
                                </div>
                            </div>

                            {/* User Community QR Code - Hidden until image loads successfully */}
                            {qrCodeDataUrl && (
                                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-5">
                                    <div className="flex flex-col items-center text-center">
                                        <p className="text-sm font-medium text-[var(--ink)]">加入用户交流群</p>
                                        <p className="mt-1 text-xs text-[var(--ink-muted)]">扫码加入，与其他用户交流使用心得</p>
                                        <img
                                            src={qrCodeDataUrl}
                                            alt="用户交流群二维码"
                                            className="mt-4 h-36 w-36 rounded-lg"
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Contact & Links */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-5">
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">Developer</p>
                                        <p className="mt-1 text-[var(--ink)]">Ethan L</p>
                                    </div>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">Website</p>
                                        <ExternalLink
                                            href="https://myagents.io"
                                            className="mt-1 block text-[var(--accent)] hover:underline"
                                        >
                                            myagents.io
                                        </ExternalLink>
                                    </div>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">Contact</p>
                                        <ExternalLink
                                            href="mailto:myagents.io@gmail.com"
                                            className="mt-1 block text-[var(--accent)] hover:underline"
                                        >
                                            myagents.io@gmail.com
                                        </ExternalLink>
                                    </div>
                                </div>
                            </div>

                            {/* Copyright */}
                            <p className="text-center text-xs text-[var(--ink-muted)]">
                                © 2026 Ethan L. All rights reserved.
                            </p>

                            {/* Developer Section - Hidden by default, unlocked by tapping logo 5 times */}
                            {devSectionVisible && (
                                <div>
                                    <h2 className="mb-4 text-base font-medium text-[var(--ink-muted)]">开发者</h2>
                                    <div className="space-y-4">
                                        {/* Developer Mode Toggle */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-5">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <h3 className="text-sm font-medium text-[var(--ink)]">开发者模式</h3>
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                        显示页面上的日志入口按钮（如 Logs、System Info 等）。
                                                    </p>
                                                </div>
                                                <button
                                                    onClick={() => updateConfig({ showDevTools: !config.showDevTools })}
                                                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${config.showDevTools ? 'bg-[var(--success)]' : 'bg-[var(--paper-inset)]'
                                                        }`}
                                                >
                                                    <span
                                                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--paper-elevated)] shadow transition-transform ${config.showDevTools ? 'translate-x-5' : 'translate-x-0'
                                                            }`}
                                                    />
                                                </button>
                                            </div>
                                        </div>

                                        {/* Build Versions */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-5">
                                            <h3 className="mb-3 text-sm font-medium text-[var(--ink)]">构建信息</h3>
                                            <div className="space-y-2 text-xs">
                                                {(() => {
                                                    const versions = getBuildVersions();
                                                    return (
                                                        <>
                                                            <div className="flex justify-between">
                                                                <span className="text-[var(--ink-muted)]">Claude Agent SDK</span>
                                                                <span className="font-mono text-[var(--ink)]">{versions.claudeAgentSdk}</span>
                                                            </div>
                                                            <div className="flex justify-between">
                                                                <span className="text-[var(--ink-muted)]">Bun Runtime</span>
                                                                <span className="font-mono text-[var(--ink)]">{versions.bun}</span>
                                                            </div>
                                                            <div className="flex justify-between">
                                                                <span className="text-[var(--ink-muted)]">Tauri</span>
                                                                <span className="font-mono text-[var(--ink)]">{versions.tauri}</span>
                                                            </div>
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                        </div>

                                        {/* Manual Update */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-5">
                                            <h3 className="mb-3 text-sm font-medium text-[var(--ink)]">手动更新</h3>

                                            {/* Version comparison */}
                                            <div className="mb-4 space-y-2 text-xs">
                                                <div className="flex justify-between">
                                                    <span className="text-[var(--ink-muted)]">当前版本</span>
                                                    <span className="font-mono text-[var(--ink)]">v{appVersion}</span>
                                                </div>
                                                {remoteVersion && (
                                                    <div className="flex justify-between">
                                                        <span className="text-[var(--ink-muted)]">最新版本</span>
                                                        <span className={`font-mono ${(updateStatus === 'ready' || updateStatus === 'downloading') ? 'text-[var(--success)]' : 'text-[var(--ink)]'}`}>
                                                            v{remoteVersion}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Status message */}
                                            {updateStatus === 'no-update' && (
                                                <p className="mb-3 text-xs text-[var(--ink-muted)]">
                                                    ✓ 当前已是最新版本
                                                </p>
                                            )}
                                            {updateStatus === 'ready' && (
                                                <p className="mb-3 text-xs text-[var(--success)]">
                                                    ✓ 新版本已下载完成，点击下方按钮重启更新
                                                </p>
                                            )}
                                            {updateStatus === 'error' && (
                                                <p className="mb-3 text-xs text-[var(--error)]">
                                                    ✗ {updateError || '检查更新失败'}
                                                </p>
                                            )}

                                            {/* Action button */}
                                            {updateStatus === 'ready' ? (
                                                <button
                                                    onClick={handleRestartUpdate}
                                                    className="rounded-lg bg-[var(--success)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
                                                >
                                                    重启并更新
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={handleCheckUpdate}
                                                    disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                                                    className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-strong)] disabled:opacity-50"
                                                >
                                                    {updateStatus === 'checking' && '检查中...'}
                                                    {updateStatus === 'downloading' && '下载中...'}
                                                    {(updateStatus === 'idle' || updateStatus === 'no-update' || updateStatus === 'error') && '检查更新'}
                                                </button>
                                            )}
                                        </div>

                                        {/* Network Proxy Settings */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-5">
                                            <h3 className="mb-3 text-sm font-medium text-[var(--ink)]">网络代理</h3>
                                            <p className="mb-4 text-xs text-[var(--ink-muted)]">
                                                配置 HTTP/SOCKS5 代理，用于外部 API 请求（如 Clash、V2Ray 等）
                                            </p>

                                            {/* Enable toggle */}
                                            <div className="mb-4 flex items-center justify-between">
                                                <span className="text-xs text-[var(--ink-secondary)]">启用代理</span>
                                                <button
                                                    onClick={() => {
                                                        const current = config.proxySettings;
                                                        updateConfig({
                                                            proxySettings: {
                                                                enabled: !current?.enabled,
                                                                protocol: current?.protocol || PROXY_DEFAULTS.protocol,
                                                                host: current?.host || PROXY_DEFAULTS.host,
                                                                port: current?.port || PROXY_DEFAULTS.port,
                                                            }
                                                        });
                                                    }}
                                                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${config.proxySettings?.enabled ? 'bg-[var(--success)]' : 'bg-[var(--paper-inset)]'}`}
                                                >
                                                    <span
                                                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--paper-elevated)] shadow transition-transform ${config.proxySettings?.enabled ? 'translate-x-5' : 'translate-x-0'}`}
                                                    />
                                                </button>
                                            </div>

                                            {/* Proxy settings form */}
                                            {config.proxySettings?.enabled && (
                                                <div className="space-y-3 border-t border-[var(--line)] pt-4">
                                                    {/* Protocol */}
                                                    <div className="flex items-center gap-3">
                                                        <label className="w-16 text-xs text-[var(--ink-muted)]">协议</label>
                                                        <select
                                                            value={config.proxySettings?.protocol || PROXY_DEFAULTS.protocol}
                                                            onChange={(e) => {
                                                                updateConfig({
                                                                    proxySettings: {
                                                                        ...config.proxySettings!,
                                                                        protocol: e.target.value as 'http' | 'socks5',
                                                                    }
                                                                });
                                                            }}
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                                                        >
                                                            <option value="http">HTTP</option>
                                                            <option value="socks5">SOCKS5</option>
                                                        </select>
                                                    </div>

                                                    {/* Host */}
                                                    <div className="flex items-center gap-3">
                                                        <label className="w-16 text-xs text-[var(--ink-muted)]">服务器</label>
                                                        <input
                                                            type="text"
                                                            value={config.proxySettings?.host || PROXY_DEFAULTS.host}
                                                            onChange={(e) => {
                                                                const host = e.target.value.trim();
                                                                // Allow typing (validate on blur or save)
                                                                // Only update if valid or empty (will use default)
                                                                if (host === '' || isValidProxyHost(host)) {
                                                                    updateConfig({
                                                                        proxySettings: {
                                                                            ...config.proxySettings!,
                                                                            host: host || PROXY_DEFAULTS.host,
                                                                        }
                                                                    });
                                                                }
                                                            }}
                                                            placeholder={PROXY_DEFAULTS.host}
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
                                                        />
                                                    </div>

                                                    {/* Port */}
                                                    <div className="flex items-center gap-3">
                                                        <label className="w-16 text-xs text-[var(--ink-muted)]">端口</label>
                                                        <input
                                                            type="number"
                                                            min={1}
                                                            max={65535}
                                                            value={config.proxySettings?.port || PROXY_DEFAULTS.port}
                                                            onChange={(e) => {
                                                                const value = e.target.value;
                                                                // Empty input: restore default
                                                                if (value === '') {
                                                                    updateConfig({
                                                                        proxySettings: {
                                                                            ...config.proxySettings!,
                                                                            port: PROXY_DEFAULTS.port,
                                                                        }
                                                                    });
                                                                    return;
                                                                }
                                                                const port = parseInt(value, 10);
                                                                if (!isNaN(port) && port >= 1 && port <= 65535) {
                                                                    updateConfig({
                                                                        proxySettings: {
                                                                            ...config.proxySettings!,
                                                                            port,
                                                                        }
                                                                    });
                                                                }
                                                            }}
                                                            placeholder={String(PROXY_DEFAULTS.port)}
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
                                                        />
                                                    </div>

                                                    {/* Preview */}
                                                    <div className="mt-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2">
                                                        <span className="text-xs text-[var(--ink-muted)]">代理地址: </span>
                                                        <code className="text-xs font-mono text-[var(--ink)]">
                                                            {config.proxySettings?.protocol || PROXY_DEFAULTS.protocol}://{config.proxySettings?.host || PROXY_DEFAULTS.host}:{config.proxySettings?.port || PROXY_DEFAULTS.port}
                                                        </code>
                                                    </div>

                                                    <p className="text-[10px] text-[var(--ink-faint)]">
                                                        注意：修改后需要重启应用或切换标签页才能生效
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {activeSection === 'providers' && (
                        <div>
                            <div className="mb-8 flex items-center justify-between">
                                <h2 className="text-lg font-semibold text-[var(--ink)]">模型供应商</h2>
                                <button
                                    onClick={() => setShowCustomForm(true)}
                                    className="flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-strong)]"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    添加
                                </button>
                            </div>

                            <p className="mb-6 text-sm text-[var(--ink-muted)]">
                                配置 API 密钥以使用不同的模型供应商
                            </p>

                            {/* Provider list */}
                            <div className="space-y-4">
                                {allProviders.map((provider) => (
                                    <div
                                        key={provider.id}
                                        className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 transition-all hover:shadow-sm"
                                    >
                                        {/* Provider header */}
                                        <div className="mb-4 flex items-start justify-between">
                                            <div>
                                                <div className="flex items-center gap-2">
                                                    <h3 className="font-semibold text-[var(--ink)]">{provider.name}</h3>
                                                    <span className="rounded bg-[var(--paper-contrast)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                                                        {provider.cloudProvider}
                                                    </span>
                                                </div>
                                                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                    {getModelsDisplay(provider)}
                                                </p>
                                            </div>
                                            <button
                                                onClick={() => openProviderManage(provider)}
                                                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                                                title="管理"
                                            >
                                                <Settings2 className="h-4 w-4" />
                                            </button>
                                        </div>

                                        {/* API Key input */}
                                        {provider.type === 'api' && (
                                            <div className="flex items-center gap-2">
                                                <div className="relative flex-1">
                                                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
                                                    <input
                                                        type="password"
                                                        placeholder="输入 API Key"
                                                        value={apiKeys[provider.id] || ''}
                                                        onChange={(e) => handleSaveApiKey(provider, e.target.value)}
                                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] py-2.5 pl-10 pr-4 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                    />
                                                </div>
                                                {renderVerifyStatus(provider)}
                                            </div>
                                        )}

                                        {/* Subscription type - show status */}
                                        {provider.type === 'subscription' && (
                                            <div className="space-y-2">
                                                <p className="text-sm text-[var(--ink-muted)]">
                                                    使用 Anthropic 订阅账户，无需 API Key
                                                </p>
                                                {/* Subscription status display */}
                                                <div className="flex items-center gap-2 text-xs flex-wrap">
                                                    {subscriptionStatus?.available ? (
                                                        <>
                                                            {/* Email display first */}
                                                            <span className="text-[var(--ink-muted)] font-mono text-[10px]">
                                                                {subscriptionStatus.info?.email}
                                                            </span>
                                                            {/* Verification status after email */}
                                                            {subscriptionStatus.verifyStatus === 'loading' && (
                                                                <div className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                    <span>验证中...</span>
                                                                </div>
                                                            )}
                                                            {subscriptionStatus.verifyStatus === 'valid' && (
                                                                <div className="flex items-center gap-1.5 text-[var(--success)]">
                                                                    <Check className="h-3.5 w-3.5" />
                                                                    <span className="font-medium">已验证</span>
                                                                </div>
                                                            )}
                                                            {subscriptionStatus.verifyStatus === 'invalid' && (
                                                                <div className="flex items-center gap-1.5 text-[var(--error)]">
                                                                    <AlertCircle className="h-3.5 w-3.5" />
                                                                    <span className="font-medium">验证失败</span>
                                                                </div>
                                                            )}
                                                            {subscriptionStatus.verifyStatus === 'idle' && (
                                                                <div className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                                                                    <span>检测中...</span>
                                                                </div>
                                                            )}
                                                            {/* Error message */}
                                                            {subscriptionStatus.verifyStatus === 'invalid' && subscriptionStatus.verifyError && (
                                                                <span className="text-[var(--error)] text-[10px] w-full mt-1">
                                                                    {subscriptionStatus.verifyError}
                                                                </span>
                                                            )}
                                                        </>
                                                    ) : (
                                                        <span className="text-[var(--ink-muted)]">
                                                            未登录，请先使用 Claude Code CLI 登录 (claude --login)
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {activeSection === 'mcp' && (
                        <div>
                            <div className="mb-8 flex items-center justify-between">
                                <h2 className="text-lg font-semibold text-[var(--ink)]">工具 & MCP</h2>
                                <button
                                    onClick={() => setShowMcpForm(true)}
                                    className="flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-strong)]"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    添加
                                </button>
                            </div>

                            <p className="mb-6 text-sm text-[var(--ink-muted)]">
                                MCP (Model Context Protocol) 扩展能力让 Agent 可以使用更多工具
                            </p>

                            {/* MCP Server list */}
                            <div className="space-y-3">
                                {mcpServers.map((server) => {
                                    const isEnabled = mcpEnabledIds.includes(server.id);
                                    const installState = mcpInstallStatus[server.id];
                                    const isInstalling = installState?.status === 'installing';
                                    const isReady = installState?.status === 'ready';
                                    const hasError = installState?.status === 'error';
                                    return (
                                        <div
                                            key={server.id}
                                            className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:shadow-sm"
                                        >
                                            <div className="flex items-start justify-between">
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <Globe className="h-4 w-4 text-[var(--accent-warm)]/70" />
                                                        <h3 className="font-medium text-[var(--ink)]">{server.name}</h3>
                                                        {server.isBuiltin && (
                                                            <span className="rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--info)]">
                                                                预设
                                                            </span>
                                                        )}
                                                        {/* Status indicator */}
                                                        {isInstalling && (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--info)]" />
                                                        )}
                                                        {isReady && (
                                                            <span className="h-2 w-2 rounded-full bg-[var(--success)]" title="已安装" />
                                                        )}
                                                        {hasError && (
                                                            <span
                                                                className="h-2 w-2 rounded-full bg-[var(--error)]"
                                                                title={installState?.error || '安装失败'}
                                                            />
                                                        )}
                                                    </div>
                                                    {server.description && (
                                                        <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                            {server.description}
                                                        </p>
                                                    )}
                                                    <p className="mt-2 font-mono text-[10px] text-[var(--ink-muted)]">
                                                        {server.command} {server.args?.join(' ')}
                                                    </p>
                                                    {hasError && installState?.error && (
                                                        <p className="mt-1 text-xs text-[var(--error)]">
                                                            {installState.error}
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {!server.isBuiltin && (
                                                        <button
                                                            onClick={() => handleDeleteMcp(server.id)}
                                                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                                            title="删除"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleMcpToggle(server, !isEnabled)}
                                                        disabled={isInstalling}
                                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${isInstalling
                                                            ? 'bg-[var(--info)]/60 cursor-wait'
                                                            : isEnabled
                                                                ? 'bg-[var(--success)]'
                                                                : 'bg-[var(--paper-inset)]'
                                                            }`}
                                                        title={isInstalling ? '安装中...' : isEnabled ? '已启用' : '点击启用并安装'}
                                                    >
                                                        <span
                                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--paper-elevated)] shadow transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                                                        />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Discovery links */}
                            <div className="mt-8 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-contrast)] p-4">
                                <p className="text-sm text-[var(--ink-muted)]">
                                    更多 MCP 可以在以下网站寻找：
                                </p>
                                <div className="mt-2 flex flex-wrap gap-3">
                                    {MCP_DISCOVERY_LINKS.map((link) => (
                                        <ExternalLink
                                            key={link.url}
                                            href={link.url}
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--paper-elevated)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] shadow-sm transition-colors hover:bg-[var(--info-bg)] hover:text-[var(--info)]"
                                        >
                                            {link.name}
                                            <ExternalLinkIcon className="h-3 w-3" />
                                        </ExternalLink>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Add MCP Modal */}
                    {showMcpForm && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                            <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
                                {/* Header */}
                                <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
                                    <h3 className="text-lg font-semibold text-[var(--ink)]">添加 MCP 服务器</h3>
                                    <button
                                        onClick={() => {
                                            setShowMcpForm(false);
                                            setMcpForm({
                                                id: '', name: '', type: 'stdio', command: '', args: [], newArg: '', url: '',
                                                env: {}, newEnvKey: '', headers: {}, newHeaderKey: ''
                                            });
                                        }}
                                        className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                                    >
                                        <X className="h-5 w-5" />
                                    </button>
                                </div>

                                {/* Content - Scrollable */}
                                <div className="flex-1 overflow-y-auto px-6 py-5">
                                    {/* Transport Type Selector */}
                                    <div className="mb-5">
                                        <label className="mb-2 block text-sm font-medium text-[var(--ink-muted)]">传输协议</label>
                                        <div className="grid grid-cols-3 gap-2">
                                            {[
                                                { type: 'stdio' as const, icon: '💻', name: 'STDIO', desc: '本地命令行' },
                                                { type: 'http' as const, icon: '🌐', name: 'Streamable HTTP', desc: '远程服务器' },
                                                { type: 'sse' as const, icon: '📡', name: 'SSE', desc: 'Server-Sent Events' },
                                            ].map((t) => (
                                                <button
                                                    key={t.type}
                                                    onClick={() => setMcpForm((p) => ({ ...p, type: t.type }))}
                                                    className={`flex flex-col items-center rounded-xl border p-3 transition-all ${mcpForm.type === t.type
                                                        ? 'border-[var(--ink)] bg-[var(--paper-contrast)]'
                                                        : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                                                        }`}
                                                >
                                                    <span className="text-xl mb-1">{t.icon}</span>
                                                    <span className={`text-sm font-medium ${mcpForm.type === t.type ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}>
                                                        {t.name}
                                                    </span>
                                                    <span className="text-xs text-[var(--ink-muted)]">{t.desc}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        {/* ID - Common */}
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                <span className="font-mono">ID</span> <span className="text-[var(--error)]">*</span>
                                            </label>
                                            <input
                                                type="text"
                                                value={mcpForm.id}
                                                onChange={(e) => setMcpForm((p) => ({ ...p, id: e.target.value.toLowerCase().replace(/\s/g, '-') }))}
                                                placeholder="例如: my-mcp-server"
                                                className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                            />
                                            <p className="mt-1 text-xs text-[var(--ink-muted)]">唯一标识符，用于在配置中引用</p>
                                        </div>

                                        {/* Name - Common */}
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                名称 <span className="font-mono text-[var(--ink-muted)]">name</span> <span className="text-[var(--error)]">*</span>
                                            </label>
                                            <input
                                                type="text"
                                                value={mcpForm.name}
                                                onChange={(e) => setMcpForm((p) => ({ ...p, name: e.target.value }))}
                                                placeholder="例如: 我的 MCP 服务器"
                                                className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                            />
                                        </div>

                                        {/* STDIO Fields */}
                                        {mcpForm.type === 'stdio' && (
                                            <>
                                                <div>
                                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                        命令 <span className="font-mono text-[var(--ink-muted)]">command</span> <span className="text-[var(--error)]">*</span>
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={mcpForm.command}
                                                        onChange={(e) => setMcpForm((p) => ({ ...p, command: e.target.value }))}
                                                        placeholder="例如: npx, uvx, node, python"
                                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                    />
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">启动服务器的命令</p>
                                                </div>

                                                {/* Args - array input */}
                                                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-4">
                                                    <label className="mb-3 block text-sm font-medium text-[var(--ink)]">
                                                        参数 <span className="font-mono text-[var(--ink-muted)]">args</span>
                                                    </label>

                                                    {/* Existing args */}
                                                    {mcpForm.args.length > 0 && (
                                                        <div className="mb-3 flex flex-wrap gap-2">
                                                            {mcpForm.args.map((arg, index) => (
                                                                <div key={index} className="flex items-center gap-1 rounded-lg bg-[var(--paper-elevated)] px-2.5 py-1.5 text-xs font-mono text-[var(--ink)]">
                                                                    <span>{arg}</span>
                                                                    <button
                                                                        onClick={() => {
                                                                            setMcpForm((p) => ({
                                                                                ...p,
                                                                                args: p.args.filter((_, i) => i !== index)
                                                                            }));
                                                                        }}
                                                                        className="ml-1 text-[var(--ink-muted)] hover:text-[var(--error)]"
                                                                    >
                                                                        <X className="h-3 w-3" />
                                                                    </button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {/* Add new arg */}
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="text"
                                                            value={mcpForm.newArg}
                                                            onChange={(e) => setMcpForm((p) => ({ ...p, newArg: e.target.value }))}
                                                            placeholder="例如: @playwright/mcp@latest"
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    if (mcpForm.newArg.trim()) {
                                                                        setMcpForm((p) => ({
                                                                            ...p,
                                                                            args: [...p.args, p.newArg.trim()],
                                                                            newArg: ''
                                                                        }));
                                                                    }
                                                                }
                                                            }}
                                                        />
                                                        <button
                                                            onClick={() => {
                                                                if (mcpForm.newArg.trim()) {
                                                                    setMcpForm((p) => ({
                                                                        ...p,
                                                                        args: [...p.args, p.newArg.trim()],
                                                                        newArg: ''
                                                                    }));
                                                                }
                                                            }}
                                                            disabled={!mcpForm.newArg.trim()}
                                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)] disabled:opacity-50"
                                                        >
                                                            <Plus className="h-4 w-4" />
                                                            添加
                                                        </button>
                                                    </div>
                                                    <p className="mt-2 text-xs text-[var(--ink-muted)]">一次填写一个参数，按 Enter 或点击添加</p>
                                                </div>

                                                {/* Environment Variables */}
                                                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-4">
                                                    <label className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                                                        <span>🔐</span> 环境变量 <span className="font-mono text-[var(--ink-muted)]">env</span>（可选）
                                                    </label>

                                                    {/* Existing env vars */}
                                                    {Object.entries(mcpForm.env).map(([key, value]) => (
                                                        <div key={key} className="mb-2 flex items-center gap-2">
                                                            <span className="min-w-[100px] text-xs font-mono text-[var(--success)]">{key}</span>
                                                            <input
                                                                type="text"
                                                                value={value}
                                                                onChange={(e) => setMcpForm((p) => ({
                                                                    ...p,
                                                                    env: { ...p.env, [key]: e.target.value }
                                                                }))}
                                                                placeholder="值"
                                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                            />
                                                            <button
                                                                onClick={() => {
                                                                    const newEnv = { ...mcpForm.env };
                                                                    delete newEnv[key];
                                                                    setMcpForm((p) => ({ ...p, env: newEnv }));
                                                                }}
                                                                className="rounded-lg p-2 text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </button>
                                                        </div>
                                                    ))}

                                                    {/* Add new env var */}
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="text"
                                                            value={mcpForm.newEnvKey}
                                                            onChange={(e) => setMcpForm((p) => ({ ...p, newEnvKey: e.target.value.toUpperCase().replace(/\s/g, '_') }))}
                                                            placeholder="变量名（如 API_KEY）"
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    if (mcpForm.newEnvKey) {
                                                                        setMcpForm((p) => ({
                                                                            ...p,
                                                                            env: { ...p.env, [p.newEnvKey]: '' },
                                                                            newEnvKey: ''
                                                                        }));
                                                                    }
                                                                }
                                                            }}
                                                        />
                                                        <button
                                                            onClick={() => {
                                                                if (mcpForm.newEnvKey) {
                                                                    setMcpForm((p) => ({
                                                                        ...p,
                                                                        env: { ...p.env, [p.newEnvKey]: '' },
                                                                        newEnvKey: ''
                                                                    }));
                                                                }
                                                            }}
                                                            disabled={!mcpForm.newEnvKey}
                                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)] disabled:opacity-50"
                                                        >
                                                            <Plus className="h-4 w-4" />
                                                            添加
                                                        </button>
                                                    </div>
                                                </div>
                                            </>
                                        )}

                                        {/* HTTP/SSE Fields */}
                                        {(mcpForm.type === 'http' || mcpForm.type === 'sse') && (
                                            <>
                                                <div>
                                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                        服务器 <span className="font-mono text-[var(--ink-muted)]">url</span> <span className="text-[var(--error)]">*</span>
                                                    </label>
                                                    <input
                                                        type="url"
                                                        value={mcpForm.url}
                                                        onChange={(e) => setMcpForm((p) => ({ ...p, url: e.target.value }))}
                                                        placeholder={mcpForm.type === 'sse' ? "例如: https://example.com/sse" : "例如: https://example.com/mcp"}
                                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                    />
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                        {mcpForm.type === 'sse' ? 'SSE 事件流端点地址' : 'MCP 服务器的 HTTP 端点地址'}
                                                    </p>
                                                </div>

                                                {/* HTTP Headers */}
                                                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-contrast)] p-4">
                                                    <label className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                                                        <span>🔑</span> 请求头 <span className="font-mono text-[var(--ink-muted)]">headers</span>（可选）
                                                    </label>

                                                    {/* Existing headers */}
                                                    {Object.entries(mcpForm.headers).map(([key, value]) => (
                                                        <div key={key} className="mb-2 flex items-center gap-2">
                                                            <span className="min-w-[100px] text-xs font-mono text-[var(--success)]">{key}</span>
                                                            <input
                                                                type="text"
                                                                value={value}
                                                                onChange={(e) => setMcpForm((p) => ({
                                                                    ...p,
                                                                    headers: { ...p.headers, [key]: e.target.value }
                                                                }))}
                                                                placeholder="值"
                                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                            />
                                                            <button
                                                                onClick={() => {
                                                                    const newHeaders = { ...mcpForm.headers };
                                                                    delete newHeaders[key];
                                                                    setMcpForm((p) => ({ ...p, headers: newHeaders }));
                                                                }}
                                                                className="rounded-lg p-2 text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </button>
                                                        </div>
                                                    ))}

                                                    {/* Add new header */}
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="text"
                                                            value={mcpForm.newHeaderKey}
                                                            onChange={(e) => setMcpForm((p) => ({ ...p, newHeaderKey: e.target.value }))}
                                                            placeholder="头名称（如 Authorization）"
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    if (mcpForm.newHeaderKey) {
                                                                        setMcpForm((p) => ({
                                                                            ...p,
                                                                            headers: { ...p.headers, [p.newHeaderKey]: '' },
                                                                            newHeaderKey: ''
                                                                        }));
                                                                    }
                                                                }
                                                            }}
                                                        />
                                                        <button
                                                            onClick={() => {
                                                                if (mcpForm.newHeaderKey) {
                                                                    setMcpForm((p) => ({
                                                                        ...p,
                                                                        headers: { ...p.headers, [p.newHeaderKey]: '' },
                                                                        newHeaderKey: ''
                                                                    }));
                                                                }
                                                            }}
                                                            disabled={!mcpForm.newHeaderKey}
                                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)] disabled:opacity-50"
                                                        >
                                                            <Plus className="h-4 w-4" />
                                                            添加
                                                        </button>
                                                    </div>
                                                    <p className="mt-2 text-xs text-[var(--ink-muted)]">用于认证的 HTTP 请求头，如 Bearer Token</p>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Footer */}
                                <div className="flex gap-3 px-6 py-4 border-t border-[var(--line)]">
                                    <button
                                        onClick={() => {
                                            setShowMcpForm(false);
                                            setMcpForm({
                                                id: '', name: '', type: 'stdio', command: '', args: [], newArg: '', url: '',
                                                env: {}, newEnvKey: '', headers: {}, newHeaderKey: ''
                                            });
                                        }}
                                        className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)]"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={handleAddMcp}
                                        disabled={
                                            !mcpForm.id || !mcpForm.name ||
                                            (mcpForm.type === 'stdio' && !mcpForm.command) ||
                                            ((mcpForm.type === 'http' || mcpForm.type === 'sse') && !mcpForm.url)
                                        }
                                        className="flex-1 rounded-lg bg-[var(--ink)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-strong)] disabled:opacity-50"
                                    >
                                        添加服务器
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Custom Provider Modal */}
            {showCustomForm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                    <div className="mx-4 w-full max-w-md rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl">
                        <div className="mb-5 flex items-center justify-between">
                            <h3 className="text-lg font-semibold text-[var(--ink)]">添加自定义供应商</h3>
                            <button
                                onClick={() => {
                                    setShowCustomForm(false);
                                    setCustomForm(EMPTY_CUSTOM_FORM);
                                }}
                                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    供应商名称 <span className="text-[var(--error)]">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={customForm.name}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, name: e.target.value }))}
                                    placeholder="例如: My Custom Provider"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">服务商标签</label>
                                <input
                                    type="text"
                                    value={customForm.cloudProvider}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, cloudProvider: e.target.value }))}
                                    placeholder="例如: 云服务商"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    API Base URL (Anthropic兼容协议) <span className="text-[var(--error)]">*</span>
                                </label>
                                <input
                                    type="url"
                                    value={customForm.baseUrl}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, baseUrl: e.target.value }))}
                                    placeholder="https://api.example.com/anthropic"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    模型 ID <span className="text-[var(--error)]">*</span>
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={customForm.newModelInput}
                                        onChange={(e) => setCustomForm((p) => ({ ...p, newModelInput: e.target.value }))}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && customForm.newModelInput.trim()) {
                                                e.preventDefault();
                                                const newModel = customForm.newModelInput.trim();
                                                if (!customForm.models.includes(newModel)) {
                                                    setCustomForm((p) => ({
                                                        ...p,
                                                        models: [...p.models, newModel],
                                                        newModelInput: '',
                                                    }));
                                                }
                                            }
                                        }}
                                        placeholder="输入模型 ID，按 Enter 添加"
                                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const newModel = customForm.newModelInput.trim();
                                            if (newModel && !customForm.models.includes(newModel)) {
                                                setCustomForm((p) => ({
                                                    ...p,
                                                    models: [...p.models, newModel],
                                                    newModelInput: '',
                                                }));
                                            }
                                        }}
                                        disabled={!customForm.newModelInput.trim()}
                                        className="rounded-lg bg-[var(--paper-contrast)] px-3 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                                    >
                                        <Plus className="h-4 w-4" />
                                    </button>
                                </div>
                                {/* Model tags */}
                                {customForm.models.length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {customForm.models.map((model, index) => (
                                            <div
                                                key={model}
                                                className="flex items-center gap-1 rounded-md bg-[var(--paper-contrast)] px-2 py-1 text-xs font-medium text-[var(--ink)]"
                                            >
                                                <span className="text-[10px] text-[var(--ink-muted)]">{index + 1}.</span>
                                                <span>{model}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => setCustomForm((p) => ({
                                                        ...p,
                                                        models: p.models.filter((m) => m !== model),
                                                    }))}
                                                    className="ml-0.5 rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">API Key</label>
                                <input
                                    type="password"
                                    value={customForm.apiKey}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, apiKey: e.target.value }))}
                                    placeholder="可选，稍后设置"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                />
                            </div>
                        </div>

                        <div className="mt-6 flex gap-3">
                            <button
                                onClick={() => {
                                    setShowCustomForm(false);
                                    setCustomForm(EMPTY_CUSTOM_FORM);
                                }}
                                className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleAddCustomProvider}
                                disabled={!customForm.name || !customForm.baseUrl || customForm.models.length === 0}
                                className="flex-1 rounded-lg bg-[var(--ink)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-strong)] disabled:opacity-50"
                            >
                                添加
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Provider Management Modal */}
            {editingProvider && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                    <div className="mx-4 w-full max-w-md rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl">
                        <div className="mb-5 flex items-center justify-between">
                            <h3 className="text-lg font-semibold text-[var(--ink)]">
                                {editingProvider.provider.isBuiltin ? '管理供应商' : '编辑供应商'}
                            </h3>
                            <button
                                onClick={() => setEditingProvider(null)}
                                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="space-y-4">
                            {/* Provider info - editable for custom, read-only for preset */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">供应商名称</label>
                                {editingProvider.provider.isBuiltin ? (
                                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink-muted)]">
                                        {editingProvider.provider.name}
                                    </div>
                                ) : (
                                    <input
                                        type="text"
                                        value={editingProvider.editName || ''}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, editName: e.target.value } : null)}
                                        placeholder="输入供应商名称"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                    />
                                )}
                            </div>

                            {/* 云服务商标签 - only for custom providers */}
                            {!editingProvider.provider.isBuiltin && (
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">云服务商标签</label>
                                    <input
                                        type="text"
                                        value={editingProvider.editCloudProvider || ''}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, editCloudProvider: e.target.value } : null)}
                                        placeholder="例如：自定义、代理"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                    />
                                </div>
                            )}

                            {/* Base URL */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">API Base URL</label>
                                {editingProvider.provider.isBuiltin ? (
                                    editingProvider.provider.config.baseUrl && (
                                        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink-muted)] font-mono text-xs break-all">
                                            {editingProvider.provider.config.baseUrl}
                                        </div>
                                    )
                                ) : (
                                    <input
                                        type="text"
                                        value={editingProvider.editBaseUrl || ''}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, editBaseUrl: e.target.value } : null)}
                                        placeholder="https://api.example.com"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--ink)] focus:outline-none"
                                    />
                                )}
                            </div>

                            {/* Existing models */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    模型列表
                                </label>
                                <div className="flex flex-wrap gap-1.5">
                                    <ModelTagList
                                        provider={editingProvider.provider}
                                        removedModels={editingProvider.removedModels}
                                        onRemove={removeExistingModel}
                                        customModels={editingProvider.customModels}
                                        onRemoveCustomModel={removeCustomModelFromProvider}
                                    />
                                </div>
                            </div>

                            {/* Custom models for this provider */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    添加自定义模型 ID
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={editingProvider.newModelInput}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, newModelInput: e.target.value } : null)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                addCustomModelToProvider();
                                            }
                                        }}
                                        placeholder="输入模型 ID，按 Enter 添加"
                                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--ink)] focus:outline-none"
                                    />
                                    <button
                                        type="button"
                                        onClick={addCustomModelToProvider}
                                        disabled={!editingProvider.newModelInput.trim()}
                                        className="rounded-lg bg-[var(--paper-contrast)] px-3 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                                    >
                                        <Plus className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 flex items-center justify-between">
                            {/* Delete button (only for custom providers) */}
                            {!editingProvider.provider.isBuiltin ? (
                                <button
                                    onClick={() => setDeleteConfirmProvider(editingProvider.provider)}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    删除
                                </button>
                            ) : (
                                <div />
                            )}

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setEditingProvider(null)}
                                    className="rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)]"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={saveProviderEdits}
                                    className="rounded-lg bg-[var(--ink)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--ink-strong)]"
                                >
                                    保存
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteConfirmProvider && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40">
                    <div className="mx-4 w-full max-w-sm rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl">
                        <div className="mb-4 flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--error-bg)]">
                                <Trash2 className="h-5 w-5 text-[var(--error)]" />
                            </div>
                            <h3 className="text-lg font-semibold text-[var(--ink)]">删除供应商</h3>
                        </div>
                        <p className="mb-6 text-sm text-[var(--ink-muted)]">
                            确定要删除「{deleteConfirmProvider.name}」吗？此操作无法撤销。
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setDeleteConfirmProvider(null)}
                                className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-contrast)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={confirmDeleteCustomProvider}
                                className="flex-1 rounded-lg bg-[var(--error)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:brightness-110"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
