import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const REPOSITORY = 'heavenzhang/MyAgents';

export function renderBootstrap({ sourceCommit, releaseTag, archiveName, archiveSha256, installerSha256, installerBase64, profile = 'myagents-test' }) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Invalid source commit');
  const profiles = { 'myagents-test': { root: 'myagents-host-test', tag: 'host-test-' }, 'moxbot-test': { root: 'moxbot-host-test', tag: 'host-test-moxbot-' } };
  if (!Object.hasOwn(profiles, profile)) throw new Error('Invalid Host profile');
  const selected = profiles[profile];
  const tagMatch = new RegExp(`^${selected.tag}([0-9]{14})-([0-9a-f]{12})$`).exec(releaseTag);
  const archiveMatch = new RegExp(`^${selected.root}-([0-9]{14})-([0-9a-f]{12})\\.tar\\.gz$`).exec(archiveName);
  if (!tagMatch || !archiveMatch || tagMatch[1] !== archiveMatch[1] || tagMatch[2] !== archiveMatch[2] || tagMatch[2] !== sourceCommit.slice(0, 12)) {
    throw new Error('Invalid or mismatched test release tag/archive/source commit');
  }
  if (!/^[0-9a-f]{64}$/.test(archiveSha256) || !/^[0-9a-f]{64}$/.test(installerSha256)) throw new Error('Invalid SHA-256');
  if (typeof installerBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(installerBase64)) {
    throw new Error('Invalid embedded installer Base64');
  }
  const installerBytes = Buffer.from(installerBase64, 'base64');
  if (installerBytes.toString('base64') !== installerBase64) throw new Error('Non-canonical embedded installer Base64');
  if (createHash('sha256').update(installerBytes).digest('hex') !== installerSha256) throw new Error('Embedded installer SHA-256 mismatch');
  const releaseApiUrl = `https://api.github.com/repos/${REPOSITORY}/releases/tags/${releaseTag}`;
  const assetApiBase = `https://api.github.com/repos/${REPOSITORY}/releases/assets`;
  return `#!/usr/bin/env bash
set -euo pipefail

# Unsigned internal test bootstrap. Review this file and its pinned digests before use.
readonly RELEASE_TAG='${releaseTag}'
readonly SOURCE_COMMIT='${sourceCommit}'
readonly PROFILE='${profile}'
readonly ARCHIVE_NAME='${archiveName}'
readonly ARCHIVE_SHA256='${archiveSha256}'
readonly INSTALLER_SHA256='${installerSha256}'
readonly RELEASE_API_URL='${releaseApiUrl}'
readonly ASSET_API_BASE='${assetApiBase}'

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
command -v python3 >/dev/null || fail 'python3 is required'
[[ $(getconf GNU_LIBC_VERSION 2>/dev/null || true) == glibc\\ * ]] || fail 'glibc is required'

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
archive="$tmp/$ARCHIVE_NAME"
installer="$tmp/install.sh"
metadata="$tmp/release.json"
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 30 --max-time 120 \\
  --header 'Accept: application/vnd.github+json' --header 'X-GitHub-Api-Version: 2022-11-28' \\
  --output "$metadata" "$RELEASE_API_URL"
asset_id=$(python3 - "$metadata" "$RELEASE_TAG" "$SOURCE_COMMIT" "$ARCHIVE_NAME" <<'PY'
import json
import sys

path, expected_tag, expected_commit, expected_name = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as stream:
        release = json.load(stream)
except (OSError, UnicodeError, json.JSONDecodeError) as exc:
    raise SystemExit(f"invalid GitHub release metadata: {exc}")
if not isinstance(release, dict):
    raise SystemExit("GitHub release metadata must be an object")
if release.get("tag_name") != expected_tag:
    raise SystemExit("GitHub release tag mismatch")
if release.get("draft") is not False:
    raise SystemExit("GitHub release must be published, not draft")
if release.get("target_commitish") != expected_commit:
    raise SystemExit("GitHub release source commit mismatch")
assets = release.get("assets")
if not isinstance(assets, list):
    raise SystemExit("GitHub release assets must be a list")
matches = [item for item in assets if isinstance(item, dict) and item.get("name") == expected_name]
if len(matches) != 1:
    raise SystemExit("GitHub release must contain exactly one archive asset with the pinned name")
asset = matches[0]
asset_id = asset.get("id")
if type(asset_id) is not int or asset_id <= 0:
    raise SystemExit("GitHub release archive asset ID must be a positive integer")
if asset.get("state") != "uploaded":
    raise SystemExit("GitHub release archive asset is not uploaded")
print(asset_id)
PY
) || fail 'release metadata validation failed'
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 30 --max-time 3600 \\
  --header 'Accept: application/octet-stream' --header 'X-GitHub-Api-Version: 2022-11-28' \\
  --output "$archive" "$ASSET_API_BASE/$asset_id"
actual=$(sha256sum "$archive" | cut -d ' ' -f1)
[[ $actual == "$ARCHIVE_SHA256" ]] || fail 'release archive SHA-256 mismatch; installer was not run'
python3 - "$installer" "$INSTALLER_SHA256" <<'PY'
import base64
import hashlib
import sys

path, expected_sha256 = sys.argv[1:]
encoded = """${installerBase64}"""
try:
    installer = base64.b64decode(encoded, validate=True)
except (ValueError, base64.binascii.Error) as exc:
    raise SystemExit(f"embedded installer Base64 is invalid: {exc}")
if base64.b64encode(installer).decode("ascii") != encoded:
    raise SystemExit("embedded installer Base64 is not canonical")
if hashlib.sha256(installer).hexdigest() != expected_sha256:
    raise SystemExit("embedded installer SHA-256 mismatch; installer was not run")
with open(path, "xb") as output:
    output.write(installer)
PY
bash "$installer" "$archive" --sha256 "$ARCHIVE_SHA256" --profile "$PROFILE"
`;
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
