import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { spawn, type SubprocessHandle } from '../utils/subprocess';
import { detectCliInstallation } from './cli-installation';

vi.mock('../utils/subprocess', () => ({ spawn: vi.fn() }));

const path = resolve('fixture-agy');

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('runtime installation discovery', () => {
  it('does not spawn anything for a presence-only check or a missing executable', async () => {
    await expect(detectCliInstallation(path, {}, { includeVersion: false })).resolves.toEqual({ path, installed: true });
    await expect(detectCliInstallation('agy', {})).resolves.toEqual({ installed: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the path installed and kills the version probe when metadata stalls', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    vi.mocked(spawn).mockReturnValue({
      exited: new Promise<number>(() => {}),
      stdout: null,
      kill,
    } as unknown as SubprocessHandle);
    const detection = detectCliInstallation(path, {});
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(detection).resolves.toEqual({ path, installed: true });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
