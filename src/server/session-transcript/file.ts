import { randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, mkdir, rename, unlink, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setImmediate as yieldToRuntime } from 'node:timers/promises';
import {
  type TranscriptProjection,
} from '../../shared/sessionTranscript';
import {
  TranscriptDecoder,
  TRANSCRIPT_MAX_LINE_BYTES,
  encodeTranscriptBatch,
  type DecodedTranscript,
  type TranscriptBatch,
  type TranscriptHeader,
} from './codec';
import { transcriptBaselineOperations } from './operations';
import { TranscriptStorageError, type TranscriptCommitTarget, type TranscriptStorage } from './writer';

type FileCursor = TranscriptCommitTarget & { size: number; dev: number; ino: number };

export async function readTranscriptFile(filePath: string, sessionId: string): Promise<DecodedTranscript> {
  const decoder = new TranscriptDecoder(sessionId);
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  let fragments: string[] = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
    const text = chunk as string;
    let offset = 0;
    for (;;) {
      const end = text.indexOf('\n', offset);
      if (end < 0) break;
      try {
        let line = text.slice(offset, end);
        if (fragments.length) {
          fragments.push(line);
          line = fragments.join('');
          fragments = [];
          pendingBytes = 0;
        }
        if (!decoder.push(line)) return decoder.finish();
      } catch (error) {
        throw new TranscriptStorageError('invalid-history', error instanceof Error ? error.message : 'Invalid V2 transcript');
      }
      offset = end + 1;
    }
    if (offset < text.length) {
      const suffix = text.slice(offset);
      fragments.push(suffix);
      pendingBytes += Buffer.byteLength(suffix);
    }
    if (pendingBytes > TRANSCRIPT_MAX_LINE_BYTES) throw new TranscriptStorageError('invalid-history', 'V2 record exceeds size limit');
    await yieldToRuntime();
  }
  try { return decoder.finish(pendingBytes > 0); } catch (error) {
    throw new TranscriptStorageError('invalid-history', error instanceof Error ? error.message : 'Invalid V2 transcript');
  }
}

export interface TranscriptFileOptions {
  sessionId: string;
  filePath: string;
  generation: string;
  allowCreate: boolean;
  /** Issued only when the Session lifecycle adopts a cold, ownerless transcript. */
  recoverIncompleteTail?: boolean;
  withLock: <T>(run: () => Promise<T>) => Promise<T>;
  /** Birth publication is part of initial durability, never AI admission. */
  publishBirth?: (committed: TranscriptCommitTarget) => Promise<void>;
  /** A named rewind writes its existing recovery intent before publishing a candidate. */
  prepareReplacement?: (source: TranscriptCommitTarget, target: TranscriptCommitTarget) => Promise<void>;
}

async function writeAll(file: FileHandle, bytes: Buffer, offset: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(bytes, written, bytes.length - written, offset + written);
    if (result.bytesWritten <= 0) throw new Error('Transcript write made no progress');
    written += result.bytesWritten;
  }
}

async function readRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await file.read(bytes, read, length - read, start + read);
    if (result.bytesRead === 0) throw new Error('Transcript changed during read');
    read += result.bytesRead;
  }
  return bytes;
}

/** libuv opens Windows directories with BACKUP_SEMANTICS; flushing also requires write access. */
export async function syncTranscriptDirectory(path: string): Promise<void> {
  // Numeric O_WRONLY supplies write access without the create/truncate implied
  // by 'w'. A read-only Windows handle fails FlushFileBuffers with access denied.
  const directory = await open(path, process.platform === 'win32' ? constants.O_WRONLY : constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** JSON omits optional undefined object fields; those are not lost content. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => sameJsonValue(a[key], b[key]));
}

/** Physical writes are serialized by SessionStore's existing per-session lock. */
export class TranscriptFile implements TranscriptStorage {
  private cursor: FileCursor | null = null;
  private createdHeader: Buffer | null = null;
  private pendingReplacement: { expected: TranscriptCommitTarget; generation: string; revision: number; candidate: string; recoverEmptySource: boolean } | null = null;

  constructor(private readonly options: TranscriptFileOptions) {}

  async read(): Promise<DecodedTranscript> {
    return readTranscriptFile(this.options.filePath, this.options.sessionId);
  }

