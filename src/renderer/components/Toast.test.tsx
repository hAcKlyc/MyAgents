import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

function ToastTrigger() {
    const toast = useToast();
    return <button onClick={() => toast.info('Saved', 1_000)}>Show toast</button>;
}

it('dismisses mounted toasts and cancels their timers on unmount', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { unmount } = render(<ToastProvider><ToastTrigger /></ToastProvider>);
    try {
        fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
        expect(screen.getByRole('status')).toHaveTextContent('Saved');
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(screen.queryByRole('status')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
        expect(screen.getByRole('status')).toHaveTextContent('Saved');
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.useRealTimers();
    }
});
