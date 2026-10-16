import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  networkConnections,
  selectNetworkConnection,
} from "@/api/agentNetwork";
import {
  useAgentNetworkRegistry,
  acceptNetworkRegistry,
} from "@/features/agent-network/store";
import {
  ownedAccountCandidates,
  selectedOwnedAccount,
} from "@/features/account/ownedAccountSelection";
import { canonicalOwnedIssuer } from "@/utils/ownedCloud";
import CommunityPage from "./CommunityPage";

/** Uses the same account selection as the personal menu, independent of relay readiness. */
export default function CommunityContainer({
  onOpenAccount,
}: {
  onOpenAccount?: () => void;
}) {
  const { t } = useTranslation("community");
  const registry = useAgentNetworkRegistry();
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [selectionError, setSelectionError] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const account = selectedOwnedAccount(registry);
  const candidates = ownedAccountCandidates(registry);
  const identity = account?.ownedAccount;
  useEffect(() => {
    let active = true;
    const refresh = () => {
      setNow(Date.now() / 1000);
      void networkConnections()
        .then((next) => {
          if (active) acceptNetworkRegistry(next);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  if (
    account &&
    identity?.state === "authenticated" &&
    identity.bindingId &&
    (identity.expiresAt == null || identity.expiresAt > now)
  ) {
    const scope = {
      connectionId: account.id,
      principalId: identity.principalId,
      bindingId: identity.bindingId,
    };
    return <CommunityPage key={JSON.stringify(scope)} scope={scope} />;
  }
  const configured = Boolean(canonicalOwnedIssuer(registry.ownedServiceUrl));
  return (
    <section className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center text-[var(--ink)]">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="max-w-md text-sm text-[var(--ink-muted)]">
        {t(
          !configured
            ? "unconfigured"
            : !account && candidates.length > 1
              ? "chooseAccount"
              : "accountRequired",
        )}
      </p>
      {!account && candidates.length > 1 && (
        <div className="flex max-w-md flex-col gap-2">
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              disabled={selecting}
              className="rounded-lg border border-[var(--line)] px-4 py-2 hover:bg-[var(--hover-bg)]"
              onClick={() => {
                setSelecting(true);
                setSelectionError(false);
                void selectNetworkConnection(candidate.id)
                  .then(acceptNetworkRegistry)
                  .catch(() => setSelectionError(true))
                  .finally(() => setSelecting(false));
              }}
            >
              {candidate.name} ·{" "}
              {candidate.ownedAccount?.principalId.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
      {selectionError && (
        <p role="alert" className="text-sm text-[var(--ink-muted)]">
          {t("readFailed")}
        </p>
      )}
      {configured && (
        <button
          type="button"
          disabled={!onOpenAccount}
          className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-[var(--button-primary-text)] disabled:opacity-60"
          onClick={onOpenAccount}
        >
          {t("manageAccount")}
        </button>
      )}
    </section>
  );
}
