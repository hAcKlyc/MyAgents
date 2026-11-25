import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setSidecarPort } from "../session-core/sidecar-port";
import * as subprocess from "../utils/subprocess";
import {
  isRuntimeSteerUnavailableError,
  type UnifiedEvent,
} from "./types";
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
let settleAuthCancelledPrompt;
let recoverAfterFramedQuote = false;
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
  if (f.method === 'session/new') return reply({
    sessionId:'native',
    configOptions:configOptions(),
    models:{
      currentModelId:'model-a-high',
      availableModels:[
        {modelId:'model-a-high',name:'Model A (High)'},
        {modelId:'model-a-medium',name:'Model A (Medium)'},
        {modelId:'model-b-low',name:'Model B (Low)'},
        {modelId:'model-b-high',name:'Model B (High)'},
      ],
    },
  });
  if (f.method === 'session/resume') return send({id:f.id,error:{code:-32602,message:'unknown session'}});
  if (f.method === 'session/cancel' && settleAuthCancelledPrompt) {
    const settle = settleAuthCancelledPrompt;
    settleAuthCancelledPrompt = undefined;
    return settle();
  }
  if (f.method === 'session/close') return reply({});
  if (f.method === 'session/cancel') {
    if (turn !== undefined) {
      const cancelled = turn;
      turn = undefined;
      send({id:cancelled,result:{stopReason:'cancelled'}});
    }
    return;
  }
  if (f.method === 'session/prompt') {
    const promptText = f.params.prompt[0]?.text ?? '';
    const update = (data, sessionId = 'native') => send({method:'session/update',params:{sessionId,update:data}});
    const content = text => ({type:'content',content:{type:'text',text}});
    if (turn !== undefined && promptText === 'steer-permission-race') {
      return send({
        id:f.id,
        error:{
          code:-32603,
          message:"Can't add this prompt to session native: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again",
        },
      });
    }
    if (turn !== undefined && promptText === 'steer-invalid') {
      return send({id:f.id,error:{code:-32602,message:'Empty prompt'}});
    }
    if (turn !== undefined && promptText === 'steer-one') {
      const prev = turn;
      turn = f.id;
      send({
        id:prev,
        result:{
          stopReason:'end_turn',
          usage:{inputTokens:100,outputTokens:20,thoughtTokens:5,cachedReadTokens:10,totalTokens:135},
        },
      });
      setTimeout(() => {
        update({sessionUpdate:'tool_call_update',toolCallId:'steer-cmd',status:'completed',content:[content('done')],rawOutput:{exit_code:0,duration_ms:15}});
      }, 15);
      return;
    }
    if (turn !== undefined && promptText === 'steer-two') {
      const prev = turn;
      turn = f.id;
      send({id:prev,result:{stopReason:'end_turn'}});
      setTimeout(() => {
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Final steered answer.'}});
        const finished = turn;
        turn = undefined;
        send({
          id:finished,
          result:{
            stopReason:'end_turn',
            usage:{inputTokens:40,outputTokens:10,thoughtTokens:2,cachedReadTokens:20,totalTokens:72},
          },
        });
      }, 15);
      return;
    }
    if (turn !== undefined && promptText === 'steer-cancel-target') {
      const prev = turn;
      turn = f.id;
      send({id:prev,result:{stopReason:'end_turn'}});
      return;
    }
    if (turn !== undefined && promptText === 'steer-next-first') {
      const prev = turn;
      turn = undefined;
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Early successor reply.'}});
      reply({stopReason:'max_tokens'});
      setTimeout(() => send({id:prev,result:{stopReason:'end_turn'}}), 25);
      return;
    }
    if (turn !== undefined && promptText === 'steer-old-before-rejection') {
      const prev = turn;
      turn = undefined;
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Tail from predecessor.'}});
      send({id:prev,result:{stopReason:'end_turn'}});
      setTimeout(() => {
        update({sessionUpdate:'usage_update',used:42,size:100});
        send({
          id:f.id,
          error:{
            code:-32603,
            message:"Can't add this prompt to session native: the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again",
          },
        });
      }, 25);
      return;
    }
    if (turn !== undefined && promptText === 'steer-early-permission') {
      const prev = turn;
      turn = f.id;
      send({
        id:401,
        method:'session/request_permission',
        params:{
          sessionId:'native',
          toolCall:{toolCallId:'perm-401',title:'Approve steered action'},
          options:[
            {kind:'allow_once',optionId:'allow-401',name:'Yes'},
            {kind:'reject_once',optionId:'deny-401',name:'No'},
          ],
        },
      });
      setTimeout(() => send({id:prev,result:{stopReason:'end_turn'}}), 20);
      return;
    }
    turn = f.id;
    const textChunk = text => ({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
    const auth401Text = '\\n⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.\\n';
    if (promptText === 'exit') return process.exit(2);
    if (promptText === 'auth-401-recover' || promptText === 'auth-401-exhaust' || promptText === 'auth-401-cap' || promptText === 'auth-401-cancel') {
      globalThis.__authMode = promptText;
      globalThis.__authCalls = 0;
    }
    if (globalThis.__authMode) {
      globalThis.__authCalls += 1;
      const call = globalThis.__authCalls;
      if (globalThis.__authMode === 'auth-401-recover') {
        if (call === 1) {
          update(textChunk('Started in the original session. '));
          update({sessionUpdate:'tool_call',toolCallId:'pre-401',title:'Check status',kind:'execute',status:'pending',rawInput:{CommandLine:'echo ok'}});
          update({sessionUpdate:'tool_call_update',toolCallId:'pre-401',status:'completed',content:[{type:'content',content:{type:'text',text:'ok'}}],rawOutput:{exit_code:0}});
          update(textChunk(auth401Text));
          return reply({stopReason:'end_turn',usage:{inputTokens:100,outputTokens:20,thoughtTokens:5,cachedReadTokens:30,totalTokens:155}});
        }
        if (f.params.sessionId !== 'native' || f.params.prompt.length !== 1 || !promptText.startsWith('Continue from where you stopped.')) {
          return reply({stopReason:'refusal'});
        }
        if (call === 2) {
          update(textChunk(auth401Text));
          return reply({stopReason:'end_turn',usage:{inputTokens:10,outputTokens:0,thoughtTokens:0,cachedReadTokens:5,totalTokens:15}});
        }
        globalThis.__authMode = null;
        update(textChunk('Recovered in the same session.'));
        return reply({stopReason:'end_turn',usage:{inputTokens:40,outputTokens:12,thoughtTokens:3,cachedReadTokens:20,totalTokens:75}});
      }
      if (globalThis.__authMode === 'auth-401-exhaust') {
        update(textChunk(auth401Text));
        return reply({stopReason:'end_turn',usage:{inputTokens:50,outputTokens:5,thoughtTokens:0,cachedReadTokens:10,totalTokens:65}});
      }
      if (globalThis.__authMode === 'auth-401-cap') {
        // Every attempt makes real progress (a tool call) before hitting 401 again,
        // exercising consecutive-retry reset + hard per-turn cap (4 total retries = 5 total prompts).
        update({sessionUpdate:'tool_call',toolCallId:'step-' + call,title:'Step ' + call,kind:'execute',status:'pending',rawInput:{CommandLine:'echo ' + call}});
        update({sessionUpdate:'tool_call_update',toolCallId:'step-' + call,status:'completed',content:[{type:'content',content:{type:'text',text:String(call)}}],rawOutput:{exit_code:0}});
        update(textChunk(auth401Text));
        return reply({stopReason:'end_turn',usage:{inputTokens:10,outputTokens:1,thoughtTokens:0,cachedReadTokens:0,totalTokens:11}});
      }
      if (globalThis.__authMode === 'auth-401-cancel') {
        if (call === 1) {
          update(textChunk(auth401Text));
          return reply({stopReason:'end_turn',usage:{inputTokens:25,outputTokens:2,thoughtTokens:0,cachedReadTokens:0,totalTokens:27}});
        }
        // Should never be reached if interrupted during backoff.
        update(textChunk('SHOULD_NOT_RUN'));
        return reply({stopReason:'end_turn'});
      }
    }
    if (promptText === 'auth-401-cancel-before-warning' || promptText === 'auth-401-cancel-after-warning') {
      const warningBeforeCancel = promptText === 'auth-401-cancel-after-warning';
      if (warningBeforeCancel) update(textChunk(auth401Text));
      update({sessionUpdate:'usage_update',used:44,size:100});
      settleAuthCancelledPrompt = () => {
        if (!warningBeforeCancel) update(textChunk(auth401Text));
        return reply({stopReason:'end_turn',usage:{inputTokens:25,outputTokens:2,totalTokens:27}});
      };
      return;
    }
    if (promptText === 'auth-401-warning-after-framed-quote') {
      recoverAfterFramedQuote = true;
      update(textChunk(auth401Text));
      update(textChunk(auth401Text));
      return reply({stopReason:'end_turn'});
    }
    if (promptText.startsWith('auth-401-framed-quote-')) {
      update(textChunk(auth401Text));
      return reply({stopReason:promptText.slice('auth-401-framed-quote-'.length)});
    }
    if (promptText === 'auth-401-quoted-final-chunk') {
      update(textChunk('Here is the exact error: '));
      update(textChunk(auth401Text.trim()));
      return reply({stopReason:'end_turn'});
    }
    if (promptText === 'auth-401-quoted') {
      update(textChunk(auth401Text));
      update(textChunk('That error occurs when OAuth2 expires.'));
      return reply({stopReason:'end_turn'});
    }
    if (promptText === 'auth-401-quoted-single-chunk') {
      update(textChunk(auth401Text.trim() + ' That error occurs when OAuth2 expires.'));
      return reply({stopReason:'end_turn'});
    }
    if (promptText === 'auth-401-disconnect-during-backoff') {
      update(textChunk(auth401Text));
      reply({stopReason:'end_turn',usage:{inputTokens:33,outputTokens:7,thoughtTokens:0,cachedReadTokens:5,totalTokens:45}});
      setTimeout(() => { process.stdout.end(); }, 25);
      return;
    }
    if (promptText === 'auth-401-exit-during-backoff') {
      update(textChunk(auth401Text));
      reply({stopReason:'end_turn',usage:{inputTokens:44,outputTokens:6,thoughtTokens:2,cachedReadTokens:12,totalTokens:64}});
      setTimeout(() => { process.exit(3); }, 25);
      return;
    }
    if (promptText.startsWith('Continue from where you stopped.')) {
      update(textChunk(recoverAfterFramedQuote ? 'Continued after warning.' : 'UNEXPECTED_RETRY'));
      recoverAfterFramedQuote = false;
      return reply({stopReason:'end_turn'});
    }
    if (promptText === 'usage') {
      turn = undefined;
      return reply({
        stopReason:'end_turn',
        usage:{inputTokens:100,outputTokens:20,thoughtTokens:5,cachedReadTokens:30,totalTokens:155},
      });
    }
    if (promptText === 'steer-root') {
      update({sessionUpdate:'tool_call',toolCallId:'steer-cmd',title:'sleep 4',kind:'execute',status:'in_progress',rawInput:{CommandLine:'sleep 4'}});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Working before steer.'}});
      return;
    }
    if (promptText === 'steer-root-finishable') {
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Still running.'}});
      setTimeout(() => {
        if (turn === f.id) {
          turn = undefined;
          reply({stopReason:'end_turn'});
        }
      }, 80);
      return;
    }
    if (promptText === 'delegate') {
      const text = text => ({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
      const usage = {sessionUpdate:'usage_update',used:40,size:100};
      update(text('Waiting for delegated work.'));
      turn = undefined;
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
    if (promptText === 'tool projection') {
      update({sessionUpdate:'tool_call',toolCallId:'cmd',title:'printf synthetic-private-value',kind:'execute',status:'pending',rawInput:{CommandLine:'printf synthetic-private-value',toolSummary:'Print a marker'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',status:'in_progress',content:[content('first')]});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'still'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',content:[content('first and second')]});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',content:[content('revised')]});
      update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:' writing'}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',status:'failed',content:[content('final output')],rawOutput:{exit_code:6,duration_ms:25}});
      update({sessionUpdate:'tool_call_update',toolCallId:'cmd',status:'failed',content:[content('do not duplicate')]});
      turn = undefined;
      return reply({stopReason:'end_turn'});
    }
    if (promptText === 'exact permission choices') {
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
    if (approvals.size === 2 && turn !== undefined) {
      const done = turn;
      turn = undefined;
      send({id:done,result:{
        stopReason: approvals.get(301).optionId === 'exact-301' && approvals.get(302).optionId === 'reject-302'
          ? 'end_turn' : 'refusal',
      }});
    }
  } else if ([101,102].includes(f.id)) {
    approvals.set(f.id,f.result.outcome);
    if(approvals.size === 2 && turn !== undefined) {
      const done = turn;
      turn = undefined;
      const ok = approvals.get(101).optionId === 'a101' && approvals.get(102).optionId === 'd102';
      const cancelled = [...approvals.values()].every(v => v.outcome === 'cancelled');
      send({id:done,result:{stopReason: ok ? 'end_turn' : cancelled ? 'cancelled' : 'refusal'}});
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

it("silently retries transient mid-turn HTTP 401 warnings without leaking the banner or duplicating the user prompt", async () => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [15, 25] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, "auth-401-recover");

  await expect
    .poll(() => events.filter((event) => event.kind === "turn_complete").length)
    .toBe(1);

  const terminal = events.find((event) => event.kind === "turn_complete");
  expect(terminal).toMatchObject({ kind: "turn_complete", status: "completed" });
  const combinedText = events
    .filter((event): event is Extract<UnifiedEvent, { kind: "text_delta" }> => event.kind === "text_delta")
    .map((event) => event.text)
    .join("");
  expect(combinedText).toBe("Started in the original session. Recovered in the same session.");
  expect(events.filter((event) => event.kind === "tool_result")).toMatchObject([
    { toolUseId: "pre-401", isError: false },
  ]);
  expect(combinedText).not.toContain("UNAUTHENTICATED");

  // Usage across initial + 2 retries is accumulated and emitted once for the Product Turn.
  const usageEvents = events.filter((event) => event.kind === "usage");
  expect(usageEvents).toEqual([
    {
      kind: "usage",
      semantics: "delta",
      inputTokens: 150,
      outputTokens: 40,
      cacheReadTokens: 55,
      cacheCreationTokens: undefined,
    },
  ]);
});

it("escalates to a failed turn once consecutive HTTP 401 retries are exhausted", async () => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [10, 15] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, "auth-401-exhaust");

  await expect
    .poll(() => events.filter((event) => event.kind === "turn_complete").length)
    .toBe(1);

  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({
    kind: "turn_complete",
    status: "failed",
    error: expect.stringContaining("HTTP 401"),
  });
  expect(events.some((event) => event.kind === "text_delta")).toBe(false);
  // 1 initial attempt + 2 retries = 3 usage contributions accumulated.
  expect(events.filter((event) => event.kind === "usage")).toEqual([
    {
      kind: "usage",
      semantics: "delta",
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 30,
      cacheCreationTokens: undefined,
    },
  ]);
});

it("resets consecutive retry count after real progress while enforcing the per-turn cap of 4 retries", async () => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [5, 10] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, "auth-401-cap");

  await expect
    .poll(() => events.filter((event) => event.kind === "turn_complete").length)
    .toBe(1);

  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({
    kind: "turn_complete",
    status: "failed",
    error: expect.stringContaining("HTTP 401"),
  });
  const toolStarts = events.filter((event) => event.kind === "tool_use_start");
  expect(toolStarts).toHaveLength(5);
  expect(events.some((event) => event.kind === "text_delta")).toBe(false);
});

it("cancels cleanly without firing a pending HTTP 401 backoff retry when interrupted", async () => {
  const slowRuntime = new AntigravityRuntime({ authRetryDelaysMs: [2_000, 5_000] });
  const { options, receive, events } = await setup();
  processHandle = await slowRuntime.startSession(options, receive);
  await slowRuntime.sendMessage(processHandle, "auth-401-cancel");

  // Wait until the first 401 attempt has resolved and entered the backoff window.
  await expect
    .poll(() => (processHandle as { isAwaitingAuthRetry?: () => boolean }).isAwaitingAuthRetry?.())
    .toBe(true);
  await slowRuntime.interruptTurn(processHandle);

  await expect
    .poll(() => events.filter((event) => event.kind === "turn_complete").length)
    .toBe(1);
  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({
    kind: "turn_complete",
    status: "cancelled",
  });
  expect(events.some((event) => event.kind === "text_delta")).toBe(false);
  expect(events.filter((event) => event.kind === "usage")).toEqual([
    {
      kind: "usage",
      semantics: "delta",
      inputTokens: 25,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: undefined,
    },
  ]);
});

it.each(["before-warning", "after-warning"])(
  "honors cancel %s without interpreting the pending prompt response as success or retrying",
  async (timing) => {
    const reviewRuntime = new AntigravityRuntime({ authRetryDelaysMs: [10, 15] });
    const { options, receive, events } = await setup();
    processHandle = await reviewRuntime.startSession(options, receive);
    await reviewRuntime.sendMessage(processHandle, `auth-401-cancel-${timing}`);
    await expect.poll(() => events.some((event) => event.kind === "context_update")).toBe(true);

    await reviewRuntime.interruptTurn(processHandle);
    await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("cancelled");
    expect(events.filter((event) => event.kind === "usage")).toMatchObject([
      { semantics: "delta", inputTokens: 25, outputTokens: 2 },
    ]);
    expect(events.some((event) => event.kind === "text_delta")).toBe(false);

    await reviewRuntime.sendMessage(processHandle, "usage");
    await expect.poll(() => events.filter((event) => event.kind === "turn_complete").map((event) => event.status))
      .toEqual(["cancelled", "completed"]);
  },
);

it("preserves an unframed warning quoted verbatim in the last model chunk", async () => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [10, 15] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, "auth-401-quoted-final-chunk");
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("completed");
  const text = events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []);
  expect(text).toEqual([
    "Here is the exact error: ",
    "⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
  ]);
});

