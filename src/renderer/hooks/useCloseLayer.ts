/**
 * useCloseLayer — register a closeable layer for Cmd+W dismissal.
 *
 * Usage (one line per overlay):
 *   useCloseLayer(() => { onClose(); return true; }, 200);
 *
 * The second argument is the component's CSS z-index, which doubles as
 * the dismissal priority.  Higher z-index = dismissed first.
 *
 * Returning `false` from the handler passes through to the next layer
 * (useful for focus-aware panels like the split-pane editor / terminal).
 */

import { useEffect, useRef } from 'react';
import { useOverlayOwnerActive } from '@/context/OverlayOwnerActiveContext';
import { registerCloseLayer } from '@/utils/closeLayer';

export function useCloseLayer(handler: () => boolean, zIndex: number): void {
    const ownerActive = useOverlayOwnerActive();
    const handlerRef = useRef(handler);
    useEffect(() => { handlerRef.current = handler; });

    useEffect(() => {
        if (!ownerActive) return;
        return registerCloseLayer(() => handlerRef.current(), zIndex);
    }, [ownerActive, zIndex]);
}
