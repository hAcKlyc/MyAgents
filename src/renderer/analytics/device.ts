/**
 * Device Identification
 * 设备标识和平台检测
 */

import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '@/utils/browserMock';

// localStorage key (fallback for browser dev mode)
const DEVICE_ID_KEY = 'myagents_device_id';

// 缓存值
let cachedDeviceId: string | null = null;
let cachedAppVersion: string | null = null;
let cachedPlatform: string | null = null;

/**
 * 异步获取设备 ID（使用 Tauri Rust 命令）
 * Tauri 环境：从 ~/.myagents/device_id 文件读取或生成
 * 浏览器环境：使用 localStorage（开发模式 fallback）
 */
async function loadDeviceIdAsync(): Promise<string> {
  try {
    if (isTauriEnvironment()) {
      // 调用 Rust 命令，从文件系统读取或生成
      const id = await invoke<string>('cmd_get_device_id');
      return id;
    }
    // 浏览器开发模式：使用 localStorage
    return getDeviceIdFromLocalStorage();
  } catch (e) {
    console.warn('[Analytics] Failed to load device_id from Rust:', e);
    return getDeviceIdFromLocalStorage();
  }
}

/**
 * 从 localStorage 获取或生成设备 ID（浏览器 fallback）
 */
function getDeviceIdFromLocalStorage(): string {
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
 * 预加载设备 ID（应用启动时调用）
 */
export async function preloadDeviceId(): Promise<void> {
  if (!cachedDeviceId) {
    cachedDeviceId = await loadDeviceIdAsync();
  }
}

/**
 * 同步获取设备 ID（返回缓存值）
 * 注意：必须先调用 preloadDeviceId() 才能返回正确值
 */
export function getDeviceId(): string {
  // 如果缓存不存在，使用 localStorage fallback
  if (!cachedDeviceId) {
    cachedDeviceId = getDeviceIdFromLocalStorage();
  }
  return cachedDeviceId;
}

/**
 * 异步检测运行平台（使用 Tauri Rust 命令）
 * 返回与打包一致的平台标识:
 * - darwin-aarch64 (macOS ARM64)
 * - darwin-x86_64 (macOS Intel)
 * - windows-x86_64 (Windows x64)
 * - linux-x86_64 (Linux x64)
 */
async function detectPlatformAsync(): Promise<string> {
  try {
    if (isTauriEnvironment()) {
      // 调用 Rust 命令获取编译时的平台信息（最准确）
      const platform = await invoke<string>('cmd_get_platform');
      return platform;
    }

    // 非 Tauri 环境（浏览器开发模式）- 使用 navigator 作为 fallback
    return detectPlatformFallback();
  } catch {
    return detectPlatformFallback();
  }
}

/**
 * 同步检测平台（浏览器 fallback，不精确）
 */
function detectPlatformFallback(): string {
  try {
    const navPlatform = navigator.platform.toLowerCase();

    if (navPlatform.includes('mac') || navPlatform.includes('darwin')) {
      // 浏览器环境无法准确检测架构，默认返回 x86_64
      return 'darwin-x86_64';
    }
    if (navPlatform.includes('win')) {
      return 'windows-x86_64';
    }
    if (navPlatform.includes('linux')) {
      return 'linux-x86_64';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 预加载平台信息（应用启动时调用）
 */
export async function preloadPlatform(): Promise<void> {
  if (!cachedPlatform) {
    cachedPlatform = await detectPlatformAsync();
  }
}

/**
 * 获取运行平台（同步，返回缓存值）
 * 注意：必须先调用 preloadPlatform() 才能返回准确值
 */
export function getPlatform(): string {
  // 如果缓存不存在，使用同步 fallback（不精确）
  if (!cachedPlatform) {
    cachedPlatform = detectPlatformFallback();
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
