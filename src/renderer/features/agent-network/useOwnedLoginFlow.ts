import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OwnedLoginAttempt } from "@/api/agentNetwork";

type Phase =
  | "idle"
  | "starting"
  | "opening"
  | "waiting"
  | "checking"
  | "cancelling"
  | "expired"
  | "stopped";
export interface OwnedLoginActions {
  onOwnedStart: (issuer: string, ca?: string) => Promise<OwnedLoginAttempt>;
  onOwnedOpen: (id: string) => Promise<void>;
  onOwnedPoll: (
    id: string,
  ) => Promise<"pending" | "authenticated" | OwnedLoginAttempt>;
  onOwnedCancel: (id: string) => Promise<void>;
  onCancel: () => void;
}
const POLL_DELAY = 2000;

/** Presentation lifecycle only. The existing Rust owner validates and saves login. */
export function useOwnedLoginFlow(actions: OwnedLoginActions) {
  const { t } = useTranslation("app");
  const [attempt, setAttempt] = useState<OwnedLoginAttempt | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ ...actions, t });
  const alive = useRef(false);
  const epoch = useRef(0);
  const current = useRef<OwnedLoginAttempt | null>(null);
  const flight = useRef(false);
  const cancelled = useRef(false);
  const cancelling = useRef(false);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkRef = useRef<() => Promise<void>>(async () => {});
  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current);
    if (expiry.current) clearTimeout(expiry.current);
    timer.current = expiry.current = null;
  };
  const isCurrent = (generation: number) =>
    alive.current && epoch.current === generation && !cancelled.current;
  const failureText = (failure: unknown) =>
    failure instanceof Error
      ? failure.message
      : latest.current.t("agentNetwork.errors.failed");
  const expired = () =>
    !current.current || current.current.expiresAt * 1000 <= Date.now();
  const markExpired = () => {
    clearTimers();
    setPhase("expired");
    setError(null);
    setBrowserError(null);
    setNotice(latest.current.t("agentNetwork.ownedLogin.expired"));
  };
  const armExpiry = () => {
    if (expiry.current) clearTimeout(expiry.current);
    const generation = epoch.current;
    expiry.current = setTimeout(
      () => {
        if (isCurrent(generation)) {
          if (expired()) markExpired();
          else armExpiry();
        }
      },
      Math.min(
        2_147_000_000,
        Math.max(0, (current.current?.expiresAt ?? 0) * 1000 - Date.now()),
      ),
    );
  };
  const schedule = (delay = POLL_DELAY) => {
    if (timer.current) clearTimeout(timer.current);
    if (!alive.current || cancelled.current || !current.current) return;
    if (expired()) {
      markExpired();
      return;
    }
    timer.current = setTimeout(() => {
      void checkRef.current();
    }, delay);
  };
  const open = async (generation = epoch.current) => {
    const active = current.current;
    if (!active || !isCurrent(generation)) return;
    setPhase("opening");
    try {
      await latest.current.onOwnedOpen(active.attemptId);
      if (isCurrent(generation)) {
        setBrowserError(null);
        setNotice(latest.current.t("agentNetwork.ownedLogin.browserOpened"));
      }
    } catch (failure) {
      if (isCurrent(generation))
        setBrowserError(
          latest.current.t("agentNetwork.ownedLogin.browserFailed", {
            message: failureText(failure),
          }),
        );
    }
  };
  async function check() {
    if (flight.current || cancelled.current || !current.current) return;
    if (expired()) {
      markExpired();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    flight.current = true;
    const generation = epoch.current;
    const active = current.current;
    setPhase("checking");
    setPolling(true);
    try {
      const result = await latest.current.onOwnedPoll(active.attemptId);
      if (!isCurrent(generation)) return;
      failures.current = 0;
      setError(null);
      if (result === "authenticated") {
        current.current = null;
        clearTimers();
        setAttempt(null);
        setPhase("idle");
        latest.current.onCancel();
        return;
      }
      if (typeof result === "object") {
        // The Rust owner may require confirmation of an existing device identity.
        // It supplies the next authorization; never create a separate login here.
        const changed =
          result.authorizationUrl !== active.authorizationUrl ||
          result.attemptId !== active.attemptId;
        current.current = result;
        setAttempt(result);
        armExpiry();
        if (changed) await open(generation);
        if (isCurrent(generation))
          setNotice(
            latest.current.t("agentNetwork.ownedLogin.restoreIdentity"),
          );
      } else setNotice(latest.current.t("agentNetwork.ownedLogin.pending"));
    } catch (failure) {
      if (isCurrent(generation)) {
        failures.current += 1;
        setError(
          latest.current.t("agentNetwork.ownedLogin.checkFailed", {
            message: failureText(failure),
          }),
        );
      }
    } finally {
      if (isCurrent(generation)) {
        flight.current = false;
        setPolling(false);
        if (current.current) {
          if (!expired()) setPhase("waiting");
          schedule(
            Math.min(15_000, POLL_DELAY * 2 ** Math.min(failures.current, 3)),
          );
        }
      }
    }
  }
  async function start(issuer: string, ca?: string) {
    if (flight.current || !issuer.trim()) return;
    const generation = ++epoch.current;
    cancelled.current = false;
    failures.current = 0;
    flight.current = true;
    clearTimers();
    current.current = null;
    setAttempt(null);
    setPhase("starting");
    setError(null);
    setBrowserError(null);
    setNotice(null);
    try {
      const started = await latest.current.onOwnedStart(
        issuer.trim(),
        ca?.trim() || undefined,
      );
      if (!isCurrent(generation)) {
        // A start can finish after unmount. Do not leave its new attempt alive.
        await latest.current.onOwnedCancel(started.attemptId).catch(() => {});
        return;
      }
      current.current = started;
      setAttempt(started);
      armExpiry();
      await open(generation);
    } catch (failure) {
      if (isCurrent(generation)) {
        setError(failureText(failure));
        setPhase("idle");
      }
    } finally {
      if (isCurrent(generation)) {
        flight.current = false;
        if (current.current) {
          if (!expired()) setPhase("waiting");
          schedule();
        }
      }
    }
  }
  async function reopen() {
    if (flight.current || cancelled.current || !current.current || expired())
      return;
    flight.current = true;
    const generation = epoch.current;
    setError(null);
    try {
      await open(generation);
    } finally {
      if (isCurrent(generation)) {
        flight.current = false;
        if (!expired()) setPhase("waiting");
        schedule();
      }
    }
  }
  async function cancel() {
    if (cancelling.current) return;
    cancelling.current = true;
    // Cancel stays available while a background poll is in flight. The callback
    // invalidates the existing login owner's generation before awaiting native IO.
    cancelled.current = true;
    ++epoch.current;
    clearTimers();
    setPhase("cancelling");
    setPolling(false);
    setError(null);
    setBrowserError(null);
    setNotice(null);
    try {
      if (current.current)
        await latest.current.onOwnedCancel(current.current.attemptId);
      if (alive.current) latest.current.onCancel();
    } catch (failure) {
      if (alive.current) {
        setError(
          latest.current.t("agentNetwork.ownedLogin.cancelFailed", {
            message: failureText(failure),
          }),
        );
        setPhase("stopped");
      }
    } finally {
      cancelling.current = false;
    }
  }
  useLayoutEffect(() => {
    latest.current = { ...actions, t };
    checkRef.current = check;
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current += 1;
      clearTimers();
    };
  }, []);
  useEffect(() => {
    const focus = () => {
      if (current.current && !cancelled.current) void checkRef.current();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  return {
    attempt,
    phase,
    error: browserError ?? error,
    notice,
    start,
    reopen,
    check,
    cancel,
    busy: phase === "starting" || phase === "opening" || phase === "cancelling",
    checking: polling,
    expired: phase === "expired",
    stopped: phase === "stopped",
  };
}
