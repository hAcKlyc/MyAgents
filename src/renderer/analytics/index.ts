/**
 * Analytics Module
 * 埋点统计模块
 *
 * 使用方式:
 * ```typescript
 * import { track, initAnalytics } from '@/analytics';
 *
 * // 应用启动时初始化
 * await initAnalytics();
 *
 * // 追踪事件
 * track('message_send', { mode: 'auto', model: 'claude-3.5-sonnet' });
 * ```
 *
 * 配置 (.env):
 * - VITE_ANALYTICS_ENABLED=true     # 启用埋点
 * - VITE_ANALYTICS_API_KEY=xxx      # API Key
 * - VITE_ANALYTICS_ENDPOINT=xxx     # 可选，自定义上报地址
 */

// 核心功能
export { track, initAnalytics, flushEvents, isEnabled } from './tracker';

// 类型导出
export type {
  EventName,
  EventParams,
  MessageSendParams,
  MessageCompleteParams,
  TrackEvent,
} from './types';

// 配置（调试用）
export { isAnalyticsEnabled, getAnalyticsConfig } from './config';

// 设备信息（调试用）
export { getDeviceId, getPlatform, getAppVersion } from './device';
