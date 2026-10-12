import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * saveToolAttachment — 统一入口，把 (base64 / 已落盘绝对路径 / 远程 URL) 三种
 * 来源都转成 ToolAttachment，前端用 ToolAttachmentGallery 统一渲染。
 *
 * PRD 0.2.15 §4.5。
 *
 * 安全：
 * - base64 落盘路径 MUST 在 trusted attachment root（~/.myagents/generated/tool-attachments/）
 * - externalPath（Codex savedPath 等）MUST 过 validateExternalReadPathNode 黑名单
 * - 单文件大小 ≤ MAX_TOOL_ATTACHMENT_BYTES；caption 长度 ≤ MAX_TOOL_ATTACHMENT_CAPTION_BYTES
 *
 * 异步策略：parseNotification 不直接 await，而是 emit 一个占位 attachment（pendingId）
 * 然后在 then 里 broadcast `tool_attachment_update` patch — 避免 head-of-line block。
 * 见 codex.ts 的调用方。
 */

import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

import { withAbortSignal } from '../utils/cancellation';
import {
  validateExternalReadPathNode,
  validateTrustedAttachmentRoot,
  getToolAttachmentRoot,
} from '../utils/path-safety';
import {
  type ToolAttachment,
  type ToolAttachmentKind,
  MAX_TOOL_ATTACHMENT_BYTES,
  MAX_TOOL_ATTACHMENT_CAPTION_BYTES,
} from '../../shared/types/tool-attachment';

/**
 * Error reason codes — short, safe enum that ships to the renderer/SSE/IM.
 * Verbose underlying messages are kept in server logs only (no path/home leak).
 * Codex review C4 / privacy.
 */
export const ATTACHMENT_ERROR_CODES = {
  TOO_LARGE: 'too_large',
  REJECTED_PATH: 'rejected_path',
  NOT_FOUND: 'not_found',
  FETCH_FAILED: 'fetch_failed',
  UNSUPPORTED_URL: 'unsupported_url',
  DECODE_FAILED: 'decode_failed',
  UNKNOWN: 'unknown',
} as const;
export type AttachmentErrorCode = typeof ATTACHMENT_ERROR_CODES[keyof typeof ATTACHMENT_ERROR_CODES];

class AttachmentSaveError extends Error {
  constructor(public readonly code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = 'AttachmentSaveError';
  }
}

export type AttachmentSource =
  | { kind: 'base64'; data: string }
  | { kind: 'externalPath'; sourcePath: string }
  | { kind: 'url'; url: string };

export interface SaveContext {
  sessionId: string;
  turnId: string;
  toolUseId: string;
  mimeType: string;
  /** Defaults to inferring from mimeType (image/* → 'image'); pass explicit when caller knows. */
  kind?: ToolAttachmentKind;
  caption?: string;
  producedBy?: string;
}

/**
 * Build a stable filename that's safe across OSes (no `/`, `..`, control chars,
 * no overly long toolUseId chunks). Includes a uuid to prevent collisions
 * across concurrent turns sharing the same toolUseId.
 */
function buildFilename(ctx: SaveContext): string {
  const ext = mimeToExt(ctx.mimeType);
  const safeTool = ctx.toolUseId.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32);
  const stamp = Date.now().toString(36);
  const uniq = randomUUID().slice(0, 8);
  return `${safeTool || 'tool'}-${stamp}-${uniq}.${ext}`;
}

export function mimeToExt(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split('+')[0] || 'bin';
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg') return 'svg';
  // `audio/mpeg` → `.mp3` (not `.mpeg`) so the OS associates the file with an
  // audio player for the attachment "open with default app" action (PRD 0.2.30).
  if (subtype === 'mpeg' && mimeType.startsWith('audio/')) return 'mp3';
  if (subtype === 'mp4' && mimeType.startsWith('audio/')) return 'm4a';
  return subtype;
}

function inferKind(mimeType: string): ToolAttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'file';
}

