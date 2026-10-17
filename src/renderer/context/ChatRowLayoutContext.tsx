import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

export type RowLayoutChangeReason =
  | 'user-message-collapse-measured'
  | 'user-message-expand'
  | 'block-group-expand'
  | 'block-group-collapse'
  | 'process-row-expand'
  | 'process-row-collapse'
  | 'expandable-container-expand'
  | 'expandable-container-collapse'
  | 'attachment-settle'
  | 'widget-resize'
  | 'tool-complete';

export interface RowLayoutChangePayload {
  reason: RowLayoutChangeReason;
  messageId?: string;
}

interface ChatRowLayoutContextValue {
  messageId: string;
  onRowLayoutChanged: (messageId: string, reason: RowLayoutChangeReason) => void;
}

const ChatRowLayoutContext = createContext<ChatRowLayoutContextValue | null>(null);

export function ChatRowLayoutProvider({
  messageId,
  onRowLayoutChanged,
  children,
}: {
  messageId: string;
  onRowLayoutChanged: (messageId: string, reason: RowLayoutChangeReason) => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ messageId, onRowLayoutChanged }),
    [messageId, onRowLayoutChanged],
  );
  return (
    <ChatRowLayoutContext.Provider value={value}>
      {children}
    </ChatRowLayoutContext.Provider>
  );
}

export function useNotifyRowLayoutChanged(): (reason: RowLayoutChangeReason) => void {
  const context = useContext(ChatRowLayoutContext);
  const messageId = context?.messageId;
  const onRowLayoutChanged = context?.onRowLayoutChanged;
  return useCallback((reason: RowLayoutChangeReason) => {
    if (!messageId || !onRowLayoutChanged) return;
    onRowLayoutChanged(messageId, reason);
  }, [messageId, onRowLayoutChanged]);
}