it.each([
  ["max_tokens", "failed"],
  ["cancelled", "cancelled"],
])("keeps a framed warning quote with the native stop reason %s", async (stopReason, status) => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [10, 15] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, `auth-401-framed-quote-${stopReason}`);
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe(status);
  const text = events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []);
  expect(text).toEqual([expect.stringMatching(/^\n⚠ UNAUTHENTICATED .*\n$/)]);
});

it("continues after a final native warning even when the previous chunk was an identical quote", async () => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [10, 15] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, "auth-401-warning-after-framed-quote");
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("completed");
  const text = events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []);
  expect(text).toEqual([expect.stringMatching(/^\n⚠ UNAUTHENTICATED .*\n$/), "Continued after warning."]);
});

it("flushes legitimately quoted 401 warning text intact across split or single chunks", async () => {
  const fastRuntime = new AntigravityRuntime({ authRetryDelaysMs: [10, 15] });
  const { options, receive, events } = await setup();
  processHandle = await fastRuntime.startSession(options, receive);
  await fastRuntime.sendMessage(processHandle, "auth-401-quoted");

  await expect
    .poll(() => events.filter((event) => event.kind === "turn_complete").length)
    .toBe(1);
  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({
    kind: "turn_complete",
    status: "completed",
  });
  let combinedText = events
    .filter((event): event is Extract<UnifiedEvent, { kind: "text_delta" }> => event.kind === "text_delta")
    .map((event) => event.text)
    .join("");
  expect(combinedText).toContain("⚠ UNAUTHENTICATED (code 401):");
  expect(combinedText).toContain("That error occurs when OAuth2 expires.");

  events.length = 0;
  await fastRuntime.sendMessage(processHandle, "auth-401-quoted-single-chunk");
  await expect
    .poll(() => events.filter((event) => event.kind === "turn_complete").length)
    .toBe(1);
  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({
    kind: "turn_complete",
    status: "completed",
  });
  combinedText = events
    .filter((event): event is Extract<UnifiedEvent, { kind: "text_delta" }> => event.kind === "text_delta")
    .map((event) => event.text)
    .join("");
  expect(combinedText).toContain("⚠ UNAUTHENTICATED (code 401):");
  expect(combinedText).toContain("That error occurs when OAuth2 expires.");
});