function capCaption(caption?: string): string | undefined {
  if (!caption) return undefined;
  if (caption.length <= MAX_TOOL_ATTACHMENT_CAPTION_BYTES) return caption;
  return caption.slice(0, MAX_TOOL_ATTACHMENT_CAPTION_BYTES);
}

function sanitizeSessionTurnSegment(seg: string): string {
  // Filenames in path can't contain / or \ or .. ; we also reject control chars.
  return seg.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function buildRefPath(sessionId: string, turnId: string, filename: string): string {
  const s = sanitizeSessionTurnSegment(sessionId);
  const t = sanitizeSessionTurnSegment(turnId);
  return `/api/attachment/tool/${encodeURIComponent(s)}/${encodeURIComponent(t)}/${encodeURIComponent(filename)}`;
}

function buildSavedPath(sessionId: string, turnId: string, filename: string): string {
  const root = getToolAttachmentRoot();
  return path.join(root, sanitizeSessionTurnSegment(sessionId), sanitizeSessionTurnSegment(turnId), filename);
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function saveBase64Source(
  b64: string,
  ctx: SaveContext,
  decodedBytes?: Buffer,
): Promise<ToolAttachment> {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.DECODE_FAILED, 'Empty base64 data');
  }
  // Quick size pre-check from b64 length (Buffer.byteLength would be more
  // accurate but b64 length ≥ raw bytes always, so this is a fast reject).
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > MAX_TOOL_ATTACHMENT_BYTES) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.TOO_LARGE,
      `Base64 string too large: ~${approxBytes} bytes > ${MAX_TOOL_ATTACHMENT_BYTES}`,
    );
  }
  // Callers that already decoded (e.g. saveExtractedToolResultAttachments
  // writes the same bytes into the workspace first) pass them through —
  // decoding a 25MB image twice means two transient ~25MB buffers
  // (cross-review 0.2.33, Codex + cc).
  const buf = decodedBytes ?? Buffer.from(b64, 'base64');
  if (buf.length === 0) {
    throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.DECODE_FAILED, 'Decoded empty base64');
  }
  if (buf.length > MAX_TOOL_ATTACHMENT_BYTES) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.TOO_LARGE,
      `Decoded too large: ${buf.length} bytes`,
    );
  }

  const filename = buildFilename(ctx);
  const savedPath = buildSavedPath(ctx.sessionId, ctx.turnId, filename);

  // Defense-in-depth: must be inside trusted attachment root.
  const checkRoot = validateTrustedAttachmentRoot(savedPath, { canonicalizeSymlinks: false });
  if (!checkRoot.ok) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.REJECTED_PATH,
      `Refusing to write outside trusted root: ${checkRoot.reason}`,
    );
  }

  await ensureParentDir(savedPath);
  // Codex review W1: use `wx` exclusive-create flag to fail on filename collision
  // rather than silently overwrite a prior write. UUID + ms timestamp makes
  // collisions vanishingly rare, but cheap insurance.
  await writeFile(savedPath, buf, { flag: 'wx' });

  return {
    kind: ctx.kind ?? inferKind(ctx.mimeType),
    mimeType: ctx.mimeType,
    refPath: buildRefPath(ctx.sessionId, ctx.turnId, filename),
    savedPath,
    sizeBytes: buf.length,
    caption: capCaption(ctx.caption),
    producedBy: ctx.producedBy,
  };
}

/**
 * Positive allow-list for external-path attachments. Allows references to:
 *   - the MyAgents trusted root (own writes)
 *   - Codex's own caches under ~/.codex/ (savedPath from imageGeneration)
 *   - Managed Codex output under ~/.myagents/ (with auth.json still blacklisted)
 *   - the OS user's typical "documents" dirs (when Codex saves a generated
 *     file into the working directory) — but still subject to blacklist
 *
 * Beyond these prefixes we refuse the reference even if the path passes
 * the blacklist (cc-C4: don't broadcast bytes from ~/Documents/secrets.docx
 * just because nothing's stopping it).
 */
const HOME = homedir() || '';

