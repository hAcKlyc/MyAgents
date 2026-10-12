#!/usr/bin/env python3
"""Fixed root operator controls for the isolated headless AgentNet test owner."""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys

USER = "myagents-host-network-test"
GROUP = USER
NODE_IDENTITY = pathlib.Path("/var/lib/myagents-host-test/host-identity.json")
STATE = pathlib.Path("/var/lib/myagents-host-network-test")
CREDENTIAL = pathlib.Path("/etc/myagents-host-network-test/identity-kek.cred")
DAEMON_UNIT = "myagents-host-network-test.service"
AUTH_UNIT = "myagents-host-network-test-auth.service"
BIN = pathlib.Path("/opt/myagents-host-network-test/current/myagents-host-network")
PIN_PATH = pathlib.Path("/opt/myagents-host-network-test/device-id.json")
STATUS_FILE = pathlib.Path("/run/myagents-host-network-test/status.json")


def host_id() -> str:
    node = pwd.getpwnam("myagents-host-test")
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


def run_control(command: str) -> int:
    if os.geteuid() != 0:
        raise PermissionError("run this operator control as root")
    if command not in {"start", "wait", "cancel", "status", "run"}:
        raise ValueError("unsupported operator action")
    device_id = verified_host_id()
    if command == "run":
        return subprocess.run(["systemctl", "start", DAEMON_UNIT], check=False).returncode
    account = pwd.getpwnam(USER)
    if account.pw_uid == 0 or account.pw_gid == 0:
        raise ValueError("isolated service account is invalid")
    operation = {"start": "auth-start", "wait": "auth-wait", "cancel": "auth-cancel", "status": "status"}[command]
    unit = AUTH_UNIT.replace("-auth.service", f"-auth-{command}.service")
    args = [
        "systemd-run", "--quiet", "--pipe", "--wait", "--collect", f"--unit={unit}",
        f"--property=User={USER}", f"--property=Group={GROUP}",
        "--property=UMask=0077", "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes",
        "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
        "--property=RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
        f"--property=ReadOnlyPaths=/run/myagents-host-network-test",
    ]
    if command in {"start", "wait", "cancel"}:
        args.extend([
            f"--property=LoadCredentialEncrypted=identity-kek:{CREDENTIAL}",
            f"--property=ReadWritePaths={STATE}",
            str(BIN), operation, "--state-dir", str(STATE), "--unit", unit,
            "--credential", "identity-kek", "--device-id", device_id, "--device-name", "Linux-Host",
        ])
        # systemd-run --pipe forwards stdout to this terminal, never to the journal.
        # auth-start's capability-bearing URL is intentionally neither captured nor logged.
        return subprocess.run(args, check=False).returncode
    args.extend([str(BIN), operation, "--status-file", str(STATUS_FILE)])
    return subprocess.run(args, check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("start", "wait", "cancel", "status", "run"))
    args = parser.parse_args()
    try:
        return run_control(args.command)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(json.dumps({"status": "error", "code": "NETWORK_CONTROL_REJECTED", "detail": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
