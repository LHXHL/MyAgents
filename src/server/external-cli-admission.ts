import { timingSafeEqual } from 'node:crypto';

import {
  INTERNAL_CLI_TOKEN_ENV,
  INTERNAL_CLI_TOKEN_HEADER,
  isExternalCliPublicRoute,
} from '../shared/externalCliCapabilities';
import { managementApi } from './utils/management-api-client';

export type AdminCaller = { kind: 'internal' } | { kind: 'external-cli' };

export interface AdminAdmissionFailure {
  status: number;
  response: {
    success: false;
    code: string;
    error: string;
    suggestion?: string;
  };
}

function secretsEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasValidInternalCliCredential(request: Request): boolean {
  const expected = process.env[INTERNAL_CLI_TOKEN_ENV]?.trim();
  const supplied = request.headers.get(INTERNAL_CLI_TOKEN_HEADER)?.trim();
  return Boolean(expected && supplied && secretsEqual(supplied, expected));
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || undefined;
}

export async function admitAdminRequest(
  request: Request,
  route: string,
): Promise<AdminCaller | AdminAdmissionFailure> {
  if (hasValidInternalCliCredential(request)) {
    return { kind: 'internal' };
  }

  if (!isExternalCliPublicRoute(route)) {
    return {
      status: 403,
      response: {
        success: false,
        code: 'EXTERNAL_CLI_CAPABILITY_NOT_OPEN',
        error: `The command route '${route}' is available only inside MyAgents.`,
        suggestion:
          'Use `myagents --help` to list the public external commands.',
      },
    };
  }

  const token = bearerToken(request);
  if (!token) {
    return {
      status: 401,
      response: {
        success: false,
        code: 'EXTERNAL_CLI_TOKEN_REQUIRED',
        error: 'External CLI access requires MYAGENTS_API_TOKEN.',
        suggestion:
          'Enable External Calls in MyAgents Settings and export the token.',
      },
    };
  }

  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) {
    return {
      status: 503,
      response: {
        success: false,
        code: 'EXTERNAL_CLI_HOST_NOT_READY',
        error: 'The MyAgents Host identity is not ready.',
      },
    };
  }
  const result = await managementApi('/api/external-cli/admit', 'POST', {
    sidecarId,
    token,
  });
  if (result.ok !== true) {
    return {
      status: 503,
      response: {
        success: false,
        code: 'EXTERNAL_CLI_POLICY_UNAVAILABLE',
        error: 'The MyAgents external access policy is unavailable.',
      },
    };
  }
  if (result.allowed !== true) {
    const code = String(result.code ?? 'external_cli_token_invalid');
    const disabled = code === 'external_cli_disabled';
    return {
      status: disabled ? 403 : 401,
      response: {
        success: false,
        code: disabled ? 'EXTERNAL_CLI_DISABLED' : 'EXTERNAL_CLI_TOKEN_INVALID',
        error: disabled
          ? 'MyAgents CLI external access is disabled.'
          : 'MYAGENTS_API_TOKEN is invalid or has been reset.',
        suggestion: disabled
          ? 'Enable External Calls in MyAgents Settings.'
          : 'Copy the current token from MyAgents Settings and retry.',
      },
    };
  }
  return { kind: 'external-cli' };
}

export function isAdminAdmissionFailure(
  admission: AdminCaller | AdminAdmissionFailure,
): admission is AdminAdmissionFailure {
  return 'status' in admission;
}
