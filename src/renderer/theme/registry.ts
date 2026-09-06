import {
  CANONICAL_THEME_ID,
  normalizeAppearanceMode,
  normalizeThemeId,
  resolveColorScheme,
  type AppearanceMode,
} from '../../shared/theme';
import {
  REQUIRED_MERMAID_THEME_VARIABLES,
  REQUIRED_THEME_CSS_TOKENS,
  REQUIRED_WIDGET_CSS_VARIABLES,
  REQUIRED_XTERM_PALETTE_KEYS,
} from './registry-contract';
import {
  collectContractBlocks,
  collectDeclaredTokens,
  collectTopLevelCssBlocks,
  containsStructuralBrace,
  containsTopLevelSemicolon,
  decodeCssEscapes,
  parseThemeStylesheet,
  selectorListContainsExact,
  selectorListExactlyMatches,
  type ThemeCssBlock,
} from './stylesheet-contract';
import type { ResolvedTheme, ThemeDefinition, ThemePreviewSwatches } from './types';
import { absolutelyThemeManifest } from './themes/absolutely';
import { codexThemeManifest } from './themes/codex';
import { defaultBlackThemeManifest } from './themes/default-black';
import { linearThemeManifest } from './themes/linear';
import { myAgentsLightThemeManifest } from './themes/myagents-light';
import { myAgentsDefaultTheme } from './themes/myagents-default';
import { createPresetTheme, type PresetThemeManifest } from './themes/preset-theme';
import { proofThemeManifest } from './themes/proof';
import { raycastThemeManifest } from './themes/raycast';
import { sageThemeManifest } from './themes/sage';

export { REQUIRED_THEME_CSS_TOKENS, REQUIRED_WIDGET_CSS_VARIABLES } from './registry-contract';

const ALLOWED_PRISM_HOST_VARIABLES = new Set<string>([
  ...REQUIRED_THEME_CSS_TOKENS,
  '--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl', '--text-2xl', '--text-3xl',
]);

const THEME_PRESENTATION_CLASS_NAMES = [
  '.theme-product-wordmark',
  '.theme-launcher-hero-title',
  '.theme-launcher-hero-slogan',
] as const;

const RESPONSIVE_HERO_CLASS_NAMES = [
  '.theme-launcher-hero-title',
  '.theme-launcher-hero-slogan',
] as const;

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[theme] ${path} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[theme] ${path} must be a non-empty string`);
  }
}

function assertPositiveNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[theme] ${path} must be a positive number`);
  }
}

