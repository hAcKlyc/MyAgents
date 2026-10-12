# Host management protocol codec (v1)

This crate is a transport-independent codec foundation. It defines a closed `host.management` v1 envelope, bounded JSON DTOs, and a four-byte big-endian length-prefixed stream decoder. The receiver must still perform channel negotiation, peer authorization, replay/sequence policy, method dispatch, and owner-side validation. This crate grants no management permission and does not report synthetic operation success.

Each encoded JSON envelope is limited to 64 KiB; buffered input is limited to 256 KiB. A malformed or truncated stream poisons the decoder and must be discarded. Call `FrameDecoder::finish` at EOF to reject a partial frame. See `schemas/host-management-v1.schema.json` for the wire envelope shape; Rust validation additionally enforces DTO-specific invariants.

The response DTOs are a bounded contract proposal aligned with existing Host status/config/resource types. They are not connected to the real config or resource owners in this crate. Secret model-key writes, transport/TLS, dispatch, UI, and end-to-end permission tests remain outside this foundation.
