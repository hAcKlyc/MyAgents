import { afterEach, describe, expect, it, vi } from "vitest";
const managementApi = vi.hoisted(() => vi.fn());
vi.mock("../utils/management-api-client", () => ({ managementApi }));
import { deliverNetworkReturn } from "./return";
import type { SendResultEvent } from "../inbox/session-event";

const reference = {
  opId: "00000000-0000-0000-0000-000000000001",
  returnRouteId: "00000000-0000-0000-0000-000000000002",
};
const event: SendResultEvent = {
  version: 1,
  type: "send.result",
  eventId: "00000000-0000-0000-0000-000000000003",
  requestEventId: "00000000-0000-0000-0000-000000000004",
  sourceSessionId: "target-session",
  targetSessionId: "remote-source",
  status: "ok",
  createdAt: "2026-10-01T00:00:00.000Z",
  payload: "result",
};
afterEach(() => {
  vi.unstubAllEnvs();
  managementApi.mockReset();
  vi.restoreAllMocks();
});
describe("terminal return transport", () => {
  it("requires the original live Sidecar and sends an opaque reference to the App", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "");
    expect(await deliverNetworkReturn(reference, event)).toBe("dropped");
    expect(managementApi).not.toHaveBeenCalled();
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar-1");
    managementApi.mockResolvedValue({ ok: true, settlement: "delivered" });
    expect(await deliverNetworkReturn(reference, event)).toBe("delivered");
    expect(managementApi).toHaveBeenCalledWith(
      "/api/agent-network/return",
      "POST",
      {
        sidecarId: "sidecar-1",
        reference,
        event,
      },
      { timeoutMs: 32_000 },
    );
  });
  it("keeps transport ambiguity separate from a dropped route without retrying", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar-1");
    managementApi
      .mockResolvedValueOnce({ ok: false, code: "transport_outcome_unknown" })
      .mockResolvedValueOnce({ ok: false, code: "RETURN_ROUTE_LOST" });
    expect(await deliverNetworkReturn(reference, event)).toBe("unconfirmed");
    expect(await deliverNetworkReturn(reference, event)).toBe("dropped");
    expect(managementApi).toHaveBeenCalledTimes(2);
  });
  it.each([
    [{ ok: false, error: { code: "CONNECTOR_NOT_READY", details: "private error" } }, "dropped", "CONNECTOR_NOT_READY"],
    [{ ok: false, error: { code: "RETURN_CONTEXT_LOST" } }, "dropped", "RETURN_CONTEXT_LOST"],
    [{ ok: false, code: "transport_outcome_unknown", error: "private transport error" }, "unconfirmed", "transport_outcome_unknown"],
    [{ ok: true, settlement: "delivered" }, "delivered", "none"],
  ])("records callback submission and settlement without private content: %j", async (response, settlement, code) => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar-1");
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    managementApi.mockResolvedValue(response);
    expect(await deliverNetworkReturn(reference, { ...event, payload: "private result" })).toBe(settlement);
    const logs = [...info.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(logs).toContain("stage=submit");
    expect(logs).toContain(`stage=settle settlement=${settlement} code=${code}`);
    expect(logs).toContain(`op_id=${reference.opId}`);
    expect(logs).toContain(`event_id=${event.eventId}`);
    expect(logs).toContain(`request_event_id=${event.requestEventId}`);
    expect(logs).not.toContain("private");
  });
  it("never logs malformed callbacks or free-form rejection text", async () => {
    vi.stubEnv("MYAGENTS_SIDECAR_ID", "sidecar-1");
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await deliverNetworkReturn(reference, { ...event, eventId: "private\nresult" })).toBe("dropped");
    managementApi.mockResolvedValue({ ok: false, error: { code: "private\nresult", details: "private result" } });
    expect(await deliverNetworkReturn(reference, event)).toBe("dropped");
    const logs = [...info.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(logs).toContain("code=RETURN_EVENT_INVALID");
    expect(logs).toContain("code=RETURN_REJECTED");
    expect(logs).not.toContain("private");
  });
});
