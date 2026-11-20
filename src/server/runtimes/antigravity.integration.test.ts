import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as subprocess from "../utils/subprocess";
import type { UnifiedEvent } from "./types";
import { AntigravityRuntime } from "./antigravity";

// Keep real SDK framing, pipes and process teardown. Only substitute the external executable.
const fixture = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = f => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...f})+'\\n');
const approvals = new Map();
let turn;
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}},authMethods:[]});
  if (f.method === 'session/new') return reply({sessionId:'native'});
  if (f.method === 'session/resume') return send({id:f.id,error:{code:-32602,message:'unknown session'}});
  if (f.method === 'session/close') return reply({});
  if (f.method === 'session/prompt') {
    turn = f.id;
    if (f.params.prompt[0].text === 'exit') return process.exit(2);
    for (const id of [101,102]) send({id,method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:String(id),title:'file '+id},options:[{kind:'allow_once',optionId:'a'+id,name:'Yes'},{kind:'reject_once',optionId:'d'+id,name:'No'}]}});
  } else if ([101,102].includes(f.id)) {
    approvals.set(f.id,f.result.outcome);
    if(approvals.size === 2) {
      const ok = approvals.get(101).optionId === 'a101' && approvals.get(102).optionId === 'd102';
      const cancelled = [...approvals.values()].every(v => v.outcome === 'cancelled');
      send({id:turn,result:{stopReason: ok ? 'end_turn' : cancelled ? 'cancelled' : 'refusal'}});
    }
  }
});
`;
const originalSpawn = subprocess.spawn;
const runtime = new AntigravityRuntime();
let directory: string;
let processHandle: Awaited<ReturnType<typeof runtime.startSession>> | undefined;
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "MyAgents 测试 "));
  const spawn = vi
    .spyOn(subprocess, "spawn")
    .mockImplementation((_argv, options) =>
      originalSpawn([process.execPath, "-e", fixture], options),
    );
  const options = {
    workspacePath: directory,
    sessionId: "product",
    scenario: { type: "desktop" as const },
  };
  const events: UnifiedEvent[] = [];
  return {
    options,
    events,
    receive: (e: UnifiedEvent) => {
      events.push(e);
    },
    spawn,
  };
}
afterEach(async () => {
  if (processHandle) await runtime.stopSession(processHandle);
  processHandle = undefined;
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("answers overlapping approvals by native option and request identity in reverse order", async () => {
  const { options, events, receive } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "permissions");
  const approvals = () => events.filter((e) => e.kind === "permission_request");
  await expect.poll(() => approvals().length).toBe(2);
  expect(approvals().every((p) => p.suppressAlwaysAllowRule)).toBe(true);
  await runtime.respondPermission(
    processHandle,
    approvals()[1].requestId,
    "deny",
  );
  await runtime.respondPermission(
    processHandle,
    approvals()[0].requestId,
    "allow_once",
  );
  await expect
    .poll(() => events.find((e) => e.kind === "turn_complete")?.status)
    .toBe("completed");
});
it("settles headless approvals without a card and reports an unexpected worker exit", async () => {
  const { options, events, receive } = await setup();
  processHandle = await runtime.startSession(
    {
      ...options,
      scenario: {
        type: "cron",
        taskId: "test",
        intervalMinutes: 1,
        aiCanExit: true,
      },
    },
    receive,
  );
  await runtime.sendMessage(processHandle, "permissions");
  await expect
    .poll(() => events.find((e) => e.kind === "turn_complete")?.status)
    .toBe("cancelled");
  expect(events.some((e) => e.kind === "permission_request")).toBe(false);
  await runtime.sendMessage(processHandle, "exit");
  await expect
    .poll(() => events.find((e) => e.kind === "session_complete")?.subtype)
    .toBe("error");
});
it("preserves a missing native binding and refuses to start a replacement session", async () => {
  const { options, events, receive, spawn } = await setup();
  await expect(
    runtime.startSession({ ...options, resumeSessionId: "missing" }, receive),
  ).rejects.toThrow(/恢复/);
  expect(events.some((e) => e.kind === "session_init")).toBe(false);
  expect(spawn).toHaveBeenCalledTimes(1);
});
