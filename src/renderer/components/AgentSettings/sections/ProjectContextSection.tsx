import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../../../shared/config-types';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';

/** Ordinary Project preference, independent of proactive/heartbeat mode. */
export default function ProjectContextSection({ project }: { project: Project }) {
  const { t } = useTranslation('settings');
  const { patchProject, refreshConfig } = useConfig();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const enabled = project.projectContextEnabled !== false;
  async function toggle() {
    if (saving) return;
    setSaving(true);
    try {
      await patchProject(project.id, { projectContextEnabled: !enabled });
      await refreshConfig();
    } catch {
      await refreshConfig().catch(() => undefined);
      toast.error(t('agentSettings.general.operationFailed'));
    } finally { setSaving(false); }
  }
  return <div className="flex items-start justify-between gap-4">
    <div>
      <h3 id="project-context-label" className="text-base font-medium text-[var(--ink)]">{t('projectContext.title')}</h3>
      <p id="project-context-description" className="mt-1 text-xs leading-relaxed text-[var(--ink-muted)]">{t('projectContext.description')}</p>
    </div>
    <button type="button" role="switch" aria-checked={enabled} aria-labelledby="project-context-label"
      aria-describedby="project-context-description" disabled={saving} onClick={() => { void toggle(); }}
      className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${saving ? 'cursor-wait opacity-50' : 'cursor-pointer'} ${enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}>
      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  </div>;
}
