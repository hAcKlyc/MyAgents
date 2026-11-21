import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToastProvider, useToast } from '@/components/Toast';

import {
  classifyRewindTransportOutcome,
  getConversationRejectionMessage,
  projectRewindRecovery,
  type RewindResponse,
  warnRewindFileOutcome,
} from './rewindFileOutcome';

function Harness({ result }: { result: RewindResponse }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => warnRewindFileOutcome(
        result,
        toast.warning,
        (key, options) => `${key}${options ? `:${options.count}` : ''}`,
      )}
    >
      rewind
    </button>
  );
}

describe('rewind file outcome warning', () => {
  it.each([
    [{ fileRewindStatus: 'failed' }, 'shell.toasts.rewindFilesFailed'],
    [{ fileRewindStatus: 'not_attempted' }, 'shell.toasts.rewindFilesNotAttempted'],
    [{ fileRewindStatus: 'partial', skippedLinks: 2 }, 'shell.toasts.rewindPartialLinks:2'],
  ] as const)('shows the independent workspace warning for %o', (result, expected) => {
    render(<ToastProvider><Harness result={result} /></ToastProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'rewind' }));

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe('conversation transport reconciliation', () => {
  it('treats an absent target in restored authority as committed', () => {
    expect(classifyRewindTransportOutcome({
      restored: true,
      targetMessagePresent: false,
    })).toBe('committed');
  });

  it('treats a target still present in restored authority as unchanged', () => {
    expect(classifyRewindTransportOutcome({
      restored: true,
      targetMessagePresent: true,
    })).toBe('unchanged');
  });

  it('does not infer a result when authority could not be restored', () => {
    expect(classifyRewindTransportOutcome({
      restored: false,
      targetMessagePresent: null,
    })).toBe('unresolved');
  });

  it('does not infer deletion when the target presence probe is incomplete', () => {
    expect(classifyRewindTransportOutcome({
      restored: true,
      targetMessagePresent: null,
    })).toBe('target-unknown');
  });

  it.each([
    ['rejected', true, true],
    ['committed', false, false],
    ['unchanged', false, true],
    ['target-unknown', false, false],
    ['unresolved', false, false],
  ] as const)(
    'projects %s without overwriting SessionStore authority',
    (outcome, restoreMessageSnapshot, restoreComposerSnapshot) => {
      expect(projectRewindRecovery(outcome)).toEqual({
        restoreMessageSnapshot,
        restoreComposerSnapshot,
      });
    },
  );
});

describe('explicit conversation rejections', () => {
  const translate = (key: string) => key;
  it.each(['unsupported_runtime', 'codex_update_required', 'anchor_unavailable'])('preserves %s instead of claiming an unknown outcome', errorCode => {
    const error = Object.assign(new Error('known rejection'), { status: 400, errorCode });
    expect(getConversationRejectionMessage(error, translate)).toBe(`shell.toasts.conversationError.${errorCode}`);
  });
  it('recognizes an explicit native branch refusal before product rewind commit', () => {
    expect(getConversationRejectionMessage({ status: 502, errorCode: 'native_fork_failed' }, translate))
      .toBe('shell.toasts.conversationError.native_fork_failed');
    expect(getConversationRejectionMessage({ status: 502 }, translate)).toBeNull();
  });
  it('retains a concrete validation message and keeps transport/server failure ambiguous', () => {
    expect(getConversationRejectionMessage(Object.assign(new Error('Invalid target'), { status: 400 }), translate)).toBe('Invalid target');
    expect(getConversationRejectionMessage(new Error('Connection lost'), translate)).toBeNull();
    expect(getConversationRejectionMessage(Object.assign(new Error('IO failed'), { status: 500 }), translate)).toBeNull();
  });
});
