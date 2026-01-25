// Slash Commands Service
// Provides slash command discovery and management for the chat input
// Supports builtin commands, custom commands (.claude/commands/), and skills (.claude/skills/, ~/.myagents/skills/)

import { load as yamlLoad } from 'js-yaml';

export interface SlashCommand {
    name: string;           // Command name without slash, e.g., "review"
    description: string;    // Human readable description
    source: 'builtin' | 'custom' | 'skill';  // Source type: builtin, custom command, or skill
    scope?: 'user' | 'project';  // Where the item is defined
    path?: string;          // File path for custom commands or skills
    folderName?: string;    // Folder name for skills (may differ from display name after rename)
}

/**
 * Complete Skill frontmatter interface
 * Matches the Agent Skills Open Standard specification
 */
export interface SkillFrontmatter {
    name: string;
    description: string;
    // Advanced options
    'disable-model-invocation'?: boolean;
    'user-invocable'?: boolean;
    'allowed-tools'?: string;
    context?: 'fork' | string;
    agent?: 'Explore' | 'Plan' | 'general-purpose' | string;
    'argument-hint'?: string;
}

/**
 * Complete Command frontmatter interface
 */
export interface CommandFrontmatter {
    description: string;
}

// Built-in Claude Code slash commands with descriptions
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
    { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
    { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
    { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
    { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
    { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
    { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
    { name: 'review', description: '对代码进行审查', source: 'builtin' },
    { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
];

/**
 * Extract YAML frontmatter string from markdown content
 */
function extractFrontmatter(content: string): { frontmatterStr: string; body: string } | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }
    return {
        frontmatterStr: match[1],
        body: match[2] || ''
    };
}

/**
 * Parse YAML frontmatter from a markdown file to extract description
 * For custom commands (.claude/commands/*.md)
 * Format:
 * ---
 * description: Some description here
 * ---
 */
export function parseYamlFrontmatter(content: string): { description?: string } {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return {};
        }
        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return {
            description: typeof parsed.description === 'string' ? parsed.description : undefined
        };
    } catch (e) {
        console.warn('Failed to parse YAML frontmatter:', e);
        return {};
    }
}

/**
 * Parse YAML frontmatter from a SKILL.md file to extract name and description
 * Skills use 'name' and 'description' fields in frontmatter
 * Format:
 * ---
 * name: skill-name
 * description: "What this skill does and when to use it"
 * ---
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return {};
        }
        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return {
            name: typeof parsed.name === 'string' ? parsed.name : undefined,
            description: typeof parsed.description === 'string' ? parsed.description : undefined
        };
    } catch (e) {
        console.warn('Failed to parse skill frontmatter:', e);
        return {};
    }
}

/**
 * Extract command name from file path
 * e.g., "/path/to/review-code.md" -> "review-code"
 */
export function extractCommandName(filePath: string): string {
    const fileName = filePath.split('/').pop() || '';
    return fileName.replace(/\.md$/, '');
}

/**
 * Parse complete SKILL.md frontmatter with all fields
 * Returns both frontmatter and markdown body content
 */
export function parseFullSkillContent(content: string): {
    frontmatter: Partial<SkillFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return { frontmatter: {}, body: content };
        }

        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<SkillFrontmatter> = {};

        if (typeof parsed.name === 'string') frontmatter.name = parsed.name;
        if (typeof parsed.description === 'string') frontmatter.description = parsed.description;
        if (typeof parsed['disable-model-invocation'] === 'boolean') {
            frontmatter['disable-model-invocation'] = parsed['disable-model-invocation'];
        }
        if (typeof parsed['user-invocable'] === 'boolean') {
            frontmatter['user-invocable'] = parsed['user-invocable'];
        }
        if (typeof parsed['allowed-tools'] === 'string') {
            frontmatter['allowed-tools'] = parsed['allowed-tools'];
        }
        if (typeof parsed.context === 'string') frontmatter.context = parsed.context;
        if (typeof parsed.agent === 'string') frontmatter.agent = parsed.agent;
        if (typeof parsed['argument-hint'] === 'string') {
            frontmatter['argument-hint'] = parsed['argument-hint'];
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full skill content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Parse complete Command file content
 * Returns both frontmatter and markdown body content
 */
export function parseFullCommandContent(content: string): {
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
} {
    try {
        const extracted = extractFrontmatter(content);
        if (!extracted) {
            return { frontmatter: {}, body: content };
        }

        const parsed = yamlLoad(extracted.frontmatterStr) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') {
            return { frontmatter: {}, body: extracted.body };
        }

        const frontmatter: Partial<CommandFrontmatter> = {};
        if (typeof parsed.description === 'string') {
            frontmatter.description = parsed.description;
        }

        return { frontmatter, body: extracted.body };
    } catch (e) {
        console.warn('Failed to parse full command content:', e);
        return { frontmatter: {}, body: content };
    }
}

/**
 * Serialize Skill frontmatter and body back to SKILL.md format
 */
export function serializeSkillContent(frontmatter: Partial<SkillFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    if (frontmatter.name) lines.push(`name: ${frontmatter.name}`);
    if (frontmatter.description) lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    if (frontmatter['disable-model-invocation'] !== undefined) {
        lines.push(`disable-model-invocation: ${frontmatter['disable-model-invocation']}`);
    }
    if (frontmatter['user-invocable'] !== undefined) {
        lines.push(`user-invocable: ${frontmatter['user-invocable']}`);
    }
    if (frontmatter['allowed-tools']) lines.push(`allowed-tools: ${frontmatter['allowed-tools']}`);
    if (frontmatter.context) lines.push(`context: ${frontmatter.context}`);
    if (frontmatter.agent) lines.push(`agent: ${frontmatter.agent}`);
    if (frontmatter['argument-hint']) lines.push(`argument-hint: ${frontmatter['argument-hint']}`);

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}

/**
 * Serialize Command frontmatter and body back to markdown format
 */
export function serializeCommandContent(frontmatter: Partial<CommandFrontmatter>, body: string): string {
    const lines: string[] = ['---'];

    if (frontmatter.description) {
        lines.push(`description: "${frontmatter.description.replace(/"/g, '\\"')}"`);
    }

    lines.push('---');
    lines.push('');
    lines.push(body.trim());

    return lines.join('\n');
}
