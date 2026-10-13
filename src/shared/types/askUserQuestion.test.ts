import { describe, it, expect } from 'vitest';
import { normalizeAskUserQuestionInput, withQuestionTextAnswerKeys, type AskUserQuestion } from './askUserQuestion';

const q = (question: string, extra: Partial<AskUserQuestion> = {}): AskUserQuestion => ({
  question,
  header: 'H',
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
  ],
  multiSelect: false,
  ...extra,
});

describe('withQuestionTextAnswerKeys', () => {
  // The bug: SDK 0.3.158's builtin AskUserQuestion tool looks each answer up by
  // question TEXT (answers[question.question]); the renderer keyed by index, so
  // the model was told "The user did not answer the questions."
  it('aliases index-keyed builtin answers by question text (0.2.119→0.3.158 regression)', () => {
    const questions = [q('请你定一件事：要不要配图？')];
    const out = withQuestionTextAnswerKeys(questions, { '0': '纯文字纸墨版' });
    // SDK binary reads answers[question.text] — must be present now.
    expect(out['请你定一件事：要不要配图？']).toBe('纯文字纸墨版');
    // Original index key is preserved so the Codex runtime still matches.
    expect(out['0']).toBe('纯文字纸墨版');
  });

  it('aliases every question in a multi-question form', () => {
    const questions = [q('Q1?'), q('Q2?')];
    const out = withQuestionTextAnswerKeys(questions, { '0': 'A', '1': 'B' });
    expect(out['Q1?']).toBe('A');
    expect(out['Q2?']).toBe('B');
  });

  it('keeps id-keyed (Codex) answers and adds the text alias for the SDK binary', () => {
    const questions = [q('Pick one?', { id: 'codex-123' })];
    const out = withQuestionTextAnswerKeys(questions, { 'codex-123': 'A' });
    expect(out['codex-123']).toBe('A'); // Codex reads this
    expect(out['Pick one?']).toBe('A'); // SDK binary reads this
  });

  it('preserves comma-joined multi-select values verbatim', () => {
    const questions = [q('Which features?', { multiSelect: true })];
    const out = withQuestionTextAnswerKeys(questions, { '0': 'A,B' });
    expect(out['Which features?']).toBe('A,B');
  });

  it('does not invent an answer for a skipped optional question', () => {
    const questions = [q('Required?'), q('Optional?', { required: false })];
    // Renderer omits the optional question's key when nothing was selected.
    const out = withQuestionTextAnswerKeys(questions, { '0': 'A' });
    expect(out['Required?']).toBe('A');
    expect('Optional?' in out).toBe(false);
  });

  it('returns answers unchanged when questions are missing', () => {
    expect(withQuestionTextAnswerKeys(undefined, { '0': 'A' })).toEqual({ '0': 'A' });
  });

  it('is idempotent when answers are already keyed by text', () => {
    const questions = [q('Q1?')];
    const out = withQuestionTextAnswerKeys(questions, { 'Q1?': 'A' });
    expect(out).toEqual({ 'Q1?': 'A' });
  });

  // Characterization: two questions with IDENTICAL text collapse to one text key (first-wins,
  // via `if (text in merged) return`). This is inherent to the SDK contract — the binary builds
  // its result with `answers[question.text]`, so same-text questions are indistinguishable to the
  // SDK by construction and BOTH resolve to the first answer. We deliberately do NOT fight that
  // with index fallbacks (the SDK never reads them for the builtin tool). Pin the behavior so a
  // future refactor doesn't silently change it.
  it('collapses duplicate-text questions to the first answer (matches SDK text-keying)', () => {
    const questions = [q('Same?'), q('Same?')];
    const out = withQuestionTextAnswerKeys(questions, { '0': 'first', '1': 'second' });
    expect(out['Same?']).toBe('first'); // first-wins; SDK reads this for BOTH questions
    // Index keys are still preserved verbatim for any id/index consumer (e.g. Codex).
    expect(out['0']).toBe('first');
    expect(out['1']).toBe('second');
  });
});


describe('normalizeAskUserQuestionInput', () => {
  it('normalizes screenshot-shaped single-select input without changing answer text', () => {
    const question = { question: '本次走哪个执行渠道？', header: '执行渠道', options: [
      { label: '当前 Agent', description: '本机实现' }, { label: '摩灵', description: '员工执行' },
    ] };
    const raw = { questions: [question], metadata: { source: 'fixture' } };
    expect(normalizeAskUserQuestionInput(raw)).toEqual({ ok: true, input: {
      ...raw, questions: [{ ...question, multiSelect: false }],
    } });
    expect(question).not.toHaveProperty('multiSelect');
  });
  it('preserves native ids, optional/secret questions, multi-select and free-text forms', () => {
    const input = { questions: [q('Select', { id: 'choose', multiSelect: true }),
      q('Secret', { id: 'secret', options: [], required: false, isSecret: true })] };
    expect(normalizeAskUserQuestionInput(input)).toEqual({ ok: true, input });
  });
  it.each([null, [], 'A', { label: null }, { label: 'A', description: {} }, { label: 'A', preview: {} }])(
    'rejects malformed options before rendering: %j', option => {
      const result = normalizeAskUserQuestionInput({ questions: [{ ...q('Choose'), options: [option] }] });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('options[0]') });
    },
  );
  it('defaults an omitted description but rejects duplicate answer labels and ids', () => {
    expect(normalizeAskUserQuestionInput({ questions: [{ ...q('Choose'), options: [{ label: 'A' }] }] })).toMatchObject({
      ok: true, input: { questions: [{ options: [{ label: 'A', description: '' }] }] },
    });
    expect(normalizeAskUserQuestionInput({ questions: [{ ...q('Choose'), options: [q('Q').options[0], q('Q').options[0]] }] }).ok).toBe(false);
    expect(normalizeAskUserQuestionInput({ questions: [q('First', { id: 'same' }), q('Second', { id: 'same' })] }).ok).toBe(false);
  });
  it.each([null, [], {}, { questions: [] }, { questions: [null] }, { questions: [{ ...q('Choose'), multiSelect: 'false' }] }])(
    'reports invalid input without a cancellation: %j', input => {
      expect(normalizeAskUserQuestionInput(input)).toMatchObject({ ok: false, error: expect.stringContaining('Correct the input') });
    },
  );
});
