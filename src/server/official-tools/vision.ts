import { randomUUID } from 'crypto';
import { basename, extname, isAbsolute, relative, resolve, win32 } from 'path';
import { lstatSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  ALLOWED_IMAGE_MIME_TYPES,
  USER_IMAGE_ATTACHMENT_MAX_BYTES,
} from '../../shared/fileTypes';
import { IMAGE_UNDERSTANDING_TOOL_ID } from '../../shared/official-tools';
import {
  buildClaudeSessionEnv,
  resolveClaudeCodeCli,
  startOneShotBridge,
} from '../agent-session';
import type { ProviderEnv } from '../provider-types';
import {
  findEffectiveProvider,
  getEffectiveOfficialToolIdsForSession,
  loadConfig,
  resolveImageUnderstandingToolAvailability,
  resolveProviderEnv,
  type AdminAppConfig,
} from '../utils/admin-config';
import { processImage } from '../utils/imageResize';
import { applyContextWindowSuffixForContextLength } from '../utils/model-capabilities';
import { createGuardedSdkQuery } from '../utils/sdk-child-launch-guard';
import { sdkSubprocessUserMessage } from '../utils/sdk-subprocess-diagnostics';
import type { ResolvedImagePayload } from '../runtimes/types';
import type { SessionMetadata } from '../types/session';

const DEFAULT_VISION_PROMPT = [
  'Analyze the provided image(s) for another AI agent that may not be able to see images.',
  'Return a faithful, task-useful description. Include visible text/OCR, UI layout, key objects, charts/tables, relationships, notable colors/states, and any ambiguities.',
  'If multiple images are provided, describe each image separately and then summarize cross-image relationships when relevant.',
].join(' ');

const SYSTEM_PROMPT = [
  'You are MyAgents Vision Helper.',
  'Your job is to inspect the provided images and produce precise textual observations for another AI agent.',
  'Do not invent details. If something is unclear, say so.',
].join('\n');

const MAX_IMAGES = 6;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_PROMPT_FILE_BYTES = 256 * 1024;
const TIMEOUT_MS = 120_000;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface VisionAnalyzeInput {
  workspacePath?: string | null;
  sessionMeta?: SessionMetadata | null;
  images: string[];
  prompt?: string;
  promptFile?: string;
}

export interface VisionAnalyzeResult {
  toolId: typeof IMAGE_UNDERSTANDING_TOOL_ID;
  providerId: string;
  model: string;
  prompt: string;
  images: Array<{
    input: string;
    resolvedPath: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  text: string;
}

class VisionToolError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly recoveryHint?: { recoveryCommand?: string; message?: string },
  ) {
    super(message);
    this.name = 'VisionToolError';
  }
}

export function getVisionToolReadme(): string {
  return `myagents vision — official image-understanding helper

Usage:
  myagents vision analyze --image <path> [--image <path> ...] [--prompt "..."] [--json]
  myagents vision analyze --image <path> --prompt-file <workspace-relative-text-file>
  myagents vision analyze --image @myagents_files/screenshot.png --prompt "Read the error message"
  myagents vision readme

The tool only accepts local image paths inside the current MyAgents workspace.
Use @myagents_files/... paths when the conversation shows attached images as
workspace references. URLs are not supported.

For long or quoted inspection instructions, write a text file inside the current
workspace and pass it with --prompt-file. Prompt files are resolved with the same
workspace safety boundary as image paths; arbitrary absolute paths are rejected.`;
}

export async function analyzeImages(input: VisionAnalyzeInput): Promise<VisionAnalyzeResult> {
  const config = loadConfig();
  const workspacePath = input.workspacePath?.trim();
  if (!workspacePath) {
    throw new VisionToolError('No current workspace is available for image path resolution.', 400, {
      message: 'Run this command from an active MyAgents session with a workspace.',
    });
  }
  const enabledIds = getEffectiveOfficialToolIdsForSession(
    workspacePath,
    input.sessionMeta,
    undefined,
    config,
  );
  if (!enabledIds.includes(IMAGE_UNDERSTANDING_TOOL_ID)) {
    throw new VisionToolError('Image understanding is not enabled for this session.', 403, {
      message: 'Open the chat tool menu and enable Image Understanding for this session.',
    });
  }

  const availability = resolveImageUnderstandingToolAvailability(config);
  if (!availability.ok) {
    throw new VisionToolError(availability.message, availability.status, {
      message: availability.recoveryMessage,
    });
  }

  const workspaceReal = realpathSync(workspacePath);
  const images = resolveVisionImages(input.images, workspaceReal);
  const prompt = resolveVisionPrompt({
    prompt: input.prompt,
    promptFile: input.promptFile,
    workspaceReal,
  });
  const providerEnv = materializeVisionProviderEnv(availability.providerId, availability.model, config);
  const deadlineMs = Date.now() + TIMEOUT_MS;

  const text = await runVisionQuery({
    workspacePath,
    providerId: availability.providerId,
    providerEnv,
    model: availability.model,
    images: images.map(img => img.payload),
    prompt,
    deadlineMs,
  });

  return {
    toolId: IMAGE_UNDERSTANDING_TOOL_ID,
    providerId: availability.providerId,
    model: availability.model,
    prompt,
    images: images.map(({ payload, input: imageInput, resolvedPath }) => ({
      input: imageInput,
      resolvedPath,
      name: payload.name,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes ?? 0,
    })),
    text,
  };
}

