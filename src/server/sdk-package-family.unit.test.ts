import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const EXPECTED_SDK_VERSION = '0.3.319';
const PLATFORM_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@anthropic-ai/claude-agent-sdk-win32-x64',
] as const;

interface PackageManifest {
  version: string;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

interface PackageLock {
  version: string;
  packages: Record<string, { version?: string }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T;
}

describe('Claude Agent SDK package family', () => {
  it('locks the wrapper and all eight native packages to the same exact version', () => {
    const manifest = readJson<PackageManifest>('package.json');
    expect(manifest.dependencies['@anthropic-ai/claude-agent-sdk']).toBe(EXPECTED_SDK_VERSION);
    for (const packageName of PLATFORM_PACKAGES) {
      expect(manifest.optionalDependencies[packageName]).toBe(EXPECTED_SDK_VERSION);
    }
  });

  it('keeps package-lock root metadata and every SDK package in sync', () => {
    const manifest = readJson<PackageManifest>('package.json');
    const lock = readJson<PackageLock>('package-lock.json');
    expect(lock.version).toBe(manifest.version);
    expect(lock.packages['']?.version).toBe(manifest.version);
    expect(lock.packages['node_modules/@anthropic-ai/claude-agent-sdk']?.version).toBe(EXPECTED_SDK_VERSION);
    for (const packageName of PLATFORM_PACKAGES) {
      expect(lock.packages[`node_modules/${packageName}`]?.version).toBe(EXPECTED_SDK_VERSION);
    }
  });
});