  private async openForAppend(): Promise<FileHandle> {
    try { return await open(this.options.filePath, 'r+'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !this.options.allowCreate) throw error;
    }
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const file = await open(this.options.filePath, 'wx+');
    const header: TranscriptHeader = {
      kind: 'session-transcript', version: 2, sessionId: this.options.sessionId,
      generation: this.options.generation, baseRevision: 0, baseline: false,
    };
    this.createdHeader = Buffer.from(JSON.stringify(header) + '\n');
    try {
      await writeAll(file, this.createdHeader, 0);
      await file.sync();
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async append(expected: TranscriptCommitTarget, batch: TranscriptBatch): Promise<void> {
    const line = Buffer.from(encodeTranscriptBatch(batch));
    await this.options.withLock(async () => {
      const file = await this.openForAppend();
      try {
        let info = await file.stat();
        // Only this instance's failed, exclusive header creation can be repaired.
        if (this.createdHeader && info.size < this.createdHeader.length) {
          const prefix = await readRange(file, 0, info.size);
          if (!prefix.equals(this.createdHeader.subarray(0, prefix.length))) {
            throw new TranscriptStorageError('invalid-history', 'V2 initialization identity changed');
          }
          await writeAll(file, this.createdHeader, 0);
          await file.sync();
          info = await file.stat();
        }
        const cached = this.cursor;
        let offset: number;
        let alreadyWritten = false;
        if (cached && cached.generation === expected.generation && cached.revision === expected.revision
          && cached.dev === info.dev && cached.ino === info.ino && info.size >= cached.size) {
          offset = cached.size;
          const tailBytes = info.size - offset;
          if (tailBytes > line.length) throw new TranscriptStorageError('invalid-history', 'Unexpected writer advanced transcript');
          const tail = await readRange(file, offset, tailBytes);
          if (!tail.equals(line.subarray(0, tailBytes))) {
            throw new TranscriptStorageError('invalid-history', 'Transcript tail does not belong to pending batch');
          }
          alreadyWritten = tailBytes === line.length;
          if (!alreadyWritten && tailBytes > 0) await file.truncate(offset);
        } else {
          const decoded = await this.read();
          if (decoded.header.generation !== expected.generation || decoded.tail === 'invalid') {
            throw new TranscriptStorageError('invalid-history', 'V2 transcript generation or prefix changed');
          }
          alreadyWritten = decoded.revision === batch.revision && decoded.lastBatchId === batch.id
            && decoded.tail === 'clean' && info.size >= line.length
            && (await readRange(file, info.size - line.length, line.length)).equals(line);
          if (!alreadyWritten && decoded.revision !== expected.revision) {
            throw new TranscriptStorageError('invalid-history', 'V2 transcript revision changed');
          }
          offset = alreadyWritten ? info.size - line.length : decoded.validBytes;
          if (!alreadyWritten && info.size > offset) {
            const tail = await readRange(file, offset, info.size - offset);
            const recoverColdTail = this.options.recoverIncompleteTail && decoded.tail === 'incomplete';
            if (!recoverColdTail && !tail.equals(line.subarray(0, tail.length))) {
              throw new TranscriptStorageError('invalid-history', 'Unowned V2 partial tail');
            }
            await file.truncate(offset);
          }
          // Keep the known committed prefix even if this append/sync fails.
          this.cursor = { ...expected, size: offset, dev: info.dev, ino: info.ino };
        }
        if (!alreadyWritten) await writeAll(file, line, offset);
        await file.sync();
        if (this.createdHeader) await syncTranscriptDirectory(dirname(this.options.filePath));
        await this.options.publishBirth?.({ generation: expected.generation, revision: batch.revision });
        this.cursor = { generation: expected.generation, revision: batch.revision, size: offset + line.length, dev: info.dev, ino: info.ino };
        this.createdHeader = null;
      } finally { await file.close(); }
    });
  }

  private async publishReplacement(): Promise<TranscriptCommitTarget> {
    const pending = this.pendingReplacement!;
    await this.options.withLock(async () => {
      let published = false;
      try {
        const source = await this.read();
        published = source.header.generation === pending.generation && source.revision === pending.revision && source.tail === 'clean';
        const emptySource = pending.recoverEmptySource && source.tail === 'clean'
          && source.revision === 0 && source.lastBatchId === null && source.header.baseline === false;
        if (!published && !emptySource && (source.header.generation !== pending.expected.generation || source.revision !== pending.expected.revision
          || (source.tail !== 'clean' && !(this.options.recoverIncompleteTail && source.tail === 'incomplete')))) {
          throw new TranscriptStorageError('invalid-history', 'Baseline source changed');
        }
        if (!published && source.tail === 'incomplete') {
          const file = await open(this.options.filePath, 'r+');
          try { await file.truncate(source.validBytes); await file.sync(); } finally { await file.close(); }
        }
      } catch (error) {
        const missingInitialBirth = (error as NodeJS.ErrnoException).code === 'ENOENT'
          && this.options.allowCreate && pending.expected.revision === 0;
        const emptyFile = pending.recoverEmptySource && error instanceof TranscriptStorageError
          && error.reason === 'invalid-history'
          && await stat(this.options.filePath).then(info => info.size === 0, () => false);
        if (!missingInitialBirth && !emptyFile) throw error;
      }
      if (!published) {
        await this.options.prepareReplacement?.(pending.expected, { generation: pending.generation, revision: pending.revision });
        await rename(pending.candidate, this.options.filePath);
      }
      // A retry after rename confirms the same generation; it never overwrites
      // an already-published baseline with the next caller's newer snapshot.
      const file = await open(this.options.filePath, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      await syncTranscriptDirectory(dirname(this.options.filePath));
      await this.options.publishBirth?.({ generation: pending.generation, revision: pending.revision });
      const info = await stat(this.options.filePath);
      this.cursor = { generation: pending.generation, revision: pending.revision, size: info.size, dev: info.dev, ino: info.ino };
    });
    this.pendingReplacement = null;
    return { generation: pending.generation, revision: pending.revision };
  }

  /** Called only after this operation's physical IO has settled. */
  async discardCandidate(): Promise<void> {
    if (!this.pendingReplacement) return;
    try { await unlink(this.pendingReplacement.candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.pendingReplacement = null;
  }

  async replace(expected: TranscriptCommitTarget, snapshot: TranscriptProjection, revision: number): Promise<TranscriptCommitTarget> {
    return this.prepareBaselineReplacement(expected, snapshot, revision, false);
  }

  async recoverEmptySource(expected: TranscriptCommitTarget, snapshot: TranscriptProjection, revision: number): Promise<TranscriptCommitTarget> {
    return this.prepareBaselineReplacement(expected, snapshot, revision, true);
  }

  private async prepareBaselineReplacement(expected: TranscriptCommitTarget, snapshot: TranscriptProjection, revision: number, recoverEmptySource: boolean): Promise<TranscriptCommitTarget> {
    if (this.pendingReplacement) return this.publishReplacement();
    const generation = randomUUID();
    const candidate = join(dirname(this.options.filePath), `.${this.options.sessionId}.${generation}.tmp`);
    const header: TranscriptHeader = {
      kind: 'session-transcript', version: 2, sessionId: this.options.sessionId,
      generation, baseRevision: revision, baseline: true, sourceGeneration: expected.generation,
    };
    await mkdir(dirname(candidate), { recursive: true });
    const file = await open(candidate, 'wx');
    let candidateComplete = false;
    try {
      let offset = 0;
      const write = async (text: string) => {
        const bytes = Buffer.from(text);
        await writeAll(file, bytes, offset);
        offset += bytes.length;
      };
      await write(JSON.stringify(header) + '\n');
      let count = 0;
      for (const operation of transcriptBaselineOperations(snapshot)) {
        await write(encodeTranscriptBatch({ id: randomUUID(), mode: 'baseline', fromRevision: 0, revision, operations: [operation] }));
        if (++count % 8 === 0) await yieldToRuntime();
      }
      await write(encodeTranscriptBatch({ id: randomUUID(), mode: 'baseline', fromRevision: 0, revision, operations: [], baselineEnd: true }));
      await file.sync();
      candidateComplete = true;
    } finally {
      await file.close();
      if (!candidateComplete) await unlink(candidate);
    }

    try {
      // Validate with the production reader before publishing a candidate.
      const verified = await readTranscriptFile(candidate, this.options.sessionId);
      if (verified.tail !== 'clean' || verified.revision !== revision) {
        throw new TranscriptStorageError('invalid-history', 'Invalid V2 baseline candidate');
      }
      if (snapshot.messages.size !== verified.projection.messages.size || snapshot.turns.size !== verified.projection.turns.size
        || [...snapshot.turns].some(([id, turn]) => !sameJsonValue(turn, verified.projection.turns.get(id)))) {
        throw new TranscriptStorageError('invalid-history', 'V2 baseline does not preserve its source');
      }
      const actual = verified.projection.messages.entries();
      for (const [id, message] of snapshot.messages) {
        const next = actual.next().value;
        if (!next || next[0] !== id || !sameJsonValue(message, next[1])) {
          throw new TranscriptStorageError('invalid-history', 'V2 baseline content differs from source');
        }
        await yieldToRuntime();
      }
      this.pendingReplacement = { expected, generation, revision, candidate, recoverEmptySource };
    } catch (error) {
      await unlink(candidate);
      throw error;
    }
    return this.publishReplacement();
  }
}