export function isAllowedExternalAttachmentPrefix(canonical: string): boolean {
  if (!HOME) return false;
  const allowedPrefixes = [
    getToolAttachmentRoot(),
    path.join(HOME, '.codex'),
    path.join(HOME, APP_DATA_DIR_NAME),
    // Codex can also save into the project workspace; the workspacePath isn't
    // known here, so we allow ~/Documents and ~/Desktop as a pragmatic default.
    // These are still subject to blacklist (no credential paths etc.).
    path.join(HOME, 'Documents'),
    path.join(HOME, 'Desktop'),
    path.join(HOME, 'Downloads'),
  ];
  for (const prefix of allowedPrefixes) {
    const norm = path.normalize(prefix);
    if (canonical === norm) return true;
    const sep = path.sep;
    if (canonical.startsWith(norm.endsWith(sep) ? norm : norm + sep)) return true;
  }
  return false;
}


async function referenceExternalPath(sourcePath: string, ctx: SaveContext): Promise<ToolAttachment> {
  // Zero-copy reference (Codex savedPath etc). Goes through:
  //   1. system/credential blacklist (validateExternalReadPathNode)
  //   2. realpath canonicalization (catches evil_link → /etc/passwd symlinks)
  //   3. positive allow-list (refuses arbitrary user files like ~/Documents/secrets.docx)
  //   4. lstat reject symlinks on the leaf (defense-in-depth even after #2)
  //   5. file size + regular-file checks
  const check = validateExternalReadPathNode(sourcePath, { canonicalizeSymlinks: true });
  if (!check.ok) {
    throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.REJECTED_PATH, `External path rejected: ${check.reason}`);
  }
  if (!isAllowedExternalAttachmentPrefix(check.canonical)) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.REJECTED_PATH,
      `External path outside allowed prefixes (canonical=${check.canonical})`,
    );
  }

  const statResult = await stat(check.canonical).catch(() => null);
  if (!statResult || !statResult.isFile()) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.NOT_FOUND,
      `External path not a regular file or missing: ${sourcePath}`,
    );
  }
  if (statResult.size > MAX_TOOL_ATTACHMENT_BYTES) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.TOO_LARGE,
      `External attachment too large: ${statResult.size} bytes`,
    );
  }

  // Filename in URL is derived from sourcePath basename for diagnostic readability,
  // but the endpoint resolves the real path via SessionStore lookup, not by trusting
  // this filename.
  const ext = mimeToExt(ctx.mimeType);
  const baseName = path.basename(check.canonical).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const finalName = baseName.endsWith('.' + ext) ? baseName : `${baseName}.${ext}`;

  // Register so the endpoint can map sid/tid/filename → real path on demand.
  registerExternalAttachment(ctx.sessionId, ctx.turnId, finalName, check.canonical);

  return {
    kind: ctx.kind ?? inferKind(ctx.mimeType),
    mimeType: ctx.mimeType,
    refPath: buildRefPath(ctx.sessionId, ctx.turnId, finalName),
    savedPath: check.canonical,
    sizeBytes: statResult.size,
    caption: capCaption(ctx.caption),
    producedBy: ctx.producedBy,
  };
}

/**
 * Reject URLs whose host resolves (lexically) to private/loopback/link-local
 * ranges, plus non-https schemes. SSRF defense — prevents prompt-injected
 * tools from making the sidecar fetch internal metadata services
 * (169.254.169.254 etc.) or localhost-bound services.
 *
 * Codex review Critical#3.
 *
 * Exported for unit testing — pure (URL) → result, no I/O.
 */
/**
 * Is a host string (literal IP or a DNS-resolved address) in a private /
 * loopback / link-local range we must never let an attachment fetch reach?
 * Shared by the lexical pre-check (`isUrlSchemeSafe`) and the DNS-resolution
 * post-check (`assertPublicHostname`) so both judge addresses identically.
 */
