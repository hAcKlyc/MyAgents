import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRightIcon } from "@/components/icons";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import {
  canManageHost,
  hostAddressKey,
  hostLocatorKey,
  hostManagementAdapter,
  sameHostAddress,
  sameHostLocator,
  validHostProvider,
  type HostAccess,
  type HostLocator,
  type HostManagementAdapter,
  type HostMutation,
  type HostReceipt,
  type HostSnapshot,
} from "@/api/hostManagement";
import {
  getHostDraft,
  getHostPending,
  setHostDraft,
  setHostPending,
  type HostPending,
} from "./hostManagementState";

const secondary =
  "rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const primary =
  "rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--focus-border)] focus:outline-none disabled:opacity-60";

export function HostManagement({
  locator,
  online,
  adapter = hostManagementAdapter,
}: {
  locator: HostLocator;
  online: boolean;
  /** Explicit dependency injection for isolated tests; production uses only the
   * protocol-gated adapter above, never a fixture or runtime mock flag. */
  adapter?: HostManagementAdapter;
}) {
  const { t } = useTranslation("app");
  const [expanded, setExpanded] = useState(false);
  const [response, setResponse] = useState<{
    key: string;
    adapter: HostManagementAdapter;
    access: HostAccess;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const requestKey = JSON.stringify([hostLocatorKey(locator), retry]);
  const access =
    response?.key === requestKey && response.adapter === adapter
      ? response.access
      : null;
  const { connectionId, principalId, authGeneration, networkId, deviceId } =
    locator;
  useEffect(() => {
    const abort = new AbortController();
    const setAccess = (value: HostAccess) =>
      setResponse({ key: requestKey, adapter, access: value });
    void adapter
      .inspect(
        { connectionId, principalId, authGeneration, networkId, deviceId },
        abort.signal,
      )
      .then(
        (result) => {
          if (abort.signal.aborted) return;
          if (
            result.status === "ready" &&
            !sameHostLocator(result.snapshot.address, {
              connectionId,
              principalId,
              authGeneration,
              networkId,
              deviceId,
            })
          ) {
            setAccess({ status: "unavailable" });
          } else if (
            result.status === "ready" &&
            (!result.snapshot.permissions.includes("read") ||
              !result.snapshot.capabilities.includes("config.read"))
          ) {
            setAccess({ status: "denied" });
          } else {
            setAccess(result);
          }
        },
        () => {
          if (!abort.signal.aborted) setAccess({ status: "unavailable" });
        },
      );
    return () => abort.abort();
  }, [
    adapter,
    connectionId,
    principalId,
    authGeneration,
    networkId,
    deviceId,
    requestKey,
  ]);
  const status =
    access === null
      ? "loading"
      : access.status === "ready"
        ? online && access.snapshot.online
          ? access.snapshot.initialization
          : "offline"
        : access.status;
  return (
    <section
      className="mb-4 rounded-xl border border-[var(--line-subtle)]"
      aria-label={t("agentNetwork.host.title")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="network-host-management"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 rounded-xl px-3.5 py-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <ChevronRightIcon
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--ink)]">
          {t("agentNetwork.host.title")}
        </span>
        <span className="text-xs text-[var(--ink-muted)]">
          {t(`agentNetwork.host.states.${status}`)}
        </span>
      </button>
      <div
        id="network-host-management"
        hidden={!expanded}
        className="border-t border-[var(--line-subtle)] px-3.5 py-4"
      >
        {access === null ? (
          <p
            role="status"
            aria-busy="true"
            className="text-sm text-[var(--ink-muted)]"
          >
            {t("agentNetwork.host.loading")}
          </p>
        ) : access.status !== "ready" ? (
          <div className="space-y-3">
            <p
              role={access.status === "unavailable" ? "alert" : "status"}
              className="text-sm text-[var(--ink-secondary)]"
            >
              {t(
                `agentNetwork.host.${access.status === "unsupported" ? access.reason : access.status}`,
              )}
            </p>
            {access.status === "unavailable" && (
              <button
                type="button"
                className={secondary}
                onClick={() => setRetry((value) => value + 1)}
              >
                {t("agentNetwork.retry")}
              </button>
            )}
          </div>
        ) : (
          <HostConfiguration
            key={hostAddressKey(access.snapshot.address)}
            initial={access.snapshot}
            online={online}
            adapter={adapter}
            onAccessChanged={(next) =>
              setResponse({ key: requestKey, adapter, access: next })
            }
          />
        )}
      </div>
    </section>
  );
}

