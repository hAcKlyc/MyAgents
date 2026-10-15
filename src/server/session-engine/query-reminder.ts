import {
  assertKnownProductSystemSkillRequirement,
  TASK_ALIGNMENT_SKILL_REQUIREMENT,
} from "../../shared/systemSkills";
import { desktopContextOf } from "../../shared/agentMentions";
import {
  activeAgentSnapshots,
  queryAgentSelectors,
  agentMentionSnapshotSchema,
  composeQueryReminder,
  type PreparedAgentMention,
} from "../../shared/agentMentions";
import {
  agentDiscoverySchema,
  validateMentionAgent,
  discoveryContext,
} from "../../shared/agentDiscovery";
import type { DesktopMessageRequest } from "./types";
import { optionalProjectContext } from './project-context';

/** Query metadata is prepared once by the common facade. Text that resembles
 * XML is never promoted into a trusted product context. Discovery grants no
 * execution permission; the CLI still performs the real admission checks. */
export async function prepareDesktopQuery(
  request: DesktopMessageRequest,
): Promise<{ request: DesktopMessageRequest; needsReselect: boolean }> {
  // Typed product context carries its admission contract, including older
  // annotations created before requirements were persisted. Never infer from XML.
  const requiredSystemSkill =
    request.requiredSystemSkill ??
    (desktopContextOf(request.queryPrimaryContext)?.kind === "task-discussion"
      ? TASK_ALIGNMENT_SKILL_REQUIREMENT
      : undefined);
  if (requiredSystemSkill)
    assertKnownProductSystemSkillRequirement(requiredSystemSkill);
  request = { ...request, requiredSystemSkill };
  const projectContext = await optionalProjectContext(request);
  const selectors = queryAgentSelectors(request.text);
  if (!selectors.length)
    return {
      request: {
        ...request,
        desktopQuery:
          request.queryPrimaryContext || requiredSystemSkill || projectContext
            ? {
                visibleText: request.text,
                requiredSystemSkill,
                primaryContext: request.queryPrimaryContext,
                projectContext,
              }
            : undefined,
        text: composeQueryReminder({
          visibleText: request.text,
          primaryContext: request.queryPrimaryContext,
          projectContext,
        }),
      },
      needsReselect: false,
    };
  const snapshots = activeAgentSnapshots(
    request.text,
    (request.agentMentions ?? []).map((snapshot) =>
      agentMentionSnapshotSchema.parse(snapshot),
    ),
  );
  const { getAgentDiscovery } = await import("../agent-network/discovery");
  // A network/discovery outage must not reject an otherwise valid user query.
  const response = await getAgentDiscovery().catch(() => null);
  const discovery = agentDiscoverySchema.safeParse(response);
  const current = discovery.success ? discovery.data : null;
  const available = new Map(
    current?.items.map((item) => [item.selector, item]) ?? [],
  );
  const saved = new Map(
    snapshots.map((snapshot) => [snapshot.agent.selector, snapshot]),
  );
  const mentions: PreparedAgentMention[] = [];
  for (const selector of selectors) {
    const agent = available.get(selector);
    if (agent) {
      mentions.push({
        agent: validateMentionAgent(agent),
        availability: "available",
      });
      continue;
    }
    const snapshot = saved.get(selector);
    const scope =
      snapshot && current ? discoveryContext(current, snapshot.agent) : null;
    if (
      snapshot &&
      !snapshot.agent.isLocal &&
      scope &&
      snapshot.authGeneration === scope.authGeneration &&
      snapshot.principalId === scope.principalId &&
      snapshot.networkId === scope.networkId &&
      snapshot.agent.source?.networkId === scope.networkId
    ) {
      mentions.push({
        agent: validateMentionAgent(snapshot.agent),
        availability: "unavailable",
      });
    }
    // Unknown/pasted/cross-account tokens remain visible ordinary text. Never
    // guess a same-name target or reuse another account's saved metadata.
  }
  return {
    request: {
      ...request,
      desktopQuery: {
        projectContext,
        visibleText: request.text,
        requiredSystemSkill,
        agentMentions: mentions.map(({ agent }) => {
          const scope = discoveryContext(current!, agent)!;
          return {
            agent,
            authGeneration: scope.authGeneration,
            principalId: scope.principalId,
            networkId: scope.networkId,
          };
        }),
        primaryContext: request.queryPrimaryContext,
      },
      text: composeQueryReminder({
        projectContext,
        visibleText: request.text,
        primaryContext: request.queryPrimaryContext,
        agentMentions: mentions,
      }),
    },
    needsReselect: mentions.length !== selectors.length,
  };
}
