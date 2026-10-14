import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managementNetworkStatus, readNetworkStatus } from '../../host/network-status';

const hostId = '00000000-0000-4000-8000-000000000001';
const folders: string[] = [];
const snapshot = { state: 'ready', ready: true, deviceId: hostId, networkId: hostId,
  errorCode: null, updatedAt: 100 };
async function fixture(value = snapshot) {
  const dir = await mkdtemp(join(tmpdir(), 'myagents-network-status-')); folders.push(dir);
  const path = join(dir, 'status.json'); await writeFile(path, JSON.stringify(value), { mode: 0o640 });
  return path;
}
afterEach(async () => { for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('Host network diagnostic projection', () => {
  it('copies allowlisted fields and never forwards a secret in the producer object', async () => {
    const path = await fixture({ ...snapshot, token: 'must-not-leave' } as typeof snapshot);
    expect(await readNetworkStatus(path, process.getuid!(), hostId, 100)).toEqual({ available: true,
      state: 'ready', ready: true, deviceId: hostId, networkId: hostId, errorCode: null, reportedAt: 100 });
  });
  it('projects ready and unavailable diagnostics into the strict management wire contract', async () => {
    const path = await fixture();
    const ready = await readNetworkStatus(path, process.getuid!(), hostId, 100);
    // Rust AgentNetStatus denies unknown fields. Forwarding the full ready
    // diagnostic used to close both snapshot and inspect management channels.
    expect(managementNetworkStatus(ready)).toEqual({ available: true, reason: null });
    expect(managementNetworkStatus(await readNetworkStatus(path, process.getuid!(), hostId, 131)))
      .toEqual({ available: false, reason: 'connector-status-stale' });
    expect(managementNetworkStatus(await readNetworkStatus(undefined, undefined, hostId)))
      .toEqual({ available: false, reason: 'not-integrated' });
  });
  it('rejects stale/future status, another Host and readiness contradiction', async () => {
    const path = await fixture();
    expect((await readNetworkStatus(path, process.getuid!(), hostId, 131)).available).toBe(false);
    expect((await readNetworkStatus(path, process.getuid!(), hostId, 90)).available).toBe(false);
    expect((await readNetworkStatus(path, process.getuid!(), hostId.replace(/1$/, '2'), 100)).available).toBe(false);
    await writeFile(path, JSON.stringify({ ...snapshot, ready: false }));
    expect((await readNetworkStatus(path, process.getuid!(), hostId, 100)).available).toBe(false);
  });
  it('rejects unsafe modes, wrong owner, oversized data and symlink', async () => {
    const path = await fixture();
    expect((await readNetworkStatus(path, process.getuid!() + 1, hostId, 100)).available).toBe(false);
    await chmod(path, 0o644);
    expect((await readNetworkStatus(path, process.getuid!(), hostId, 100)).available).toBe(false);
    await chmod(path, 0o640); await writeFile(path, ' '.repeat(2049));
    expect((await readNetworkStatus(path, process.getuid!(), hostId, 100)).available).toBe(false);
    const link = `${path}.link`; await symlink(path, link);
    expect((await readNetworkStatus(link, process.getuid!(), hostId, 100)).available).toBe(false);
  });
  it('preserves explicitly unintegrated and missing-file states', async () => {
    expect(await readNetworkStatus(undefined, undefined, hostId)).toEqual({ available: false, reason: 'not-integrated' });
    expect((await readNetworkStatus('/nonexistent/myagents-status', process.getuid!(), hostId)).available).toBe(false);
  });
});
