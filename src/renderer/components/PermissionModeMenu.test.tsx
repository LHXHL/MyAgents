import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PermissionModeMenuContent } from './PermissionModeMenu';

describe('PermissionModeMenuContent', () => {
  it('exposes a separate Runtime permission-rule management action', async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    render(
      <PermissionModeMenuContent
        items={[{ value: 'auto', label: 'Auto', description: 'Automatic' }]}
        selectedValue="auto"
        onSelect={vi.fn()}
        header="Session mode"
        footerAction={{ label: 'Allowed actions', onClick: onManage }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Allowed actions' }));
    expect(onManage).toHaveBeenCalledOnce();
  });
});