it("settles the turn and flushes accumulated usage when ACP disconnects during auth retry backoff", async () => {
  const slowRuntime = new AntigravityRuntime({ authRetryDelaysMs: [2_000, 5_000] });
  const { options, receive, events } = await setup();
  processHandle = await slowRuntime.startSession(options, receive);
  await slowRuntime.sendMessage(processHandle, "auth-401-disconnect-during-backoff");

  await expect
    .poll(() => events.find((event) => event.kind === "turn_complete"))
    .toMatchObject({
      kind: "turn_complete",
      status: "failed",
    });
  expect(events.filter((event) => event.kind === "usage")).toEqual([
    {
      kind: "usage",
      semantics: "delta",
      inputTokens: 33,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheCreationTokens: undefined,
    },
  ]);
});

it("flushes accumulated usage before reporting worker exit during auth retry backoff", async () => {
  const slowRuntime = new AntigravityRuntime({ authRetryDelaysMs: [2_000, 5_000] });
  const { options, receive, events } = await setup();
  processHandle = await slowRuntime.startSession(options, receive);
  await slowRuntime.sendMessage(processHandle, "auth-401-exit-during-backoff");

  await expect
    .poll(() => events.find((event) => event.kind === "session_complete"))
    .toMatchObject({
      kind: "session_complete",
      subtype: "error",
    });
  const usageIndex = events.findIndex((event) => event.kind === "usage");
  const sessionCompleteIndex = events.findIndex((event) => event.kind === "session_complete");
  expect(usageIndex).toBeGreaterThanOrEqual(0);
  expect(usageIndex).toBeLessThan(sessionCompleteIndex);
  expect(events[usageIndex]).toEqual({
    kind: "usage",
    semantics: "delta",
    inputTokens: 44,
    outputTokens: 8,
    cacheReadTokens: 12,
    cacheCreationTokens: undefined,
  });
});

