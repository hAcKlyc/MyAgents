import { MapPin, X } from 'lucide-react';
import type { CSSProperties } from 'react';

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
    return (
        <section
            role="dialog"
            aria-modal="true"
            aria-label={postcard.headline}
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
            <button type="button" className="fbw-travel-keep" onClick={onDismiss}>
                {dismissLabel}
            </button>
        </section>
    );
}
