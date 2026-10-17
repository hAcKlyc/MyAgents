// WorkspaceGeneralTab — the "通用" tab in WorkspaceConfigPanel
// Flat layout: section titles + dividers, no outer card borders

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { getAgentById, setProactiveAgentEnabled, reconcilePersistedAgentWorkspaceIdentities } from '@/config/services/agentConfigService';
import { workspacePathsEqual } from '../../../shared/workspacePath';
import WorkspaceBasicsSection from './WorkspaceBasicsSection';
import AgentChannelsSection from './sections/AgentChannelsSection';
import AgentHeartbeatSection from './sections/AgentHeartbeatSection';
import AgentMemoryUpdateSection from './sections/AgentMemoryUpdateSection';
import AgentMemoryEvolutionSection from './sections/AgentMemoryEvolutionSection';
import AgentTasksSection from './sections/AgentTasksSection';
import { SlidersIcon, HeartPulseIcon } from '@/components/icons';
import type { ChannelType } from '../../../shared/types/agent';
import AgentIdentityConflicts from './AgentIdentityConflicts';
import ProjectContextSection from './sections/ProjectContextSection';
import { resolveAgentWorkspaceProjections } from '../../../shared/agentWorkspaceIdentity';

interface WorkspaceGeneralTabProps {
  agentDir: string;
  initialAddChannelPlatform?: ChannelType;
  onInitialAddChannelPlatformConsumed?: () => void;
}

export default function WorkspaceGeneralTab({
  agentDir,
  initialAddChannelPlatform,
  onInitialAddChannelPlatformConsumed,
}: WorkspaceGeneralTabProps) {
  const { t } = useTranslation('settings');
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const project = projects.find(p => workspacePathsEqual(p.path, agentDir));
  const agent = project?.agentId ? getAgentById(config, project.agentId) : undefined;
  const isProactive = agent?.enabled === true;
  const { statuses, refresh: refreshStatuses } = useAgentStatuses(!!agent);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleAgentChanged = useCallback(async () => {
    await refreshConfig();
    await refreshStatuses();
  }, [refreshConfig, refreshStatuses]);

  // Toggle proactive agent mode
  const handleToggleProactive = useCallback(async () => {
    if (!project || toggling) return;
    setToggling(true);
    try {
      if (!agent) {
        const identity = await reconcilePersistedAgentWorkspaceIdentities();
        const created = identity.agentProjections.find(item => item.projectId === project.id)?.agent;
        if (!created) throw new Error(`Could not create Agent for Project '${project.id}'.`);
        await setProactiveAgentEnabled(created.id, true);
        await patchProject(project.id, { isAgent: true });
        toastRef.current.success(t('agentSettings.general.enabled'));
      } else {
        const nextEnabled = !agent.enabled;
        await setProactiveAgentEnabled(agent.id, nextEnabled);
        if (nextEnabled && !project.isAgent) {
          await patchProject(project.id, { isAgent: true });
        }
        toastRef.current.success(t(
          nextEnabled ? 'agentSettings.general.enabled' : 'agentSettings.general.disabled',
        ));
      }
      await refreshConfig();
      if (isMountedRef.current) await refreshStatuses();
    } catch (e) {
      console.error('[WorkspaceGeneralTab] Toggle proactive failed:', e);
      // The disk write may have committed before a runtime/managed-task
      // projection failed. Re-read authority before rendering the failure.
      try {
        await refreshConfig();
        if (isMountedRef.current) await refreshStatuses();
      } catch (refreshError) {
        console.error('[WorkspaceGeneralTab] Failed to refresh proactive state:', refreshError);
      }
      toastRef.current.error(t('agentSettings.general.operationFailed'));
    } finally {
      if (isMountedRef.current) setToggling(false);
    }
  }, [project, agent, toggling, patchProject, refreshConfig, refreshStatuses, t]);

  const status = agent ? statuses[agent.id] : undefined;
  const identityError = agent && resolveAgentWorkspaceProjections(projects, config.agents ?? []).diagnostics
    .some(item => item.agentIds.includes(agent.id));

  if (identityError) return <div className="overflow-auto px-8 py-6"><AgentIdentityConflicts agentId={agent.id} /></div>;

  if (!project) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-[var(--ink-subtle)]">{t('agentSettings.general.missingWorkspace')}</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="mx-auto max-w-2xl space-y-6 pb-8">
        {/* Card 1: Basic settings */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h3 className="flex items-center gap-2 text-base font-medium text-[var(--ink)]">
            <SlidersIcon className="h-[18px] w-[18px] text-[var(--ink-muted)]" />
            {t('agentSettings.general.basicsTitle')}
          </h3>
          <div className="mt-4">
            <WorkspaceBasicsSection project={project} agent={agent} agentDir={agentDir} />
          </div>
        </div>

        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <ProjectContextSection key={project.id} project={project} />
        </div>

        {/* Card 2: Channels — independent from Proactive Agent mode */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          {agent && (
            <AgentChannelsSection
              agent={agent}
              status={status}
              onAgentChanged={handleAgentChanged}
              initialAddPlatform={initialAddChannelPlatform}
              onInitialAddPlatformConsumed={onInitialAddChannelPlatformConsumed}
            />
          )}
        </div>

        {/* Card 3: Proactive Agent mode */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <div className="flex items-center justify-between">
            <div className="flex-1 pr-4">
              <h3 className="flex items-center gap-2 text-base font-medium text-[var(--ink)]">
                <HeartPulseIcon className="h-[18px] w-[18px] text-[var(--heartbeat)]" />
                {t('agentSettings.general.proactiveTitle')}
              </h3>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                {t('agentSettings.general.proactiveDescription')}
              </p>
            </div>
            <button
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                toggling ? 'cursor-wait opacity-50' : 'cursor-pointer'
              } ${
                isProactive ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
              }`}
              onClick={handleToggleProactive}
              disabled={toggling}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                  isProactive ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Proactive children stay folded while the master is off. */}
          {isProactive && agent && (
            <>
              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentHeartbeatSection agent={agent} workspacePath={project.path} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentMemoryUpdateSection agent={agent} workspacePath={project.path} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentMemoryEvolutionSection
                  agent={agent}
                  workspaceId={project.id}
                  workspacePath={project.path}
                  onAgentChanged={handleAgentChanged}
                />
              </div>
            </>
          )}
        </div>

        {/* Card 4: Tasks — independent from Proactive Agent mode */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <AgentTasksSection workspacePath={project.path} />
        </div>
      </div>
    </div>
  );
}
