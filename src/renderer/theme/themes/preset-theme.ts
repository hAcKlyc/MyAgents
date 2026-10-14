import { APP_BUILD_PROFILE, APP_DISPLAY_NAME } from '../../../shared/appProfile';
import type {
  ThemeDefinition,
  ThemeSchemeDefinition,
  WidgetThemeAdapter,
} from '../types';
import { createPrismStyle } from '../prism-style';
import {
  collectContractBlocks,
  collectDeclaredTokens,
  parseThemeStylesheet,
  type ParsedThemeStylesheet,
} from '../stylesheet-contract';

const XTERM_FONT = "'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'PingFang SC', 'Microsoft YaHei', monospace";

export interface PresetThemeManifest {
  id: string;
  displayName: string;
  description: string;
  stylesheetText: string;
}

type Scheme = 'light' | 'dark';

type TokenMap = ReadonlyMap<string, string>;

function collectTokens(stylesheet: ParsedThemeStylesheet, selector: string): TokenMap {
  const blocks = collectContractBlocks(
    stylesheet.topLevelBlocks,
    selector,
    [[selector]],
    `preset selector ${selector}`,
  );
  if (blocks.length === 0) {
    throw new Error(`[theme] Missing preset selector: ${selector}`);
  }
  return collectDeclaredTokens(blocks);
}

function requiredToken(tokens: TokenMap, token: string, context: string): string {
  const value = tokens.get(token);
  if (!value) throw new Error(`[theme] ${context}: missing adapter source ${token}`);
  return value;
}

function requiredHex(tokens: TokenMap, token: string, context: string): string {
  const value = requiredToken(tokens, token, context);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`[theme] ${context}: ${token} must be a six-digit hex color`);
  }
  return value;
}

function monacoHex(value: string): string {
  return value.slice(1);
}

function withAlpha(value: string, alpha: string): string {
  return `${value}${alpha}`;
}

