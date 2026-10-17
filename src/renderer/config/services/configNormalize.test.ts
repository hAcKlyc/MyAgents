import { describe, it, expect } from 'vitest';
import type { AppConfig } from '../types';
import { normalizeStringifiedJsonFields, promoteAgentMcpJsonToGlobal } from './configNormalize';
import dirtyConfig from '../../../shared/__fixtures__/dirtyConfig301.json';

// Issue #301: a legacy/hand-edited config can persist `providerEnvJson` /
// `mcpServersJson` as a raw JSON object instead of a stringified blob, which
// makes the strict Rust `cmd_start_agent_channel` / boot parse reject it with
// `invalid type: map, expected a string`. The load-boundary normalizer heals it.
// Shared fixture with the Rust twin test: src/shared/__fixtures__/dirtyConfig301.json.

interface ChannelLike {
  overrides?: { providerEnvJson?: unknown };
}
interface AgentLike {
  id: string;
  providerEnvJson?: unknown;
  mcpServersJson?: unknown;
  channels?: ChannelLike[];
}

function agentsOf(cfg: AppConfig): AgentLike[] {
  return (cfg as unknown as { agents: AgentLike[] }).agents;
}

function freshConfig(): AppConfig {
  return structuredClone(dirtyConfig) as unknown as AppConfig;
}

describe('normalizeStringifiedJsonFields (issue #301)', () => {
  it('coerces object providerEnvJson/mcpServersJson + channel overrides back to strings, losslessly', () => {
    const cfg = freshConfig();
    expect(normalizeStringifiedJsonFields(cfg)).toBe(true);

    const dirty = agentsOf(cfg).find(a => a.id === 'agent-dirty')!;

    // Agent-level providerEnvJson: now a string that round-trips to the object.
    expect(typeof dirty.providerEnvJson).toBe('string');
    expect(JSON.parse(dirty.providerEnvJson as string)).toEqual({
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-agent-test',
      authType: 'auth_token',
    });

    // mcpServersJson: now a string that round-trips to the array.
    expect(typeof dirty.mcpServersJson).toBe('string');
    expect(JSON.parse(dirty.mcpServersJson as string)).toEqual([{ id: 'playwright', command: 'npx' }]);

    // Channel override providerEnvJson: now a string that round-trips to the object.
    const override = dirty.channels![0].overrides!.providerEnvJson;
    expect(typeof override).toBe('string');
    expect(JSON.parse(override as string)).toEqual({
      baseUrl: 'https://override.example.com',
      apiKey: 'sk-override-test',
    });
  });

  it('leaves already-stringified values untouched', () => {
    const cfg = freshConfig();
    normalizeStringifiedJsonFields(cfg);
    const clean = agentsOf(cfg).find(a => a.id === 'agent-clean')!;
    expect(clean.providerEnvJson).toBe('{"baseUrl":"https://clean.example.com","apiKey":"sk-clean"}');
  });

  it('is idempotent — a second pass reports no change', () => {
    const cfg = freshConfig();
    expect(normalizeStringifiedJsonFields(cfg)).toBe(true);
    expect(normalizeStringifiedJsonFields(cfg)).toBe(false);
  });

  it('returns false for configs without an agents array', () => {
    expect(normalizeStringifiedJsonFields({} as AppConfig)).toBe(false);
    expect(normalizeStringifiedJsonFields({ agents: undefined } as unknown as AppConfig)).toBe(false);
  });

  it('drops non-string scalars rather than feeding a bogus JSON.parse downstream', () => {
    const cfg = { agents: [{ id: 'x', providerEnvJson: 42 }] } as unknown as AppConfig;
    expect(normalizeStringifiedJsonFields(cfg)).toBe(true);
    expect(agentsOf(cfg)[0].providerEnvJson).toBeUndefined();
  });
});

describe('promoteAgentMcpJsonToGlobal (issue #398)', () => {
  it('promotes selected custom HTTP MCP definitions stranded in Agent JSON', () => {
    const remote = {
      id: 'remote-http',
      name: 'Remote HTTP',
      type: 'http' as const,
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      isBuiltin: false,
    };
    const cfg = {
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['remote-http'],
        mcpServersJson: JSON.stringify([remote]),
      }],
      mcpServers: [],
      mcpEnabledServers: [],
    } as unknown as AppConfig;

    expect(promoteAgentMcpJsonToGlobal(cfg)).toBe(true);
    expect(cfg.mcpServers).toEqual([remote]);
    expect(cfg.mcpEnabledServers).toEqual(['remote-http']);
  });

  it('does not re-enable a known global server that the user disabled globally', () => {
    const remote = {
      id: 'remote-sse',
      name: 'Remote SSE',
      type: 'sse' as const,
      url: 'https://mcp.example.com/sse',
      isBuiltin: false,
    };
    const cfg = {
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['remote-sse'],
        mcpServersJson: JSON.stringify([remote]),
      }],
      mcpServers: [remote],
      mcpEnabledServers: [],
    } as unknown as AppConfig;

    expect(promoteAgentMcpJsonToGlobal(cfg)).toBe(false);
    expect(cfg.mcpServers).toEqual([remote]);
    expect(cfg.mcpEnabledServers).toEqual([]);
  });

  it('does not promote malformed or non-remote definitions from Agent JSON', () => {
    const cfg = {
      agents: [{
        id: 'agent-1',
        mcpEnabledServers: ['remote-without-url', 'agent-stdio'],
        mcpServersJson: JSON.stringify([
          {
            id: 'remote-without-url',
            name: 'Remote Missing URL',
            type: 'http',
            isBuiltin: false,
          },
          {
            id: 'agent-stdio',
            name: 'Agent Stdio',
            type: 'stdio',
            command: 'node',
            isBuiltin: false,
          },
        ]),
      }],
      mcpServers: [],
      mcpEnabledServers: [],
    } as unknown as AppConfig;

    expect(promoteAgentMcpJsonToGlobal(cfg)).toBe(false);
    expect(cfg.mcpServers).toEqual([]);
    expect(cfg.mcpEnabledServers).toEqual([]);
  });
});

import { applyBuiltinBrowserExecutionToolToggle } from '../../../shared/browserTools';

describe('MCP selection settings regression', () => {
  it('renderer load then settings toggle/save preserves IDs and serialized definitions', () => {
    const config = {
      mcpEnabledServers: '[]',
      agents: [{ id: 'legacy', mcpEnabledServers: '[playwright,tavily-search]', mcpServersJson: '[]' }],
    } as unknown as AppConfig;
    normalizeStringifiedJsonFields(config);
    const agent = config.agents![0];
    agent.mcpEnabledServers = applyBuiltinBrowserExecutionToolToggle(agent.mcpEnabledServers!, 'tavily-search', false, true);
    const saved = JSON.parse(JSON.stringify(config)) as AppConfig;
    expect(saved.agents![0].mcpEnabledServers).toEqual(['playwright']);
    expect(saved.agents![0].mcpServersJson).toBe('[]');
    expect(saved.mcpEnabledServers).toEqual([]);
  });
});
