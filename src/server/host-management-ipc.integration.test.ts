import { createServer, type Server } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { build } from "esbuild";
import { mkdtemp, chmod, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { connectHostManagementIpc } from "../host/management-ipc";
import {
  configureHost,
  HostConfigError,
  readConfigReceipt,
  type HostConfig,
} from "../host/management";

let scratch: string | undefined;
let listener: Server | undefined;
let child: ChildProcess | undefined;
let client: { close(): Promise<void> } | undefined;
let peers: Array<import("node:net").Socket> = [];
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
  await client?.close();
  client = undefined;
  for (const peer of peers) peer.destroy();
  peers = [];
  if (listener?.listening)
    await new Promise<void>((resolveClose) =>
      listener!.close(() => resolveClose()),
    );
  listener = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}

type TestResponse = {
  kind?: unknown;
  requestId?: unknown;
  result?: Record<string, unknown>;
};
async function receive(
  socket: import("node:net").Socket,
): Promise<TestResponse> {
  const pending: Buffer[] = [];
  let buffered = Buffer.alloc(0);
  const read = async (): Promise<TestResponse> => {
    while (
      buffered.length < 4 ||
      buffered.length < buffered.readUInt32BE(0) + 4
    ) {
      const chunk =
        pending.shift() ??
        (await new Promise<Buffer>((resolveChunk, reject) => {
          const onData = (value: Buffer) => {
            cleanup();
            resolveChunk(value);
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onClose = () => {
            cleanup();
            reject(new Error("socket closed"));
          };
          const cleanup = () => {
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
          };
          socket.once("data", onData);
          socket.once("error", onError);
          socket.once("close", onClose);
        }));
      buffered = Buffer.concat([buffered, chunk]);
    }
    const length = buffered.readUInt32BE(0);
    const result = JSON.parse(
      buffered.subarray(4, 4 + length).toString("utf8"),
    ) as TestResponse;
    buffered = buffered.subarray(4 + length);
    return result;
  };
  return read();
}

async function setup(
  dispatch: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  expect(uid).toBeGreaterThan(0);
  expect(gid).toBeGreaterThan(0);
  scratch = await mkdtemp(join(homedir(), `.mah-host-mgmt-${process.pid}-`));
  const ipcDir = join(scratch, "ipc");
  await chmod(scratch, 0o700);
  await (await import("node:fs/promises")).mkdir(ipcDir, { mode: 0o750 });
  await chmod(ipcDir, 0o750);
  const socketPath = join(ipcDir, "management.sock");
  listener = createServer((peer) => {
    peers.push(peer);
  });
  listener.listen(socketPath);
  await once(listener, "listening");
  await chmod(socketPath, 0o660);
  client = await connectHostManagementIpc({
    socketPath,
    expectedUid: uid!,
    expectedGid: gid!,
    dispatch,
    isShuttingDown: () => false,
  });
  const peer = await new Promise<import("node:net").Socket>(
    (resolvePeer, reject) => {
      const check = () => {
        if (peers[0]) resolvePeer(peers[0]);
        else setTimeout(check, 2);
      };
      setTimeout(check, 2);
      setTimeout(
        () => reject(new Error("client did not connect")),
        1000,
      ).unref();
    },
  );
  return { peer, socketPath };
}

it("dispatches only closed management requests serially and returns correlated typed responses", async () => {
  const calls: string[] = [];
  const { peer } = await setup(async (method, params) => {
    calls.push(method);
    if (method === "host.snapshot")
      return {
        kind: "snapshot",
        version: 1,
        hostId: "00000000-0000-4000-8000-000000000001",
        configured: false,
        settings: null,
        activeSession: null,
        stopping: false,
        capabilities: [],
        agentNet: { available: false, reason: null },
        runtime: { node: "24", sdkBinaryPresent: false },
      };
    if (method === "config.set")
      return {
        kind: "config-receipt",
        status: "persisted",
        mutationId: params.mutationId,
        revision: 1,
        effect: "new-session",
        settings: {
          revision: 1,
          providerId: "moonshot-coding",
          model: "k3",
          workspace: "/tmp/work",
          executionAuthorized: false,
        },
      };
    if (method === "resources.create")
      return {
        kind: "resource-receipt",
        status: "persisted",
        mutationId: params.mutationId,
        revision: 1,
        effect: "registered-disabled-agent",
        resource: {
          created: true,
          agentId: "a",
          projectId: "p",
          name: "n",
          workspacePath: "/tmp/work/x",
          enabled: false,
          archived: false,
        },
      };
    return { kind: "error", code: "OWNER_OPERATION_FAILED" };
  });
  const ids = [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
    "00000000-0000-4000-8000-000000000013",
  ];
  const requests = [
    { kind: "request", requestId: ids[0], method: "host.snapshot", params: {} },
    {
      kind: "request",
      requestId: ids[1],
      method: "config.set",
      params: {
        expectedRevision: 0,
        providerId: "moonshot-coding",
        model: "k3",
        executionAuthorized: false,
        mutationId: ids[1],
      },
    },
    {
      kind: "request",
      requestId: ids[2],
      method: "resources.create",
      params: {
        rootId: "workspaces",
        relativePath: "x",
        expectedRevision: 0,
        mutationId: ids[2],
        operation: "register",
      },
    },
  ];
  for (const item of requests) {
    peer.write(frame(item));
    const response = await receive(peer);
    expect(response).toMatchObject({
      kind: "response",
      requestId: item.requestId,
    });
    expect(response.result?.kind).not.toBe("error");
  }
  expect(calls).toEqual(["host.snapshot", "config.set", "resources.create"]);
  peer.write(
    frame({
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000014",
      method: "session.create",
      params: {},
    }),
  );
  expect(await receive(peer)).toMatchObject({
    result: { kind: "error", code: "INVALID_REQUEST" },
  });
  peer.write(
    frame({
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000015",
      method: "config.set",
      params: {
        expectedRevision: 0,
        providerId: "moonshot-coding",
        model: "k3",
        executionAuthorized: false,
        mutationId: "00000000-0000-4000-8000-000000000015",
        apiKey: "must-not-be-accepted",
      },
    }),
  );
  expect(await receive(peer)).toMatchObject({
    result: { kind: "error", code: "INVALID_REQUEST" },
  });
  expect(calls).toHaveLength(3);
});

it("does not retry or dispatch queued frames after peer disconnect while a mutation is in flight", async () => {
  let calls = 0;
  let finish!: (value: unknown) => void;
  const { peer } = await setup(async () => {
    calls++;
    return new Promise((resolveResult) => {
      finish = resolveResult;
    });
  });
  peer.write(
    frame({
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000021",
      method: "config.set",
      params: {
        expectedRevision: 0,
        providerId: "moonshot-coding",
        model: "k3",
        executionAuthorized: false,
        mutationId: "00000000-0000-4000-8000-000000000021",
      },
    }),
  );
  for (let attempt = 0; attempt < 100 && !finish; attempt++)
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  expect(finish).toBeTypeOf("function");
  peer.write(
    frame({
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000022",
      method: "host.snapshot",
      params: {},
    }),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  const closed = once(peer, "close");
  peer.destroy();
  await closed;
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  finish({
    kind: "config-receipt",
    status: "persisted",
    mutationId: "00000000-0000-4000-8000-000000000021",
    revision: 1,
    effect: "new-session",
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  expect(calls).toBe(1);
});

it("rejects oversized IPC frames without invoking an owner", async () => {
  let calls = 0;
  const { peer } = await setup(async () => {
    calls++;
    return {};
  });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(64 * 1024 + 1);
  peer.write(header);
  await once(peer, "close");
  expect(calls).toBe(0);
});

it("waits boundedly for the Rust listener during Host startup", async () => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  expect(uid).toBeGreaterThan(0);
  expect(gid).toBeGreaterThan(0);
  scratch = await mkdtemp(
    join(homedir(), `.mah-host-mgmt-startup-${process.pid}-`),
  );
  await chmod(scratch, 0o700);
  const ipcDir = join(scratch, "ipc");
  await mkdir(ipcDir, { mode: 0o750 });
  await chmod(ipcDir, 0o750);
  const socketPath = join(ipcDir, "management.sock");
  const starting = connectHostManagementIpc({
    socketPath,
    expectedUid: uid!,
    expectedGid: gid!,
    dispatch: async () => ({}),
    isShuttingDown: () => false,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  listener = createServer((peer) => {
    peers.push(peer);
  });
  listener.listen(socketPath);
  await once(listener, "listening");
  await chmod(socketPath, 0o660);
  client = await starting;
  expect(peers).toHaveLength(1);
});

it("reconnects to a recreated safe socket without replaying or leaking the old mutation response", async () => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  expect(uid).toBeGreaterThan(0);
  expect(gid).toBeGreaterThan(0);
  scratch = await mkdtemp(
    join(homedir(), `.mah-host-mgmt-reconnect-${process.pid}-`),
  );
  await chmod(scratch, 0o700);
  const ipcDir = join(scratch, "ipc");
  await mkdir(ipcDir, { mode: 0o750 });
  await chmod(ipcDir, 0o750);
  const socketPath = join(ipcDir, "management.sock");
  const accepted: Array<import("node:net").Socket> = [];
  let snapshotCalls = 0;
  let activeDispatches = 0;
  let maxConcurrentDispatches = 0;
  const makeListener = async () => {
    const next = createServer((peer) => {
      accepted.push(peer);
      peers.push(peer);
    });
    next.listen(socketPath);
    await once(next, "listening");
    await chmod(socketPath, 0o660);
    listener = next;
    return next;
  };
  const firstListener = await makeListener();
  let finishMutation!: (value: unknown) => void;
  let mutationCalls = 0;
  client = await connectHostManagementIpc({
    socketPath,
    expectedUid: uid!,
    expectedGid: gid!,
    isShuttingDown: () => false,
    dispatch: async (method, params) => {
      activeDispatches++;
      maxConcurrentDispatches = Math.max(
        maxConcurrentDispatches,
        activeDispatches,
      );
      try {
        if (method === "config.set") {
          mutationCalls++;
          return await new Promise((resolveResult) => {
            finishMutation = resolveResult;
          });
        }
        if (method === "receipt.get")
          return {
            kind: "config-receipt",
            status: "persisted",
            mutationId: params.mutationId,
            revision: 1,
            effect: "new-session",
          };
        snapshotCalls++;
        return { kind: "snapshot", version: 1 };
      } finally {
        activeDispatches--;
      }
    },
  });
  const waitForPeer = async (index: number) => {
    for (let attempt = 0; attempt < 200 && !accepted[index]; attempt++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    expect(accepted[index]).toBeDefined();
    return accepted[index]!;
  };
  const oldPeer = await waitForPeer(0);
  const mutationId = "00000000-0000-4000-8000-000000000031";
  oldPeer.write(
    frame({
      kind: "request",
      requestId: mutationId,
      method: "config.set",
      params: {
        expectedRevision: 0,
        providerId: "moonshot-coding",
        model: "k3",
        executionAuthorized: false,
        mutationId,
      },
    }),
  );
  for (let attempt = 0; attempt < 200 && !finishMutation; attempt++)
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  expect(finishMutation).toBeTypeOf("function");
  const oldClosed = once(oldPeer, "close");
  oldPeer.destroy();
  await oldClosed;
  await new Promise<void>((resolveClose) =>
    firstListener.close(() => resolveClose()),
  );
  const secondListener = await makeListener();
  const newPeer = await waitForPeer(1);
  const snapshotId = "00000000-0000-4000-8000-000000000032";
  newPeer.write(
    frame({
      kind: "request",
      requestId: snapshotId,
      method: "host.snapshot",
      params: {},
    }),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  expect(snapshotCalls).toBe(0);
  expect(mutationCalls).toBe(1);
  expect(maxConcurrentDispatches).toBe(1);
  finishMutation({
    kind: "config-receipt",
    status: "persisted",
    mutationId,
    revision: 1,
    effect: "new-session",
  });
  expect(await receive(newPeer)).toMatchObject({
    requestId: snapshotId,
    result: { kind: "snapshot" },
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const receiptId = "00000000-0000-4000-8000-000000000033";
  newPeer.write(
    frame({
      kind: "request",
      requestId: receiptId,
      method: "receipt.get",
      params: { mutationId, owner: "config" },
    }),
  );
  expect(await receive(newPeer)).toMatchObject({
    requestId: receiptId,
    result: { status: "persisted", mutationId },
  });
  expect(mutationCalls).toBe(1);
  expect(maxConcurrentDispatches).toBe(1);
  listener = secondListener;
});

it("bounds pending work across replaced peers and close waits for the in-flight owner write", async () => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  expect(uid).toBeGreaterThan(0);
  expect(gid).toBeGreaterThan(0);
  scratch = await mkdtemp(
    join(homedir(), `.mah-host-mgmt-queue-${process.pid}-`),
  );
  await chmod(scratch, 0o700);
  const ipcDir = join(scratch, "ipc");
  await mkdir(ipcDir, { mode: 0o750 });
  await chmod(ipcDir, 0o750);
  const socketPath = join(ipcDir, "management.sock");
  const accepted: Array<import("node:net").Socket> = [];
  const makeListener = async () => {
    const next = createServer((peer) => {
      accepted.push(peer);
      peers.push(peer);
    });
    next.listen(socketPath);
    await once(next, "listening");
    await chmod(socketPath, 0o660);
    listener = next;
    return next;
  };
  const waitForPeer = async (index: number) => {
    for (let attempt = 0; attempt < 200 && !accepted[index]; attempt++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    expect(accepted[index]).toBeDefined();
    return accepted[index]!;
  };
  let finishMutation!: (value: unknown) => void;
  let mutationCalls = 0;
  let snapshots = 0;
  let active = 0;
  let maximumActive = 0;
  const firstListener = await makeListener();
  client = await connectHostManagementIpc({
    socketPath,
    expectedUid: uid!,
    expectedGid: gid!,
    isShuttingDown: () => false,
    dispatch: async (method) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (method === "config.set") {
          mutationCalls++;
          return await new Promise((resolveResult) => {
            finishMutation = resolveResult;
          });
        }
        snapshots++;
        return { kind: "snapshot", version: 1 };
      } finally {
        active--;
      }
    },
  });
  const firstPeer = await waitForPeer(0);
  firstPeer.write(
    frame({
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000051",
      method: "config.set",
      params: {
        expectedRevision: 0,
        providerId: "moonshot-coding",
        model: "k3",
        executionAuthorized: false,
        mutationId: "00000000-0000-4000-8000-000000000051",
      },
    }),
  );
  for (let attempt = 0; attempt < 200 && !finishMutation; attempt++)
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  expect(finishMutation).toBeTypeOf("function");
  const firstClosed = once(firstPeer, "close");
  firstPeer.destroy();
  await firstClosed;
  await new Promise<void>((resolveClose) =>
    firstListener.close(() => resolveClose()),
  );

  const secondListener = await makeListener();
  const secondPeer = await waitForPeer(1);
  secondPeer.write(
    Buffer.concat(
      Array.from({ length: 16 }, (_, index) =>
        frame({
          kind: "request",
          requestId: `00000000-0000-4000-8000-${String(index + 0x60).padStart(12, "0")}`,
          method: "host.snapshot",
          params: {},
        }),
      ),
    ),
  );
  await once(secondPeer, "close");
  await new Promise<void>((resolveClose) =>
    secondListener.close(() => resolveClose()),
  );

  const thirdListener = await makeListener();
  const thirdPeer = await waitForPeer(2);
  thirdPeer.write(
    frame({
      kind: "request",
      requestId: "00000000-0000-4000-8000-000000000071",
      method: "host.snapshot",
      params: {},
    }),
  );
  await once(thirdPeer, "close");
  expect(mutationCalls).toBe(1);
  expect(snapshots).toBe(0);
  expect(maximumActive).toBe(1);

  let closeSettled = false;
  const closing = client!.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  expect(closeSettled).toBe(false);
  finishMutation({
    kind: "config-receipt",
    status: "persisted",
    mutationId: "00000000-0000-4000-8000-000000000051",
    revision: 1,
    effect: "new-session",
  });
  await closing;
  expect(closeSettled).toBe(true);
  expect(snapshots).toBe(0);
  expect(maximumActive).toBe(1);
  listener = thirdListener;
});

it("preserves typed unknown config-write outcomes and permits receipt recovery without retry", async () => {
  let persisted: HostConfig = {};
  let writes = 0;
  const owner = {
    hostId: "00000000-0000-4000-8000-000000000001",
    defaultWorkspace: "/tmp",
    readConfig: async () => persisted,
    writeConfig: async (value: HostConfig) => {
      writes++;
      persisted = value;
      throw new Error("private filesystem detail");
    },
    workspacePath: async (value: string) => value,
    busy: () => false,
  };
  const mutationId = "00000000-0000-4000-8000-000000000041";
  let caught: unknown;
  try {
    await configureHost(owner, {
      expectedRevision: 0,
      providerId: "moonshot-coding",
      model: "k3",
      executionAuthorized: false,
      mutationId,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HostConfigError);
  expect((caught as HostConfigError).code).toBe("HOST_MANAGEMENT_UNCONFIRMED");
  expect(
    readConfigReceipt(persisted, owner.hostId, { mutationId }),
  ).toMatchObject({ status: "persisted", mutationId });
  expect(writes).toBe(1);

  const { peer } = await setup(async () => {
    throw new HostConfigError();
  });
  const requestId = "00000000-0000-4000-8000-000000000042";
  peer.write(
    frame({ kind: "request", requestId, method: "host.snapshot", params: {} }),
  );
  const response = await receive(peer);
  expect(response).toMatchObject({
    result: { kind: "error", code: "HOST_MANAGEMENT_UNCONFIRMED" },
  });
  expect(JSON.stringify(response)).not.toContain("private filesystem detail");
});

it.skipIf(process.getuid?.() === 0)(
  "requires non-root Host fixture (root is unsupported): connects actual Host main to Rust-side IPC and dispatches owners",
  async () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    expect(uid).toBeGreaterThan(0);
    expect(gid).toBeGreaterThan(0);
    scratch = await mkdtemp(
      join(homedir(), `.mah-host-management-main-${process.pid}-`),
    );
    await chmod(scratch, 0o700);
    const state = join(scratch, "state");
    const home = join(state, "home");
    const ipcDir = join(scratch, "ipc");
    const ipcPath = join(ipcDir, "management.sock");
    const controlPath = join(scratch, "control.sock");
    const entry = join(scratch, "host-main.mjs");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    await writeFile(join(state, "host.lock"), "", { mode: 0o600 });
    await mkdir(ipcDir, { mode: 0o750 });
    await chmod(ipcDir, 0o750);
    const keyDir = join(scratch, 'systemd-credential-fixture');
    await mkdir(keyDir, { mode: 0o700 });
    await writeFile(join(keyDir, 'provider-key'), Buffer.alloc(32, 0x42), { mode: 0o600 });
    await build({
      entryPoints: [resolve("src/host/main.ts")],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      banner: {
        js: 'import { createRequire as __myAgentsCreateRequire } from "module"; const require = __myAgentsCreateRequire(import.meta.url);',
      },
    });
    listener = createServer((peer) => {
      peers.push(peer);
    });
    listener.listen(ipcPath);
    await once(listener, "listening");
    await chmod(ipcPath, 0o660);
    const accepted = once(listener, "connection");
    const linux = process.platform === "linux";
    child = spawn(
      linux ? "/usr/bin/flock" : process.execPath,
      linux
        ? [
            "--exclusive",
            "--nonblock",
            "--no-fork",
            join(state, "host.lock"),
            process.execPath,
            entry,
            "--serve",
          ]
        : [entry, "--serve"],
      {
        env: {
          ...process.env,
          HOME: home,
          MYAGENTS_HOST_STATE_DIR: state,
          MYAGENTS_HOST_SOCKET: controlPath,
          MYAGENTS_HOST_MANAGEMENT_IPC: ipcPath,
          MYAGENTS_HOST_MANAGEMENT_NETWORK_UID: String(uid),
          MYAGENTS_HOST_MANAGEMENT_GID: String(gid),
          MYAGENTS_HOST_MODE: '1',
          CREDENTIALS_DIRECTORY: keyDir,
          MYAGENTS_HOST_PROVIDER_KEY_CREDENTIAL: 'provider-key',
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = new Promise<string>((resolveOutput, reject) => {
      let text = "";
      child!.stdout!.on("data", (chunk) => {
        text += String(chunk);
        if (text.includes("management IPC connected")) resolveOutput(text);
      });
      child!.stderr!.on("data", (chunk) => {
        text += String(chunk);
      });
      child!.once("exit", (code) =>
        reject(
          new Error(
            `Host exited before IPC startup: ${code}: ${text.slice(-1200)}`,
          ),
        ),
      );
    });
    await Promise.race([accepted, output.then(() => undefined)]);
    await output;
    const peer = peers[0];
    const sendRequest = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      const requestId = randomUUID();
      peer.write(frame({ kind: "request", requestId, method, params }));
      const response = await receive(peer);
      expect(response).toMatchObject({ kind: "response", requestId });
      return response.result as Record<string, unknown>;
    };
    expect(await sendRequest("host.snapshot", {})).toMatchObject({
      kind: "snapshot",
      configured: false,
      settings: null,
      activeSession: null,
      agentNet: { available: false },
      credentials: { configured: false, revision: 0, writeAvailable: true },
      resources: { version: 1, revision: 0, roots: [{ rootId: 'workspaces' }], agents: [] },
    });
    expect(await sendRequest('host.inspect',{})).toMatchObject({kind:'extended-snapshot',provider:null,settings:null});
    expect(await sendRequest('host.snapshot',{})).not.toHaveProperty('provider');
    const credentialId = randomUUID();
    const syntheticSecret = 'ipc-test-only-provider-secret-never-use-for-network';
    const credentialRequest = { providerId: 'moonshot-coding', credential: syntheticSecret,
      expectedRevision: 0, mutationId: credentialId };
    const credentialReceipt = await sendRequest('credential.set', credentialRequest);
    expect(credentialReceipt).toMatchObject({ kind: 'credential-receipt', status: 'persisted',
      mutationId: credentialId, revision: 1, effect: 'new-session' });
    expect(await sendRequest('credential.set', credentialRequest)).toEqual(credentialReceipt);
    expect(await sendRequest('receipt.get', { mutationId: credentialId, owner: 'credentials' })).toEqual(credentialReceipt);
    const snapshot = await sendRequest('host.snapshot', {});
    expect(snapshot).toMatchObject({ credentials: { configured: true, revision: 1, writeAvailable: true } });
    expect(JSON.stringify(snapshot)).not.toContain(syntheticSecret);
    expect((await readFile(join(state, 'provider-credentials', 'credentials.enc'), 'utf8'))).not.toContain(syntheticSecret);
    const configId = randomUUID();
    expect(
      await sendRequest("config.set", {
        expectedRevision: 0,
        providerId: "moonshot-coding",
        model: "k3",
        executionAuthorized: false,
        mutationId: configId,
      }),
    ).toMatchObject({
      kind: "config-receipt",
      status: "persisted",
      mutationId: configId,
      revision: 1,
      effect: "new-session",
    });
    const hydratedLegacy=await sendRequest('host.inspect',{});
    expect(hydratedLegacy).toMatchObject({kind:'extended-snapshot',settings:{workspace:{rootId:'workspaces',relativePath:'default'}},provider:{id:'moonshot-coding',sourceProviderId:'moonshot-coding',baseUrl:'https://api.kimi.com/coding/',modelAliases:{fable:'k3',sonnet:'k3',opus:'k3',haiku:'k3'}}});
    expect(JSON.stringify(hydratedLegacy)).not.toContain(syntheticSecret);
    expect(await sendRequest('host.snapshot',{})).not.toHaveProperty('provider');
    const persistedConfig = await readFile(join(home, '.myagents', 'config.json'), 'utf8');
    expect(persistedConfig).not.toContain(syntheticSecret);
    expect(JSON.parse(persistedConfig).providerApiKeys).toEqual({ 'moonshot-coding': 'host-provider-credential:moonshot-coding' });
    expect(
      await sendRequest("receipt.get", {
        mutationId: configId,
        owner: "config",
      }),
    ).toMatchObject({
      kind: "config-receipt",
      status: "persisted",
      mutationId: configId,
      revision: 1,
    });
    if (process.platform === "linux") {
      const resourceId = randomUUID();
      expect(
        await sendRequest("resources.create", {
          rootId: "workspaces",
          relativePath: "ipc-created/workspace",
          expectedRevision: 0,
          mutationId: resourceId,
          operation: "create",
        }),
      ).toMatchObject({
        kind: "resource-receipt",
        status: "persisted",
        mutationId: resourceId,
        effect: "registered-disabled-agent",
        resource: { enabled: false, archived: false },
      });
      expect(
        await sendRequest("receipt.get", {
          mutationId: resourceId,
          owner: "resources",
        }),
      ).toMatchObject({
        kind: "resource-receipt",
        status: "persisted",
        mutationId: resourceId,
      });
      expect(await sendRequest('host.snapshot', {})).toMatchObject({
        resources: { revision: 1, agents: [{ enabled: false, archived: false }] },
      });
    }
    const disconnectedMutation = randomUUID();
    peer.write(
      frame({
        kind: "request",
        requestId: randomUUID(),
        method: "config.set",
        params: {
          expectedRevision: 1,
          providerId: "moonshot-coding",
          model: "k4",
          executionAuthorized: false,
          mutationId: disconnectedMutation,
        },
      }),
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    const disconnected = once(peer, "close");
    peer.destroy();
    await disconnected;
    const queryReceipt = () =>
      new Promise<{ data?: Record<string, unknown> }>(
        (resolveReceipt, reject) => {
          const req = httpRequest(
            {
              socketPath: controlPath,
              path: "/host/receipt",
              method: "POST",
              headers: { "Content-Type": "application/json" },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => {
                text += String(chunk);
              });
              response.on("end", () => {
                try {
                  resolveReceipt(JSON.parse(text));
                } catch {
                  reject(new Error("local receipt JSON invalid"));
                }
              });
              response.on("error", reject);
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify({ mutationId: disconnectedMutation }));
        },
      );
    let durable: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await queryReceipt();
      durable = response.data;
      if (durable?.status === "persisted") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(durable).toMatchObject({
      mutationId: disconnectedMutation,
      status: "persisted",
      revision: 2,
    });
  },
);

it('accepts only the closed portable extension fields and sends legal legacy upgrade-required errors',async()=> {
  const calls:string[]=[];
  const {peer}=await setup(async(method)=>{calls.push(method);if(method==='host.snapshot')throw new (await import('../host/management')).HostManagementUpgradeRequired();return {kind:'test-owner-result'};});
  const profile={id:'generic-1',name:'Portable',apiProtocol:'openai',baseUrl:'https://api.example.test/v1',authType:'both'};
  const requests:Array<[string,Record<string,unknown>]>=[['host.capabilities',{}],['host.inspect',{}],['config.provider.set',{provider:profile,model:'vendor/model',workspace:{rootId:'workspaces',relativePath:'客户 文件夹'},executionAuthorized:false,expectedRevision:0,mutationId:randomUUID()}],['credential.provider.set',{providerId:profile.id,credential:'synthetic-key',expectedRevision:0,mutationId:randomUUID()}],['resources.directory.list',{rootId:'workspaces',relativePath:''}],['resources.register',{rootId:'workspaces',relativePath:'客户 文件夹',expectedRevision:0,mutationId:randomUUID()}],['receipt.provider.get',{owner:'credentials',providerId:profile.id,mutationId:randomUUID()}]];
  for(const [method,params]of requests){const response=receive(peer);peer.write(frame({kind:'request',requestId:randomUUID(),method,params}));expect((await response).result?.kind).toBe('test-owner-result');}
  expect(calls).toEqual(requests.map(([method])=>method));
  const refused=receive(peer);peer.write(frame({kind:'request',requestId:randomUUID(),method:'config.provider.set',params:{...requests[2][1],provider:{...profile,env:{secret:'no'}}}}));expect((await refused).result).toEqual({kind:'error',code:'INVALID_REQUEST'});
  const legacy=receive(peer);peer.write(frame({kind:'request',requestId:randomUUID(),method:'host.snapshot',params:{}}));expect((await legacy).result).toEqual({kind:'error',code:'HOST_MANAGEMENT_UPGRADE_REQUIRED'});
});
