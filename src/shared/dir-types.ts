/**
 * Shared directory tree types used by both server and renderer
 */

export type DirectoryEntry = {
  path: string;
  type: 'file' | 'dir';
  depth: number;
};

export type DirectoryInfo = {
  root: string;
  summary: {
    totalFiles: number;
    totalDirs: number;
  };
  entries: DirectoryEntry[];
  truncated: boolean;
};

export type DirectoryTreeNode = {
  id: string;
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: DirectoryTreeNode[];
  /**
   * For directories: indicates if children are fully loaded.
   * - `true` or `undefined`: fully loaded
   * - `false`: children not fully loaded due to depth/entry limits, needs expand on demand
   */
  loaded?: boolean;
};

export type DirectoryTree = {
  root: string;
  summary: {
    totalFiles: number;
    totalDirs: number;
  };
  tree: DirectoryTreeNode;
  truncated: boolean;
};

export type ExpandDirectoryResult = {
  children: DirectoryTreeNode[];
  loaded: boolean;
};