function rgba(value: string, alpha: number): string {
  const number = Number.parseInt(value.slice(1), 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function createScheme(
  id: string,
  scheme: Scheme,
  globalTokens: TokenMap,
  schemeTokens: TokenMap,
): ThemeSchemeDefinition {
  const tokens = new Map([...globalTokens, ...schemeTokens]);
  const context = `${id}.${scheme}`;
  const text = requiredHex(tokens, '--ink', context);
  const textSecondary = requiredHex(tokens, '--ink-secondary', context);
  const muted = requiredHex(tokens, '--ink-muted', context);
  const subtle = requiredHex(tokens, '--ink-subtle', context);
  const paper = requiredHex(tokens, '--paper', context);
  const surface = requiredHex(tokens, '--paper-elevated', context);
  const inset = requiredHex(tokens, '--paper-inset', context);
  const accent = requiredHex(tokens, '--accent-warm', context);
  const accentHover = requiredHex(tokens, '--accent-warm-hover', context);
  const accentSubtle = requiredToken(tokens, '--accent-warm-subtle', context);
  const onAccent = requiredHex(tokens, '--on-accent', context);
  const cool = requiredHex(tokens, '--accent-cool', context);
  const success = requiredHex(tokens, '--success', context);
  const successBg = requiredToken(tokens, '--success-bg', context);
  const error = requiredHex(tokens, '--error', context);
  const errorBg = requiredToken(tokens, '--error-bg', context);
  const warning = requiredHex(tokens, '--warning', context);
  const warningBg = requiredToken(tokens, '--warning-bg', context);
  const info = requiredHex(tokens, '--info', context);
  const infoBg = requiredToken(tokens, '--info-bg', context);
  const line = requiredToken(tokens, '--line', context);
  const lineStrong = requiredToken(tokens, '--line-strong', context);
  const fontBody = requiredToken(tokens, '--font-body', context);
  const fontCode = requiredToken(tokens, '--font-code', context);
  const radiusTrack = requiredToken(tokens, '--theme-radius-base', context);
  const radiusControl = requiredToken(tokens, '--theme-radius-sm', context);
  const radiusCard = requiredToken(tokens, '--theme-radius-lg', context);
  const radiusFull = requiredToken(tokens, '--theme-radius-full', context);
  const controlShadow = requiredToken(tokens, '--theme-shadow-base', context);
  const codeBackground = requiredHex(tokens, '--code-bg', context);
  const codeText = requiredHex(tokens, '--code-text', context);
  const codeLineNumber = requiredHex(tokens, '--code-line-number', context);

  const widgetVariables = {
    '--widget-text': text,
    '--widget-text-secondary': muted,
    '--widget-text-muted': subtle,
    '--widget-bg': 'transparent',
    '--widget-bg-elevated': surface,
    '--widget-bg-inset': inset,
    '--widget-border': line,
    '--widget-border-strong': lineStrong,
    '--widget-accent': accent,
    '--widget-accent-hover': accentHover,
    '--widget-accent-subtle': accentSubtle,
    '--widget-success': success,
    '--widget-success-bg': successBg,
    '--widget-error': error,
    '--widget-error-bg': errorBg,
    '--widget-warning': warning,
    '--widget-warning-bg': warningBg,
    '--widget-info': info,
    '--widget-info-bg': infoBg,
    '--widget-primary-text': onAccent,
    '--widget-font-body': fontBody,
    '--widget-radius-track': radiusTrack,
    '--widget-radius-control': radiusControl,
    '--widget-radius-card': radiusCard,
    '--widget-radius-full': radiusFull,
    '--widget-control-shadow': controlShadow,
  } satisfies WidgetThemeAdapter['variables'];

  return {
    xterm: {
      palette: {
        background: paper,
        foreground: text,
        cursor: accent,
        cursorAccent: paper,
        selectionBackground: rgba(accent, scheme === 'light' ? 0.2 : 0.28),
        selectionForeground: undefined,
        selectionInactiveBackground: rgba(accent, scheme === 'light' ? 0.12 : 0.18),
        black: scheme === 'light' ? text : inset,
        red: error,
        green: success,
        yellow: warning,
        blue: info,
        magenta: accent,
        cyan: cool,
        white: textSecondary,
        brightBlack: muted,
        brightRed: error,
        brightGreen: success,
        brightYellow: warning,
        brightBlue: info,
        brightMagenta: accentHover,
        brightCyan: cool,
        brightWhite: text,
      },
      fontFamily: XTERM_FONT,
      fontSize: 14,
      lineHeight: 1.3,
    },
    monaco: {
      name: `${id}-${scheme}`,
      fontFamily: fontCode,
      fontSize: 14,
      lineHeight: 22,
      data: {
        base: scheme === 'light' ? 'vs' : 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: monacoHex(muted), fontStyle: 'italic' },
          { token: 'keyword', foreground: monacoHex(accent) },
          { token: 'storage', foreground: monacoHex(accent) },
          { token: 'string', foreground: monacoHex(success) },
          { token: 'number', foreground: monacoHex(warning) },
          { token: 'constant', foreground: monacoHex(warning) },
          { token: 'type', foreground: monacoHex(info) },
          { token: 'class', foreground: monacoHex(info) },
          { token: 'function', foreground: monacoHex(info) },
          { token: 'variable', foreground: monacoHex(textSecondary) },
          { token: 'operator', foreground: monacoHex(cool) },
          { token: 'tag', foreground: monacoHex(error) },
          { token: 'attribute.name', foreground: monacoHex(warning) },
          { token: 'attribute.value', foreground: monacoHex(success) },
          { token: 'delimiter', foreground: monacoHex(textSecondary) },
        ],
        colors: {
          'editor.background': paper,
          'editor.foreground': text,
          'editor.lineHighlightBackground': surface,
          'editor.selectionBackground': withAlpha(accent, scheme === 'light' ? '35' : '55'),
          'editor.inactiveSelectionBackground': withAlpha(accent, scheme === 'light' ? '20' : '35'),
          'editorLineNumber.foreground': muted,
          'editorLineNumber.activeForeground': textSecondary,
          'scrollbar.shadow': '#00000000',
          'scrollbarSlider.background': withAlpha(muted, '40'),
          'scrollbarSlider.hoverBackground': withAlpha(muted, '60'),
          'scrollbarSlider.activeBackground': withAlpha(muted, '80'),
          'editorGutter.background': paper,
          'editorCursor.foreground': accent,
          'editorIndentGuide.background': withAlpha(muted, '35'),
          'editorIndentGuide.activeBackground': withAlpha(muted, '65'),
        },
      },
    },
    mermaid: {
      theme: scheme === 'light' ? 'neutral' : 'dark',
      fontFamily: fontBody,
      themeVariables: {
        primaryColor: surface,
        primaryTextColor: text,
        primaryBorderColor: accent,
        lineColor: muted,
        secondaryColor: inset,
        tertiaryColor: paper,
      },
    },
    prism: createPrismStyle({
      background: codeBackground,
      text: codeText,
      textSecondary,
      muted: codeLineNumber,
      accent,
      success,
      error,
      warning,
      info,
      cool,
    }),
    widget: { variables: widgetVariables },
  };
}

const noHeroBackground = {
  assetUrl: null,
  position: 'center',
  size: 'cover',
  repeat: 'no-repeat',
  mask: null,
} as const;

/** Builds complete adapters from the same co-located CSS that owns host tokens. */
export function createPresetTheme(manifest: PresetThemeManifest): ThemeDefinition {
  const stylesheet = parseThemeStylesheet(manifest.stylesheetText);
  const globalTokens = collectTokens(
    stylesheet,
    `html[data-theme-id='${manifest.id}']`,
  );
  const schemes = Object.fromEntries((['light', 'dark'] as const).map(scheme => [
    scheme,
    createScheme(
      manifest.id,
      scheme,
      globalTokens,
      collectTokens(
        stylesheet,
        `html[data-theme-id='${manifest.id}'][data-color-scheme='${scheme}']`,
      ),
    ),
  ])) as Record<Scheme, ThemeSchemeDefinition>;

  return {
    ...manifest,
    hero: {
      productName: APP_DISPLAY_NAME,
      slogans: {
        'zh-CN': APP_BUILD_PROFILE === 'moxbot' ? '人定目标，Bot 团队协作执行' : '每个人都应享受智能的推背感，欢迎来到言出法随的世界',
        'en-US': APP_BUILD_PROFILE === 'moxbot' ? 'Set goals. Let your Bot team get to work.' : 'Your intent, amplified',
      },
      backgrounds: { light: noHeroBackground, dark: noHeroBackground },
    },
    schemes,
  };
}
