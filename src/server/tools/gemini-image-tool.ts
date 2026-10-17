import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
// Gemini Image Generation MCP Tool — AI image generation & multi-turn editing
// Uses Shadow Session to maintain Gemini multi-turn context (contents[] + thought_signature)
// In-process MCP server (same pattern as cron-tools / im-media)

// SDK + zod are loaded lazily inside createGeminiImageServer() via dynamic
// import. configure/validate are plain exports that builtin-mcp-meta.ts
// pulls in on-demand via a proxy load(), so they never force SDK eval
// either. See builtin-mcp-meta.ts for registration.
import { existsSync , writeFileSync, readFileSync, statSync } from 'fs';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ensureGitignorePattern } from '../utils/gitignore';
import { randomUUID } from 'crypto';
import { ensureDirSync } from '../utils/fs-utils';
import { cancellableFetch } from '../utils/cancellation';
import { getCurrentTurnSignal } from '../utils/turn-abort';

// MCP Tool Result type (matches @modelcontextprotocol/sdk/types.js CallToolResult)
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ============= Configuration =============

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MAX_CONTEXT_TURNS = 20;
const API_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000]; // Exponential backoff

interface GeminiImageConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  defaultAspectRatio: string;
  defaultImageSize: string;
  thinkingLevel: string;
  searchGrounding: boolean;
  maxContextTurns: number;
  sessionId: string;
  workspace?: string;
}

let geminiImageConfig: GeminiImageConfig | null = null;

export function setGeminiImageConfig(cfg: GeminiImageConfig): void {
  geminiImageConfig = cfg;
  console.log(`[gemini-image] Config set: model=${cfg.model}, session=${cfg.sessionId}`);
  // Load persisted contexts for this session
  loadContexts(cfg.sessionId);
}

export function getGeminiImageConfig(): GeminiImageConfig | null {
  return geminiImageConfig;
}

export function clearGeminiImageConfig(): void {
  geminiImageConfig = null;
  imageContexts.clear();
  console.log('[gemini-image] Config and contexts cleared');
}

// ============= Directories =============

function getGeneratedDir(): string {
  const workspace = geminiImageConfig?.workspace;
  const dir = workspace
    ? join(workspace, 'myagents_files', 'generated_images')
    : join(homedir(), APP_DATA_DIR_NAME, 'generated');
  if (!existsSync(dir)) {
    ensureDirSync(dir);
    if (workspace) ensureGitignorePattern(workspace, 'myagents_files/');
  }
  return dir;
}

function getContextsDir(): string {
  const dir = join(homedir(), APP_DATA_DIR_NAME, 'image-contexts');
  ensureDirSync(dir);
  return dir;
}

// ============= Gemini API Types =============

interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string; // base64
  };
  thought_signature?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content: {
      role: string;
      parts: GeminiPart[];
    };
    finishReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

// ============= Shadow Session (ImageContext) =============

interface GeminiPartPersisted {
  text?: string;
  imageRef?: string;       // Disk path (replaces base64)
  mime_type?: string;
  thought_signature?: string;
}

interface GeminiTurnPersisted {
  role: 'user' | 'model';
  parts: GeminiPartPersisted[];
}

interface ImageContext {
  id: string;                       // imgctx_xxxxx
  sessionId: string;
  turns: GeminiTurnPersisted[];
  generatedImages: string[];        // All generated image paths
  config: {
    model: string;
    aspectRatio: string;
    imageSize: string;
  };
  createdAt: number;
  updatedAt: number;
}

const imageContexts = new Map<string, ImageContext>();

function generateContextId(): string {
  return `imgctx_${randomUUID().split('-')[0]}`;
}

