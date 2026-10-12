import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
// Edge TTS MCP Tool — Free text-to-speech using Microsoft Edge's online TTS API
// Self-implemented WebSocket protocol (no npm dependency)
// In-process MCP server (same pattern as gemini-image-tool)

// SDK + zod loaded lazily inside createEdgeTtsServer() via dynamic import.
// configureEdgeTts is a plain export that builtin-mcp-meta.ts references
// via a lazy proxy — no eager SDK eval. No validate() (free service).
import { existsSync , writeFileSync } from 'fs';
import { ensureGitignorePattern } from '../utils/gitignore';
import { join } from 'path';
import { homedir } from 'os';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as tls from 'tls';
import { ensureDirSync } from '../utils/fs-utils';
import { cancellableFetch } from '../utils/cancellation';
import { getCurrentTurnSignal } from '../utils/turn-abort';

// MCP Tool Result type (matches @modelcontextprotocol/sdk/types.js CallToolResult)
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ============= Constants & Types =============

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '1-143.0.3650.75';
const BASE_URL = 'speech.platform.bing.com';
const WSS_URL = `wss://${BASE_URL}/consumer/speech/synthesize/readaloud/edge/v1`;
const VOICES_URL = `https://${BASE_URL}/consumer/speech/synthesize/readaloud/voices/list`;

// Windows epoch offset: seconds between 1601-01-01 and 1970-01-01
const WINDOWS_EPOCH_OFFSET = 11644473600n;
const TICKS_PER_SECOND = 10000000n;
const ROUND_TICKS = 3000000000n; // 5 minutes in ticks

const MAX_TEXT_LENGTH = 10000;
const MAX_CHUNK_BYTES = 3000; // conservative limit, leave room for SSML tags
const WS_TIMEOUT_MS = 30000;

// ============= Configuration =============

interface EdgeTtsConfig {
  defaultVoice: string;
  defaultRate: string;
  defaultVolume: string;
  defaultPitch: string;
  defaultOutputFormat: string;
  workspace?: string;
}

let edgeTtsConfig: EdgeTtsConfig | null = null;

export function setEdgeTtsConfig(cfg: EdgeTtsConfig): void {
  edgeTtsConfig = cfg;
  console.log(`[edge-tts] Config set: voice=${cfg.defaultVoice}, format=${cfg.defaultOutputFormat}`);
}

export function getEdgeTtsConfig(): EdgeTtsConfig | null {
  return edgeTtsConfig;
}

export function clearEdgeTtsConfig(): void {
  edgeTtsConfig = null;
  console.log('[edge-tts] Config cleared');
}

// ============= Directories =============

function getGeneratedAudioDir(): string {
  const workspace = edgeTtsConfig?.workspace;
  const dir = workspace
    ? join(workspace, 'myagents_files', 'generated_audio')
    : join(homedir(), APP_DATA_DIR_NAME, 'generated_audio');
  if (!existsSync(dir)) {
    ensureDirSync(dir);
    if (workspace) ensureGitignorePattern(workspace, 'myagents_files/');
  }
  return dir;
}

// ============= Format Helpers =============

function getExtFromFormat(format: string): string {
  if (format.includes('mp3') || format.includes('mpeg')) return 'mp3';
  if (format.includes('webm')) return 'webm';
  if (format.includes('ogg')) return 'ogg';
  if (format.includes('wav') || format.includes('pcm')) return 'wav';
  return 'mp3';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============= DRM Token =============

function generateSecMsGecToken(): string {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const ticks = (nowSeconds + WINDOWS_EPOCH_OFFSET) * TICKS_PER_SECOND;
  const roundedTicks = ticks - (ticks % ROUND_TICKS);
  const input = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`;
  return createHash('sha256').update(input, 'utf8').digest('hex').toUpperCase();
}

// ============= SSML Builder =============

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text: string, voice: string, rate: string, volume: string, pitch: string): string {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${escapeXml(voice)}'><prosody pitch='${escapeXml(pitch)}' rate='${escapeXml(rate)}' volume='${escapeXml(volume)}'>${escapeXml(text)}</prosody></voice></speak>`;
}

/** Split a single oversized segment by character count (hard split at word/char boundaries) */
function hardSplitSegment(segment: string): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < segment.length) {
    let end = start + 1;
    while (end < segment.length && Buffer.byteLength(segment.slice(start, end + 1), 'utf8') <= MAX_CHUNK_BYTES) {
      end++;
    }
    result.push(segment.slice(start, end));
    start = end;
  }
  return result;
}

