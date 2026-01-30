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

import { Minus, Square, X, RefreshCw, Settings, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { isTauri } from '@/api/tauriClient';

interface CustomTitleBarProps {
    children: ReactNode;  // TabBar component
    onSettingsClick?: () => void;
    /** Whether an update is ready to install */
    updateReady?: boolean;
    /** Version of the update ready to install */
    updateVersion?: string | null;
    /** Callback when user clicks "Restart to Update" */
    onRestartAndUpdate?: () => void;
}

// macOS traffic lights (close/minimize/maximize) width + padding
const MACOS_TRAFFIC_LIGHTS_WIDTH = 78;

// Detect platform
const isWindows = typeof navigator !== 'undefined' && navigator.platform?.includes('Win');

export default function CustomTitleBar({
    children,
    onSettingsClick,
    updateReady,
    updateVersion,
    onRestartAndUpdate,
}: CustomTitleBarProps) {
    const [isFullscreen, setIsFullscreen] = useState(false);
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
                const fs = await win.isFullscreen();
                const max = await win.isMaximized();
                if (mounted) {
                    setIsFullscreen(fs);
                    setIsMaximized(max);
                }
            } catch (e) {
                console.error('Failed to check window state:', e);
            }
        };

        // Initial check
        checkWindowState();

        // Use resize event listener with debounce instead of polling
        let resizeTimeout: NodeJS.Timeout;
        const onResize = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(checkWindowState, 200);
        };

        window.addEventListener('resize', onResize);

        return () => {
            mounted = false;
            window.removeEventListener('resize', onResize);
            clearTimeout(resizeTimeout);
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
            className="custom-titlebar flex h-11 flex-shrink-0 items-center border-b border-[var(--line)] bg-gradient-to-b from-[var(--paper)] to-[var(--paper-contrast)]/30"
        >
            {/* macOS traffic lights spacer - DRAGGABLE (hidden on Windows) */}
            {!isWindows && !isFullscreen && (
                <div
                    className="flex-shrink-0 h-full"
                    style={{ width: MACOS_TRAFFIC_LIGHTS_WIDTH }}
                    data-tauri-drag-region
                />
            )}

            {/* Windows: Small left padding for drag area */}
            {isWindows && (
                <div
                    className="flex-shrink-0 h-full w-3"
                    data-tauri-drag-region
                />
            )}

            {/* Tabs area - NOT draggable */}
            <div
                className="flex h-full items-center overflow-hidden"
                data-no-drag
            >
                {children}
            </div>

            {/* Flexible spacer - DRAGGABLE */}
            <div
                className="flex-1 h-full"
                data-tauri-drag-region
            />

            {/* Right side actions - NOT draggable */}
            <div
                className="flex flex-shrink-0 items-center gap-1 px-3 h-full"
                data-no-drag
            >
                {/* Update button - only shown when update is ready */}
                {updateReady && (
                    <button
                        onClick={onRestartAndUpdate}
                        className="flex h-7 items-center gap-1.5 px-3 rounded-full text-xs font-medium text-white bg-emerald-600 shadow-sm transition-all hover:bg-emerald-700 active:scale-95"
                        title={updateVersion ? `更新到 v${updateVersion}` : '重启并更新'}
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        <span>重启更新</span>
                    </button>
                )}
                <button
                    onClick={onSettingsClick || (() => console.log('Settings clicked - TODO'))}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-all hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    title="设置"
                >
                    <Settings className="h-4 w-4" />
                </button>
            </div>

            {/* Windows window controls */}
            {isWindows && (
                <div className="flex h-full items-stretch" data-no-drag>
                    <button
                        onClick={handleMinimize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] transition-colors"
                        title="最小化"
                    >
                        <Minus className="h-4 w-4" />
                    </button>
                    <button
                        onClick={handleMaximize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] transition-colors"
                        title={isMaximized ? "还原" : "最大化"}
                    >
                        {isMaximized ? (
                            <Copy className="h-3.5 w-3.5" />
                        ) : (
                            <Square className="h-3.5 w-3.5" />
                        )}
                    </button>
                    <button
                        onClick={handleClose}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-red-500 hover:text-white transition-colors"
                        title="关闭"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
