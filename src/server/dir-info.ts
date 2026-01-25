import type { Dirent } from 'fs';
import { readdir, stat } from 'fs/promises';
import { basename, join, relative, resolve } from 'path';

// Re-export types from shared for backward compatibility
export type {
  DirectoryEntry,
  DirectoryInfo,
  DirectoryTreeNode,
  DirectoryTree,
  ExpandDirectoryResult
} from '../shared/dir-types';

import type {
  DirectoryEntry,
  DirectoryInfo,
  DirectoryTreeNode,
  DirectoryTree,
  ExpandDirectoryResult
} from '../shared/dir-types';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'out', 'dist', 'tmp']);

// Default limits for directory scanning
const DEFAULT_INFO_MAX_DEPTH = 3;
const DEFAULT_INFO_MAX_ENTRIES = 500;
const DEFAULT_TREE_MAX_DEPTH = 6;
const DEFAULT_TREE_MAX_ENTRIES = 2000;
const DEFAULT_EXPAND_MAX_DEPTH = 3;
const DEFAULT_EXPAND_MAX_ENTRIES = 500;

export async function buildDirectoryInfo(
  root: string,
  options?: {
    maxDepth?: number;
    maxEntries?: number;
    ignores?: Set<string>;
  }
): Promise<DirectoryInfo> {
  const maxDepth = options?.maxDepth ?? DEFAULT_INFO_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_INFO_MAX_ENTRIES;
  const ignores = options?.ignores ?? DEFAULT_IGNORES;

  const entries: DirectoryEntry[] = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let truncated = false;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && entries.length < maxEntries) {
    const { dir, depth } = queue.shift()!;
    let dirEntries: Dirent[];
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      const name = entry.name;
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }

      if (ignores.has(name)) {
        continue;
      }

      const fullPath = join(dir, name);
      const relPath = relative(root, fullPath) || name;
      const entryDepth = depth + 1;

      if (entry.isDirectory()) {
        totalDirs += 1;
        entries.push({ path: relPath, type: 'dir', depth: entryDepth });
        if (entryDepth < maxDepth) {
          queue.push({ dir: fullPath, depth: entryDepth });
        }
      } else if (entry.isFile()) {
        totalFiles += 1;
        entries.push({ path: relPath, type: 'file', depth: entryDepth });
      } else {
        try {
          const info = await stat(fullPath);
          if (info.isDirectory()) {
            totalDirs += 1;
            entries.push({ path: relPath, type: 'dir', depth: entryDepth });
            if (entryDepth < maxDepth) {
              queue.push({ dir: fullPath, depth: entryDepth });
            }
          } else if (info.isFile()) {
            totalFiles += 1;
            entries.push({ path: relPath, type: 'file', depth: entryDepth });
          }
        } catch {
          continue;
        }
      }
    }
  }

  if (entries.length >= maxEntries) {
    truncated = true;
  }

  return {
    root,
    summary: { totalFiles, totalDirs },
    entries,
    truncated
  };
}

export async function buildDirectoryTree(
  root: string,
  options?: {
    maxDepth?: number;
    maxEntries?: number;
    ignores?: Set<string>;
  }
): Promise<DirectoryTree> {
  const maxDepth = options?.maxDepth ?? DEFAULT_TREE_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_TREE_MAX_ENTRIES;
  const ignores = options?.ignores ?? DEFAULT_IGNORES;

  let totalFiles = 0;
  let totalDirs = 0;
  let truncated = false;
  let entriesCount = 0;

  const rootPath = resolve(root);

  // Use breadth-first approach: collect current level items first, then recurse
  const walk = async (dir: string, relPath: string, depth: number): Promise<DirectoryTreeNode> => {
    const node: DirectoryTreeNode = {
      id: relPath || 'root',
      name: relPath ? basename(relPath) : '.',
      path: relPath,
      type: 'dir',
      children: [],
      loaded: true // Will be set to false if not fully loaded
    };

    // Depth limit reached - mark as not loaded
    if (depth >= maxDepth) {
      node.loaded = false;
      return node;
    }

    let dirEntries: Dirent[];
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      node.loaded = true; // Empty or inaccessible, consider loaded
      return node;
    }

    const sorted = dirEntries
      .filter((entry) => !ignores.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    // Separate directories and files
    const dirs: Array<{ entry: Dirent; childRelPath: string; fullPath: string }> = [];
    const files: Array<{ entry: Dirent; childRelPath: string }> = [];

    for (const entry of sorted) {
      const childRelPath = relPath ? join(relPath, entry.name) : entry.name;
      const fullPath = resolve(rootPath, childRelPath);

      if (entry.isDirectory()) {
        dirs.push({ entry, childRelPath, fullPath });
      } else if (entry.isFile()) {
        files.push({ entry, childRelPath });
      } else {
        // Handle symlinks or other types
        try {
          const info = await stat(fullPath);
          if (info.isDirectory()) {
            dirs.push({ entry, childRelPath, fullPath });
          } else if (info.isFile()) {
            files.push({ entry, childRelPath });
          }
        } catch {
          continue;
        }
      }
    }

    // First pass: add all items at current level (directories as placeholders, files directly)
    // This ensures current level is complete before recursing into subdirectories
    for (const { entry, childRelPath } of dirs) {
      if (entriesCount >= maxEntries) {
        truncated = true;
        break;
      }
      totalDirs += 1;
      entriesCount += 1;
      // Add directory placeholder - will be populated in second pass
      node.children?.push({
        id: childRelPath,
        name: entry.name,
        path: childRelPath,
        type: 'dir',
        children: [],
        loaded: false // Default to not loaded, will be updated in second pass
      });
    }

    for (const { entry, childRelPath } of files) {
      if (entriesCount >= maxEntries) {
        truncated = true;
        break;
      }
      totalFiles += 1;
      entriesCount += 1;
      node.children?.push({
        id: childRelPath,
        name: entry.name,
        path: childRelPath,
        type: 'file'
      });
    }

    // Second pass: recursively populate directory children (if not truncated and within depth)
    if (depth + 1 < maxDepth) {
      for (let i = 0; i < dirs.length && i < (node.children?.length ?? 0); i++) {
        if (truncated) {
          // Remaining directories stay loaded: false
          break;
        }
        const { fullPath, childRelPath } = dirs[i];
        const childNode = node.children?.[i];
        if (childNode && childNode.type === 'dir') {
          const populated = await walk(fullPath, childRelPath, depth + 1);
          childNode.children = populated.children;
          childNode.loaded = populated.loaded;
        }
      }
    }

    return node;
  };

  const tree = await walk(rootPath, '', 0);

  return {
    root: rootPath,
    summary: { totalFiles, totalDirs },
    tree,
    truncated
  };
}

