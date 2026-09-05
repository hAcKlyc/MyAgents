import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SUBSCRIPTION_PROVIDER_ID } from '../../shared/config-types';
import { applyWindowsUtf8SubprocessEnv, buildClaudeSessionEnv } from '../agent-session';
import {
  applyContextWindowSuffixForContextLength,
  lookupSnapshotModelContextLength,
  snapshotProviderModelContextLengths,
} from '../utils/model-capabilities';

describe('buildClaudeSessionEnv npm prefix isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not leak MyAgents npm prefix variables into the SDK shell env', () => {
    const home = process.platform === 'win32'
      ? 'C:\\Users\\myagents-test'
      : '/tmp/myagents-env-home';
    const prefix = process.platform === 'win32'
      ? resolve(home, '.myagents', 'npm-global')
      : `${home}/.myagents/npm-global`;
    const binDir = process.platform === 'win32' ? prefix : `${prefix}/bin`;
    const appBinDir = process.platform === 'win32'
      ? resolve(home, '.myagents', 'bin')
      : `${home}/.myagents/bin`;

    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home);
    vi.stubEnv('npm_config_prefix', prefix);
    vi.stubEnv('NPM_CONFIG_PREFIX', prefix);
    vi.stubEnv('PREFIX', prefix);
    vi.stubEnv(
      process.platform === 'win32' ? 'Path' : 'PATH',
      [binDir, appBinDir].join(delimiter),
    );

    const env = buildClaudeSessionEnv();
    const pathValue = env[process.platform === 'win32' ? 'Path' : 'PATH'] ?? '';

    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(env.PREFIX).toBeUndefined();
    expect(env.MYAGENTS_NPM_GLOBAL_PREFIX).toBe(prefix);
    const pathEntries = pathValue.split(delimiter);
    expect(pathEntries).toContain(binDir);
    expect(pathEntries).toContain(appBinDir);
    expect(pathEntries.indexOf(appBinDir)).toBeLessThan(pathEntries.indexOf(binDir));
  });
});

describe('Windows SDK subprocess UTF-8 env', () => {
  const tempHomes: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const home of tempHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is a no-op outside Windows', () => {
    const env: NodeJS.ProcessEnv = {};

    applyWindowsUtf8SubprocessEnv(env, { platform: 'darwin', useBashEnvPrelude: true });

    expect(env.LANG).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
  });

  it('sets UTF-8 locale and Python stdio env on Windows', () => {
    const env: NodeJS.ProcessEnv = {};

    applyWindowsUtf8SubprocessEnv(env, { platform: 'win32', useBashEnvPrelude: false });

    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.LESSCHARSET).toBe('utf-8');
    expect(env.BASH_ENV).toBeUndefined();
  });

  it('installs a Git Bash UTF-8 BASH_ENV prelude without touching an existing shell prefix', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'myagents-env-home-'));
    tempHomes.push(home);
    const env: NodeJS.ProcessEnv = {
      BASH_ENV: 'C:\\custom\\bash-env.sh',
      CLAUDE_CODE_SHELL_PREFIX: 'echo existing;',
    };

    applyWindowsUtf8SubprocessEnv(env, { platform: 'win32', useBashEnvPrelude: true, home });

    expect(env.BASH_ENV).toContain('windows-utf8-bash-env.sh');
    expect(env.MYAGENTS_ORIGINAL_BASH_ENV).toBe('C:/custom/bash-env.sh');
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBe('echo existing;');
    const prelude = readFileSync(env.BASH_ENV!, 'utf-8');
    expect(prelude).toContain('MYAGENTS_WINDOWS_UTF8');
    expect(prelude).toContain('MYAGENTS_ORIGINAL_BASH_ENV');
    expect(prelude).toContain('chcp.com 65001');
  });

  it('does not replace the BASH_ENV prelude when applied repeatedly', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'myagents-env-home-'));
    tempHomes.push(home);
    const env: NodeJS.ProcessEnv = {};

    applyWindowsUtf8SubprocessEnv(env, { platform: 'win32', useBashEnvPrelude: true, home });
    const once = env.BASH_ENV;
    applyWindowsUtf8SubprocessEnv(env, { platform: 'win32', useBashEnvPrelude: true, home });

    expect(env.BASH_ENV).toBe(once);
  });

  it.each([undefined, '0'])('enables PowerShell alongside Git Bash and UTF-8 with inherited switch %s', (inheritedSwitch) => {
    const home = mkdtempSync(resolve(tmpdir(), 'myagents-env-home-'));
    tempHomes.push(home);
    const inheritedGitBashPath = resolve(process.cwd(), 'package.json');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', inheritedGitBashPath);
    vi.stubEnv('CLAUDE_CODE_SHELL_PREFIX', 'echo existing;');
    vi.stubEnv('CLAUDE_CODE_USE_POWERSHELL_TOOL', inheritedSwitch);

    const env = buildClaudeSessionEnv();

    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe(inheritedGitBashPath);
    expect(env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.LC_ALL).toBe('C.UTF-8');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.LESSCHARSET).toBe('utf-8');
    expect(env.BASH_ENV).toContain('windows-utf8-bash-env.sh');
    expect(readFileSync(env.BASH_ENV!, 'utf-8')).toContain('chcp.com 65001');
    expect(env.CLAUDE_CODE_SHELL_PREFIX).toBe('echo existing;');
  });

  it('keeps the BASH_ENV prelude when Git Bash falls back to SDK PATH lookup', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'myagents-env-home-'));
    tempHomes.push(home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CLAUDE_CODE_GIT_BASH_PATH', resolve(home, 'missing-bash.exe'));

    const env = buildClaudeSessionEnv();

    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('');
    expect(env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBe('1');
    expect(env.BASH_ENV).toContain('windows-utf8-bash-env.sh');
    expect(readFileSync(env.BASH_ENV!, 'utf-8')).toContain('chcp.com 65001');
  });

  it.each(['darwin', 'linux'] as const)('does not opt into PowerShell on %s', (platform) => {
    const home = mkdtempSync(resolve(tmpdir(), 'myagents-env-home-'));
    tempHomes.push(home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CLAUDE_CODE_USE_POWERSHELL_TOOL', undefined);

    expect(buildClaudeSessionEnv().CLAUDE_CODE_USE_POWERSHELL_TOOL).toBeUndefined();
  });
});

