import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTtsPreview, type TtsPreviewSettings } from './useTtsPreview';

const { apiPostJson, toast } = vi.hoisted(() => ({
  apiPostJson: vi.fn(),
  toast: { error: vi.fn() },
}));
vi.mock('@/api/apiFetch', () => ({ apiPostJson }));
vi.mock('@/components/Toast', () => ({ useToast: () => toast }));

const settings: TtsPreviewSettings = {
  defaultVoice: 'zh-CN-XiaoxiaoNeural', defaultRate: 0, defaultVolume: -10,
  defaultPitch: 2, defaultOutputFormat: 'audio-24khz-48kbitrate-mono-mp3',
};
const audioResult = { success: true, audioBase64: 'AA==', mimeType: 'audio/mpeg' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mountPreview() {
  return renderHook(({ value }: { value: TtsPreviewSettings | null }) => useTtsPreview(value), {
    initialProps: { value: settings as TtsPreviewSettings | null },
    wrapper: StrictMode,
  });
}

describe('settings TTS preview lifecycle', () => {
  let elements: HTMLAudioElement[];

  beforeEach(() => {
    elements = [];
    apiPostJson.mockReset().mockResolvedValue(audioResult);
    toast.error.mockReset();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.stubGlobal('Audio', function Audio(src: string) {
      const audio = document.createElement('audio');
      audio.src = src;
      elements.push(audio);
      return audio;
    });
    let nextUrl = 0;
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => `blob:preview-${++nextUrl}`);
      static revokeObjectURL = vi.fn();
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['close', 'unmount', 'configure'])(
    'cannot create a player when synthesis finishes after %s', async (action) => {
      const pending = deferred<typeof audioResult>();
      apiPostJson.mockReturnValueOnce(pending.promise);
      const hook = mountPreview();
      let playing!: Promise<void>;
      act(() => { playing = hook.result.current.toggle('preview'); });
      expect(hook.result.current.loading).toBe(true);
      if (action === 'unmount') hook.unmount();
      else hook.rerender({ value: action === 'close' ? null : { ...settings, defaultRate: 10 } });
      await act(async () => { pending.resolve(audioResult); await playing; });
      expect(elements).toHaveLength(0);
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      if (action !== 'unmount') expect(hook.result.current.loading).toBe(false);
    },
  );

  it.each(['resolve', 'reject'])(
    'ignores an old synthesis %s after reopening and playing a new preview', async (settlement) => {
      const pending = deferred<typeof audioResult>();
      apiPostJson.mockReturnValueOnce(pending.promise);
      const hook = mountPreview();
      let first!: Promise<void>;
      act(() => { first = hook.result.current.toggle('first'); });
      hook.rerender({ value: null });
      hook.rerender({ value: settings });
      await act(async () => { await hook.result.current.toggle('second'); });
      await act(async () => {
        if (settlement === 'resolve') pending.resolve(audioResult);
        else pending.reject(new Error('stale synthesis'));
        await first;
      });
      expect(elements).toHaveLength(1);
      expect(elements[0].src).toBe('blob:preview-1');
      expect(hook.result.current.playing).toBe(true);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it.each(['ended', 'error', 'stop', 'close', 'unmount'])(
    'unloads the media resource and listeners on %s', async (action) => {
      const hook = mountPreview();
      await act(async () => { await hook.result.current.toggle('preview'); });
      expect(hook.result.current.playing).toBe(true);
      const audio = elements[0];
      await act(async () => {
        if (action === 'stop') await hook.result.current.toggle('preview');
        else if (action === 'close') hook.rerender({ value: null });
        else if (action === 'unmount') hook.unmount();
        else audio.dispatchEvent(new Event(action));
      });
      expect(audio.hasAttribute('src')).toBe(false);
      expect(audio.pause).toHaveBeenCalledOnce();
      expect(audio.load).toHaveBeenCalledOnce();
      expect(audio.onended).toBeNull();
      expect(audio.onerror).toBeNull();
      expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1');
      if (action !== 'unmount') expect(hook.result.current.playing).toBe(false);
    },
  );

  it('releases the element and URL on play rejection without a media error event', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('play rejected'));
    const hook = mountPreview();
    await act(async () => { await hook.result.current.toggle('preview'); });
    expect(elements[0].hasAttribute('src')).toBe(false);
    expect(elements[0].load).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-1');
    expect(hook.result.current).toMatchObject({ playing: false, loading: false });
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'])(
    'ignores a retired play promise %s and its late events', async (settlement) => {
      const pending = deferred<void>();
      vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pending.promise);
      const hook = mountPreview();
      let first!: Promise<void>;
      await act(async () => { first = hook.result.current.toggle('first'); });
      const retired = elements[0];
      const lateEnd = retired.onended;
      const lateError = retired.onerror;
      hook.rerender({ value: null });
      hook.rerender({ value: settings });
      await act(async () => { await hook.result.current.toggle('second'); });
      await act(async () => {
        lateEnd?.call(retired, new Event('ended'));
        lateError?.call(retired, new Event('error'));
        if (settlement === 'resolve') pending.resolve();
        else pending.reject(new Error('retired playback'));
        await first;
      });
      expect(elements[1].src).toBe('blob:preview-2');
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-2');
      expect(hook.result.current.playing).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it('forwards the chosen preview settings through the existing API', async () => {
    const hook = mountPreview();
    await act(async () => { await hook.result.current.toggle('preview'); });
    expect(apiPostJson).toHaveBeenCalledExactlyOnceWith('/api/edge-tts/preview', {
      text: 'preview', voice: settings.defaultVoice, rate: '+0%', volume: '-10%',
      pitch: '+2Hz', outputFormat: settings.defaultOutputFormat,
    });
  });
});
