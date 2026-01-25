// External link component that opens URLs using system default browser
// Supports text selection for copying while allowing click-to-open

import { type ReactNode, type MouseEvent } from 'react';
import { openExternal } from '@/utils/openExternal';

interface ExternalLinkProps {
    href: string;
    children: ReactNode;
    className?: string;
    title?: string;
}

/**
 * A link component that opens external URLs in the system browser
 * while still allowing text selection for copying.
 *
 * Click behavior:
 * - Single click without text selection: opens the link
 * - Click after selecting text: does not open (allows copy)
 */
export function ExternalLink({ href, children, className, title }: ExternalLinkProps) {
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();

        // Check if user is selecting text (has selection)
        const selection = window.getSelection();
        const hasSelection = selection && selection.toString().length > 0;

        if (!hasSelection && href) {
            openExternal(href);
        }
    };

    return (
        <a
            href={href}
            onClick={handleClick}
            className={className}
            title={title}
            // Allow text selection
            style={{ userSelect: 'text' }}
        >
            {children}
        </a>
    );
}

export default ExternalLink;