function assertStylesheetAtRuleScope(
  topLevelBlocks: readonly ThemeCssBlock[],
  definition: ThemeDefinition,
): void {
  const themeRootSelector = `html[data-theme-id='${definition.id}']`;
  const allowedHeroSelectorLists: string[][] = definition.id === CANONICAL_THEME_ID
    ? RESPONSIVE_HERO_CLASS_NAMES.map(className => [className, `${themeRootSelector} ${className}`])
    : RESPONSIVE_HERO_CLASS_NAMES.map(className => [`${themeRootSelector} ${className}`]);

  for (const block of topLevelBlocks.filter(candidate => candidate.prelude.trim().startsWith('@'))) {
    // Theme packages own runtime tokens plus brand and Launcher Hero presentation. Keep
    // global side-effect rules such as @property/@font-face out of the package,
    // while retaining the canonical responsive Hero typography.
    const decodedPrelude = decodeCssEscapes(block.prelude.trim());
    const mediaQuery = decodedPrelude.replace(/^@media\b/i, '').trim();
    if (!/^@media(?:\s|\()/i.test(decodedPrelude) || !mediaQuery || /[;{}@]/.test(mediaQuery)) {
      throw new Error(`[theme] ${definition.id}: stylesheet contains an unsupported at-rule`);
    }
    if (containsTopLevelSemicolon(block.body)) {
      throw new Error(`[theme] ${definition.id}: stylesheet contains an unsupported at-rule`);
    }
    const nestedBlocks = collectTopLevelCssBlocks(block.body, true);
    const invalidNestedBlock = nestedBlocks.find(nested => (
      nested.prelude.trim().startsWith('@')
      || !allowedHeroSelectorLists.some(selectors => selectorListExactlyMatches(nested.prelude, selectors))
    ));
    if (nestedBlocks.length === 0 || invalidNestedBlock) {
      throw new Error(`[theme] ${definition.id}: conditional rules may only target scoped Hero selectors`);
    }
  }
}

function assertCanonicalFallbackScope(
  blocks: readonly ThemeCssBlock[],
  definition: ThemeDefinition,
  fallbackSelector: string,
  canonicalSelector: string,
  path: string,
): void {
  const fallbackBlocks = blocks.filter(block => selectorListContainsExact(block.prelude, fallbackSelector));
  const invalidBlock = fallbackBlocks.find(block => (
    definition.id !== CANONICAL_THEME_ID
    || !selectorListExactlyMatches(block.prelude, [fallbackSelector, canonicalSelector])
  ));
  if (invalidBlock) {
    throw new Error(`[theme] ${path}: fallback selector is reserved for the canonical paired fallback`);
  }
}

function assertStylesheetSelectorScope(blocks: readonly ThemeCssBlock[], definition: ThemeDefinition): void {
  const themeRootSelector = `html[data-theme-id='${definition.id}']`;
  const allowedSelectorLists: string[][] = [];
  if (definition.id === CANONICAL_THEME_ID) {
    allowedSelectorLists.push([':root', themeRootSelector]);
    for (const scheme of ['light', 'dark'] as const) {
      allowedSelectorLists.push([
        `html[data-color-scheme='${scheme}']`,
        `${themeRootSelector}[data-color-scheme='${scheme}']`,
      ]);
    }
    for (const className of THEME_PRESENTATION_CLASS_NAMES) {
      allowedSelectorLists.push([className, `${themeRootSelector} ${className}`]);
    }
  } else {
    allowedSelectorLists.push([themeRootSelector]);
    for (const scheme of ['light', 'dark'] as const) {
      allowedSelectorLists.push([`${themeRootSelector}[data-color-scheme='${scheme}']`]);
    }
    for (const className of THEME_PRESENTATION_CLASS_NAMES) {
      allowedSelectorLists.push([`${themeRootSelector} ${className}`]);
    }
  }

  const invalidBlock = blocks.find(block => (
    !block.prelude.trim().startsWith('@')
    && !allowedSelectorLists.some(selectors => selectorListExactlyMatches(block.prelude, selectors))
  ));
  if (invalidBlock) {
    throw new Error(`[theme] ${definition.id}: stylesheet contains an unsupported or unscoped selector`);
  }
}

function assertFlatDeclarationBlocks(blocks: readonly ThemeCssBlock[], definition: ThemeDefinition): void {
  const nestedSelectorBlock = blocks.find(block => (
    !block.prelude.trim().startsWith('@') && containsStructuralBrace(block.body)
  ));
  if (nestedSelectorBlock) {
    throw new Error(`[theme] ${definition.id}: Theme root and Hero rules must contain declarations only`);
  }
}

const CSS_WIDE_PREFIX = /^(?:initial|inherit|unset|revert|revert-layer)(?:\s|!|$)/i;
const IMPORTANT_PRIORITY = /!\s*important\s*$/i;

function containsRemoteReference(value: string): boolean {
  const decoded = decodeCssEscapes(value);
  return /(?:https?|ftp|file|javascript)\s*:/i.test(decoded) || /(^|[\s('"=,:])\/\//.test(decoded);
}

function containsControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function hasUsableToken(
  tokens: ReadonlyMap<string, string>,
  token: string,
  resolving: ReadonlySet<string> = new Set(),
): boolean {
  if (resolving.has(token)) return false;
  const rawValue = tokens.get(token)?.trim();
  const value = rawValue ? decodeCssEscapes(rawValue) : rawValue;
  if (!value || CSS_WIDE_PREFIX.test(value) || IMPORTANT_PRIORITY.test(value)) return false;

  const referencedTokens = [...value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)].map(match => match[1]);
  const valueWithoutSimpleReferences = value.replace(/var\(\s*--[a-zA-Z0-9-]+\s*\)/g, '');
  if (/var\s*\(/i.test(valueWithoutSimpleReferences)) return false;

  const nextResolving = new Set(resolving).add(token);
  return referencedTokens.every(reference => hasUsableToken(tokens, reference, nextResolving));
}

function hasImportantDeclaration(tokens: ReadonlyMap<string, string>): boolean {
  return [...tokens.values()].some(value => IMPORTANT_PRIORITY.test(decodeCssEscapes(value).trim()));
}

function assertSafeCssLiteral(value: string, path: string): void {
  const decoded = decodeCssEscapes(value);
  if (
    value !== value.trim()
    || containsControlCharacters(decoded)
    || /[;{}]/.test(decoded)
    || /\/\*|\*\//.test(decoded)
    || CSS_WIDE_PREFIX.test(decoded.trim())
    || IMPORTANT_PRIORITY.test(decoded)
    || /\b(?:var|env|url|image-set|cross-fade|element)\s*\(/i.test(decoded)
    || containsRemoteReference(decoded)
  ) {
    throw new Error(`[theme] ${path} must be an iframe-ready CSS literal`);
  }
}

function isLiteralCssColor(value: string): boolean {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return true;
  const number = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
  const percentage = `${number}%`;
  const alpha = `(?:${number}|${percentage})`;
  const hue = `${number}(?:deg|grad|rad|turn)?`;
  const rgbChannel = `(?:${number}|${percentage})`;
  const rgbComma = new RegExp(`^rgba?\\(\\s*${rgbChannel}\\s*,\\s*${rgbChannel}\\s*,\\s*${rgbChannel}(?:\\s*,\\s*${alpha})?\\s*\\)$`, 'i');
  const rgbSpace = new RegExp(`^rgba?\\(\\s*${rgbChannel}\\s+${rgbChannel}\\s+${rgbChannel}(?:\\s*\\/\\s*${alpha})?\\s*\\)$`, 'i');
  const hslComma = new RegExp(`^hsla?\\(\\s*${hue}\\s*,\\s*${percentage}\\s*,\\s*${percentage}(?:\\s*,\\s*${alpha})?\\s*\\)$`, 'i');
  const hslSpace = new RegExp(`^hsla?\\(\\s*${hue}\\s+${percentage}\\s+${percentage}(?:\\s*\\/\\s*${alpha})?\\s*\\)$`, 'i');
  const oklch = new RegExp(`^oklch\\(\\s*(?:${number}|${percentage})\\s+${number}\\s+${hue}(?:\\s*\\/\\s*${alpha})?\\s*\\)$`, 'i');
  return rgbComma.test(value) || rgbSpace.test(value) || hslComma.test(value) || hslSpace.test(value) || oklch.test(value);
}

function supportsCssProperty(property: string, value: string): boolean {
  // Theme registry is renderer-only. Use the browser's declaration parser as
  // the single CSS grammar authority in production and DOM tests alike.
  // JSDOM currently accepts negative transition durations, so keep that one
  // standards invariant explicit before asking the shared declaration API.
  if (property === 'transition-duration' && /^\s*-/.test(value)) return false;
  const style = document.createElement('div').style;
  style.setProperty(property, value);
  return style.getPropertyValue(property) !== '';
}

function resolveTokenValue(
  tokens: ReadonlyMap<string, string>,
  token: string,
  resolving: ReadonlySet<string> = new Set(),
): string | null {
  if (resolving.has(token)) return null;
  const rawValue = tokens.get(token);
  if (!rawValue) return null;
  const nextResolving = new Set(resolving).add(token);
  let unresolved = false;
  const resolved = decodeCssEscapes(rawValue).replace(
    /var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g,
    (_match, reference: string) => {
      const replacement = resolveTokenValue(tokens, reference, nextResolving);
      if (replacement === null) {
        unresolved = true;
        return '';
      }
      return replacement;
    },
  ).trim();
  return unresolved ? null : resolved;
}

function themeTokenProperty(token: string): string {
  if (token.startsWith('--font-')) return 'font-family';
  if (token.startsWith('--radius-') || token.startsWith('--theme-radius-')) return 'border-radius';
  if (token.startsWith('--duration-')) return 'transition-duration';
  if (token === '--theme-body-background' || token === '--featured-card-background') return 'background';
  if (token === '--theme-body-texture') return 'background-image';
  if (token === '--theme-body-texture-opacity') return 'opacity';
  if (token === '--theme-body-texture-blend') return 'mix-blend-mode';
  if (
    token.startsWith('--shadow-')
    || token.startsWith('--theme-shadow-')
    || token.startsWith('--action-shadow')
    || token.startsWith('--tool-shadow')
    || token === '--fb-window-shadow'
    || token === '--featured-card-shadow'
  ) return 'box-shadow';
  return 'color';
}

function widgetVariableProperty(variable: string): string {
  if (variable === '--widget-font-body') return 'font-family';
  if (variable.startsWith('--widget-radius-')) return 'border-radius';
  if (variable === '--widget-control-shadow') return 'box-shadow';
  return 'color';
}

function assertCssPropertyValue(value: string, property: string, path: string): void {
  if (!supportsCssProperty(property, value)) {
    throw new Error(`[theme] ${path} must be valid ${property} syntax`);
  }
}

function assertLiteralColorValue(value: string, path: string): void {
  if (!isLiteralCssColor(value)) {
    throw new Error(`[theme] ${path} must be a literal color`);
  }
}

function isXtermColor(value: string): boolean {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) return true;

  const functional = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|\d?\.\d+)\s*)?\)$/i,
  );
  if (!functional) return false;
  const channels = functional.slice(1, 4).map(Number);
  const alpha = functional[4] === undefined ? 1 : Number(functional[4]);
  return channels.every(channel => channel >= 0 && channel <= 255)
    && alpha >= 0
    && alpha <= 1;
}