function createContext(config: GeminiImageConfig, aspectRatio?: string, imageSize?: string): ImageContext {
  const ctx: ImageContext = {
    id: generateContextId(),
    sessionId: config.sessionId,
    turns: [],
    generatedImages: [],
    config: {
      model: config.model,
      aspectRatio: aspectRatio || config.defaultAspectRatio,
      imageSize: imageSize || config.defaultImageSize,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  imageContexts.set(ctx.id, ctx);
  return ctx;
}

function addUserTurn(ctx: ImageContext, text: string): void {
  ctx.turns.push({
    role: 'user',
    parts: [{ text }],
  });
  ctx.updatedAt = Date.now();
}

function addModelTurn(ctx: ImageContext, parts: GeminiPartPersisted[]): void {
  ctx.turns.push({
    role: 'model',
    parts,
  });
  ctx.updatedAt = Date.now();
}

/**
 * Pattern 3 §D.5 — total byte cap on image history sent to the API.
 * Beyond this we drop the oldest images first (keeping their text turns)
 * so a long edit history doesn't grow the request indefinitely.
 */
const GEMINI_IMAGE_HISTORY_BYTE_CAP = 20 * 1024 * 1024; // 20 MiB

/**
 * Build full Gemini contents[] for API call.
 *
 * Pattern 3 §D.5 — async + bounded.
 *  - Reads image bytes via `fs.promises.readFile` so we don't block the
 *    event loop on disk I/O for multi-MB context turns.
 *  - Walks turns from newest → oldest, summing on-disk byte sizes; once
 *    `GEMINI_IMAGE_HISTORY_BYTE_CAP` is reached, drops image parts from
 *    older turns (text parts kept). Newest images are always preserved.
 */
async function buildContentsForApi(ctx: ImageContext): Promise<GeminiContent[]> {
  // First pass (newest → oldest): decide which image parts survive the cap.
  const includeImage: boolean[][] = ctx.turns.map((t) => t.parts.map(() => false));
  let bytesUsed = 0;
  for (let ti = ctx.turns.length - 1; ti >= 0; ti--) {
    const turn = ctx.turns[ti];
    for (let pi = 0; pi < turn.parts.length; pi++) {
      const part = turn.parts[pi];
      if (!part.imageRef) continue;
      if (!existsSync(part.imageRef)) continue;
      let size = 0;
      try { size = statSync(part.imageRef).size; } catch { continue; }
      if (bytesUsed + size > GEMINI_IMAGE_HISTORY_BYTE_CAP) continue;
      includeImage[ti][pi] = true;
      bytesUsed += size;
    }
  }

  const contents: GeminiContent[] = [];
  for (let ti = 0; ti < ctx.turns.length; ti++) {
    const turn = ctx.turns[ti];
    const parts: GeminiPart[] = [];
    for (let pi = 0; pi < turn.parts.length; pi++) {
      const part = turn.parts[pi];
      if (part.imageRef && includeImage[ti][pi]) {
        try {
          const imgBuffer = await fsp.readFile(part.imageRef);
          const base64 = imgBuffer.toString('base64');
          const apiPart: GeminiPart = {
            inline_data: {
              mime_type: part.mime_type || 'image/png',
              data: base64,
            },
          };
          if (part.thought_signature) {
            apiPart.thought_signature = part.thought_signature;
          }
          parts.push(apiPart);
        } catch (err) {
          console.warn(`[gemini-image] failed to load image ${part.imageRef}:`, err);
        }
      } else if (part.text !== undefined) {
        const apiPart: GeminiPart = { text: part.text };
        if (part.thought_signature) {
          apiPart.thought_signature = part.thought_signature;
        }
        parts.push(apiPart);
      }
    }
    if (parts.length > 0) {
      contents.push({ role: turn.role, parts });
    }
  }

  return contents;
}

// Pattern 3 §D.5 — debounce context rewrites.
// Each persist call previously read+parse+stringify+write the entire
// session-wide JSON every edit. For a multi-turn editing session this
// rewrites the same file many times in quick succession; coalesce the
// writes to one per second per (sessionId).
const persistDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PERSIST_DEBOUNCE_MS = 1000;

function persistContext(ctx: ImageContext): void {
  const key = ctx.sessionId;
  const existing = persistDebounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistDebounceTimers.delete(key);
    try {
      const dir = getContextsDir();
      const filePath = join(dir, `${ctx.sessionId}.json`);

      // Load existing file to merge (multiple contexts per session)
      let allContexts: Record<string, ImageContext> = {};
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        allContexts = JSON.parse(raw);
      }
      allContexts[ctx.id] = ctx;
      writeFileSync(filePath, JSON.stringify(allContexts, null, 2));
    } catch (err) {
      console.error(`[gemini-image] Failed to persist context ${ctx.id}:`, err);
    }
  }, PERSIST_DEBOUNCE_MS);
  persistDebounceTimers.set(key, timer);
}