it("normalizes flat agy models CLI output into families with reasoning efforts", async () => {
  const cliLines = [
    "gemini-4-neon-high\\tGemini 4 Neon (High)",
    "gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)",
    "gemini-4-neon-low\\tGemini 4 Neon (Low)",
    "gemini-pro-orchestrator-neon\\tOrchestrator (Neon)",
    "gpt-oss-120b-medium\\tGPT-OSS 120B (Medium)",
  ].join("\\n");
  vi.spyOn(subprocess, "spawn").mockImplementation((_argv, options) =>
    originalSpawn([process.execPath, "-e", `console.log("${cliLines}")`], options));

  expect(await runtime.queryModels()).toEqual([
    {
      value: "gemini-4-neon",
      displayName: "Gemini 4 Neon",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
        { reasoningEffort: "high", description: "High" },
        { reasoningEffort: "xhigh", description: "Extra" },
      ],
    },
    { value: "gemini-pro-orchestrator-neon", displayName: "Orchestrator (Neon)" },
    { value: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)" },
  ]);
});

it("maps legacy flat model IDs onto ACP family + thought_level options while preserving default reset", async () => {
  const { options, receive } = await setup();
  processHandle = await runtime.startSession({ ...options, model: "model-a-medium" }, receive);
  const readCatalog = () => runtime.queryModels({ process: processHandle });
  expect(await readCatalog()).toMatchObject([
    {
      value: "model-a",
      isDefault: true,
      isCurrent: true,
      currentReasoningEffort: "medium",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "medium" },
        { reasoningEffort: "high", description: "high" },
      ],
    },
    { value: "model-b", displayName: "model-b" },
  ]);
  expect((await readCatalog())[1]?.supportedReasoningEfforts).toBeUndefined();

  // Reapplying the persisted model at the next turn boundary keeps the reset.
  await runtime.setReasoningEffort(processHandle, undefined);
  await runtime.setModel(processHandle, "model-a-medium");
  expect((await readCatalog())[0]?.currentReasoningEffort).toBe("high");

  await runtime.setModel(processHandle, "model-b");
  expect((await readCatalog())[1]).toMatchObject({
    isCurrent: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "low" }],
  });
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

