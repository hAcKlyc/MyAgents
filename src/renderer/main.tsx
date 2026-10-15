import { isModelQaBuild } from '../shared/updaterQa';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { APP_DISPLAY_NAME } from '../shared/appProfile';

import AppErrorBoundary from './components/AppErrorBoundary';
import { ConfigProvider } from './config/ConfigProvider';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { FloatingI18nBootstrap } from './i18n/FloatingI18nBootstrap';
import { I18nLanguageSync } from './i18n/I18nLanguageSync';
import {
  ConfiguredThemeRuntime,
  FloatingThemeRuntime,
  primeThemeRuntimeFromBootstrap,
} from './theme';
import { initFrontendLogger, setLogServerReady, setRendererLogLabel } from './utils/frontendLogger';
import { installMacFunctionKeyGuard } from './utils/macFunctionKeyGuard';
import { installTextCorrectionPolicy } from './utils/textCorrectionPolicy';
import { initializeAppZoom } from './utils/appZoom';
import { dispatchNativeHistoryCommand, type NativeHistoryCommand } from './utils/nativeHistoryCommands';
import { listenWithCleanup } from './utils/tauriListen';

import './i18n';
import './index.css';

let tauriWindowLabel: string | undefined;
document.title = APP_DISPLAY_NAME;
try {
  tauriWindowLabel = getCurrentWebviewWindow().label;
} catch {
  tauriWindowLabel = undefined; // browser dev mode — no Tauri runtime
}

function describeBootError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function reportBootEvent(stage: string, detail?: string): void {
  try {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: { invoke?: (command: string, payload: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== 'function') return;
    void Promise.resolve(internals.invoke('cmd_record_renderer_boot_event', {
      stage,
      windowLabel: tauriWindowLabel ?? 'browser',
      detail,
    })).catch(() => {});
  } catch {
    // Boot diagnostics are observational and must never become startup state.
  }
}

// Initialize frontend logger to capture React console logs
setRendererLogLabel(tauriWindowLabel);
initFrontendLogger();
reportBootEvent('renderer-entry-evaluated');

// Optional Theme packages are inline-only and validated before activation.
// Prime the validated bootstrap snapshot before React's first paint. A broken
// snapshot/package is diagnostic, not permission to strand the window blank.
try {
  primeThemeRuntimeFromBootstrap();
  reportBootEvent('theme-renderer-bootstrap-complete');
} catch (error) {
  reportBootEvent('theme-renderer-bootstrap-failed', describeBootError(error));
}

// Block macOS WKWebView's NSEvent function-key tofu leak globally —
// see utils/macFunctionKeyGuard.ts. Must run before React mounts so the
// document-level capture handler is attached when the first input fires.
installMacFunctionKeyGuard();
installTextCorrectionPolicy();

// Window-lifetime native menu bridge, shared by main and companion editors.
// Rust sends only to the focused window; each editor still owns its history.
if (tauriWindowLabel && navigator.platform.toLowerCase().includes('mac')) {
  const historyEvents = new AbortController();
  void listenWithCleanup<NativeHistoryCommand>('window:history-command', event => {
    dispatchNativeHistoryCommand(event.payload);
  }, historyEvents.signal, { target: { kind: 'Webview', label: tauriWindowLabel } });
  const cleanupHistoryEvents = () => {
    historyEvents.abort();
    window.removeEventListener('pagehide', cleanupHistoryEvents);
  };
  window.addEventListener('pagehide', cleanupHistoryEvents, { once: true });
  import.meta.hot?.dispose(cleanupHistoryEvents);
}

// Block native "Reload / Inspect Element" context menu in production.
// Keep native menu for: input fields, text selection, contenteditable, links, images, media.
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'IMG'
      || tag === 'VIDEO' || tag === 'AUDIO' || el.isContentEditable) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}

const root = createRoot(document.getElementById('root')!);
reportBootEvent('react-root-created');

function BootCommitMarker() {
  React.useEffect(() => {
    reportBootEvent('react-commit');
  }, []);
  return null;
}