function isBlockedHostLiteral(host: string): boolean {
  if (
    host === 'localhost' ||
    host === '127.0.0.1' || host.startsWith('127.') ||
    host === '0.0.0.0' ||
    host === '::1' || host === '[::1]' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^\[?fc00:/i.test(host) || /^\[?fd[0-9a-f]{2}:/i.test(host) || /^\[?fe80:/i.test(host)
  ) {
    return true;
  }
  // IPv6 forms the lexical IPv4 checks above miss (cross-review W1). Node keeps
  // the brackets in `hostname` for IPv6 literals — strip + lower-case first.
  //  - `::` / unspecified routes to loopback on many stacks.
  //  - `::ffff:<v4>` (IPv4-mapped IPv6, dotted `::ffff:127.0.0.1` OR hex
  //    `::ffff:7f00:1`) is a classic SSRF bypass for loopback/private targets;
  //    reject the literal form outright — legitimate image hosts don't use it.
  const h6 = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h6 === '::' || h6 === '::0' || /^(?:0:){7}0$/.test(h6) || h6.startsWith('::ffff:')) {
    return true;
  }
  return false;
}

export function isUrlSchemeSafe(parsed: URL): { ok: true } | { ok: false; reason: string } {
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }
  // Lexical pre-check — rejects literal private/loopback hosts before any DNS.
  // Hostname SSRF (a public name resolving to a private IP) is caught by the
  // DNS post-check in `assertPublicHostname` just before fetch.
  if (isBlockedHostLiteral(parsed.hostname)) {
    return { ok: false, reason: `Blocked private/loopback host: ${parsed.hostname}` };
  }
  return { ok: true };
}

/**
 * SSRF DNS guard (#293 cross-review): the lexical check can't see that
 * `https://attacker.example/x.png` resolves to `127.0.0.1` / `169.254.169.254`
 * (cloud metadata) / RFC1918. Attachment URLs are model/tool-controlled, so a
 * public name pointing inward is a real SSRF vector.
 *
 * Resolves the host, rejects if ANY returned address is private, AND returns an
 * undici dispatcher PINNED to the validated addresses via `connect.lookup` — so
 * the subsequent fetch connects to the exact IPs we vetted instead of
 * re-resolving. This CLOSES the DNS-rebinding TOCTOU (a public answer to the
 * guard lookup, a private answer at connect time): undici's connector can only
 * return addresses from the pre-validated set. TLS SNI/cert verification still
 * uses the original hostname, so HTTPS identity is unaffected. A literal-IP host
 * needs neither check nor pin (undici connects to the literal directly;
 * `isUrlSchemeSafe` already vetted it) → returns undefined.
 *
 * The dispatcher MUST be fetched with undici's OWN `fetch` (same package
 * version) — the global fetch is Node's built-in undici and rejects a foreign
 * Agent. Caller MUST `.close()` it after the body is consumed (per-request
 * agent; leaving it open leaks sockets).
 */
async function buildSsrfGuardedDispatcher(parsed: URL): Promise<Agent | undefined> {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return undefined; // literal IP — already vetted, no re-resolution risk
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.FETCH_FAILED, `DNS resolution failed for ${host}`);
  }
  for (const { address } of addresses) {
    if (isBlockedHostLiteral(address)) {
      throw new AttachmentSaveError(
        ATTACHMENT_ERROR_CODES.UNSUPPORTED_URL,
        `Blocked: ${host} resolves to private/loopback address`,
      );
    }
  }
  // Pin connect-time resolution to the validated set — undici won't re-resolve.
  const pinned = addresses.map((a) => ({ address: a.address, family: a.family }));
  return new Agent({
    connect: {
      lookup: (_hostname: string, _options: unknown, cb: (err: Error | null, addrs: { address: string; family: number }[]) => void) => {
        cb(null, pinned);
      },
    },
  });
}

