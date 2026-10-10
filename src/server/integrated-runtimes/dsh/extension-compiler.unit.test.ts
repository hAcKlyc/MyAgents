import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { DshProductExtensionSource } from './extension-compiler';
import {
  compileDshExtensionSnapshot,
  compileDshProductExtensionPlane,
  findDshHostToolBinding,
  findDshMcpCredentialBinding,
  normalizeDshHostToolInputSchema,
} from './extension-compiler';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function source(overrides: Partial<DshProductExtensionSource> = {}): DshProductExtensionSource {
  return {
    revision: 'a'.repeat(64),
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    dynamicTools: [],
    ...overrides,
  };
}

describe('DSH declarative extension compiler', () => {
  it('keeps the empty snapshot deterministic and immutable', () => {
    const first = compileDshExtensionSnapshot();
    const second = compileDshExtensionSnapshot();

    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.skillSourcePolicy)).toBe(true);
    expect(Object.isFrozen(first.mcpLaunchPolicy)).toBe(true);
  });

  it('keeps tool-guidance Skills and isolates execution-context semantics without changing other components', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-skill-admission-'));
    const definitions = [
      ['guidance', 'allowed-tools: Bash(example:*)\n'],
      ['forked', 'context: fork\nagent: Explore\n'],
      ['user-only', 'disable-model-invocation: true\nuser-invocable: true\n'],
    ];
    const skills = definitions.map(([name, metadata]) => {
      const content = `---\nname: ${name}\ndescription: Fixture\n${metadata}---\n\nSynthetic instructions.\n`;
      const path = join(root, `${name}.md`);
      writeFileSync(path, content);
      return { name: name!, description: 'Fixture', contentSha256: sha256(content), path, scope: 'user' as const, sourceId: 'global' };
    });
    const plane = compileDshProductExtensionPlane(source({ skills }));
    expect(plane.snapshot.components.map(component => component.id)).toEqual(['guidance', 'user-only']);
    expect(plane.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'guidance', code: 'dsh_skill_tool_guidance', state: 'applied' }),
      expect.objectContaining({ id: 'forked', code: 'dsh_skill_execution_context_unsupported', state: 'unsupported' }),
    ]));
    expect(plane.snapshot.components.find(component => component.id === 'user-only')).toMatchObject({
      descriptor: { invocation: { modelInvocable: false, userInvocable: true } },
    });
  });

  it('projects Product Skills, commands, agents, remote MCP, and Host tools without secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-'));
    const skillPath = join(root, 'SKILL.md');
    const skillContent = '---\nname: review\ndescription: Review changes\n---\n\n# Review\n';
    writeFileSync(skillPath, skillContent, 'utf8');
    const dispatcher = {
      descriptors: [],
      dispatch: vi.fn(),
      dispose: vi.fn(),
    };
    const plane = compileDshProductExtensionPlane(source({
      workspacePath: root,
      skills: [{
        name: 'review',
        description: 'Review changes',
        contentSha256: sha256(skillContent),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
      commands: [{
        name: 'verify',
        description: 'Verify the change',
        body: 'Run the relevant checks.',
        scope: 'project',
        sourceId: 'workspace',
      }],
      agents: [{
        name: 'reviewer',
        description: 'Reviews a change',
        prompt: 'Review the change carefully.',
        tools: ['Read', 'Bash'],
        disallowedTools: ['Bash'],
        maxTurns: 12,
        skills: [{ name: 'review', path: skillPath }],
        scope: 'project',
        sourceId: 'workspace',
      }],
      mcpServers: [
        {
          id: 'remote-tools',
          name: 'Remote tools',
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { authorization: 'Bearer private-token' },
          runtimeConfigRevision: 'remote-tools-credentials-v1',
          isBuiltin: false,
        },
        {
          id: 'local-tools',
          name: 'Local tools',
          type: 'stdio',
          command: 'node',
          isBuiltin: false,
        },
      ],
      dynamicTools: [{
        name: 'myagents__mcp__builtin__lookup',
        description: 'Looks up Product data',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      }],
      hostToolDispatcher: dispatcher,
    }));

    for (const binding of plane.credentialBindings) {
      expect(binding.credentialRef).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    }
    expect(plane.snapshot.components.map(component => component.kind)).toEqual([
      'skill',
      'command',
      'agent',
      'mcp',
      'mcp',
      'host_tool',
    ]);
    expect(plane.snapshot.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill_document', content: skillContent }),
      expect.objectContaining({ kind: 'command_template', content: 'Run the relevant checks.' }),
    ]));
    expect(plane.snapshot.components).toContainEqual(expect.objectContaining({
      id: 'reviewer',
      kind: 'agent',
      descriptor: expect.objectContaining({
        tools: ['Read', 'bash', 'pwsh'],
        disallowedTools: ['bash', 'pwsh'],
        maxTurns: 12,
      }),
    }));
    expect(JSON.stringify(plane.snapshot)).not.toContain('private-token');
    expect(plane.credentialBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentId: 'remote-tools',
        credentialRevision: 'remote-tools-credentials-v1',
        material: { authorization: 'Bearer private-token' },
      }),
      expect.objectContaining({
        componentId: 'local-tools',
        materialSlot: 'env',
      }),
    ]));
    expect(plane.snapshot.mcpLaunchPolicy!.profiles).toEqual([
      expect.objectContaining({
        argv: expect.arrayContaining(['node']),
        cwd: root,
      }),
    ]);
    const credential = plane.credentialBindings.find(binding => binding.componentId === 'remote-tools')!;
    expect(findDshMcpCredentialBinding(plane, {
      componentId: credential.componentId,
      credentialRef: credential.credentialRef,
      credentialRevision: credential.credentialRevision,
      materialSlot: credential.materialSlot,
    })).toBe(credential);
    const hostTool = plane.hostToolBindings[0]!;
    expect(findDshHostToolBinding(plane, hostTool.publicToolName)).toBe(hostTool);
    expect(hostTool.publicToolName).toBe(
      'mcp__myagents_host__myagents__mcp__builtin__lookup',
    );
    expect(plane.expectedSkillNames).toEqual(['review']);
    expect(plane.diagnostics).toContainEqual(expect.objectContaining({
      id: 'local-tools',
      state: 'applied',
      code: 'dsh_stdio_mcp_compiled',
    }));
  });

  it('changes the opaque stdio credential revision when effective env changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-stdio-revision-'));
    const compile = (token: string) => compileDshProductExtensionPlane(source({
      workspacePath: root,
      mcpServers: [{
        id: 'local-tools',
        name: 'Local tools',
        type: 'stdio',
        command: 'node',
        env: { TOKEN: token },
        runtimeConfigRevision: 'same-config-revision',
        isBuiltin: false,
      }],
    })).credentialBindings[0]?.credentialRevision;

    const first = compile('first-secret');
    const second = compile('second-secret');

    expect(first).toMatch(/^mcp-env-[a-f0-9]{64}$/u);
    expect(second).toMatch(/^mcp-env-[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    expect(first).not.toContain('first-secret');
  });

  it('reports an outside-workspace project Skill as an explicit body-only result', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'myagents-dsh-workspace-'));
    const outside = mkdtempSync(join(tmpdir(), 'myagents-dsh-outside-skill-'));
    const skillPath = join(outside, 'SKILL.md');
    const skillContent = '---\nname: linked\ndescription: Linked Skill\n---\n\nUse references/checklist.md.\n';
    writeFileSync(skillPath, skillContent, 'utf8');

    const plane = compileDshProductExtensionPlane(source({
      workspacePath: workspace,
      skills: [{
        name: 'linked',
        description: 'Linked Skill',
        contentSha256: sha256(skillContent),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
    }));

    expect(plane.expectedSkillNames).toEqual(['linked']);
    expect(plane.snapshot.skillSourcePolicy.roots).toEqual([]);
    expect(plane.diagnostics).toContainEqual(expect.objectContaining({
      id: 'linked',
      state: 'applied',
      code: 'dsh_skill_body_only_no_workspace_package_root',
    }));
  });

  it('caps workspace Skill package roots and stdio MCP profiles per component', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-limits-'));
    const skills = Array.from({ length: 129 }, (_, index) => {
      const name = `skill-${String(index).padStart(3, '0')}`;
      const root = join(workspace, '.agents', 'skills', name);
      const path = join(root, 'SKILL.md');
      const content = `---\nname: ${name}\ndescription: Fixture ${name}\n---\n\nUse ${name}.\n`;
      mkdirSync(root, { recursive: true });
      writeFileSync(path, content, 'utf8');
      return {
        name,
        description: `Fixture ${name}`,
        contentSha256: sha256(content),
        path,
        scope: 'project' as const,
        sourceId: 'workspace',
      };
    });
    const mcpServers = Array.from({ length: 129 }, (_, index) => ({
      id: `local-${String(index).padStart(3, '0')}`,
      name: `Local ${String(index)}`,
      type: 'stdio' as const,
      command: 'node',
      isBuiltin: false,
    }));

    const plane = compileDshProductExtensionPlane(source({
      workspacePath: workspace,
      skills,
      mcpServers,
    }));

    expect(plane.snapshot.skillSourcePolicy.roots).toHaveLength(128);
    expect(plane.expectedSkillNames).toHaveLength(128);
    expect(plane.snapshot.mcpLaunchPolicy!.profiles).toHaveLength(128);
    expect(plane.credentialBindings.filter(binding => binding.materialSlot === 'env')).toHaveLength(128);
    expect(plane.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill-128', state: 'unsupported', code: 'dsh_skill_source_root_limit' }),
      expect.objectContaining({ id: 'local-128', state: 'unsupported', code: 'dsh_mcp_launch_profile_limit' }),
    ]));
  });

  it('fails a changed Skill and degrades unsafe per-component inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-drift-'));
    const skillPath = join(root, 'SKILL.md');
    writeFileSync(skillPath, '# Changed\n', 'utf8');

    expect(compileDshProductExtensionPlane(source({
      skills: [{
        name: 'review',
        description: 'Review',
        contentSha256: sha256('# Original\n'),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
    })).diagnostics).toContainEqual(expect.objectContaining({
      component: 'skills', state: 'failed', code: 'dsh_skill_descriptor_invalid',
    }));

    const degraded = compileDshProductExtensionPlane(source({
      mcpServers: [{
        id: 'credential-without-revision',
        name: 'Credential MCP',
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { authorization: 'secret' },
        isBuiltin: false,
      }],
      dynamicTools: [{
        name: 'unsupported_schema',
        description: 'Uses an unsupported schema keyword',
        inputSchema: { type: 'object', patternProperties: {} },
      }],
      hostToolDispatcher: { descriptors: [], dispatch: vi.fn(), dispose: vi.fn() },
    }));
    expect(degraded.snapshot.components).toEqual([]);
    expect(degraded.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dsh_mcp_credential_revision_missing', state: 'unsupported' }),
      expect.objectContaining({ code: 'dsh_host_tool_schema_invalid', state: 'failed' }),
    ]));
  });

  it('normalizes only the protocol closed JSON Schema subset', () => {
    expect(normalizeDshHostToolInputSchema({
      type: 'object',
      properties: { count: { type: 'integer', enum: [1, 2] } },
      required: ['count'],
    })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { count: { type: 'integer', enum: [1, 2] } },
      required: ['count'],
    });
    expect(() => normalizeDshHostToolInputSchema({
      type: 'object',
      oneOf: [],
    })).toThrow(/unsupported JSON Schema keywords/u);
    expect(() => normalizeDshHostToolInputSchema({
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
    })).toThrow(/unsupported JSON Schema keywords/u);
  });

  it('degrades a Host tool whose rendered public identity exceeds the Runtime name bound', () => {
    const toolName = 'a'.repeat(45);
    const plane = compileDshProductExtensionPlane(source({
      dynamicTools: [{
        name: toolName,
        description: 'Too long after the fixed public prefix',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
      hostToolDispatcher: {
        descriptors: [],
        dispatch: vi.fn(),
        dispose: vi.fn(),
      },
    }));

    expect(plane.snapshot.components).toEqual([]);
    expect(plane.hostToolBindings).toEqual([]);
    expect(plane.diagnostics).toContainEqual(expect.objectContaining({
      component: 'host_tools',
      id: toolName,
      state: 'failed',
      code: 'dsh_host_tool_name_invalid',
    }));
  });

  it('degrades Product names outside each exact DSH component intersection', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-extension-names-'));
    const skillPath = join(root, 'SKILL.md');
    const skillContent = '# Localized Skill\n';
    writeFileSync(skillPath, skillContent, 'utf8');
    const plane = compileDshProductExtensionPlane(source({
      skills: [{
        name: '中文技能',
        description: 'Valid Product Skill with a DSH-incompatible identity',
        contentSha256: sha256(skillContent),
        path: skillPath,
        scope: 'project',
        sourceId: 'workspace',
      }],
      commands: [{
        name: 'UPDATE_MEMORY',
        description: 'Valid Product slash command with a DSH-incompatible identity',
        body: 'Summarize.',
        scope: 'project',
        sourceId: 'workspace',
      }],
      mcpServers: [{
        id: 'remote.tools',
        name: 'Remote tools',
        type: 'http',
        url: 'https://example.test/mcp',
        isBuiltin: false,
      }],
    }));

    expect(plane.snapshot.components).toEqual([]);
    expect(plane.snapshot.resources).toEqual([]);
    expect(plane.expectedSkillNames).toEqual([]);
    expect(plane.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dsh_skill_name_invalid', state: 'failed' }),
      expect.objectContaining({ code: 'dsh_command_name_unsupported', state: 'unsupported' }),
      expect.objectContaining({ code: 'dsh_mcp_name_invalid', state: 'failed' }),
    ]));
  });
});
