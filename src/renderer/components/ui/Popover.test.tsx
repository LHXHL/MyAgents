import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Popover from './Popover';

describe('Popover positioning readiness', () => {
  it('keeps unpositioned content hidden and notifies focus owner only after placement', async () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const ready = vi.fn(); const anchorRef = { current: anchor };
    const { rerender, unmount } = render(<Popover open anchorRef={anchorRef} onClose={vi.fn()} onPositioned={ready}><input aria-label="popup field" /></Popover>);
    const input = screen.getByLabelText('popup field');
    expect(input.parentElement).toHaveStyle({ opacity: '0', pointerEvents: 'none' });
    expect(ready).not.toHaveBeenCalled();
    await waitFor(() => expect(input).toBeVisible());
    expect(ready).toHaveBeenCalledOnce();
    rerender(<Popover open anchorRef={anchorRef} onClose={vi.fn()} onPositioned={ready}><input aria-label="popup field" /></Popover>);
    expect(ready).toHaveBeenCalledOnce();
    unmount(); anchor.remove();
  });
});
