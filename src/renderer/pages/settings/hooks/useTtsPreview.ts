import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';

export interface TtsPreviewSettings {
  defaultVoice: string;
  defaultRate: number;
  defaultVolume: number;
  defaultPitch: number;
  defaultOutputFormat: string;
}

interface PreviewOperation {
  audio: HTMLAudioElement | null;
  blobUrl: string | null;
}

type PreviewStatus = 'idle' | 'loading' | 'playing';

/** The settings dialog owns both synthesis admission and the resulting player. */
export function useTtsPreview(settings: TtsPreviewSettings | null) {
  const { t } = useTranslation('settings');
  const toast = useToast();
  const [preview, setPreview] = useState<{ settings: TtsPreviewSettings | null; status: PreviewStatus }>({
    settings, status: 'idle',
  });
  // Reset the dialog's own projection when its input changes, before children
  // paint. The layout effect below only retires external resources.
  if (preview.settings !== settings) setPreview({ settings, status: 'idle' });
  const setStatus = useCallback((status: PreviewStatus) => {
    setPreview({ settings, status });
  }, [settings]);
  const operationRef = useRef<PreviewOperation | null>(null);
  const mountedRef = useRef(false);

  const retire = useCallback(() => {
    // Invalidate before teardown: queued media events and late async responses
    // belong to this exact operation and cannot touch a replacement preview.
    const operation = operationRef.current;
    operationRef.current = null;
    if (operation?.audio) {
      operation.audio.onended = null;
      operation.audio.onerror = null;
      operation.audio.pause();
      operation.audio.removeAttribute('src');
      operation.audio.load();
    }
    if (operation?.blobUrl) URL.revokeObjectURL(operation.blobUrl);
  }, []);

  const stop = useCallback(() => {
    retire();
    if (mountedRef.current) setStatus('idle');
  }, [retire, setStatus]);

  // Retire on the close/configuration commit, before a pending synthesis or
  // play() completion can regain permission to play. Setup also works after
  // React's setup → cleanup → setup probe.
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      retire();
    };
  }, [settings, retire]);

  const toggle = useCallback(async (text: string) => {
    if (!settings || !mountedRef.current) return;
    if (operationRef.current) {
      stop();
      return;
    }

    const operation: PreviewOperation = { audio: null, blobUrl: null };
    operationRef.current = operation;
    const isCurrent = () => operationRef.current === operation;
    setStatus('loading');

    try {
      const percent = (value: number) => `${value >= 0 ? '+' : ''}${value}%`;
      const result = await apiPostJson<{
        success: boolean;
        audioBase64?: string;
        mimeType?: string;
        error?: string;
      }>('/api/edge-tts/preview', {
        text,
        voice: settings.defaultVoice,
        rate: percent(settings.defaultRate),
        volume: percent(settings.defaultVolume),
        pitch: `${settings.defaultPitch >= 0 ? '+' : ''}${settings.defaultPitch}Hz`,
        outputFormat: settings.defaultOutputFormat,
      });
      // apiPostJson's Tauri transport has no request cancellation API. The
      // dialog still revokes playback admission immediately, before decoding
      // bytes or creating any WebView media resource from a stale response.
      if (!isCurrent()) return;
      if (!result.success || !result.audioBase64) {
        stop();
        toast.error(result.error || t('toolbox.toasts.ttsPreviewFailed'));
        return;
      }

      const binary = atob(result.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      operation.blobUrl = URL.createObjectURL(new Blob([bytes], {
        type: result.mimeType || 'audio/mpeg',
      }));
      const audio = new Audio(operation.blobUrl);
      operation.audio = audio;
      audio.onended = () => { if (isCurrent()) stop(); };
      audio.onerror = () => {
        if (!isCurrent()) return;
        stop();
        toast.error(t('toolbox.toasts.audioPlayFailed'));
      };
      await audio.play();
      if (isCurrent()) setStatus('playing');
    } catch {
      if (!isCurrent()) return;
      stop();
      toast.error(t('toolbox.toasts.ttsPreviewRequestFailed'));
    }
  }, [settings, setStatus, stop, t, toast]);

  return { loading: preview.status === 'loading', playing: preview.status === 'playing', toggle, stop };
}
