import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { RuntimeDetections } from '../../shared/types/runtime';

const DEFAULT_DETECTIONS: RuntimeDetections = {
  builtin: { installed: true },
  dsh: { installed: false },
  antigravity: { installed: false },
  'claude-code': { installed: false },
  codex: { installed: false },
};

export function useRuntimeDetections() {
  const [request, setRequest] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    request: number;
    detections?: RuntimeDetections;
  }>();
  const retry = useCallback(() => setRequest(value => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    void invoke<RuntimeDetections>('cmd_detect_runtimes')
      .then(detections => {
        if (!cancelled) setSnapshot({ request, detections });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ request });
      });
    return () => { cancelled = true; };
  }, [request]);
  return {
    detections: snapshot?.detections ?? DEFAULT_DETECTIONS,
    detecting: snapshot?.request !== request,
    detectionFailed: snapshot?.request === request && !snapshot.detections,
    retry,
  };
}
