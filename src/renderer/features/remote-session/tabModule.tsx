import { readRemoteOperation } from "./drafts";
import { lazy, memo, Suspense } from "react";
import { z } from "zod";
import type {
  TabPersistenceCodec,
  TabModuleDefinition,
} from "@/tab-workspace/contracts";
import { PAGE_FALLBACK } from "@/tab-workspace/PageFallback";
import { remoteScopeSchema } from "@/api/remoteSession";
import {
  remoteTabIdentity,
  type RemoteSessionTab,
  type RemoteSessionOpenIntent,
  type RemoteSessionBinding,
} from "./tabContract";
const Page = lazy(() => import("./RemoteSession"));
const Renderer = memo(function RemoteSessionRenderer({
  tab,
  isActive,
  isDeferred,
  binding,
}: {
  tab: RemoteSessionTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: RemoteSessionBinding;
}) {
  return isDeferred ? (
    PAGE_FALLBACK
  ) : (
    <Suspense fallback={PAGE_FALLBACK}>
      <Page tab={tab} isActive={isActive} binding={binding} />
    </Suspense>
  );
});
const wire = z
  .object({
    view: z.literal("remote-session"),
    id: z.string().min(1).max(256),
    locator: z
      .object({
        connectionId: z
          .string()
          .min(1)
          .max(256)
          .refine((v) => v !== "official"),
        principalId: z.string().min(1).max(256),
        networkId: z.string().min(1).max(256),
        deviceId: z.string().min(1).max(256),
        authGeneration: z.number().int().nonnegative(),
      })
      .strict(),
    agentId: z.string().min(1).max(256),
    sessionId: z
      .string()
      .min(1)
      .max(99)
      .regex(/^[A-Za-z0-9-]+$/)
      .nullable(),
    targetScope: remoteScopeSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.targetScope.principalId === value.locator.principalId &&
      value.targetScope.networkId === value.locator.networkId &&
      value.targetScope.deviceId === value.locator.deviceId,
  );
export type PersistedRemoteSessionTab = z.infer<typeof wire>;
export const remoteSessionTabPersistenceCodec: TabPersistenceCodec<
  RemoteSessionTab,
  PersistedRemoteSessionTab
> = {
  serialize: (tab) => {
    if (!tab.targetScope || (!tab.sessionId && !readRemoteOperation(tab)))
      return null;
    return {
      view: "remote-session",
      id: tab.id,
      locator: tab.locator,
      agentId: tab.agentId,
      sessionId: tab.sessionId,
      targetScope: tab.targetScope,
    };
  },
  parse: (value) => {
    const parsed = wire.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  hydrate: (value) => ({
    ...value,
    title: value.agentId,
    agentName: value.agentId,
    deviceName: value.locator.deviceId,
  }),
  resourceIdentity: remoteTabIdentity,
};
export const remoteSessionTabModule = {
  kind: "remote-session",
  render: Renderer,
  chrome: (tab) => ({
    title: tab.title || tab.agentName,
    subtitle: `${tab.deviceName} · ${tab.agentName}`,
  }),
  identity: remoteTabIdentity,
  open: {
    findExisting: (tabs, intent) =>
      tabs.find(
        (tab) =>
          remoteTabIdentity(tab) ===
          remoteTabIdentity({
            locator: intent.locator,
            agentId: intent.agentId,
            sessionId: intent.sessionId ?? null,
          }),
      ),
    create: (intent, { id }) => ({
      id,
      view: "remote-session",
      ...intent,
      sessionId: intent.sessionId ?? null,
      targetScope: intent.targetScope ?? null,
    }),
  },
  initialMount: () => "deferred-content",
  persistence: remoteSessionTabPersistenceCodec,
} satisfies TabModuleDefinition<
  RemoteSessionTab,
  RemoteSessionOpenIntent,
  RemoteSessionBinding,
  PersistedRemoteSessionTab
>;
