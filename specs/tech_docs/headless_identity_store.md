# Headless device identity storage

Task: MAH-IDENTITY-20261012, part of MAH-LINUX-20261012. Implementation and
native acceptance are in progress. This is storage preparation for the existing
device identity flow, not proof of AgentNet enrollment or remote management.

## Reason and owner

The existing Linux `OsIdentityStore` explicitly uses Secret Service. The test
Host's actual service process has no session bus or XDG runtime directory; its
service UID has no user bus, and gnome-keyring is not installed. A systemd
credential is a read-only startup projection, so a projected device key alone
cannot implement dynamic `save_pending`, generation conflict detection, or
recovery after an activation response is lost.

The new store reuses the original Rust `KeyScope` and `DevicePrivateKey`.
Desktop initialization explicitly retains `OsIdentityStore`; headless
initialization explicitly receives an encrypted store. There is no automatic
fallback after a desktop credential error.

An isolated Rust identity owner receives a dedicated 32-byte encryption key
through its private read-only systemd credential projection. Root provisions
that new key once. The owner encrypts dynamic device keys into its own private
state directory and verifies persistence before any issuer activation. It has
no runtime root helper. The Node Host and its task processes receive neither
this key nor the device keys. Installation of this backend does not change
network capabilities, account access, remote grants or the Node service unit.

## Storage requirements

- Validate the full original scope, including issuer, environment, service,
  principal, device and generation. Authenticate that scope as AEAD associated
  data; never choose a generation locally to bypass issuer state.
- Reject unsafe paths, symlinks, broad permissions, oversized or malformed
  records, invalid projections and ciphertext authentication failures.
- Serialize each scope across processes. Never replace a different key for an
  existing generation. Saving the same key returns the original durable key.
- Complete file sync, exclusive publication, directory sync and a reload with
  matching public fingerprint before `save_pending` succeeds.
- Unknown write outcomes remain errors until the original scope is loaded.
  Missing, unavailable, corrupt and conflict are distinct from saved results.
- Keep secrets out of serialized types, Debug, CLI arguments, environment
  values, config, Node, UI, transcripts and logs. Credential paths and public
  fingerprints are non-secret metadata.

## Acceptance

- [x] Inspect the actual headless service environment and original storage owner.
- [ ] Extract shared crypto without duplicating implementation; preserve desktop
  crypto, identity generation and recovery behavior.
- [ ] Build and test the headless crate independently without Tauri, GTK or
  Secret Service; keep native artifact source and digest provenance.
- [ ] Verify real systemd projection with an isolated UID, dynamic saves,
  cross-process reload and repeats, generation conflicts, scope isolation,
  permission refusal, authentication failure and service restart.
- [ ] Review, complete repository gates, merge and verify remote main.
- [ ] Consume this backend in a real headless identity/enrollment owner after
  authority and test account access are available.

The local storage checker only uses isolated development scopes at an invalid
issuer. It never contacts an issuer or registers a device. Injected failure
tests do not prove power-loss behavior. Real enrollment, issuer CAS, activation
recovery, renewal, revocation and device-level management remain separate gates.
