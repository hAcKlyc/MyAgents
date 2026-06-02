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

const DEFAULT_IMAGE_MIME = 'image/png';
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/is;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function safeStringifyToolResult(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (key, nestedValue) => {
        if (typeof nestedValue !== 'string') {
          return nestedValue;
        }
        if (
          key === 'data' ||
          key === 'base64' ||
          key === 'b64_json' ||
          key === 'image_base64' ||
          nestedValue.startsWith('data:') ||
          isLikelyBase64Payload(nestedValue)
        ) {
          return `[${nestedValue.length} bytes omitted]`;
        }
        return nestedValue;
      },
      2,
    ) ?? '';
  } catch {
    return String(value);
  }
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

export function extractToolResultRenderParts(content: unknown): ToolResultRenderParts {
  if (typeof content === 'string') {
    return { text: content, attachments: [] };
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
