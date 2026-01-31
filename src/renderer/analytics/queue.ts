/**
 * Analytics Event Queue
 * 事件队列和批量发送
 */

import { proxyFetch } from '@/api/tauriClient';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isAnalyticsEnabled, getApiKey, getEndpoint } from './config';
import type { TrackEvent, TrackResponse } from './types';

// 事件队列
const eventQueue: TrackEvent[] = [];

// 防抖定时器
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// 队列配置
const FLUSH_DELAY_MS = 500;     // 防抖延迟
const MAX_QUEUE_SIZE = 50;      // 队列满发送阈值
const MAX_BATCH_SIZE = 100;     // 单次最大发送数量

// 重试配置
const MAX_RETRY_COUNT = 5;           // 最大重试次数
const RETRY_BASE_DELAY_MS = 1000;    // 重试基础延迟（指数退避）
const MAX_FAILED_EVENTS = 500;       // 失败事件最大保留数量（防止内存泄漏）

// 节流配置
const THROTTLE_WINDOW_MS = 60_000;  // 滑动窗口时长：1 分钟
const MAX_EVENTS_PER_WINDOW = 200;  // 窗口内最大事件数

// 滑动窗口计数器：存储事件时间戳
const eventTimestamps: number[] = [];

// 重试状态
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let isRetrying = false;

/**
 * 检查是否超过节流限制
 * 使用滑动窗口算法统计最近一分钟内的事件数量
 */
function isThrottled(): boolean {
  const now = Date.now();
  const windowStart = now - THROTTLE_WINDOW_MS;

  // 清理过期的时间戳
  while (eventTimestamps.length > 0 && eventTimestamps[0] < windowStart) {
    eventTimestamps.shift();
  }

  // 检查是否超过限制
  return eventTimestamps.length >= MAX_EVENTS_PER_WINDOW;
}

/**
 * 将事件加入队列
 */
export function enqueue(event: TrackEvent): void {
  // 检查是否启用
  if (!isAnalyticsEnabled()) {
    return;
  }

  // 节流检查：超过限制时静默丢弃
  if (isThrottled()) {
    console.debug('[Analytics] Event throttled:', event.event);
    return;
  }

  // 记录事件时间戳
  eventTimestamps.push(Date.now());

  eventQueue.push(event);

  // 防抖：重置定时器
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);

  // 队列满时立即发送
  if (eventQueue.length >= MAX_QUEUE_SIZE) {
    flush();
  }
}

/**
 * 立即发送队列中的事件
 */
export async function flush(): Promise<void> {
  // 清除防抖定时器
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // 如果正在重试中，跳过（避免并发）
  if (isRetrying) {
    return;
  }

  // 队列为空则跳过
  if (eventQueue.length === 0) {
    return;
  }

  // 取出事件（最多 MAX_BATCH_SIZE 条）
  const events = eventQueue.splice(0, MAX_BATCH_SIZE);

  // 发送请求
  try {
    await sendEvents(events);
    // 成功：重置重试计数
    retryCount = 0;
  } catch (error) {
    console.debug('[Analytics] Failed to send events:', error);

    // 失败：将事件放回队列头部
    if (retryCount < MAX_RETRY_COUNT) {
      // 放回队列头部（限制总数防止内存泄漏）
      const eventsToRestore = eventQueue.length + events.length > MAX_FAILED_EVENTS
        ? events.slice(0, MAX_FAILED_EVENTS - eventQueue.length)
        : events;

      if (eventsToRestore.length > 0) {
        eventQueue.unshift(...eventsToRestore);
      }

      // 指数退避重试
      retryCount++;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, retryCount - 1);
      console.debug(`[Analytics] Scheduling retry ${retryCount}/${MAX_RETRY_COUNT} in ${delay}ms`);

      scheduleRetry(delay);
    } else {
      // 超过最大重试次数，丢弃事件
      console.debug(`[Analytics] Max retries (${MAX_RETRY_COUNT}) exceeded, dropping ${events.length} events`);
      retryCount = 0;
    }
  }
}

/**
 * 调度重试
 */
function scheduleRetry(delay: number): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
  }

  isRetrying = true;
  retryTimer = setTimeout(async () => {
    isRetrying = false;
    retryTimer = null;
    await flush();
  }, delay);
}

/**
 * 发送事件到服务器
 */
async function sendEvents(events: TrackEvent[]): Promise<TrackResponse> {
  const endpoint = getEndpoint();
  const apiKey = getApiKey();

  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ events }),
  };

  let response: Response;

  if (isTauriEnvironment()) {
    // Tauri 环境：通过 Rust 代理发送（绕过 CORS）
    response = await proxyFetch(endpoint, requestInit);
  } else {
    // 浏览器开发模式：直接 fetch
    response = await fetch(endpoint, requestInit);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<TrackResponse>;
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
}

/**
 * 页面卸载前同步发送（仅浏览器环境使用）
 *
 * 注意：此函数使用原生 fetch with keepalive，在 Tauri 环境中会被 CORS 阻止。
 * Tauri 环境应使用 visibilitychange + flush() 代替。
 * 参见 tracker.ts 中的环境判断逻辑。
 */
export function flushSync(): void {
  if (eventQueue.length === 0 || !isAnalyticsEnabled()) {
    return;
  }

  const events = eventQueue.splice(0, MAX_BATCH_SIZE);
  const endpoint = getEndpoint();
  const apiKey = getApiKey();

  try {
    // 使用 fetch with keepalive 确保页面卸载时可靠发送
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ events }),
      keepalive: true,
    }).catch(() => {
      // 静默失败
    });
  } catch {
    // 静默失败
  }
}
