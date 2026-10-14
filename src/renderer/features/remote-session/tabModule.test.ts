const pendingMock = vi.hoisted(() => ({ present: false }));
vi.mock("./drafts", () => ({
  readRemoteOperation: () =>
    pendingMock.present
      ? {
          operationId: "11111111-1111-4111-8111-111111111111",
          kind: "start",
          status: "unconfirmed",
        }
      : null,
}));
import { expect, it, vi } from "vitest";
import { remoteSessionTabModule } from "./tabModule";
const locator = {
  connectionId: "owned:test",
  principalId: "p",
  networkId: "n",
  deviceId: "d",
  authGeneration: 4,
};
const targetScope = {
  serviceId: "s",
  environment: "e",
  principalId: "p",
  networkId: "n",
  deviceId: "d",
  keyGeneration: 2,
};
const intent = {
  title: "private session title",
  locator,
  agentId: "a",
  agentName: "private name",
  deviceName: "private device",
  sessionId: "s",
  targetScope,
};
it("persisted remote tabs contain only source locator, signed target and session ID; drafts never persist", () => {
  const tab = remoteSessionTabModule.open.create(intent, { id: "tab" });
  expect(remoteSessionTabModule.persistence.serialize(tab)).toEqual({
    view: "remote-session",
    id: "tab",
    locator,
    agentId: "a",
    sessionId: "s",
    targetScope,
  });
  expect(
    remoteSessionTabModule.persistence.serialize({ ...tab, sessionId: null }),
  ).toBeNull();
  expect(
    remoteSessionTabModule.persistence.parse({
      ...remoteSessionTabModule.persistence.serialize(tab),
      messages: ["private"],
    }),
  ).toBeNull();
});
it("deduplicates per complete remote identity without colliding with another account or local session", () => {
  const tab = remoteSessionTabModule.open.create(intent, { id: "tab" });
  expect(remoteSessionTabModule.open.findExisting([tab], intent)).toEqual(tab);
  expect(
    remoteSessionTabModule.open.findExisting([tab], {
      ...intent,
      locator: { ...locator, principalId: "other" },
    }),
  ).toBeUndefined();
  expect(
    remoteSessionTabModule.open.findExisting([tab], {
      ...intent,
      locator: { ...locator, deviceId: "other" },
    }),
  ).toBeUndefined();
  expect(
    remoteSessionTabModule.open.findExisting([tab], {
      ...intent,
      sessionId: undefined,
    }),
  ).toBeUndefined();
});

it("restores a first-message draft locator when its durable operation remains unconfirmed", () => {
  const tab = remoteSessionTabModule.open.create(
    { ...intent, sessionId: undefined },
    { id: "pending-tab" },
  );
  pendingMock.present = true;
  const saved = remoteSessionTabModule.persistence.serialize(tab);
  expect(saved).toMatchObject({
    id: "pending-tab",
    view: "remote-session",
    sessionId: null,
    locator,
    targetScope,
  });
  const parsed = remoteSessionTabModule.persistence.parse(saved);
  expect(parsed).not.toBeNull();
  expect(remoteSessionTabModule.persistence.hydrate(parsed!)).toMatchObject({
    sessionId: null,
    locator,
  });
  pendingMock.present = false;
});
