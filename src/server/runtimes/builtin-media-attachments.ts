import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
/**
 * builtin-media-attachments — turn builtin in-process MCP media-tool output
 * (edge-tts audio / gemini-image image) into first-class `ToolAttachment[]`,
 * on the same pipeline as the Codex external runtime.
 *
 * PRD 0.2.30 (§3.1) + 0.2.31 cleanup + #293. Parsing of the tool result text
 * lives in the shared parser `@/shared/builtinMediaResult` (consumed by both
 * this server module and the renderer cards). This module owns the IO half:
 *  - `buildBuiltinMediaAttachments` — read a file-path media result (edge-tts /
 *    gemini-image) and save a trusted-root serving copy;
 *  - `saveExtractedToolResultAttachments` (#293) — write extracted image bytes
 *    into the per-tool workspace dir `<workspace>/myagents_files/<tool-name>/`
 *    (the user-visible `sourcePath`) + a trusted-root serving copy.
 *
 * Why base64-copy into the trusted root (not a zero-copy externalPath ref):
 *  - the attachment endpoint resolves trusted-root files by path concat, so
 *    sidecar restart needs no `rebuildAttachmentRegistryFromBlocks`;
 *  - self-contained + GC-aligned; sidesteps the external-path allow-list (which
 *    doesn't cover arbitrary workspaces).
 * The original generated path is preserved on the attachment as `sourcePath`
 * (shown in the tool card + targeted by the "open path" menu).
 *
 * Failure is per-file graceful (log + skip): the tool card still shows the path.
 *
 * Security: the source path comes from OUR builtin tool's output (not model-
 * controlled), but is still validated defensively — absolute, under a known
 * generated dir, `lstat` rejects symlink leaf, regular file, size-capped before
 * the read (so a pathological file never gets fully loaded + base64-expanded).
 */

import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { mimeToExt, saveToolAttachment } from './tool-attachments';
import { parseBuiltinMediaToolResult } from '../../shared/builtinMediaResult';
import { MAX_TOOL_ATTACHMENT_BYTES, type ToolAttachment } from '../../shared/types/tool-attachment';
import { ensureDirSync } from '../utils/fs-utils';
import { ensureGitignorePattern } from '../utils/gitignore';
import type { ExtractedToolResultAttachment } from '../utils/tool-result-attachments';

/** generated dir segment names (`~/.myagents/<name>` or `<ws>/myagents_files/<name>`). */
const GENERATED_DIR_NAMES = ['generated_audio', 'generated_images', 'generated'];

export interface BuiltinAttachmentCtxBase {
  sessionId: string;
  /** path-namespace turn segment; only needs to be unique — we use toolUseId. */
  toolUseId: string;
  /**
   * Active workspace dir (agentDir). When set, extracted images land in the
   * unified workspace location `<workspace>/myagents_files/<tool-name>/` —
   * the same `myagents_files/` convention edge-tts / gemini-image use, but
   * foldered per tool (user's request #293-followup) so a Playwright run's
   * screenshots sit under their own folder. Absent (IM/cron with no
   * workspace) → falls back to `~/.myagents/generated/<tool-name>/`.
   */
  workspace?: string;
}

/**
 * Folder name for a tool's generated files, under `myagents_files/`. Uses the
 * raw tool name (`mcp__playwright__browser_take_screenshot`) sanitized to
 * filesystem-safe chars so different tools self-organize into sibling folders.
 */
function toolDirName(toolName: string): string {
  const safe = toolName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return safe || 'tool';
}

/**
 * Resolve the per-tool generated dir and ensure it exists (+ gitignore the
 * workspace `myagents_files/` umbrella on first write, matching edge-tts /
 * gemini-image).
 */
function ensureToolGeneratedDir(toolName: string, workspace?: string): string {
  const dir = workspace
    ? path.join(workspace, 'myagents_files', toolDirName(toolName))
    : path.join(homedir(), APP_DATA_DIR_NAME, 'generated', toolDirName(toolName));
  ensureDirSync(dir);
  if (workspace) ensureGitignorePattern(workspace, 'myagents_files/');
  return dir;
}

/** Defensive: the path must sit under a known generated dir segment. */
function isUnderKnownGeneratedDir(absPath: string): boolean {
  const norm = path.normalize(absPath);
  return GENERATED_DIR_NAMES.some(name => norm.includes(`${path.sep}${name}${path.sep}`));
}

/**
 * Read builtin media files and save trusted-root copies as `ToolAttachment[]`.
 * Per-file failures are swallowed (log + skip); non-media tools return `[]`.
 */
