/**
 * tool-result-attachments — PURE half of builtin tool-result media extraction
 * (#293, originally authored on stranded commit ee0273f0; re-landed for 0.2.33).
 *
 * Problem: builtin SDK tool results arrive as `tool_result.content[]` blocks.
 * Image-bearing blocks (MCP `ImageContent`, Anthropic image source blocks,
 * OpenAI `b64_json`, data URLs, plain URLs, file refs) were previously just
 * `JSON.stringify`-ed into the result text — so the image (a) never rendered
 * and (b) flooded session JSONL + SSE with megabytes of base64 (the hidden
 * half of #293; only Playwright was spared via the sentinel strip).
 *
 * This module turns raw tool-result content into:
 *   - `attachments`: extracted media sources for `saveToolAttachment(...)`
 *     (the IO half lives in runtimes/builtin-media-attachments.ts — base64 →
 *     trusted-root file, url → SSRF-guarded download, externalPath →
 *     allow-listed zero-copy reference);
 *   - `text`: the remaining human-readable text — what actually gets broadcast
 *     + persisted as `tool.result`. Image blocks are removed entirely; base64-
 *     ish payloads in UNRECOGNIZED structured blocks are redacted to
 *     `[N bytes omitted]`. (Plain string content and `text`-block bodies pass
 *     through verbatim — a server stuffing base64 into prose is a pathological
 *     shape outside this guard.) Images live on disk; session data only ever
 *     carries path references.
 *
 * PURE (no I/O, no module state) — unit-tested in isolation.
 */

import type { ToolAttachmentKind } from '../../shared/types/tool-attachment';
import type { AttachmentSource } from '../runtimes/tool-attachments';

export interface ExtractedToolResultAttachment {
  source: AttachmentSource;
  mimeType: string;
  kind: ToolAttachmentKind;
}

export interface ToolResultRenderParts {
  text: string;
  attachments: ExtractedToolResultAttachment[];
}

export interface NormalizedSdkToolUseResult {
  content: unknown;
  metadata: unknown;
  isMetadataEnvelope: boolean;
}

const DEFAULT_IMAGE_MIME = 'image/png';
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/is;

/**
 * Presentation policy (#293): which tools produce PROCESS media (the AI's
 * "eyes" — screenshots taken to drive the next step) vs ARTIFACT media (the
 * user's deliverable). Process media renders inside the folded tool row;
 * artifacts stay as always-visible in-flow cards (PRD 0.2.30).
 *
 * Matched on the builtin MCP tool-name convention `mcp__<server>__<tool>`.
 * The generic /screenshot/ test deliberately errs toward 'process': a
 * misclassified artifact lands inside the fold (still reachable, one click),
 * while the inverse — a 30-screenshot browse run flooding the conversation —
 * is the failure mode this distinction exists to prevent.
 */
// Keep legacy Cuse tool results and user-configured MCP screenshots folded.
const PROCESS_TOOL_PREFIXES = ['mcp__playwright__', 'mcp__computer-use__', 'mcp__cuse__'];