function assertXtermColorValue(value: string, path: string): void {
  // xterm's parser always supports only hex and comma-separated rgb(a).
  // Other CSS colors depend on a Canvas fallback which rejects transparency
  // and is unavailable in non-browser consumers, so a Theme cannot rely on it.
  if (!isXtermColor(value)) {
    throw new Error(`[theme] ${path} must be an xterm-compatible color`);
  }
}

function cssPropertyName(reactProperty: string): string {
  return reactProperty.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
}

function assertPrismStyleValue(value: string, reactProperty: string, path: string): void {
  const hostVariable = value.match(/^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/)?.[1];
  if (hostVariable) {
    if (!ALLOWED_PRISM_HOST_VARIABLES.has(hostVariable)) {
      throw new Error(`[theme] ${path} references an unknown host CSS variable`);
    }
    return;
  }
  assertCssPropertyValue(value, cssPropertyName(reactProperty), path);
}

function validateStylesheet(definition: ThemeDefinition): ThemePreviewSwatches {
  assertNonEmptyString(definition.stylesheetText, `${definition.id}.stylesheetText`);
  const { cssText, topLevelBlocks, blocks } = parseThemeStylesheet(definition.stylesheetText);
  if (/@import\b/i.test(decodeCssEscapes(cssText)) || containsRemoteReference(cssText)) {
    throw new Error(`[theme] ${definition.id}: stylesheet must not reference remote assets`);
  }
  const themeRootSelector = `html[data-theme-id='${definition.id}']`;
  assertCanonicalFallbackScope(blocks, definition, ':root', themeRootSelector, `${definition.id} root`);
  for (const scheme of ['light', 'dark'] as const) {
    assertCanonicalFallbackScope(
      blocks,
      definition,
      `html[data-color-scheme='${scheme}']`,
      `${themeRootSelector}[data-color-scheme='${scheme}']`,
      `${definition.id}.${scheme} root`,
    );
  }
  for (const className of THEME_PRESENTATION_CLASS_NAMES) {
    assertCanonicalFallbackScope(
      blocks,
      definition,
      className,
      `${themeRootSelector} ${className}`,
      `${definition.id} presentation ${className}`,
    );
  }
  assertStylesheetSelectorScope(blocks, definition);
  assertFlatDeclarationBlocks(blocks, definition);
  assertStylesheetAtRuleScope(topLevelBlocks, definition);
  const acceptedGlobalSelectorLists = definition.id === CANONICAL_THEME_ID
    ? [[':root', themeRootSelector]]
    : [[themeRootSelector]];
  const globalTokens = collectDeclaredTokens(collectContractBlocks(
    topLevelBlocks,
    themeRootSelector,
    acceptedGlobalSelectorLists,
    `${definition.id} root`,
  ));
  if (hasImportantDeclaration(globalTokens)) {
    throw new Error(`[theme] ${definition.id}: Theme Token declarations must not use !important`);
  }
  const previewSwatches = {} as ThemePreviewSwatches;

  for (const scheme of ['light', 'dark'] as const) {
    const schemeRootSelector = `${themeRootSelector}[data-color-scheme='${scheme}']`;
    const acceptedSchemeSelectorLists = definition.id === CANONICAL_THEME_ID
      ? [[`html[data-color-scheme='${scheme}']`, schemeRootSelector]]
      : [[schemeRootSelector]];
    const schemeTokens = collectDeclaredTokens(collectContractBlocks(
      topLevelBlocks,
      schemeRootSelector,
      acceptedSchemeSelectorLists,
      `${definition.id}.${scheme} root`,
    ));
    if (hasImportantDeclaration(schemeTokens)) {
      throw new Error(`[theme] ${definition.id}.${scheme}: Theme Token declarations must not use !important`);
    }
    const effectiveTokens = new Map(globalTokens);
    for (const [token, value] of schemeTokens) effectiveTokens.set(token, value);
    const missingTokens = REQUIRED_THEME_CSS_TOKENS.filter(
      token => {
        if (!hasUsableToken(effectiveTokens, token)) return true;
        const resolvedValue = resolveTokenValue(effectiveTokens, token);
        return resolvedValue === null || !supportsCssProperty(themeTokenProperty(token), resolvedValue);
      },
    );
    if (missingTokens.length > 0) {
      throw new Error(`[theme] ${definition.id}.${scheme}: stylesheet missing CSS tokens: ${missingTokens.join(', ')}`);
    }
    const primary = resolveTokenValue(effectiveTokens, '--button-primary-bg');
    if (primary === null || !isLiteralCssColor(primary)) {
      throw new Error(`[theme] ${definition.id}.${scheme}: preview primary color is invalid`);
    }
    previewSwatches[scheme] = primary;
  }

  for (const className of THEME_PRESENTATION_CLASS_NAMES) {
    const presentationSelector = `${themeRootSelector} ${className}`;
    const acceptedPresentationSelectorLists = definition.id === CANONICAL_THEME_ID
      ? [[className, presentationSelector]]
      : [[presentationSelector]];
    const presentationBlocks = collectContractBlocks(
      topLevelBlocks,
      presentationSelector,
      acceptedPresentationSelectorLists,
      `${definition.id} presentation ${className}`,
    );
    if (presentationBlocks.length === 0) {
      throw new Error(`[theme] ${definition.id}: stylesheet missing presentation selector ${className}`);
    }
  }
  return previewSwatches;
}

