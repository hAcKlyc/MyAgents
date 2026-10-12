import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  clearTimeout as nativeClearTimeout,
  setTimeout as nativeSetTimeout,
} from "node:timers";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  INTERNAL_CLI_TOKEN_ENV,
  INTERNAL_CLI_TOKEN_HEADER,
} from "../../shared/externalCliCapabilities";

const run = promisify(execFile);
const internalToken = "fixture-internal-capability";
const externalToken = "fixture-external-token";
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const processes: ChildProcess[] = [];
const hosts: Record<string, { port: number; home: string }> = {};
let management: Server;
let scratch: string;
let cliBundle: string;

class HealthDeadlineError extends Error {}

async function readHealth(
  probe: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = 1_000,
): Promise<boolean> {
  const controller = new AbortController();
  let stage = "health-request";
  let timer: ReturnType<typeof nativeSetTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = nativeSetTimeout(() => {
      reject(new HealthDeadlineError(`Fixture deadline: stage=${stage}`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await probe(controller.signal);
        stage = "health-body";
        await response.arrayBuffer();
        return response.ok;
      })(),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) nativeClearTimeout(timer);
    controller.abort();
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timer = nativeSetTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      nativeClearTimeout(timer);
      resolveExit();
    });
    child.kill("SIGTERM");
  });
}

// Launch only with explicit fixture inputs; never inherit user credentials or
// connect these production processes to the user's App/data directories.
function fixtureEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap(
        (key) => (process.env[key] ? [[key, process.env[key]]] : []),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture loopback port");
  return address.port;
}

async function startHost(
  role: "global" | "session",
  managementPort: number,
  bundle: string,
) {
  const home = join(scratch, role);
  const workspace = join(home, "workspace");
  const configDir = join(home, ".myagents");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      agents: [{ id: "target-agent", name: "Target", enabled: false }],
    }),
  );
  await writeFile(
    join(configDir, "projects.json"),
    JSON.stringify([
      {
        id: "target-project",
        name: "Target",
        path: workspace,
        agentId: "target-agent",
      },
    ]),
  );
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolveClose) =>
    reservation.close(() => resolveClose()),
  );
  const child = spawn(
    process.execPath,
    [
      bundle,
      "--agent-dir",
      workspace,
      "--port",
      String(port),
      "--sidecar-role",
      role,
      "--no-pre-warm",
      ...(role === "session" ? ["--session-id", "source-session"] : []),
    ],
    {
      cwd: scratch,
      env: {
        ...fixtureEnv(home),
        MYAGENTS_SIDECAR_ID:
          role === "global" ? "__global__" : "source-session",
        MYAGENTS_MANAGEMENT_PORT: String(managementPort),
        [INTERNAL_CLI_TOKEN_ENV]: internalToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-16_000);
  });
  child.stderr?.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-16_000);
  });
  console.info("[external-cli-fixture] stage=health-start", {
    fetchMock: vi.isMockFunction(globalThis.fetch),
    fakeClock: vi.isFakeTimers(),
  });
  const deadline = performance.now() + 15_000;
  let healthy = false;
  try {
    while (performance.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Fixture Sidecar exited: ${output}`);
      try {
        if (
          await readHealth((signal) =>
            fetch(`http://127.0.0.1:${port}/health`, { signal }),
          )
        ) {
          hosts[role] = { port, home };
          healthy = true;
          return;
        }
      } catch (error) {
        if (error instanceof HealthDeadlineError) throw error;
        /* Retry a settled connection failure while the listener starts. */
      }
      await new Promise<void>((resolveWait) =>
        nativeSetTimeout(resolveWait, 50),
      );
    }
    throw new Error(`Fixture Sidecar did not become healthy: ${output}`);
  } finally {
    if (!healthy) await stopChild(child);
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "myagents-external-inbox-"));
  // Exercise the shipped composition/router, not a mocked routing adapter.
  for (const target of ["server", "cli"]) {
    await run(process.execPath, ["scripts/esbuild-bundle.mjs", target], {
      cwd: resolve("."),
      env: fixtureEnv(scratch),
      maxBuffer: 2 * 1024 * 1024,
    });
  }
  const serverBundle = join(scratch, "server.mjs");
  cliBundle = join(scratch, "myagents.cjs");
  await cp(resolve("src-tauri/resources/server-dist.js"), serverBundle);
  await cp(resolve("src-tauri/resources/cli/myagents.cjs"), cliBundle);
  management = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    response.setHeader("Content-Type", "application/json");
    if (
      request.headers[INTERNAL_CLI_TOKEN_HEADER.toLowerCase()] !== internalToken
    ) {
      response.writeHead(401).end(JSON.stringify({ ok: false }));
      return;
    }
    const path = request.url ?? "";
    calls.push({ path, body });
    if (path === "/api/external-cli/admit") {
      response.end(
        JSON.stringify({ ok: true, allowed: body.token === externalToken }),
      );
    } else if (path === "/api/inbox/deliver") {
      const message = body.message as Record<string, unknown>;
      response.end(
        JSON.stringify({
          ok: true,
          outcome: { status: "delivered", message_id: message.messageId },
        }),
      );
    } else if (path === "/api/inbox/start-session") {
      response.end(
        JSON.stringify({
          ok: true,
          outcome: {
            status: "accepted",
            agentId: body.agentId,
            sessionId: "fresh-session",
            messageId: "fresh-request",
            replyBack: body.replyBack,
          },
        }),
      );
    } else {
      response.end(JSON.stringify({ ok: true }));
    }
  });
  const managementPort = await listen(management);
  await startHost("global", managementPort, serverBundle);
  await startHost("session", managementPort, serverBundle);
});

