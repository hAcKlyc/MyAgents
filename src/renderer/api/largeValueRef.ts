interface LargeValueRefAddress {
  kind: 'ref';
  id: string;
  mimetype: string;
}

function isLargeValueRefAddress(value: unknown): value is LargeValueRefAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<LargeValueRefAddress>;
  return candidate.kind === 'ref'
    && typeof candidate.id === 'string'
    && /^[a-f0-9]{8,32}$/.test(candidate.id)
    && typeof candidate.mimetype === 'string';
}

export async function fetchJsonLargeValueRef(
  baseUrl: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (!isLargeValueRefAddress(value) || !value.mimetype.includes('json')) {
    throw new Error('Invalid JSON large-value ref');
  }
  // `/refs/:id` is the explicit large-value escape hatch and carries CORS
  // headers. Native fetch keeps the body off the Tauri invoke JSON channel;
  // routing it through invoke would re-buffer 256KiB–1MiB refs in IPC.
  const response = await fetch(`${baseUrl}/refs/${value.id}`);
  if (!response.ok) throw new Error(`JSON large-value ref returned ${response.status}`);
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON large-value ref did not contain an object');
  }
  return parsed as Record<string, unknown>;
}

/** Read a tool-output ref from the originating Tab's data plane. */
export async function fetchTextLargeValueRef(baseUrl: string, value: unknown, signal: AbortSignal): Promise<string> {
  if (!isLargeValueRefAddress(value) || !value.mimetype.startsWith('text/plain')) {
    throw new Error('Invalid text large-value ref');
  }
  const response = await fetch(`${baseUrl}/refs/${value.id}`, { signal });
  if (!response.ok) throw new Error(`Text large-value ref returned ${response.status}`);
  return response.text();
}
