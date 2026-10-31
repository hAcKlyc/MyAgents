/** Identity colours from the approved companion / editorial group artwork.
 * Fixed foreground/background pairs keep nickname text legible in any Theme;
 * these are avatar content colours, not semantic success/error state colours.
 */
export const PEER_AVATAR_PALETTE = [
  { background: '#E8B35B', foreground: '#4B391F' }, // ochre
  { background: '#D59A7E', foreground: '#543528' }, // clay
  { background: '#B6C4A7', foreground: '#304638' }, // sage
  { background: '#A9C6D5', foreground: '#29434F' }, // sky
  { background: '#F0CEB0', foreground: '#5B3D2E' }, // peach
  { background: '#F1E2C6', foreground: '#554631' }, // cream
  { background: '#C8C9A6', foreground: '#41472F' }, // olive
  { background: '#AABCC1', foreground: '#2F4249' }, // slate
  { background: '#E3BAB0', foreground: '#58383C' }, // rose
] as const;
