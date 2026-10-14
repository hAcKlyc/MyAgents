import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("bootstrap_auth", Path(__file__).with_name("bootstrap_auth.py"))
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def prepare(self, output, **kwargs):
        return bootstrap.prepare(output, kwargs.get("issuer", "https://auth.example.test/dex"),
                                 "https://network.example.test/auth/callback", "admin@example.test",
                                 "Administrator", "test-only-long-password",
                                 hasher=lambda _: "$2b$12$" + "a" * 53,
                                 tls=kwargs.get("tls"))

    def test_bundle_is_private_loopback_and_has_no_password_grant(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root).resolve() / "auth"
            self.prepare(output)
            config = json.loads((output / "dex.json").read_text())
            compose = json.loads((output / "compose.json").read_text())
            self.assertEqual(compose["services"]["dex"]["ports"], ["127.0.0.1:15556:5556"])
            self.assertEqual(config["oauth2"]["responseTypes"], ["code"])
            self.assertNotIn("passwordConnector", config["oauth2"])
            self.assertEqual(config["frontend"], {"dir": "/etc/dex/web", "theme": "moxbots", "issuer": "MoXBots"})
            self.assertIn("./web:/etc/dex/web:ro", compose["services"]["dex"]["volumes"])
            password_template = (output / "web/templates/password.html").read_text()
            self.assertIn("登录云后台", password_template)
            self.assertTrue((output / "web/robots.txt").is_file())
            self.assertTrue((output / "web/static/main.css").is_file())
            self.assertIn('action="{{ .PostURL }}"', password_template)
            self.assertIn('name="login"', password_template)
            self.assertIn('name="password"', password_template)
            self.assertEqual(config["staticClients"][0]["secret"],
                             (output / "oidc-client-secret").read_text())
            self.assertNotIn("test-only-long-password", (output / "dex.json").read_text())
            for path in output.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
            original = (output / "dex.json").read_bytes()
            with self.assertRaises(FileExistsError):
                self.prepare(output)
            self.assertEqual(original, (output / "dex.json").read_bytes())

    def test_rejects_http_and_credential_urls_before_creating_files(self):
        with tempfile.TemporaryDirectory() as root:
            for value in ["http://127.0.0.1/dex", "https://user:secret@example.test/dex",
                          "https://example.test/dex?secret=hidden", "https://example.test:bad/dex"]:
                path = Path(root).resolve() / "auth"
                with self.assertRaises(ValueError):
                    self.prepare(path, issuer=value)
                self.assertFalse(path.exists())

    def test_real_hash_is_salted_and_long_passwords_do_not_truncate(self):
        password = "temporary-test-password-32-bytes"
        first = bootstrap.bcrypt_hash(password)
        second = bootstrap.bcrypt_hash(password)
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith(("$2a$12$", "$2b$12$", "$2y$12$")))
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                bootstrap.prepare(Path(root).resolve() / "auth", "https://example.test/dex",
                                  "https://example.test/auth/callback", "admin@example.test",
                                  "Admin", "a" * 73)

    def test_secret_files_reject_symlink_and_readable_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "password"
            path.write_text("temporary-password")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                bootstrap.read_private(path)
            path.chmod(0o600)
            link = Path(root) / "linked"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                bootstrap.read_private(link)
            self.assertEqual(bootstrap.read_private(path), b"temporary-password")
            os.link(path, Path(root) / "hardlink")
            with self.assertRaises(ValueError):
                bootstrap.read_private(path)

    def test_tls_mounts_are_read_only_and_private(self):
        with tempfile.TemporaryDirectory() as root:
            output = self.prepare(Path(root).resolve() / "auth", tls=(b"certificate", b"private-key"))
            config = json.loads((output / "dex.json").read_text())
            self.assertNotIn("http", config["web"])
            self.assertEqual(config["web"]["https"], "0.0.0.0:5556")
            self.assertEqual(stat.S_IMODE((output / "tls.key").stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
