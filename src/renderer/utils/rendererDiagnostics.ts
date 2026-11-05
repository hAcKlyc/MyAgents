/** Native diagnostics must outlive App mount/unmount and its Sidecar log sink. */
export function rendererErrorMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  try {
    if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
      return error.message;
    }
    return String(error);
  } catch {
    return '';
  }
}

export function describeRendererError(error: unknown): string {
  return (error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
    : rendererErrorMessage(error)).slice(0, 2000);
}

export function reportRendererBootEvent(stage: string, detail?: string): void {
  try {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke?: (command: string, payload: Record<string, unknown>) => Promise<unknown>;
        metadata?: { currentWebview?: { label?: string } };
      };
    }).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== 'function') return;
    void Promise.resolve(internals.invoke('cmd_record_renderer_boot_event', {
      stage,
      windowLabel: internals.metadata?.currentWebview?.label ?? 'browser',
      detail: detail?.slice(0, 2000),
    })).catch(() => {});
  } catch {
    // Observational only: native diagnostics cannot become startup state.
  }
}
