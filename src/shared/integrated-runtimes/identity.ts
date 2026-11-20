import packageJson from "../../../package.json";
import { CODEX_SUBSCRIPTION_PROVIDER_ID } from "../config-types";
import managedCodexRuntimeLock from "../managed-codex-runtime.json";
import type { RuntimeSource, RuntimeType } from "../types/runtime";
import dshLock from "./effective-dsh-lock";

export const CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION = packageJson.dependencies["@anthropic-ai/claude-agent-sdk"];

export const INTEGRATED_RUNTIME_IDS = ["claude-agent-sdk", "dsh"] as const;
export type IntegratedRuntimeId = (typeof INTEGRATED_RUNTIME_IDS)[number];

export const EXTERNAL_RUNTIME_IDS = ["claude-code", "codex", "antigravity"] as const;
export type ExternalRuntimeId = (typeof EXTERNAL_RUNTIME_IDS)[number];

export type AgentRuntimePreference =
  | { family: "integrated"; id: IntegratedRuntimeId }
  | { family: "external"; id: ExternalRuntimeId };

export type EffectiveRuntimeBinding =
  | {
      family: "integrated";
      id: "claude-agent-sdk";
      implementationVersion: string;
    }
  | {
      family: "integrated";
      id: "dsh";
      implementationVersion: string;
      protocolVersion: string;
      protocolSchemaSha256: string;
      runtimeArtifactSha256: string;
      compatibilityManifestSha256: string;
      sessionFormat: string;
      platformTarget: string;
    }
  | {
      family: "managed-provider";
      id: "managed-codex";
      providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
      implementationVersion: string;
    }
  | {
      family: "external";
      id: ExternalRuntimeId;
      implementationVersion?: string;
    };

export type RuntimeBindingCompatibilityCode =
  | "invalid-runtime-binding"
  | "unknown-legacy-runtime"
  | "illegal-legacy-runtime-source"
  | "legacy-managed-provider-without-codex-proof";

export type RuntimeBindingCompatibility = {
  state: "incompatible";
  code: RuntimeBindingCompatibilityCode;
  message: string;
};

export type PersistedRuntimeBindingResolution =
  | {
      status: "resolved";
      binding: EffectiveRuntimeBinding;
      migratedFromLegacy: boolean;
    }
  | {
      status: "incompatible";
      compatibility: RuntimeBindingCompatibility;
    };

export type LegacyRuntimeBindingFacts = {
  runtimeBinding?: unknown;
  runtime?: RuntimeType | string;
  runtimeSource?: RuntimeSource | string;
  providerId?: string;
  providerExecutionIdentity?: {
    kind?: unknown;
    providerId?: unknown;
    runtime?: unknown;
    runtimeSource?: unknown;
  };
};

export type LegacyRuntimeProjection = {
  runtime: RuntimeType;
  runtimeSource?: RuntimeSource;
};

export type LegacyAgentRuntimePreferenceFacts = {
  runtime?: unknown;
  runtimeSource?: unknown;
  providerId?: unknown;
  defaultIntegratedRuntime?: IntegratedRuntimeId;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isExternalRuntimeId(value: unknown): value is ExternalRuntimeId {
  return EXTERNAL_RUNTIME_IDS.includes(value as ExternalRuntimeId);
}

function incompatibility(
  code: RuntimeBindingCompatibilityCode,
  message: string,
): PersistedRuntimeBindingResolution {
  return {
    status: "incompatible",
    compatibility: { state: "incompatible", code, message },
  };
}

export function parseAgentRuntimePreference(
  value: unknown,
): AgentRuntimePreference | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.family === "integrated" &&
    INTEGRATED_RUNTIME_IDS.includes(value.id as IntegratedRuntimeId)
  ) {
    return { family: "integrated", id: value.id as IntegratedRuntimeId };
  }
  if (value.family === "external" && isExternalRuntimeId(value.id)) {
    return { family: "external", id: value.id };
  }
  return undefined;
}

/**
 * Convert only legal historical Agent shapes. Managed Codex was a Provider
 * constraint, not an External Codex preference, so its legacy projection maps
 * back to the default Integrated preference and is constrained again by the
 * Provider resolver. Unknown combinations remain invalid instead of silently
 * becoming Claude SDK.
 */
