#!/usr/bin/env python3
"""Fixed root operator controls for the isolated headless AgentNet test owner."""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse

USER = "myagents-host-network-test"
GROUP = USER
NODE_USER = "myagents-host-test"
NODE_IDENTITY = pathlib.Path("/var/lib/myagents-host-test/host-identity.json")
STATE = pathlib.Path("/var/lib/myagents-host-network-test")
CREDENTIAL = pathlib.Path("/etc/myagents-host-network-test/identity-kek.cred")
DAEMON_UNIT = "myagents-host-network-test.service"
AUTH_UNIT = "myagents-host-network-test-auth.service"
BIN = pathlib.Path("/opt/myagents-host-network-test/current/myagents-host-network")
PIN_PATH = pathlib.Path("/opt/myagents-host-network-test/device-id.json")
STATUS_FILE = pathlib.Path("/run/myagents-host-network-test/status.json")
OWNED_CONFIG = pathlib.Path("/etc/myagents-host-network-test/owned-instance.json")
OWNED_CA_DIR = pathlib.Path("/etc/myagents-host-network-test-public")
OWNED_CA = OWNED_CA_DIR / "owned-instance-ca.pem"
HOST_UNIT = pathlib.Path("/etc/systemd/system/myagents-host-test.service")
HOST_DROPIN_DIR = pathlib.Path("/etc/systemd/system/myagents-host-test.service.d")
HOST_DROPIN = HOST_DROPIN_DIR / "owned-management.conf"
MANAGEMENT_SOCKET = pathlib.Path("/run/myagents-host-network-test/management.sock")
PROFILE = "myagents-test"

def select_profile(profile: str) -> None:
    global PROFILE, USER, GROUP, NODE_USER, NODE_IDENTITY, STATE, CREDENTIAL, DAEMON_UNIT, AUTH_UNIT, BIN, PIN_PATH, STATUS_FILE
    global OWNED_CONFIG, OWNED_CA, OWNED_CA_DIR, HOST_UNIT, HOST_DROPIN_DIR, HOST_DROPIN, MANAGEMENT_SOCKET, DAEMON_DROPIN_DIR, JOIN_DROPIN
    profiles = {"myagents-test": ("myagents-host-network-test", "myagents-host-test"),
                "moxbot-test": ("moxbot-host-network-test", "moxbot-host-test")}
    if profile not in profiles:
        raise ValueError("profile must be myagents-test or moxbot-test")
    if profile == PROFILE:
        return
    network, host = profiles[profile]
    PROFILE, USER, GROUP, NODE_USER = profile, network, network, host
    NODE_IDENTITY = pathlib.Path("/var/lib") / host / "host-identity.json"
    STATE = pathlib.Path("/var/lib") / network
    CREDENTIAL = pathlib.Path("/etc") / network / "identity-kek.cred"
    DAEMON_UNIT = network + ".service"
    AUTH_UNIT = network + "-auth.service"
    BIN = pathlib.Path("/opt") / network / "current" / "myagents-host-network"
    PIN_PATH = pathlib.Path("/opt") / network / "device-id.json"
    STATUS_FILE = pathlib.Path("/run") / network / "status.json"
    OWNED_CONFIG = pathlib.Path("/etc") / network / "owned-instance.json"
    OWNED_CA_DIR = pathlib.Path("/etc") / (network + "-public")
    OWNED_CA = OWNED_CA_DIR / "owned-instance-ca.pem"
    HOST_UNIT = pathlib.Path("/etc/systemd/system") / (host + ".service")
    HOST_DROPIN_DIR = pathlib.Path("/etc/systemd/system") / (host + ".service.d")
    HOST_DROPIN = HOST_DROPIN_DIR / "owned-management.conf"
    MANAGEMENT_SOCKET = pathlib.Path("/run") / network / "management.sock"
    DAEMON_DROPIN_DIR = pathlib.Path("/etc/systemd/system") / (network + ".service.d")
    JOIN_DROPIN = DAEMON_DROPIN_DIR / "one-shot-join.conf"
DAEMON_DROPIN_DIR = pathlib.Path("/etc/systemd/system/myagents-host-network-test.service.d")
JOIN_DROPIN = DAEMON_DROPIN_DIR / "one-shot-join.conf"


