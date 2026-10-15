import { useSyncExternalStore } from 'react';
const listeners = new Set<() => void>();
let project = { id: 'synthetic-project', name: '合成项目', path: '/synthetic/project', providerId: null, permissionMode: null, projectContextEnabled: true };
export const qa = { saves: 0, errors: 0, failNext: false };
export async function patchProject(_id: string, patch: { projectContextEnabled?: boolean }) {
  qa.saves += 1;
  if (qa.failNext) { qa.failNext = false; throw new Error('synthetic write failure'); }
  project = { ...project, ...patch };
  for (const listener of listeners) listener();
}
export const refreshConfig = async () => undefined;
export const useToast = () => ({ error: () => { qa.errors += 1; document.getElementById('feedback')!.textContent = '保存失败，原设置保留'; } });
export function useConfig() {
  const current = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => project);
  return { projects: [current], patchProject, refreshConfig };
}
