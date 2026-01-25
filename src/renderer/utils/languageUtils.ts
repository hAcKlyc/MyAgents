/**
 * Language utilities for file type detection
 * 
 * Shared module for language detection used by both preview and editor components.
 * Centralizes language mappings to ensure consistency between SyntaxHighlighter and Monaco.
 */

/**
 * Language configuration for a file type
 */
interface LanguageConfig {
    /** Prism language ID for SyntaxHighlighter */
    prism: string;
    /** Monaco language ID for editor */
    monaco: string;
    /** Whether to show line numbers */
    showLineNumbers: boolean;
}

/**
 * Default configuration for unknown file types
 */
const DEFAULT_CONFIG: LanguageConfig = {
    prism: 'text',
    monaco: 'plaintext',
    showLineNumbers: true,
};

/**
 * Special dotfile mappings (full filename match)
 */
const DOTFILE_MAP: Record<string, LanguageConfig> = {
    '.gitignore': { prism: 'text', monaco: 'plaintext', showLineNumbers: true },
    '.gitattributes': { prism: 'text', monaco: 'plaintext', showLineNumbers: true },
    '.editorconfig': { prism: 'ini', monaco: 'ini', showLineNumbers: true },
    '.env': { prism: 'text', monaco: 'plaintext', showLineNumbers: true },
    '.env.local': { prism: 'text', monaco: 'plaintext', showLineNumbers: true },
    '.env.development': { prism: 'text', monaco: 'plaintext', showLineNumbers: true },
    '.env.production': { prism: 'text', monaco: 'plaintext', showLineNumbers: true },
    '.npmrc': { prism: 'ini', monaco: 'ini', showLineNumbers: true },
    '.yarnrc': { prism: 'yaml', monaco: 'yaml', showLineNumbers: true },
    '.prettierrc': { prism: 'json', monaco: 'json', showLineNumbers: true },
    '.eslintrc': { prism: 'json', monaco: 'json', showLineNumbers: true },
    '.babelrc': { prism: 'json', monaco: 'json', showLineNumbers: true },
    'dockerfile': { prism: 'docker', monaco: 'dockerfile', showLineNumbers: true },
    'makefile': { prism: 'makefile', monaco: 'makefile', showLineNumbers: true },
};

/**
 * Extension-based language mappings
 */
const EXTENSION_MAP: Record<string, LanguageConfig> = {
    // JavaScript/TypeScript
    js: { prism: 'javascript', monaco: 'javascript', showLineNumbers: true },
    jsx: { prism: 'jsx', monaco: 'javascript', showLineNumbers: true },
    ts: { prism: 'typescript', monaco: 'typescript', showLineNumbers: true },
    tsx: { prism: 'tsx', monaco: 'typescript', showLineNumbers: true },
    mjs: { prism: 'javascript', monaco: 'javascript', showLineNumbers: true },
    cjs: { prism: 'javascript', monaco: 'javascript', showLineNumbers: true },

    // Web
    html: { prism: 'html', monaco: 'html', showLineNumbers: true },
    htm: { prism: 'html', monaco: 'html', showLineNumbers: true },
    css: { prism: 'css', monaco: 'css', showLineNumbers: true },
    scss: { prism: 'scss', monaco: 'scss', showLineNumbers: true },
    less: { prism: 'less', monaco: 'less', showLineNumbers: true },

    // Data/Config
    json: { prism: 'json', monaco: 'json', showLineNumbers: true },
    yaml: { prism: 'yaml', monaco: 'yaml', showLineNumbers: true },
    yml: { prism: 'yaml', monaco: 'yaml', showLineNumbers: true },
    toml: { prism: 'toml', monaco: 'ini', showLineNumbers: true }, // Monaco lacks TOML
    xml: { prism: 'xml', monaco: 'xml', showLineNumbers: true },
    ini: { prism: 'ini', monaco: 'ini', showLineNumbers: true },
    cfg: { prism: 'ini', monaco: 'ini', showLineNumbers: true },
    conf: { prism: 'ini', monaco: 'ini', showLineNumbers: true },

    // Programming Languages
    py: { prism: 'python', monaco: 'python', showLineNumbers: true },
    rb: { prism: 'ruby', monaco: 'ruby', showLineNumbers: true },
    rs: { prism: 'rust', monaco: 'rust', showLineNumbers: true },
    go: { prism: 'go', monaco: 'go', showLineNumbers: true },
    java: { prism: 'java', monaco: 'java', showLineNumbers: true },
    kt: { prism: 'kotlin', monaco: 'kotlin', showLineNumbers: true },
    swift: { prism: 'swift', monaco: 'swift', showLineNumbers: true },
    c: { prism: 'c', monaco: 'c', showLineNumbers: true },
    cpp: { prism: 'cpp', monaco: 'cpp', showLineNumbers: true },
    h: { prism: 'c', monaco: 'c', showLineNumbers: true },
    hpp: { prism: 'cpp', monaco: 'cpp', showLineNumbers: true },
    cs: { prism: 'csharp', monaco: 'csharp', showLineNumbers: true },

    // Shell
    sh: { prism: 'bash', monaco: 'shell', showLineNumbers: true },
    bash: { prism: 'bash', monaco: 'shell', showLineNumbers: true },
    zsh: { prism: 'bash', monaco: 'shell', showLineNumbers: true },

    // Documentation - no line numbers
    md: { prism: 'markdown', monaco: 'markdown', showLineNumbers: false },
    markdown: { prism: 'markdown', monaco: 'markdown', showLineNumbers: false },

    // Other
    sql: { prism: 'sql', monaco: 'sql', showLineNumbers: true },
    graphql: { prism: 'graphql', monaco: 'graphql', showLineNumbers: true },

    // Plain text - no line numbers
    txt: { prism: 'text', monaco: 'plaintext', showLineNumbers: false },
    log: { prism: 'text', monaco: 'plaintext', showLineNumbers: false },
};

/**
 * Get language configuration for a file
 */
export function getLanguageConfig(filename: string): LanguageConfig {
    const lowerName = filename.toLowerCase();

    // Check dotfile mapping first
    if (DOTFILE_MAP[lowerName]) {
        return DOTFILE_MAP[lowerName];
    }

    // Get extension
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';

    return EXTENSION_MAP[ext] ?? DEFAULT_CONFIG;
}

/**
 * Get Prism language identifier from file extension
 */
export function getPrismLanguage(filename: string): string {
    return getLanguageConfig(filename).prism;
}

/**
 * Get Monaco language identifier from file extension
 */
export function getMonacoLanguage(filename: string): string {
    return getLanguageConfig(filename).monaco;
}

/**
 * Check if a file should show line numbers
 */
export function shouldShowLineNumbers(filename: string): boolean {
    return getLanguageConfig(filename).showLineNumbers;
}

/**
 * Check if a file is Markdown
 */
export function isMarkdownFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return ext === 'md' || ext === 'markdown';
}
