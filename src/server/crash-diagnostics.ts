import { APP_DATA_DIR_NAME } from '../shared/appProfile';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const CRASH_LOG_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const CRASH_LOG_MAX_AGE_MS = 30 * DAY_MS;
export const DEFAULT_CRASH_LOG_DIR = join(homedir(), APP_DATA_DIR_NAME, 'logs', 'crash');

const CRASH_DEDUPE_WINDOW_MS = 60_000;
const CRASH_DEDUPE_DUMP_LIMIT = 3;
export type CrashDiagnosticsOptions = {
  crashDir?: string;
  pid?: number;
  now?: () => number;
  getRecentLines?: (limit: number) => string[];
  /** Test seam; production always uses the exported hard ceiling. */
  maxFileBytes?: number;
  /** Test seam; production rotates at the application retention age. */
  maxFileAgeMs?: number;
};

type FingerprintState = {
  count: number;
  firstSeen: number;
  suppressed: boolean;
};

/** Process-local writer; the directory policy itself is application-scoped. */
export class CrashDiagnostics {
  private readonly crashDir: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly getRecentLines: (limit: number) => string[];
  private readonly maxFileBytes: number;
  private readonly maxFileAgeMs: number;
  private readonly fingerprints = new Map<string, FingerprintState>();
  private filePath: string | null = null;
  private fileCreatedAt: number | null = null;
  private ceilingHit = false;

  constructor(options: CrashDiagnosticsOptions = {}) {
    this.crashDir = options.crashDir ?? DEFAULT_CRASH_LOG_DIR;
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.getRecentLines = options.getRecentLines ?? (() => []);
    this.maxFileBytes = options.maxFileBytes ?? CRASH_LOG_FILE_MAX_BYTES;
    this.maxFileAgeMs = options.maxFileAgeMs ?? CRASH_LOG_MAX_AGE_MS;
  }

  /** Lazily creates a report only when an abnormal event is recorded. */
  record(prefix: string, ...args: unknown[]): void {
    const message = args.map(formatCrashValue).join(' ');
    this.append(`[${new Date(this.now()).toISOString()}] ${prefix} ${message}\n`);
  }

  recordContext(reason: string, error?: unknown): void {
    if (this.ceilingHit || (error !== undefined && !this.shouldDumpContext(error))) return;
    try {
      const lines = this.getRecentLines(200);
      if (lines.length === 0) return;
      this.append(
        `\n--- crash context (${reason}, last ${lines.length} unified lines) ---\n`
        + lines.join('')
        + '--- end crash context ---\n',
      );
    } catch {
      // Crash reporting must never become a second failure.
    }
  }

  get activeFilePath(): string | null {
    return this.filePath;
  }

  private ensureFilePath(now: number): string {
    if (this.filePath) return this.filePath;
    try { mkdirSync(this.crashDir, { recursive: true }); } catch { /* later append retries */ }
    const timestamp = new Date(now).toISOString().replace(/[:]/g, '-');
    // PID + nonce prevents different Sidecars starting in the same millisecond
    // from co-owning one file (observed in the historical local corpus).
    const nonce = randomUUID().slice(0, 8);
    this.filePath = join(this.crashDir, `${timestamp}-${this.pid}-${nonce}.log`);
    this.fileCreatedAt = now;
    return this.filePath;
  }

  private append(value: string): void {
    const now = this.now();
    if (
      this.filePath
      && this.fileCreatedAt !== null
      && now - this.fileCreatedAt >= this.maxFileAgeMs
    ) {
      // mtime is refreshed by every append, so an always-alive Sidecar must
      // rotate based on the file's creation instant. Delete the expired file
      // directly: retaining it until an mtime sweep would allow content to live
      // for almost twice the documented ceiling.
      try { unlinkSync(this.filePath); } catch { /* Tauri's application sweep retries */ }
      this.filePath = null;
      this.fileCreatedAt = null;
      this.ceilingHit = false;
    }
    if (this.ceilingHit) return;
    const filePath = this.ensureFilePath(now);
    try {
      const currentSize = existsSync(filePath) ? statSync(filePath).size : 0;
      const remaining = this.maxFileBytes - currentSize;
      if (remaining <= 0) {
        this.ceilingHit = true;
        return;
      }
      const bytes = Buffer.from(value);
      if (bytes.length > remaining) {
        appendFileSync(filePath, bytes.subarray(0, remaining));
        this.ceilingHit = true;
      } else {
        appendFileSync(filePath, bytes);
      }
    } catch {
      return;
    }
  }

  private shouldDumpContext(error: unknown): boolean {
    const fingerprint = fingerprintError(error);
    const now = this.now();
    if (this.fingerprints.size > 50) {
      for (const [key, state] of this.fingerprints) {
        if (now - state.firstSeen > CRASH_DEDUPE_WINDOW_MS) this.fingerprints.delete(key);
      }
    }

    const state = this.fingerprints.get(fingerprint);
    if (!state || now - state.firstSeen > CRASH_DEDUPE_WINDOW_MS) {
      this.fingerprints.set(fingerprint, { count: 1, firstSeen: now, suppressed: false });
      return true;
    }
    state.count += 1;
    if (state.count <= CRASH_DEDUPE_DUMP_LIMIT) return true;
    if (!state.suppressed) {
      state.suppressed = true;
      this.append(
        `[${new Date(now).toISOString()}] SUPPRESS_CONTEXT fingerprint=${fingerprint.slice(0, 100)} `
        + `count=${state.count} — further dumps suppressed for ${CRASH_DEDUPE_WINDOW_MS / 1000}s\n`,
      );
    }
    return false;
  }
}

function formatCrashValue(value: unknown): string {
  if (value instanceof Error) return `${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function fingerprintError(error: unknown): string {
  if (!error) return 'null';
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const stackHead = (error.stack ?? error.message ?? '').split('\n').slice(0, 2).join('|').slice(0, 200);
    return `${error.name}:${code}:${stackHead}`;
  }
  return String(error).slice(0, 200);
}
