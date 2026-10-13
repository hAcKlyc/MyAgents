#!/usr/bin/env python3
"""Install the local Host and prepare its isolated owned AgentNet test owner."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import os
import pathlib
import pwd
import re
import stat
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
HOST_PREFIX = pathlib.Path("/opt/myagents-host-test")
HOST_CURRENT = HOST_PREFIX / "current"
HOST_UNIT = pathlib.Path("/etc/systemd/system/myagents-host-test.service")
HOST_SERVICE = "myagents-host-test.service"
UNIFIED_LOCK = pathlib.Path("/run/myagents-host-unified-install.lock")
PROFILE = "myagents-test"
HOST_USER = "myagents-host-test"

def select_profile(profile: str) -> None:
    global PROFILE, HOST_USER, HOST_PREFIX, HOST_CURRENT, HOST_UNIT, HOST_SERVICE
    profiles = {"myagents-test": "myagents-host-test", "moxbot-test": "moxbot-host-test"}
    if profile not in profiles:
        raise UnifiedInstallError("profile must be myagents-test or moxbot-test")
    PROFILE = profile
    HOST_USER = profiles[profile]
    HOST_PREFIX = pathlib.Path("/opt") / HOST_USER
    HOST_CURRENT = HOST_PREFIX / "current"
    HOST_UNIT = pathlib.Path("/etc/systemd/system") / (HOST_USER + ".service")
    HOST_SERVICE = HOST_USER + ".service"


class UnifiedInstallError(RuntimeError):
    pass


MAX_HOST_ARCHIVE = 2 * 1024 * 1024 * 1024


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _host_service_state() -> dict:
    result = subprocess.run(
        ["systemctl", "show", "--property=LoadState", "--property=UnitFileState", "--property=ActiveState",
         HOST_SERVICE],
        check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    fields = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if not separator or key not in {"LoadState", "UnitFileState", "ActiveState"} or key in fields:
            raise UnifiedInstallError("Host service state could not be verified")
        fields[key] = value
    if result.returncode != 0 or set(fields) != {"LoadState", "UnitFileState", "ActiveState"}:
        raise UnifiedInstallError("Host service state could not be verified")
    load_state = fields["LoadState"]
    unit_file_state = fields["UnitFileState"]
    active_state = fields["ActiveState"]
    if load_state == "not-found":
        if unit_file_state or active_state not in {"inactive", "failed"}:
            raise UnifiedInstallError("Host service has an unexpected unloaded state")
        return {"present": False, "enabled": False, "active": False}
    if load_state != "loaded" or unit_file_state not in {"enabled", "disabled"} or active_state not in {"active", "inactive"}:
        raise UnifiedInstallError("Host service is in an unsupported state")
    return {"present": True, "enabled": unit_file_state == "enabled", "active": active_state == "active"}


def _matches_service_state(snapshot: dict) -> bool:
    try:
        actual = _host_service_state()
    except (UnifiedInstallError, OSError, subprocess.SubprocessError):
        return False
    expected_present = snapshot.get("servicePresent", snapshot.get("unit") is not None)
    return (actual["present"] == expected_present
            and actual["enabled"] == snapshot["enabled"]
            and actual["active"] == snapshot["active"])


def _copy_verified_host_archive(source_text: str, destination: pathlib.Path, expected_sha256: str) -> pathlib.Path:
    source = pathlib.Path(source_text)
    if not source.is_absolute() or source.resolve(strict=True) != source:
        raise UnifiedInstallError("Host archive path must be absolute and canonical")
    before = source.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_size <= 0 or before.st_size > MAX_HOST_ARCHIVE):
        raise UnifiedInstallError("Host archive must be a bounded, unlinked regular file")
    src_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    dst_fd = -1
    digest = hashlib.sha256()
    copied = 0
    try:
        opened = os.fstat(src_fd)
        if (opened.st_dev != before.st_dev or opened.st_ino != before.st_ino
                or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or opened.st_size != before.st_size):
            raise UnifiedInstallError("Host archive changed before snapshot")
        dst_fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        while chunk := os.read(src_fd, 1024 * 1024):
            copied += len(chunk)
            if copied > MAX_HOST_ARCHIVE:
                raise UnifiedInstallError("Host archive exceeded its size limit")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(dst_fd, view)
                view = view[written:]
        after = os.fstat(src_fd)
        if copied != opened.st_size or after.st_dev != opened.st_dev or after.st_ino != opened.st_ino or after.st_size != opened.st_size:
            raise UnifiedInstallError("Host archive changed while being snapshotted")
        if digest.hexdigest() != expected_sha256:
            raise UnifiedInstallError("Host archive SHA-256 does not match the independent pin")
        os.fsync(dst_fd)
        return destination
    finally:
        os.close(src_fd)
        if dst_fd >= 0:
            os.close(dst_fd)


def _safe_current() -> str | None:
    if not os.path.lexists(HOST_CURRENT):
        return None
    st = HOST_CURRENT.lstat()
    if not stat.S_ISLNK(st.st_mode) or st.st_uid != 0:
        raise UnifiedInstallError("existing Host release pointer is unsafe")
    value = os.readlink(HOST_CURRENT)
    if not re.fullmatch(r"releases/[A-Za-z0-9._-]{1,128}", value):
        raise UnifiedInstallError("existing Host release pointer is outside managed releases")
    return value


def _snapshot_host() -> dict:
    current = _safe_current()
    unit_bytes = None
    unit_mode = None
    if os.path.lexists(HOST_UNIT):
        st = HOST_UNIT.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_gid != 0 or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o644:
            raise UnifiedInstallError("existing Host service unit is unsafe")
        unit_bytes = HOST_UNIT.read_bytes()
        unit_mode = stat.S_IMODE(st.st_mode)
    state = _host_service_state()
    if state["present"] != (unit_bytes is not None):
        raise UnifiedInstallError("Host unit file and systemd state disagree")
    return {"current": current, "unit": unit_bytes, "unitMode": unit_mode,
            "servicePresent": state["present"], "enabled": state["enabled"], "active": state["active"]}


def _restore_host(snapshot: dict) -> bool:
    try:
        now_current = _safe_current()
        now_unit = HOST_UNIT.read_bytes() if HOST_UNIT.exists() and not HOST_UNIT.is_symlink() else None
        if now_current == snapshot["current"] and now_unit == snapshot["unit"] and _matches_service_state(snapshot):
            return True
        if _run(["systemctl", "stop", HOST_SERVICE]).returncode not in (0, 5):
            return False
        # Remove the newly-created enablement links while its unit still exists.
        # daemon-reload alone leaves dangling Wants symlinks after unit removal.
        if snapshot["unit"] is None and now_unit is not None and _run(["systemctl", "disable", HOST_SERVICE]).returncode != 0:
            return False
        if snapshot["current"] is None:
            HOST_CURRENT.unlink(missing_ok=True)
        else:
            temp_link = HOST_PREFIX / ".current-unified-rollback"
            if os.path.lexists(temp_link):
                return False
            os.symlink(snapshot["current"], temp_link)
            os.replace(temp_link, HOST_CURRENT)
        if snapshot["unit"] is None:
            HOST_UNIT.unlink(missing_ok=True)
        else:
            fd, name = tempfile.mkstemp(prefix=f".{HOST_USER}.service.rollback.", dir=HOST_UNIT.parent)
            try:
                os.fchown(fd, 0, 0)
                os.fchmod(fd, snapshot["unitMode"])
                with os.fdopen(fd, "wb", closefd=False) as stream:
                    stream.write(snapshot["unit"])
                    stream.flush()
                    os.fsync(stream.fileno())
                os.close(fd)
                os.replace(name, HOST_UNIT)
                dfd = os.open(HOST_UNIT.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    os.fsync(dfd)
                finally:
                    os.close(dfd)
            finally:
                try:
                    os.close(fd)
                except OSError:
                    pass
                pathlib.Path(name).unlink(missing_ok=True)
        if _run(["systemctl", "daemon-reload"]).returncode != 0:
            return False
        if snapshot.get("servicePresent", snapshot["unit"] is not None):
            command = "enable" if snapshot["enabled"] else "disable"
            if _run(["systemctl", command, HOST_SERVICE]).returncode != 0:
                return False
            if snapshot["active"] and _run(["systemctl", "start", HOST_SERVICE]).returncode != 0:
                return False
        elif snapshot["enabled"] or snapshot["active"]:
            return False
        if _safe_current() != snapshot["current"]:
            return False
        restored_unit = HOST_UNIT.read_bytes() if HOST_UNIT.exists() and not HOST_UNIT.is_symlink() else None
        return restored_unit == snapshot["unit"] and _matches_service_state(snapshot)
    except (OSError, UnifiedInstallError):
        return False


def _acquire_lock(expected_uid: int = 0, expected_gid: int = 0) -> int:
    inherited_text = os.environ.get("MYAGENTS_HOST_TRANSACTION_LOCK_FD")
    try:
        if inherited_text is not None:
            if not re.fullmatch(r"[1-9][0-9]*", inherited_text) or int(inherited_text) < 3:
                raise UnifiedInstallError("inherited transaction lock descriptor is invalid")
            fd = int(inherited_text)
        else:
            fd = os.open(UNIFIED_LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        st = os.fstat(fd)
        access_mode = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
        path_st = os.stat(UNIFIED_LOCK, follow_symlinks=False)
        if (access_mode != os.O_RDWR or not stat.S_ISREG(st.st_mode)
                or st.st_uid != expected_uid or st.st_gid != expected_gid or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != 0o600 or stat.S_ISLNK(path_st.st_mode)
                or path_st.st_dev != st.st_dev or path_st.st_ino != st.st_ino
                or path_st.st_uid != expected_uid or path_st.st_gid != expected_gid or path_st.st_nlink != 1
                or stat.S_IMODE(path_st.st_mode) != 0o600):
            raise UnifiedInstallError("unified installation lock is unsafe")
        descriptor_flags = fcntl.fcntl(fd, fcntl.F_GETFD)
        if not descriptor_flags & fcntl.FD_CLOEXEC:
            fcntl.fcntl(fd, fcntl.F_SETFD, descriptor_flags | fcntl.FD_CLOEXEC)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BlockingIOError as exc:
        if "fd" in locals():
            os.close(fd)
        raise UnifiedInstallError("another Host or network install transaction is active") from exc
    except BaseException:
        if "fd" in locals():
            os.close(fd)
        raise


def install(args: argparse.Namespace) -> None:
    select_profile(getattr(args, "profile", "myagents-test"))
    if os.geteuid() != 0:
        raise UnifiedInstallError("run unified installation as root")
    if not sys.platform.startswith("linux") or os.uname().machine not in ("x86_64", "amd64"):
        raise UnifiedInstallError("unified test install supports Linux x86_64 only")
    if not re.fullmatch(r"[0-9a-f]{64}", args.host_sha256) or not re.fullmatch(r"[0-9a-f]{64}", args.network_sha256):
        raise UnifiedInstallError("both independently trusted 64-digit SHA-256 values are required")
    if not re.fullmatch(r"[0-9a-f]{40}", args.network_source_commit):
        raise UnifiedInstallError("an independently trusted 40-digit network source commit is required")
    network_script = ROOT / "network-install.py"
    spec = importlib.util.spec_from_file_location("unified_network_install", network_script)
    if not spec or not spec.loader:
        raise UnifiedInstallError("network installer is unavailable")
    network_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(network_module)
    network_module.select_profile(PROFILE)
    ca_bytes = None
    try:
        owned_instance = network_module.validate_owned_origin(args.owned_instance)
        if args.public_tls_ca_file:
            ca_bytes = network_module.read_ca_source(args.public_tls_ca_file)
    except network_module.InstallError as exc:
        raise UnifiedInstallError("owned instance configuration is invalid") from exc
    if not pathlib.Path(args.network_artifact_dir).is_absolute():
        raise UnifiedInstallError("network artifact directory must be absolute")

    lock_fd = _acquire_lock()
    try:
        before = _snapshot_host()
        with tempfile.TemporaryDirectory(prefix="myagents-host-unified-") as temp:
            os.chmod(temp, 0o700)
            scratch = pathlib.Path(temp)
            host_archive = _copy_verified_host_archive(args.host_archive, scratch / "host.tar.gz", args.host_sha256)
            staged_ca_path = None
            if ca_bytes is not None:
                staged_ca_path = scratch / "owned-instance-ca.pem"
                fd = os.open(staged_ca_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
                try:
                    os.fchmod(fd, 0o644)
                    view = memoryview(ca_bytes)
                    while view:
                        written = os.write(fd, view)
                        view = view[written:]
                    os.fsync(fd)
                finally:
                    os.close(fd)
            network_snapshot_dir = scratch / "network-artifact"
            network_snapshot_dir.mkdir(mode=0o700)
            try:
                network_module.copy_snapshot(args.network_artifact_dir, network_snapshot_dir,
                                             args.network_sha256, args.network_source_commit)
            except network_module.InstallError as exc:
                raise UnifiedInstallError("network artifact failed pinned snapshot verification") from exc

            dry_run = ["bash", str(ROOT / "install.sh"), str(host_archive),
                       "--sha256", args.host_sha256, "--profile", PROFILE, "--dry-run"]
            if subprocess.run(dry_run, check=False).returncode != 0:
                raise UnifiedInstallError("Host archive failed its non-mutating package validation")

            host_command = ["bash", str(ROOT / "install.sh"), str(host_archive),
                            "--sha256", args.host_sha256, "--profile", PROFILE]
            locked_env = os.environ.copy()
            locked_env["MYAGENTS_HOST_TRANSACTION_LOCK_FD"] = str(lock_fd)
            host_result = subprocess.run(host_command, check=False, pass_fds=(lock_fd,), env=locked_env)
            if host_result.returncode != 0:
                if not _restore_host(before):
                    raise UnifiedInstallError("Host install failed and prior Host state could not be restored")
                raise UnifiedInstallError("Host package installation failed; its installer performed its own rollback")
            node_user = pwd.getpwnam(HOST_USER)
            network_command = [sys.executable, str(network_script),
                               str(network_snapshot_dir), args.network_sha256,
                               args.network_source_commit, "--profile", PROFILE, "--owned-instance", owned_instance,
                               "--management-socket", str(network_module.MANAGEMENT_SOCKET),
                               "--management-host-uid", str(node_user.pw_uid)]
            if staged_ca_path is not None:
                network_command.extend(["--public-tls-ca-file", str(staged_ca_path)])
            network_result = subprocess.run(network_command, check=False, pass_fds=(lock_fd,), env=locked_env)
            if network_result.returncode != 0:
                restored = _restore_host(before)
                if not restored:
                    raise UnifiedInstallError("network install failed and Host rollback could not be verified")
                raise UnifiedInstallError("owned network package installation failed; prior Host release and unit were restored")
        print("Unified test packages installed. Owned login and explicit join remain operator actions; no AgentNet session was created.")
    finally:
        os.close(lock_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-archive", required=True)
    parser.add_argument("--host-sha256", required=True)
    parser.add_argument("--network-artifact-dir", required=True)
    parser.add_argument("--network-sha256", required=True)
    parser.add_argument("--network-source-commit", required=True)
    parser.add_argument("--owned-instance", required=True)
    parser.add_argument("--profile", choices=("myagents-test", "moxbot-test"), default="myagents-test")
    parser.add_argument("--public-tls-ca-file")
    args = parser.parse_args()
    try:
        install(args)
        return 0
    except (UnifiedInstallError, OSError, subprocess.SubprocessError, KeyError) as exc:
        print(f"UNIFIED_INSTALL_FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
