#!/usr/bin/env bash
# Explicit isolated storage acceptance; never an enrollment/Host installer.
set -euo pipefail
umask 077
[[ ${EUID:-$(id -u)} == 0 ]] || { echo 'Run this isolated acceptance script as root' >&2; exit 1; }
[[ $# == 3 ]] || { echo 'Usage: identity-store-qa.sh ARTIFACT_DIR EXPECTED_SHA256 EXPECTED_SOURCE_COMMIT' >&2; exit 1; }
artifact_dir=$1
expected_sha=$2
expected_source=$3
[[ $expected_sha =~ ^[0-9a-f]{64}$ && $expected_source =~ ^[0-9a-f]{40}$ ]]
snapshot=$(mktemp -d /tmp/myagents-identity-artifact.XXXXXXXX)
encrypted=
trap 'rm -f "${encrypted:-}"; rm -rf "$snapshot"' EXIT
# Retain source directory/file objects without symlink traversal, then verify
# root-private copied bytes. A mutable staging path never becomes executable.
python3 - "$artifact_dir" "$snapshot" <<'PY'
import os,pathlib,stat,sys
source=pathlib.PurePosixPath(sys.argv[1]); assert source.is_absolute()
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_CLOEXEC)
try:
 for part in source.parts[1:]:
  assert part not in ('.','..')
  nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
  os.close(fd);fd=nxt
 for name,limit in [('identity-store-check',64*1024*1024),('source-commit.txt',100)]:
  src=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
  try:
   info=os.fstat(src);assert stat.S_ISREG(info.st_mode) and 0<info.st_size<=limit
   with os.fdopen(os.dup(src),'rb') as inp,open(pathlib.Path(sys.argv[2])/name,'xb') as out:
    copied=0
    while chunk:=inp.read(65536):
     copied+=len(chunk);assert copied<=limit;out.write(chunk)
   os.chmod(pathlib.Path(sys.argv[2])/name,0o400)
  finally:os.close(src)
finally:os.close(fd)
PY
binary_source=$snapshot/identity-store-check
[[ $(cat "$snapshot/source-commit.txt") == "$expected_source" ]]
[[ $(sha256sum "$binary_source" | cut -d ' ' -f1) == "$expected_sha" ]]
python3 - "$binary_source" <<'PY'
import sys
with open(sys.argv[1], 'rb') as f: h=f.read(20)
assert h[:6]==b'\x7fELF\x02\x01' and int.from_bytes(h[18:20], 'little')==62
PY

# A separate OS owner avoids granting the task-executing Node UID access to KEK.
identity_user=myagents-identity-store-test
state_root=/var/lib/myagents-identity-store-test
credential_root=/etc/myagents-identity-store-test
prefix=/opt/myagents-identity-store-test
for directory in "$state_root" "$credential_root" "$prefix" /run/myagents-identity-store-test-provision; do
  [[ ! -L $directory ]] || { echo 'Unsafe isolated storage path' >&2; exit 1; }
done
marker=$prefix/fixture.json
known_fixture=0
if [[ -e $marker || -L $marker ]]; then
  [[ -f $marker && ! -L $marker && $(stat -c %u "$marker") == 0 && $(stat -c %a "$marker") == 600 ]]
  python3 - "$marker" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={'kind':'myagents-isolated-identity-storage','serviceUser':'myagents-identity-store-test'}
PY
  known_fixture=1
fi
if ((known_fixture == 0)); then
  for directory in "$state_root" "$credential_root" "$prefix"; do
    [[ ! -e $directory ]] || { echo 'Existing unmarked path is preserved; review it before provisioning' >&2; exit 1; }
  done
  if getent passwd "$identity_user" >/dev/null; then
    echo 'Existing unmarked OS user is preserved; review it before provisioning' >&2; exit 1
  fi
else
  for directory in "$credential_root" "$prefix"; do
    [[ -d $directory && $(stat -c %u "$directory") == 0 ]]
  done
fi
if [[ -e /run/myagents-identity-store-test-provision ]]; then
  [[ -d /run/myagents-identity-store-test-provision && $(stat -c %u /run/myagents-identity-store-test-provision) == 0 && $(stat -c %a /run/myagents-identity-store-test-provision) == 700 ]]
fi
install -d -o root -g root -m 0700 /run/myagents-identity-store-test-provision
[[ ! -L /run/myagents-identity-store-test-provision/lock ]]
exec 9>/run/myagents-identity-store-test-provision/lock
flock -n 9 || { echo 'Another isolated identity storage acceptance owns this fixture' >&2; exit 1; }
if ! getent passwd "$identity_user" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir "$state_root" --shell /usr/sbin/nologin "$identity_user"
fi
[[ $(getent passwd "$identity_user" | cut -d : -f6) == "$state_root" ]]
[[ $(getent passwd "$identity_user" | cut -d : -f7) == /usr/sbin/nologin ]]
[[ $(id -Gn "$identity_user") == "$identity_user" && $(id -u "$identity_user") != 0 ]]
if [[ -e $state_root ]]; then
  [[ -d $state_root && $(stat -c %u "$state_root") == "$(id -u "$identity_user")" && $(stat -c %a "$state_root") == 700 ]]
fi
install -d -o "$identity_user" -g "$identity_user" -m 0700 "$state_root"
install -d -o root -g root -m 0700 "$credential_root"
install -d -o root -g root -m 0755 "$prefix"
if ((known_fixture == 0)); then
  printf '%s\n' '{"kind":"myagents-isolated-identity-storage","serviceUser":"myagents-identity-store-test"}' > "$marker"
  chmod 0600 "$marker"
fi
binary=$prefix/identity-store-check
if [[ -e $binary || -L $binary ]]; then
  [[ -f $binary && ! -L $binary && $(stat -c %u "$binary") == 0 ]]
  [[ $(sha256sum "$binary" | cut -d ' ' -f1) == "$expected_sha" ]] || { echo 'Existing isolated test binary differs; preserve it for review' >&2; exit 1; }
else
  install -o root -g root -m 0755 "$binary_source" "$binary"
fi
[[ -f $binary && ! -L $binary && $(stat -c '%u:%g:%a:%h' "$binary") == 0:0:755:1 ]]
[[ $(sha256sum "$binary" | cut -d ' ' -f1) == "$expected_sha" ]]
credential=$credential_root/identity-kek.cred
if [[ -e $credential || -L $credential ]]; then
  [[ -f $credential && ! -L $credential && $(stat -c %u "$credential") == 0 && $(stat -c %a "$credential") == 600 ]]
else
  encrypted=$(mktemp "$credential_root/encrypted.XXXXXX")
  # The 32 raw bytes travel only through a private pipe, never disk/argv/env/log.
  python3 -c 'import os,sys;sys.stdout.buffer.write(os.urandom(32))' |
    systemd-creds encrypt --name=identity-kek --with-key=host - "$encrypted"
  chmod 0600 "$encrypted"
  mv -T "$encrypted" "$credential"
  encrypted=
fi
# Separate random KEK for an authentication refusal check, never replacing KEK.
wrong_credential=$credential_root/identity-kek-wrong.cred
if [[ -e $wrong_credential || -L $wrong_credential ]]; then
  [[ -f $wrong_credential && ! -L $wrong_credential && $(stat -c %u "$wrong_credential") == 0 && $(stat -c %a "$wrong_credential") == 600 ]]
else
  encrypted=$(mktemp "$credential_root/encrypted.XXXXXX")
  python3 -c 'import os,sys;sys.stdout.buffer.write(os.urandom(32))' |
    systemd-creds encrypt --name=identity-kek-wrong --with-key=host - "$encrypted"
  chmod 0600 "$encrypted"
  mv -T "$encrypted" "$wrong_credential"
  encrypted=
fi
run_dir=$(mktemp -d "$state_root/acceptance.XXXXXX")
chown "$identity_user:$identity_user" "$run_dir"
store=$run_dir/store
install -d -o "$identity_user" -g "$identity_user" -m 0700 "$store"
scope=$run_dir/scope.json
python3 - "$scope" <<'PY'
import json,sys,uuid
s={'issuer':'https://isolated-storage.myagents.invalid','environment':'development',
   'serviceId':str(uuid.uuid4()),'principalId':'isolated-storage-test-owner',
   'deviceId':str(uuid.uuid4()),'keyGeneration':1}
json.dump(s,open(sys.argv[1],'w'))
json.dump({**s,'keyGeneration':2},open(sys.argv[1]+'.other','w'))
json.dump({**s,'keyGeneration':3},open(sys.argv[1]+'.readonly','w'))
PY
chown "$identity_user:$identity_user" "$scope" "$scope.other" "$scope.readonly"
chmod 0600 "$scope" "$scope.other" "$scope.readonly"

run_step() {
  local step=$1 command=$2 task_scope=${3:-$scope}
  local task_unit="myagents-identity-store-test-$step.service"
  local credential_name=${4:-identity-kek}
  local requested_credential=${6:-$credential_name}
  local extra_properties=()
  if [[ ${5:-} == readonly ]]; then extra_properties+=(--property="ReadOnlyPaths=$store"); fi
  systemd-run --quiet --wait --pipe --collect --unit="$task_unit" \
    --property="User=$identity_user" --property="Group=$identity_user" \
    --property="LoadCredentialEncrypted=$credential_name:$credential_root/$credential_name.cred" \
    --property=UMask=0077 --property=NoNewPrivileges=yes \
    --property=PrivateTmp=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
    --property=PrivateNetwork=yes --property=RestrictAddressFamilies=AF_UNIX \
    --property="ReadWritePaths=$state_root" --property=RuntimeMaxSec=30 \
    --property=TimeoutStopSec=10 --property=KillMode=control-group \
    "${extra_properties[@]}" \
    "$binary" "$command" "$store" "$task_scope" "$task_unit" "$requested_credential"
}
run_step init init > "$run_dir/init.json"
run_step reload load > "$run_dir/reload.json"
run_step repeat-one same > "$run_dir/repeat-one.json" &
repeat_one=$!
run_step repeat-two same > "$run_dir/repeat-two.json" &
repeat_two=$!
repeat_one_status=0
repeat_two_status=0
wait "$repeat_one" || repeat_one_status=$?
wait "$repeat_two" || repeat_two_status=$?
[[ $repeat_one_status == 0 && $repeat_two_status == 0 ]]
if run_step conflict conflict > "$run_dir/conflict.json"; then
  echo 'A different key replaced the existing generation' >&2; exit 1
fi
if run_step other load "$scope.other" > "$run_dir/other.json"; then
  echo 'A different generation unexpectedly loaded a key' >&2; exit 1
fi
run_step after-conflict load > "$run_dir/after-conflict.json"
if run_step missing-credential load "$scope" identity-kek '' identity-kek-missing > "$run_dir/missing-credential.json"; then
  echo 'An absent projected credential unexpectedly loaded a generation' >&2; exit 1
fi
if run_step wrong-key load "$scope" identity-kek-wrong > "$run_dir/wrong-key.json"; then
  echo 'An independent KEK decrypted an existing generation' >&2; exit 1
fi
run_step after-wrong-key load > "$run_dir/after-wrong-key.json"
if run_step readonly init "$scope.readonly" identity-kek readonly > "$run_dir/readonly.json"; then
  echo 'Save unexpectedly succeeded on a read-only storage mount' >&2; exit 1
fi
if run_step readonly-recovery load "$scope.readonly" > "$run_dir/readonly-recovery.json"; then
  echo 'Failed read-only save unexpectedly created a generation' >&2; exit 1
fi
python3 - "$run_dir" <<'PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);load=lambda n:json.load(open(p/(n+'.json')))
fingerprint=load('init')['fingerprint']
assert load('init')['status']=='persisted'
for name in ['reload','repeat-one','repeat-two','after-conflict','after-wrong-key']:
 assert load(name)['fingerprint']==fingerprint
assert load('conflict')=={'status':'error','code':'NETWORK_CREDENTIAL_GENERATION_CONFLICT'}
assert load('other')=={'status':'error','code':'NETWORK_CREDENTIAL_KEY_MISSING'}
assert load('wrong-key')=={'status':'error','code':'NETWORK_CREDENTIAL_CORRUPT'}
assert load('missing-credential')=={'status':'error','code':'NETWORK_CREDENTIAL_STORE_UNAVAILABLE'}
assert load('readonly')['status']=='error' and load('readonly')['code'] in ['NETWORK_CREDENTIAL_STORE_UNAVAILABLE','NETWORK_CREDENTIAL_PERSISTENCE_UNCONFIRMED']
assert load('readonly-recovery')=={'status':'error','code':'NETWORK_CREDENTIAL_KEY_MISSING'}
print('isolated real systemd store: cross-service reload, concurrent same-key saves, conflict and generation isolation passed')
PY
run_step delete delete > "$run_dir/delete.json"
if run_step after-delete load > "$run_dir/after-delete.json"; then
  echo 'Deleted isolated generation remained readable' >&2; exit 1
fi
python3 - "$run_dir" <<'PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1])
assert json.load(open(p/'delete.json'))=={'status':'deleted'}
assert json.load(open(p/'after-delete.json'))=={'status':'error','code':'NETWORK_CREDENTIAL_KEY_MISSING'}
print('isolated deletion persisted; no issuer request was made')
PY
run_step tamper-init init "$scope.other" > "$run_dir/tamper-init.json"
python3 - "$store" <<'PY'
from pathlib import Path
import sys
files=list(Path(sys.argv[1]).glob('key-*.sealed'));assert len(files)==1
with files[0].open('r+b') as f:
 f.seek(-1,2);value=f.read(1);f.seek(-1,2);f.write(bytes([value[0]^1]));f.flush()
 import os;os.fsync(f.fileno())
PY
if run_step tamper load "$scope.other" > "$run_dir/tamper.json"; then
  echo 'Tampered ciphertext unexpectedly loaded' >&2; exit 1
fi
python3 - "$store" <<'PY'
from pathlib import Path
import sys
files=list(Path(sys.argv[1]).glob('key-*.sealed'));assert len(files)==1;files[0].chmod(0o644)
PY
if run_step permissions load "$scope.other" > "$run_dir/permissions.json"; then
  echo 'A broad-permission generation unexpectedly loaded' >&2; exit 1
fi
python3 - "$run_dir" "$store" <<'PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1])
assert json.load(open(p/'tamper.json'))=={'status':'error','code':'NETWORK_CREDENTIAL_CORRUPT'}
assert json.load(open(p/'permissions.json'))=={'status':'error','code':'NETWORK_CREDENTIAL_PATH_UNSAFE'}
files=list(Path(sys.argv[2]).glob('key-*.sealed'));assert len(files)==1;files[0].chmod(0o600)
print('tamper and broad permissions refused; isolated damaged ciphertext retained for inspection')
PY
printf 'source=%s artifact_sha256=%s evidence=%s\n' "$expected_source" "$expected_sha" "$run_dir"
systemctl is-active myagents-host-test nginx docker
