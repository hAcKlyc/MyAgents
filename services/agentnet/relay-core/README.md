# AgentNet relay-core

This Rust 1.92 crate implements a synchronous, bounded state machine for the
fixed 1.1 device-level control and opaque TLS relay path. It does not open a
listener, perform WebSocket I/O, decrypt TLS, parse business objects, or
authorize `op.prepare`, permits, and return routes.

`ValidatedAccess` can only be created by admission-core's cryptographic
validator. `RelayCore::authorize_device` also requires a live snapshot supplied
by the parent after checking AuthStore, DeviceStore, and current membership; it
matches the access session, scope, key generation, SPKI fingerprint, validated
service audience, environment, and canonical issuer origin, then verifies the
peer-binding JWT signature and fixed schema against pinned issuer JWKS. This
prevents a valid projection from being reused across relay instances with a
different service or environment. The relay cannot independently prove that
the parent snapshot is current. The network ID on `ValidatedAccess` is pinned
validator context rather than a signed JWT claim; the parent must compare it
against the live DeviceStore/AuthStore scope before issuing the snapshot and
call `invalidate_device` when a session, key generation, or membership is
revoked.

Connections begin in Syncing state. The parent catalog owner must mint
`TrustedReadyEvidence` only after durable ACK and policy checks; the relay binds
that evidence to the server-generated connection epoch, membership revision,
and exact catalog sequence before returning `ready.result`. This evidence is a
trusted local integration boundary, not an independently signed proof.

All mutating methods require exclusive access to `RelayCore`. A service owner
must acquire its connection/state lock first and sample fresh wall-clock time
after acquiring it, then call the method. Returned effects are not delivered
automatically. The adapter must enqueue them under its bounded socket queue;
if an opaque-frame effect cannot be enqueued, it should close that channel
rather than retrying the already-accounted frame. Client `credit.release`
controls return cumulative per-direction credit. Ready channels expire after
the fixed `idleChannelMs` budget unless a valid `channel.ready`, forwarded TLS
frame, or valid `credit.release` refreshes their monotonic activity timestamp.
Invalid controls and unsupported messages do not refresh that timeout.

Channel roles follow the fixed canonical full device-scope ordering, independent
of which peer sends `channel.open`. Both peers receive an Offer and must each
accept their current signed binding before either receives Accepted. Accepted
channels relay bounded opaque TLS handshake frames: the actual clients must
finish mutual TLS and exchange ChannelHello before both can send channel-ready.
Blocking all opaque frames until Ready would deadlock that handshake. Application
business admission remains an endpoint responsibility after its cryptographic
and relay Ready gates; this server cannot distinguish encrypted business bytes.

The crate uses the pinned shared protocol crate and its 1.1 JSON schemas and
budgets. It is not yet wired into the HTTP/WS server, which must provide the
live authorization snapshots, catalog proofs, bounded socket delivery, and
fresh-clock serialization described above.