function splitTextForSsml(text: string): string[] {
  const sentences = text.split(/(?<=[。！？.!?\n])/);
  const chunks: string[] = [];
  let current = '';

  for (const s of sentences) {
    const combined = current + s;
    if (Buffer.byteLength(combined, 'utf8') > MAX_CHUNK_BYTES && current) {
      chunks.push(current);
      current = s;
    } else {
      current = combined;
    }
  }
  if (current) chunks.push(current);

  // Secondary pass: hard-split any chunk that still exceeds the limit
  const result: string[] = [];
  for (const chunk of chunks) {
    if (Buffer.byteLength(chunk, 'utf8') > MAX_CHUNK_BYTES) {
      result.push(...hardSplitSegment(chunk));
    } else {
      result.push(chunk);
    }
  }

  return result.length > 0 ? result : [text];
}

// ============= WebSocket Client =============
// Bun's global WebSocket does not support custom HTTP headers.
// Edge TTS requires Origin + User-Agent headers in the upgrade request.
// This minimal client implements WebSocket framing over node:tls.

function buildWsHeaders(): Record<string, string> {
  const muid = randomBytes(16).toString('hex').toUpperCase();
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${muid};`,
  };
}

class EdgeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  private socket: tls.TLSSocket | null = null;
  private buf = Buffer.alloc(0);
  private upgraded = false;
  private closed = false;

  constructor(urlStr: string) {
    const url = new URL(urlStr);
    const host = url.hostname;
    const path = `${url.pathname}${url.search}`;
    const wsKey = randomBytes(16).toString('base64');

    const socket = tls.connect({ host, port: 443, servername: host }, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(buildWsHeaders()).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });

    this.socket = socket;

    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);

      if (!this.upgraded) {
        const idx = this.buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const httpResp = this.buf.subarray(0, idx).toString();
        this.buf = this.buf.subarray(idx + 4);

        if (!httpResp.startsWith('HTTP/1.1 101')) {
          const m = httpResp.match(/HTTP\/1\.\d (\d+)/);
          this.onerror?.({ message: `WebSocket upgrade failed: HTTP ${m?.[1] ?? 'unknown'}` });
          socket.destroy();
          return;
        }

        // Validate Sec-WebSocket-Accept per RFC 6455 Section 4.2.2
        const expectedAccept = createHash('sha1')
          .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        const acceptMatch = httpResp.match(/Sec-WebSocket-Accept:\s*(.+)/i);
        if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
          this.onerror?.({ message: 'WebSocket upgrade failed: invalid Sec-WebSocket-Accept' });
          socket.destroy();
          return;
        }

        this.upgraded = true;
        this.onopen?.();
      }

      this.drainFrames();
    });

    socket.on('error', (err: Error) => {
      if (!this.closed) this.onerror?.({ message: err.message });
    });

    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.onclose?.({ code: 1006, reason: '' });
      }
    });
  }

  send(data: string): void {
    this.writeFrame(0x01, Buffer.from(data, 'utf8'));
  }

  close(): void {
    if (!this.closed) {
      this.writeFrame(0x08, Buffer.alloc(0));
      this.closed = true;
      setTimeout(() => this.socket?.destroy(), 1000);
    }
  }

  // ── Frame parsing ──────────────────────────────────────────

  private drainFrames(): void {
    for (;;) {
      if (this.buf.length < 2) return;

      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let off = 2;

      if (payloadLen === 126) {
        if (this.buf.length < 4) return;
        payloadLen = this.buf.readUInt16BE(2);
        off = 4;
      } else if (payloadLen === 127) {
        if (this.buf.length < 10) return;
        payloadLen = this.buf.readUInt32BE(2) * 0x1_0000_0000 + this.buf.readUInt32BE(6);
        off = 10;
      }

      if (masked) off += 4;
      if (this.buf.length < off + payloadLen) return;

      let payload = this.buf.subarray(off, off + payloadLen);
      if (masked) {
        const mk = this.buf.subarray(off - 4, off);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3];
      }

      this.buf = this.buf.subarray(off + payloadLen);

      // Fragmented messages not supported — log and skip
      if (!fin && (opcode === 0x01 || opcode === 0x02)) {
        console.warn('[edge-tts] Received fragmented WebSocket frame, data may be lost');
        continue;
      }
      if (opcode === 0x00) {
        console.warn('[edge-tts] Received continuation frame (not supported)');
        continue;
      }

      if (opcode === 0x01 && fin) {
        // Text frame
        this.onmessage?.({ data: payload.toString('utf8') });
      } else if (opcode === 0x02 && fin) {
        // Binary frame — copy to standalone ArrayBuffer
        const ab = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        this.onmessage?.({ data: ab });
      } else if (opcode === 0x08) {
        // Close frame
        this.closed = true;
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.onclose?.({ code, reason });
        this.socket?.destroy();
        return;
      } else if (opcode === 0x09) {
        // Ping → pong
        this.writeFrame(0x0a, payload instanceof Buffer ? payload : Buffer.from(payload));
      }
    }
  }

  // ── Frame writing (client frames are always masked per RFC 6455) ──

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket) return;

    const mask = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];

    let hdr: Buffer;
    if (payload.length < 126) {
      hdr = Buffer.allocUnsafe(6);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 0x80 | payload.length;
      mask.copy(hdr, 2);
    } else if (payload.length < 0x10000) {
      hdr = Buffer.allocUnsafe(8);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 0x80 | 126;
      hdr.writeUInt16BE(payload.length, 2);
      mask.copy(hdr, 4);
    } else {
      hdr = Buffer.allocUnsafe(14);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 0x80 | 127;
      hdr.writeUInt32BE(0, 2);
      hdr.writeUInt32BE(payload.length, 6);
      mask.copy(hdr, 10);
    }

    this.socket.write(Buffer.concat([hdr, masked]));
  }
}

// ============= WebSocket Synthesis =============

function isoTimestamp(): string {
  return new Date().toISOString();
}

function buildWsUrl(connectionId: string): string {
  const token = generateSecMsGecToken();
  return `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}&ConnectionId=${connectionId}`;
}

function extractAudioFromBinary(data: ArrayBuffer): Uint8Array | null {
  if (data.byteLength < 2) return null;
  const view = new DataView(data);
  const headerLen = view.getUint16(0, false); // big-endian
  const headerEnd = 2 + headerLen;
  if (headerEnd > data.byteLength) return null;
  const headerText = new TextDecoder().decode(new Uint8Array(data, 2, headerLen));
  if (!headerText.includes('Path:audio')) return null;
  return new Uint8Array(data, headerEnd);
}

async function synthesizeChunk(params: {
  text: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  outputFormat: string;
}): Promise<Buffer> {
  const connectionId = randomUUID().replace(/-/g, '');
  const wsUrl = buildWsUrl(connectionId);

  return new Promise<Buffer>((resolve, reject) => {
    const audioChunks: Uint8Array[] = [];
    let settled = false;
    let turnEndReceived = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('WebSocket synthesis timed out after 30s'));
      }
    }, WS_TIMEOUT_MS);

    const ws = new EdgeWebSocket(wsUrl);

    ws.onopen = () => {
      // 1. Send speech.config
      const configPayload = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: 'false',
                wordBoundaryEnabled: 'false',
              },
              outputFormat: params.outputFormat,
            },
          },
        },
      });

      const configMsg = [
        `X-Timestamp:${isoTimestamp()}`,
        'Content-Type:application/json; charset=utf-8',
        'Path:speech.config',
        '',
        configPayload,
      ].join('\r\n');

      ws.send(configMsg);

      // 2. Send SSML
      const ssml = buildSsml(params.text, params.voice, params.rate, params.volume, params.pitch);
      const ssmlMsg = [
        `X-RequestId:${connectionId}`,
        `X-Timestamp:${isoTimestamp()}`,
        'Content-Type:application/ssml+xml',
        'Path:ssml',
        '',
        ssml,
      ].join('\r\n');

      ws.send(ssmlMsg);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Text message — check for turn.end
        if (event.data.includes('Path:turn.end')) {
          turnEndReceived = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            ws.close();
            resolve(Buffer.concat(audioChunks));
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        // Binary message — extract audio data
        const audio = extractAudioFromBinary(event.data);
        if (audio && audio.byteLength > 0) {
          audioChunks.push(audio);
        }
      }
    };

    ws.onerror = (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`WebSocket error: ${event.message || 'connection failed'}`));
      }
    };

    ws.onclose = (event) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (turnEndReceived && audioChunks.length > 0) {
          resolve(Buffer.concat(audioChunks));
        } else {
          reject(
            new Error(
              `WebSocket closed before synthesis completed: code=${event.code} reason=${event.reason || 'unknown'}`
            )
          );
        }
      }
    };
  });
}

/** Only MP3 raw bitstreams can be safely byte-concatenated; container formats (OGG/WebM) cannot */
function formatSupportsConcatenation(outputFormat: string): boolean {
  return outputFormat.includes('mp3') || outputFormat.includes('mpeg');
}

async function synthesize(params: {
  text: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  outputFormat: string;
}): Promise<Buffer> {
  // For non-MP3 formats (OGG/WebM), skip chunking — send full text in a single WS connection
  if (!formatSupportsConcatenation(params.outputFormat)) {
    return synthesizeChunk(params);
  }

  const chunks = splitTextForSsml(params.text);

  if (chunks.length === 1) {
    return synthesizeChunk({ ...params, text: chunks[0] });
  }

  // Multiple chunks: synthesize each sequentially, then concatenate (MP3 only)
  console.log(`[edge-tts] Splitting text into ${chunks.length} chunks for synthesis`);
  const buffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[edge-tts] Synthesizing chunk ${i + 1}/${chunks.length} (${Buffer.byteLength(chunks[i], 'utf8')} bytes)`);
    const buf = await synthesizeChunk({ ...params, text: chunks[i] });
    buffers.push(buf);
  }
  return Buffer.concat(buffers);
}

