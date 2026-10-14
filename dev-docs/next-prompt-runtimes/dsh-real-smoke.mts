/** Explicit acceptance only. Reads the authorized existing Provider in memory, never logs credentials.
 * Uses a disposable native DSH home and synthetic transcript; no production Session or App mutation. */
import { readFile, mkdtemp, mkdir, rm, readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDshRuntimeInstallation } from '../../src/server/integrated-runtimes/dsh/installation';
import { createDshInitializeParams } from '../../src/server/integrated-runtimes/dsh/initialize';
import { DshRuntimeProcessHost } from '../../src/server/integrated-runtimes/dsh/process-host';
import { buildDshChildEnvironment } from '../../src/server/integrated-runtimes/dsh/child-environment';
import { compileDshModelExecutionProfile } from '../../src/server/integrated-runtimes/dsh/profile-compiler';
import { compileDshProductExtensionPlane } from '../../src/server/integrated-runtimes/dsh/extension-compiler';
import { findEffectiveProvider, resolveProviderEnv } from '../../src/server/utils/admin-config';
import type { AdminAppConfig } from '../../src/server/utils/admin-config';
import type { Provider } from '../../src/shared/config-types';
import { DSH_REVERSE_METHOD_NAMES, type DshExecutionEnvironment, type DshHostRequestHandlers } from '../../src/server/integrated-runtimes/dsh/protocol-types';
import { runDshTextUtility } from '../../src/server/integrated-runtimes/dsh/text-utility';
import { cleanNextPromptSuggestion } from '../../src/shared/nextPromptSuggestion';
import { NEXT_PROMPT_SYSTEM_PROMPT } from '../../src/server/session-prompt-suggestion';
const started = Date.now();
const config = JSON.parse(await readFile(process.env.NEXT_PROMPT_CONFIG_PATH ?? join(homedir(), '.moxbot/config.json'), 'utf8')) as AdminAppConfig;
const providerId = process.env.NEXT_PROMPT_PROVIDER_ID ?? config.defaultProviderId;
if (!providerId) throw new Error('No authorized Provider selected');
const provider = findEffectiveProvider(providerId, config) as Provider | null;
if (!provider) throw new Error('Selected Provider is unavailable');
const model = process.env.NEXT_PROMPT_MODEL ?? provider.models[0]?.model;
const credential = resolveProviderEnv(providerId, config, model);
if (!credential?.apiKey || !model) throw new Error('Selected Provider has no usable existing credential');
const profile = compileDshModelExecutionProfile({ provider, modelId: model, reasoningEffort: 'low' });
const root = await realpath(await mkdtemp(join(tmpdir(), 'moxbots-dsh-real-utility-')));
const workspace = join(root, 'workspace'), runtimeHome = join(root, 'runtime-home'), attachments = join(root, 'attachments');
await Promise.all([workspace, runtimeHome, attachments].map(p => mkdir(p)));
const resourceRoot = process.env.NEXT_PROMPT_RESOURCE_ROOT ?? '/Applications/MoXBots.app/Contents/Resources';
const installation = await resolveDshRuntimeInstallation({ resourceRoot, nodeExecutablePath: join(resourceRoot, 'nodejs/bin/node') });
const childEnvironment = buildDshChildEnvironment({ nodeExecutablePath: installation.nodeExecutablePath, commandDirectories: ['/bin', '/usr/bin'], inheritedEnvironment: { HOME: root, USERPROFILE: root, LANG: 'en_US.UTF-8' }, sessionCli: null });
const environment: Omit<DshExecutionEnvironment, 'digest'> = {
  revision: 'next-prompt-real-utility-v1', workspace: { identity: 'synthetic-utility-workspace', canonicalRoot: workspace },
  executables: { bundledNodeRef: 'bundled-node', shellRef: 'runtime-shell', ripgrepRef: 'bundled-ripgrep', shellDialect: 'bash', allowedCommandRefs: ['runtime-shell', 'bundled-node', 'bundled-ripgrep'], pathPolicy: 'sealed' },
  environment: { allowedKeys: childEnvironment.allowedKeys, inheritedKeys: [], secretValues: 'reverse-port-only' },
  network: { mode: 'host-policy', policyRef: 'deepseek-official-web-search-v1' },
  process: { backgroundRetention: 'deny', maxChildren: 2, killTreeOnAbort: true },
  checkpoint: { mode: 'managed-file-tools', version: 1, policyRevision: 'next-prompt-utility-checkpoint', trackedTools: ['Write', 'Edit'], tracksShell: false, tracksChildAgents: false, tracksExternalChanges: false },
  attachmentStagingRoot: attachments,
};
const reverseMethods: string[] = [];
const handlers = Object.fromEntries(DSH_REVERSE_METHOD_NAMES.map(method => [method, async (params: Record<string, unknown>) => {
  reverseMethods.push(method);
  if (method !== 'host/credential/resolve' || params.subject !== 'provider' || params.credentialRef !== profile.credentialRef || params.profileRevision !== profile.revision || params.providerRouteId !== profile.providerRouteId) throw new Error('Utility test refuses unrelated reverse work');
  return params.purpose === 'availability' ? { kind: 'availability', available: true, authoritativeCredentialRevision: profile.revision }
    : { kind: 'material', authoritativeCredentialRevision: profile.revision, material: { apiKey: credential.apiKey } };
}])) as DshHostRequestHandlers;
const host = new DshRuntimeProcessHost({ installation, initialize: createDshInitializeParams({ productSessionId: 'synthetic-next-prompt-acceptance', productVersion: '0.5.5', runtimeHome, workspace: { path: workspace, identity: environment.workspace.identity }, executionEnvironment: environment, interaction: 'deterministic-headless' }), hostHandlers: handlers,
 notificationHandlers: { 'runtime/event': async () => {}, 'host/interaction/cancel': async () => {} }, childEnvironment, handshakeTimeoutMs: 15_000, shutdownGraceMs: 2_000 });
