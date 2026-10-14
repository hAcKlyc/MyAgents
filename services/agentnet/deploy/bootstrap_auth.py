#!/usr/bin/env python3
"""Prepare private Dex deployment files; never starts containers or opens ports."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
from urllib.parse import urlsplit
import uuid

DEX_IMAGE = "ghcr.io/dexidp/dex:v2.46.0"


def https_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("issuer and callback must be fixed HTTPS URLs")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("invalid HTTPS port") from error
    return value.rstrip("/")


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_size > 32768):
            raise ValueError("secret input must be a private, owner-controlled regular file")
        data = os.read(fd, 32769)
        if len(data) > 32768:
            raise ValueError("secret input is too large")
        return data
    finally:
        os.close(fd)


def bcrypt_hash(password):
    # htpasswd accepts the password on stdin, never in process arguments.
    executable = shutil.which("htpasswd")
    if not executable:
        raise ValueError("htpasswd is required (apache2-utils on Debian/Ubuntu)")
    result = subprocess.run([executable, "-niBC", "12", "bootstrap"],
                            input=password.encode() + b"\n", capture_output=True,
                            check=False, timeout=20)
    if result.returncode:
        raise ValueError("password hashing failed")
    hashed = result.stdout.decode().strip().partition(":")[2]
    if not re.fullmatch(r"\$2[aby]\$12\$[./A-Za-z0-9]{53}", hashed):
        raise ValueError("password hash format is invalid")
    return hashed


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(fd)


def prepare(output, issuer, callback, email, username, password, *, tls=None,
            hasher=bcrypt_hash):
    issuer = https_url(issuer)
    callback = https_url(callback)
    if (not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)
            or not 1 <= len(email) <= 254 or not 1 <= len(username) <= 80
            or any(ord(char) < 32 for char in username)):
        raise ValueError("valid email and display name are required")
    # bcrypt truncates after 72 bytes; reject instead of silently truncating.
    if not 16 <= len(password.encode()) <= 72 or any(char in password for char in "\r\n\0"):
        raise ValueError("password must contain 16–72 UTF-8 bytes with no line breaks")
    hashed = hasher(password)
    client_secret = secrets.token_urlsafe(48)
    web = {"http": "0.0.0.0:5556"}
    if tls:
        web = {"https": "0.0.0.0:5556", "tlsCert": "/etc/dex/tls.crt",
               "tlsKey": "/etc/dex/tls.key"}
    config = {
        "issuer": issuer,
        "storage": {"type": "sqlite3", "config": {"file": "/var/dex/dex.db"}},
        "web": web,
        "logger": {"level": "error", "format": "json"},
        "frontend": {"dir": "/etc/dex/web", "theme": "moxbots", "issuer": "MoXBots"},
        "oauth2": {"responseTypes": ["code"], "skipApprovalScreen": False},
        "enablePasswordDB": True,
        "staticPasswords": [{"email": email, "username": username,
                             "userID": str(uuid.uuid4()), "hash": hashed}],
        "staticClients": [{"id": "myagents-agentnet", "name": "MoXBots",
                           "secret": client_secret, "redirectURIs": [callback]}],
    }
    mounts = ["./dex.json:/etc/dex/config.json:ro", "./dex-state:/var/dex", "./web:/etc/dex/web:ro"]
    if tls:
        mounts.extend(["./tls.crt:/etc/dex/tls.crt:ro", "./tls.key:/etc/dex/tls.key:ro"])
    compose = {"name": "myagents-owned-auth", "services": {"dex": {
        "image": DEX_IMAGE, "user": f"{os.getuid()}:{os.getgid()}",
        "command": ["dex", "serve", "/etc/dex/config.json"],
        "restart": "unless-stopped", "read_only": True,
        "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
        "ports": ["127.0.0.1:15556:5556"], "volumes": mounts,
        "tmpfs": ["/tmp:rw,noexec,nosuid,size=16m"],
        "logging": {"driver": "json-file", "options": {"max-size": "5m", "max-file": "2"}},
    }}}
    # This creates a new bundle only; never overwrites existing users or state.
    output = Path(output).absolute()
    parent = output.parent
    if parent.resolve() != parent or not parent.is_dir():
        raise ValueError("bundle parent must be an existing non-symlink directory")
    old_mask = os.umask(0o077)
    try:
        output.mkdir(mode=0o700)
        (output / "dex-state").mkdir(mode=0o700)
        shutil.copytree(Path(__file__).with_name("dex-web"), output / "web")
        (output / "web").chmod(0o700)
        write_private(output / "dex.json", (json.dumps(config, indent=2) + "\n").encode())
        write_private(output / "oidc-client-secret", client_secret.encode())
        write_private(output / "compose.json", (json.dumps(compose, indent=2) + "\n").encode())
        if tls:
            write_private(output / "tls.crt", tls[0])
            write_private(output / "tls.key", tls[1])
    finally:
        os.umask(old_mask)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--issuer", required=True)
    parser.add_argument("--callback", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--username", default="Administrator")
    parser.add_argument("--password-file")
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    args = parser.parse_args()
    try:
        if bool(args.tls_cert) != bool(args.tls_key):
            raise ValueError("provide both TLS certificate and key")
        password = (read_private(args.password_file).decode().removesuffix("\n")
                    if args.password_file else getpass.getpass("Initial account password: "))
        tls = (read_private(args.tls_cert), read_private(args.tls_key)) if args.tls_cert else None
        prepare(args.output, args.issuer, args.callback, args.email, args.username,
                password, tls=tls)
        print("Private authentication bundle prepared; no service has been started.")
    except (ValueError, OSError, subprocess.SubprocessError, UnicodeError):
        # Input errors may contain credentials/paths; do not print their objects.
        print("Authentication bundle preparation failed; check inputs and prerequisites.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
