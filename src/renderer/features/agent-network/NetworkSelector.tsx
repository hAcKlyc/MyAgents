import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon, PlusIcon } from "@/components/icons";
import Popover from "@/components/ui/Popover";
import ConfirmDialog from "@/components/ConfirmDialog";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToastOptional } from "@/components/Toast";
import {
  selectNetworkConnection,
  joinNetworkConnection,
  startOwnedNetworkLogin,
  openOwnedNetworkAuthorization,
  pollOwnedNetworkLogin,
  cancelOwnedNetworkLogin,
  removeNetworkConnection,
  networkConnections,
  networkErrorKey,
  restoreOwnedCredentials,
  cancelOwnedCredentialRestore,
  type NetworkRegistry,
} from "@/api/agentNetwork";
import { acceptNetworkRegistry } from "./store";
import { JoinNetworkDialog } from "./JoinNetworkDialog";
import { APP_BUILD_PROFILE } from "../../../shared/appProfile";

// The owned edition's page heading belongs to NetworkHeader; this label keeps
// the actual connection identity and switching controls separate from branding.
const NetworkLabel = APP_BUILD_PROFILE === "moxbot" ? "div" : "h1";
const networkLabelClass = APP_BUILD_PROFILE === "moxbot"
  ? "min-w-0 text-sm font-medium"
  : "min-w-0 text-2xl font-semibold";
