/**
 * Companion chat window (PRD 0.2.35) — the transparent NSPanel that holds the
 * Mino desktop-channel conversation. Visual spec: the sign-off'd playground
 * (specs/playgrounds/0.2.35_floating_ball.html) — one glass sheet, no chrome
 * until hover, conversation + hairline input area.
 *
 * Mode model（透明度 = 投入度）:
 *   hidden → peek（hover：半透明，纯视觉，焦点纹丝不动）
 *          → pin （点击/球点击：变实 + 拿键盘焦点；窗口失焦/Esc/×/再点球 → hidden）
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, Brain, Image as ImageIcon, Loader2, Settings as SettingsIcon, StopCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { listenWithCleanup } from '@/utils/tauriListen';
import Markdown from '@/components/Markdown';
import AttachmentPreviewList from '@/components/AttachmentPreviewList';
import { PermissionPrompt } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import { FileActionProvider } from '@/context/FileActionContext';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useToast } from '@/components/Toast';
import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { track } from '@/analytics';
import { loadAppConfig, mergePresetCustomModels } from '@/config/services/appConfigService';
import { getAllProviders, modelSupportsModality } from '@/config/services/providerService';
import { applyProviderEnablementAndOrder, type Provider } from '@/config/types';
import { ALLOWED_IMAGE_MIME_TYPES, USER_IMAGE_ATTACHMENT_MAX_BYTES, isChatImageFile, isImageMimeType } from '../../shared/fileTypes';
import { resolveAttachmentUrl } from '@/utils/attachmentUrl';
import { renameIfBareClipboardImage } from '@/utils/clipboardImage';
import { formatDuration, getToolBadgeConfig, getToolLabel, getToolMainLabel, getToolSummaryNode, isSubagentContainerTool } from '@/components/tools/toolBadgeConfig';
import { isBackgroundSubagentTool, isSubagentContainerRunning } from '@/components/tools/subagentActivity';
import { groupContentBlocksForDisplay } from '@/utils/contentBlockDisplay';
import type { ContentBlock } from '@/types/chat';
import { isNearBottom } from './convoAutoFollow';
import { createFocusConvergence } from './focusConvergence';
import { useFloatingSession, type FbAttachment, type FbMsg } from './useFloatingSession';
import { useFloatingComposerKeydown } from './useFloatingComposerKeydown';
import { describeNativeFloatingBallError } from './nativeFloatingBall';
import { TravelMatePostcard } from './TravelMatePostcard';
import {
    dismissTravelMatePostcard,
    getTravelMateSnapshot,
    type TravelMateSnapshot,
    type TravelMatePostcard as TravelMatePostcardData,
} from './travelMate';

import './fb.css';

type FbMode = 'hidden' | 'peek' | 'pin';

interface FbCtx {
    appName?: string | null;
    windowTitle?: string | null;
    selection?: string | null;
}

interface FbWhoContext {
    appName: string;
    windowTitle?: string | null;
}

/** 📷 快门结果（Rust FbScreenshot）：图 + 快门时刻的前台窗口标识。 */
interface FbShot {
    dataUrl: string;
    appName?: string | null;
    windowTitle?: string | null;
}

interface FbImageDraft {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    data: string;
    previewUrl: string;
    source: 'upload' | 'screenshot';
    transport?: 'inline_base64' | 'attachment_ref';
    relativePath?: string;
    appName?: string | null;
    windowTitle?: string | null;
}

const WIN_W = 440;
const WIN_H_KEY = 'fb-win-h';
const HIDE_GRACE_MS = 280;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = USER_IMAGE_ATTACHMENT_MAX_BYTES;

function isMacRendererPlatform(): boolean {
    return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
}

function loadWinH(): number {
    const saved = parseInt(localStorage.getItem(WIN_H_KEY) ?? '', 10);
    return Number.isFinite(saved) && saved >= 360 ? Math.min(saved, 1200) : 660;
}

/** cameo 式单行活动条：状态点 + 主端同款过程摘要，但不可展开。 */
function ActivityRow({ block, isStreaming, tick }: { block: ContentBlock; isStreaming: boolean; tick: number }) {
    const { t } = useTranslation('chat');
    const isThinking = block.type === 'thinking';
    const isTool = block.type === 'tool_use' || block.type === 'server_tool_use';
    const tool = isTool ? block.tool : undefined;
    const isTaskTool = !!tool?.name && isSubagentContainerTool(tool.name);
    const isThinkingActive = isThinking && block.isComplete !== true && isStreaming;
    const isToolActive = !!tool?.isLoading;
    const isTaskRunning = isTaskTool && isSubagentContainerRunning(tool);
    const isRunning = isThinkingActive || isToolActive || isTaskRunning;

    let icon: ReactNode = null;
    let mainLabel = '';
    let subLabel = '';
    let taskDuration: string | null = null;
    const summaryNode = tool ? getToolSummaryNode(tool) : null;
    const processAttachments = tool?.attachments?.filter((a) => a.presentation === 'process') ?? [];

    if (isThinking) {
        const durationMs = block.thinkingDurationMs ?? (isThinkingActive && block.thinkingStartedAt ? tick - block.thinkingStartedAt : undefined);
        const durationSec = durationMs ? Math.floor(durationMs / 1000) : 0;
        if (isThinkingActive) {
            mainLabel = durationSec > 0
                ? t('floatingBall.activity.thinkingRunningWithSeconds', { seconds: durationSec })
                : t('floatingBall.activity.thinkingRunning');
            icon = <Loader2 className="size-4 animate-spin" />;
        } else if (block.isFailed) {
            mainLabel = durationSec > 0
                ? t('floatingBall.activity.thinkingFailedWithSeconds', { seconds: durationSec })
                : t('floatingBall.activity.thinkingFailed');
            icon = <XCircle className="size-4 text-[var(--error)]" />;
        } else if (block.isStopped) {
            mainLabel = durationSec > 0
                ? t('floatingBall.activity.thinkingStoppedWithSeconds', { seconds: durationSec })
                : t('floatingBall.activity.thinkingStopped');
            icon = <StopCircle className="size-4 text-[var(--warning)]" />;
        } else {
            mainLabel = t('floatingBall.activity.thinkingDone', { seconds: Math.max(durationSec, 1) });
            icon = <Brain className="size-4" />;
        }
    } else if (tool) {
        const config = getToolBadgeConfig(tool.name);
        const toolLabel = getToolLabel(tool);
        mainLabel = getToolMainLabel(tool);
        subLabel = toolLabel !== mainLabel ? toolLabel : '';
        if (isTaskRunning && tool.taskStartTime) {
            taskDuration = formatDuration(tick - tool.taskStartTime);
        } else if (isTaskTool && tool.result) {
            try {
                const parsed = JSON.parse(tool.result) as { totalDurationMs?: number };
                if (parsed.totalDurationMs) taskDuration = formatDuration(parsed.totalDurationMs);
            } catch {
                taskDuration = null;
            }
        }
        if (isToolActive || isTaskRunning) {
            icon = <Loader2 className="size-4 animate-spin" />;
        } else if (tool.isFailed) {
            icon = <XCircle className="size-4 text-[var(--error)]" />;
        } else if (tool.isStopped) {
            icon = <StopCircle className="size-4 text-[var(--warning)]" />;
        } else if (tool.isError) {
            icon = <AlertCircle className="size-4 text-[var(--error)]" />;
        } else {
            icon = config.icon;
        }
    }

    return (
        <div className={`fbw-act${isRunning ? ' running' : ''}`} data-tick={tick}>
            <span className="dot" />
            <span className="icon">{icon}</span>
            <span className="label">{mainLabel}</span>
            {isTaskTool && isBackgroundSubagentTool(tool) && (
                <span className="badge">{t('floatingBall.activity.background')}</span>
            )}
            {taskDuration && <span className="detail">{taskDuration}</span>}
            {subLabel && <span className="sub">{subLabel}</span>}
            {processAttachments.length > 0 && (
                <span className="media">
                    <ImageIcon className="size-3" />
                    {processAttachments.length > 1 ? `×${processAttachments.length}` : ''}
                </span>
            )}
            {summaryNode && <span className="summary">{summaryNode}</span>}
        </div>
    );
}

