#!/usr/bin/env bash
set -Eeuo pipefail

readonly PREFIX=/opt/myagents-host-test
readonly STATE=/var/lib/myagents-host-test
readonly SERVICE=myagents-host-test
readonly USER_NAME=myagents-host-test
readonly UNIT=/etc/systemd/system/myagents-host-test.service
DRY_RUN=0
ARCHIVE=
EXPECTED_SHA=
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --sha256) (($# >= 2)) || { echo '--sha256 requires an independently obtained digest' >&2; exit 2; }; EXPECTED_SHA=$2; shift 2 ;;
    --*) echo "Unsupported option: $1" >&2; exit 2 ;;
    *) [[ -z "$ARCHIVE" ]] || { echo 'Only one archive is accepted' >&2; exit 2; }; ARCHIVE=$1; shift ;;
  esac
done
[[ -n "$ARCHIVE" && -f "$ARCHIVE" ]] || { echo 'Usage: install.sh [--dry-run] ARCHIVE.tar.gz --sha256 EXPECTED_SHA256' >&2; exit 2; }
[[ "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'A caller-supplied 64-digit --sha256 is required' >&2; exit 2; }
ACTUAL_SHA=$(sha256sum -- "$ARCHIVE" | awk '{print $1}')
ACTUAL_SHA=$(printf '%s' "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')
EXPECTED_SHA=$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || { echo 'Archive SHA-256 does not match caller-supplied digest' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required for safe archive and manifest verification' >&2; exit 1; }
STAGE=$(mktemp -d)
BACKUP_LINK=
LINK_CHANGED=0
CREATED_RELEASE=
RESTORE_OLD_SERVICE=0
UNIT_CHANGED=0
PREVIOUS_ENABLED=0
cleanup() {
  local result=$?
  if ((result != 0 && LINK_CHANGED)); then
    if [[ -n "$BACKUP_LINK" && -L "$BACKUP_LINK" ]]; then
      ln -sfn "$(readlink "$BACKUP_LINK")" "$PREFIX/current.rollback"
      mv -Tf "$PREFIX/current.rollback" "$PREFIX/current"
    else
      rm -f "$PREFIX/current"
    fi
      systemctl stop "$SERVICE" >/dev/null 2>&1 || true
      if ((UNIT_CHANGED)); then
      if [[ -f "$STAGE/previous-unit" ]]; then install -o root -g root -m 0644 "$STAGE/previous-unit" "$UNIT"; else rm -f "$UNIT"; fi
      systemctl daemon-reload >/dev/null 2>&1 || true
      if ((PREVIOUS_ENABLED)); then systemctl enable "$SERVICE" >/dev/null 2>&1 || true; else systemctl disable "$SERVICE" >/dev/null 2>&1 || true; fi
    fi
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
    if ((RESTORE_OLD_SERVICE && PREVIOUS_ENABLED)); then systemctl start "$SERVICE" >/dev/null 2>&1 || true; fi
  fi
  if ((result != 0)) && [[ -n "$CREATED_RELEASE" && -d "$CREATED_RELEASE" ]]; then rm -rf -- "$CREATED_RELEASE"; fi
  rm -rf -- "$STAGE"
  exit "$result"
}
trap cleanup EXIT

python3 - "$ARCHIVE" "$STAGE" <<'PY'
import hashlib, json, os, pathlib, stat, sys, tarfile
archive, stage = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    root = pathlib.PurePosixPath('myagents-host-test')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != root.name:
            raise SystemExit(f'Unsafe archive path: {member.name!r}')
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f'Archive contains link or special file: {member.name!r}')
    tf.extractall(stage, members=members)
base = pathlib.Path(stage) / root
manifests = list(base.glob('releases/*/manifest.json'))
if len(manifests) != 1:
    raise SystemExit('Archive must contain exactly one release manifest')
manifest_path = manifests[0]
manifest = json.loads(manifest_path.read_text())
if manifest.get('schemaVersion') != 1 or manifest.get('target') != 'linux-x64-glibc':
    raise SystemExit('Unsupported package manifest or target')
release = manifest_path.parent
release_id = manifest.get('releaseId')
if release.name != release_id or not isinstance(release_id, str) or '/' in release_id:
    raise SystemExit('Release id does not match manifest location')
expected = manifest.get('files')
if not isinstance(expected, list) or not expected:
    raise SystemExit('Manifest file list is missing')
seen = set()
for item in expected:
    rel = pathlib.PurePosixPath(item['path'])
    if rel.is_absolute() or '..' in rel.parts or str(rel) in seen:
        raise SystemExit(f'Unsafe or duplicate manifest path: {item["path"]!r}')
    seen.add(str(rel))
    path = release.joinpath(*rel.parts)
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f'Manifest file is missing or not regular: {rel}')
    data = path.read_bytes()
    if (len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']
            or stat.S_IMODE(path.stat().st_mode) != item['mode']):
        raise SystemExit(f'Manifest hash/size mismatch: {rel}')
actual = {p.relative_to(release).as_posix() for p in release.rglob('*') if p.is_file() and p != manifest_path}
if actual != seen:
    raise SystemExit('Release contains unlisted or missing files')
print(release_id)
PY
RELEASE_ID=$(python3 -c 'import json,glob,os,sys; p=glob.glob(sys.argv[1]+"/myagents-host-test/releases/*/manifest.json"); print(json.load(open(p[0]))["releaseId"])' "$STAGE")
RELEASE_SOURCE="$STAGE/myagents-host-test/releases/$RELEASE_ID"
[[ -x "$RELEASE_SOURCE/resources/nodejs/bin/node" && -x "$RELEASE_SOURCE/resources/claude-agent-sdk/claude" ]] || { echo 'Required bundled runtimes are not executable' >&2; exit 1; }
if ((DRY_RUN)); then printf 'Verified unsigned test package %s (%s)\n' "$RELEASE_ID" "$ACTUAL_SHA"; exit 0; fi
((EUID == 0)) || { echo 'Install requires root; --dry-run does not' >&2; exit 1; }
command -v systemctl >/dev/null || { echo 'systemd is required' >&2; exit 1; }
readonly INSTALL_LOCK=/run/myagents-host-test-install.lock
if [[ ! -e "$INSTALL_LOCK" ]]; then (umask 077; : >"$INSTALL_LOCK"); fi
[[ -f "$INSTALL_LOCK" && ! -L "$INSTALL_LOCK" && "$(stat -c '%u' "$INSTALL_LOCK")" == 0 \
  && $((8#$(stat -c '%a' "$INSTALL_LOCK") & 077)) == 0 ]] || { echo 'Unsafe installation lock file' >&2; exit 1; }
exec 9>>"$INSTALL_LOCK"
flock -n 9 || { echo 'Another installation or rollback transaction is active' >&2; exit 1; }
if [[ -L "$PREFIX/current" && "$(readlink "$PREFIX/current")" == "releases/$RELEASE_ID" && -d "$PREFIX/releases/$RELEASE_ID" ]]; then
  python3 - "$RELEASE_SOURCE" "$PREFIX/releases/$RELEASE_ID" <<'PY'
import hashlib, json, pathlib, stat, sys
source, installed = map(pathlib.Path, sys.argv[1:])
source_manifest = (source / 'manifest.json').read_bytes()
installed_manifest = (installed / 'manifest.json').read_bytes()
if source_manifest != installed_manifest:
    raise SystemExit('Installed release manifest differs from this archive')
m = json.loads(source_manifest)
expected = set()
for item in m['files']:
    rel = pathlib.PurePosixPath(item['path'])
    if rel.is_absolute() or '..' in rel.parts: raise SystemExit('Unsafe installed manifest path')
    expected.add(str(rel))
    path = installed.joinpath(*rel.parts)
    if path.is_symlink() or not path.is_file(): raise SystemExit(f'Installed release file is missing or unsafe: {rel}')
    data = path.read_bytes()
    if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256'] or stat.S_IMODE(path.stat().st_mode) != item['mode']:
        raise SystemExit(f'Installed release file differs from verified archive: {rel}')
actual = {p.relative_to(installed).as_posix() for p in installed.rglob('*') if p.is_file() and p.name != 'manifest.json'}
if actual != expected: raise SystemExit('Installed release contains unlisted or missing files')
PY
  printf 'Already installed and verified release %s; no changes made.\n' "$RELEASE_ID"
  exit 0
fi
if systemctl is-active --quiet "$SERVICE"; then echo 'Refusing update while service is active; stop and inspect it first' >&2; exit 1; fi
if [[ -e "$STATE/host.lock" ]] && ! flock -n "$STATE/host.lock" -c true; then
  echo 'Refusing update while another Host process holds the runtime lock' >&2
  exit 1
fi
STATE_PREEXISTED=0
if [[ -e "$STATE" ]]; then
  [[ -d "$STATE" && ! -L "$STATE" ]] || { echo 'Existing Host state path is not a regular directory' >&2; exit 1; }
  STATE_PREEXISTED=1
else
  install -d -o root -g root -m 0755 "$STATE"
fi
if getent passwd "$USER_NAME" >/dev/null; then
  IFS=: read -r _ _ SERVICE_UID SERVICE_GID _ SERVICE_HOME SERVICE_SHELL < <(getent passwd "$USER_NAME")
  [[ "$SERVICE_UID" != 0 && "$SERVICE_HOME" == "$STATE/home" && "$SERVICE_SHELL" == /usr/sbin/nologin ]] || {
    echo "Existing $USER_NAME account has unexpected UID, home, or shell; refusing to modify it" >&2; exit 1;
  }
  [[ "$(stat -c '%u' "$STATE")" == "$SERVICE_UID" && "$(stat -c '%a' "$STATE")" == 700 \
    && -d "$STATE/home" && ! -L "$STATE/home" && "$(stat -c '%u' "$STATE/home")" == "$SERVICE_UID" \
    && "$(stat -c '%a' "$STATE/home")" == 700 ]] || {
    echo "Existing Host state/home is unsafe or owned by another account; refusing to change it" >&2; exit 1;
  }
  GROUP_ENTRY=$(getent group "$USER_NAME" || true)
  [[ -n "$GROUP_ENTRY" && "${GROUP_ENTRY#*:*:}" == "$SERVICE_GID:"* ]] || {
    echo "Existing $USER_NAME account does not have its expected dedicated primary group" >&2; exit 1;
  }
else
  ((STATE_PREEXISTED == 0)) || { echo 'Host state exists without its dedicated account; refusing to adopt or chown it' >&2; exit 1; }
  useradd --system --user-group --home-dir "$STATE/home" --create-home --shell /usr/sbin/nologin "$USER_NAME"
  install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$STATE" "$STATE/home"
fi
install -d -o root -g root -m 0755 "$PREFIX/releases"
for config_dir in /etc/myagents-host-test /etc/myagents-host-test/credentials; do
  if [[ -e "$config_dir" ]]; then
    [[ -d "$config_dir" && ! -L "$config_dir" && "$(stat -c '%u' "$config_dir")" == 0 \
      && "$(stat -c '%a' "$config_dir")" == 700 ]] || { echo "Unsafe root credential directory: $config_dir" >&2; exit 1; }
  else
    install -d -o root -g root -m 0700 "$config_dir"
  fi
done
DEST="$PREFIX/releases/$RELEASE_ID"
[[ ! -e "$DEST" ]] || { echo "Release id already exists; refusing to replace: $RELEASE_ID" >&2; exit 1; }
CREATED_RELEASE=$DEST
cp -a "$RELEASE_SOURCE" "$DEST"
chown -R root:root "$DEST"
chmod -R go-w "$DEST"
if [[ -f "$UNIT" ]]; then cp -p "$UNIT" "$STAGE/previous-unit"; fi
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then PREVIOUS_ENABLED=1; fi
if [[ -L "$PREFIX/current" ]]; then
  BACKUP_LINK="$STAGE/previous-link"
  cp -P "$PREFIX/current" "$BACKUP_LINK"
  RESTORE_OLD_SERVICE=1
fi
ln -s "releases/$RELEASE_ID" "$PREFIX/current.next"
mv -Tf "$PREFIX/current.next" "$PREFIX/current"
LINK_CHANGED=1
install -d -o root -g root -m 0755 "$PREFIX/bin"
install -o root -g root -m 0755 "$RELEASE_SOURCE/bin/myagents-host" "$PREFIX/bin/myagents-host"
install -d -o root -g root -m 0700 /etc/myagents-host-test
CREDENTIAL_LINE=
CREDENTIAL=/etc/myagents-host-test/credentials/kimi.cred
if [[ -e "$CREDENTIAL" || -L "$CREDENTIAL" ]]; then
  [[ -f "$CREDENTIAL" && ! -L "$CREDENTIAL" && "$(stat -c '%u' "$CREDENTIAL")" == 0 \
    && "$(stat -c '%a' "$CREDENTIAL")" == 600 ]] || { echo 'Kimi credential must be a root-owned mode-0600 regular file' >&2; exit 1; }
  CREDENTIAL_LINE='LoadCredentialEncrypted=kimi:/etc/myagents-host-test/credentials/kimi.cred'
fi
cat > "$STAGE/service" <<UNITFILE
[Unit]
Description=MyAgents local Linux Host (test installation)
After=network.target

[Service]
Type=simple
User=myagents-host-test
Group=myagents-host-test
WorkingDirectory=/opt/myagents-host-test/current/resources
Environment=HOME=/var/lib/myagents-host-test/home
Environment=MYAGENTS_HOST_STATE_DIR=/var/lib/myagents-host-test
Environment=MYAGENTS_HOST_MODE=1
Environment=MYAGENTS_HOST_SOCKET=/run/myagents-host-test/control.sock
Environment=MYAGENTS_HOST_LOCK_HELD=1
RuntimeDirectory=myagents-host-test
RuntimeDirectoryMode=0700
StateDirectory=myagents-host-test
StateDirectoryMode=0700
UMask=0077
ExecStart=/usr/bin/flock --no-fork -n /var/lib/myagents-host-test/host.lock /opt/myagents-host-test/current/resources/nodejs/bin/node /opt/myagents-host-test/current/resources/host-main.mjs --serve
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/myagents-host-test /run/myagents-host-test
$CREDENTIAL_LINE

[Install]
WantedBy=multi-user.target
UNITFILE
install -o root -g root -m 0644 "$STAGE/service" "$UNIT"
UNIT_CHANGED=1
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl start "$SERVICE"
READY=0
for _ in $(seq 1 45); do
  if systemctl is-active --quiet "$SERVICE" && "$PREFIX/bin/myagents-host" doctor >"$STAGE/doctor.json" 2>"$STAGE/doctor.err" \
    && python3 - "$STAGE/doctor.json" <<'PY'
import json, re, sys
try:
    value = json.load(open(sys.argv[1]))
    ready = (re.fullmatch(r'[0-9a-fA-F-]{36}', value.get('hostId', '')) is not None
             and value.get('runtime', {}).get('sdkBinaryPresent') is True
             and value.get('runtime', {}).get('node') == '24.20.0')
except Exception:
    ready = False
raise SystemExit(0 if ready else 1)
PY
  then READY=1; break; fi
  sleep 1
done
if ((READY == 0)); then
  echo 'Service did not become ready with the expected Node and Claude SDK; rolling back' >&2
  cat "$STAGE/doctor.err" >&2 2>/dev/null || true
  exit 1
fi
RESTORE_OLD_SERVICE=0
printf 'Installed unsigned test release %s; service started. Identity data remains under %s.\n' "$RELEASE_ID" "$STATE"
