import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdater } from "./useUpdater";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  relaunch: vi.fn(),
  handlers: new Map<
    string,
    (event: { payload: { version: string } }) => void
  >(),
}));
vi.mock("../../shared/appProfile", () => ({ APP_BUILD_PROFILE: "moxbot" }));
vi.mock("@/identity/deviceIdentity", () => ({
  getPlatform: () => "darwin-aarch64",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.5.2"),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@/utils/tauriListen", () => ({ listenWithCleanup: mocks.listen }));
vi.mock("@/utils/browserMock", () => ({ isTauriEnvironment: () => true }));
vi.mock("@/utils/debug", () => ({ isDebugMode: () => false }));
vi.mock("@/analytics", () => ({ track: vi.fn() }));
vi.mock("@/i18n", () => ({ i18n: { t: (key: string) => key } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  mocks.handlers.clear();
  mocks.invoke.mockReset().mockResolvedValue(null);
  mocks.listen.mockImplementation(
    (
      name: string,
      callback: (event: { payload: { version: string } }) => void,
    ) => {
      mocks.handlers.set(name, callback);
      return Promise.resolve();
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("MoxBots downloads in the background but never installs when an update becomes ready", async () => {
  const { result, unmount } = renderHook(() => useUpdater());
  await act(async () => {
    mocks.handlers.get("updater:ready-to-restart")!({
      payload: { version: "0.5.3" },
    });
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
  });
  expect(result.current.updateReady).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledWith("check_and_download_update");
  expect(mocks.invoke).not.toHaveBeenCalledWith("install_pending_update");
  expect(mocks.relaunch).not.toHaveBeenCalled();
  unmount();
});

it.each([
  ["UPDATE_BUSY: task", "busy"],
  ["UPDATE_ACTIVITY_UNKNOWN: owner", "activity-unknown"],
])(
  "retains the downloaded update after %s without scheduling an automatic restart",
  async (error, expected) => {
    const { result, unmount } = renderHook(() => useUpdater());
    await act(async () => {
      mocks.handlers.get("updater:ready-to-restart")!({
        payload: { version: "0.5.3" },
      });
    });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "install_pending_update") throw error;
      return null;
    });
    await act(async () => {
      expect(await result.current.restartAndUpdate()).toBe(expected);
    });
    expect(result.current.installing).toBe(false);
    expect(result.current.updateReady).toBe(true);
    expect(result.current.updateVersion).toBe("0.5.3");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    });
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "install_pending_update",
      ),
    ).toHaveLength(1);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    unmount();
  },
);

it("rejects a corrupted pending package and requires a new verified download", async () => {
  const { result, unmount } = renderHook(() => useUpdater());
  await act(async () => {
    mocks.handlers.get("updater:ready-to-restart")!({
      payload: { version: "0.5.3" },
    });
  });
  mocks.invoke.mockImplementation(async () => {
    throw "UPDATE_SIGNATURE_INVALID";
  });
  await act(async () => {
    expect(await result.current.restartAndUpdate()).toBe("signature-error");
  });
  expect(result.current.updateReady).toBe(false);
  expect(result.current.updateVersion).toBeNull();
  expect(mocks.relaunch).not.toHaveBeenCalled();
  unmount();
});


it('clears a failed background download spinner so a manual retry reaches Rust', async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === 'test_update_connectivity' ? 'version: 0.5.3' : false);
  const { result, unmount } = renderHook(() => useUpdater());
  await act(async () => { expect(await result.current.checkForUpdate()).toBe('downloading'); });
  expect(result.current.downloading).toBe(true);
  await act(async () => { mocks.handlers.get('updater:download-failed')!({ payload: { version: '0.5.3' } }); });
  expect(result.current.downloading).toBe(false);
  await act(async () => { await result.current.checkForUpdate(); });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'test_update_connectivity')).toHaveLength(2);
  unmount();
});


it('allows re-downloading after a background handoff became ready but the saved signature was invalid', async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === 'test_update_connectivity' ? 'version: 0.5.3' : false);
  const { result, unmount } = renderHook(() => useUpdater());
  await act(async () => { await result.current.checkForUpdate(); });
  await act(async () => { mocks.handlers.get('updater:ready-to-restart')!({ payload: { version: '0.5.3' } }); });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'install_pending_update') throw 'UPDATE_SIGNATURE_INVALID';
    return command === 'test_update_connectivity' ? 'version: 0.5.3' : false;
  });
  await act(async () => { expect(await result.current.restartAndUpdate()).toBe('signature-error'); });
  await act(async () => { await result.current.checkForUpdate(); });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === 'test_update_connectivity')).toHaveLength(2);
  unmount();
});
