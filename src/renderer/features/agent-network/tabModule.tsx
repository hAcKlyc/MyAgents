import { lazy, memo, Suspense } from "react";
import type { AgentNetworkTab } from "./tabContract";
import type { TabModuleDefinition } from "@/tab-workspace/contracts";
import { PAGE_FALLBACK } from "@/tab-workspace/PageFallback";
const AgentNetwork = lazy(() => import("@/pages/AgentNetwork"));
const Renderer = memo(function AgentNetworkTabRenderer({
  isActive,
  isDeferred,
  binding,
}: {
  tab: AgentNetworkTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: { onOpenRemoteSession: import('@/features/remote-session/tabContract').RemoteSessionBinding['onOpen'] };
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      <AgentNetwork isActive={isActive} onOpenRemoteSession={binding.onOpenRemoteSession} />
    </Suspense>
  );
});
export const agentNetworkTabModule = {
  kind: "agentnetwork",
  render: Renderer,
  chrome: (_tab, { t }) => ({
    title: t("tabs.agentNetwork"),
    subtitle: t("tabs.agentNetwork"),
  }),
  identity: () => "agentnetwork",
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: "agentnetwork",
      title: intent.title,
    }),
  },
  initialMount: () => "deferred-content",
} satisfies TabModuleDefinition<AgentNetworkTab, { title: string }, { onOpenRemoteSession: import('@/features/remote-session/tabContract').RemoteSessionBinding['onOpen'] }>;
