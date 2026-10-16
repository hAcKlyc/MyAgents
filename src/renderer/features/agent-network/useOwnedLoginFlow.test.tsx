import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOwnedLoginFlow, type OwnedLoginActions } from "./useOwnedLoginFlow";
import type { OwnedLoginAttempt } from "@/api/agentNetwork";
const attempt: OwnedLoginAttempt = {
  attemptId: "attempt-1",
  authorizationUrl: "https://cloud.test/authorize?state=synthetic",
  expiresAt: 1800000120,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup(overrides: Partial<OwnedLoginActions> = {}) {
  const actions = {
    onOwnedStart: vi.fn().mockResolvedValue(attempt),
    onOwnedOpen: vi.fn().mockResolvedValue(undefined),
    onOwnedPoll: vi.fn().mockResolvedValue("pending"),
    onOwnedCancel: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...renderHook(() => useOwnedLoginFlow(actions)), actions };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const tick = async (ms = 2000) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
it("opens the browser once, polls automatically and closes on authenticated without manual checking", async () => {
  const poll = vi
    .fn()
    .mockResolvedValueOnce("pending")
    .mockResolvedValueOnce("authenticated");
  const { result, actions } = setup({ onOwnedPoll: poll });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  expect(actions.onOwnedOpen).toHaveBeenCalledExactlyOnceWith("attempt-1");
  await tick();
  expect(poll).toHaveBeenCalledTimes(1);
  expect(actions.onCancel).not.toHaveBeenCalled();
  await tick();
  expect(actions.onCancel).toHaveBeenCalledOnce();
  await tick(10_000);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("shares one flight among background, focus and manual checks and keeps cancellation available", async () => {
  const pending = deferred<"authenticated">();
  const poll = vi.fn().mockReturnValue(pending.promise);
  const { result, actions } = setup({ onOwnedPoll: poll });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    void result.current.check();
  });
  await tick(10_000);
  expect(poll).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.cancel();
  });
  expect(actions.onOwnedCancel).toHaveBeenCalledExactlyOnceWith("attempt-1");
  expect(actions.onCancel).toHaveBeenCalledOnce();
  await act(async () => {
    pending.resolve("authenticated");
  });
  expect(actions.onCancel).toHaveBeenCalledOnce();
  await tick();
  expect(poll).toHaveBeenCalledTimes(1);
});
it("stops all automatic checks at expiry and permits a new login attempt", async () => {
  const short = { ...attempt, expiresAt: 1800000003 };
  const { result, actions } = setup({
    onOwnedStart: vi
      .fn()
      .mockResolvedValueOnce(short)
      .mockResolvedValue(attempt),
  });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick(3000);
  expect(result.current.expired).toBe(true);
  await tick(10_000);
  expect(actions.onOwnedPoll).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.check();
  });
  expect(actions.onOwnedPoll).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  expect(result.current.expired).toBe(false);
  expect(actions.onOwnedStart).toHaveBeenCalledTimes(2);
});
it("cleans up timers and ignores a late poll when the dialog unmounts", async () => {
  const pending = deferred<"authenticated">();
  const { result, actions, unmount } = setup({
    onOwnedPoll: vi.fn().mockReturnValue(pending.promise),
  });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick();
  unmount();
  await act(async () => {
    pending.resolve("authenticated");
  });
  await tick(10_000);
  expect(actions.onCancel).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels a start that completes after unmount instead of opening its browser", async () => {
  const started = deferred<OwnedLoginAttempt>();
  const { result, actions, unmount } = setup({
    onOwnedStart: vi.fn().mockReturnValue(started.promise),
  });
  let promise!: Promise<void>;
  act(() => {
    promise = result.current.start("https://cloud.test");
  });
  unmount();
  await act(async () => {
    started.resolve(attempt);
    await promise;
  });
  expect(actions.onOwnedOpen).not.toHaveBeenCalled();
  expect(actions.onOwnedCancel).toHaveBeenCalledWith("attempt-1");
});
it("reopens a changed authorization once, then continues checking the original attempt owner", async () => {
  const next = {
    ...attempt,
    authorizationUrl: "https://cloud.test/restore?state=next",
  };
  const poll = vi
    .fn()
    .mockResolvedValueOnce(next)
    .mockResolvedValueOnce(next)
    .mockResolvedValue("authenticated");
  const { result, actions } = setup({ onOwnedPoll: poll });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick();
  expect(actions.onOwnedOpen).toHaveBeenCalledTimes(2);
  expect(result.current.attempt?.authorizationUrl).toBe(next.authorizationUrl);
  await tick();
  expect(actions.onOwnedOpen).toHaveBeenCalledTimes(2);
  await tick();
  expect(actions.onCancel).toHaveBeenCalledOnce();
});
it("keeps browser-open failures visible and still allows a manual recovery", async () => {
  const open = vi
    .fn()
    .mockRejectedValueOnce(Error("no browser"))
    .mockResolvedValue(undefined);
  const { result, actions } = setup({ onOwnedOpen: open });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  expect(result.current.error).toContain("未能自动打开浏览器");
  await tick();
  expect(result.current.error).toContain("未能自动打开浏览器");
  await act(async () => {
    await result.current.reopen();
  });
  expect(result.current.error).toBeNull();
  expect(open).toHaveBeenCalledTimes(2);
  await act(async () => {
    await result.current.check();
  });
  expect(actions.onOwnedPoll).toHaveBeenCalledTimes(2);
});
it("backs off failed checks and recovers without asking the user to click check", async () => {
  const poll = vi
    .fn()
    .mockRejectedValueOnce(Error("offline"))
    .mockResolvedValueOnce("authenticated");
  const { result, actions } = setup({ onOwnedPoll: poll });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick();
  expect(result.current.error).toContain("将自动重试");
  await tick();
  expect(poll).toHaveBeenCalledTimes(1);
  await tick();
  expect(actions.onCancel).toHaveBeenCalledOnce();
});
it("pauses after an unconfirmed cancellation, prevents duplicate cancellation and permits retry", async () => {
  const pending = deferred<void>();
  const cancel = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(undefined);
  const { result, actions } = setup({ onOwnedCancel: cancel });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  let first!: Promise<void>;
  act(() => {
    first = result.current.cancel();
    void result.current.cancel();
  });
  expect(cancel).toHaveBeenCalledOnce();
  await act(async () => {
    pending.resolve();
    await first;
  });
  expect(actions.onCancel).toHaveBeenCalledOnce();
});
it("keeps automatic checking stopped when cancellation fails", async () => {
  const cancel = vi
    .fn()
    .mockRejectedValueOnce(Error("cancel unavailable"))
    .mockResolvedValue(undefined);
  const { result, actions } = setup({ onOwnedCancel: cancel });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await act(async () => {
    await result.current.cancel();
  });
  expect(result.current.stopped).toBe(true);
  await tick(10_000);
  expect(actions.onOwnedPoll).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.cancel();
  });
  expect(actions.onCancel).toHaveBeenCalledOnce();
});
it("does not expire a valid far-future deadline through timer integer overflow", async () => {
  const { result, actions } = setup({
    onOwnedStart: vi
      .fn()
      .mockResolvedValue({ ...attempt, expiresAt: 1900000000 }),
  });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick(1000);
  expect(result.current.expired).toBe(false);
  expect(actions.onOwnedPoll).not.toHaveBeenCalled();
});
it("stops after expiry while a poll is still in flight", async () => {
  const pending = deferred<"pending">();
  const poll = vi.fn().mockReturnValue(pending.promise);
  const { result } = setup({
    onOwnedStart: vi
      .fn()
      .mockResolvedValue({ ...attempt, expiresAt: 1800000003 }),
    onOwnedPoll: poll,
  });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick(3000);
  expect(result.current.expired).toBe(true);
  expect(result.current.checking).toBe(true);
  await act(async () => {
    pending.resolve("pending");
  });
  expect(result.current.checking).toBe(false);
  await tick(10_000);
  expect(poll).toHaveBeenCalledTimes(1);
});
it("uses committed latest callbacks without restarting the polling clock on parent rerenders", async () => {
  const initial = {
    onOwnedStart: vi.fn().mockResolvedValue(attempt),
    onOwnedOpen: vi.fn().mockResolvedValue(undefined),
    onOwnedPoll: vi.fn().mockResolvedValue("pending" as const),
    onOwnedCancel: vi.fn(),
    onCancel: vi.fn(),
  };
  const { result, rerender } = renderHook(
    ({ actions }) => useOwnedLoginFlow(actions),
    { initialProps: { actions: initial } },
  );
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick(1000);
  const changed = {
    ...initial,
    onOwnedPoll: vi.fn().mockResolvedValue("authenticated" as const),
  };
  rerender({ actions: changed });
  await tick(1000);
  expect(changed.onOwnedPoll).toHaveBeenCalledOnce();
  expect(initial.onOwnedPoll).not.toHaveBeenCalled();
});

it("keeps one browser launch and one polling loop under StrictMode lifecycle replay", async () => {
  const actions = {
    onOwnedStart: vi.fn().mockResolvedValue(attempt),
    onOwnedOpen: vi.fn().mockResolvedValue(undefined),
    onOwnedPoll: vi.fn().mockResolvedValue("authenticated" as const),
    onOwnedCancel: vi.fn(),
    onCancel: vi.fn(),
  };
  const { result } = renderHook(() => useOwnedLoginFlow(actions), {
    wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
  });
  await act(async () => {
    await result.current.start("https://cloud.test");
  });
  await tick();
  expect(actions.onOwnedOpen).toHaveBeenCalledOnce();
  expect(actions.onOwnedPoll).toHaveBeenCalledOnce();
  expect(actions.onCancel).toHaveBeenCalledOnce();
});
