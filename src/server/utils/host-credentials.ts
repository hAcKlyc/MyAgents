import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PREFIX = 'systemd-credential:';

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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || ((stat.mode & 0o077) !== 0 && !isReadOnlySystemdProjection(directory, stat))) {
    throw new Error('Host credential file must be private and regular');
  }
  const credential = readFileSync(path, 'utf8').trim();
  if (!credential || credential.includes('\n') || credential.includes('\r')) {
    throw new Error('Host credential value is invalid');
  }
  return credential;
}
