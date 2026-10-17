import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXTERNAL_CLI_PUBLIC_CAPABILITIES } from './externalCliCapabilities';

const GUIDE_PATH = resolve(
  process.cwd(),
  'bundled-guides/external-myagents-cli/SKILL.md',
);
const guide = readFileSync(GUIDE_PATH, 'utf8');
const documentedInvocations = [
  ...guide.matchAll(/^(?:\d+\.\s+)?<CLI> ([^\n]+)$/gm),
].map(([, invocation]) => invocation.trim());
const publicCommands = EXTERNAL_CLI_PUBLIC_CAPABILITIES.map(
  ({ command }) => command,
);

describe('external MyAgents CLI guide', () => {
  it('never demonstrates an invocation outside the public allowlist', () => {
    for (const invocation of documentedInvocations) {
      if (invocation === '--help') continue;
      const withoutHelp = invocation.endsWith(' --help')
        ? invocation.slice(0, -' --help'.length)
        : invocation;
      const matchingCommands = publicCommands.filter((command) => {
        if (withoutHelp === command || withoutHelp.startsWith(`${command} `)) {
          return true;
        }
        return (
          !withoutHelp.includes(' ') && command.startsWith(`${withoutHelp} `)
        );
      });
      expect(
        matchingCommands,
        `unsupported external CLI invocation: ${invocation}`,
      ).not.toHaveLength(0);
    }
  });

  it('routes each multi-command capability domain through group help', () => {
    const documented = new Set(documentedInvocations);
    for (const group of ['agent', 'network', 'runtime', 'session', 'task', 'record']) {
      expect(documented.has(`${group} --help`)).toBe(true);
    }
  });

  it('keeps internal caller credentials and direct control-plane details out', () => {
    expect(guide).not.toContain('MYAGENTS_INTERNAL_CLI_TOKEN');
    expect(guide).not.toContain('MYAGENTS_PORT');
    expect(guide).not.toContain('/api/admin/');
  });

  it('requires the absolute launcher and external token environment variable', () => {
    expect(guide).toContain('CLI 绝对路径');
    expect(guide).toContain('MYAGENTS_API_TOKEN');
    expect(guide).toContain('PATH 不保证能发现 `myagents`');
  });
});