async function downloadAndSaveUrl(url: string, ctx: SaveContext, signal?: AbortSignal): Promise<ToolAttachment> {
  // data: URLs are handled inline (no network) — but still subject to size cap.
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!match) {
      throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.UNSUPPORTED_URL, 'Unsupported data URL');
    }
    const [, mime, b64] = match;
    return saveBase64Source(b64, { ...ctx, mimeType: mime || ctx.mimeType });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.UNSUPPORTED_URL, `Malformed URL`);
  }
  const schemeCheck = isUrlSchemeSafe(parsed);
  if (!schemeCheck.ok) {
    throw new AttachmentSaveError(ATTACHMENT_ERROR_CODES.UNSUPPORTED_URL, schemeCheck.reason);
  }
  // DNS guard: reject a public hostname resolving to a private IP, and pin the
  // fetch to the validated addresses (closes the rebinding TOCTOU). undefined
  // for a literal-IP host (no re-resolution to defend against).
  const dispatcher = await buildSsrfGuardedDispatcher(parsed);

  let buf: Buffer;
  let mime: string;
  try {
    // Use undici's OWN fetch (not the global) so it matches the `Agent` version
    // — mixing the repo's undici@8 Agent with Node's built-in-undici global fetch
    // throws "invalid onRequestStart method". `withAbortSignal` composes the
    // parent signal + 30s timeout (same semantics cancellableFetch gave us).
    const resp = await withAbortSignal(
      signal,
      (s) => undiciFetch(url, {
        redirect: 'error',
        signal: s,
        ...(dispatcher ? { dispatcher } : {}),
      } as UndiciRequestInit),
      { timeoutMs: 30_000 },
    );
    if (!resp.ok) {
      throw new AttachmentSaveError(
        ATTACHMENT_ERROR_CODES.FETCH_FAILED,
        `URL fetch failed: ${resp.status}`,
      );
    }

    const contentLengthHeader = resp.headers.get('content-length');
    if (contentLengthHeader) {
      const len = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(len) && len > MAX_TOOL_ATTACHMENT_BYTES) {
        throw new AttachmentSaveError(
          ATTACHMENT_ERROR_CODES.TOO_LARGE,
          `URL response too large per Content-Length: ${len}`,
        );
      }
    }
    // Stream with a cumulative cap — Content-Length is optional (chunked
    // encoding), so `arrayBuffer()` would let a hostile endpoint allocate an
    // unbounded body before the size check ever ran. The URL is
    // model/MCP-controlled, same trust class as the SSRF guards above
    // (cross-review 0.2.33, Codex W4). Abort the read the moment the cap is
    // crossed; fall back to arrayBuffer only when there's no body stream.
    if (resp.body) {
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_TOOL_ATTACHMENT_BYTES) {
          await reader.cancel().catch(() => {});
          throw new AttachmentSaveError(
            ATTACHMENT_ERROR_CODES.TOO_LARGE,
            `URL response too large: >${MAX_TOOL_ATTACHMENT_BYTES} bytes (no/false Content-Length)`,
          );
        }
        chunks.push(value);
      }
      buf = Buffer.concat(chunks);
    } else {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > MAX_TOOL_ATTACHMENT_BYTES) {
        throw new AttachmentSaveError(
          ATTACHMENT_ERROR_CODES.TOO_LARGE,
          `URL response too large: ${ab.byteLength} bytes`,
        );
      }
      buf = Buffer.from(ab);
    }
    mime = resp.headers.get('content-type')?.split(';')[0]?.trim() || ctx.mimeType;
  } finally {
    // Per-request agent — close after the body is consumed (or on error) so we
    // don't leak the pinned socket pool.
    if (dispatcher) void dispatcher.close().catch(() => { /* best-effort */ });
  }

  const filename = buildFilename({ ...ctx, mimeType: mime });
  const savedPath = buildSavedPath(ctx.sessionId, ctx.turnId, filename);

  const checkRoot = validateTrustedAttachmentRoot(savedPath, { canonicalizeSymlinks: false });
  if (!checkRoot.ok) {
    throw new AttachmentSaveError(
      ATTACHMENT_ERROR_CODES.REJECTED_PATH,
      `Refusing to write outside trusted root: ${checkRoot.reason}`,
    );
  }

  await ensureParentDir(savedPath);
  await writeFile(savedPath, buf, { flag: 'wx' });

  return {
    kind: ctx.kind ?? inferKind(mime),
    mimeType: mime,
    refPath: buildRefPath(ctx.sessionId, ctx.turnId, filename),
    savedPath,
    sizeBytes: buf.length,
    caption: capCaption(ctx.caption),
    producedBy: ctx.producedBy,
  };
}