function materializeVisionProviderEnv(
  providerId: string,
  model: string,
  config: AdminAppConfig,
): ProviderEnv | undefined {
  const env = resolveProviderEnv(providerId, config, model);
  const provider = findEffectiveProvider(providerId, config);
  if (provider?.type === 'subscription') {
    return {};
  }
  if (provider?.type === 'api' && !env) {
    throw new VisionToolError(`Provider '${providerId}' needs a valid API key before it can drive image understanding.`, 409, {
      message: 'Open Settings -> Model Providers and configure or verify the provider API key.',
    });
  }
  return env as ProviderEnv | undefined;
}

export function buildVisionPrompt(prompt: string | undefined): string {
  const trimmed = prompt?.trim();
  if (!trimmed) return DEFAULT_VISION_PROMPT;
  return [
    DEFAULT_VISION_PROMPT,
    '',
    'Specific inspection request from the calling agent:',
    trimmed,
  ].join('\n');
}

function resolveVisionPrompt(args: {
  prompt?: string;
  promptFile?: string;
  workspaceReal: string;
}): string {
  if (args.prompt?.trim() && args.promptFile?.trim()) {
    throw new VisionToolError('--prompt and --prompt-file are mutually exclusive.', 400);
  }
  if (!args.promptFile?.trim()) {
    return buildVisionPrompt(args.prompt);
  }
  const promptFile = resolveWorkspaceFilePath({
    rawInput: args.promptFile,
    workspaceReal: args.workspaceReal,
    kind: 'Prompt file',
  });
  const stat = statSync(promptFile.realPath);
  if (stat.size > MAX_PROMPT_FILE_BYTES) {
    throw new VisionToolError(`Prompt file '${promptFile.input}' exceeds 256KB.`, 400);
  }
  const text = readFileSync(promptFile.realPath, 'utf-8');
  if (text.includes('\0')) {
    throw new VisionToolError(`Prompt file '${promptFile.input}' contains NUL bytes and looks binary.`, 400);
  }
  return buildVisionPrompt(text);
}

function remainingMs(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new VisionToolError('Image understanding timed out.', 504);
  }
  return remaining;
}

function resolveVisionImages(
  rawImages: string[],
  workspaceReal: string,
): Array<{ input: string; resolvedPath: string; payload: ResolvedImagePayload }> {
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    throw new VisionToolError('At least one --image path is required.', 400);
  }
  if (rawImages.length > MAX_IMAGES) {
    throw new VisionToolError(`At most ${MAX_IMAGES} images can be analyzed at once.`, 400);
  }
  const images = rawImages.map(raw => resolveOneVisionImage(raw, workspaceReal));
  const totalBytes = images.reduce((sum, image) => sum + (image.payload.sizeBytes ?? 0), 0);
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new VisionToolError('Total image payload exceeds 50MB.', 400);
  }
  return images;
}

function resolveOneVisionImage(
  rawInput: string,
  workspaceReal: string,
): { input: string; resolvedPath: string; payload: ResolvedImagePayload } {
  const resolved = resolveWorkspaceFilePath({
    rawInput,
    workspaceReal,
    kind: 'Image path',
  });
  const stat = statSync(resolved.realPath);
  if (stat.size > USER_IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new VisionToolError(`Image '${resolved.input}' exceeds 10MB.`, 400);
  }

  const data = readFileSync(resolved.realPath);
  const mimeType = mimeFromPath(resolved.realPath);
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new VisionToolError(`Unsupported image type for '${resolved.input}'.`, 400);
  }
  const magicMimeType = detectImageMimeFromMagic(data);
  if (!magicMimeType || magicMimeType !== mimeType) {
    throw new VisionToolError(`Image '${resolved.input}' does not match its declared image type.`, 400);
  }

  return {
    input: resolved.input,
    resolvedPath: resolved.realPath,
    payload: {
      name: basename(resolved.realPath),
      mimeType,
      data: data.toString('base64'),
      sizeBytes: stat.size,
    },
  };
}

function resolveWorkspaceFilePath(args: {
  rawInput: string;
  workspaceReal: string;
  kind: string;
}): { input: string; realPath: string } {
  const input = args.rawInput.trim();
  if (!input) throw new VisionToolError(`${args.kind} cannot be empty.`, 400);
  if (isVisionUrlLikeInput(input)) {
    throw new VisionToolError(`${args.kind} URLs are not supported. Use a local workspace path.`, 400);
  }

  const withoutAt = input.startsWith('@') ? input.slice(1) : input;
  const candidate = isAbsolute(withoutAt) || win32.isAbsolute(withoutAt)
    ? withoutAt
    : resolve(args.workspaceReal, withoutAt);

  let lst;
  try {
    lst = lstatSync(candidate);
  } catch {
    throw new VisionToolError(`${args.kind} not found: ${input}`, 404);
  }
  if (lst.isSymbolicLink()) {
    throw new VisionToolError(`${args.kind} must not be a symlink: ${input}`, 400);
  }
  if (!lst.isFile()) {
    throw new VisionToolError(`${args.kind} is not a file: ${input}`, 400);
  }

  const realPath = realpathSync(candidate);
  const rel = relative(args.workspaceReal, realPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new VisionToolError(`${args.kind} must stay inside the current workspace.`, 400);
  }
  return { input, realPath };
}

