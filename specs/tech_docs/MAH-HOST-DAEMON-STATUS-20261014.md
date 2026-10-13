# MAH-HOST-DAEMON-STATUS-20261014

Goal: finish the Linux Host's persistent owned connection and correct local diagnostic status, while the exact desktop trial installation confirmation remains pending. Preserve identities, credentials, existing management unit contents and finite execution policies. Current target is the existing MoX test namespace on the authorized Linux test Host.

- [x] Fresh source/live audit: the connector is Ready but disabled at boot; Node doctor reports not-integrated because its status environment is absent.
- [x] Add a separate diagnostic network-status.conf through the explicit owned activation path; retain the existing management drop-in byte contract.
- [x] Explicit --enable-on-boot requires run/join, a configured owned instance, fresh matching device/network status and actual service PID. No enrollment or finite policy renewal is introduced by the boot flag.
- [x] Fix failure/rejected-join handling so it preserves an already-active connector rather than stopping it.
- [x] Five new behavioral regressions and thirty existing intake/control tests passed; independent read-only review found no new P1/P2. New regressions are wired into CI.
- [x] Actual MoX application verified: private static unit/config/credential/policy backup; separate diagnostic drop-in applied; doctor available/Ready; connector enabled on boot. Deployed operator script source79c25045, SHA256bcf3627fafa9d8c1dabdbdacdfba4d5c7bf9324a2e4f0862676f42a4a0b8d624.
- [x] Actual two-service stop/start passed with Node deliberately started before its connector. Both units enabled, automatic existing-account reconnect and Ready doctor projection verified; original settings revision3, identity, credentials, configuration, management unit bytes and finite policies preserved. Account binding/scope/expiry preserved; only runtime PID/nonce/observation context refreshes. Invalid boot flag on status rejects before mutation. No model call.
- [ ] Current main sync, required CI, main delivery and exact deployed operator-script correspondence.

The real test uses only the MoX namespace. Other namespace boundary coverage is provided by tests; do not claim a second namespace was deployed. A whole-machine reboot is not authorized by this isolated service maintenance and is not part of its acceptance. Verify systemd enablement plus actual service restart/reconnect and document that boundary.

Private runtime receipts/credential backups remain outside Git. Desktop credential migration and remote configuration/Agent creation still require the separately prepared approved-to-run trial; this task does not close those gates or replace the full goal.
