import { isModelQaBuild } from '../../shared/updaterQa';
import { hasValidInternalCliCredential } from '../external-cli-admission';

/** Exact test-only control plane. Rust supplies its per-process credential. */
export function isModelQaRoute(pathname: string, method: string): boolean {
  return isModelQaBuild() && (
    (pathname === '/api/modelqa/next-prompt' && ['GET', 'POST'].includes(method))
    || (pathname === '/api/modelqa/title' && ['GET', 'POST', 'DELETE'].includes(method))
  );
}

export async function modelQaRequest(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!isModelQaRoute(path, request.method)) return null;
  if (!hasValidInternalCliCredential(request)) return Response.json({ error: 'INTERNAL_CALLER_REQUIRED' }, { status: 401 });
  if (path === '/api/modelqa/next-prompt') {
    return (await import('./next-prompt')).modelqaNextPromptHandler(request);
  }
  return (await import('./title')).modelqaTitleHandler(request);
}
