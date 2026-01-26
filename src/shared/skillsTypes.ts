/**
 * Shared types for Skills & Commands management
 */
import type { SkillFrontmatter, CommandFrontmatter } from './slashCommands';

// Re-export frontmatter types
export type { SkillFrontmatter, CommandFrontmatter };

/**
 * Skill item in list view
 */
export interface SkillItem {
    name: string;
    description: string;
    scope: 'user' | 'project';
    path: string;
    folderName: string;
}

/**
 * Command item in list view
 */
export interface CommandItem {
    name: string;           // Display name (from frontmatter or fallback to fileName)
    fileName: string;       // Actual file name without .md extension
    description: string;
    scope: 'user' | 'project';
    path: string;
}

/**
 * Full skill detail with frontmatter and body
 */
export interface SkillDetail {
    name: string;
    folderName: string;
    path: string;
    scope: 'user' | 'project';
    frontmatter: Partial<SkillFrontmatter>;
    body: string;
}

/**
 * Full command detail with frontmatter and body
 */
export interface CommandDetail {
    name: string;           // Display name (from frontmatter or fallback to fileName)
    fileName: string;       // Actual file name without .md extension
    path: string;
    scope: 'user' | 'project';
    frontmatter: Partial<CommandFrontmatter>;
    body: string;
}

/**
 * API response types
 */
export interface SkillsListResponse {
    success: boolean;
    skills: SkillItem[];
    error?: string;
}

export interface CommandsListResponse {
    success: boolean;
    commands: CommandItem[];
    error?: string;
}

export interface SkillDetailResponse {
    success: boolean;
    skill: SkillDetail;
    error?: string;
}

export interface CommandDetailResponse {
    success: boolean;
    command: CommandDetail;
    error?: string;
}

export interface ApiSuccessResponse {
    success: boolean;
    error?: string;
    path?: string;
    folderName?: string;
    name?: string;
}
