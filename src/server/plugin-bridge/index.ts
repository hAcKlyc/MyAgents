import { APP_BUILD_PROFILE } from '../../shared/appProfile';
/**
 * OpenClaw Channel Plugin Bridge
 *
 * Independent Bun process that loads an OpenClaw channel plugin and bridges
 * communication between the plugin and Rust (management API).
 *
 * CLI args:
 *   --plugin-dir <path>   Plugin installation directory
 *   --port <number>       HTTP server port for Rust → Bridge communication
 *   --rust-port <number>  Management API port for Bridge → Rust communication
 *   --bot-id <string>     Bot ID for message routing
 *
 * Env:
 *   BRIDGE_PLUGIN_CONFIG  Plugin configuration JSON (env var to avoid leaking secrets in `ps`)
 */

import { createCompatApi, type CapturedPlugin, type CapturedTool } from './compat-api';
import { createCompatRuntime } from './compat-runtime';
import { getBotIdentity, abortResolver } from './bot-identity';
import { createMcpHandler } from './mcp-handler';
import {
  abortPendingDispatch,
  bindPendingStream,
  clearAllPendingDispatches,
  completePendingDispatch,
  enqueueBlockBoundary,
  enqueuePartial,
  enqueueRunStart,
  type OpenClawReplyPayload,
} from './pending-dispatch';
import { buildFunctionalHealth, buildReadyHealth, type GatewayRuntimeStatus } from './gateway-health';
import {
  addOpenClawChannelAliases,
  buildOpenClawConfig,
  getOpenClawConfigSnapshot,
  setOpenClawConfigSnapshot,
} from './openclaw-config';
import { redactPluginBridgeSecrets } from './secret-redaction';
import { sanitizeOutboundMediaFilename } from './media-filename';
import { installLarkAdmissionRuntimeGlobals } from './lark-admission';
import { patchLarkChatQueueSource } from './plugin-compat-patches';
import {
  getGeneralRequestDispatcher,
  initializeProxyStateFromCurrentSettings,
} from '../proxy-state';
import {
  install as installUndiciGlobals,
  setGlobalDispatcher,
} from 'undici';
import { serve as honoServe } from '@hono/node-server';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { parseArgs } from 'util';

// Bind standalone shims before dynamically importing any plugin. Inherited
// environment cannot choose a different product's private data directory.
process.env.MYAGENTS_BRIDGE_APP_PROFILE = APP_BUILD_PROFILE;

// =============================================================================
// Plugin compat loader — runtime patch for broken community plugins
// =============================================================================
// Some published OpenClaw plugins (e.g. @larksuite/openclaw-lark all versions)
// have build-pipeline bugs we work around at load time. We use a sync
// `module.registerHooks` (Node 22.15+) instead of `register()` because when a
// CJS file calls `require(broken.js)`, Node pivots to `loadESMFromCJS` on the
// main thread synchronously — async hooks aren't invoked on that path. Only
// sync hooks catch it.
//
// Patches applied (in order):
//
// 1. CJS + import.meta hybrid (every @larksuite/openclaw-lark version)
//    Plugin emits `"use strict"; Object.defineProperty(exports, ...); exports.X = Y`
//    AND references `import.meta.url` inside function bodies. Node's module
//    classifier sees `import.meta` and forces ESM parsing → CJS `exports`
//    global becomes undefined → ReferenceError at load. Bun tolerated this
//    silently; Node (spec-compliant) rejects it.
//      - Rewrite `fileURLToPath(import.meta.url)` → `__filename`
//      - Rewrite remaining `import.meta.url` → `pathToFileURL(__filename).href`
//      - Force CJS classification so Node accepts the file
//
// 2. Lark image/file upload `Readable.from(buffer)` (v2026.4.8 and earlier)
//    @larksuite/openclaw-lark wraps a Buffer in `Readable.from(image)` before
//    handing it to the Feishu SDK's `client.im.image.create()`. The SDK uses
//    `form-data` for multipart upload, and form-data can't determine the
//    stream length from a Readable, so the upload is sent without
//    Content-Length and Feishu's API returns `null` ("no image_key in
//    response"). Upstream OpenClaw fixed this by passing the Buffer directly
//    (form-data handles Buffers fine), but the published plugin still ships
//    the broken pattern. See:
//      - https://github.com/larksuite/node-sdk/issues/121
//      - openclaw/extensions/feishu/src/media.ts (upstream canonical)
//
// 3. Official Lark same-chat queue lifecycle (v2026.7.9)
//    The plugin serializes each account+chat/thread task until the entire AI
//    reply and CardKit delivery finish. MyAgents already has a bounded Rust
//    ingress queue plus request-scoped ReplyRouter ownership, so that private
//    queue turns normal follow-ups into head-of-line blocking. The narrow
//    structural patch below advances only after Bridge→Rust admission while
//    keeping every dispatcher alive until its own delivery completes. Unknown
//    upstream source shapes are left unchanged (fail closed).
const PLUGIN_PATH_RE = /[/\\]openclaw-plugins[/\\][^/\\]+[/\\]node_modules[/\\]/;
// Match the broken lark pattern, capturing the destination var name and the input arg name
// so we can preserve them in the rewrite. The transform expression matches both upload sites
// in one regex (image / file / any var). Whitespace is generous because plugins may republish
// with prettier reformatted output.
const LARK_BUFFER_STREAM_RE = /Buffer\.isBuffer\((\w+)\)\s*\?\s*[\w$.]+\.Readable\.from\(\1\)\s*:\s*fs\.createReadStream\(\1\)/g;
const LARK_CHAT_QUEUE_PATH_RE = /[/\\]node_modules[/\\]@larksuite[/\\]openclaw-lark[/\\]src[/\\]channel[/\\]chat-queue\.js$/;

installLarkAdmissionRuntimeGlobals();

