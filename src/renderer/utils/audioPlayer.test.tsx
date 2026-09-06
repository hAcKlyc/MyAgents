import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { playAudio, seekTo, stopAudio, subscribeAudio, toggleAudio } from './audioPlayer';

vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

describe('audio player resource lifecycle', () => {
  let elements: HTMLAudioElement[];
  let revoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    elements = [];
    invoke.mockReset().mockResolvedValue('AA==');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.stubGlobal('Audio', function Audio(src: string) {
      const element = document.createElement('audio');
      element.src = src;
      elements.push(element);
      return element;
    });
    let nextUrl = 0;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:audio-${++nextUrl}`);
      static revokeObjectURL = vi.fn();
    });
    revoke = vi.mocked(URL.revokeObjectURL);
  });

  afterEach(() => {
    stopAudio();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['ended', 'error'])('releases the media element on %s and ignores retired events', async (event) => {
    await playAudio('/first.wav');
    const retired = elements[0];
    retired.dispatchEvent(new Event(event));

    expect(retired.hasAttribute('src')).toBe(false);
    expect(retired.load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:audio-1');

    await playAudio('/second.wav');
    const listener = vi.fn();
    const unsubscribe = subscribeAudio(listener);
    retired.dispatchEvent(new Event('ended'));
    retired.dispatchEvent(new Event('error'));
    retired.dispatchEvent(new Event('timeupdate'));
    expect(listener).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalledWith('blob:audio-2');
    unsubscribe();
  });

  it('releases the element when play rejects without a media error event', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('decode failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await playAudio('/broken.wav');
    expect(elements[0].hasAttribute('src')).toBe(false);
    expect(elements[0].load).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:audio-1');
  });

  it('preserves the loaded element and seek position for pause/resume', async () => {
    await playAudio('/first.wav');
    const element = elements[0];
    Object.defineProperty(element, 'paused', { configurable: true, value: false });
    Object.defineProperty(element, 'duration', { value: 60 });
    seekTo(12);
    toggleAudio('/first.wav');
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.src).toBe('blob:audio-1');
    expect(element.currentTime).toBe(12);
    expect(revoke).not.toHaveBeenCalled();

    Object.defineProperty(element, 'paused', { value: true });
    toggleAudio('/first.wav');
    expect(element.play).toHaveBeenCalledTimes(2);
    expect(elements).toHaveLength(1);
    expect(element.currentTime).toBe(12);
  });

  it('does not start playback when a stopped file read completes late', async () => {
    let resolve!: (value: string) => void;
    invoke.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const playing = playAudio('/first.wav');
    // resolveAudioUrl dynamically imports the Tauri command module.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    stopAudio();
    resolve('AA==');
    await playing;
    expect(elements).toHaveLength(0);
    expect(revoke).toHaveBeenCalledWith('blob:audio-1');
  });

  it('does not let a retired play rejection stop a replacement player', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = playAudio('/first.wav');
    await vi.waitFor(() => expect(elements).toHaveLength(1));
    await playAudio('/second.wav');
    reject(new Error('retired'));
    await first;
    expect(elements[1].src).toBe('blob:audio-2');
    expect(revoke).not.toHaveBeenCalledWith('blob:audio-2');
  });
});
