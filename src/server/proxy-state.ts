import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProxySettings } from '../shared/config-types';
import { effectiveProxyScopeKey, shouldUseMyAgentsProxyForProvider } from '../shared/proxyScope';
import {
  isSocksBridgeRunning,
  startSocksBridge,
  stopSocksBridge,
} from './utils/socks-bridge';

export const PROXY_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]';

const PROXY_VARS_LIST = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

const proxyWasInjectedByRust = process.env.MYAGENTS_PROXY_INJECTED === '1';
delete process.env.MYAGENTS_PROXY_INJECTED;

const inheritedProxySnapshot: Record<string, string | undefined> = {};
if (!proxyWasInjectedByRust) {
  for (const key of PROXY_VARS_LIST) {
    inheritedProxySnapshot[key] = process.env[key];
  }
}

let currentProxySettings: ProxySettings | null = readInitialProxySettings();
let proxyConfigGeneration = 0;

function readInitialProxySettings(): ProxySettings | null {
  try {
    const raw = readFileSync(join(homedir(), '.myagents', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as { proxySettings?: unknown };
    return coerceProxySettings(parsed.proxySettings);
  } catch {
    return null;
  }
}

function coerceProxySettings(raw: unknown): ProxySettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const protocol = obj.protocol === 'https' || obj.protocol === 'socks5' ? obj.protocol : 'http';
  return {
    enabled: obj.enabled === true,
    protocol,
    host: typeof obj.host === 'string' && obj.host.trim() ? obj.host : '127.0.0.1',
    port: typeof obj.port === 'number' && Number.isFinite(obj.port) ? obj.port : 7890,
    ...(obj.scope && typeof obj.scope === 'object' ? { scope: obj.scope as ProxySettings['scope'] } : {}),
  };
}

function rawProxyUrl(settings: ProxySettings): string {
  return `${settings.protocol || 'http'}://${settings.host || '127.0.0.1'}:${settings.port || 7890}`;
}

function applyProxyEnvVars(proxyUrl: string, noProxyVal: string): void {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.NO_PROXY = noProxyVal;
  process.env.no_proxy = noProxyVal;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
}

function restoreInheritedProxyEnvToProcess(): void {
  if (proxyWasInjectedByRust) {
    for (const key of PROXY_VARS_LIST) delete process.env[key];
    return;
  }
  for (const key of PROXY_VARS_LIST) {
    const value = inheritedProxySnapshot[key];
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
}

function copyProxyEnvVars(
  target: Record<string, string | undefined>,
  source: Record<string, string | undefined>,
): void {
  for (const key of PROXY_VARS_LIST) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
    else delete target[key];
  }
  delete target.MYAGENTS_PROXY_INJECTED;
  if (!target.NO_PROXY && !target.no_proxy) {
    target.NO_PROXY = PROXY_NO_PROXY_VAL;
    target.no_proxy = PROXY_NO_PROXY_VAL;
  }
}

function proxyForUrlFromEnv(url: string, env: Record<string, string | undefined>): string | undefined {
  const proxy = env.https_proxy || env.HTTPS_PROXY
    || env.http_proxy || env.HTTP_PROXY
    || env.ALL_PROXY || env.all_proxy;
  if (!proxy) return undefined;

  const noProxy = env.no_proxy || env.NO_PROXY || '';
  if (noProxy === '*') return undefined;
  if (noProxy) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const excluded = noProxy.split(',').some(patternRaw => {
        const pattern = patternRaw.trim().toLowerCase();
        if (!pattern) return false;
        const normalizedHost = normalizeNoProxyHost(host);
        const normalizedPattern = normalizeNoProxyHost(pattern);
        if (normalizedPattern === '127.0.0.0/8' || normalizedPattern === '127/8') {
          return normalizedHost === '127.0.0.1' || normalizedHost.startsWith('127.');
        }
        if (normalizedPattern.startsWith('.')) {
          return normalizedHost.endsWith(normalizedPattern);
        }
        return normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`);
      });
      if (excluded) return undefined;
    } catch {
      // Invalid target URL: leave proxy detection to the caller's fetch error.
    }
  }
  return proxy;
}

function normalizeNoProxyHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const bracketedIpv6 = /^\[(.*)\]$/.exec(trimmed);
  return bracketedIpv6?.[1] ?? trimmed;
}

export function getCurrentProxySettings(): ProxySettings | null {
  return currentProxySettings;
}

export function getProviderProxyScopeKey(providerId: string): string {
  return effectiveProxyScopeKey(currentProxySettings, providerId);
}

export function getProcessProxyEnvKey(): string {
  return PROXY_VARS_LIST
    .map((key) => `${key}=${process.env[key] ?? ''}`)
    .join('\n');
}

export async function setProcessProxyConfig(rawSettings: unknown): Promise<void> {
  const proxySettings = coerceProxySettings(rawSettings);
  currentProxySettings = proxySettings;
  const generation = ++proxyConfigGeneration;

  if (!proxySettings?.enabled) {
    if (isSocksBridgeRunning()) {
      await stopSocksBridge().catch(() => { /* ignore */ });
    }
    restoreInheritedProxyEnvToProcess();
    const restoredProxy = process.env.HTTP_PROXY || process.env.http_proxy || '';
    console.log(`[proxy-state] Proxy disabled, restored inherited state${restoredProxy ? ` (${restoredProxy})` : ''}`);
    return;
  }

  const proxyUrl = rawProxyUrl(proxySettings);
  if (proxySettings.protocol === 'socks5') {
    try {
      const bridgePort = await startSocksBridge(proxySettings.host || '127.0.0.1', proxySettings.port || 7890);
      if (generation !== proxyConfigGeneration) {
        console.log('[proxy-state] SOCKS5 bridge callback discarded (superseded)');
        return;
      }
      const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
      applyProxyEnvVars(bridgeUrl, PROXY_NO_PROXY_VAL);
      console.log(`[proxy-state] SOCKS5 proxy applied: ${proxyUrl} -> bridge ${bridgeUrl}`);
      return;
    } catch (err) {
      if (generation !== proxyConfigGeneration) return;
      console.error(`[proxy-state] Failed to start SOCKS5 bridge: ${err instanceof Error ? err.message : String(err)}. Falling back to raw URL.`);
      applyProxyEnvVars(proxyUrl, PROXY_NO_PROXY_VAL);
      return;
    }
  }

  if (isSocksBridgeRunning()) {
    await stopSocksBridge().catch(() => { /* ignore */ });
  }
  applyProxyEnvVars(proxyUrl, PROXY_NO_PROXY_VAL);
  console.log(`[proxy-state] Proxy applied: ${proxyUrl}`);
}

export async function initSocksBridgeFromCurrentEnv(): Promise<void> {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '';
  if (!proxyUrl.startsWith('socks5://')) return;

  try {
    const url = new URL(proxyUrl);
    const host = url.hostname || '127.0.0.1';
    const port = parseInt(url.port, 10) || 1080;
    const bridgePort = await startSocksBridge(host, port);
    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    applyProxyEnvVars(bridgeUrl, PROXY_NO_PROXY_VAL);
    console.log(`[proxy-state] SOCKS5 bridge initialized at startup: ${proxyUrl} -> ${bridgeUrl}`);
  } catch (err) {
    console.error(`[proxy-state] Failed to initialize SOCKS5 bridge from env: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function applyProviderProxyPolicyToEnv(
  env: Record<string, string | undefined>,
  providerId: string,
): void {
  if (shouldUseMyAgentsProxyForProvider(currentProxySettings, providerId)) {
    copyProxyEnvVars(env, process.env);
    return;
  }
  copyProxyEnvVars(env, inheritedProxySnapshot);
}

export function getProxyForProviderUrl(providerId: string, url: string): string | undefined {
  const source = shouldUseMyAgentsProxyForProvider(currentProxySettings, providerId)
    ? process.env
    : inheritedProxySnapshot;
  return proxyForUrlFromEnv(url, source);
}

export function getProxyForUrl(url: string): string | undefined {
  return proxyForUrlFromEnv(url, process.env);
}

export function _resetProxyStateForTests(settings: ProxySettings | null): void {
  currentProxySettings = settings;
}
