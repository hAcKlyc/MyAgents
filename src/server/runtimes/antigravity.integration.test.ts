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
let model = 'model-a';
let thought = 'high';
let mode = 'accept-edits';
const allowedThoughts = () => model === 'model-a' ? ['medium', 'high'] : ['low'];
const select = (id, currentValue, values) => ({
  id, name:id, type:'select', currentValue,
  options: values.map(value => ({value,name:value})),
});
const configOptions = () => [
  select('model', model, ['model-a','model-b']),
  select('thought_level', thought, allowedThoughts()),
  select('mode', mode, []),
];
let turn;
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}},authMethods:[]});
  if (f.method === 'session/set_config_option') {
    const {configId, value} = f.params;
    if (configId === 'mode' && ['auto','accept-edits','default','plan'].includes(value)) mode = value;
    else if (configId === 'model' && ['model-a','model-b'].includes(value)) {
      if (model !== value) {
        model = value;
        thought = model === 'model-a' ? 'high' : 'low';
      }
    } else if (configId === 'thought_level' && allowedThoughts().includes(value)) thought = value;
    else return send({id:f.id,error:{code:-32602,message:'invalid config option'}});
    return reply({configOptions:configOptions()});
  }
  if (f.method === 'session/new') return reply({sessionId:'native',configOptions:configOptions()});
  if (f.method === 'session/resume') return send({id:f.id,error:{code:-32602,message:'unknown session'}});
  if (f.method === 'session/close') return reply({});
  if (f.method === 'session/prompt') {
    turn = f.id;
    if (f.params.prompt[0].text === 'exit') return process.exit(2);
    if (f.params.prompt[0].text === 'usage') return reply({
      stopReason:'end_turn',
      usage:{inputTokens:100,outputTokens:20,thoughtTokens:5,cachedReadTokens:30,totalTokens:155},
    });
    if (f.params.prompt[0].text === 'delegate') {
      const update = (data, sessionId = 'native') => send({method:'session/update',params:{sessionId,update:data}});
      const text = text => ({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
      const usage = {sessionUpdate:'usage_update',used:40,size:100};
      update(text('Waiting for delegated work.'));
      reply({stopReason:'end_turn'});
      setTimeout(() => {
        update(usage);
        update(text('Unrelated'), 'foreign');
        update(text('Subagent one reported.'));
        update(usage);
        update(text('Subagents two and three reported. '));
        update(text('Here is the summary.'));
        update(usage);
      }, 25);
      return;
    }
    if (f.params.prompt[0].text === 'tool projection') {
      const update = data => send({method:'session/update',params:{sessionId:'native',update:data}});
      const content = text => ({type:'content',content:{type:'text',text}});
      update({sessionUpdate:'tool_call',toolCallId:'cmd',title:'printf synthetic-private-value',kind:'execute',status:'pending',rawInput:{CommandLine:'printf synthetic-private-value',toolSummary:'Print a marker'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',status:'in_progress',content:[content('first')]});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'still'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',content:[content('first and second')]});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',content:[content('revised')]});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' writing'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',status:'failed',content:[content('final output')],rawOutput:{exit_code:6,duration_ms:25}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',status:'failed',content:[content('do not duplicate')]});
      return reply({stopReason:'end_turn'});
    }
    if (f.params.prompt[0].text === 'exact permission choices') {
      for (const id of [301,302]) send({id,method:'session/request_permission',params:{
        sessionId:'native',
        toolCall:{toolCallId:String(id),title:'Run synthetic command',kind:'execute',rawInput:{CommandLine:'printf '+ 'x'.repeat(1500)}},
        options:[
          {kind:'allow_always',optionId:'workspace-'+id,name:'Always allow in this workspace'},
          {kind:'allow_always',optionId:'exact-'+id,name:'Always allow this command'},
          {kind:'reject_always',optionId:'reject-'+id,name:'Always deny this command'},
        ],
      }});
      return;
    }
    for (const id of [101,102]) send({id,method:'session/request_permission',params:{sessionId:'native',toolCall:{toolCallId:String(id),title:'file '+id},options:[{kind:'allow_once',optionId:'a'+id,name:'Yes'},{kind:'reject_once',optionId:'d'+id,name:'No'}]}});
  } else if ([301,302].includes(f.id)) {
    approvals.set(f.id,f.result.outcome);
    if (approvals.size === 2) send({id:turn,result:{
      stopReason: approvals.get(301).optionId === 'exact-301' && approvals.get(302).optionId === 'reject-302'
        ? 'end_turn' : 'refusal',
    }});
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

it("gives native model discovery 30 seconds", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  vi.spyOn(subprocess, "spawn").mockImplementation((_argv, options) =>
    originalSpawn([process.execPath, "-e", "console.log('model-id\\tNative Model')"], options));
  expect(await runtime.queryModels()).toEqual([{ value: "model-id", displayName: "Native Model" }]);
  expect(timeout).toHaveBeenCalledWith(30_000);
});

it("projects real ACP command fields and replaces cumulative output without splitting root text", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "tool projection");
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("completed");
  const projection = events.filter((event) => event.kind.startsWith("tool_") || event.kind.startsWith("text_"));
  expect(projection).toMatchObject([
    { kind: "tool_use_start", toolUseId: "cmd", toolName: "Bash", input: { command: "printf synthetic-private-value", description: "Print a marker" } },
    { kind: "tool_result_update", toolUseId: "cmd", content: "", status: "pending" },
    { kind: "tool_result_update", toolUseId: "cmd", content: "first", status: "in_progress" },
    { kind: "text_delta", text: "still" },
    { kind: "tool_result_update", toolUseId: "cmd", content: "first and second" },
    { kind: "tool_result_update", toolUseId: "cmd", content: "revised" },
    { kind: "text_delta", text: " writing" },
    { kind: "tool_use_stop", toolUseId: "cmd" },
    { kind: "tool_result", toolUseId: "cmd", content: "final output", isError: true, metadata: { status: "failed", exitCode: 6, durationMs: 25 } },
    { kind: "text_stop" },
  ]);
});

it.each(["accept-edits", "auto", "dangerously-skip-permissions"])(
  "applies %s via its native interface and reports when a replacement is needed",
  async mode => {
    const { options, receive, spawn } = await setup();
    processHandle = await runtime.startSession({ ...options, permissionMode: mode }, receive);
    const full = mode === "dangerously-skip-permissions";
    expect(spawn.mock.calls[0][0].includes("--dangerously-skip-permissions")).toBe(full);
    expect(processHandle.requiresPermissionModeRestart("dangerously-skip-permissions")).toBe(!full);
    expect(processHandle.requiresPermissionModeRestart("accept-edits")).toBe(full);
    await expect(runtime.setPermissionMode(processHandle, full ? "auto" : "dangerously-skip-permissions")).rejects.toThrow(/重新启动/);
    if (!full) await runtime.setPermissionMode(processHandle, "auto");
  },
);

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


it("settles native options by the exact offered ID and retains long command details", async () => {
  const { options, events, receive } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "exact permission choices");
  const approvals = () => events.filter((event) => event.kind === "permission_request");
  await expect.poll(() => approvals().length).toBe(2);
  const [first, second] = approvals();
  expect(first.toolName).toBe("Bash");
  expect(first.input.command).toBe("printf " + "x".repeat(1500));
  expect(first.permissionOptions).toEqual([
    { kind: "allow_always", optionId: "workspace-301", name: "Always allow in this workspace" },
    { kind: "allow_always", optionId: "exact-301", name: "Always allow this command" },
    { kind: "reject_always", optionId: "reject-301", name: "Always deny this command" },
  ]);
  await expect(runtime.respondPermissionOption(processHandle, first.requestId, "exact-302"))
    .rejects.toThrow(/当前请求/);
  await runtime.respondPermissionOption(processHandle, second.requestId, "reject-302");
  await runtime.respondPermissionOption(processHandle, first.requestId, "exact-301");
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status)
    .toBe("completed");
});


