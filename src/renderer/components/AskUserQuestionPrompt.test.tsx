import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AskUserQuestionPrompt } from './AskUserQuestionPrompt';

describe('AskUserQuestionPrompt response settlement', () => {
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

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith('ask-1', { 0: 'One' });
    consoleError.mockRestore();
  });
});