// ============= Voices API =============

interface Voice {
  Name: string;
  ShortName: string;
  Gender: string;
  Locale: string;
  FriendlyName: string;
  Status: string;
  SuggestedCodec: string;
  VoiceTag: Record<string, string>;
}

let voicesCache: { voices: Voice[]; timestamp: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000;

async function fetchVoices(): Promise<Voice[]> {
  if (voicesCache && Date.now() - voicesCache.timestamp < CACHE_TTL) {
    return voicesCache.voices;
  }
  const url = `${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
  // Pattern 1: 30s cap on remote Edge TTS voices API. Cached for 10 min so
  // this only fires on cold cache; without a bound we'd hang the tool turn
  // indefinitely if Microsoft's endpoint stalls.
  // Pattern 1 follow-up: parent signal = active turn so stop releases this
  // even before the 30s ceiling.
  const res = await cancellableFetch(url, undefined, {
    timeoutMs: 30_000,
    parentSignal: getCurrentTurnSignal(),
  });
  if (!res.ok) {
    throw new Error(`Voices API returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const voices = (await res.json()) as Voice[];
  voicesCache = { voices, timestamp: Date.now() };
  return voices;
}

// ============= Tool Handlers =============

async function textToSpeechHandler(input: {
  text: string;
  voice?: string;
  rate?: string;
  volume?: string;
  pitch?: string;
}): Promise<CallToolResult> {
  if (!edgeTtsConfig) {
    return {
      content: [{ type: 'text', text: 'Error: Edge TTS is not configured. Please enable it in Settings.' }],
      isError: true,
    };
  }

  const { text, voice, rate, volume, pitch } = input;

  if (!text.trim()) {
    return {
      content: [{ type: 'text', text: 'Error: Text cannot be empty.' }],
      isError: true,
    };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return {
      content: [{ type: 'text', text: `Error: Text too long (${text.length} chars). Maximum is ${MAX_TEXT_LENGTH} characters.` }],
      isError: true,
    };
  }

  const selectedVoice = voice || edgeTtsConfig.defaultVoice;
  const selectedRate = rate || edgeTtsConfig.defaultRate;
  const selectedVolume = volume || edgeTtsConfig.defaultVolume;
  const selectedPitch = pitch || edgeTtsConfig.defaultPitch;
  const outputFormat = edgeTtsConfig.defaultOutputFormat;

  try {
    const audioBuffer = await synthesize({
      text,
      voice: selectedVoice,
      rate: selectedRate,
      volume: selectedVolume,
      pitch: selectedPitch,
      outputFormat,
    });

    const ext = getExtFromFormat(outputFormat);
    const fileName = `tts_${randomUUID().substring(0, 8)}.${ext}`;
    const filePath = join(getGeneratedAudioDir(), fileName);

    writeFileSync(filePath, audioBuffer);

    const sizeBytes = audioBuffer.length;
    const textPreview = text.length > 50 ? text.substring(0, 50) + '...' : text;

    const bitrate = outputFormat.match(/(\d+)kbitrate/)?.[1];
    const bitrateKbps = bitrate ? parseInt(bitrate, 10) : 48;
    const estimatedDuration = (sizeBytes / ((bitrateKbps * 1000) / 8)).toFixed(1);

    const result = [
      '语音已生成。',
      '',
      `filePath: ${filePath}`,
      `voice: ${selectedVoice}`,
      `duration: ${estimatedDuration}s`,
      `format: ${ext}`,
      `size: ${formatSize(sizeBytes)}`,
      `rate: ${selectedRate}`,
      `volume: ${selectedVolume}`,
      `pitch: ${selectedPitch}`,
      `textPreview: ${textPreview}`,
    ].join('\n');

    console.log(`[edge-tts] Generated: ${fileName}, voice=${selectedVoice}, size=${formatSize(sizeBytes)}`);
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[edge-tts] Synthesis error:`, errMsg);
    return {
      content: [{ type: 'text', text: `Error: Failed to synthesize speech. ${errMsg}` }],
      isError: true,
    };
  }
}

async function listVoicesHandler(input: {
  language?: string;
  gender?: string;
}): Promise<CallToolResult> {
  try {
    const voices = await fetchVoices();

    let filtered = voices;

    if (input.language) {
      const lang = input.language.toLowerCase();
      filtered = filtered.filter((v) => v.Locale.toLowerCase().startsWith(lang));
    }

    if (input.gender) {
      const gender = input.gender.toLowerCase();
      filtered = filtered.filter((v) => v.Gender.toLowerCase() === gender);
    }

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No voices found matching the criteria. Try a broader language code (e.g., 'zh' instead of 'zh-CN') or omit the gender filter.`,
          },
        ],
      };
    }

    const lines = filtered.map((v) => `${v.ShortName} | ${v.Gender} | ${v.Locale} | ${v.FriendlyName}`);

    const header = `Found ${filtered.length} voice(s):\n\nShortName | Gender | Locale | FriendlyName\n${'─'.repeat(60)}`;
    return {
      content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[edge-tts] List voices error:`, errMsg);
    return {
      content: [{ type: 'text', text: `Error: Failed to list voices. ${errMsg}` }],
      isError: true,
    };
  }
}

// ============= Standalone synthesis (for Settings preview) =============

export async function synthesizePreview(params: {
  text: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  outputFormat: string;
}): Promise<{ success: true; audioBase64: string; mimeType: string } | { success: false; error: string }> {
  if (!params.text?.trim()) return { success: false, error: 'Empty text' };
  if (params.text.length > MAX_TEXT_LENGTH) return { success: false, error: `Text too long (${params.text.length} chars, max ${MAX_TEXT_LENGTH})` };

  try {
    const audioBuffer = await synthesize({
      text: params.text,
      voice: params.voice,
      rate: params.rate,
      volume: params.volume,
      pitch: params.pitch,
      outputFormat: params.outputFormat,
    });

    const ext = getExtFromFormat(params.outputFormat);
    const mimeTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      webm: 'audio/webm',
    };
    const mimeType = mimeTypes[ext] || 'audio/mpeg';
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    console.log(`[edge-tts] Preview generated: ${formatSize(audioBuffer.length)} ${ext}`);
    return { success: true, audioBase64, mimeType };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[edge-tts] Preview error:`, errMsg);
    return { success: false, error: errMsg };
  }
}

