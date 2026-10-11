import { describe, expect, it } from 'vitest';
import fixtures from './__fixtures__/mcpSelection.json';
import { normalizeConfigMcpSelections, normalizeMcpSelectionField, normalizeProjectMcpSelections } from './mcpSelection';

describe('persisted MCP selection compatibility', () => {
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
