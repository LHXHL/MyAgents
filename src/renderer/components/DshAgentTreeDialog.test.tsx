import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import DshAgentTreeDialog from './DshAgentTreeDialog';
import type { RuntimeAgentWorkSnapshot } from '../../shared/types/subagent-lifecycle';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('@/context/TabContext', () => ({ useTabApi: () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }) }));
afterEach(cleanup);
const fixture = (override: Partial<RuntimeAgentWorkSnapshot> = {}): RuntimeAgentWorkSnapshot => ({
  agentId: 'child-1', taskId: 'task-1', parentToolUseId: 'call-1', agentType: 'general', description: 'Parent fixture',
  handleRevision: 10, handleState: 'open', status: 'completed', startedAt: 1_000, finishedAt: 2_000,
  activation: { id: 'epoch-1', ordinal: 1, state: 'completed' },
  tree: { rootAgentId: 'root-1', parentAgentId: 'root-1', depth: 1 }, model: 'model-parent',
  modelRoute: { provider: 'provider-parent', profileRevision: 'profile-parent', selection: 'inherit' }, ...override,
});

describe('DSH Agent tree controls', () => {
  beforeEach(async () => { vi.resetAllMocks(); await i18n.changeLanguage('zh-CN'); });

  it('shows parent and descendant states with actual routes and unknown usage in collapsed details', async () => {
    mocks.apiGet.mockResolvedValue({ success: true, items: [fixture(), fixture({ agentId: 'grandchild', taskId: 'task-2', description: 'Descendant fixture',
      tree: { rootAgentId: 'root-1', parentAgentId: 'child-1', depth: 2 }, status: 'running',
      activation: { id: 'grand-epoch-1', ordinal: 1, state: 'waiting_interaction' },
      model: 'model-child', modelRoute: { provider: 'provider-child', profileRevision: 'profile-child', selection: 'fixed' },
      totalUsage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6, costUsd: null },
    })] });
    render(<DshAgentTreeDialog onClose={vi.fn()} />);
    expect(await screen.findByText('Parent fixture')).toBeInTheDocument();
    expect(screen.getByText('本次已完成，后台后代仍在活动')).toBeInTheDocument();
    expect(screen.getByText(/等待用户/)).toBeInTheDocument();
    expect(screen.getByText('provider-child')).not.toBeVisible();
    const parent = screen.getByText('Parent fixture').closest('article')!;
    const details = within(parent).getByText('查看详情').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(within(parent).getByText('查看详情'));
    expect(within(parent).getByText('provider-parent')).toBeVisible();
    expect(within(parent).getByText('已报告 tokens').nextElementSibling).toHaveTextContent('未知');
    expect(screen.queryByText(/部分节点用量未知/)).not.toBeInTheDocument();
  });

  it('retries a lost explicit reopen receipt with the same identity and handle revision', async () => {
    mocks.apiGet.mockResolvedValue({ success: true, items: [fixture({ handleState: 'closed' })] });
    mocks.apiPost.mockRejectedValueOnce(new Error('fixture response lost')).mockResolvedValue({ success: true });
    render(<DshAgentTreeDialog onClose={vi.fn()} />);
    const resume = await screen.findByRole('button', { name: '恢复此节点' });
    expect(screen.queryByRole('button', { name: '追问' })).not.toBeInTheDocument();
    fireEvent.click(resume);
    expect(await screen.findByRole('alert')).toHaveTextContent('fixture response lost');
    await waitFor(() => expect(resume).not.toBeDisabled());
    fireEvent.click(resume);
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
    expect(mocks.apiPost.mock.calls[1]).toEqual(mocks.apiPost.mock.calls[0]);
    expect(mocks.apiPost.mock.calls[0]?.[1]).toMatchObject({ kind: 'resume', agentId: 'child-1', expectedHandleRevision: 10, clientRequestId: expect.any(String) });
  });

  it('reports message acceptance without claiming execution completion', async () => {
    mocks.apiGet.mockResolvedValue({ success: true, items: [fixture()] }); mocks.apiPost.mockResolvedValue({ success: true });
    render(<DshAgentTreeDialog onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '追问' }));
    fireEvent.change(screen.getByRole('textbox', { name: '追问' }), { target: { value: 'Continue fixture task' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('status')).toHaveTextContent('消息已接收，将在目标允许的执行边界生效。');
    expect(mocks.apiPost.mock.calls[0]?.[1]).toMatchObject({ kind: 'message', agentId: 'child-1', message: 'Continue fixture task', clientMessageId: expect.any(String) });
  });
});
