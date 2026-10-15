import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { InfoIcon, LockIcon } from "@/components/icons";
import Popover from "@/components/ui/Popover";
import { APP_BUILD_PROFILE } from "../../../shared/appProfile";

/** Header geometry belongs to the page, regardless of account or directory readiness. */
export function NetworkHeader({
  selector,
  deviceCount = null,
  agentCount = null,
}: {
  selector: ReactNode;
  deviceCount?: number | null;
  agentCount?: number | null;
}) {
  const { t } = useTranslation("app");
  const infoButton = useRef<HTMLButtonElement>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <header className="mb-6 flex shrink-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-full">
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          {APP_BUILD_PROFILE === "moxbot" ? (
            <h1 className="min-w-0 text-2xl font-semibold">{t("agentNetwork.pageTitle")}</h1>
          ) : selector}
          <button
            type="button"
            ref={infoButton}
            aria-label={t("agentNetwork.networkInfo")}
            aria-expanded={infoOpen}
            aria-controls="agent-network-explanation"
            onClick={() => setInfoOpen((value) => !value)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <InfoIcon className="h-4 w-4" />
          </button>
          <Popover
            open={infoOpen}
            onClose={() => setInfoOpen(false)}
            anchorRef={infoButton}
            className="max-w-xs space-y-1.5 px-4 py-3 text-xs leading-relaxed text-[var(--ink-secondary)]"
          >
            <div id="agent-network-explanation">
              <h2 className="flex items-center gap-1.5 font-medium text-[var(--ink)]">
                <LockIcon className="h-3.5 w-3.5 shrink-0" />
                {t("agentNetwork.infoTitle")}
              </h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-4">
                <li>{t("agentNetwork.infoIntro")}</li>
                <li>{t("agentNetwork.infoRelay")}</li>
                <li>{t("agentNetwork.infoLocal")}</li>
              </ul>
            </div>
          </Popover>
        </div>
        {APP_BUILD_PROFILE === "moxbot" && (
          <>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">{t("agentNetwork.welcome")}</p>
            <div className="mt-3 min-w-0">{selector}</div>
          </>
        )}
      </div>

      <dl className="flex shrink-0 gap-6">
        <div>
          <dd className="text-xl font-semibold leading-tight">
            {deviceCount ?? "—"}
          </dd>
          <dt className="text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.statDevices")}
          </dt>
        </div>
        <div>
          <dd className="text-xl font-semibold leading-tight">
            {agentCount ?? "—"}
          </dd>
          <dt className="text-xs text-[var(--ink-muted)]">
            {t("agentNetwork.statAgents")}
          </dt>
        </div>
      </dl>
    </header>
  );
}
