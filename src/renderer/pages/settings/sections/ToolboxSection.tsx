import {
  AudioLines,
  Download,
  Globe,
  ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CliToolsSection } from '@/components/CliToolsSection';
import type { McpServerDefinition } from '@/config/types';
import {
  SPEECH_RECOGNITION_TOOL_ID,
  type OfficialToolDefinition,
  type OfficialToolId,
} from '@/../shared/official-tools';
import type { SpeechModelPackStatus } from '@/../shared/types/record';
import {
  MANAGED_BROWSER_MCP_ID,
  hasUserEditableMcpSettings,
  isBrowserResourceReady,
  type BrowserResourceStatus,
} from '@/../shared/browserTools';
import { SpeechModelResourceControls } from './SpeechModelResourceControls';

interface ToolboxSectionProps {
  cliToolRegistryEnabled?: boolean;
  mcpServers: McpServerDefinition[];
  mcpEnabledIds: string[];
  mcpEnabling: Record<string, boolean>;
  mcpNeedsConfig: Record<string, boolean>;
  officialTools?: readonly OfficialToolDefinition[];
  officialEnabledIds?: OfficialToolId[];
  officialToolEnabling?: Record<string, boolean>;
  officialToolNeedsConfig?: Record<string, boolean>;
  browserResourceStatus?: BrowserResourceStatus | null;
  speechModelPackStatus?: SpeechModelPackStatus | null;
  onAddMcp: () => void;
  onEditMcp: (server: McpServerDefinition) => void;
  onEditBuiltinMcp: (server: McpServerDefinition) => void;
  onToggleMcp: (server: McpServerDefinition, enabled: boolean) => void;
  onEditOfficialTool?: (tool: OfficialToolDefinition) => void;
  onToggleOfficialTool?: (
    tool: OfficialToolDefinition,
    enabled: boolean,
  ) => void;
  onInstallBrowserResource?: () => void;
  onInstallSpeechModelPack?: () => void;
  onRemoveSpeechModelPack?: () => void;
}