function bootstrapFloatingWindowLogSink(label: string): void {
  console.info(`[${label}] window boot`);
  void import('./api/tauriClient')
    .then(async ({ waitForGlobalSidecar }) => {
      void import('./utils/tauriListen')
        .then(({ listenWithCleanup }) => {
          const ac = new AbortController();
          void listenWithCleanup<string>('global-sidecar:restarted', () => {
            setLogServerReady();
            console.info(`[${label}] unified log sink rebound after global restart`);
          }, ac.signal);
        })
        .catch((err) => {
          console.warn(`[${label}] global sidecar restart listener unavailable:`, err);
        });
      await waitForGlobalSidecar();
      setLogServerReady();
      console.info(`[${label}] unified log sink ready`);
    })
    .catch((err) => {
      console.warn(`[${label}] unified log sink unavailable:`, err);
    });
}

// Floating ball windows (PRD 0.2.35): the ball + companion are separate Tauri
// WebviewWindows loading this same bundle. Route by window label — they mount
// their own minimal trees (no App / ConfigProvider; they read config via the
// service layer directly). App itself is lazy so the two tiny fb windows never
// parse/execute the multi-MB main-app chunk (and the main window pays only a
// microtask + local chunk fetch).

if (tauriWindowLabel === 'fb-ball') {
  setRendererLogLabel('fb-ball');
  bootstrapFloatingWindowLogSink('fb-ball');
  const BallWindow = React.lazy(() => import('./floating-ball/BallWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <BootCommitMarker />
      <FloatingThemeRuntime>
        <FloatingI18nBootstrap>
          <React.Suspense fallback={null}>
            <BallWindow />
          </React.Suspense>
        </FloatingI18nBootstrap>
      </FloatingThemeRuntime>
    </AppErrorBoundary>
  );
} else if (tauriWindowLabel === 'fb-companion') {
  setRendererLogLabel('fb-companion');
  bootstrapFloatingWindowLogSink('fb-companion');
  const CompanionWindow = React.lazy(() => import('./floating-ball/CompanionWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <BootCommitMarker />
      <FloatingThemeRuntime>
        <FloatingI18nBootstrap>
          <ToastProvider>
            <ImagePreviewProvider>
              <React.Suspense fallback={null}>
                <CompanionWindow />
              </React.Suspense>
            </ImagePreviewProvider>
          </ToastProvider>
        </FloatingI18nBootstrap>
      </FloatingThemeRuntime>
    </AppErrorBoundary>
  );
} else if (tauriWindowLabel === 'fb-shield') {
  setRendererLogLabel('fb-shield');
  const ShieldWindow = React.lazy(() => import('./floating-ball/ShieldWindow'));
  document.documentElement.classList.add('fb-transparent');
  root.render(
    <AppErrorBoundary>
      <BootCommitMarker />
      <FloatingThemeRuntime>
        <React.Suspense fallback={null}>
          <ShieldWindow />
        </React.Suspense>
      </FloatingThemeRuntime>
    </AppErrorBoundary>
  );
} else {
  initializeAppZoom();
  const surface = new URLSearchParams(location.search).get('surface');
  const App = React.lazy(async () => {
    if (isModelQaBuild()) {
      if (surface !== 'app') {
        await (await import('./api/tauriClient')).startGlobalSidecar();
      }
      if (surface === 'next-prompt') return import('./pages/ModelQaNextPrompt');
      if (surface === 'title-utility') return import('./pages/ModelQaTitle');
      if (surface !== 'app') return import('./pages/ModelQaHome');
    }
    return import('./App');
  });
  // Note: React.StrictMode removed to prevent double-rendering of SSE effects in development
  // StrictMode causes useEffect to run twice, which duplicates SSE events and thinking blocks
  root.render(
    <AppErrorBoundary>
      <BootCommitMarker />
      <ConfigProvider>
        <ConfiguredThemeRuntime>
          <I18nLanguageSync />
          <ToastProvider>
            <ImagePreviewProvider>
              <React.Suspense fallback={null}>
                <App />
              </React.Suspense>
              {isModelQaBuild() && <nav aria-label="独立验收导航" className="fixed bottom-2 right-2 z-[9999] flex gap-3 rounded border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-xs text-[var(--ink)]">
                <a href="?">验收首页</a>
                <a href="?surface=next-prompt">建议</a>
                <a href="?surface=title-utility">标题</a>
                <a href="?surface=app">隔离客户端</a>
              </nav>}
            </ImagePreviewProvider>
          </ToastProvider>
        </ConfiguredThemeRuntime>
      </ConfigProvider>
    </AppErrorBoundary>
  );
}
