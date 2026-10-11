import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { i18n } from '@/i18n';
import type { Message } from '@/types/chat';
import { TASK_ALIGNMENT_SKILL_REQUIREMENT } from '../../shared/systemSkills';
import type { TaskDiscussionInput } from '../../shared/taskDiscussion';
import TaskDiscussionRecovery from './TaskDiscussionRecovery';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const input: TaskDiscussionInput = {
  text: '  full original input\ntrailing spaces  ', clientRequestId: '00000000-0000-4000-8000-000000000001',
  primaryContext: { kind: 'task-discussion', input: { candidatesDir: '/data/discussion/candidates', workspaceId: 'ws', workspacePath: '/ws', visibleUserMessage: '  full original input\ntrailing spaces  ', sourceRecordId: 'record', sourceRecordDocumentPath: '/record/content.md', sourceRecordAudioPaths: [{ track: 'mixed', path: '/record/audio.wav' }] } },
  requiredSystemSkill: TASK_ALIGNMENT_SKILL_REQUIREMENT,
};
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage('zh-CN'); vi.mocked(invoke).mockResolvedValue(input); });
it('recovers and copies the exact original without replaying, then explicitly restores the complete contract', async () => {
  const onRestore = vi.fn();
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  render(<TaskDiscussionRecovery discussionId="discussion" messages={[]} active onRestore={onRestore} />);
  expect((await screen.findByRole('textbox')).getAttribute('readonly')).not.toBeNull();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(input.text);
  expect(onRestore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '复制原文' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(input.text));
  fireEvent.click(screen.getByRole('button', { name: '恢复到输入框' }));
  expect(onRestore).not.toHaveBeenCalled();
  const buttons = await screen.findAllByRole('button', { name: '恢复到输入框' });
  fireEvent.click(buttons[buttons.length - 1]);
  expect(onRestore).toHaveBeenCalledWith(input);
});
it('only retires the recovery entry after a real transcript row, including a retry with a new client identity', async () => {
  const onRestore = vi.fn();
  const row: Message = { id: 'optimistic', role: 'user', content: input.text, timestamp: new Date(), metadata: { source: 'desktop', clientRequestId: input.clientRequestId }, deliveryStatus: 'sending' };
  const { rerender } = render(<TaskDiscussionRecovery discussionId="discussion" messages={[row]} active onRestore={onRestore} />);
  await screen.findByText('讨论原始输入已保存。');
  rerender(<TaskDiscussionRecovery discussionId="discussion" messages={[{ ...row, id: 'real', deliveryStatus: undefined, metadata: { source: 'desktop', clientRequestId: 'new-retry-id' }, desktopQuery: { visibleText: input.text, primaryContext: input.primaryContext, requiredSystemSkill: input.requiredSystemSkill } }]} active onRestore={onRestore} />);
  expect(screen.queryByText('讨论原始输入已保存。')).not.toBeInTheDocument();
});
it('leaves a retryable read error and never invents missing legacy input', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('read denied')).mockResolvedValueOnce(null);
  render(<TaskDiscussionRecovery discussionId="legacy" messages={[]} active onRestore={vi.fn()} />);
  await screen.findByText('暂时无法读取已保存的讨论输入。');
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await screen.findByText('这次讨论没有保存可恢复的原文。请检查原始 Record 或已经保存的会话内容。');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('ignores a late artifact read after rebinding to another discussion', async () => {
  let resolve!: (value: TaskDiscussionInput) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { rerender } = render(<TaskDiscussionRecovery discussionId="old" messages={[]} active onRestore={vi.fn()} />);
  vi.mocked(invoke).mockResolvedValueOnce({ ...input, text: 'new input' });
  rerender(<TaskDiscussionRecovery discussionId="new" messages={[]} active onRestore={vi.fn()} />);
  await screen.findByRole('textbox');
  await act(async () => resolve(input));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('new input');
});
