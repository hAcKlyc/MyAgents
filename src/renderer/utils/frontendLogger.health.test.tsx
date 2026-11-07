import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  clearFrontendLogs, initFrontendLogger, restoreFrontendLogger,
  setAppActiveTabId, setCurrentTabId, setRendererLogLabel, snapshotFrontendLogs,
} from './frontendLogger';

vi.mock('./browserMock', () => ({ isTauriEnvironment: () => false }));

function samples() {
  return snapshotFrontendLogs().filter(entry => entry.message.includes('[renderer-health]'));
}

beforeEach(() => {
  vi.useFakeTimers();
  clearFrontendLogs();
  setAppActiveTabId(null);
  setRendererLogLabel('main');
});

afterEach(() => {
  restoreFrontendLogger();
  setCurrentTabId('private-tab', false);
  setAppActiveTabId(null);
  setRendererLogLabel(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('records changing counts through the existing log store without retaining payloads or duplicating timers', () => {
  const callbacks = new Map([[1, { secret: 'private callback payload' }]]);
  vi.stubGlobal('__TAURI_INTERNALS__', { callbacks });
  setAppActiveTabId('private-tab', ['private-tab']);
  setCurrentTabId('private-tab');
  initFrontendLogger();
  initFrontendLogger();
  expect(samples()).toHaveLength(1);
  const first = JSON.parse(samples()[0].message.split('[renderer-health] ')[1]);
  expect(first).toMatchObject({ appTabs: 1, mountedChats: 1, tauriCallbacks: 1 });
  expect(Object.values(first).every(value => value === null || typeof value !== 'object')).toBe(true);
  expect(samples()[0].message).not.toContain('private');

  callbacks.clear();
  setCurrentTabId('private-tab', false);
  vi.advanceTimersByTime(5 * 60_000);
  expect(samples()).toHaveLength(2);
  const second = JSON.parse(samples()[1].message.split('[renderer-health] ')[1]);
  expect(second).toMatchObject({ mountedChats: 0, tauriCallbacks: 0 });
  restoreFrontendLogger();
  vi.advanceTimersByTime(10 * 60_000);
  expect(samples()).toHaveLength(2);
});

it('omits unavailable callback telemetry and does not sample companion or browser development windows', () => {
  initFrontendLogger();
  expect(JSON.parse(samples()[0].message.split('[renderer-health] ')[1]).tauriCallbacks).toBeNull();
  restoreFrontendLogger();
  clearFrontendLogs();
  for (const label of ['fb-companion', undefined]) {
    setRendererLogLabel(label);
    initFrontendLogger();
    vi.advanceTimersByTime(10 * 60_000);
    restoreFrontendLogger();
  }
  expect(samples()).toHaveLength(0);
});

it('contains telemetry failures while ordinary logging continues', () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {
    get callbacks() { throw new Error('unavailable telemetry'); },
  });
  expect(() => initFrontendLogger()).not.toThrow();
  expect(() => vi.advanceTimersByTime(10 * 60_000)).not.toThrow();
  expect(samples()).toHaveLength(0);
  console.log('ordinary log still works');
  expect(snapshotFrontendLogs().some(entry => entry.message.includes('ordinary log still works'))).toBe(true);
});