registerHooks({
  load(url, context, next) {
    if (!url.startsWith('file://') || !url.endsWith('.js') || !PLUGIN_PATH_RE.test(url)) {
      return next(url, context);
    }
    let src: string;
    try {
      src = readFileSync(fileURLToPath(url), 'utf8');
    } catch {
      return next(url, context);
    }
    const hasImportMeta = /\bimport\.meta\b/.test(src);
    // Detect CJS-style exports: top of file is `"use strict"` and file has any
    // of the three CJS export patterns. Don't restrict distance — copyright
    // header comments between them can be >200 chars.
    const hasCjsExports = /^"use strict";/.test(src)
      && /\b(?:Object\.defineProperty\(exports|exports\.[\w$]+\s*=|module\.exports\s*=)/.test(src);
    const needsCjsImportMetaPatch = hasImportMeta && hasCjsExports;
    const needsLarkBufferPatch = LARK_BUFFER_STREAM_RE.test(src);
    LARK_BUFFER_STREAM_RE.lastIndex = 0; // reset between calls (regex has /g flag)
    const isLarkChatQueue = LARK_CHAT_QUEUE_PATH_RE.test(fileURLToPath(url));
    const larkChatQueuePatched = isLarkChatQueue ? patchLarkChatQueueSource(src) : null;
    if (isLarkChatQueue && !larkChatQueuePatched) {
      console.warn('[plugin-bridge] official Lark chat queue shape is unknown; keeping upstream serialization unchanged');
    }
    if (!needsCjsImportMetaPatch && !needsLarkBufferPatch && !larkChatQueuePatched) {
      return next(url, context);
    }
    let patched = larkChatQueuePatched ?? src;
    if (needsCjsImportMetaPatch) {
      patched = patched
        .replace(/\(0,\s*[\w$.]+\.fileURLToPath\)\(import\.meta\.url\)/g, '__filename')
        .replace(/\bfileURLToPath\(import\.meta\.url\)/g, '__filename')
        .replace(/\bimport\.meta\.url\b/g, 'require("node:url").pathToFileURL(__filename).href');
    }
    if (needsLarkBufferPatch) {
      // `arg` is the captured input variable (image/file/buffer/etc.).
      // The replacement matches upstream openclaw's fix: pass Buffer directly,
      // use createReadStream only for string paths.
      patched = patched.replace(LARK_BUFFER_STREAM_RE,
        (_match, arg) => `(typeof ${arg} === 'string' ? fs.createReadStream(${arg}) : ${arg})`);
    }
    // Both patch paths target CJS files — the import.meta+CJS hybrid forces
    // 'commonjs' to override Node's misclassification, and the lark buffer
    // patch only matches CJS-shape `<requireBinding>.Readable.from(...)`.
    // Returning 'commonjs' for both keeps Node's classifier consistent.
    return { format: 'commonjs', source: patched, shortCircuit: true };
  },
});
// =============================================================================

/**
 * Shape subset of package.json fields this module reads. Bun.file(p).json()
 * previously returned `any`; we keep ad-hoc shape so callers can do
 * pkg.dependencies / pkg.version / pkg.main without narrowing.
 */
type PkgJsonLike = {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  type?: string;
  keywords?: string[];
  openclaw?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
} & Record<string, unknown>;

async function readJsonFile(path: string, fallback?: PkgJsonLike): Promise<PkgJsonLike> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as PkgJsonLike;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error(`Failed to read JSON: ${path}`);
  }
}

async function readOptionalJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return asOptionalJsonObject(parsed);
  } catch {
    return null;
  }
}

function asOptionalJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Resolve an OpenClaw plugin's entry file inside its package directory.
 *
 * Implements the protocol from openclaw/src/plugins/manifest.ts:
 *   1. package.json["openclaw"].extensions: [path, ...] — explicit per-package entries
 *   2. Fallback: probe DEFAULT_PLUGIN_ENTRY_CANDIDATES at the package root
 *
 * Returns the first existing absolute path, or null if none found.
 */
const DEFAULT_PLUGIN_ENTRY_CANDIDATES = ['index.ts', 'index.js', 'index.mjs', 'index.cjs'] as const;

async function resolveOpenClawPluginEntry(packageDir: string): Promise<string | null> {
  const pkg = await readJsonFile(`${packageDir}/package.json`, {}) as {
    openclaw?: { extensions?: unknown };
  };
  const rawExts = pkg.openclaw?.extensions;
  const declared = Array.isArray(rawExts)
    ? rawExts.filter((e): e is string => typeof e === 'string' && e.length > 0)
    : [];

  const candidates = declared.length > 0 ? declared : DEFAULT_PLUGIN_ENTRY_CANDIDATES;
  for (const rel of candidates) {
    const abs = `${packageDir}/${rel.replace(/^\.\//, '')}`;
    try {
      await readFile(abs); // existence check
      return abs;
    } catch {
      // try next
    }
  }
  return null;
}

// Parse CLI arguments
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    'plugin-dir': { type: 'string' },
    'port': { type: 'string' },
    'rust-port': { type: 'string' },
    'bot-id': { type: 'string' },
  },
});

const pluginDir = args['plugin-dir'] as string | undefined;
const port = parseInt((args['port'] as string) || '0', 10);
const rustPort = parseInt((args['rust-port'] as string) || '0', 10);
const botId = (args['bot-id'] as string) || '';
// Read config from env var (not CLI arg) to avoid leaking secrets in process listing
const pluginConfig = JSON.parse(process.env.BRIDGE_PLUGIN_CONFIG || '{}');

if (!pluginDir || !port || !rustPort || !botId) {
  console.error('[plugin-bridge] Missing required args: --plugin-dir, --port, --rust-port, --bot-id');
  process.exit(1);
}

console.log(`[plugin-bridge] Starting: plugin-dir=${pluginDir} port=${port} rust-port=${rustPort} bot-id=${botId}`);

let capturedPlugin: CapturedPlugin | null = null;
let pluginName = 'unknown';
let gatewayError: string | null = null;
let gatewayStarted = false; // true once startAccount() has been invoked
let waitingForQrLogin = false; // true when plugin supports QR login but isn't configured yet
let gatewayStatus: GatewayRuntimeStatus | null = null;

function mergeGatewayStatus(update: GatewayRuntimeStatus): void {
  gatewayStatus = { ...(gatewayStatus ?? {}), ...update };
}

let streamIdCounter = 0;

// MCP handler — initialized after plugin loads and captures tools
let mcpHandler: ReturnType<typeof createMcpHandler> | null = null;
let getCapturedToolsFn: (() => CapturedTool[]) | null = null;
let getCapturedCommandsFn: (() => import('./compat-api').CapturedCommand[]) | null = null;
/** Compat runtime — created in loadPlugin(), shared with gateway ctx for startAccount/restart */
let loadedRuntime: ReturnType<typeof createCompatRuntime> | null = null;
/** Current resolved account — shared by sendText/sendMedia closures, updated by /restart-gateway */
let currentAccount: Record<string, unknown> = {};
/**
 * Plugin's withTicket() function for AsyncLocalStorage context injection.
 * Discovered after plugin loads — allows MCP tool calls to access the
 * request-level ticket (senderOpenId, chatId, accountId) needed for
 * OAuth Device Flow auto-auth and account routing.
 */
let pluginWithTicket: ((ticket: Record<string, unknown>, fn: () => Promise<unknown>) => Promise<unknown>) | null = null;

