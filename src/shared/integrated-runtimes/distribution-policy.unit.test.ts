import { describe, expect, it } from "vitest";

import {
  AGENT_RUNTIME_DISTRIBUTION_POLICY,
  isRuntimeSelectorAvailable,
  parseAgentRuntimeDistributionPolicy,
  resolveDefaultIntegratedRuntime,
} from "./distribution-policy";

describe("Agent Runtime distribution policy", () => {
  it("loads the fully available product policy", () => {
    expect(AGENT_RUNTIME_DISTRIBUTION_POLICY).toEqual({
      schemaVersion: 1,
      allowedIntegratedRuntimes: ["claude-agent-sdk", "dsh"],
      allowedExternalRuntimes: ["claude-code", "codex", "antigravity"],
      defaultIntegratedRuntime: "claude-agent-sdk",
      selectorAvailability: "always",
    });
    expect(
      isRuntimeSelectorAvailable(AGENT_RUNTIME_DISTRIBUTION_POLICY),
    ).toBe(true);
  });

  it("accepts a valid DSH-only hidden distribution", () => {
    expect(
      parseAgentRuntimeDistributionPolicy({
        schemaVersion: 1,
        allowedIntegratedRuntimes: ["dsh"],
        allowedExternalRuntimes: [],
        defaultIntegratedRuntime: "dsh",
        selectorAvailability: "hidden",
      }),
    ).toMatchObject({
      allowedIntegratedRuntimes: ["dsh"],
      defaultIntegratedRuntime: "dsh",
      selectorAvailability: "hidden",
    });
  });

  it("accepts only an allowed default override", () => {
    expect(
      resolveDefaultIntegratedRuntime(
        AGENT_RUNTIME_DISTRIBUTION_POLICY,
        "dsh",
      ),
    ).toBe("dsh");
    expect(
      resolveDefaultIntegratedRuntime(
        AGENT_RUNTIME_DISTRIBUTION_POLICY,
        "future-runtime",
      ),
    ).toBe("claude-agent-sdk");
    expect(
      resolveDefaultIntegratedRuntime(
        parseAgentRuntimeDistributionPolicy({
          schemaVersion: 1,
          allowedIntegratedRuntimes: ["dsh"],
          allowedExternalRuntimes: [],
          defaultIntegratedRuntime: "dsh",
          selectorAvailability: "hidden",
        }),
        "claude-agent-sdk",
      ),
    ).toBe("dsh");
  });

  it("rejects unknown, duplicate, empty, and inconsistent policy", () => {
    const base = {
      schemaVersion: 1,
      allowedIntegratedRuntimes: ["claude-agent-sdk"],
      allowedExternalRuntimes: ["codex"],
      defaultIntegratedRuntime: "claude-agent-sdk",
      selectorAvailability: "always",
    };
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedIntegratedRuntimes: [],
      }),
    ).toThrow(/invalid Integrated/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedExternalRuntimes: ["codex", "codex"],
      }),
    ).toThrow(/invalid External/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedExternalRuntimes: ["gemini"],
      }),
    ).toThrow(/invalid External/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        defaultIntegratedRuntime: "dsh",
      }),
    ).toThrow(/must be allowed/);
    expect(() =>
      parseAgentRuntimeDistributionPolicy({
        ...base,
        allowedIntegratedRuntimes: ["pi"],
        defaultIntegratedRuntime: "pi",
      }),
    ).toThrow(/invalid Integrated/);
  });
});
