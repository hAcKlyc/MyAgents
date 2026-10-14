import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGuardedSdkQuery } from './sdk-child-launch-guard';

const scratchDirs: string[] = [];
const qaMode = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../shared/updaterQa', () => ({ isUpdaterQaBuild: () => qaMode.enabled, isModelQaBuild: () => false, isIsolatedQaBuild: () => qaMode.enabled }));

function executableFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'myagents-sdk-child-'));
  scratchDirs.push(dir);
  const path = join(dir, 'claude');
  writeFileSync(path, 'fixture');
  return path;
}

afterEach(async () => {
  qaMode.enabled = false;
  vi.unstubAllEnvs();
  const { rm } = await import('fs/promises');
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('createGuardedSdkQuery', () => {
  it.each(['', 'qa-session'])('QA refuses SDK creation before OAuth fallback or management calls (%s)', async sidecarId => {
    qaMode.enabled = true;
    const createQuery = vi.fn();
    const managementCall = vi.fn();
    await expect(createGuardedSdkQuery('/nonexistent-qa-sdk', createQuery, { sidecarId, managementCall }))
      .rejects.toThrow('UPDATER_QA_EXECUTION_DISABLED');
    expect(createQuery).not.toHaveBeenCalled();
    expect(managementCall).not.toHaveBeenCalled();
  });
  it('does not create a second SDK process while the application circuit is open', async () => {
    const executablePath = executableFixture();
    const createQuery = vi.fn();
    const managementCall = vi.fn().mockResolvedValue({
      ok: true,
      admitted: false,
      errorCode: 'EPERM',
      retryAfterMs: 42_000,
    });

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
      sidecarId: '__global__',
    })).rejects.toMatchObject({
      code: 'SDK_CHILD_LAUNCH_CIRCUIT_OPEN',
      errorCode: 'EPERM',
      retryAfterMs: 42_000,
    });
    expect(createQuery).not.toHaveBeenCalled();
  });

  it('does not let stale lifecycle bookkeeping veto a healthy SDK launch', async () => {
    const executablePath = executableFixture();
    const query = {};
    const createQuery = vi.fn(() => query);
    const managementCall = vi.fn().mockResolvedValue({
      ok: false,
      code: 'stale_sidecar',
      error: 'Sidecar identity is no longer current',
    });

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
      sidecarId: 'pending-1',
    })).resolves.toBe(query);
    expect(createQuery).toHaveBeenCalledOnce();
  });

  it('keeps mixed-version Sidecars usable when launch-guard identity is absent', async () => {
    vi.stubEnv('MYAGENTS_SIDECAR_ID', '');
    vi.stubEnv('MYAGENTS_MANAGEMENT_PORT', '31415');
    const executablePath = executableFixture();
    const query = {};
    const createQuery = vi.fn(() => query);
    const managementCall = vi.fn();

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
    })).resolves.toBe(query);
    expect(managementCall).not.toHaveBeenCalled();
    expect(createQuery).toHaveBeenCalledOnce();
  });

  it('keeps the SDK usable when the local management transport is unavailable', async () => {
    const executablePath = executableFixture();
    const query = { initializationResult: vi.fn().mockResolvedValue({}) };
    const createQuery = vi.fn(() => query);
    const managementCall = vi.fn().mockResolvedValue({
      ok: false,
      code: 'management_unavailable',
    });

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
      sidecarId: '__global__',
    })).resolves.toBe(query);
    expect(createQuery).toHaveBeenCalledOnce();
  });

  it('does not invent EPERM when a circuit denial has no deterministic OS error', async () => {
    const executablePath = executableFixture();
    const query = {};
    const createQuery = vi.fn(() => query);
    const managementCall = vi.fn().mockResolvedValue({
      ok: true,
      admitted: false,
      errorCode: 'unknown',
    });

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
      sidecarId: '__global__',
    })).resolves.toBe(query);
    expect(createQuery).toHaveBeenCalledOnce();
  });

  it('keeps the SDK usable when the management request throws', async () => {
    const executablePath = executableFixture();
    const query = {};
    const createQuery = vi.fn(() => query);
    const managementCall = vi.fn().mockRejectedValue(new Error('connection reset'));

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
      sidecarId: '__global__',
    })).resolves.toBe(query);
    expect(createQuery).toHaveBeenCalledOnce();
  });

  it.each([null, [], 'invalid'])('keeps the SDK usable for a top-level malformed admission response', async (admission) => {
    const executablePath = executableFixture();
    const query = {};
    const createQuery = vi.fn(() => query);
    const managementCall = vi.fn().mockResolvedValue(admission);

    await expect(createGuardedSdkQuery(executablePath, createQuery, {
      managementCall,
      sidecarId: '__global__',
    })).resolves.toBe(query);
    expect(createQuery).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'malformed response', settle: () => Promise.resolve(null) },
    { label: 'rejected request', settle: () => Promise.reject(new Error('connection reset')) },
  ])('contains a $label from best-effort settlement', async ({ settle }) => {
    const executablePath = executableFixture();
    const managementCall = vi.fn()
      .mockResolvedValueOnce({ ok: true, admitted: true, admissionEpoch: 10 })
      .mockImplementationOnce(settle);
    const query = { initializationResult: vi.fn().mockResolvedValue({}) };

    await createGuardedSdkQuery(executablePath, () => query, {
      managementCall,
      sidecarId: '__global__',
    });
    await vi.waitFor(() => expect(managementCall).toHaveBeenCalledTimes(2));
  });

  it('reports deterministic spawn denial at executable scope', async () => {
    const executablePath = executableFixture();
    const managementCall = vi.fn()
      .mockResolvedValueOnce({ ok: true, admitted: true, admissionEpoch: 7 })
      .mockResolvedValue({ ok: true });
    const query = {
      initializationResult: vi.fn().mockRejectedValue(
        new Error(`Failed to spawn Claude Code process: spawn '${executablePath}' EPERM`),
      ),
    };

    await createGuardedSdkQuery(executablePath, () => query, {
      managementCall,
      sidecarId: 'pending-1',
    });
    await vi.waitFor(() => {
      expect(managementCall).toHaveBeenLastCalledWith(
        '/api/runtime/sdk-child/settle',
        'POST',
        expect.objectContaining({
          sidecarId: 'pending-1',
          admissionEpoch: 7,
          outcome: 'spawn_denied',
          errorCode: 'EPERM',
        }),
        expect.anything(),
      );
    });
  });

  it('clears the circuit only after the SDK control plane is ready', async () => {
    const executablePath = executableFixture();
    const managementCall = vi.fn()
      .mockResolvedValueOnce({ ok: true, admitted: true, admissionEpoch: 8 })
      .mockResolvedValue({ ok: true });
    const query = { initializationResult: vi.fn().mockResolvedValue({}) };

    await createGuardedSdkQuery(executablePath, () => query, {
      managementCall,
      sidecarId: '__global__',
    });
    await vi.waitFor(() => {
      expect(managementCall).toHaveBeenLastCalledWith(
        '/api/runtime/sdk-child/settle',
        'POST',
        expect.objectContaining({ outcome: 'ready' }),
        expect.anything(),
      );
    });
  });

  it('releases admission for provider or network failures without opening the circuit', async () => {
    const executablePath = executableFixture();
    const managementCall = vi.fn()
      .mockResolvedValueOnce({ ok: true, admitted: true, admissionEpoch: 9 })
      .mockResolvedValue({ ok: true });
    const query = {
      initializationResult: vi.fn().mockRejectedValue(new Error('HTTP 503 upstream unavailable')),
    };

    await createGuardedSdkQuery(executablePath, () => query, {
      managementCall,
      sidecarId: 'session-1',
    });
    await vi.waitFor(() => {
      expect(managementCall).toHaveBeenLastCalledWith(
        '/api/runtime/sdk-child/settle',
        'POST',
        expect.objectContaining({ outcome: 'released', admissionEpoch: 9 }),
        expect.anything(),
      );
    });
  });

  it('keeps every production builtin SDK query behind the shared guard', () => {
    const root = join(process.cwd(), 'src', 'server');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          path.endsWith('.ts')
          && !path.includes('.test.')
          && !path.includes(`${join('src', 'server', '__tests__')}`)
        ) files.push(path);
      }
    };
    walk(root);

    const uncovered: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes("from '@anthropic-ai/claude-agent-sdk'")) continue;
      const queryCalls = source
        .split('\n')
        .filter(line => !line.trimStart().startsWith('//'))
        .filter(line => /\bquery\s*\(\s*\{/.test(line))
        .length;
      if (queryCalls === 0) continue;
      const guardedCalls = source.match(/\bcreateGuardedSdkQuery\s*\(/g)?.length ?? 0;
      if (guardedCalls < queryCalls) uncovered.push(file.slice(root.length + 1));
    }

    expect(uncovered).toEqual([]);
  });
});
