# AgentNet relay-core

This Rust 1.92 crate implements the synchronous, bounded state machine used by
the parent AgentNet service's WebSocket relay. The HTTP/controller and bounded
WebSocket transport are in `services/agentnet/src/relay_controller.rs`,
`relay_http.rs`, and `relay_transport.rs`; this crate itself does not bind a
listener or perform WebSocket I/O. It does not decrypt inner TLS or authorize
`op.prepare`, permits, or return routes.

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

The crate uses the pinned shared protocol crate and its fixed 1.1 JSON schemas
and budgets. The parent service supplies live authorization snapshots and
durable catalog/policy evidence, serializes mutations against live AuthStore,
DeviceStore, PeerStore, and MetadataStore state, and delivers bounded effects
through the WebSocket transport. A snapshot is a local trust boundary: the
crate does not independently establish that the caller is still authorized.
The server path is covered by loopback/native tests for descriptor admission,
catalog ACK and Ready, paired Offer/Accept, opaque frame forwarding, close,
revocation and replacement cleanup. These results do not establish public
DNS/TLS deployment or the pending user-driven desktop-to-Host management
acceptance.

The service's optional public descriptor advertises the implemented
`tls13-mtls` capability only. An explicit owned-device management profile is
handled by the client/Host management adapter after local user authorization;
it does not arise from discovery, a same-account relationship, or this relay
crate. The current management channel carries the fixed encrypted Host
configuration/resource operations. It does not expose model-invocation,
permit, mount, or return-route authority.