export function ToolboxSection({
  cliToolRegistryEnabled,
  mcpServers,
  mcpEnabledIds,
  mcpEnabling,
  mcpNeedsConfig,
  officialTools = [],
  officialEnabledIds = [],
  officialToolEnabling = {},
  officialToolNeedsConfig = {},
  browserResourceStatus,
  speechModelPackStatus,
  onAddMcp,
  onEditMcp,
  onEditBuiltinMcp,
  onToggleMcp,
  onEditOfficialTool,
  onToggleOfficialTool,
  onInstallBrowserResource,
  onInstallSpeechModelPack,
  onRemoveSpeechModelPack,
}: ToolboxSectionProps) {
  const { t } = useTranslation('settings');
  const totalTools = mcpServers.length + officialTools.length;
  const toggleTitle = (isEnabling: boolean, isEnabled: boolean) =>
    isEnabling
      ? t('toolbox.tools.enabling')
      : isEnabled
        ? t('toolbox.tools.enabled')
        : t('toolbox.tools.clickToEnable');

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-[var(--ink-muted)]" />
          <h3 className="text-base font-semibold text-[var(--ink)]">
            {t('toolbox.tools.title')}
          </h3>
          <span className="text-xs text-[var(--ink-muted)]">
            ({totalTools})
          </span>
        </div>
        <button
          onClick={onAddMcp}
          className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        >
          <Plus className="h-4 w-4" />
          {t('toolbox.tools.add')}
        </button>
      </div>

      <p className="mb-4 mt-1 text-sm text-[var(--ink-muted)]">
        {t('toolbox.tools.description')}
      </p>

      <div className="grid grid-cols-2 gap-4">
        {officialTools.map((tool) => {
          const isEnabled = officialEnabledIds.includes(tool.id);
          const isEnabling = officialToolEnabling[tool.id] ?? false;
          const needsConfig = officialToolNeedsConfig[tool.id] ?? false;
          const isSpeechRecognition = tool.id === SPEECH_RECOGNITION_TOOL_ID;
          return (
            <div
              key={tool.id}
              id={`official-tool-${tool.id}`}
              className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {isSpeechRecognition ? (
                    <AudioLines className="h-4 w-4 shrink-0 text-[var(--accent-warm)]/70" />
                  ) : (
                    <ImageIcon className="h-4 w-4 shrink-0 text-[var(--accent-warm)]/70" />
                  )}
                  <h3
                    className="min-w-0 truncate font-semibold text-[var(--ink)]"
                    title={tool.name}
                  >
                    {tool.name}
                  </h3>
                  {isEnabling && (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--info)]" />
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {tool.requiresConfig && (
                    <button
                      onClick={() => onEditOfficialTool?.(tool)}
                      className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                      title={t('toolbox.tools.settings')}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-busy={isEnabling}
                    onClick={() => onToggleOfficialTool?.(tool, !isEnabled)}
                    disabled={isEnabling}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ${
                      isEnabling
                        ? 'cursor-wait bg-[var(--info)]/60'
                        : isEnabled
                          ? 'cursor-pointer bg-[var(--accent)]'
                          : 'cursor-pointer bg-[var(--line-strong)]'
                    }`}
                    title={toggleTitle(isEnabling, isEnabled)}
                  >
                    <span
                      className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                    />
                  </button>
                </div>
              </div>
              <p
                className="mt-1 truncate text-xs text-[var(--ink-muted)]"
                title={tool.description}
              >
                {tool.description}
              </p>
              {needsConfig && (
                <p className="mt-1 text-xs text-[var(--warning)]">
                  {t('toolbox.tools.needsVisionModel')}
                </p>
              )}
              <p
                className="mt-2 truncate font-mono text-xs text-[var(--ink-muted)]"
                title={
                  isSpeechRecognition
                    ? 'myagents speech transcribe --file <path>'
                    : 'myagents vision analyze --image <path>'
                }
              >
                {isSpeechRecognition
                  ? 'myagents speech transcribe --file <path>'
                  : 'myagents vision analyze --image <path>'}
              </p>
              {isSpeechRecognition && (
                <SpeechModelResourceControls
                  status={speechModelPackStatus ?? null}
                  onInstall={onInstallSpeechModelPack}
                  onRemove={onRemoveSpeechModelPack}
                />
              )}
            </div>
          );
        })}
        {mcpServers.map((server) => {
          const isEnabled = mcpEnabledIds.includes(server.id);
          const isEnabling = mcpEnabling[server.id] ?? false;
          const isManagedBrowser = server.id === MANAGED_BROWSER_MCP_ID;
          const browserReady = isBrowserResourceReady(browserResourceStatus);
          const browserResourceBusy =
            isManagedBrowser &&
            [
              'checking',
              'downloading',
              'verifying',
              'installing',
              'updating',
            ].includes(browserResourceStatus?.state ?? '');
          const disableToggle =
            isEnabling || (isManagedBrowser && !isEnabled && !browserReady);
          const showResourceAction =
            isManagedBrowser && !browserReady && !browserResourceBusy;
          const browserResourceSize =
            typeof browserResourceStatus?.totalBytes === 'number'
              ? `${(browserResourceStatus.totalBytes / (1024 * 1024)).toFixed(1)} MiB`
              : null;
          const browserResourceError =
            isManagedBrowser && browserResourceStatus?.errorCode
              ? t(
                  `toolbox.browserResource.errors.${browserResourceStatus.errorCode}`,
                  {
                    defaultValue: t('toolbox.browserResource.errors.default'),
                  },
                )
              : null;
          return (
            <div
              key={server.id}
              className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Globe className="h-4 w-4 shrink-0 text-[var(--accent-warm)]/70" />
                  <h3
                    className="min-w-0 truncate font-semibold text-[var(--ink)]"
                    title={server.name}
                  >
                    {server.name}
                  </h3>
                  {server.isFree && (
                    <span className="shrink-0 rounded-full border border-[var(--success)]/20 bg-[var(--success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--success)]">
                      {t('toolbox.tools.freeBadge')}
                    </span>
                  )}
                  {isEnabling && (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--info)]" />
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {hasUserEditableMcpSettings(server.id) && (
                    <button
                      onClick={() =>
                        server.isBuiltin
                          ? onEditBuiltinMcp(server)
                          : onEditMcp(server)
                      }
                      className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                      title={t('toolbox.tools.settings')}
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isEnabled}
                    aria-busy={isEnabling}
                    onClick={() => onToggleMcp(server, !isEnabled)}
                    disabled={disableToggle}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 ${
                      isEnabling
                        ? 'cursor-wait bg-[var(--info)]/60'
                        : isEnabled
                          ? 'cursor-pointer bg-[var(--accent)]'
                          : 'cursor-pointer bg-[var(--line-strong)]'
                    }`}
                    title={toggleTitle(isEnabling, isEnabled)}
                  >
                    <span
                      className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                    />
                  </button>
                </div>
              </div>
              {server.description && (
                <p
                  className="mt-1 truncate text-xs text-[var(--ink-muted)]"
                  title={server.description}
                >
                  {server.description}
                </p>
              )}
              {mcpNeedsConfig[server.id] && (
                <p className="mt-1 text-xs text-[var(--warning)]">
                  {t('toolbox.tools.needsApiKey')}
                </p>
              )}
              {isManagedBrowser &&
                (browserResourceBusy ||
                  browserResourceError ||
                  showResourceAction) && (
                  <div className="mt-3 space-y-2">
                    {browserResourceBusy && (
                      <div
                        className="flex items-center justify-between gap-3 text-xs"
                        role="status"
                        aria-live="polite"
                      >
                        <span className="text-[var(--ink-muted)]">
                          {t(
                            `toolbox.browserResource.states.${browserResourceStatus?.state ?? 'checking'}`,
                          )}
                          {browserResourceSize
                            ? ` · ${browserResourceSize}`
                            : ''}
                        </span>
                        {typeof browserResourceStatus?.progressPercent ===
                          'number' && (
                          <span className="font-mono text-[var(--ink-muted)]">
                            {Math.max(
                              0,
                              Math.min(
                                100,
                                Math.round(
                                  browserResourceStatus.progressPercent,
                                ),
                              ),
                            )}
                            %
                          </span>
                        )}
                      </div>
                    )}
                    {browserResourceBusy && (
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-[var(--paper-inset)]"
                        role="progressbar"
                        aria-label={t(
                          `toolbox.browserResource.states.${browserResourceStatus?.state ?? 'checking'}`,
                        )}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={browserResourceStatus?.progressPercent}
                      >
                        <div
                          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                          style={{
                            width: `${Math.max(2, Math.min(100, browserResourceStatus?.progressPercent ?? 2))}%`,
                          }}
                        />
                      </div>
                    )}
                    {browserResourceError && (
                      <p className="text-xs text-[var(--danger)]">
                        {browserResourceError}
                      </p>
                    )}
                    {showResourceAction && (
                      <button
                        type="button"
                        onClick={onInstallBrowserResource}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                      >
                        {browserResourceStatus?.installAuthorized ? (
                          <RefreshCw className="h-3.5 w-3.5" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {browserResourceStatus?.installAuthorized
                          ? t('toolbox.browserResource.retryUpdate')
                          : browserResourceStatus?.state === 'install_failed'
                            ? t('toolbox.browserResource.retry')
                            : t('toolbox.browserResource.install')}
                      </button>
                    )}
                  </div>
                )}
              {!isManagedBrowser &&
                server.command !== '__builtin__' && (
                  <p
                    className="mt-2 truncate font-mono text-xs text-[var(--ink-muted)]"
                    title={`${server.command} ${server.args?.join(' ') ?? ''}`}
                  >
                    {server.command} {server.args?.join(' ')}
                  </p>
                )}
            </div>
          );
        })}
      </div>

      {cliToolRegistryEnabled === true && <CliToolsSection />}
    </div>
  );
}
