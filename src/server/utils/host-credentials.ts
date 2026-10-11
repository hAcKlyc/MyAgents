import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PREFIX = 'systemd-credential:';

/** Resolve a non-secret reference only at execution, never while loading config. */
export function resolveHostProviderCredential(value: string | undefined): string | undefined {
  if (!value?.startsWith(PREFIX)) return value;
  const name = value.slice(PREFIX.length);
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (process.env.MYAGENTS_HOST_MODE !== '1' || !directory || !isAbsolute(directory)
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('Host credential reference is unavailable');
  }
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077) !== 0) {
    throw new Error('Host credential file must be private and regular');
  }
  const credential = readFileSync(path, 'utf8').trim();
  if (!credential || credential.includes('\n') || credential.includes('\r')) {
    throw new Error('Host credential value is invalid');
  }
  return credential;
}
