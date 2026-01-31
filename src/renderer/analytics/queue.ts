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

// 滑动窗口计数器：使用索引指针优化清理性能
const eventTimestamps: number[] = [];
let timestampStartIndex = 0;  // 有效时间戳的起始索引

// 发送状态
let isFlushing = false;       // 是否正在发送（防止并发）
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

/**
 * 自定义错误类：标识不可重试的错误
 */
class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
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

  // 如果正在发送中，跳过（避免并发）
  if (isFlushing) {
    return;
  }

  // 队列为空则跳过
  if (eventQueue.length === 0) {
    return;
  }

  // 标记为正在发送
  isFlushing = true;

  // 取出事件（最多 MAX_BATCH_SIZE 条）
  const events = eventQueue.splice(0, MAX_BATCH_SIZE);

  try {
    await sendEvents(events);
    // 成功：重置重试计数
    retryCount = 0;
  } catch (error) {
    console.debug('[Analytics] Failed to send events:', error);

    // 检查是否为不可重试的错误（4xx 客户端错误）
    if (error instanceof NonRetryableError) {
      console.debug('[Analytics] Non-retryable error, dropping events');
      retryCount = 0;
    } else if (retryCount < MAX_RETRY_COUNT) {
      // 可重试错误：将事件放回队列头部
      // 限制总数防止内存泄漏
      const maxToRestore = Math.max(0, MAX_FAILED_EVENTS - eventQueue.length);
      const eventsToRestore = events.slice(0, maxToRestore);

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
  } finally {
    // 确保状态重置
    isFlushing = false;
  }

  // 如果队列中还有事件且没有在重试中，继续发送
  if (eventQueue.length > 0 && retryTimer === null) {
    // 使用 setTimeout 避免递归调用栈溢出
    setTimeout(() => void flush(), 0);
  }
}

/**
 * 调度重试
 */
function scheduleRetry(delay: number): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
  }

  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flush();
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

  // 根据状态码分类错误
  if (!response.ok) {
    const status = response.status;

    // 4xx 客户端错误：不重试（请求本身有问题）
    if (status >= 400 && status < 500) {
      throw new NonRetryableError(`HTTP ${status} - Client error`);
    }

    // 5xx 服务器错误：可重试
    throw new Error(`HTTP ${status} - Server error`);
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
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryCount = 0;
  isFlushing = false;
}

/**
 * 页面卸载前同步发送（仅浏览器环境使用）
 *
 * 注意：此函数使用原生 fetch with keepalive，在 Tauri 环境中会被 CORS 阻止。
 * Tauri 环境应使用 visibilitychange + flush() 代替。
 * 参见 tracker.ts 中的环境判断逻辑。
 */
export function flushSync(): void {
  if (eventQueue.length === 0 || !isCachedEnabled()) {
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
