/**
 * FileSearchResults - Workspace folder and file search results.
 *
 * Folders are navigation objects and always precede files. File content uses
 * progressive disclosure: two matches by default, up to the ten returned by
 * the Rust search owner after an explicit expand action.
 */

import { memo, useId } from 'react';
import { LocateFixed } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
    FileMatchLine,
    FileSearchHit,
    FolderSearchHit,
} from '@/api/searchClient';
import { FileIcon } from '@/components/file-icon';
import {
    isActiveSearchFile,
    isActiveSearchMatch,
    type ActiveSearchTarget,
} from '@/utils/workspaceSearchNavigation';

import SearchHighlight from './SearchHighlight';

const DEFAULT_VISIBLE_MATCHES = 2;

interface FileSearchResultsProps {
    folders: FolderSearchHit[];
    results: FileSearchHit[];
    isLoading: boolean;
    isRefreshing: boolean;
    query: string;
    expandedFiles: Set<string>;
    activeTarget: ActiveSearchTarget | null;
    onToggleFile: (path: string) => void;
    onFolderClick: (hit: FolderSearchHit) => void;
    onFileClick: (hit: FileSearchHit) => void;
    onRevealInTree: (hit: FileSearchHit) => void;
    onMatchClick: (hit: FileSearchHit, match: FileMatchLine) => void;
    onContextMenu: (e: React.MouseEvent, hit: FileSearchHit) => void;
}