export function isVisionUrlLikeInput(input: string): boolean {
  const trimmed = input.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return false;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
}

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function detectImageMimeFromMagic(data: Buffer): string | null {
  if (
    data.length >= 8
    && data[0] === 0x89
    && data[1] === 0x50
    && data[2] === 0x4e
    && data[3] === 0x47
    && data[4] === 0x0d
    && data[5] === 0x0a
    && data[6] === 0x1a
    && data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  const asciiHead = data.subarray(0, 12).toString('ascii');
  if (asciiHead.startsWith('GIF87a') || asciiHead.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (data.length >= 12 && asciiHead.startsWith('RIFF') && asciiHead.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function runVisionQuery(args: {
  workspacePath: string;
  providerId: string;
  providerEnv?: ProviderEnv;
  model: string;
  images: ResolvedImagePayload[];
  prompt: string;
  deadlineMs: number;
}): Promise<string> {
  const bridge = args.providerEnv?.apiProtocol === 'openai'
    ? startOneShotBridge(args.providerEnv, args.model, `official-vision:${args.providerEnv.baseUrl ?? args.providerId}`)
    : null;
  try {
    return await runVisionQueryInner({ ...args, bridgeToken: bridge?.token });
  } finally {
    bridge?.release();
  }
}

async function runVisionQueryInner(args: {
  workspacePath: string;
  providerId: string;
  providerEnv?: ProviderEnv;
  model: string;
  images: ResolvedImagePayload[];
  prompt: string;
  deadlineMs: number;
  bridgeToken?: string;
}): Promise<string> {
  const sessionId = randomUUID();
  const abortController = new AbortController();
  const env = buildClaudeSessionEnv(args.providerEnv, args.model, {
    bridgeToken: args.bridgeToken,
    providerId: args.providerId,
  });
  const launchModel = applyContextWindowSuffixForContextLength(
    args.model,
    Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
  );
  const cliPath = resolveClaudeCodeCli();
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }
  > = [];

  for (const img of args.images) {
    const tiles = await processImage(img, undefined, remainingMs(args.deadlineMs));
    if (tiles.length > 1) {
      contentBlocks.push({
        type: 'text',
        text: `[The following ${tiles.length} images are consecutive tiles of "${img.name}", in reading order.]`,
      });
    }
    for (const tile of tiles) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: tile.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: tile.data,
        },
      });
    }
  }
  contentBlocks.push({ type: 'text', text: args.prompt });

  async function* visionPrompt() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: contentBlocks },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  const visionQuery = await createGuardedSdkQuery(cliPath, () => query({
    prompt: visionPrompt(),
    options: {
      maxTurns: 1,
      sessionId,
      cwd: args.workspacePath || resolve(homedir(), '.myagents', 'projects'),
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: cliPath,
      env,
      systemPrompt: SYSTEM_PROMPT,
      includePartialMessages: false,
      persistSession: false,
      mcpServers: {},
      tools: [],
      model: launchModel,
      abortController,
    },
  }));

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new VisionToolError('Image understanding timed out.', 504));
    }, remainingMs(args.deadlineMs));
  });

  try {
    return await Promise.race([extractVisionText(visionQuery), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!abortController.signal.aborted) abortController.abort();
    try { visionQuery.close(); } catch { /* ignore */ }
  }
}

async function extractVisionText(visionQuery: AsyncIterable<unknown>): Promise<string> {
  let lastText = '';
  for await (const message of visionQuery) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.type === 'assistant') {
      const text = textFromContent((record.message as { content?: unknown } | undefined)?.content);
      if (text) lastText = text;
    } else if (record.type === 'result') {
      const messages = (record as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
      const assistant = messages?.filter(m => m.role === 'assistant').pop();
      const text = textFromContent(assistant?.content);
      if (text) lastText = text;
    }
  }
  if (!lastText.trim()) throw new VisionToolError('Vision model returned no text.', 502);
  return lastText.trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export function visionErrorResponse(error: unknown): {
  status: number;
  error: string;
  recoveryHint?: { recoveryCommand?: string; message?: string };
} {
  if (error instanceof VisionToolError) {
    return { status: error.status, error: error.message, recoveryHint: error.recoveryHint };
  }
  const sdkLaunchMessage = sdkSubprocessUserMessage(error);
  if (sdkLaunchMessage) return { status: 503, error: sdkLaunchMessage };
  return { status: 500, error: error instanceof Error ? error.message : String(error) };
}
