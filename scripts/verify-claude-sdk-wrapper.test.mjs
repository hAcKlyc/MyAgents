import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { verifyClaudeSdkWrapper } from './verify-claude-sdk-wrapper.mjs';

const name = '@anthropic-ai/claude-agent-sdk';
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64'];

function put(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

test('SDK wrapper verification rejects a stale installed package after a version change', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-sdk-wrapper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(join(root, 'package.json'), { dependencies: { [name]: '0.3.284' }, optionalDependencies: Object.fromEntries(platforms.map(platform => [`${name}-${platform}`, '0.3.284'])) });
  put(join(root, 'package-lock.json'), { packages: Object.fromEntries([name, ...platforms.map(platform => `${name}-${platform}`)].map(packageName => [`node_modules/${packageName}`, { version: '0.3.284' }])) });
  const installedPath = join(root, 'node_modules', name, 'package.json');
  put(installedPath, { name, version: '0.3.281' });
  assert.throws(() => verifyClaudeSdkWrapper(root), /not 0\.3\.284/);
  put(installedPath, { name, version: '0.3.284' });
  assert.equal(verifyClaudeSdkWrapper(root), '0.3.284');
});

test('SDK sends long MCP configuration and credentials to the child on stdin', { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-mcp-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'capture.cjs');
  // Observe the actual arguments and initialize frame in a child process.
  // This exercises OS spawning on Windows without contacting a model or MCP.
  writeFileSync(cli, `
    const { writeFileSync } = require('node:fs');
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', line => {
      const { request, request_id } = JSON.parse(line);
      if (request?.subtype !== 'initialize') return;
      writeFileSync(require('node:path').join(__dirname, 'capture.json'), JSON.stringify({ args: process.argv, servers: request.mcpServers }));
      console.log(JSON.stringify({ type: 'control_response', response: {
        subtype: 'success', request_id, response: { mcp_servers_applied: true }
      } }));
    });
  `);
  const mcpServers = {
    local: { type: 'stdio', command: 'fixture', env: { TOKEN: 'fixture-stdio-token' } },
    remote: {
      type: 'http',
      url: 'http://127.0.0.1/mcp',
      headers: { Authorization: 'Bearer fixture-http-token', 'X-Padding': 'mcp-padding-'.repeat(4000) },
    },
  };
  assert.ok(JSON.stringify(mcpServers).length > 32_767);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  t.after(() => clearTimeout(timer));
  const session = query({
    prompt: 'fixture',
    options: {
      // Windows holds a process's cwd open; keep it outside the disposable fixture.
      cwd: tmpdir(),
      pathToClaudeCodeExecutable: process.execPath,
      executableArgs: [cli],
      settingSources: [],
      mcpServers,
      mcpServersDelivery: 'initialize',
      abortController: controller,
    },
  });
  try {
    await session.initializationResult();
    const { args, servers } = JSON.parse(readFileSync(join(root, 'capture.json'), 'utf8'));
    assert.deepEqual(servers, mcpServers);
    assert.doesNotMatch(args.join(' '), /--mcp-config|fixture-stdio-token|fixture-http-token|mcp-padding-/);
  } finally {
    await session.return();
  }
});
