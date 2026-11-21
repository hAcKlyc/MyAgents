import { describe, expect, it } from "vitest";

import { AGENT_RUNTIME_DISTRIBUTION_POLICY } from "./distribution-policy";
import {
  createClaudeSdkBinding,
  createDshBinding,
  createManagedCodexBinding,
} from "./identity";
import {
  resolveEffectiveRuntimeBinding,
  type RuntimeReadinessCatalog,
  type RuntimeResolutionInput,
} from "./resolver";

function readiness(
  dshState: RuntimeReadinessCatalog["integrated"]["dsh"] = {
    state: "ready",
  },
): RuntimeReadinessCatalog {
  return {
    integrated: {
      "claude-agent-sdk": { state: "ready" },
      dsh: dshState,
    },
    external: {
      antigravity: { state: "ready", implementationVersion: "1.5.13" },
      "claude-code": { state: "ready", implementationVersion: "1.0.0" },
      codex: { state: "ready", implementationVersion: "2.0.0" },
    },
    managedCodex: { state: "ready" },
    platformTarget: "darwin-arm64",
  };
}

function input(
  overrides: Partial<RuntimeResolutionInput> = {},
): RuntimeResolutionInput {
  return {
    policy: AGENT_RUNTIME_DISTRIBUTION_POLICY,
    providerConstraint: {
      kind: "portable",
      apiFamily: "anthropic-messages",
      credentialKind: "api-key",
    },
    readiness: readiness(),
    ...overrides,
  };
}

describe("central Runtime resolver", () => {
  it("returns an existing frozen binding without consulting Agent preference", () => {
    const existingBinding = createDshBinding("darwin-arm64");
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          existingBinding,
          agentPreference: { family: "external", id: "codex" },
        }),
      ),
    ).toEqual({
      status: "resolved",
      binding: existingBinding,
      decision: "existing-session",
      readiness: "ready",
    });
  });

  it("uses the distribution default for an Agent without a Runtime choice", () => {
    expect(
      resolveEffectiveRuntimeBinding(
        input({
        }),
      ),
    ).toEqual({
      status: "resolved",
      binding: createClaudeSdkBinding(),
      decision: "distribution-default",
      readiness: "ready",
    });
  });

  it("uses the configured default for an Agent without a Runtime choice", () => {
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          configuredDefaultIntegratedRuntime: "dsh",
        }),
      ),
    ).toMatchObject({
      status: "resolved",
      binding: { family: "integrated", id: "dsh" },
      decision: "distribution-default",
    });
  });

  it.each([
    ["claude-agent-sdk", "dsh"],
    ["dsh", "claude-agent-sdk"],
  ] as const)("keeps explicit %s when the default is %s", (id, defaultId) => {
    expect(resolveEffectiveRuntimeBinding(input({
      agentPreference: { family: "integrated", id },
      configuredDefaultIntegratedRuntime: defaultId,
    }))).toMatchObject({
      status: "resolved", binding: { family: "integrated", id }, decision: "selected-integrated",
    });
  });

  it("preserves an existing SDK Session when the default changes to DSH", () => {
    expect(resolveEffectiveRuntimeBinding(input({
      existingBinding: createClaudeSdkBinding(), configuredDefaultIntegratedRuntime: "dsh",
    }))).toMatchObject({ binding: createClaudeSdkBinding(), decision: "existing-session" });
  });

  it("lets an explicit External preference win over dormant Provider fields", () => {
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          agentPreference: { family: "external", id: "claude-code" },
          providerConstraint: {
            kind: "requires-managed-runtime",
            runtimeId: "managed-codex",
            providerId: "codex-sub",
          },
        }),
      ),
    ).toMatchObject({
      status: "resolved",
      binding: { family: "external", id: "claude-code" },
      decision: "explicit-external",
    });
  });

  it("fails closed for invalid authoritative or unknown legacy preferences", () => {
    expect(
      resolveEffectiveRuntimeBinding(
        input({ agentPreference: { family: "integrated", id: "pi" } }),
      ),
    ).toMatchObject({
      status: "failed",
      code: "runtime-preference-invalid",
    });
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          legacyAgentRuntime: "future-runtime",
          legacyAgentRuntimeSource: "managed-provider",
        }),
      ),
    ).toMatchObject({
      status: "failed",
      code: "runtime-preference-invalid",
    });
  });

  it("applies subscription Provider constraints after Integrated preference", () => {
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          agentPreference: { family: "integrated", id: "dsh" },
          providerConstraint: {
            kind: "requires-integrated-runtime",
            runtimeId: "claude-agent-sdk",
            providerId: "anthropic-sub",
          },
        }),
      ),
    ).toEqual({
      status: "resolved",
      binding: createClaudeSdkBinding(),
      decision: "provider-required-integrated",
      readiness: "ready",
    });
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          providerConstraint: {
            kind: "requires-managed-runtime",
            runtimeId: "managed-codex",
            providerId: "codex-sub",
          },
        }),
      ),
    ).toEqual({
      status: "resolved",
      binding: createManagedCodexBinding(),
      decision: "provider-required-managed",
      readiness: "ready",
    });
  });

  it("selects DSH only when exact readiness admits its target", () => {
    expect(
      resolveEffectiveRuntimeBinding(
        input({ agentPreference: { family: "integrated", id: "dsh" } }),
      ),
    ).toMatchObject({
      status: "resolved",
      binding: { family: "integrated", id: "dsh" },
      decision: "selected-integrated",
    });
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          agentPreference: { family: "integrated", id: "dsh" },
          readiness: readiness({
            state: "unavailable",
            reason: "platform-unverified",
          }),
        }),
      ),
    ).toEqual({
      status: "failed",
      code: "runtime-not-ready",
      runtimeKey: "integrated:dsh",
      message: "integrated:dsh is not ready: platform-unverified",
    });
  });

  it("requires an explicit developer override for unverified bytes", () => {
    const unverified = readiness({ state: "unverified-dev-runtime" });
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          agentPreference: { family: "integrated", id: "dsh" },
          readiness: unverified,
        }),
      ),
    ).toMatchObject({ status: "failed", code: "runtime-not-ready" });
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          agentPreference: { family: "integrated", id: "dsh" },
          readiness: unverified,
          allowUnverifiedDevRuntime: true,
        }),
      ),
    ).toMatchObject({
      status: "resolved",
      readiness: "unverified-dev-runtime",
    });
  });

  it("keeps excluded existing Sessions readable but refuses execution", () => {
    const dshOnlyPolicy = {
      schemaVersion: 1 as const,
      allowedIntegratedRuntimes: ["claude-agent-sdk" as const],
      allowedExternalRuntimes: [],
      defaultIntegratedRuntime: "claude-agent-sdk" as const,
      selectorAvailability: "hidden" as const,
    };
    expect(
      resolveEffectiveRuntimeBinding(
        input({
          policy: dshOnlyPolicy,
          existingBinding: createDshBinding("darwin-arm64"),
        }),
      ),
    ).toMatchObject({
      status: "failed",
      code: "runtime-not-allowed",
      runtimeKey: "integrated:dsh",
    });
  });
});
