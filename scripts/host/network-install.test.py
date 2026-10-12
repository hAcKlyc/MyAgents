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
import argparse
import fcntl
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
    def test_profiles_are_closed_and_disjoint(self) -> None:
        installer.select_profile("moxbot-test")
        control.select_profile("moxbot-test")
        self.assertEqual(str(installer.PREFIX), "/opt/moxbot-host-network-test")
        self.assertEqual(str(installer.IDENTITY), "/var/lib/moxbot-host-test/host-identity.json")
        self.assertEqual(str(installer.CREDENTIAL), "/etc/moxbot-host-network-test/identity-kek.cred")
        self.assertEqual(installer.UNIT_NAME, "moxbot-host-network-test.service")
        self.assertEqual(str(control.HOST_UNIT), "/etc/systemd/system/moxbot-host-test.service")
        self.assertEqual(str(control.STATUS_FILE), "/run/moxbot-host-network-test/status.json")
        with self.assertRaises(installer.InstallError):
            installer.select_profile("/var/lib/arbitrary")
        with self.assertRaises(ValueError):
            control.select_profile("/var/lib/arbitrary")
        installer.select_profile("myagents-test")
        control.select_profile("myagents-test")

    def test_profile_marker_cannot_authorize_the_other_namespace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            marker = pathlib.Path(tmp) / "fixture.json"
            installer.select_profile("moxbot-test")
            marker.write_text(json.dumps({"kind": "myagents-headless-network",
                                          "serviceUser": "moxbot-host-network-test",
                                          "profile": "moxbot-test"}), encoding="utf-8")
            os.chmod(marker, 0o600)
            self.assertTrue(installer.validate_marker(marker, os.geteuid(), os.getegid()))
            marker.write_text(json.dumps({"kind": "myagents-headless-network",
                                          "serviceUser": "myagents-host-network-test"}), encoding="utf-8")
            with self.assertRaises(installer.InstallError):
                installer.validate_marker(marker, os.geteuid(), os.getegid())
            installer.select_profile("myagents-test")

    def test_transaction_lock_reentry_contention_and_foreign_fd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            lock = root / "transaction.lock"
            foreign = root / "foreign.lock"
            foreign.write_bytes(b"")
            uid, gid = os.geteuid(), os.getegid()
            with mock.patch.object(installer, "INSTALL_LOCK", lock):
                held = installer._acquire_install_lock(uid, gid)
                inherited = fcntl.fcntl(held, fcntl.F_DUPFD, 20)
                try:
                    self.assertGreaterEqual(inherited, 20)
                    with mock.patch.dict(os.environ, {"MYAGENTS_HOST_TRANSACTION_LOCK_FD": str(inherited)}):
                        reentered = installer._acquire_install_lock(uid, gid)
                        self.assertEqual(reentered, inherited)
                        os.close(reentered)
                    with mock.patch.dict(os.environ, {}, clear=True):
                        with self.assertRaises(BlockingIOError):
                            installer._acquire_install_lock(uid, gid)
                    readonly = os.open(lock, os.O_RDONLY)
                    try:
                        with mock.patch.dict(os.environ, {"MYAGENTS_HOST_TRANSACTION_LOCK_FD": str(readonly)}):
                            with self.assertRaises(installer.InstallError):
                                installer._acquire_install_lock(uid, gid)
                    finally:
                        try:
                            os.close(readonly)
                        except OSError:
                            pass
                    wrong = os.open(foreign, os.O_RDWR)
                    try:
                        with mock.patch.dict(os.environ, {"MYAGENTS_HOST_TRANSACTION_LOCK_FD": str(wrong)}):
                            with self.assertRaises(installer.InstallError):
                                installer._acquire_install_lock(uid, gid)
                    finally:
                        try:
                            os.close(wrong)
                        except OSError:
                            pass
                finally:
                    os.close(held)

    def test_owned_instance_unit_is_opt_in_and_binds_complete_fixed_ipc_tuple(self) -> None:
        defaults = argparse.Namespace(owned_instance=None, public_tls_ca_file=None,
                                     management_socket=None, management_host_uid=None)
        self.assertIsNone(installer.owned_config_text(defaults, 1000, 1001))
        base_unit = installer._unit_text("11111111-2222-4333-8444-555555555555")
        self.assertNotIn("--owned-instance", base_unit)
        self.assertNotIn("--management-socket", base_unit)

        owned = argparse.Namespace(owned_instance="https://owned.example:15557", public_tls_ca_file=None,
                                   management_socket=str(installer.MANAGEMENT_SOCKET),
                                   management_host_uid=1000)
        config = json.loads(installer.owned_config_text(owned, 1000, 7012))
        self.assertEqual(config["managementGid"], 7012)
        network_account = type("Account", (), {"pw_uid": 7000, "pw_gid": 7012})()
        node_account = type("Account", (), {"pw_uid": 1000, "pw_gid": 1001})()
        # Default official profile keeps Node's primary group on both the
        # setgid directory and the replaceable status inode. Rust's temp file
        # inherits this group, so status.rs can atomically replace the file;
        # Node needs no supplementary group to read it.
        default_tmpfiles = installer._tmpfiles_text(network_account, node_account)
        self.assertIn("d /run/myagents-host-network-test 2750 7000 1001 - -", default_tmpfiles)
        self.assertIn("f /run/myagents-host-network-test/status.json 0640 7000 1001 - -", default_tmpfiles)
        default_groups = [int(line.split()[4]) for line in default_tmpfiles.splitlines()]
        self.assertEqual(default_groups, [node_account.pw_gid, node_account.pw_gid])

        # Owned IPC requires Rust's socket parent group to equal the network
        # primary GID. Node receives that group only in the explicit owned-mode
        # systemd drop-in; the status inode must match the setgid parent too.
        owned_tmpfiles = installer._tmpfiles_text(network_account, node_account, config)
        self.assertIn("d /run/myagents-host-network-test 2750 7000 7012 - -", owned_tmpfiles)
        self.assertIn("f /run/myagents-host-network-test/status.json 0640 7000 7012 - -", owned_tmpfiles)
        owned_groups = [int(line.split()[4]) for line in owned_tmpfiles.splitlines()]
        self.assertEqual(owned_groups, [network_account.pw_gid, network_account.pw_gid])
        unit = installer._unit_text("11111111-2222-4333-8444-555555555555", config)
        self.assertIn("--owned-instance https://owned.example:15557", unit)
        self.assertIn(f"--management-socket {installer.MANAGEMENT_SOCKET}", unit)
        self.assertIn("--management-host-uid 1000 --management-gid 7012", unit)
        self.assertNotIn("--join", unit)

    def test_owned_instance_rejects_non_https_ambiguous_origin_and_partial_ipc(self) -> None:
        for origin in ("http://owned.example", "https://user@owned.example", "https://owned.example/path",
                       "https://owned.example/", "https://owned.example?", "https://owned.example#",
                       "https://owned.example:443", "https://owned.example:", "https://OWNED.example",
                       "https://owned.example;ExecStart=x"):
            with self.subTest(origin=origin), self.assertRaises(installer.InstallError):
                installer.validate_owned_origin(origin)
        partial = argparse.Namespace(owned_instance="https://owned.example", public_tls_ca_file=None,
                                     management_socket=str(installer.MANAGEMENT_SOCKET),
                                     management_host_uid=None)
        with self.assertRaises(installer.InstallError):
            installer.owned_config_text(partial, 1000, 1001)

    def test_marker_must_match_exact_test_fixture(self) -> None:
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as tmp:
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

    def test_default_device_pin_follows_selected_profile_at_call_time(self) -> None:
        myagents_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        moxbot_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp).resolve()
            os.chmod(root, 0o755)
            myagents_pin = root / "myagents-device-id.json"
            moxbot_pin = root / "moxbot-device-id.json"
            for path, host_id in ((myagents_pin, myagents_id), (moxbot_pin, moxbot_id)):
                path.write_text(json.dumps({"schemaVersion": 1, "hostId": host_id}) + "\n", encoding="utf-8")
                os.chmod(path, 0o600)
            installer.select_profile("moxbot-test")
            try:
                # Model the profile-selected absolute pin while keeping the test
                # isolated from both fixed /opt namespaces.
                with mock.patch.object(installer, "DEVICE_PIN", moxbot_pin):
                    self.assertEqual(installer.read_device_pin(owner=os.getuid(), group=os.getgid()), moxbot_id)
                installer.select_profile("myagents-test")
                with mock.patch.object(installer, "DEVICE_PIN", myagents_pin):
                    self.assertEqual(installer.read_device_pin(owner=os.getuid(), group=os.getgid()), myagents_id)
            finally:
                installer.select_profile("myagents-test")

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
    @mock.patch.object(control, "owned_config", return_value={
        "schemaVersion": 1,
        "ownedInstance": "https://owned.example",
        "caFile": str(control.OWNED_CA),
        "managementSocket": str(control.MANAGEMENT_SOCKET),
        "managementHostUid": 1000,
        "managementGid": 1001,
    })
    @mock.patch.object(control, "verified_host_id", return_value="11111111-2222-4333-8444-555555555555")
    @mock.patch.object(control.subprocess, "run")
    @mock.patch.object(control.pwd, "getpwnam")
    @mock.patch.object(control.os, "geteuid", return_value=0)
    def test_owned_auth_start_passes_fixed_instance_and_ca_without_secret_arguments(self, _uid, get_user, run, _host, _config):
        get_user.return_value = type("Account", (), {"pw_uid": 7001, "pw_gid": 7001})()
        run.return_value.returncode = 0
        self.assertEqual(control.run_control("start"), 0)
        args = run.call_args.args[0]
        self.assertIn("owned-auth-start", args)
        self.assertIn("--owned-instance", args)
        self.assertIn("https://owned.example", args)
        self.assertIn("--public-tls-ca-file", args)
        self.assertNotIn("token", args)

    def test_explicit_join_is_a_separate_fixed_one_shot_override(self) -> None:
        config = {"ownedInstance": "https://owned.example", "caFile": None,
                  "managementSocket": str(control.MANAGEMENT_SOCKET),
                  "managementHostUid": 1000, "managementGid": 7012}
        override = control._network_join_override(config, "11111111-2222-4333-8444-555555555555").decode()
        self.assertIn("ExecStart=\n", override)
        self.assertTrue(override.rstrip().endswith('"--join"'))
        self.assertIn('"--owned-instance" "https://owned.example"', override)

    def test_canonical_origin_rejects_default_and_empty_port_before_rust(self) -> None:
        for origin in ("https://owned.example:443", "https://owned.example:", "https://OWNED.example", "https://owned.example/"):
            with self.subTest(origin=origin):
                self.assertFalse(control._canonical_owned_origin(origin))
        self.assertTrue(control._canonical_owned_origin("https://owned.example:15557"))

    def test_join_waits_for_management_socket_before_restarting_host(self) -> None:
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as tmp:
            root = pathlib.Path(tmp)
            daemon_dropin = root / "network.service.d"
            join_dropin = daemon_dropin / "one-shot-join.conf"
            host_dropin_dir = root / "host.service.d"
            host_dropin = host_dropin_dir / "owned-management.conf"
            host_unit = root / "host.service"
            host_unit.write_text("[Service]\n", encoding="ascii")
            order = []
            config = {"ownedInstance": "https://owned.example", "caFile": None,
                      "managementSocket": str(control.MANAGEMENT_SOCKET),
                      "managementHostUid": 1000, "managementGid": 7012}

            def run(args, **kwargs):
                order.append(tuple(args))
                is_network_probe = args[:3] == ["systemctl", "is-active", "--quiet"] and args[3] == control.DAEMON_UNIT
                return type("Result", (), {"returncode": 1 if is_network_probe else 0})()

            def write_new(path, payload, mode):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
                os.chmod(path, mode)

            with (
                mock.patch.object(control, "DAEMON_DROPIN_DIR", daemon_dropin),
                mock.patch.object(control, "JOIN_DROPIN", join_dropin),
                mock.patch.object(control, "HOST_DROPIN_DIR", host_dropin_dir),
                mock.patch.object(control, "HOST_DROPIN", host_dropin),
                mock.patch.object(control, "HOST_UNIT", host_unit),
                mock.patch.object(control, "_ensure_root_dropin_dir", side_effect=lambda path: path.mkdir(parents=True, exist_ok=True)),
                mock.patch.object(control, "_network_join_override", return_value=b"[Service]\\nExecStart=join\\n"),
                mock.patch.object(control, "_write_new_root_file", side_effect=write_new),
                mock.patch.object(control, "_wait_management_socket", side_effect=lambda _cfg: order.append(("socket-ready",))),
                mock.patch.object(control, "_host_dropin", side_effect=lambda _cfg: (b"env", True)),
                mock.patch.object(control.os, "chown"),
                mock.patch.object(control.subprocess, "run", side_effect=run),
            ):
                self.assertEqual(control._activate_owned("join", config, "11111111-2222-4333-8444-555555555555"), 0)

            self.assertFalse(join_dropin.exists())
            with mock.patch.object(control.pwd, "getpwnam", return_value=type("Account", (), {"pw_uid": 7001})()):
                self.assertIn(f"SupplementaryGroups={control.USER}\n",
                              control._management_dropin_bytes(config).decode("ascii"))
            self.assertLess(order.index(("socket-ready",)), order.index(("systemctl", "restart", host_unit.name)))
            self.assertTrue(any(call[:2] == ("systemctl", "start") and call[2] == control.DAEMON_UNIT for call in order))

    def test_listener_failure_stops_network_without_restarting_host(self) -> None:
        config = {"ownedInstance": "https://owned.example", "caFile": None,
                  "managementSocket": str(control.MANAGEMENT_SOCKET),
                  "managementHostUid": 1000, "managementGid": 7012}
        calls = []

        def run(args, **kwargs):
            calls.append(tuple(args))
            return type("Result", (), {"returncode": 0})()

        with (
            mock.patch.object(control.subprocess, "run", side_effect=run),
            mock.patch.object(control, "_wait_management_socket", side_effect=ValueError("socket readiness timeout")),
            mock.patch.object(control, "_host_dropin") as host_dropin,
        ):
            with self.assertRaisesRegex(ValueError, "socket readiness timeout"):
                control._activate_owned("run", config, "11111111-2222-4333-8444-555555555555")
        host_dropin.assert_not_called()
        self.assertIn(("systemctl", "stop", control.DAEMON_UNIT), calls)
        self.assertFalse(any(call[0] == "systemctl" and call[1] in {"start", "restart"}
                             and call[-1] == "myagents-host-test.service" for call in calls))

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
