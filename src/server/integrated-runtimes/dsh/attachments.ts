import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { ResolvedImagePayload } from '../../runtimes/types';
import type { DshRpcObject, MethodParams } from './protocol-types';

type StoredAttachment = Readonly<{
  attachmentId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  path: string;
}>;

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function text(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${description} is invalid`);
  return value;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export class DshAttachmentRegistry {
  private readonly leases = new Map<string, string>();
  private rootValue: string | undefined;

  constructor(private readonly requestedRoot: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.requestedRoot, 'objects'), { recursive: true, mode: 0o700 });
    this.rootValue = await realpath(this.requestedRoot);
  }

  private get root(): string {
    if (!this.rootValue) throw new Error('DSH attachment registry is not initialized');
    return this.rootValue;
  }

  private objectPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('DSH attachment digest is invalid');
    return join(this.root, 'objects', sha256);
  }

  private async storeBytes(bytes: Uint8Array, mimeType: string): Promise<StoredAttachment> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = this.objectPath(sha256);
    try {
      await access(path, fsConstants.F_OK);
    } catch {
      await writeFile(path, bytes, { mode: 0o400, flag: 'wx' }).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
    return {
      attachmentId: `sha256:${sha256}`,
      mimeType,
      sizeBytes: bytes.byteLength,
      sha256,
      path,
    };
  }

  async registerImages(images: readonly ResolvedImagePayload[] | undefined): Promise<Extract<MethodParams<'turn/start'>['input']['parts'][number], { kind: 'image_ref' }>[]> {
    if (!images?.length) return [];
    const parts: Extract<MethodParams<'turn/start'>['input']['parts'][number], { kind: 'image_ref' }>[] = [];
    for (const image of images) {
      const bytes = Buffer.from(image.data, 'base64');
      if (bytes.byteLength < 1 || bytes.byteLength > 5 * 1_024 * 1_024) {
        throw new Error('DSH image attachment size is outside the protocol bound');
      }
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType)) {
        throw new Error(`DSH does not support image type ${image.mimeType}`);
      }
      const stored = await this.storeBytes(bytes, image.mimeType);
      parts.push({
        kind: 'image_ref',
        attachmentId: stored.attachmentId,
        name: image.name,
        mimeType: image.mimeType as Extract<MethodParams<'turn/start'>['input']['parts'][number], { kind: 'image_ref' }>['mimeType'],
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
      });
    }
    return parts;
  }

  async publishDataUrl(dataUrl: string): Promise<DshRpcObject> {
    const match = /^data:([^;,]{1,256});base64,([A-Za-z0-9+/]*={0,2})$/u.exec(dataUrl);
    if (!match) throw new Error('DSH Host tool attachment data URL is invalid');
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.byteLength < 1 || bytes.byteLength > 20 * 1_024 * 1_024) {
      throw new Error('DSH Host tool attachment exceeds its byte bound');
    }
    const stored = await this.storeBytes(bytes, match[1]!);
    return {
      attachmentId: stored.attachmentId,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    };
  }

  async publishJson(value: unknown): Promise<{
    attachmentId: string; mimeType: 'application/json'; sizeBytes: number; sha256: string;
  }> {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (bytes.byteLength > 20 * 1_024 * 1_024) {
      throw new Error('DSH extension snapshot exceeds the 20 MB resource limit');
    }
    const stored = await this.storeBytes(bytes, 'application/json');
    return { attachmentId: stored.attachmentId, mimeType: 'application/json',
      sizeBytes: stored.sizeBytes, sha256: stored.sha256 };
  }

  async put(params: DshRpcObject): Promise<DshRpcObject> {
    const stagingPath = await realpath(text(params.stagingPath, 'DSH attachment staging path'));
    if (!inside(this.root, stagingPath)) throw new Error('DSH attachment staging path escaped its root');
    const details = await stat(stagingPath);
    const expectedSize = params.sizeBytes;
    const expectedSha = text(params.sha256, 'DSH attachment digest');
    if (!details.isFile() || details.size !== expectedSize || await sha256File(stagingPath) !== expectedSha) {
      throw new Error('DSH staged attachment differs from its declared identity');
    }
    const destination = this.objectPath(expectedSha);
    if (destination !== stagingPath) {
      await copyFile(stagingPath, destination, fsConstants.COPYFILE_EXCL).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
    // The Host owns immutable objects; Runtime consumers validate a read-only lease.
    if (((await stat(destination)).mode & 0o222) !== 0) await chmod(destination, 0o400);
    return {
      attachmentId: `sha256:${expectedSha}`,
      mimeType: text(params.mimeType, 'DSH attachment MIME type'),
      sizeBytes: details.size,
      sha256: expectedSha,
    };
  }

  async acquire(params: DshRpcObject): Promise<DshRpcObject> {
    const attachmentId = text(params.attachmentId, 'DSH attachment id');
    const match = /^sha256:([a-f0-9]{64})$/.exec(attachmentId);
    if (!match) throw new Error('DSH attachment id is not content addressed');
    const sha256 = match[1]!;
    const path = resolve(this.objectPath(sha256));
    if (!inside(this.root, path)) throw new Error('DSH attachment object escaped its root');
    const details = await stat(path);
    if (
      !details.isFile()
      || details.size !== params.expectedSizeBytes
      || sha256 !== params.expectedSha256
      || await sha256File(path) !== sha256
    ) {
      throw new Error('DSH attachment acquire postcondition failed');
    }
    // Also seal objects created by earlier Host versions before granting a lease.
    if ((details.mode & 0o222) !== 0) await chmod(path, 0o400);
    const leaseId = `lease-${randomUUID()}`;
    this.leases.set(leaseId, attachmentId);
    return {
      leaseId,
      readOnlyPath: path,
      mimeType: text(params.expectedMimeType, 'DSH expected attachment MIME type'),
      sizeBytes: details.size,
      sha256,
    };
  }

  async readJson(reference: { attachmentId: string; mimeType: string; sizeBytes: number; sha256: string }): Promise<unknown> {
    const lease = await this.acquire({ attachmentId: reference.attachmentId, expectedMimeType: reference.mimeType, expectedSizeBytes: reference.sizeBytes, expectedSha256: reference.sha256 });
    try { return JSON.parse(await readFile(lease.readOnlyPath as string, 'utf8')) as unknown; }
    finally { this.release({ leaseId: lease.leaseId }); }
  }

  release(params: DshRpcObject): DshRpcObject {
    const leaseId = text(params.leaseId, 'DSH attachment lease id');
    if (!this.leases.delete(leaseId)) throw new Error('DSH attachment lease is not active');
    return { ok: true };
  }

  close(): void {
    this.leases.clear();
  }
}
