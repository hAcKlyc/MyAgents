/**
 * CustomTitleBar - Chrome-style titlebar with integrated tabs
 *
 * Key insight: data-tauri-drag-region must be on SPECIFIC draggable elements,
 * not just the parent container. Also, -webkit-app-region CSS CONFLICTS with
 * Tauri's mechanism on macOS WebKit.
 */

import { RefreshCw, Settings } from 'lucide-react';
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

export default function CustomTitleBar({
    children,
    onSettingsClick,
    updateReady,
    updateVersion,
    onRestartAndUpdate,
}: CustomTitleBarProps) {
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Listen for fullscreen changes
    useEffect(() => {
        if (!isTauri()) return;

        let mounted = true;

        const checkFullscreen = async () => {
            if (!mounted) return;
            try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                const win = getCurrentWindow();
                const fs = await win.isFullscreen();
                if (mounted) setIsFullscreen(fs);
            } catch (e) {
                console.error('Failed to check fullscreen:', e);
            }
        };

        // Initial check
        checkFullscreen();

        // Use resize event listener with debounce instead of polling
        let resizeTimeout: NodeJS.Timeout;
        const onResize = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(checkFullscreen, 200);
        };

        window.addEventListener('resize', onResize);

        return () => {
            mounted = false;
            window.removeEventListener('resize', onResize);
            clearTimeout(resizeTimeout);
        };
    }, []);

    // NOTE: Double-click to maximize/restore is handled natively by macOS
    // when using titleBarStyle: "Overlay". No custom handler needed.

    return (
        <div
            className="custom-titlebar flex h-11 flex-shrink-0 items-center border-b border-[var(--line)] bg-gradient-to-b from-[var(--paper)] to-[var(--paper-contrast)]/30"
        >
            {/* macOS traffic lights spacer - DRAGGABLE */}
            {!isFullscreen && (
                <div
                    className="flex-shrink-0 h-full"
                    style={{ width: MACOS_TRAFFIC_LIGHTS_WIDTH }}
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
        </div>
    );
}