// ============= MCP Server =============

export async function createEdgeTtsServer() {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod/v4');
  return createSdkMcpServer({
    name: 'edge-tts',
    version: '1.0.0',
    tools: [
      tool(
        'text_to_speech',
        `Convert text to speech audio using Microsoft Edge's free TTS service.

Use this tool when the user asks you to:
- Read text aloud or generate speech/audio
- Create an audio/voice file from text
- Produce a voiceover, narration, or podcast segment
- "把这段话读出来" / "帮我生成语音"

Supports 400+ neural voices across 100+ languages. No API key needed.

Common voices:
- Chinese female: zh-CN-XiaoxiaoNeural (sweet), zh-CN-XiaomoNeural (gentle)
- Chinese male: zh-CN-YunxiNeural (narrative), zh-CN-YunjianNeural (news anchor)
- English female: en-US-JennyNeural, en-US-AriaNeural
- English male: en-US-GuyNeural, en-US-ChristopherNeural
- Japanese: ja-JP-NanamiNeural (female), ja-JP-KeitaNeural (male)

Use list_voices to discover voices for other languages.`,
        {
          text: z
            .string()
            .describe(
              'The text to convert to speech. Supports any language. For best results, use plain text without markdown.'
            ),
          voice: z
            .string()
            .optional()
            .describe(
              "Voice ID, e.g. 'zh-CN-XiaoxiaoNeural'. Use list_voices to find voices for a specific language. If omitted, uses the user's configured default voice."
            ),
          rate: z
            .string()
            .optional()
            .describe("Speech rate. '+50%' = faster, '-30%' = slower, '0%' = normal. Range: -100% to +200%."),
          volume: z
            .string()
            .optional()
            .describe("Volume. '+0%' = normal, '-50%' = quieter. Range: -100% to +100%."),
          pitch: z
            .string()
            .optional()
            .describe(
              "Voice pitch. '+10Hz' = higher, '-10Hz' = lower, '+0Hz' = normal. Range: -100Hz to +100Hz."
            ),
        },
        textToSpeechHandler
      ),
      tool(
        'list_voices',
        `List available TTS voices. Use this to find the right voice for a specific language or gender before calling text_to_speech. Returns voice names (ShortName) that can be directly used as the "voice" parameter.`,
        {
          language: z
            .string()
            .optional()
            .describe(
              "Filter by language code: 'zh' (all Chinese), 'zh-CN' (Mandarin), 'en' (all English), 'en-US', 'ja', 'ko', 'fr', etc."
            ),
          gender: z
            .string()
            .optional()
            .describe("Filter by gender: 'Male' or 'Female'."),
        },
        listVoicesHandler
      ),
    ],
  });
}

// ============= Configure =============
// Light export — no SDK/zod dependency. Referenced lazily by builtin-mcp-meta.ts.

export function configureEdgeTts(
  env: Record<string, string>,
  ctx: { sessionId: string; workspace?: string },
): void {
  setEdgeTtsConfig({
    defaultVoice: env.EDGE_TTS_DEFAULT_VOICE || 'zh-CN-XiaoxiaoNeural',
    defaultRate: env.EDGE_TTS_DEFAULT_RATE || '0%',
    defaultVolume: env.EDGE_TTS_DEFAULT_VOLUME || '0%',
    defaultPitch: env.EDGE_TTS_DEFAULT_PITCH || '+0Hz',
    defaultOutputFormat: env.EDGE_TTS_DEFAULT_FORMAT || 'audio-24khz-48kbitrate-mono-mp3',
    workspace: ctx.workspace,
  });
}
