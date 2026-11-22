/**
 * Analytics Tracker
 * 核心追踪逻辑
 */

import { antigravityToolTelemetryName } from '../../shared/antigravityToolTelemetry';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isAnalyticsEnabled, getApiKey, getEndpoint } from './config';
import { getDeviceId, getPlatform, getAppVersionSync, preloadAppVersion, preloadPlatform, preloadDeviceId } from './device';
import { enqueue, flush, flushSync } from './queue';
import type { EventName, EventParams, TrackEvent } from './types';

// 是否已初始化
let initialized = false;

/**
 * Analytics Active Context
 *
 * Module-level 软上下文。Caller 在 session/tab 切换时调一次 setAnalyticsContext，
 * 每次 track() 自动把 context 字段 merge 进 params——call site 不必每次手动传
 * session_id / tab_id。
 *
 * 设计要点：
 *  1. 软提示：如果 caller 显式传了同名字段（例如 session_new 自己显式传
 *     session_id），以 caller 为准；context 仅在 caller **没传**时兜底。
 *  2. null 不注入：context 内 null/undefined 的字段不会进 params，避免污染
 *     早期事件（active context 还没建立时）。
 *  3. 全局单例：跨 Tab 共享一个 context，但 caller（TabProvider/App）有责任
 *     在切换时同步——这跟 session-aware port lookup 用同样的 ref 思路。
 */
interface AnalyticsContext {
  sessionId: string | null;
  tabId: string | null;
}

let activeContext: AnalyticsContext = { sessionId: null, tabId: null };

/**
 * 更新 Active Context（增量 merge，不传的字段保留）
 *
 * 典型用法：
 *  - TabProvider 在 currentSessionId 变化时调 setAnalyticsContext({ sessionId })
 *  - App.tsx 在 activeTabId 变化时调 setAnalyticsContext({ tabId })
 */
export function setAnalyticsContext(patch: Partial<AnalyticsContext>): void {
  activeContext = { ...activeContext, ...patch };
}

/**
 * 清空 Active Context（所有 tab 关闭时调用）
 */
export function clearAnalyticsContext(): void {
  activeContext = { sessionId: null, tabId: null };
}

/**
 * 读 Active Context 当前值（调试/测试用）
 */
export function getAnalyticsContext(): Readonly<AnalyticsContext> {
  return activeContext;
}

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

  // Write analytics config to disk for Sidecar server-side tracking
  // Sidecar reads ~/.myagents/analytics_config.json to send events directly
  await writeAnalyticsConfigForSidecar();

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

// 序列化值的最大长度（防止产生过大字符串）
const MAX_SERIALIZED_VALUE_LENGTH = 500;

/**
 * 清理参数对象，只保留可序列化的简单值。
 *
 * 重要约定（PRD 0.2.19 cross-review fix）：
 *  - `undefined` 值会被丢弃（filter out）—— Active Context 注入逻辑依赖这个
 *    行为来判断"caller 没传 vs caller 显式传 null"：传 `undefined` 会被过滤掉
 *    → `safeParams.x === undefined` → 触发 context 注入；传 `null` 保留 →
 *    suppress 注入。如果未来想把 undefined 改成 null，必须先重写 Active Context
 *    判断逻辑，否则 context 注入会被永久压制。
 *  - `null` / `string` / `number` / `boolean` 保留（这些是序列化兼容的）。
 *  - 复杂对象 (function / symbol / 大对象) 被丢弃或截断。
 */
function sanitizeParams(params: EventParams): EventParams {
  const result: EventParams = {};
  for (const [key, value] of Object.entries(params)) {
    // 只保留简单类型：string, number, boolean, null
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'object') {
      // 对象类型尝试转为字符串，限制长度防止产生过大字符串
      try {
        const str = JSON.stringify(value);
        result[key] = str.length > MAX_SERIALIZED_VALUE_LENGTH
          ? '[Object:truncated]'
          : str;
      } catch {
        result[key] = '[Object]';
      }
    }
    // 其他类型（function, symbol, undefined）忽略
  }
  return result;
}

/**
 * 仅限以下"session-scoped 事件"在 Active Context 缺省时由 SDK 自动注入
 * `session_id`。其它事件（如 `workspace_open`、`history_open`、`tab_new`）
 * 即使全局 active context 有值也不会被注入——这些事件要么发生在"还没有
 * session 的入口面"，要么本身就跨 session 语义，注入 stale session_id 会
 * 污染 join。
 *
 * 注意：本 allowlist 是"如果 caller 没传 session_id 时的兜底"。Caller 显式
 * 传值（包括 null）永远优先。TabProvider 通过 `trackTabEvent` 包装器为每
 * 个 session-scoped 调用显式注入自己 tab 的 currentSessionId——所以即使
 * SSE 后台事件触发时全局 active context 已切到别的 tab，这里也拿到对的 id。
 * Allowlist 只是 defense-in-depth：未来如有非 TabProvider 路径调用这些事件
 * 而忘记传 session_id，Active Context 还能兜住。
 */
