import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Fixture home is injected through path APIs; never mutate the process HOME. */
async function bundleFixture(contents: string, output: string, home: string, profile?: string, format: 'esm' | 'cjs' = 'esm') {
  await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: 'profile-fixture.ts', loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format,
    define: profile === undefined ? {} : { __MYAGENTS_BUILD_PROFILE__: JSON.stringify(profile) },
    banner: format === 'esm' ? { js: 'import { createRequire as __fixtureRequire } from "node:module"; const require = __fixtureRequire(import.meta.url);' } : undefined,
    plugins: [{ name: 'fixture-home-path-api', setup(builder) {
      builder.onResolve({ filter: /^(node:)?os$/ }, args => args.namespace === 'fixture-os'
        ? { path: 'node:os', external: true } : { path: 'os', namespace: 'fixture-os' });
      builder.onLoad({ filter: /.*/, namespace: 'fixture-os' }, () => ({
        contents: `export * from 'node:os'; export const homedir = () => ${JSON.stringify(home)};`, loader: 'js',
      }));
      builder.onLoad({ filter: /[\\/]utils[\\/]platform\.ts$/ }, args => ({
        contents: readFileSync(args.path, 'utf8').replaceAll('const { home } = getCrossPlatformEnv();', `const home = ${JSON.stringify(home)};`), loader: 'ts',
      }));
    } }],
  });
}

const fixtureEntry = `
export * from './src/shared/appProfile';
export { DEFAULT_CONFIG } from './src/shared/config-types';
export { atomicModifyConfig, loadConfig, getProvidersDir } from './src/server/utils/admin-config';
export { getCliToolsBinDir, buildLauncherSource } from './src/server/utils/cli-tools-registry';
export { getMyAgentsNpmGlobalPrefix } from './src/server/utils/npm-prefix-env';
export { serializeAppRoute, parseAppRouteUrl, createSpaceHomeAppRoute } from './src/shared/appRoute';
export { saveSessionMetadata, getAllSessionMetadata } from './src/server/SessionStore';
export { buildSessionInboxSection } from './src/server/system-prompt-cli-tools';
`;

async function profiles() {
  const home = mkdtempSync(join(tmpdir(), 'app-profile-isolation-')); scratch.push(home);
  const standard = join(home, 'standard.mjs'), isolated = join(home, 'isolated.mjs');
  await bundleFixture(fixtureEntry, standard, home);
  await bundleFixture(fixtureEntry, isolated, home, 'moxbot');
  return { home, standard: await import(pathToFileURL(standard).href), isolated: await import(pathToFileURL(isolated).href) };
}

