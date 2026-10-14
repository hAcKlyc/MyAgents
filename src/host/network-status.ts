import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

type Unavailable = { available: false; reason: string };
type Report = {
  available: true; state: string; ready: boolean; deviceId: string;
  networkId: string | null; errorCode: string | null; reportedAt: number;
};

/** The management wire contract is narrower than the local diagnostic report. */
export function managementNetworkStatus(status: Unavailable | Report): { available: boolean; reason: string | null } {
  return { available: status.available, reason: status.available ? null : status.reason };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const states = new Set(['connecting', 'initializing', 'catalog', 'hydrating', 'ready',
  'signedOut', 'expired', 'unavailable', 'stopped']);

/** A bounded diagnostic projection; it never authorizes Node execution. */
export async function readNetworkStatus(
  path: string | undefined, owner: number | undefined, hostId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<Unavailable | Report> {
  if (!path) return { available: false, reason: 'not-integrated' };
  if (!path.startsWith('/') || !Number.isSafeInteger(owner) || owner! < 0)
    return { available: false, reason: 'connector-status-invalid' };
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== owner || (stat.mode & 0o7777) !== 0o640
      || stat.nlink !== 1 || stat.size < 2 || stat.size > 2048)
      return { available: false, reason: 'connector-status-invalid' };
    const bytes = Buffer.alloc(2049);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 2048) return { available: false, reason: 'connector-status-invalid' };
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid projection');
    const s = value as Record<string, unknown>;
    if (s.deviceId !== hostId || typeof s.state !== 'string' || !states.has(s.state)
      || typeof s.ready !== 'boolean' || s.ready !== (s.state === 'ready')
      || !(s.networkId === null || (typeof s.networkId === 'string' && uuid.test(s.networkId)))
      || !(s.errorCode === null || (typeof s.errorCode === 'string' && /^[A-Z0-9_]{1,128}$/.test(s.errorCode)))
      || !Number.isSafeInteger(s.updatedAt) || typeof s.updatedAt !== 'number')
      return { available: false, reason: 'connector-status-invalid' };
    if (s.updatedAt > now + 2 || now - s.updatedAt > 30)
      return { available: false, reason: 'connector-status-stale' };
    // Deliberately copy only the allowlisted nonsecret fields.
    return { available: true, state: s.state, ready: s.ready, deviceId: hostId,
      networkId: s.networkId as string | null, errorCode: s.errorCode as string | null,
      reportedAt: s.updatedAt };
  } catch {
    return { available: false, reason: 'connector-status-unavailable' };
  } finally { await file?.close(); }
}
