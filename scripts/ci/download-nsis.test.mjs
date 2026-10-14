import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadNsisArchive, verifyNsisArchive } from './download-nsis.mjs';

const valid = Buffer.from('isolated compiler archive fixture');
const expected = { size: valid.length, sha256: createHash('sha256').update(valid).digest('hex') };

test('archive verification rejects truncated and same-size corrupted responses', () => {
  assert.doesNotThrow(() => verifyNsisArchive(valid, expected));
  assert.throws(() => verifyNsisArchive(valid.subarray(1), expected), /size mismatch/);
  const corrupt = Buffer.from(valid);
  corrupt[0] ^= 1;
  assert.throws(() => verifyNsisArchive(corrupt, expected), /SHA-256 mismatch/);
});

test('failed download does not create or replace an existing compiler archive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'nsis-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'compiler.zip');
  const networkFailure = async () => { throw new Error('HTTP 406'); };
  await assert.rejects(downloadNsisArchive(path, { download: networkFailure }), /HTTP 406/);
  assert.equal(existsSync(path), false);
  writeFileSync(path, 'retained archive');
  await assert.rejects(downloadNsisArchive(path, { download: async () => valid }), /size mismatch/);
  assert.equal(readFileSync(path, 'utf8'), 'retained archive');
});
