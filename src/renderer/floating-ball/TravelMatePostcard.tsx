import { MapPin, X } from 'lucide-react';
import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';

import type { TravelMatePostcard as TravelMatePostcardData } from './travelMate';

export function TravelMatePostcard({
    postcard,
    eyebrow,
    dismissLabel,
    onDismiss,
}: {
    postcard: TravelMatePostcardData;
    eyebrow: string;
    dismissLabel: string;
    onDismiss: () => void;
}) {
    const [ink, paper, accent] = postcard.motif.palette;
    const dialogRef = useRef<HTMLElement>(null);
    const keepButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const siblings = Array.from(dialogRef.current?.parentElement?.children ?? [])
            .filter((element): element is HTMLElement => (
                element instanceof HTMLElement && element !== dialogRef.current
            ))
            .map((element) => ({ element, wasInert: element.inert }));
        for (const { element } of siblings) element.inert = true;
        keepButtonRef.current?.focus();
        return () => {
            for (const { element, wasInert } of siblings) element.inert = wasInert;
            if (previousFocus?.isConnected) previousFocus.focus();
        };
    }, []);

    const containKeyboardFocus = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onDismiss();
            return;
        }
        if (event.key !== 'Tab') return;
        const buttons = Array.from(
            dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (buttons.length === 0) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    return (
        <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={postcard.headline}
            onKeyDown={containKeyboardFocus}
            className="fbw-travel-postcard"
            style={{
                '--travel-ink': ink,
                '--travel-paper': paper,
                '--travel-accent': accent,
            } as CSSProperties}
        >
            <button
                type="button"
                className="fbw-travel-close"
                onClick={onDismiss}
                aria-label={`${dismissLabel} · close`}
            >
                <X aria-hidden className="size-4" />
            </button>
            <div className="fbw-travel-stamp" aria-hidden>
                <MapPin className="size-5" />
                <span>{postcard.motif.symbol}</span>
            </div>
            <p className="fbw-travel-eyebrow">{eyebrow}</p>
            <h2>{postcard.headline}</h2>
            <p className="fbw-travel-destination">{postcard.destination}</p>
            <p className="fbw-travel-story">{postcard.story}</p>
            <p className="fbw-travel-signature">{postcard.signature}</p>
            <button
                ref={keepButtonRef}
                type="button"
                className="fbw-travel-keep"
                onClick={onDismiss}
            >
                {dismissLabel}
            </button>
        </section>
    );
}