function validateThemePackage(definition: ThemeDefinition): ThemePreviewSwatches {
  if (!definition.id || !definition.id.trim()) throw new Error('[theme] Theme ID is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.id)) {
    throw new Error(`[theme] Invalid Theme ID: ${definition.id}`);
  }
  if (!definition.displayName.trim()) throw new Error(`[theme] ${definition.id}: displayName is required`);
  if (!definition.description.trim()) throw new Error(`[theme] ${definition.id}: description is required`);
  const previewSwatches = validateStylesheet(definition);

  assertRecord(definition.hero, `${definition.id}.hero`);
  if (!definition.hero.productName.trim()) throw new Error(`[theme] ${definition.id}: Hero productName is required`);
  if (!definition.hero.slogans?.['zh-CN'] || !definition.hero.slogans?.['en-US']) {
    throw new Error(`[theme] ${definition.id}: Hero slogans must include zh-CN and en-US`);
  }

  for (const scheme of ['light', 'dark'] as const) {
    const schemeDefinition = definition.schemes?.[scheme];
    assertRecord(schemeDefinition, `${definition.id}.schemes.${scheme}`);
    assertRecord(schemeDefinition.xterm, `${definition.id}.schemes.${scheme}.xterm`);
    assertRecord(schemeDefinition.xterm.palette, `${definition.id}.schemes.${scheme}.xterm.palette`);
    for (const key of REQUIRED_XTERM_PALETTE_KEYS) {
      assertNonEmptyString(schemeDefinition.xterm.palette[key], `${definition.id}.schemes.${scheme}.xterm.palette.${key}`);
    }
    for (const [key, value] of Object.entries(schemeDefinition.xterm.palette)) {
      if (value === undefined) continue;
      assertNonEmptyString(value, `${definition.id}.schemes.${scheme}.xterm.palette.${key}`);
      assertXtermColorValue(value, `${definition.id}.schemes.${scheme}.xterm.palette.${key}`);
    }
    assertNonEmptyString(schemeDefinition.xterm.fontFamily, `${definition.id}.schemes.${scheme}.xterm.fontFamily`);
    assertCssPropertyValue(
      schemeDefinition.xterm.fontFamily,
      'font-family',
      `${definition.id}.schemes.${scheme}.xterm.fontFamily`,
    );
    assertPositiveNumber(schemeDefinition.xterm.fontSize, `${definition.id}.schemes.${scheme}.xterm.fontSize`);
    assertPositiveNumber(schemeDefinition.xterm.lineHeight, `${definition.id}.schemes.${scheme}.xterm.lineHeight`);
    assertRecord(schemeDefinition.monaco, `${definition.id}.schemes.${scheme}.monaco`);
    assertNonEmptyString(schemeDefinition.monaco.name, `${definition.id}.schemes.${scheme}.monaco.name`);
    assertNonEmptyString(schemeDefinition.monaco.fontFamily, `${definition.id}.schemes.${scheme}.monaco.fontFamily`);
    assertCssPropertyValue(
      schemeDefinition.monaco.fontFamily,
      'font-family',
      `${definition.id}.schemes.${scheme}.monaco.fontFamily`,
    );
    assertPositiveNumber(schemeDefinition.monaco.fontSize, `${definition.id}.schemes.${scheme}.monaco.fontSize`);
    assertPositiveNumber(schemeDefinition.monaco.lineHeight, `${definition.id}.schemes.${scheme}.monaco.lineHeight`);
    assertRecord(schemeDefinition.monaco.data, `${definition.id}.schemes.${scheme}.monaco.data`);
    if (!['vs', 'vs-dark', 'hc-black', 'hc-light'].includes(schemeDefinition.monaco.data.base)) {
      throw new Error(`[theme] ${definition.id}.schemes.${scheme}.monaco.data.base is invalid`);
    }
    if (typeof schemeDefinition.monaco.data.inherit !== 'boolean') {
      throw new Error(`[theme] ${definition.id}.schemes.${scheme}.monaco.data.inherit must be boolean`);
    }
    if (!Array.isArray(schemeDefinition.monaco.data.rules)) {
      throw new Error(`[theme] ${definition.id}.schemes.${scheme}.monaco.data.rules must be an array`);
    }
    for (const [index, rule] of schemeDefinition.monaco.data.rules.entries()) {
      for (const field of ['foreground', 'background'] as const) {
        const value = rule[field];
        if (value !== undefined && !/^[0-9a-f]{6,8}$/i.test(value)) {
          throw new Error(`[theme] ${definition.id}.schemes.${scheme}.monaco.data.rules.${index}.${field} must be a Monaco hex color`);
        }
      }
    }
    assertRecord(schemeDefinition.monaco.data.colors, `${definition.id}.schemes.${scheme}.monaco.data.colors`);
    assertNonEmptyString(
      schemeDefinition.monaco.data.colors['editor.background'],
      `${definition.id}.schemes.${scheme}.monaco.data.colors.editor.background`,
    );
    assertNonEmptyString(
      schemeDefinition.monaco.data.colors['editor.foreground'],
      `${definition.id}.schemes.${scheme}.monaco.data.colors.editor.foreground`,
    );
    for (const [key, value] of Object.entries(schemeDefinition.monaco.data.colors)) {
      assertNonEmptyString(value, `${definition.id}.schemes.${scheme}.monaco.data.colors.${key}`);
      if (!/^#[0-9a-f]{6,8}$/i.test(value)) {
        throw new Error(`[theme] ${definition.id}.schemes.${scheme}.monaco.data.colors.${key} must be a Monaco hex color`);
      }
    }
    assertRecord(schemeDefinition.mermaid, `${definition.id}.schemes.${scheme}.mermaid`);
    assertNonEmptyString(schemeDefinition.mermaid.fontFamily, `${definition.id}.schemes.${scheme}.mermaid.fontFamily`);
    assertCssPropertyValue(
      schemeDefinition.mermaid.fontFamily,
      'font-family',
      `${definition.id}.schemes.${scheme}.mermaid.fontFamily`,
    );
    assertRecord(schemeDefinition.mermaid.themeVariables, `${definition.id}.schemes.${scheme}.mermaid.themeVariables`);
    const mermaidKeys = Object.keys(schemeDefinition.mermaid.themeVariables);
    const unexpectedMermaidKeys = mermaidKeys.filter(key => !REQUIRED_MERMAID_THEME_VARIABLES.includes(
      key as (typeof REQUIRED_MERMAID_THEME_VARIABLES)[number],
    ));
    if (unexpectedMermaidKeys.length > 0) {
      throw new Error(`[theme] ${definition.id}.${scheme}: unsupported Mermaid variables: ${unexpectedMermaidKeys.join(', ')}`);
    }
    for (const key of REQUIRED_MERMAID_THEME_VARIABLES) {
      const value = schemeDefinition.mermaid.themeVariables[key];
      assertNonEmptyString(value, `${definition.id}.schemes.${scheme}.mermaid.themeVariables.${key}`);
      assertLiteralColorValue(value, `${definition.id}.schemes.${scheme}.mermaid.themeVariables.${key}`);
    }
    assertRecord(schemeDefinition.prism, `${definition.id}.schemes.${scheme}.prism`);
    if (Object.keys(schemeDefinition.prism).length === 0) {
      throw new Error(`[theme] ${definition.id}.schemes.${scheme}.prism must not be empty`);
    }
    for (const [selector, style] of Object.entries(schemeDefinition.prism)) {
      assertRecord(style, `${definition.id}.schemes.${scheme}.prism.${selector}`);
      for (const [property, value] of Object.entries(style)) {
        if (value === undefined) continue;
        assertNonEmptyString(value, `${definition.id}.schemes.${scheme}.prism.${selector}.${property}`);
        assertPrismStyleValue(value, property, `${definition.id}.schemes.${scheme}.prism.${selector}.${property}`);
      }
    }
    assertRecord(schemeDefinition.widget, `${definition.id}.schemes.${scheme}.widget`);
    assertRecord(schemeDefinition.widget.variables, `${definition.id}.schemes.${scheme}.widget.variables`);
    const missingWidgetVariables = REQUIRED_WIDGET_CSS_VARIABLES.filter(
      variable => !(variable in schemeDefinition.widget.variables),
    );
    if (missingWidgetVariables.length > 0) {
      throw new Error(`[theme] ${definition.id}.${scheme}: missing Widget variables: ${missingWidgetVariables.join(', ')}`);
    }
    for (const [variable, value] of Object.entries(schemeDefinition.widget.variables)) {
      if (!/^--widget-[a-z0-9-]+$/.test(variable)) {
        throw new Error(`[theme] ${definition.id}.${scheme}: invalid Widget variable name ${variable}`);
      }
      assertNonEmptyString(value, `${definition.id}.schemes.${scheme}.widget.variables.${variable}`);
      assertSafeCssLiteral(value, `${definition.id}.${scheme}.widget.variables.${variable}`);
      assertCssPropertyValue(
        value,
        widgetVariableProperty(variable),
        `${definition.id}.${scheme}.widget.variables.${variable}`,
      );
    }
    const heroBackground = definition.hero.backgrounds?.[scheme];
    assertRecord(heroBackground, `${definition.id}.hero.backgrounds.${scheme}`);
    if (heroBackground.assetUrl !== null) {
      assertNonEmptyString(heroBackground.assetUrl, `${definition.id}.hero.backgrounds.${scheme}.assetUrl`);
      const isBase64Raster = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+=*$/i.test(heroBackground.assetUrl);
      const isSafeSelfPath = heroBackground.assetUrl === heroBackground.assetUrl.trim()
        && !containsControlCharacters(heroBackground.assetUrl)
        && !/^[a-z][a-z0-9+.-]*:/i.test(heroBackground.assetUrl)
        && !heroBackground.assetUrl.startsWith('//')
        && !/["'()\\\r\n]/.test(heroBackground.assetUrl);
      if (!isBase64Raster && !isSafeSelfPath) {
        throw new Error(`[theme] ${definition.id}.hero.backgrounds.${scheme}.assetUrl must be a bundled/self asset`);
      }
    }
    assertNonEmptyString(heroBackground.position, `${definition.id}.hero.backgrounds.${scheme}.position`);
    assertSafeCssLiteral(heroBackground.position, `${definition.id}.hero.backgrounds.${scheme}.position`);
    assertCssPropertyValue(heroBackground.position, 'background-position', `${definition.id}.hero.backgrounds.${scheme}.position`);
    assertNonEmptyString(heroBackground.size, `${definition.id}.hero.backgrounds.${scheme}.size`);
    assertSafeCssLiteral(heroBackground.size, `${definition.id}.hero.backgrounds.${scheme}.size`);
    assertCssPropertyValue(heroBackground.size, 'background-size', `${definition.id}.hero.backgrounds.${scheme}.size`);
    assertNonEmptyString(heroBackground.repeat, `${definition.id}.hero.backgrounds.${scheme}.repeat`);
    assertSafeCssLiteral(heroBackground.repeat, `${definition.id}.hero.backgrounds.${scheme}.repeat`);
    assertCssPropertyValue(heroBackground.repeat, 'background-repeat', `${definition.id}.hero.backgrounds.${scheme}.repeat`);
    if (heroBackground.mask !== null) {
      assertNonEmptyString(heroBackground.mask, `${definition.id}.hero.backgrounds.${scheme}.mask`);
      if (!isLiteralCssColor(heroBackground.mask)) {
        throw new Error(`[theme] ${definition.id}.hero.backgrounds.${scheme}.mask must be a literal CSS color`);
      }
    }
  }

  return previewSwatches;
}

export function validateThemeDefinition(definition: ThemeDefinition): ThemeDefinition {
  validateThemePackage(definition);
  return definition;
}

export class ThemeRegistry {
  private readonly definitions = new Map<string, ThemeDefinition>();
  private readonly previewSwatches = new Map<string, ThemePreviewSwatches>();
  private readonly warnedUnknownIds = new Set<string>();
  private readonly presentationOrder: readonly string[];

  constructor(
    definitions: readonly ThemeDefinition[],
    optionalFactories: readonly OptionalThemeFactory[] = [],
    presentationOrder?: readonly string[],
  ) {
    const seenIds = new Set<string>();
    for (const definition of definitions) {
      if (seenIds.has(definition.id)) throw new Error(`[theme] Duplicate Theme ID: ${definition.id}`);
      seenIds.add(definition.id);
      if (definition.id === CANONICAL_THEME_ID) {
        this.register(definition);
        continue;
      }
      try {
        this.register(definition);
      } catch (error) {
        // Reject an invalid optional package without making the application
        // unbootable. Resolving its ID below then takes the whole-Theme default
        // fallback path; the canonical Theme itself always remains fail-fast.
        console.warn(`[theme] Rejected invalid Theme package "${definition.id}":`, error);
      }
    }
    for (const factory of optionalFactories) {
      if (seenIds.has(factory.id)) throw new Error(`[theme] Duplicate Theme ID: ${factory.id}`);
      seenIds.add(factory.id);
      try {
        const definition = factory.create();
        if (definition.id !== factory.id) {
          throw new Error(`[theme] Optional Theme factory "${factory.id}" produced "${definition.id}"`);
        }
        this.register(definition);
      } catch (error) {
        // Construction and validation share one Registry-owned rejection
        // boundary, so a malformed optional manifest cannot abort entry-module
        // evaluation before the canonical Theme can render.
        console.warn(`[theme] Rejected invalid Theme package "${factory.id}":`, error);
      }
    }
    if (!this.definitions.has(CANONICAL_THEME_ID)) {
      throw new Error(`[theme] Registry must include canonical Theme ${CANONICAL_THEME_ID}`);
    }
    if (presentationOrder) {
      const orderedIds = new Set(presentationOrder);
      if (orderedIds.size !== presentationOrder.length) {
        throw new Error('[theme] Product order must not contain duplicate Theme IDs');
      }
      const unknownIds = presentationOrder.filter(id => !seenIds.has(id));
      const omittedIds = [...seenIds].filter(id => !orderedIds.has(id));
      if (unknownIds.length > 0 || omittedIds.length > 0) {
        throw new Error(`[theme] Product order must cover every declared Theme ID (unknown: ${unknownIds.join(', ') || 'none'}; omitted: ${omittedIds.join(', ') || 'none'})`);
      }
      // A rejected optional package stays absent without disturbing the order
      // of the remaining accepted packages.
      this.presentationOrder = presentationOrder.filter(id => this.definitions.has(id));
    } else {
      this.presentationOrder = [...this.definitions.keys()];
    }
  }

  register(definition: ThemeDefinition): void {
    const previewSwatches = validateThemePackage(definition);
    if (this.definitions.has(definition.id)) throw new Error(`[theme] Duplicate Theme ID: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    this.previewSwatches.set(definition.id, previewSwatches);
  }

  getProductionIds(): readonly string[] {
    return [...this.presentationOrder];
  }

  /** Accepted, validated packages in product order. */
  getAcceptedDefinitions(): readonly ThemeDefinition[] {
    return this.presentationOrder.map(id => this.definitions.get(id)!);
  }

  getPreviewSwatches(themeId: string): ThemePreviewSwatches {
    return this.previewSwatches.get(themeId) ?? this.previewSwatches.get(CANONICAL_THEME_ID)!;
  }

  resolve(requestedThemeId: unknown, appearanceMode: unknown, systemPrefersDark: boolean): ResolvedTheme {
    const normalizedRequestedId = normalizeThemeId(requestedThemeId);
    const normalizedAppearanceMode: AppearanceMode = normalizeAppearanceMode(appearanceMode);
    const definition = this.definitions.get(normalizedRequestedId) ?? this.definitions.get(CANONICAL_THEME_ID)!;
    if (definition.id !== normalizedRequestedId && !this.warnedUnknownIds.has(normalizedRequestedId)) {
      this.warnedUnknownIds.add(normalizedRequestedId);
      console.warn(`[theme] Unknown Theme ID "${normalizedRequestedId}"; using ${CANONICAL_THEME_ID}`);
    }
    const resolvedColorScheme = resolveColorScheme(normalizedAppearanceMode, systemPrefersDark);
    return {
      requestedThemeId: normalizedRequestedId,
      themeId: definition.id,
      appearanceMode: normalizedAppearanceMode,
      resolvedColorScheme,
      definition,
      adapters: definition.schemes[resolvedColorScheme],
      hero: { ...definition.hero, background: definition.hero.backgrounds[resolvedColorScheme] },
      key: `${definition.id}:${resolvedColorScheme}`,
    };
  }
}

export interface OptionalThemeFactory {
  readonly id: string;
  readonly create: () => ThemeDefinition;
}

function presetFactory(manifest: PresetThemeManifest): OptionalThemeFactory {
  return {
    id: manifest.id,
    create: () => createPresetTheme(manifest),
  };
}

const defaultBlackFactory: OptionalThemeFactory = {
  id: defaultBlackThemeManifest.id,
  create: () => ({
    ...defaultBlackThemeManifest,
    hero: myAgentsDefaultTheme.hero,
    schemes: myAgentsDefaultTheme.schemes,
  }),
};

/** Production catalog order is also the product order shown by Settings. */
export const themeRegistry = new ThemeRegistry(
  [myAgentsDefaultTheme],
  [
    defaultBlackFactory,
    ...[
      myAgentsLightThemeManifest,
      sageThemeManifest,
      absolutelyThemeManifest,
      linearThemeManifest,
      proofThemeManifest,
      codexThemeManifest,
      raycastThemeManifest,
    ].map(presetFactory),
  ],
  [
    myAgentsLightThemeManifest.id,
    myAgentsDefaultTheme.id,
    defaultBlackThemeManifest.id,
    sageThemeManifest.id,
    absolutelyThemeManifest.id,
    linearThemeManifest.id,
    proofThemeManifest.id,
    codexThemeManifest.id,
    raycastThemeManifest.id,
  ],
);
