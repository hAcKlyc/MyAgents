import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import RuntimeSelector from "@/components/RuntimeSelector";
import {
  normalizeChatQueueResponseMode,
  type AppConfig,
  type ChatQueueResponseMode,
} from "@/config/types";
import type { RuntimeDetections } from "../../../../shared/types/runtime";
import {
  AGENT_RUNTIME_DISTRIBUTION_POLICY,
  defaultIntegratedRuntimeType,
} from "../../../../shared/integrated-runtimes/distribution-policy";

interface AgentFunctionSettingsProps {
  config: Pick<AppConfig, "defaultIntegratedRuntime" | "chatQueueResponseMode">;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;
}

export default function AgentFunctionSettings({
  config,
  updateConfig,
}: AgentFunctionSettingsProps) {
  const { t: tSettings } = useTranslation("settings");
  const [detections, setDetections] = useState<RuntimeDetections>({
    builtin: { installed: true },
    dsh: { installed: false },
    antigravity: { installed: false },
    "claude-code": { installed: false },
    codex: { installed: false },
  });
  useEffect(() => {
    let active = true;
    void invoke<RuntimeDetections>("cmd_detect_runtimes")
      .then((result) => {
        if (active) setDetections(result);
      })
      .catch((error) =>
        console.error("[runtime] Default environment detection failed:", error),
      );
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
      <h3 className="text-base font-medium text-[var(--ink)]">
        {tSettings("general.agentFeaturesTitle")}
      </h3>
      <div className="mt-4 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--ink)]">
            {tSettings("general.defaultRuntimeTitle")}
          </p>
          <p className="text-xs text-[var(--ink-muted)]">
            {tSettings("general.defaultRuntimeDescription")}
          </p>
        </div>
        <div className="w-72 max-w-[45%] shrink-0">
          <RuntimeSelector
            value={defaultIntegratedRuntimeType(
              AGENT_RUNTIME_DISTRIBUTION_POLICY,
              config.defaultIntegratedRuntime,
            )}
            detections={detections}
            variant="panel"
            integratedOnly
            onChange={(runtime) =>
              void updateConfig({
                defaultIntegratedRuntime:
                  runtime === "dsh" ? "dsh" : "claude-agent-sdk",
              })
            }
          />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-[var(--line)] pt-4">
        <div className="flex-1">
          <p className="text-sm font-medium text-[var(--ink)]">
            {tSettings("general.queueModeTitle")}
          </p>
          <p className="text-xs text-[var(--ink-muted)]">
            {normalizeChatQueueResponseMode(config.chatQueueResponseMode) ===
            "turn"
              ? tSettings("general.queueTurnDescription")
              : tSettings("general.queueRealtimeDescription")}
          </p>
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
          {(
            [
              {
                value: "realtime",
                label: tSettings("general.queueRealtime"),
              },
              {
                value: "turn",
                label: tSettings("general.queueTurn"),
              },
            ] as const satisfies ReadonlyArray<{
              value: ChatQueueResponseMode;
              label: string;
            }>
          ).map((opt) => {
            const active =
              normalizeChatQueueResponseMode(config.chatQueueResponseMode) ===
              opt.value;
            return (
              <button
                key={opt.value}
                onClick={() =>
                  void updateConfig({
                    chatQueueResponseMode: opt.value,
                  })
                }
                className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                  active
                    ? "bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