it("maps the Launcher family and effort to a supported flat model for a legacy ACP worker", async () => {
  const legacyFixture = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = f => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...f})+'\\n');
const available = [
  {modelId:'legacy-a-high', name:'Legacy A (High)'},
  {modelId:'legacy-a-low', name:'Legacy A (Low)'},
  {modelId:'legacy-b', name:'Legacy B'},
];
let current = 'legacy-b';
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{},authMethods:[]});
  if (f.method === 'session/new') return reply({sessionId:'legacy',configOptions:[{id:'mode',name:'mode',type:'select',currentValue:'accept-edits',options:[]}],models:{currentModelId:current,availableModels:available}});
  if (f.method === 'session/set_config_option') return send({id:f.id,error:{code:-32602,message:'unsupported config'}});
  if (f.method === 'session/set_model') {
    if (!available.some(m => m.modelId === f.params.modelId)) return send({id:f.id,error:{code:-32602,message:'unknown model'}});
    current = f.params.modelId;
    return reply({});
  }
  if (f.method === 'session/close') return reply({});
});
`;
  directory = await mkdtemp(join(tmpdir(), "MyAgents-legacy-models-"));
  const cliRows = "legacy-a-high\tLegacy A (High)\nlegacy-a-low\tLegacy A (Low)\nlegacy-b\tLegacy B";
  vi.spyOn(subprocess, "spawn").mockImplementation((argv, options) =>
    originalSpawn([
      process.execPath,
      "-e",
      argv[1] === "models" ? `console.log(${JSON.stringify(cliRows)})` : legacyFixture,
    ], options));
  const [family] = await runtime.queryModels();
  expect(family?.value).toBe("legacy-a");
  processHandle = await runtime.startSession(
    {
      workspacePath: directory,
      sessionId: "legacy-product",
      scenario: { type: "desktop" },
      model: family!.value,
      reasoningEffort: "low",
    },
    () => undefined,
  );
  const catalog = await runtime.queryModels({ process: processHandle });
  expect(catalog.map((model) => model.value)).toEqual(["legacy-a-high", "legacy-a-low", "legacy-b"]);
  expect(catalog.find((model) => model.isCurrent)?.value).toBe("legacy-a-low");
  await runtime.setModel(processHandle, "legacy-a-high");
  await runtime.setReasoningEffort(processHandle, "low");
  await runtime.setModel(processHandle, family!.value);
  expect((await runtime.queryModels({ process: processHandle })).find((model) => model.isCurrent)?.value)
    .toBe("legacy-a-low");
});

it("reports active background task watchdog state and observes native task log progress and settlement", async () => {
  const nativeSid = "87361ac8-8654-4053-91b5-163b1affdfaa";
  const bgFixture = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = f => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...f})+'\\n');
lines.on('line', line => {
  const f = JSON.parse(line);
  const reply = result => send({id:f.id, result});
  if (f.method === 'initialize') return reply({protocolVersion:1,agentCapabilities:{},authMethods:[]});
  if (f.method === 'session/new') return reply({
    sessionId:'${nativeSid}',
    configOptions:[{id:'mode',name:'mode',type:'select',currentValue:'accept-edits',options:[]}],
  });
  if (f.method === 'session/set_config_option') return reply({
    configOptions:[{id:'mode',name:'mode',type:'select',currentValue:f.params.value,options:[]}],
  });
  if (f.method === 'session/prompt') {
    const update = data => send({method:'session/update',params:{sessionId:'${nativeSid}',update:data}});
    update({
      sessionUpdate:'tool_call',
      toolCallId:'bg-cmd',
      title:'Run spark query',
      kind:'execute',
      status:'completed',
      rawInput:{CommandLine:'python3 run_sql.py'},
      content:[{type:'content',content:{type:'text',text:'Tool is running as a background task with task id: ${nativeSid}/task-104'}}],
    });
    // Keep session/prompt open while waiting for the background task, matching real agy ACP reactive wakeup.
    return;
  }
  if (f.method === 'session/close') return reply({});
});
`;
  directory = await mkdtemp(join(tmpdir(), "MyAgents-agy-bg-task-"));
  const fakeHome = join(directory, "home");
  const tasksDir = join(fakeHome, ".gemini", "antigravity-cli", "brain", nativeSid, ".system_generated", "tasks");
  const messagesDir = join(fakeHome, ".gemini", "antigravity-cli", "brain", nativeSid, ".system_generated", "messages");
  await mkdir(tasksDir, { recursive: true });
  await mkdir(messagesDir, { recursive: true });
  const logPath = join(tasksDir, "task-104.log");
  await writeFile(logPath, "[1s] status=RUNNING\n", "utf8");

  const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const prevHome = process.env[homeKey];
  process.env[homeKey] = fakeHome;
  try {
    vi.spyOn(subprocess, "spawn").mockImplementation((_argv, options) =>
      originalSpawn([process.execPath, "-e", bgFixture], options));
    processHandle = await runtime.startSession(
      { workspacePath: directory, sessionId: "product-bg", scenario: { type: "desktop" } },
      () => undefined,
    );
    await runtime.sendMessage(processHandle, "run long spark query");

    await expect.poll(() => processHandle?.getWatchdogState?.().activeAsyncWork).toBe(true);
    const initialProgress = processHandle.getWatchdogState?.().lastAsyncProgressAt ?? 0;
    expect(initialProgress).toBeGreaterThan(0);

    // Wait for baseline poll, then grow the native task log and verify watchdog progress advances.
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await appendFile(logPath, "[60s] status=RUNNING\n", "utf8");
    await expect
      .poll(() => processHandle?.getWatchdogState?.().lastAsyncProgressAt ?? 0, { timeout: 5_000 })
      .toBeGreaterThan(initialProgress);
    const progressBeforeFinish = processHandle.getWatchdogState?.().lastAsyncProgressAt ?? 0;

    // Native task completion message settles activeAsyncWork and bumps progress for parent wakeup.
    await writeFile(
      join(messagesDir, "done.json"),
      JSON.stringify({
        id: "done",
        sender: `${nativeSid}/task-104`,
        recipient: nativeSid,
        timestamp: new Date().toISOString(),
        content: `Task id "${nativeSid}/task-104" finished with result:\nCommand exited with code 0.`,
      }),
      "utf8",
    );
    await expect
      .poll(() => processHandle?.getWatchdogState?.().activeAsyncWork, { timeout: 5_000 })
      .toBe(false);
    expect(processHandle.getWatchdogState?.().lastAsyncProgressAt ?? 0).toBeGreaterThan(progressBeforeFinish);
  } finally {
    if (prevHome === undefined) delete process.env[homeKey];
    else process.env[homeKey] = prevHome;
  }
});

