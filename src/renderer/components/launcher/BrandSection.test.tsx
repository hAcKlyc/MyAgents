import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { forwardRef, useImperativeHandle } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SimpleChatInputHandle } from '@/components/SimpleChatInput';
import { MANAGED_CODEX_PROVIDER, type Project } from '@/config/types';
import { i18n } from '@/i18n';
import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';
import BrandSection, { LauncherHeroBrand } from './BrandSection';

const openExternalMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/openExternal', () => ({ openExternal: openExternalMock }));

const simpleInputHandle = vi.hoisted(() => ({
  processDroppedFiles: vi.fn(async () => undefined),
  processDroppedFilePaths: vi.fn(async () => undefined),
  insertReferences: vi.fn(),
  appendReferenceToken: vi.fn(),
  insertSlashCommand: vi.fn(),
  setValue: vi.fn(),
  setImages: vi.fn(),
  focus: vi.fn(),
  clearWorkspaceBoundDraft: vi.fn(() => ({
    strippedReferences: 0,
    clearedImages: 0,
  })),
  clearQueryContext: vi.fn(),
      getQueryContext: vi.fn(() => ({})),
  getCurrentValue: vi.fn(() => ''),
  getImages: vi.fn(() => []),
}));

const nativeFileDrop = vi.hoisted(() => ({
  options: undefined as { enabled?: boolean } | undefined,
  zoneId: undefined as string | undefined,
  zoneElement: null as HTMLElement | null,
  zoneDrop: undefined as ((paths: string[]) => void) | undefined,
  registerZone: vi.fn(
    (
      id: string,
      element: HTMLElement | null,
      onDrop: (paths: string[]) => void,
    ) => {
      nativeFileDrop.zoneId = id;
      nativeFileDrop.zoneElement = element;
      nativeFileDrop.zoneDrop = onDrop;
    },
  ),
  unregisterZone: vi.fn(),
}));

const taskCenterMock = vi.hoisted(() => ({ available: false }));

vi.mock('@/components/SimpleChatInput', () => ({
  default: forwardRef<
    SimpleChatInputHandle,
    {
      active?: boolean;
      onSlashAction?: (name: string) => void;
      showBuiltinSdkSlashCommands?: boolean;
    }
  >(function SimpleChatInputMock(
    { active, onSlashAction, showBuiltinSdkSlashCommands },
    _ref,
  ) {
    useImperativeHandle(_ref, () => simpleInputHandle, []);
    return (
      <div
        data-testid="launcher-input"
        data-active={String(active)}
        data-show-builtin-sdk-commands={String(showBuiltinSdkSlashCommands)}
      >
        input
        <button type="button" onClick={() => onSlashAction?.('goal')}>
          open goal
        </button>
      </div>
    );
  }),
}));

vi.mock('@/hooks/useTauriFileDrop', () => ({
  useTauriFileDrop: (options: { enabled?: boolean }) => {
    nativeFileDrop.options = options;
    return {
      isDragging: false,
      activeZoneId: null,
      registerZone: nativeFileDrop.registerZone,
      unregisterZone: nativeFileDrop.unregisterZone,
    };
  },
}));

vi.mock('@/components/cron/CronTaskSettingsModal', () => ({
  GOAL_SLASH_PRESET: {
    taskKind: 'goal',
    prompt: '',
    intervalMinutes: 30,
    endConditions: { aiCanExit: true },
    runMode: 'single_session',
    notifyEnabled: true,
    schedule: { kind: 'loop' },
    executionTarget: 'current_session',
  },
  default: ({
    isOpen,
    initialConfig,
  }: {
    isOpen: boolean;
    initialConfig?: { taskKind?: string };
  }) =>
    isOpen ? (
      <div
        data-testid="cron-settings"
        data-task-kind={initialConfig?.taskKind}
      />
    ) : null,
}));

vi.mock('./LauncherInputContextRow', () => ({
  default: () => <div data-testid="launcher-context-row">context row</div>,
}));

vi.mock('@/components/task-center/ModeSegment', () => ({
  default: ({ onChange }: { onChange: (mode: 'task' | 'thought') => void }) => (
    <button type="button" onClick={() => onChange('thought')}>
      thought mode
    </button>
  ),
}));

