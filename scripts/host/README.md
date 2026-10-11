# Linux Host test package

From the repository root, run `node scripts/host/build.mjs`. It cross-builds Linux x64/glibc bundles on macOS, downloads the pinned Node 24.20.0 and Claude SDK Linux x64 artifacts, and writes an unsigned test archive under `output/host/`. The package manifest records the source commit/dirty flag, versions, resource pins, and each installed file's SHA-256, size, and mode. The `.sha256` sidecar detects transfer damage; it is not a publisher signature. A clean source build also emits `install-<releaseId>.sh`, pinned to the matching `host-test-<releaseId>` GitHub prerelease, source commit, archive digest, and raw `install.sh` digest. Dirty builds still produce development archives but deliberately omit this bootstrap.

After the maintainer creates that exact prerelease and uploads the archive and generated bootstrap assets, use the maintainer-provided command to fetch the bootstrap by its numeric GitHub release asset ID with `Accept: application/octet-stream`; asset IDs exist only after upload. Do not guess an ID or use the browser download URL. Then run it with `sudo bash install-<releaseId>.sh`. The bootstrap requires root, Linux x86_64 with glibc, and the existing `curl`, `sha256sum`, `bash`, `tar`, `mktemp`, `getconf`, `flock`, and `python3` commands. It queries only the fixed `api.github.com/repos/heavenzhang/MyAgents/releases/tags/<pinned-tag>` endpoint, validates the exact tag, published state, pinned source commit, unique exact archive asset name, and positive integer asset ID, then downloads through the fixed GitHub API asset endpoint with `Accept: application/octet-stream`. It never follows a metadata-provided URL. It validates both pinned SHA-256 values before invoking the installer and uses a temporary directory removed on exit. It does not configure networking or install desktop components. The bootstrap and package are unsigned internal test artifacts: embedded checksums detect mismatches but do not authenticate the publisher. Review the bootstrap from a trusted source before use; no matching release is implied to exist until the maintainer publishes it.

Install only after confirming the expected archive digest through a separate trusted channel. The installer requires the caller to provide the digest and validates the archive and manifest before extracting or running package code:

```sh
sudo scripts/host/install.sh output/host/myagents-host-test-<release>.tar.gz --sha256 <independently-confirmed-64-hex-digest>
```

The paths, service account, unit, and socket are fixed to the `myagents-host-test` test installation. Repeating the same currently installed release is a verified no-op; a different release is refused while the service or Host lock is busy. Updates require an operator to inspect state and stop the service first. The installer waits for the service's Unix-socket `doctor` response with the expected Node version and SDK binary before it reports success. Automatic online updates and production signing are not implemented. Rollback has passed an isolated Ubuntu 24.04/systemd 255 forced-startup-failure check; the prior release, service, identity and settings were restored.

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

The package does not enable Playwright/browser execution. Its bundled Node is self-contained; the installer and wrapper do not require system Node. Root installation, Linux runtime bootstrap, systemd readiness, encrypted credential projection, busy-update refusal, identity/config persistence and failed-startup rollback have been checked on an isolated Ubuntu 24.04 host. A synthetic credential with execution authorization disabled proved Session creation and persistence without model calls; real Kimi execution and AgentNet remain open acceptance gates. See `specs/tech_docs/linux_host.md`.
