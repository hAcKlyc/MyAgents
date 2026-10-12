# Linux Host test package

The separate Rust AgentNet connector, browser authorization and its real enrollment gate are described in [headless enrollment](../../specs/tech_docs/headless_enrollment.md). It does not require Provider/model credentials to publish an empty device catalog. The Node package below retains local execution ownership; a root-configured `MYAGENTS_HOST_NETWORK_STATUS` path and `MYAGENTS_HOST_NETWORK_UID` may expose the Rust connector's bounded diagnostic report through `doctor`, without granting Node access to account or device secrets.

From the repository root, run `node scripts/host/build.mjs`. It cross-builds Linux x64/glibc bundles on macOS, downloads the pinned Node 24.20.0 and Claude SDK Linux x64 artifacts, and writes an unsigned test archive under `output/host/`. The package manifest records the source commit/dirty flag, versions, resource pins, and each installed file's SHA-256, size, and mode. The `.sha256` sidecar detects transfer damage; it is not a publisher signature. A clean source build also emits `install-<releaseId>.sh`, pinned to the matching `host-test-<releaseId>` GitHub prerelease, source commit, archive digest, and raw `install.sh` digest. Dirty builds still produce development archives but deliberately omit this bootstrap.

After the maintainer creates that exact prerelease and uploads the archive and generated bootstrap assets, use the maintainer-provided command to fetch the bootstrap by its numeric GitHub release asset ID with `Accept: application/octet-stream`; asset IDs exist only after upload. Do not guess an ID or use the browser download URL. Then run it with `sudo bash install-<releaseId>.sh`. The bootstrap requires root, Linux x86_64 with glibc, and the existing `curl`, `sha256sum`, `bash`, `tar`, `mktemp`, `getconf`, `flock`, and `python3` commands. It queries only the fixed `api.github.com/repos/heavenzhang/MyAgents/releases/tags/<pinned-tag>` endpoint, validates the exact tag, published state, pinned source commit, unique exact archive asset name, and positive integer asset ID, then downloads the archive through the fixed GitHub API asset endpoint with `Accept: application/octet-stream`. It never follows a metadata-provided URL and makes no raw-source request. The generated bootstrap embeds installer bytes from the pinned source commit; Python strictly decodes them into its private temporary directory and verifies their pinned SHA-256 before executing the installer. It also verifies the archive SHA-256 before installer execution and removes temporary files on exit. It does not configure networking or install desktop components. The bootstrap and package are unsigned internal test artifacts: embedded checksums detect mismatches but do not authenticate the publisher. Review the bootstrap from a trusted source before use; no matching release is implied to exist until the maintainer publishes it.

Install only after confirming the expected archive digest through a separate trusted channel. The installer requires the caller to provide the digest and validates the archive and manifest before extracting or running package code:

```sh
sudo scripts/host/install.sh output/host/myagents-host-test-<release>.tar.gz --sha256 <independently-confirmed-64-hex-digest>
```

The paths, service account, unit, and socket are fixed to the `myagents-host-test` test installation. Repeating the same currently installed release is a verified no-op; a different release is refused while the service or Host lock is busy. Updates require an operator to inspect state and stop the service first. The installer waits for the service's Unix-socket `doctor` response with the expected Node version and SDK binary before it reports success. Automatic online updates and production signing are not implemented. Rollback has passed an isolated Ubuntu 24.04/systemd 255 forced-startup-failure check; the prior release, service, identity and settings were restored.

On first installation, the installer creates a random 32-byte provider-store master key in memory, pipes it directly to `systemd-creds encrypt --name=provider-key --with-key=host`, and atomically publishes only the encrypted file at `/etc/myagents-host-test/credentials/provider-key.cred`. The service receives it through `LoadCredentialEncrypted=provider-key:…` as `CREDENTIALS_DIRECTORY/provider-key`; Node uses it only to encrypt provider credentials saved through the local product configuration flow. The master key is not a model credential. It is never written in plaintext to a file, argument, environment variable, or installer output. A valid existing file is reused without rotation; an unsafe file or failed encryption stops installation. Once published, the encrypted key is preserved across rollback and reinstall.

This installer-side key lifecycle is not yet a complete remote UI or unified credential-management installation. The product form and its end-to-end persistence/runtime acceptance remain integration gates. Do not manually create a provider key or enter a real model credential for this test step.

Legacy Kimi projection remains supported for existing installations. New installs can include a pre-existing encrypted Kimi credential in the generated unit; for a running older installation, the historical manual procedure is:

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

The Host resolves this legacy credential reference when it initializes a Session. Restarting the service after adding or replacing the encrypted file is required; changing the Host's persisted config alone does not load a new systemd credential. Do not put plaintext keys in the repository, service unit, or Host configuration. This remains a compatibility procedure, not the recommended path for new provider credentials.

The package does not enable Playwright/browser execution. Its bundled Node is self-contained; the installer and wrapper do not require system Node. Root installation, Linux runtime bootstrap, systemd readiness, busy-update refusal, identity/config persistence and failed-startup rollback have been checked on an isolated Ubuntu 24.04 host. This provider-key installer change has only shell/static validation so far; `systemd-creds` host-key encryption and projection still require an isolated Linux install check. A synthetic credential with execution authorization disabled proved Session creation and persistence without model calls; real model execution and AgentNet remain open acceptance gates. See `specs/tech_docs/linux_host.md`.

## Recoverable local configuration

The existing private Unix-socket `configure` command accepts an optional `mutationId` UUID in its stdin JSON. Include the original `expectedRevision` and complete allowed intent (`providerId`, `model`, optional absolute `workspace`, and explicit `executionAuthorized`). Save this ID before submitting. Read it later with `myagents-host receipt <mutationId>`; the CLI does not resend automatically.

For tracked requests, `hostSettings` and a non-secret receipt are committed together in the original `config.json`. The same ID and canonical request return the original receipt without increasing revision, including after restart, while a Session is active or after its workspace disappears. Reusing the ID with different intent or revision fails. UUIDs are case-insensitive; an omitted workspace is the explicit default workspace. The supplied absolute workspace spelling is part of the intent hash; filesystem aliases are not collapsed during replay. A tracked CAS conflict is a durable `conflict` receipt; legacy calls without an ID retain their conflict error behavior.

`persisted` with `effect: new-session` means the desired default was saved, not that a live Session changed or a model executed. Persistence errors are `unconfirmed`: query the original ID. `not-found` is a lookup result, not proof that an in-flight request was rejected. The ledger retains up to 256 entries without automatic expiry/eviction; a full ledger rejects new tracked requests while keeping existing receipts and legacy local configuration available. Malformed or wrong-Host ledgers fail closed. Do not discard unresolved receipts to clear capacity.

This is a local owner capability, not an AgentNet wire schema or remote authorization mechanism. Future adapters must validate caller, grant, service and target generation and bind their operation scope before handing off to this owner. AgentNet production management remains unsupported until the authority publishes compatible contracts and real integration passes.