function loadContexts(sessionId: string): void {
  try {
    const filePath = join(getContextsDir(), `${sessionId}.json`);
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, 'utf-8');
    const allContexts = JSON.parse(raw) as Record<string, ImageContext>;
    for (const [id, ctx] of Object.entries(allContexts)) {
      imageContexts.set(id, ctx);
    }
    console.log(`[gemini-image] Loaded ${Object.keys(allContexts).length} contexts for session ${sessionId}`);
  } catch (err) {
    console.error(`[gemini-image] Failed to load contexts for session ${sessionId}:`, err);
  }
}

// ============= Gemini API Client =============

async function callGeminiApi(
  contents: GeminiContent[],
  config: {
    model: string;
    aspectRatio: string;
    imageSize: string;
    thinkingLevel: string;
    searchGrounding: boolean;
    apiKey: string;
    baseUrl: string;
  },
): Promise<GeminiResponse> {
  const baseUrl = config.baseUrl.trim() || DEFAULT_BASE_URL;
  const url = `${baseUrl}/models/${config.model}:generateContent?key=${config.apiKey}`;

  // Build request body — 'auto' means omit the parameter, let Gemini decide
  const imageConfig: Record<string, string> = {};
  if (config.aspectRatio && config.aspectRatio !== 'auto') {
    imageConfig.aspectRatio = config.aspectRatio;
  }
  if (config.imageSize && config.imageSize !== 'auto') {
    imageConfig.imageSize = config.imageSize;
  }

  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  };
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig,
  };

  // Add thinking config — 'auto' means omit, let Gemini use its default (minimal)
  if (config.thinkingLevel && config.thinkingLevel !== 'auto') {
    (body as Record<string, unknown>).thinkingConfig = {
      thinkingLevel: config.thinkingLevel,
    };
  }

  // Add search grounding
  if (config.searchGrounding) {
    (body as Record<string, unknown>).tools = [{ google_search: {} }];
  }

  // Retry loop with exponential backoff
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Pattern 1 fix #10: migrated to cancellableFetch — same parent-signal
      // semantics as the four already-migrated tools.
      // Pattern 1 follow-up: parent signal = active turn so a renderer stop
      // releases the in-flight Gemini API call immediately rather than
      // waiting on API_TIMEOUT_MS.
      const response = await cancellableFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { timeoutMs: API_TIMEOUT_MS, parentSignal: getCurrentTurnSignal() });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMsg = `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed.error?.message) errorMsg = parsed.error.message;
        } catch { /* not JSON */ }

        // Don't retry on 4xx errors (except 429 rate limit)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error(`Gemini API error: ${errorMsg}`);
        }

        // Retry on 429 and 5xx
        lastError = new Error(`Gemini API error (${response.status}): ${errorMsg}`);
        if (attempt < MAX_RETRIES - 1) {
          console.log(`[gemini-image] Retry ${attempt + 1}/${MAX_RETRIES} after ${RETRY_DELAYS[attempt]}ms`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        throw lastError;
      }

      return await response.json() as GeminiResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Gemini API request timed out (300s)');
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        console.log(`[gemini-image] Retry ${attempt + 1}/${MAX_RETRIES} after ${RETRY_DELAYS[attempt]}ms: ${lastError.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  throw lastError || new Error('Gemini API call failed after retries');
}

// ============= Response Processing =============

