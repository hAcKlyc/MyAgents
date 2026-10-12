import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { randomUUID } from 'crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { cancellableFetch } from '../utils/cancellation';
import { FileBusyError, withFileLock } from '../utils/file-lock';
import { ensureDirSync } from '../utils/fs-utils';

const QR_CODE_URL = 'https://download.myagents.io/assets/feedback_qr_code.png';
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const LOCK_MAX_AGE_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = DOWNLOAD_TIMEOUT_MS + 5_000;

type FetchLike = typeof cancellableFetch;

interface QrCodeAssetRouteOptions {
  cacheDir?: string;
  cacheMaxAgeMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

interface QrCodeAssetBody {
  success: boolean;
  dataUrl?: string;
  error?: string;
}

function jsonResponse(body: QrCodeAssetBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? '网络请求超时' : error.message;
  return String(error || '加载失败');
}

function imageMimeFromBytes(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function defaultCacheDir(): string {
  return join(homedir(), APP_DATA_DIR_NAME, 'cache', 'assets');
}

function ensurePrivateCacheDir(cacheDir: string): void {
  ensureDirSync(cacheDir);
  const metadata = lstatSync(cacheDir);
  if (!metadata.isDirectory()) {
    throw new Error('QR cache path is not a directory');
  }
  try {
    chmodSync(cacheDir, 0o700);
  } catch {
    /* best-effort on platforms/filesystems that ignore POSIX mode bits */
  }
}

function readRegularFileNoFollow(filePath: string): Buffer | null {
  let fd: number | null = null;
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile()) return null;
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

function cacheAgeMs(cacheFile: string, now: () => number): number | null {
  try {
    const metadata = lstatSync(cacheFile);
    if (!metadata.isFile()) return null;
    return now() - metadata.mtimeMs;
  } catch {
    return null;
  }
}

function readCacheDataUrl(cacheFile: string): string | null {
  const imageBuffer = readRegularFileNoFollow(cacheFile);
  if (!imageBuffer || imageBuffer.length === 0) return null;
  return `data:${imageMimeFromBytes(imageBuffer)};base64,${imageBuffer.toString('base64')}`;
}

function unavailableResponse(error: string): Response {
  return jsonResponse({ success: false, error: error || 'QR code not available' });
}

export async function handleQrCodeAssetRoute(
  pathname: string,
  request: Request,
  options: QrCodeAssetRouteOptions = {},
): Promise<Response | null> {
  if (pathname !== '/api/assets/qr-code' || request.method !== 'GET') return null;

  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const cacheFile = join(cacheDir, 'feedback_qr_code.png');
  const lockPath = `${cacheFile}.download.lock`;
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? CACHE_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? cancellableFetch;
  const startTime = now();

  try {
    let needsDownload = true;
    const existingAge = cacheAgeMs(cacheFile, now);
    if (existingAge !== null) {
      const age = existingAge;
      if (age < cacheMaxAgeMs) {
        needsDownload = false;
        logger.log(`[api/assets/qr-code] Cache hit (age: ${Math.round(age / 1000 / 60)}min)`);
      } else {
        logger.log(`[api/assets/qr-code] Cache expired (age: ${Math.round(age / 1000 / 60)}min), re-downloading`);
      }
    } else {
      logger.log('[api/assets/qr-code] Cache miss, downloading');
    }

    if (needsDownload) {
      try {
        ensurePrivateCacheDir(cacheDir);
        await withFileLock(
          { lockPath, timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_MAX_AGE_MS },
          async () => {
            const lockedAge = cacheAgeMs(cacheFile, now);
            if (lockedAge !== null && lockedAge < cacheMaxAgeMs) {
              logger.log(`[api/assets/qr-code] Cache refreshed by another process (age: ${Math.round(lockedAge / 1000 / 60)}min)`);
              return;
            }

            const downloadStartTime = now();
            const response = await fetchImpl(QR_CODE_URL, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
            if (!response.ok) {
              logger.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using cache if available`);
              return;
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const tmpFile = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
            try {
              writeFileSync(tmpFile, buffer, { flag: 'wx' });
              renameSync(tmpFile, cacheFile);
            } finally {
              if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
            }
            logger.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${Math.round(now() - downloadStartTime)}ms)`);
          },
        );
      } catch (error) {
        if (error instanceof FileBusyError) {
          logger.warn('[api/assets/qr-code] Download lock busy, using cache if available');
        } else {
          logger.warn(`[api/assets/qr-code] Download failed (${errorMessage(error)}), using cache if available`);
        }
      }
    }

    const dataUrl = readCacheDataUrl(cacheFile);
    if (!dataUrl) return unavailableResponse('QR code not available');

    logger.log(`[api/assets/qr-code] Request completed in ${Math.round(now() - startTime)}ms`);
    return jsonResponse({ success: true, dataUrl });
  } catch (error) {
    logger.warn(`[api/assets/qr-code] Optional asset route failed (${errorMessage(error)})`);
    const dataUrl = readCacheDataUrl(cacheFile);
    return dataUrl ? jsonResponse({ success: true, dataUrl }) : unavailableResponse(errorMessage(error));
  }
}
