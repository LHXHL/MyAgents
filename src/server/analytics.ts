/**
 * Server-side Analytics
 *
 * Lightweight event tracker for the Node Sidecar.
 * Reads config from ~/.myagents/analytics_config.json (written by frontend at startup).
 * Uses the existing general-network transport and an in-memory receipt queue.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { fetchWithGeneralProxy, withAbortSignal } from './utils/cancellation';
import {
  AnalyticsDeliveryError, analyticsFailureDetails, analyticsRetryDelay,
  assertAnalyticsReceipt, assertAnalyticsStatus,
} from '../shared/analyticsDelivery';

const CONFIG_PATH = join(homedir(), '.myagents', 'analytics_config.json');

interface AnalyticsConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  deviceId: string;
  platform: string;
  appVersion: string;
}

interface ServerTrackEvent {
  event: string;
  device_id: string;
  platform: string;
  app_version: string;
  params: Record<string, string | number | boolean | null | undefined>;
  client_timestamp: string;
}

interface PendingConfigTrackEvent {
  event: string;
  params: Record<string, string | number | boolean | null | undefined>;
  client_timestamp: string;
  created_at_ms: number;
}

type ConfigState = AnalyticsConfig | 'disabled' | 'missing';

// Lazy-loaded config with retry — frontend writes the file asynchronously at startup,
// so the Sidecar may call trackServer() before the file exists. Missing config is
// distinct from disabled analytics: missing gets a short pending queue; disabled
// stays a no-op.
let config: ConfigState | null = null;
let configLoadedAt = 0;
const CONFIG_RETRY_MS = 10_000; // retry every 10s if config was missing

// Simple batch queue
const queue: ServerTrackEvent[] = [];
const pendingConfigQueue: PendingConfigTrackEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 3000;
const MAX_QUEUE_SIZE = 30;
const MAX_BUFFERED_EVENTS = 500;
const CONFIG_PENDING_RETRY_MS = 1000;
const PENDING_CONFIG_TTL_MS = 30_000;
const MAX_PENDING_CONFIG_QUEUE_SIZE = 100;
const ANALYTICS_FETCH_TIMEOUT_MS = 10_000;
let flushInFlight = false;
let retryAttempt = 0;
let retryAt = 0;
let capacityReported = false;

function enqueueReadyEvent(event: ServerTrackEvent): void {
  if (queue.length >= MAX_BUFFERED_EVENTS) {
    // Log once per capacity episode, rather than once per rejected event.
    if (!capacityReported) console.warn('[Analytics] Queue capacity reached', { limit: MAX_BUFFERED_EVENTS });
    capacityReported = true;
    return;
  }
  queue.push(event);
}

function loadConfig(): ConfigState {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AnalyticsConfig;
    if (!parsed.enabled || !parsed.apiKey || !parsed.endpoint) return 'disabled';
    return parsed;
  } catch {
    return 'missing';
  }
}

function isReadyConfig(value: ConfigState | null): value is AnalyticsConfig {
  return typeof value === 'object' && value !== null;
}

function getConfigState(): ConfigState {
  const now = Date.now();
  // Retry if config failed to load and enough time has passed
  const retryMs = config === 'missing' && pendingConfigQueue.length > 0
    ? CONFIG_PENDING_RETRY_MS
    : CONFIG_RETRY_MS;
  if (config === null || (!isReadyConfig(config) && now - configLoadedAt >= retryMs)) {
    config = loadConfig();
    configLoadedAt = now;
  }
  return config;
}

function createEvent(
  cfg: AnalyticsConfig,
  event: string,
  params: Record<string, string | number | boolean | null | undefined>,
  clientTimestamp = new Date().toISOString(),
): ServerTrackEvent {
  return {
    event,
    device_id: cfg.deviceId,
    platform: cfg.platform,
    app_version: cfg.appVersion,
    params,
    client_timestamp: clientTimestamp,
  };
}

function pruneExpiredPendingConfigEvents(): void {
  const now = Date.now();
  for (let i = pendingConfigQueue.length - 1; i >= 0; i -= 1) {
    if (now - pendingConfigQueue[i].created_at_ms > PENDING_CONFIG_TTL_MS) {
      pendingConfigQueue.splice(i, 1);
    }
  }
}

function materializePendingConfigEvents(cfg: AnalyticsConfig): void {
  pruneExpiredPendingConfigEvents();
  if (pendingConfigQueue.length === 0) return;

  const pending = pendingConfigQueue.splice(0, pendingConfigQueue.length);
  for (const item of pending) {
    enqueueReadyEvent(createEvent(cfg, item.event, item.params, item.client_timestamp));
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushQueue(), retryAt > Date.now() ? retryAt - Date.now() : delayMs);
  flushTimer.unref?.();
}

async function flushQueue(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (flushInFlight) {
    if (queue.length > 0 || pendingConfigQueue.length > 0) {
      scheduleFlush(FLUSH_DELAY_MS);
    }
    return;
  }
  if (retryAt > Date.now()) {
    scheduleFlush(retryAt - Date.now());
    return;
  }

  const cfg = getConfigState();
  if (cfg === 'disabled') {
    queue.length = 0;
    pendingConfigQueue.length = 0;
    return;
  }

  if (!isReadyConfig(cfg)) {
    pruneExpiredPendingConfigEvents();
    if (queue.length > 0 || pendingConfigQueue.length > 0) {
      scheduleFlush(CONFIG_PENDING_RETRY_MS);
    }
    return;
  }

  materializePendingConfigEvents(cfg);
  if (queue.length === 0) {
    return;
  }

  const events = queue.slice(0, MAX_QUEUE_SIZE);

  flushInFlight = true;
  try {
    // Keep the timeout alive through the receipt body, not just the headers.
    await withAbortSignal(undefined, async signal => {
      const response = await fetchWithGeneralProxy(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cfg.apiKey,
        },
        body: JSON.stringify({ events }),
        signal,
      });
      if (!response.ok) {
        // undici requires every body to be consumed or cancelled. Otherwise
        // a stalled error body survives this request's timeout and each retry
        // can leave another open stream behind.
        await response.body?.cancel().catch(() => {});
        assertAnalyticsStatus(response.ok, response.status);
      }
      assertAnalyticsReceipt(await response.json(), events.length);
    }, { timeoutMs: ANALYTICS_FETCH_TIMEOUT_MS });
    queue.splice(0, events.length);
    retryAttempt = 0;
    retryAt = 0;
    capacityReported = false;
  } catch (error) {
    const retryable = !(error instanceof AnalyticsDeliveryError) || error.retryable;
    if (retryable) {
      retryAttempt = Math.min(retryAttempt + 1, 7);
      retryAt = Date.now() + analyticsRetryDelay(retryAttempt);
    } else {
      queue.splice(0, events.length);
      retryAttempt = 0;
      retryAt = 0;
      capacityReported = false;
    }
    console.warn('[Analytics] Delivery failed', {
      ...analyticsFailureDetails(error), count: events.length, retryable,
      retryInMs: Math.max(0, retryAt - Date.now()),
    });
  } finally {
    flushInFlight = false;
  }

  // If there are remaining events, schedule another flush
  if (queue.length > 0) {
    scheduleFlush(FLUSH_DELAY_MS);
  }
}

/**
 * Track a server-side event.
 * Silent no-op if analytics is disabled. If the Sidecar starts before the
 * renderer has written analytics_config.json, retain a short pending queue so
 * early turn-complete events are not lost.
 */
export function trackServer(
  event: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const cfg = getConfigState();

  if (cfg === 'disabled') {
    pendingConfigQueue.length = 0;
    return;
  }

  if (!isReadyConfig(cfg)) {
    pruneExpiredPendingConfigEvents();
    pendingConfigQueue.push({
      event,
      params,
      client_timestamp: new Date().toISOString(),
      created_at_ms: Date.now(),
    });
    if (pendingConfigQueue.length > MAX_PENDING_CONFIG_QUEUE_SIZE) {
      pendingConfigQueue.splice(0, pendingConfigQueue.length - MAX_PENDING_CONFIG_QUEUE_SIZE);
    }
    scheduleFlush(CONFIG_PENDING_RETRY_MS);
    return;
  }

  materializePendingConfigEvents(cfg);
  enqueueReadyEvent(createEvent(cfg, event, params));

  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushQueue();
  } else {
    scheduleFlush(FLUSH_DELAY_MS);
  }
}
