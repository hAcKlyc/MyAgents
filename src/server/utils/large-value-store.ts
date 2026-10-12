import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * Large Value Store — Pattern 2 (v0.2.0 structural refactors).
 *
 * Goal: keep large payloads (tool results, file previews, binary blobs) OUT of
 * the SSE / IPC JSON channel. When a value exceeds `inlineMaxBytes`, spill it
 * to disk under `~/.myagents/refs/<id>` and return a `LargeValueRef` placeholder
 * carrying just a `preview` (head N bytes) plus metadata. Consumers fetch the
 * full body via the sidecar's `GET /refs/:id` endpoint over its existing port.
 *
 * Lifecycle:
 *   - Each ref has a TTL (default 1h) and a `sessionId` tag.
 *   - `clearExpiredRefs()` runs periodically (60s) to evict TTL-expired entries.
 *   - `clearSessionRefs(sessionId)` is called on session-end / reset to release
 *     refs owned by that session early.
 *
 * On-disk layout (under `~/.myagents/refs/`):
 *   <id>            — the actual bytes (Uint8Array | utf-8 text)
 *   <id>.meta.json  — `{ id, sizeBytes, mimetype, preview, expiresAt, sessionId? }`
 *
 * Concurrency: writers claim `<id>.part` exclusively, then expose body/meta
 * through no-clobber same-directory hard links. No global ref lock is needed.
 */

import { promises as fsp } from "fs";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

/**
 * Reference placeholder for a large value. Replaces inline bytes in SSE / IPC
 * payloads — the consumer fetches the full body via `GET /refs/:id` when (and
 * only if) it actually needs it.
 *
 * Stable shape — clients (renderer, Rust proxy) discriminate on `kind === 'ref'`.
 */
import type { LargeValueRef } from '../../shared/types/large-value';
export type { LargeValueRef } from '../../shared/types/large-value';

interface RefMeta extends LargeValueRef {
  /** Optional session tag for `clearSessionRefs`. Empty string = unscoped. */
  sessionId?: string;
}

export interface MaybeSpillOptions {
  /** Default 256 KiB. Values at-or-below this are returned inline. */
  inlineMaxBytes?: number;
  /** Default 8 KiB. Head bytes captured into `LargeValueRef.preview`. */
  previewBytes?: number;
  /** Mimetype tag for the payload (e.g. `text/plain`, `application/json`, `image/png`). */
  mimetype: string;
  /** Default 1h. TTL for the ref before automatic GC. */
  ttlMs?: number;
  /** Optional session tag — `clearSessionRefs(sessionId)` evicts refs by this tag. */
  sessionId?: string;
}

const DEFAULT_INLINE_MAX_BYTES = 256 * 1024; // 256 KiB
const DEFAULT_PREVIEW_BYTES = 8 * 1024; // 8 KiB
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const REF_COMMIT_MAX_ATTEMPTS = 8;

/** New writers emit 32 hex; readers keep the legacy 8–32 window. */
const REF_ID_RE = /^[a-f0-9]{8,32}$/;
const BODY_PART_RE = /^[a-f0-9]{8,32}\.part$/;
const META_PART_RE = /^[a-f0-9]{8,32}\.meta\.json\.part$/;

/**
 * Root directory for spilled ref bodies. Created lazily on first spill so
 * unit tests / fresh installs don't see an empty unused directory.
 *
 * Override via `MYAGENTS_REFS_DIR` (used by tests to isolate the on-disk
 * surface from the shared user dir).
 */
function getRefsDir(): string {
  const override = process.env.MYAGENTS_REFS_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), APP_DATA_DIR_NAME, "refs");
}

function ensureRefsDir(): string {
  const dir = getRefsDir();
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort; subsequent writeFile will surface a real error */
    }
  }
  return dir;
}

function newRefId(): string {
  return randomUUID().replaceAll("-", "");
}

