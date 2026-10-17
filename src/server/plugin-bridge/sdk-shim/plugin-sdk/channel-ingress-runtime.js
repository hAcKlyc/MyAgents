import { resolveSenderCommandAuthorizationWithRuntime } from './command-auth.js';

/**
 * SDK ingress projection for Bridge plugins. As with the released command-auth
 * entry, Rust AgentChannel owns BIND / allowedUsers / group admission. Plugin
 * pairing files are NOT that authority: consulting them here would reject
 * Rust-authorized senders before they reach its admission path.
 *
 * Only the sender/command projections consumed by channel plugins are exposed;
 * OpenClaw's access graph, pairing writes and ingress monitor are not provided.
 * See plugin_bridge_architecture.md, SDK contracts.
 */
export async function resolveChannelMessageIngress(params) {
  const command = params.command ?? params.policy?.command;
  const legacy = await resolveSenderCommandAuthorizationWithRuntime({
    isGroup: params.conversation?.kind !== 'direct',
    senderId: params.subject?.stableId,
    configuredAllowFrom: params.allowFrom,
    configuredGroupAllowFrom: params.groupAllowFrom,
  });
  return {
    senderAccess: {
      allowed: legacy.senderAllowedForCommands,
      decision: legacy.senderAllowedForCommands ? 'allow' : 'block',
      effectiveAllowFrom: legacy.effectiveAllowFrom,
      effectiveGroupAllowFrom: legacy.effectiveGroupAllowFrom,
      providerMissingFallbackApplied: false,
    },
    commandAccess: {
      requested: command != null,
      authorized: command != null && legacy.commandAuthorized,
      shouldBlockControlCommand: command?.hasControlCommand === true && !legacy.commandAuthorized,
    },
  };
}