const SESSION_SCOPED_AUTO_INJECT_EVENTS: ReadonlySet<string> = new Set([
  'session_new',
  'session_fork',          // Chat.tsx:2797 — fork from an existing session, intrinsically session-scoped
  'session_rewind',
  'session_title_edit',
  'message_send',
  'message_complete',
  'message_stop',
  'message_error',
  'message_retry',
  'message_copy',
  'tool_use',
  'permission_grant',
  'permission_deny',
  'skill_use',             // AgentCapabilitiesPanel — fires during an active turn
]);

/**
 * 追踪事件
 * @param event - 事件名称
 * @param params - 事件参数（可选）
 *
 * 注意：启用状态检查由 enqueue() 统一处理（使用缓存版本），
 * 此处不再重复检查，避免每次调用都读取环境变量。
 *
 * Active Context 自动注入（PRD 0.2.19 cross-review fix H1）：
 *  - `session_id` 仅在事件名属于 `SESSION_SCOPED_AUTO_INJECT_EVENTS` 时考虑注入；
 *    其它事件（workspace_open / history_open / settings_open / tab_new 等）
 *    即便全局 context 有值也不会被注入——它们要么是 pre-session 入口面，要么
 *    跨 session 语义，注入会污染 join。
 *  - `tab_id` 对所有事件按需注入（轻量、无跨 session 风险）。
 *  - Caller 显式值（包括 null）优先：caller 传 `{ session_id: null }` 时，context
 *    不会覆盖；这就是 history_open / workspace_open 显式压制注入的方式。
 *  - Caller 不传 (undefined) 时，由 `sanitizeParams` 过滤掉 undefined → 接下来
 *    `safeParams.session_id === undefined` 触发 context 注入。约定写在
 *    `sanitizeParams` 注释中。
 */
export function track(event: EventName | string, params: EventParams = {}): void {
  // 清理参数，确保可序列化
  const safeParams = sanitizeParams(params);
  if (safeParams.runtime === 'antigravity' && typeof safeParams.tool === 'string') {
    safeParams.tool = antigravityToolTelemetryName(safeParams.tool);
  }

  // Active Context 自动注入：caller 显式值优先；session_id 仅限 allowlist 事件
  const shouldInjectSessionId =
    activeContext.sessionId !== null &&
    safeParams.session_id === undefined &&
    SESSION_SCOPED_AUTO_INJECT_EVENTS.has(event);
  const shouldInjectTabId =
    activeContext.tabId !== null && safeParams.tab_id === undefined;

  const finalParams: EventParams =
    shouldInjectSessionId || shouldInjectTabId
      ? {
          ...(shouldInjectSessionId ? { session_id: activeContext.sessionId } : {}),
          ...(shouldInjectTabId ? { tab_id: activeContext.tabId } : {}),
          ...safeParams,
        }
      : safeParams;

  // 构建事件对象
  const trackEvent: TrackEvent = {
    event,
    device_id: getDeviceId(),
    platform: getPlatform(),
    app_version: getAppVersionSync(),
    params: finalParams,
    client_timestamp: new Date().toISOString(),
  };

  // 加入队列（enqueue 内部使用缓存检查启用状态）
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

/**
 * Write analytics config to ~/.myagents/analytics_config.json
 * so that the Node Sidecar can send server-side events (e.g. ai_turn_complete)
 */
async function writeAnalyticsConfigForSidecar(): Promise<void> {
  if (!isTauriEnvironment()) return;

  try {
    const { ensureConfigDir, getConfigDir, safeWriteJson } = await import('@/config/services/configStore');
    const { join } = await import('@tauri-apps/api/path');
    await ensureConfigDir();
    const dir = await getConfigDir();
    const filePath = await join(dir, 'analytics_config.json');

    await safeWriteJson(filePath, {
      enabled: isAnalyticsEnabled(),
      apiKey: getApiKey(),
      endpoint: getEndpoint(),
      deviceId: getDeviceId(),
      platform: getPlatform(),
      appVersion: getAppVersionSync(),
    });
  } catch {
    // Silent failure — analytics config write must not block app startup
  }
}