afterAll(async () => {
  await Promise.all(processes.map(stopChild));
  if (management)
    await new Promise<void>((resolveClose) =>
      management.close(() => resolveClose()),
    );
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

it("bounds a health request that ignores cancellation even on a fake global clock", async () => {
  vi.useFakeTimers();
  const frozenTime = Date.now();
  let signal: AbortSignal | undefined;
  try {
    await expect(
      readHealth((received) => {
        signal = received;
        return new Promise<Response>(() => {});
      }, 25),
    ).rejects.toThrow("Fixture deadline: stage=health-request");
    expect(signal?.aborted).toBe(true);
    expect(Date.now()).toBe(frozenTime);
    expect(vi.isFakeTimers()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("bounds health response consumption rather than accepting stalled response headers", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  try {
    await expect(
      readHealth(async (received) => {
        signal = received;
        return new Response(body, { status: 200 });
      }, 25),
    ).rejects.toThrow("Fixture deadline: stage=health-body");
    expect(signal?.aborted).toBe(true);
  } finally {
    controller.error(new Error("Fixture stream cleanup"));
  }
});

async function request(
  role: string,
  operation: string,
  internal: boolean,
  extra = {},
) {
  const response = await fetch(
    `http://127.0.0.1:${hosts[role].port}/api/admin/session/${operation}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(internal
          ? { [INTERNAL_CLI_TOKEN_HEADER]: internalToken }
          : { Authorization: `Bearer ${externalToken}` }),
      },
      body: JSON.stringify({
        ...(operation === "send"
          ? { toSessionId: "target-session" }
          : { agentId: "target-agent" }),
        prompt: "Fixture work",
        ...extra,
      }),
    },
  );
  return response.json() as Promise<Record<string, unknown>>;
}

describe("production external CLI Session collaboration routing", () => {
  it.each([
    ["global", "send"],
    ["global", "start"],
    ["session", "send"],
    ["session", "start"],
  ])(
    "%s preserves authenticated external provenance for local %s",
    async (role, operation) => {
      const before = calls.filter((call) =>
        call.path.startsWith("/api/inbox/"),
      ).length;
      const result = await request(role, operation, false, {
        replyBack: true,
        sourceKind: "internal-session",
        fromSessionId: "forged-source",
      });
      expect(result).toMatchObject({ success: true, replyBack: false });
      expect(
        calls.filter((call) => call.path.startsWith("/api/inbox/")).length,
      ).toBe(before + 1);
      const last = calls.findLast(
        (call) =>
          call.path ===
          (operation === "send"
            ? "/api/inbox/deliver"
            : "/api/inbox/start-session"),
      )!;
      const envelope =
        operation === "send"
          ? (last.body.message as Record<string, unknown>)
          : last.body;
      expect(envelope).toMatchObject({
        sourceKind: "external-cli",
        fromLabel: "External CLI",
        replyBack: false,
      });
      expect(envelope).not.toHaveProperty("fromSessionId");
      if (operation === "send") {
        expect(envelope.sessionEvent).toMatchObject({
          sourceKind: "external-cli",
          sourceNotification: "none",
        });
        expect(envelope.sessionEvent).not.toHaveProperty("sourceSessionId");
      }
    },
  );

  it.each([false, true])(
    "the shipped CLI sends from an ordinary terminal (no-reply=%s)",
    async (noReply) => {
      const before = calls.filter(
        (call) => call.path === "/api/inbox/deliver",
      ).length;
      const { stdout } = await run(
        process.execPath,
        [
          cliBundle,
          "session",
          "send",
          "target-session",
          "-p",
          "CLI fixture work",
          "--json",
          ...(noReply ? ["--no-reply"] : []),
        ],
        {
          env: {
            ...fixtureEnv(hosts.global.home),
            MYAGENTS_PORT: String(hosts.global.port),
            MYAGENTS_API_TOKEN: externalToken,
          },
        },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        success: true,
        delivered: true,
        replyBack: false,
      });
      expect(
        calls.filter((call) => call.path === "/api/inbox/deliver").length,
      ).toBe(before + 1);
    },
  );

  it.each(["global", "session"])(
    "%s still requires external authorization before mutation",
    async (role) => {
      const before = calls.filter((call) =>
        call.path.startsWith("/api/inbox/"),
      ).length;
      for (const operation of ["send", "start"]) {
        const response = await fetch(
          `http://127.0.0.1:${hosts[role].port}/api/admin/session/${operation}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              toSessionId: "target-session",
              agentId: "target-agent",
              prompt: "Unauthenticated fixture",
            }),
          },
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          success: false,
          code: "EXTERNAL_CLI_TOKEN_REQUIRED",
        });
      }
      expect(
        calls.filter((call) => call.path.startsWith("/api/inbox/")).length,
      ).toBe(before);
    },
  );

  it("keeps real internal Session source identity and default return delivery", async () => {
    for (const operation of ["send", "start"]) {
      expect(await request("session", operation, true)).toMatchObject({
        success: true,
        replyBack: true,
      });
      const last = calls.findLast(
        (call) =>
          call.path ===
          (operation === "send"
            ? "/api/inbox/deliver"
            : "/api/inbox/start-session"),
      )!;
      const envelope =
        operation === "send"
          ? (last.body.message as Record<string, unknown>)
          : last.body;
      expect(envelope).toMatchObject({
        sourceKind: "internal-session",
        fromSessionId: "source-session",
        replyBack: true,
      });
    }
  });

  it("still rejects internal Global mutations and internal self-send before delivery", async () => {
    const before = calls.filter((call) =>
      call.path.startsWith("/api/inbox/"),
    ).length;
    expect(await request("global", "send", true)).toMatchObject({
      success: false,
      code: "delivery_failed",
    });
    expect(await request("global", "start", true)).toMatchObject({
      success: false,
      code: "caller_session_required",
    });
    expect(
      await request("session", "send", true, { toSessionId: "source-session" }),
    ).toMatchObject({ success: false, code: "invalid_args" });
    expect(
      calls.filter((call) => call.path.startsWith("/api/inbox/")).length,
    ).toBe(before);
  });
});
