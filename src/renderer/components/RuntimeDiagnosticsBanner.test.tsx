import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import type { RuntimeDiagnostics } from '../../shared/types/runtime';
import RuntimeDiagnosticsBanner from './RuntimeDiagnosticsBanner';

function expectTextContaining(...parts: string[]) {
  expect(
    screen.getAllByText((_content, element) => {
      const text = element?.textContent ?? '';
      return parts.every((part) => text.includes(part));
    }).length,
  ).toBeGreaterThan(0);
}

const blockingDiagnostics: RuntimeDiagnostics = {
  runtime: 'codex',
  runtimeSource: 'system-cli',
  timestamp: '2026-07-03T00:00:00.000Z',
  status: {
    auth: 'ok',
    apps: 'ok',
    mcpServers: 'ok',
    features: 'ok',
  },
  auth: {
    authMethod: null,
    requiresLogin: true,
  },
  effectiveEnv: {
    cwd: '/Users/example/project',
  },
};

describe('RuntimeDiagnosticsBanner i18n', () => {
  it('localizes diagnostic chrome while preserving raw runtime payloads', async () => {
    await i18n.changeLanguage('en-US');
    const diagnostics: RuntimeDiagnostics = {
      runtime: 'codex',
      timestamp: '2026-06-28T00:00:00.000Z',
      status: {
        auth: { error: '原始 auth 错误' },
        apps: 'ok',
        mcpServers: 'ok',
        features: 'unsupported',
      },
      auth: {
        authMethod: null,
        requiresLogin: true,
      },
      apps: [
        {
          id: 'artifact-tool',
          isEnabled: true,
          isAccessible: false,
          needsAuth: true,
        },
      ],
      mcpServers: [
        {
          name: '用户MCP',
          toolCount: 1,
          resourceCount: 0,
          state: 'failed',
          authStatus: 'oauth-required',
        },
      ],
      features: [
        {
          name: 'artifact',
          enabled: false,
          defaultEnabled: true,
        },
      ],
      effectiveEnv: {
        cwd: '/tmp/用户工作区',
        proxy: {
          http: 'http://127.0.0.1:7890',
          https: 'http://127.0.0.1:7890',
          no: 'localhost,127.0.0.1',
        },
        proxyPolicy: 'terminal',
        myagentsProxyInjected: false,
        hasOpenaiApiKey: false,
        hasAnthropicApiKey: true,
        hasCodexHome: true,
      },
    };

    render(<RuntimeDiagnosticsBanner diagnostics={diagnostics} />);

    const headline = screen.getByRole('button', { name: /Sign in to Codex to continue/ });
    expect(headline).toBeInTheDocument();

    await userEvent.click(headline);

    expect(screen.getByText('Problems')).toBeInTheDocument();
    expect(screen.getByText('Auth [Failed: 原始 auth 错误]')).toBeInTheDocument();
    expect(screen.queryByText('认证')).not.toBeInTheDocument();
    expectTextContaining('auth query failed: 原始 auth 错误');
    expectTextContaining('inaccessible ', 'artifact-tool');
    expectTextContaining('用户MCP', 'state=failed');
    expectTextContaining('cwd: /tmp/用户工作区');
    expectTextContaining('Diagnostic snapshot: 2026-06-28T00:00:00.000Z. CLI sync info:');
  });
});

describe('RuntimeDiagnosticsBanner diagnostics action', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('calls onDiagnose for blocking diagnostics', () => {
    const onDiagnose = vi.fn();
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={blockingDiagnostics}
        onDiagnose={onDiagnose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Ask helper to diagnose/ }));

    expect(onDiagnose).toHaveBeenCalledTimes(1);
    expect(onDiagnose).toHaveBeenCalledWith(blockingDiagnostics);
  });

  it('does not render diagnostics action for non-blocking diagnostics', () => {
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          auth: {
            authMethod: null,
            requiresLogin: false,
          },
        }}
        onDiagnose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Ask helper to diagnose/ })).not.toBeInTheDocument();
  });

  it('silently skips failed optional extension components when the snapshot is healthy', () => {
    const { container } = render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          runtimeSource: 'managed-provider',
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          extensions: {
            desiredRevision: 'same-revision',
            effectiveRevision: 'same-revision',
            state: 'unchanged',
            components: [
              {
                component: 'commands',
                id: 'workspace:BOOTSTRAP.md',
                state: 'failed',
                code: 'command_invalid_name',
              },
            ],
          },
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('still surfaces a failed extension snapshot', () => {
    render(
      <RuntimeDiagnosticsBanner
        diagnostics={{
          ...blockingDiagnostics,
          runtimeSource: 'managed-provider',
          auth: { authMethod: 'chatgpt', requiresLogin: false },
          extensions: {
            desiredRevision: 'desired-revision',
            effectiveRevision: 'effective-revision',
            state: 'failed',
            components: [],
          },
        }}
      />,
    );

    expect(screen.getByRole('button', {
      name: /Managed Codex extension application failed/,
    })).toBeInTheDocument();
  });

  it('surfaces unsupported Managed Codex extension components with their reason', async () => {
    const diagnostics: RuntimeDiagnostics = {
      ...blockingDiagnostics,
      timestamp: '2026-08-08T00:00:00.000Z',
      auth: { authMethod: 'chatgpt', requiresLogin: false },
      extensions: {
        desiredRevision: 'desired-revision',
        effectiveRevision: 'effective-revision',
        state: 'applied',
        components: [
          {
            component: 'skills',
            state: 'applied',
            code: 'skill_compiled',
          },
          {
            component: 'host_tools',
            state: 'unsupported',
            code: 'host_tools_catalog_immutable',
            message: 'Start a new Product Session.',
          },
        ],
      },
    };
    render(<RuntimeDiagnosticsBanner diagnostics={diagnostics} />);

    const headline = screen.getByRole('button', { name: /Some Managed Codex extensions are unsupported/ });
    await userEvent.click(headline);
    expectTextContaining('Extension host_tools', 'Start a new Product Session.');
    expectTextContaining('Extension skills', 'applied');
    expectTextContaining('desired: desired-revi', 'effective: effective-re');
  });
});
