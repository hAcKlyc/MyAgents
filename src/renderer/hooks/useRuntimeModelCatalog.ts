import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/api/apiFetch';
import { runtimeModelCatalogPath } from '@/utils/runtimeModelCatalog';
import type { RuntimeModelInfo } from '../../shared/types/runtime';

type CatalogRuntime = 'codex' | 'antigravity';
interface CatalogState {
  runtime: CatalogRuntime;
  request: number;
  models: RuntimeModelInfo[];
  status: 'ready' | 'error';
}

const EMPTY_CATALOG: RuntimeModelInfo[] = [];

/** CLI discovery for the Launcher and saved Agent defaults. Chat uses its own Session API. */
export function useRuntimeModelCatalog(runtime: CatalogRuntime | undefined, enabled = true) {
  const [state, setState] = useState<CatalogState>();
  const [request, setRequest] = useState(0);
  const retry = useCallback(() => setRequest(value => value + 1), []);
  useEffect(() => {
    if (!runtime || !enabled) return;
    const controller = new AbortController();
    void apiFetch(runtimeModelCatalogPath(runtime, 'system-cli'), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: { models: RuntimeModelInfo[] } = await response.json();
        if (!controller.signal.aborted) setState({ runtime, request, models: data.models, status: 'ready' });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState(previous => ({
          runtime,
          request,
          models: previous?.runtime === runtime ? previous.models : EMPTY_CATALOG,
          status: 'error',
        }));
      });
    return () => controller.abort();
  }, [runtime, enabled, request]);
  const catalog = state?.runtime === runtime ? state : undefined;
  return {
    models: catalog?.models ?? EMPTY_CATALOG,
    loading: !!runtime && enabled && catalog?.request !== request,
    error: catalog?.request === request && catalog.status === 'error',
    retry,
  };
}