async function loadPlugin() {
  // Find the plugin entry point FIRST — we need the module name to infer the channel brand
  const pkgJsonPath = `${pluginDir}/package.json`;
  const pkgJson = await readJsonFile(pkgJsonPath, {});

  // Find installed packages (look in node_modules for packages with openclaw metadata)
  const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  let entryModule: string | null = null;
  let entryManifest: Record<string, unknown> | null = null;

  for (const depName of Object.keys(deps || {})) {
    if (depName === 'openclaw') continue; // Skip the shim
    try {
      const depPkgDir = `${pluginDir}/node_modules/${depName}`;
      const depPkg = await readJsonFile(`${depPkgDir}/package.json`, {});
      if (depPkg.openclaw || depPkg.keywords?.includes('openclaw')) {
        entryModule = depName;
        pluginName = depPkg.name || depName;
        entryManifest = await readOptionalJsonObject(`${depPkgDir}/openclaw.plugin.json`)
          ?? asOptionalJsonObject(depPkg.openclaw);
        break;
      }
    } catch {
      // Not an openclaw plugin, skip
    }
  }

  if (!entryModule) {
    throw new Error('No OpenClaw channel plugin found in dependencies');
  }

  console.log(`[plugin-bridge] Loading plugin: ${entryModule}`);

  // Build OpenClaw-format config BEFORE register() so plugin tools can discover accounts.
  // The flat pluginConfig {appId, appSecret, ...} must be nested under channels.<brand>.
  const { channelKey, config: openclawConfig } = buildOpenClawConfig({
    entryModule,
    pluginConfig,
    manifest: entryManifest,
  });

  // Create compat API with properly structured config
  setOpenClawConfigSnapshot(openclawConfig);
  const compatApi = createCompatApi(openclawConfig);
  // Runtime must be created early — plugins call setRuntime(api.runtime) during register()
  const runtime = createCompatRuntime(rustPort, botId, 'unknown');
  compatApi.runtime = runtime;
  loadedRuntime = runtime;

  // CRITICAL: Patch axios BEFORE importing the plugin.
  //
  // @larksuiteoapi/node-sdk@1.60.0 does this at import time:
  //   const defaultHttpInstance = axios.create({ adapter: bunFetchAdapter });
  //
  // The bunFetchAdapter is hand-rolled to use global `fetch` for Bun runtime
  // compatibility. But its body serialization is broken for multipart uploads:
  //   opts.body = typeof c.data==='string' ? c.data : JSON.stringify(c.data)
  // — when `c.data` is a FormData object (image upload, file upload), the
  // adapter JSON-stringifies it into "{}", so Feishu's API receives a
  // bodyless multipart request and returns null. This surfaced as
  // "Image upload failed: no image_key in response. Response: null".
  //
  // We override two things on every instance the plugin creates:
  //   1. adapter — force back to 'http' so axios uses Node's http adapter
  //      (handles FormData / Buffer / Stream correctly via form-data lib).
  //   2. timeout — cap at 10s so a stuck connection fails fast and the
  //      plugin's retry/fallback path kicks in (legacy fix for a separate
  //      Bun adapter hang bug).
  //
  // Why createRequire instead of `await import('axios')`:
  // axios's package.json `exports.default` differs by environment:
  //   "require": "./dist/node/axios.cjs"   ← what `require('axios')` loads
  //   "default": "./index.js"              ← what `import('axios')` loads
  // These are TWO DIFFERENT module instances with separate `create` functions.
  // The lark SDK is CJS and does `var axios = require('axios')`, hitting the
  // .cjs file. Patching the ESM-imported axios therefore never affects the
  // SDK. Use createRequire to grab the same module the SDK will see, then
  // patch THAT.
  try {
    const pluginRequire = createRequire(`${pluginDir}/`);
    const axiosCjs = pluginRequire('axios') as { create?: (config?: unknown) => { defaults: Record<string, unknown> } };
    if (typeof axiosCjs?.create === 'function') {
      const origCreate = axiosCjs.create.bind(axiosCjs);
      axiosCjs.create = (...args: unknown[]) => {
        const instance = origCreate(...(args as [Record<string, unknown>]));
        // Replace any custom adapter (e.g. bunFetchAdapter) with axios's built-in
        // 'http' adapter. Multipart uploads need the http adapter — fetch-based
        // shims drop FormData. The string form is supported by axios 1.x and
        // resolves to the same adapter axios would auto-pick in Node.
        instance.defaults.adapter = 'http';
        if (!instance.defaults.timeout || (instance.defaults.timeout as number) > 10000) {
          instance.defaults.timeout = 10000;
        }
        return instance;
      };
      console.log('[plugin-bridge] Patched CJS axios.create — adapter=http, timeout=10s');
    }
  } catch {
    // axios not installed in plugin dir — no patch needed
  }

  // Import the plugin module.
  //
  // Resolution follows the OpenClaw package manifest protocol — the authoritative
  // source of truth for a plugin's entry point, not package.json's `main`/`exports`:
  //
  //   1. `package.json["openclaw"].extensions: [path, ...]` (OpenClaw convention)
  //   2. Fallback probe: DEFAULT_PLUGIN_ENTRY_CANDIDATES
  //      = ["index.ts", "index.js", "index.mjs", "index.cjs"]
  //
  // Reference: openclaw/src/plugins/manifest.ts::resolvePackageExtensionEntries
  //           openclaw/src/plugins/discovery.ts (around line 885)
  //
  // Why not rely on `main`/`exports`:
  //   - lark's main="./dist/index.js" but dist/ isn't in the published tarball
  //   - qqbot's main="./dist/index.js" but only index.ts is shipped
  //   - Many plugins declare aspirational build outputs that don't exist
  //
  // `openclaw.extensions` points to actually-shipped files by convention.
  const pluginPkgDir = `${pluginDir}/node_modules/${entryModule}`;
  const resolvedEntry = await resolveOpenClawPluginEntry(pluginPkgDir);
  if (!resolvedEntry) {
    throw new Error(
      `Plugin entry not found for ${entryModule}. Checked ` +
      `package.json["openclaw"].extensions and fallback candidates ` +
      `(index.ts/.js/.mjs/.cjs) under ${pluginPkgDir}`
    );
  }
  console.log(`[plugin-bridge] Using entry: ${resolvedEntry}`);
  const pluginModule: Record<string, unknown> = await import(pathToFileURL(resolvedEntry).href);

  // Plugins can export their registration in several patterns:
  //   1. default export = { register(api) { ... } }  (OpenClaw standard)
  //   2. default export = function(api) { ... }       (simple)
  //   3. module.default.default                       (double-wrapped ESM)
  const exported = (pluginModule.default ?? pluginModule) as Record<string, unknown>;
  const register = exported.register;
  const nestedRegister = (exported.default as Record<string, unknown> | undefined)?.register;
  if (typeof exported === 'object' && typeof register === 'function') {
    await (register as (api: unknown) => unknown)(compatApi);
  } else if (typeof exported === 'function') {
    await (exported as unknown as (api: unknown) => unknown)(compatApi);
  } else if (typeof exported === 'object' && typeof nestedRegister === 'function') {
    await (nestedRegister as (api: unknown) => unknown)(compatApi);
  }

  capturedPlugin = compatApi.getCapturedPlugin();

  if (!capturedPlugin) {
    throw new Error('Plugin did not register a channel via registerChannel()');
  }

  console.log(`[plugin-bridge] Plugin registered: ${capturedPlugin.id} (${capturedPlugin.name})`);

  // Update runtime with actual plugin ID (was 'unknown' at creation time)
  if (runtime && typeof (runtime as Record<string, unknown>).setPluginId === 'function') {
    (runtime as Record<string, unknown> & { setPluginId: (id: string) => void }).setPluginId(capturedPlugin.id);
  }

  // Add the registered ChannelPlugin.id as an additional alias when it differs
  // from the manifest channel key. The manifest key is canonical for OpenClaw
  // config, while historical MyAgents data and some plugins still mention
  // install/package identities.
  const openclawCfg = addOpenClawChannelAliases(openclawConfig, [capturedPlugin.id], channelKey);
  compatApi.config = openclawCfg;
  setOpenClawConfigSnapshot(openclawCfg);

  // Set up MCP handler with captured tools (use the final config so tools and
  // message routing see the same channel aliases).
  getCapturedToolsFn = () => compatApi.getCapturedTools();
  getCapturedCommandsFn = () => compatApi.getCapturedCommands();
  mcpHandler = createMcpHandler(getCapturedToolsFn, openclawCfg, channelKey);
  const toolCount = compatApi.getCapturedTools().length;
  if (toolCount > 0) {
    console.log(`[plugin-bridge] MCP handler initialized with ${toolCount} captured tool factories`);
  }

  // Discover plugin's withTicket() for AsyncLocalStorage context injection.
  // The Feishu plugin uses LarkTicket (via AsyncLocalStorage) to propagate
  // message context (senderOpenId, chatId, accountId) through async call chains.
  // MCP tool calls arrive as separate HTTP requests — outside the original
  // withTicket() scope — so we must re-inject the ticket before tool.execute().
  //
  // NOTE: the plugin's package.json "exports" field only exposes "." so we
  // can't resolve the subpath via normal import — load the absolute path directly.
  // Dynamic import() of the CJS module shares the same AsyncLocalStorage instance
  // as the plugin's own code (verified), which is the whole point.
  if (entryModule && /lark|feishu/i.test(entryModule)) {
    try {
      const ticketPath = `${pluginDir}/node_modules/${entryModule}/src/core/lark-ticket.js`;
      const ticketMod = await import(pathToFileURL(ticketPath).href);
      const withTicket = ticketMod.withTicket ?? ticketMod.default?.withTicket;
      if (typeof withTicket === 'function') {
        pluginWithTicket = withTicket;
        console.log('[plugin-bridge] Discovered withTicket() for LarkTicket context injection');
      }
    } catch {
      console.log('[plugin-bridge] No LarkTicket module found (withTicket injection unavailable)');
    }
  }

  // Resolve account using the plugin's own config.resolveAccount if available
  // Pass accountId from pluginConfig (persisted after QR login) so plugins like
  // WeChat can find credentials saved under that specific accountId on disk.
  const configAccessor = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
  const persistedAccountId = pluginConfig.accountId as string | undefined;
  let account: Record<string, unknown> = currentAccount;
  if (typeof configAccessor?.resolveAccount === 'function') {
    try {
      account = (configAccessor.resolveAccount as (cfg: unknown, id?: string) => Record<string, unknown>)(openclawCfg, persistedAccountId);
    } catch (err) {
      console.warn(`[plugin-bridge] resolveAccount failed, using flat config:`, err);
      account = { accountId: persistedAccountId || 'default', enabled: true, ...pluginConfig };
    }
  } else {
    account = { accountId: 'default', enabled: true, ...pluginConfig };
  }

  currentAccount = account; // Share with /restart-gateway and sendText/sendMedia closures

  // Log account with secrets redacted, including nested plugin config.
  const redactedAccount = redactPluginBridgeSecrets(account);
  console.log(`[plugin-bridge] Resolved account:`, JSON.stringify(redactedAccount));

  // Wrap outbound.sendText/sendMedia if top-level handlers are missing
  // OpenClaw plugins put send functions under plugin.outbound with signature:
  //   outbound.sendText({ to, text, accountId, replyToId, cfg })
  // We need to wrap them to match our CapturedPlugin interface:
  //   sendText(chatId, text) → outbound.sendText({ to: chatId, text, cfg })
  const outbound = capturedPlugin.raw?.outbound as Record<string, unknown> | undefined;
  if (!capturedPlugin.sendText && typeof outbound?.sendText === 'function') {
    const outboundSendText = outbound.sendText as (params: Record<string, unknown>) => Promise<{ messageId?: string; error?: Error }>;
    capturedPlugin.sendText = async (chatId: string, text: string) => {
      const result = await outboundSendText({ to: chatId, text, accountId: currentAccount.accountId || 'default', cfg: openclawCfg });
      if (result?.error) throw result.error;
      return { messageId: result?.messageId };
    };
    console.log('[plugin-bridge] Wrapped outbound.sendText as sendText handler');
  }
  if (!capturedPlugin.sendMedia && typeof outbound?.sendMedia === 'function') {
    const outboundSendMedia = outbound.sendMedia as (params: Record<string, unknown>) => Promise<{ messageId?: string; error?: Error }>;
    // Rust bridge.rs::send_photo / send_file POST `{ chatId, type, filename, data:base64, mimeType?, caption }`,
    // but OpenClaw `outbound.sendMedia` expects `{ to, text, mediaUrl, mediaLocalRoots, accountId, cfg }`
    // (mirroring sendText). Spreading params raw left every plugin field undefined → plugin
    // logged `target=undefined`, then crashed with `Cannot read properties of undefined
    // (reading 'trim')` deep inside its target parser.
    //
    // The OpenClaw outbound.sendMedia surface only accepts a `mediaUrl` (no raw buffer at this
    // layer), so we materialize the base64 payload to a temp file and pass a bare absolute path.
    // Why bare path instead of `file://...` URL: the WeChat plugin's `isLocalFilePath` uses
    // `!mediaUrl.includes("://")` to detect local paths, which rejects `file://` URLs and falls
    // through to a text-only send. Bare absolute paths satisfy both the Lark plugin
    // (`isLocalMediaPath` → `path.isAbsolute(raw)`) and the WeChat plugin. mediaLocalRoots is
    // scoped to just the temp dir so the plugin's path validator (post-CVE-2026-26321) doesn't
    // refuse the read.
    capturedPlugin.sendMedia = async (params: Record<string, unknown>) => {
      const chatId = params.chatId as string | undefined;
      const filename = (params.filename as string | undefined) ?? 'file';
      const data = params.data as string | undefined;
      const caption = params.caption as string | null | undefined;
      if (!chatId) {
        throw new Error('[plugin-bridge] sendMedia: missing chatId');
      }
      if (!data) {
        throw new Error('[plugin-bridge] sendMedia: missing base64 data');
      }
      const safeName = sanitizeOutboundMediaFilename(filename);
      const tmpDir = await mkdtemp(pathJoin(tmpdir(), 'plugin-bridge-media-'));
      const tmpPath = pathJoin(tmpDir, safeName);
      await writeFile(tmpPath, Buffer.from(data, 'base64'));
      try {
        const result = await outboundSendMedia({
          to: chatId,
          text: caption ?? undefined,
          mediaUrl: tmpPath,
          mediaLocalRoots: [tmpDir],
          accountId: currentAccount.accountId || 'default',
          cfg: openclawCfg,
        });
        if (result?.error) throw result.error;
        return { messageId: result?.messageId };
      } finally {
        // Cleanup is best-effort — losing a temp dir on shutdown is harmless;
        // blocking on it would slow down the response that the AI is awaiting.
        void rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      }
    };
    console.log('[plugin-bridge] Wrapped outbound.sendMedia as sendMedia handler');
  }
  // Store textChunkLimit from outbound config for max_message_length
  if (outbound?.textChunkLimit && typeof outbound.textChunkLimit === 'number') {
    console.log(`[plugin-bridge] Plugin textChunkLimit: ${outbound.textChunkLimit}`);
  }

  // Validate credentials before starting gateway
  // Check if the plugin's isConfigured function reports the account as configured
  const configAccessorForCheck = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
  const supportsQrLogin = typeof capturedPlugin.gateway?.loginWithQrStart === 'function';
  if (typeof configAccessorForCheck?.isConfigured === 'function') {
    // OpenClaw signature: isConfigured(account, cfg) → boolean | Promise<boolean>
    const configuredResult = (configAccessorForCheck.isConfigured as (a: unknown, c: unknown) => boolean | Promise<boolean>)(account, openclawCfg);
    const configured = configuredResult instanceof Promise ? await configuredResult : configuredResult;
    if (!configured) {
      if (supportsQrLogin) {
        // QR login plugins: isConfigured=false is expected (user hasn't scanned yet).
        // Keep Bridge alive and healthy — QR login endpoints will handle authentication.
        waitingForQrLogin = true;
        console.log('[plugin-bridge] Account not configured, but plugin supports QR login — waiting for /qr-login-start');
        return; // Skip gateway start — /restart-gateway will start it after QR login
      } else {
        const errMsg = 'Plugin reports account is not configured (missing required credentials)';
        console.error(`[plugin-bridge] ${errMsg}`);
        gatewayError = errMsg;
        mergeGatewayStatus({ running: false, lastError: errMsg });
        return; // Don't start gateway — credentials are missing
      }
    }
  }

  // Start the plugin's gateway
  const startAccount = capturedPlugin.gateway?.startAccount;
  if (typeof startAccount === 'function') {
    const abortController = new AbortController();
    gatewayStatus = null;
    let status: GatewayRuntimeStatus = { running: false, connected: false };

    const resolvedAccountId = (account.accountId as string) || persistedAccountId || 'default';
    const ctx = {
      account,
      accountId: resolvedAccountId,
      abortSignal: abortController.signal,
      log: console,
      runtime,
      // Required by openclaw plugins >=2026.3.22. Weixin@2.4.2 strictly throws
      // when missing and reads channel-surface fields directly (channelRuntime.media.*,
      // channelRuntime.routing.*, ...). Wecom diverges from the spec and expects
      // PluginRuntime shape (target.core.channel.text.chunkText). Dual-shape object
      // satisfies both: spread of channel surface + a `channel` self-reference.
      channelRuntime: { ...runtime.channel, channel: runtime.channel },
      cfg: openclawCfg,
      getStatus: () => status,
      setStatus: (s: GatewayRuntimeStatus) => {
        status = { ...status, ...s };
        mergeGatewayStatus(s);
      },
    };

    // Don't await — let the gateway run in background (it may be long-lived)
    gatewayStarted = true;
    // Pre-warm bot identity resolver — fire-and-forget, populates cache so
    // verify_connection's GET /identity hits the cache instead of waiting on
    // a cold token+info round-trip. Returns null for plugins without a
    // resolver (wecom / weixin) → renderer falls back to platformLabel.
    void getBotIdentity(capturedPlugin.id, pluginConfig);
    // Store context for stopAccount() — OpenClaw expects same context shape
    (globalThis as Record<string, unknown>).__bridgeGatewayCtx = ctx;
    (startAccount as (ctx: Record<string, unknown>) => Promise<void>)(ctx)
      .then(() => console.log(`[plugin-bridge] Plugin gateway started`))
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[plugin-bridge] Gateway error:`, errMsg);
        gatewayError = errMsg;
        mergeGatewayStatus({ running: false, lastError: errMsg });
      });

    // Store abort controller for graceful shutdown
    (globalThis as Record<string, unknown>).__bridgeAbort = abortController;
  } else {
    // No gateway — plugin is a send-only channel, mark as ready immediately
    gatewayStarted = true;
    gatewayStatus = null;
    // Pre-warm bot identity resolver (same rationale as above).
    void getBotIdentity(capturedPlugin.id, pluginConfig);
  }
}

// Start HTTP server for Rust → Bridge communication
const server = honoServe({
  port,
  fetch: async (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Pattern 4: three orthogonal health probes.
    //   /health             — legacy alias for /health/live (Rust watchdog
    //                         pre-rollout still polls this; keep compatible).
    //   /health/live        — bridge process is alive + listening.
    //   /health/ready       — plugin loaded AND gateway registered/started
    //                         (or waiting-for-QR-login). Failure ⇒ structured 503.
    //   /health/functional  — gateway status still receives successful polls
    //                         (or recent forwards for plugins without status).
    //                         Failure ⇒ "alive but not actually serving".
    if (path === '/health' || path === '/health/live') {
      return Response.json({ ok: true, pluginName });
    }

    // Bot identity: returns the bot's user-facing display name resolved by
    // bot-identity.ts. Returns { displayName: null } when no resolver matches
    // the plugin (wecom / weixin) or when resolution failed — caller should
    // treat null as "no identity available" and fall back to platform label.
    if (path === '/identity') {
      if (!capturedPlugin) {
        return Response.json({ displayName: null });
      }
      const identity = await getBotIdentity(capturedPlugin.id, pluginConfig);
      return Response.json({ displayName: identity?.displayName ?? null });
    }

    if (path === '/health/ready') {
      const health = buildReadyHealth({
        pluginLoaded: !!capturedPlugin,
        gatewayError,
        gatewayStarted,
        waitingForQrLogin,
        hasGateway: typeof capturedPlugin?.gateway?.startAccount === 'function',
        pluginName,
        pluginId: capturedPlugin?.id,
        gatewayStatus,
      });
      return Response.json(health.body, { status: health.status });
    }

    if (path === '/health/functional') {
      const lastForward = (globalThis as { __pluginBridgeLastForwardAt?: number }).__pluginBridgeLastForwardAt;
      const health = buildFunctionalHealth({
        pluginLoaded: !!capturedPlugin,
        gatewayError,
        gatewayStarted,
        waitingForQrLogin,
        hasGateway: typeof capturedPlugin?.gateway?.startAccount === 'function',
        pluginName,
        pluginId: capturedPlugin?.id,
        gatewayStatus,
        lastForwardAt: lastForward,
      });
      return Response.json(health.body, { status: health.status });
    }

    if (path === '/status') {
      return Response.json({
        ok: !gatewayError,
        pluginName,
        pluginId: capturedPlugin?.id || 'unknown',
        // Ready when: gateway running OR waiting for QR login (plugin loaded, endpoints available)
        ready: !!capturedPlugin && !gatewayError && (gatewayStarted || waitingForQrLogin),
        error: gatewayError || undefined,
        waitingForQrLogin,
        gatewayStatus: gatewayStatus || undefined,
      });
    }

    if (path === '/capabilities') {
      const outbound = capturedPlugin?.raw?.outbound as Record<string, unknown> | undefined;
      const capabilities = capturedPlugin?.raw?.capabilities as Record<string, unknown> | undefined;
      const toolGroups = mcpHandler ? mcpHandler.getToolGroups() : [];
      const hasTools = getCapturedToolsFn ? getCapturedToolsFn().length > 0 : false;
      const commands = getCapturedCommandsFn
        ? getCapturedCommandsFn().map(c => ({ name: c.name, description: c.description }))
        : [];
      const supportsQrLogin = typeof capturedPlugin?.gateway?.loginWithQrStart === 'function';
      return Response.json({
        pluginId: capturedPlugin?.id || 'unknown',
        textChunkLimit: outbound?.textChunkLimit ?? 4096,
        chunkerMode: outbound?.chunkerMode ?? 'text',
        deliveryMode: outbound?.deliveryMode ?? 'direct',
        capabilities: {
          chatTypes: capabilities?.chatTypes ?? ['direct'],
          media: capabilities?.media ?? false,
          reactions: capabilities?.reactions ?? false,
          threads: capabilities?.threads ?? false,
          edit: !!capturedPlugin?.editMessage || !!(capabilities?.edit),
          blockStreaming: capabilities?.blockStreaming ?? false,
          replyProtocolTransport: true,
          hasTools,
          toolGroups,
          commands,
          supportsQrLogin,
        },
      });
    }

    if (path === '/send-text' && req.method === 'POST') {
      const body = await req.json() as { chatId: string; text: string };
      const { chatId, text } = body;

      if (!capturedPlugin?.sendText) {
        return Response.json({ ok: false, error: 'Plugin has no sendText handler' }, { status: 501 });
      }

      try {
        const result = await capturedPlugin.sendText(chatId, text);
        const messageId = result?.messageId;
        if (!messageId) {
          console.warn(`[plugin-bridge] sendText returned empty messageId for chatId=${chatId} — the platform API may have rejected the request. result:`, JSON.stringify(result));
        }
        return Response.json({ ok: true, messageId: messageId || undefined });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/edit-message' && req.method === 'POST') {
      const body = await req.json() as { chatId: string; messageId: string; text: string };
      const { chatId, messageId, text } = body;

      if (!capturedPlugin?.editMessage) {
        return Response.json({ ok: false, error: 'Not supported' }, { status: 501 });
      }

      try {
        await capturedPlugin.editMessage(chatId, messageId, text);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/delete-message' && req.method === 'POST') {
      const body = await req.json() as { chatId: string; messageId: string };
      const { chatId, messageId } = body;

      if (!capturedPlugin?.deleteMessage) {
        return Response.json({ ok: false, error: 'Not supported' }, { status: 501 });
      }

      try {
        await capturedPlugin.deleteMessage(chatId, messageId);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/send-media' && req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>;

      if (!capturedPlugin?.sendMedia) {
        return Response.json({ ok: false, error: 'Not supported' }, { status: 501 });
      }

      try {
        const result = await capturedPlugin.sendMedia(body);
        return Response.json({ ok: true, messageId: result?.messageId });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/validate-credentials' && req.method === 'POST') {
      // Generic credential validation using the plugin's own isConfigured() check
      if (!capturedPlugin) {
        return Response.json({ ok: false, error: 'Plugin not loaded yet' }, { status: 503 });
      }
      const configCheck = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
      if (typeof configCheck?.isConfigured !== 'function') {
        // Plugin has no isConfigured — assume credentials are fine if plugin loaded
        return Response.json({ ok: true, message: 'Plugin has no credential validator (assumed valid)' });
      }
      try {
        const body = await req.json() as Record<string, unknown>;
        // Build a temporary account-like object from the provided credentials
        const tempAccount = { accountId: 'default', enabled: true, ...body };
        // OpenClaw signature: isConfigured(account, cfg) → boolean | Promise<boolean>
        const configuredResult = (configCheck.isConfigured as (a: unknown, c: unknown) => boolean | Promise<boolean>)(tempAccount, getOpenClawConfigSnapshot());
        const configured = configuredResult instanceof Promise ? await configuredResult : configuredResult;
        if (configured) {
          return Response.json({ ok: true, message: 'Credentials valid (isConfigured passed)' });
        } else {
          return Response.json({ ok: false, error: 'Plugin reports credentials incomplete' });
        }
      } catch (err) {
        return Response.json({ ok: false, error: `Validation error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
      }
    }

    // ===== Request-scoped OpenClaw reply transport =====

    const protocolError = (requestId: string, err: unknown): Response => {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith('protocol_dispatch_missing')
        ? 'protocol_dispatch_missing'
        : 'protocol_dispatch_error';
      mergeGatewayStatus({
        lastProtocolError: { code, requestId, at: Date.now() },
      });
      console.error(
        `[plugin-bridge] ${code} pluginId=${capturedPlugin?.id || 'unknown'} requestId=${requestId}:`,
        err,
      );
      return Response.json({ ok: false, error: code }, { status: code === 'protocol_dispatch_missing' ? 404 : 500 });
    };

    if (path === '/start-dispatch' && req.method === 'POST') {
      const body = await req.json() as { requestId: string };
      try {
        enqueueRunStart(body.requestId);
        return Response.json({ ok: true });
      } catch (err) {
        return protocolError(body.requestId, err);
      }
    }

    if (path === '/start-stream' && req.method === 'POST') {
      const body = await req.json() as {
        requestId: string;
        chatId: string;
        initialContent?: string;
      };
      const streamId = `reply_${++streamIdCounter}_${Date.now()}`;
      try {
        bindPendingStream(body.requestId, streamId);
        if (body.initialContent) {
          enqueuePartial(streamId, { text: body.initialContent }, 'answer');
        }
        return Response.json({ ok: true, streamId });
      } catch (err) {
        return protocolError(body.requestId, err);
      }
    }

    if (path === '/stream-chunk' && req.method === 'POST') {
      const body = await req.json() as {
        streamId: string;
        content: string;
        sequence?: number;
        isThinking?: boolean;
      };
      try {
        enqueuePartial(
          body.streamId,
          { text: body.content },
          body.isThinking ? 'reasoning' : 'answer',
        );
        return Response.json({ ok: true });
      } catch (err) {
        return protocolError(body.streamId, err);
      }
    }

    if (path === '/finish-stream-block' && req.method === 'POST') {
      const body = await req.json() as { streamId: string };
      try {
        enqueueBlockBoundary(body.streamId);
        return Response.json({ ok: true });
      } catch (err) {
        return protocolError(body.streamId, err);
      }
    }

    if (path === '/complete-dispatch' && req.method === 'POST') {
      const body = await req.json() as {
        requestId: string;
        finalPayloads?: OpenClawReplyPayload[];
      };
      try {
        completePendingDispatch(body.requestId, body.finalPayloads ?? []);
        return Response.json({ ok: true });
      } catch (err) {
        return protocolError(body.requestId, err);
      }
    }

    if (path === '/abort-dispatch' && req.method === 'POST') {
      const body = await req.json() as {
        requestId: string;
        reason?: string;
        terminalPayload: OpenClawReplyPayload;
      };
      try {
        abortPendingDispatch(body.requestId, body.terminalPayload);
        return Response.json({ ok: true });
      } catch (err) {
        return protocolError(body.requestId, err);
      }
    }

    // ===== MCP tool proxy endpoints =====

    if (path === '/mcp/tools' && req.method === 'GET') {
      if (!mcpHandler) {
        return Response.json({ ok: false, error: 'MCP handler not initialized (no tools captured)' }, { status: 503 });
      }

      const groupsParam = url.searchParams.get('groups');
      const enabledGroups = groupsParam ? groupsParam.split(',').map((g) => g.trim()).filter(Boolean) : undefined;

      try {
        const tools = mcpHandler.resolveTools(enabledGroups);
        return Response.json({ ok: true, tools });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/mcp/call-tool' && req.method === 'POST') {
      if (!mcpHandler) {
        return Response.json({ ok: false, error: 'MCP handler not initialized (no tools captured)' }, { status: 503 });
      }

      const body = await req.json() as {
        toolName: string;
        args: Record<string, unknown>;
        userId?: string;
        isOwner?: boolean;
        enabledGroups?: string[];
        // Ticket context for AsyncLocalStorage injection (Feishu OAuth auto-auth)
        chatId?: string;
        chatType?: string;
        accountId?: string;
      };

      if (!body.toolName) {
        return Response.json({ ok: false, error: 'Missing required field: toolName' }, { status: 400 });
      }

      // Enforce tool group restrictions: only allow tools in enabled groups
      if (body.enabledGroups && body.enabledGroups.length > 0) {
        const allowedTools = mcpHandler.resolveTools(body.enabledGroups);
        const isAllowed = allowedTools.some(t => t.name === body.toolName);
        if (!isAllowed) {
          return Response.json({ ok: false, error: `Tool "${body.toolName}" is not in the enabled tool groups` }, { status: 403 });
        }
      }

      try {
        // Wrap tool execution in plugin's withTicket() if available.
        // This injects the LarkTicket context so the plugin's auto-auth
        // (handleInvokeErrorWithAutoAuth) can find the sender and chat to
        // send OAuth Device Flow cards. Without this, getTicket() returns
        // undefined and auto-auth silently falls back to error propagation.
        const doCall = () => mcpHandler!.callTool(body.toolName, body.args || {}, body.userId, body.isOwner);

        let result: unknown;
        if (pluginWithTicket && body.userId) {
          const ticket = {
            senderOpenId: body.userId,
            chatId: body.chatId || body.userId,
            chatType: body.chatType || 'p2p',
            accountId: body.accountId || 'default',
            messageId: `bridge-mcp-${Date.now()}`,
            startTime: Date.now(),
          };
          result = await pluginWithTicket(ticket, doCall);
        } else {
          result = await doCall();
        }
        // Ensure result is never undefined — JSON.stringify omits undefined keys,
        // causing downstream MCP SDK validation to fail (text: undefined)
        return Response.json({ ok: true, result: result ?? null });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // ===== Plugin command execution =====

    if (path === '/execute-command' && req.method === 'POST') {
      const body = await req.json() as { command: string; args?: string; userId?: string; chatId?: string };
      if (!body.command) {
        return Response.json({ ok: false, error: 'Missing required field: command' }, { status: 400 });
      }

      const commands = getCapturedCommandsFn ? getCapturedCommandsFn() : [];
      const cmd = commands.find(c => c.name === body.command);
      if (!cmd) {
        return Response.json({ ok: false, error: `Unknown command: /${body.command}` }, { status: 404 });
      }

      try {
        const result = await cmd.execute({
          args: body.args || '',
          userId: body.userId,
          chatId: body.chatId,
          config: getOpenClawConfigSnapshot(),
        });
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return Response.json({ ok: true, result: text });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // ===== QR Login endpoints (generic OpenClaw gateway protocol) =====

    if (path === '/qr-login-start' && req.method === 'POST') {
      const loginWithQrStart = capturedPlugin?.gateway?.loginWithQrStart;
      if (typeof loginWithQrStart !== 'function') {
        return Response.json({ ok: false, error: 'Plugin does not support QR login' }, { status: 501 });
      }
      try {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const result = await (loginWithQrStart as (params: Record<string, unknown>) => Promise<Record<string, unknown>>)(body);
        // qrDataUrl can be:
        // 1. data:image/png;base64,... (WhatsApp) — pass through, frontend renders as <img>
        // 2. https://... (WeChat) — a URL to be QR-encoded, NOT an image to download.
        //    The frontend will use the `qrcode` library to encode this URL into a QR image.
        //    WeChat's qrcode_img_content is a web page URL, not a direct image.
        // Both cases: return as-is. Frontend handles rendering.
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/qr-login-wait' && req.method === 'POST') {
      const loginWithQrWait = capturedPlugin?.gateway?.loginWithQrWait;
      if (typeof loginWithQrWait !== 'function') {
        return Response.json({ ok: false, error: 'Plugin does not support QR login' }, { status: 501 });
      }
      try {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        // loginWithQrWait may long-poll (up to 35s for WeChat), so no timeout here
        const result = await (loginWithQrWait as (params: Record<string, unknown>) => Promise<Record<string, unknown>>)(body);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/restart-gateway' && req.method === 'POST') {
      // After QR login success, restart the gateway with fresh credentials
      if (!capturedPlugin) {
        return Response.json({ ok: false, error: 'No plugin loaded' }, { status: 500 });
      }
      try {
        // 1. Stop current gateway gracefully (abort + explicit stopAccount)
        const abortCtrl = (globalThis as Record<string, unknown>).__bridgeAbort as AbortController | undefined;
        if (abortCtrl) abortCtrl.abort();
        const stopAccount = capturedPlugin.gateway?.stopAccount;
        if (typeof stopAccount === 'function') {
          try { await (stopAccount as () => Promise<void>)(); } catch { /* best-effort */ }
        }

        // 2. Re-resolve account with fresh credentials
        // CRITICAL: pass accountId from QR login result — plugins like WeChat require
        // accountId to look up the newly-saved credentials on disk
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const qrAccountId = body.accountId as string | undefined;
        const openclawCfg = getOpenClawConfigSnapshot();
        const resolveAccount = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
        let account: Record<string, unknown> = pluginConfig;
        if (typeof resolveAccount?.resolveAccount === 'function') {
          try {
            account = await (resolveAccount.resolveAccount as (cfg: unknown, id?: string) => Promise<Record<string, unknown>>)(openclawCfg, qrAccountId) || pluginConfig;
          } catch (err) {
            console.warn('[plugin-bridge] resolveAccount failed after QR login:', err);
            // If resolve failed but we have an accountId, try building a minimal account
            if (qrAccountId) {
              account = { accountId: qrAccountId, enabled: true, configured: true, ...pluginConfig };
            }
          }
        }

        // 3. Check if now configured
        // OpenClaw signature: isConfigured(account, cfg) → boolean | Promise<boolean>
        const isConfigured = resolveAccount;
        if (typeof isConfigured?.isConfigured === 'function') {
          const configuredResult = (isConfigured.isConfigured as (a: unknown, c: unknown) => boolean | Promise<boolean>)(account, openclawCfg);
          const configured = configuredResult instanceof Promise ? await configuredResult : configuredResult;
          if (!configured) {
            return Response.json({ ok: false, error: 'Account still not configured after QR login' }, { status: 400 });
          }
        }

        // 4. Update shared account (sendText/sendMedia closures use currentAccount)
        currentAccount = account;
        waitingForQrLogin = false; // QR login complete, transitioning to running state

        // 5. Start gateway with new account
        const startAccount = capturedPlugin.gateway?.startAccount;
        if (typeof startAccount === 'function') {
          // QR-restart path runs after loadPlugin() completed → loadedRuntime
          // is always set. Bail loudly if not — a missing channelRuntime would
          // resurrect the original "host too old" startup failure on weixin.
          if (!loadedRuntime) {
            return Response.json({ ok: false, error: 'Bridge runtime not initialized; cannot restart gateway' }, { status: 500 });
          }
          const newAbort = new AbortController();
          gatewayStatus = null;
          let status: GatewayRuntimeStatus = { running: false, connected: false };
          const restartAccountId = (account.accountId as string) || qrAccountId || 'default';
          const channelSurface = loadedRuntime.channel;
          const ctx = {
            account,
            accountId: restartAccountId,
            abortSignal: newAbort.signal,
            log: console,
            runtime: loadedRuntime,
            channelRuntime: { ...channelSurface, channel: channelSurface },
            cfg: openclawCfg,
            getStatus: () => status,
            setStatus: (s: GatewayRuntimeStatus) => {
              status = { ...status, ...s };
              mergeGatewayStatus(s);
            },
          };
          gatewayError = null;
          gatewayStarted = true;
          // Pre-warm bot identity after QR-login restart — pluginConfig may have
          // been mutated (e.g. accountId persisted). Cache from the pre-QR
          // attempt is still valid for plugins where identity is config-derived;
          // for QR-only plugins (weixin) the resolver returns null anyway.
          void getBotIdentity(capturedPlugin.id, pluginConfig);
          // Store context for stopAccount()
          (globalThis as Record<string, unknown>).__bridgeGatewayCtx = ctx;
          (startAccount as (ctx: Record<string, unknown>) => Promise<void>)(ctx)
            .then(() => console.log('[plugin-bridge] Gateway restarted after QR login'))
            .catch((err: unknown) => {
              gatewayError = err instanceof Error ? err.message : String(err);
              mergeGatewayStatus({ running: false, lastError: gatewayError });
              console.error('[plugin-bridge] Gateway restart error:', gatewayError);
            });
          (globalThis as Record<string, unknown>).__bridgeAbort = newAbort;
        }
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // ===== Lifecycle endpoints =====

    if (path === '/stop' && req.method === 'POST') {
      console.log('[plugin-bridge] Received stop signal');
      // Clean up pending protocol dispatches
      clearAllPendingDispatches();
      // Abort the gateway via AbortController
      const abortCtrl = (globalThis as Record<string, unknown>).__bridgeAbort as AbortController | undefined;
      if (abortCtrl) abortCtrl.abort();
      mergeGatewayStatus({ running: false });
      // Abort any in-flight bot-identity resolver fetches.
      abortResolver();
      // Also try calling stopAccount if available — OpenClaw expects same context as startAccount
      const stopAccount = capturedPlugin?.gateway?.stopAccount;
      if (typeof stopAccount === 'function') {
        try {
          const gatewayCtx = (globalThis as Record<string, unknown>).__bridgeGatewayCtx as Record<string, unknown> | undefined;
          await (stopAccount as (ctx?: Record<string, unknown>) => Promise<void>)(gatewayCtx);
        } catch (err) {
          console.error('[plugin-bridge] Error stopping plugin gateway:', err);
        }
      }
      // Graceful shutdown
      setTimeout(() => process.exit(0), 500);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

// honoServe returns a Node http.Server whose address() resolves after 'listening'.
const serverAddr = server.address();
const listenPort = typeof serverAddr === 'object' && serverAddr ? serverAddr.port : port;
console.log(`[plugin-bridge] HTTP server listening on port ${listenPort}`);

// Establish the process-wide general proxy baseline (including a local HTTP
// bridge for SOCKS5) before plugin code opens any external connection. Plugin
// Bridge owns no model-provider traffic, so provider-only scope must not start
// or consume the app proxy in this process.
initializeProxyStateFromCurrentSettings({ providerOwnedConsumers: false })
  .then(() => {
    // Community plugins call global fetch directly. Install the package-pinned
    // implementation before evaluating plugin code, then bind it to the same
    // general-request baseline used by first-party callers. The Bridge process
    // is restarted when this scope changes, so this dispatcher is immutable for
    // the process lifetime.
    installUndiciGlobals();
    setGlobalDispatcher(getGeneralRequestDispatcher());
    return loadPlugin();
  })
  .catch((err) => {
    console.error('[plugin-bridge] Failed to initialize proxy or load plugin:', err);
    process.exit(1);
  });
