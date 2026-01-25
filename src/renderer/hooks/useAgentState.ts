import { useEffect, useState } from 'react';

import { chatClient, type ChatInitPayload } from '@/api/chatClient';

export function useAgentState(): ChatInitPayload {
  const [state, setState] = useState<ChatInitPayload>({
    agentDir: '',
    sessionState: 'idle',
    hasInitialPrompt: false
  });

  useEffect(() => {
    const unsubscribeInit = chatClient.onInit((payload) => {
      if (!payload) {
        return;
      }
      setState(payload);
    });

    const unsubscribeStatus = chatClient.onStatus((payload) => {
      if (!payload) {
        return;
      }
      setState((prev) => ({
        ...prev,
        sessionState: payload.sessionState
      }));
    });

    return () => {
      unsubscribeInit();
      unsubscribeStatus();
    };
  }, []);

  return state;
}
