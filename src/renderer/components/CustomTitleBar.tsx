/**
 * CustomTitleBar - Chrome-style titlebar with integrated tabs
 *
 * Key insight: data-tauri-drag-region must be on SPECIFIC draggable elements,
 * not just the parent container. Also, -webkit-app-region CSS CONFLICTS with
 * Tauri's mechanism on macOS WebKit.
 *
 * Windows: Custom window controls (minimize, maximize, close) are added since
 * we use decorations: false on Windows for custom title bar styling.
 */

import {
  MinusIcon,
  StopIcon,
  CloseIcon,
  RefreshIcon,
  UndoIcon,
  CopyIcon,
} from '@/components/icons';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri } from '@/api/tauriClient';

interface CustomTitleBarProps {
    children: ReactNode;  // TabBar component
    /** Whether an update is ready to install */
    updateReady?: boolean;
    /** Version of the update ready to install */
    updateVersion?: string | null;
    /** Whether an install is currently in flight (post-click). When true the
     *  button shows a spinner and is disabled to prevent double-clicks. */
    updateInstalling?: boolean;
    /** Whether a silent download is replacing the pending bytes. When true
     *  the button hides entirely — clicking install mid-replacement would
     *  land on inconsistent cache/disk state. The button reappears with the
     *  new version once the replacement commits. */
    updatePreparing?: boolean;
    /** Callback when user clicks "Restart to Update" */
    onRestartAndUpdate?: () => void;
    /** Number of restorable conversations from the previous session (Issue
     *  #309). `> 0` shows the "恢复对话" pill; surfaced by App only when the last
     *  exit was NOT a deliberate quit (crash / update-restart). */
    restoreCount?: number;
    /** Click the pill body → restore the previous session. */
    onRestoreSession?: () => void;
    /** Click the pill's ✕ → dismiss without restoring. */
    onDismissRestore?: () => void;
}

const EDGE_DRAG_REGION_WIDTH = 30;

// Detect platform
const isWindows = typeof navigator !== 'undefined' && navigator.platform?.includes('Win');

function TitlebarDragSpacer({ className = '', style }: { className?: string; style?: CSSProperties }) {
    return (
        <div
            className={`h-full flex-shrink-0 ${className}`}
            style={style}
            data-tauri-drag-region
            aria-hidden="true"
        />
    );
}