function isTextMimetype(mimetype: string): boolean {
  const lower = mimetype.toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower.includes("json") ||
    lower.includes("xml") ||
    lower.includes("javascript") ||
    lower.includes("yaml") ||
    lower.includes("csv") ||
    lower.includes("html")
  );
}

function buildPreview(
  value: string | Uint8Array,
  mimetype: string,
  previewBytes: number,
): string {
  if (typeof value === "string") {
    if (value.length <= previewBytes) return value;
    return value.slice(0, previewBytes);
  }
  // Uint8Array path.
  const head = value.subarray(0, previewBytes);
  if (isTextMimetype(mimetype)) {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(head);
    } catch {
      // Fall through to base64.
    }
  }
  // Binary preview — base64 of head bytes. Renderers can show it as a thumbnail
  // or simply as a "head" indicator in tooling.
  return Buffer.from(head).toString("base64");
}

function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.meta.json`);
}

function bodyPath(dir: string, id: string): string {
  return join(dir, id);
}

function bodyPartPath(dir: string, id: string): string {
  return join(dir, `${id}.part`);
}

function metaPartPath(dir: string, id: string): string {
  return join(dir, `${id}.meta.json.part`);
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
      return false;
    throw error;
  }
}

async function removeOwned(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map((path) => fsp.rm(path, { force: true }).catch(() => undefined)),
  );
}

/**
 * Commit one ref without ever truncating an existing namespace entry.
 *
 * `.part` is the cross-process claim. Body/meta become visible through
 * same-directory hard links, which are atomic and fail when the target exists;
 * readers continue to gate on the final meta name.
 */
async function commitRef(
  dir: string,
  value: string | Uint8Array,
  buildMeta: (id: string) => RefMeta,
): Promise<RefMeta> {
  for (let attempt = 0; attempt < REF_COMMIT_MAX_ATTEMPTS; attempt += 1) {
    const id = newRefId();
    const body = bodyPath(dir, id);
    const bodyPart = bodyPartPath(dir, id);
    const meta = metaPath(dir, id);
    const metaPart = metaPartPath(dir, id);
    const owned: string[] = [];
    let bodyHandle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    let metaHandle: Awaited<ReturnType<typeof fsp.open>> | undefined;

    try {
      bodyHandle = await fsp.open(bodyPart, "wx");
      owned.push(bodyPart);

      // The exclusive part claims this id against upgraded writers. Reject
      // historical body/meta/temp residue before writing any payload bytes.
      if (
        (await pathExists(body)) ||
        (await pathExists(meta)) ||
        (await pathExists(metaPart))
      ) {
        await bodyHandle.close();
        bodyHandle = undefined;
        await removeOwned(owned);
        continue;
      }

      if (typeof value === "string") {
        await bodyHandle.writeFile(value, "utf-8");
      } else {
        await bodyHandle.writeFile(value);
      }
      await bodyHandle.datasync();
      await bodyHandle.close();
      bodyHandle = undefined;

      await fsp.link(bodyPart, body);
      owned.push(body);

      const metadata = buildMeta(id);
      metaHandle = await fsp.open(metaPart, "wx");
      owned.push(metaPart);
      await metaHandle.writeFile(JSON.stringify(metadata), "utf-8");
      await metaHandle.datasync();
      await metaHandle.close();
      metaHandle = undefined;

      await fsp.link(metaPart, meta);
      owned.push(meta);

      // The final pair is committed. Leftover hard-link aliases are harmless
      // and the existing stale-part GC will remove them if unlink is blocked.
      await removeOwned([bodyPart, metaPart]);
      return metadata;
    } catch (error) {
      await bodyHandle?.close().catch(() => undefined);
      await metaHandle?.close().catch(() => undefined);
      await removeOwned(owned.reverse());
      if (isAlreadyExists(error)) continue;
      throw error;
    }
  }

  throw new Error(
    `large-value-store: ref commit collided ${REF_COMMIT_MAX_ATTEMPTS} times`,
  );
}

/**
 * Spill if `value` is larger than `inlineMaxBytes`, otherwise return inline.
 *
 * Returns `{ inline }` for small values (caller passes through unchanged) or a
 * `LargeValueRef` for large values (caller embeds `{kind:'ref', id, ...}` into
 * its outgoing SSE / tool result).
 */
export async function maybeSpill(
  value: string | Uint8Array,
  opts: MaybeSpillOptions,
): Promise<{ inline: string | Uint8Array } | LargeValueRef> {
  const inlineMaxBytes = opts.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  const previewBytes = opts.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const sizeBytes =
    typeof value === "string"
      ? Buffer.byteLength(value, "utf-8")
      : value.byteLength;

  if (sizeBytes <= inlineMaxBytes) {
    return { inline: value };
  }

  const dir = ensureRefsDir();
  const expiresAt = Date.now() + ttlMs;
  const preview = buildPreview(value, opts.mimetype, previewBytes);

  try {
    return await commitRef(dir, value, (id) => {
      const ref: RefMeta = {
        kind: "ref",
        id,
        sizeBytes,
        mimetype: opts.mimetype,
        preview,
        expiresAt,
      };
      if (opts.sessionId) ref.sessionId = opts.sessionId;
      return ref;
    });
  } catch (err) {
    // Pattern 2 contract: oversize values MUST NOT travel inline through
    // SSE / IPC. The previous `return { inline: value }` fallback defeated
    // the entire 256KB protection — a multi-MB tool result on a full disk
    // would silently flood the renderer queue, OOM the IPC bridge, or
    // wedge a slow client. Fail closed: surface the spill failure so the
    // caller's try/catch turns it into a tool-error instead.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[refs] spill failed sizeBytes=${sizeBytes}: ${reason}`);
    throw new Error(
      `large-value-store: failed to spill ${sizeBytes} bytes: ${reason}`,
    );
  }
}