/**
 * Unified entry point. Three sources resolved into a fully-formed ToolAttachment.
 *
 * Throws on size limit / blacklist / IO failure. Callers should either:
 *  - log + downgrade to a placeholder error attachment, or
 *  - silently drop (with a log).
 */
export async function saveToolAttachment(
  source: AttachmentSource,
  ctx: SaveContext,
  opts?: { signal?: AbortSignal; decodedBase64Bytes?: Buffer },
): Promise<ToolAttachment> {
  switch (source.kind) {
    case 'base64':
      return saveBase64Source(source.data, ctx, opts?.decodedBase64Bytes);
    case 'externalPath':
      return referenceExternalPath(source.sourcePath, ctx);
    case 'url':
      return downloadAndSaveUrl(source.url, ctx, opts?.signal);
  }
}

/**
 * Build a placeholder attachment for synchronous emission, with a pendingId
 * the caller will use to broadcast `chat:tool-attachment-update` once the
 * async save resolves.
 */
export function makePlaceholderAttachment(ctx: SaveContext): { attachment: ToolAttachment; pendingId: string } {
  const pendingId = randomUUID();
  return {
    pendingId,
    attachment: {
      kind: ctx.kind ?? inferKind(ctx.mimeType),
      mimeType: ctx.mimeType,
      refPath: '',
      caption: capCaption(ctx.caption),
      producedBy: ctx.producedBy,
      pendingId,
    },
  };
}

/**
 * Build a 'failed' attachment when async save throws. Marks refPath with the
 * `error://` sentinel + a safe error code (NOT the raw error message).
 *
 * Codex review C4 / privacy: raw error.message often contains absolute paths
 * (HOME, .codex sessions dir, etc.) that would leak through SSE and persist
 * in SessionStore. We map to an enum here and keep the verbose detail in the
 * server log only.
 */
export function makeErrorAttachment(
  ctx: SaveContext,
  err: unknown,
  pendingId: string,
): ToolAttachment {
  let code: AttachmentErrorCode = ATTACHMENT_ERROR_CODES.UNKNOWN;
  if (err instanceof AttachmentSaveError) {
    code = err.code;
  } else if (err instanceof Error) {
    // Best-effort mapping for unexpected throws (fs EACCES, network ENOTFOUND).
    if (/timeout|abort/i.test(err.message)) code = ATTACHMENT_ERROR_CODES.FETCH_FAILED;
    else if (/ENOENT|not found/i.test(err.message)) code = ATTACHMENT_ERROR_CODES.NOT_FOUND;
    else if (/too large|exceed/i.test(err.message)) code = ATTACHMENT_ERROR_CODES.TOO_LARGE;
  }
  return {
    kind: ctx.kind ?? inferKind(ctx.mimeType),
    mimeType: ctx.mimeType,
    refPath: `error://${code}`,
    caption: capCaption(ctx.caption),
    producedBy: ctx.producedBy,
    pendingId,
  };
}

// ──────────────────────────────────────────────────────────────────────
// In-flight async save tracking
// ──────────────────────────────────────────────────────────────────────
//
// `scheduleAttachmentSave` (called from parseNotification) fires off save
// promises in the background. PRD §4.7.1 — they emit `tool_attachment_update`
// when resolved. But `persistTurnResult` may run before the save completes,
// snapshotting `currentContentBlocks` with the placeholder still in place.
// The disk JSON then carries the unfulfilled placeholder forever — and the
// later `tool_attachment_update` lands on an already-reset `currentContentBlocks`.
//
// Fix: track in-flight saves per turn; `persistTurnResult` awaits them before
// snapshotting. This serializes only the persist boundary, not the synchronous
// `tool_result` SSE emit, so the renderer still sees the immediate placeholder.

const inFlightSaves = new Set<Promise<void>>();

/** Register an in-flight async save. Returned promise is added/removed automatically. */
export function trackInFlightSave(p: Promise<void>): void {
  inFlightSaves.add(p);
  const cleanup = () => inFlightSaves.delete(p);
  p.then(cleanup, cleanup);
}

