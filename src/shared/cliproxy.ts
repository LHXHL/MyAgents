import type { ModelEntity } from './config-types';

/** Product views contain no endpoint, local key, OAuth state or credential path. */
export type CliProxyError = { code: string; message: string };
export type CliProxyAccount = {
  generation: string;
  email?: string | null;
  status: 'stored' | 'verified' | 'reauth-required';
  verifiedAt?: string | null;
  verifiedModel?: string | null;
};
export type CliProxyCandidate = {
  attemptId: string;
  generation: string;
  phase: 'authorizing' | 'awaiting-verification' | 'verifying' | 'waiting-to-commit' | 'cancelling' | 'failed';
  email?: string | null;
  expiresAt?: string | null;
  error?: CliProxyError | null;
};
export type CliProxyStatus = {
  policy: { mode: 'disabled' | 'internal' | 'enabled'; usable: boolean; revision: number; error?: CliProxyError | null;
    validity?: 'valid' | 'missing' | 'invalid' | 'incompatible'; source?: 'bundled' | 'cached' | 'remote' };
  component: { version?: string | null; previousVersion?: string | null; bundledVersion?: string;
    phase?: 'missing' | 'installing' | 'installed' | 'failed'; source?: 'bundled' | 'updated' | null };
  update: {
    phase: 'idle' | 'checking' | 'downloading' | 'installing' | 'ready' | 'waiting-to-switch' | 'failed';
    targetVersion?: string | null;
    downloadedBytes?: number;
    totalBytes?: number;
    lastCheckedAt?: string | null;
    error?: CliProxyError | null;
  };
  active?: CliProxyAccount | null;
  candidate?: CliProxyCandidate | null;
  instances: { active: string; candidate: string; activeGeneration?: string | null; candidateGeneration?: string | null };
  cleanup?: { scope: 'candidate' | 'retired' | 'all'; failed: boolean } | null;
  models: ModelEntity[];
  modelsStale: boolean;
  modelVerification?: Record<string, { status: 'succeeded' | 'failed'; checkedAt: string }>;
  verification?: { accountGeneration: string; model: string; phase: 'running' } | null;
  error?: CliProxyError | null;
};

/** Execution-only protocol between an identified Sidecar generation and Rust. */
export type ManagedProxyBinding = {
  providerId: 'antigravity-sub';
  baseUrl: string;
  apiKey: string;
  instanceGeneration: string;
  accountGeneration: string;
  leaseId: string;
  /** Bound compatibility decisions; never inferred from user-edited metadata. */
  modelPolicy: { id: string; thinking: boolean; contextLength?: number | null; maxOutputTokens?: number | null };
};
export type ManagedProxyPurpose =
  | { purpose: 'execution' }
  | { purpose: 'verification'; expectedAccountGeneration: string; verificationOperationId: string };