it("admits and completes two detached parent replies without another prompt", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "delegate");
  await expect.poll(() => events.filter((event) => event.kind === "turn_complete").length).toBe(3);
  const replies = events.filter((event) =>
    event.kind === "root_turn_admitted" || event.kind === "text_delta" || event.kind === "turn_complete",
  );
  expect(replies).toMatchObject([
    { kind: "text_delta", text: "Waiting for delegated work." },
    { kind: "turn_complete", status: "completed" },
    { kind: "root_turn_admitted", origin: "collaboration" },
    { kind: "text_delta", text: "Subagent one reported." },
    { kind: "turn_complete", status: "completed" },
    { kind: "root_turn_admitted", origin: "collaboration" },
    { kind: "text_delta", text: "Subagents two and three reported. " },
    { kind: "text_delta", text: "Here is the summary." },
    { kind: "turn_complete", status: "completed" },
  ]);
});


it("reports native model and thought choices, resets the override, and switches families", async () => {
  const { options, receive } = await setup();
  processHandle = await runtime.startSession({ ...options, reasoningEffort: "medium" }, receive);
  const readCatalog = () => runtime.queryModels({ process: processHandle });
  expect(await readCatalog()).toMatchObject([
    { value: "model-a", isDefault: true, isCurrent: true, currentReasoningEffort: "medium", defaultReasoningEffort: "high" },
    { value: "model-b" },
  ]);
  await runtime.setReasoningEffort(processHandle, undefined);
  expect((await readCatalog())[0]?.currentReasoningEffort).toBe("high");
  await runtime.setReasoningEffort(processHandle, "medium");
  await runtime.setModel(processHandle, "model-b");
  expect(await readCatalog()).toMatchObject([
    { value: "model-a", isDefault: true },
    {
      value: "model-b", isCurrent: true, currentReasoningEffort: "low", defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }],
    },
  ]);
});


