export type ToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  streamIndex: number;
};

export type ToolInputDelta = {
  index: number;
  toolId: string;
  delta: string;
};

export type ContentBlockStop = {
  index: number;
  toolId?: string;
};

export type ThinkingStart = {
  index: number;
};

export type ThinkingChunk = {
  index: number;
  delta: string;
};

export type ToolResultStart = {
  toolUseId: string;
  content: string;
  isError: boolean;
};

export type ToolResultDelta = {
  toolUseId: string;
  delta: string;
};

export type ToolResultComplete = {
  toolUseId: string;
  content: string;
  isError?: boolean;
};
