"""Boot activation and diagnostics must preserve the existing owned network."""
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("network-control.py")
spec = importlib.util.spec_from_file_location("control_daemon", SCRIPT)
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)
DEVICE = "11111111-2222-4333-8444-555555555555"
NETWORK = "22222222-3333-4444-8555-666666666666"
CONFIG = {"ownedInstance": "https://owned.example", "managementSocket": str(control.MANAGEMENT_SOCKET),
          "managementHostUid": 993, "managementGid": 984, "caFile": None}


class DaemonTests(unittest.TestCase):
    def test_status_dropin_is_additive_idempotent_and_rejects_changed_content(self):
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as tmp:
            directory = pathlib.Path(tmp)
            legacy = directory / "owned-management.conf"
            legacy.write_bytes(b"existing management and policy must survive\n")
            info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0, st_gid=0, st_nlink=1, st_size=128)
            with (mock.patch.object(control, "HOST_DROPIN_DIR", directory),
                  mock.patch.object(control, "_ensure_root_dropin_dir"),
                  mock.patch.object(control.pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=990)),
                  mock.patch.object(control, "_write_new_root_file", side_effect=lambda path, data, mode: path.write_bytes(data))):
                self.assertTrue(control._host_status_dropin(CONFIG))
                expected = b"[Service]\nEnvironment=MYAGENTS_HOST_NETWORK_STATUS=/run/myagents-host-network-test/status.json\nEnvironment=MYAGENTS_HOST_NETWORK_UID=990\n"
                info.st_size = len(expected)
                path = directory / "network-status.conf"
                self.assertEqual(path.read_bytes(), expected)
                with mock.patch.object(pathlib.Path, "lstat", return_value=info):
                    self.assertFalse(control._host_status_dropin(CONFIG))
                    path.write_bytes(b"manual unknown content\n")
                    with self.assertRaisesRegex(ValueError, "unexpected content"):
                        control._host_status_dropin(CONFIG)
                self.assertEqual(legacy.read_bytes(), b"existing management and policy must survive\n")
                self.assertEqual(path.read_bytes(), b"manual unknown content\n")

    def test_boot_activation_requires_explicit_flag_and_ready_identity(self):
        calls = []
        with (mock.patch.object(control.os, "geteuid", return_value=0),
              mock.patch.object(control, "verified_host_id", return_value=DEVICE),
              mock.patch.object(control, "owned_config", return_value=CONFIG),
              mock.patch.object(control, "_activate_owned", return_value=0),
              mock.patch.object(control, "_wait_ready_status", side_effect=lambda device: calls.append(("ready", device))),
              mock.patch.object(control.subprocess, "run", side_effect=lambda args, **kw: calls.append(tuple(args)))):
            self.assertEqual(control.run_control("run"), 0)
            self.assertEqual(calls, [])
            self.assertEqual(control.run_control("run", enable_on_boot=True), 0)
            self.assertEqual(calls, [("ready", DEVICE), ("systemctl", "enable", control.DAEMON_UNIT)])
            with mock.patch.object(control, "_wait_ready_status", side_effect=ValueError("expired")):
                with self.assertRaises(ValueError):
                    control.run_control("run", enable_on_boot=True)
            self.assertEqual(len(calls), 2)

    def test_boot_flag_rejects_auth_and_unowned_commands(self):
        with (mock.patch.object(control.os, "geteuid", return_value=0),
              mock.patch.object(control, "verified_host_id", return_value=DEVICE),
              mock.patch.object(control, "owned_config", return_value=None),
              mock.patch.object(control.subprocess, "run") as run):
            for command in ("start", "wait", "cancel", "logout", "status", "run"):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    control.run_control(command, enable_on_boot=True)
            run.assert_not_called()

    def test_failure_and_rejected_join_keep_an_existing_network_running(self):
        calls = []
        def run(args, **kwargs):
            calls.append(tuple(args))
            return types.SimpleNamespace(returncode=0)
        with (mock.patch.object(control.subprocess, "run", side_effect=run),
              mock.patch.object(control, "_wait_management_socket", side_effect=ValueError("not ready"))):
            with self.assertRaises(ValueError):
                control._activate_owned("run", CONFIG, DEVICE)
            with self.assertRaisesRegex(ValueError, "stop the network"):
                control._activate_owned("join", CONFIG, DEVICE)
        self.assertNotIn(("systemctl", "stop", control.DAEMON_UNIT), calls)
        self.assertFalse(any(c[:2] == ("systemctl", "restart") for c in calls))

    def test_ready_projection_checks_owner_process_identity_and_freshness(self):
        with tempfile.TemporaryDirectory(dir=SCRIPT.parent) as tmp:
            path = pathlib.Path(tmp) / "status.json"
            value = {"deviceId": DEVICE, "networkId": NETWORK, "pid": 4321, "ready": True,
                     "state": "ready", "errorCode": None, "updatedAt": int(time.time())}
            account = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
            def write(v):
                path.write_text(json.dumps(v)); path.chmod(0o640)
            write(value)
            with (mock.patch.object(control, "STATUS_FILE", path),
                  mock.patch.object(control.pwd, "getpwnam", return_value=account),
                  mock.patch.object(control.subprocess, "run", return_value=types.SimpleNamespace(stdout="4321\n"))):
                control._wait_ready_status(DEVICE)
                for change in ({"deviceId": NETWORK}, {"pid": 4322}, {"updatedAt": 0},
                               {"state": "signedOut", "ready": False}, {"networkId": None}):
                    write({**value, **change})
                    with self.subTest(change=change), self.assertRaises(ValueError):
                        control._wait_ready_status(DEVICE)
                write(value)
                path.chmod(0o666)
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    control._wait_ready_status(DEVICE)


if __name__ == "__main__":
    unittest.main()
