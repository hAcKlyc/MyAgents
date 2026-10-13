import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PREFIX = 'systemd-credential:';
export const HOST_PROVIDER_REFERENCE = 'host-provider-credential:moonshot-coding';
let sessionCredential: { value: string | undefined } | undefined;

/** Private supervisor IPC installs a single worker-birth snapshot, never config. */
export function installHostSessionCredential(value: string | undefined): void {
  if (process.env.MYAGENTS_HOST_MODE !== '1' || sessionCredential !== undefined
    || (value !== undefined && (!value.trim() || Buffer.byteLength(value, 'utf8') > 16 * 1024
      || /[\r\n\0]/.test(value)))) throw new Error('Host Session credential snapshot is invalid');
  sessionCredential = { value };
}

// systemd may expose root-owned credentials as 0440 using a service-user ACL.
// Accept that projection only inside its private, read-only credential mount.
function isReadOnlySystemdProjection(directory: string, stat: Stats): boolean {
  if (process.platform !== 'linux' || !/^\/run\/credentials\/[a-zA-Z0-9_.@-]+$/.test(directory)
    || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o440) return false;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.gid !== 0
      || (parent.mode & 0o027) !== 0 || realpathSync(directory) !== directory) return false;
    return readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line => {
      const [left, right] = line.split(' - ');
      const fields = left.split(' ');
      return fields[4] === directory && fields[5]?.split(',').includes('ro')
        && right?.split(' ')[0] === 'tmpfs';
    });
  } catch { return false; }
}

/** Resolve a non-secret reference only at execution, never while loading config. */
export function readHostSystemdCredential(name: string, maxBytes: number): Buffer {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (process.env.MYAGENTS_HOST_MODE !== '1' || !directory || !isAbsolute(directory)
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('Host credential reference is unavailable');
  }
  const path = join(directory, name);
  const stat = lstatSync(path);
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || (parent.uid !== 0 && parent.uid !== process.getuid?.())
    || ((parent.mode & 0o077) !== 0 && !isReadOnlySystemdProjection(directory, stat)))
    throw new Error('Host credential directory must be private');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes
    || (stat.uid !== 0 && stat.uid !== process.getuid?.())
    || ((stat.mode & 0o077) !== 0 && !isReadOnlySystemdProjection(directory, stat))) {
    throw new Error('Host credential file must be private and regular');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const pinned = fstatSync(fd);
    if (!pinned.isFile() || pinned.dev !== stat.dev || pinned.ino !== stat.ino
      || pinned.size !== stat.size || pinned.nlink !== 1) throw new Error('Host credential file changed');
    const bytes = readFileSync(fd);
    if (bytes.length !== pinned.size || bytes.length > maxBytes) {
      bytes.fill(0);
      throw new Error('Host credential file changed');
    }
    return bytes;
  } finally { closeSync(fd); }
}

/** Resolve a non-secret reference only at execution, never while loading config. */
export function resolveHostProviderCredential(value: string | undefined): string | undefined {
  if (value === HOST_PROVIDER_REFERENCE) {
    if (process.env.MYAGENTS_HOST_MODE !== '1' || sessionCredential === undefined)
      throw new Error('Host Session credential snapshot is unavailable');
    return sessionCredential.value;
  }
  if (value?.startsWith('host-provider-credential:')) throw new Error('Host credential reference is unavailable');
  if (!value?.startsWith(PREFIX)) return value;
  if (process.env.MYAGENTS_HOST_CREDENTIAL_SOURCE === 'supervisor-ipc') {
    if (process.env.MYAGENTS_HOST_MODE !== '1' || sessionCredential === undefined || value !== 'systemd-credential:kimi')
      throw new Error('Host Session credential snapshot is unavailable');
    return sessionCredential.value;
  }
  const bytes = readHostSystemdCredential(value.slice(PREFIX.length), 65536);
  let credential: string;
  try { credential = bytes.toString('utf8').trim(); } finally { bytes.fill(0); }
  if (!credential || credential.includes('\n') || credential.includes('\r')) {
    throw new Error('Host credential value is invalid');
  }
  return credential;
}
