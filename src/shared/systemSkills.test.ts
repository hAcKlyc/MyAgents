import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isRequiredSystemSkill,
  REQUIRED_SYSTEM_SKILLS,
  SYSTEM_SKILLS_VERSION,
  TASK_ALIGNMENT_SKILL_REQUIREMENT,
  withoutRequiredSystemSkills,
} from './systemSkills';

describe('required system skill contract', () => {
  it('contains exactly the nine product-required global skills', () => {
    expect(REQUIRED_SYSTEM_SKILLS).toEqual([
      'myagents-task-alignment',
      'myagents-memory-update',
      'myagents-memory-gardener',
      'myagents-memory-molt',
      'myagents-cli',
      'myagents-anydoc',
      'myagents-speech-recognition',
      'myagents-task-automation',
      'myagents-docs',
    ]);
    for (const name of REQUIRED_SYSTEM_SKILLS) {
      expect(isRequiredSystemSkill(name)).toBe(true);
    }
    expect(isRequiredSystemSkill('prompt-writer')).toBe(false);
  });

  it('removes required and malformed entries without disturbing optional disabled skills', () => {
    expect(withoutRequiredSystemSkills([
      'myagents-cli',
      'myagents-anydoc',
      'myagents-speech-recognition',
      'myagents-task-alignment',
      'prompt-writer',
      null,
      'myagents-docs',
      'user-skill',
    ])).toEqual(['prompt-writer', 'user-skill']);
  });

  it('binds Task discussion to the exact bundled Skill content', () => {
    const content = readFileSync(
      resolve(process.cwd(), 'bundled-skills/myagents-task-alignment/SKILL.md'),
      'utf8',
    );
    expect(TASK_ALIGNMENT_SKILL_REQUIREMENT.systemSkillsVersion).toBe(SYSTEM_SKILLS_VERSION);
    expect(createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex'))
      .toBe(TASK_ALIGNMENT_SKILL_REQUIREMENT.contentSha256);
  });
});
