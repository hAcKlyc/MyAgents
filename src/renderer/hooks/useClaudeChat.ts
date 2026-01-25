import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { chatClient } from '@/api/chatClient';
import type { Message, SubagentToolCall, ToolInput } from '@/types/chat';
import type { ToolUse } from '@/types/stream';
import { parsePartialJson } from '@/utils/parsePartialJson';

/**
 * @deprecated This hook is no longer used. Chat.tsx now uses TabProvider exclusively.
 * Kept as reference implementation for chatClient event handling.
 * The actual message handling logic lives in TabProvider.tsx.
 */
export function useClaudeChat(): {
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  clearMessages: () => void;
  isLoading: boolean;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
} {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const isStreamingRef = useRef(false);
  const debugMessagesRef = useRef<string[]>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const isNewSessionRef = useRef(false);
  type MessageWire = Omit<Message, 'timestamp'> & { timestamp: string };

  // Clear messages and reset session state - prevents old messages from being replayed
  const clearMessages = useCallback(() => {
    setMessages([]);
    seenIdsRef.current.clear();
    isNewSessionRef.current = true;
  }, []);

  const updateSubagentCalls = (
    parentToolUseId: string,
    updater: (calls: SubagentToolCall[]) => SubagentToolCall[]
  ) => {
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        const message = prev[i];
        if (message.role !== 'assistant' || typeof message.content === 'string') {
          continue;
        }
        const contentArray = message.content;
        const toolIndex = contentArray.findIndex(
          (block) => block.type === 'tool_use' && block.tool?.id === parentToolUseId
        );
        if (toolIndex === -1) {
          continue;
        }
        const toolBlock = contentArray[toolIndex];
        if (toolBlock.type !== 'tool_use' || !toolBlock.tool) {
          continue;
        }
        const existingCalls = toolBlock.tool.subagentCalls ?? [];
        const nextCalls = updater(existingCalls);
        const updatedContent = [...contentArray];
        updatedContent[toolIndex] = {
          ...toolBlock,
          tool: {
            ...toolBlock.tool,
            subagentCalls: nextCalls
          }
        };
        return [
          ...prev.slice(0, i),
          {
            ...message,
            content: updatedContent
          },
          ...prev.slice(i + 1)
        ];
      }
      return prev;
    });
  };

  useEffect(() => {
    const unsubscribeInit = chatClient.onInit(() => {
      seenIdsRef.current.clear();
      setMessages([]);
    });

    const unsubscribeMessageReplay = chatClient.onMessageReplay((payload) => {
      // Skip ALL replays if we're in a new session (flag stays true until new message stream starts)
      if (isNewSessionRef.current) {
        return;
      }
      if (!payload?.message) {
        return;
      }
      const message = payload.message as MessageWire;
      if (seenIdsRef.current.has(message.id)) {
        return;
      }
      seenIdsRef.current.add(message.id);
      setMessages((prev) => [
        ...prev,
        {
          ...message,
          timestamp: new Date(message.timestamp)
        }
      ]);
    });

    // Listen for streaming message chunks
    const unsubscribeMessageChunk = chatClient.onMessageChunk((chunk: string) => {
      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        // Only append if last message is from assistant AND we're actively streaming
        // This prevents appending to completed messages from previous turns
        if (lastMessage && lastMessage.role === 'assistant' && isStreamingRef.current) {
          const content = lastMessage.content;
          if (typeof content === 'string') {
            return [
              ...prev.slice(0, -1),
              {
                ...lastMessage,
                content: content + chunk
              }
            ];
          } else {
            // Content is structured - append to last text block or create new one
            const lastBlock = content[content.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [
                    ...content.slice(0, -1),
                    { type: 'text', text: (lastBlock.text || '') + chunk }
                  ]
                }
              ];
            } else {
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [...content, { type: 'text', text: chunk }]
                }
              ];
            }
          }
        }
        // Otherwise, create new assistant message and start streaming
        isStreamingRef.current = true;
        isNewSessionRef.current = false; // Reset new session flag - user started a real conversation
        setIsLoading(true);
        debugMessagesRef.current = []; // Clear debug accumulator for new response
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: chunk,
            timestamp: new Date()
          }
        ];
      });
    });

    // Listen for thinking block start
    const unsubscribeThinkingStart = chatClient.onThinkingStart((data: { index: number }) => {
      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        const thinkingBlock = {
          type: 'thinking' as const,
          thinking: '',
          thinkingStreamIndex: data.index,
          thinkingStartedAt: Date.now()
        };

        if (lastMessage && lastMessage.role === 'assistant') {
          const content = lastMessage.content;
          const contentArray =
            typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
          return [
            ...prev.slice(0, -1),
            {
              ...lastMessage,
              content: [...contentArray, thinkingBlock]
            }
          ];
        }

        // No existing assistant message – start a new one so thinking can render
        isStreamingRef.current = true;
        isNewSessionRef.current = false; // Reset new session flag - user started a real conversation
        setIsLoading(true);
        debugMessagesRef.current = []; // Clear debug accumulator for new response
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: [thinkingBlock],
            timestamp: new Date()
          }
        ];
      });
    });

    // Listen for thinking chunk deltas
    const unsubscribeThinkingChunk = chatClient.onThinkingChunk(
      (data: { index: number; delta: string }) => {
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.role === 'assistant' &&
            typeof lastMessage.content !== 'string'
          ) {
            const contentArray = lastMessage.content;
            // Find incomplete thinking block by stream index (not array index)
            const thinkingBlockIndex = contentArray.findIndex(
              (block) =>
                block.type === 'thinking' &&
                block.thinkingStreamIndex === data.index &&
                !block.isComplete
            );

            if (thinkingBlockIndex !== -1) {
              const thinkingBlock = contentArray[thinkingBlockIndex];
              if (thinkingBlock.type === 'thinking') {
                const updatedContent = [...contentArray];
                updatedContent[thinkingBlockIndex] = {
                  ...thinkingBlock,
                  thinking: (thinkingBlock.thinking || '') + data.delta,
                  thinkingStreamIndex: thinkingBlock.thinkingStreamIndex,
                  isComplete: thinkingBlock.isComplete
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }
          }
          return prev;
        });
      }
    );

    // Listen for tool use start
    const unsubscribeToolUseStart = chatClient.onToolUseStart((tool: ToolUse) => {
      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        const toolBlock = {
          type: 'tool_use' as const,
          tool: {
            ...tool,
            // Don't stringify tool.input here - it gets built up via deltas
            inputJson: '',
            isLoading: true
          }
        };

        if (lastMessage && lastMessage.role === 'assistant') {
          const content = lastMessage.content;
          const contentArray =
            typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
          return [
            ...prev.slice(0, -1),
            {
              ...lastMessage,
              content: [...contentArray, toolBlock]
            }
          ];
        }

        // No existing assistant message – start a new one so the tool can render
        isStreamingRef.current = true;
        isNewSessionRef.current = false; // Reset new session flag - user started a real conversation
        setIsLoading(true);
        debugMessagesRef.current = []; // Clear debug accumulator for new response
        return [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'assistant',
            content: [toolBlock],
            timestamp: new Date()
          }
        ];
      });
    });

    // Listen for tool input deltas - accumulate the raw string and attempt incremental parsing
    const unsubscribeToolInputDelta = chatClient.onToolInputDelta(
      (data: { index: number; toolId: string; delta: string }) => {
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.role === 'assistant' &&
            typeof lastMessage.content !== 'string'
          ) {
            const contentArray = lastMessage.content;
            // Match by tool ID instead of streamIndex for better delineation
            const toolBlockIndex = contentArray.findIndex(
              (block) => block.type === 'tool_use' && block.tool?.id === data.toolId
            );

            if (toolBlockIndex !== -1) {
              const toolBlock = contentArray[toolBlockIndex];
              if (toolBlock.type === 'tool_use' && toolBlock.tool) {
                const currentTool = toolBlock.tool;
                const newInputJson = (currentTool.inputJson || '') + data.delta;

                // Attempt to parse the accumulated JSON incrementally
                const parsedInput = parsePartialJson<ToolInput>(newInputJson);

                const updatedContent = [...contentArray];
                updatedContent[toolBlockIndex] = {
                  ...toolBlock,
                  tool: {
                    ...currentTool,
                    inputJson: newInputJson,
                    // Update parsedInput if we successfully parsed something
                    parsedInput: parsedInput || currentTool.parsedInput
                  }
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }
          }
          return prev;
        });
      }
    );

    // Listen for content block stop - parse the accumulated inputJson or mark thinking complete
    const unsubscribeContentBlockStop = chatClient.onContentBlockStop(
      (data: { index: number; toolId?: string }) => {
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.role === 'assistant' &&
            typeof lastMessage.content !== 'string'
          ) {
            const contentArray = lastMessage.content;

            // First check if this is a thinking block
            const thinkingBlockIndex = contentArray.findIndex(
              (block) =>
                block.type === 'thinking' &&
                block.thinkingStreamIndex === data.index &&
                !block.isComplete
            );

            if (thinkingBlockIndex !== -1) {
              const thinkingBlock = contentArray[thinkingBlockIndex];
              if (thinkingBlock.type === 'thinking') {
                const updatedContent = [...contentArray];
                updatedContent[thinkingBlockIndex] = {
                  ...thinkingBlock,
                  isComplete: true,
                  thinkingDurationMs:
                    thinkingBlock.thinkingStartedAt ?
                      Date.now() - thinkingBlock.thinkingStartedAt
                    : undefined
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }

            // Otherwise check if this is a tool block
            // Match by tool ID (if available) for consistency with onToolInputDelta
            // Fall back to streamIndex for non-tool blocks or if toolId is missing
            const toolBlockIndex =
              data.toolId ?
                contentArray.findIndex(
                  (block) => block.type === 'tool_use' && block.tool?.id === data.toolId
                )
              : contentArray.findIndex(
                  (block) => block.type === 'tool_use' && block.tool?.streamIndex === data.index
                );

            if (toolBlockIndex !== -1) {
              const toolBlock = contentArray[toolBlockIndex];
              if (toolBlock.type === 'tool_use' && toolBlock.tool) {
                const currentTool = toolBlock.tool;
                let parsedInput: ToolInput | undefined = currentTool.parsedInput;
                if (currentTool.inputJson) {
                  try {
                    parsedInput = JSON.parse(currentTool.inputJson) as ToolInput;
                  } catch {
                    const fallback = parsePartialJson<ToolInput>(currentTool.inputJson);
                    parsedInput = fallback ?? currentTool.parsedInput;
                  }
                }

                const updatedContent = [...contentArray];
                updatedContent[toolBlockIndex] = {
                  ...toolBlock,
                  tool: {
                    ...currentTool,
                    parsedInput
                  }
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }
          }
          return prev;
        });
      }
    );

    // Listen for tool result start
    const unsubscribeToolResultStart = chatClient.onToolResultStart(
      (data: { toolUseId: string; content: string; isError: boolean }) => {
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.role === 'assistant' &&
            typeof lastMessage.content !== 'string'
          ) {
            const contentArray = lastMessage.content;
            const toolBlockIndex = contentArray.findIndex(
              (block) => block.type === 'tool_use' && block.tool?.id === data.toolUseId
            );

            if (toolBlockIndex !== -1) {
              const toolBlock = contentArray[toolBlockIndex];
              if (toolBlock.type === 'tool_use' && toolBlock.tool) {
                const updatedContent = [...contentArray];
                updatedContent[toolBlockIndex] = {
                  ...toolBlock,
                  tool: {
                    ...toolBlock.tool,
                    result: data.content,
                    isError: data.isError,
                    isLoading: true
                  }
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }
          }
          return prev;
        });
      }
    );

    // Listen for tool result deltas
    const unsubscribeToolResultDelta = chatClient.onToolResultDelta(
      (data: { toolUseId: string; delta: string }) => {
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.role === 'assistant' &&
            typeof lastMessage.content !== 'string'
          ) {
            const contentArray = lastMessage.content;
            const toolBlockIndex = contentArray.findIndex(
              (block) => block.type === 'tool_use' && block.tool?.id === data.toolUseId
            );

            if (toolBlockIndex !== -1) {
              const toolBlock = contentArray[toolBlockIndex];
              if (toolBlock.type === 'tool_use' && toolBlock.tool) {
                const updatedContent = [...contentArray];
                updatedContent[toolBlockIndex] = {
                  ...toolBlock,
                  tool: {
                    ...toolBlock.tool,
                    result: (toolBlock.tool.result || '') + data.delta,
                    isLoading: true
                  }
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }
          }
          return prev;
        });
      }
    );

    // Listen for tool result complete
    const unsubscribeToolResultComplete = chatClient.onToolResultComplete(
      (data: { toolUseId: string; content: string; isError?: boolean }) => {
        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          if (
            lastMessage &&
            lastMessage.role === 'assistant' &&
            typeof lastMessage.content !== 'string'
          ) {
            const contentArray = lastMessage.content;
            const toolBlockIndex = contentArray.findIndex(
              (block) => block.type === 'tool_use' && block.tool?.id === data.toolUseId
            );

            if (toolBlockIndex !== -1) {
              const toolBlock = contentArray[toolBlockIndex];
              if (toolBlock.type === 'tool_use' && toolBlock.tool) {
                const updatedContent = [...contentArray];
                updatedContent[toolBlockIndex] = {
                  ...toolBlock,
                  tool: {
                    ...toolBlock.tool,
                    result: data.content,
                    isError: data.isError,
                    isLoading: false
                  }
                };

                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    content: updatedContent
                  }
                ];
              }
            }
          }
          return prev;
        });
      }
    );

    const unsubscribeSubagentToolUse = chatClient.onSubagentToolUse(
      (data: { parentToolUseId: string; tool: ToolUse }) => {
        updateSubagentCalls(data.parentToolUseId, (calls) => {
          const existing = calls.find((call) => call.id === data.tool.id);
          const inputJson = JSON.stringify(data.tool.input ?? {}, null, 2);
          if (existing) {
            return calls.map((call) =>
              call.id === data.tool.id ?
                {
                  ...call,
                  name: data.tool.name,
                  input: data.tool.input ?? {},
                  inputJson,
                  isLoading: true
                }
              : call
            );
          }
          return [
            ...calls,
            {
              id: data.tool.id,
              name: data.tool.name,
              input: data.tool.input ?? {},
              inputJson,
              isLoading: true
            }
          ];
        });
      }
    );

    const unsubscribeSubagentToolInputDelta = chatClient.onSubagentToolInputDelta(
      (data: { parentToolUseId: string; toolId: string; delta: string }) => {
        updateSubagentCalls(data.parentToolUseId, (calls) =>
          calls.map((call) => {
            if (call.id !== data.toolId) {
              return call;
            }
            const nextInputJson = `${call.inputJson ?? ''}${data.delta}`;
            const parsedInput = parsePartialJson<ToolInput>(nextInputJson);
            return {
              ...call,
              inputJson: nextInputJson,
              parsedInput: parsedInput ?? call.parsedInput
            };
          })
        );
      }
    );

    const unsubscribeSubagentToolResultStart = chatClient.onSubagentToolResultStart(
      (data: { parentToolUseId: string; toolUseId: string; content: string; isError: boolean }) => {
        updateSubagentCalls(data.parentToolUseId, (calls) =>
          calls.map((call) =>
            call.id === data.toolUseId ?
              {
                ...call,
                result: data.content,
                isError: data.isError,
                isLoading: true
              }
            : call
          )
        );
      }
    );

    const unsubscribeSubagentToolResultDelta = chatClient.onSubagentToolResultDelta(
      (data: { parentToolUseId: string; toolUseId: string; delta: string }) => {
        updateSubagentCalls(data.parentToolUseId, (calls) =>
          calls.map((call) =>
            call.id === data.toolUseId ?
              {
                ...call,
                result: `${call.result ?? ''}${data.delta}`,
                isLoading: true
              }
            : call
          )
        );
      }
    );

    const unsubscribeSubagentToolResultComplete = chatClient.onSubagentToolResultComplete(
      (data: {
        parentToolUseId: string;
        toolUseId: string;
        content: string;
        isError?: boolean;
      }) => {
        updateSubagentCalls(data.parentToolUseId, (calls) =>
          calls.map((call) =>
            call.id === data.toolUseId ?
              {
                ...call,
                result: data.content,
                isError: data.isError,
                isLoading: false
              }
            : call
          )
        );
      }
    );

    // Listen for message completion
    const unsubscribeMessageComplete = chatClient.onMessageComplete(() => {
      isStreamingRef.current = false;
      setIsLoading(false);

      // Append all accumulated debug messages when response completes
      if (debugMessagesRef.current.length > 0) {
        const accumulatedDebug = debugMessagesRef.current.join('\n');
        debugMessagesRef.current = []; // Clear accumulator

        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          const debugContent = `\n\n---\n**🔍 Debug Output:**\n\`\`\`\n${accumulatedDebug}\n\`\`\`\n`;

          if (lastMessage && lastMessage.role === 'assistant') {
            const content = lastMessage.content;
            if (typeof content === 'string') {
              // Append debug message to string content
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: content + debugContent
                }
              ];
            } else {
              // Content is structured - append debug block
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [
                    ...content,
                    {
                      type: 'text' as const,
                      text: debugContent
                    }
                  ]
                }
              ];
            }
          }
          // No existing assistant message - create new one for debug
          return [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'assistant',
              content: debugContent.trim(),
              timestamp: new Date()
            }
          ];
        });
      }
    });

    const unsubscribeMessageStopped = chatClient.onMessageStopped(() => {
      isStreamingRef.current = false;
      setIsLoading(false);

      // Get accumulated debug messages
      const accumulatedDebug =
        debugMessagesRef.current.length > 0 ? debugMessagesRef.current.join('\n') : null;
      debugMessagesRef.current = []; // Clear accumulator

      setMessages((prev) => {
        const lastMessage = prev[prev.length - 1];
        if (
          lastMessage &&
          lastMessage.role === 'assistant' &&
          typeof lastMessage.content !== 'string'
        ) {
          let hasUpdates = false;
          let updatedContent = lastMessage.content.map((block) => {
            if (block.type === 'thinking' && !block.isComplete) {
              hasUpdates = true;
              return {
                ...block,
                isComplete: true,
                thinkingDurationMs:
                  block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
              };
            }
            return block;
          });

          // Append debug messages if any were accumulated
          if (accumulatedDebug) {
            const debugContent = `\n\n---\n**🔍 Debug Output:**\n\`\`\`\n${accumulatedDebug}\n\`\`\`\n`;
            updatedContent = [
              ...updatedContent,
              {
                type: 'text' as const,
                text: debugContent
              }
            ];
            hasUpdates = true;
          }

          if (hasUpdates) {
            return [
              ...prev.slice(0, -1),
              {
                ...lastMessage,
                content: updatedContent
              }
            ];
          }
        } else if (accumulatedDebug) {
          // No existing assistant message but we have debug messages
          const debugContent = `\n\n---\n**🔍 Debug Output:**\n\`\`\`\n${accumulatedDebug}\n\`\`\`\n`;
          return [
            ...prev,
            {
              id: Date.now().toString(),
              role: 'assistant',
              content: debugContent.trim(),
              timestamp: new Date()
            }
          ];
        }
        return prev;
      });
    });

    // Listen for errors
    const unsubscribeMessageError = chatClient.onMessageError((error: string) => {
      isStreamingRef.current = false;

      // Append all accumulated debug messages when error occurs
      if (debugMessagesRef.current.length > 0) {
        const accumulatedDebug = debugMessagesRef.current.join('\n');
        debugMessagesRef.current = []; // Clear accumulator

        setMessages((prev) => {
          const lastMessage = prev[prev.length - 1];
          const debugContent = `\n\n---\n**🔍 Debug Output:**\n\`\`\`\n${accumulatedDebug}\n\`\`\`\n`;

          if (lastMessage && lastMessage.role === 'assistant') {
            const content = lastMessage.content;
            if (typeof content === 'string') {
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: content + debugContent
                }
              ];
            } else {
              return [
                ...prev.slice(0, -1),
                {
                  ...lastMessage,
                  content: [
                    ...content,
                    {
                      type: 'text' as const,
                      text: debugContent
                    }
                  ]
                }
              ];
            }
          }
          return prev;
        });
      }

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `Error: ${error}`,
          timestamp: new Date()
        }
      ]);
      setIsLoading(false);
    });

    // Listen for debug messages (stderr from Claude Code process)
    // Accumulate debug messages during streaming - they'll be appended when response completes
    const unsubscribeDebugMessage = chatClient.onDebugMessage((message: string) => {
      // Only accumulate if we're actively streaming
      if (isStreamingRef.current) {
        debugMessagesRef.current.push(message);
      }
    });

    // Cleanup function to remove all event listeners
    return () => {
      unsubscribeInit();
      unsubscribeMessageReplay();
      unsubscribeMessageChunk();
      unsubscribeThinkingStart();
      unsubscribeThinkingChunk();
      unsubscribeToolUseStart();
      unsubscribeToolInputDelta();
      unsubscribeContentBlockStop();
      unsubscribeToolResultStart();
      unsubscribeToolResultDelta();
      unsubscribeToolResultComplete();
      unsubscribeSubagentToolUse();
      unsubscribeSubagentToolInputDelta();
      unsubscribeSubagentToolResultStart();
      unsubscribeSubagentToolResultDelta();
      unsubscribeSubagentToolResultComplete();
      unsubscribeMessageComplete();
      unsubscribeMessageStopped();
      unsubscribeMessageError();
      unsubscribeDebugMessage();
    };
  }, []);

  return {
    messages,
    setMessages,
    clearMessages,
    isLoading,
    setIsLoading
  };
}