it("keeps the prompt usage delta independent from native context-window telemetry", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "usage");
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("completed");
  expect(events).toContainEqual({
    kind: "usage", inputTokens: 100, outputTokens: 25, cacheReadTokens: 30,
    cacheCreationTokens: undefined, semantics: "delta",
  });
  expect(events.some((event) => event.kind === "context_update")).toBe(false);
});

it("fails closed with an actionable error when the CLI session does not offer auto mode, and skips redundant mode RPCs", async () => {
  const restrictedFixture = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = f => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...f})+'\\n');
let mode = 'accept-edits';
let setModeCalls = 0;
const select = (id, currentValue, values) => ({
  id, name:id, type:'select', currentValue,
  options: values.map(value => ({value, name:value})),
});
const configOptions = () => [
  select('model', 'model-a', ['model-a']),
  select('thought_level', 'high', ['medium', 'high']),
  select('mode', mode, ['default', 'accept-edits', 'plan']),
];
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{},authMethods:[]});
  if (f.method === 'session/new') return reply({sessionId:'restricted',configOptions:configOptions()});
  if (f.method === 'session/set_config_option') {
    if (f.params.configId === 'mode') setModeCalls++;
    if (f.params.configId === 'mode' && ['default', 'accept-edits', 'plan'].includes(f.params.value)) {
      mode = f.params.value;
      return reply({configOptions:configOptions()});
    }
    return send({id:f.id, error:{code:-32602, message:'Unknown mode: ' + f.params.value}});
  }
  if (f.method === 'session/prompt') {
    send({method:'session/update',params:{sessionId:'restricted',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'modeCalls=' + setModeCalls}}}});
    return reply({stopReason:'end_turn'});
  }
  if (f.method === 'session/close') return reply({});
});
`;
  directory = await mkdtemp(join(tmpdir(), "MyAgents-agy-restricted-mode-"));
  vi.spyOn(subprocess, "spawn").mockImplementation((_argv, options) =>
    originalSpawn([process.execPath, "-e", restrictedFixture], options));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await expect(
    runtime.startSession(
      { workspacePath: directory, sessionId: "product", scenario: { type: "desktop" }, permissionMode: "auto" },
      () => undefined,
    ),
  ).rejects.toThrow(/帮我批准（auto）.*请求批准/);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Permission mode 'auto' is not offered"));

  const events: UnifiedEvent[] = [];
  processHandle = await runtime.startSession(
    { workspacePath: directory, sessionId: "product", scenario: { type: "desktop" }, permissionMode: "accept-edits" },
    (e) => events.push(e),
  );
  await runtime.sendMessage(processHandle, "check");
  await expect.poll(() => events.find((e) => e.kind === "turn_complete")?.status).toBe("completed");
  // Mode was already accept-edits on session/new so no redundant set_config_option RPC was sent.
  expect(events.find((e) => e.kind === "text_delta")).toMatchObject({ text: "modeCalls=0" });

  await expect(runtime.setPermissionMode(processHandle, "auto")).rejects.toThrow(/帮我批准（auto）.*请求批准/);
});

it("translates raw ACP -32602 on mode=auto when the worker omits mode option lists", async () => {
  const opaqueModeFixture = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = f => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...f})+'\\n');
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{},authMethods:[]});
  if (f.method === 'session/new') return reply({sessionId:'opaque',configOptions:[{id:'mode',name:'mode',type:'select',currentValue:'default',options:[]}]});
  if (f.method === 'session/set_config_option') return send({id:f.id, error:{code:-32602, message:'Unknown mode: auto'}});
  if (f.method === 'session/close') return reply({});
});
`;
  directory = await mkdtemp(join(tmpdir(), "MyAgents-agy-opaque-mode-"));
  vi.spyOn(subprocess, "spawn").mockImplementation((_argv, options) =>
    originalSpawn([process.execPath, "-e", opaqueModeFixture], options));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  await expect(
    runtime.startSession(
      { workspacePath: directory, sessionId: "product", scenario: { type: "desktop" }, permissionMode: "auto" },
      () => undefined,
    ),
  ).rejects.toThrow(/帮我批准（auto）.*请求批准/);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("configId=mode value=auto"));
});

