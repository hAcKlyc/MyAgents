import { useEffect, useState } from 'react';

import { chatClient } from '@/api/chatClient';

export function useAgentLogs(): string[] {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribeInit = chatClient.onInit(() => {
      setLogs([]);
    });
    const unsubscribeSnapshot = chatClient.onLogsSnapshot((payload) => {
      setLogs(payload.lines ?? []);
    });
    const unsubscribeLog = chatClient.onLog((line) => {
      setLogs((prev) => [...prev, line]);
    });

    return () => {
      unsubscribeInit();
      unsubscribeSnapshot();
      unsubscribeLog();
    };
  }, []);

  return logs;
}
