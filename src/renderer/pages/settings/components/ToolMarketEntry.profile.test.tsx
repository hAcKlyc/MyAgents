// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'zh-CN' } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each(['moxbot', 'myagents'] as const)('does not advertise an unsupported resource market in %s', async (profile) => {
  vi.stubGlobal('__MYAGENTS_BUILD_PROFILE__', profile);
  vi.resetModules();
  const { ToolMarketEntry } = await import('./ToolMarketEntry');
  const open = vi.fn();
  const view = render(<ToolMarketEntry onOpen={open} />);
  if (profile === 'moxbot') {
    expect(view.queryByRole('button')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  } else {
    fireEvent.click(view.getByRole('button'));
    expect(open).toHaveBeenCalledOnce();
  }
});
