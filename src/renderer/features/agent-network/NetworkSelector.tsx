import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDownIcon, PlusIcon } from "@/components/icons";
import Popover from "@/components/ui/Popover";
import ConfirmDialog from "@/components/ConfirmDialog";
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
  type NetworkRegistry,
} from "@/api/agentNetwork";
import { acceptNetworkRegistry } from "./store";
import { JoinNetworkDialog } from "./JoinNetworkDialog";
export function NetworkSelector({ registry }: { registry: NetworkRegistry }) {
  const { t } = useTranslation("app");
  return registry.selfhostEnabled === true ? (
    <NetworkSwitcher registry={registry} />
  ) : (
    <h1 className="min-w-0 text-2xl font-semibold">{t("agentNetwork.networkName")}</h1>
  );
}
function NetworkSwitcher({ registry }: { registry: NetworkRegistry }) {
  const { t } = useTranslation("app");
  const toast = useToastOptional();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [join, setJoin] = useState(false),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false);
  const current =
    registry.connections.find((c) => c.id === registry.selected) ??
    registry.connections[0];
  const name = current?.official
    ? t("agentNetwork.networkName")
    : current?.name;
  const error = (failure: unknown) =>
    t(`agentNetwork.errors.${networkErrorKey(failure)}`);
  async function select(id: string) {
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
      <h1 className="min-w-0 text-2xl font-semibold">
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
      </h1>
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
        </div>
      </Popover>
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
