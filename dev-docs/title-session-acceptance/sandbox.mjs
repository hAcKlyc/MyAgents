// Probe actual macOS Seatbelt enforcement, including child inheritance.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function networkProfile(inbound, outbound) {
  assert.ok([inbound, ...outbound].every(p => Number.isInteger(p) && p > 0 && p <= 65535));
  assert.equal(outbound.length, 2);
  return `(version 1) (allow default) (deny network*)
    (allow network-bind (local ip "localhost:${inbound}"))
    (allow network-inbound (local ip "localhost:${inbound}"))
    (allow network-outbound ${outbound.map(p => `(remote ip "localhost:${p}")`).join(' ')})`;
}
async function denied(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('forbidden connect succeeded')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('timeout is not OS denial evidence')); });
    socket.once('error', error => {
      try { assert.ok(['EPERM', 'EACCES'].includes(error.code), `unexpected socket failure ${error.code}`); resolve(error.code); }
      catch (e) { reject(e); }
    });
  });
}
async function probe() {
  const [allowedA, allowedB, blocked] = process.argv.slice(3).map(Number);
  for (const port of [allowedA, allowedB]) {
    const reply = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await reply.text(), 'LOCAL_ALLOWED');
  }
  return { localAllowed: 2, localDenied: await denied('127.0.0.1', blocked), external443Denied: await denied('1.1.1.1', 443) };
}
async function capture(executable, args, env) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b);
  child.stderr.on('data', b => stderr += b);
  const code = await new Promise(r => child.once('close', r));
  assert.equal(code, 0, stderr || stdout);
  return stdout;
}
if (process.argv[2] === '--child') {
  console.log(JSON.stringify(await probe()));
} else if (process.argv[2] === '--parent') {
  const own = await probe();
  const child = JSON.parse(await capture(process.execPath, [import.meta.filename, '--child', ...process.argv.slice(3)], process.env));
  console.log(JSON.stringify({ own, child }));
} else if (process.argv[2] === '--verify') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'moxbots-title-network-')));
  await chmod(home, 0o700);
  const servers = [];
  for (let i = 0; i < 3; i++) {
    const s = createServer((req, res) => res.end('LOCAL_ALLOWED'));
    await new Promise(r => s.listen(0, '127.0.0.1', r)); servers.push(s);
  }
  const inboundReservation = createServer();
  await new Promise(r => inboundReservation.listen(0, '127.0.0.1', r));
  const inbound = inboundReservation.address().port;
  await new Promise(r => inboundReservation.close(r));
  let evidence;
  try {
    const ports = servers.map(s => s.address().port);
    const profile = networkProfile(inbound, ports.slice(0, 2));
    evidence = JSON.parse(await capture('/usr/bin/sandbox-exec', ['-p', profile,
      process.execPath, import.meta.filename, '--parent', ...ports.map(String)], {
      HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
    }));
    await writeFile(join(home, 'receipt.json'), JSON.stringify({ passed: true, profile, evidence, realModelRequests: 0 }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ receipt: join(home, 'receipt.json'), evidence }));
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  }
}
