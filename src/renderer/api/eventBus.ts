type EventHandler<T> = (payload: T) => void;

const listeners = new Map<string, Set<EventHandler<unknown>>>();
const replayBuffer: Record<string, unknown[]> = {
  'chat:message-replay': [],
  'chat:system-init': [],
  'chat:log': [],
  'chat:logs': []
};
const replayEvents = new Set(Object.keys(replayBuffer));

export function onEvent<T>(event: string, handler: EventHandler<T>): () => void {
  const existing = listeners.get(event) ?? new Set();
  existing.add(handler as EventHandler<unknown>);
  listeners.set(event, existing);

  if (replayEvents.has(event)) {
    const buffered = replayBuffer[event] ?? [];
    buffered.forEach((payload) => {
      handler(payload as T);
    });
  }

  return () => {
    const current = listeners.get(event);
    if (!current) {
      return;
    }
    current.delete(handler as EventHandler<unknown>);
    if (current.size === 0) {
      listeners.delete(event);
    }
  };
}

export function emitEvent(event: string, payload: unknown): void {
  if (event === 'chat:init') {
    Object.keys(replayBuffer).forEach((key) => {
      replayBuffer[key] = [];
    });
  }

  if (replayEvents.has(event)) {
    replayBuffer[event].push(payload);
  }

  const current = listeners.get(event);
  if (!current) {
    return;
  }
  current.forEach((handler) => {
    handler(payload);
  });
}
