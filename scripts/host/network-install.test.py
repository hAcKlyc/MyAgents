#!/usr/bin/env python3
"""Scratch tests for safe artifact intake and the isolated network installer."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("network-install.py")
SPEC = importlib.util.spec_from_file_location("network_install", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(installer)
CONTROL_SPEC = importlib.util.spec_from_file_location("network_control", SCRIPT.with_name("network-control.py"))
control = importlib.util.module_from_spec(CONTROL_SPEC)
assert CONTROL_SPEC and CONTROL_SPEC.loader
CONTROL_SPEC.loader.exec_module(control)

COMMIT = "a" * 40


def fake_elf() -> bytes:
    # Minimal ELF64 little-endian x86_64 header; tests never execute it.
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    header[16:18] = (2).to_bytes(2, "little")
    header[18:20] = (62).to_bytes(2, "little")
    return bytes(header)


class SnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.artifact = self.root / "artifact"
        self.artifact.mkdir()
        self.payload = fake_elf()
        (self.artifact / installer.ARTIFACT).write_bytes(self.payload)
        (self.artifact / "source-commit.txt").write_text(COMMIT + "\n", encoding="ascii")
        self.dest = self.root / "snapshot"
        self.dest.mkdir(mode=0o700)
        self.sha = hashlib.sha256(self.payload).hexdigest()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def copy(self, source: pathlib.Path | None = None, sha: str | None = None,
             commit: str = COMMIT) -> pathlib.Path:
        path = source if source is not None else self.artifact.resolve()
        return installer.copy_snapshot(str(path), self.dest, sha or self.sha, commit)

    def test_pinned_artifact_is_copied_and_made_non_writable(self) -> None:
        result = self.copy()
        self.assertEqual(result.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(result.stat().st_mode), 0o500)
        self.assertEqual(stat.S_IMODE((self.dest / "source-commit.txt").stat().st_mode), 0o400)

    def test_wrong_digest_and_source_commit_are_rejected(self) -> None:
        with self.assertRaises(installer.InstallError):
            self.copy(sha="0" * 64)
        for item in self.dest.iterdir():
            item.unlink()
        with self.assertRaises(installer.InstallError):
            self.copy(commit="b" * 40)

    def test_symlink_directory_component_is_rejected(self) -> None:
        canonical_root = self.root.resolve()
        outside = canonical_root / "outside"
        outside.mkdir()
        for name in (installer.ARTIFACT, "source-commit.txt"):
            (outside / name).write_bytes((self.artifact / name).read_bytes())
        link = canonical_root / "linked"
        link.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.copy(source=link)

    def test_symlink_and_hardlink_artifacts_are_rejected(self) -> None:
        binary = self.artifact / installer.ARTIFACT
        saved = self.root / "saved"
        binary.rename(saved)
        binary.symlink_to(saved)
        with self.assertRaises(OSError):
            self.copy()
        binary.unlink()
        os.link(saved, binary)
        with self.assertRaises(installer.InstallError):
            self.copy()

    def test_fifo_artifact_is_rejected_without_blocking(self) -> None:
        binary = self.artifact / installer.ARTIFACT
        binary.unlink()
        os.mkfifo(binary)
        with self.assertRaises(installer.InstallError):
            self.copy()


class FixtureTests(unittest.TestCase):
    def test_marker_must_match_exact_test_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            prefix = pathlib.Path(tmp) / "prefix"
            prefix.mkdir()
            marker = prefix / "fixture.json"
            marker.write_text(json.dumps({"kind": "wrong", "serviceUser": installer.USER}))
            with self.assertRaises(installer.InstallError):
                installer.validate_marker(marker, os.getuid(), os.getgid())
            marker.write_text(json.dumps({"kind": "myagents-headless-network", "serviceUser": installer.USER}))
            os.chmod(marker, 0o600)
            self.assertTrue(installer.validate_marker(marker, os.getuid(), os.getgid()))
            marker.unlink()
            marker.symlink_to(prefix / "other")
            with self.assertRaises(installer.InstallError):
                installer.validate_marker(marker, os.getuid(), os.getgid())

    def test_device_pin_matches_current_identity_and_is_canonical(self) -> None:
        pinned = "abcdefab-cdef-4abc-8def-abcdefabcdef"
        self.assertEqual(installer.parse_device_pin(json.dumps({"schemaVersion": 1, "hostId": pinned}).encode()), pinned)
        installer.verify_device_pin(pinned, pinned)
        with self.assertRaises(installer.InstallError):
            installer.verify_device_pin("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pinned)
        with self.assertRaises(installer.InstallError):
            installer.parse_device_pin(json.dumps({"schemaVersion": 1, "hostId": pinned.upper()}).encode())

    def test_device_pin_rejects_unsafe_mode_symlink_and_missing_pin(self) -> None:
        pinned = "abcdefab-cdef-4abc-8def-abcdefabcdef"
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp).resolve()
            os.chmod(parent, 0o755)
            path = parent / "device-id.json"
            path.write_text(json.dumps({"schemaVersion": 1, "hostId": pinned}) + "\n")
            os.chmod(path, 0o600)
            self.assertEqual(installer.read_device_pin(path, owner=os.getuid(), group=os.getgid()), pinned)
            os.chmod(path, 0o640)
            with self.assertRaises(installer.InstallError):
                installer.read_device_pin(path, owner=os.getuid(), group=os.getgid())
            path.unlink()
            target = parent / "target"
            target.write_text(json.dumps({"schemaVersion": 1, "hostId": pinned}) + "\n")
            os.chmod(target, 0o600)
            path.symlink_to(target)
            with self.assertRaises(OSError):
                installer.read_device_pin(path, owner=os.getuid(), group=os.getgid())
            path.unlink()
            with self.assertRaises(installer.InstallError):
                installer.read_device_pin(path, owner=os.getuid(), group=os.getgid())

    def test_first_pin_is_written_once_and_is_not_replaced(self) -> None:
        host = "abcdefab-cdef-4abc-8def-abcdefabcdef"
        with tempfile.TemporaryDirectory() as tmp:
            parent = pathlib.Path(tmp).resolve()
            os.chmod(parent, 0o755)
            path = parent / "device-id.json"
            installer.create_device_pin(host, path, owner=os.getuid(), group=os.getgid())
            self.assertEqual(installer.read_device_pin(path, owner=os.getuid(), group=os.getgid()), host)
            with self.assertRaises(installer.InstallError):
                installer.create_device_pin("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path, owner=os.getuid(), group=os.getgid())
            self.assertEqual(installer.read_device_pin(path, owner=os.getuid(), group=os.getgid()), host)


class ControlTests(unittest.TestCase):
    @mock.patch.object(control, "verified_host_id", return_value="11111111-2222-4333-8444-555555555555")
    @mock.patch.object(control.subprocess, "run")
    @mock.patch.object(control.pwd, "getpwnam")
    @mock.patch.object(control.os, "geteuid", return_value=0)
    def test_auth_start_uses_fixed_transient_unit_and_forwards_terminal_output(self, _uid, get_user, run, _host):
        get_user.return_value = type("Account", (), {"pw_uid": 7001, "pw_gid": 7001})()
        run.return_value.returncode = 0
        self.assertEqual(control.run_control("start"), 0)
        args = run.call_args.args[0]
        self.assertIn("--pipe", args)
        self.assertIn("--wait", args)
        self.assertIn("--unit=myagents-host-network-test-auth-start.service", args)
        self.assertNotIn("--stdout", args)
        self.assertEqual(run.call_args.kwargs, {"check": False})

    @mock.patch.object(control.subprocess, "run")
    @mock.patch.object(control, "verified_host_id", return_value="11111111-2222-4333-8444-555555555555")
    @mock.patch.object(control.pwd, "getpwnam")
    @mock.patch.object(control.os, "geteuid", return_value=0)
    def test_status_does_not_project_or_read_encrypted_credential(self, _uid, get_user, _host, run):
        get_user.return_value = type("Account", (), {"pw_uid": 7001, "pw_gid": 7001})()
        run.return_value.returncode = 0
        self.assertEqual(control.run_control("status"), 0)
        args = run.call_args.args[0]
        self.assertIn("--unit=myagents-host-network-test-auth-status.service", args)
        self.assertFalse(any("LoadCredentialEncrypted" in item for item in args))
        self.assertEqual(args[-4:], [str(control.BIN), "status", "--status-file", str(control.STATUS_FILE)])

    @mock.patch.object(control.subprocess, "run")
    @mock.patch.object(control, "verified_host_id", return_value="11111111-2222-4333-8444-555555555555")
    @mock.patch.object(control.pwd, "getpwnam")
    @mock.patch.object(control.os, "geteuid", return_value=0)
    def test_run_validates_pin_then_starts_only_fixed_daemon_unit(self, _uid, get_user, _host, run):
        get_user.return_value = type("Account", (), {"pw_uid": 7001, "pw_gid": 7001})()
        run.return_value.returncode = 0
        self.assertEqual(control.run_control("run"), 0)
        run.assert_called_once_with(["systemctl", "start", control.DAEMON_UNIT], check=False)

    @mock.patch.object(control.subprocess, "run")
    @mock.patch.object(control, "verified_host_id", side_effect=ValueError("identity mismatch"))
    @mock.patch.object(control.pwd, "getpwnam")
    @mock.patch.object(control.os, "geteuid", return_value=0)
    def test_identity_pin_mismatch_stops_control_before_systemd(self, _uid, get_user, _host, run):
        get_user.return_value = type("Account", (), {"pw_uid": 7001, "pw_gid": 7001})()
        with self.assertRaises(ValueError):
            control.run_control("run")
        run.assert_not_called()

    @mock.patch.object(control.subprocess, "run")
    @mock.patch.object(control.os, "geteuid", return_value=0)
    def test_unlisted_command_is_rejected_without_subprocess(self, _uid, run):
        with self.assertRaises(ValueError):
            control.run_control("exec")
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
