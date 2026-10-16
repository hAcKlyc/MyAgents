import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  HelperIcon,
  LoaderIcon,
  LogOutIcon,
  UserIcon,
} from "@/components/icons";
import { canonicalOwnedIssuer } from '@/utils/ownedCloud';
import { openExternal } from "@/utils/openExternal";
import { Popover } from "@/components/ui/Popover";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  networkConnections,
  openOwnedNetworkAuthorization,
  pollOwnedNetworkLogin,
  removeNetworkConnection,
  selectNetworkConnection,
  startOwnedNetworkLogin,
  cancelOwnedNetworkLogin,
  type NetworkConnection,
  type NetworkRegistry,
} from "@/api/agentNetwork";
import {
  acceptNetworkRegistry,
  useAgentNetworkRegistry,
} from "@/features/agent-network/store";
import { JoinNetworkDialog } from "@/features/agent-network/JoinNetworkDialog";

export { canonicalOwnedIssuer } from '@/utils/ownedCloud';

function ownedConnection(
  registry: NetworkRegistry,
  issuer: string | null,
): NetworkConnection | null {
  if (!issuer) return null;
  const connections = registry.connections;
  const eligible = connections.filter(
    (item) =>
      !item.official &&
      !item.removing &&
      item.ownedAccount &&
      canonicalOwnedIssuer(item.url) === issuer,
  );
  const selected = connections.find(
    (item) =>
      item.id === registry.selected &&
      !item.official &&
      !item.removing &&
      item.ownedAccount &&
      canonicalOwnedIssuer(item.url) === issuer,
  );
  return selected ?? eligible[0] ?? null;
}

