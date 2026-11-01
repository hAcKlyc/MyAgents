import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { chatSendShortcut: 'enter' }, projects: [] }),
}));

import SimpleChatInput from './SimpleChatInput';
import { ToastProvider } from './Toast';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }));
afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

function renderInput(onSend = vi.fn(), onSlashAction?: (action: string) => void) {
  render(
    <ToastProvider>
      <ImagePreviewProvider>
        <SimpleChatInput
          mode="launcher"
          runtime="codex"
          isLoading={false}
          onSend={onSend}
          onSlashAction={onSlashAction}
        />
      </ImagePreviewProvider>
    </ToastProvider>,
  );
  return onSend;
}

describe('SimpleChatInput IME submission guard', () => {
  it.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])('does not invoke slash commands from a composition Enter: %j', async ime => {
    const onAction = vi.fn();
    renderInput(vi.fn(), onAction);
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } });
    fireEvent.change(textarea, { target: { value: '/goal', selectionStart: 5 } });
    await screen.findByText('/goal', { selector: 'span' });
    fireEvent.compositionStart(textarea);
    if (!ime.isComposing) fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', ...ime });
    expect(onAction).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('/goal');
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('goal'));
  });

  it('does not send from the button while IME composition is active', () => {
    const onSend = renderInput();
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    fireEvent.change(textarea, { target: { value: '输入法提交测试' } });
    fireEvent.compositionStart(textarea);
    fireEvent.click(screen.getByTitle(/发送/));

    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.click(screen.getByTitle(/发送/));

    expect(onSend).toHaveBeenCalledWith('输入法提交测试', undefined, undefined, undefined, expect.any(Function));
  });
});