export function preferenceFromLegacyAgentFacts(
  facts: LegacyAgentRuntimePreferenceFacts,
): AgentRuntimePreference | undefined {
  const runtime = facts.runtime ?? (facts.defaultIntegratedRuntime === "dsh" ? "dsh" : "builtin");
  const source = facts.runtimeSource;
  if (runtime === "builtin") {
    return source === undefined
      ? { family: "integrated", id: "claude-agent-sdk" }
      : undefined;
  }
  if (runtime === "dsh") {
    return source === undefined || source === "integrated"
      ? { family: "integrated", id: "dsh" }
      : undefined;
  }
  if (!isExternalRuntimeId(runtime)) return undefined;
  if (
    runtime === "codex" &&
    source === "managed-provider" &&
    facts.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID
  ) {
    return { family: "integrated", id: "claude-agent-sdk" };
  }
  return { family: "external", id: runtime };
}

export function resolveAgentRuntimePreference(facts: {
  runtimePreference?: unknown;
  runtime?: unknown;
  runtimeSource?: unknown;
  providerId?: unknown;
  defaultIntegratedRuntime?: IntegratedRuntimeId;
}): AgentRuntimePreference | undefined {
  if (facts.runtimePreference !== undefined) {
    return parseAgentRuntimePreference(facts.runtimePreference);
  }
  return preferenceFromLegacyAgentFacts(facts);
}

/**
 * Build the authoritative Agent preference together with the legacy Runtime
 * projection used by older readers. Runtime selection writers must persist
 * both values atomically so a migrated Agent cannot display one Runtime while
 * a Sidecar resolves another.
 */
export function agentRuntimePreferenceForRuntime(
  runtime: RuntimeType,
): AgentRuntimePreference {
  if (runtime === "builtin") {
    return { family: "integrated", id: "claude-agent-sdk" };
  }
  if (runtime === "dsh") {
    return { family: "integrated", id: "dsh" };
  }
  return { family: "external", id: runtime };
}

export function runtimeTypeForAgentRuntimePreference(
  preference: AgentRuntimePreference,
): RuntimeType {
  if (preference.family === "external") return preference.id;
  return preference.id === "dsh" ? "dsh" : "builtin";
}

export function createClaudeSdkBinding(): EffectiveRuntimeBinding {
  return {
    family: "integrated",
    id: "claude-agent-sdk",
    implementationVersion: CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION,
  };
}

/** Native startup and Product Session birth must accept the same host targets. */
export function resolveDshPlatformTarget(
  platform: string,
  arch: string,
): "darwin-arm64" | "darwin-x64" | "win32-x64" | "linux-x64" {
  const target = `${platform}-${arch}`;
  if (target === "darwin-arm64" || target === "darwin-x64" || target === "win32-x64" || target === "linux-x64") {
    return target;
  }
  throw new Error(`DSH has no accepted platform target for ${target}`);
}

export function createDshBinding(
  platformTarget: string,
): EffectiveRuntimeBinding {
  if (!isNonEmptyString(platformTarget)) {
    throw new Error("DSH binding requires a platform target");
  }
  return {
    family: "integrated",
    id: "dsh",
    implementationVersion: dshLock.runtime.version,
    protocolVersion: dshLock.protocol.version,
    protocolSchemaSha256: dshLock.protocol.schemaSha256,
    runtimeArtifactSha256: dshLock.handoff.runtimeManifestSha256,
    compatibilityManifestSha256: dshLock.handoff.compatibilitySha256,
    sessionFormat: dshLock.runtime.sessionFormat,
    platformTarget,
  };
}

export function createManagedCodexBinding(): EffectiveRuntimeBinding {
  return {
    family: "managed-provider",
    id: "managed-codex",
    providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    implementationVersion: managedCodexRuntimeLock.version,
  };
}

export function parseEffectiveRuntimeBinding(
  value: unknown,
): EffectiveRuntimeBinding | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.family === "integrated" &&
    value.id === "claude-agent-sdk" &&
    isNonEmptyString(value.implementationVersion)
  ) {
    return {
      family: "integrated",
      id: "claude-agent-sdk",
      implementationVersion: value.implementationVersion,
    };
  }
  if (
    value.family === "integrated" &&
    value.id === "dsh" &&
    isNonEmptyString(value.implementationVersion) &&
    isNonEmptyString(value.protocolVersion) &&
    isNonEmptyString(value.protocolSchemaSha256) &&
    isNonEmptyString(value.runtimeArtifactSha256) &&
    isNonEmptyString(value.compatibilityManifestSha256) &&
    isNonEmptyString(value.sessionFormat) &&
    isNonEmptyString(value.platformTarget)
  ) {
    return {
      family: "integrated",
      id: "dsh",
      implementationVersion: value.implementationVersion,
      protocolVersion: value.protocolVersion,
      protocolSchemaSha256: value.protocolSchemaSha256,
      runtimeArtifactSha256: value.runtimeArtifactSha256,
      compatibilityManifestSha256: value.compatibilityManifestSha256,
      sessionFormat: value.sessionFormat,
      platformTarget: value.platformTarget,
    };
  }
  if (
    value.family === "managed-provider" &&
    value.id === "managed-codex" &&
    value.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID &&
    isNonEmptyString(value.implementationVersion)
  ) {
    return {
      family: "managed-provider",
      id: "managed-codex",
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
      implementationVersion: value.implementationVersion,
    };
  }
  if (
    value.family === "external" &&
    isExternalRuntimeId(value.id) &&
    (value.implementationVersion === undefined ||
      isNonEmptyString(value.implementationVersion))
  ) {
    return {
      family: "external",
      id: value.id,
      ...(value.implementationVersion
        ? { implementationVersion: value.implementationVersion }
        : {}),
    };
  }
  return undefined;
}

