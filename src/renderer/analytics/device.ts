/**
 * Device Identification
 * 设备标识和平台检测
 */

import { getVersion } from '@tauri-apps/api/app';
import { isTauriEnvironment } from '@/utils/browserMock';

const DEVICE_ID_KEY = 'myagents_device_id';

// 缓存的版本号
let cachedAppVersion: string | null = null;

// 缓存的平台信息
let cachedPlatform: string | null = null;

/**
 * 获取或生成设备 ID
 * 使用 localStorage 持久化存储，确保同一设备 ID 不变
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage 不可用时返回临时 ID
    return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * 检测运行平台（内部实现）
 * 返回: mac_arm | mac_intel | win_64 | linux | unknown
 */
function detectPlatform(): string {
  try {
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();

    if (platform.includes('mac') || platform.includes('darwin')) {
      // 检测 Apple Silicon
      // 方法1: 检查 userAgent 中的 ARM 标识
      if (userAgent.includes('arm64') || userAgent.includes('aarch64')) {
        return 'mac_arm';
      }
      // 方法2: 使用 userAgentData API (如果可用)
      const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
      if (uaData?.platform === 'macOS') {
        // 在 macOS 上，如果没有明确的 ARM 标识，尝试通过 WebGL 检测
        // Apple Silicon 的 GPU 通常包含 "Apple" 字样
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (gl) {
            const debugInfo = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
              const renderer = (gl as WebGLRenderingContext).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
              if (renderer && typeof renderer === 'string' && renderer.includes('Apple')) {
                return 'mac_arm';
              }
            }
          }
        } catch {
          // WebGL 检测失败，fallback
        }
      }
      return 'mac_intel';
    }

    if (platform.includes('win')) {
      return 'win_64';
    }

    if (platform.includes('linux')) {
      return 'linux';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 获取运行平台（带缓存）
 * 首次调用时检测并缓存，后续调用直接返回缓存值
 */
export function getPlatform(): string {
  if (!cachedPlatform) {
    cachedPlatform = detectPlatform();
  }
  return cachedPlatform;
}

/**
 * 获取应用版本号
 * 异步获取，首次调用后会缓存
 */
export async function getAppVersion(): Promise<string> {
  if (cachedAppVersion) {
    return cachedAppVersion;
  }

  try {
    if (isTauriEnvironment()) {
      cachedAppVersion = await getVersion();
    } else {
      // 非 Tauri 环境（浏览器开发模式）
      cachedAppVersion = 'dev';
    }
  } catch {
    cachedAppVersion = 'unknown';
  }

  return cachedAppVersion;
}

/**
 * 同步获取缓存的版本号
 * 如果还没有获取过，返回 'unknown'
 */
export function getAppVersionSync(): string {
  return cachedAppVersion || 'unknown';
}

/**
 * 预加载版本号（应用启动时调用）
 */
export async function preloadAppVersion(): Promise<void> {
  await getAppVersion();
}
