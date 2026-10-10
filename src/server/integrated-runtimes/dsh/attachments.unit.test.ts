import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DshAttachmentRegistry } from './attachments';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const request = {
  attachmentId: `sha256:${sha256}`,
  expectedMimeType: 'image/png',
  expectedSizeBytes: bytes.length,
  expectedSha256: sha256,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachment-lease-'));
  roots.push(root);
  const registry = new DshAttachmentRegistry(root);
  await registry.initialize();
  return { root, registry };
}

it('publishes a complete extension snapshot larger than a protocol frame as immutable JSON', async () => {
  const { registry } = await fixture();
  const snapshot = { resources: [{ content: '中文\\\n'.repeat(200_000) }] };
  const reference = await registry.publishJson(snapshot);
  expect(reference.sizeBytes).toBeGreaterThan(1_048_576);
  expect(reference.mimeType).toBe('application/json');
  expect(Object.keys(reference).sort()).toEqual(['attachmentId', 'mimeType', 'sha256', 'sizeBytes']);
  expect(await registry.readJson(reference)).toEqual(snapshot);
});

describe('DSH attachment read-only leases', () => {
  it.each(['Runtime tool', 'Host tool', 'user image'] as const)('seals %s bytes before Runtime consumption', async source => {
    const { root, registry } = await fixture();
    if (source === 'Runtime tool') {
      const stagingPath = join(root, 'staged.png');
      await writeFile(stagingPath, bytes, { mode: 0o600 });
      await registry.put({ stagingPath, mimeType: 'image/png', sizeBytes: bytes.length, sha256 });
      if (process.platform !== 'win32') expect((await stat(stagingPath)).mode & 0o200).toBe(0o200);
    } else if (source === 'Host tool') {
      await registry.publishDataUrl(`data:image/png;base64,${bytes.toString('base64')}`);
    } else {
      await registry.registerImages([{ name: 'pixel.png', mimeType: 'image/png', data: bytes.toString('base64') }]);
    }
    const lease = await registry.acquire(request);
    const path = lease.readOnlyPath as string;
    const sealed = await stat(path);
    expect(await readFile(path)).toEqual(bytes);
    if (process.platform !== 'win32') expect(sealed.mode & 0o222).toBe(0);
    const second = await registry.acquire(request);
    // A concurrent consumer must not change the first lease's file identity.
    expect((await stat(path)).ctimeMs).toBe(sealed.ctimeMs);
    registry.release({ leaseId: second.leaseId });
    registry.release({ leaseId: lease.leaseId });
    registry.close();
  });

  it('seals a verified object from an earlier Host before returning its first lease', async () => {
    const { root, registry } = await fixture();
    const path = join(root, 'objects', sha256);
    await writeFile(path, bytes, { mode: 0o600 });
    const lease = await registry.acquire(request);
    expect(await readFile(lease.readOnlyPath as string)).toEqual(bytes);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o222).toBe(0);
    registry.release({ leaseId: lease.leaseId });
    registry.close();
  });

  it('rejects corrupted objects before granting a lease or changing permissions', async () => {
    const { root, registry } = await fixture();
    const path = join(root, 'objects', sha256);
    await writeFile(path, Buffer.alloc(bytes.length), { mode: 0o600 });
    await expect(registry.acquire(request)).rejects.toThrow('acquire postcondition failed');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o200).toBe(0o200);
    registry.close();
  });
});