describe('session model alias resolution', () => {
  it('uses the active model for built-in subagent alias env when aliases are collapsed', () => {
    const env = buildClaudeSessionEnv(
      {
        baseUrl: 'https://api.minimax.example',
        apiKey: 'test-key',
        modelAliases: {
          sonnet: 'MiniMax-M3',
          opus: 'MiniMax-M3',
          haiku: 'MiniMax-M3',
        },
      },
      'MiniMax-M2.7',
    );

    // #335 — MiniMax-M2.7's preset contextLength is 204_800 (> the SDK 200K
    // default), so the SDK-ingress `_MODEL` envs carry the `[1m]` unlock; the
    // display-label `_MODEL_NAME` env stays raw (applyContextWindowSuffix
    // contract: wrapped values flow ONLY into SDK ingress points).
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7[1m]');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBe('MiniMax-M2.7');
  });

  it('keeps split subagent alias env unchanged', () => {
    const env = buildClaudeSessionEnv(
      {
        baseUrl: 'https://api.deepseek.example',
        apiKey: 'test-key',
        modelAliases: {
          sonnet: 'provider-pro',
          opus: 'provider-pro',
          haiku: 'provider-flash',
        },
      },
      'provider-pro',
    );

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('provider-pro');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('provider-pro');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('provider-flash');
  });
});

describe('Claude Code provider-managed host env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not mark Anthropic subscription auth as host-managed', () => {
    vi.stubEnv('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', '1');

    const env = buildClaudeSessionEnv(
      {},
      'claude-opus-4-8',
      { providerId: SUBSCRIPTION_PROVIDER_ID },
    );

    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  });

  it('keeps host-managed provider env stripping for third-party providers', () => {
    const env = buildClaudeSessionEnv(
      {
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.example/anthropic',
        apiKey: 'test-key',
      },
      'deepseek-chat',
      { providerId: 'deepseek' },
    );

    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe('1');
  });
});