/**
 * `expiresAt` validity check — rejects 0/NaN/non-number values and treats
 * past timestamps as expired. The legacy `expiresAt && expiresAt < Date.now()`
 * check accepted `0` as a "non-expiring" sentinel (because `0` is falsy),
 * which corrupted meta could exploit to keep refs alive forever.
 */
function isExpired(expiresAt: unknown): boolean {
  if (typeof expiresAt !== "number") return true; // corrupt → treat as expired
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return expiresAt < Date.now();
}

async function readCommittedMeta(
  dir: string,
  id: string,
): Promise<RefMeta | null> {
  if (!REF_ID_RE.test(id)) return null;
  let meta: RefMeta;
  try {
    meta = JSON.parse(
      await fsp.readFile(metaPath(dir, id), "utf-8"),
    ) as RefMeta;
  } catch {
    return null;
  }
  if (isExpired(meta.expiresAt)) {
    void deleteRef(dir, id);
    return null;
  }
  if (
    meta.kind !== "ref" ||
    meta.id !== id ||
    !Number.isSafeInteger(meta.sizeBytes) ||
    meta.sizeBytes < 0 ||
    typeof meta.mimetype !== "string"
  )
    return null;
  try {
    const body = await fsp.stat(bodyPath(dir, id));
    if (!body.isFile() || body.size !== meta.sizeBytes) return null;
  } catch {
    return null;
  }
  return meta;
}

/**
 * Fetch a previously-spilled ref. Returns `null` if the ref doesn't exist or
 * has expired (TTL).
 *
 * The body is loaded into memory — this matches what the consumer would have
 * seen pre-spill. For very large bodies, prefer streaming via the HTTP route.
 */
export async function fetchRef(
  id: string,
): Promise<{ data: Uint8Array; mimetype: string } | null> {
  const dir = getRefsDir();
  const meta = await readCommittedMeta(dir, id);
  if (!meta) return null;
  try {
    const body = await fsp.readFile(bodyPath(dir, id));
    if (body.byteLength !== meta.sizeBytes) return null;
    return { data: body, mimetype: meta.mimetype };
  } catch {
    return null;
  }
}

