import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionMessage } from '../types/session';
import { fromStoredTranscriptMessage, toStoredTranscriptMessage, type TranscriptObject } from '../../shared/sessionTranscript';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import { MAX_TOOL_ATTACHMENT_BYTES } from '../../shared/types/tool-attachment';
import { getToolAttachmentRoot, validateExternalReadPathNode } from '../utils/path-safety';
import { lookupExternalAttachment, isAllowedExternalAttachmentPrefix } from '../runtimes/tool-attachments';
import { syncTranscriptDirectory } from './file';

/** Fork-owned copies are prepared before the target history is published. */
export async function copyForkAttachments(messages: readonly SessionMessage[], targetId: string): Promise<SessionMessage[]> {
  const userRoot = path.join(homedir(), APP_DATA_DIR_NAME, 'attachments');
  const toolRoot = getToolAttachmentRoot();
  const copy = async (source: string, destination: string, root: string, maxBytes?: number) => {
    const checked = validateExternalReadPathNode(source, { canonicalizeSymlinks: true });
    if (!checked.ok) throw new Error('Fork attachment path is unavailable');
    const original = await open(checked.canonical, 'r');
    try {
      const stat = await original.stat();
      if (!stat.isFile() || (maxBytes !== undefined && stat.size > maxBytes)) throw new Error('Fork attachment is unavailable');
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(checked.canonical, destination, constants.COPYFILE_EXCL);
      const saved = await open(destination, 'r+');
      try { await saved.sync(); } finally { await saved.close(); }
      for (let dir = path.dirname(destination);; dir = path.dirname(dir)) {
        await syncTranscriptDirectory(dir);
        if (dir === root) break;
      }
    } finally { await original.close(); }
  };
  const cloneTool = async (tool: TranscriptObject): Promise<void> => {
    if (Array.isArray(tool.attachments)) {
      const attachments: TranscriptObject[] = [];
      for (const value of tool.attachments) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid fork attachment');
        const attachment = value as unknown as ToolAttachment;
        if (attachment.refPath.startsWith('error://')) { attachments.push(value); continue; }
        if (attachment.pendingId && !attachment.refPath) throw new Error('附件仍在保存，请稍后再创建分支');
        const segments = attachment.refPath.split('/').filter(Boolean).map(decodeURIComponent);
        const [api, surface, kind, sid, tid, filename] = segments;
        if (segments.length !== 6 || api !== 'api' || surface !== 'attachment' || kind !== 'tool'
          || [sid, tid, filename].some(part => !part || part === '.' || part === '..' || /[/\\]/u.test(part))) throw new Error('Invalid fork attachment reference');
        const trusted = path.join(toolRoot, sid, tid, filename);
        const source = lookupExternalAttachment(sid, tid, filename) ?? attachment.savedPath ?? trusted;
        const checkedSource = validateExternalReadPathNode(source, { canonicalizeSymlinks: true });
        if (!checkedSource.ok || !isAllowedExternalAttachmentPrefix(checkedSource.canonical)) throw new Error('Fork attachment path is unavailable');
        // Reuse the endpoint's persisted path authority. A path is accepted
        // only for an attachment actually referenced by this source snapshot.
        const targetFilename = randomUUID() + path.extname(filename);
        const destination = path.join(toolRoot, targetId, 'fork', targetFilename);
        await copy(source, destination, toolRoot, MAX_TOOL_ATTACHMENT_BYTES);
        const { pendingId: _pending, ...rest } = attachment;
        attachments.push({ ...rest, savedPath: destination,
          refPath: `/api/attachment/tool/${targetId}/fork/${targetFilename}` } as unknown as TranscriptObject);
      }
      tool.attachments = attachments;
    }
    if (Array.isArray(tool.subagentCalls)) for (const call of tool.subagentCalls) {
      if (call && typeof call === 'object' && !Array.isArray(call)) await cloneTool(call);
    }
  };
  const result: SessionMessage[] = [];
  for (const row of messages) {
    const message = fromStoredTranscriptMessage(structuredClone(row));
    if (message.attachments) for (const attachment of message.attachments) {
      const source = path.resolve(userRoot, attachment.path);
      if (!source.startsWith(userRoot + path.sep)) throw new Error('Invalid user attachment reference');
      const filename = randomUUID() + path.extname(attachment.path);
      await copy(source, path.join(userRoot, targetId, filename), userRoot);
      attachment.path = `${targetId}/${filename}`;
    }
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (block.tool && typeof block.tool === 'object' && !Array.isArray(block.tool)) await cloneTool(block.tool);
    }
    result.push(toStoredTranscriptMessage(message));
  }
  return result;
}

/** Only a fresh, unpublished fork transaction may remove these target roots. */
export async function discardForkAttachments(targetId: string): Promise<void> {
  for (const root of [path.join(homedir(), APP_DATA_DIR_NAME, 'attachments'), getToolAttachmentRoot()]) {
    await rm(path.join(root, targetId), { recursive: true, force: true });
  }
}