it("propagates session-scoped internal myagents CLI env and bin PATH precedence to agy", async () => {
  const { options, receive, spawn } = await setup();
  vi.stubEnv("MYAGENTS_INTERNAL_CLI_TOKEN", "internal-cli-test-token");
  setSidecarPort(41234);
  try {
    processHandle = await runtime.startSession(
      { ...options, sessionId: "product-session-cli-env" },
      receive,
    );
    const spawnEnv = spawn.mock.calls[0]?.[1]?.env as Record<string, string | undefined>;
    expect(spawnEnv).toBeDefined();
    expect(spawnEnv.MYAGENTS_PORT).toBe("41234");
    expect(spawnEnv.MYAGENTS_INTERNAL_CLI_TOKEN).toBe("internal-cli-test-token");
    expect(spawnEnv.MYAGENTS_SESSION_ID).toBe("product-session-cli-env");
    expect(spawnEnv.PWD).toBe(options.workspacePath);
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const home = (process.platform === "win32" ? spawnEnv.USERPROFILE : spawnEnv.HOME) || homedir();
    const firstPathEntry = (spawnEnv[pathKey] ?? "").split(delimiter)[0];
    expect(firstPathEntry).toBe(join(home, ".myagents", "bin"));
  } finally {
    setSidecarPort(0);
    vi.unstubAllEnvs();
  }
});

