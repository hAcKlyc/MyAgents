/**
 * Analytics Types
 * 埋点统计类型定义
 */

/**
 * 基础事件参数（SDK 自动填充）
 */
export interface BaseEventParams {
  device_id: string;
  platform: string;
  app_version: string;
  client_timestamp: string;
}

/**
 * 事件名称枚举
 *
 * 注意：每个事件都必须有对应的 track() 调用实现
 * 已移除的事件（规划时定义但实际不需要）：
 * - app_ready: 与 app_launch 功能重叠
 * - session_end: 会话只有切换/新建，无明确结束点
 */
export type EventName =
  // 应用生命周期
  | 'app_launch'
  // 会话管理
  | 'session_new'
  | 'session_switch'
  // 核心交互
  | 'message_send'
  | 'message_complete'
  | 'message_stop'
  | 'message_error'
  // 工具使用
  | 'tool_use'
  // 权限控制
  | 'permission_grant'
  | 'permission_deny'
  // 配置变更
  | 'provider_switch'
  | 'model_switch'
  | 'mcp_add'
  | 'mcp_remove'
  // 功能使用
  | 'tab_new'
  | 'tab_close'
  | 'settings_open'
  | 'workspace_open'
  | 'history_open'
  | 'file_drop'
  // 系统事件
  | 'update_check'
  | 'update_install';

/**
 * message_send 事件参数
 */
export interface MessageSendParams {
  mode: string;           // 权限模式: auto | confirm | deny
  model: string;          // 当前模型
  skill?: string | null;  // 技能/指令名称
  has_image: boolean;     // 是否含图片
  has_file: boolean;      // 是否含文件
}

/**
 * message_complete 事件参数
 */
export interface MessageCompleteParams {
  model?: string;                // 主模型名称
  input_tokens: number;          // 输入 tokens
  output_tokens: number;         // 输出 tokens
  cache_read_tokens: number;     // 缓存读取 tokens
  cache_creation_tokens: number; // 缓存创建 tokens
  tool_count: number;            // 工具调用次数
  duration_ms: number;           // 响应耗时（毫秒）
}

/**
 * 通用事件参数类型
 */
export type EventParams = Record<string, string | number | boolean | null | undefined>;

/**
 * 待发送的事件
 */
export interface TrackEvent {
  event: EventName | string;
  device_id: string;
  platform: string;
  app_version: string;
  params: EventParams;
  client_timestamp: string;
}

/**
 * API 请求体
 */
export interface TrackRequest {
  events: TrackEvent[];
}

/**
 * API 响应
 */
export interface TrackResponse {
  success: boolean;
  received?: number;
  error?: string;
}
