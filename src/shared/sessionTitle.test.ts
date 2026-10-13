import { describe, it, expect } from 'vitest';
import {
  stripSystemWrapper,
  deriveSessionTitle,
  buildTitleRoundsFromMessages,
  shouldAttemptAutoTitle,
  capTitleAtBoundary,
  AUTO_TITLE_MIN_ROUNDS,
  TITLE_GEN_MESSAGE_LIMIT,
  MAX_TITLE_GEN_ATTEMPTS,
  boundTitleContext,
  type TitleRoundMessage,
} from './sessionTitle';
import { buildFloatingBallContextReminder, buildGoalContinuationReminder } from './systemReminder';

describe('stripSystemWrapper', () => {
  it('returns plain text unchanged', () => {
    expect(stripSystemWrapper('帮我看看今天的邮件')).toBe('帮我看看今天的邮件');
  });

  it('unwraps a complete system-reminder + CRON_TASK and extracts the task title', () => {
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：# GitHub Issue 自动化处理\n</CRON_TASK>\n</system-reminder>';
    expect(stripSystemWrapper(raw)).toBe('GitHub Issue 自动化处理');
  });

  it('extracts the task title from mixed cron reminders with visible task text', () => {
    const raw = [
      '<system-reminder>',
      '<CRON_TASK>',
      'You are running inside a MyAgents scheduled task execution.',
      'cronTaskId: cron_123',
      '</CRON_TASK>',
      '</system-reminder>',
      '执行任务：# GitHub Issue 自动化处理',
      '',
      '每 6 小时自动 triage',
    ].join('\n');

    expect(stripSystemWrapper(raw)).toBe('GitHub Issue 自动化处理');
  });

  it('recovers content when the wrapper is TRUNCATED before the closing tag (the bug)', () => {
    // This is exactly the shape that used to be stored: slice(0,40) of a wrapped prompt.
    const truncated = '<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 查收今天的所有邮件';
    expect(stripSystemWrapper(truncated)).toBe('请你帮 Ethan 查收今天的所有邮件');
  });

  it('strips HEARTBEAT markers', () => {
    expect(stripSystemWrapper('<HEARTBEAT> mino，心跳唤醒，看看 wishpool')).toBe('mino，心跳唤醒，看看 wishpool');
  });

  it('returns empty for whitespace / empty input', () => {
    expect(stripSystemWrapper('')).toBe('');
    expect(stripSystemWrapper('   \n  ')).toBe('');
  });

  // --- adversarial-review regressions ---

  it('does NOT extract 执行任务 from a plain user message (no <CRON_TASK> marker) [#1]', () => {
    const userMsg = '请解释这段日志：执行任务：#123 然后呢';
    // Must return the message intact, NOT the silently-rewritten capture "123 然后呢".
    expect(stripSystemWrapper(userMsg)).toBe(userMsg);
  });

  it('stops the cron task title at the first newline, not bleeding the body in [#3]', () => {
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：每日简报\n补充说明：要包含 A/B/C 三块内容\n</CRON_TASK>\n</system-reminder>';
    expect(stripSystemWrapper(raw)).toBe('每日简报');
  });

  it('returns empty for an actual wrapper-only string [#7]', () => {
    expect(stripSystemWrapper('<system-reminder>\n<CRON_TASK>\n</CRON_TASK>\n</system-reminder>')).toBe('');
    expect(stripSystemWrapper('<system-reminder></system-reminder>')).toBe('');
  });

  it('keeps the user query after a floating-ball context reminder', () => {
    const raw = `${buildFloatingBallContextReminder({
      appName: 'Safari',
      selectedText: 'selected text',
    })}\n\n解释这段选中文字`;
    expect(stripSystemWrapper(raw)).toBe('解释这段选中文字');
    expect(stripSystemWrapper(buildFloatingBallContextReminder({ screenshotAttached: true }))).toBe('');
  });

  it('does not derive a title from a pure hidden Goal reminder', () => {
    const reminder = buildGoalContinuationReminder({
      objective: '分析这个项目有什么价值',
      goalId: 'goal_title',
      goalStatus: 'active',
      turnNumber: 2,
      aiCanExit: true,
    });

    expect(stripSystemWrapper(reminder)).toBe('');
    expect(deriveSessionTitle(reminder)).toBe('');
  });
});

