import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { Provider } from '../../../shared/config-types';
import { ModelFailoverSettings } from './ModelFailoverSettings';

const provider: Provider = {
  id: 'backup-provider', name: 'Backup Provider', vendor: 'custom', cloudProvider: 'fixture', type: 'api',
  isBuiltin: false, apiProtocol: 'openai', config: { baseUrl: 'https://fixture.invalid' }, enabled: true,
  primaryModel: 'backup-model', models: [{ model: 'backup-model', modelName: 'Backup Model', modelSeries: 'fixture' }],
};
const backup = { providerId: provider.id, modelId: 'backup-model' };
const keys = { [provider.id]: 'fixture-key' };

afterEach(cleanup);
beforeEach(async () => { await i18n.changeLanguage('en-US'); });

describe('backup model settings', () => {
  it('defaults off and cannot enable without a selected backup', () => {
    const update = vi.fn();
    render(<ModelFailoverSettings value={undefined} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    const toggle = screen.getByRole('switch', { name: 'Enable automatic model failover' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText('Select a backup model before enabling automatic failover.')).toBeVisible();
  });

  it('selects exactly one provider/model through the config owner without enabling it', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<ModelFailoverSettings value={undefined} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    fireEvent.click(screen.getByRole('button', { name: 'Backup provider and model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Backup Provider · backup-model' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ modelFailover: { enabled: false, backup } }));
    expect(document.querySelector('select')).toBeNull();
  });

  it('requires an API key and excludes disabled, subscription, runtime-backed and cloud-session providers', async () => {
    const update = vi.fn();
    const excluded: Provider[] = [
      { ...provider, id: 'disabled', name: 'Disabled Provider', enabled: false },
      { ...provider, id: 'subscription', name: 'Subscription Provider', type: 'subscription' },
      { ...provider, id: 'runtime', name: 'Runtime Provider', execution: { kind: 'runtime-backed', runtime: 'codex', source: 'managed-provider' } },
      { ...provider, id: 'cloud-session:fixture', name: 'Cloud Session Provider' },
    ];
    render(<ModelFailoverSettings value={{ enabled: false, backup }} providers={[provider, ...excluded]} apiKeys={{ [provider.id]: '  ' }} updateConfig={update} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(/Add this provider’s API key/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Backup provider and model' }));
    expect(await screen.findByRole('button', { name: 'Backup Provider · backup-model' })).toBeVisible();
    for (const item of excluded) expect(screen.queryByRole('button', { name: `${item.name} · backup-model` })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('enables a ready backup and displays only the persisted state', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ModelFailoverSettings value={{ enabled: false, backup }} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ modelFailover: { enabled: true, backup } }));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    rerender(<ModelFailoverSettings value={{ enabled: true, backup }} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('shows an unavailable saved backup and permits disabling an enabled broken configuration', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<ModelFailoverSettings value={{ enabled: true, backup }} providers={[]} apiKeys={keys} updateConfig={update} />);
    expect(screen.getByRole('button', { name: 'Backup provider and model' })).toHaveTextContent('Unavailable · backup-model');
    expect(screen.getByText(/The saved backup is unavailable/)).toBeVisible();
    expect(screen.getByRole('switch')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ modelFailover: { enabled: false, backup } }));
  });

  it('disables failover when the selected backup is cleared', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    render(<ModelFailoverSettings value={{ enabled: true, backup }} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    fireEvent.click(screen.getByRole('button', { name: 'Backup provider and model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select a backup model' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ modelFailover: { enabled: false } }));
  });

  it('keeps provider identity when two providers offer the same model and disables a keyless replacement', async () => {
    const other = { ...provider, id: 'other-provider', name: 'Other Provider' };
    const update = vi.fn().mockResolvedValue(undefined);
    render(<ModelFailoverSettings value={{ enabled: true, backup }} providers={[provider, other]} apiKeys={keys} updateConfig={update} />);
    fireEvent.click(screen.getByRole('button', { name: 'Backup provider and model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Other Provider · backup-model' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ modelFailover: {
      enabled: false, backup: { providerId: 'other-provider', modelId: 'backup-model' },
    } }));
  });

  it('retains persisted settings after a save failure and allows retry', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('disk write failed')).mockResolvedValue(undefined);
    render(<ModelFailoverSettings value={{ enabled: false, backup }} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save. Your previous settings are unchanged. Try again.');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('locks both controls during saving and prevents duplicate writes', async () => {
    let finish: (() => void) | undefined;
    const update = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<ModelFailoverSettings value={{ enabled: false, backup }} providers={[provider]} apiKeys={keys} updateConfig={update} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Backup provider and model' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    expect(update).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
    expect(screen.getByRole('switch')).not.toBeDisabled();
  });

  it('explains safety limits and supports the Chinese UI resource', async () => {
    await i18n.changeLanguage('zh-CN');
    render(<ModelFailoverSettings value={undefined} providers={[]} apiKeys={{}} updateConfig={vi.fn()} />);
    fireEvent.click(screen.getByText('切换规则与适用范围'));
    expect(screen.getByText(/支持内置运行环境的 API 模型/)).toBeVisible();
    expect(screen.getByText(/保留进度并停止，避免自动重复执行操作/)).toBeVisible();
    expect(screen.getByRole('switch', { name: '启用模型自动切换' })).toBeDisabled();
  });
});