export default memo(function FileSearchResults({
    folders,
    results,
    isLoading,
    isRefreshing,
    query,
    expandedFiles,
    activeTarget,
    onToggleFile,
    onFolderClick,
    onFileClick,
    onRevealInTree,
    onMatchClick,
    onContextMenu,
}: FileSearchResultsProps) {
    const { t } = useTranslation('chat');
    const folderHeadingId = useId();
    const fileHeadingId = useId();
    const refreshingSuffix = isRefreshing ? t('workspaceFiles.search.refreshingSuffix') : '';
    const hasResults = folders.length > 0 || results.length > 0;

    if (isLoading && !hasResults) {
        return (
            <div className="flex h-full flex-col overflow-y-auto overscroll-contain px-4 py-3 pb-8">
                <div className="mb-4 flex items-center gap-2">
                    <div className="text-xs font-medium text-[var(--ink-muted)]">
                        {t('workspaceFiles.search.searching')}
                    </div>
                </div>
            </div>
        );
    }

    if (!query) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-[var(--ink-muted)]/60">
                <p>{t('workspaceFiles.search.searchInWorkspace')}</p>
                <p className="mt-1 text-xs">{t('workspaceFiles.search.fileNameAndContent')}</p>
            </div>
        );
    }

    if (!hasResults) {
        return (
            <div className="flex h-full flex-col overflow-y-auto overscroll-contain px-4 py-3 pb-8">
                <div className="mb-4 flex items-center gap-2">
                    <div className="text-xs font-medium text-[var(--ink-muted)]">
                        {t('workspaceFiles.search.zeroResults')}{refreshingSuffix}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            className="flex h-full flex-col overflow-y-auto overscroll-contain pb-8"
            style={{ scrollbarGutter: 'stable' }}
        >
            <div className="sticky top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper)]/90 px-4 py-2 backdrop-blur-sm">
                <div className="text-xs font-medium text-[var(--ink-muted)]">
                    {t('workspaceFiles.search.summary', {
                        folders: folders.length,
                        files: results.length,
                    })}{refreshingSuffix}
                </div>
            </div>

            <div className="py-2">
                {folders.length > 0 && (
                    <section aria-labelledby={folderHeadingId}>
                        <div
                            id={folderHeadingId}
                            className="px-4 pb-1 pt-1 text-xs font-medium text-[var(--ink-muted)]"
                        >
                            {t('workspaceFiles.search.folderSection', { count: folders.length })}
                        </div>
                        {folders.map((hit) => {
                            const { basename, dirname } = splitSearchPath(hit.path);
                            return (
                                <button
                                    key={hit.path}
                                    type="button"
                                    title={hit.path}
                                    className="flex h-7 w-full items-center gap-1.5 px-4 text-left text-sm hover:bg-[var(--hover-bg)] focus-visible:bg-[var(--hover-bg)]"
                                    onClick={() => onFolderClick(hit)}
                                >
                                    <FileIcon name={basename} nodeKind="directory" />
                                    <span className="shrink-0 text-[var(--ink)]">
                                        <SearchHighlight
                                            text={basename}
                                            highlights={findTextHighlights(basename, query)}
                                        />
                                    </span>
                                    {dirname && (
                                        <span className="ml-1 min-w-0 truncate text-xs text-[var(--ink-muted)]/70">
                                            {dirname}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </section>
                )}

                {results.length > 0 && (
                    <section
                        aria-labelledby={fileHeadingId}
                        className={folders.length > 0 ? 'mt-2' : undefined}
                    >
                        <div
                            id={fileHeadingId}
                            className="px-4 pb-1 pt-1 text-xs font-medium text-[var(--ink-muted)]"
                        >
                            {t('workspaceFiles.search.fileSection', { count: results.length })}
                        </div>
                        {results.map((hit) => {
                            const isExpanded = expandedFiles.has(hit.path);
                            const visibleMatches = isExpanded
                                ? hit.matches
                                : hit.matches.slice(0, DEFAULT_VISIBLE_MATCHES);
                            const hasMore = hit.matches.length > DEFAULT_VISIBLE_MATCHES;
                            const isActiveFile = isActiveSearchFile(activeTarget, hit.path);
                            const { basename, dirname } = splitSearchPath(hit.path);

                            return (
                                <div key={hit.path} className="flex flex-col">
                                    <div
                                        role="group"
                                        title={hit.path}
                                        className={`group relative flex h-7 items-center px-4 text-sm select-none ${
                                            isActiveFile
                                                ? 'bg-[var(--accent-warm-subtle)]'
                                                : 'hover:bg-[var(--hover-bg)]'
                                        }`}
                                        onContextMenu={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onContextMenu(event, hit);
                                        }}
                                    >
                                        <button
                                            type="button"
                                            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                                            onClick={() => onFileClick(hit)}
                                        >
                                            <FileIcon name={hit.name} />
                                            <span className="shrink-0 text-[var(--ink)]">
                                                <SearchHighlight
                                                    text={basename}
                                                    highlights={findTextHighlights(basename, query)}
                                                />
                                            </span>
                                            {dirname && (
                                                <span className="ml-1 min-w-0 truncate text-xs text-[var(--ink-muted)]/70">
                                                    {dirname}
                                                </span>
                                            )}
                                        </button>
                                        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center bg-gradient-to-l from-[var(--paper-elevated)] from-70% pl-4 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                                            <button
                                                type="button"
                                                title={t('workspaceFiles.common.revealInTree')}
                                                aria-label={t('workspaceFiles.common.revealInTree')}
                                                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)]/60 transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)] group-hover:pointer-events-auto group-focus-within:pointer-events-auto"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onRevealInTree(hit);
                                                }}
                                            >
                                                <LocateFixed className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </div>

                                    {visibleMatches.length > 0 && (
                                        <div className="flex flex-col">
                                            {visibleMatches.map((match, index) => {
                                                const isActiveMatch = isActiveSearchMatch(
                                                    activeTarget,
                                                    hit.path,
                                                    match.lineNumber,
                                                );
                                                return (
                                                    <button
                                                        key={`${hit.path}-${match.lineNumber}-${index}`}
                                                        type="button"
                                                        className={`group flex min-h-6 items-start py-0.5 pr-3 pl-[30px] text-left text-xs text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink)] ${
                                                            isActiveMatch
                                                                ? 'bg-[var(--accent-warm-subtle)]'
                                                                : 'hover:bg-[var(--hover-bg)]'
                                                        }`}
                                                        onClick={() => onMatchClick(hit, match)}
                                                        onContextMenu={(event) => {
                                                            event.preventDefault();
                                                            event.stopPropagation();
                                                            onContextMenu(event, hit);
                                                        }}
                                                    >
                                                        <span className="w-8 shrink-0 select-none pr-3 pt-[1px] text-right font-mono text-xs text-[var(--ink-muted)]/60">
                                                            {match.lineNumber}
                                                        </span>
                                                        <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono leading-relaxed group-hover:text-[var(--ink)]">
                                                            <SearchHighlight
                                                                text={match.lineContent.trimStart()}
                                                                highlights={adjustHighlightsForTrim(
                                                                    match.lineContent,
                                                                    match.highlights,
                                                                )}
                                                            />
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                            {hasMore && (
                                                <button
                                                    type="button"
                                                    className="self-center rounded-md px-2 py-1 text-xs text-[var(--accent-warm)] hover:bg-[var(--paper-inset)]"
                                                    onClick={() => onToggleFile(hit.path)}
                                                >
                                                    {isExpanded
                                                        ? t('workspaceFiles.search.collapseResults')
                                                        : t('workspaceFiles.search.expandResults')}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </section>
                )}
            </div>
        </div>
    );
});

function splitSearchPath(path: string): { basename: string; dirname: string } {
    const pathParts = path.split('/');
    const basename = pathParts.pop() || path;
    return { basename, dirname: pathParts.join('/') };
}

function findTextHighlights(text: string, query: string): [number, number][] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const { folded: haystack, offsets } = foldTextWithOriginalOffsets(text);
    const highlights: [number, number][] = [];
    let offset = 0;
    while (offset < haystack.length) {
        const index = haystack.indexOf(needle, offset);
        if (index < 0) break;
        const first = offsets[index];
        const last = offsets[index + needle.length - 1];
        if (first && last) {
            const range: [number, number] = [first[0], last[1]];
            const previous = highlights[highlights.length - 1];
            if (!previous || previous[0] !== range[0] || previous[1] !== range[1]) {
                highlights.push(range);
            }
        }
        offset = index + needle.length;
    }
    return highlights;
}

function foldTextWithOriginalOffsets(text: string): {
    folded: string;
    offsets: [number, number][];
} {
    let folded = '';
    let originalOffset = 0;
    const offsets: [number, number][] = [];
    for (const character of text) {
        const start = originalOffset;
        originalOffset += character.length;
        const foldedCharacter = character.toLowerCase();
        folded += foldedCharacter;
        for (let index = 0; index < foldedCharacter.length; index += 1) {
            offsets.push([start, originalOffset]);
        }
    }
    return { folded, offsets };
}

/** Adjust highlight indices to account for trimStart(). */
function adjustHighlightsForTrim(
    original: string,
    highlights: [number, number][],
): [number, number][] {
    const trimmed = original.trimStart();
    const trimOffset = original.length - trimmed.length;
    if (trimOffset === 0) return highlights;
    return highlights.map(([start, end]) => [
        Math.max(0, start - trimOffset),
        Math.max(0, end - trimOffset),
    ]);
}
