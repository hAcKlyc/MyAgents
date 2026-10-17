/** Error bodies are untrusted. A hung/oversized body is not proof of a transient failure. */
export async function readBoundedErrorBody(body: ReadableStream<Uint8Array> | null,
  timeoutMs = 1_000, maximumBytes = 16_384): Promise<string | undefined> {
  if (!body) return '';
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { void reader.cancel().catch(() => undefined); resolve(undefined); }, timeoutMs);
  });
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return Buffer.concat(chunks).toString('utf8');
        size += next.value.byteLength;
        if (size > maximumBytes) { void reader.cancel().catch(() => undefined); return undefined; }
        chunks.push(next.value);
      }
    } catch { return undefined; }
  };
  try { return await Promise.race([read(), timeout]); }
  finally { clearTimeout(timer); }
}
