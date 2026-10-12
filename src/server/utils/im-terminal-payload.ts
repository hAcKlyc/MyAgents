export type ImReplyPayload = Record<string, unknown> & {
  text?: string;
  isError?: boolean;
};

export type ImTerminalPayload = {
  finalPayloads: ImReplyPayload[];
};

/** Kept in the producer text so native IM and OpenClaw finalPayloads agree. */
export function formatImResumeFailure(text: string): string {
  return `${text}\n\n若此会话重试后仍无法恢复，可发送 /new 开始新对话，旧会话历史会保留。`;
}

export function buildImCompletePayload(text: string): ImTerminalPayload {
  return {
    finalPayloads: text.trim() ? [{ text }] : [],
  };
}

export function buildImErrorPayload(text: string): ImTerminalPayload {
  return {
    finalPayloads: text.trim() ? [{ text, isError: true }] : [],
  };
}

export function buildImCancelledPayload(text = '🛑 已取消'): ImTerminalPayload {
  return {
    finalPayloads: text.trim() ? [{ text }] : [],
  };
}
