import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NATIVE_RESUME_BOUNDARY_MESSAGE } from '../../shared/nativeResumeBoundary';
import { NativeResumeRecoveryAction } from './NativeResumeRecoveryAction';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const messages = [
  { id: 'earlier', role: 'assistant' as const, sdkUuid: 'native-earlier' },
  { id: 'retained', role: 'assistant' as const, sdkUuid: 'native-question' },
  { id: 'unsent', role: 'user' as const },
  { id: 'diagnostic', role: 'assistant' as const },
];

describe('native boundary recovery action', () => {
  it('branches at the retained assistant, leaving later unsent input and diagnostics in the source', () => {
    const onFork = vi.fn();
    render(<NativeResumeRecoveryAction error={NATIVE_RESUME_BOUNDARY_MESSAGE} messages={messages} disabled={false} onFork={onFork} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onFork).toHaveBeenCalledExactlyOnceWith('retained');
    expect(messages.map(message => message.id)).toEqual(['earlier', 'retained', 'unsent', 'diagnostic']);
  });

  it('does not start a second mutation while loading or forking', () => {
    const onFork = vi.fn();
    render(<NativeResumeRecoveryAction error={NATIVE_RESUME_BOUNDARY_MESSAGE} messages={messages} disabled onFork={onFork} />);
    expect(screen.getByRole('button')).toBeDisabled();
    fireEvent.click(screen.getByRole('button'));
    expect(onFork).not.toHaveBeenCalled();
  });

  it.each([
    { error: 'Provider unavailable', messages, onFork: vi.fn() },
    { error: NATIVE_RESUME_BOUNDARY_MESSAGE, messages: messages.slice(2), onFork: vi.fn() },
    { error: NATIVE_RESUME_BOUNDARY_MESSAGE, messages, onFork: undefined },
  ])('never offers an unanchored or unavailable recovery', props => {
    render(<NativeResumeRecoveryAction {...props} disabled={false} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
