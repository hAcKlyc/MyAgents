import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const REPOSITORY = 'heavenzhang/MyAgents';

export function renderBootstrap({ sourceCommit, releaseTag, archiveName, archiveSha256, installerSha256 }) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Invalid source commit');
  const tagMatch = /^host-test-([0-9]{14})-([0-9a-f]{12})$/.exec(releaseTag);
  const archiveMatch = /^myagents-host-test-([0-9]{14})-([0-9a-f]{12})\.tar\.gz$/.exec(archiveName);
  if (!tagMatch || !archiveMatch || tagMatch[1] !== archiveMatch[1] || tagMatch[2] !== archiveMatch[2] || tagMatch[2] !== sourceCommit.slice(0, 12)) {
    throw new Error('Invalid or mismatched test release tag/archive/source commit');
  }
  if (!/^[0-9a-f]{64}$/.test(archiveSha256) || !/^[0-9a-f]{64}$/.test(installerSha256)) throw new Error('Invalid SHA-256');
  const archiveUrl = `https://github.com/${REPOSITORY}/releases/download/${releaseTag}/${archiveName}`;
  const installerUrl = `https://raw.githubusercontent.com/${REPOSITORY}/${sourceCommit}/scripts/host/install.sh`;
  return `#!/usr/bin/env bash
set -euo pipefail

# Unsigned internal test bootstrap. Review this file and its pinned digests before use.
readonly RELEASE_TAG='${releaseTag}'
readonly SOURCE_COMMIT='${sourceCommit}'
readonly ARCHIVE_NAME='${archiveName}'
readonly ARCHIVE_SHA256='${archiveSha256}'
readonly INSTALLER_SHA256='${installerSha256}'
readonly ARCHIVE_URL='${archiveUrl}'
readonly INSTALLER_URL='${installerUrl}'

fail() { printf 'myagents-host bootstrap: %s\\n' "$*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail 'this pinned bootstrap accepts no arguments'
[[ $(id -u) -eq 0 ]] || fail 'run as root (for example: sudo bash install-*.sh)'
[[ $(uname -s) == Linux ]] || fail 'Linux is required'
[[ $(uname -m) == x86_64 ]] || fail 'Linux x86_64 is required'
command -v id >/dev/null || fail 'id is required'
command -v curl >/dev/null || fail 'curl is required'
command -v sha256sum >/dev/null || fail 'sha256sum is required'
command -v cut >/dev/null || fail 'cut is required'
command -v bash >/dev/null || fail 'bash is required'
command -v tar >/dev/null || fail 'tar is required'
command -v mktemp >/dev/null || fail 'mktemp is required'
command -v getconf >/dev/null || fail 'getconf is required'
command -v flock >/dev/null || fail 'flock is required'
[[ $(getconf GNU_LIBC_VERSION 2>/dev/null || true) == glibc\\ * ]] || fail 'glibc is required'

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
archive="$tmp/$ARCHIVE_NAME"
installer="$tmp/install.sh"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --output "$archive" "$ARCHIVE_URL"
actual=$(sha256sum "$archive" | cut -d ' ' -f1)
[[ $actual == "$ARCHIVE_SHA256" ]] || fail 'release archive SHA-256 mismatch; installer was not run'
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --output "$installer" "$INSTALLER_URL"
actual=$(sha256sum "$installer" | cut -d ' ' -f1)
[[ $actual == "$INSTALLER_SHA256" ]] || fail 'installer SHA-256 mismatch; installer was not run'
bash "$installer" "$archive" --sha256 "$ARCHIVE_SHA256"
`;
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
