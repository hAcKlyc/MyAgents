import { APP_DATA_DIR_NAME } from '../../shared/appProfile';
import { existsSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, relative, resolve } from "path";

import type { createConnection } from "@playwright/mcp";
import type { BrowserContextOptions, LaunchOptions } from "playwright";

export type PlaywrightConnectionConfig = NonNullable<
  Parameters<typeof createConnection>[0]
>;

export interface CompiledBrowserRuntimeSettings {
  browserName: "chromium";
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  connectionConfig: PlaywrightConnectionConfig;
}

function assertArtifactRoot(
  workspacePath: string,
  productSessionId: string,
): string {
  const canonicalizeExistingPrefix = (path: string): string => {
    const suffix: string[] = [];
    let cursor = resolve(path);
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
    return resolve(realpathSync(cursor), ...suffix);
  };
  const workspace = canonicalizeExistingPrefix(workspacePath);
  const safeSession = productSessionId
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 96);
  const output = canonicalizeExistingPrefix(
    resolve(
      workspace,
      APP_DATA_DIR_NAME,
      "browser-artifacts",
      safeSession || "session",
    ),
  );
  const relativeOutput = relative(workspace, output);
  if (
    relativeOutput === ".." ||
    relativeOutput.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(relativeOutput)
  ) {
    throw new Error("BROWSER_ARTIFACT_ROOT_INVALID");
  }
  return output;
}

/**
 * The MyAgents Browser has one deliberately small product contract in 0.4.10:
 * headed managed Chromium, isolated Contexts and product-owned identity.
 * Standard Playwright argv belongs to the separate `playwright` preset and is
 * never compiled here.
 */
export function compileBrowserRuntimeSettings(
  productSessionId: string,
  workspacePath: string,
): CompiledBrowserRuntimeSettings {
  const launchOptions: LaunchOptions = {
    headless: false,
    // Global Sidecar drains tools and checkpoints live Contexts before closing
    // Chromium. Playwright's parallel signal handlers would preempt that owner.
    handleSIGINT: false,
    handleSIGTERM: false,
  };
  const contextOptions: BrowserContextOptions = {};
  const connectionConfig: PlaywrightConnectionConfig = {
    capabilities: ["storage"],
    allowUnrestrictedFileAccess: false,
    outputDir: assertArtifactRoot(workspacePath, productSessionId),
    outputMode: "stdout",
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions,
      contextOptions,
    },
  };
  return {
    browserName: "chromium",
    launchOptions,
    contextOptions,
    connectionConfig,
  };
}
