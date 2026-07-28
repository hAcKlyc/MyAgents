import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TravelMatePostcard } from './TravelMatePostcard';

describe('TravelMatePostcard', () => {
    it('shows the offline story and dismisses once', () => {
        const onDismiss = vi.fn();
        render(
            <TravelMatePostcard
                postcard={{
                    tripId: 'trip-1',
                    destination: '青岛海边',
                    headline: '我去了青岛海边',
                    story: '海风把早晨吹得亮晶晶的。',
                    signature: '—— Mino',
                    motif: {
                        kind: 'line-art',
                        symbol: 'wave',
                        palette: ['#3C7DA6', '#E7D7B7', '#F28C6A'],
                    },
                }}
                eyebrow="旅行归来"
                dismissLabel="收好明信片"
                onDismiss={onDismiss}
            />,
        );

        expect(screen.getByRole('dialog', { name: '我去了青岛海边' })).toBeInTheDocument();
        expect(screen.getByText('海风把早晨吹得亮晶晶的。')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '收好明信片' }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('focuses the keep action, traps tab, and restores prior focus', () => {
        const prior = document.createElement('button');
        document.body.append(prior);
        prior.focus();
        const onDismiss = vi.fn();
        const { unmount } = render(
            <TravelMatePostcard
                postcard={{
                    tripId: 'trip-2',
                    destination: '西安城墙',
                    headline: '我去了西安城墙',
                    story: '清晨的城砖还带着一点雨光。',
                    signature: '—— Mino',
                    motif: {
                        kind: 'line-art',
                        symbol: 'ginkgo',
                        palette: ['#C8644B', '#F2D6B3', '#284B3F'],
                    },
                }}
                eyebrow="旅行归来"
                dismissLabel="收好明信片"
                onDismiss={onDismiss}
            />,
        );

        const keep = screen.getByRole('button', { name: '收好明信片' });
        const close = screen.getByRole('button', { name: '收好明信片 · close' });
        expect(keep).toHaveFocus();
        fireEvent.keyDown(keep, { key: 'Tab' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(keep).toHaveFocus();
        fireEvent.keyDown(keep, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledTimes(1);

        unmount();
        expect(prior).toHaveFocus();
        prior.remove();
    });
});
