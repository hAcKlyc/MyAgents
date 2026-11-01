import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/mcpSelection.json';
import { normalizeConfigMcpSelections, normalizeMcpSelectionField, normalizeProjectMcpSelections, resolveDefaultMcpSelection } from './mcpSelection';

describe('persisted MCP selection compatibility', () => {
  it('keeps Agent defaults authoritative over a stale Project mirror, including empty/missing selections', () => {
    const project = { mcpEnabledServers: ['project-only'] };
    expect(resolveDefaultMcpSelection({ mcpEnabledServers: ['agent-only'] }, project)).toEqual(['agent-only']);
    expect(resolveDefaultMcpSelection({ mcpEnabledServers: [] }, project)).toEqual([]);
    expect(resolveDefaultMcpSelection({}, project)).toEqual([]);
    expect(resolveDefaultMcpSelection(undefined, project)).toEqual(['project-only']);
  });

  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const holder = structuredClone(fixture.input);
      normalizeMcpSelectionField(holder);
      expect(holder).toEqual(fixture.expected);
      expect(normalizeMcpSelectionField(holder)).toBe(false);
    });
  }

  it('normalizes every config holder without traversing independent snapshots', () => {
    const holder = () => ({ mcpEnabledServers: '[playwright,tavily-search]' });
    const config = {
      ...holder(), agents: [holder()], projects: [holder()], imBotConfigs: [holder()],
      imBotConfig: holder(), launcherLastUsed: holder(), session: holder(),
    };
    expect(normalizeConfigMcpSelections(config)).toBe(true);
    for (const item of [config, ...config.agents, ...config.projects, ...config.imBotConfigs, config.imBotConfig, config.launcherLastUsed]) {
      expect(item.mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
    }
    expect(config.session.mcpEnabledServers).toBe('[playwright,tavily-search]');
    expect(normalizeConfigMcpSelections(config)).toBe(false);
    const projects = [holder()];
    normalizeProjectMcpSelections(projects);
    expect(projects[0].mcpEnabledServers).toEqual(['playwright', 'tavily-search']);
  });

});
