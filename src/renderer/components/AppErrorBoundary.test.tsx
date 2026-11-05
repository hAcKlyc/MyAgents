import { lazy, Suspense } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AppErrorBoundary from './AppErrorBoundary';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shows and persists a native startup rejection before the App log sink exists', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('__TAURI_INTERNALS__', {
    invoke,
    metadata: { currentWebview: { label: 'main' } },
  });
  const rejected = 'current webview is not a WebviewWindow';
  const App = lazy(() => Promise.reject(rejected));
  render(<AppErrorBoundary><Suspense fallback={null}><App /></Suspense></AppErrorBoundary>);
  expect(await screen.findByText(rejected)).toBeInTheDocument();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('cmd_record_renderer_boot_event', {
    stage: 'renderer-react-error',
    windowLabel: 'main',
    detail: expect.stringContaining(rejected),
  }));
});

it('keeps the recovery UI usable when native diagnostics are unavailable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn().mockRejectedValue('unavailable') });
  const App = lazy(() => Promise.reject(new Error('render failed')));
  render(<AppErrorBoundary><Suspense fallback={null}><App /></Suspense></AppErrorBoundary>);
  expect(await screen.findByText('render failed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
});
