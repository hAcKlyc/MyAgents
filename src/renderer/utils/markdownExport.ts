import { APP_DISPLAY_NAME } from '../../shared/appProfile';
/**
 * Shared Markdown-export primitives.
 *
 * Two responsibilities, deliberately split so the formatting logic stays a
 * pure (unit-testable) core and the side-effecting download stays a thin shell:
 *
 *   - pure builders (`buildThinkingMarkdown` / `buildReplyMarkdown`) turn a
 *     piece of chat content into a Markdown document string;
 *   - `downloadMarkdown` triggers a browser download to the OS Downloads dir
 *     (same mechanism `sessionExport.ts` already uses for whole-session export).
 *
 * Reused by: ProcessRow (single thinking block), Message (single assistant
 * reply), and sessionExport (whole session). New per-content export entry
 * points MUST build on these helpers rather than re-implementing the blob /
 * <a>.click() dance, so file-name sanitization and the export header stay
 * consistent everywhere.
 */

import { i18n } from '@/i18n';

const pad2 = (n: number) => String(n).padStart(2, '0');

function exportText(key: string, options?: Record<string, unknown>): string {
    return String(i18n.t(`app:export.${key}`, options));
}

/** Local (not UTC) date string `YYYY-MM-DD`. Clock injectable for tests. */
export function localDateStr(now: Date = new Date()): string {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Strip characters that make a download file name invalid, and cap length, so
 * the result is always a usable name. Handles: path/reserved separators
 * (`/\:*?"<>|`), ASCII control chars, whitespace runs, and leading/trailing
 * dots (which produce hidden / `..`-like names). Falls back to `untitled` when
 * nothing survives. (Windows reserved device names like `CON` are not special-
 * cased: every caller prefixes a date, so a bare reserved name can't occur.)
 */
export function sanitizeFileName(name: string, maxLen = 60): string {
    const cleaned = name
        // eslint-disable-next-line no-control-regex -- intentionally stripping C0 control chars
        .replace(/[\x00-\x1f]/g, '')
        .replace(/[/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen)
        .replace(/^[.\s]+|[.\s]+$/g, '');
    return cleaned || 'untitled';
}

/** Provenance header prepended to every exported document. */
export function exportHeader(dateStr: string): string {
    return `<!-- Exported from ${APP_DISPLAY_NAME} · ${dateStr} -->`;
}

/** Build a Markdown document for a single AI thinking block. Pure. */
export function buildThinkingMarkdown(thinking: string, now: Date = new Date()): string {
    return [
        exportHeader(localDateStr(now)),
        '<!-- AI 思考过程 / Chain of Thought -->',
        '',
        thinking.trim(),
        '',
    ].join('\n');
}

/** Build a Markdown document for a single assistant text reply. Pure. */
export function buildReplyMarkdown(text: string, now: Date = new Date()): string {
    return [
        exportHeader(localDateStr(now)),
        '',
        text.trim(),
        '',
    ].join('\n');
}

/**
 * Trigger a browser download of `content` as a Markdown file into the OS
 * Downloads directory. Returns a toast-ready message: the resolved full path
 * when Tauri can resolve it, otherwise a generic "saved to Downloads" line.
 */
export async function downloadMarkdown(fileName: string, content: string): Promise<string> {
    return downloadBlob(fileName, new Blob([content], { type: 'text/markdown;charset=utf-8' }));
}

/** Shared browser/Tauri download transport for generated documents. */
export async function downloadBlob(fileName: string, blob: Blob): Promise<string> {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    // Defer the revoke: `a.click()` initiates the download asynchronously, and
    // revoking in the same tick can race the engine's blob fetch → intermittent
    // 0-byte downloads (notably in WKWebView, which is MyAgents' runtime).
    setTimeout(() => URL.revokeObjectURL(url), 0);

    try {
        const { downloadDir, join: joinPath } = await import('@tauri-apps/api/path');
        const dlDir = await downloadDir();
        const fullPath = await joinPath(dlDir, fileName);
        return exportText('downloadedPath', { path: fullPath });
    } catch {
        return exportText('downloadedDownloads', { fileName });
    }
}