it("reconciles unsupported persisted reasoningEffort at startup while rejecting unsupported live switches", async () => {
  const { options, receive } = await setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // Persisted 'max' is not in model-a's offered ['medium', 'high']: startup keeps native 'high' instead of crashing.
  processHandle = await runtime.startSession({ ...options, model: "model-a", reasoningEffort: "max" }, receive);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring unsupported persisted reasoningEffort='max'"));
  const catalog = await runtime.queryModels({ process: processHandle });
  expect(catalog[0]).toMatchObject({ value: "model-a", isCurrent: true, currentReasoningEffort: "high" });

  // Explicit live switch to an unsupported level fails clearly instead of leaking raw ACP -32602.
  await expect(runtime.setReasoningEffort(processHandle, "max")).rejects.toThrow(/推理强度 "max".*medium、high/);
});

it("maps a family model ID to a matching legacy flat model ID and ignores thought_level when legacy ACP has none", async () => {
  const legacyFixture = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = f => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...f})+'\\n');
const available = [
  {modelId:'legacy-a-high', name:'Legacy A (High)'},
  {modelId:'legacy-a-low', name:'Legacy A (Low)'},
];
let current = 'legacy-a-high';
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{},authMethods:[]});
  if (f.method === 'session/new') return reply({sessionId:'legacy',configOptions:[{id:'mode',name:'mode',type:'select',currentValue:'accept-edits',options:[]}],models:{currentModelId:current,availableModels:available}});
  if (f.method === 'session/set_config_option') return send({id:f.id, error:{code:-32602, message:'unsupported config'}});
  if (f.method === 'session/set_model') {
    if (!available.some(m => m.modelId === f.params.modelId)) return send({id:f.id, error:{code:-32602, message:'unknown model'}});
    current = f.params.modelId;
    return reply({});
  }
  if (f.method === 'session/close') return reply({});
});
`;
  directory = await mkdtemp(join(tmpdir(), "MyAgents-agy-legacy-family-"));
  vi.spyOn(subprocess, "spawn").mockImplementation((_argv, options) =>
    originalSpawn([process.execPath, "-e", legacyFixture], options));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  processHandle = await runtime.startSession(
    {
      workspacePath: directory,
      sessionId: "legacy-product",
      scenario: { type: "desktop" },
      model: "legacy-a",
      reasoningEffort: "low",
      permissionMode: "accept-edits",
    },
    () => undefined,
  );
  const catalog = await runtime.queryModels({ process: processHandle });
  expect(catalog.find((m) => m.isCurrent)?.value).toBe("legacy-a-low");
});
