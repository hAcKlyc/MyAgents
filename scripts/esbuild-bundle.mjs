// Cross-platform esbuild driver for the three Node bundles we ship
// (server, plugin-bridge, CLI).
//
// Why this script exists: the previous inline `npm run build:*` commands
// embedded the esbuild banner via `--banner:js='...'` with single quotes.
// That worked under bash/zsh on macOS/Linux but **broke under Windows
// `cmd.exe`**, which doesn't recognise single quotes — it just split the
// banner arg on whitespace, and esbuild aborted with:
//
//   ✘ ERROR  Must use "outdir" when there are multiple input files
//
// Switching to the JS API removes shell-quoting entirely and gives us
// one source of truth for everything that defines a Node bundle: entry,
// banner, format, externals, sourcemap. Per-target staging and validation
// steps (e.g. CLI inventory cleanup, server hardcoded-path validation) live
// here too — used to be duplicated across build_macos.sh / build_linux.sh
// / build_windows.ps1, now centralised so a missed update can't ship a
// half-fixed bundle.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preparePlaywrightControlRuntime } from './prepare-playwright-control-runtime.mjs';
import { dshBuildDefines } from './integrated-runtimes/dsh-build-selection.mjs';
import { verifyAgentNetworkProtocol } from './verify-agent-network-protocol.mjs';

const APP_BUILD_PROFILE = process.env.MYAGENTS_BUILD_PROFILE ?? 'myagents';
if (!['myagents', 'moxbot'].includes(APP_BUILD_PROFILE)) {
  throw new Error('MYAGENTS_BUILD_PROFILE must be myagents or moxbot');
}

await verifyAgentNetworkProtocol();

// Read package.json version once and inject as a compile-time constant.
// This is the ONLY way `myagents version` can show the real shipped
// version in production: the runtime `process.env.npm_package_version`
// is set by `npm run …` (dev), not by Tauri's sidecar spawn (prod), so
// without compile-time injection the admin-api falls back to a stale
// hardcoded string. Issue #149 follow-up — users couldn't tell whether
// they were running the patched build.
const PKG_VERSION = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;

