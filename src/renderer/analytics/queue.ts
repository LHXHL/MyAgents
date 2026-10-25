/**
 * Analytics Event Queue
 * 事件队列和批量发送
 */

import { proxyAnalyticsFetch } from '@/api/tauriClient';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isAnalyticsEnabled, getApiKey, getEndpoint } from './config';
import type { TrackEvent } from './types';
import {
  AnalyticsDeliveryError, analyticsFailureDetails, analyticsRetryDelay,
  assertAnalyticsReceipt, assertAnalyticsStatus,
} from '../../shared/analyticsDelivery';

// 事件队列
const eventQueue: TrackEvent[] = [];

// 防抖定时器
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// 队列配置
const FLUSH_DELAY_MS = 500;     // 防抖延迟
const MAX_QUEUE_SIZE = 50;      // 队列满发送阈值
const MAX_BATCH_SIZE = 100;     // 单次最大发送数量

// 重试配置
const MAX_FAILED_EVENTS = 500;       // 失败事件最大保留数量（防止内存泄漏）

// 节流配置
const THROTTLE_WINDOW_MS = 60_000;  // 滑动窗口时长：1 分钟
const MAX_EVENTS_PER_WINDOW = 200;  // 窗口内最大事件数

// 滑动窗口计数器：使用索引指针优化清理性能
const eventTimestamps: number[] = [];
let timestampStartIndex = 0;  // 有效时间戳的起始索引

// 发送状态
let isFlushing = false;       // 是否正在发送（防止并发）
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAt = 0;
let queueGeneration = 0;
let capacityReported = false;

// 缓存 analytics 启用状态（避免频繁读取环境变量）
let cachedEnabled: boolean | null = null;

/**
 * 获取缓存的启用状态
 */
function isCachedEnabled(): boolean {
  if (cachedEnabled === null) {
    cachedEnabled = isAnalyticsEnabled();
  }
  return cachedEnabled;
}

/**
 * 检查是否超过节流限制
 * 使用索引指针优化，避免 shift() 的 O(n) 开销
 */
function isThrottled(): boolean {
  const now = Date.now();
  const windowStart = now - THROTTLE_WINDOW_MS;

  // 移动起始索引跳过过期的时间戳（O(1) 平均）
  while (timestampStartIndex < eventTimestamps.length &&
         eventTimestamps[timestampStartIndex] < windowStart) {
    timestampStartIndex++;
  }

  // 定期压缩数组（当无效元素过多时）
  if (timestampStartIndex > 1000) {
    eventTimestamps.splice(0, timestampStartIndex);
    timestampStartIndex = 0;
  }

  // 检查有效时间戳数量是否超过限制
  const validCount = eventTimestamps.length - timestampStartIndex;
  return validCount >= MAX_EVENTS_PER_WINDOW;
}

/**
 * 将事件加入队列
 */
export function enqueue(event: TrackEvent): void {
  // 检查是否启用（使用缓存）
  if (!isCachedEnabled()) {
    return;
  }

  // 节流检查：超过限制时静默丢弃
  if (isThrottled()) {
    console.debug('[Analytics] Event throttled:', event.event);
    return;
  }

  // 记录事件时间戳
  eventTimestamps.push(Date.now());

  if (eventQueue.length >= MAX_FAILED_EVENTS) {
    if (!capacityReported) console.warn('[Analytics] Queue capacity reached', { limit: MAX_FAILED_EVENTS });
    capacityReported = true;
    return;
  }
  eventQueue.push(event);

  // 防抖：重置定时器
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);

  // 队列满时立即发送
  if (eventQueue.length >= MAX_QUEUE_SIZE) {
    void flush();
  }
}

/** Send only after the current retry deadline; retain the head until acknowledged. */
export async function flush(keepalive = false): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (isFlushing || eventQueue.length === 0) return;
  if (retryAt > Date.now()) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  isFlushing = true;
  const generation = queueGeneration;
  const events = eventQueue.slice(0, MAX_BATCH_SIZE);
  try {
    await sendEvents(events, keepalive);
    if (generation === queueGeneration) {
      eventQueue.splice(0, events.length);
      retryCount = 0;
      retryAt = 0;
      capacityReported = false;
    }
  } catch (error) {
    if (generation === queueGeneration) {
      const retryable = !(error instanceof AnalyticsDeliveryError) || error.retryable;
      if (retryable) {
        retryCount = Math.min(retryCount + 1, 7);
        scheduleRetry(analyticsRetryDelay(retryCount));
      } else {
        eventQueue.splice(0, events.length);
        retryCount = 0;
        retryAt = 0;
        capacityReported = false;
      }
      console.warn('[Analytics] Delivery failed', {
        ...analyticsFailureDetails(error), count: events.length, retryable,
        retryInMs: Math.max(0, retryAt - Date.now()),
      });
    }
  } finally {
    isFlushing = false;
  }
  if (eventQueue.length > 0 && retryTimer === null) {
    flushTimer = setTimeout(() => void flush(), 0);
  }
}

/**
 * 调度重试
 */
function scheduleRetry(delay: number): void {
  retryAt = Date.now() + delay;
  if (retryTimer) {
    clearTimeout(retryTimer);
  }

  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flush();
  }, delay);
}

/**
 * 安全的 JSON 序列化，处理循环引用
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    // 处理非对象类型
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    // 检测循环引用
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value;
  });
}

/**
 * 发送事件到服务器
 */
async function sendEvents(events: TrackEvent[], keepalive: boolean): Promise<void> {
  const endpoint = getEndpoint();
  const apiKey = getApiKey();

  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: safeStringify({ events }),
    signal: AbortSignal.timeout(10_000),
  };

  let response: Response;

  if (isTauriEnvironment()) {
    // Tauri 环境：通过 Rust 代理发送（绕过 CORS）
    response = await proxyAnalyticsFetch(endpoint, requestInit);
  } else {
    // 浏览器开发模式：直接 fetch
    response = await fetch(endpoint, { ...requestInit, keepalive });
  }

  assertAnalyticsStatus(response.ok, response.status);
  assertAnalyticsReceipt(await response.json(), events.length);
}

/**
 * 获取队列长度（调试用）
 */
export function getQueueLength(): number {
  return eventQueue.length;
}

/**
 * 清空队列（调试用）
 */
export function clearQueue(): void {
  eventQueue.length = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryCount = 0;
  retryAt = 0;
  queueGeneration++;
  capacityReported = false;
}

/**
 * 页面卸载前尽力发送（仅浏览器环境使用）
 *
 * 注意：此函数与普通发送共用内存队列与互斥；浏览器发送使用 keepalive。
 * Tauri 环境应使用 visibilitychange + flush() 代替。
 * 参见 tracker.ts 中的环境判断逻辑。
 */
export function flushSync(): void {
  // The browser may terminate before completion; keepalive shares the same
  // owner and receipt path so a visibility flush cannot duplicate an in-flight batch.
  void flush(true);
}