describe('Claude SDK context window env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('pins auto-compaction at 90% instead of inheriting the host value (#508)', () => {
    vi.stubEnv('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', '55');

    const env = buildClaudeSessionEnv(undefined, 'claude-opus-4-8');

    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('90');
  });

  it('keeps Claude 4.6 defaults at 200K without forcing SDK 1M disable flags (#392)', () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT', '');
    vi.stubEnv('CLAUDE_CODE_ENABLE_1M_CONTEXT', '1');

    const env = buildClaudeSessionEnv(undefined, 'claude-opus-4-6');

    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('');
    expect(env.CLAUDE_CODE_ENABLE_1M_CONTEXT).toBe('1');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
  });

  it('keeps Anthropic subscription 4.6 at 200K when another provider discovers the same model id as 1M (#444)', () => {
    const prevHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'myagents-env-home-'));
    try {
      mkdirSync(join(tempHome, '.myagents'), { recursive: true });
      writeFileSync(
        join(tempHome, '.myagents', 'config.json'),
        JSON.stringify({
          presetCustomModels: {
            'custom-dragon': [{ model: 'claude-opus-4-6', contextLength: 1_000_000 }],
          },
        }),
      );
      vi.stubEnv('HOME', tempHome);

      const subscriptionEnv = buildClaudeSessionEnv(
        { providerId: SUBSCRIPTION_PROVIDER_ID },
        'claude-opus-4-6',
        { providerId: SUBSCRIPTION_PROVIDER_ID },
      );
      const customEnv = buildClaudeSessionEnv(
        { providerId: 'custom-dragon', baseUrl: 'https://dragon.example', apiKey: 'test-key' },
        'claude-opus-4-6',
        { providerId: 'custom-dragon' },
      );

      expect(subscriptionEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
      expect(customEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('uses only the active provider row for context and adopts its later discovery metadata (#516)', () => {
    const prevHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'myagents-env-home-'));
    const providerDir = join(tempHome, '.myagents', 'providers');
    const cacheDir = join(tempHome, '.myagents', 'cache');
    const providerPath = join(providerDir, 'amd.json');
    try {
      mkdirSync(providerDir, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        providerPath,
        JSON.stringify({
          id: 'amd',
          models: [{ model: 'DeepSeek-V4-Flash', modelName: 'DeepSeek V4 Flash' }],
        }),
      );
      writeFileSync(
        join(cacheDir, 'litellm_model_prices.json'),
        JSON.stringify({
          'deepseek-v4-flash': { max_input_tokens: 1_000_000, mode: 'chat' },
          'tensormesh/deepseek-ai/DeepSeek-V4-Flash': { max_input_tokens: 32_768, mode: 'chat' },
        }),
      );
      vi.stubEnv('HOME', tempHome);
      const providerEnv = {
        providerId: 'amd',
        baseUrl: 'https://amd.example/v1',
        apiKey: 'test-key',
        apiProtocol: 'openai' as const,
        modelAliases: {
          sonnet: 'DeepSeek-V4-Flash',
          opus: 'DeepSeek-V4-Flash',
          haiku: 'DeepSeek-V4-Flash',
        },
      };

      const launchContextWindowSnapshot = snapshotProviderModelContextLengths(
        ['DeepSeek-V4-Flash'],
        'amd',
      );
      const beforeDiscovery = buildClaudeSessionEnv(
        providerEnv,
        'DeepSeek-V4-Flash',
        { providerId: 'amd', contextWindowSnapshot: launchContextWindowSnapshot },
      );
      expect(beforeDiscovery.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(beforeDiscovery.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('DeepSeek-V4-Flash');
      const beforeDiscoveryLaunchModel = applyContextWindowSuffixForContextLength(
        'DeepSeek-V4-Flash',
        lookupSnapshotModelContextLength(launchContextWindowSnapshot, 'DeepSeek-V4-Flash'),
      );

      writeFileSync(
        providerPath,
        JSON.stringify({
          id: 'amd',
          models: [{
            model: 'DeepSeek-V4-Flash',
            modelName: 'DeepSeek V4 Flash',
            contextLength: 1_048_576,
            source: 'discovered',
          }],
        }),
      );
      const afterDiscovery = buildClaudeSessionEnv(
        providerEnv,
        'DeepSeek-V4-Flash',
        { providerId: 'amd' },
      );
      const heldLaunchAfterDiscovery = buildClaudeSessionEnv(
        providerEnv,
        'DeepSeek-V4-Flash',
        { providerId: 'amd', contextWindowSnapshot: launchContextWindowSnapshot },
      );
      expect(afterDiscovery.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
      expect(afterDiscovery.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('DeepSeek-V4-Flash[1m]');
      expect(heldLaunchAfterDiscovery.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(heldLaunchAfterDiscovery.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('DeepSeek-V4-Flash');
      expect(beforeDiscoveryLaunchModel).toBe('DeepSeek-V4-Flash');
      expect(applyContextWindowSuffixForContextLength(
        'DeepSeek-V4-Flash',
        Number(afterDiscovery.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
      )).toBe('DeepSeek-V4-Flash[1m]');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('keeps Opus 4.7 / 4.8 on the default 1M window', () => {
    expect(buildClaudeSessionEnv(undefined, 'claude-opus-4-7').CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(buildClaudeSessionEnv(undefined, 'claude-opus-4-8').CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
  });

  it('keeps provider-routed sessions eligible for registry-backed SDK 1M unlocks', () => {
    const env = buildClaudeSessionEnv(
      {
        providerId: 'minimax',
        baseUrl: 'https://api.minimax.example',
        apiKey: 'test-key',
        modelAliases: {
          sonnet: 'MiniMax-M3',
          opus: 'MiniMax-M3',
          haiku: 'MiniMax-M3',
        },
      },
      'MiniMax-M2.7',
    );

    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('204800');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.7[1m]');
  });
});
