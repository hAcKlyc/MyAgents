/** Leaf contract export avoids a registry -> concrete Theme -> registry cycle. */
export const REQUIRED_THEME_CSS_TOKENS = [
  '--font-body', '--font-display', '--font-code',
  '--ink', '--ink-secondary', '--ink-muted', '--ink-subtle', '--ink-faint',
  '--paper', '--global-sidebar-bg', '--paper-elevated', '--message-user-bg', '--paper-inset',
  '--paper-a0', '--global-sidebar-bg-a0', '--paper-elevated-a0', '--message-user-bg-a0', '--paper-inset-a0', '--hover-bg',
  '--accent', '--accent-warm', '--accent-warm-hover', '--accent-warm-subtle',
  '--accent-warm-muted', '--accent-warm-subtle-a0', '--accent-cool', '--accent-cool-hover', '--on-accent',
  '--heartbeat', '--heartbeat-bg', '--heartbeat-border',
  '--success', '--success-bg', '--on-success', '--error', '--error-bg', '--error-hover', '--error-subtle', '--on-error',
  '--warning', '--warning-bg', '--on-warning', '--info', '--info-bg', '--on-info',
  '--button-primary-bg', '--button-primary-bg-hover', '--button-primary-text',
  '--button-dark-bg', '--button-dark-bg-hover', '--button-dark-text', '--button-secondary-bg',
  '--button-secondary-bg-hover', '--button-secondary-text',
  '--fb-surface-peek', '--fb-surface-glass', '--fb-surface-pin', '--fb-surface-pin-a0',
  '--fb-surface-pin-72', '--fb-surface-pin-95', '--fb-glass-border', '--fb-glass-border-soft',
  '--fb-highlight', '--fb-highlight-mid', '--fb-highlight-faint', '--fb-highlight-strong',
  '--fb-highlight-a0', '--fb-highlight-line', '--fb-mask-opaque', '--fb-shadow-strong',
  '--fb-shadow-soft', '--fb-shadow-panel', '--fb-shadow-preview', '--fb-core-shadow',
  '--fb-inset-shadow', '--fb-window-shadow', '--fb-control-hover', '--fb-line-input', '--fb-line-thumb',
  '--fb-drag-handle',
  '--line', '--line-strong', '--line-subtle',
  '--featured-card-background', '--featured-card-border', '--featured-card-shadow',
  '--theme-radius-base', '--theme-radius-sm', '--theme-radius-md', '--theme-radius-lg',
  '--theme-radius-xl', '--theme-radius-2xl', '--theme-radius-full',
  '--theme-shadow-base', '--theme-shadow-xs', '--theme-shadow-sm', '--theme-shadow-md',
  '--theme-shadow-lg', '--theme-shadow-xl', '--theme-shadow-2xl',
  '--action-shadow', '--action-shadow-active', '--tool-shadow', '--tool-shadow-hover',
  '--expanded-block-line', '--warning-border',
  '--focus-border', '--toggle-thumb', '--toggle-off-bg',
  '--code-bg', '--code-bg-a0', '--code-header-bg', '--code-text', '--code-line-number',
  '--duration-fast', '--duration-normal', '--duration-slow',
  '--theme-body-background', '--theme-body-texture', '--theme-body-texture-opacity',
  '--theme-body-texture-blend',
] as const;

export const REQUIRED_WIDGET_CSS_VARIABLES = [
  '--widget-text', '--widget-text-secondary', '--widget-text-muted',
  '--widget-bg', '--widget-bg-elevated', '--widget-bg-inset',
  '--widget-border', '--widget-border-strong',
  '--widget-accent', '--widget-accent-hover', '--widget-accent-subtle',
  '--widget-success', '--widget-success-bg', '--widget-error', '--widget-error-bg',
  '--widget-warning', '--widget-warning-bg', '--widget-info', '--widget-info-bg',
  '--widget-primary-text', '--widget-font-body', '--widget-radius-track',
  '--widget-radius-control', '--widget-radius-card', '--widget-radius-full',
  '--widget-control-shadow',
] as const;

export type WidgetCssVariable = (typeof REQUIRED_WIDGET_CSS_VARIABLES)[number];

export const REQUIRED_MERMAID_THEME_VARIABLES = [
  'primaryColor',
  'primaryTextColor',
  'primaryBorderColor',
  'lineColor',
  'secondaryColor',
  'tertiaryColor',
] as const;

export type MermaidThemeVariable = (typeof REQUIRED_MERMAID_THEME_VARIABLES)[number];

export const REQUIRED_XTERM_PALETTE_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionInactiveBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
