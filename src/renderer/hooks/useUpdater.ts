// React hook for managing auto-updates (silent background updates)
//
// Flow:
// 1. Rust checks and downloads updates silently on startup
// 2. When ready, Rust emits 'updater:ready-to-restart' event
// 3. This hook receives the event and sets updateReady = true
// 4. UI shows "Restart to Update" button in titlebar
// 5. User clicks → restartAndUpdate() → app restarts with new version

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';

import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';

export interface UpdateReadyInfo {
    version: string;
}

interface UseUpdaterResult {
    /** Whether an update has been downloaded and is ready to install */
    updateReady: boolean;
    /** The version that's ready to install */
    updateVersion: string | null;
    /** Restart the app to apply the update */
    restartAndUpdate: () => Promise<void>;
}

// Periodic check interval: 4 hours
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function useUpdater(): UseUpdaterResult {
    const [updateReady, setUpdateReady] = useState(false);
    const [updateVersion, setUpdateVersion] = useState<string | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const updateReadyRef = useRef(false);

    // Keep ref in sync with state
    useEffect(() => {
        updateReadyRef.current = updateReady;
    }, [updateReady]);

    // Restart app to apply the update
    const restartAndUpdate = useCallback(async () => {
        if (!isTauriEnvironment()) return;

        try {
            await relaunch();
        } catch (err) {
            console.error('[useUpdater] Restart failed:', err);
            // Fallback: try invoking the Rust command
            try {
                await invoke('restart_app');
            } catch (e) {
                console.error('[useUpdater] Rust restart also failed:', e);
            }
        }
    }, []);

    // Listen for update ready event from Rust
    useEffect(() => {
        if (!isTauriEnvironment()) {
            if (isDebugMode()) {
                console.log('[useUpdater] Not in Tauri environment, skipping event listener setup');
            }
            return;
        }

        if (isDebugMode()) {
            console.log('[useUpdater] Setting up event listener for updater:ready-to-restart...');
        }
        let isMounted = true;
        let unlisten: UnlistenFn | null = null;

        const setup = async () => {
            try {
                unlisten = await listen<UpdateReadyInfo>('updater:ready-to-restart', (event) => {
                    if (isDebugMode()) {
                        console.log('[useUpdater] Event received: updater:ready-to-restart', event.payload);
                    }
                    if (!isMounted) {
                        return;
                    }
                    setUpdateVersion(event.payload.version);
                    setUpdateReady(true);
                });
                if (isDebugMode()) {
                    console.log('[useUpdater] Event listener registered successfully');
                }
            } catch (err) {
                console.error('[useUpdater] Failed to setup event listener:', err);
            }
        };

        void setup();

        return () => {
            isMounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    // Periodic background check (silent - just triggers Rust to check and download)
    // Uses ref to avoid recreating interval when updateReady changes
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const doCheck = async () => {
            // Use ref to get current value without dependency
            if (updateReadyRef.current) return;
            try {
                await invoke('check_and_download_update');
            } catch (err) {
                // Silent failure - don't bother user
                console.error('[useUpdater] Periodic check failed:', err);
            }
        };

        intervalRef.current = setInterval(() => {
            void doCheck();
        }, CHECK_INTERVAL_MS);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, []); // Empty deps - interval created once on mount

    return {
        updateReady,
        updateVersion,
        restartAndUpdate,
    };
}
