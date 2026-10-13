#!/usr/bin/env python3
"""Install the isolated headless AgentNet test consumer from a pinned CI artifact."""
from __future__ import annotations

import argparse
import fcntl
import grp
import ipaddress
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import uuid

USER = "myagents-host-network-test"
NODE_USER = "myagents-host-test"
PREFIX = pathlib.Path("/opt/myagents-host-network-test")
RELEASES = PREFIX / "releases"
CURRENT = PREFIX / "current"
STATE = pathlib.Path("/var/lib/myagents-host-network-test")
ETC = pathlib.Path("/etc/myagents-host-network-test")
CREDENTIAL = ETC / "identity-kek.cred"
UNIT_NAME = "myagents-host-network-test.service"
UNIT_PATH = pathlib.Path("/etc/systemd/system") / UNIT_NAME
MARKER = PREFIX / "fixture.json"
DEVICE_PIN = PREFIX / "device-id.json"
IDENTITY = pathlib.Path("/var/lib/myagents-host-test/host-identity.json")
ARTIFACT = "myagents-host-network"
MAX_BINARY = 128 * 1024 * 1024
INSTALL_LOCK = pathlib.Path("/run/myagents-host-unified-install.lock")
TMPFILES_PATH = pathlib.Path("/etc/tmpfiles.d/myagents-host-network-test.conf")
OWNED_CONFIG = ETC / "owned-instance.json"
OWNED_CA_DIR = pathlib.Path("/etc/myagents-host-network-test-public")
OWNED_CA = OWNED_CA_DIR / "owned-instance-ca.pem"
LEGACY_OWNED_CA = ETC / "owned-instance-ca.pem"
MANAGEMENT_SOCKET = pathlib.Path("/run/myagents-host-network-test/management.sock")
PROFILE = "myagents-test"
RUN_DIR = pathlib.Path("/run/myagents-host-network-test")

def select_profile(profile: str) -> None:
    global PROFILE, USER, NODE_USER, PREFIX, RELEASES, CURRENT, STATE, ETC, CREDENTIAL
    global UNIT_NAME, UNIT_PATH, MARKER, DEVICE_PIN, IDENTITY, TMPFILES_PATH, OWNED_CONFIG, OWNED_CA, OWNED_CA_DIR, LEGACY_OWNED_CA, MANAGEMENT_SOCKET, RUN_DIR
    profiles = {"myagents-test": ("myagents-host-network-test", "myagents-host-test"),
                "moxbot-test": ("moxbot-host-network-test", "moxbot-host-test")}
    if profile not in profiles:
        raise InstallError("profile must be myagents-test or moxbot-test")
    if profile == PROFILE:
        return
    network, host = profiles[profile]
    PROFILE = profile
    USER, NODE_USER = network, host
    PREFIX = pathlib.Path("/opt") / network
    RELEASES, CURRENT = PREFIX / "releases", PREFIX / "current"
    STATE, ETC = pathlib.Path("/var/lib") / network, pathlib.Path("/etc") / network
    CREDENTIAL = ETC / "identity-kek.cred"
    UNIT_NAME = network + ".service"
    UNIT_PATH = pathlib.Path("/etc/systemd/system") / UNIT_NAME
    MARKER, DEVICE_PIN = PREFIX / "fixture.json", PREFIX / "device-id.json"
    IDENTITY = pathlib.Path("/var/lib") / host / "host-identity.json"
    TMPFILES_PATH = pathlib.Path("/etc/tmpfiles.d") / (network + ".conf")
    OWNED_CONFIG = ETC / "owned-instance.json"
    OWNED_CA_DIR = pathlib.Path("/etc") / (network + "-public")
    OWNED_CA = OWNED_CA_DIR / "owned-instance-ca.pem"
    LEGACY_OWNED_CA = ETC / "owned-instance-ca.pem"
    MANAGEMENT_SOCKET = pathlib.Path("/run") / network / "management.sock"
    RUN_DIR = pathlib.Path("/run") / network


class InstallError(RuntimeError):
    pass


