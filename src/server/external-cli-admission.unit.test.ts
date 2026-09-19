import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { managementApi } = vi.hoisted(() => ({ managementApi: vi.fn() }));

vi.mock('./utils/management-api-client', () => ({ managementApi }));

import { admitAdminRequest } from './external-cli-admission';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:31415/api/admin/status', {
    method: 'POST',
    headers,
  });
}

describe('external CLI admission', () => {
  beforeEach(() => {
    vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'internal-capability');
    vi.stubEnv('MYAGENTS_SIDECAR_ID', 'sidecar-1');
    managementApi.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('recognizes the App-injected internal capability before the public allowlist', async () => {
    const result = await admitAdminRequest(
      request({
        'X-MyAgents-Internal-Cli-Token': 'internal-capability',
      }),
      'config/set',
    );

    expect(result).toEqual({ kind: 'internal' });
    expect(managementApi).not.toHaveBeenCalled();
  });

  it('denies non-public routes even when an external bearer is present', async () => {
    const result = await admitAdminRequest(
      request({ Authorization: 'Bearer external-token' }),
      'config/set',
    );

    expect(result).toMatchObject({
      status: 403,
      response: { code: 'EXTERNAL_CLI_CAPABILITY_NOT_OPEN' },
    });
    expect(managementApi).not.toHaveBeenCalled();
  });

  it('requires a bearer token on public routes', async () => {
    const result = await admitAdminRequest(request(), 'session/get');

    expect(result).toMatchObject({
      status: 401,
      response: { code: 'EXTERNAL_CLI_TOKEN_REQUIRED' },
    });
  });

  it('delegates token authority to Rust and preserves disabled versus reset errors', async () => {
    managementApi.mockResolvedValueOnce({
      ok: true,
      allowed: false,
      code: 'external_cli_disabled',
    });
    const disabled = await admitAdminRequest(
      request({ Authorization: 'Bearer external-token' }),
      'session/get',
    );
    expect(disabled).toMatchObject({
      status: 403,
      response: { code: 'EXTERNAL_CLI_DISABLED' },
    });

    managementApi.mockResolvedValueOnce({
      ok: true,
      allowed: false,
      code: 'external_cli_token_invalid',
    });
    const reset = await admitAdminRequest(
      request({ Authorization: 'Bearer stale-token' }),
      'session/get',
    );
    expect(reset).toMatchObject({
      status: 401,
      response: { code: 'EXTERNAL_CLI_TOKEN_INVALID' },
    });
  });

  it('admits only after the live Rust policy accepts the token', async () => {
    managementApi.mockResolvedValue({ ok: true, allowed: true });

    await expect(
      admitAdminRequest(
        request({ Authorization: 'Bearer external-token' }),
        'agent/create',
      ),
    ).resolves.toEqual({ kind: 'external-cli' });
    expect(managementApi).toHaveBeenCalledWith(
      '/api/external-cli/admit',
      'POST',
      {
        sidecarId: 'sidecar-1',
        token: 'external-token',
      },
    );
  });
});
