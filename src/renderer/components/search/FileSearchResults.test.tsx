import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileSearchHit, FolderSearchHit } from '@/api/searchClient';
import { i18n } from '@/i18n';
import FileSearchResults from './FileSearchResults';

const hit: FileSearchHit = {
    path: 'docs/note.md',
    name: 'note.md',
    matchCount: 3,
    matches: [
        {
            lineNumber: 12,
            lineContent: '  high school exam note',
            highlights: [[2, 6]],
        },
        {
            lineNumber: 24,
            lineContent: 'second match',
            highlights: [[0, 6]],
        },
        {
            lineNumber: 36,
            lineContent: 'third match',
            highlights: [[0, 5]],
        },
    ],
};

const folder: FolderSearchHit = {
    path: 'docs/high-notes',
    name: 'high-notes',
};

function renderResults(overrides: Partial<ComponentProps<typeof FileSearchResults>> = {}) {
    const props: ComponentProps<typeof FileSearchResults> = {
        folders: [folder],
        results: [hit],
        isLoading: false,
        isRefreshing: false,
        query: 'high',
        expandedFiles: new Set(),
        activeTarget: null,
        onToggleFile: vi.fn(),
        onFolderClick: vi.fn(),
        onFileClick: vi.fn(),
        onRevealInTree: vi.fn(),
        onMatchClick: vi.fn(),
        onContextMenu: vi.fn(),
        ...overrides,
    };
    render(<FileSearchResults {...props} />);
    return props;
}

describe('FileSearchResults', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('zh-CN');
    });

    it('shows folders first and keeps expand separate from file preview', () => {
        const props = renderResults();

        const folderHeading = screen.getByText('文件夹（1）');
        const fileHeading = screen.getByText('文件（1）');
        expect(folderHeading.compareDocumentPosition(fileHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        expect(screen.queryByText('third match')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '展开' }));
        expect(props.onToggleFile).toHaveBeenCalledWith(hit.path);
        expect(props.onFileClick).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /note\.md/ }));
        expect(props.onFileClick).toHaveBeenCalledWith(hit);
    });

    it('navigates folder rows without invoking file preview', () => {
        const props = renderResults();

        fireEvent.click(screen.getByRole('button', { name: /high-notes/ }));

        expect(props.onFolderClick).toHaveBeenCalledWith(folder);
        expect(props.onFileClick).not.toHaveBeenCalled();
    });

    it('shows all returned chunks when expanded and offers a one-step collapse', () => {
        const props = renderResults({ expandedFiles: new Set([hit.path]) });

        expect(screen.getByRole('button', { name: /36thirdmatch/ })).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: '收起' }));
        expect(props.onToggleFile).toHaveBeenCalledWith(hit.path);
    });

    it('omits the per-file count even when file content has matches', () => {
        renderResults();
        expect(screen.queryByLabelText(/正文命中/)).not.toBeInTheDocument();
        expect(screen.queryByText(String(hit.matchCount))).not.toBeInTheDocument();
    });

    it('does not offer expand for filename-only matches', () => {
        renderResults({
            folders: [],
            query: 'note',
            results: [{ ...hit, matchCount: 0, matches: [] }],
        });

        expect(screen.queryByLabelText(/正文命中/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '展开' })).not.toBeInTheDocument();
        expect(screen.getByText('note')).toBeInTheDocument();
    });

    it('maps case-folded Unicode matches back to the original filename offsets', () => {
        renderResults({
            folders: [{ path: 'docs/İX', name: 'İX' }],
            results: [],
            query: 'x',
        });

        expect(screen.getByText('X').tagName).toBe('MARK');
        expect(screen.getByText('İ').tagName).not.toBe('MARK');
    });

    it('exposes reveal-in-tree as an icon-only action', () => {
        const props = renderResults();

        fireEvent.click(screen.getByTitle('在文件目录中展示'));

        expect(props.onRevealInTree).toHaveBeenCalledWith(hit);
        expect(props.onFileClick).not.toHaveBeenCalled();
    });

    it('passes the full search hit to match clicks and context menus', () => {
        const props = renderResults();

        const matchRow = screen.getByRole('button', { name: /12highschool exam note/ });
        fireEvent.click(matchRow);
        expect(props.onMatchClick).toHaveBeenCalledWith(hit, hit.matches[0]);

        fireEvent.contextMenu(screen.getByTitle(hit.path));
        expect(props.onContextMenu).toHaveBeenCalledWith(expect.anything(), hit);
    });
});