def _acquire_install_lock(expected_uid: int = 0, expected_gid: int = 0) -> int:
    inherited_text = os.environ.get("MYAGENTS_HOST_TRANSACTION_LOCK_FD")
    inherited = inherited_text is not None
    try:
        if inherited:
            if not re.fullmatch(r"[1-9][0-9]*", inherited_text) or int(inherited_text) < 3:
                raise InstallError("inherited transaction lock descriptor is invalid")
            fd = int(inherited_text)
        else:
            fd = os.open(INSTALL_LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        info = os.fstat(fd)
        access_mode = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
        path_info = os.stat(INSTALL_LOCK, follow_symlinks=False)
        if (access_mode != os.O_RDWR or not stat.S_ISREG(info.st_mode)
                or info.st_uid != expected_uid or info.st_gid != expected_gid
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600
                or stat.S_ISLNK(path_info.st_mode) or path_info.st_dev != info.st_dev or path_info.st_ino != info.st_ino
                or path_info.st_uid != expected_uid or path_info.st_gid != expected_gid or path_info.st_nlink != 1
                or stat.S_IMODE(path_info.st_mode) != 0o600):
            raise InstallError("installation transaction lock is unsafe")
        descriptor_flags = fcntl.fcntl(fd, fcntl.F_GETFD)
        if not descriptor_flags & fcntl.FD_CLOEXEC:
            fcntl.fcntl(fd, fcntl.F_SETFD, descriptor_flags | fcntl.FD_CLOEXEC)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        if "fd" in locals():
            os.close(fd)
        raise


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_snapshot(artifact_dir: str, destination: pathlib.Path,
                  expected_sha256: str, expected_commit: str) -> pathlib.Path:
    """Copy fixed artifact names from pinned directory/file descriptors, then verify."""
    source = pathlib.PurePosixPath(artifact_dir)
    if not source.is_absolute() or ".." in source.parts or "." in source.parts:
        raise InstallError("artifact directory must be an absolute normalized path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in source.parts[1:]:
            if not part:
                continue
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        for name, limit in ((ARTIFACT, MAX_BINARY), ("source-commit.txt", 100)):
            src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
            try:
                info = os.fstat(src)
                if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > limit or info.st_nlink != 1:
                    raise InstallError(f"unsafe artifact file: {name}")
                dst_path = destination / name
                out_fd = os.open(dst_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
                try:
                    copied = 0
                    with os.fdopen(os.dup(src), "rb") as inp, os.fdopen(out_fd, "wb", closefd=False) as out:
                        while chunk := inp.read(65536):
                            copied += len(chunk)
                            if copied > limit:
                                raise InstallError(f"artifact file grew beyond limit: {name}")
                            out.write(chunk)
                        out.flush()
                        os.fsync(out.fileno())
                    if copied != info.st_size:
                        raise InstallError(f"artifact file changed while copying: {name}")
                finally:
                    os.close(out_fd)
            finally:
                os.close(src)
    finally:
        os.close(fd)

    source_text = (destination / "source-commit.txt").read_text(encoding="ascii")
    if source_text != expected_commit + "\n":
        raise InstallError("artifact source commit does not match trusted commit")
    binary = destination / ARTIFACT
    if sha256_file(binary) != expected_sha256:
        raise InstallError("artifact SHA-256 does not match trusted digest")
    with binary.open("rb") as f:
        header = f.read(20)
    if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01" or int.from_bytes(header[18:20], "little") != 62:
        raise InstallError("artifact is not a Linux x86_64 ELF")
    os.chmod(binary, 0o500)
    os.chmod(destination / "source-commit.txt", 0o400)
    return binary


def _run(args: list[str], *, input_bytes: bytes | None = None, check: bool = True,
         stdout: int | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(args, input=input_bytes, check=check, stdout=stdout)


def _assert_plain_root_path(path: pathlib.Path) -> None:
    """Reject symlinks in any existing component; installation paths are constants."""
    current = pathlib.Path("/")
    for part in path.parts[1:]:
        current = current / part
        try:
            st = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(st.st_mode):
            raise InstallError(f"refusing symlink in protected path: {current}")


def validate_marker(marker: pathlib.Path, expected_owner: int = 0, expected_group: int = 0) -> bool:
    if not marker.exists() and not marker.is_symlink():
        return False
    st = marker.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != expected_owner or st.st_gid != expected_group or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1:
        raise InstallError("existing fixture marker is unsafe")
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise InstallError("existing fixture marker is invalid") from exc
    expected = {"kind": "myagents-headless-network", "serviceUser": USER}
    if PROFILE != "myagents-test":
        expected["profile"] = PROFILE
    if value != expected:
        raise InstallError("existing fixture marker does not authorize this installation")
    return True


def _check_fixture() -> bool:
    for path in (PREFIX, STATE, ETC, OWNED_CA_DIR, UNIT_PATH, TMPFILES_PATH, DEVICE_PIN, INSTALL_LOCK, OWNED_CONFIG, OWNED_CA, LEGACY_OWNED_CA, RUN_DIR):
        _assert_plain_root_path(path)
    if validate_marker(MARKER):
        return True
    for path in (PREFIX, STATE, ETC, OWNED_CA_DIR, UNIT_PATH, TMPFILES_PATH):
        if path.exists() or path.is_symlink():
            raise InstallError(f"unmarked existing path is preserved: {path}")
    try:
        pwd.getpwnam(USER)
    except KeyError:
        return False
    raise InstallError("unmarked service account already exists; refusing to take it over")


def _validate_existing_user() -> pwd.struct_passwd:
    try:
        entry = pwd.getpwnam(USER)
    except KeyError as exc:
        raise InstallError("marked fixture is missing its service account") from exc
    if (entry.pw_uid == 0 or entry.pw_gid == 0 or grp.getgrgid(entry.pw_gid).gr_name != USER or entry.pw_dir != str(STATE)
            or entry.pw_shell not in ("/usr/sbin/nologin", "/sbin/nologin")):
        raise InstallError("existing service account does not match the isolated fixture")
    if any(USER in group.gr_mem and group.gr_gid != entry.pw_gid for group in grp.getgrall()):
        raise InstallError("service account has unexpected supplementary group access")
    return entry


def _verify_dir(path: pathlib.Path, owner: int, group: int, mode: int) -> None:
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != owner or st.st_gid != group or stat.S_IMODE(st.st_mode) != mode:
        raise InstallError(f"directory has unexpected owner or mode: {path}")


def _create_credential() -> None:
    if CREDENTIAL.exists() or CREDENTIAL.is_symlink():
        st = CREDENTIAL.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_gid != 0 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1:
            raise InstallError("existing identity credential is unsafe")
        return
    fd, tmp_name = tempfile.mkstemp(prefix=".identity-kek.", dir=ETC)
    os.close(fd)
    tmp = pathlib.Path(tmp_name)
    os.chmod(tmp, 0o600)
    try:
        # KEK bytes are piped directly to systemd-creds; they never enter argv/env/file/log.
        raw = os.urandom(32)
        _run(["systemd-creds", "encrypt", "--name=identity-kek", "--with-key=host", "-", str(tmp)], input_bytes=raw)
        del raw
        os.chmod(tmp, 0o600)
        os.replace(tmp, CREDENTIAL)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def _read_identity() -> str:
    node_account = pwd.getpwnam(NODE_USER)
    path = IDENTITY
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        parent_info = os.fstat(fd)
        if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != node_account.pw_uid or stat.S_IMODE(parent_info.st_mode) != 0o700:
            raise InstallError("existing Host state directory is not private to the Node UID")
        identity_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        try:
            st = os.fstat(identity_fd)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != node_account.pw_uid or st.st_gid != node_account.pw_gid
                    or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > 4096):
                raise InstallError("existing Host identity file is unsafe")
            raw = os.read(identity_fd, 4097)
        finally:
            os.close(identity_fd)
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise InstallError("existing Host identity file is invalid") from exc
    if not isinstance(value, dict) or set(value) != {"hostId", "schemaVersion"}:
        raise InstallError("existing Host identity has invalid schema")
    host_id = value.get("hostId")
    if value.get("schemaVersion") != 1 or not is_canonical_uuid(host_id):
        raise InstallError("existing Host identity has invalid schema")
    return host_id


def is_canonical_uuid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def parse_device_pin(data: bytes) -> str:
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise InstallError("device identity pin is invalid") from exc
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "hostId"} or value.get("schemaVersion") != 1 or not is_canonical_uuid(value.get("hostId")):
        raise InstallError("device identity pin has invalid schema")
    return value["hostId"]


def read_device_pin(path: pathlib.Path | None = None, *, owner: int = 0, group: int = 0) -> str:
    # Resolve the default at call time: select_profile() changes DEVICE_PIN.
    path = DEVICE_PIN if path is None else path
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        parent = os.fstat(fd)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner or parent.st_gid != group:
            raise InstallError("device identity pin directory is unsafe")
        try:
            pin_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        except FileNotFoundError as exc:
            raise InstallError("device identity pin is missing; refusing to re-pin") from exc
        try:
            info = os.fstat(pin_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_gid != group or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size <= 0 or info.st_size > 4096:
                raise InstallError("device identity pin is unsafe")
            data = os.read(pin_fd, 4097)
        finally:
            os.close(pin_fd)
    finally:
        os.close(fd)
    return parse_device_pin(data)


def verify_device_pin(current_host_id: str, pin_host_id: str) -> None:
    if not is_canonical_uuid(current_host_id) or current_host_id != pin_host_id:
        raise InstallError("Node Host identity differs from the root-managed device pin")


def create_device_pin(host_id: str, path: pathlib.Path | None = None, *, owner: int = 0, group: int = 0) -> None:
    path = path or DEVICE_PIN
    if not is_canonical_uuid(host_id):
        raise InstallError("cannot pin a noncanonical Host identity")
    if path.exists() or path.is_symlink():
        raise InstallError("device identity pin already exists; refusing to replace it")
    _write_atomic(path, json.dumps({"schemaVersion": 1, "hostId": host_id}, separators=(",", ":")) + "\n", 0o600, owner, group)
    if read_device_pin(path, owner=owner, group=group) != host_id:
        raise InstallError("new device identity pin did not verify")


def _write_atomic(path: pathlib.Path, data: str, mode: int, owner: int = 0, group: int = 0) -> None:
    temp = path.with_name("." + path.name + ".new")
    if temp.exists() or temp.is_symlink():
        raise InstallError(f"unexpected temporary path exists: {temp}")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.fchown(fd, owner, group)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)
    os.replace(temp, path)
    dir_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def validate_owned_origin(value: str) -> str:
    if not isinstance(value, str) or not value.isascii() or any(ord(c) <= 0x20 for c in value):
        raise InstallError("owned instance must be a canonical HTTPS origin")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise InstallError("owned instance must be a canonical HTTPS origin") from exc
    host = parsed.hostname
    if (parsed.scheme != "https" or not host or parsed.username is not None or parsed.password is not None
            or parsed.query or "?" in value or parsed.fragment or "#" in value or parsed.path != ""
            or (port is not None and (not 1 <= port <= 65535 or port == 443))):
        raise InstallError("owned instance must be a canonical HTTPS origin without credentials, path, query, or fragment")
    if ":" in host:
        try:
            host = f"[{ipaddress.IPv6Address(host).compressed}]"
        except ipaddress.AddressValueError as exc:
            raise InstallError("owned instance host is invalid") from exc
    else:
        if not re.fullmatch(r"[A-Za-z0-9.-]+", host):
            raise InstallError("owned instance host is invalid")
        host = host.lower()
    canonical_authority = host + (f":{port}" if port is not None else "")
    canonical = f"https://{canonical_authority}"
    if value != canonical:
        raise InstallError("owned instance must use the canonical HTTPS origin spelling")
    return canonical


def read_ca_source(path_text: str, *, owner: int = 0, group: int = 0) -> bytes:
    path = pathlib.Path(path_text)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise InstallError("public TLS CA path must be absolute and canonical")
    _assert_plain_root_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_gid != group or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) not in (0o644, 0o640) or info.st_size <= 0 or info.st_size > 1024 * 1024):
            raise InstallError("public TLS CA file must be a bounded root-owned regular file")
        data = bytearray()
        while len(data) <= 1024 * 1024:
            chunk = os.read(fd, min(65536, 1024 * 1024 + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if (len(data) != info.st_size or after.st_dev != info.st_dev or after.st_ino != info.st_ino
                or after.st_size != info.st_size):
            raise InstallError("public TLS CA changed while being read")
        return bytes(data)
    finally:
        os.close(fd)


def owned_config_text(args: argparse.Namespace, host_uid: int, network_gid: int,
                      *, ca_path: pathlib.Path | None = None) -> str | None:
    if not args.owned_instance:
        if args.public_tls_ca_file or args.management_socket or args.management_host_uid:
            raise InstallError("owned TLS and management IPC options require --owned-instance")
        return None
    origin = validate_owned_origin(args.owned_instance)
    ipc_values = (args.management_socket, args.management_host_uid)
    if any(value is not None for value in ipc_values):
        if any(value is None for value in ipc_values):
            raise InstallError("management IPC requires the fixed socket and Host UID together")
        if pathlib.Path(args.management_socket) != MANAGEMENT_SOCKET or args.management_host_uid != host_uid:
            raise InstallError("management IPC must use the fixed socket and dedicated Node Host UID")
    if args.public_tls_ca_file:
        read_ca_source(args.public_tls_ca_file)
    return json.dumps({
        "schemaVersion": 1,
        "ownedInstance": origin,
        "caFile": str(ca_path or OWNED_CA) if args.public_tls_ca_file or ca_path else None,
        "managementSocket": str(MANAGEMENT_SOCKET) if args.management_socket else None,
        "managementHostUid": host_uid if args.management_socket else None,
        "managementGid": network_gid if args.management_socket else None,
    }, separators=(",", ":")) + "\n"


def _verify_root_public_file(path: pathlib.Path, *, mode: int = 0o644,
                            owner: int = 0, group: int = 0) -> bytes:
    _assert_plain_root_path(path)
    parent = path.parent.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner or parent.st_gid != group
            or stat.S_IMODE(parent.st_mode) != 0o755):
        raise InstallError("public TLS CA directory is unsafe")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_gid != group
                or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode
                or info.st_size <= 0 or info.st_size > 1024 * 1024):
            raise InstallError("public TLS CA file is unsafe")
        data = bytearray()
        while len(data) <= 1024 * 1024:
            chunk = os.read(fd, min(65536, 1024 * 1024 + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if (len(data) != info.st_size or after.st_dev != info.st_dev or after.st_ino != info.st_ino
                or after.st_size != info.st_size):
            raise InstallError("public TLS CA changed while being read")
        return bytes(data)
    finally:
        os.close(fd)


def _service_is_stopped(unit: str) -> bool:
    try:
        result = subprocess.run(["systemctl", "show", unit, "--property=ActiveState", "--property=MainPID", "--no-pager"],
                                check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0:
        return False
    values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if "=" not in line:
            return False
        key, value = line.split("=", 1)
        if key not in {"ActiveState", "MainPID"} or key in values:
            return False
        values[key] = value
    return values == {"ActiveState": "inactive", "MainPID": "0"}


def _migrate_legacy_public_ca(host_id: str, source_commit: str, args: argparse.Namespace,
                              node_uid: int, network_gid: int, *, ca_bytes: bytes | None,
                              root_uid: int = 0, root_gid: int = 0) -> bool:
    """Migrate only the exact legacy installation, while its service is stopped."""
    if not args.public_tls_ca_file or ca_bytes is None:
        raise InstallError("legacy CA migration requires an explicitly supplied CA file")
    if not (OWNED_CONFIG.exists() and not OWNED_CONFIG.is_symlink()):
        return False
    try:
        legacy_args = argparse.Namespace(**vars(args))
        legacy_args.public_tls_ca_file = str(LEGACY_OWNED_CA)
        legacy_text = owned_config_text(legacy_args, node_uid, network_gid, ca_path=LEGACY_OWNED_CA)
        current_text = OWNED_CONFIG.read_text(encoding="utf-8")
    except (OSError, UnicodeError, InstallError):
        return False
    config_st = OWNED_CONFIG.lstat()
    if (not stat.S_ISREG(config_st.st_mode) or config_st.st_uid != root_uid or config_st.st_gid != root_gid
            or config_st.st_nlink != 1 or stat.S_IMODE(config_st.st_mode) != 0o600
            or current_text != legacy_text):
        return False
    legacy_bytes = read_ca_source(str(LEGACY_OWNED_CA), owner=root_uid, group=root_gid)
    if legacy_bytes != ca_bytes:
        raise InstallError("legacy CA differs from the supplied certificate; preserve it for operator review")
    current = CURRENT.lstat() if CURRENT.exists() or CURRENT.is_symlink() else None
    if (current is None or not stat.S_ISLNK(current.st_mode)
            or os.readlink(CURRENT) != f"releases/{source_commit}"):
        return False
    unit_text = _unit_text(host_id, json.loads(legacy_text))
    unit_st = UNIT_PATH.lstat() if UNIT_PATH.exists() or UNIT_PATH.is_symlink() else None
    if (unit_st is None or not stat.S_ISREG(unit_st.st_mode) or unit_st.st_uid != root_uid
            or unit_st.st_gid != root_gid or unit_st.st_nlink != 1
            or stat.S_IMODE(unit_st.st_mode) != 0o644
            or UNIT_PATH.read_text(encoding="utf-8") != unit_text):
        raise InstallError("legacy CA migration requires the exact installer-owned service unit")
    if not _service_is_stopped(UNIT_NAME):
        raise InstallError("owned network service must be confirmed inactive before CA migration")

    public_dir_created = False
    ca_created = False
    migrated_args = argparse.Namespace(**vars(args))
    migrated_args.public_tls_ca_file = str(LEGACY_OWNED_CA)
    expected_text = owned_config_text(migrated_args, node_uid, network_gid, ca_path=OWNED_CA)
    new_unit = _unit_text(host_id, json.loads(expected_text))
    try:
        if not OWNED_CA_DIR.exists():
            os.mkdir(OWNED_CA_DIR, 0o755)
            os.chown(OWNED_CA_DIR, root_uid, root_gid)
            os.chmod(OWNED_CA_DIR, 0o755)
            public_dir_created = True
        _verify_dir(OWNED_CA_DIR, root_uid, root_gid, 0o755)
        if OWNED_CA.exists() or OWNED_CA.is_symlink():
            if _verify_root_public_file(OWNED_CA, owner=root_uid, group=root_gid) != legacy_bytes:
                raise InstallError("public CA destination has different bytes; preserve it for review")
        else:
            _write_atomic(OWNED_CA, legacy_bytes.decode("ascii"), 0o644, root_uid, root_gid)
            ca_created = True
        _write_atomic(OWNED_CONFIG, expected_text, 0o600, root_uid, root_gid)
        _write_atomic(UNIT_PATH, new_unit, 0o644, root_uid, root_gid)
        _run(["systemctl", "daemon-reload"])
    except BaseException:
        _write_atomic(OWNED_CONFIG, legacy_text, 0o600, root_uid, root_gid)
        _write_atomic(UNIT_PATH, unit_text, 0o644, root_uid, root_gid)
        _run(["systemctl", "daemon-reload"], check=False)
        if ca_created:
            OWNED_CA.unlink(missing_ok=True)
        if public_dir_created:
            try:
                OWNED_CA_DIR.rmdir()
            except OSError:
                pass
        raise
    return True


def _unit_text(host_id: str, owned: dict | None = None) -> str:
    status_dir = RUN_DIR
    status_file = status_dir / "status.json"
    extra = ""
    if owned:
        extra = f" --owned-instance {owned['ownedInstance']}"
        if owned["caFile"]:
            extra += f" --public-tls-ca-file {owned['caFile']}"
        if owned["managementSocket"]:
            extra += (f" --management-socket {owned['managementSocket']}"
                      f" --management-host-uid {owned['managementHostUid']}"
                      f" --management-gid {owned['managementGid']}")
    return f"""[Unit]
Description=MyAgents headless AgentNet test connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={USER}
Group={USER}
Environment=HOME={STATE}/home
ExecStart={CURRENT}/{ARTIFACT} run --state-dir {STATE} --unit {UNIT_NAME} --credential identity-kek --device-id {host_id} --device-name Linux-Host --status-file {status_file}{extra}
LoadCredentialEncrypted=identity-kek:{CREDENTIAL}
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths={STATE} {status_dir}
KillMode=control-group
Restart=on-failure

[Install]
WantedBy=multi-user.target
"""


def _runtime_group(network_account: pwd.struct_passwd, node_account: pwd.struct_passwd,
                   owned: dict | None) -> int:
    # status.rs replaces status.json with a sibling temp file. That file inherits
    # the setgid directory's group and must match the existing status inode.
    # Only the owned IPC profile grants Node the network service's group.
    if owned and owned["managementSocket"]:
        return network_account.pw_gid
    return node_account.pw_gid


def _tmpfiles_text(network_account: pwd.struct_passwd, node_account: pwd.struct_passwd,
                   owned: dict | None = None) -> str:
    runtime_gid = _runtime_group(network_account, node_account, owned)
    return (f"d {RUN_DIR} 2750 {network_account.pw_uid} {runtime_gid} - -\n"
            f"f {RUN_DIR}/status.json 0640 {network_account.pw_uid} {runtime_gid} - -\n")


def install(args: argparse.Namespace) -> None:
    select_profile(getattr(args, "profile", "myagents-test"))
    if os.geteuid() != 0:
        raise InstallError("run the installer as root")
    if not sys.platform.startswith("linux") or os.uname().machine not in ("x86_64", "amd64"):
        raise InstallError("this test installer supports Linux x86_64 only")
    if not re.fullmatch(r"[0-9a-f]{64}", args.sha256) or not re.fullmatch(r"[0-9a-f]{40}", args.source_commit):
        raise InstallError("trusted SHA-256 and 40-character source commit are required")
    with tempfile.TemporaryDirectory(prefix="myagents-network-artifact-") as temp:
        os.chmod(temp, 0o700)
        snap = pathlib.Path(temp)
        snap_binary = copy_snapshot(args.artifact_dir, snap, args.sha256, args.source_commit)
        fixture = _check_fixture()
        # Lock must cover all mutations and rollback; use an inherited FD held here.
        lock_fd = _acquire_install_lock()
        try:
            _check_fixture()
            # Validate all read-only external inputs before creating the service UID.
            host_id = _read_identity()
            if fixture:
                verify_device_pin(host_id, read_device_pin())
            node_account = pwd.getpwnam(NODE_USER)
            if not args.owned_instance:
                if args.public_tls_ca_file or args.management_socket or args.management_host_uid:
                    raise InstallError("owned TLS and management IPC options require --owned-instance")
            else:
                validate_owned_origin(args.owned_instance)
                ipc_values = (args.management_socket, args.management_host_uid)
                if any(value is not None for value in ipc_values):
                    if any(value is None for value in ipc_values):
                        raise InstallError("management IPC requires the fixed socket and Host UID together")
                    if pathlib.Path(args.management_socket) != MANAGEMENT_SOCKET or args.management_host_uid != node_account.pw_uid:
                        raise InstallError("management IPC must use the fixed socket and dedicated Node Host UID")
            ca_bytes = read_ca_source(args.public_tls_ca_file) if args.public_tls_ca_file else None
            if not fixture:
                _run(["useradd", "--system", "--user-group", "--no-create-home", "--home-dir", str(STATE), "--shell", "/usr/sbin/nologin", USER])
            account = _validate_existing_user()
            expected_owned_text = owned_config_text(args, node_account.pw_uid, account.pw_gid)
            owned_value = json.loads(expected_owned_text) if expected_owned_text else None
            legacy_expected = None
            legacy_migration = False
            if expected_owned_text is None:
                if OWNED_CONFIG.exists() or OWNED_CONFIG.is_symlink():
                    raise InstallError("existing owned-instance configuration cannot be removed implicitly")
            elif OWNED_CONFIG.exists() or OWNED_CONFIG.is_symlink():
                cfg_st = OWNED_CONFIG.lstat()
                existing_config = OWNED_CONFIG.read_text(encoding="utf-8")
                if args.owned_instance and args.public_tls_ca_file:
                    legacy_args = argparse.Namespace(**vars(args))
                    legacy_args.public_tls_ca_file = str(LEGACY_OWNED_CA)
                    legacy_expected = owned_config_text(legacy_args, node_account.pw_uid,
                                                        pwd.getpwnam(USER).pw_gid,
                                                        ca_path=LEGACY_OWNED_CA)
                    legacy_migration = existing_config == legacy_expected
                if (not stat.S_ISREG(cfg_st.st_mode) or cfg_st.st_uid != 0 or cfg_st.st_gid != 0
                        or cfg_st.st_nlink != 1 or stat.S_IMODE(cfg_st.st_mode) != 0o600
                        or (existing_config != expected_owned_text and existing_config != legacy_expected)):
                    raise InstallError("existing owned-instance configuration differs or is unsafe")
            if ca_bytes is not None and (OWNED_CA.exists() or OWNED_CA.is_symlink()):
                if _verify_root_public_file(OWNED_CA) != ca_bytes:
                    raise InstallError("existing owned-instance CA differs; preserve it for operator review")

            for path, parent_mode in ((PREFIX, 0o755), (RELEASES, 0o755), (STATE, 0o700), (ETC, 0o700)):
                if not path.exists():
                    os.mkdir(path, parent_mode)
                    os.chown(path, 0 if path != STATE else account.pw_uid, 0 if path != STATE else account.pw_gid)
                    os.chmod(path, parent_mode)
            _verify_dir(PREFIX, 0, 0, 0o755)
            _verify_dir(RELEASES, 0, 0, 0o755)
            _verify_dir(STATE, account.pw_uid, account.pw_gid, 0o700)
            _verify_dir(ETC, 0, 0, 0o700)
            home_dir = STATE / "home"
            if not home_dir.exists():
                os.mkdir(home_dir, 0o700)
                os.chown(home_dir, account.pw_uid, account.pw_gid)
                os.chmod(home_dir, 0o700)
            _verify_dir(home_dir, account.pw_uid, account.pw_gid, 0o700)
            if fixture:
                _verify_dir(STATE, account.pw_uid, account.pw_gid, 0o700)
            else:
                create_device_pin(host_id)
                marker_tmp = PREFIX / ".fixture-new"
                marker_value = {"kind": "myagents-headless-network", "serviceUser": USER}
                if PROFILE != "myagents-test":
                    marker_value["profile"] = PROFILE
                marker_tmp.write_text(json.dumps(marker_value) + "\n", encoding="utf-8")
                os.chown(marker_tmp, 0, 0)
                os.chmod(marker_tmp, 0o600)
                os.replace(marker_tmp, MARKER)

            release = RELEASES / args.source_commit
            release_binary = release / ARTIFACT
            release_exists = release.exists() or release.is_symlink()
            if release_exists:
                st = release.lstat()
                if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_gid != 0 or stat.S_IMODE(st.st_mode) != 0o755:
                    raise InstallError("existing release directory is unsafe")
                bst = release_binary.lstat() if release_binary.exists() or release_binary.is_symlink() else None
                if bst is None or not stat.S_ISREG(bst.st_mode) or bst.st_uid != 0 or bst.st_gid != 0 or bst.st_nlink != 1 or stat.S_IMODE(bst.st_mode) != 0o755 or sha256_file(release_binary) != args.sha256:
                    raise InstallError("release commit already exists with different or unsafe bytes")

            old_current: str | None = None
            if CURRENT.exists() or CURRENT.is_symlink():
                current_st = CURRENT.lstat()
                if not stat.S_ISLNK(current_st.st_mode):
                    raise InstallError("current release pointer is not a symlink")
                old_current = os.readlink(CURRENT)
                if not re.fullmatch(r"releases/[0-9a-f]{40}", old_current):
                    raise InstallError("current release pointer is outside managed release paths")
            if old_current == f"releases/{args.source_commit}":
                if expected_owned_text is None:
                    if OWNED_CONFIG.exists() or OWNED_CONFIG.is_symlink():
                        raise InstallError("existing owned-instance configuration differs; refusing to clear it")
                elif not OWNED_CONFIG.exists() or OWNED_CONFIG.is_symlink():
                    raise InstallError("same release owned-instance configuration differs")
                else:
                    config_text = OWNED_CONFIG.read_text(encoding="utf-8")
                    if config_text != expected_owned_text and not (legacy_migration and config_text == legacy_expected):
                        raise InstallError("same release owned-instance configuration differs")
                credential_st = CREDENTIAL.lstat() if CREDENTIAL.exists() or CREDENTIAL.is_symlink() else None
                if credential_st is None or not stat.S_ISREG(credential_st.st_mode) or credential_st.st_uid != 0 or credential_st.st_gid != 0 or credential_st.st_nlink != 1 or stat.S_IMODE(credential_st.st_mode) != 0o600:
                    raise InstallError("existing identity credential is unsafe")
                if not UNIT_PATH.exists() or UNIT_PATH.is_symlink():
                    raise InstallError("same release is missing its managed service unit")
                unit_st = UNIT_PATH.lstat()
                current_unit_text = UNIT_PATH.read_text(encoding="utf-8")
                legacy_unit_value = json.loads(legacy_expected) if legacy_migration else None
                acceptable_units = {_unit_text(host_id, owned_value)}
                if legacy_migration:
                    acceptable_units.add(_unit_text(host_id, legacy_unit_value))
                if (not stat.S_ISREG(unit_st.st_mode) or unit_st.st_uid != 0 or unit_st.st_gid != 0
                        or unit_st.st_nlink != 1 or stat.S_IMODE(unit_st.st_mode) != 0o644
                        or current_unit_text not in acceptable_units):
                    raise InstallError("same release service unit has changed")
                node_account = pwd.getpwnam(NODE_USER)
                expected_tmpfiles = _tmpfiles_text(account, node_account, owned_value)
                tmpfiles_path = TMPFILES_PATH
                if not tmpfiles_path.exists() or tmpfiles_path.is_symlink():
                    raise InstallError("same release is missing its managed tmpfiles rule")
                tmpfiles_st = tmpfiles_path.lstat()
                if not stat.S_ISREG(tmpfiles_st.st_mode) or tmpfiles_st.st_uid != 0 or tmpfiles_st.st_gid != 0 or tmpfiles_st.st_nlink != 1 or stat.S_IMODE(tmpfiles_st.st_mode) != 0o644 or tmpfiles_path.read_text(encoding="utf-8") != expected_tmpfiles:
                    raise InstallError("same release tmpfiles rule has changed")
                if legacy_migration:
                    if ca_bytes is None:
                        raise InstallError("legacy CA migration requires an explicitly supplied CA file")
                    if not _migrate_legacy_public_ca(host_id, args.source_commit, args, node_account.pw_uid,
                                                     account.pw_gid, ca_bytes=ca_bytes):
                        raise InstallError("legacy CA migration did not complete; no success is reported")
                print(json.dumps({"status": "ok", "result": "same-release-verified", "sourceCommit": args.source_commit}))
                return

            if fixture and _run(["systemctl", "is-active", "--quiet", UNIT_NAME], check=False).returncode == 0:
                raise InstallError("service is active; back up and stop it before installing a different release")

            if not release_exists:
                stage = RELEASES / (".stage-" + args.source_commit)
                if stage.exists() or stage.is_symlink():
                    raise InstallError("staging directory already exists; preserve it for review")
                os.mkdir(stage, 0o700)
                stage_binary = stage / ARTIFACT
                shutil.copyfile(snap_binary, stage_binary, follow_symlinks=False)
                os.chown(stage_binary, 0, 0)
                os.chmod(stage_binary, 0o755)
                if sha256_file(stage_binary) != args.sha256:
                    raise InstallError("installed release changed during copy")
                os.chmod(stage, 0o755)
                os.rename(stage, release)

            _create_credential()
            # The directory and replaceable status inode share a group so status.rs's
            # same-directory atomic replacement preserves the expected group.
            status_dir = RUN_DIR
            runtime_gid = _runtime_group(account, node_account, owned_value)
            if not status_dir.exists():
                os.mkdir(status_dir, 0o2750)
                os.chown(status_dir, account.pw_uid, runtime_gid)
                os.chmod(status_dir, 0o2750)
            _verify_dir(status_dir, account.pw_uid, runtime_gid, 0o2750)
            status_file = status_dir / "status.json"
            if not status_file.exists() and not status_file.is_symlink():
                fd = os.open(status_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
                os.close(fd)
                os.chown(status_file, account.pw_uid, runtime_gid)
                os.chmod(status_file, 0o640)
            else:
                status_st = status_file.lstat()
                if not stat.S_ISREG(status_st.st_mode) or status_st.st_uid != account.pw_uid or status_st.st_gid != runtime_gid or stat.S_IMODE(status_st.st_mode) != 0o640 or status_st.st_nlink != 1:
                    raise InstallError("existing runtime status file is unsafe")

            tmpfiles_path = TMPFILES_PATH
            tmpfiles_text = _tmpfiles_text(account, node_account, owned_value)
            previous_tmpfiles: str | None = None
            if tmpfiles_path.exists() or tmpfiles_path.is_symlink():
                existing = tmpfiles_path.lstat()
                if not stat.S_ISREG(existing.st_mode) or existing.st_uid != 0 or existing.st_nlink != 1 or stat.S_IMODE(existing.st_mode) != 0o644 or tmpfiles_path.read_text(encoding="utf-8") != tmpfiles_text:
                    raise InstallError("existing tmpfiles rule differs; preserve it for review")
                previous_tmpfiles = tmpfiles_text
            else:
                _write_atomic(tmpfiles_path, tmpfiles_text, 0o644)

            unit_tmp = UNIT_PATH.with_name("." + UNIT_NAME + ".tmp")
            unit_text = _unit_text(host_id, owned_value)
            previous_unit: str | None = None
            if UNIT_PATH.exists() or UNIT_PATH.is_symlink():
                unit_st = UNIT_PATH.lstat()
                if not stat.S_ISREG(unit_st.st_mode) or unit_st.st_uid != 0 or unit_st.st_nlink != 1 or stat.S_IMODE(unit_st.st_mode) != 0o644:
                    raise InstallError("existing service unit is unsafe")
                # Only replace the exact unit format emitted by this installer.
                previous = UNIT_PATH.read_text(encoding="utf-8")
                if "Description=MyAgents headless AgentNet test connector\n" not in previous or f"User={USER}\n" not in previous:
                    raise InstallError("existing service unit is not owned by this installer")
                previous_unit = previous
            _write_atomic(UNIT_PATH, unit_text, 0o644)
            previous_owned_config = OWNED_CONFIG.read_text(encoding="utf-8") if OWNED_CONFIG.exists() else None
            ca_created = False
            ca_dir_created = False

            try:
                if expected_owned_text is not None and previous_owned_config is None:
                    _write_atomic(OWNED_CONFIG, expected_owned_text, 0o600)
                if ca_bytes is not None and not OWNED_CA.exists():
                    if not OWNED_CA_DIR.exists():
                        os.mkdir(OWNED_CA_DIR, 0o755)
                        os.chown(OWNED_CA_DIR, 0, 0)
                        os.chmod(OWNED_CA_DIR, 0o755)
                        ca_dir_created = True
                    _verify_dir(OWNED_CA_DIR, 0, 0, 0o755)
                    try:
                        ca_text = ca_bytes.decode("ascii")
                    except UnicodeDecodeError as exc:
                        raise InstallError("public TLS CA must be ASCII PEM") from exc
                    _write_atomic(OWNED_CA, ca_text, 0o644)
                    ca_created = True
                link_tmp = PREFIX / ".current-new"
                if link_tmp.exists() or link_tmp.is_symlink():
                    raise InstallError("unexpected current staging path exists")
                os.symlink(pathlib.Path("releases") / args.source_commit, link_tmp)
                os.replace(link_tmp, CURRENT)
                _run(["systemctl", "daemon-reload"])
            except BaseException:
                if old_current is None:
                    CURRENT.unlink(missing_ok=True)
                else:
                    restore_link = PREFIX / ".current-rollback"
                    restore_link.unlink(missing_ok=True)
                    os.symlink(old_current, restore_link)
                    os.replace(restore_link, CURRENT)
                if previous_unit is None:
                    UNIT_PATH.unlink(missing_ok=True)
                else:
                    _write_atomic(UNIT_PATH, previous_unit, 0o644)
                if previous_tmpfiles is None:
                    tmpfiles_path.unlink(missing_ok=True)
                if previous_owned_config is None:
                    OWNED_CONFIG.unlink(missing_ok=True)
                else:
                    _write_atomic(OWNED_CONFIG, previous_owned_config, 0o600)
                if ca_created:
                    OWNED_CA.unlink(missing_ok=True)
                if ca_dir_created:
                    try:
                        OWNED_CA_DIR.rmdir()
                    except OSError:
                        pass
                _run(["systemctl", "daemon-reload"], check=False)
                raise
            print(json.dumps({"status": "ok", "result": "installed", "sourceCommit": args.source_commit,
                              "unit": UNIT_NAME, "activation": "explicit operator action required"}))
        finally:
            os.close(lock_fd)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_dir", help="absolute CI artifact directory")
    parser.add_argument("sha256", help="independently trusted artifact binary SHA-256")
    parser.add_argument("source_commit", help="independently trusted 40-character source commit")
    parser.add_argument("--profile", choices=("myagents-test", "moxbot-test"), default="myagents-test")
    parser.add_argument("--owned-instance", help="explicit HTTPS origin for an owned AgentNet instance")
    parser.add_argument("--public-tls-ca-file", help="optional root-owned PEM CA for the owned instance")
    parser.add_argument("--management-socket", help="fixed owned IPC socket path; requires the Host UID")
    parser.add_argument("--management-host-uid", type=int, help="dedicated Node Host UID for IPC peer checking")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        install(parse_args())
    except (InstallError, OSError, subprocess.CalledProcessError, ValueError, KeyError) as exc:
        print(json.dumps({"status": "error", "code": "NETWORK_INSTALL_REJECTED", "detail": str(exc)}), file=sys.stderr)
        sys.exit(1)