const inventory = async (directory: string): Promise<Record<string,string>> => {
 const result:Record<string,string>={};
 async function visit(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await visit(p);else if(e.isFile())result[p.slice(directory.length)]=createHash('sha256').update(await readFile(p)).digest('hex');}}
 await visit(directory);return result;
};
try {
 await host.start();
 const plane = compileDshProductExtensionPlane({ revision:'utility-empty-plane', workspacePath:workspace, skills:[], commands:[], agents:[], dynamicTools:[], mcpServers:[] });
 await host.request('extension/replace', plane.snapshot);
 const catalog=await host.request('extension/catalog',{});
 const binding=await host.request('session/create',{clientOperationId:'synthetic-utility-bind',persistenceRef:'synthetic-utility-native',provider:profile,configRevision:'synthetic-utility-config',extensionDigest:catalog.digest,systemPrompt:'',permissionMode:'approval-required',interactionScenario:'host-interaction-v1'});
 if(binding.state!=='ready')throw new Error('Synthetic utility native session not ready');
 const before = await inventory(runtimeHome);
 const text=await runDshTextUtility({host, exited:false, configuration:{profile}}, { timeoutMs:60_000, systemPrompt:NEXT_PROMPT_SYSTEM_PROMPT, prompt:JSON.stringify([{role:'user',text:'帮我设计CSV导入的错误报告流程。'},{role:'assistant',text:'建议报告包含行号、字段和错误原因；实现完成后应验证空文件、重复列名和无效日期。'}]) });
 const after = await inventory(runtimeHome);
 const cleaned=text ? cleanNextPromptSuggestion(text):null;
 console.log(JSON.stringify({runtime:'dsh',source:'integrated native utility/run',providerName:provider.name,model,success:!!cleaned,text:cleaned,elapsedMs:Date.now()-started,nativeSessionFilesUnchanged:JSON.stringify(before)===JSON.stringify(after),reverseMethods,workspaceFiles:await readdir(workspace)}));
 if(!cleaned||JSON.stringify(before)!==JSON.stringify(after)||reverseMethods.some(m=>m!=='host/credential/resolve'))process.exitCode=1;
} finally { await host.stop(); await rm(root,{recursive:true,force:true}); }
