import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { hostLocatorKey, type HostLocator } from "@/api/hostManagement";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  ownedHostErrorCode,
  ownedHostManagement,
  sameOwnedHostScope,
  type OwnedHostOperation,
  type OwnedHostOwner,
  type OwnedHostResponse,
  type OwnedHostScope,
} from "@/api/ownedHostManagement";

type Pending = {
  locatorKey: string;
  owner: OwnedHostOwner;
  mutationId: string;
  scope: OwnedHostScope;
};
// Only original receipt identities survive closing the detail panel. Secrets
// and mutation bodies are never kept in this presentation state.
const pendingReceipts = new Map<string, Pending>();
function receiptKey(locatorKey: string, scope: OwnedHostScope): string {
  return JSON.stringify([
    locatorKey,
    scope.serviceId,
    scope.environment,
    scope.principalId,
    scope.networkId,
    scope.deviceId,
    scope.keyGeneration,
  ]);
}
const inputClass =
  "w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
const buttonClass =
  "rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";

export function OwnedHostManagement({
  locator,
  online,
}: {
  locator: HostLocator;
  online: boolean;
}) {
  const { t } = useTranslation("app");
  const key = hostLocatorKey(locator);
  const { connectionId, principalId, networkId, deviceId, authGeneration } =
    locator;
  const [response, setResponse] = useState<{
    key: string;
    value: OwnedHostResponse;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [model, setModel] = useState("");
  const [credential, setCredential] = useState("");
  const [path, setPath] = useState("");
  const [execution, setExecution] = useState(false);
  const [pending, setPending] = useState<Pending | undefined>();
  const lastScope = useRef<OwnedHostScope | null>(null);
  const lifetime = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(false);
  const value = response?.key === key ? response.value : null;
  const snapshot = value?.result.kind === "snapshot" ? value.result : null;
  const disabled =
    !online || !snapshot || snapshot.stopping || busy || !!pending;
  useEffect(() => {
    alive.current = true;
    lifetime.current++;
    const generation = lifetime.current;
    const abort = new AbortController();
    if (online) {
      void ownedHostManagement(
        { connectionId, principalId, networkId, deviceId, authGeneration },
        null,
        { method: "host.snapshot", params: {} },
        abort.signal,
      ).then(
        (result) => {
          if (abort.signal.aborted || lifetime.current !== generation) return;
          const changed =
            lastScope.current &&
            !sameOwnedHostScope(lastScope.current, result.scope);
          const unresolvedOtherIdentity = [...pendingReceipts.values()].some(
            (item) =>
              item.locatorKey === key &&
              !sameOwnedHostScope(item.scope, result.scope),
          );
          if (changed || unresolvedOtherIdentity)
            setNotice(t("agentNetwork.ownedHost.identityChanged"));
          lastScope.current = result.scope;
          setCredential("");
          setPending(pendingReceipts.get(receiptKey(key, result.scope)));
          setResponse({ key, value: result });
          if (result.result.kind === "snapshot") {
            setModel(result.result.settings?.model ?? "kimi-for-coding");
            setExecution(result.result.settings?.executionAuthorized ?? false);
          }
        },
        (error) => {
          if (abort.signal.aborted || lifetime.current !== generation) return;
          setResponse(null);
          setNotice(
            t("agentNetwork.ownedHost.failed", {
              code: ownedHostErrorCode(error),
            }),
          );
        },
      );
    }
    return () => {
      alive.current = false;
      lifetime.current = generation + 1;
      abort.abort();
    };
  }, [
    connectionId,
    principalId,
    networkId,
    deviceId,
    authGeneration,
    key,
    online,
    refresh,
    t,
  ]);

  async function submit(
    operation: OwnedHostOperation,
    owner: OwnedHostOwner,
    recovering = false,
  ) {
    if (
      inFlight.current ||
      !online ||
      !value ||
      !snapshot ||
      snapshot.stopping ||
      (!recovering && pending)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    const generation = lifetime.current;
    const identity = recovering
      ? pending
      : "mutationId" in operation.params
        ? {
            locatorKey: key,
            owner,
            mutationId: operation.params.mutationId,
            scope: value.scope,
          }
        : undefined;
    if (!identity) {
      inFlight.current = false;
      setBusy(false);
      return;
    }
    const identityKey = receiptKey(key, identity.scope);
    if (!pendingReceipts.has(identityKey) && pendingReceipts.size >= 64) {
      inFlight.current = false;
      setBusy(false);
      setNotice(
        t("agentNetwork.ownedHost.failed", {
          code: "HOST_MANAGEMENT_CAPACITY",
        }),
      );
      return;
    }
    pendingReceipts.set(identityKey, identity);
    setPending(identity);
    const current = () => alive.current && lifetime.current === generation;
    try {
      const result = await ownedHostManagement(
        locator,
        identity.scope,
        operation,
        new AbortController().signal,
      );
      if (!current()) return;
      if (
        result.result.kind === "receipt-not-found" ||
        ("status" in result.result &&
          (result.result.status === "pending" ||
            result.result.status === "not-found"))
      ) {
        setNotice(t("agentNetwork.ownedHost.unknown"));
        return;
      }
      if (!("status" in result.result))
        throw { code: "HOST_MANAGEMENT_RESPONSE_INVALID" };
      pendingReceipts.delete(identityKey);
      setPending(undefined);
      setNotice(
        t(
          result.result.status === "conflict"
            ? "agentNetwork.ownedHost.conflict"
            : "agentNetwork.ownedHost.saved",
        ),
      );
      setRefresh((count) => count + 1);
    } catch (error) {
      if (!current()) return;
      const code = ownedHostErrorCode(error);
      if (
        !recovering &&
        !["HOST_MANAGEMENT_UNCONFIRMED", "RESOURCE_UNCONFIRMED"].includes(code)
      ) {
        pendingReceipts.delete(identityKey);
        setPending(undefined);
      }
      setNotice(
        t(
          code === "HOST_MANAGEMENT_UNCONFIRMED" ||
            code === "RESOURCE_UNCONFIRMED"
            ? "agentNetwork.ownedHost.unknown"
            : "agentNetwork.ownedHost.failed",
          { code },
        ),
      );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
      if (current()) setCredential("");
    }
  }
  return (
    <section
      className="mb-4 space-y-3 rounded-xl border border-[var(--line)] p-4"
      aria-label={t("agentNetwork.ownedHost.title")}
      onKeyDown={(event) => {
        if (event.key === "Enter" && isImeComposingEvent(event))
          event.preventDefault();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          {t("agentNetwork.ownedHost.title")}
        </h3>
        <button
          type="button"
          className={buttonClass}
          disabled={!online || busy}
          onClick={() => setRefresh((count) => count + 1)}
        >
          {t("agentNetwork.ownedHost.refresh")}
        </button>
      </div>
      {!online && (
        <p role="status" className="text-sm text-[var(--ink-muted)]">
          {t("agentNetwork.ownedHost.offline")}
        </p>
      )}
      {online && !snapshot && !notice && (
        <p role="status" className="text-sm text-[var(--ink-muted)]">
          {t("agentNetwork.ownedHost.loading")}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="break-words text-sm text-[var(--ink-secondary)]"
        >
          {notice}
        </p>
      )}
      {pending && (
        <button
          type="button"
          disabled={!online || !snapshot || busy}
          className={buttonClass}
          onClick={() =>
            void submit(
              {
                method: "receipt.get",
                params: {
                  owner: pending.owner,
                  mutationId: pending.mutationId,
                },
              },
              pending.owner,
              true,
            )
          }
        >
          {t("agentNetwork.ownedHost.checkReceipt")}
        </button>
      )}
      {snapshot && (
        <>
          <p className="text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.ownedHost.effect")}
          </p>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || snapshot.activeSession || !model.trim()) return;
              void submit(
                {
                  method: "config.set",
                  params: {
                    providerId: "moonshot-coding",
                    model: model.trim(),
                    executionAuthorized: execution,
                    expectedRevision: snapshot.settings?.revision ?? 0,
                    mutationId: crypto.randomUUID(),
                  },
                },
                "config",
              );
            }}
          >
            <label className="block space-y-1 text-sm text-[var(--ink)]">
              <span>{t("agentNetwork.ownedHost.model")}</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                maxLength={160}
                disabled={disabled || !!snapshot.activeSession}
                className={inputClass}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                checked={execution}
                disabled={disabled || !!snapshot.activeSession}
                onChange={(event) => setExecution(event.target.checked)}
              />
              {t("agentNetwork.ownedHost.execution")}
            </label>
            <button
              type="submit"
              disabled={disabled || !!snapshot.activeSession || !model.trim()}
              className={buttonClass}
            >
              {t("agentNetwork.ownedHost.saveModel")}
            </button>
            {snapshot.activeSession && (
              <p className="text-xs text-[var(--ink-muted)]">
                {t("agentNetwork.ownedHost.activeSession")}
              </p>
            )}
          </form>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                disabled ||
                !snapshot.credentials.writeAvailable ||
                !credential.trim() ||
                /[\r\n\0]/.test(credential) ||
                new TextEncoder().encode(credential).length > 16 * 1024
              )
                return;
              void submit(
                {
                  method: "credential.set",
                  params: {
                    providerId: "moonshot-coding",
                    credential,
                    expectedRevision: snapshot.credentials.revision,
                    mutationId: crypto.randomUUID(),
                  },
                },
                "credentials",
              );
              setCredential("");
            }}
          >
            <label className="block space-y-1 text-sm text-[var(--ink)]">
              <span>{t("agentNetwork.ownedHost.credential")}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                disabled={disabled || !snapshot.credentials.writeAvailable}
                className={inputClass}
              />
            </label>
            <p className="text-xs text-[var(--ink-muted)]">
              {t(
                snapshot.credentials.configured
                  ? "agentNetwork.ownedHost.credentialConfigured"
                  : "agentNetwork.ownedHost.credentialMissing",
              )}
            </p>
            <button
              type="submit"
              disabled={
                disabled ||
                !snapshot.credentials.writeAvailable ||
                !credential.trim()
              }
              className={buttonClass}
            >
              {t("agentNetwork.ownedHost.saveCredential")}
            </button>
          </form>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                disabled ||
                !snapshot.resources.roots[0] ||
                !validRelativePath(path)
              )
                return;
              void submit(
                {
                  method: "resources.create",
                  params: {
                    operation: "create",
                    rootId: snapshot.resources.roots[0].rootId,
                    relativePath: path,
                    expectedRevision: snapshot.resources.revision,
                    mutationId: crypto.randomUUID(),
                  },
                },
                "resources",
              );
            }}
          >
            <label className="block space-y-1 text-sm text-[var(--ink)]">
              <span>{t("agentNetwork.ownedHost.workspace")}</span>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                maxLength={1024}
                disabled={disabled}
                placeholder="agents/research"
                className={inputClass}
              />
            </label>
            <p className="text-xs text-[var(--ink-muted)]">
              {t("agentNetwork.ownedHost.agentHint")}
            </p>
            <button
              type="submit"
              className={buttonClass}
              disabled={
                disabled ||
                !snapshot.resources.roots[0] ||
                !validRelativePath(path)
              }
            >
              {t("agentNetwork.ownedHost.createAgent")}
            </button>
          </form>
          <ul
            className="space-y-1 text-sm text-[var(--ink-secondary)]"
            aria-label={t("agentNetwork.ownedHost.agents")}
          >
            {snapshot.resources.agents.map((agent) => (
              <li key={agent.agentId} className="break-words">
                {agent.name} ·{" "}
                {t(
                  agent.enabled
                    ? "agentNetwork.ownedHost.enabled"
                    : "agentNetwork.ownedHost.disabled",
                )}
                <span className="block text-xs text-[var(--ink-muted)]">
                  {agent.workspacePath}
                </span>
              </li>
            ))}
            {snapshot.resources.agents.length === 0 && (
              <li>{t("agentNetwork.ownedHost.empty")}</li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}
function validRelativePath(path: string): boolean {
  return (
    path.length <= 1024 &&
    path
      .split("/")
      .every(
        (part) =>
          /^[a-zA-Z0-9_.-]{1,128}$/.test(part) && part !== "." && part !== "..",
      )
  );
}