/** Wait for all currently-in-flight async saves to settle. Used by persistTurnResult. */
export async function awaitInFlightSaves(): Promise<void> {
  if (inFlightSaves.size === 0) return;
  await Promise.allSettled([...inFlightSaves]);
}

// ──────────────────────────────────────────────────────────────────────
// External-path attachment registry
// ──────────────────────────────────────────────────────────────────────
//
// Base64 / URL attachments live under the trusted attachment root and the
// endpoint can serve them by simply concatenating <root>/<sid>/<tid>/<file>.
//
// External-path attachments (Codex savedPath in `~/.codex/...` etc.) are
// referenced without copying. The endpoint needs a way to map
// `<sid>/<tid>/<file>` → real absolute path. We keep that mapping in a
// process-level Map; session-resume code re-registers entries by walking
// the persisted content blocks (see external-session.ts).
//
// Process restart loses the Map. Renderer code that fetches an old refPath
// after restart will 404 — the renderer must call a re-register hook (or
// the sidecar runs replay) before fetching. In practice external-session
// re-registers during loadSessionForAttach, so the gap window is narrow.

const externalPathRegistry = new Map<string, string>();

function regKey(sessionId: string, turnId: string, filename: string): string {
  return `${sessionId}/${turnId}/${filename}`;
}

/** Decode a filename segment from a URL component (assumes the caller already URL-decoded). */
function normalizeRegistrationFilename(filename: string): string {
  // Strip directory components first, then scrub control characters.
  const base = path.basename(filename);
  let out = '';
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || ch === '/' || ch === '\\') out += '_';
    else out += ch;
  }
  return out;
}

/** Register an external-path attachment so the endpoint can resolve it. */
export function registerExternalAttachment(
  sessionId: string,
  turnId: string,
  filename: string,
  realPath: string,
): void {
  externalPathRegistry.set(
    regKey(sanitizeSessionTurnSegment(sessionId), sanitizeSessionTurnSegment(turnId), normalizeRegistrationFilename(filename)),
    realPath,
  );
}

/** Look up a previously-registered external attachment. */
export function lookupExternalAttachment(
  sessionId: string,
  turnId: string,
  filename: string,
): string | undefined {
  return externalPathRegistry.get(
    regKey(sanitizeSessionTurnSegment(sessionId), sanitizeSessionTurnSegment(turnId), normalizeRegistrationFilename(filename)),
  );
}

/** Walk a persisted ContentBlock[] and register any external-path attachments
 *  found. Used by external-session loadSession path after resume. */
export function rebuildAttachmentRegistryFromBlocks(
  sessionId: string,
  blocks: ReadonlyArray<{ tool?: { id?: string; attachments?: ToolAttachment[] } | undefined; type?: string } | undefined>,
  fallbackTurnId: string,
): void {
  const attachRoot = getToolAttachmentRoot();
  for (const block of blocks) {
    if (!block || block.type !== 'tool_use') continue;
    const attachments = block.tool?.attachments;
    if (!attachments) continue;
    for (const a of attachments) {
      if (!a.savedPath || !a.refPath) continue;
      // Trusted-root attachments resolve by path concat, no need to register.
      if (a.savedPath.startsWith(attachRoot)) continue;
      // refPath = /api/attachment/tool/<sid>/<tid>/<filename>; pull filename.
      const lastSlash = a.refPath.lastIndexOf('/');
      if (lastSlash < 0) continue;
      const filename = decodeURIComponent(a.refPath.slice(lastSlash + 1));
      // turnId is also encoded in refPath, but we don't always parse it here;
      // caller passes `fallbackTurnId` so each block gets a unique key. In
      // practice the refPath embeds the right turnId — we extract:
      const refSegs = a.refPath.split('/').filter(Boolean);
      // ['api','attachment','tool',<sid>,<tid>,<file>]
      const tidFromPath = refSegs.length >= 6 ? decodeURIComponent(refSegs[4]) : fallbackTurnId;
      registerExternalAttachment(sessionId, tidFromPath, filename, a.savedPath);
    }
  }
}
