import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { RuntimeExtensionStatusPanel } from './RuntimeExtensionStatusPanel';

afterEach(cleanup);
beforeEach(async () => { await i18n.changeLanguage('en-US'); });

describe('current Session extension availability', () => {
  it('keeps missing receipts unknown instead of deriving admission from installation', () => {
    render(<RuntimeExtensionStatusPanel />);
    expect(screen.getByText(/No admission receipts yet/)).toBeTruthy();
    expect(screen.queryByText('Admitted')).toBeNull();
  });

  it('shows native admission once, invocation restrictions, and pending generations', () => {
    render(<RuntimeExtensionStatusPanel status={{ desiredRevision: 'next', effectiveRevision: 'current', state: 'deferred_until_idle', components: [
      { component: 'skill', id: 'manual-only', state: 'applied', code: 'compiled' },
      { component: 'skill', id: 'manual-only', state: 'applied', code: 'ready', admission: 'ready', enabled: true, modelInvocable: false },
      { component: 'agent', id: 'next-agent', state: 'deferred_until_idle', code: 'awaiting_idle', admission: 'pending', enabled: true },
    ] }} />);
    expect(screen.getAllByText('manual-only')).toHaveLength(1);
    expect(screen.getByText(/Enabled: Yes · Model invocation: No/)).toBeTruthy();
    expect(screen.getByText(/Pending application/)).toBeTruthy();
    expect(screen.getByText(/Effective generation: current · Requested: next/)).toBeTruthy();
    expect(screen.getByText(/still requires execution permission/)).toBeTruthy();
  });
});
