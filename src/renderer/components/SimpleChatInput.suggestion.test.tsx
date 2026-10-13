import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './Toast';
import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import type { SimpleChatInputProps } from './chat-input/types';

const shortcut = vi.hoisted(() => ({ value: 'enter' }));
vi.mock('@/config/useConfigData', () => ({ useConfigData: () => ({ config: { chatSendShortcut: shortcut.value }, projects: [] }) }));
import SimpleChatInput from './SimpleChatInput';

const suggestion = { key: 'reply-1', sessionId: 'session-1', text: '请继续实现并验证下一步。' };
beforeEach(() => { shortcut.value = 'enter'; HTMLElement.prototype.scrollIntoView = vi.fn(); });
function setup(props: Partial<SimpleChatInputProps> = {}) {
  const onSend = vi.fn();
  const view = (extra: Partial<SimpleChatInputProps> = {}) => <ToastProvider><ImagePreviewProvider><SimpleChatInput isLoading={false} runtime="builtin" providerAvailable sessionId="session-1" nextPromptSuggestion={suggestion} onSend={onSend} {...props} {...extra} /></ImagePreviewProvider></ToastProvider>;
  const result = render(view());
  return { onSend, textarea: screen.getByRole('textbox'), rerender: (extra: Partial<SimpleChatInputProps>) => result.rerender(view(extra)) };
}

describe('next prompt draft acceptance', () => {
  it('keeps ghost outside value; first Enter edits, repeated Enter does nothing, distinct send executes the edited draft once', async () => {
    const { onSend, textarea } = setup();
    expect(screen.getByTestId('next-prompt-ghost')).toHaveTextContent(suggestion.text);
    expect(textarea).toHaveValue('');
    fireEvent.click(screen.getByTitle(/发送/));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea).toHaveValue(suggestion.text);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: '修改后的下一步' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith('修改后的下一步', undefined);
    expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
  });
  it('dismisses the current anchor with Escape or typing, while a new reply gets a new suggestion', () => {
    const { textarea, rerender } = setup();
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
    rerender({ nextPromptSuggestion: { ...suggestion, key: 'reply-2' } });
    expect(screen.getByTestId('next-prompt-ghost')).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: '自己的内容' } });
    fireEvent.change(textarea, { target: { value: '' } });
    expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
  });
  it('keeps a late result dismissed after typing into a pending suggestion, and clicking a ghost only focuses', () => {
    const { textarea, onSend, rerender } = setup({ nextPromptSuggestion: { ...suggestion, text: null } });
    fireEvent.change(textarea, { target: { value: '自己的任务' } });
    fireEvent.change(textarea, { target: { value: '' } });
    rerender({ nextPromptSuggestion: suggestion });
    expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
    rerender({ nextPromptSuggestion: { ...suggestion, key: 'another-reply' } });
    fireEvent.mouseDown(screen.getByTestId('next-prompt-ghost'));
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue('');
    expect(onSend).not.toHaveBeenCalled();
  });
  it.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])('does not accept or execute an IME Enter: %j', ime => {
    const { textarea, onSend } = setup();
    fireEvent.compositionStart(textarea);
    if (!ime.isComposing) fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', ...ime });
    expect(textarea).toHaveValue('');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 13 });
    expect(textarea).toHaveValue(suggestion.text);
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    fireEvent.click(screen.getByTitle(/发送/));
    expect(onSend).not.toHaveBeenCalled();
  });
  it('preserves newline and configured Cmd/Ctrl+Enter sending after acceptance', () => {
    shortcut.value = 'modEnter';
    const { textarea, onSend } = setup();
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(textarea).toHaveValue('');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea).toHaveValue(suggestion.text);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledOnce();
  });
  it.each([{ isLoading: true }, { sendBlocked: true }, { active: false }, { providerAvailable: false }, { sessionState: 'stopping' as const }, { sessionState: 'error' as const }, { sessionId: 'another-session' }])('suppresses a suggestion when unsafe or out of scope: %j', props => {
    setup(props);
    expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
  });
  it('preserves an existing editable draft and marks unsupported generation explicitly', () => {
    const { textarea, rerender } = setup({ value: '已有草稿' });
    expect(textarea).toHaveValue('已有草稿');
    expect(screen.queryByTestId('next-prompt-ghost')).not.toBeInTheDocument();
    rerender({ value: '', nextPromptSuggestion: { ...suggestion, text: null, unavailable: true } });
    expect(screen.getByText('下一步建议：当前 Runtime 暂不可用')).toBeInTheDocument();
  });
});
