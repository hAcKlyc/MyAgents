#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SERVER_ROOT = join(ROOT, 'src', 'server');
const VITEST_BIN = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const ALLOWED_SUFFIXES = [
  '.unit.test.ts',
  '.integration.test.ts',
  '.credentialed.test.ts',
];
const CHILD_PROCESS_ALLOWLIST = new Set([
  // Headless Host tests run only isolated Node control/store children with
  // model execution disabled and pre-warm off. They never launch the SDK.
  'src/server/host-controller.integration.test.ts',
  'src/server/host-session-worker.integration.test.ts',
  // Runs only the real local Host with temp state/workspaces, a Unix socket,
  // pre-warm/model execution disabled, and Linux flock. No provider is called.
  'src/server/host-management-ipc.integration.test.ts',
  // Creates only a FIFO in private scratch using mkfifo to prove credentials
  // reject non-regular files. No Host, network service or model is launched.
  'src/server/host-provider-credentials.integration.test.ts',
  // On Windows, runs process.execPath only to enumerate the sealed child's env
  // names. This catches OS-level case folding without secrets or network I/O.
  'src/server/integrated-runtimes/dsh/child-environment.unit.test.ts',
  // Kills an IPC-only synthetic transcript writer at real file publication
  // boundaries. The child receives only a temporary directory and stage name.
  'src/server/session-transcript/process.integration.test.ts',
  // This regression intentionally verifies config lock serialization across
  // separate Node processes. Keep the exception narrow so future integration
  // tests cannot spawn arbitrary network-capable subprocesses unnoticed.
  'src/server/__tests__/admin-config-lock.integration.test.ts',
  // Proves dead-PID lock recovery with process.execPath running only
  // `process.exit(0)`; the child receives no URL, secret, or network input.
  'src/server/__tests__/file-lock.integration.test.ts',
  // Composes that same short-lived local child with a temp-HOME SessionStore
  // bootstrap. The child exits immediately and cannot perform network I/O.
  'src/server/__tests__/session-lock-bootstrap.integration.test.ts',
  // Boots the real Sidecar against temp HOME/workspace directories and a
  // loopback-only HTTP port to verify the required-system-skill API contract.
  'src/server/__tests__/skills-required.integration.test.ts',
  // Builds and runs the shipped CLI plus Global/Session Sidecars against a
  // loopback-only fake Rust admission owner. Children get OS-only env, temp
  // HOME/workspaces, synthetic credentials and --no-pre-warm; no model runs.
  'src/server/inbox/external-cli-routing.integration.test.ts',
  // This regression verifies the existing MCP OAuth refresh lock across real
  // Node processes. Children share only a temp config dir and loopback server.
  'src/server/__tests__/mcp-oauth.integration.test.ts',
  // This contract test runs the real Plugin Bridge process against a temp
  // OpenClaw fixture and a loopback-only fake Rust ingress. It uses no secrets
  // and cannot reach an external service.
  'src/server/plugin-bridge/reply-transport.integration.test.ts',
  // Explicit opt-in packed DSH smoke uses local OpenSSL solely to create a
  // temporary test CA. HTTPS targets/proxies are loopback fixtures; no real
  // credential or external model is used, and the default test run skips it.
  'src/server/integrated-runtimes/dsh/process-host.native.integration.test.ts',
]);
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, out);
      continue;
    }
    if (entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

function rel(path) {
  return relative(ROOT, path).replace(/\\/g, '/');
}

const files = walk(SERVER_ROOT).map(rel).sort();
const bareServerTests = files.filter((file) => (
  !ALLOWED_SUFFIXES.some((suffix) => file.endsWith(suffix))
));

const unit = files.filter((file) => file.endsWith('.unit.test.ts'));
const integration = files.filter((file) => file.endsWith('.integration.test.ts'));
const credentialed = files.filter((file) => file.endsWith('.credentialed.test.ts'));
const overlap = integration.filter((file) => credentialed.includes(file));

function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, '');
}

function listProjectFiles(project) {
  // File membership is what classification owns. Runtime test collection can
  // hide credentialed tests when every case is skipIf(...) in a no-secret CI.
  const stdout = execFileSync(
    process.execPath,
    [VITEST_BIN, 'list', '--project', project, '--filesOnly'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const prefix = `[${project}] `;
  const found = new Set();
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    const file = line.slice(prefix.length).split(' > ')[0];
    if (file) found.add(file.replace(/\\/g, '/'));
  }
  return [...found].sort();
}

function diffSets(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((file) => !actualSet.has(file)),
    extra: actual.filter((file) => !expectedSet.has(file)),
  };
}

