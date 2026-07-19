import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { forwardRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/config/types';
import { i18n } from '@/i18n';
import { ThemeRegistry, ThemeRuntimeProvider } from '@/theme';
import { syntheticTheme } from '@/theme/__tests__/syntheticTheme';
import { myAgentsDefaultTheme } from '@/theme/themes/myagents-default';

import BrandSection from './BrandSection';

vi.mock('@/components/SimpleChatInput', () => ({
  default: forwardRef<HTMLTextAreaElement, { onSlashAction?: (name: string) => void }>(function SimpleChatInputMock(
    { onSlashAction },
    _ref,
  ) {
    return (
      <div data-testid="launcher-input">
        input
        <button type="button" onClick={() => onSlashAction?.('goal')}>open goal</button>
      </div>
    );
  }),
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
  default: ({ isOpen, initialConfig }: { isOpen: boolean; initialConfig?: { taskKind?: string } }) => (
    isOpen ? <div data-testid="cron-settings" data-task-kind={initialConfig?.taskKind} /> : null
  ),
}));

vi.mock('./LauncherInputContextRow', () => ({
  default: () => <div data-testid="launcher-context-row">context row</div>,
}));

vi.mock('@/components/task-center/ModeSegment', () => ({
  default: () => null,
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
  taskCenterAvailable: () => false,
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
      selection={{ themeId: themeId ?? 'myagents-default', appearanceMode: 'light' }}
    >
      {content}
    </ThemeRuntimeProvider>
  );
  return { ...view, onGoToSettings };
}

describe('BrandSection', () => {
  it('keeps the no-provider settings CTA in the same below-input stack as the launcher context row', () => {
    const { container } = renderBrandSection();

    const stack = container.querySelector('.launcher-below-input-stack');

    expect(stack).not.toBeNull();
    expect(screen.getByTestId('launcher-context-row')).toBeInTheDocument();
    expect(stack as HTMLElement).toContainElement(screen.getByTestId('launcher-context-row'));
    expect(stack as HTMLElement).toContainElement(screen.getByRole('button', { name: /配置模型供应商/ }));
  });

  it('opens provider settings from the no-provider CTA', () => {
    const { onGoToSettings } = renderBrandSection();

    fireEvent.click(screen.getByRole('button', { name: /配置模型供应商/ }));

    expect(onGoToSettings).toHaveBeenCalledTimes(1);
  });

  it('opens the Goal preset from the launcher slash action', () => {
    renderBrandSection();

    fireEvent.click(screen.getByRole('button', { name: 'open goal' }));

    expect(screen.getByTestId('cron-settings')).toHaveAttribute('data-task-kind', 'goal');
  });

  it('renders the no-provider CTA in English when the UI language is English', async () => {
    await i18n.changeLanguage('en-US');

    renderBrandSection();

    expect(screen.getByText(/One step to start your AI journey/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Configure a model provider/ })).toBeInTheDocument();
  });

  it('renders product name and localized slogan from the resolved Theme Hero', () => {
    const { container } = renderBrandSection({}, syntheticTheme.id);

    expect(screen.getByRole('heading', { name: 'Synthetic Agents' })).toBeInTheDocument();
    expect(screen.getByText('合成主题标记')).toBeInTheDocument();
    expect(container.querySelector('[data-theme-hero="synthetic-test-theme"]')).not.toBeNull();
  });
});
