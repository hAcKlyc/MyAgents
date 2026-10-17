# Bots admin validation

[BOTS-CLOUD-ADMIN-UI.md](BOTS-CLOUD-ADMIN-UI.md) records independent browser acceptance. [Desktop](bots-admin-evidence/desktop.png) and [mobile](bots-admin-evidence/mobile.png) captures contain synthetic identities/data only. External absolute paths in the historical report locate the original QA run; the scripts below are the versioned reproduction entry points.

## Isolated browser fixture

Use the repository's fixed Rust toolchain and Node/npm versions. Start a separate terminal from the repository root:

```sh
cargo test --locked --manifest-path services/agentnet/Cargo.toml --lib admin_browser_fixture -- --ignored --nocapture
```

The ignored test binds only `127.0.0.1:5198`, creates private temporary SQLite stores and registers synthetic admin/ordinary identities. Its test-only login/identity helpers are excluded from the production binary. It uses the actual AdminService/AuthStore operations, but does not exercise production OIDC, a real Host or paid inference. Stop the test process after verification.

Run each script sequentially against this fixture:

```sh
node services/agentnet/validation/scripts/run-fixture.mjs
node services/agentnet/validation/scripts/auth-retest.mjs
node services/agentnet/validation/scripts/login-fallback-smoke.mjs
node services/agentnet/validation/scripts/rwd-final-smoke.mjs
```

Playwright must already be installed for this checkout. If using an existing local dependency installation, `PLAYWRIGHT_MODULE` may identify its ESM entry point and `CHROMIUM_EXECUTABLE` an already installed Chromium executable. No browser download or production login is required. Optional `BOTS_ADMIN_QA_OUTPUT` is an existing writable evidence directory; otherwise scripts create a temporary directory. `BOTS_ADMIN_FIXTURE_URL` is restricted to loopback. Do not point these synthetic mutation tests at any shared cloud environment.

Scripts refuse stale fixture assets by comparing served HTML/JS/CSS with source SHA256. `login-fallback-smoke.mjs` checks that a hidden/unavailable popup still leaves a validated independent-tab authorization link, then exercises cancellation cleanup and a subsequent login. The fixture does not implement `/auth/login/cancel`, so the script intercepts only that cancellation request with a test shim; it does not claim server-side cancellation coverage. Test bearers remain in process memory; output excludes tokens, cookies, authorization URLs and credentials. Outputs describe observed cases and limitations; inspect screenshots separately for visual acceptance.

## Service validation

```sh
cargo test --locked --manifest-path services/agentnet/Cargo.toml
cargo test --locked --manifest-path services/agentnet/metadata-core/Cargo.toml
cargo clippy --locked --all-targets --manifest-path services/agentnet/Cargo.toml -- -D warnings
cargo fmt --manifest-path services/agentnet/Cargo.toml --check
npm run lint
```

The existing Owned AgentNet workflow builds the Linux artifact and records the exact CI source commit, executable digest and native dependencies. A passing fixture/build is not a production acceptance or permission to grant an administrator role.

## Finite Bot lifecycle (synthetic lane)

Use the test-only `execution_browser_fixture::execution_browser_fixture` ignored test on127.0.0.1:5199; no test identity/control route is compiled into production. Run `node services/agentnet/validation/scripts/execution-ui-smoke.mjs` with an installed Playwright Chromium. The fixture injects a synthetic banner; served JS/CSS are checked against source. SDK effects are simulated and never reported as running.

See [BOTS-CLOUD-EXEC-UI.md](BOTS-CLOUD-EXEC-UI.md) and versioned synthetic [desktop](bots-execution-evidence/admin-1440x900.png), [tablet](bots-execution-evidence/admin-768x1024.png), [mobile](bots-execution-evidence/admin-390x844.png) captures. Fresh fixtures are required for full replay; the final unconfirmed case intentionally leaves its original command pending. Linux-specific Node cases, distinct-UID IPC and actual Host Session acceptance remain separate gates.