describe('deriveSessionTitle', () => {
  it('strips the wrapper BEFORE the length cap (regression: no wrapper-only scrap)', () => {
    // The raw is the wrapped cron prompt; a blind slice(0,40) would have stored
    // "<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 E...". After the fix the cap
    // applies to the REAL task text.
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 查收今天的所有未读邮件并按优先级整理成清单\n</CRON_TASK>\n</system-reminder>';
    const title = deriveSessionTitle(raw, 40);
    expect(title.startsWith('请你帮 Ethan')).toBe(true);
    expect(title).not.toContain('<');
    expect(title).not.toContain('CRON_TASK');
    expect(title).not.toContain('执行任务');
  });

  it('does NOT degrade to a 4-char scrap for the reported case', () => {
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 处理邮件\n</CRON_TASK>\n</system-reminder>';
    expect(deriveSessionTitle(raw, 40)).toBe('请你帮 Ethan 处理邮件');
  });

  it('caps at maxLen and appends ellipsis only when actually truncated', () => {
    expect(deriveSessionTitle('短标题', 40)).toBe('短标题');
    const long = 'a'.repeat(60);
    const out = deriveSessionTitle(long, 40);
    expect(out).toBe('a'.repeat(40) + '...');
  });

  it('does not split a surrogate pair at the cap boundary (no lone-surrogate "�")', () => {
    // 39 ASCII + a 2-code-unit emoji straddling the 40-char cap.
    const out = deriveSessionTitle('a'.repeat(39) + '👍tail', 40);
    expect([...out].length).toBe(40 + 3); // 40 code points + "..."
    expect(out.endsWith('👍...')).toBe(true); // emoji kept whole, not severed
    // No UNPAIRED surrogate (a blind UTF-16 slice(0,40) would have left one).
    // isWellFormed() is true iff the string has no lone surrogate.
    expect(out.isWellFormed()).toBe(true);
  });

  it('returns empty for empty/whitespace/wrapper-only input (caller supplies fallback)', () => {
    expect(deriveSessionTitle('', 40)).toBe('');
    expect(deriveSessionTitle('   ', 40)).toBe('');
    expect(deriveSessionTitle(null, 40)).toBe('');
    expect(deriveSessionTitle(undefined, 40)).toBe('');
  });
});

// ─── #296 auto-title: round reconstruction ───

const u = (content: string): TitleRoundMessage => ({ role: 'user', content });
const a = (content: string): TitleRoundMessage => ({ role: 'assistant', content });

describe('buildTitleRoundsFromMessages', () => {
  it('does not summarize an authentication error as a completed answer', () => {
    expect(buildTitleRoundsFromMessages([u('优化费用包'), a('Not logged in · Please run /login')])).toEqual([]);
  });
  it('pairs adjacent user→assistant turns into rounds', () => {
    const rounds = buildTitleRoundsFromMessages([
      u('帮我优化 Redis 缓存'), a('好的，可以从连接池入手'),
      u('连接池怎么配'), a('设置 maxTotal 和 maxIdle'),
    ]);
    expect(rounds).toEqual([
      { user: '帮我优化 Redis 缓存', assistant: '好的，可以从连接池入手' },
      { user: '连接池怎么配', assistant: '设置 maxTotal 和 maxIdle' },
    ]);
  });

  it('extracts text from JSON-stringified assistant ContentBlock[] (disk form)', () => {
    const rounds = buildTitleRoundsFromMessages([
      u('讲个故事'),
      a(JSON.stringify([{ type: 'text', text: '从前有座山' }, { type: 'tool_use', id: 'x' }])),
    ]);
    expect(rounds).toEqual([{ user: '讲个故事', assistant: '从前有座山' }]);
  });

  it('keeps a user message that merely starts with "[" but is not valid JSON', () => {
    const rounds = buildTitleRoundsFromMessages([
      u('[引用回复]\n> 上文\n\n@bot 介绍下项目'), a('这是一个 Agent 产品'),
    ]);
    expect(rounds[0].user).toBe('[引用回复]\n> 上文\n\n@bot 介绍下项目');
  });

  it('drops pure system-injected rounds but keeps mixed user-visible queries', () => {
    const floating = `${buildFloatingBallContextReminder({
      appName: 'Safari',
      selectedText: 'selected text',
    })}\n\n解释这段选中文字`;
    const rounds = buildTitleRoundsFromMessages([
      u('<HEARTBEAT> 心跳唤醒'), a('收到'),
      u('<MEMORY_UPDATE> 更新记忆'), a('已更新'),
      u(buildFloatingBallContextReminder({ screenshotAttached: true })), a('收到截图'),
      u('<system-reminder>\n群聊信息\n</system-reminder>\n\n@bot hi'), a('hello'),
      u(floating), a('这段文字的意思是...'),
      u('帮我查邮件'), a('好的'),
    ]);
    expect(rounds).toEqual([
      { user: '@bot hi', assistant: 'hello' },
      { user: '解释这段选中文字', assistant: '这段文字的意思是...' },
      { user: '帮我查邮件', assistant: '好的' },
    ]);
  });

  it('drops error-shaped assistant rounds so the error text never seeds a title (#245)', () => {
    const rounds = buildTitleRoundsFromMessages([
      u('帮我跑一下'), a('API Error: 400 invalid request'),
      u('再试一次'), a('成功了，结果是 42'),
    ]);
    expect(rounds).toEqual([{ user: '再试一次', assistant: '成功了，结果是 42' }]);
  });

  it('keeps requirements beyond the old 200-character prefix', () => {
    const long = '背景'.repeat(120) + '调整费用包保存校验和毛利展示';
    const rounds = buildTitleRoundsFromMessages([u(long), a(long)]);
    expect(rounds[0].user).toBe(long);
    expect(rounds[0].assistant).toBe(long);
  });

  it('bounds long context while preserving its opening and final request', () => {
    const long = '项目：MoXBots\n' + '背景'.repeat(3000) + '\n请完善公司目标承接界面';
    const rounds = buildTitleRoundsFromMessages([u(long), a(long)]);
    expect([...rounds[0].user]).toHaveLength(2000);
    expect([...rounds[0].assistant]).toHaveLength(500);
    expect(rounds[0].user).toMatch(/^项目：MoXBots/);
    expect(rounds[0].user).toMatch(/请完善公司目标承接界面$/);
    expect(boundTitleContext('👍'.repeat(3000)).isWellFormed()).toBe(true);
  });

  it('ignores a trailing unpaired user message (turn in flight)', () => {
    const rounds = buildTitleRoundsFromMessages([
      u('问题一'), a('回答一'),
      u('问题二，还没回答'),
    ]);
    expect(rounds).toEqual([{ user: '问题一', assistant: '回答一' }]);
  });

  it('lets the caller exclude automatic turns before title generation', () => {
    const rounds = buildTitleRoundsFromMessages([
      u('automatic issue delivery'), a('processed automatically'),
      u('human follow-up'), a('human answer'),
    ], {
      isUserTitleable: index => index === 2,
    });

    expect(rounds).toEqual([{ user: 'human follow-up', assistant: 'human answer' }]);
  });
});