/**
 * Streaming-friendly body path lookup. Used by the HTTP `/refs/:id` route to
 * pipe the file directly into the response without loading it into memory.
 *
 * Returns `null` if missing or expired (TTL).
 */
export async function getRefStreamPath(
  id: string,
): Promise<{ path: string; mimetype: string; sizeBytes: number } | null> {
  const dir = getRefsDir();
  const meta = await readCommittedMeta(dir, id);
  if (!meta) return null;
  return {
    path: bodyPath(dir, id),
    mimetype: meta.mimetype,
    sizeBytes: meta.sizeBytes,
  };
}

async function deleteRef(dir: string, id: string): Promise<void> {
  await fsp.rm(bodyPath(dir, id), { force: true }).catch(() => undefined);
  await fsp.rm(metaPath(dir, id), { force: true }).catch(() => undefined);
}

/**
 * GC entry point. Iterates all refs and removes those whose `expiresAt` is in
 * the past. Cheap enough to run every 60s; failures are swallowed.
 */
export async function clearExpiredRefs(): Promise<void> {
  const dir = getRefsDir();
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const metaNames = new Set<string>();
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".meta.json"))
      .map(async (name) => {
        metaNames.add(name);
        const id = name.slice(0, -".meta.json".length);
        try {
          const raw = await fsp.readFile(join(dir, name), "utf-8");
          const meta = JSON.parse(raw) as RefMeta;
          if (isExpired(meta.expiresAt)) {
            await deleteRef(dir, id);
          }
        } catch {
          // Corrupt meta — drop it.
          await deleteRef(dir, id);
        }
      }),
  );

  // Sweep stale body-without-meta and commit temp files. Young files survive
  // because another Sidecar may currently own the exclusive `.part` claim.
  await Promise.all(
    entries
      .filter((name) => !name.endsWith(".meta.json"))
      .map(async (name) => {
        const isBodyOrphan =
          REF_ID_RE.test(name) && !metaNames.has(`${name}.meta.json`);
        const isBodyPart = BODY_PART_RE.test(name);
        const isMetaPart = META_PART_RE.test(name);
        if (!isBodyOrphan && !isBodyPart && !isMetaPart) return;
        const fullPath = join(dir, name);
        try {
          const st = await fsp.stat(fullPath);
          const ageMs = Date.now() - st.mtimeMs;
          if (ageMs > 60 * 60 * 1000) {
            await fsp.rm(fullPath, { force: true }).catch(() => undefined);
          }
        } catch {
          /* ignore */
        }
      }),
  );
}

/**
 * Evict refs tagged with `sessionId`. Called from session-end / reset so refs
 * created during a session don't outlive their consumer.
 */
/** Release a ref when its existing interaction owner settles. */
export async function releaseLargeValueRef(id: string): Promise<void> {
  if (!REF_ID_RE.test(id)) throw new Error('Invalid large-value reference id');
  await deleteRef(getRefsDir(), id);
}

export async function clearSessionRefs(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const dir = getRefsDir();
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name.endsWith(".meta.json"))
      .map(async (name) => {
        const id = name.slice(0, -".meta.json".length);
        try {
          const raw = await fsp.readFile(join(dir, name), "utf-8");
          const meta = JSON.parse(raw) as RefMeta;
          if (meta.sessionId === sessionId) {
            await deleteRef(dir, id);
          }
        } catch {
          /* ignore */
        }
      }),
  );
}

/**
 * Kick off the periodic GC. Idempotent — safe to call multiple times; the
 * timer is unref'd so it doesn't keep the event loop alive.
 *
 * Returns a stop handle for tests that want to release the timer.
 */
let gcTimer: ReturnType<typeof setInterval> | undefined;
export function startRefsGc(intervalMs = 60_000): () => void {
  if (gcTimer) return () => stopRefsGc();
  gcTimer = setInterval(() => {
    void clearExpiredRefs();
  }, intervalMs);
  gcTimer.unref?.();
  return () => stopRefsGc();
}

export function stopRefsGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = undefined;
  }
}