function legacyHasManagedCodexProof(facts: LegacyRuntimeBindingFacts): boolean {
  const identity = facts.providerExecutionIdentity;
  return (
    facts.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID ||
    (identity?.kind === "runtime-backed-provider" &&
      identity.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID &&
      identity.runtime === "codex" &&
      identity.runtimeSource === "managed-provider")
  );
}

export function resolvePersistedRuntimeBinding(
  facts: LegacyRuntimeBindingFacts,
): PersistedRuntimeBindingResolution {
  if (facts.runtimeBinding !== undefined) {
    const parsed = parseEffectiveRuntimeBinding(facts.runtimeBinding);
    return parsed
      ? { status: "resolved", binding: parsed, migratedFromLegacy: false }
      : incompatibility(
          "invalid-runtime-binding",
          "Session has an invalid authoritative runtimeBinding.",
        );
  }

  const runtime = facts.runtime ?? "builtin";
  const source = facts.runtimeSource;
  const managedCodexProof = legacyHasManagedCodexProof(facts);

  if (runtime === "builtin") {
    if (source === undefined && managedCodexProof) {
      return {
        status: "resolved",
        binding: createManagedCodexBinding(),
        migratedFromLegacy: true,
      };
    }
    if (source === undefined) {
      return {
        status: "resolved",
        binding: createClaudeSdkBinding(),
        migratedFromLegacy: true,
      };
    }
    if (source === "managed-provider" && !managedCodexProof) {
      return incompatibility(
        "legacy-managed-provider-without-codex-proof",
        "Legacy builtin/managed-provider Session has no managed Codex proof.",
      );
    }
    return incompatibility(
      "illegal-legacy-runtime-source",
      `Legacy builtin Session cannot use runtimeSource ${source}.`,
    );
  }

  if (!isExternalRuntimeId(runtime)) {
    return incompatibility(
      "unknown-legacy-runtime",
      `Unknown legacy runtime ${String(runtime)}.`,
    );
  }

  if (runtime === "codex" && source === "managed-provider") {
    return {
      status: "resolved",
      binding: createManagedCodexBinding(),
      migratedFromLegacy: true,
    };
  }
  if (source === undefined || source === "system-cli") {
    return {
      status: "resolved",
      binding: { family: "external", id: runtime },
      migratedFromLegacy: true,
    };
  }
  return incompatibility(
    "illegal-legacy-runtime-source",
    `Legacy ${runtime} Session cannot use runtimeSource ${source}.`,
  );
}

export function legacyProjectionForBinding(
  binding: EffectiveRuntimeBinding,
): LegacyRuntimeProjection {
  if (binding.family === "external") {
    return { runtime: binding.id, runtimeSource: "system-cli" };
  }
  if (binding.family === "managed-provider") {
    return { runtime: "codex", runtimeSource: "managed-provider" };
  }
  return binding.id === "dsh"
    ? { runtime: "dsh", runtimeSource: "integrated" }
    : { runtime: "builtin" };
}

/** Runtime implementation selected by an authoritative binding, independent of its legacy projection. */
export function runtimeTypeForBinding(binding: EffectiveRuntimeBinding): RuntimeType {
  if (binding.family === "external") return binding.id;
  if (binding.family === "managed-provider") return "codex";
  return binding.id === "dsh" ? "dsh" : "builtin";
}

export function runtimeSourceForBinding(binding: EffectiveRuntimeBinding): RuntimeSource | undefined {
  if (binding.family === "external") return "system-cli";
  if (binding.family === "managed-provider") return "managed-provider";
  return binding.id === "dsh" ? "integrated" : undefined;
}

export function runtimeBindingKey(binding: EffectiveRuntimeBinding): string {
  switch (binding.family) {
    case "integrated":
      return `integrated:${binding.id}:${binding.implementationVersion}`;
    case "managed-provider":
      return `managed-provider:${binding.id}:${binding.implementationVersion}`;
    case "external":
      return `external:${binding.id}:${binding.implementationVersion ?? "system"}`;
  }
}