describe('compiled application profile isolation', () => {
  it('writes real config through its existing owner without reading or altering the other profile', async () => {
    const { home, standard, isolated } = await profiles();
    await standard.atomicModifyConfig((config: Record<string, unknown>) => ({ ...config, cliToolEnv: { probe: { PROFILE_LABEL: 'standard' } } }));
    const original = readFileSync(join(home, '.myagents', 'config.json'));
    expect(isolated.loadConfig().cliToolEnv).toBeUndefined();
    await isolated.atomicModifyConfig((config: Record<string, unknown>) => ({ ...config, cliToolEnv: { probe: { PROFILE_LABEL: 'isolated' } } }));
    expect(readFileSync(join(home, '.myagents', 'config.json'))).toEqual(original);
    expect(isolated.loadConfig().cliToolEnv.probe.PROFILE_LABEL).toBe('isolated');
    expect(standard.loadConfig().cliToolEnv.probe.PROFILE_LABEL).toBe('standard');
    expect(isolated.getProvidersDir()).toBe(resolve(home, '.moxbot', 'providers'));
    expect(isolated.getCliToolsBinDir()).toBe(resolve(home, '.moxbot', 'bin'));
    expect(isolated.getMyAgentsNpmGlobalPrefix(home, 'linux')).toBe(`${home}/.moxbot/npm-global`);
    expect(standard.APP_BUILD_PROFILE).toBe('myagents');
    expect(standard.DEFAULT_CONFIG.globalSummonShortcut.enabled).toBe(true);
    expect(isolated.DEFAULT_CONFIG.globalSummonShortcut.enabled).toBe(false);
    expect(isolated.APP_DISPLAY_NAME).toBe('MoXBots');
    expect(isolated.APP_WEBSITE_URL).toBe('https://140.143.183.232/');
    expect(standard.APP_WEBSITE_URL).toBe('https://myagents.io');
    expect(isolated.serializeAppRoute(isolated.createSpaceHomeAppRoute())).toBe('moxbot://open/v1/spaces');
    expect(isolated.parseAppRouteUrl('myagents://open/v1/spaces')).toBeNull();
    expect(isolated.buildSessionInboxSection({ type: 'desktop' })).toContain('moxbot session');
  });

  it('reads only its own persisted config before the generated launcher dispatches', async () => {
    const { home, standard, isolated } = await profiles();
    for (const [owner, label] of [[standard, 'standard'], [isolated, 'isolated']] as const) {
      await owner.atomicModifyConfig((config: Record<string, unknown>) => ({ ...config, cliToolEnv: { probe: { PROFILE_LABEL: label } } }));
    }
    const entry = join(home, 'probe.cjs');
    writeFileSync(entry, 'process.stdout.write(process.env.PROFILE_LABEL || "missing")');
    let dispatchedLabel: string | undefined;
    let exitCode: number | undefined;
    runInNewContext(isolated.buildLauncherSource('probe', entry), {
      require: (name: string) => {
        if (name === 'node:fs') return { readFileSync };
        if (name === 'node:path') return { join };
        if (name === 'node:os') return { homedir: () => home };
        if (name === 'node:child_process') return { spawnSync: (_command: string, _args: string[], options: { env: Record<string, string> }) => {
          dispatchedLabel = options.env.PROFILE_LABEL;
          return { status: 0 };
        } };
        throw new Error('Unexpected launcher dependency');
      },
      process: { execPath: 'fixture-node', argv: ['fixture-node', 'fixture-launcher'], env: {}, exit: (code: number) => { exitCode = code; } },
    });
    expect(dispatchedLabel).toBe('isolated');
    expect(exitCode).toBe(0);
    expect(existsSync(join(home, '.myagents', 'config.json'))).toBe(true);
  });

  it('persists SessionStore metadata in only the selected application root', async () => {
    const { home, standard, isolated } = await profiles();
    const metadata = (id: string) => ({ id, agentDir: join(home, 'workspace'), title: id, createdAt: '2026-10-13T00:00:00Z', lastActiveAt: '2026-10-13T00:00:00Z' });
    await standard.saveSessionMetadata(metadata('11111111-1111-4111-8111-111111111111'));
    const original = readFileSync(join(home, '.myagents', 'sessions.json'));
    expect(isolated.getAllSessionMetadata()).toEqual([]);
    await isolated.saveSessionMetadata(metadata('22222222-2222-4222-8222-222222222222'));
    expect(readFileSync(join(home, '.myagents', 'sessions.json'))).toEqual(original);
    expect(isolated.getAllSessionMetadata().map((entry: { id: string }) => entry.id)).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(standard.getAllSessionMetadata().map((entry: { id: string }) => entry.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('uses the selected CLI alias for real help and recovery suggestions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'app-profile-cli-')); scratch.push(home);
    for (const profile of ['myagents', 'moxbot']) {
      const output = join(home, `${profile}.mjs`);
      await bundleFixture(`export { TOP_HELP, publicCliHelp, validateExternalCliInvocation } from './src/cli/myagents';`, output, home, profile);
      const cli = await import(pathToFileURL(output).href);
      expect(cli.TOP_HELP).toContain(`Usage: ${profile} <command>`);
      expect(cli.publicCliHelp(['agent'])).toContain(`${profile} agent`);
      expect(cli.validateExternalCliInvocation(['unknown-command'], {}).suggestion).toBe(`Run ${profile} --help for the supported public commands.`);
      expect(cli.validateExternalCliInvocation(['agent'], {}).suggestedCommand).toBe(`${profile} agent --help`);
      if (profile === 'moxbot') expect(cli.TOP_HELP).not.toMatch(/\bmyagents (?:session|agent|task|runtime|model|--help)/);
    }
  });

  it('rejects an unknown compiled profile rather than selecting a shared home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'app-profile-invalid-')); scratch.push(home);
    const output = join(home, 'invalid.mjs');
    await bundleFixture(`export * from './src/shared/appProfile';`, output, home, 'other');
    await expect(import(pathToFileURL(output).href)).rejects.toThrow('Unsupported application build profile');
    expect(existsSync(join(home, '.myagents'))).toBe(false);
    expect(existsSync(join(home, '.moxbot'))).toBe(false);
  });
});