vi.mock('@/components/task-center/RecentThoughtsRow', () => ({
  default: () => null,
}));

vi.mock('@/components/task-center/ThoughtInput', () => ({
  ThoughtInput: forwardRef<HTMLTextAreaElement>(function ThoughtInputMock() {
    return <textarea aria-label="thought input" />;
  }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('@/api/taskCenter', () => ({
  thoughtList: vi.fn(async () => []),
  taskCenterAvailable: () => taskCenterMock.available,
}));

vi.mock('@/hooks/useThoughtTagCandidates', () => ({
  useThoughtTagCandidates: () => [],
}));

const project: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/Users/zhihu/project',
  providerId: null,
  permissionMode: null,
};

function renderBrandSection(
  overrides: Partial<ComponentProps<typeof BrandSection>> = {},
  themeId?: string,
) {
  const onGoToSettings = vi.fn();
  const content = (
    <BrandSection
      projects={[project]}
      selectedProject={project}
      onSelectWorkspace={vi.fn()}
      onAddFolder={vi.fn()}
      onSend={vi.fn()}
      onStartRecording={vi.fn()}
      onOpenRecord={vi.fn()}
      isActive={true}
      providers={[]}
      apiKeys={{}}
      providerVerifyStatus={{}}
      onGoToSettings={onGoToSettings}
      {...overrides}
    />
  );
  const view = render(
    <ThemeRuntimeProvider
      registry={new ThemeRegistry([myAgentsDefaultTheme, syntheticTheme])}
      selection={{
        themeId: themeId ?? 'myagents-default',
        appearanceMode: 'light',
      }}
    >
      {content}
    </ThemeRuntimeProvider>,
  );
  return { ...view, onGoToSettings };
}

describe('BrandSection', () => {
  beforeEach(() => {
    openExternalMock.mockClear();
    simpleInputHandle.processDroppedFiles.mockClear();
    simpleInputHandle.processDroppedFilePaths.mockClear();
    nativeFileDrop.options = undefined;
    nativeFileDrop.zoneId = undefined;
    nativeFileDrop.zoneElement = null;
    nativeFileDrop.zoneDrop = undefined;
    nativeFileDrop.registerZone.mockClear();
    nativeFileDrop.unregisterZone.mockClear();
    taskCenterMock.available = false;
  });

  it('opens the MoXBots website by click or keyboard from its hero brand', async () => {
    const user = userEvent.setup();
    render(
      <LauncherHeroBrand
        profile="moxbot"
        websiteUrl="https://140.143.183.232/"
        websiteLabel="Open the MoXBots website"
        title="MoXBots"
      />,
    );

    const brand = screen.getByRole('button', { name: 'Open the MoXBots website' });
    brand.focus();
    expect(brand).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(openExternalMock).toHaveBeenLastCalledWith('https://140.143.183.232/');
    await user.click(brand);
    expect(openExternalMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the MyAgents hero brand as a non-clickable logotype', () => {
    render(
      <LauncherHeroBrand
        profile="myagents"
        websiteUrl="https://140.143.183.232/"
        websiteLabel="Open the MyAgents website"
        title="MyAgents"
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'MyAgents' })).toBeInTheDocument();
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it('routes native file paths dropped on the task input to the existing input import pipeline', () => {
    renderBrandSection({ isActive: true });

    const input = screen.getByTestId('launcher-input');
    expect(nativeFileDrop.options?.enabled).toBe(true);
    expect(nativeFileDrop.zoneId).toBe('launcher-input');
    expect(nativeFileDrop.zoneElement).toBe(input.parentElement);

    nativeFileDrop.zoneDrop?.(['/tmp/report.pdf']);

    expect(simpleInputHandle.processDroppedFilePaths).toHaveBeenCalledWith([
      '/tmp/report.pdf',
    ]);
  });

  it('routes browser file drops to the existing File import pipeline', () => {
    renderBrandSection({ isActive: true });
    const file = new File(['report'], 'report.pdf', {
      type: 'application/pdf',
    });

    fireEvent.drop(screen.getByTestId('launcher-input'), {
      dataTransfer: { files: [file] },
    });

    expect(simpleInputHandle.processDroppedFiles).toHaveBeenCalledWith([file]);
  });

  it('gates both native and browser file drops when the Launcher tab is inactive', () => {
    renderBrandSection({ isActive: false });
    const input = screen.getByTestId('launcher-input');
    const file = new File(['report'], 'report.pdf', {
      type: 'application/pdf',
    });

    expect(nativeFileDrop.options?.enabled).toBe(false);
    expect(input).toHaveAttribute('data-active', 'false');
    fireEvent.drop(input, { dataTransfer: { files: [file] } });

    expect(simpleInputHandle.processDroppedFiles).not.toHaveBeenCalled();
  });

  it('stops accepting drops while the thought input is visible', () => {
    taskCenterMock.available = true;
    renderBrandSection({ isActive: true });
    const input = screen.getByTestId('launcher-input');
    const file = new File(['report'], 'report.pdf', {
      type: 'application/pdf',
    });

    fireEvent.click(screen.getByRole('button', { name: 'thought mode' }));

    expect(nativeFileDrop.options?.enabled).toBe(false);
    expect(input).toHaveAttribute('data-active', 'false');
    fireEvent.drop(input, { dataTransfer: { files: [file] } });

    expect(simpleInputHandle.processDroppedFiles).not.toHaveBeenCalled();
  });

  it('keeps the no-provider settings CTA in the same below-input stack as the launcher context row', () => {
    const { container } = renderBrandSection();

    const stack = container.querySelector('.launcher-below-input-stack');

    expect(stack).not.toBeNull();
    expect(stack).toHaveClass('mt-2');
    expect(screen.getByTestId('launcher-context-row')).toBeInTheDocument();
    expect(stack as HTMLElement).toContainElement(
      screen.getByTestId('launcher-context-row'),
    );
    expect(stack as HTMLElement).toContainElement(
      screen.getByRole('button', { name: /配置模型供应商/ }),
    );
  });

  it('opens provider settings from the no-provider CTA', () => {
    const { onGoToSettings } = renderBrandSection();

    fireEvent.click(screen.getByRole('button', { name: /配置模型供应商/ }));

    expect(onGoToSettings).toHaveBeenCalledTimes(1);
  });

  it('opens the Goal preset from the launcher slash action', () => {
    renderBrandSection();

    fireEvent.click(screen.getByRole('button', { name: 'open goal' }));

    expect(screen.getByTestId('cron-settings')).toHaveAttribute(
      'data-task-kind',
      'goal',
    );
  });

  it.each([
    {
      name: 'Managed Codex provider',
      props: {
        provider: {
          ...MANAGED_CODEX_PROVIDER,
          primaryModel: 'gpt-5.6-sol',
          models: [
            {
              model: 'gpt-5.6-sol',
              modelName: 'GPT-5.6-Sol',
              modelSeries: 'codex',
            },
          ],
        },
      },
      expected: 'false',
    },
    {
      name: 'system CLI runtime',
      props: { runtime: 'claude-code' as const },
      expected: 'false',
    },
    {
      name: 'builtin execution',
      props: {},
      expected: 'true',
    },
  ])('projects Claude SDK slash commands for $name', ({ props, expected }) => {
    renderBrandSection(props);

    expect(screen.getByTestId('launcher-input')).toHaveAttribute(
      'data-show-builtin-sdk-commands',
      expected,
    );
  });

  it('renders the no-provider CTA in English when the UI language is English', async () => {
    await i18n.changeLanguage('en-US');

    renderBrandSection();

    expect(
      screen.getByText(/One step to start your AI journey/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Configure a model provider/ }),
    ).toBeInTheDocument();
  });

  it('renders product name and localized slogan from the resolved Theme Hero', () => {
    const { container } = renderBrandSection({}, syntheticTheme.id);

    expect(
      screen.getByRole('heading', { name: 'Synthetic Agents' }),
    ).toBeInTheDocument();
    expect(screen.getByText('合成主题标记')).toBeInTheDocument();
    expect(
      container.querySelector('[data-theme-hero="synthetic-test-theme"]'),
    ).not.toBeNull();
  });
});
