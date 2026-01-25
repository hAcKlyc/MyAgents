import type { SystemInitInfo } from '../../shared/types/system';

interface SystemInfoPanelProps {
  info: SystemInitInfo | null;
  showHeader?: boolean;
}

type InfoRowProps = {
  label: string;
  value?: string;
};

function InfoRow({ label, value }: InfoRowProps) {
  if (!value) {
    return null;
  }
  return (
    <div className="grid gap-1">
      <div className="text-[10px] font-semibold tracking-[0.2em] text-[var(--ink-muted)] uppercase">
        {label}
      </div>
      <div className="text-xs break-all text-[var(--ink)]">{value}</div>
    </div>
  );
}

type InfoChipsProps = {
  label: string;
  items?: string[];
  emptyLabel?: string;
};

function InfoChips({ label, items, emptyLabel = 'None' }: InfoChipsProps) {
  const hasItems = items && items.length > 0;
  return (
    <div className="grid gap-2">
      <div className="text-[10px] font-semibold tracking-[0.2em] text-[var(--ink-muted)] uppercase">
        {label}
      </div>
      {hasItems ?
        <div className="flex flex-wrap gap-2">
          {items?.map((item) => (
            <span
              key={`${label}-${item}`}
              className="rounded-full border border-[var(--line)] bg-[var(--paper-strong)] px-3 py-1 text-[10px] text-[var(--ink)]"
            >
              {item}
            </span>
          ))}
        </div>
      : <div className="text-[11px] text-[var(--ink-muted)]">{emptyLabel}</div>}
    </div>
  );
}

export default function SystemInfoPanel({ info, showHeader = true }: SystemInfoPanelProps) {
  return (
    <div>
      {showHeader && (
        <div className="text-[11px] font-semibold tracking-[0.2em] text-[var(--ink-muted)] uppercase">
          System Init
        </div>
      )}
      {!info ?
        <div
          className={
            showHeader ?
              'mt-3 text-[11px] text-[var(--ink-muted)]'
            : 'text-[11px] text-[var(--ink-muted)]'
          }
        >
          Waiting for init data...
        </div>
      : <div className={`${showHeader ? 'mt-3' : ''} max-h-[60vh] space-y-4 overflow-y-auto pr-1`}>
          <InfoRow label="Timestamp" value={info.timestamp} />
          <InfoRow label="Working Directory" value={info.cwd} />
          <div className="grid gap-3">
            <div className="grid gap-1">
              <div className="text-[10px] font-semibold tracking-[0.2em] text-[var(--ink-muted)] uppercase">
                Runtime
              </div>
              <div className="grid gap-2 text-xs text-[var(--ink)]">
                <div className="flex flex-wrap gap-2">
                  {info.model && (
                    <span className="rounded-full border border-[var(--line)] bg-[var(--paper-strong)] px-3 py-1 text-[10px] text-[var(--ink)]">
                      Model: {info.model}
                    </span>
                  )}
                  {info.permissionMode && (
                    <span className="rounded-full border border-[var(--line)] bg-[var(--paper-strong)] px-3 py-1 text-[10px] text-[var(--ink)]">
                      Permission: {info.permissionMode}
                    </span>
                  )}
                  {info.output_style && (
                    <span className="rounded-full border border-[var(--line)] bg-[var(--paper-strong)] px-3 py-1 text-[10px] text-[var(--ink)]">
                      Output: {info.output_style}
                    </span>
                  )}
                  {info.apiKeySource && (
                    <span className="rounded-full border border-[var(--line)] bg-[var(--paper-strong)] px-3 py-1 text-[10px] text-[var(--ink)]">
                      API Key: {info.apiKeySource}
                    </span>
                  )}
                  {info.claude_code_version && (
                    <span className="rounded-full border border-[var(--line)] bg-[var(--paper-strong)] px-3 py-1 text-[10px] text-[var(--ink)]">
                      Claude Code: {info.claude_code_version}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="grid gap-3">
            <InfoRow label="Session ID" value={info.session_id} />
            <InfoRow label="UUID" value={info.uuid} />
          </div>
          <InfoChips label="Tools" items={info.tools} emptyLabel="No tools reported." />
          <InfoChips
            label="Slash Commands"
            items={info.slash_commands}
            emptyLabel="No commands reported."
          />
          <InfoChips label="Agents" items={info.agents} emptyLabel="No agents reported." />
          <InfoChips label="Skills" items={info.skills} emptyLabel="No skills reported." />
          <InfoChips label="Plugins" items={info.plugins} emptyLabel="No plugins reported." />
          <InfoChips label="MCP Servers" items={info.mcp_servers} emptyLabel="No servers." />
        </div>
      }
    </div>
  );
}