export function classifyToolAttachmentPresentation(
  toolName: string | undefined | null,
): 'artifact' | 'process' {
  if (!toolName) return 'artifact';
  if (PROCESS_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'process';
  if (/screenshot/i.test(toolName)) return 'process';
  return 'artifact';
}

/**
 * Honest trace for delivery paths that EXTRACT image blocks but cannot attach
 * them yet (subagent tool results — pipeline doc §10 residual): without this,
 * a subagent screenshot would vanish without a trace (pre-#293 it at least
 * showed up as garbage JSON).
 */
export function appendOmittedImageNote(text: string, imageCount: number): string {
  if (imageCount <= 0) return text;
  const note = `[${imageCount} image attachment(s) omitted]`;
  return text ? `${text}\n${note}` : note;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * SDK 0.3.232 wraps subagent MCP results that carry `_meta` as
 * `{ content, _meta }`. Normalize that transport envelope at the SDK ingress so
 * render/persistence keeps consuming the actual result content. Metadata stays
 * available for a future product-owned renderer without leaking into the basic
 * text representation today. Legacy bare values pass through unchanged.
 */
export function normalizeSdkToolUseResult(value: unknown): NormalizedSdkToolUseResult {
  if (
    isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, 'content')
    && Object.prototype.hasOwnProperty.call(value, '_meta')
  ) {
    return {
      content: value.content,
      metadata: value._meta,
      isMetadataEnvelope: true,
    };
  }
  return {
    content: value,
    metadata: undefined,
    isMetadataEnvelope: false,
  };
}

/** Project the two SDK result representations once, before main/subagent delivery.
 * Side data preserves structured Read/WebSearch results, but is not safe display
 * text: Read image/PDF results can carry the same bytes as content blocks.
 */
export function extractSdkToolResultRenderParts(content: unknown, toolUseResult: unknown): ToolResultRenderParts {
  const normalized = normalizeSdkToolUseResult(toolUseResult);
  const parts = extractToolResultRenderParts(normalized.isMetadataEnvelope ? normalized.content : content);
  return {
    ...parts,
    text: !normalized.isMetadataEnvelope && toolUseResult && typeof toolUseResult === 'object'
      ? safeStringifyToolResult(toolUseResult, true)
      : parts.text,
  };
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function readMimeType(record: Record<string, unknown>, fallback = DEFAULT_IMAGE_MIME): string {
  const explicit = readString(record, ['mimeType', 'mime_type', 'mediaType', 'media_type']);
  if (explicit) {
    return explicit;
  }
  const type = readString(record, ['type']);
  return type?.includes('/') ? type : fallback;
}

function sourceFromDataString(data: string, mimeType: string): { source: AttachmentSource; mimeType: string } {
  const match = DATA_URL_RE.exec(data);
  if (match) {
    return {
      source: { kind: 'base64', data: match[2] ?? '' },
      mimeType: match[1] || mimeType,
    };
  }
  return { source: { kind: 'base64', data }, mimeType };
}

function sourceFromUrl(url: string, mimeType: string): { source: AttachmentSource; mimeType: string } {
  const match = DATA_URL_RE.exec(url);
  if (match) {
    return {
      source: { kind: 'base64', data: match[2] ?? '' },
      mimeType: match[1] || mimeType,
    };
  }
  return { source: { kind: 'url', url }, mimeType };
}

/**
 * Recognize one image-bearing block in any of the shapes seen across MCP
 * servers / SDK providers. Returns null for non-image blocks.
 *
 * Security note: extraction only CLASSIFIES sources — every source is later
 * funneled through `saveToolAttachment`, whose three entries own the actual
 * trust decisions (trusted-root write for base64, positive allow-list +
 * symlink-canonicalized read for externalPath, SSRF-guarded https-only fetch
 * for url). Nothing extracted here bypasses that layer.
 */
function extractImageAttachment(block: Record<string, unknown>): ExtractedToolResultAttachment | null {
  const blockType = typeof block.type === 'string' ? block.type : undefined;
  if (blockType !== 'image' && blockType !== 'input_image' && blockType !== 'output_image') {
    return null;
  }

  const blockMime = readMimeType(block);
  const directData = readString(block, ['data', 'base64', 'b64_json', 'image_base64']);
  if (directData) {
    const { source, mimeType } = sourceFromDataString(directData, blockMime);
    return { source, mimeType, kind: 'image' };
  }

  const sourceBlock = block.source;
  if (isRecord(sourceBlock)) {
    const sourceMime = readMimeType(sourceBlock, blockMime);
    const sourceData = readString(sourceBlock, ['data', 'base64', 'b64_json']);
    if (sourceData) {
      const { source, mimeType } = sourceFromDataString(sourceData, sourceMime);
      return { source, mimeType, kind: 'image' };
    }
    const sourceUrl = readString(sourceBlock, ['url']);
    if (sourceUrl) {
      const { source, mimeType } = sourceFromUrl(sourceUrl, sourceMime);
      return { source, mimeType, kind: 'image' };
    }
  }

  const fileBlock = block.file;
  if (isRecord(fileBlock)) {
    const fileMime = readMimeType(fileBlock, blockMime);
    const fileData = readString(fileBlock, ['base64', 'data', 'b64_json']);
    if (fileData) {
      const { source, mimeType } = sourceFromDataString(fileData, fileMime);
      return { source, mimeType, kind: 'image' };
    }
    const filePath = readString(fileBlock, ['path', 'sourcePath', 'savedPath']);
    if (filePath) {
      return { source: { kind: 'externalPath', sourcePath: filePath }, mimeType: fileMime, kind: 'image' };
    }
  }

  const imageUrl = block.image_url;
  if (isRecord(imageUrl)) {
    const url = readString(imageUrl, ['url']);
    if (url) {
      const { source, mimeType } = sourceFromUrl(url, blockMime);
      return { source, mimeType, kind: 'image' };
    }
  }

  const url = readString(block, ['url']);
  if (url) {
    const { source, mimeType } = sourceFromUrl(url, blockMime);
    return { source, mimeType, kind: 'image' };
  }

  return null;
}

function isLikelyBase64Payload(value: string): boolean {
  return value.length > 256 && /^[a-zA-Z0-9+/=\r\n]+$/.test(value);
}

/**
 * JSON.stringify with base64-ish string values redacted to `[N bytes omitted]`.
 * Unknown blocks use conservative heuristics. SDK side data contains ordinary
 * Read/Bash/search prose, so only explicit media fields are redacted there:
 * `data:` YAML and long alphabetic file contents must survive unchanged.
 */
function safeStringifyToolResult(value: unknown, sdkSideData = false): string {
  try {
    return JSON.stringify(
      value,
      function (this: Record<string, unknown>, key, nestedValue) {
        if (typeof nestedValue !== 'string') {
          return nestedValue;
        }
        if (
          key === 'base64' ||
          key === 'b64_json' ||
          key === 'image_base64' ||
          (key === 'data' && (!sdkSideData
            || this.type === 'base64' || this.type === 'image' || this.type === 'audio')) ||
          (sdkSideData && key === 'stdout' && this.isImage === true) ||
          (!sdkSideData && (nestedValue.startsWith('data:') || isLikelyBase64Payload(nestedValue)))
        ) {
          return `[${nestedValue.length} bytes omitted]`;
        }
        return nestedValue;
      },
      sdkSideData ? undefined : 2,
    ) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * A standalone `data:<mime>;base64,...` image string is image BYTES wearing a
 * string costume — extract it like an image block so it never lands in
 * JSONL/SSE (#293 cross-review finding 2). Matches a string that is ONLY the
 * data URL (no surrounding prose) to avoid mangling legitimate text that
 * merely mentions one.
 */
function imageDataUrlString(value: string): ExtractedToolResultAttachment | null {
  const trimmed = value.trim();
  const match = DATA_URL_RE.exec(trimmed);
  if (!match) return null;
  const mime = match[1] || DEFAULT_IMAGE_MIME;
  if (!mime.startsWith('image/')) return null;
  return { source: { kind: 'base64', data: match[2] ?? '' }, mimeType: mime, kind: 'image' };
}

function textFromBlock(block: unknown): string | null {
  if (typeof block === 'string') {
    return block;
  }
  if (!isRecord(block)) {
    return block == null ? null : String(block);
  }
  if (block.type === 'text' && typeof block.text === 'string') {
    return block.text;
  }
  if (typeof block.text === 'string') {
    return block.text;
  }
  return null;
}

/**
 * Split raw tool-result content into render text + extracted image sources.
 *
 * - string content passes through untouched (zero-cost common path);
 * - arrays/objects are walked block-by-block: image blocks become attachment
 *   sources (removed from text), text blocks join the text, anything else is
 *   stringified with base64 redaction.
 */
export function extractToolResultRenderParts(content: unknown): ToolResultRenderParts {
  if (typeof content === 'string') {
    // A bare data-URL image string is bytes, not text — extract it so base64
    // never reaches JSONL/SSE (#293 cross-review finding 2). Other strings
    // (Bash/JSON/file output) pass through verbatim.
    const dataUrl = imageDataUrlString(content);
    return dataUrl
      ? { text: '', attachments: [dataUrl] }
      : { text: content, attachments: [] };
  }
  if (content === null || content === undefined) {
    return { text: '', attachments: [] };
  }

  const items = Array.isArray(content) ? content : [content];
  const textParts: string[] = [];
  const attachments: ExtractedToolResultAttachment[] = [];

  for (const item of items) {
    if (isRecord(item)) {
      const attachment = extractImageAttachment(item);
      if (attachment) {
        attachments.push(attachment);
        continue;
      }
    }

    const text = textFromBlock(item);
    if (text !== null) {
      // A text block whose body is ONLY a data-URL image is the same costume —
      // extract instead of passing the base64 through.
      const inlineImage = imageDataUrlString(text);
      if (inlineImage) {
        attachments.push(inlineImage);
        continue;
      }
      textParts.push(text);
      continue;
    }
    textParts.push(safeStringifyToolResult(item));
  }

  return {
    text: textParts
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n'),
    attachments,
  };
}