export async function buildBuiltinMediaAttachments(
  toolName: string,
  contentStr: string,
  ctxBase: BuiltinAttachmentCtxBase,
): Promise<ToolAttachment[]> {
  const specs = parseBuiltinMediaToolResult(toolName, contentStr);
  if (specs.length === 0) return [];

  const out: ToolAttachment[] = [];
  for (const spec of specs) {
    try {
      if (!path.isAbsolute(spec.filePath)) {
        console.warn(`[builtin-media] non-absolute path, skip: ${spec.filePath}`);
        continue;
      }
      if (!isUnderKnownGeneratedDir(spec.filePath)) {
        console.warn(`[builtin-media] path not under a known generated dir, skip: ${spec.filePath}`);
        continue;
      }
      const st = await lstat(spec.filePath);
      if (st.isSymbolicLink() || !st.isFile()) {
        console.warn(`[builtin-media] not a regular file (symlink?), skip: ${spec.filePath}`);
        continue;
      }
      // Size gate BEFORE readFile: saveToolAttachment enforces the 25MB cap, but
      // only after the whole file is read + base64-expanded (~1.33x), peaking at
      // ~2.3x in memory. We already have `st` — reject up front.
      if (st.size > MAX_TOOL_ATTACHMENT_BYTES) {
        console.warn(`[builtin-media] file exceeds ${MAX_TOOL_ATTACHMENT_BYTES} bytes (${st.size}), skip: ${spec.filePath}`);
        continue;
      }
      const bytes = await readFile(spec.filePath);
      const attachment = await saveToolAttachment(
        { kind: 'base64', data: bytes.toString('base64') },
        {
          sessionId: ctxBase.sessionId,
          turnId: ctxBase.toolUseId,
          toolUseId: ctxBase.toolUseId,
          mimeType: spec.mimeType,
          kind: spec.kind,
          caption: spec.caption,
          producedBy: spec.producedBy,
        },
      );
      // Preserve the original generated path so the card + "open path" menu agree.
      out.push({ ...attachment, sourcePath: spec.filePath });
    } catch (err) {
      console.warn(
        `[builtin-media] failed to build attachment for ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}

/**
 * #293 — save image sources EXTRACTED from tool_result content blocks (the
 * generic MCP/SDK shapes: base64 ImageContent, data URLs, file refs, remote
 * urls) as first-class `ToolAttachment[]`.
 *
 * Counterpart of `buildBuiltinMediaAttachments` (which parses file PATHS out
 * of result TEXT for the two builtin generator tools); this one consumes the
 * pre-extracted block sources from `extractToolResultRenderParts`.
 *
 * Storage (#293-followup): a `base64` source — the dominant case for
 * screenshots / inline images — is written to the unified WORKSPACE location
 * `<workspace>/myagents_files/<tool-name>/` (its `sourcePath`, what the tool
 * card's "reveal / open" targets), then a trusted-root copy is taken for
 * restart-safe serving (its `savedPath`). This is exactly edge-tts /
 * gemini-image's "workspace original + trusted serving copy" shape, just
 * foldered per tool. `externalPath` (a file the tool already wrote) and `url`
 * (remote) keep their own locations via `saveToolAttachment`'s allow-listed /
 * SSRF-guarded paths.
 *
 * Per-item failures are swallowed (log + skip) — one bad block must not sink
 * the sibling images or the tool result itself.
 */
export async function saveExtractedToolResultAttachments(
  extracted: ExtractedToolResultAttachment[],
  toolName: string,
  ctxBase: BuiltinAttachmentCtxBase,
): Promise<ToolAttachment[]> {
  if (extracted.length === 0) return [];
  const out: ToolAttachment[] = [];
  for (const item of extracted) {
    try {
      const saveCtx = {
        sessionId: ctxBase.sessionId,
        turnId: ctxBase.toolUseId,
        toolUseId: ctxBase.toolUseId,
        mimeType: item.mimeType,
        kind: item.kind,
        producedBy: toolName,
      };

      if (item.source.kind === 'base64') {
        // Write the bytes into the per-tool workspace dir first (the unified,
        // user-visible location), then take the trusted-root serving copy.
        // Size-gate on the b64 STRING length BEFORE decoding (b64 length ≥
        // decoded bytes, so this never false-rejects) — a pathological image
        // must not get fully buffered just to be measured. Decode ONCE and
        // hand the bytes to saveToolAttachment for the serving copy
        // (cross-review 0.2.33, Codex + cc: gate-after-allocate + double
        // decode peaked at two ~25MB transient buffers).
        if (Math.floor((item.source.data.length * 3) / 4) > MAX_TOOL_ATTACHMENT_BYTES) {
          console.warn(`[builtin-media] extracted image exceeds ${MAX_TOOL_ATTACHMENT_BYTES} bytes (b64 length ${item.source.data.length}), skip: ${toolName}`);
          continue;
        }
        const bytes = Buffer.from(item.source.data, 'base64');
        if (bytes.byteLength > MAX_TOOL_ATTACHMENT_BYTES) {
          console.warn(`[builtin-media] extracted image exceeds ${MAX_TOOL_ATTACHMENT_BYTES} bytes (${bytes.byteLength}), skip: ${toolName}`);
          continue;
        }
        const dir = ensureToolGeneratedDir(toolName, ctxBase.workspace);
        const filename = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${mimeToExt(item.mimeType)}`;
        const workspaceFile = path.join(dir, filename);
        await writeFile(workspaceFile, bytes, { flag: 'wx' });
        const attachment = await saveToolAttachment(item.source, saveCtx, {
          decodedBase64Bytes: bytes,
        });
        out.push({ ...attachment, sourcePath: workspaceFile });
        continue;
      }

      // externalPath / url — saveToolAttachment owns the trust + location.
      out.push(await saveToolAttachment(item.source, saveCtx));
    } catch (err) {
      console.warn(
        `[builtin-media] failed to save extracted ${item.kind} from ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}