const actualUnitServer = listProjectFiles('unit').filter((file) => file.startsWith('src/server/'));
const actualIntegration = listProjectFiles('integration');
const actualCredentialed = listProjectFiles('credentialed');
const unitDiff = diffSets(unit, actualUnitServer);
const integrationDiff = diffSets(integration, actualIntegration);
const credentialedDiff = diffSets(credentialed, actualCredentialed);

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const scripts = packageJson.scripts ?? {};
const workflowText = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf-8');

function scriptIncludes(scriptName, parts) {
  const value = String(scripts[scriptName] ?? '');
  return parts.every((part) => value.includes(part));
}

function findDirectChildProcessUsage() {
  const offenders = [];
  const nonCredentialed = files.filter((file) => !file.endsWith('.credentialed.test.ts'));
  for (const file of nonCredentialed) {
    if (CHILD_PROCESS_ALLOWLIST.has(file)) continue;
    const text = readFileSync(join(ROOT, file), 'utf-8');
    if (
      /^\s*import\s+.*['"]node:child_process['"]/m.test(text)
      || /^\s*import\s+.*['"]child_process['"]/m.test(text)
      || /^\s*(?:const|let|var)\s+.*=\s*require\(['"]node:child_process['"]\)/m.test(text)
      || /^\s*(?:const|let|var)\s+.*=\s*require\(['"]child_process['"]\)/m.test(text)
    ) {
      offenders.push(file);
    }
  }
  return offenders;
}

const childProcessOffenders = findDirectChildProcessUsage();

const errors = [];
if (bareServerTests.length > 0) {
  errors.push([
    'Server tests must use an explicit classification suffix:',
    ...bareServerTests.map((file) => `  - ${file}`),
    `Allowed suffixes: ${ALLOWED_SUFFIXES.join(', ')}`,
  ].join('\n'));
}
if (overlap.length > 0) {
  errors.push([
    'Integration and credentialed test sets overlap:',
    ...overlap.map((file) => `  - ${file}`),
  ].join('\n'));
}
if (integration.length === 0) {
  errors.push('No integration tests were found; CI would not exercise stateful server coverage.');
}
if (credentialed.length === 0) {
  errors.push('No credentialed tests were found; real-provider smoke tests may have been misclassified.');
}
for (const [project, diff] of [
  ['unit', unitDiff],
  ['integration', integrationDiff],
  ['credentialed', credentialedDiff],
]) {
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    errors.push([
      `Vitest project '${project}' does not match the server test classification:`,
      ...diff.missing.map((file) => `  missing from project: ${file}`),
      ...diff.extra.map((file) => `  extra in project: ${file}`),
    ].join('\n'));
  }
}
if (childProcessOffenders.length > 0) {
  errors.push([
    'Non-credentialed tests must not directly import child_process:',
    ...childProcessOffenders.map((file) => `  - ${file}`),
    'Move the test to credentialed, mock the subprocess, or add a narrow allowlist entry with a comment.',
  ].join('\n'));
}
if (!scriptIncludes('test', ['test:classification', 'test:build-scripts', 'test:unit', 'test:dom', 'test:integration'])) {
  errors.push('package.json script "test" must run classification + build scripts + unit + dom + integration.');
}
for (const scriptName of ['test:changed', 'test:watch', 'coverage']) {
  if (!scriptIncludes(scriptName, ['--project unit', '--project dom', '--project integration'])) {
    errors.push(`package.json script "${scriptName}" must explicitly scope to unit/dom/integration and exclude credentialed.`);
  }
}
for (const command of [
  'npm run test:classification',
  'npm run test:build-scripts',
  'npm run test:integration',
  'npm run build:server',
  'npm run build:bridge',
  'npm run build:cli',
  'npm run build:web',
  'cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::disallowed_methods -D clippy::disallowed_macros',
]) {
  if (!workflowText.includes(command)) {
    errors.push(`.github/workflows/test.yml must run: ${command}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n\n'));
  process.exit(1);
}

console.log(`test classification ok: ${files.length} server tests (${integration.length} integration, ${credentialed.length} credentialed)`);
