import {
  ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  SUBSCRIPTION_PROVIDER_ID,
  XAI_SUBSCRIPTION_PROVIDER_ID,
  type Provider,
} from "../config-types";

export type DshApiFamily =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses";

export type ApiFamily = DshApiFamily;

export const OFFICIAL_DEEPSEEK_ANTHROPIC_BASE_URL =
  "https://api.deepseek.com/anthropic";

export type ProviderExecutionConstraint =
  | { kind: "portable"; apiFamily: ApiFamily; credentialKind: "api-key" | "host-managed-oauth" | "proxy-managed" }
  | {
      kind: "requires-integrated-runtime";
      runtimeId: "claude-agent-sdk";
      providerId: typeof SUBSCRIPTION_PROVIDER_ID | "anthropic-api";
    }
  | {
      kind: "requires-managed-runtime";
      runtimeId: "managed-codex";
      providerId: typeof CODEX_SUBSCRIPTION_PROVIDER_ID;
    };

type ProviderConstraintShape = Pick<
  Provider,
  "id" | "type" | "execution" | "subscriptionAuth" | "apiProtocol" | "upstreamFormat"
>;

export function providerRequiresClaudeSdk(id: unknown): id is typeof SUBSCRIPTION_PROVIDER_ID | 'anthropic-api' {
  return id === SUBSCRIPTION_PROVIDER_ID || id === 'anthropic-api';
}

/**
 * Resolve the product execution requirement from explicit Provider fields.
 *
 * API transports are portable by their declared wire family. Product
 * Provider and model records remain the authority for route-specific facts.
 */
export function getProviderExecutionConstraint(
  provider: ProviderConstraintShape,
): ProviderExecutionConstraint {
  if (provider.id === CODEX_SUBSCRIPTION_PROVIDER_ID) {
    return {
      kind: "requires-managed-runtime",
      runtimeId: "managed-codex",
      providerId: CODEX_SUBSCRIPTION_PROVIDER_ID,
    };
  }
  if (providerRequiresClaudeSdk(provider.id)) {
    return {
      kind: "requires-integrated-runtime",
      runtimeId: "claude-agent-sdk",
      providerId: provider.id,
    };
  }
  let credentialKind: Extract<ProviderExecutionConstraint, { kind: "portable" }>["credentialKind"] = "api-key";
  if (provider.id === XAI_SUBSCRIPTION_PROVIDER_ID) {
    if (provider.type !== "subscription" || provider.subscriptionAuth?.kind !== "host-managed-oauth"
      || provider.apiProtocol !== "openai" || provider.upstreamFormat !== "responses") {
      throw new Error("Grok subscription requires Host-managed OAuth and OpenAI Responses");
    }
    credentialKind = "host-managed-oauth";
  } else if (provider.id === ANTIGRAVITY_SUBSCRIPTION_PROVIDER_ID) {
    if (provider.type !== "subscription" || provider.subscriptionAuth?.kind !== "proxy-managed"
      || provider.subscriptionAuth.proxy !== "cliproxy" || provider.apiProtocol !== "anthropic"
      || provider.upstreamFormat === "responses") {
      throw new Error("Antigravity subscription requires CLIProxy and Anthropic Messages");
    }
    credentialKind = "proxy-managed";
  } else if (provider.type === "subscription") {
    throw new Error(`Subscription Provider ${provider.id} has no declared execution owner`);
  }
  if (provider.execution?.kind === "runtime-backed") {
    throw new Error(
      `Provider ${provider.id} is owned by ${provider.execution.runtime}`,
    );
  }
  if (provider.apiProtocol === undefined || provider.apiProtocol === "anthropic") {
    if (provider.upstreamFormat === "responses") {
      throw new Error(
        `Anthropic Provider ${provider.id} cannot use the OpenAI Responses format`,
      );
    }
    return { kind: "portable", apiFamily: "anthropic-messages", credentialKind };
  }
  if (provider.apiProtocol !== "openai") {
    throw new Error(`Provider ${provider.id} declares an unsupported API protocol`);
  }
  if (
    provider.upstreamFormat !== undefined
    && provider.upstreamFormat !== "chat_completions"
    && provider.upstreamFormat !== "responses"
  ) {
    throw new Error(`Provider ${provider.id} declares an unsupported OpenAI format`);
  }
  return {
    kind: "portable",
    apiFamily:
      provider.upstreamFormat === "responses"
        ? "openai-responses"
        : "openai-completions",
    credentialKind,
  };
}

type DshSelectableProviderShape = Pick<
  Provider,
  | "id"
  | "type"
  | "execution"
  | "subscriptionAuth"
  | "enabled"
  | "apiProtocol"
  | "upstreamFormat"
  | "models"
>;

export function isDshProviderEligible(
  provider: DshSelectableProviderShape,
): boolean {
  if (provider.enabled === false) return false;
  try {
    return getProviderExecutionConstraint(provider).kind === "portable";
  } catch {
    return false;
  }
}

export function isDshModelSelectable(
  provider: DshSelectableProviderShape,
  modelId: string | null | undefined,
): boolean {
  const model = modelId?.trim();
  return isDshProviderEligible(provider)
    && !!model
    && provider.models.some((candidate) => candidate.model === model);
}
