/**
 * Analytics Tracker
 * 核心追踪逻辑
 */

import { isTauriEnvironment } from '@/utils/browserMock';
import { isAnalyticsEnabled } from './config';
import { getDeviceId, getPlatform, getAppVersionSync, preloadAppVersion, preloadPlatform, preloadDeviceId } from './device';
import { enqueue, flush, flushSync } from './queue';
import type { EventName, EventParams, TrackEvent } from './types';

// 是否已初始化
let initialized = false;

/**
 * 初始化 Analytics
 * 应在应用启动时调用
 */
export async function initAnalytics(): Promise<void> {
  if (initialized) {
    return;
  }

  // 并行预加载设备ID、版本号和平台信息
  await Promise.all([preloadDeviceId(), preloadAppVersion(), preloadPlatform()]);

  // 注册页面卸载/隐藏事件
  if (typeof window !== 'undefined') {
    if (isTauriEnvironment()) {
      // Tauri 环境：使用 visibilitychange 异步发送
      // beforeunload 在 Tauri 中使用原生 fetch 会被 CORS 阻止
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          void flush();
        }
      });
    } else {
      // 浏览器环境：使用 beforeunload + flushSync (fetch with keepalive)
      window.addEventListener('beforeunload', () => {
        flushSync();
      });

      // 额外添加 visibilitychange 作为补充
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          void flush();
        }
      });
    }
  }

  initialized = true;
}

/**
 * 清理参数对象，只保留可序列化的简单值
 */
function sanitizeParams(params: EventParams): EventParams {
  const result: EventParams = {};
  for (const [key, value] of Object.entries(params)) {
    // 只保留简单类型：string, number, boolean, null
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'object') {
      // 对象类型尝试转为字符串，忽略失败
      try {
        result[key] = JSON.stringify(value);
      } catch {
        result[key] = '[Object]';
      }
    }
    // 其他类型（function, symbol, undefined）忽略
  }
  return result;
}

/**
 * 追踪事件
 * @param event - 事件名称
 * @param params - 事件参数（可选）
 */
export function track(event: EventName | string, params: EventParams = {}): void {
  // 检查是否启用
  if (!isAnalyticsEnabled()) {
    return;
  }

  // 清理参数，确保可序列化
  const safeParams = sanitizeParams(params);

  // 构建事件对象
  const trackEvent: TrackEvent = {
    event,
    device_id: getDeviceId(),
    platform: getPlatform(),
    app_version: getAppVersionSync(),
    params: safeParams,
    client_timestamp: new Date().toISOString(),
  };

  // 加入队列
  enqueue(trackEvent);
}

/**
 * 立即发送所有待发送的事件
 */
export async function flushEvents(): Promise<void> {
  await flush();
}

/**
 * 检查是否启用
 */
export function isEnabled(): boolean {
  return isAnalyticsEnabled();
}
