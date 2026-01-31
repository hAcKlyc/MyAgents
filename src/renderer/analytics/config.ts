/**
 * Analytics Configuration
 * 埋点配置管理
 */

/**
 * 默认上报地址
 */
const DEFAULT_ENDPOINT = 'https://analytics.myagents.io/api/track';

/**
 * 检查埋点是否启用
 * 必须同时满足：VITE_ANALYTICS_ENABLED=true 且 VITE_ANALYTICS_API_KEY 有值
 */
export function isAnalyticsEnabled(): boolean {
  const enabled = import.meta.env.VITE_ANALYTICS_ENABLED;
  const apiKey = import.meta.env.VITE_ANALYTICS_API_KEY;

  return enabled === 'true' && !!apiKey && apiKey.length > 0;
}

/**
 * 获取 API Key
 */
export function getApiKey(): string {
  return import.meta.env.VITE_ANALYTICS_API_KEY || '';
}

/**
 * 获取上报地址
 */
export function getEndpoint(): string {
  return import.meta.env.VITE_ANALYTICS_ENDPOINT || DEFAULT_ENDPOINT;
}

/**
 * 获取完整配置（用于调试）
 */
export function getAnalyticsConfig() {
  return {
    enabled: isAnalyticsEnabled(),
    endpoint: getEndpoint(),
    hasApiKey: !!getApiKey(),
  };
}
