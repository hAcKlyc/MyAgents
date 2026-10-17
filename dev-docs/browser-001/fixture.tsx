import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { i18n } from '@/i18n';
import { ThemeRuntimeProvider } from '@/theme/ThemeRuntime';
import '@/index.css';
import { BrowserToolEntry } from '@/components/chat-input/components/BrowserToolEntry';
import { ToolboxSection } from '@/pages/settings/sections/ToolboxSection';
import { changeResource, useBrowserResourceStatus } from './mock';
await i18n.changeLanguage('zh-CN');
const server = { id: 'myagents-browser', name: '浏览器', description: '应用托管的 Chromium', command: '__browser_host__', type: 'stdio' as const, isBuiltin: true, isFree: true };
function Fixture() {
  const status = useBrowserResourceStatus();
  const [settings, showSettings] = useState(false);
  const [available, setAvailable] = useState(false);
  const [selected, select] = useState(false);
  return <main className="min-h-screen bg-[var(--paper)] p-4 text-[var(--ink)]">
    <h1 className="mb-2 text-lg font-semibold">Agent 浏览器入口验收</h1>
    <p className="mb-4 text-sm text-[var(--ink-muted)]">实际产品组件 · 合成资源状态 · 不读写真实配置</p>
    {!settings ? <section className="w-64 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] py-1">
      <div className="border-b border-[var(--line)] px-3 py-2 text-xs">工具（在此对话中启用）</div>
      <BrowserToolEntry available={available} selected={selected} onToggle={(_, value) => select(value)} onSetup={() => showSettings(true)} />
    </section> : <>
      <button className="rounded border border-[var(--line)] px-3 py-2 text-sm" onClick={() => showSettings(false)}>返回对话</button>
      <ToolboxSection mcpServers={[server]} mcpEnabledIds={available ? [server.id] : []} mcpEnabling={{}} mcpNeedsConfig={{}} browserResourceStatus={status}
        onAddMcp={() => {}} onEditMcp={() => {}} onEditBuiltinMcp={() => {}} onToggleMcp={(_, value) => setAvailable(value)}
        onInstallBrowserResource={() => { changeResource({ state: 'downloading', installAuthorized: true, progressPercent: 42, errorCode: undefined, totalBytes: 230 * 1024 * 1024 }); }} />
    </>}
    <aside className="mt-8 flex flex-wrap gap-3 text-xs" aria-label="验收状态控制">
      <button onClick={() => changeResource({ state: 'ready', installedRevision: 'test', installAuthorized: true, errorCode: undefined })}>模拟下载完成</button>
      <button onClick={() => changeResource({ state: 'install_failed', errorCode: 'BROWSER_RESOURCE_DOWNLOAD_FAILED', installAuthorized: false })}>模拟下载失败</button>
      <button onClick={() => changeResource({ state: 'unsupported', errorCode: 'BROWSER_RESOURCE_UNSUPPORTED' })}>模拟不支持平台</button>
    </aside>
  </main>;
}
createRoot(document.getElementById('root')!).render(<ThemeRuntimeProvider selection={{ themeId: 'myagents-light', appearanceMode: location.search.includes('dark') ? 'dark' : 'light' }}><Fixture /></ThemeRuntimeProvider>);
