import { describe, expect, it, vi } from 'vitest';

import { myAgentsDefaultTheme } from './themes/myagents-default';
import { ThemeRegistry, themeRegistry, validateThemeDefinition } from './registry';
import {
  collectContractBlocks,
  collectDeclaredTokens,
  parseThemeStylesheet,
} from './stylesheet-contract';
import type { ThemeDefinition } from './types';
import { SYNTHETIC_THEME_ID, syntheticTheme } from './__tests__/syntheticTheme';

function renamedSyntheticTheme(id: string): ThemeDefinition {
  const definition = structuredClone(syntheticTheme) as ThemeDefinition;
  definition.id = id;
  definition.displayName = `Synthetic ${id}`;
  definition.stylesheetText = definition.stylesheetText.replaceAll(SYNTHETIC_THEME_ID, id);
  return definition;
}

function presetTokens(
  definition: ThemeDefinition,
  scheme: 'light' | 'dark',
): ReadonlyMap<string, string> {
  const stylesheet = parseThemeStylesheet(definition.stylesheetText);
  const collect = (selector: string) => {
    const blocks = collectContractBlocks(
      stylesheet.topLevelBlocks,
      selector,
      [[selector]],
      `test selector ${selector}`,
    );
    return collectDeclaredTokens(blocks);
  };
  return new Map([
    ...collect(`html[data-theme-id='${definition.id}']`).entries(),
    ...collect(`html[data-theme-id='${definition.id}'][data-color-scheme='${scheme}']`).entries(),
  ]);
}

