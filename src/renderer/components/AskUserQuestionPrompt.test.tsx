import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';

import { AskUserQuestionPrompt } from './AskUserQuestionPrompt';

describe('AskUserQuestionPrompt response settlement', () => {
  it('submits three questions with four choices, keeping custom and multi-select answers lossless', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<StrictMode><AskUserQuestionPrompt
      request={{ requestId: 'ask-many', questions: [0, 1, 2].map(index => ({
        id: `q${index}`, question: `Question ${index}`, header: `Q${index}`,
        multiSelect: index === 1,
        options: ['One, two', 'Three', 'Four', 'Five'].map(label => ({ label, description: label })),
      })) }} onSubmit={onSubmit} onCancel={vi.fn()}
    /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'One, two One, two' }));
    await screen.findByText('Question 1');
    fireEvent.click(screen.getByRole('button', { name: 'One, two One, two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Three Three' }));
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Write locally, then continue' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('ask-many', {
      q0: { selected: ['One, two'] }, q1: { selected: ['One, two', 'Three'] },
      q2: { selected: [], custom: 'Write locally, then continue' },
    }));
  });

  it('shows a cancellation failure and permits retry in Strict Mode', async () => {
    const onCancel = vi.fn().mockRejectedValueOnce(new Error('not acknowledged')).mockResolvedValueOnce(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<StrictMode><AskUserQuestionPrompt
      request={{ requestId: 'ask-cancel', questions: [{ question: 'Choose', header: 'Choice', multiSelect: false,
        options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }] }}
      onSubmit={vi.fn()} onCancel={onCancel}
    /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('取消失败'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2));
    consoleError.mockRestore();
  });

  it('preserves selected answers and permits retry when submission is not acknowledged', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error('response not acknowledged'))
      .mockResolvedValueOnce(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AskUserQuestionPrompt
        request={{
          requestId: 'ask-1',
          questions: [{
            question: 'Choose one',
            header: 'Choice',
            options: [
              { label: 'One', description: 'First option' },
              { label: 'Two', description: 'Second option' },
            ],
            multiSelect: false,
          }],
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const choice = screen.getByRole('button', { name: /One First option/u });
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: '提交' })).not.toBeDisabled());
    expect(choice).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('回答提交失败');

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith('ask-1', { 0: { selected: ['One'] } });
    consoleError.mockRestore();
  });
});
