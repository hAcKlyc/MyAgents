import { useEffect, useState } from 'react';

import { chatClient } from '@/api/chatClient';

import type { SystemInitInfo } from '../../shared/types/system';

export function useSystemInit(): SystemInitInfo | null {
  const [info, setInfo] = useState<SystemInitInfo | null>(null);

  useEffect(() => {
    const unsubscribeInit = chatClient.onInit(() => {
      setInfo(null);
    });
    const unsubscribeSystemInit = chatClient.onSystemInit((payload) => {
      setInfo(payload.info);
    });

    return () => {
      unsubscribeInit();
      unsubscribeSystemInit();
    };
  }, []);

  return info;
}