let commit = null;
let dirty = null;
try {
  const git = args => execFileSync('git', args, { encoding: 'utf8', cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  commit = git(['rev-parse', 'HEAD']);
  dirty = git(['status', '--porcelain']).length > 0;
} catch { /* Source archives may omit Git. */ }
const BUILD_IDENTITY = { version: PKG_VERSION, mode: 'bundle', capturedAt: new Date().toISOString(), commit, dirty };

// Banner content kept as plain string literals here — no shell parsing
// involved, so single/double quotes mean what they say.
//
// Aliasing `createRequire` here is load-bearing, not stylistic: at least one
// bundled source file (`src/server/utils/imageResize.ts`) uses
// `import { createRequire } from 'module'` at top level, and esbuild keeps
// that import literally in the output. If our banner *also* binds the bare
// name `createRequire`, Node ≥22's ESM loader rejects the module on first
// load with `SyntaxError: Identifier 'createRequire' has already been
// declared` — Sidecar dies before answering /health, the renderer hangs at
// "loading history". A unique alias here permanently sidesteps the
// collision regardless of how many depths-deep deps re-import the symbol.
const ESM_INTEROP_BANNER =
  'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);';
const CLI_SHEBANG_BANNER = '#!/usr/bin/env node';

const TARGETS = {
  server: {
    entryPoints: ['src/server/index.ts'],
    outfile: 'src-tauri/resources/server-dist.js',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    // Playwright must keep its package-local CommonJS layout and data files.
    // Bundling it into this ESM file leaves module-scoped globals such as
    // `__dirname` unbound and breaks its relative package.json/assets lookup
    // in release builds. Tauri ships these three pinned *control-code*
    // packages under Resources/node_modules; Chromium itself remains a
    // separately managed runtime artifact and is not part of the app bundle.
    external: [
      '@playwright/mcp',
      '@playwright/mcp/*',
      'playwright',
      'playwright/*',
      'playwright-core',
      'playwright-core/*',
      'fsevents',
      'chromium-bidi/*',
    ],
    /** Post-build: catch hardcoded `__dirname = "<dev-machine path>"` leaks.
     *  esbuild treats a top-level `__dirname` as a compile-time constant; the
     *  source must use `import.meta.url` / `getScriptDir()` instead. If anyone
     *  regresses that contract, fail the build here so the bad bundle never
     *  ships (used to be a separate `grep` step in each .sh / .ps1 build
     *  script — three near-identical copies before the consolidation).
     */
    postBuild: async (outfile) => {
      const code = await readFile(outfile, 'utf8');
      // Match Mac/Linux absolute (`/Users/...`, `/home/...`) and Windows
      // (`C:\...` or forward-slash form `C:/...`, both upper- and lower-
      // case drives) — esbuild has been observed to emit either slash
      // style on Windows depending on path-normalize internals.
      const m = code.match(/var __dirname = "((?:\/Users|\/home|[A-Za-z]:[\\/])[^"]+)"/);
      if (m) {
        console.error(
          `✘ ${outfile}: hardcoded __dirname → ${m[1]}\n` +
            `  Source must use import.meta.url / utils.getScriptDir(), not __dirname.`,
        );
        process.exit(1);
      }
    },
  },
  bridge: {
    entryPoints: ['src/server/plugin-bridge/index.ts'],
    // `.mjs` is load-bearing, not stylistic. Plugin Bridge is spawned with
    // `--import tsx/esm` so tsx's loader hooks see every module load. When
    // the bundle lives somewhere with no `package.json` above declaring
    // `"type": "module"` (e.g. a Windows production install at
    // `C:\Users\hackl\AppData\Local\MyAgents\`), Node's default classifier
    // returns `format: "commonjs"` for the `.js` entry. tsx's hook then
    // detects ESM syntax in the CJS-classified file, transpiles it to CJS
    // via esbuild, and re-serves it as a `data:text/javascript` URL — which
    // ends up triggering an ERR_REQUIRE_CYCLE_MODULE on the still-loading
    // entry. Renaming the output to `.mjs` short-circuits the whole path:
    // Node treats `.mjs` as ESM unconditionally per spec, tsx's CJS branch
    // never fires. Verified against a real Windows 0.2.0 install log.
    // server-dist.js stays `.js` because the sidecar spawn doesn't pass
    // `--import` (no tsx in the chain), so the same trap doesn't apply.
    outfile: 'src-tauri/resources/plugin-bridge-dist.mjs',
    format: 'esm',
    sourcemap: true,
    banner: { js: ESM_INTEROP_BANNER },
    external: ['openclaw'],
  },
  cli: {
    entryPoints: ['src/cli/myagents.ts'],
    // The extension is part of the runtime contract. The CLI bundle is
    // CommonJS, and `.cjs` keeps that classification deterministic even when
    // a development `.app` lives below a repository `package.json` whose
    // `type` is `module`.
    outfile: 'src-tauri/resources/cli/myagents.cjs',
    format: 'cjs',
    sourcemap: false,
    banner: { js: CLI_SHEBANG_BANNER },
  },
};

const targetName = process.argv[2];
const cfg = TARGETS[targetName];
if (!cfg) {
  const known = Object.keys(TARGETS).join(', ');
  console.error(`Usage: node scripts/esbuild-bundle.mjs <${known}>`);
  process.exit(1);
}

// Ensure the outfile's directory exists. esbuild creates the file but
// requires the parent dir; on a clean checkout (or after `cargo clean`
// nuked target/), `src-tauri/resources/cli/` may not exist yet.
const outputDir = dirname(cfg.outfile);
await mkdir(outputDir, { recursive: true });

if (targetName === 'server') {
  preparePlaywrightControlRuntime();
}

// The package must contain exactly one CLI business payload. Remove artifacts
// emitted by older build logic (notably myagents.cmd) before rebuilding while
// preserving the tracked placeholder used by clean checkouts.
if (targetName === 'cli') {
  for (const entry of await readdir(outputDir)) {
    if (entry !== '.gitkeep') {
      await rm(join(outputDir, entry), { recursive: true, force: true });
    }
  }
}

await build({
  bundle: true,
  platform: 'node',
  target: 'node22',
  define: {
    ...dshBuildDefines(fileURLToPath(new URL('..', import.meta.url))),
    __MYAGENTS_BUILD_PROFILE__: JSON.stringify(APP_BUILD_PROFILE),
    // Compile-time version constant. Replaces `process.env.npm_package_version`
    // fallbacks across the codebase so `myagents version` reports the real
    // shipped build instead of a stale hardcoded string in production.
    __MYAGENTS_VERSION__: JSON.stringify(PKG_VERSION),
    __MYAGENTS_BUILD_IDENTITY__: JSON.stringify(BUILD_IDENTITY),
  },
  // `postBuild` is our own hook — strip it before handing config to esbuild.
  ...(({ postBuild: _strip, ...rest }) => rest)(cfg),
});

if (cfg.postBuild) {
  await cfg.postBuild(cfg.outfile);
}

console.log(`✓ ${targetName} → ${cfg.outfile}`);
