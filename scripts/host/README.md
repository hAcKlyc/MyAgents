# Linux Host test package

From the repository root, run `node scripts/host/build.mjs`. It cross-builds Linux x64/glibc bundles on macOS, downloads the pinned Node 24.20.0 and Claude SDK Linux x64 artifacts, and writes an unsigned test archive under `output/host/`. The package manifest records the source commit/dirty flag, versions, resource pins, and each installed file's SHA-256, size, and mode. The `.sha256` sidecar detects transfer damage; it is not a publisher signature.

Install only after confirming the expected archive digest through a separate trusted channel. The installer requires the caller to provide the digest and validates the archive and manifest before extracting or running package code:

```sh
sudo scripts/host/install.sh output/host/myagents-host-test-<release>.tar.gz --sha256 <independently-confirmed-64-hex-digest>
```

The paths, service account, unit, and socket are fixed to the `myagents-host-test` test installation. Repeating the same currently installed release is a verified no-op; a different release is refused while the service or Host lock is busy. Updates require an operator to inspect state and stop the service first. The installer waits for the service's Unix-socket `doctor` response with the expected Node version and SDK binary before it reports success. Automatic online updates and production signing are not implemented. Rollback is coded for failed installation/startup, but still needs a real Ubuntu/systemd failure-injection check.

The first install can start without an API credential. To add one later, keep the plaintext source in a root-only location, encrypt it to the systemd host key, and install only the encrypted credential under the root-owned configuration directory:

```sh
sudo install -d -o root -g root -m 0700 /etc/myagents-host-test/credentials
sudo systemd-creds encrypt --name=kimi --with-key=host /root/kimi-api-key /etc/myagents-host-test/credentials/kimi.cred
sudo chown root:root /etc/myagents-host-test/credentials/kimi.cred
sudo chmod 0600 /etc/myagents-host-test/credentials/kimi.cred
```

Because the initial service was created without the credential file, add a systemd drop-in so systemd exposes it as `CREDENTIALS_DIRECTORY/kimi` on the next start:

```sh
sudo install -d -o root -g root -m 0755 /etc/systemd/system/myagents-host-test.service.d
sudo tee /etc/systemd/system/myagents-host-test.service.d/credentials.conf >/dev/null <<'UNIT'
[Service]
LoadCredentialEncrypted=kimi:/etc/myagents-host-test/credentials/kimi.cred
UNIT
sudo systemd-analyze verify /etc/systemd/system/myagents-host-test.service
sudo systemctl daemon-reload
sudo systemctl restart myagents-host-test
```

The Host resolves this credential reference when it initializes a Session. Restarting the service after adding or replacing the encrypted file is required; changing the Host's persisted config alone does not load a new systemd credential. Do not put plaintext keys in the repository, service unit, or Host configuration.

The package does not enable Playwright/browser execution. Its bundled Node is self-contained; the installer and wrapper do not require system Node. Root installation, Linux runtime execution, systemd readiness, credential loading, busy-update refusal, and rollback have not been accepted on a real Ubuntu host by this build step.