export default function OwnedAccountEntry({
  expanded,
  onOpenAgentNetwork,
  onOpenHelper,
}: {
  expanded: boolean;
  onOpenAgentNetwork?: () => void;
  onOpenHelper?: () => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const registry = useAgentNetworkRegistry();
  const serviceUrl = canonicalOwnedIssuer(registry.ownedServiceUrl);
  const owned = ownedConnection(registry, serviceUrl);
  const state = owned?.ownedAccount?.state;
  const principalId = owned?.ownedAccount?.principalId ?? "";
  const expiresAt = owned?.ownedAccount?.expiresAt ?? null;
  const snapshotState = owned?.snapshot.state ?? null;
  const snapshotAuthGeneration = owned?.snapshot.authGeneration ?? null;
  const snapshotErrorCode = owned?.snapshot.error?.code ?? null;
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const logoutBoundary = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const openedLoginGeneration = useRef(0);
  const projectionSequence = useRef(0);
  const projectionBoundary = JSON.stringify([
    serviceUrl,
    owned?.id ?? null,
    principalId,
    owned?.snapshot.authGeneration ?? null,
  ]);
  const loginBoundary = JSON.stringify([
    serviceUrl,
    owned?.id ?? null,
    principalId,
    owned?.snapshot.authGeneration ?? null,
    state,
  ]);
  const currentProjectionBoundary = useRef(projectionBoundary);
  currentProjectionBoundary.current = projectionBoundary;
  const previousLoginBoundary = useRef(loginBoundary);
  const pendingAttemptId = useRef<string | null>(null);
  const completedAttempt = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      const pending = pendingAttemptId.current;
      pendingAttemptId.current = null;
      if (pending && !completedAttempt.current)
        void cancelOwnedNetworkLogin(pending).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!expanded || !serviceUrl) return;
    const sequence = ++projectionSequence.current;
    const boundary = projectionBoundary;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void networkConnections()
        .then((next) => {
          if (
            !active ||
            !mounted.current ||
            sequence !== projectionSequence.current ||
            currentProjectionBoundary.current !== boundary ||
            canonicalOwnedIssuer(next.ownedServiceUrl) !== serviceUrl
          )
            return;
          acceptNetworkRegistry(next);
        })
        .catch(() => {
          // Keep the last confirmed account projection during transient network errors.
        });
    };
    refresh();
    if (
      state === "authenticated" &&
      expiresAt !== null &&
      Number.isFinite(expiresAt)
    ) {
      const refreshAtExpiry = () => {
        const delay = expiresAt * 1000 - Date.now();
        if (delay <= 0) refresh();
        else
          timer = setTimeout(refreshAtExpiry, Math.min(delay, 2_147_000_000));
      };
      refreshAtExpiry();
    }
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (projectionSequence.current === sequence)
        projectionSequence.current += 1;
    };
  }, [
    expanded,
    serviceUrl,
    projectionBoundary,
    state,
    expiresAt,
    snapshotState,
    snapshotAuthGeneration,
    snapshotErrorCode,
  ]);

  useEffect(() => {
    if (previousLoginBoundary.current === loginBoundary) return;
    previousLoginBoundary.current = loginBoundary;
    setLoginOpen(false);
    setMenuOpen(false);
    setLogoutOpen(false);
    logoutBoundary.current = null;
    const pending = pendingAttemptId.current;
    pendingAttemptId.current = null;
    if (completedAttempt.current) {
      // The authenticated poll changed the account boundary; let its selection finish.
      completedAttempt.current = false;
      return;
    }
    generation.current += 1;
    openedLoginGeneration.current = generation.current;
    if (pending) void cancelOwnedNetworkLogin(pending).catch(() => {});
  }, [loginBoundary]);

  const startLogin = () => {
    if (!serviceUrl) return;
    generation.current += 1;
    openedLoginGeneration.current = generation.current;
    setLoginOpen(true);
  };
  const closeLogin = () => {
    generation.current += 1;
    setLoginOpen(false);
  };
  const loginEpochIsCurrent = (epoch: number) =>
    mounted.current && generation.current === epoch;
  const selectRecoveredConnection = async () => {
    if (!owned || !onOpenAgentNetwork) return;
    setBusy(true);
    try {
      acceptNetworkRegistry(await selectNetworkConnection(owned.id));
      onOpenAgentNetwork();
    } catch (failure) {
      toast.error(
        failure instanceof Error
          ? failure.message
          : t("ownedAccountEntry.failed"),
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const logout = async () => {
    if (!owned || busy) return;
    if (logoutBoundary.current !== currentProjectionBoundary.current) {
      setLogoutOpen(false);
      logoutBoundary.current = null;
      return;
    }
    setBusy(true);
    try {
      acceptNetworkRegistry(await removeNetworkConnection(owned.id));
      setLogoutOpen(false);
    } catch (failure) {
      toast.error(
        failure instanceof Error
          ? failure.message
          : t("ownedAccountEntry.failed"),
      );
      try {
        acceptNetworkRegistry(await networkConnections());
      } catch {
        /* Keep the last confirmed state. */
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const openFeedback = async () => {
    if (!serviceUrl) return;
    try {
      await openExternal(`${serviceUrl}/feedback`);
      setMenuOpen(false);
    } catch {
      toast.error(t("ownedAccountEntry.feedbackFailed"));
    }
  };

  const label =
    state === "authenticated"
      ? t("ownedAccountEntry.signedInAs", {
          instance: owned?.name ?? t("ownedAccountEntry.instance"),
          account: principalId.slice(0, 8) || t("ownedAccountEntry.account"),
        })
      : state === "authorizationRequired"
        ? t("ownedAccountEntry.restore")
        : state === "unavailable"
          ? t("ownedAccountEntry.unavailable")
          : serviceUrl
            ? t("ownedAccountEntry.signIn")
            : t("ownedAccountEntry.unconfigured");

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={busy}
        onClick={() => setMenuOpen((value) => !value)}
        aria-label={expanded ? undefined : t("ownedAccountEntry.menu")}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        className={`global-sidebar-row relative flex h-8 min-w-0 items-center text-left text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60 ${expanded ? "" : "w-10 justify-center"}`}
        data-owned-account-trigger
        data-global-account-trigger
      >
        <span
          className={`${expanded ? "absolute left-3" : ""} flex h-4 w-4 shrink-0 items-center justify-center`}
        >
          {busy ? (
            <LoaderIcon className="h-4 w-4 animate-spin" />
          ) : (
            <UserIcon className="h-4 w-4" />
          )}
        </span>
        {expanded && (
          <span className="global-sidebar-label min-w-0 flex-1 truncate pl-10 pr-3">
            {label}
          </span>
        )}
      </button>
      {
        <Popover
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={trigger}
          placement="top-start"
          className="w-72 p-3"
        >
          <div
            role="dialog"
            aria-label={t("ownedAccountEntry.menu")}
            className="space-y-2 text-sm"
          >
            <strong className="block truncate">
              {owned?.name ?? t("ownedAccountEntry.instance")}
            </strong>
            {state === "authenticated" && (
              <p className="text-xs text-[var(--ink-muted)]">
                {t("ownedAccountEntry.accountId", {
                  account: principalId.slice(0, 8),
                })}
              </p>
            )}
            {state === "authenticated" && (
              <p className="text-xs text-[var(--ink-muted)]">
                {t("ownedAccountEntry.signedInOfflineSafe")}
              </p>
            )}
            {state !== "authenticated" && (
              <button
                type="button"
                disabled={
                  !serviceUrl ||
                  busy ||
                  (state === "authorizationRequired" && !onOpenAgentNetwork)
                }
                className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--hover-bg)] disabled:opacity-60"
                onClick={() => {
                  setMenuOpen(false);
                  if (state === "authorizationRequired")
                    void selectRecoveredConnection();
                  else if (state === "unavailable") onOpenAgentNetwork?.();
                  else startLogin();
                }}
              >
                {label}
              </button>
            )}
            <button
              type="button"
              disabled={!onOpenHelper}
              onClick={() => {
                setMenuOpen(false);
                onOpenHelper?.();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-[var(--hover-bg)] disabled:opacity-60"
            >
              <HelperIcon className="h-4 w-4" />
              {t("globalSidebar.helper")}
            </button>
            <button
              type="button"
              disabled={!serviceUrl}
              onClick={() => void openFeedback()}
              className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--hover-bg)] disabled:opacity-60"
            >
              {t("titlebar.feedbackTitle")}
            </button>
            {state === "authenticated" && (
              <button
                type="button"
                onClick={() => void selectRecoveredConnection()}
                className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--hover-bg)]"
                disabled={!onOpenAgentNetwork || busy}
              >
                {t("ownedAccountEntry.openNetwork")}
              </button>
            )}
            {state === "authenticated" && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  logoutBoundary.current = projectionBoundary;
                  setLogoutOpen(true);
                }}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[var(--error)] hover:bg-[var(--hover-bg)]"
              >
                <LogOutIcon className="h-4 w-4" />
                {t("ownedAccountEntry.signOut")}
              </button>
            )}
          </div>
        </Popover>
      }
      {loginOpen && state !== "authenticated" && serviceUrl && (
        <JoinNetworkDialog
          accountOnly
          initialUrl={serviceUrl}
          title={t("ownedAccountEntry.loginTitle")}
          onCancel={closeLogin}
          onConfirm={async () => {
            throw new Error(t("ownedAccountEntry.failed"));
          }}
          onOwnedStart={async (issuer, ca) => {
            const epoch = openedLoginGeneration.current;
            const attempt = await startOwnedNetworkLogin(issuer, ca);
            if (!loginEpochIsCurrent(epoch)) {
              await cancelOwnedNetworkLogin(attempt.attemptId).catch(() => {});
              throw new Error(t("ownedAccountEntry.failed"));
            }
            pendingAttemptId.current = attempt.attemptId;
            completedAttempt.current = false;
            return attempt;
          }}
          onOwnedOpen={(attemptId) => openOwnedNetworkAuthorization(attemptId)}
          onOwnedCancel={async (attemptId) => {
            generation.current += 1;
            pendingAttemptId.current = null;
            try {
              await cancelOwnedNetworkLogin(attemptId);
            } catch {
              // End locally and allow a new attempt; the old server attempt expires on its own.
            }
          }}
          onOwnedPoll={async (attemptId) => {
            const epoch = openedLoginGeneration.current;
            const result = await pollOwnedNetworkLogin(attemptId);
            if (!loginEpochIsCurrent(epoch)) return "pending";
            if (result.status === "reauthorize") return result.authorization;
            if (result.status !== "authenticated") return "pending";
            const next = result.registry;
            pendingAttemptId.current = null;
            completedAttempt.current = true;
            acceptNetworkRegistry(next);
            const match = next.connections.find(
              (connection) =>
                connection.id === next.selected &&
                !connection.official &&
                !connection.removing &&
                canonicalOwnedIssuer(connection.url) === serviceUrl,
            );
            if (match) {
              const selected = await selectNetworkConnection(match.id);
              if (loginEpochIsCurrent(epoch)) acceptNetworkRegistry(selected);
            }
            return "authenticated";
          }}
        />
      )}
      {logoutOpen && owned && logoutBoundary.current === projectionBoundary && (
        <ConfirmDialog
          title={t("ownedAccountEntry.signOut")}
          message={t("ownedAccountEntry.signOutMessage", { name: owned.name })}
          confirmText={t("ownedAccountEntry.confirmSignOut")}
          confirmVariant="danger"
          loading={busy}
          onCancel={() => {
            if (!busy) {
              setLogoutOpen(false);
              logoutBoundary.current = null;
            }
          }}
          onConfirm={() => {
            void logout();
          }}
        />
      )}
    </>
  );
}