describe('ThemeRegistry', () => {
  const productionThemeIds = [
    'myagents-light',
    'myagents-default',
    'default-black',
    'sage',
    'absolutely',
    'linear',
    'proof',
    'codex',
    'raycast',
  ];

  it('ships nine complete production Themes in product order', () => {
    expect(themeRegistry.getProductionIds()).toEqual(productionThemeIds);
    expect(themeRegistry.getAcceptedDefinitions().map(definition => definition.displayName)).toEqual([
      'MyAgents Light',
      'MyAgents Classic',
      'MyAgents Classic2',
      'Sage',
      'Claude',
      'Linear',
      'Proof',
      'Codex',
      'Raycast',
    ]);
    expect(themeRegistry.getProductionIds()).not.toContain(SYNTHETIC_THEME_ID);
  });

  it('resolves an omitted preference to the current product default', () => {
    expect(themeRegistry.resolve(undefined, 'light', false).themeId).toBe('myagents-light');
  });

  it('registers every production Theme on WebViews without color-mix support', () => {
    // macOS 13.0 ships WebKit 16.1. An unsupported required material must
    // never make canonical Theme registration throw before the app mounts.
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    const parser = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
      .mockImplementation(function (this: CSSStyleDeclaration, property, value, priority) {
        if (value?.includes('color-mix(')) return;
        setProperty.call(this, property, value, priority);
      });
    try {
      const registry = new ThemeRegistry(themeRegistry.getAcceptedDefinitions());
      expect(registry.getAcceptedDefinitions().map(({ id }) => id)).toEqual(productionThemeIds);
    } finally {
      parser.mockRestore();
    }
  });

  it('derives selector swatches from each Theme package primary action tokens', () => {
    for (const themeId of productionThemeIds) {
      const swatches = themeRegistry.getPreviewSwatches(themeId);
      expect(swatches.light, `${themeId}.light`).toMatch(/^#/);
      expect(swatches.dark, `${themeId}.dark`).toMatch(/^#/);
    }
    expect(themeRegistry.getPreviewSwatches('myagents-default').light).toBe('#c26d3a');
    expect(themeRegistry.getPreviewSwatches('default-black').light).toBe('#111111');
    expect(themeRegistry.getPreviewSwatches('myagents-light').light).toBe('#111111');
  });

  it('keeps Theme and Appearance orthogonal for every production package', () => {
    for (const themeId of productionThemeIds) {
      const light = themeRegistry.resolve(themeId, 'light', true);
      const dark = themeRegistry.resolve(themeId, 'dark', false);
      const systemLight = themeRegistry.resolve(themeId, 'system', false);
      const systemDark = themeRegistry.resolve(themeId, 'system', true);

      expect(light.themeId).toBe(themeId);
      expect(light.appearanceMode).toBe('light');
      expect(light.resolvedColorScheme).toBe('light');
      expect(dark.themeId).toBe(themeId);
      expect(dark.appearanceMode).toBe('dark');
      expect(dark.resolvedColorScheme).toBe('dark');
      expect(systemLight.resolvedColorScheme).toBe('light');
      expect(systemDark.resolvedColorScheme).toBe('dark');
    }
  });

  it('derives embedded adapters and Hero from each accepted package', () => {
    for (const definition of themeRegistry.getAcceptedDefinitions()) {
      for (const scheme of ['light', 'dark'] as const) {
        const resolved = themeRegistry.resolve(definition.id, scheme, false);
        expect(resolved.hero.productName).toBe('MyAgents');
        expect(resolved.hero.slogans['zh-CN']).toBe('每个人都应享受智能的推背感，欢迎来到言出法随的世界');
        expect(resolved.hero.slogans['en-US']).toBe('Your intent, amplified');
        expect(resolved.adapters.xterm.palette.cursor).toBeTruthy();
        expect(resolved.adapters.monaco.data.colors['editorCursor.foreground']).toBeTruthy();
        expect(resolved.adapters.mermaid.themeVariables.primaryColor).toBeTruthy();
        expect(resolved.adapters.prism['code[class*="language-"]']).toBeTruthy();
        expect(resolved.adapters.widget.variables['--widget-accent']).toBeTruthy();
      }
    }
  });

  it('derives optional Widget geometry and material from the same host Theme tokens', () => {
    for (const definition of themeRegistry.getAcceptedDefinitions().filter(
      candidate => candidate.id !== 'myagents-default' && candidate.id !== 'default-black',
    )) {
      for (const scheme of ['light', 'dark'] as const) {
        const tokens = presetTokens(definition, scheme);
        const variables = definition.schemes[scheme].widget.variables;
        expect(variables['--widget-radius-track']).toBe(tokens.get('--theme-radius-base'));
        expect(variables['--widget-radius-control']).toBe(tokens.get('--theme-radius-sm'));
        expect(variables['--widget-radius-card']).toBe(tokens.get('--theme-radius-lg'));
        expect(variables['--widget-radius-full']).toBe(tokens.get('--theme-radius-full'));
        expect(variables['--widget-control-shadow']).toBe(tokens.get('--theme-shadow-base'));
      }
    }
  });

  it('projects every adapter and Hero slot from a complete synthetic Theme', () => {
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);
    const light = registry.resolve(SYNTHETIC_THEME_ID, 'light', true);
    const dark = registry.resolve(SYNTHETIC_THEME_ID, 'dark', false);

    expect(light.themeId).toBe(SYNTHETIC_THEME_ID);
    expect(light.hero.productName).toBe('Synthetic Agents');
    expect(light.hero.slogans['en-US']).toBe('Synthetic theme sentinel');
    expect(light.adapters.xterm.palette.background).toBe('#fff0ff');
    expect(light.adapters.monaco.name).toBe('synthetic-light-monaco');
    expect(light.adapters.mermaid.themeVariables.primaryColor).toBe('#efd0f5');
    expect(light.adapters.prism['code[class*="language-"]'].color).toBe('#21002f');
    expect(light.adapters.widget.variables['--widget-text']).toBe('#21002f');
    expect(dark.adapters.xterm.palette.background).toBe('#120012');
    expect(dark.hero.background.position).toBe('right top');
  });

  it('rejects duplicate IDs and incomplete Theme packages', () => {
    expect(() => new ThemeRegistry([myAgentsDefaultTheme, myAgentsDefaultTheme])).toThrow('Duplicate Theme ID');

    const missingToken = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(/\s*--ink\s*:[^;]+;/, ''),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(missingToken)).toThrow('missing CSS tokens');

    const missingDisplayName = { ...syntheticTheme, displayName: '' } as ThemeDefinition;
    expect(() => validateThemeDefinition(missingDisplayName)).toThrow('displayName is required');

    const missingWidgetVariable = structuredClone(syntheticTheme) as ThemeDefinition;
    delete (missingWidgetVariable.schemes.light.widget.variables as Partial<typeof missingWidgetVariable.schemes.light.widget.variables>)['--widget-text'];
    expect(() => validateThemeDefinition(missingWidgetVariable)).toThrow('missing Widget variables');

    const remoteHeroAsset = structuredClone(syntheticTheme) as ThemeDefinition;
    remoteHeroAsset.hero.backgrounds.light.assetUrl = 'https://example.com/theme.jpg';
    expect(() => validateThemeDefinition(remoteHeroAsset)).toThrow('must be a bundled/self asset');

    const injectedHeroAsset = structuredClone(syntheticTheme) as ThemeDefinition;
    injectedHeroAsset.hero.backgrounds.light.assetUrl = 'hero.png"), url("https://example.com/tracker.png';
    expect(() => validateThemeDefinition(injectedHeroAsset)).toThrow('must be a bundled/self asset');

    const descendantTokens = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'] {",
        "html[data-theme-id='synthetic-test-theme'] .descendant {",
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(descendantTokens)).toThrow('unsupported or unscoped selector');

    const whitespaceDescendantTokens = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'] {",
        "html [data-theme-id='synthetic-test-theme'] {",
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(whitespaceDescendantTokens)).toThrow('unsupported or unscoped selector');

    const escapedTypeSelector = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'] {",
        "html\\[data-theme-id='synthetic-test-theme'] {",
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedTypeSelector)).toThrow('unsupported or unscoped selector');

    const spacedAttributeSyntax = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'] {",
        'html[data-theme-id = "synthetic-test-theme"] {',
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(spacedAttributeSyntax)).not.toThrow();

    const invalidCompanionSelector = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'] {",
        "html[data-theme-id='synthetic-test-theme'], :unknown-pseudo {",
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(invalidCompanionSelector)).toThrow('unsupported or unscoped selector');

    const optionalGlobalFallback = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n:root { --paper: red !important; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(optionalGlobalFallback)).toThrow('reserved for the canonical paired fallback');

    const nestedOptionalSchemeFallback = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@media (min-width: 1px) { html[data-color-scheme='dark'] { --paper: red; } }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(nestedOptionalSchemeFallback)).toThrow('reserved for the canonical paired fallback');

    const nestedOptionalSchemeDescendant = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@supports (display: grid) { html[data-color-scheme='dark'] body { color: red; } }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(nestedOptionalSchemeDescendant)).toThrow('unsupported or unscoped selector');

    const conditionallyScopedRoot = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@media (min-width: 999999px) { html[data-theme-id='synthetic-test-theme'] { --ink: red; } }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(conditionallyScopedRoot)).toThrow('conditional rules may only target scoped Hero selectors');

    const conditionallyHiddenPackage = {
      ...syntheticTheme,
      stylesheetText: `@media (min-width: 999999px) { ${syntheticTheme.stylesheetText} }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(conditionallyHiddenPackage)).toThrow('conditional rules may only target scoped Hero selectors');

    const globalPropertyRegistration = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@property --ink { syntax: "<color>"; inherits: false; initial-value: red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(globalPropertyRegistration)).toThrow('unsupported at-rule');

    const rawTailwindTheme = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@theme { --shadow-sm: 0 0 1px red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(rawTailwindTheme)).toThrow('unsupported at-rule');

    const escapedTailwindTheme = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@th\\65me { --shadow-sm: 0 0 1px red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedTailwindTheme)).toThrow('unsupported at-rule');

    const semicolonSelectorBypass = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@media screen; :root { --paper: red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(semicolonSelectorBypass)).toThrow('unsupported top-level statement');

    const semicolonPropertyBypass = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@media screen; @property --ink { syntax: "<color>"; inherits: false; initial-value: red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(semicolonPropertyBypass)).toThrow('unsupported top-level statement');

    const trailingAtRuleStatement = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@layer theme-order;`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(trailingAtRuleStatement)).toThrow('unsupported top-level statement');

    const trailingGarbage = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\nnot-a-css-rule`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(trailingGarbage)).toThrow('unsupported trailing content');

    const nestedSemicolonAtRule = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n@media screen { html[data-theme-id='synthetic-test-theme'] .theme-launcher-hero-title { font-size: 2rem; } @layer nested-order; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(nestedSemicolonAtRule)).toThrow('unsupported at-rule');

    const nestedDescendantRule = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\nhtml[data-theme-id='synthetic-test-theme'] { .adversarial-hidden { display: none; } }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(nestedDescendantRule)).toThrow('must contain declarations only');

    const nestedHeroRule = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\nhtml[data-theme-id='synthetic-test-theme'] .theme-launcher-hero-title { & .adversarial-hidden { display: none; } }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(nestedHeroRule)).toThrow('must contain declarations only');

    const badStringRecoveryNesting = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\nhtml[data-theme-id='synthetic-test-theme'] {\n  --junk: "\n;\n  .adversarial-hidden { display: none; }\n  ";\n}`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(badStringRecoveryNesting)).toThrow('must contain declarations only');

    const optionalArbitraryGlobalRule = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\nbody { color: red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(optionalArbitraryGlobalRule)).toThrow('unsupported or unscoped selector');

    const optionalHeroFallback = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n.theme-launcher-hero-title { color: red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(optionalHeroFallback)).toThrow('reserved for the canonical paired fallback');

    const standaloneCanonicalFallback = {
      ...myAgentsDefaultTheme,
      stylesheetText: `${myAgentsDefaultTheme.stylesheetText}\n:root { --paper: red; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(standaloneCanonicalFallback)).toThrow('reserved for the canonical paired fallback');

    const lateCanonicalOverride = {
      ...myAgentsDefaultTheme,
      stylesheetText: `${myAgentsDefaultTheme.stylesheetText}\nhtml[data-theme-id='myagents-default'][data-color-scheme='light'] { --ink: initial; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(lateCanonicalOverride)).toThrow('unsupported or unscoped selector');

    const escapedCanonicalOverride = {
      ...myAgentsDefaultTheme,
      stylesheetText: `${myAgentsDefaultTheme.stylesheetText}\nhtml[data-theme-id='myagents-def\\61ult'][data-color-scheme='light'] { --ink: initial; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedCanonicalOverride)).toThrow('unsupported or unscoped selector');

    const splitCanonicalGlobalFallback = {
      ...myAgentsDefaultTheme,
      stylesheetText: `${myAgentsDefaultTheme.stylesheetText.replace(/\s*--font-body\s*:[^;]+;/, '')}\nhtml[data-theme-id='myagents-default'] { --font-body: system-ui, sans-serif; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(splitCanonicalGlobalFallback)).toThrow('unsupported or unscoped selector');

    const splitCanonicalSchemeFallback = {
      ...myAgentsDefaultTheme,
      stylesheetText: `${myAgentsDefaultTheme.stylesheetText.replace(/\s*--ink\s*:[^;]+;/, '')}\nhtml[data-theme-id='myagents-default'][data-color-scheme='light'] { --ink: #1c1612; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(splitCanonicalSchemeFallback)).toThrow('unsupported or unscoped selector');

    const invalidHeroCombinator = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'] .theme-launcher-hero-title",
        "html[data-theme-id='synthetic-test-theme'].theme-launcher-hero-title",
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(invalidHeroCombinator)).toThrow('unsupported or unscoped selector');

    const escapedHeroOverride = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\nhtml[data-theme-id='synthetic-test-theme'] .theme-launcher-hero-\\74itle { color: initial; }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedHeroOverride)).toThrow('unsupported or unscoped selector');

    const invalidSchemeOverride = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        "html[data-theme-id='synthetic-test-theme'][data-color-scheme='light'] {\n  --theme-body-background:",
        "html[data-theme-id='synthetic-test-theme'][data-color-scheme='light'] {\n  --ink: initial !important;\n  --theme-body-background:",
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(invalidSchemeOverride)).toThrow('must not use !important');

    const unresolvedToken = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace('--ink: #21002f;', '--ink: var(--missing-ink);'),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(unresolvedToken)).toThrow('missing CSS tokens');

    const wrongTokenSyntax = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace('--ink: #21002f;', '--ink: 12px;'),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(wrongTokenSyntax)).toThrow('missing CSS tokens');

    const tokenHiddenInsideString = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(
        '--ink: #21002f;',
        '--unrelated: "; --ink: #21002f;";',
      ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(tokenHiddenInsideString)).toThrow('missing CSS tokens');

    const quotedNumericThemeId = renamedSyntheticTheme('1theme');
    expect(() => validateThemeDefinition(quotedNumericThemeId)).not.toThrow();

    const invalidBareNumericThemeId = structuredClone(quotedNumericThemeId) as ThemeDefinition;
    invalidBareNumericThemeId.stylesheetText = invalidBareNumericThemeId.stylesheetText.replaceAll(
      "data-theme-id='1theme'",
      'data-theme-id=1theme',
    );
    expect(() => validateThemeDefinition(invalidBareNumericThemeId)).toThrow('unsupported or unscoped selector');

    const escapedCssWideToken = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace('--font-body: system-ui, sans-serif;', '--font-body: \\69nitial;'),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedCssWideToken)).toThrow('missing CSS tokens');

    const escapedUnresolvedToken = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace('--font-body: system-ui, sans-serif;', '--font-body: v\\61r(--missing-font);'),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedUnresolvedToken)).toThrow('missing CSS tokens');

    const importantGlobalToken = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText
        .replace('--font-body: system-ui, sans-serif;', '--font-body: initial !important;')
        .replace(
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='light'] {",
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='light'] {\n  --font-body: system-ui, sans-serif;",
        )
        .replace(
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='dark'] {",
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='dark'] {\n  --font-body: system-ui, sans-serif;",
        ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(importantGlobalToken)).toThrow('must not use !important');

    const spacedImportantGlobalToken = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText
        .replace('--font-body: system-ui, sans-serif;', '--font-body: initial ! important;')
        .replace(
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='light'] {",
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='light'] {\n  --font-body: system-ui, sans-serif;",
        )
        .replace(
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='dark'] {",
          "html[data-theme-id='synthetic-test-theme'][data-color-scheme='dark'] {\n  --font-body: system-ui, sans-serif;",
        ),
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(spacedImportantGlobalToken)).toThrow('must not use !important');

    const inheritedWidgetValue = structuredClone(syntheticTheme) as ThemeDefinition;
    inheritedWidgetValue.schemes.light.widget.variables['--widget-text'] = 'var(--ink)';
    expect(() => validateThemeDefinition(inheritedWidgetValue)).toThrow('iframe-ready CSS literal');

    const remoteStylesheet = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n.remote { background: url(https://example.com/tracker.png); }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(remoteStylesheet)).toThrow('must not reference remote assets');

    const remoteImageSet = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n.remote { background: image-set("https://example.com/tracker.png" 1x); }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(remoteImageSet)).toThrow('must not reference remote assets');

    const escapedRemoteStylesheet = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n.remote { background: u\\72l(https://example.com/tracker.png); }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(escapedRemoteStylesheet)).toThrow('must not reference remote assets');

    const continuedRemoteStylesheet = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n.remote { background: image-set("ht\\\ntps:/\\\n/example.com/tracker.png" 1x); }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(continuedRemoteStylesheet)).toThrow('must not reference remote assets');

    const quotedCommentRemoteStylesheet = {
      ...syntheticTheme,
      stylesheetText: `${syntheticTheme.stylesheetText}\n.remote { background: image-set("/*" 1x, "https://example.com/tracker.png" 2x, "*/" 3x); }`,
    } as ThemeDefinition;
    expect(() => validateThemeDefinition(quotedCommentRemoteStylesheet)).toThrow('must not reference remote assets');

    const whitespaceRemoteHero = structuredClone(syntheticTheme) as ThemeDefinition;
    whitespaceRemoteHero.hero.backgrounds.light.assetUrl = ' https://example.com/hero.png';
    expect(() => validateThemeDefinition(whitespaceRemoteHero)).toThrow('must be a bundled/self asset');

    const injectedWidgetValue = structuredClone(syntheticTheme) as ThemeDefinition;
    injectedWidgetValue.schemes.light.widget.variables['--widget-text'] = 'red; } body { color: blue';
    expect(() => validateThemeDefinition(injectedWidgetValue)).toThrow('iframe-ready CSS literal');

    const remoteWidgetValue = structuredClone(syntheticTheme) as ThemeDefinition;
    remoteWidgetValue.schemes.light.widget.variables['--widget-text'] = 'url(https://example.com/tracker.png)';
    expect(() => validateThemeDefinition(remoteWidgetValue)).toThrow('iframe-ready CSS literal');

    const cssWideWidgetValue = structuredClone(syntheticTheme) as ThemeDefinition;
    cssWideWidgetValue.schemes.light.widget.variables['--widget-text'] = 'initial';
    expect(() => validateThemeDefinition(cssWideWidgetValue)).toThrow('iframe-ready CSS literal');

    const wrongWidgetColorSyntax = structuredClone(syntheticTheme) as ThemeDefinition;
    wrongWidgetColorSyntax.schemes.light.widget.variables['--widget-text'] = '12px';
    expect(() => validateThemeDefinition(wrongWidgetColorSyntax)).toThrow('valid color syntax');

    const wrongXtermColorSyntax = structuredClone(syntheticTheme) as ThemeDefinition;
    wrongXtermColorSyntax.schemes.light.xterm.palette.background = '12px';
    expect(() => validateThemeDefinition(wrongXtermColorSyntax)).toThrow('xterm-compatible color');

    const cssWideXtermColor = structuredClone(syntheticTheme) as ThemeDefinition;
    cssWideXtermColor.schemes.light.xterm.palette.background = 'initial';
    expect(() => validateThemeDefinition(cssWideXtermColor)).toThrow('xterm-compatible color');

    const unsupportedTransparentXtermColor = structuredClone(syntheticTheme) as ThemeDefinition;
    unsupportedTransparentXtermColor.schemes.light.xterm.palette.selectionBackground = 'rgb(170 0 170 / 0.22)';
    expect(() => validateThemeDefinition(unsupportedTransparentXtermColor)).toThrow('xterm-compatible color');

    const supportedTransparentXtermColor = structuredClone(syntheticTheme) as ThemeDefinition;
    supportedTransparentXtermColor.schemes.light.xterm.palette.selectionBackground = 'rgba(170, 0, 170, 0.22)';
    expect(() => validateThemeDefinition(supportedTransparentXtermColor)).not.toThrow();

    const outOfRangeXtermChannel = structuredClone(syntheticTheme) as ThemeDefinition;
    outOfRangeXtermChannel.schemes.light.xterm.palette.background = 'rgb(256, 0, 0)';
    expect(() => validateThemeDefinition(outOfRangeXtermChannel)).toThrow('xterm-compatible color');

    const outOfRangeXtermAlpha = structuredClone(syntheticTheme) as ThemeDefinition;
    outOfRangeXtermAlpha.schemes.light.xterm.palette.selectionBackground = 'rgba(170, 0, 170, 1.1)';
    expect(() => validateThemeDefinition(outOfRangeXtermAlpha)).toThrow('xterm-compatible color');

    const numericPrismValue = structuredClone(syntheticTheme) as ThemeDefinition;
    (numericPrismValue.schemes.light.prism['code[class*="language-"]'] as Record<string, unknown>).flexGrow = 1;
    expect(() => validateThemeDefinition(numericPrismValue)).toThrow('must be a non-empty string');

    const stringPrismValue = structuredClone(syntheticTheme) as ThemeDefinition;
    stringPrismValue.schemes.light.prism['code[class*="language-"]'].flexGrow = '1';
    expect(() => validateThemeDefinition(stringPrismValue)).not.toThrow();

    const wrongPrismColorSyntax = structuredClone(syntheticTheme) as ThemeDefinition;
    wrongPrismColorSyntax.schemes.light.prism['code[class*="language-"]'].color = '12px';
    expect(() => validateThemeDefinition(wrongPrismColorSyntax)).toThrow('valid color syntax');

    const wrongPrismFontSize = structuredClone(syntheticTheme) as ThemeDefinition;
    wrongPrismFontSize.schemes.light.prism['code[class*="language-"]'].fontSize = 'red';
    expect(() => validateThemeDefinition(wrongPrismFontSize)).toThrow('valid font-size syntax');

    const unsupportedMermaidVariable = structuredClone(syntheticTheme) as ThemeDefinition;
    (unsupportedMermaidVariable.schemes.light.mermaid.themeVariables as Record<string, string>).mainBkg = '12px';
    expect(() => validateThemeDefinition(unsupportedMermaidVariable)).toThrow('unsupported Mermaid variables');

    const wrongWidgetRadiusSyntax = structuredClone(syntheticTheme) as ThemeDefinition;
    wrongWidgetRadiusSyntax.schemes.light.widget.variables['--widget-radius-card'] = 'red';
    expect(() => validateThemeDefinition(wrongWidgetRadiusSyntax)).toThrow('valid border-radius syntax');

    const wrongHeroPositionSyntax = structuredClone(syntheticTheme) as ThemeDefinition;
    wrongHeroPositionSyntax.hero.backgrounds.light.position = 'banana';
    expect(() => validateThemeDefinition(wrongHeroPositionSyntax)).toThrow('valid background-position syntax');

    const injectedMask = structuredClone(syntheticTheme) as ThemeDefinition;
    injectedMask.hero.backgrounds.light.mask = 'red), url(https://example.com/tracker.png';
    expect(() => validateThemeDefinition(injectedMask)).toThrow('must be a literal CSS color');

    const invalidMask = structuredClone(syntheticTheme) as ThemeDefinition;
    invalidMask.hero.backgrounds.light.mask = 'rgb(red)';
    expect(() => validateThemeDefinition(invalidMask)).toThrow('must be a literal CSS color');
  });

  it('falls back as one complete default Theme and diagnoses an unknown ID once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme]);

    const first = registry.resolve('missing-theme', 'dark', false);
    const second = registry.resolve('missing-theme', 'light', false);

    expect(first.requestedThemeId).toBe('missing-theme');
    expect(first.themeId).toBe('myagents-default');
    expect(first.definition).toBe(myAgentsDefaultTheme);
    expect(first.adapters).toBe(myAgentsDefaultTheme.schemes.dark);
    expect(second.adapters).toBe(myAgentsDefaultTheme.schemes.light);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid optional package without making the canonical registry unbootable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalidTheme = {
      ...syntheticTheme,
      stylesheetText: syntheticTheme.stylesheetText.replace(/\s*--ink\s*:[^;]+;/, ''),
    } as ThemeDefinition;

    const registry = new ThemeRegistry([myAgentsDefaultTheme, invalidTheme]);

    expect(registry.getProductionIds()).toEqual(['myagents-default']);
    expect(registry.resolve(invalidTheme.id, 'dark', false).themeId).toBe('myagents-default');
    expect(warn).toHaveBeenCalled();
  });

  it('contains optional construction failures inside the Registry boundary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validAfterFailure = renamedSyntheticTheme('synthetic-after-construction-failure');
    const registry = new ThemeRegistry(
      [myAgentsDefaultTheme],
      [
        {
          id: 'broken-construction',
          create: () => { throw new Error('adapter construction failed'); },
        },
        { id: validAfterFailure.id, create: () => validAfterFailure },
      ],
    );

    expect(registry.getProductionIds()).toEqual([
      'myagents-default',
      validAfterFailure.id,
    ]);
    expect(registry.resolve('broken-construction', 'light', false).themeId).toBe('myagents-default');
    expect(warn).toHaveBeenCalledWith(
      '[theme] Rejected invalid Theme package "broken-construction":',
      expect.any(Error),
    );
  });

  it.each([
    ['missing Token', (definition: ThemeDefinition) => {
      definition.stylesheetText = definition.stylesheetText.replace(/\s*--ink\s*:[^;]+;/, '');
    }],
    ['missing product wordmark', (definition: ThemeDefinition) => {
      definition.stylesheetText = definition.stylesheetText.replace(
        /\nhtml\[data-theme-id='[^']+'\] \.theme-product-wordmark \{[^}]*\}\n/,
        '\n',
      );
    }],
    ['missing scheme', (definition: ThemeDefinition) => {
      delete (definition.schemes as Partial<ThemeDefinition['schemes']>).dark;
    }],
    ['missing Hero', (definition: ThemeDefinition) => {
      delete (definition as Partial<ThemeDefinition>).hero;
    }],
    ['missing adapter', (definition: ThemeDefinition) => {
      delete (definition.schemes.light as Partial<ThemeDefinition['schemes']['light']>).widget;
    }],
    ['illegal selector', (definition: ThemeDefinition) => {
      definition.stylesheetText += '\nbody { color: red; }';
    }],
  ])('rejects an optional package with %s while accepting the following package', (_label, corrupt) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const invalid = renamedSyntheticTheme('synthetic-invalid-optional');
    const validAfterFailure = renamedSyntheticTheme('synthetic-valid-after-optional');
    corrupt(invalid);

    const registry = new ThemeRegistry(
      [myAgentsDefaultTheme],
      [
        { id: invalid.id, create: () => invalid },
        { id: validAfterFailure.id, create: () => validAfterFailure },
      ],
    );

    expect(registry.getProductionIds()).toEqual(['myagents-default', validAfterFailure.id]);
    expect(registry.resolve(invalid.id, 'dark', false).themeId).toBe('myagents-default');
    expect(warn).toHaveBeenCalled();
  });
});
