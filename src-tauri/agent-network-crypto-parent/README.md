# MoXBots credential parent policy

This library changes the desktop caller's timing and closed diagnostics, while preserving the released reader v1 and its original source closure. It has no reader executable. The existing packaging process continues to inject and verify the pinned signed reader bytes.

`build-support.rs` verifies the six imported source inputs and retains their bytes. `build.rs` compiles snapshots of those buffers, applying only the explicit parent transport policy. It does not reread source files after verification. Source changes or ambiguous transformation points fail the build. Generated source digests and policy version are recorded in `OUT_DIR/parent-policy-provenance.json`.

Only macOS MoXBots with the reader feature uses this library through the desktop crypto facade. The default MyAgents build and headless Host keep the original library. Crypto types must not be mixed across the two libraries.

Background transport has a 30-second budget; explicit read authorization remains 180 seconds. Child UI policy, request framing, signature checks, publisher and process authentication, cancellation and bounded output are unchanged. Synchronous parent signature preflight is not interruptible, so this is not a hard whole-operation wall-clock guarantee. Diagnostics contain only closed labels and durations.

The larger budget is a resilience candidate, not proof of the original migration failure cause. Native migration, cold-start and cross-build acceptance remain required before delivery is declared complete.