function HostConfiguration({
  initial,
  online,
  adapter,
  onAccessChanged,
}: {
  initial: HostSnapshot;
  online: boolean;
  adapter: HostManagementAdapter;
  onAccessChanged: (access: HostAccess) => void;
}) {
  const { t } = useTranslation("app");
  const address = initial.address;
  const [snapshot, setSnapshot] = useState(initial);
  const [draft, setDraft] = useState(
    () =>
      getHostDraft(address) ?? {
        config: initial.provider.config,
        expectedRevision: initial.provider.desiredRevision,
      },
  );
  const [pending, updatePending] = useState<HostPending | undefined>(() =>
    getHostPending(address),
  );
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    pending ? "unconfirmed" : null,
  );
  const [testStatus, setTestStatus] = useState<"passed" | "failed" | null>(
    null,
  );
  const busyRef = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  // A newly committed form can receive a click before its passive effect runs.
  // Establish the signal before any operation can acquire the busy latch.
  if (lifetime.current === null) lifetime.current = new AbortController();
  useEffect(() => {
    const previous = lifetime.current;
    const abort = previous && !previous.signal.aborted
      ? previous
      : new AbortController();
    lifetime.current = abort;
    if (previous?.signal.aborted) {
      busyRef.current = false;
      setBusy(false);
    }
    return () => abort.abort();
  }, []);

  const current = { ...snapshot, online: snapshot.online && online };
  const mayRead =
    current.permissions.includes("read") &&
    current.capabilities.includes("config.read");
  const configure = canManageHost(current, "configure", "provider.configure");
  const writeCredential = canManageHost(
    current,
    "configure",
    "provider.credential.write",
  );
  const mayTest = canManageHost(current, "operate", "provider.test");
  const dirty =
    draft.config.baseUrl !== snapshot.provider.config.baseUrl ||
    draft.config.model !== snapshot.provider.config.model;
  const conflict =
    draft.expectedRevision !== snapshot.provider.desiredRevision && dirty;
  const locked = busy || !!pending;
  const needsRead = notice === "conflictReadFailed";
  function publishSnapshot(next: HostSnapshot) {
    setSnapshot(next);
    onAccessChanged({ status: "ready", snapshot: next });
  }

  function retainDraft(config: typeof draft.config) {
    const next = { ...draft, config };
    setDraft(next);
    setHostDraft(address, next);
    setTestStatus(null);
  }
  function providerKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || isImeComposingEvent(event)) return;
    event.preventDefault();
    void save("provider");
  }
  function retainPending(value?: HostPending) {
    setHostPending(address, value);
    updatePending(value);
  }
  function begin(): AbortSignal | null {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    return signal;
  }
  function end(signal: AbortSignal) {
    if (signal.aborted) return;
    busyRef.current = false;
    setBusy(false);
  }

  async function readSnapshot(signal: AbortSignal): Promise<HostSnapshot> {
    const next = await adapter.read(address, signal);
    if (!sameHostAddress(next.address, address))
      throw new Error("HOST_SCOPE_CHANGED");
    if (
      !next.permissions.includes("read") ||
      !next.capabilities.includes("config.read")
    ) {
      if (!signal.aborted) onAccessChanged({ status: "denied" });
      throw new Error("HOST_READ_DENIED");
    }
    return next;
  }

  async function finishReceipt(
    receipt: HostReceipt,
    operation: HostPending,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return;
    if (
      !sameHostAddress(receipt.address, address) ||
      receipt.mutationId !== operation.mutationId ||
      receipt.resource !== operation.resource
    )
      throw new Error("HOST_RECEIPT_INVALID");
    retainPending({ ...operation, receipt });
    setNotice(receipt.status);
    if (receipt.status === "rejected" || receipt.status === "conflict") {
      retainPending();
      if (receipt.status === "conflict") {
        try {
          const next = await readSnapshot(signal);
          if (!signal.aborted) publishSnapshot(next);
        } catch {
          if (!signal.aborted) setNotice("conflictReadFailed");
        }
      }
      return;
    }
    if (receipt.status === "persisted" || receipt.status === "applied") {
      // A receipt is not a full configuration snapshot. Read from the owner
      // before adopting new CAS values or clearing the submitted draft.
      try {
        const next = await readSnapshot(signal);
        if (signal.aborted) return;
        if (next.provider.desiredRevision < receipt.desiredRevision)
          throw new Error("HOST_SNAPSHOT_STALE");
        publishSnapshot(next);
        if (operation.resource === "provider" || !dirty) {
          const nextDraft = {
            config: next.provider.config,
            expectedRevision: next.provider.desiredRevision,
          };
          setDraft(nextDraft);
          setHostDraft(address);
        }
        setCredential("");
        retainPending();
      } catch {
        if (!signal.aborted) setNotice("persistedReadFailed");
      }
    }
  }

  async function save(resource: HostMutation["resource"]) {
    if (
      pending ||
      needsRead ||
      !mayRead ||
      (resource === "provider"
        ? !configure || !dirty || conflict || !validHostProvider(draft.config)
        : !writeCredential || !credential.trim() || dirty || conflict)
    )
      return;
    const signal = begin();
    if (!signal) return;
    const operation: HostPending = {
      mutationId: crypto.randomUUID(),
      resource,
      receipt: null,
    };
    retainPending(operation); // synchronous lock survives unmount before ACK
    setNotice(null);
    setTestStatus(null);
    const mutation: HostMutation =
      resource === "provider"
        ? {
            mutationId: operation.mutationId,
            expectedRevision: draft.expectedRevision,
            patch: {
              baseUrl: draft.config.baseUrl.trim(),
              model: draft.config.model.trim(),
            },
            resource,
          }
        : {
            mutationId: operation.mutationId,
            expectedRevision: snapshot.provider.desiredRevision,
            credential,
            resource,
          };
    try {
      const receipt = await adapter.mutate(address, mutation, signal);
      await finishReceipt(receipt, operation, signal);
    } catch {
      // A transport exception may follow handoff. Never call it rejection or
      // replay with another mutationId; recovery only reads the original ID.
      if (!signal.aborted) setNotice("unconfirmed");
    } finally {
      end(signal);
    }
  }

  async function recover() {
    if (!pending || !mayRead || !current.online) return;
    const signal = begin();
    if (!signal) return;
    try {
      await finishReceipt(
        await adapter.receipt(address, pending.mutationId, signal),
        pending,
        signal,
      );
    } catch {
      if (!signal.aborted) setNotice("unconfirmed");
    } finally {
      end(signal);
    }
  }

  async function refresh() {
    if (pending || !mayRead || !current.online) return;
    const signal = begin();
    if (!signal) return;
    try {
      const next = await readSnapshot(signal);
      if (signal.aborted) return;
      publishSnapshot(next);
      if (!dirty) {
        setDraft({
          config: next.provider.config,
          expectedRevision: next.provider.desiredRevision,
        });
        setHostDraft(address);
      }
      setNotice(null);
      setTestStatus(null);
    } catch {
      if (!signal.aborted) setNotice("readFailed");
    } finally {
      end(signal);
    }
  }

  async function test() {
    if (
      !mayTest ||
      locked ||
      dirty ||
      !!credential ||
      snapshot.provider.applyState !== "applied" ||
      snapshot.provider.desiredRevision !==
        snapshot.provider.effectiveRevision ||
      !snapshot.provider.credentialConfigured
    )
      return;
    const signal = begin();
    if (!signal) return;
    setTestStatus(null);
    try {
      const result = await adapter.testProvider(
        address,
        snapshot.provider.effectiveRevision,
        signal,
      );
      if (!signal.aborted) setTestStatus(result.ok ? "passed" : "failed");
    } catch {
      if (!signal.aborted) setTestStatus("failed");
    } finally {
      end(signal);
    }
  }

  function reconcile() {
    if (locked || !configure) return;
    // Explicitly adopt the newly read revision, keeping user-entered fields.
    const next = {
      ...draft,
      expectedRevision: snapshot.provider.desiredRevision,
    };
    setDraft(next);
    setHostDraft(address, next);
    setNotice(null);
  }

  if (!mayRead)
    return (
      <p role="alert" className="text-sm text-[var(--error)]">
        {t("agentNetwork.host.denied")}
      </p>
    );
  const environment = snapshot.environment;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          {t("agentNetwork.host.environment")}
        </h3>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={locked || !current.online}
          className={secondary}
        >
          {t("agentNetwork.host.refresh")}
        </button>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {[
          ["system", `${environment.os} · ${environment.architecture}`],
          ["runtime", environment.runtime],
          [
            "resources",
            t("agentNetwork.host.resourceCount", {
              workspaces: environment.workspaceCount,
              agents: environment.agentCount,
            }),
          ],
        ].map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-[var(--ink-muted)]">
              {t(`agentNetwork.host.${label}`)}
            </dt>
            <dd className="min-w-0 break-words text-[var(--ink-secondary)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {environment.agentCount === 0 && (
        <p className="rounded-lg bg-[var(--paper-inset)] p-3 text-xs text-[var(--ink-muted)]">
          {t("agentNetwork.host.emptyHost")}
        </p>
      )}
      <p className="text-xs text-[var(--ink-muted)]">
        {t("agentNetwork.host.grants", {
          grants: snapshot.permissions
            .map((permission) =>
              t(`agentNetwork.host.permissions.${permission}`),
            )
            .join(" · "),
        })}
      </p>
      {!current.online && (
        <p role="status" className="text-sm text-[var(--warning)]">
          {t("agentNetwork.host.offline")}
        </p>
      )}
      {!configure && current.online && (
        <p role="status" className="text-xs text-[var(--ink-muted)]">
          {t("agentNetwork.host.readOnly")}
        </p>
      )}

      <div className="space-y-3 border-t border-[var(--line-subtle)] pt-4">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          {t("agentNetwork.host.provider")}
        </h3>
        <p className="text-xs text-[var(--ink-muted)]">
          {t("agentNetwork.host.sessionScope")}
        </p>
        <p className="text-xs text-[var(--ink-secondary)]">
          {t("agentNetwork.host.revisions", {
            desired: snapshot.provider.desiredRevision,
            effective: snapshot.provider.effectiveRevision,
          })}{" "}
          · {t(`agentNetwork.host.apply.${snapshot.provider.applyState}`)}
        </p>
        <p className="text-xs text-[var(--ink-muted)]">
          {t(`agentNetwork.host.effects.${snapshot.provider.effectScope}`)}
        </p>
        <div
          role="form"
          aria-label={t("agentNetwork.host.provider")}
          className="space-y-3"
        >
          <fieldset disabled={!configure || locked} className="space-y-3">
            <label className="block space-y-1.5 text-sm text-[var(--ink-secondary)]">
              <span>{t("agentNetwork.host.baseUrl")}</span>
              <input
                type="text"
                autoComplete="off"
                value={draft.config.baseUrl}
                onKeyDown={providerKey}
                onChange={(event) =>
                  retainDraft({ ...draft.config, baseUrl: event.target.value })
                }
                className={inputClass}
              />
            </label>
            <label className="block space-y-1.5 text-sm text-[var(--ink-secondary)]">
              <span>{t("agentNetwork.host.model")}</span>
              <input
                type="text"
                autoComplete="off"
                maxLength={160}
                value={draft.config.model}
                onKeyDown={providerKey}
                onChange={(event) =>
                  retainDraft({ ...draft.config, model: event.target.value })
                }
                className={inputClass}
              />
            </label>
          </fieldset>
          {!validHostProvider(draft.config) && dirty && (
            <p role="alert" className="text-xs text-[var(--error)]">
              {t("agentNetwork.host.invalidProvider")}
            </p>
          )}
          {conflict && (
            <div role="alert" className="space-y-2 text-xs text-[var(--error)]">
              <p>{t("agentNetwork.host.conflictDraft")}</p>
              <button
                type="button"
                className={secondary}
                disabled={locked || !configure}
                onClick={reconcile}
              >
                {t("agentNetwork.host.reconcile")}
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void save("provider")}
              className={primary}
              disabled={
                !configure ||
                locked ||
                !dirty ||
                conflict ||
                needsRead ||
                !validHostProvider(draft.config)
              }
              aria-busy={busy}
            >
              {t(
                busy
                  ? "agentNetwork.host.processing"
                  : "agentNetwork.host.saveProvider",
              )}
            </button>
            <span className="text-xs text-[var(--ink-muted)]">
              {t(
                dirty
                  ? "agentNetwork.host.draftRetained"
                  : "agentNetwork.host.noChanges",
              )}
            </span>
          </div>
        </div>
        <div className="space-y-2 rounded-lg bg-[var(--paper-inset)] p-3">
          <label className="block space-y-1.5 text-sm text-[var(--ink-secondary)]">
            <span>{t("agentNetwork.host.credential")}</span>
            <input
              type="password"
              autoComplete="new-password"
              disabled={!writeCredential || locked || dirty || conflict}
              value={credential}
              onChange={(event) => {
                setCredential(event.target.value);
                setTestStatus(null);
              }}
              className={inputClass}
            />
          </label>
          <p className="text-xs text-[var(--ink-muted)]">
            {t(
              snapshot.provider.credentialConfigured
                ? "agentNetwork.host.credentialExists"
                : "agentNetwork.host.credentialMissing",
            )}{" "}
            {t("agentNetwork.host.credentialHint")}
          </p>
          <button
            type="button"
            className={secondary}
            onClick={() => void save("credential")}
            disabled={
              !writeCredential ||
              locked ||
              needsRead ||
              !credential.trim() ||
              dirty ||
              conflict
            }
          >
            {t("agentNetwork.host.saveCredential")}
          </button>
        </div>
        {notice && (
          <p
            role={
              notice === "applied" ||
              notice === "persisted" ||
              notice === "accepted"
                ? "status"
                : "alert"
            }
            className="text-sm text-[var(--ink-secondary)]"
          >
            {t(`agentNetwork.host.notices.${notice}`)}
          </p>
        )}
        {pending && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--ink-muted)]">
              {t("agentNetwork.host.receiptHint")}
            </p>
            <button
              type="button"
              className={secondary}
              disabled={busy || !current.online}
              onClick={() => void recover()}
            >
              {t("agentNetwork.host.queryReceipt")}
            </button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={secondary}
            onClick={() => void test()}
            disabled={
              !mayTest ||
              locked ||
              dirty ||
              !!credential ||
              snapshot.provider.applyState !== "applied" ||
              snapshot.provider.desiredRevision !==
                snapshot.provider.effectiveRevision ||
              !snapshot.provider.credentialConfigured
            }
          >
            {t("agentNetwork.host.testProvider")}
          </button>
          {testStatus && (
            <span
              role={testStatus === "failed" ? "alert" : "status"}
              className={`text-xs ${testStatus === "failed" ? "text-[var(--error)]" : "text-[var(--ink-secondary)]"}`}
            >
              {t(`agentNetwork.host.test.${testStatus}`)}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--ink-muted)]">
          {t("agentNetwork.host.testHint")}
        </p>
      </div>
    </div>
  );
}
