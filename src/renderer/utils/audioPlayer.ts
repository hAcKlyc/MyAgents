/**
 * Global singleton audio player.
 *
 * Ensures only one audio plays at a time across the entire app.
 * Provides play/stop control and state callbacks for UI updates.
 *
 * In Tauri: reads file via Rust command → base64 → blob URL (avoids asset protocol scope issues).
 * In browser: uses direct URL to the Node Sidecar's /api/audio endpoint.
 */
import { isTauriEnvironment } from '@/utils/browserMock';

/**
 * Read a local file via Rust and return a blob URL.
 * Works around Tauri asset protocol scope restrictions on workspace directories.
 * In browser dev mode, returns a direct URL to the Node Sidecar endpoint.
 */
export async function readLocalFileAsBlobUrl(
  filePath: string,
  mimeType: string,
  apiEndpoint: string,
): Promise<string> {
  if (!isTauriEnvironment()) {
    return `${apiEndpoint}?path=${encodeURIComponent(filePath)}`;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const base64: string = await invoke('cmd_read_file_base64', { path: filePath });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/** Audio extensions we recognize for inline playback (exported for pathDetection reuse) */
export const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'opus', 'webm', 'aac', 'm4a']);

/** mm:ss formatter for playback time (shared by the audio players). */
export function formatPlaybackTime(sec: number): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Check if a file path is an audio file */
export function isAudioPath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? AUDIO_EXTENSIONS.has(ext) : false;
}

/** Map extension to MIME type for blob creation */
function audioMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    opus: 'audio/opus', webm: 'audio/webm', aac: 'audio/aac', m4a: 'audio/mp4',
  };
  return map[ext ?? ''] ?? 'audio/mpeg';
}

export interface AudioState {
  playing: boolean;
  currentPath: string | null;
  progress: number;
  duration: number;
}

type StateListener = (state: AudioState) => void;

let audio: HTMLAudioElement | null = null;
let currentPath: string | null = null;
let currentBlobUrl: string | null = null;
let playGeneration = 0; // monotonic counter to detect stale async completions
const listeners = new Set<StateListener>();

// Throttle timeupdate notifications to ~4 updates/sec max
let lastProgressNotifyAt = 0;
const PROGRESS_THROTTLE_MS = 250;

function notify() {
  const state: AudioState = {
    playing: audio ? !audio.paused && !audio.ended : false,
    currentPath,
    progress: audio?.currentTime ?? 0,
    duration: audio?.duration ?? 0,
  };
  for (const fn of listeners) fn(state);
}

function notifyProgress() {
  const now = Date.now();
  if (now - lastProgressNotifyAt < PROGRESS_THROTTLE_MS) return;
  lastProgressNotifyAt = now;
  notify();
}

/** Subscribe to audio state changes. Returns unsubscribe function. */
export function subscribeAudio(fn: StateListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function detachListeners(el: HTMLAudioElement) {
  el.removeEventListener('play', notify);
  el.removeEventListener('pause', notify);
  el.removeEventListener('ended', onEnded);
  el.removeEventListener('timeupdate', notifyProgress);
  el.removeEventListener('error', onError);
}

// Revoking a blob URL only prevents future URL resolution; it does not unload
// an element that already holds the media resource. Every terminal path must
// retire the element and its listeners through the same owner as explicit stop.
function onEnded() { stopAudio(); }
function onError() { stopAudio(); }

function revokeBlobUrl() {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

/** Resolve a local file path to a playable audio URL. */
async function resolveAudioUrl(filePath: string): Promise<string> {
  return readLocalFileAsBlobUrl(filePath, audioMime(filePath), '/api/audio');
}

/** Play an audio file. Stops any currently playing audio first. */
export async function playAudio(filePath: string): Promise<void> {
  stopAudio();
  const gen = ++playGeneration;
  currentPath = filePath;
  notify(); // Show loading state immediately

  try {
    const url = await resolveAudioUrl(filePath);
    // Stale check: another play/stop happened while we were fetching
    if (gen !== playGeneration) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }
    if (url.startsWith('blob:')) currentBlobUrl = url;

    audio = new Audio(url);
    audio.addEventListener('play', notify);
    audio.addEventListener('pause', notify);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('timeupdate', notifyProgress);
    audio.addEventListener('error', onError);
    await audio.play();
  } catch (err) {
    // Only reset if this is still the active generation
    if (gen === playGeneration) {
      console.error('[audioPlayer] playback failed:', err);
      stopAudio();
    }
  }
}

/** Stop currently playing audio (also cancels any pending async play). */
export function stopAudio(): void {
  ++playGeneration; // invalidate any in-flight playAudio
  if (audio) {
    detachListeners(audio);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }
  currentPath = null;
  revokeBlobUrl();
  notify();
}

/** Seek to a specific time (seconds). Only works if audio is loaded. */
export function seekTo(time: number): void {
  if (audio && isFinite(time)) {
    audio.currentTime = Math.max(0, Math.min(time, audio.duration || 0));
    notify();
  }
}

/**
 * Toggle play/pause for a specific file. Reads internal state — no external
 * dependency needed.
 *
 * Pause/resume (not stop) so the position is preserved: a paused audio keeps its
 * element + blob URL + currentTime, and `state.currentPath` stays set so the UI
 * can still scrub and show the progress. A *different* file (or a finished one)
 * starts fresh via playAudio (which tears down any prior audio first).
 */
export function toggleAudio(filePath: string): void {
  if (currentPath === filePath && audio) {
    if (!audio.paused && !audio.ended) {
      audio.pause();        // PAUSE — keep element/blob/position
      notify();
      return;
    }
    if (!audio.ended) {
      void audio.play().catch(() => { /* resume race; state re-syncs on next event */ });
      notify();
      return;
    }
    // ended → restart from the beginning
  }
  void playAudio(filePath);
}