def host_id() -> str:
    node = pwd.getpwnam(NODE_USER)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in NODE_IDENTITY.parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        parent_info = os.fstat(fd)
        if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != node.pw_uid or stat.S_IMODE(parent_info.st_mode) != 0o700:
            raise ValueError("existing Host state directory is not private to the Node UID")
        identity_fd = os.open(NODE_IDENTITY.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        try:
            info = os.fstat(identity_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != node.pw_uid or info.st_gid != node.pw_gid
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
                raise ValueError("existing Host identity file is unsafe")
            data = os.read(identity_fd, 4097)
        finally:
            os.close(identity_fd)
    finally:
        os.close(fd)
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("existing Host identity file is invalid") from exc
    if not isinstance(value, dict) or set(value) != {"hostId", "schemaVersion"}:
        raise ValueError("existing Host identity has invalid schema")
    result = value.get("hostId")
    if value.get("schemaVersion") != 1 or not isinstance(result, str) or canonical_uuid(result) != result:
        raise ValueError("existing Host identity has invalid schema")
    return result


def canonical_uuid(value: str) -> str | None:
    import uuid
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        return None


def pinned_host_id() -> str:
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in PIN_PATH.parts[1:-1]:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        parent = os.fstat(fd)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_gid != 0 or stat.S_IMODE(parent.st_mode) != 0o755:
            raise ValueError("root-managed device pin directory is unsafe")
        pin_fd = os.open(PIN_PATH.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
        try:
            info = os.fstat(pin_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size <= 0 or info.st_size > 4096:
                raise ValueError("root-managed device pin is unsafe")
            raw = os.read(pin_fd, 4097)
        finally:
            os.close(pin_fd)
    except FileNotFoundError as exc:
        raise ValueError("root-managed device pin is missing; refusing to re-pin") from exc
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("root-managed device pin is invalid") from exc
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "hostId"} or value.get("schemaVersion") != 1:
        raise ValueError("root-managed device pin has invalid schema")
    result = value.get("hostId")
    if not isinstance(result, str) or canonical_uuid(result) != result:
        raise ValueError("root-managed device pin has invalid UUID")
    return result


def verified_host_id() -> str:
    current = host_id()
    pinned = pinned_host_id()
    if current != pinned:
        raise ValueError("Node Host identity differs from the root-managed device pin")
    return pinned


def _read_root_unit(path: pathlib.Path) -> str | None:
    if not os.path.lexists(path):
        return None
    before = path.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0
            or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o644
            or before.st_size > 64 * 1024):
        raise ValueError("managed service unit is unsafe")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev != before.st_dev or opened.st_ino != before.st_ino
                or not stat.S_ISREG(opened.st_mode) or opened.st_uid != 0 or opened.st_gid != 0
                or opened.st_nlink != 1 or opened.st_size > 64 * 1024):
            raise ValueError("managed service unit changed while being read")
        data = bytearray()
        while len(data) <= 64 * 1024:
            chunk = os.read(fd, min(8192, 64 * 1024 + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(fd)
        if len(data) != opened.st_size or after.st_dev != opened.st_dev or after.st_ino != opened.st_ino or after.st_size != opened.st_size:
            raise ValueError("managed service unit changed while being read")
        return data.decode("utf-8")
    finally:
        os.close(fd)


def owned_config() -> dict | None:
    etc_dir = pathlib.Path("/etc") / USER
    if not os.path.lexists(etc_dir):
        unit_path = pathlib.Path("/etc/systemd/system") / DAEMON_UNIT
        unit_text = _read_root_unit(unit_path)
        if unit_text is not None and "--owned-instance" in unit_text:
            raise ValueError("owned service is missing its root-owned instance configuration")
        return None
    _assert_no_symlink(etc_dir)
    try:
        directory = etc_dir.lstat()
        info = OWNED_CONFIG.lstat()
    except FileNotFoundError:
        unit_path = pathlib.Path("/etc/systemd/system") / DAEMON_UNIT
        unit_text = _read_root_unit(unit_path)
        if unit_text is not None and "--owned-instance" in unit_text:
            raise ValueError("owned service is missing its root-owned instance configuration")
        return None
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_gid != 0
            or stat.S_IMODE(directory.st_mode) != 0o700 or not stat.S_ISREG(info.st_mode)
            or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size <= 0 or info.st_size > 4096):
        raise ValueError("owned network configuration is unsafe")
    fd = os.open(OWNED_CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        pinned = os.fstat(fd)
        if pinned.st_dev != info.st_dev or pinned.st_ino != info.st_ino:
            raise ValueError("owned network configuration changed")
        raw = os.read(fd, 4097)
    finally:
        os.close(fd)
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("owned network configuration is invalid") from exc
    expected = {"schemaVersion", "ownedInstance", "caFile", "managementSocket", "managementHostUid", "managementGid"}
    if not isinstance(value, dict) or set(value) != expected or value.get("schemaVersion") != 1:
        raise ValueError("owned network configuration has an invalid schema")
    origin = value.get("ownedInstance")
    if not _canonical_owned_origin(origin):
        raise ValueError("owned network instance origin is invalid")
    if value["caFile"] not in (None, str(OWNED_CA)):
        raise ValueError("owned network CA path is not fixed")
    ipc = (value["managementSocket"], value["managementHostUid"], value["managementGid"])
    if ipc != (None, None, None) and ipc != (str(MANAGEMENT_SOCKET), pwd.getpwnam(NODE_USER).pw_uid,
                                              pwd.getpwnam(USER).pw_gid):
        raise ValueError("owned network IPC identity is invalid")
    if value["caFile"]:
        _verify_public_ca()
    credential = CREDENTIAL.lstat()
    if not stat.S_ISREG(credential.st_mode) or credential.st_uid != 0 or credential.st_gid != 0 or credential.st_nlink != 1 or stat.S_IMODE(credential.st_mode) != 0o600:
        raise ValueError("owned network encrypted credential is unsafe")
    unit_path = pathlib.Path("/etc/systemd/system") / DAEMON_UNIT
    unit_text = _read_root_unit(unit_path)
    if unit_text is None:
        raise ValueError("owned network service unit is missing or unsafe")
    if f"--owned-instance {origin}" not in unit_text or f"LoadCredentialEncrypted=identity-kek:{CREDENTIAL}" not in unit_text:
        raise ValueError("owned network service unit does not match its root configuration")
    if value["managementSocket"] and (f"--management-socket {MANAGEMENT_SOCKET}" not in unit_text
        or f"--management-host-uid {value['managementHostUid']}" not in unit_text
        or f"--management-gid {value['managementGid']}" not in unit_text):
        raise ValueError("owned IPC service arguments do not match root configuration")
    return value


def _canonical_owned_origin(origin: object) -> bool:
    if not isinstance(origin, str) or not origin.isascii() or any(ord(char) <= 0x20 for char in origin):
        return False
    try:
        parsed = urllib.parse.urlsplit(origin)
        port = parsed.port
        host = parsed.hostname
    except ValueError:
        return False
    if (parsed.scheme != "https" or not host or parsed.username is not None or parsed.password is not None
            or parsed.path != "" or parsed.query or "?" in origin or parsed.fragment or "#" in origin or port == 443):
        return False
    if ":" in host:
        try:
            canonical_host = f"[{ipaddress.IPv6Address(host).compressed}]"
        except ipaddress.AddressValueError:
            return False
    else:
        if not re.fullmatch(r"[A-Za-z0-9.-]+", host):
            return False
        canonical_host = host.lower()
    port_suffix = f":{port}" if port is not None else ""
    return origin == f"https://{canonical_host}{port_suffix}"


def _assert_no_symlink(path: pathlib.Path) -> None:
    current = pathlib.Path("/")
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("protected configuration path contains a symlink")


def _verify_public_ca() -> None:
    _assert_no_symlink(OWNED_CA)
    parent_fd = os.open(OWNED_CA_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        parent = os.fstat(parent_fd)
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_gid != 0
                or stat.S_IMODE(parent.st_mode) != 0o755):
            raise ValueError("public CA directory is unsafe")
        fd = os.open(OWNED_CA.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=parent_fd)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
                    or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o644
                    or info.st_size <= 0 or info.st_size > 1024 * 1024):
                raise ValueError("public CA file is unsafe")
            data = bytearray()
            while len(data) <= 1024 * 1024:
                chunk = os.read(fd, min(65536, 1024 * 1024 + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
            after = os.fstat(fd)
            if (len(data) != info.st_size or after.st_dev != info.st_dev
                    or after.st_ino != info.st_ino or after.st_size != info.st_size):
                raise ValueError("public CA file changed while being read")
        finally:
            os.close(fd)
    finally:
        os.close(parent_fd)


def _ensure_root_dropin_dir(path: pathlib.Path) -> None:
    _assert_no_symlink(path.parent)
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_gid != 0 or stat.S_IMODE(parent.st_mode) != 0o755:
        raise ValueError("systemd drop-in parent is unsafe")
    if not os.path.lexists(path):
        os.mkdir(path, 0o755)
        os.chown(path, 0, 0)
        os.chmod(path, 0o755)
    _assert_no_symlink(path)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o755:
        raise ValueError("systemd drop-in directory is unsafe")


def _write_new_root_file(path: pathlib.Path, data: bytes, mode: int) -> None:
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    temp = pathlib.Path(name)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, 0, 0)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.close(fd)
        os.link(temp, path, follow_symlinks=False)
        temp.unlink()
        dfd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        temp.unlink(missing_ok=True)


def _management_dropin_bytes(config: dict) -> bytes | None:
    if not config["managementSocket"]:
        return None
    return ("[Service]\n"
            f"SupplementaryGroups={USER}\n"
            f"Environment=MYAGENTS_HOST_MANAGEMENT_IPC={MANAGEMENT_SOCKET}\n"
            f"Environment=MYAGENTS_HOST_MANAGEMENT_NETWORK_UID={pwd.getpwnam(USER).pw_uid}\n"
            f"Environment=MYAGENTS_HOST_MANAGEMENT_GID={config['managementGid']}\n").encode("ascii")


def _wait_management_socket(config: dict, timeout: float = 30.0) -> None:
    if not config["managementSocket"]:
        return
    network = pwd.getpwnam(USER)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            parent = MANAGEMENT_SOCKET.parent.lstat()
            sock = MANAGEMENT_SOCKET.lstat()
            if (stat.S_ISDIR(parent.st_mode) and parent.st_uid == network.pw_uid
                    and parent.st_gid == config["managementGid"] and stat.S_IMODE(parent.st_mode) == 0o2750
                    and stat.S_ISSOCK(sock.st_mode) and sock.st_uid == network.pw_uid
                    and sock.st_gid == config["managementGid"] and stat.S_IMODE(sock.st_mode) == 0o660
                    and sock.st_nlink == 1):
                return
        except FileNotFoundError:
            pass
        time.sleep(0.2)
    raise ValueError("owned management IPC socket did not become ready")


def _host_dropin(config: dict) -> tuple[bytes | None, bool]:
    content = _management_dropin_bytes(config)
    if content is None:
        return None, False
    if not HOST_UNIT.exists() or HOST_UNIT.is_symlink():
        raise ValueError("Node Host unit is missing or unsafe")
    unit = HOST_UNIT.lstat()
    if not stat.S_ISREG(unit.st_mode) or unit.st_uid != 0 or unit.st_gid != 0 or unit.st_nlink != 1 or stat.S_IMODE(unit.st_mode) != 0o644:
        raise ValueError("Node Host unit is unsafe")
    _ensure_root_dropin_dir(HOST_DROPIN_DIR)
    if HOST_DROPIN.exists() or HOST_DROPIN.is_symlink():
        st = HOST_DROPIN.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_gid != 0 or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o644:
            raise ValueError("Node Host management drop-in is unsafe")
        if HOST_DROPIN.read_bytes() != content:
            raise ValueError("Node Host management drop-in has unexpected content")
        return content, False
    _write_new_root_file(HOST_DROPIN, content, 0o644)
    return content, True


def _remove_created_host_dropin(created: bool) -> None:
    if created:
        HOST_DROPIN.unlink(missing_ok=True)
        subprocess.run(["systemctl", "daemon-reload"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _network_join_override(config: dict, device_id: str) -> bytes:
    binary = str(BIN)
    args = [binary, "run", "--state-dir", str(STATE), "--unit", DAEMON_UNIT,
            "--credential", "identity-kek", "--device-id", device_id, "--device-name", "Linux-Host",
            "--status-file", str(STATUS_FILE), "--owned-instance", config["ownedInstance"]]
    if config["caFile"]:
        args.extend(["--public-tls-ca-file", config["caFile"]])
    if config["managementSocket"]:
        args.extend(["--management-socket", config["managementSocket"],
                     "--management-host-uid", str(config["managementHostUid"]),
                     "--management-gid", str(config["managementGid"])])
    args.append("--join")
    escaped = " ".join('"' + arg.replace("\\", "\\\\").replace('"', '\\"') + '"' for arg in args)
    return ("[Service]\nExecStart=\nExecStart=" + escaped + "\n").encode("ascii")


def _activate_owned(command: str, config: dict, device_id: str) -> int:
    if not config["ownedInstance"]:
        raise ValueError("owned instance configuration is missing")
    host_was_active = subprocess.run(["systemctl", "is-active", "--quiet", HOST_UNIT.name], check=False).returncode == 0
    created_host_dropin = False
    join_override_created = False
    try:
        if command == "join":
            if subprocess.run(["systemctl", "is-active", "--quiet", DAEMON_UNIT], check=False).returncode == 0:
                raise ValueError("stop the network service before requesting an explicit join")
            _ensure_root_dropin_dir(DAEMON_DROPIN_DIR)
            override = _network_join_override(config, device_id)
            if JOIN_DROPIN.exists() or JOIN_DROPIN.is_symlink():
                raise ValueError("an unfinished explicit join override exists; preserve it for review")
            _write_new_root_file(JOIN_DROPIN, override, 0o644)
            join_override_created = True
            subprocess.run(["systemctl", "daemon-reload"], check=True)
        elif JOIN_DROPIN.exists() or JOIN_DROPIN.is_symlink():
            raise ValueError("an unfinished explicit join override exists; preserve it for review")
        start = subprocess.run(["systemctl", "start", DAEMON_UNIT], check=False)
        if start.returncode != 0:
            raise subprocess.CalledProcessError(start.returncode, ["systemctl", "start", DAEMON_UNIT])
        if config["managementSocket"]:
            _wait_management_socket(config)
            _, created_host_dropin = _host_dropin(config)
            subprocess.run(["systemctl", "daemon-reload"], check=True)
            subprocess.run(["systemctl", "restart" if host_was_active else "start", HOST_UNIT.name], check=True)
        if join_override_created:
            JOIN_DROPIN.unlink()
            subprocess.run(["systemctl", "daemon-reload"], check=True)
        return 0
    except BaseException:
        _remove_created_host_dropin(created_host_dropin)
        if created_host_dropin and host_was_active:
            subprocess.run(["systemctl", "restart", HOST_UNIT.name], check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["systemctl", "stop", DAEMON_UNIT], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if join_override_created:
            JOIN_DROPIN.unlink(missing_ok=True)
            subprocess.run(["systemctl", "daemon-reload"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise


def run_control(command: str, profile: str = "myagents-test") -> int:
    select_profile(profile)
    if os.geteuid() != 0:
        raise PermissionError("run this operator control as root")
    if command not in {"start", "wait", "cancel", "logout", "status", "run", "join"}:
        raise ValueError("unsupported operator action")
    device_id = verified_host_id()
    config = owned_config()
    if command in {"run", "join"}:
        if config is not None:
            return _activate_owned(command, config, device_id)
        return subprocess.run(["systemctl", "start", DAEMON_UNIT], check=False).returncode
    account = pwd.getpwnam(USER)
    if account.pw_uid == 0 or account.pw_gid == 0:
        raise ValueError("isolated service account is invalid")
    if command == "logout" and config is None:
        raise ValueError("logout requires an owned-instance configuration")
    if command == "logout":
        subprocess.run(["systemctl", "stop", DAEMON_UNIT], check=False)
    operation = {"start": "owned-auth-start" if config else "auth-start",
                 "wait": "owned-auth-wait" if config else "auth-wait",
                 "cancel": "owned-auth-cancel" if config else "auth-cancel",
                 "logout": "owned-auth-logout", "status": "status"}[command]
    unit = AUTH_UNIT.replace("-auth.service", f"-auth-{command}.service")
    args = [
        "systemd-run", "--quiet", "--pipe", "--wait", "--collect", f"--unit={unit}",
        f"--property=User={USER}", f"--property=Group={GROUP}",
        "--property=UMask=0077", "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes",
        "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
        "--property=RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
        f"--property=ReadOnlyPaths={STATUS_FILE.parent}",
    ]
    if command in {"start", "wait", "cancel", "logout"}:
        args.extend([
            f"--property=LoadCredentialEncrypted=identity-kek:{CREDENTIAL}",
            f"--property=ReadWritePaths={STATE}",
            str(BIN), operation, "--state-dir", str(STATE), "--unit", unit,
            "--credential", "identity-kek", "--device-id", device_id, "--device-name", "Linux-Host",
        ])
        if config:
            args.extend(["--owned-instance", config["ownedInstance"]])
            if config["caFile"]:
                args.extend(["--public-tls-ca-file", config["caFile"]])
        # systemd-run --pipe forwards stdout to this terminal, never to the journal.
        # auth-start's capability-bearing URL is intentionally neither captured nor logged.
        return subprocess.run(args, check=False).returncode
    args.extend([str(BIN), operation, "--status-file", str(STATUS_FILE)])
    return subprocess.run(args, check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "wait", "cancel", "logout", "status", "run", "join"))
    parser.add_argument("--profile", choices=("myagents-test", "moxbot-test"), default="myagents-test")
    args = parser.parse_args()
    try:
        return run_control(args.command, args.profile)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({"status": "error", "code": "NETWORK_CONTROL_REJECTED", "detail": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
