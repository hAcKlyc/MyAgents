import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AsyncQuestionCard from './AsyncQuestionCard';
import { acceptedAsyncQuestionReplies, AsyncQuestionContext, useAsyncQuestionComposerDraft, type AsyncQuestionActions } from '@/context/AsyncQuestionContext';

vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const questions = { id: 'q', questions: [{ title: '去哪？', options: ['看海', '爬山'] }, { title: '备注？', options: null }] };
const reply = { questionId: 'q', questionIndex: 0 };
function surface(actions: Partial<AsyncQuestionActions> = {}) {
  return <AsyncQuestionContext.Provider value={{ answered: [], queued: [], disabled: false, onReply: vi.fn(async () => true), onCompose: vi.fn(), ...actions }}><AsyncQuestionCard questions={questions} /></AsyncQuestionContext.Provider>;
}

describe('async question interaction', () => {
  it('hands off the reply target with the composer before a delayed failed receipt', async () => {
    const { result } = renderHook(() => useAsyncQuestionComposerDraft('session'));
    act(() => result.current.setDraft({ sessionId: 'session', reply, title: '去哪？' }));
    const submitted = result.current.capture();
    let rejectAdmission!: (error: Error) => void;
    const admission = new Promise<boolean>((_resolve, reject) => { rejectAdmission = reject; });
    const clearComposer = vi.fn();
    act(() => result.current.handoff(submitted, clearComposer));
    expect(clearComposer).toHaveBeenCalledOnce();
    expect(result.current.target).toBeNull();
    expect(result.current.capture()).toBeNull();
    await act(async () => {
      rejectAdmission(new Error('rejected'));
      await admission.catch(() => false);
    });
    // A plain new query has no inherited reply identity after rejection.
    expect(result.current.capture()).toBeNull();
  });

  it('preserves a newer draft for the same question and keeps targets Session-scoped', () => {
    const { result, rerender } = renderHook(({ sessionId }) => useAsyncQuestionComposerDraft(sessionId), { initialProps: { sessionId: 'first' } });
    act(() => result.current.setDraft({ sessionId: 'first', reply, title: 'original' }));
    const submitted = result.current.target;
    act(() => result.current.setDraft({ sessionId: 'first', reply, title: 'new draft' }));
    act(() => result.current.handoff(submitted));
    expect(result.current.target?.title).toBe('new draft');
    rerender({ sessionId: 'second' });
    expect(result.current.capture()).toBeNull();
  });

  it('does not capture or consume an independent target when retrying an ordinary failed row', () => {
    const { result } = renderHook(() => useAsyncQuestionComposerDraft('session'));
    act(() => result.current.setDraft({ sessionId: 'session', reply, title: 'independent draft' }));
    const independentDraft = result.current.target;
    const retriedDraft = result.current.capture(undefined, 'failed-ordinary-row');
    expect(retriedDraft).toBeNull();
    expect(retriedDraft?.reply).toBeUndefined();
    act(() => result.current.handoff(retriedDraft));
    expect(result.current.target).toBe(independentDraft);
    expect(result.current.capture(reply)).toBeNull();
    expect(result.current.capture()).toBe(independentDraft);
  });

  it('keeps a locally failed answer retryable until canonical user acceptance', () => {
    const local = { role: 'user' as const, asyncQuestionReply: reply, deliveryStatus: 'failed' as const };
    const view = render(surface({ answered: acceptedAsyncQuestionReplies([local]) }));
    expect(screen.queryByText('asyncQuestion.answered')).toBeNull();
    expect(screen.getAllByText('asyncQuestion.compose')[0]).toBeEnabled();
    view.rerender(surface({ answered: acceptedAsyncQuestionReplies([{ ...local, deliveryStatus: undefined }]) }));
    expect(screen.getByText('asyncQuestion.answered')).toBeTruthy();
  });

  it('sends to the same question once and separates HTTP pending, queue, and acceptance', async () => {
    let resolve!: (value: boolean) => void;
    const onReply = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const view = render(surface({ onReply }));
    fireEvent.click(screen.getByText('看海'));
    fireEvent.click(screen.getByText('爬山'));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(reply, '去哪？\n\n看海');
    expect(screen.getByText('asyncQuestion.sending')).toBeTruthy();
    view.rerender(surface({ onReply, queued: [reply] }));
    await act(async () => { resolve(true); });
    expect(screen.getByText('asyncQuestion.queued')).toBeTruthy();
    expect(screen.queryByText('asyncQuestion.answered')).toBeNull();
    view.rerender(surface({ onReply, answered: [reply] }));
    expect(screen.getByText('asyncQuestion.answered')).toBeTruthy();
    fireEvent.click(screen.getByText('看海'));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('allows retry after rejection or queue cancellation and keeps other questions independent', async () => {
    const onReply = vi.fn(async () => false);
    const onCompose = vi.fn();
    const view = render(surface({ onReply, onCompose }));
    await act(async () => { fireEvent.click(screen.getByText('看海')); });
    expect(screen.getByText('asyncQuestion.failed')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText('看海')); });
    expect(onReply).toHaveBeenCalledTimes(2);
    view.rerender(surface({ onReply, onCompose, queued: [reply] }));
    fireEvent.click(screen.getAllByText('asyncQuestion.compose')[1]);
    expect(onCompose).toHaveBeenCalledWith({ questionId: 'q', questionIndex: 1 }, '备注？');
    view.rerender(surface({ onReply, onCompose }));
    await act(async () => { fireEvent.click(screen.getByText('爬山')); });
    expect(onReply).toHaveBeenCalledTimes(3);
  });

  it('disables answered historical cards after remount', () => {
    const onReply = vi.fn(async () => true);
    render(surface({ answered: [reply], onReply }));
    fireEvent.click(screen.getByText('看海'));
    expect(onReply).not.toHaveBeenCalled();
  });
});