interface ProcessedResponse {
  textParts: string[];
  imagePaths: string[];
  persistedParts: GeminiPartPersisted[];
}

function processGeminiResponse(
  response: GeminiResponse,
  contextId: string,
  imageIndex: number,
): ProcessedResponse {
  const result: ProcessedResponse = {
    textParts: [],
    imagePaths: [],
    persistedParts: [],
  };

  if (response.error) {
    throw new Error(`Gemini API error: ${response.error.message}`);
  }

  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) {
    throw new Error('Gemini API returned empty response');
  }

  const generatedDir = getGeneratedDir();
  let imgIdx = imageIndex;

  for (const part of candidate.content.parts) {
    if (part.inline_data?.data) {
      // Image part — save to disk
      const ext = part.inline_data.mime_type === 'image/jpeg' ? 'jpg' : 'png';
      const fileName = `${contextId}_${imgIdx}.${ext}`;
      const filePath = join(generatedDir, fileName);

      const buffer = Buffer.from(part.inline_data.data, 'base64');
      writeFileSync(filePath, buffer);

      result.imagePaths.push(filePath);
      result.persistedParts.push({
        imageRef: filePath,
        mime_type: part.inline_data.mime_type,
        thought_signature: part.thought_signature,
      });

      imgIdx++;
    } else if (part.text !== undefined) {
      // Text part
      result.textParts.push(part.text);
      result.persistedParts.push({
        text: part.text,
        thought_signature: part.thought_signature,
      });
    }
  }

  return result;
}

// ============= Tool Handlers =============

