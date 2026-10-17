# MoxBots 0.5.9

0.5.9 is built from the accepted changes merged to `main` after the 0.5.8 source freeze. It includes:

- Project board status grouping and conversion of idle Sessions into Tasks.
- Resizable sidebar and detail panels.
- Production Session-route handling for next-step suggestions.
- Context-recovery improvements: effective context budgeting, recoverable compaction failures, durable action receipts and protection against replaying completed business actions after interruption or restart.
- Continuous watch remains opt-in for local delivery. Requests that ask the current network return protocol to carry continuous events are rejected with `CONTINUOUS_NETWORK_WATCH_UNAVAILABLE`; the protocol currently supports the existing single-turn network settlement path.

This release note describes code included in the signed package. It does not claim that every product path has been exercised against a real external Host, Provider or the daily installed client. The daily client is not installed, quit or restarted as part of publication. After stable publication, compatible clients can check and download in the background; applying the update remains subject to the client's normal idle and user-confirmed restart gates.

## Release provenance

- Canonical repository: `https://github.com/heavenzhang/MoXBots.git`
- Frozen source: to be recorded after the release PR is merged to `main`.
- macOS arm64 artifact, notarization, updater signature and public download evidence: to be recorded in the task handoff and private release receipt after verification.
- Rollback target: the previously published 0.5.8 archive and stable manifest, retained by the updater publication process.