export function NetworkSelector({ registry }: { registry: NetworkRegistry }) {
  const { t } = useTranslation("app");
  return registry.selfhostEnabled === true ? (
    <NetworkSwitcher registry={registry} />
  ) : (
    <NetworkLabel className={networkLabelClass}>{t("agentNetwork.networkName")}</NetworkLabel>
  );
}
function NetworkSwitcher({ registry }: { registry: NetworkRegistry }) {
  const { t } = useTranslation("app");
  const toast = useToastOptional();
  const anchor = useRef<HTMLButtonElement>(null);
  const restoreCloseButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [join, setJoin] = useState(false),
    [ownedLoginTarget, setOwnedLoginTarget] = useState<{
      connectionId: string;
      url: string;
      principalId: string;
      authGeneration: number;
    } | null>(null),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [restoreOpen, setRestoreOpen] = useState(false),
    [restoreBusy, setRestoreBusy] = useState(false),
    [restoreTargetId, setRestoreTargetId] = useState<string | null>(null),
    [restoreExpectedRevision, setRestoreExpectedRevision] =
      useState<number | null>(null),
    [restoreExpectedAuthGeneration, setRestoreExpectedAuthGeneration] =
      useState<number | null>(null),
    [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreOperation = useRef<{
    operationId: string;
    connectionId: string;
    expectedRegistryRevision: number;
    authGeneration: number;
  } | null>(null);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownedLoginGeneration = useRef(0);
  const pendingOwnedLoginAttempt = useRef<string | null>(null);
  const completedOwnedLoginAttempt = useRef(false);
  const current =
    registry.connections.find((c) => c.id === registry.selected) ??
    registry.connections[0];
  const selectedConnection = registry.connections.find(
    (connection) => connection.id === registry.selected,
  );
  const restoreConnection = registry.connections.find(
    (connection) => connection.id === restoreTargetId,
  );
  const restoreConnectionId = restoreConnection?.id ?? null;
  const restoreAuthGeneration = restoreConnection?.snapshot.authGeneration ?? null;
  const restoreState = restoreConnection?.snapshot.state ?? null;
  const restoreErrorCode = restoreConnection?.snapshot.error?.code ?? null;
  const restoreRemoving = restoreConnection?.removing ?? false;
  const restoreOfficial = restoreConnection?.official ?? false;
  const restoreEligible = Boolean(
    selectedConnection &&
      !selectedConnection.official &&
      !selectedConnection.removing &&
      selectedConnection.snapshot.error?.code ===
        "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED" &&
      Number.isSafeInteger(registry.revision),
  );
  const selectedOwnedNeedsLogin = Boolean(
    selectedConnection &&
      !selectedConnection.official &&
      !selectedConnection.removing &&
      selectedConnection.ownedAccount?.state === "signInRequired",
  );
  const selectedOwnedLoginUrl = selectedConnection?.url ?? null;
  const ownedLoginTargetIsCurrent = Boolean(
    ownedLoginTarget &&
      selectedConnection &&
      selectedConnection.id === ownedLoginTarget.connectionId &&
      selectedConnection.url === ownedLoginTarget.url &&
      (selectedConnection.ownedAccount?.principalId ?? "") === ownedLoginTarget.principalId &&
      selectedConnection.snapshot.authGeneration === ownedLoginTarget.authGeneration,
  );
  const restoreCanContinue = Boolean(
    selectedConnection &&
      selectedConnection.id === restoreTargetId &&
      !selectedConnection.official &&
      !selectedConnection.removing &&
      Number.isSafeInteger(registry.revision) &&
      registry.revision === restoreExpectedRevision &&
      selectedConnection.snapshot.authGeneration ===
        restoreExpectedAuthGeneration,
  );
  const name = current?.official
    ? t("agentNetwork.networkName")
    : current?.name;
  const error = (failure: unknown) =>
    t(`agentNetwork.errors.${networkErrorKey(failure)}`);
  const closeRestore = useCallback(() => {
    setRestoreOpen(false);
    setRestoreTargetId(null);
    setRestoreExpectedRevision(null);
    setRestoreExpectedAuthGeneration(null);
    setRestoreError(null);
    if (restoreTimer.current) clearTimeout(restoreTimer.current);
    restoreTimer.current = null;
    const active = restoreOperation.current;
    if (active) {
      restoreOperation.current = null;
      setRestoreBusy(false);
      void cancelOwnedCredentialRestore(active.operationId).catch(() => {
        // The Rust generation fence still rejects any late result.
      });
    }
    anchor.current?.focus();
  }, []);
  async function authorizeAndRestore() {
    if (
      !selectedConnection ||
      selectedConnection.id !== restoreTargetId ||
      !restoreCanContinue ||
      restoreBusy ||
      restoreExpectedRevision === null ||
      restoreExpectedAuthGeneration === null
    )
      return;
    const operation = {
      operationId: crypto.randomUUID(),
      connectionId: restoreTargetId,
      expectedRegistryRevision: restoreExpectedRevision,
      authGeneration: restoreExpectedAuthGeneration,
    };
    restoreOperation.current = operation;
    setRestoreBusy(true);
    setRestoreError(null);
    restoreTimer.current = setTimeout(() => {
      restoreTimer.current = null;
      if (restoreOperation.current !== operation) return;
      restoreOperation.current = null;
      setRestoreBusy(false);
      setRestoreError(t("agentNetwork.ownedCredentialRestore.timeout"));
      void cancelOwnedCredentialRestore(operation.operationId).catch(() => {});
    }, 180_000);
    try {
      const next = await restoreOwnedCredentials({
        connectionId: operation.connectionId,
        expectedRegistryRevision: operation.expectedRegistryRevision,
        operationId: operation.operationId,
      });
      if (restoreOperation.current !== operation) return;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
      restoreOperation.current = null;
      setRestoreBusy(false);
      setRestoreOpen(false);
      setRestoreTargetId(null);
      setRestoreExpectedRevision(null);
      setRestoreExpectedAuthGeneration(null);
      anchor.current?.focus();
      acceptNetworkRegistry(next);
    } catch (failure) {
      if (restoreOperation.current !== operation) return;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
      restoreOperation.current = null;
      setRestoreBusy(false);
      setRestoreError(error(failure));
    }
  }
  useEffect(() => {
    const active = restoreOperation.current;
    if (
      active &&
      registry.selected === active.connectionId &&
      restoreConnectionId === active.connectionId &&
      restoreAuthGeneration === active.authGeneration &&
      restoreState === "ready" &&
      restoreErrorCode !== "NETWORK_CREDENTIAL_STORE_AUTHORIZATION_REQUIRED"
    ) {
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
      restoreOperation.current = null;
      setRestoreBusy(false);
      setRestoreOpen(false);
      setRestoreTargetId(null);
      setRestoreExpectedRevision(null);
      setRestoreExpectedAuthGeneration(null);
      setRestoreError(null);
      anchor.current?.focus();
      return;
    }
    if (
      restoreOpen &&
      (restoreTargetId === null ||
        registry.selected !== restoreTargetId ||
        registry.revision !== restoreExpectedRevision ||
        restoreAuthGeneration !== restoreExpectedAuthGeneration ||
        restoreOfficial ||
        restoreRemoving ||
        !restoreConnectionId)
    ) {
      closeRestore();
    }
  }, [
    restoreOpen,
    restoreTargetId,
    restoreExpectedRevision,
    restoreExpectedAuthGeneration,
    registry.selected,
    registry.revision,
    restoreConnectionId,
    restoreAuthGeneration,
    restoreState,
    restoreErrorCode,
    restoreRemoving,
    restoreOfficial,
    closeRestore,
  ]);
  useEffect(() => {
    if (!restoreOpen) return;
    restoreCloseButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRestore();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [restoreOpen, closeRestore]);
  useEffect(
    () => () => {
      ownedLoginGeneration.current += 1;
      const pendingLogin = pendingOwnedLoginAttempt.current;
      pendingOwnedLoginAttempt.current = null;
      if (pendingLogin && !completedOwnedLoginAttempt.current)
        void cancelOwnedNetworkLogin(pendingLogin).catch(() => {});
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
      const active = restoreOperation.current;
      restoreOperation.current = null;
      if (active)
        void cancelOwnedCredentialRestore(active.operationId).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!ownedLoginTarget || ownedLoginTargetIsCurrent) return;
    setOwnedLoginTarget(null);
    const pending = pendingOwnedLoginAttempt.current;
    pendingOwnedLoginAttempt.current = null;
    if (completedOwnedLoginAttempt.current) {
      completedOwnedLoginAttempt.current = false;
      return;
    }
    ownedLoginGeneration.current += 1;
    if (pending) void cancelOwnedNetworkLogin(pending).catch(() => {});
  }, [ownedLoginTarget, ownedLoginTargetIsCurrent]);
  function openOwnedLogin() {
    if (
      !selectedOwnedNeedsLogin ||
      !selectedConnection ||
      !selectedOwnedLoginUrl
    )
      return;
    setOpen(false);
    ownedLoginGeneration.current += 1;
    completedOwnedLoginAttempt.current = false;
    pendingOwnedLoginAttempt.current = null;
    setOwnedLoginTarget({
      connectionId: selectedConnection.id,
      url: selectedOwnedLoginUrl,
      principalId: selectedConnection.ownedAccount?.principalId ?? "",
      authGeneration: selectedConnection.snapshot.authGeneration,
    });
  }
  async function select(id: string) {
    if (restoreOperation.current || restoreOpen) closeRestore();
    setOpen(false);
    try {
      acceptNetworkRegistry(await selectNetworkConnection(id));
    } catch (failure) {
      toast?.error(error(failure));
    }
  }
  async function removeCurrent() {
    if (!current || busy) return;
    setBusy(true);
    try {
      acceptNetworkRegistry(await removeNetworkConnection(current.id));
      setRemove(false);
    } catch (failure) {
      toast?.error(error(failure));
      try {
        acceptNetworkRegistry(await networkConnections());
      } catch {
        /* Preserve the last confirmed projection. */
      }
      setRemove(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <NetworkLabel className={networkLabelClass}>
        <button
          ref={anchor}
          type="button"
          className="flex max-w-[30rem] items-center gap-2 rounded-md text-left hover:text-[var(--ink-secondary)]"
          aria-label={t("agentNetwork.chooseNetwork")}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="truncate">{name}</span>
          <ChevronDownIcon className="h-4 w-4 shrink-0" />
        </button>
      </NetworkLabel>
      {selectedOwnedNeedsLogin && (
        <button
          type="button"
          disabled={!selectedOwnedLoginUrl || ownedLoginTarget !== null}
          className="mt-2 self-start rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
          onClick={openOwnedLogin}
        >
          {t("agentNetwork.ownedLogin.signInAgain")}
        </button>
      )}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        className="min-w-64 max-w-sm p-1.5"
      >
        <div role="menu" aria-label={t("agentNetwork.chooseNetwork")}>
          {registry.connections.map((c) => (
            <button
              key={c.id}
              role="menuitemradio"
              aria-checked={registry.selected === c.id}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[var(--hover-bg)]"
              onClick={() => {
                void select(c.id);
              }}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${c.snapshot.state === "ready" && !c.removing ? "bg-emerald-600" : "bg-[var(--ink-subtle)]"}`}
              />
              <span className="min-w-0 flex-1 truncate">
                {c.official ? t("agentNetwork.officialNetwork") : c.name}
              </span>
              <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                {t(
                  c.removing
                    ? "agentNetwork.removalPending"
                    : c.snapshot.state === "ready"
                      ? "agentNetwork.online"
                      : c.snapshot.state === "connecting"
                        ? "agentNetwork.connecting"
                        : "agentNetwork.offline",
                )}
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-[var(--line-subtle)]" />
          <button
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-[var(--hover-bg)]"
            onClick={() => {
              setOpen(false);
              setJoin(true);
            }}
          >
            <PlusIcon className="h-4 w-4" />
            {t("agentNetwork.joinSelfhost")}
          </button>
          {current && !current.official && (
            <button
              role="menuitem"
              className="w-full rounded-md px-3 py-2.5 text-left text-sm text-[var(--error)] hover:bg-[var(--hover-bg)]"
              onClick={() => {
                setOpen(false);
                setRemove(true);
              }}
            >
              {t(
                current.removing
                  ? "agentNetwork.retryRemove"
                  : "agentNetwork.removeConnection",
              )}
            </button>
          )}
          {restoreEligible && selectedConnection && (
            <button
              role="menuitem"
              className="w-full rounded-md px-3 py-2.5 text-left text-sm hover:bg-[var(--hover-bg)]"
              onClick={() => {
                setOpen(false);
                setRestoreError(null);
                setRestoreTargetId(selectedConnection.id);
                setRestoreExpectedRevision(registry.revision!);
                setRestoreExpectedAuthGeneration(
                  selectedConnection.snapshot.authGeneration,
                );
                setRestoreOpen(true);
              }}
            >
              {t("agentNetwork.ownedCredentialRestore.open")}
            </button>
          )}
          {selectedOwnedNeedsLogin && selectedConnection && (
            <button
              role="menuitem"
              disabled={!selectedOwnedLoginUrl}
              className="w-full rounded-md px-3 py-2.5 text-left text-sm hover:bg-[var(--hover-bg)] disabled:opacity-50"
              onClick={openOwnedLogin}
            >
              {selectedOwnedLoginUrl ? t("ownedAccountEntry.signIn") : t("ownedAccountEntry.unconfigured")}
            </button>
          )}
        </div>
      </Popover>
      {restoreOpen && restoreConnection && (
        <OverlayBackdrop
          onClose={restoreBusy ? undefined : closeRestore}
          className="z-[300] px-4"
          portal
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="owned-credential-restore-title"
            className="glass-panel w-full max-w-md"
          >
            <div className="border-b border-[var(--line)] px-5 py-4">
              <h2
                id="owned-credential-restore-title"
                className="text-lg font-semibold text-[var(--ink)]"
              >
                {t("agentNetwork.ownedCredentialRestore.title")}
              </h2>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-[var(--ink-muted)]">
              <p>
                {t("agentNetwork.ownedCredentialRestore.target", {
                  name: restoreConnection.name,
                  issuer: safeIssuerDisplay(restoreConnection.url),
                })}
              </p>
              <p>{t("agentNetwork.ownedCredentialRestore.explanation")}</p>
              <p>{t("agentNetwork.ownedCredentialRestore.systemPrompt")}</p>
              {restoreError && (
                <p role="alert" className="text-[var(--error)]">
                  {restoreError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
              <button
                ref={restoreCloseButton}
                type="button"
                onClick={closeRestore}
                className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
              >
                {restoreBusy
                  ? t("agentNetwork.ownedCredentialRestore.cancel")
                  : t("agentNetwork.ownedCredentialRestore.close")}
              </button>
              <button
                type="button"
                onClick={() => void authorizeAndRestore()}
                disabled={restoreBusy || !restoreCanContinue}
                className="rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
              >
                {restoreBusy
                  ? t("agentNetwork.ownedCredentialRestore.working")
                  : t("agentNetwork.ownedCredentialRestore.confirm")}
              </button>
            </div>
          </div>
        </OverlayBackdrop>
      )}
      {join && (
        <JoinNetworkDialog
          onCancel={() => setJoin(false)}
          onConfirm={async (url, key) => {
            try {
              acceptNetworkRegistry(await joinNetworkConnection(url, key));
            } catch (failure) {
              throw Error(error(failure));
            }
          }}
          onOwnedStart={async (issuer, publicTlsCaFile) => {
            try {
              return await startOwnedNetworkLogin(issuer, publicTlsCaFile);
            } catch (failure) {
              throw Error(error(failure));
            }
          }}
          onOwnedOpen={async (attemptId) => {
            try {
              await openOwnedNetworkAuthorization(attemptId);
            } catch (failure) {
              throw Error(error(failure));
            }
          }}
          onOwnedPoll={async (attemptId) => {
            try {
              const result = await pollOwnedNetworkLogin(attemptId);
              if (result.status === "reauthorize") return result.authorization;
              if (result.status === "authenticated") {
                acceptNetworkRegistry(result.registry);
                return "authenticated";
              }
              return "pending";
            } catch (failure) {
              throw Error(error(failure));
            }
          }}
          onOwnedCancel={async (attemptId) => {
            try {
              await cancelOwnedNetworkLogin(attemptId);
            } catch (failure) {
              throw Error(error(failure));
            }
          }}
        />
      )}
      {ownedLoginTarget && (
        <JoinNetworkDialog
          accountOnly
          initialUrl={ownedLoginTarget.url}
          title={t("ownedAccountEntry.loginTitle")}
          onCancel={() => {
            ownedLoginGeneration.current += 1;
            pendingOwnedLoginAttempt.current = null;
            setOwnedLoginTarget(null);
          }}
          onConfirm={async () => { throw Error(t("agentNetwork.errors.failed")); }}
          onOwnedStart={async (issuer, ca) => {
            const generation = ownedLoginGeneration.current;
            try {
              const attempt = await startOwnedNetworkLogin(issuer, ca);
              if (generation !== ownedLoginGeneration.current || !ownedLoginTargetIsCurrent) {
                await cancelOwnedNetworkLogin(attempt.attemptId).catch(() => {});
                throw Error(t("agentNetwork.errors.failed"));
              }
              pendingOwnedLoginAttempt.current = attempt.attemptId;
              completedOwnedLoginAttempt.current = false;
              return attempt;
            }
            catch (failure) { throw Error(error(failure)); }
          }}
          onOwnedOpen={async (attemptId) => {
            try { await openOwnedNetworkAuthorization(attemptId); }
            catch (failure) { throw Error(error(failure)); }
          }}
          onOwnedCancel={async (attemptId) => {
            ownedLoginGeneration.current += 1;
            pendingOwnedLoginAttempt.current = null;
            try { await cancelOwnedNetworkLogin(attemptId); }
            catch {
              // End locally and allow a new attempt; the old server attempt expires on its own.
            }
          }}
          onOwnedPoll={async (attemptId) => {
            const generation = ownedLoginGeneration.current;
            try {
              const result = await pollOwnedNetworkLogin(attemptId);
              if (generation !== ownedLoginGeneration.current) return "pending";
              if (result.status === "reauthorize") return result.authorization;
              if (result.status !== "authenticated") return "pending";
              const next = result.registry;
              pendingOwnedLoginAttempt.current = null;
              completedOwnedLoginAttempt.current = true;
              const matching = next.connections.find((connection) =>
                connection.id === next.selected && !connection.official && !connection.removing && connection.url === ownedLoginTarget.url,
              );
              if (matching) {
                const selected = await selectNetworkConnection(matching.id);
                if (generation === ownedLoginGeneration.current) acceptNetworkRegistry(selected);
              } else if (generation === ownedLoginGeneration.current) {
                acceptNetworkRegistry(next);
              }
              return "authenticated";
            } catch (failure) { throw Error(error(failure)); }
          }}
        />
      )}
      {remove && current && (
        <ConfirmDialog
          title={t("agentNetwork.removeConnection")}
          message={t(
            current.removing
              ? "agentNetwork.retryRemoveMessage"
              : "agentNetwork.removeConnectionMessage",
            { name: current.name },
          )}
          confirmText={t("agentNetwork.removeConnection")}
          confirmVariant="danger"
          loading={busy}
          onCancel={() => {
            if (!busy) setRemove(false);
          }}
          onConfirm={() => {
            void removeCurrent();
          }}
        />
      )}
    </>
  );
}

function safeIssuerDisplay(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}
