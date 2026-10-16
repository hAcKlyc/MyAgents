import { lazy, memo, Suspense } from "react";
import { APP_BUILD_PROFILE } from "@/../shared/appProfile";

import type { SpaceTab } from "@/features/space/tabContract";
import type { TabModuleDefinition } from "@/tab-workspace/contracts";
import { PAGE_FALLBACK } from "@/tab-workspace/PageFallback";
import type { PendingAppRoute } from "@/../shared/appRoute";

const Community = lazy(() => import("@/features/community/CommunityContainer"));
const Space = lazy(() => import("@/pages/Space"));

export interface SpaceOpenIntent {
  title: string;
  navigationIntent?: PendingAppRoute;
}

export interface SpaceRenderBinding {
  onRouteConsumed: (tabId: string, generation: number) => void;
  onOpenAccount?: () => void;
}

const SpaceTabRenderer = memo(function SpaceTabRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: SpaceTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: SpaceRenderBinding;
}) {
  if (isDeferred) return PAGE_FALLBACK;
  return (
    <Suspense fallback={PAGE_FALLBACK}>
      {APP_BUILD_PROFILE === "moxbot" ? (
        <Community onOpenAccount={binding.onOpenAccount} />
      ) : (
        <Space
          isActive={isActive}
          pendingRoute={tab.navigationIntent ?? null}
          onRouteConsumed={(generation) =>
            binding.onRouteConsumed(tab.id, generation)
          }
        />
      )}
    </Suspense>
  );
});

export const spaceTabModule = {
  kind: "space",
  render: SpaceTabRenderer,
  chrome: (_tab, { t }) => ({
    title: t(APP_BUILD_PROFILE === "moxbot" ? "globalSidebar.community" : "tabs.team"),
    subtitle: t(APP_BUILD_PROFILE === "moxbot" ? "globalSidebar.community" : "tabs.team"),
  }),
  identity: () => "space",
  open: {
    findExisting: (tabs) => tabs[0],
    create: (intent, { id }) => ({
      id,
      view: "space",
      title: intent.title,
      ...(intent.navigationIntent
        ? { navigationIntent: intent.navigationIntent }
        : {}),
    }),
    reopen: (tab, intent) =>
      intent.navigationIntent
        ? { ...tab, navigationIntent: intent.navigationIntent }
        : tab,
  },
  initialMount: () => "deferred-content",
} satisfies TabModuleDefinition<SpaceTab, SpaceOpenIntent, SpaceRenderBinding>;