export default function CustomTitleBar({
    children,
    updateReady,
    updateVersion,
    updateInstalling,
    updatePreparing,
    onRestartAndUpdate,
    restoreCount = 0,
    onRestoreSession,
    onDismissRestore,
}: CustomTitleBarProps) {
    const { t } = useTranslation('app');
    const [isMaximized, setIsMaximized] = useState(false);

    // Listen for fullscreen changes
    useEffect(() => {
        if (!isTauri()) return;

        let mounted = true;

        const checkWindowState = async () => {
            if (!mounted) return;
            try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                const win = getCurrentWindow();
                const max = await win.isMaximized();
                if (mounted) {
                    setIsMaximized(max);
                }
            } catch (e) {
                console.error('Failed to check window state:', e);
            }
        };

        // Initial check
        checkWindowState();

        // Use resize event listener with debounce instead of polling
        // macOS fullscreen exit animation takes ~500-700ms, so we do a
        // second delayed check to catch the final state after animation.
        let resizeTimeout: NodeJS.Timeout;
        let animationTimeout: NodeJS.Timeout;
        const onResize = () => {
            clearTimeout(resizeTimeout);
            clearTimeout(animationTimeout);
            resizeTimeout = setTimeout(checkWindowState, 150);
            animationTimeout = setTimeout(checkWindowState, 700);
        };

        window.addEventListener('resize', onResize);

        return () => {
            mounted = false;
            window.removeEventListener('resize', onResize);
            clearTimeout(resizeTimeout);
            clearTimeout(animationTimeout);
        };
    }, []);

    // Windows window control handlers
    const handleMinimize = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().minimize();
        } catch (e) {
            console.error('Failed to minimize:', e);
        }
    };

    const handleMaximize = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const win = getCurrentWindow();
            if (await win.isMaximized()) {
                await win.unmaximize();
            } else {
                await win.maximize();
            }
        } catch (e) {
            console.error('Failed to toggle maximize:', e);
        }
    };

    const handleClose = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().close();
        } catch (e) {
            console.error('Failed to close:', e);
        }
    };

    return (
        <div
            className="custom-titlebar flex h-11 flex-shrink-0 items-center bg-[var(--global-sidebar-bg)] pl-2"
        >
            {/* Windows: keep a reliable left-edge drag target even when tabs fill the bar. */}
            {isWindows && (
                <div
                    className="h-full flex-shrink-0"
                    style={{ width: EDGE_DRAG_REGION_WIDTH }}
                    data-tauri-drag-region
                />
            )}

            {/* Tabs area: owns the available titlebar slot; TabBar leaves unused space draggable internally. */}
            <div className="flex h-full min-w-0 flex-1 items-center overflow-hidden" data-no-drag>
                {children}
            </div>

            {/* Right-edge drag target. Kept fixed so crowded tabs never cover it. */}
            <TitlebarDragSpacer style={{ width: EDGE_DRAG_REGION_WIDTH }} />

            {/* Right side actions. Buttons are non-drag; explicit gaps remain draggable. */}
            <div className="flex h-full flex-shrink-0 items-center" data-no-drag>
                <TitlebarDragSpacer className="w-1" />
                {/* "恢复对话" pill (Issue #309) — opt-in restore of the previous
                    session, shown only when the last exit was NOT a deliberate
                    quit (crash / update-restart; decided in App). A compound
                    pill: the body restores, the trailing ✕ dismisses. Lower
                    emphasis than the green update pill (a soft terracotta tint,
                    not a call-to-action) since it's optional and dismissable. */}
                {restoreCount > 0 && (
                    <>
                        <div
                            className="flex h-7 items-center rounded-full border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] shadow-sm"
                            data-no-drag
                        >
                            <button
                                onClick={onRestoreSession}
                                className="flex h-full items-center gap-1.5 rounded-l-full pl-3 pr-2 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--accent-warm-muted)] active:scale-95"
                                title={t('titlebar.restoreTitle', { count: restoreCount })}
                                data-no-drag
                            >
                                <UndoIcon className="h-3.5 w-3.5 text-[var(--accent-warm)]" />
                                <span>{t('titlebar.restorePrevious')}</span>
                                {restoreCount > 1 && (
                                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent-warm-muted)] px-1 text-xs font-semibold text-[var(--accent-warm)]">
                                        {restoreCount}
                                    </span>
                                )}
                            </button>
                            <span className="h-3.5 w-px bg-[var(--accent-warm-muted)]" />
                            <button
                                onClick={onDismissRestore}
                                className="flex h-full items-center rounded-r-full px-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--accent-warm-muted)] hover:text-[var(--ink)] active:scale-95"
                                title={t('titlebar.dismiss')}
                                data-no-drag
                            >
                                <CloseIcon className="h-3 w-3" />
                            </button>
                        </div>
                        <TitlebarDragSpacer className="w-1" />
                    </>
                )}
                {/* Update button - only shown when update is ready AND no
                    silent replacement download is in flight. Spinner +
                    disabled state during install so the user sees immediate
                    feedback on click. Hidden during silent download because
                    the pending bytes are about to be replaced — clicking
                    install mid-replacement could land on inconsistent
                    cache/disk state. Reappears automatically when the
                    replacement commits (with the new version). */}
                {updateReady && !updatePreparing && (
                    <>
                        <button
                            onClick={updateInstalling ? undefined : onRestartAndUpdate}
                            disabled={updateInstalling}
                            className="flex h-7 items-center gap-1.5 px-3 rounded-full text-xs font-medium text-[var(--on-success)] bg-[var(--success)] shadow-sm transition-all hover:bg-[var(--success)] active:scale-95 disabled:opacity-80 disabled:cursor-wait"
                            title={updateInstalling
                                ? t('titlebar.installingUpdate')
                                : (updateVersion ? t('titlebar.updateToVersion', { version: updateVersion }) : t('titlebar.restartAndUpdate'))}
                            data-no-drag
                        >
                            <RefreshIcon className={`h-3.5 w-3.5 ${updateInstalling ? 'animate-spin' : ''}`} />
                            <span>{updateInstalling ? t('titlebar.installing') : t('titlebar.restartUpdate')}</span>
                        </button>
                        <TitlebarDragSpacer className="w-1" />
                    </>
                )}
            </div>

            {/* Windows window controls */}
            {isWindows && (
                <div className="flex h-full items-stretch" data-no-drag>
                    <button
                        onClick={handleMinimize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
                        title={t('titlebar.minimize')}
                        data-no-drag
                    >
                        <MinusIcon className="h-4 w-4" />
                    </button>
                    <button
                        onClick={handleMaximize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
                        title={isMaximized ? t('titlebar.restoreWindow') : t('titlebar.maximize')}
                        data-no-drag
                    >
                        {isMaximized ? (
                            <CopyIcon className="h-3.5 w-3.5" />
                        ) : (
                            <StopIcon className="h-3.5 w-3.5" />
                        )}
                    </button>
                    <button
                        onClick={handleClose}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--error)] hover:text-[var(--on-error)] transition-colors"
                        title={t('titlebar.close')}
                        data-no-drag
                    >
                        <CloseIcon className="h-4 w-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