async function generateImageHandler(args: {
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
}): Promise<CallToolResult> {
  if (!geminiImageConfig) {
    return {
      content: [{ type: 'text', text: 'Error: Gemini Image tool is not configured. Please configure it in Settings → MCP Tools.' }],
      isError: true,
    };
  }

  if (!geminiImageConfig.apiKey) {
    return {
      content: [{ type: 'text', text: 'Error: Gemini API Key is not set. Please configure it in Settings → MCP Tools → Gemini 图片生成.' }],
      isError: true,
    };
  }

  try {
    const aspectRatio = args.aspectRatio || geminiImageConfig.defaultAspectRatio;
    const resolution = args.resolution || geminiImageConfig.defaultImageSize;

    // Create new context
    const ctx = createContext(geminiImageConfig, aspectRatio, resolution);

    // Add user turn
    addUserTurn(ctx, args.prompt);

    // Build contents for API
    const contents = await buildContentsForApi(ctx);

    console.log(`[gemini-image] generate_image: ctx=${ctx.id}, prompt="${args.prompt.length > 80 ? args.prompt.slice(0, 80) + '...' : args.prompt}"`);

    // Call Gemini API
    const response = await callGeminiApi(contents, {
      model: geminiImageConfig.model,
      aspectRatio,
      imageSize: resolution,
      thinkingLevel: geminiImageConfig.thinkingLevel,
      searchGrounding: geminiImageConfig.searchGrounding,
      apiKey: geminiImageConfig.apiKey,
      baseUrl: geminiImageConfig.baseUrl,
    });

    // Process response
    const processed = processGeminiResponse(response, ctx.id, 0);

    if (processed.imagePaths.length === 0) {
      return {
        content: [{ type: 'text', text: `Gemini returned text but no image.\n\n${processed.textParts.join('\n')}` }],
        isError: true,
      };
    }

    // Add model turn to context
    addModelTurn(ctx, processed.persistedParts);

    // Update generated images list
    ctx.generatedImages.push(...processed.imagePaths);

    // Persist context
    persistContext(ctx);

    // Build result text
    const description = processed.textParts.join('\n').trim();
    const imagePath = processed.imagePaths[0];

    let resultText = `图片已生成。\n\n`;
    resultText += `contextId: ${ctx.id}\n`;
    resultText += `filePath: ${imagePath}\n`;
    resultText += `resolution: ${resolution} | aspectRatio: ${aspectRatio}\n`;
    resultText += `model: ${geminiImageConfig.model}\n`;
    if (description) {
      resultText += `\n图片描述: ${description}\n`;
    }
    resultText += `\n如需修改此图片，请使用 edit_image 工具并传入 contextId: ${ctx.id}`;

    return {
      content: [{ type: 'text', text: resultText }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gemini-image] generate_image error:`, msg);
    return {
      content: [{ type: 'text', text: `Error generating image: ${msg}` }],
      isError: true,
    };
  }
}

async function editImageHandler(args: {
  contextId: string;
  instruction: string;
  aspectRatio?: string;
  resolution?: string;
}): Promise<CallToolResult> {
  if (!geminiImageConfig) {
    return {
      content: [{ type: 'text', text: 'Error: Gemini Image tool is not configured.' }],
      isError: true,
    };
  }

  if (!geminiImageConfig.apiKey) {
    return {
      content: [{ type: 'text', text: 'Error: Gemini API Key is not set.' }],
      isError: true,
    };
  }

  const ctx = imageContexts.get(args.contextId);
  if (!ctx) {
    return {
      content: [{ type: 'text', text: `Error: Image context "${args.contextId}" not found. It may have expired or belong to a different session.` }],
      isError: true,
    };
  }

  try {
    const maxTurns = geminiImageConfig.maxContextTurns || DEFAULT_MAX_CONTEXT_TURNS;
    const editCount = Math.floor(ctx.turns.length / 2); // Each edit = 1 user + 1 model turn

    // Check turn limit — auto-create new context if exceeded
    if (editCount >= maxTurns) {
      console.log(`[gemini-image] Context ${ctx.id} reached turn limit (${maxTurns}), creating new context`);

      // Create new context with last image as reference
      const newCtx = createContext(geminiImageConfig, args.aspectRatio || ctx.config.aspectRatio, args.resolution || ctx.config.imageSize);

      // Migrate: add last image as initial reference
      const lastImage = ctx.generatedImages[ctx.generatedImages.length - 1];
      if (lastImage && existsSync(lastImage)) {
        newCtx.turns.push({
          role: 'user',
          parts: [{ text: 'Here is the previous image for reference.' }],
        });
        newCtx.turns.push({
          role: 'model',
          parts: [{
            imageRef: lastImage,
            mime_type: 'image/png',
          }],
        });
      }

      // Add current instruction
      addUserTurn(newCtx, args.instruction);

      const contents = await buildContentsForApi(newCtx);
      const response = await callGeminiApi(contents, {
        model: geminiImageConfig.model,
        aspectRatio: newCtx.config.aspectRatio,
        imageSize: newCtx.config.imageSize,
        thinkingLevel: geminiImageConfig.thinkingLevel,
        searchGrounding: geminiImageConfig.searchGrounding,
        apiKey: geminiImageConfig.apiKey,
        baseUrl: geminiImageConfig.baseUrl,
      });

      const processed = processGeminiResponse(response, newCtx.id, 0);
      if (processed.imagePaths.length === 0) {
        return {
          content: [{ type: 'text', text: `Gemini returned text but no image.\n\n${processed.textParts.join('\n')}` }],
          isError: true,
        };
      }

      addModelTurn(newCtx, processed.persistedParts);
      newCtx.generatedImages.push(...processed.imagePaths);
      persistContext(newCtx);

      const description = processed.textParts.join('\n').trim();
      let resultText = `图片已编辑（自动创建新会话，原会话已达 ${maxTurns} 轮上限）。\n\n`;
      resultText += `contextId: ${newCtx.id}\n`;
      resultText += `previousContextId: ${ctx.id}\n`;
      resultText += `filePath: ${processed.imagePaths[0]}\n`;
      resultText += `resolution: ${newCtx.config.imageSize} | aspectRatio: ${newCtx.config.aspectRatio}\n`;
      if (description) resultText += `\n${description}\n`;
      resultText += `\n后续编辑请使用新的 contextId: ${newCtx.id}`;

      return { content: [{ type: 'text', text: resultText }] };
    }

    // Normal edit flow
    if (args.aspectRatio) ctx.config.aspectRatio = args.aspectRatio;
    if (args.resolution) ctx.config.imageSize = args.resolution;

    addUserTurn(ctx, args.instruction);

    console.log(`[gemini-image] edit_image: ctx=${ctx.id}, edit #${editCount + 1}, instruction="${args.instruction.length > 80 ? args.instruction.slice(0, 80) + '...' : args.instruction}"`);

    const contents = await buildContentsForApi(ctx);
    const response = await callGeminiApi(contents, {
      model: geminiImageConfig.model,
      aspectRatio: ctx.config.aspectRatio,
      imageSize: ctx.config.imageSize,
      thinkingLevel: geminiImageConfig.thinkingLevel,
      searchGrounding: geminiImageConfig.searchGrounding,
      apiKey: geminiImageConfig.apiKey,
      baseUrl: geminiImageConfig.baseUrl,
    });

    const processed = processGeminiResponse(response, ctx.id, ctx.generatedImages.length);
    if (processed.imagePaths.length === 0) {
      // Remove the user turn we just added since API didn't return an image
      ctx.turns.pop();
      return {
        content: [{ type: 'text', text: `Gemini returned text but no image.\n\n${processed.textParts.join('\n')}` }],
        isError: true,
      };
    }

    addModelTurn(ctx, processed.persistedParts);
    ctx.generatedImages.push(...processed.imagePaths);
    persistContext(ctx);

    const newEditCount = editCount + 1;
    const description = processed.textParts.join('\n').trim();

    // Build edit history summary
    const historyLines: string[] = [];
    let turnIdx = 0;
    for (const turn of ctx.turns) {
      if (turn.role === 'user') {
        turnIdx++;
        const label = turnIdx === 1 ? '初始' : `编辑`;
        const text = turn.parts[0]?.text || '';
        const suffix = turnIdx === newEditCount + 1 ? ' ← 当前' : '';
        historyLines.push(`  ${turnIdx}. ${label}: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}${suffix}`);
      }
    }

    let resultText = `图片已编辑（第 ${newEditCount} 次修改）。\n\n`;
    resultText += `contextId: ${ctx.id}\n`;
    resultText += `filePath: ${processed.imagePaths[0]}\n`;
    resultText += `resolution: ${ctx.config.imageSize} | aspectRatio: ${ctx.config.aspectRatio}\n`;
    if (description) resultText += `\n${description}\n`;
    resultText += `\n编辑历史:\n${historyLines.join('\n')}\n`;
    resultText += `\n如需继续修改，请使用 edit_image 传入相同 contextId。`;

    return { content: [{ type: 'text', text: resultText }] };
  } catch (err) {
    // Rollback the user turn we added before the API call failed
    if (ctx.turns.length > 0 && ctx.turns[ctx.turns.length - 1].role === 'user') {
      ctx.turns.pop();
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[gemini-image] edit_image error:`, msg);
    return {
      content: [{ type: 'text', text: `Error editing image: ${msg}` }],
      isError: true,
    };
  }
}

// ============= MCP Server =============

export async function createGeminiImageServer() {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  return createSdkMcpServer({
    name: 'gemini-image',
    version: '1.0.0',
    tools: [
      tool(
        'generate_image',
        `Generate an image from a text description using Gemini AI.

Use this tool when the user asks you to:
- Create, draw, design, or generate any kind of image
- Make a logo, illustration, diagram concept, UI mockup, icon, etc.
- Visualize something described in text

The tool returns a contextId that can be used with edit_image for subsequent modifications.

Tips for better results:
- Be detailed: include subject, style, colors, composition, mood
- English prompts generally produce better results
- Specify aspect ratio for specific use cases (16:9 for desktop wallpapers, 9:16 for phone wallpapers, etc.)`,
        {
          prompt: z.string().describe('Detailed image description. Include subject, style, colors, composition, and mood for best results.'),
          aspectRatio: z.string().optional().describe('Aspect ratio. Options: 1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 4:5, 5:4, 21:9. Defaults to user preset.'),
          resolution: z.string().optional().describe('Resolution/size. Options: 1K, 2K, 4K. Defaults to user preset.'),
        },
        generateImageHandler,
      ),
      tool(
        'edit_image',
        `Edit a previously generated image based on instructions.

Use this tool when the user wants to modify an existing image. The tool maintains full editing history — Gemini sees every version from initial generation to the current edit, enabling cumulative modifications.

You MUST provide the contextId from a previous generate_image or edit_image result. The instruction should describe what to change (e.g., "make the background blue", "enlarge the text", "remove the logo in the corner").`,
        {
          contextId: z.string().describe('Image context ID from a previous generate_image or edit_image result.'),
          instruction: z.string().describe('What to change. Can reference previous versions (e.g., "go back to the colors from version 1").'),
          aspectRatio: z.string().optional().describe('Optional: change the aspect ratio.'),
          resolution: z.string().optional().describe('Optional: change the resolution.'),
        },
        editImageHandler,
      ),
    ],
  });
}

// ============= Configure / Validate (light — no SDK/zod dependency) =============
// These are exported as plain named exports so that builtin-mcp-meta.ts can
// reference them via dynamic import without pulling in the SDK. `configure`
// is called at session start (via buildSdkMcpServers); `validate` is called
// when the user clicks Test/Enable in Settings.

// Cache for verified API key + baseUrl pair (avoids re-validation on every enable toggle)
let verifiedCacheKey = '';

export function configureGeminiImage(
  env: Record<string, string>,
  ctx: { sessionId: string; workspace?: string },
): void {
  setGeminiImageConfig({
    apiKey: env.GEMINI_API_KEY || '',
    baseUrl: env.GEMINI_BASE_URL || '',
    model: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    defaultAspectRatio: env.GEMINI_DEFAULT_ASPECT_RATIO || 'auto',
    defaultImageSize: env.GEMINI_DEFAULT_IMAGE_SIZE || 'auto',
    thinkingLevel: env.GEMINI_THINKING_LEVEL || 'auto',
    searchGrounding: env.GEMINI_SEARCH_GROUNDING === 'true',
    maxContextTurns: parseInt(env.MAX_CONTEXT_TURNS || '20', 10),
    sessionId: ctx.sessionId,
    workspace: ctx.workspace,
  });
}

export async function validateGeminiImage(
  env: Record<string, string>,
): Promise<{ type: string; message: string } | null> {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return { type: 'runtime_error', message: '请先配置 Gemini API Key' };
  }

  const baseUrl = env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta';

  // Skip if this key+baseUrl pair was already verified
  const cacheKey = `${apiKey}@${baseUrl}`;
  if (cacheKey === verifiedCacheKey) return null;
  try {
    console.log('[api/mcp/enable] Verifying Gemini API key...');
    // Pattern 1 fix #10: migrated to cancellableFetch — bounded 15s timeout.
    const resp = await cancellableFetch(`${baseUrl}/models?key=${apiKey}`, undefined, {
      timeoutMs: 15_000,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      let msg = `API Key 验证失败 (HTTP ${resp.status})`;
      try {
        const parsed = JSON.parse(body);
        if (parsed.error?.message) msg = parsed.error.message;
      } catch { /* not JSON */ }
      console.error(`[api/mcp/enable] Gemini key verification failed: ${msg}`);
      return { type: 'runtime_error', message: msg };
    }
    verifiedCacheKey = cacheKey;
    console.log('[api/mcp/enable] Gemini API key verified successfully');
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[api/mcp/enable] Gemini key verification error: ${errMsg}`);
    return {
      type: 'connection_failed',
      message: errMsg.includes('abort') || errMsg.includes('timeout')
        ? '连接 Gemini API 超时，请检查网络或 Base URL'
        : `连接失败: ${errMsg}`,
    };
  }
}
