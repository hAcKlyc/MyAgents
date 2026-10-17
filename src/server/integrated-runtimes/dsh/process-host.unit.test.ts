import { buildDshChildEnvironment } from './child-environment';
import { RUNTIME_CAPABILITIES, DSH_ENGINE_VERSION, GENERATED_PROTOCOL_VERSION } from '../../../../contracts/myagents-dsh/public-contract.generated';
import dshLock from '../../../shared/integrated-runtimes/dsh-lock.json';
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { LoadedDshProtocolRuntime } from "./generated-client";
import { createDshInitializeParams } from "./initialize";
import type { DshRuntimeInstallation } from "./installation";
import { DshRuntimeProcessHost, redactDshDiagnosticLine } from "./process-host";
import {
  DSH_CLIENT_METHOD_BY_PROTOCOL,
  DSH_HOST_METHOD_NAMES,
  DSH_REVERSE_METHOD_NAMES,
  type DshExecutionEnvironment,
  type DshGeneratedHostClient,
  type DshHostRequestHandlers,
  type DshInitializeResult,
  type DshJsonRpcPeer,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

class TestProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  private exited = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    this.exit(0, typeof signal === "string" ? signal : null);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

const installation: DshRuntimeInstallation = {
  resourceRoot: "/verified/resources",
  dshResourceRoot: "/verified/resources/integrated-runtimes/dsh",
  runtimeArtifactRoot:
    "/verified/resources/integrated-runtimes/dsh/runtime-artifact",
  runtimeEntrypointPath:
    "/verified/resources/integrated-runtimes/dsh/runtime-artifact/runtime-server-process.artifact.mjs",
  nodeExecutablePath: "/verified/resources/nodejs/bin/node",
};

function executionEnvironment(): Omit<DshExecutionEnvironment, "digest"> {
  return {
    revision: "execution-v1",
    workspace: {
      identity: "workspace-1",
      canonicalRoot: "/fixture/workspace",
    },
    executables: {
      bundledNodeRef: "node-v24",
      shellRef: "bash",
      ripgrepRef: "rg",
      shellDialect: "bash",
      allowedCommandRefs: ["node-v24", "bash", "rg"],
      pathPolicy: "sealed",
    },
    environment: {
      allowedKeys: ["LANG"],
      inheritedKeys: [],
      secretValues: "reverse-port-only",
    },
    network: { mode: "deny" },
    process: {
      backgroundRetention: "allow",
      maxChildren: 8,
      killTreeOnAbort: true,
    },
    checkpoint: {
      mode: "managed-file-tools",
      version: 1,
      policyRevision: "checkpoint-v1",
      trackedTools: ["Write", "Edit"],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: "/fixture/attachments",
  };
}

function initialize() {
  return createDshInitializeParams({
    productSessionId: "product-session-1",
    productVersion: "0.4.11",
    runtimeHome: "/fixture/runtime-home",
    workspace: { path: "/fixture/workspace", identity: "workspace-1" },
    executionEnvironment: executionEnvironment(),
    interaction: "interactive",
    platform: "fixture",
    arch: "fixture",
  });
}

function initializeResult(
  overrides: Partial<DshInitializeResult> = {},
): DshInitializeResult {
  return {
    protocolVersion: GENERATED_PROTOCOL_VERSION,
    schemaSha256: dshLock.protocol.schemaSha256,
    runtimeVersion: dshLock.runtime.version as DshInitializeResult["runtimeVersion"],
    runtimeGeneration: "artifact-process-generation",
    sessionFormat: "dsh-session-events-v2",
    profileDigest: dshLock.profile.digest,
    limits: {
      maxFrameBytes: 1_048_576,
      maxPendingRequests: 128,
      maxConcurrentReverseRequests: 32,
      maxAttachmentLeases: 128,
      eventQueueHighWatermark: 2_048,
    },
    runtimeEngine: {
      name: "deepseek-harness",
      version: DSH_ENGINE_VERSION,
      distribution: "myagents-dsh",
      distributionVersion: dshLock.runtime.version as DshInitializeResult["runtimeEngine"]["distributionVersion"],
    },
    runtimeCapabilities: RUNTIME_CAPABILITIES,
    ...overrides,
  };
}

function hostHandlers(): DshHostRequestHandlers {
  return Object.fromEntries(
    DSH_REVERSE_METHOD_NAMES.map((method) => [
      method,
      async () => ({ ok: true }),
    ]),
  ) as unknown as DshHostRequestHandlers;
}

const notificationHandlers: DshRuntimeNotificationHandlers = {
  "runtime/event": vi.fn(),
  "host/interaction/cancel": vi.fn(),
};

function harness(
  result = initializeResult(),
  proxyEnvironment?: NodeJS.ProcessEnv,
  sessionCli?: { productSessionId: string; sidecarPort: number; internalCliToken: string },
) {
  const order: string[] = [];
  const child = new FakeChild();
  let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
  let registeredHostHandlers: DshHostRequestHandlers | undefined;
  let registeredNotifications: DshRuntimeNotificationHandlers | undefined;
  const peer: DshJsonRpcPeer = {
    role: "host",
    updateLimits: () => order.push("update-limits"),
    flush: async () => {
      order.push("flush");
    },
    close: () => {
      order.push("peer-close");
    },
  };
  const clientRecord: Record<string, unknown> = { peer };
  for (const method of DSH_HOST_METHOD_NAMES) {
    const clientMethod = DSH_CLIENT_METHOD_BY_PROTOCOL[method];
    clientRecord[clientMethod] = async () => {
      order.push(clientMethod);
      return {};
    };
  }
  clientRecord.initialize = async () => {
    order.push("initialize");
    return result;
  };
  clientRecord.registerHostHandlers = (handlers: DshHostRequestHandlers) => {
    order.push("register-host-handlers");
    registeredHostHandlers = handlers;
    return () => order.push("dispose-host-handlers");
  };
  clientRecord.registerRuntimeNotificationHandlers = (
    handlers: DshRuntimeNotificationHandlers,
  ) => {
    order.push("register-notifications");
    registeredNotifications = handlers;
    return () => order.push("dispose-notifications");
  };
  clientRecord.initialized = async () => {
    order.push("initialized");
  };
  clientRecord.runtimeStatus = async () => {
    order.push("runtimeStatus");
    return {
      runtimeGeneration: result.runtimeGeneration,
      initialized: true,
      primarySessionState: "unbound",
    };
  };
  clientRecord.runtimeShutdown = async () => {
    order.push("runtimeShutdown");
    queueMicrotask(() => child.exit(0, null));
    return { ok: true };
  };
  const client = clientRecord as DshGeneratedHostClient;
  let fatal: ((error: Error) => void) | undefined;
  const protocolRuntime: LoadedDshProtocolRuntime = {
    protocolEntryPath: "/verified/protocol.js",
    generatedClientEntryPath: "/verified/host-client.js",
    ProtocolError: TestProtocolError,
    createHostClient: options => { fatal = options.onFatalError; return client; },
  };
  const diagnostics: string[] = [];
  const failures: Error[] = [];
  const exits: unknown[] = [];
  const host = new DshRuntimeProcessHost({
    installation,
    childEnvironment: buildDshChildEnvironment({
      nodeExecutablePath: installation.nodeExecutablePath,
      inheritedEnvironment: {
        LANG: "en_US.UTF-8",
        ANTHROPIC_API_KEY: "credential-canary",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      },
      proxyEnvironment,
      sessionCli: sessionCli ?? null,
    }),
    initialize: initialize(),
    hostHandlers: hostHandlers(),
    notificationHandlers,
    loadProtocolRuntime: async () => {
      order.push("load-protocol");
      return protocolRuntime;
    },
    spawnRuntime: (_command, _args, options) => {
      spawnedEnvironment = options.env;
      order.push("spawn-runtime");
      return child as never;
    },
    onStderrLine: (line) => diagnostics.push(line),
    redactStderrLine: redactDshDiagnosticLine,
    onFailure: (error) => failures.push(error),
    onExit: details => exits.push(details),
    handshakeTimeoutMs: 1_000,
    shutdownGraceMs: 1_000,
  });
  return {
    host,
    child,
    order,
    diagnostics,
    failures,
    exits,
    fatal: (error: Error) => fatal?.(error),
    get spawnedEnvironment() {
      return spawnedEnvironment;
    },
    get registeredHostHandlers() {
      return registeredHostHandlers;
    },
    get registeredNotifications() {
      return registeredNotifications;
    },
  };
}

describe("DSH RuntimeProcessHost", () => {
  it('redacts quoted credentials, bearer material and URL userinfo before bounding output', () => {
    const redacted = redactDshDiagnosticLine('{"apiKey":"private key value","token":"private-token"} authorization=Bearer private-bearer https://private-user:private-pass@example.test/path');
    expect(redacted).not.toMatch(/private-/);
    expect(redacted).not.toContain('private key value');
    expect(redactDshDiagnosticLine(JSON.stringify({ password: 'Bearer abc"PRIVATE_TAIL' }))).not.toContain('PRIVATE_TAIL');
    expect(redactDshDiagnosticLine('x'.repeat(5000))).toHaveLength(4096);
  });

  it('redacts across chunks and omits oversized lines without exposing incomplete credentials', async () => {
    const test = harness();
    await test.host.start();
    test.child.stderr.write('api');
    test.child.stderr.write('Key="chunk-secret"\napiKey="');
    test.child.stderr.write('s'.repeat(20_000));
    test.child.stderr.write('secret-tail"\nnext diagnostic\n');
    test.child.stderr.write('https://user:PRIVATE_PREFIX' + 's'.repeat(17000) + '@example.test/\n');
    expect(test.diagnostics).toEqual(['apiKey=[REDACTED]', '[DSH stderr line omitted: exceeds 16384 characters]', 'next diagnostic', '[DSH stderr line omitted: exceeds 16384 characters]']);
    await test.host.stop();
  });

  it('retains exit facts after EOF and identifies Host termination separately', async () => {
    const test = harness();
    await test.host.start();
    test.fatal(new Error('Protocol input reached EOF'));
    expect(test.failures.map(error => error.message)).toEqual(['Protocol input reached EOF']);
    expect(test.exits).toEqual([{ code: 0, signal: 'SIGTERM', hostTermination: { reason: 'protocol_failure', signal: 'SIGTERM' } }]);
    await test.host.stop();
    expect(test.exits).toHaveLength(1);
  });

  it('retains native exit facts without inventing a Host termination', async () => {
    const test = harness();
    await test.host.start();
    test.child.exit(23, null);
    await new Promise(resolve => setImmediate(resolve));
    expect(test.exits).toEqual([{ code: 23, signal: null, hostTermination: null }]);
  });

  it('identifies graceful Host shutdown even when no signal was needed', async () => {
    const test = harness();
    await test.host.start();
    await test.host.stop();
    expect(test.exits).toEqual([{ code: 0, signal: null, hostTermination: { reason: 'host_shutdown', signal: null } }]);
  });

  it('flushes late unterminated stderr once on stream close after process exit', async () => {
    const test = harness();
    await test.host.start();
    test.child.exit(23, null);
    test.child.stderr.write('resume failed: {"apiKey":"private key value"}');
    test.child.stderr.end();
    test.child.stderr.resume();
    await new Promise(resolve => setImmediate(resolve));
    test.child.stderr.emit('close');
    expect(test.diagnostics).toEqual(['resume failed: {"apiKey":[REDACTED]}']);
  });

  it('retains handshake rejection teardown facts', async () => {
    const test = harness(initializeResult({ profileDigest: '0'.repeat(64) }));
    await expect(test.host.start()).rejects.toThrow(/identity/);
    expect(test.exits).toEqual([{ code: 0, signal: 'SIGTERM', hostTermination: { reason: 'startup_failed', signal: 'SIGTERM' } }]);
  });

  it("starts a Session child with the App-owned internal CLI capability without exposing its value in diagnostics", async () => {
    const test = harness(initializeResult(), undefined, {
      productSessionId: "product-session-1",
      sidecarPort: 31417,
      internalCliToken: "app-capability",
    });
    await test.host.start();
    expect(test.spawnedEnvironment).toMatchObject({
      MYAGENTS_PORT: "31417",
      MYAGENTS_SESSION_ID: "product-session-1",
      MYAGENTS_INTERNAL_CLI_TOKEN: "app-capability",
    });
    expect(test.spawnedEnvironment?.MYAGENTS_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(test.host.diagnosticSnapshot)).not.toContain("app-capability");
    await test.host.stop();
  });

  it("reports sealed proxy endpoints without credentials, paths or query values", () => {
    const test = harness(undefined, { HTTPS_PROXY: 'http://private-user:private-pass@127.0.0.1:3128/private-path?secret=value', NO_PROXY: 'localhost' });
    expect(test.host.diagnosticSnapshot.proxy).toMatchObject({
      scope: 'general', endpoints: { HTTPS_PROXY: 'http://127.0.0.1:3128' }, keys: ['HTTPS_PROXY', 'NO_PROXY'],
    });
    expect(JSON.stringify(test.host.diagnosticSnapshot)).not.toMatch(/private-|secret=value/);
    expect(test.host.diagnosticSnapshot.process.identity).toBeNull();
  });

  it("performs the exact handshake before becoming protocol-ready", async () => {
    const test = harness();
    const identity = await test.host.start();
    expect(identity).toMatchObject({
      productSessionId: "product-session-1",
      runtimeGeneration: "artifact-process-generation",
      protocolVersion: GENERATED_PROTOCOL_VERSION,
      sessionFormat: "dsh-session-events-v2",
    });
    expect(test.host.state).toBe("protocol-ready");
    expect(test.order).toEqual([
      "load-protocol",
      "spawn-runtime",
      "initialize",
      "update-limits",
      "register-host-handlers",
      "register-notifications",
      "initialized",
      "runtimeStatus",
    ]);
    expect(Object.keys(test.registeredHostHandlers ?? {})).toEqual([
      ...DSH_REVERSE_METHOD_NAMES,
    ]);
    expect(Object.keys(test.registeredNotifications ?? {})).toEqual([
      "runtime/event",
      "host/interaction/cancel",
    ]);
    expect(JSON.stringify(test.host.childEnvironment)).not.toContain(
      "credential-canary",
    );

    expect(test.host.diagnosticSnapshot).toMatchObject({
      process: { state: "protocol-ready", identity, artifact: { sourceCommit: dshLock.handoff.sourceCommit } },
      environment: { policy: "allowlist", allowedKeys: expect.arrayContaining(["LANG"]) },
      proxy: { scope: "general", capturedAt: "process_start", keys: [] },
    });
    expect(JSON.stringify(test.host.diagnosticSnapshot)).not.toContain("en_US.UTF-8");
    expect(JSON.stringify(test.host.diagnosticSnapshot)).not.toContain("credential-canary");
    await expect(test.host.request("session/read", {})).resolves.toEqual({});
    expect(test.order).toContain("sessionRead");

    test.child.stderr.write("authorization=secret-value\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.diagnostics).toEqual(["authorization=[REDACTED]"]);

    await test.host.stop();
    expect(test.host.state).toBe("stopped");
    expect(test.order).toContain("runtimeShutdown");
  });

  it("fails closed on initialize identity drift", async () => {
    const test = harness(
      initializeResult({
        profileDigest: "0".repeat(64),
      }),
    );
    await expect(test.host.start()).rejects.toThrow(/identity/);
    expect(test.host.state).toBe("failed");
    expect(test.child.killedSignals).toContain("SIGTERM");
  });

  it("cancels startup without spawning after Host shutdown", async () => {
    const test = harness();
    const starting = test.host.start();
    const stopping = test.host.stop();
    await expect(starting).rejects.toThrow(/cancelled/);
    await stopping;
    expect(test.host.state).toBe("stopped");
    expect(test.order).toEqual(["load-protocol"]);
  });
});
