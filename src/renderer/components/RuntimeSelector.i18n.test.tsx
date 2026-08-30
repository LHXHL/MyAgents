import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { RuntimeDetections } from '@/../shared/types/runtime';
import RuntimeSelector from './RuntimeSelector';

const detections: RuntimeDetections = {
  builtin: { installed: true },
  dsh: { installed: true, version: '0.0.0' },
  'claude-code': { installed: true, version: '1.0.0' },
  codex: { installed: true, version: '1.0.0' },
  gemini: { installed: false },
};

describe('RuntimeSelector i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders toolbar menu chrome in English', async () => {
    const user = userEvent.setup();
    render(
      <RuntimeSelector
        value="codex"
        detections={detections}
        onChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByTitle('Runtime: Codex CLI'));

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByText('Not installed')).toBeInTheDocument();
  });

  it('groups DSH as Integrated and exposes its unverified development state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RuntimeSelector
        value="builtin"
        detections={{
          ...detections,
          dsh: { installed: true, version: '0.0.0', readiness: 'unverified-dev-runtime' },
        }}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByTitle('Runtime: MyAgents (Claude Agent SDK)'));
    expect(screen.getByText('Integrated')).toBeInTheDocument();
    expect(screen.getByText('External CLI')).toBeInTheDocument();
    expect(screen.getByText('Experimental')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /MyAgents \(DSH\)/ }));
    expect(onChange).toHaveBeenCalledWith('dsh');
  });

  it('does not expose Runtimes excluded by a custom distribution', async () => {
    const user = userEvent.setup();
    render(
      <RuntimeSelector
        value="dsh"
        detections={detections}
        onChange={vi.fn()}
        distributionPolicy={{
          schemaVersion: 1,
          allowedIntegratedRuntimes: ['dsh'],
          allowedExternalRuntimes: [],
          defaultIntegratedRuntime: 'dsh',
          selectorAvailability: 'always',
        }}
      />,
    );

    await user.click(screen.getByTitle('Runtime: MyAgents (DSH)'));
    expect(screen.getAllByRole('button', { name: /MyAgents \(DSH\)/ })).toHaveLength(2);
    expect(screen.queryByText('MyAgents (Claude Agent SDK)')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
  });
});
