import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMetadata } from '@/api/sessionClient';
import type { Task } from '@/../shared/types/task';

import { DispatchTaskDialog } from './DispatchTaskDialog';
import { TaskEditPanel } from './TaskEditPanel';
import { TaskDocBlock } from './TaskDocBlock';
import { TaskSessionsList } from './TaskSessionsList';
import { TaskStatusBadge } from './TaskStatusBadge';
import { TaskListPanel } from './TaskListPanel';
import { TaskCardItem } from './views/TaskCardItem';
import { TaskItemActions } from './views/TaskItemActions';
import { __setTaskCenterSessionsForTest } from '@/hooks/taskCenterStore';

const taskApiMocks = vi.hoisted(() => ({
  getSessions: vi.fn(),
  taskGetRunStats: vi.fn(),
  taskCreateDirect: vi.fn(),
  taskList: vi.fn(),
  taskRun: vi.fn(),
  taskRerun: vi.fn(),
  taskDelete: vi.fn(),
  taskReadDoc: vi.fn(),
  taskOpenDocsDir: vi.fn(),
  taskUpdate: vi.fn(),
  taskWriteDoc: vi.fn(),
}));

const analyticsMocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock('@/api/sessionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sessionClient')>();
  return {
    ...actual,
    getSessions: taskApiMocks.getSessions,
  };
});

vi.mock('@/api/taskCenter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/taskCenter')>();
  return {
    ...actual,
    taskGetRunStats: taskApiMocks.taskGetRunStats,
    taskCreateDirect: taskApiMocks.taskCreateDirect,
    taskList: taskApiMocks.taskList,
    taskRun: taskApiMocks.taskRun,
    taskRerun: taskApiMocks.taskRerun,
    taskDelete: taskApiMocks.taskDelete,
    taskReadDoc: taskApiMocks.taskReadDoc,
    taskOpenDocsDir: taskApiMocks.taskOpenDocsDir,
    taskUpdate: taskApiMocks.taskUpdate,
    taskWriteDoc: taskApiMocks.taskWriteDoc,
  };
});

vi.mock('@/analytics', () => ({
  track: analyticsMocks.track,
}));

const modelProviders = [{
  id: 'grouped', name: 'Model Provider', type: 'api', config: {},
  primaryModel: 'example', models: [{ model: 'example', modelName: 'Example Model' }],
}];
vi.mock('@/hooks/useAvailableProviders', () => ({ useAvailableProviders: () => modelProviders }));
vi.mock('@/hooks/useBrowserResourceReady', () => ({ useBrowserResourceReady: () => false }));
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    projects: [
      {
        id: 'workspace-1',
        name: 'mino',
        displayName: 'mino',
        path: '/Users/me/mino',
        isHidden: false,
      },
      {
        id: 'workspace-2',
        name: 'research',
        displayName: 'Research Agent',
        path: '/Users/me/research',
        isHidden: false,
      },
    ],
    providers: modelProviders, config: {}, apiKeys: {}, providerVerifyStatus: {},
  }),
}));

vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/task-center/NotificationConfigEditor', () => ({
  default: () => <div>任务通知配置</div>,
}));
vi.mock('./views/TaskListRow', () => ({
  TaskListRow: ({
    task,
    onRun,
    onRerun,
    onDelete,
  }: {
    task?: Task;
    onRun?: () => void;
    onRerun?: () => void;
    onDelete?: () => void;
  }) => (
    <div>
      <span>{task?.name}</span>
      <button type="button" onClick={onDelete}>删除测试任务</button>
      <button type="button" title="更多操作">
        更多操作
      </button>
      {task?.status === 'todo' ? (
        <button type="button" onClick={onRun}>
          立即执行
        </button>
      ) : (
        <button type="button" onClick={onRerun}>
          重新派发
        </button>
      )}
    </div>
  ),
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: '每日 AI 行业新闻与暴论',
    executor: 'agent',
    workspaceId: 'workspace-1',
    workspacePath: '/Users/me/mino',
    executionMode: 'recurring',
    runMode: 'new-session',
    sessionIds: [],
    status: 'running',
    tags: [],
    createdAt: Date.parse('2026-06-20T00:00:00+08:00'),
    updatedAt: Date.parse('2026-06-27T11:12:00+08:00'),
    statusHistory: [],
    dispatchOrigin: 'direct',
    ...overrides,
  };
}

function expectedTaskSessionTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return d.getFullYear() === now.getFullYear()
    ? `${mm}-${dd} ${hh}:${mi}`
    : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

describe('Task Center UX refinements', () => {
  it('requires UI confirmation before deleting, supports cancellation and keeps a failed delete retryable', async () => {
    taskApiMocks.taskList.mockResolvedValue([task({ status: 'done' })]);
    taskApiMocks.taskDelete.mockRejectedValueOnce(new Error('delete failed')).mockResolvedValueOnce(undefined);
    // Tauri can expose confirm as async; its Promise must not authorize deletion.
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => Promise.resolve(false) as unknown as boolean);
    try {
      render(<TaskListPanel onCreateTask={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: '删除测试任务' }));
      expect(taskApiMocks.taskDelete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(taskApiMocks.taskDelete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: '删除测试任务' }));
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await waitFor(() => expect(taskApiMocks.taskDelete).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByRole('button', { name: '删除' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: '删除' }));
      await waitFor(() => expect(taskApiMocks.taskDelete).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('button', { name: '删除测试任务' })).not.toBeInTheDocument());
      expect(confirm).not.toHaveBeenCalled();
    } finally { confirm.mockRestore(); }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.setItem('myagents:task-center:view', 'list');
    taskApiMocks.taskGetRunStats.mockResolvedValue({ executionCount: 0 });
    taskApiMocks.taskList.mockResolvedValue([]);
    taskApiMocks.getSessions.mockResolvedValue([]);
    taskApiMocks.taskReadDoc.mockResolvedValue('# Task body');
    taskApiMocks.taskOpenDocsDir.mockResolvedValue(undefined);
    taskApiMocks.taskUpdate.mockImplementation(async (input) =>
      task({
        status: 'stopped',
        workspaceId: input.workspaceId ?? 'workspace-1',
        workspacePath: input.workspacePath ?? '/Users/me/mino',
      }),
    );
    __setTaskCenterSessionsForTest([]);
  });

  it('defaults the task panel to list view when no preference is stored', async () => {
    window.localStorage.removeItem('myagents:task-center:view');

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTitle(/列表视图|List view/)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
    expect(screen.getByTitle(/卡片视图|Card view/)).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('keeps an explicit card preference and persists a later list choice', async () => {
    window.localStorage.setItem('myagents:task-center:view', 'card');

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTitle(/卡片视图|Card view/)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    fireEvent.click(screen.getByTitle(/列表视图|List view/));

    expect(window.localStorage.getItem('myagents:task-center:view')).toBe(
      'list',
    );
    expect(screen.getByTitle(/列表视图|List view/)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('separates recoverable work and reveals completed rows ten at a time', async () => {
    const completed = Array.from({ length: 12 }, (_, index) =>
      task({
        id: `done-${index + 1}`,
        name: `已完成任务 ${index + 1}`,
        status: 'done',
        executionMode: 'once',
        updatedAt: Date.parse('2026-08-22T12:00:00+08:00') - index * 1_000,
      }),
    );
    taskApiMocks.taskList.mockResolvedValueOnce([
      task({ id: 'active', name: '正在运行任务', status: 'running' }),
      task({ id: 'stopped', name: '等待恢复任务', status: 'stopped' }),
      ...completed,
      task({ id: 'planned', name: '尚未启动任务', status: 'todo' }),
    ]);

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    const active = await screen.findByText('进行中');
    const recovery = screen.getByText('待恢复');
    const finished = screen.getByText('已完成');
    const planned = screen.getByText('规划中');
    expect(
      active.compareDocumentPosition(recovery) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      recovery.compareDocumentPosition(finished) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      finished.compareDocumentPosition(planned) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('等待恢复任务')).toBeInTheDocument();
    expect(screen.getByText('已完成任务 10')).toBeInTheDocument();
    expect(screen.queryByText('已完成任务 11')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    expect(screen.getByText('已完成任务 11')).toBeInTheDocument();
    expect(screen.getByText('已完成任务 12')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '加载更多' }),
    ).not.toBeInTheDocument();
  });

  it('shows all matching completed rows while searching and resets the list limit afterwards', async () => {
    taskApiMocks.taskList.mockResolvedValueOnce(
      Array.from({ length: 12 }, (_, index) =>
        task({
          id: `report-${index + 1}`,
          name: `归档报告 ${index + 1}`,
          status: 'done',
          executionMode: 'once',
          updatedAt: Date.parse('2026-08-22T12:00:00+08:00') - index * 1_000,
        }),
      ),
    );

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    await screen.findByText('归档报告 10');
    expect(screen.queryByText('归档报告 11')).not.toBeInTheDocument();
    const search = screen.getByPlaceholderText(/搜索任务|Search tasks/);
    fireEvent.change(search, { target: { value: '归档报告' } });
    expect(screen.getByText('归档报告 12')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '' } });
    expect(screen.queryByText('归档报告 11')).not.toBeInTheDocument();
  });

  it('tracks a run only after using the ordinal accepted by the Task owner', async () => {
    const accepted = task({
      status: 'running',
      executionMode: 'once',
      sessionIds: ['shared-session'],
    });
    taskApiMocks.taskList.mockResolvedValueOnce([
      task({
        status: 'todo',
        executionMode: 'once',
        sessionIds: [],
      }),
    ]);
    taskApiMocks.taskRun.mockResolvedValueOnce({
      task: accepted,
      attemptOrdinal: 6,
    });

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    await screen.findByText('每日 AI 行业新闻与暴论');
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    fireEvent.click(screen.getByText('立即执行'));

    await waitFor(() =>
      expect(taskApiMocks.taskRun).toHaveBeenCalledWith('task-1'),
    );
    expect(analyticsMocks.track).toHaveBeenCalledWith('task_run', {
      source: 'desktop',
      run_count: 6,
    });
  });

  it('does not track a run rejected before admission', async () => {
    taskApiMocks.taskList.mockResolvedValueOnce([
      task({ status: 'todo', executionMode: 'once' }),
    ]);
    taskApiMocks.taskRun.mockRejectedValueOnce(new Error('task is busy'));

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    await screen.findByText('每日 AI 行业新闻与暴论');
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    fireEvent.click(screen.getByText('立即执行'));

    await waitFor(() =>
      expect(taskApiMocks.taskRun).toHaveBeenCalledWith('task-1'),
    );
    expect(analyticsMocks.track).not.toHaveBeenCalled();
  });

  it('tracks rerun with the same accepted ordinal contract', async () => {
    const stopped = task({
      status: 'stopped',
      executionMode: 'once',
      sessionIds: [],
    });
    taskApiMocks.taskList.mockResolvedValueOnce([stopped]);
    taskApiMocks.taskRerun.mockResolvedValueOnce({
      task: { ...stopped, status: 'running' },
      attemptOrdinal: 5,
    });

    render(<TaskListPanel onCreateTask={vi.fn()} />);

    await screen.findByText('每日 AI 行业新闻与暴论');
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    fireEvent.click(screen.getByText('重新派发'));

    await waitFor(() =>
      expect(taskApiMocks.taskRerun).toHaveBeenCalledWith('task-1'),
    );
    expect(analyticsMocks.track).toHaveBeenCalledWith('task_run', {
      source: 'desktop',
      run_count: 5,
    });
  });

  it('does not render latest status messages on task cards', () => {
    render(
      <TaskCardItem
        task={task({
          executionMode: 'once',
          statusHistory: [
            {
              from: 'running',
              to: 'blocked',
              at: Date.parse('2026-06-27T11:12:00+08:00'),
              actor: 'system',
              source: 'crash',
              message: '上次运行被应用重启中断，调度器将在下次计划时间继续',
            },
          ],
        })}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/上次运行被应用重启中断/),
    ).not.toBeInTheDocument();
  });

  it('keeps exact lifecycle status out of cards while retaining the execution category', () => {
    render(
      <TaskCardItem
        task={task({ executionMode: 'once', status: 'running' })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByText('进行中')).not.toBeInTheDocument();
    expect(screen.getAllByText('一次性')).not.toHaveLength(0);
  });

  it('marks command Detector tasks in the normal task list surface', () => {
    render(
      <TaskCardItem
        task={task({
          trigger: {
            source: { type: 'time' },
            detector: {
              type: 'command',
              command: { executable: 'node', args: ['detector.js'] },
            },
          },
        })}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('命令感知')).toBeInTheDocument();
  });

  it('projects a failed stop separately from the persisted stopped status', () => {
    render(<TaskStatusBadge status="stopped" executionState="stop_failed" />);

    expect(screen.getByText('停止未确认')).toBeInTheDocument();
  });

  it('uses a stronger neutral surface for paused detail status', () => {
    render(<TaskStatusBadge status="stopped" />);

    expect(screen.getByText('已暂停')).toHaveClass(
      'bg-[var(--line-strong)]',
      'text-[var(--ink-secondary)]',
    );
  });

  it('offers retry-stop but no generic rerun for terminal attached work', () => {
    const retryStop = vi.fn();
    const { rerender } = render(
      <TaskItemActions
        variant="task"
        status="stopped"
        executionState="stop_failed"
        canRerun={false}
        onStop={retryStop}
        onOpenDetail={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    expect(screen.queryByText('删除')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('重试中止'));
    expect(retryStop).toHaveBeenCalledOnce();

    rerender(
      <TaskItemActions
        variant="task"
        status="done"
        canRerun={false}
        onRerun={vi.fn()}
        onOpenDetail={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle(/更多操作|More actions/));
    expect(screen.queryByText('重新派发')).not.toBeInTheDocument();
  });

  it('uses launcher session title fallback and keeps execution timestamps on one line', async () => {
    const session: SessionMetadata = {
      id: 'session-1',
      agentDir: '/Users/me/mino',
      title: 'New Chat',
      lastMessagePreview: '每日 AI 行业新闻采集与总结',
      createdAt: '2026-06-27T03:12:00.000Z',
      lastActiveAt: '2026-06-27T03:12:00.000Z',
    };
    taskApiMocks.getSessions.mockResolvedValueOnce([session]);

    render(<TaskSessionsList task={task({ sessionIds: ['session-1'] })} />);

    expect(
      await screen.findByText('每日 AI 行业新闻采集与总结'),
    ).toBeInTheDocument();
    expect(screen.queryByText('New Chat')).not.toBeInTheDocument();

    const timestamp = screen.getByText(
      expectedTaskSessionTimestamp(session.lastActiveAt),
    );
    expect(timestamp).toHaveClass('whitespace-nowrap', 'tabular-nums');
    expect(taskApiMocks.getSessions).toHaveBeenCalledWith('/Users/me/mino');
  });

  it('reveals Task execution sessions five at a time with compact row typography', async () => {
    const sessions: SessionMetadata[] = Array.from(
      { length: 12 },
      (_, index) => ({
        id: `session-${index + 1}`,
        agentDir: '/Users/me/mino',
        title: `Execution ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 5, 27, 3, index)).toISOString(),
        lastActiveAt: new Date(Date.UTC(2026, 5, 27, 3, index)).toISOString(),
      }),
    );
    taskApiMocks.getSessions.mockResolvedValueOnce(sessions);

    render(
      <TaskSessionsList
        task={task({ sessionIds: sessions.map((session) => session.id) })}
      />,
    );

    expect(await screen.findByText('Execution 12')).toHaveClass('text-xs');
    expect(screen.getByText('Execution 8')).toBeInTheDocument();
    expect(screen.queryByText('Execution 7')).not.toBeInTheDocument();

    const expandMore = screen.getByRole('button', { name: '展开更多' });
    expect(expandMore).toHaveClass('w-full', 'justify-between');
    expect(expandMore.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(expandMore);
    expect(screen.getByText('Execution 7')).toBeInTheDocument();
    expect(screen.queryByText('Execution 2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开更多' }));
    expect(screen.getByText('Execution 1')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '展开更多' }),
    ).not.toBeInTheDocument();
  });

  it('shows the canonical Task path with a home-relative prefix and no redundant heading', async () => {
    const taskWithDocs = task({
      docs: {
        dir: '/Users/zhihu/.myagents/tasks/task-1',
        taskMd: '/Users/zhihu/.myagents/tasks/task-1/task.md',
      },
    });

    render(
      <TaskDocBlock
        task={taskWithDocs}
        doc="task"
        emptyHint="empty"
        collapsible={false}
        onError={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole('button', {
        name: '~/.myagents/tasks/task-1/task.md',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('task.md · 执行 Prompt')).not.toBeInTheDocument();
    expect(
      screen.queryByText('/Users/zhihu/.myagents/tasks/task-1/task.md'),
    ).not.toBeInTheDocument();
  });

  it('starts the manual create form with one canonical task document and workspace configuration', async () => {
    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        initialMode="manual"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );

    expect(screen.queryByText('基本信息')).not.toBeInTheDocument();
    expect(screen.queryByText('简短描述')).not.toBeInTheDocument();
    expect(screen.queryByText('标签')).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('以逗号分隔，例如 MyAgents, 维护'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('任务需求 Task.md')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'AI 执行时看到的 prompt，默认取自记录原文。你可以补充细节、目标、约束。',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(
        'AI 执行时看到的 prompt，默认取自记录原文。你可以补充细节、目标、约束。',
      ),
    ).toBeInTheDocument();

    const name = screen.getByText('任务名称');
    const taskDemand = screen.getByText('任务需求 Task.md');
    const workspace = screen.getByText('Agent 工作区');
    expect(screen.queryByText('验收清单')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        name.compareDocumentPosition(taskDemand) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        taskDemand.compareDocumentPosition(workspace) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it('shows conversation strategy and pre-trigger checks only for recurring creation', () => {
    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        initialMode="manual"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );

    expect(screen.queryByText('会话策略')).not.toBeInTheDocument();
    expect(screen.queryByText('触发前检测')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '定时一次' }));
    expect(screen.queryByText('会话策略')).not.toBeInTheDocument();
    expect(screen.queryByText('触发前检测')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '周期触发' }));
    expect(screen.getByText('会话策略')).toBeInTheDocument();
    expect(screen.getByText('触发前检测')).toBeInTheDocument();
  });

  it('keeps Task edit fields and mode-specific controls aligned with manual creation', async () => {
    render(
      <TaskEditPanel
        task={task({
          status: 'stopped',
          executionMode: 'once',
          description: 'legacy description',
          tags: ['legacy-tag'],
        })}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await screen.findByDisplayValue('# Task body');
    expect(screen.queryByText('简短描述')).not.toBeInTheDocument();
    expect(screen.queryByText('标签')).not.toBeInTheDocument();

    const taskDocument = screen.getByText('task.md · 执行 Prompt');
    const workspace = screen.getByText('Agent 工作区');
    const advanced = screen.getAllByText('高级配置')[0];
    expect(
      taskDocument.compareDocumentPosition(workspace) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      workspace.compareDocumentPosition(advanced) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(screen.queryByText('会话策略')).not.toBeInTheDocument();
    expect(screen.queryByText('触发前检测')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '定时一次' }));
    expect(screen.queryByText('会话策略')).not.toBeInTheDocument();
    expect(screen.queryByText('触发前检测')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '周期触发' }));
    expect(screen.getByText('会话策略')).toBeInTheDocument();
    expect(screen.getByText('触发前检测')).toBeInTheDocument();
  });

  it('clears a fixed task model only when the edited task is saved', async () => {
    const props = { task: task({ status: 'stopped', executionMode: 'once', providerId: 'grouped', model: 'example' }),
      onSaved: vi.fn(), onCancel: vi.fn(), onError: vi.fn() };
    for (const action of ['取消', '保存']) {
      const view = render(<TaskEditPanel {...props} />);
      await screen.findByDisplayValue('# Task body');
      fireEvent.click(screen.getByRole('button', { name: /Model Provider.*Example Model/ }));
      expect(screen.getByRole('button', { current: true })).toHaveTextContent('Example Model');
      fireEvent.click(screen.getByRole('button', { name: '跟随 Agent 工作区' }));
      expect(taskApiMocks.taskUpdate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: action }));
      if (action === '取消') expect(taskApiMocks.taskUpdate).not.toHaveBeenCalled();
      else await waitFor(() => expect(taskApiMocks.taskUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ clearProviderOverride: true })));
      view.unmount();
    }
  });

  it('persists workspace reassignment as one pair and normalizes hidden once-only state', async () => {
    const onSaved = vi.fn();
    render(
      <TaskEditPanel
        task={task({
          status: 'stopped',
          executionMode: 'once',
          runMode: 'single-session',
          preselectedSessionId: 'legacy-session',
          trigger: {
            source: { type: 'time' },
            detector: {
              type: 'command',
              command: { executable: 'node', args: ['detector.js'] },
            },
          },
        })}
        onSaved={onSaved}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await screen.findByDisplayValue('# Task body');
    fireEvent.click(screen.getByRole('button', { name: 'mino' }));
    fireEvent.click(screen.getByRole('button', { name: 'Research Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(taskApiMocks.taskUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'workspace-2',
          workspacePath: '/Users/me/research',
          executionMode: 'once',
          runMode: 'new-session',
          preselectedSessionId: '',
          clearTrigger: true,
        }),
      ),
    );
    const payload = taskApiMocks.taskUpdate.mock.calls[0][0];
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('tags');
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('defaults to the accessible smart flow and retains its draft when launch is rejected', async () => {
    const onClose = vi.fn();
    const onDiscuss = vi.fn().mockResolvedValue(false);
    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        onClose={onClose}
        onDispatched={vi.fn()}
        onDiscuss={onDiscuss}
      />,
    );

    expect(
      screen.getByRole('dialog', { name: '新建任务' }),
    ).toBeInTheDocument();
    const smartTab = screen.getByRole('tab', { name: '智能' });
    expect(smartTab).toHaveAttribute('aria-selected', 'true');
    const prompt = screen.getByPlaceholderText(/请输入您希望创建或推进任务/);
    fireEvent.change(prompt, { target: { value: '每天检查高危依赖' } });
    fireEvent.click(screen.getByRole('button', { name: '与 AI 讨论' }));

    await waitFor(() =>
      expect(onDiscuss).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '每天检查高危依赖',
          workspaceId: 'workspace-1',
          workspacePath: '/Users/me/mino',
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '与 AI 讨论' })).toBeEnabled(),
    );
    expect(prompt).toHaveValue('每天检查高危依赖');
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(smartTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '手动' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('submits the manual task.md directly as the canonical task document', async () => {
    taskApiMocks.taskCreateDirect.mockResolvedValue(
      task({
        name: '整理交付清单',
        executionMode: 'once',
        status: 'todo',
      }),
    );
    taskApiMocks.taskRun.mockResolvedValue(true);
    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        initialMode="manual"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
        onDiscuss={vi.fn().mockResolvedValue(true)}
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText('例如: 升级 OpenClaw lark 适配器到 v2.4'),
      {
        target: { value: '整理交付清单' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        'AI 执行时看到的 prompt，默认取自记录原文。你可以补充细节、目标、约束。',
      ),
      {
        target: { value: '# 目标\n整理本周交付。' },
      },
    );
    fireEvent.click(screen.getByText('高级配置'));
    fireEvent.click(screen.getByRole('button', { name: '跟随 Agent 工作区' }));
    const taskName = screen.getByDisplayValue('整理交付清单');
    fireEvent.mouseDown(taskName.closest('[data-overlay-backdrop]')!);
    expect(screen.queryByRole('button', { name: 'Example Model' })).toBeNull();
    expect(taskName).toHaveValue('整理交付清单');
    fireEvent.click(screen.getByRole('button', { name: '跟随 Agent 工作区' }));
    expect(screen.getByRole('button', { current: true })).toHaveTextContent('跟随 Agent');
    fireEvent.click(screen.getByRole('button', { name: 'Example Model' }));
    expect(taskApiMocks.taskCreateDirect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() =>
      expect(taskApiMocks.taskCreateDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'grouped', model: 'example',
          taskMdContent: '# 目标\n整理本周交付。',
        }),
      ),
    );
    expect(taskApiMocks.taskWriteDoc).not.toHaveBeenCalled();
  });

  it('creates a blank task without exposing or synthesizing tags', async () => {
    taskApiMocks.taskCreateDirect.mockResolvedValue(
      task({
        name: '整理交付清单',
        executionMode: 'once',
        status: 'todo',
      }),
    );
    taskApiMocks.taskRun.mockResolvedValue(true);

    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        initialMode="manual"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );

    fireEvent.change(
      screen.getByPlaceholderText('例如: 升级 OpenClaw lark 适配器到 v2.4'),
      {
        target: { value: '整理交付清单' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        'AI 执行时看到的 prompt，默认取自记录原文。你可以补充细节、目标、约束。',
      ),
      {
        target: { value: '整理本周交付内容并输出检查清单。' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() => {
      expect(taskApiMocks.taskCreateDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: [],
          runMode: 'new-session',
          preselectedSessionId: undefined,
          trigger: undefined,
        }),
      );
    });
  });

  it('materializes an existing Session when continuous conversation is selected', async () => {
    const existing: SessionMetadata = {
      id: 'session-existing',
      agentDir: '/Users/me/mino',
      title: '构建排障上下文',
      createdAt: '2026-08-03T01:00:00.000Z',
      lastActiveAt: '2026-08-03T02:00:00.000Z',
    };
    const other: SessionMetadata = {
      id: 'session-other',
      agentDir: '/Users/me/mino',
      title: '其他排障上下文',
      createdAt: '2026-08-02T01:00:00.000Z',
      lastActiveAt: '2026-08-02T02:00:00.000Z',
    };
    __setTaskCenterSessionsForTest([other, existing]);
    taskApiMocks.taskCreateDirect.mockResolvedValue(
      task({
        executionMode: 'recurring',
        runMode: 'single-session',
        preselectedSessionId: existing.id,
        status: 'todo',
      }),
    );
    taskApiMocks.taskRun.mockResolvedValue(true);

    render(
      <DispatchTaskDialog
        defaultWorkspacePath="/Users/me/mino"
        currentSessionId="session-existing"
        initialMode="manual"
        onClose={vi.fn()}
        onDispatched={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText('例如: 升级 OpenClaw lark 适配器到 v2.4'),
      {
        target: { value: '等待构建完成' },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        'AI 执行时看到的 prompt，默认取自记录原文。你可以补充细节、目标、约束。',
      ),
      {
        target: { value: '构建失败后分析日志。' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: '周期触发' }));
    fireEvent.click(screen.getByRole('button', { name: '连续对话' }));
    // The actual current Session is selected by default; opening that selector
    // must still expose the distinction from other workspace Sessions.
    fireEvent.click(
      screen.getByRole('button', { name: '当前 Session · 构建排障上下文' }),
    );
    const currentSessionButtons = screen.getAllByRole('button', {
      name: '当前 Session · 构建排障上下文',
    });
    expect(currentSessionButtons).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: '其他 Session · 其他排障上下文' }),
    ).toBeInTheDocument();
    fireEvent.click(currentSessionButtons[1]);
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() =>
      expect(taskApiMocks.taskCreateDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          runMode: 'single-session',
          preselectedSessionId: 'session-existing',
        }),
      ),
    );
  });
});
