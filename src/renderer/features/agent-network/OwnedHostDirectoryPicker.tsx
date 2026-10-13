import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import CustomSelect from "@/components/CustomSelect";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { isImeComposingEvent } from "@/utils/imeKeyboard";
import { ownedHostManagement, type OwnedHostDirectoryList, type OwnedHostScope } from "@/api/ownedHostManagement";
import type { HostLocator } from "@/api/hostManagement";

const button = "rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
export function displayHostPath(root: string, relativePath: string) {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const suffix = relativePath.split("/").filter(Boolean).join(separator);
  return suffix ? `${normalizedRoot}${separator}${suffix}` : root;
}

export function OwnedHostDirectoryPicker({ locator, scope, roots, online, initial, onClose, onSelect }: {
  locator: HostLocator; scope: OwnedHostScope; roots: { rootId: string; workspacePath: string }[];
  online: boolean; initial?: { rootId: string; relativePath: string };
  onClose: () => void; onSelect: (selected: { rootId: string; relativePath: string }) => void;
}) {
  const { t } = useTranslation("app");
  const { connectionId, principalId, networkId, deviceId, authGeneration } = locator;
  const { serviceId, environment, scopePrincipalId, scopeNetworkId, scopeDeviceId, keyGeneration } = {
    serviceId: scope.serviceId, environment: scope.environment, scopePrincipalId: scope.principalId,
    scopeNetworkId: scope.networkId, scopeDeviceId: scope.deviceId, keyGeneration: scope.keyGeneration,
  };
  const [rootId, setRootId] = useState(initial?.rootId && roots.some(root => root.rootId === initial.rootId) ? initial.rootId : roots[0]?.rootId ?? "");
  const [path, setPath] = useState(initial?.relativePath ?? "");
  const [page, setPage] = useState<OwnedHostDirectoryList | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const firstRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useCloseLayer(() => { onClose(); return true; }, 200);
  useEffect(() => {
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstRef.current?.focus();
    return () => { if (restoreFocus.current?.isConnected) restoreFocus.current.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const stableLocator: HostLocator = { connectionId, principalId, networkId, deviceId, authGeneration };
    const stableScope: OwnedHostScope = { serviceId, environment, principalId: scopePrincipalId, networkId: scopeNetworkId, deviceId: scopeDeviceId, keyGeneration };
    void Promise.resolve().then(() => {
      if (!active) return null;
      setState("loading"); setError("");
      return ownedHostManagement(stableLocator, stableScope, { method: "resources.directory.list", params: { rootId, relativePath: path, ...(cursor ? { cursor } : {}) } }, controller.signal);
    }).then(response => {
      if (!active) return;
      if (!response) return;
      if (response.result.kind !== "directory-list") throw new Error("HOST_MANAGEMENT_RESPONSE_INVALID");
      setPage(response.result); setState("ready");
    }).catch(reason => {
      if (!active || controller.signal.aborted) return;
      const code = reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string" ? reason.code : "HOST_MANAGEMENT_NOT_COMPLETED";
      setError(code); setState("error");
    });
    return () => { active = false; controller.abort(); };
  }, [connectionId, principalId, networkId, deviceId, authGeneration, serviceId, environment, scopePrincipalId, scopeNetworkId, scopeDeviceId, keyGeneration, rootId, path, cursor, refreshGeneration]);
  const move = (nextPath: string) => { setPath(nextPath); setCursor(undefined); setHistory([]); };
  const parent = path ? path.split("/").slice(0, -1).join("/") : null;
  return <OverlayBackdrop portal onClose={onClose} className="z-[240] p-4">
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="owned-host-directory-title" onKeyDown={e => {
      if (e.key === "Escape" && !isImeComposingEvent(e)) { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }} className="flex max-h-[min(680px,90dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
      <header className="flex items-start gap-3 border-b border-[var(--line)] p-5">
        <div className="min-w-0 flex-1"><h2 id="owned-host-directory-title" className="text-lg font-semibold text-[var(--ink)]">{t("agentNetwork.ownedHost.directoryTitle")}</h2><p className="mt-1 break-all text-xs text-[var(--ink-muted)]">{displayHostPath(roots.find(r => r.rootId === rootId)?.workspacePath ?? "", path)}</p></div>
        <button ref={firstRef} type="button" className={button} onClick={onClose}>{t("agentNetwork.ownedHost.close")}</button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        <label className="block space-y-1 text-sm text-[var(--ink)]"><span>{t("agentNetwork.ownedHost.directoryRoot")}</span><CustomSelect size="md" ariaLabel={t("agentNetwork.ownedHost.directoryRoot")} value={rootId} disabled={!online || roots.length === 0} placeholder={t("agentNetwork.ownedHost.directoryNoRoots")} options={roots.map(root => ({ value: root.rootId, label: root.workspacePath }))} onChange={value => { setRootId(value); move(""); }} /></label>
        <div className="flex flex-wrap items-center gap-2"><button type="button" className={button} disabled={parent === null || state === "loading"} onClick={() => move(parent ?? "")}>{t("agentNetwork.ownedHost.directoryParent")}</button><button type="button" className={button} disabled={!online || state === "loading"} onClick={() => { setCursor(undefined); setHistory([]); setRefreshGeneration(value => value + 1); }}>{t("agentNetwork.ownedHost.directoryRefresh")}</button><span className="min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)]">{path || "/"}</span></div>
        {!online && <p role="status" className="text-sm text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.offline")}</p>}
        {state === "loading" && <p role="status" className="text-sm text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.directoryLoading")}</p>}
        {state === "error" && <p role="alert" className="break-words text-sm text-[var(--error)]">{t("agentNetwork.ownedHost.directoryError", { code: error })}</p>}
        {state === "ready" && page && <>
          <ul aria-label={t("agentNetwork.ownedHost.directoryEntries")} className="min-h-20 space-y-1 rounded-xl border border-[var(--line)] p-2">
            {page.entries.map(entry => <li key={entry.relativePath}><button type="button" className="w-full break-all rounded-lg px-3 py-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => move(entry.relativePath)}><span aria-hidden="true" className="mr-2 text-[var(--accent)]">▸</span>{entry.name}</button></li>)}
            {!page.entries.length && <li className="px-3 py-5 text-center text-sm text-[var(--ink-muted)]">{t("agentNetwork.ownedHost.directoryEmpty")}</li>}
          </ul>
          <div className="flex justify-between"><button type="button" className={button} disabled={!history.length} onClick={() => { const previous = history.at(-1); setHistory(old => old.slice(0, -1)); setCursor(previous); }}>{t("agentNetwork.ownedHost.directoryPrevious")}</button><button type="button" className={button} disabled={!page.nextCursor} onClick={() => { setHistory(old => [...old, cursor]); setCursor(page.nextCursor ?? undefined); }}>{t("agentNetwork.ownedHost.directoryNext")}</button></div>
        </>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-[var(--line)] p-5"><button type="button" className={button} onClick={onClose}>{t("agentNetwork.ownedHost.cancel")}</button><button type="button" className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50" disabled={state !== "ready" || !online || !rootId} onClick={event => { event.preventDefault(); event.stopPropagation(); onSelect({ rootId, relativePath: path }); }}>{t("agentNetwork.ownedHost.selectDirectory")}</button></footer>
    </section>
  </OverlayBackdrop>;
}
