export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024; // 32 MB
export const ATTACHMENTS_DIR_NAME = 'attachments';

/**
 * API endpoints for Skills & Commands management
 */
export const API_ENDPOINTS = {
    // Skills
    SKILLS_LIST: '/api/skills',
    SKILL_DETAIL: (name: string) => `/api/skill/${encodeURIComponent(name)}`,
    SKILL_CREATE: '/api/skill/create',

    // Commands
    COMMANDS_LIST: '/api/command-items',
    COMMAND_DETAIL: (name: string) => `/api/command-item/${encodeURIComponent(name)}`,
    COMMAND_CREATE: '/api/command-item/create',

    // CLAUDE.md
    CLAUDE_MD: '/api/claude-md',

    // Agent
    OPEN_IN_FINDER: '/agent/open-in-finder',
} as const;

/**
 * File system paths for Skills & Commands
 */
export const FS_PATHS = {
    USER_SKILLS_DIR: '~/.myagents/skills/',
    USER_COMMANDS_DIR: '~/.myagents/commands/',
    PROJECT_SKILLS_DIR: '.claude/skills/',
    PROJECT_COMMANDS_DIR: '.claude/commands/',
} as const;

/**
 * UI z-index layers (ordered from bottom to top)
 */
export const Z_INDEX = {
    MODAL_OVERLAY: 200,
    MODAL_DIALOG: 250,
    TOAST: 300,
    CONFIRM_DIALOG: 300,
} as const;

/**
 * Custom event names for cross-component communication
 */
export const CUSTOM_EVENTS = {
    /** Fired when a user-level skill is copied to project directory */
    SKILL_COPIED_TO_PROJECT: 'skill-copied-to-project',
    /** Fired to open Settings page with optional section (e.g., 'mcp', 'providers') */
    OPEN_SETTINGS: 'open-settings',
} as const;
