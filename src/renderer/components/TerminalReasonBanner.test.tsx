import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import TerminalReasonBanner from './TerminalReasonBanner';

describe('TerminalReasonBanner diagnostics action', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('shows diagnostics for error-level terminal reasons', () => {
    const onDiagnose = vi.fn();
    render(
      <TerminalReasonBanner
        reason="prompt_too_long"
        onDismiss={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask helper to diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith('prompt_too_long');
  });

  it('shows diagnostics for unknown future terminal reasons', () => {
    const onDiagnose = vi.fn();
    render(
      <TerminalReasonBanner
        reason="future_reason"
        onDismiss={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ask helper to diagnose' }));
    expect(onDiagnose).toHaveBeenCalledWith('future_reason');
  });

  it('does not show diagnostics for normal or self-recovering reasons', () => {
    const onDiagnose = vi.fn();
    const { rerender } = render(
      <TerminalReasonBanner
        reason="max_turns"
        onDismiss={vi.fn()}
        onNewSession={vi.fn()}
        onDiagnose={onDiagnose}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Ask helper to diagnose' })).not.toBeInTheDocument();

    for (const reason of ['rapid_refill_breaker', 'tool_deferred', 'background_requested']) {
      rerender(
        <TerminalReasonBanner
          reason={reason}
          onDismiss={vi.fn()}
          onDiagnose={onDiagnose}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Ask helper to diagnose' })).not.toBeInTheDocument();
    }
  });
});