it("emits accurate MCP dispatch semantics instead of status_read_failed", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  const emptyMcp = events.find((event) => event.kind === "mcp_effective_update");
  expect(emptyMcp).toMatchObject({
    kind: "mcp_effective_update",
    dispatch: { state: "settled", releaseReason: "ready" },
    servers: [],
    tools: [],
  });
  await runtime.stopSession(processHandle);
  processHandle = undefined;

  events.length = 0;
  processHandle = await runtime.startSession(
    {
      ...options,
      mcpServers: [
        { id: "local-tool", name: "Local Tool", type: "stdio", command: process.execPath, args: ["-v"], isBuiltin: false },
      ],
    },
    receive,
  );
  const projectedMcp = events.find((event) => event.kind === "mcp_effective_update");
  expect(projectedMcp).toMatchObject({
    kind: "mcp_effective_update",
    dispatch: { state: "released", releaseReason: "status_unreported" },
    servers: [expect.objectContaining({ id: "local-tool", desired: true, state: "unreported" })],
  });
  await runtime.stopSession(processHandle);
  processHandle = undefined;

  events.length = 0;
  processHandle = await runtime.startSession(
    {
      ...options,
      mcpServers: [
        { id: "bad-remote", name: "Bad Remote", type: "http", url: "https://example.invalid/mcp", isBuiltin: false },
      ],
    },
    receive,
  );
  const failedMcp = events.find((event) => event.kind === "mcp_effective_update");
  expect(failedMcp).toMatchObject({
    kind: "mcp_effective_update",
    dispatch: { state: "released", releaseReason: "terminal_status" },
    servers: [expect.objectContaining({ id: "bad-remote", desired: true, state: "failed" })],
  });
});

it("steers an active prompt in-place via concurrent session/prompt, preserves in-flight tools, and accumulates delta usage", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  expect(runtime.canSteerMessage(processHandle)).toBe(false);
  await expect(
    runtime.steerMessage(processHandle, "too early", undefined, { clientUserMessageId: "u-idle" }),
  ).rejects.toSatisfy(isRuntimeSteerUnavailableError);

  await runtime.sendMessage(processHandle, "steer-root");
  await expect.poll(() => events.some((event) => event.kind === "text_delta")).toBe(true);
  expect(runtime.canSteerMessage(processHandle)).toBe(true);

  await runtime.steerMessage(processHandle, "steer-one", undefined, {
    clientUserMessageId: "u-steer-1",
  });
  expect(events.some((event) => event.kind === "turn_complete")).toBe(false);
  // Pre-steer tool completion settles in the original assistant segment before
  // `steer-one` is confirmed.
  await expect.poll(() => events.some((event) => event.kind === "tool_result" && event.toolUseId === "steer-cmd")).toBe(true);
  expect(events.filter((event) => event.kind === "tool_use_start" && event.toolUseId === "steer-cmd")).toHaveLength(1);
  expect(events.some((event) => event.kind === "user_message_accepted")).toBe(false);
  expect(runtime.canSteerMessage(processHandle)).toBe(true);

  await runtime.steerMessage(processHandle, "steer-two", undefined, {
    clientUserMessageId: "u-steer-2",
  });
  await expect.poll(() => events.filter((event) => event.kind === "turn_complete").length).toBe(1);
  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({ status: "completed" });
  const stopIdx = events.findIndex((event) => event.kind === "text_stop");
  const accepted1Idx = events.findIndex(
    (event) => event.kind === "user_message_accepted" && event.clientUserMessageId === "u-steer-1",
  );
  const accepted2Idx = events.findIndex(
    (event) => event.kind === "user_message_accepted" && event.clientUserMessageId === "u-steer-2",
  );
  const finalTextIdx = events.findIndex(
    (event) => event.kind === "text_delta" && event.text === "Final steered answer.",
  );
  expect(stopIdx).toBeGreaterThanOrEqual(0);
  expect(accepted1Idx).toBeGreaterThan(stopIdx);
  expect(accepted2Idx).toBeGreaterThan(accepted1Idx);
  expect(finalTextIdx).toBeGreaterThan(accepted2Idx);
  expect(events.filter((event) => event.kind === "user_message_accepted")).toEqual([
    { kind: "user_message_accepted", clientUserMessageId: "u-steer-1" },
    { kind: "user_message_accepted", clientUserMessageId: "u-steer-2" },
  ]);
  const usages = events.filter((event) => event.kind === "usage");
  expect(usages.at(-1)).toEqual({
    kind: "usage",
    inputTokens: 140,
    outputTokens: 37,
    cacheReadTokens: 30,
    cacheCreationTokens: undefined,
    semantics: "delta",
  });
  expect(runtime.canSteerMessage(processHandle)).toBe(false);
});

