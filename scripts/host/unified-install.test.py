#!/usr/bin/env python3
"""Offline tests for the fixed unified Host/owned-network installer."""
from __future__ import annotations

import importlib.util
import hashlib
import fcntl
import os
import pathlib
import tempfile
import types
import unittest
from collections import namedtuple
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("unified-install.py")
SPEC = importlib.util.spec_from_file_location("unified_install", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(installer)

_Uname = namedtuple("Uname", "sysname nodename release version machine")
LINUX_X64 = _Uname("Linux", "test", "test", "test", "x86_64")


def fake_elf() -> bytes:
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    header[16:18] = (2).to_bytes(2, "little")
    header[18:20] = (62).to_bytes(2, "little")
    return bytes(header)


class UnifiedInstallTests(unittest.TestCase):
    def test_profiles_select_only_fixed_host_namespaces(self) -> None:
        installer.select_profile("moxbot-test")
        self.assertEqual(str(installer.HOST_PREFIX), "/opt/moxbot-host-test")
        self.assertEqual(str(installer.HOST_CURRENT), "/opt/moxbot-host-test/current")
        self.assertEqual(installer.HOST_SERVICE, "moxbot-host-test.service")
        with self.assertRaises(installer.UnifiedInstallError):
            installer.select_profile("/opt/custom")
        installer.select_profile("myagents-test")
        self.assertEqual(str(installer.HOST_PREFIX), "/opt/myagents-host-test")

    def test_transaction_lock_reentry_contention_and_foreign_fd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            lock = root / "transaction.lock"
            foreign = root / "foreign.lock"
            foreign.write_bytes(b"")
            uid, gid = os.geteuid(), os.getegid()
            with mock.patch.object(installer, "UNIFIED_LOCK", lock):
                held = installer._acquire_lock(uid, gid)
                inherited = fcntl.fcntl(held, fcntl.F_DUPFD, 20)
                try:
                    self.assertGreaterEqual(inherited, 20)
                    with mock.patch.dict(os.environ, {"MYAGENTS_HOST_TRANSACTION_LOCK_FD": str(inherited)}):
                        reentered = installer._acquire_lock(uid, gid)
                        self.assertEqual(reentered, inherited)
                        os.close(reentered)
                    with mock.patch.dict(os.environ, {}, clear=True):
                        with self.assertRaises(installer.UnifiedInstallError):
                            installer._acquire_lock(uid, gid)
                    readonly = os.open(lock, os.O_RDONLY)
                    try:
                        with mock.patch.dict(os.environ, {"MYAGENTS_HOST_TRANSACTION_LOCK_FD": str(readonly)}):
                            with self.assertRaises(installer.UnifiedInstallError):
                                installer._acquire_lock(uid, gid)
                    finally:
                        try:
                            os.close(readonly)
                        except OSError:
                            pass
                    wrong = os.open(foreign, os.O_RDWR)
                    try:
                        with mock.patch.dict(os.environ, {"MYAGENTS_HOST_TRANSACTION_LOCK_FD": str(wrong)}):
                            with self.assertRaises(installer.UnifiedInstallError):
                                installer._acquire_lock(uid, gid)
                    finally:
                        try:
                            os.close(wrong)
                        except OSError:
                            pass
                finally:
                    os.close(held)

    def test_systemd_state_parser_requires_known_enabled_and_active_values(self) -> None:
        with mock.patch.object(
            installer.subprocess, "run",
            return_value=types.SimpleNamespace(returncode=0, stdout="LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n"),
        ):
            self.assertEqual(installer._host_service_state(),
                             {"present": True, "enabled": True, "active": True})
        with mock.patch.object(
            installer.subprocess, "run",
            return_value=types.SimpleNamespace(returncode=0, stdout="UnitFileState=\nLoadState=not-found\nActiveState=inactive\n"),
        ):
            self.assertEqual(installer._host_service_state(),
                             {"present": False, "enabled": False, "active": False})
        with mock.patch.object(
            installer.subprocess, "run",
            return_value=types.SimpleNamespace(returncode=0, stdout="LoadState=loaded\nUnitFileState=masked\nActiveState=failed\n"),
        ):
            with self.assertRaises(installer.UnifiedInstallError):
                installer._host_service_state()

    def test_systemd_state_parser_rejects_missing_duplicate_or_unknown_properties(self) -> None:
        for output in (
                "LoadState=loaded\nActiveState=active\n",
                "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nLoadState=loaded\n",
                "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=42\n",
                "loaded\nenabled\nactive\n"):
            with self.subTest(output=output), mock.patch.object(
                    installer.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout=output)):
                with self.assertRaises(installer.UnifiedInstallError):
                    installer._host_service_state()

    def test_valid_install_calls_only_pinned_local_installers_in_order(self) -> None:
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as tmp:
            root = pathlib.Path(tmp)
            host_archive = root / "host.tar.gz"
            host_bytes = b"test archive"
            host_archive.write_bytes(host_bytes)
            artifacts = root / "artifacts"
            artifacts.mkdir()
            network_bytes = fake_elf()
            (artifacts / "myagents-host-network").write_bytes(network_bytes)
            (artifacts / "source-commit.txt").write_text("c" * 40 + "\n", encoding="ascii")
            fd = os.open(root / "install.lock", os.O_CREAT | os.O_RDWR, 0o600)
            run_calls = []
            with (
                    mock.patch.object(installer.os, "geteuid", return_value=0),
                    mock.patch.object(installer.sys, "platform", "linux"),
                    mock.patch.object(installer.os, "uname", return_value=LINUX_X64),
                    mock.patch.object(installer, "_acquire_lock", return_value=fd),
                    mock.patch.object(installer, "_snapshot_host", return_value={}),
                    mock.patch.object(installer.subprocess, "run", side_effect=lambda args, **kwargs: (run_calls.append((args, kwargs)) or types.SimpleNamespace(returncode=0))),
                    mock.patch.object(installer.pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=1000, pw_gid=1001)),
            ):
                args = types.SimpleNamespace(
                        host_archive=str(host_archive), host_sha256=hashlib.sha256(host_bytes).hexdigest(),
                        network_artifact_dir=str(artifacts), network_sha256=hashlib.sha256(network_bytes).hexdigest(),
                        network_source_commit="c" * 40, owned_instance="https://owned.example",
                        public_tls_ca_file=None, profile="moxbot-test",
                    )
                installer.install(args)
            self.assertEqual(len(run_calls), 3)
            self.assertEqual(run_calls[0][0][0], "bash")
            self.assertEqual(pathlib.Path(run_calls[0][0][1]).name, "install.sh")
            self.assertIn("--dry-run", run_calls[0][0])
            self.assertEqual(pathlib.Path(run_calls[1][0][1]).name, "install.sh")
            self.assertIn("moxbot-test", run_calls[0][0])
            self.assertIn("moxbot-test", run_calls[1][0])
            self.assertEqual(pathlib.Path(run_calls[2][0][1]).name, "network-install.py")
            self.assertIn("moxbot-test", run_calls[2][0])
            self.assertIn("--owned-instance", run_calls[2][0])
            self.assertIn("--management-socket", run_calls[2][0])
            self.assertIn("--management-host-uid", run_calls[2][0])
            self.assertNotIn("--management-gid", run_calls[2][0])
            self.assertNotIn("--join", run_calls[2][0])
            self.assertTrue(all("shell" not in kwargs for _, kwargs in run_calls))
            for _, kwargs in run_calls[1:]:
                self.assertEqual(len(kwargs["pass_fds"]), 1)
                self.assertEqual(kwargs["env"]["MYAGENTS_HOST_TRANSACTION_LOCK_FD"],
                                 str(kwargs["pass_fds"][0]))

    def test_invalid_owned_origin_is_rejected_before_installers_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            host_archive = root / "host.tar.gz"
            host_archive.write_bytes(b"test archive")
            artifacts = root / "artifacts"
            artifacts.mkdir()
            args = types.SimpleNamespace(
                host_archive=str(host_archive), host_sha256="a" * 64,
                network_artifact_dir=str(artifacts), network_sha256="b" * 64,
                network_source_commit="c" * 40, owned_instance="http://owned.example",
                public_tls_ca_file=None,
            )
            with mock.patch.object(installer.os, "geteuid", return_value=0), \
                 mock.patch.object(installer.sys, "platform", "linux"), \
                 mock.patch.object(installer.os, "uname", return_value=LINUX_X64), \
                 mock.patch.object(installer.subprocess, "run") as run:
                with self.assertRaises(installer.UnifiedInstallError):
                    installer.install(args)
                run.assert_not_called()

    def test_failed_second_installer_restores_original_host_link_and_unit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            prefix = root / "opt"
            prefix.mkdir()
            releases = prefix / "releases"
            releases.mkdir()
            (releases / "old").mkdir()
            (releases / "new").mkdir()
            current = prefix / "current"
            current.symlink_to("releases/new")
            unit = root / "host.service"
            unit.write_bytes(b"new unit\n")
            with (
                mock.patch.object(installer, "HOST_PREFIX", prefix),
                mock.patch.object(installer, "HOST_CURRENT", current),
                mock.patch.object(installer, "HOST_UNIT", unit),
                mock.patch.object(installer, "HOST_SERVICE", "host.service"),
                mock.patch.object(installer, "_safe_current", side_effect=["releases/new", "releases/old"]),
                mock.patch.object(installer, "_run", return_value=types.SimpleNamespace(returncode=0)) as run,
                mock.patch.object(installer, "_host_service_state", return_value={"present": True, "enabled": True, "active": True}),
                mock.patch.object(installer.os, "fchown"),
            ):
                snapshot = {"current": "releases/old", "unit": b"old unit\n", "unitMode": 0o644,
                            "servicePresent": True, "enabled": True, "active": True}
                self.assertTrue(installer._restore_host(snapshot))
            self.assertEqual(os.readlink(current), "releases/old")
            self.assertEqual(unit.read_bytes(), b"old unit\n")
            self.assertTrue(any(call.args[0][:2] == ["systemctl", "daemon-reload"] for call in run.call_args_list))
            self.assertTrue(any(call.args[0][:2] == ["systemctl", "start"] for call in run.call_args_list))

    def test_disabled_snapshot_fails_if_systemctl_disable_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            prefix = root / "opt"
            prefix.mkdir()
            (prefix / "releases").mkdir()
            (prefix / "releases" / "old").mkdir()
            current = prefix / "current"
            current.symlink_to("releases/new")
            unit = root / "host.service"
            unit.write_bytes(b"new unit\n")
            calls = []

            def run(args):
                calls.append(args)
                return types.SimpleNamespace(returncode=1 if args[:2] == ["systemctl", "disable"] else 0)

            with (
                mock.patch.object(installer, "HOST_PREFIX", prefix),
                mock.patch.object(installer, "HOST_CURRENT", current),
                mock.patch.object(installer, "HOST_UNIT", unit),
                mock.patch.object(installer, "HOST_SERVICE", "host.service"),
                mock.patch.object(installer, "_safe_current", return_value="releases/new"),
                mock.patch.object(installer, "_run", side_effect=run),
                mock.patch.object(installer, "_host_service_state", return_value={"present": True, "enabled": False, "active": False}),
                mock.patch.object(installer.os, "fchown"),
            ):
                snapshot = {"current": "releases/old", "unit": b"old unit\n", "unitMode": 0o644,
                            "servicePresent": True, "enabled": False, "active": False}
                self.assertFalse(installer._restore_host(snapshot))
            self.assertIn(["systemctl", "disable", "host.service"], calls)

    def test_early_return_rechecks_service_state_and_restores_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            prefix = root / "opt"
            prefix.mkdir()
            current = prefix / "current"
            current.symlink_to("releases/old")
            unit = root / "host.service"
            unit.write_bytes(b"old unit\n")
            states = [
                {"present": True, "enabled": False, "active": True},
                {"present": True, "enabled": False, "active": False},
            ]
            with (
                mock.patch.object(installer, "HOST_PREFIX", prefix),
                mock.patch.object(installer, "HOST_CURRENT", current),
                mock.patch.object(installer, "HOST_UNIT", unit),
                mock.patch.object(installer, "HOST_SERVICE", "host.service"),
                mock.patch.object(installer, "_safe_current", return_value="releases/old"),
                mock.patch.object(installer, "_host_service_state", side_effect=states),
                mock.patch.object(installer, "_run", return_value=types.SimpleNamespace(returncode=0)) as run,
                mock.patch.object(installer.os, "fchown"),
            ):
                snapshot = {"current": "releases/old", "unit": b"old unit\n", "unitMode": 0o644,
                            "servicePresent": True, "enabled": False, "active": False}
                self.assertTrue(installer._restore_host(snapshot))
            self.assertTrue(any(call.args[0][:2] == ["systemctl", "daemon-reload"] for call in run.call_args_list))

    def test_absent_snapshot_removes_enablement_links_before_removing_new_unit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            current = root / "current"
            current.symlink_to("releases/new")
            unit = root / "host.service"
            unit.write_bytes(b"new unit\n")
            wants = root / "wants.service"
            wants.symlink_to(unit)
            calls = []

            def run(args):
                calls.append(args[1])
                if args[1] == "disable":
                    self.assertTrue(unit.exists())
                    wants.unlink()
                if args[1] == "daemon-reload":
                    self.assertFalse(unit.exists())
                    self.assertFalse(os.path.lexists(wants))
                return types.SimpleNamespace(returncode=0)

            with (
                    mock.patch.object(installer, "HOST_CURRENT", current),
                    mock.patch.object(installer, "HOST_UNIT", unit),
                    mock.patch.object(installer, "HOST_SERVICE", "host.service"),
                    mock.patch.object(installer, "_safe_current", side_effect=["releases/new", None]),
                    mock.patch.object(installer, "_run", side_effect=run),
                    mock.patch.object(installer, "_host_service_state", return_value={"present": False, "enabled": False, "active": False}),
            ):
                snapshot = {"current": None, "unit": None, "unitMode": None,
                            "servicePresent": False, "enabled": False, "active": False}
                self.assertTrue(installer._restore_host(snapshot))
            self.assertEqual(calls, ["stop", "disable", "daemon-reload"])
            self.assertFalse(os.path.lexists(current))

    def test_network_installer_failure_triggers_host_snapshot_rollback(self) -> None:
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as tmp:
            root = pathlib.Path(tmp)
            archive = root / "host.tar.gz"
            host_bytes = b"host"
            archive.write_bytes(host_bytes)
            artifacts = root / "network-artifacts"
            artifacts.mkdir()
            network_bytes = fake_elf()
            (artifacts / "myagents-host-network").write_bytes(network_bytes)
            (artifacts / "source-commit.txt").write_text("c" * 40 + "\n", encoding="ascii")
            lock_fd = os.open(root / "install.lock", os.O_CREAT | os.O_RDWR, 0o600)
            snapshot = {"current": "releases/old", "unit": b"old unit", "unitMode": 0o644,
                        "servicePresent": True, "enabled": True, "active": True}
            calls = []

            def run(args, **kwargs):
                calls.append(args)
                return types.SimpleNamespace(returncode=0 if len(calls) < 3 else 1)

            try:
                with (
                    mock.patch.object(installer.os, "geteuid", return_value=0),
                    mock.patch.object(installer.sys, "platform", "linux"),
                    mock.patch.object(installer.os, "uname", return_value=LINUX_X64),
                    mock.patch.object(installer, "_acquire_lock", return_value=lock_fd),
                    mock.patch.object(installer, "_snapshot_host", return_value=snapshot),
                    mock.patch.object(installer, "_restore_host", return_value=True) as restore,
                    mock.patch.object(installer.subprocess, "run", side_effect=run),
                    mock.patch.object(installer.pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=1000, pw_gid=1001)),
                ):
                    args = types.SimpleNamespace(
                        host_archive=str(archive), host_sha256=hashlib.sha256(host_bytes).hexdigest(),
                        network_artifact_dir=str(artifacts), network_sha256=hashlib.sha256(network_bytes).hexdigest(),
                        network_source_commit="c" * 40, owned_instance="https://owned.example",
                        public_tls_ca_file=None,
                    )
                    with self.assertRaisesRegex(installer.UnifiedInstallError, "prior Host release and unit were restored"):
                        installer.install(args)
            finally:
                try:
                    os.close(lock_fd)
                except OSError:
                    pass
            self.assertEqual(len(calls), 3)
            restore.assert_called_once_with(snapshot)


if __name__ == "__main__":
    unittest.main(verbosity=2)