describe('shouldAttemptAutoTitle', () => {
  it('summarizes after the first completed human turn', () => {
    expect(shouldAttemptAutoTitle({ titleSource: 'default', userMessageCount: 1 })).toBe(true);
  });
  it('attempts for a fresh session with enough user turns', () => {
    expect(shouldAttemptAutoTitle({ userMessageCount: AUTO_TITLE_MIN_ROUNDS })).toBe(true);
    expect(shouldAttemptAutoTitle({ titleSource: 'default', userMessageCount: 5 })).toBe(true);
  });

  it('never overwrites an AI-generated or user-renamed title', () => {
    expect(shouldAttemptAutoTitle({ titleSource: 'auto', userMessageCount: 5 })).toBe(false);
    expect(shouldAttemptAutoTitle({ titleSource: 'user', userMessageCount: 5 })).toBe(false);
  });

  it('stops below the min-rounds lower bound (cheap pre-filter)', () => {
    expect(shouldAttemptAutoTitle({ userMessageCount: AUTO_TITLE_MIN_ROUNDS - 1 })).toBe(false);
  });

  it('stops past the message-count upper bound (system-driven session backstop)', () => {
    expect(shouldAttemptAutoTitle({ userMessageCount: TITLE_GEN_MESSAGE_LIMIT + 1 })).toBe(false);
  });

  it('stops after the retry cap is exhausted', () => {
    expect(shouldAttemptAutoTitle({ userMessageCount: 5, titleGenAttempts: MAX_TITLE_GEN_ATTEMPTS })).toBe(false);
    expect(shouldAttemptAutoTitle({ userMessageCount: 5, titleGenAttempts: MAX_TITLE_GEN_ATTEMPTS - 1 })).toBe(true);
  });

  it('allows sessions that exhausted the old 0.2.49 five-attempt cap to retry', () => {
    expect(shouldAttemptAutoTitle({ userMessageCount: 5, titleGenAttempts: 5 })).toBe(true);
  });
});

describe('capTitleAtBoundary', () => {
  it('returns short titles unchanged', () => {
    expect(capTitleAtBoundary('SSE 流式调试', 30)).toBe('SSE 流式调试');
  });

  it('hard-cuts pure CJK at the limit (each glyph is its own word)', () => {
    expect(capTitleAtBoundary('一二三四五六', 4)).toBe('一二三四');
  });

  it('backs off a mid-Latin-word cut to the last whitespace', () => {
    // cap 10 code points would land inside "Computer" → retreat to the space after "Claude".
    expect(capTitleAtBoundary('Claude Computer Use 调研', 10)).toBe('Claude');
    // Same back-off at a larger cap (the half-budget guard used to wrongly hard-cut this).
    expect(capTitleAtBoundary('Claude Computer Use 依赖调研', 12)).toBe('Claude');
  });

  it('hard-cuts a single over-long word with no usable whitespace', () => {
    // No whitespace at all → keep the hard cut rather than gut the title to nothing.
    expect(capTitleAtBoundary('Supercalifragilistic', 10)).toBe('Supercalif');
  });

  it('never appends an ellipsis (a title is a label, not a snippet)', () => {
    expect(capTitleAtBoundary('一二三四五六七八九十', 5)).not.toContain('...');
  });
});
