import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AntigravityRuntime } from "./antigravity";
import type { RuntimeProcess, UnifiedEvent } from "./types";

it.skipIf(process.env.MYAGENTS_TEST_AGY !== "1")(
  "approves once, cancels an approval and resumes native history across processes",
  async () => {
    const runtime = new AntigravityRuntime();
    const workspacePath = await mkdtemp(join(tmpdir(), "myagents-agy-"));
    const events: UnifiedEvent[] = [];
    let proc: RuntimeProcess | undefined;
    const marker = randomUUID();
    const options = {
      workspacePath,
      sessionId: randomUUID(),
      scenario: { type: "desktop" as const },
      permissionMode: "default",
    };
    async function wait<K extends UnifiedEvent["kind"]>(kind: K, after = 0) {
      const find = () =>
        events
          .slice(after)
          .find(
            (e): e is Extract<UnifiedEvent, { kind: K }> => e.kind === kind,
          );
      await expect.poll(() => !!find(), { timeout: 90_000 }).toBe(true);
      return find()!;
    }
    try {
      expect((await runtime.detect()).installed).toBe(true);
      expect((await runtime.queryModels()).length).toBeGreaterThan(0);
      proc = await runtime.startSession(options, (e) => events.push(e));
      const nativeId = (await wait("session_init")).sessionId;
      expect(nativeId).not.toBe(options.sessionId);
      await runtime.sendMessage(
        proc,
        "Remember this conversation token: " +
          marker +
          ". Use the native file editing tool to create first.txt with exactly the word apple. Do not write the token or use shell commands.",
      );
      const approve = await wait("permission_request");
      await runtime.respondPermission(proc, approve.requestId, "allow_once");
      expect((await wait("turn_complete")).status).toBe("completed");
      expect(
        (await readFile(join(workspacePath, "first.txt"), "utf8")).trim(),
      ).toBe("apple");
      const second = events.length;
      await runtime.sendMessage(
        proc,
        "Use the native file editing tool to create second.txt containing orange. Do not use shell commands.",
      );
      await wait("permission_request", second);
      await runtime.interruptTurn(proc);
      expect((await wait("turn_complete", second)).status).toBe("cancelled");
      await expect(
        readFile(join(workspacePath, "second.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await runtime.stopSession(proc);
      const resumed = events.length;
      proc = await runtime.startSession(
        { ...options, resumeSessionId: nativeId },
        (e) => events.push(e),
      );
      await runtime.sendMessage(
        proc,
        "Reply with only the conversation token I asked you to remember, without calling tools.",
      );
      expect((await wait("turn_complete", resumed)).status).toBe("completed");
      expect(
        events
          .slice(resumed)
          .flatMap((e) => (e.kind === "text_delta" ? [e.text] : []))
          .join(""),
      ).toContain(marker);
    } finally {
      if (proc) await runtime.stopSession(proc);
      await rm(workspacePath, { recursive: true, force: true });
    }
  },
  280_000,
);

it.skipIf(process.env.MYAGENTS_TEST_AGY !== "1")(
  "injects one session-local MCP process and revokes it on resume",
  async () => {
    const { writeFile } = await import("node:fs/promises");
    const runtime = new AntigravityRuntime();
    const workspacePath = await mkdtemp(join(tmpdir(), "myagents-agy-mcp-"));
    const fixture = await mkdtemp(join(tmpdir(), "myagents-mcp-server-"));
    const receipt = randomUUID();
    const serverFile = join(fixture, "receipt.cjs");
    const calls = join(fixture, "calls");
    // The receipt exists only in this fixture process's environment.
    await writeFile(
      serverFile,
      `
    const lines = require('node:readline').createInterface({input:process.stdin});
    lines.on('line', line => {
      const r=JSON.parse(line);
      if(r.id===undefined)return;
      let result={};
      if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'receipt',version:'1'}};
      if(r.method==='tools/list')result={tools:[{name:'fresh_receipt',description:'Get a fresh receipt',inputSchema:{type:'object',properties:{}}}]};
      if(r.method==='tools/call'){require('node:fs').appendFileSync(process.env.AGY_TEST_CALLS,'1');result={content:[{type:'text',text:process.env.AGY_TEST_RECEIPT}]};}
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
    });
  `,
    );
    const events: UnifiedEvent[] = [];
    let proc: RuntimeProcess | undefined;
    const receive = (e: UnifiedEvent) => {
      events.push(e);
      if (e.kind === "permission_request" && proc)
        void runtime.respondPermission(
          proc,
          e.requestId,
          /receipt/i.test(e.toolName) ? "allow_once" : "deny",
        );
    };
    const options = {
      workspacePath,
      sessionId: randomUUID(),
      scenario: { type: "desktop" as const },
    };
    const terminal = () =>
      expect
        .poll(() => events.find((e) => e.kind === "turn_complete")?.status, {
          timeout: 90_000,
        })
        .toBe("completed");
    try {
      proc = await runtime.startSession(
        {
          ...options,
          mcpServers: [
            {
              id: "receipt",
              name: "Receipt",
              type: "stdio",
              isBuiltin: false,
              command: process.execPath,
              args: [serverFile],
              env: { AGY_TEST_RECEIPT: receipt, AGY_TEST_CALLS: calls },
            },
          ],
        },
        receive,
      );
      const nativeId = events.find((e) => e.kind === "session_init")!.sessionId;
      await runtime.sendMessage(
        proc,
        "Call the fresh_receipt MCP tool exactly once and print its result. Do not use any other tools.",
      );
      await terminal();
      expect(await readFile(calls, "utf8")).toBe("1");
      expect(
        events
          .flatMap((e) => (e.kind === "text_delta" ? [e.text] : []))
          .join(""),
      ).toContain(receipt);
      await runtime.stopSession(proc);
      events.length = 0;
      proc = await runtime.startSession(
        { ...options, mcpServers: [], resumeSessionId: nativeId },
        receive,
      );
      await runtime.sendMessage(
        proc,
        "If fresh_receipt is present call it now, otherwise say UNAVAILABLE. Do not use other tools or recall an old receipt.",
      );
      await terminal();
      expect(await readFile(calls, "utf8")).toBe("1");
      expect(
        events
          .flatMap((e) => (e.kind === "text_delta" ? [e.text] : []))
          .join(""),
      ).toMatch(/unavailable/i);
    } finally {
      if (proc) await runtime.stopSession(proc);
      await Promise.all(
        [workspacePath, fixture].map((dir) =>
          rm(dir, { recursive: true, force: true }),
        ),
      );
    }
  },
  210_000,
);

it.skipIf(process.env.MYAGENTS_TEST_AGY !== "1")(
  "asks a native question and scopes an authenticated HTTP tool to one of two sessions",
  async () => {
    const { createServer } = await import("node:http");
    const { randomBytes } = await import("node:crypto");
    const auth = randomBytes(24).toString("hex");
    const receipt = randomUUID();
    let calls = 0;
    const http = createServer(async (request, response) => {
      if (request.headers.authorization !== "Bearer " + auth) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (rpc.method === "initialize")
        result = {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "ticket", version: "1" },
        };
      if (rpc.method === "tools/list")
        result = {
          tools: [
            {
              name: "issue_ticket",
              description: "Read today's test ticket",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      if (rpc.method === "tools/call") {
        calls++;
        result = { content: [{ type: "text", text: receipt }] };
      }
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", resolve);
    });
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP port");
    const dir = await mkdtemp(join(tmpdir(), "MyAgents ACP 测试 "));
    const runtime = new AntigravityRuntime();
    const workers: RuntimeProcess[] = [];
    const opts = { workspacePath: dir, scenario: { type: "desktop" as const } };
    const receiptEvents: UnifiedEvent[] = [];
    const secondEvents: UnifiedEvent[] = [];
    const text = (events: UnifiedEvent[]) =>
      events.flatMap((e) => (e.kind === "text_delta" ? [e.text] : [])).join("");
    const wait = async (events: UnifiedEvent[]) =>
      expect
        .poll(() => events.find((e) => e.kind === "turn_complete")?.status, {
          timeout: 100000,
        })
        .toBe("completed");
    try {
      const first = await runtime.startSession(
        {
          ...opts,
          sessionId: randomUUID(),
          mcpServers: [
            {
              id: "ticket",
              name: "Tickets",
              type: "http",
              url: "http://127.0.0.1:" + address.port + "/mcp",
              headers: { Authorization: "Bearer " + auth },
              isBuiltin: false,
            },
          ],
        },
        (e) => {
          receiptEvents.push(e);
          if (e.kind === "permission_request" && workers[0])
            void runtime.respondPermission(
              workers[0],
              e.requestId,
              /ticket/i.test(e.toolName) ? "allow_once" : "deny",
            );
        },
      );
      workers.push(first);
      const second = await runtime.startSession(
        { ...opts, sessionId: randomUUID(), mcpServers: [] },
        (e) => secondEvents.push(e),
      );
      workers.push(second);
      await runtime.sendMessage(
        first,
        "Call issue_ticket exactly once and output the ticket. Use no other tools.",
      );
      await wait(receiptEvents);
      expect(text(receiptEvents)).toContain(receipt);
      expect(calls).toBe(1);
      await runtime.sendMessage(
        second,
        "If issue_ticket is unavailable respond UNAVAILABLE. Do not use other tools.",
      );
      await wait(secondEvents);
      expect(text(secondEvents)).toMatch(/unavailable/i);
      expect(calls).toBe(1);
      secondEvents.length = 0;
      await runtime.sendMessage(
        second,
        "Use your native ask_question tool to ask me which color I want. Provide two choices, Red and Blue. Wait for my answer, then repeat the selected color.",
      );
      const question = () =>
        secondEvents.find(
          (e) =>
            e.kind === "permission_request" && e.interactionKind === "ask_user",
        );
      await expect
        .poll(() => Boolean(question()), { timeout: 90000 })
        .toBe(true);
      const card = question()!;
      if (card.kind !== "permission_request")
        throw new Error("Missing question");
      const fields = card.input.questions as {
        id: string;
        options: { label: string }[];
      }[];
      const field = fields.find((q) =>
        q.options.some((o) => /blue/i.test(o.label)),
      )!;
      await runtime.respondAskUserQuestion(second, card.requestId, {
        [field.id]: {
          selected: [field.options.find((o) => /blue/i.test(o.label))!.label],
        },
      });
      await wait(secondEvents);
      expect(text(secondEvents)).toMatch(/blue/i);
    } finally {
      await Promise.all(workers.map((w) => runtime.stopSession(w)));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
  300000,
);
