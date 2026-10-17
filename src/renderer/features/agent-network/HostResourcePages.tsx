import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CustomSelect from "@/components/CustomSelect";
import {
  canManageHost,
  hostAddressKey,
  sameHostAddress,
  validHostResourcePatch,
  type HostCapability,
  type HostPageReceipt,
  type HostPagesAdapter,
  type HostResourcePatch,
  type HostResourceSnapshot,
  type HostSnapshot,
} from "@/api/hostManagement";
import {
  getHostPageDraft,
  getHostPagePending,
  setHostPageDraft,
  setHostPagePending,
} from "./hostManagementState";

const secondary =
  "rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const primary =
  "rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";
const inputClass =
  "w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--focus-border)] focus:outline-none disabled:opacity-60";
type Page = "workspaces" | "extensions";
type ResourceRow =
  | { kind: "workspace"; item: HostResourceSnapshot["workspaces"][number] }
  | { kind: "mcp"; item: HostResourceSnapshot["mcps"][number] }
  | { kind: "skill"; item: HostResourceSnapshot["skills"][number] };
function createMutationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function HostResourcePages({
  snapshot,
  adapter,
  page,
  active,
}: {
  snapshot: HostSnapshot;
  adapter: HostPagesAdapter | undefined;
  page: Page;
  active: boolean;
}) {
  const { t } = useTranslation("app");
  const address = snapshot.address;
  const [resourceState, setResourceState] = useState<{
    identity: string;
    adapter: HostPagesAdapter | undefined;
    status: "loading" | "ready" | "failed";
    response?: { resources: HostResourceSnapshot; signal: AbortSignal };
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState(() => getHostPageDraft(address));
  const [pending, setPending] = useState(() => getHostPagePending(address));
  const [notice, setNotice] = useState<string | null>(
    pending ? "unconfirmed" : null,
  );
  const [busy, setBusy] = useState(false);
  const [agentName, setAgentName] = useState("");
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const lifecycle = useRef(new AbortController());
  const gate =
    snapshot.online &&
    snapshot.permissions.includes("read") &&
    snapshot.capabilities.includes("resources.read");
  const authorizationKey = JSON.stringify([
    snapshot.online,
    snapshot.permissions,
    snapshot.capabilities,
  ]);
  const identity = JSON.stringify([hostAddressKey(address), authorizationKey]);
  const patchCapability: HostCapability =
    draft?.patch.kind ?? "workspace.register";
  const canConfigure = canManageHost(snapshot, "configure", patchCapability);
  const draftPage: Page | null = !draft
    ? null
    : draft.patch.kind === "workspace.register" ||
        draft.patch.kind === "agent.create" ||
        draft.patch.kind === "agent.patch"
      ? "workspaces"
      : "extensions";
  const draftOnOtherPage = !!draft && draftPage !== page;
  const canEditKind = (kind: HostResourcePatch["kind"]) =>
    !draft || draft.patch.kind === kind;
  const requestRead = useCallback(
    async (signal: AbortSignal, generation: number) => {
      if (!adapter || !gate) throw new Error("READ_DENIED");
      const next = await adapter.readResources(address, signal);
      if (signal.aborted || epoch.current !== generation)
        throw new Error("STALE");
      if (!sameHostAddress(next.address, address))
        throw new Error("SCOPE_CHANGED");
      setResourceState({
        identity,
        adapter,
        status: "ready",
        response: { resources: next, signal },
      });
      return next;
    },
    [adapter, address, gate, identity],
  );
  useEffect(() => {
    if (lifecycle.current.signal.aborted)
      lifecycle.current = new AbortController();
    const generation = ++epoch.current;
    if (!active)
      return () => {
        lifecycle.current.abort();
        busyRef.current = false;
        setBusy(false);
      };
    if (!adapter || !gate) {
      setResourceState({ identity, adapter, status: "loading" });
      return () => {
        lifecycle.current.abort();
        busyRef.current = false;
        setBusy(false);
      };
    }
    const controller = new AbortController();
    setResourceState({ identity, adapter, status: "loading" });
    void requestRead(controller.signal, generation).catch(() => {
      if (!controller.signal.aborted && epoch.current === generation) {
        setResourceState({ identity, adapter, status: "failed" });
      }
    });
    return () => {
      controller.abort();
      lifecycle.current.abort();
      busyRef.current = false;
      setBusy(false);
    };
  }, [active, adapter, gate, identity, requestRead, retry]);
  const currentResourceState =
    resourceState?.identity === identity &&
    resourceState.adapter === adapter &&
    (!resourceState.response || !resourceState.response.signal.aborted)
      ? resourceState
      : null;
  const resources =
    currentResourceState?.status === "ready"
      ? (currentResourceState.response?.resources ?? null)
      : null;
  const load = currentResourceState?.status ?? "loading";
  const permitted = active && gate && !!adapter;
  const writeReady =
    permitted && resources !== null && !pending && !busy && load === "ready";
  const revisionConflict =
    !!draft &&
    !!resources &&
    draft.expectedRevision !== resources.desiredRevision;
  const mayWrite =
    writeReady &&
    canConfigure &&
    !revisionConflict &&
    notice !== "conflict" &&
    notice !== "conflictReadFailed" &&
    notice !== "persistedReadFailed" &&
    notice !== "readFailed";
  const dirty = !!draft;
  const canTest =
    page === "extensions" &&
    permitted &&
    resources !== null &&
    !busy &&
    !dirty &&
    !pending &&
    resources.applyState === "applied" &&
    resources.desiredRevision === resources.effectiveRevision &&
    canManageHost(snapshot, "operate", "mcp.test");

  function retain(patch: HostResourcePatch) {
    if (
      !resources ||
      (draft && draft.patch.kind !== patch.kind) ||
      (draft?.patch.kind === "agent.patch" &&
        patch.kind === "agent.patch" &&
        draft.patch.agentId !== patch.agentId)
    )
      return;
    if (patch.kind !== "agent.create") setAgentName("");
    const next = {
      patch,
      expectedRevision: draft?.expectedRevision ?? resources.desiredRevision,
    };
    setDraft(next);
    setHostPageDraft(address, next);
    if (notice !== "conflict" && notice !== "conflictReadFailed")
      setNotice(null);
  }
  async function refresh() {
    if (!adapter || !permitted || busyRef.current) return;
    const controller = lifecycle.current;
    const generation = ++epoch.current;
    setBusy(true);
    busyRef.current = true;
    try {
      await requestRead(controller.signal, generation);
      if (!draft) {
        setDraft(undefined);
        setHostPageDraft(address);
        setNotice(null);
      } else if (notice === "conflict" || notice === "conflictReadFailed")
        setNotice("conflict");
      else setNotice(null);
    } catch {
      if (!controller.signal.aborted) setNotice("readFailed");
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  async function handleReceipt(
    receipt: HostPageReceipt,
    operation: { mutationId: string; resource: "resources" | "interaction" },
    signal: AbortSignal,
    generation: number,
  ) {
    if (operation.resource !== "resources") return;
    if (signal.aborted || epoch.current !== generation) return;
    if (
      !sameHostAddress(receipt.address, address) ||
      receipt.resource !== operation.resource ||
      receipt.mutationId !== operation.mutationId
    )
      throw new Error("RECEIPT_INVALID");
    setHostPagePending(address, { ...operation, receipt });
    setPending({ ...operation, receipt });
    setNotice(receipt.status);
    if (receipt.status === "rejected") {
      setHostPagePending(address);
      setPending(undefined);
      return;
    }
    if (receipt.status === "conflict") {
      setHostPagePending(address);
      setPending(undefined);
      try {
        const latest = await requestRead(signal, generation);
        if (signal.aborted || latest.desiredRevision < receipt.desiredRevision)
          throw new Error("HOST_SNAPSHOT_STALE");
        setResourceState({
          identity,
          adapter,
          status: "ready",
          response: { resources: latest, signal },
        });
        setNotice("conflict");
      } catch {
        if (!signal.aborted) setNotice("conflictReadFailed");
      }
      return;
    }
    if (receipt.status === "persisted" || receipt.status === "applied") {
      try {
        const latest = await requestRead(signal, generation);
        if (signal.aborted || latest.desiredRevision < receipt.desiredRevision)
          throw new Error("STALE_REVISION");
        setDraft(undefined);
        setAgentName("");
        setHostPageDraft(address);
        setPending(undefined);
        setHostPagePending(address);
        setNotice(receipt.status);
      } catch {
        if (!signal.aborted) setNotice("persistedReadFailed");
      }
    }
  }
  async function submit() {
    if (
      !adapter ||
      !resources ||
      !draft ||
      !mayWrite ||
      !validHostResourcePatch(draft.patch, resources) ||
      busyRef.current
    )
      return;
    const generation = epoch.current;
    const controller = lifecycle.current;
    const mutationId = createMutationId();
    const operation = {
      mutationId,
      resource: "resources" as const,
      receipt: null,
    };
    busyRef.current = true;
    setBusy(true);
    setHostPagePending(address, operation);
    setPending(operation);
    setNotice("unconfirmed");
    try {
      const receipt = await adapter.mutateResources(
        address,
        {
          mutationId,
          expectedRevision: draft.expectedRevision,
          patch: draft.patch,
        },
        controller.signal,
      );
      await handleReceipt(receipt, operation, controller.signal, generation);
    } catch {
      if (!controller.signal.aborted) setNotice("unconfirmed");
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function recover() {
    if (
      !adapter ||
      !pending ||
      pending.resource !== "resources" ||
      !permitted ||
      busyRef.current
    )
      return;
    const generation = epoch.current;
    const controller = lifecycle.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const receipt = await adapter.receipt(
        address,
        pending.mutationId,
        controller.signal,
      );
      await handleReceipt(receipt, pending, controller.signal, generation);
    } catch {
      if (!controller.signal.aborted) setNotice("unconfirmed");
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function testMcp(presetId: string) {
    if (
      !adapter ||
      !resources ||
      !canTest ||
      !snapshot.online ||
      busyRef.current
    )
      return;
    const item = resources.mcps.find((mcp) => mcp.presetId === presetId);
    if (!item?.enabled) return;
    const generation = epoch.current;
    const controller = lifecycle.current;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const result = await adapter.testMcp(
        address,
        presetId,
        resources.effectiveRevision,
        controller.signal,
      );
      if (!controller.signal.aborted && generation === epoch.current)
        setNotice(result.ok ? "testPassed" : "testFailed");
    } catch {
      if (!controller.signal.aborted) setNotice("testFailed");
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function reconcile() {
    if (
      !resources ||
      !draft ||
      pending ||
      busy ||
      !permitted ||
      !canConfigure ||
      load !== "ready" ||
      notice === "conflictReadFailed" ||
      notice === "persistedReadFailed"
    )
      return;
    const next = { ...draft, expectedRevision: resources.desiredRevision };
    setDraft(next);
    setHostPageDraft(address, next);
    setNotice(null);
  }
  const scopeLocked =
    pending?.resource !== undefined && pending.resource !== "resources";
  const canDiscard = permitted && !!resources && !pending && !busy;
  const workspaceWriteReady =
    writeReady &&
    canEditKind("workspace.register") &&
    canManageHost(snapshot, "configure", "workspace.register");
  const agentWriteReady = (kind: "agent.create" | "agent.patch") =>
    writeReady &&
    canEditKind(kind) &&
    canManageHost(snapshot, "configure", kind);
  const mcpWriteReady =
    writeReady &&
    canEditKind("mcp.configure") &&
    canManageHost(snapshot, "configure", "mcp.configure");
  const skillWriteReady =
    writeReady &&
    canEditKind("skill.configure") &&
    canManageHost(snapshot, "configure", "skill.configure");
  const message = (id: string) =>
    t(`agentNetwork.host.pages.${id}`, { defaultValue: id });
  const field = (
    label: string,
    value: string,
    change: (v: string) => void,
    disabled = false,
  ) => (
    <label className="block min-w-0 space-y-1.5 text-sm text-[var(--ink-secondary)]">
      <span>{label}</span>
      <input
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
  const select = (
    label: string,
    value: string,
    options: { id: string; label?: string; name?: string }[],
    change: (v: string) => void,
    disabled = false,
  ) => (
    <label className="block min-w-0 space-y-1.5 text-sm text-[var(--ink-secondary)]">
      <span>{label}</span>
      <CustomSelect
        value={value}
        options={options.map((option) => ({
          value: option.id,
          label: option.label ?? option.name ?? option.id,
        }))}
        onChange={change}
        placeholder={message("choose")}
        ariaLabel={label}
        size="md"
        disabled={disabled}
      />
    </label>
  );
  const rows = useMemo<ResourceRow[]>(
    () =>
      page === "workspaces"
        ? (resources?.workspaces ?? []).map((item) => ({
            kind: "workspace",
            item,
          }))
        : [
            ...(resources?.mcps ?? []).map((item) => ({
              kind: "mcp" as const,
              item,
            })),
            ...(resources?.skills ?? []).map((item) => ({
              kind: "skill" as const,
              item,
            })),
          ],
    [page, resources],
  );
  return (
    <section className="min-w-0 space-y-4" aria-label={message(page)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--ink)]">
          {message(page)}
        </h3>
        <button
          type="button"
          className={secondary}
          disabled={!permitted || busy || !!pending}
          title={!permitted ? message("readDisabled") : undefined}
          onClick={() => void refresh()}
        >
          {message("refresh")}
        </button>
      </div>
      {!active ? (
        <p role="status" className="text-sm text-[var(--ink-muted)]">
          {message("inactive")}
        </p>
      ) : !snapshot.online ? (
        <p role="status" className="text-sm text-[var(--warning)]">
          {message("offline")}
        </p>
      ) : !snapshot.permissions.includes("read") ||
        !snapshot.capabilities.includes("resources.read") ? (
        <p role="alert" className="text-sm text-[var(--error)]">
          {message("denied")}
        </p>
      ) : !adapter ? (
        <p role="status" className="text-sm text-[var(--ink-muted)]">
          {message("unsupported")}
        </p>
      ) : load === "loading" ? (
        <p
          role="status"
          aria-busy="true"
          className="text-sm text-[var(--ink-muted)]"
        >
          {message("loading")}
        </p>
      ) : load === "failed" ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>{message("readFailed")}</p>
          <button
            className={secondary}
            type="button"
            onClick={() => setRetry((x) => x + 1)}
          >
            {message("retry")}
          </button>
        </div>
      ) : (
        resources && (
          <>
            <div className="rounded-lg border border-[var(--line-subtle)] p-3 text-xs text-[var(--ink-muted)]">
              {t("agentNetwork.host.revisions", {
                desired: resources.desiredRevision,
                effective: resources.effectiveRevision,
              })}{" "}
              ·{" "}
              {t(`agentNetwork.host.apply.${resources.applyState}`, {
                defaultValue: resources.applyState,
              })}{" "}
              ·{" "}
              {t(`agentNetwork.host.effects.${resources.effectScope}`, {
                defaultValue: resources.effectScope,
              })}
            </div>
            {!canConfigure && (
              <p role="status" className="text-xs text-[var(--ink-muted)]">
                {message("readOnly")}
              </p>
            )}
            {scopeLocked && (
              <p role="alert" className="text-sm text-[var(--warning)]">
                {message("approvalPending")}
              </p>
            )}
            {pending && (
              <div className="flex flex-wrap items-center gap-2" role="status">
                <span>{message("unconfirmed")}</span>
                {pending.resource === "resources" && (
                  <button
                    type="button"
                    className={secondary}
                    disabled={!permitted || busy}
                    onClick={() => void recover()}
                  >
                    {message("checkReceipt")}
                  </button>
                )}
              </div>
            )}
            {notice && !pending && (
              <p
                role={
                  notice.includes("Failed") || notice === "testFailed"
                    ? "alert"
                    : "status"
                }
                className="text-sm text-[var(--ink-secondary)]"
              >
                {t(`agentNetwork.host.notices.${notice}`, {
                  defaultValue: message(notice),
                })}
              </p>
            )}
            {(notice === "conflict" || revisionConflict) && draft && (
              <div role="alert" className="space-y-2 text-sm">
                <p>{message("conflictDraft")}</p>
                <button
                  className={secondary}
                  type="button"
                  disabled={
                    !resources ||
                    !!pending ||
                    busy ||
                    notice === "conflictReadFailed"
                  }
                  onClick={reconcile}
                >
                  {message("reconcile")}
                </button>
              </div>
            )}
            {dirty && !draftOnOtherPage && (
              <p role="status" className="text-xs text-[var(--ink-muted)]">
                {message("finishDraft")}
              </p>
            )}
            <ul className="min-w-0 space-y-2">
              {rows.map((row) => (
                <li
                  key={row.item.id}
                  className="min-w-0 rounded-lg border border-[var(--line-subtle)] p-3"
                >
                  <div className="min-w-0 break-words text-sm font-medium text-[var(--ink)]">
                    {row.item.name}
                  </div>
                  <div className="mt-1 min-w-0 break-words [overflow-wrap:anywhere] text-xs text-[var(--ink-muted)]">
                    {row.kind === "workspace"
                      ? row.item.displayPath
                      : row.kind === "mcp"
                        ? `${resources.mcpPresets.find((p) => p.id === row.item.presetId)?.label ?? row.item.presetId} · ${resources.mcpPresets.find((p) => p.id === row.item.presetId)?.transport ?? ""}`
                        : resources.skillSources.find(
                            (s) => s.id === row.item.sourceId,
                          )?.label}
                  </div>
                  {row.kind !== "workspace" && (
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                      {message(row.item.enabled ? "enabled" : "disabled")}
                    </p>
                  )}
                  {page === "extensions" && row.kind !== "workspace" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={secondary}
                        disabled={
                          !writeReady ||
                          !canEditKind(
                            row.kind === "mcp"
                              ? "mcp.configure"
                              : "skill.configure",
                          ) ||
                          !canManageHost(
                            snapshot,
                            "configure",
                            row.kind === "mcp"
                              ? "mcp.configure"
                              : "skill.configure",
                          )
                        }
                        title={
                          !writeReady ? message("writeDisabled") : undefined
                        }
                        onClick={() =>
                          retain(
                            row.kind === "mcp"
                              ? {
                                  kind: "mcp.configure",
                                  presetId: row.item.presetId,
                                  enabled: !row.item.enabled,
                                }
                              : {
                                  kind: "skill.configure",
                                  sourceId: row.item.sourceId,
                                  enabled: !row.item.enabled,
                                },
                          )
                        }
                      >
                        {message(row.item.enabled ? "disable" : "enable")}
                      </button>
                      {row.kind === "mcp" && (
                        <button
                          type="button"
                          className={secondary}
                          disabled={!canTest || !snapshot.online}
                          title={!canTest ? message("testDisabled") : undefined}
                          onClick={() => void testMcp(row.item.presetId)}
                        >
                          {message("test")}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {page === "workspaces" && (
              <>
                <ul className="min-w-0 space-y-2">
                  {resources.agents.map((agent) => (
                    <li
                      key={agent.id}
                      className="min-w-0 rounded-lg border border-[var(--line-subtle)] p-3"
                    >
                      <div className="break-words text-sm font-medium">
                        {agent.name}
                      </div>
                      <div className="break-words text-xs text-[var(--ink-muted)]">
                        {
                          resources.workspaces.find(
                            (w) => w.id === agent.workspaceId,
                          )?.name
                        }{" "}
                        ·{" "}
                        {
                          resources.runtimes.find(
                            (r) => r.id === agent.runtimeId,
                          )?.label
                        }
                      </div>
                      <button
                        type="button"
                        className={`${secondary} mt-2`}
                        disabled={
                          !writeReady ||
                          !canEditKind("agent.patch") ||
                          (draft?.patch.kind === "agent.patch" &&
                            draft.patch.agentId !== agent.id) ||
                          !canManageHost(snapshot, "configure", "agent.patch")
                        }
                        title={
                          !writeReady ? message("writeDisabled") : undefined
                        }
                        onClick={() =>
                          retain({
                            kind: "agent.patch",
                            agentId: agent.id,
                            name: agent.name,
                          })
                        }
                      >
                        {message("editAgent")}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="rounded-lg border border-[var(--line-subtle)] p-3">
                  <h4 className="mb-3 text-sm font-semibold">
                    {message("registerWorkspace")}
                  </h4>
                  <p className="mb-3 text-xs text-[var(--ink-muted)]">
                    {message("resourceHint")}
                  </p>
                  {field(
                    message("workspaceName"),
                    draft?.patch.kind === "workspace.register"
                      ? draft.patch.name
                      : "",
                    (v) =>
                      retain({
                        kind: "workspace.register",
                        rootId:
                          draft?.patch.kind === "workspace.register"
                            ? draft.patch.rootId
                            : "",
                        relativePath:
                          draft?.patch.kind === "workspace.register"
                            ? draft.patch.relativePath
                            : "",
                        name: v,
                      }),
                    !workspaceWriteReady,
                  )}
                  {select(
                    message("root"),
                    draft?.patch.kind === "workspace.register"
                      ? draft.patch.rootId
                      : "",
                    resources.roots,
                    (v) =>
                      retain({
                        kind: "workspace.register",
                        rootId: v,
                        relativePath:
                          draft?.patch.kind === "workspace.register"
                            ? draft.patch.relativePath
                            : "",
                        name:
                          draft?.patch.kind === "workspace.register"
                            ? draft.patch.name
                            : "",
                      }),
                    !workspaceWriteReady,
                  )}
                  {field(
                    message("relativePath"),
                    draft?.patch.kind === "workspace.register"
                      ? draft.patch.relativePath
                      : "",
                    (v) =>
                      retain({
                        kind: "workspace.register",
                        rootId:
                          draft?.patch.kind === "workspace.register"
                            ? draft.patch.rootId
                            : "",
                        relativePath: v,
                        name:
                          draft?.patch.kind === "workspace.register"
                            ? draft.patch.name
                            : "",
                      }),
                    !workspaceWriteReady,
                  )}
                </div>
                <div className="rounded-lg border border-[var(--line-subtle)] p-3">
                  <h4 className="mb-3 text-sm font-semibold">
                    {message(
                      draft?.patch.kind === "agent.patch"
                        ? "editAgent"
                        : "createAgent",
                    )}
                  </h4>
                  <p className="mb-3 text-xs text-[var(--ink-muted)]">
                    {message("resourceHint")}
                  </p>
                  {draft?.patch.kind !== "agent.patch" && (
                    <>
                      {select(
                        message("workspace"),
                        draft?.patch.kind === "agent.create"
                          ? draft.patch.workspaceId
                          : "",
                        resources.workspaces,
                        (v) =>
                          retain({
                            kind: "agent.create",
                            workspaceId: v,
                            runtimeId:
                              draft?.patch.kind === "agent.create"
                                ? draft.patch.runtimeId
                                : "",
                            name:
                              draft?.patch.kind === "agent.create"
                                ? draft.patch.name
                                : "",
                          }),
                        !agentWriteReady("agent.create"),
                      )}
                      {select(
                        message("runtime"),
                        draft?.patch.kind === "agent.create"
                          ? draft.patch.runtimeId
                          : "",
                        resources.runtimes,
                        (v) =>
                          retain({
                            kind: "agent.create",
                            workspaceId:
                              draft?.patch.kind === "agent.create"
                                ? draft.patch.workspaceId
                                : "",
                            runtimeId: v,
                            name:
                              draft?.patch.kind === "agent.create"
                                ? draft.patch.name
                                : "",
                          }),
                        !agentWriteReady("agent.create"),
                      )}
                    </>
                  )}
                  {field(
                    message("agentName"),
                    draft?.patch.kind === "agent.create" ||
                      draft?.patch.kind === "agent.patch"
                      ? draft.patch.name
                      : agentName,
                    (v) => {
                      setAgentName(v);
                      if (draft?.patch.kind === "agent.create")
                        retain({ ...draft.patch, name: v });
                      else if (draft?.patch.kind === "agent.patch")
                        retain({ ...draft.patch, name: v });
                      else
                        retain({
                          kind: "agent.create",
                          workspaceId: "",
                          runtimeId: "",
                          name: v,
                        });
                    },
                    !agentWriteReady(
                      draft?.patch.kind === "agent.patch"
                        ? "agent.patch"
                        : "agent.create",
                    ),
                  )}
                </div>
              </>
            )}
            {page === "extensions" && (
              <div className="rounded-lg border border-[var(--line-subtle)] p-3">
                <h4 className="mb-3 text-sm font-semibold">
                  {message("configureExtension")}
                </h4>
                <p className="mb-3 text-xs text-[var(--ink-muted)]">
                  {message("extensionHint")}
                </p>
                {select(
                  message("mcpPreset"),
                  draft?.patch.kind === "mcp.configure"
                    ? draft.patch.presetId
                    : "",
                  resources.mcpPresets,
                  (v) =>
                    retain({
                      kind: "mcp.configure",
                      presetId: v,
                      enabled: true,
                    }),
                  !mcpWriteReady,
                )}
                {select(
                  message("skillSource"),
                  draft?.patch.kind === "skill.configure"
                    ? draft.patch.sourceId
                    : "",
                  resources.skillSources,
                  (v) =>
                    retain({
                      kind: "skill.configure",
                      sourceId: v,
                      enabled: true,
                    }),
                  !skillWriteReady,
                )}
              </div>
            )}
            {dirty && draftOnOtherPage && (
              <div className="flex flex-wrap items-center gap-2" role="status">
                <span className="text-sm text-[var(--ink-secondary)]">
                  {message("draftOtherPage")}
                </span>
                <button
                  type="button"
                  className={secondary}
                  disabled={!canDiscard}
                  onClick={() => {
                    setDraft(undefined);
                    setAgentName("");
                    setHostPageDraft(address);
                    setNotice(null);
                  }}
                >
                  {message("discard")}
                </button>
              </div>
            )}
            {dirty && !draftOnOtherPage && (
              <div
                role="form"
                aria-label={message("draftForm")}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="min-w-0 break-words text-xs text-[var(--ink-muted)]">
                  {message("draftSaved")}
                </span>
                <button
                  type="button"
                  className={primary}
                  disabled={
                    !mayWrite || !validHostResourcePatch(draft.patch, resources)
                  }
                  title={
                    !mayWrite
                      ? message(
                          scopeLocked ? "approvalPending" : "writeDisabled",
                        )
                      : !validHostResourcePatch(draft.patch, resources)
                        ? message("invalidPatch")
                        : undefined
                  }
                  onClick={() => void submit()}
                >
                  {message("save")}
                </button>
                <button
                  type="button"
                  className={secondary}
                  disabled={!canDiscard}
                  onClick={() => {
                    setDraft(undefined);
                    setAgentName("");
                    setHostPageDraft(address);
                    setNotice(null);
                  }}
                >
                  {message("discard")}
                </button>
              </div>
            )}
            {resources.applyState === "pending" && (
              <p role="status" className="text-sm text-[var(--warning)]">
                {message("pendingApply")}
              </p>
            )}
            {!rows.length && (
              <p role="status" className="text-sm text-[var(--ink-muted)]">
                {message("empty")}
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}
