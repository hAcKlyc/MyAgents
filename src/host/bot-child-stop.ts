import type { ChildProcess } from 'node:child_process';

export interface BotChildStopDeadlines {
  graceMs: number;
  termMs: number;
  killMs: number;
}

const DEFAULT_DEADLINES: BotChildStopDeadlines = { graceMs: 2_000, termMs: 2_000, killMs: 2_000 };
const MAX_DEADLINE_MS = 60_000;

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function validateDeadlines(deadlines: BotChildStopDeadlines): void {
  if (!deadlines || !['graceMs','termMs','killMs'].every(key =>
    Number.isSafeInteger(deadlines[key as keyof BotChildStopDeadlines]) &&
    deadlines[key as keyof BotChildStopDeadlines] >= 0 && deadlines[key as keyof BotChildStopDeadlines] <= MAX_DEADLINE_MS)) {
    throw new Error('BOT_STOP_DEADLINE_INVALID');
  }
}

function waitForExitOrTimeout(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(didExit || exited(child));
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    // Close the race between the initial check and listener registration.
    if (exited(child)) finish(true);
  });
}

/** Stop exactly this delegated Bot child and resolve only on real process exit. */
export async function stopBotChild(
  child: ChildProcess,
  shutdown: () => Promise<unknown>,
  deadlines: BotChildStopDeadlines = DEFAULT_DEADLINES,
): Promise<void> {
  validateDeadlines(deadlines);
  if (exited(child)) return;

  // A failed shutdown request does not prove the child stopped; continue with
  // bounded OS signals and require the ChildProcess exit state as evidence.
  void Promise.resolve().then(shutdown).catch(() => undefined);
  if (await waitForExitOrTimeout(child, deadlines.graceMs)) return;
  if (exited(child)) return;
  try { child.kill('SIGTERM'); } catch { /* still require exit evidence */ }
  if (await waitForExitOrTimeout(child, deadlines.termMs)) return;
  if (exited(child)) return;
  try { child.kill('SIGKILL'); } catch { /* still require exit evidence */ }
  if (await waitForExitOrTimeout(child, deadlines.killMs)) return;
  if (exited(child)) return;
  throw new Error('BOT_EXIT_UNCONFIRMED');
}
