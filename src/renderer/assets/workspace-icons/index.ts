/**
 * Agent workspace identity icons.
 * Config stores an icon ID string (e.g. "fox", "rocket"); colour is bound to the
 * glyph or portrait, so the ID alone is the whole identity. Rendering lives in
 * `components/launcher/WorkspaceIcon`.
 */
import { WORKSPACE_ICON_GLYPHS, type WorkspaceIconId as WorkspaceGlyphId } from './glyphs';
import { WORKSPACE_ICON_PORTRAITS } from './portraits';

export { WORKSPACE_ICON_GLYPHS, WORKSPACE_ICON_HUES } from './glyphs';
export { WORKSPACE_ICON_PORTRAITS } from './portraits';
export type { WorkspaceIconGlyph, WorkspaceIconHue } from './glyphs';

/** One registry for resolution, rendering and both icon pickers. */
export const WORKSPACE_ICONS = { ...WORKSPACE_ICON_GLYPHS, ...WORKSPACE_ICON_PORTRAITS };
export type WorkspaceIconId = keyof typeof WORKSPACE_ICONS;

/**
 * Default icon for workspaces without a custom icon — e.g. ones added from a
 * local folder. Template-created agents carry their template's icon instead
 * (Mino: lightning).
 */
export const DEFAULT_WORKSPACE_ICON: WorkspaceIconId = 'project';

/**
 * IDs written by the previous (Phosphor) icon set. Saved configs keep these
 * strings, so they resolve at render time instead of being rewritten on disk.
 */
export const LEGACY_WORKSPACE_ICON_IDS: Readonly<Record<string, WorkspaceGlyphId>> = {
    cpu: 'robot',
    detective: 'owl',
    dog: 'paw',
    bird: 'feather',
    butterfly: 'bee',
    fish: 'whale',
    'paw-print': 'paw',
    bug: 'code',
    'bug-beetle': 'bee',
    'moon-stars': 'moon',
    star: 'sparkle',
    cloud: 'wave',
    rainbow: 'palette',
    meteor: 'rocket',
    lightbulb: 'wand',
    'music-note': 'music',
    guitar: 'music',
    headphones: 'music',
    'flower-lotus': 'leaf',
    plant: 'cactus',
    tree: 'mountain',
    mountains: 'mountain',
    fire: 'flame',
    umbrella: 'kite',
    diamond: 'gem',
    trophy: 'crown',
    gift: 'lantern',
    balloon: 'kite',
    alien: 'planet',
    'game-controller': 'gamepad',
    'puzzle-piece': 'dice',
    'folder-open': DEFAULT_WORKSPACE_ICON,
    cube: DEFAULT_WORKSPACE_ICON,
};

function isWorkspaceIconId(id: string): id is WorkspaceIconId {
    return Object.prototype.hasOwnProperty.call(WORKSPACE_ICONS, id);
}

/**
 * Resolve a stored icon value to a current identity ID. Returns undefined for
 * values that are not icon IDs (legacy emoji), which callers render as text.
 */
export function resolveWorkspaceIconId(icon: string | undefined | null): WorkspaceIconId | undefined {
    if (!icon) return DEFAULT_WORKSPACE_ICON;
    if (isWorkspaceIconId(icon)) return icon;
    return Object.prototype.hasOwnProperty.call(LEGACY_WORKSPACE_ICON_IDS, icon)
        ? LEGACY_WORKSPACE_ICON_IDS[icon]
        : undefined;
}

/** All selectable icon IDs in picker order (one ungrouped grid). */
export const ALL_WORKSPACE_ICON_IDS = Object.keys(WORKSPACE_ICONS) as WorkspaceIconId[];
