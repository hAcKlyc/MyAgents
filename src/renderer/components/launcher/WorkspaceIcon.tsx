/**
 * WorkspaceIcon — renders an Agent identity glyph, portrait or legacy emoji.
 * Glyphs are inline SVG in the "Accent" style: hue-coloured line work, a 14%
 * body tint and one solid focal detail. Colour comes from `--agent-icon-<hue>`
 * tokens so light and dark Themes both keep the identity legible.
 */

import { memo } from 'react';
import { WORKSPACE_ICONS, resolveWorkspaceIconId, type WorkspaceIconGlyph } from '@/assets/workspace-icons';

interface WorkspaceIconProps {
    icon?: string;
    size?: number;
    className?: string;
}

// Shared icon grid: 20-unit drawing shown through a 16.5-unit crop.
const VIEW_BOX = '1.75 1.75 16.5 16.5';
// Slightly lighter than UI glyphs so identity colour, not weight, carries the mark.
const STROKE = 1.3;

export default memo(function WorkspaceIcon({ icon, size = 24, className = '' }: WorkspaceIconProps) {
    const iconId = resolveWorkspaceIconId(icon);

    if (!iconId) {
        // Emoji fallback (legacy data or custom emoji)
        return (
            <span
                className={className}
                style={{ fontSize: size * 0.75, lineHeight: 1, width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            >
                {icon}
            </span>
        );
    }

    const identity = WORKSPACE_ICONS[iconId];
    if ('src' in identity) {
        return (
            <img
                src={identity.src}
                alt=""
                aria-hidden="true"
                draggable={false}
                width={size}
                height={size}
                className={`shrink-0 rounded-[25%] object-contain${className ? ` ${className}` : ''}`}
                data-workspace-icon={iconId}
            />
        );
    }
    const glyph: WorkspaceIconGlyph = identity;
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox={VIEW_BOX}
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            className={`shrink-0${className ? ` ${className}` : ''}`}
            style={{ color: `var(--agent-icon-${glyph.hue})` }}
            data-workspace-icon={iconId}
        >
            {glyph.body && <path d={glyph.body} fill="currentColor" fillOpacity={0.14} stroke="none" />}
            {glyph.line}
            {glyph.accent && <g fill="currentColor" stroke="none">{glyph.accent}</g>}
        </svg>
    );
});
