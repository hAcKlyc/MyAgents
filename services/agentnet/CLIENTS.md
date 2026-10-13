# Owned client profile

The `owned-device-relay-v1` profile provides browser login, device identity,
registration, explicit membership and authenticated TLS relay. It does not grant
Agent invocation, publish local Agents, or expose Host management methods yet.
The desktop uses an explicit empty catalog for this profile; official networks
and legacy device-key enrollment retain their existing behavior.

`GET /api/agent-network/instance` is public, raw JSON and `no-store`. It is only
assembled when identity, network and relay owners are enabled. It contains
service/network/issuer, the real device CA and signing JWKS, never a principal,
a device, a session token, or an invented management capability. Public HTTPS
trust and the inner device CA are separate. An optional explicitly selected
public CA PEM is pinned per connection; there is no system trust modification.

Desktop: the existing `agentNetworkSelfhostDevGate` development gate controls
availability. The join dialog defaults to browser account login and retains
legacy device-key enrollment in a separate tab. Verifiers and opaque sessions
remain in the concrete operating-system credential backend; only public
connection records and the optional public CA pin are written to app config.
MyAgents and MoX bot credential slots are separated by their app data namespace.
Cancellation/new attempts fence late responses. Final connection installation
and attempt consumption use one atomic owner boundary.

Linux Host: `myagents-host-network` accepts `owned-auth-start`,
`owned-auth-wait`, `owned-auth-cancel`, `owned-auth-logout`, and
`run --owned-instance HTTPS_ORIGIN [--join]`. Each command still requires the
private state directory, systemd unit, credential name and canonical device ID.
`--public-tls-ca-file ABSOLUTE_PEM` is optional. The systemd credential supplies
the encryption key; no new plaintext key input or desktop keyring is introduced.
The public instance pin and login state are encrypted in namespaces distinct
from the official account. Logout/cancel clears local authority before attempting
remote revocation, even if the service is unavailable.

A `--join` grant is consumed once across reconnects, before membership CAS. An
uncertain write is not retried with a new mutation ID. Restart without `--join`
restores only the session, not membership permission; leaving a network requires
explicit new authorization to join again. The Host publishes an explicit empty
catalog and currently rejects incoming channels until its management owner is
connected.

Tests and CI validate only their exercised scope. Native Desktop login,
Linux systemd enrollment, inner TLS management dispatch, model-secret writes,
Agent creation and persistence require separate real acceptance. A successful
Ready, build, snapshot test or HTTP response does not establish those outcomes.