it("falls back to RuntimeSteerUnavailableError when a permission is pending or races on the wire", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "permissions");
  await expect.poll(() => events.filter((event) => event.kind === "permission_request").length).toBe(2);
  expect(runtime.canSteerMessage(processHandle)).toBe(false);
  await expect(
    runtime.steerMessage(processHandle, "blocked by local pending", undefined, { clientUserMessageId: "u-perm-local" }),
  ).rejects.toSatisfy(isRuntimeSteerUnavailableError);
  await runtime.interruptTurn(processHandle);
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("cancelled");

  const startIdx = events.length;
  await runtime.sendMessage(processHandle, "steer-root-finishable");
  await expect.poll(() => events.slice(startIdx).some((event) => event.kind === "text_delta")).toBe(true);
  await expect(
    runtime.steerMessage(processHandle, "steer-permission-race", undefined, { clientUserMessageId: "u-perm-race" }),
  ).rejects.toSatisfy(isRuntimeSteerUnavailableError);
  expect(events.slice(startIdx).some((event) => event.kind === "user_message_accepted")).toBe(false);
  await expect.poll(() => events.slice(startIdx).find((event) => event.kind === "turn_complete")?.status).toBe("completed");
});

it("preserves the active turn on non-retryable steer errors and cancels a steered turn cleanly", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "steer-root");
  await expect.poll(() => events.some((event) => event.kind === "text_delta")).toBe(true);

  const invalidError = await runtime
    .steerMessage(processHandle, "steer-invalid", undefined, { clientUserMessageId: "u-invalid" })
    .then(() => null, (error: unknown) => error);
  expect(invalidError).toBeInstanceOf(Error);
  expect(isRuntimeSteerUnavailableError(invalidError)).toBe(false);
  expect(events.some((event) => event.kind === "turn_complete")).toBe(false);
  expect(runtime.canSteerMessage(processHandle)).toBe(true);

  await runtime.steerMessage(processHandle, "steer-cancel-target", undefined, {
    clientUserMessageId: "u-cancel",
  });
  await runtime.interruptTurn(processHandle);
  expect(runtime.canSteerMessage(processHandle)).toBe(false);
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("cancelled");
  expect(events).toContainEqual({ kind: "user_message_cancelled", clientUserMessageId: "u-cancel" });
  expect(events.some((event) => event.kind === "user_message_accepted")).toBe(false);
  expect(events.filter((event) => event.kind === "turn_complete")).toHaveLength(1);
});

it("preserves the successor terminal when out-of-order responses settle the steered prompt first", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "steer-root");
  await expect.poll(() => events.some((event) => event.kind === "text_delta")).toBe(true);

  await runtime.steerMessage(processHandle, "steer-next-first", undefined, {
    clientUserMessageId: "u-next-first",
  });
  await expect.poll(() => events.some((event) => event.kind === "turn_complete")).toBe(true);
  expect(events.find((event) => event.kind === "turn_complete")).toMatchObject({
    status: "failed",
    error: "Antigravity 已达到此轮输出长度上限",
  });
  const acceptedIdx = events.findIndex(
    (event) => event.kind === "user_message_accepted" && event.clientUserMessageId === "u-next-first",
  );
  const earlyTextIdx = events.findIndex(
    (event) => event.kind === "text_delta" && event.text === "Early successor reply.",
  );
  const completeIdx = events.findIndex((event) => event.kind === "turn_complete");
  expect(acceptedIdx).toBeGreaterThanOrEqual(0);
  expect(earlyTextIdx).toBeGreaterThan(acceptedIdx);
  expect(completeIdx).toBeGreaterThan(earlyTextIdx);
});

it("does not confirm consumption from predecessor tail text or delayed usage_update before a late steer rejection", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "steer-root");
  await expect.poll(() => events.some((event) => event.kind === "text_delta")).toBe(true);

  await runtime.steerMessage(processHandle, "steer-old-before-rejection", undefined, {
    clientUserMessageId: "u-late-reject",
  });
  await expect.poll(() => events.some((event) => event.kind === "turn_complete")).toBe(true);
  expect(events).toContainEqual({ kind: "text_delta", text: "Tail from predecessor." });
  expect(events.some((event) => event.kind === "context_update")).toBe(true);
  expect(events.some((event) => event.kind === "user_message_accepted")).toBe(false);
  const cancelledIdx = events.findIndex(
    (event) => event.kind === "user_message_cancelled" && event.clientUserMessageId === "u-late-reject",
  );
  const completeIdx = events.findIndex((event) => event.kind === "turn_complete");
  expect(cancelledIdx).toBeGreaterThanOrEqual(0);
  expect(completeIdx).toBeGreaterThan(cancelledIdx);
});

it("confirms a steered prompt when an unanswered permission stays open across handoff", async () => {
  const { options, receive, events } = await setup();
  processHandle = await runtime.startSession(options, receive);
  await runtime.sendMessage(processHandle, "steer-root");
  await expect.poll(() => events.some((event) => event.kind === "text_delta")).toBe(true);

  await runtime.steerMessage(processHandle, "steer-early-permission", undefined, {
    clientUserMessageId: "u-early-perm",
  });
  await expect.poll(() => events.some((event) => event.kind === "permission_request")).toBe(true);
  expect(events).toContainEqual({
    kind: "user_message_accepted",
    clientUserMessageId: "u-early-perm",
  });

  await runtime.interruptTurn(processHandle);
  await expect.poll(() => events.find((event) => event.kind === "turn_complete")?.status).toBe("cancelled");
  expect(events.some((event) => event.kind === "user_message_cancelled")).toBe(false);
});
