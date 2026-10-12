import { describe, expect, it } from "vitest";
import {
  hostAddressKey,
  sameHostAddress,
  validHostProvider,
  validHostResourcePatch,
  hostInteractionKey,
  type HostResourceSnapshot,
} from "./hostManagement";

describe("Host UI identity and redacted Provider inputs", () => {
  it("isolates connections, accounts and target identity generations", () => {
    const address = {
      connectionId: "official",
      principalId: "human",
      authGeneration: 1,
      serviceId: "service",
      networkId: "network",
      deviceId: "host",
      targetIdentityGeneration: 2,
    };
    const values = [
      address,
      { ...address, connectionId: "selfhost" },
      { ...address, principalId: "other" },
      { ...address, authGeneration: 2 },
      { ...address, serviceId: "other-service" },
      { ...address, networkId: "other-network" },
      { ...address, deviceId: "other-host" },
      { ...address, targetIdentityGeneration: 3 },
    ];
    expect(new Set(values.map(hostAddressKey)).size).toBe(values.length);
    expect(sameHostAddress(address, { ...address })).toBe(true);
    for (const changed of values.slice(1))
      expect(sameHostAddress(address, changed)).toBe(false);
  });
  it("rejects endpoints carrying credentials, query secrets or controls and missing models", () => {
    const config = {
      baseUrl: "https://provider.example.invalid/v1",
      model: "model",
    };
    expect(validHostProvider(config)).toBe(true);
    for (const baseUrl of [
      "http://provider.invalid",
      "https://user:secret@provider.invalid",
      "https://provider.invalid?key=fixture",
      "https://provider.invalid#fixture",
      "https://provider.invalid/\n",
      "invalid",
    ])
      expect(validHostProvider({ ...config, baseUrl })).toBe(false);
    for (const model of [" ", "model\0", "x".repeat(161)])
      expect(validHostProvider({ ...config, model })).toBe(false);
  });
});

describe("Host page resource validation", () => {
  const resources = {
    roots: [{ id: "approved-root" }],
    runtimes: [{ id: "sdk" }],
    workspaces: [{ id: "workspace" }],
    agents: [{ id: "agent" }],
    mcpPresets: [{ id: "mcp-preset" }],
    skillSources: [{ id: "trusted-source" }],
  } as HostResourceSnapshot;
  it("requires declared roots and rejects traversal, absolute paths and controls", () => {
    const patch = {
      kind: "workspace.register" as const,
      rootId: "approved-root",
      relativePath: "project/subfolder",
      name: "Project",
    };
    expect(validHostResourcePatch(patch, resources)).toBe(true);
    for (const relativePath of [
      "/etc",
      "../outside",
      "a/../b",
      "a/./b",
      "a//b",
      "a\\b",
      "a\n",
      " ",
    ])
      expect(
        validHostResourcePatch({ ...patch, relativePath }, resources),
      ).toBe(false);
    expect(
      validHostResourcePatch({ ...patch, rootId: "untrusted" }, resources),
    ).toBe(false);
  });
  it("limits Agent runtime and extensions to Host-declared items", () => {
    expect(
      validHostResourcePatch(
        {
          kind: "agent.create",
          name: "Agent",
          workspaceId: "workspace",
          runtimeId: "sdk",
        },
        resources,
      ),
    ).toBe(true);
    expect(
      validHostResourcePatch(
        {
          kind: "agent.create",
          name: "Agent",
          workspaceId: "workspace",
          runtimeId: "other",
        },
        resources,
      ),
    ).toBe(false);
    expect(
      validHostResourcePatch(
        { kind: "agent.patch", name: "Agent", agentId: "other" },
        resources,
      ),
    ).toBe(false);
    expect(
      validHostResourcePatch(
        { kind: "mcp.configure", presetId: "other", enabled: true },
        resources,
      ),
    ).toBe(false);
    expect(
      validHostResourcePatch(
        { kind: "skill.configure", sourceId: "other", enabled: true },
        resources,
      ),
    ).toBe(false);
  });
  it("interaction identity includes every execution fence", () => {
    const base = {
      sessionId: "s",
      requestId: "r",
      turnId: "t",
      runtimeGeneration: 1,
    };
    expect(
      new Set(
        [
          base,
          { ...base, sessionId: "other" },
          { ...base, requestId: "other" },
          { ...base, turnId: "other" },
          { ...base, runtimeGeneration: 2 },
        ].map(hostInteractionKey),
      ).size,
    ).toBe(5);
  });
});