function AssistantMessage({ message, isStreaming, tick }: { message: Extract<FbMsg, { role: 'ai' }>; isStreaming: boolean; tick: number }) {
    const groupedBlocks = groupContentBlocksForDisplay(message.content);
    return (
        <>
            {groupedBlocks.map((item, index) => {
                if (Array.isArray(item)) {
                    return (
                        <div className="fbw-process-group" key={`g-${index}`}>
                            {item.map((block, blockIndex) => (
                                <ActivityRow
                                    key={`${block.type}-${blockIndex}-${block.tool?.id ?? block.thinkingStreamIndex ?? index}`}
                                    block={block}
                                    isStreaming={isStreaming}
                                    tick={tick}
                                />
                            ))}
                        </div>
                    );
                }
                return (
                    <div className="fbw-msg ai ai-message-content" key={`t-${index}`}>
                        <Markdown>{item.text ?? ''}</Markdown>
                        {isStreaming && message.streamingTextActive && index === groupedBlocks.length - 1 && <span className="fbw-caret" />}
                    </div>
                );
            })}
        </>
    );
}

function makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitDataUrl(dataUrl: string): { mimeType: string; data: string } {
    const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
    return {
        mimeType: match?.[1] ?? 'image/png',
        data: match?.[2] ?? dataUrl.split(',')[1] ?? '',
    };
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function fileToImageDraft(file: File): Promise<FbImageDraft> {
    const previewUrl = await readFileAsDataUrl(file);
    const { mimeType, data } = splitDataUrl(previewUrl);
    return {
        id: makeId('img'),
        name: file.name || 'image.png',
        mimeType: file.type || mimeType,
        size: file.size,
        data,
        previewUrl,
        source: 'upload',
        transport: 'inline_base64',
    };
}

function shotToImageDraft(shot: FbShot): FbImageDraft {
    const { mimeType, data } = splitDataUrl(shot.dataUrl);
    const ext = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg' : 'png';
    return {
        id: makeId('shot'),
        name: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
        mimeType,
        size: Math.floor(data.length * 0.75),
        data,
        previewUrl: shot.dataUrl,
        source: 'screenshot',
        transport: 'inline_base64',
        appName: shot.appName ?? null,
        windowTitle: shot.windowTitle ?? null,
    };
}

export default function CompanionWindow() {
    const { t } = useTranslation('chat');
    // `mode` drives rendering; `modeRef` mirrors it for event handlers and the
    // session hook. The ref is written ONLY inside applyMode (every mode
    // transition funnels through it) — never during render (react-hooks/refs).
    const [mode, setMode] = useState<FbMode>('hidden');
    const modeRef = useRef<FbMode>('hidden');

    const session = useFloatingSession(modeRef);
    const fileService = useWorkspaceFileService(session.workspacePath);
    const toast = useToast();
    const { openPreview } = useImagePreview();
    // ⚠️ 稳定性纪律（review critical）：`session` 是每渲染新对象——监听 effect
    // 的依赖链只能挂这些 useCallback 稳定函数，否则流式期间每个 chunk 都会
    // 重订阅 Tauri listener，abort↔listen 的异步空窗会静默吞掉跨窗口事件。
    const { markRead, rotateIfStale, send, suspend, resume } = session;

    const [quote, setQuote] = useState<string | null>(null);
    const [imageDrafts, setImageDrafts] = useState<FbImageDraft[]>([]);
    const [whoContext, setWhoContext] = useState<FbWhoContext | null>(null);
    const [input, setInput] = useState('');
    const [axNeeded, setAxNeeded] = useState(false);
    const [providerForCapability, setProviderForCapability] = useState<Provider | null>(null);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [travelPostcard, setTravelPostcard] = useState<TravelMatePostcardData | null>(null);

    const convoRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mouseInsideRef = useRef(false);
    const visibilityGenerationRef = useRef(0);
    const pinRequestSeqRef = useRef(0);
    const pinInFlightRef = useRef(false);
    const textFocusRepairInFlightRef = useRef(false);
    const pinFocusTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const nativeFocusLostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const ballSummonPendingRef = useRef(false);
    const inputFocusConvergence = useMemo(
        () => createFocusConvergence({
            getTarget: () => inputRef.current,
            shouldContinue: () => modeRef.current === 'pin',
            maxAttempts: 60,
            minAttempts: 8,
        }),
        [],
    );
    // 活动行秒表（仅有 running 活动时跳动）
    const [nowTick, setNowTick] = useState(() => Date.now());
    const hasRunningActivity = session.activities.some((a) => a.running);
    useEffect(() => {
        if (!hasRunningActivity) return;
        const id = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(id);
    }, [hasRunningActivity]);
    // Eager-captured situation（最前台 app/标题）— 发送时随 user 消息走（D4）。
    const lastCtxRef = useRef<FbCtx | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [config, rawProviders] = await Promise.all([loadAppConfig(), getAllProviders()]);
                const merged = mergePresetCustomModels(
                    rawProviders,
                    config.presetCustomModels,
                    config.presetRemovedModels,
                );
                const withPrimaryOverrides = merged.map((provider) => {
                    const primaryModel = config.providerPrimaryModels?.[provider.id];
                    if (!primaryModel || !provider.models?.some((m) => m.model === primaryModel)) return provider;
                    return { ...provider, primaryModel };
                });
                const providers = applyProviderEnablementAndOrder(withPrimaryOverrides, {
                    providerOrder: config.providerOrder,
                    disabledProviderIds: config.disabledProviderIds,
                });
                if (!cancelled) {
                    setProviderForCapability(providers.find((p) => p.id === session.providerId) ?? null);
                }
            } catch (err) {
                if (!cancelled) {
                    console.warn('[fb] failed to resolve provider capabilities:', err);
                    setProviderForCapability(null);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [session.providerId]);

    const canAttachImages = useMemo(() => {
        if (session.runtime !== 'builtin') return true;
        const modelId = session.model ?? providerForCapability?.primaryModel ?? null;
        return modelSupportsModality(providerForCapability, modelId, 'image');
    }, [providerForCapability, session.model, session.runtime]);
    const whoLabel = useMemo(() => {
        if (!whoContext) return 'Mino';
        return whoContext.windowTitle
            ? t('floatingBall.watchingAppWindow', {
                appName: whoContext.appName,
                windowTitle: whoContext.windowTitle,
            })
            : t('floatingBall.watchingApp', { appName: whoContext.appName });
    }, [t, whoContext]);

    const clearPinnedInputFocusRetries = useCallback(() => {
        for (const timer of pinFocusTimersRef.current) clearTimeout(timer);
        pinFocusTimersRef.current = [];
    }, []);

    const clearNativeFocusLostTimer = useCallback(() => {
        if (nativeFocusLostTimerRef.current) {
            clearTimeout(nativeFocusLostTimerRef.current);
            nativeFocusLostTimerRef.current = null;
        }
    }, []);

    // ── mode → 通知球（球用它决定点击语义）＋ pin 时清未读 ──
    const applyMode = useCallback(
        (next: FbMode) => {
            if (next === 'hidden') visibilityGenerationRef.current += 1;
            if (next === 'hidden') {
                pinInFlightRef.current = false;
                ballSummonPendingRef.current = false;
            }
            if (next !== 'pin') {
                inputFocusConvergence.cancel();
                clearPinnedInputFocusRetries();
                clearNativeFocusLostTimer();
            }
            setMode(next);
            modeRef.current = next;
            void invoke('cmd_fb_relay', {
                target: 'ball',
                event: 'fb:companion-mode',
                payload: { mode: next },
            }).catch(() => undefined);
            if (next === 'pin') markRead();
        },
        [clearNativeFocusLostTimer, clearPinnedInputFocusRetries, inputFocusConvergence, markRead],
    );

    const applyTravelSnapshot = useCallback((snapshot: TravelMateSnapshot) => {
        if (snapshot.phase.kind === 'returnedPendingPostcard') {
            setTravelPostcard(snapshot.phase.postcard);
            applyMode('pin');
        } else {
            setTravelPostcard(null);
        }
    }, [applyMode]);

    useEffect(() => {
        let cancelled = false;
        void getTravelMateSnapshot()
            .then((snapshot) => {
                if (!cancelled) applyTravelSnapshot(snapshot);
            })
            .catch((err) => {
                console.warn('[travel-mate] load snapshot failed:', err);
            });
        return () => {
            cancelled = true;
        };
    }, [applyTravelSnapshot]);

    const beginPinRequest = useCallback(() => ({
        seq: ++pinRequestSeqRef.current,
        generation: visibilityGenerationRef.current,
    }), []);

    const isCurrentPinRequest = useCallback((token: { seq: number; generation: number }) => (
        token.seq === pinRequestSeqRef.current && token.generation === visibilityGenerationRef.current
    ), []);

    const discardStalePinRequest = useCallback((token: { seq: number; generation: number }) => {
        if (token.generation !== visibilityGenerationRef.current && modeRef.current !== 'pin') {
            void invoke('cmd_fb_hide_companion').catch(() => undefined);
        }
    }, []);

    const hideSelf = useCallback(() => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
        clearNativeFocusLostTimer();
        applyMode('hidden');
        void invoke('cmd_fb_hide_companion');
    }, [applyMode, clearNativeFocusLostTimer]);

    const scheduleHideIfPeek = useCallback(() => {
        if (modeRef.current !== 'peek') return;
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
            if (modeRef.current === 'peek' && !mouseInsideRef.current) {
                hideSelf();
            }
        }, HIDE_GRACE_MS);
    }, [hideSelf]);

    const applySummonCtx = useCallback(
        async (ctx: FbCtx | null | undefined) => {
            lastCtxRef.current = ctx ?? null;
            if (ctx?.appName) {
                setWhoContext({
                    appName: ctx.appName,
                    windowTitle: ctx.windowTitle ?? null,
                });
            } else {
                setWhoContext(null);
            }
            if (ctx?.selection) {
                setQuote(ctx.selection);
                setAxNeeded(false);
            } else {
                // 没有选区且 AX 未授权 → 第一次"想给引用"的时机就是引导时机（PRD §8）。
                try {
                    const trusted = await invoke<boolean>('cmd_fb_ax_status', { prompt: false });
                    setAxNeeded(!trusted);
                } catch {
                    setAxNeeded(false);
                }
            }
        },
        [],
    );

    // 贴底跟随开关：只有本就贴底才自动滚底（isNearBottom），显式唤起/发送
    // 时强制回贴底。没有它，滚轮上翻阅读会被流式新内容持续拽回底部。
    const stickToBottomRef = useRef(true);

    const focusInputWhenPinned = useCallback(() => {
        inputFocusConvergence.request();
    }, [inputFocusConvergence]);

    const schedulePinnedInputFocus = useCallback(
        (_source: string) => {
            clearPinnedInputFocusRetries();
            const requestFocus = () => {
                if (modeRef.current !== 'pin') return;
                focusInputWhenPinned();
            };
            requestFocus();
            pinFocusTimersRef.current = [0, 80, 220, 500].map((delay) => (
                setTimeout(requestFocus, delay)
            ));
        },
        [clearPinnedInputFocusRetries, focusInputWhenPinned],
    );

    const repairMacNativeTextInputFocus = useCallback((source: string) => {
        if (!isMacRendererPlatform()) return;
        if (modeRef.current !== 'pin') return;
        if (textFocusRepairInFlightRef.current) return;
        textFocusRepairInFlightRef.current = true;
        void invoke('cmd_fb_pin_companion')
            .then(() => {
                schedulePinnedInputFocus(`${source}:native-success`);
            })
            .catch((err) => {
                console.warn('[fb-companion] native text focus repair failed:', err);
            })
            .finally(() => {
                textFocusRepairInFlightRef.current = false;
            });
    }, [schedulePinnedInputFocus]);

    useEffect(() => {
        if (mode !== 'pin') {
            clearPinnedInputFocusRetries();
            return;
        }
        // pin 态的产品语义是“实心即能输入”。这一步故意挂在 mode
        // commit 后，而不是只挂在 click handler：peek 态的 first click
        // 负责升格，真正的 caret/IME attachment 属于 pin 这个状态结果。
        schedulePinnedInputFocus('mode-pin-commit');
        repairMacNativeTextInputFocus('mode-pin-commit');
        return clearPinnedInputFocusRetries;
    }, [clearPinnedInputFocusRetries, mode, repairMacNativeTextInputFocus, schedulePinnedInputFocus]);

    useEffect(() => () => inputFocusConvergence.cancel(), [inputFocusConvergence]);

    const summonPinned = useCallback(
        async (ctx: FbCtx | null | undefined) => {
            const hadPendingReservation = ballSummonPendingRef.current;
            if (pinInFlightRef.current && !hadPendingReservation) return;
            pinInFlightRef.current = true;
            ballSummonPendingRef.current = false;
            stickToBottomRef.current = true; // 显式唤起 = 看最新
            const pinToken = beginPinRequest();
            try {
                try {
                    // BallWindow may already have requested native show; companion owns
                    // the final key-window/focus ordering and fails closed on disable.
                    await invoke('cmd_fb_pin_companion');
                } catch (err) {
                    applyMode('hidden');
                    void invoke('cmd_fb_hide_companion');
                    console.error('[fb] pin for summon failed:', err);
                    return;
                }
                if (!isCurrentPinRequest(pinToken)) {
                    discardStalePinRequest(pinToken);
                    return;
                }
                applyMode('pin');
                await applySummonCtx(ctx);
                track('floating_ball_summon', { kind: 'pin' });
                focusInputWhenPinned();
                // 唤起时机做按天轮换评估（boot-only 检查跨午夜长跑会失效）。
                void rotateIfStale();
            } finally {
                pinInFlightRef.current = false;
                ballSummonPendingRef.current = false;
            }
        },
        [applyMode, applySummonCtx, beginPinRequest, discardStalePinRequest, focusInputWhenPinned, isCurrentPinRequest, rotateIfStale],
    );

    // ── 球 → 伴侣窗事件 ──
    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup(
            'fb:ball-enter',
            () => {
                if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                if (modeRef.current === 'hidden') applyMode('peek');
            },
            ac.signal,
        );
        void listenWithCleanup('fb:ball-leave', () => scheduleHideIfPeek(), ac.signal);
        // BallWindow captures context before native pin activation, reserves
        // this pin path before native show can focus a peek window, then sends
        // the context with the summon event. Keep the late context event as a
        // tolerant compatibility path for already-queued events from older
        // windows.
        void listenWithCleanup(
            'fb:summon-pending',
            () => {
                ballSummonPendingRef.current = true;
                pinInFlightRef.current = true;
            },
            ac.signal,
        );
        void listenWithCleanup(
            'fb:summon-cancel',
            () => {
                ballSummonPendingRef.current = false;
                pinInFlightRef.current = false;
            },
            ac.signal,
        );
        void listenWithCleanup<{ ctx?: FbCtx | null }>(
            'fb:summon',
            (e) => {
                void summonPinned(e.payload?.ctx ?? null);
            },
            ac.signal,
        );
        void listenWithCleanup<{ ctx?: FbCtx }>(
            'fb:summon-ctx',
            (e) => {
                void applySummonCtx(e.payload?.ctx ?? null);
            },
            ac.signal,
        );
        void listenWithCleanup('fb:close-request', () => hideSelf(), ac.signal);
        void listenWithCleanup('fb:force-hidden', () => applyMode('hidden'), ac.signal);
        // 生命周期（review C2）：关闭悬浮球 → 断 SSE + 释放 sidecar owner；
        // 重新开启 → 重新 ensure + 连接。
        void listenWithCleanup<{ active?: boolean }>(
            'fb:lifecycle',
            (e) => {
                if (e.payload?.active === false) {
                    applyMode('hidden');
                    void suspend();
                } else {
                    void resume();
                }
            },
            ac.signal,
        );
        void listenWithCleanup<TravelMateSnapshot>(
            'travel-mate://state-changed',
            (e) => applyTravelSnapshot(e.payload),
            ac.signal,
        );
        // 原生 hover 信号（修 hover 失灵）：app 非激活时 WKWebView 收不到
        // mouseMoved，DOM mouseenter/leave 不可靠——NSTrackingArea 的进出
        // 事件经 Rust 转发到这里，驱动 peek 的 grace 计时。
        void listenWithCleanup<{ inside?: boolean; appActive?: boolean; rawInside?: boolean }>(
            'fb:native-hover',
            (e) => {
                if (e.payload?.inside) {
                    mouseInsideRef.current = true;
                    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                } else {
                    mouseInsideRef.current = false;
                    scheduleHideIfPeek();
                }
            },
            ac.signal,
        );
        void listenWithCleanup<{ focused?: boolean; visible?: boolean }>(
            'fb:native-focus',
            (e) => {
                const focused = e.payload?.focused === true;
                if (focused && modeRef.current === 'pin') {
                    clearNativeFocusLostTimer();
                    schedulePinnedInputFocus('native-focus');
                    return;
                }
                if (!focused && modeRef.current === 'pin') {
                    clearNativeFocusLostTimer();
                    nativeFocusLostTimerRef.current = setTimeout(() => {
                        nativeFocusLostTimerRef.current = null;
                        if (modeRef.current !== 'pin') return;
                        if (document.hasFocus()) {
                            schedulePinnedInputFocus('native-focus-recovered');
                            return;
                        }
                        hideSelf();
                    }, 140);
                }
            },
            ac.signal,
        );
        // 握手（review W1）：监听就绪后告知球——球在此之前的 summon 会暂存并重放，
        // 否则 enable 后立即点击的 fb:summon 会落在监听注册前被静默丢弃。
        void invoke('cmd_fb_relay', { target: 'ball', event: 'fb:companion-ready', payload: {} }).catch(
            () => undefined,
        );
        return () => ac.abort();
    }, [applyMode, applySummonCtx, applyTravelSnapshot, clearNativeFocusLostTimer, scheduleHideIfPeek, schedulePinnedInputFocus, summonPinned, hideSelf, suspend, resume]);

    // ── peek → pin 升格（窗内有效行为 = 激活 + 执行该行为，0612 用户裁决） ──
    // 点击带处境抓取（点击 = "我要说话"）；滚轮只升格不抓处境（滚轮 = "我要
    // 读"，且选区探针的剪贴板兜底——模拟 Cmd+C——不该被一次滚动引爆）。
    const promoteToPin = useCallback(
        async (kind: 'click' | 'wheel') => {
            if (modeRef.current !== 'peek') return;
            if (pinInFlightRef.current) return;
            pinInFlightRef.current = true;
            const pinToken = beginPinRequest();
            try {
                let ctx: FbCtx | null = null;
                if (kind === 'click') {
                    try {
                        ctx = await invoke<FbCtx>('cmd_fb_capture_context');
                    } catch {
                        ctx = null;
                    }
                    if (!isCurrentPinRequest(pinToken)) {
                        discardStalePinRequest(pinToken);
                        return;
                    }
                }
                try {
                    // 等 make_key_window 真正落地再聚焦：窗口还不是 key window 时
                    // focus() 不出光标——这就是"点了面板输入框却没光标"的根因。
                    await invoke('cmd_fb_pin_companion');
                } catch (err) {
                    applyMode('hidden');
                    void invoke('cmd_fb_hide_companion');
                    console.error('[fb] pin failed:', err);
                    return;
                }
                if (!isCurrentPinRequest(pinToken)) {
                    discardStalePinRequest(pinToken);
                    return;
                }
                applyMode('pin');
                track('floating_ball_summon', { kind: kind === 'click' ? 'pin' : 'wheel' });
                focusInputWhenPinned();
                void rotateIfStale();
                if (kind === 'click') {
                    void applySummonCtx(ctx);
                }
            } finally {
                pinInFlightRef.current = false;
            }
        },
        [applyMode, applySummonCtx, beginPinRequest, discardStalePinRequest, focusInputWhenPinned, isCurrentPinRequest, rotateIfStale],
    );

    // ── 焦点纪律：pin 态输入框光标常驻 ──
    // mousedown 阶段就把焦点按住（retainFocusOnMouseDown 同款 preventDefault，
    // 不给非交互区域转移焦点的机会）；交互件与会话选文区放行。
    // 仅 pin 态生效：peek 态没有任何已聚焦元素可保护，而非 key 窗口的首次
    // 点击（first mouse）在 WebKit 里本就走特殊路径，别去碰它的默认行为。
    const onWinMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        if (modeRef.current !== 'pin') return;
        const target = e.target as Element;
        if (target.closest('textarea, input, button, a, .fbw-convo')) return;
        e.preventDefault();
    }, []);

    // ── key window 收敛兜底 ──
    // 窗口成为 key window 的任何路径（我们的 pin invoke / AppKit 对
    // becomesKeyOnlyIfNeeded panel 的点击自动升 key / 未来新入口），都收敛
    // 到正确终态：peek → 走升格流程；其余 → 光标归位输入框。这是确定性
    // 信号（键盘真的到窗了才 fire），不依赖事件竞速。
    useEffect(() => {
        const onFocus = () => {
            if (modeRef.current === 'peek') {
                void promoteToPin('click');
                return;
            }
            focusInputWhenPinned();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [focusInputWhenPinned, promoteToPin]);

    const onWinClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (modeRef.current === 'peek') {
                void promoteToPin('click');
                return;
            }
            if (modeRef.current !== 'pin') return;
            // pin 态点窗内非交互区域 = 把光标还给输入框（正在选文本除外）。
            const target = e.target as Element;
            if (target.closest('textarea, input, button, a')) return;
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            focusInputWhenPinned();
        },
        [focusInputWhenPinned, promoteToPin],
    );

    // ── peek 滚轮：直接滚动会话流 + 升格 pin ──
    // peek 下 convo 是 pointer-events:none（整窗单击语义），原生滚动到不了
    // 它——首程 delta 手动喂给会话流，升格后的后续滚轮由原生接管。
    const onWinWheel = useCallback(
        (e: React.WheelEvent<HTMLDivElement>) => {
            if (modeRef.current !== 'peek') return;
            const el = convoRef.current;
            if (el) el.scrollTop += e.deltaY;
            void promoteToPin('wheel');
        },
        [promoteToPin],
    );

    const insertReferencePaths = useCallback((paths: string[]) => {
        if (paths.length === 0) return;
        const insertedText = `${paths.map((path) => `@${path}`).join(' ')} `;
        setInput((prev) => {
            const start = inputRef.current?.selectionStart ?? prev.length;
            const end = inputRef.current?.selectionEnd ?? start;
            return `${prev.slice(0, start)}${insertedText}${prev.slice(end)}`;
        });
        requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
        });
    }, []);

    const addImageDrafts = useCallback((drafts: FbImageDraft[]) => {
        if (drafts.length === 0) return;
        const slots = Math.max(0, MAX_IMAGES - imageDrafts.length);
        if (slots === 0) {
            toast.warning(t('floatingBall.toasts.maxImages', { count: MAX_IMAGES }));
            return;
        }
        if (drafts.length > slots) {
            toast.warning(t('floatingBall.toasts.maxImages', { count: MAX_IMAGES }));
        }
        setImageDrafts((prev) => [...prev, ...drafts.slice(0, Math.max(0, MAX_IMAGES - prev.length))]);
    }, [imageDrafts.length, t, toast]);

    const importFilesAsReferences = useCallback(async (files: File[]) => {
        if (files.length === 0) return;
        if (!fileService.isAvailable) {
            toast.error(t(session.workspacePath
                ? 'floatingBall.toasts.cannotUploadDevMode'
                : 'floatingBall.toasts.cannotUploadNoWorkspace'));
            return;
        }
        try {
            const base64Files = await Promise.all(
                files.map(async (file) => ({
                    name: file.name || 'attachment',
                    content: splitDataUrl(await readFileAsDataUrl(file)).data,
                })),
            );
            const result = await fileService.importBase64Files({
                files: base64Files,
                targetDir: 'myagents_files',
            });
            if (!result.success || !result.files || result.files.length === 0) {
                throw new Error('upload failed');
            }
            await fileService.addGitignore({ pattern: 'myagents_files/' }).catch(() => undefined);
            insertReferencePaths(result.files);
            toast.success(t('floatingBall.toasts.filesAdded', { count: result.files.length }));
        } catch (err) {
            console.error('[fb] import files failed:', err);
            toast.error(t('floatingBall.toasts.fileUploadFailed'));
        }
    }, [fileService, insertReferencePaths, session.workspacePath, t, toast]);

    const copyPathsAsReferences = useCallback(async (paths: string[]) => {
        if (paths.length === 0) return;
        if (!fileService.isAvailable) {
            toast.error(t(session.workspacePath
                ? 'floatingBall.toasts.cannotProcessDevMode'
                : 'floatingBall.toasts.cannotProcessNoWorkspace'));
            return;
        }
        try {
            const result = await fileService.copyPaths({
                sourcePaths: paths,
                targetDir: 'myagents_files',
                autoRename: true,
            });
            if (!result.success || !result.copiedFiles || result.copiedFiles.length === 0) {
                throw new Error('copy failed');
            }
            await fileService.addGitignore({ pattern: 'myagents_files/' }).catch(() => undefined);
            insertReferencePaths(result.copiedFiles.map((file) => file.targetPath));
            toast.success(t('floatingBall.toasts.filesAdded', { count: result.copiedFiles.length }));
            if (result.errors?.length) {
                toast.warning(t('floatingBall.toasts.filesNotAdded', { count: result.errors.length }));
            }
        } catch (err) {
            console.error('[fb] copy paths failed:', err);
            toast.error(t('floatingBall.toasts.fileProcessFailed'));
        }
    }, [fileService, insertReferencePaths, session.workspacePath, t, toast]);

    const processDroppedFiles = useCallback(async (files: File[]) => {
        if (files.length === 0) return;
        const imageFiles: File[] = [];
        const otherFiles: File[] = [];
        for (const file of files) {
            if (isChatImageFile(file.name) || isImageMimeType(file.type)) imageFiles.push(file);
            else otherFiles.push(file);
        }

        const oversizedImageFiles = imageFiles.filter((file) => file.size > MAX_IMAGE_SIZE);
        if (oversizedImageFiles.length > 0) {
            toast.warning(
                oversizedImageFiles.length === 1
                    ? t('floatingBall.toasts.imageTooLargeAsFile')
                    : t('floatingBall.toasts.imagesTooLargeAsFile', { count: oversizedImageFiles.length }),
            );
            for (const image of oversizedImageFiles) {
                const idx = imageFiles.indexOf(image);
                if (idx >= 0) imageFiles.splice(idx, 1);
            }
        }

        if (imageFiles.length > 0 && !canAttachImages) {
            toast.info(t('floatingBall.toasts.imageConvertedToFile'));
            for (const image of imageFiles) otherFiles.push(renameIfBareClipboardImage(image));
            imageFiles.length = 0;
        }

        if (imageFiles.length > 0) {
            const drafts: FbImageDraft[] = [];
            for (const file of imageFiles) {
                if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
                    toast.warning(t('floatingBall.toasts.unsupportedImageFormat', { name: file.name }));
                    continue;
                }
                try {
                    drafts.push(await fileToImageDraft(file));
                } catch (err) {
                    console.warn('[fb] failed to read image file:', err);
                }
            }
            addImageDrafts(drafts);
        }

        await importFilesAsReferences(otherFiles);
    }, [addImageDrafts, canAttachImages, importFilesAsReferences, t, toast]);

    const processDroppedFilePaths = useCallback(async (paths: string[]) => {
        if (paths.length === 0) return;
        if (!fileService.isAvailable) {
            toast.error(t(session.workspacePath
                ? 'floatingBall.toasts.cannotProcessDevMode'
                : 'floatingBall.toasts.cannotProcessNoWorkspace'));
            return;
        }

        const imagePaths: string[] = [];
        const otherPaths: string[] = [];
        for (const path of paths) {
            const filename = path.split(/[\\/]/).pop() || path;
            if (isChatImageFile(filename)) imagePaths.push(path);
            else otherPaths.push(path);
        }

        if (imagePaths.length > 0 && !canAttachImages) {
            toast.info(t('floatingBall.toasts.imageConvertedToFile'));
            otherPaths.push(...imagePaths);
            imagePaths.length = 0;
        }

        if (imagePaths.length > 0) {
            try {
                if (!session.sessionId) throw new Error('session not ready');
                const prepared = await fileService.prepareUserImageAttachments({
                    sessionId: session.sessionId,
                    paths: imagePaths,
                });
                const drafts: FbImageDraft[] = [];
                const fallbackPaths: string[] = [];
                let oversizedCount = 0;
                for (const file of prepared.attachments) {
                    const previewUrl = resolveAttachmentUrl({ relativePath: file.relativePath });
                    if (!previewUrl) continue;
                    drafts.push({
                        id: file.id,
                        name: file.name,
                        mimeType: file.mimeType,
                        size: file.sizeBytes,
                        data: '',
                        previewUrl,
                        source: 'upload',
                        transport: 'attachment_ref',
                        relativePath: file.relativePath,
                    });
                }
                for (const err of prepared.errors) {
                    if (err.code === 'too_large') oversizedCount += 1;
                    fallbackPaths.push(err.path);
                }
                if (oversizedCount > 0) {
                    toast.info(
                        oversizedCount === 1
                            ? t('floatingBall.toasts.imageTooLargeAddedAsFile')
                            : t('floatingBall.toasts.imagesTooLargeAddedAsFile', { count: oversizedCount }),
                    );
                }
                addImageDrafts(drafts);
                otherPaths.push(...fallbackPaths);
            } catch (err) {
                console.warn('[fb] failed to read dropped images, treating as files:', err);
                otherPaths.push(...imagePaths);
            }
        }

        await copyPathsAsReferences(otherPaths);
    }, [addImageDrafts, canAttachImages, copyPathsAsReferences, fileService, session.sessionId, session.workspacePath, t, toast]);

    useTauriFileDrop({
        enabled: mode !== 'hidden',
        onDragEnter: () => setIsDraggingFiles(true),
        onDragLeave: () => setIsDraggingFiles(false),
        onDrop: (paths) => {
            setIsDraggingFiles(false);
            void processDroppedFilePaths(paths);
        },
    });

    const onInputPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        void processDroppedFiles(files);
    }, [processDroppedFiles]);

    const onWinDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setIsDraggingFiles(true);
    }, []);

    const onWinDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingFiles(false);
        void processDroppedFiles(files);
    }, [processDroppedFiles]);

    const onWinDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsDraggingFiles(false);
    }, []);

    const removeImageDraft = useCallback((id: string) => {
        setImageDrafts((prev) => prev.filter((draft) => draft.id !== id));
    }, []);

    const previewDraft = useCallback((url: string, name: string) => {
        openPreview(url, name);
    }, [openPreview]);

    // ── 自动滚底（贴底跟随，唯贴底才跟随） ──
    const onConvoScroll = useCallback(() => {
        const el = convoRef.current;
        if (el) stickToBottomRef.current = isNearBottom(el);
    }, []);
    useEffect(() => {
        const el = convoRef.current;
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [session.messages, session.liveMessage, mode]);

    // ── 初始高度（记忆） ──
    useEffect(() => {
        void invoke('cmd_fb_set_companion_size', { width: WIN_W, height: loadWinH() });
    }, []);

    // ── 发送 ──（埋点在 hook 的 send 内、入队成功后才打）
    const doSend = useCallback(async () => {
        const text = input.trim();
        const drafts = imageDrafts;
        if ((!text && drafts.length === 0) || session.busy || !session.ready) return;
        stickToBottomRef.current = true; // 发送 = 跟住回复
        setInput('');
        setImageDrafts([]);
        const q = quote;
        setQuote(null);
        const ctx = lastCtxRef.current;
        const screenshotDraft = drafts.find((draft) => draft.source === 'screenshot');
        const attachments: FbAttachment[] = drafts.map((draft) => ({
            id: draft.id,
            name: draft.name,
            size: draft.size,
            mimeType: draft.mimeType,
            relativePath: draft.relativePath,
            previewUrl: draft.previewUrl,
            isImage: true,
        }));
        await send(text, {
            quote: q,
            images: drafts.map((draft) => (
                draft.transport === 'attachment_ref' && draft.relativePath
                    ? {
                        kind: 'attachment_ref' as const,
                        id: draft.id,
                        name: draft.name,
                        mimeType: draft.mimeType,
                        sizeBytes: draft.size,
                        relativePath: draft.relativePath,
                    }
                    : {
                        kind: 'inline_base64' as const,
                        id: draft.id,
                        name: draft.name,
                        mimeType: draft.mimeType,
                        sizeBytes: draft.size,
                        data: draft.data,
                    }
            )),
            attachments,
            appName: screenshotDraft?.appName ?? ctx?.appName ?? null,
            windowTitle: screenshotDraft?.windowTitle ?? ctx?.windowTitle ?? null,
            screenshotAttached: Boolean(screenshotDraft),
        });
    }, [imageDrafts, input, quote, session.busy, session.ready, send]);

    const resizeInput = useCallback((el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }, []);

    // 输入键盘入口：Ctrl/Cmd+A 全选、Esc、Enter/换行语义和 IME 防误发统一在
    // hook 内维护。悬浮窗是独立 WebView，不会经过 App.tsx 的全局快捷键路由。
    const composerKeydown = useFloatingComposerKeydown({
        sendShortcut: session.sendShortcut,
        onSend: doSend,
        onEscape: hideSelf,
        onCompositionEndResize: resizeInput,
    });

    // ── 📷 快门（D7：只在点下这一刻发生） ──
    const onShot = useCallback(async () => {
        try {
            const res = await invoke<FbShot>('cmd_fb_screenshot');
            lastCtxRef.current = {
                ...lastCtxRef.current,
                appName: res.appName ?? lastCtxRef.current?.appName ?? null,
                windowTitle: res.windowTitle ?? lastCtxRef.current?.windowTitle ?? null,
            };
            if (canAttachImages) {
                addImageDrafts([shotToImageDraft(res)]);
            } else {
                toast.info(t('floatingBall.toasts.imageConvertedToFile'));
                const { mimeType, data } = splitDataUrl(res.dataUrl);
                const ext = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg' : 'png';
                const fileName = `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
                const result = await fileService.importBase64Files({
                    files: [{ name: fileName, content: data }],
                    targetDir: 'myagents_files',
                });
                if (!result.success || !result.files?.length) {
                    toast.error(t('floatingBall.toasts.screenshotSaveFailed'));
                    return;
                }
                await fileService.addGitignore({ pattern: 'myagents_files/' }).catch(() => undefined);
                insertReferencePaths(result.files);
            }
            track('floating_ball_summon', { kind: 'screenshot' });
        } catch (err) {
            console.warn('[fb] screenshot failed:', err);
            const detail = describeNativeFloatingBallError(err).trim();
            toast.error(detail
                ? t('floatingBall.toasts.screenshotFailedWithDetail', { detail: detail.slice(0, 160) })
                : t('floatingBall.toasts.screenshotFailed'));
        }
    }, [addImageDrafts, canAttachImages, fileService, insertReferencePaths, t, toast]);

    // ── 展开进主程序（唤起主窗 → 新 Tab 接上这条会话） ──
    const onExpand = useCallback(() => {
        if (!session.sessionId || !session.workspacePath) return;
        track('floating_ball_expand', {});
        void (async () => {
            try {
                await invoke('cmd_fb_open_main_with_session', {
                    sessionId: session.sessionId,
                    workspacePath: session.workspacePath,
                    previewPath: null,
                    previewLine: null,
                });
            } catch (err) {
                console.error('[fb] open main with session failed:', err);
            } finally {
                hideSelf();
            }
        })();
    }, [session.sessionId, session.workspacePath, hideSelf]);

    const onOpenDesktopPetSettings = useCallback(() => {
        void invoke('cmd_fb_open_desktop_pet_settings').catch((err) => {
            console.error('[fb] open desktop pet settings failed:', err);
            toast.error(t('floatingBall.toasts.openPetSettingsFailed'));
        });
    }, [t, toast]);

    const onOpenMyAgentsPreview = useCallback((path: string, options?: { displayPath?: string; initialLineNumber?: number }) => {
        if (!session.sessionId || !session.workspacePath) return;
        track('floating_ball_expand', { kind: 'file_preview' });
        void (async () => {
            try {
                await invoke('cmd_fb_open_main_with_session', {
                    sessionId: session.sessionId,
                    workspacePath: session.workspacePath,
                    previewPath: path,
                    previewLine: options?.initialLineNumber ?? null,
                });
            } catch (err) {
                console.error('[fb] open main preview failed:', err);
            } finally {
                hideSelf();
            }
        })();
    }, [hideSelf, session.sessionId, session.workspacePath]);

    // ── AX 授权引导 ──
    const onGrantAx = useCallback(async () => {
        try {
            await invoke('cmd_fb_ax_status', { prompt: true });
            setAxNeeded(false);
        } catch {
            // 系统弹窗已出现即可
        }
    }, []);

    // ── 高度调节（顶/底边拖） + 移动（顶部标题栏地带拖） ──
    // 平移拖拽由 Rust 读取 NSEvent.mouseLocation + 当前窗口 frame 计算，避免把
    // WebView screenX/Y 混成 AppKit/Tauri 窗口坐标；高度调节仍由 JS 锚定当前
    // 窗口几何做局部尺寸变化。
    // 底边拖只改高度（origin 不动，height 是 JS 本地累计、本就无回读）；顶边拖
    // 锚定底边、让顶边跟随光标（newTop=光标−抓取偏移、height=底锚−newTop）。
    const bindResize = useCallback((edge: 'top' | 'bottom') => {
        return (e: React.PointerEvent<HTMLDivElement>) => {
            if (modeRef.current !== 'pin') return;
            e.preventDefault();
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            target.classList.add('active');
            // 按下时锁定的几何锚（全局点，左上原点），全程不再回读窗口几何。
            const winLeft = e.screenX - e.clientX;
            const winTop = e.screenY - e.clientY;
            const h0 = window.innerHeight;
            const bottomY = winTop + h0; // 顶边拖时的固定底锚
            const startScreenY = e.screenY;
            const grabY = e.clientY;
            let height = h0;
            const onMove = (ev: PointerEvent) => {
                if (edge === 'bottom') {
                    // 底边跟随光标、顶边（origin）不动 → 纯改高度（起始高度 + 光标
                    // 位移），无需移动窗口。
                    height = Math.max(360, h0 + (ev.screenY - startScreenY));
                    void invoke('cmd_fb_set_companion_size', { width: WIN_W, height });
                } else {
                    // 顶边跟随光标、底边锚定：绝对算 newTop/height，不送增量。
                    let newTop = ev.screenY - grabY;
                    height = Math.max(360, bottomY - newTop);
                    newTop = bottomY - height; // 触底夹紧后回算顶，保持底锚不动
                    void invoke('cmd_fb_set_companion_size', { width: WIN_W, height });
                    void invoke('cmd_fb_move_companion_to', { x: winLeft, y: newTop });
                }
            };
            const onUp = (ev: PointerEvent) => {
                target.releasePointerCapture(ev.pointerId);
                target.classList.remove('active');
                target.removeEventListener('pointermove', onMove);
                target.removeEventListener('pointerup', onUp);
                localStorage.setItem(WIN_H_KEY, String(Math.round(height)));
            };
            target.addEventListener('pointermove', onMove);
            target.addEventListener('pointerup', onUp);
        };
    }, []);

    const onMoveDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (modeRef.current !== 'pin') return;
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        target.classList.add('active');
        void invoke('cmd_fb_drag_companion_start').catch((err) => {
            console.warn('[fb] start companion native drag failed:', err);
        });
        let cleaned = false;
        const onMove = (ev: PointerEvent) => {
            ev.preventDefault();
            void invoke('cmd_fb_drag_companion_move');
        };
        const cleanup = (ev: PointerEvent) => {
            if (cleaned) return;
            cleaned = true;
            try {
                target.releasePointerCapture(ev.pointerId);
            } catch {
                // capture may already be gone on pointercancel / lostpointercapture
            }
            target.classList.remove('active');
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('pointerup', cleanup);
            target.removeEventListener('pointercancel', cleanup);
            target.removeEventListener('lostpointercapture', cleanup);
            void invoke('cmd_fb_drag_companion_end').catch((err) => {
                console.warn('[fb] end companion native drag failed:', err);
            });
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', cleanup);
        target.addEventListener('pointercancel', cleanup);
        target.addEventListener('lostpointercapture', cleanup);
    }, []);

    const sendReady = (input.trim().length > 0 || imageDrafts.length > 0) && !session.busy && session.ready;
    const hasConversationSurface =
        session.messages.length > 0 ||
        Boolean(session.liveMessage) ||
        Boolean(session.permReq) ||
        Boolean(session.askReq) ||
        Boolean(session.planReq);
    const isBootState = !session.ready && !hasConversationSurface;

    return (
        <div
            className={`fbw-win ${mode === 'pin' ? 'pin' : 'peek'}${mode === 'hidden' ? ' hidden' : ''}${isDraggingFiles ? ' dragging-files' : ''}`}
            onMouseDown={onWinMouseDown}
            onClick={onWinClick}
            onWheel={onWinWheel}
            onDragOver={onWinDragOver}
            onDragLeave={onWinDragLeave}
            onDrop={onWinDrop}
            onMouseEnter={() => {
                mouseInsideRef.current = true;
                if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
            }}
            onMouseLeave={() => {
                mouseInsideRef.current = false;
                scheduleHideIfPeek();
            }}
        >
            {/* chrome：pin 悬停浮现 */}
            <div className="fbw-chrome">
                <span className="who">{whoLabel}</span>
                <button onClick={onOpenDesktopPetSettings} title={t('floatingBall.chrome.openPetSettings')}>
                    <SettingsIcon className="size-4" />
                </button>
                <button onClick={onExpand} title={t('floatingBall.chrome.openInMyAgents')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>
                </button>
                <button onClick={hideSelf} title={t('floatingBall.chrome.closeEsc')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
            </div>

            {travelPostcard && (
                <TravelMatePostcard
                    postcard={travelPostcard}
                    eyebrow={t('floatingBall.travelMate.eyebrow')}
                    dismissLabel={t('floatingBall.travelMate.dismiss')}
                    onDismiss={() => {
                        void dismissTravelMatePostcard()
                            .then(() => setTravelPostcard(null))
                            .catch((err) => {
                                console.warn('[travel-mate] dismiss postcard failed:', err);
                            });
                    }}
                />
            )}

            {/* 会话流 */}
            <FileActionProvider
                workspacePath={session.workspacePath}
                onInsertReference={insertReferencePaths}
                menuProfile="floatingBall"
                onOpenMyAgentsPreview={onOpenMyAgentsPreview}
            >
            <div className={`fbw-convo${isBootState ? ' boot-state' : ''}`} ref={convoRef} onScroll={onConvoScroll}>
                {!session.ready && !session.error && (
                    <div className="fbw-divider">{t('floatingBall.connecting', { workspace: session.workspaceName })}</div>
                )}
                {session.error && !session.ready && (
                    <div className="fbw-error">{session.error}</div>
                )}
                {session.messages.map((m: FbMsg) =>
                    m.role === 'user' ? (
                        <div className="fbw-msg user" key={m.id}>
                            <div className="pill">
                                {m.quote && <div className="q">{m.quote}</div>}
                                {m.attachments && m.attachments.length > 0 && (
                                    <AttachmentPreviewList
                                        attachments={m.attachments}
                                        compact
                                        imageDimensions="h-20"
                                        className={m.text ? 'mb-2' : ''}
                                        onPreview={previewDraft}
                                    />
                                )}
                                {m.text}
                            </div>
                        </div>
                    ) : (
                        <AssistantMessage key={m.id} message={m} isStreaming={false} tick={nowTick} />
                    ),
                )}
                {session.liveMessage && <AssistantMessage message={session.liveMessage} isStreaming tick={nowTick} />}
                {/* 交互表单（D13）：复用主 Chat 同款组件，能力对等、视觉随设计
                    token 收敛。fb 窗是主 Vite app 的懒加载路由，Tailwind + @theme
                    token 天然可用，组件原样渲染。每类卡片缺一不可——漏接会让本轮
                    永久 hang（PRD §14.1）。 */}
                {(session.permReq || session.askReq || session.planReq) && (
                    <div className="fbw-forms">
                        {session.permReq && (
                            <PermissionPrompt
                                key={session.permReq.requestId}
                                request={session.permReq}
                                onDecision={(requestId, decision) => session.respondPermission(decision, requestId)}
                            />
                        )}
                        {session.askReq && (
                            <AskUserQuestionPrompt
                                request={session.askReq}
                                onSubmit={(_, answers) => void session.respondAskUserQuestion(answers)}
                                onCancel={() => void session.respondAskUserQuestion(null)}
                            />
                        )}
                        {session.planReq && (
                            <ExitPlanModePrompt
                                key={session.planReq.requestId}
                                request={session.planReq}
                                onApprove={() => void session.respondExitPlanMode(true)}
                                onReject={(feedback) => void session.respondExitPlanMode(false, feedback)}
                            />
                        )}
                    </div>
                )}
            </div>
            </FileActionProvider>

            {/* 兜底状态行：仅在还没有任何可见反馈（无活动行/无流式文本）时出现 */}
            {session.busy && session.activities.length === 0 && !session.liveMessage && (
                <div className="fbw-statusline">
                    <span className="fbw-spinner" />
                    <span style={{ flex: 1 }}>{t('floatingBall.processing')}</span>
                </div>
            )}
            {session.error && session.ready && (
                <div className="fbw-error">{session.error}</div>
            )}

            {/* AX 授权引导（第一次想给引用时） */}
            {mode === 'pin' && axNeeded && (
                <div className="fbw-ax">
                    {t('floatingBall.axPrompt')}
                    <br />
                    <button onClick={() => void onGrantAx()}>{t('floatingBall.grantAccessibility')}</button>
                </div>
            )}

            {/* 输入区 */}
            <div className="fbw-inputarea">
                {quote && (
                    <div className="fbw-quote">
                        <span className="rule" />
                        <span className="q-text">{quote}</span>
                        <button className="q-x" onClick={() => setQuote(null)} title={t('floatingBall.removeQuote')}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                    </div>
                )}
                {imageDrafts.length > 0 && (
                    <AttachmentPreviewList
                        attachments={imageDrafts.map((draft) => ({
                            id: draft.id,
                            name: draft.name,
                            size: draft.size,
                            mimeType: draft.mimeType,
                            previewUrl: draft.previewUrl,
                            isImage: true,
                        }))}
                        compact
                        className="fbw-input-attachments"
                        imageDimensions="h-20"
                        onRemove={removeImageDraft}
                        onPreview={previewDraft}
                    />
                )}
                <div className="fbw-inputrow">
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={input}
                        placeholder={t('input.companionPlaceholder')}
                        onChange={(e) => {
                            setInput(e.target.value);
                            // IME 组合期间不写 style（#123：触发 WebKit 候选窗重排卡顿）
                            if (!composerKeydown.isComposing()) resizeInput(e.target);
                        }}
                        onKeyDown={composerKeydown.onKeyDown}
                        onPaste={onInputPaste}
                        onCompositionStart={composerKeydown.onCompositionStart}
                        onCompositionEnd={composerKeydown.onCompositionEnd}
                    />
                    <button className="cam" onClick={() => void onShot()} title={t('input.addScreenshot')}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                    </button>
                    {/* 与主对话框同语义：运行中 = 停止（方块），否则 = 发送（箭头） */}
                    {session.busy ? (
                        <button className="send stop" onClick={() => void session.stop()} title={t('input.stop')}>
                            <svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
                        </button>
                    ) : (
                        <button className={`send${sendReady ? ' ready' : ''}`} onClick={() => void doSend()} title={t('input.send')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                        </button>
                    )}
                </div>
            </div>

            {/* 高度调节柄 + 移动拖拽区（仅 pin） */}
            <div className="fbw-rz top" onPointerDown={bindResize('top')} title={t('floatingBall.resizeHandle')} />
            <div className="fbw-rz bottom" onPointerDown={bindResize('bottom')} title={t('floatingBall.resizeHandle')} />
            <div className="fbw-mv" onPointerDown={onMoveDown} title={t('floatingBall.moveHandle')} />
        </div>
    );
}