/**
 * Expand a specific directory path and return its children
 * Used for lazy loading when user expands a directory marked as loaded: false
 */
export async function expandDirectory(
  root: string,
  targetPath: string,
  options?: {
    maxDepth?: number;
    maxEntries?: number;
    ignores?: Set<string>;
  }
): Promise<ExpandDirectoryResult> {
  const maxDepth = options?.maxDepth ?? DEFAULT_EXPAND_MAX_DEPTH;
  const maxEntries = options?.maxEntries ?? DEFAULT_EXPAND_MAX_ENTRIES;
  const ignores = options?.ignores ?? DEFAULT_IGNORES;

  const rootPath = resolve(root);
  const targetFullPath = resolve(rootPath, targetPath);

  let entriesCount = 0;
  let truncated = false;

  const walk = async (dir: string, relPath: string, depth: number): Promise<DirectoryTreeNode> => {
    const node: DirectoryTreeNode = {
      id: relPath,
      name: basename(relPath),
      path: relPath,
      type: 'dir',
      children: [],
      loaded: true
    };

    if (depth >= maxDepth) {
      node.loaded = false;
      return node;
    }

    let dirEntries: Dirent[];
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      return node;
    }

    const sorted = dirEntries
      .filter((entry) => !ignores.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const dirs: Array<{ entry: Dirent; childRelPath: string; fullPath: string }> = [];
    const files: Array<{ entry: Dirent; childRelPath: string }> = [];

    for (const entry of sorted) {
      const childRelPath = join(relPath, entry.name);
      const fullPath = resolve(rootPath, childRelPath);

      if (entry.isDirectory()) {
        dirs.push({ entry, childRelPath, fullPath });
      } else if (entry.isFile()) {
        files.push({ entry, childRelPath });
      } else {
        try {
          const info = await stat(fullPath);
          if (info.isDirectory()) {
            dirs.push({ entry, childRelPath, fullPath });
          } else if (info.isFile()) {
            files.push({ entry, childRelPath });
          }
        } catch {
          continue;
        }
      }
    }

    // Add directories
    for (const { entry, childRelPath } of dirs) {
      if (entriesCount >= maxEntries) {
        truncated = true;
        break;
      }
      entriesCount += 1;
      node.children?.push({
        id: childRelPath,
        name: entry.name,
        path: childRelPath,
        type: 'dir',
        children: [],
        loaded: false
      });
    }

    // Add files
    for (const { entry, childRelPath } of files) {
      if (entriesCount >= maxEntries) {
        truncated = true;
        break;
      }
      entriesCount += 1;
      node.children?.push({
        id: childRelPath,
        name: entry.name,
        path: childRelPath,
        type: 'file'
      });
    }

    // Recurse into subdirectories
    if (depth + 1 < maxDepth) {
      for (let i = 0; i < dirs.length && i < (node.children?.length ?? 0); i++) {
        if (truncated) break;
        const { fullPath, childRelPath } = dirs[i];
        const childNode = node.children?.[i];
        if (childNode && childNode.type === 'dir') {
          const populated = await walk(fullPath, childRelPath, depth + 1);
          childNode.children = populated.children;
          childNode.loaded = populated.loaded;
        }
      }
    }

    return node;
  };

  const result = await walk(targetFullPath, targetPath, 0);

  return {
    children: result.children ?? [],
    loaded: !truncated && result.loaded !== false
  };
}
