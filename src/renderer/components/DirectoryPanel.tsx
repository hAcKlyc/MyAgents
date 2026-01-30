import {
  AtSign,
  ChevronRight,
  ChevronUp,
  Eye,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  PanelRightClose
} from 'lucide-react';
import { forwardRef, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tree } from 'react-arborist';

import { useTabState } from '@/context/TabContext';
import { getTabServerUrl, proxyFetch, isTauri } from '@/api/tauriClient';
import type { DirectoryTreeNode, DirectoryTree, ExpandDirectoryResult } from '../../shared/dir-types';

import { useImagePreview } from '@/context/ImagePreviewContext';
import { useToast } from '@/components/Toast';
import { type Provider } from '@/config/types';
import { isDebugMode } from '@/utils/debug';

import ConfirmDialog from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import RenameDialog from './RenameDialog';

// Lazy load FilePreviewModal - it includes heavy SyntaxHighlighter
const FilePreviewModal = lazy(() => import('./FilePreviewModal'));


/** Imperative handle for DirectoryPanel */
export interface DirectoryPanelHandle {
  /** Handle file drop from Tauri (takes absolute file paths) */
  handleFileDrop: (paths: string[]) => Promise<void>;
  /** Refresh the directory tree */
  refresh: () => void;
}

interface DirectoryPanelProps {
  agentDir: string;
  provider?: Provider | null;
  providers?: Provider[];
  onProviderChange?: (providerId: string) => void;
  /** Called when user clicks collapse button (only in wide mode) */
  onCollapse?: () => void;
  /** Called when user clicks "项目设置" button */
  onOpenConfig?: () => void;
  /** External trigger to refresh (incremented when file-modifying tools complete) */
  refreshTrigger?: number;
  /** Whether Tauri drag is active over this panel */
  isTauriDragActive?: boolean;
  /** Called when user clicks "引用" to insert @path reference into chat input */
  onInsertReference?: (paths: string[]) => void;
}

type FilePreview = {
  name: string;
  content: string;
  size: number;
  path: string;
};

type ContextMenuState = {
  x: number;
  y: number;
  node: DirectoryTreeNode | null; // null means root directory
  isMultiSelect?: boolean; // true when multiple nodes are selected
} | null;

type DialogState = {
  type: 'rename' | 'delete' | 'new-file' | 'new-folder' | 'delete-multi';
  node: DirectoryTreeNode | null; // null means root directory for new-file/new-folder
  nodes?: DirectoryTreeNode[]; // for delete-multi
} | null;

// Previewable file extensions
const PREVIEWABLE_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'scss',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sh', 'bash',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'swift', 'kt',
  // Dotfiles (e.g., .gitignore -> extension is 'gitignore')
  'gitignore', 'dockerignore', 'editorconfig', 'prettierrc', 'eslintrc',
  'npmrc', 'nvmrc', 'env', 'local', 'example', 'development', 'production'
]);

// Image file extensions
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'
]);

// Delay for single-click selection to allow double-click detection
// Without this delay, React re-render from setSelectedNodes breaks onDoubleClick
const SINGLE_CLICK_DELAY_MS = 250;

// Double-click detection threshold (ms) - must be greater than SINGLE_CLICK_DELAY_MS
// We use custom double-click detection because React's onDoubleClick is unreliable
// when state updates cause re-renders between clicks
const DOUBLE_CLICK_THRESHOLD_MS = 400;

function getFileExtension(name: string): string {
  const parts = name.split('.');
  if (parts.length <= 1) {
    return '';
  }
  return parts.pop() ?? '';
}

function isPreviewable(name: string): boolean {
  const ext = getFileExtension(name).toLowerCase();
  return PREVIEWABLE_EXTENSIONS.has(ext);
}

function isImageFile(name: string): boolean {
  const ext = getFileExtension(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function getFolderName(path: string): string {
  if (!path) return 'Workspace';
  // Normalize path separators (support both / and \) and trim trailing slashes
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'Workspace';
}

const DirectoryPanel = forwardRef<DirectoryPanelHandle, DirectoryPanelProps>(function DirectoryPanel({
  agentDir,
  provider: _provider,
  providers: _providers = [],
  onProviderChange: _onProviderChange,
  onCollapse,
  onOpenConfig,
  refreshTrigger,
  isTauriDragActive = false,
  onInsertReference,
}, ref) {
  const [directoryInfo, setDirectoryInfo] = useState<DirectoryTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Multi-selection support
  const [selectedNodes, setSelectedNodes] = useState<DirectoryTreeNode[]>([]);
  const lastClickedNodeRef = useRef<DirectoryTreeNode | null>(null); // Anchor for shift-select
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Delay single-click to allow double-click
  // Custom double-click detection (more reliable than React's onDoubleClick during state updates)
  const lastClickRef = useRef<{ path: string; time: number } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(240);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Context menu and dialog states
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [importTargetDir, setImportTargetDir] = useState<string>('');

  // External drag-drop state
  const [isExternalDrop, setIsExternalDrop] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const dragCounterRef = useRef(0);

  // Git branch state
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  // Lazy loading state - track directories currently being loaded
  // Use ref to store actual data, state only for triggering UI updates
  const loadingDirsRef = useRef<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  // Image preview context
  const { openPreview } = useImagePreview();

  // Toast for notifications
  const toast = useToast();

  // Get Tab-scoped API functions and tabId
  const { apiGet, apiPost, tabId } = useTabState();

  // Narrow mode collapse state (for responsive layout)
  const [isNarrowMode, setIsNarrowMode] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true); // Default collapsed in narrow mode
  const panelRef = useRef<HTMLDivElement>(null);

  // Detect narrow mode (when panel becomes full width, i.e. stacked layout)
  useEffect(() => {
    const checkNarrowMode = () => {
      // Check if we're in stacked/narrow layout by checking window width
      // Use CSS custom property --breakpoint-mobile (768px) for consistency
      const breakpoint = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--breakpoint-mobile') || '768', 10);
      const narrow = window.innerWidth < breakpoint;
      setIsNarrowMode(narrow);
      if (!narrow) {
        setIsCollapsed(false); // Always show in wide mode
      } else {
        setIsCollapsed(true); // Default collapsed in narrow mode
      }
    };

    checkNarrowMode();
    window.addEventListener('resize', checkNarrowMode);
    return () => window.removeEventListener('resize', checkNarrowMode);
  }, []);

  // Cleanup click timer on unmount
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  const folderName = getFolderName(agentDir);

  const refresh = useCallback(() => {
    setError(null);
    apiGet<DirectoryTree>('/agent/dir')
      .then((data) => {
        setDirectoryInfo(data);
        console.log(`[DirectoryPanel] Directory tree refreshed: ${data.tree?.children?.length || 0} items`);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load directory info');
        console.error('[DirectoryPanel] Failed to refresh:', err);
      });
  }, [apiGet]);

  // Stable ref for refresh to avoid timer recreation
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Helper to update a specific node in the tree
  const updateNodeInTree = useCallback((
    nodes: DirectoryTreeNode[],
    targetPath: string,
    updater: (node: DirectoryTreeNode) => DirectoryTreeNode
  ): DirectoryTreeNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) {
        return updater(node);
      }
      if (node.children && node.type === 'dir') {
        return {
          ...node,
          children: updateNodeInTree(node.children, targetPath, updater)
        };
      }
      return node;
    });
  }, []);

  // Expand a directory that hasn't been fully loaded
  const expandDir = useCallback(async (dirPath: string) => {
    // Use ref to check loading status (stable reference, avoids dependency issues)
    if (loadingDirsRef.current.has(dirPath)) return; // Already loading

    // Update both ref and state
    loadingDirsRef.current.add(dirPath);
    setLoadingDirs(new Set(loadingDirsRef.current));

    try {
      const result = await apiGet<ExpandDirectoryResult>(
        `/agent/dir/expand?path=${encodeURIComponent(dirPath)}`
      );

      setDirectoryInfo((prev: DirectoryTree | null) => {
        if (!prev) return prev;
        const updatedChildren = updateNodeInTree(
          prev.tree.children ?? [],
          dirPath,
          (node) => ({
            ...node,
            children: result.children,
            loaded: result.loaded
          })
        );
        return {
          ...prev,
          tree: {
            ...prev.tree,
            children: updatedChildren
          }
        };
      });
    } catch (err) {
      console.error('[DirectoryPanel] Failed to expand directory:', err);
    } finally {
      // Update both ref and state
      loadingDirsRef.current.delete(dirPath);
      setLoadingDirs(new Set(loadingDirsRef.current));
    }
  }, [apiGet, updateNodeInTree]);

  useEffect(() => {
    refresh();
    // Clear old branch first to avoid flash, then fetch new
    setGitBranch(null);
    apiGet<{ branch: string | null }>('/api/git/branch')
      .then((data) => setGitBranch(data.branch))
      .catch(() => setGitBranch(null));
  }, [agentDir, apiGet, refresh]);

  // Respond to external refresh trigger (e.g., when file-modifying tools complete)
  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      console.log(`[DirectoryPanel] Refresh triggered by file-modifying tool (trigger=${refreshTrigger})`);
      refresh();
    }
  }, [refreshTrigger, refresh]);

  // Auto-refresh every 60 seconds to catch external file system changes
  // Use refreshRef to avoid timer recreation when refresh function changes
  useEffect(() => {
    const interval = setInterval(() => refreshRef.current(), 60000);
    return () => clearInterval(interval);
  }, []);

  const updateTreeHeight = () => {
    const element = treeContainerRef.current;
    if (!element) {
      return;
    }
    const nextHeight = Math.max(180, Math.floor(element.getBoundingClientRect().height));
    setTreeHeight(nextHeight);
  };

  useLayoutEffect(() => {
    updateTreeHeight();
  }, [directoryInfo]);

  useEffect(() => {
    const element = treeContainerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(updateTreeHeight);
    });

    observer.observe(element);
    window.addEventListener('resize', updateTreeHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateTreeHeight);
    };
  }, []);

  const treeData = useMemo(() => {
    return directoryInfo?.tree.children ?? [];
  }, [directoryInfo]);

  // Flatten tree for shift-select range selection
  const flattenedNodes = useMemo(() => {
    const result: DirectoryTreeNode[] = [];
    const flatten = (nodes: DirectoryTreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.type === 'dir' && node.children) {
          flatten(node.children);
        }
      }
    };
    flatten(treeData);
    return result;
  }, [treeData]);

  // Helper to check if a node is selected
  const isNodeSelected = useCallback((node: DirectoryTreeNode) => {
    return selectedNodes.some(n => n.path === node.path);
  }, [selectedNodes]);

  const handlePreview = async (node: DirectoryTreeNode) => {
    if (node.type !== 'file' || isPreviewLoading) {
      return;
    }

    // Batch state updates: only set loading, clear others on success/error
    setIsPreviewLoading(true);

    try {
      const payload = await apiGet<Omit<FilePreview, 'path'>>(`/agent/file?path=${encodeURIComponent(node.path)}`);
      // Batch: set preview and clear loading/error together
      setPreview({ ...payload, path: node.path });
      setPreviewError(null);
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : 'Failed to preview file.');
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0 || isUploading) {
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append('files', file, file.name);
      });
      const url = importTargetDir
        ? `/agent/import?targetDir=${encodeURIComponent(importTargetDir)}`
        : '/agent/import';
      const response = await fetch(url, {
        method: 'POST',
        body: formData
      });
      if (!response.ok) {
        throw new Error('Import failed');
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsUploading(false);
      setImportTargetDir('');
    }
  };

  // Helper function to convert File to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  // External file import for drag-drop
  const handleExternalFileDrop = useCallback(async (files: File[], targetDir: string = '') => {
    if (files.length === 0 || isUploading) {
      return;
    }

    setIsUploading(true);
    try {
      // Convert files to base64 for JSON upload (works in Tauri)
      const base64Files = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          content: await fileToBase64(file),
        }))
      );

      // Upload via base64 API endpoint
      const result = await apiPost<{ success: boolean; files: string[]; error?: string }>(
        '/api/files/import-base64',
        { files: base64Files, targetDir }
      );

      if (!result.success) {
        throw new Error(result.error || 'Import failed');
      }

      refresh();
    } catch (err) {
      console.error('[DirectoryPanel] File upload error:', err);
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsUploading(false);
    }
  }, [isUploading, refresh, apiPost, fileToBase64]);

  // Handle file paths from Tauri drag-drop (copies from OS paths)
  const handleTauriFileDrop = useCallback(async (paths: string[], targetDir: string = '') => {
    if (paths.length === 0 || isUploading) {
      return;
    }

    setIsUploading(true);
    try {
      // Use /api/files/copy which handles copying from OS paths
      const result = await apiPost<{
        success: boolean;
        copiedFiles: Array<{ sourcePath: string; targetPath: string; renamed: boolean }>;
        error?: string;
      }>('/api/files/copy', {
        sourcePaths: paths,
        targetDir: targetDir,
        autoRename: true,
      });

      if (!result.success) {
        throw new Error(result.error || 'Copy failed');
      }

      if (isDebugMode()) {
        console.log('[DirectoryPanel] Tauri drop copied files:', result.copiedFiles);
      }
      refresh();
    } catch (err) {
      console.error('[DirectoryPanel] Tauri file drop error:', err);
      setError(err instanceof Error ? err.message : 'Copy failed');
    } finally {
      setIsUploading(false);
    }
  }, [isUploading, refresh, apiPost]);

  // Expose imperative handle for parent to call
  useImperativeHandle(ref, () => ({
    handleFileDrop: async (paths: string[]) => {
      // Determine target directory based on selection (use first selected item)
      let targetDir = '';
      const firstSelected = selectedNodes[0];
      if (firstSelected) {
        if (firstSelected.type === 'dir') {
          targetDir = firstSelected.path;
        } else {
          // For files, use parent directory
          const parts = firstSelected.path.split('/');
          parts.pop();
          targetDir = parts.join('/');
        }
      }
      await handleTauriFileDrop(paths, targetDir);
    },
    refresh,
  }), [selectedNodes, handleTauriFileDrop, refresh]);

  // Check if a drag event contains external files
  const isExternalFileDrag = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types ?? [];
    return types.includes('Files');
  }, []);

  // Tree container drag handlers
  const handleTreeDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isExternalFileDrag(e)) {
      return;
    }

    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsExternalDrop(true);
    }
  }, [isExternalFileDrag]);

  const handleTreeDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isExternalFileDrag(e)) return;

    e.dataTransfer.dropEffect = 'copy';
  }, [isExternalFileDrag]);

  const handleTreeDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsExternalDrop(false);
      setDropTargetPath(null);
    }
  }, []);

  const handleTreeDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current = 0;
    setIsExternalDrop(false);

    const targetPath = dropTargetPath ?? '';
    setDropTargetPath(null);

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      if (isDebugMode()) {
        console.log('[DirectoryPanel] Dropped', files.length, 'files to:', targetPath || 'root');
      }
      void handleExternalFileDrop(files, targetPath);
    }
  }, [dropTargetPath, handleExternalFileDrop]);

  // Row-level drag handlers for directory highlighting
  const handleRowDragEnter = useCallback((e: React.DragEvent, nodePath: string, isDir: boolean) => {
    e.stopPropagation();
    if (!isExternalFileDrag(e)) return;

    // Only highlight directories
    if (isDir) {
      setDropTargetPath(nodePath);
    }
  }, [isExternalFileDrag]);

  const handleRowDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    // Don't clear dropTargetPath here - let tree level handler or drop handler do it
  }, []);

  // Keyboard paste handler (Cmd/Ctrl+V)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      // Check if DirectoryPanel is focused or its children
      if (!panelRef.current?.contains(document.activeElement) &&
          document.activeElement !== panelRef.current) {
        return;
      }

      // Check if it's a text input/textarea - don't intercept paste there
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }

      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length === 0) {
        return;
      }

      e.preventDefault();

      // Determine target directory based on selection (use first selected item)
      let targetDir = '';
      const firstSelected = selectedNodes[0];
      if (firstSelected) {
        if (firstSelected.type === 'dir') {
          targetDir = firstSelected.path;
        } else {
          // For files, use parent directory
          const parts = firstSelected.path.split('/');
          parts.pop();
          targetDir = parts.join('/');
        }
      }

      if (isDebugMode()) {
        console.log('[DirectoryPanel] Pasting', files.length, 'files to:', targetDir || 'root');
      }
      await handleExternalFileDrop(files, targetDir);
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [selectedNodes, handleExternalFileDrop]);

  const handleOpenInFinder = async (path: string) => {
    try {
      await apiPost('/agent/open-in-finder', { path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open');
    }
  };

  const handleRename = async (oldPath: string, newName: string) => {
    try {
      await apiPost('/agent/rename', { oldPath, newName });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const handleDelete = async (path: string) => {
    try {
      await apiPost('/agent/delete', { path });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleNewFile = async (parentDir: string, name: string) => {
    try {
      await apiPost('/agent/new-file', { parentDir, name });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const handleNewFolder = async (parentDir: string, name: string) => {
    try {
      await apiPost('/agent/new-folder', { parentDir, name });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const handleContextMenu = (e: React.MouseEvent, node: DirectoryTreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();

    // If right-clicking on empty area, clear selection and show root menu
    if (!node) {
      setSelectedNodes([]);
      setContextMenu({ x: e.clientX, y: e.clientY, node: null, isMultiSelect: false });
      return;
    }

    // If the clicked node is already in selection and we have multiple selections,
    // show multi-select menu
    const isAlreadySelected = selectedNodes.some(n => n.path === node.path);
    if (isAlreadySelected && selectedNodes.length > 1) {
      setContextMenu({ x: e.clientX, y: e.clientY, node, isMultiSelect: true });
    } else {
      // Single selection - select only this node
      setSelectedNodes([node]);
      lastClickedNodeRef.current = node;
      setContextMenu({ x: e.clientX, y: e.clientY, node, isMultiSelect: false });
    }
  };

  const handleTreeContainerContextMenu = (e: React.MouseEvent) => {
    // Only trigger if clicking on empty area (not on a tree item)
    const target = e.target as HTMLElement;
    if (target === treeContainerRef.current || target.closest('[data-tree-root]')) {
      handleContextMenu(e, null);
    }
  };

  // Get unique parent directories for multi-select "open in finder"
  const getUniqueParentDirs = (nodes: DirectoryTreeNode[]): string[] => {
    const parentDirs = new Set<string>();
    for (const node of nodes) {
      if (node.type === 'dir') {
        parentDirs.add(node.path);
      } else {
        const parts = node.path.split('/');
        parts.pop();
        parentDirs.add(parts.join('/') || '.');
      }
    }
    return Array.from(parentDirs);
  };

  // Handle multi-select delete
  const handleDeleteMultiple = async (nodes: DirectoryTreeNode[]) => {
    try {
      // Filter out nodes whose parent is also selected (avoid deleting already-deleted paths)
      const nodePaths = new Set(nodes.map(n => n.path));
      const filteredNodes = nodes.filter(node => {
        // Check if any other selected node is a parent of this node
        const parts = node.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parentPath = parts.slice(0, i).join('/');
          if (nodePaths.has(parentPath)) {
            return false; // Skip this node, its parent will be deleted
          }
        }
        return true;
      });

      for (const node of filteredNodes) {
        await apiPost('/agent/delete', { path: node.path });
      }
      setSelectedNodes([]);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const getContextMenuItems = (node: DirectoryTreeNode | null, isMultiSelect?: boolean): ContextMenuItem[] => {
    // Multi-select menu
    if (isMultiSelect && selectedNodes.length > 1) {
      const uniqueParentDirs = getUniqueParentDirs(selectedNodes);
      return [
        {
          label: `打开所在文件夹 (${uniqueParentDirs.length})`,
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => {
            for (const dir of uniqueParentDirs) {
              void handleOpenInFinder(dir);
            }
          }
        },
        {
          label: `引用 (${selectedNodes.length})`,
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => {
            onInsertReference?.(selectedNodes.map(n => n.path));
          }
        },
        {
          label: `删除 (${selectedNodes.length})`,
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onClick: () => setDialog({ type: 'delete-multi', node: null, nodes: selectedNodes })
        }
      ];
    }

    // Root directory menu (empty area)
    if (!node) {
      return [
        {
          label: '导入文件',
          icon: <Upload className="h-4 w-4" />,
          onClick: () => {
            setImportTargetDir('');
            importInputRef.current?.click();
          }
        },
        {
          label: '新建文件',
          icon: <FilePlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-file', node: null })
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-folder', node: null })
        },
        {
          label: '刷新',
          icon: <RefreshCw className="h-4 w-4" />,
          onClick: refresh
        }
      ];
    }

    const isDir = node.type === 'dir';
    const canPreview = !isDir && isPreviewable(node.name);

    if (isDir) {
      return [
        {
          label: '新建文件',
          icon: <FilePlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-file', node })
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-folder', node })
        },
        {
          label: '导入文件',
          icon: <Upload className="h-4 w-4" />,
          onClick: () => {
            setImportTargetDir(node.path);
            importInputRef.current?.click();
          }
        },
        {
          label: '打开所在文件夹',
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => handleOpenInFinder(node.path)
        },
        {
          label: '引用',
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => onInsertReference?.([node.path])
        },
        {
          label: '重命名',
          icon: <Pencil className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'rename', node })
        },
        {
          label: '删除',
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onClick: () => setDialog({ type: 'delete', node })
        }
      ];
    } else {
      return [
        {
          label: '预览',
          icon: <Eye className="h-4 w-4" />,
          disabled: !canPreview,
          onClick: () => {
            if (canPreview) {
              void handlePreview(node);
            }
          }
        },
        {
          label: '引用',
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => onInsertReference?.([node.path])
        },
        {
          label: '打开所在文件夹',
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => handleOpenInFinder(node.path)
        },
        {
          label: '重命名',
          icon: <Pencil className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'rename', node })
        },
        {
          label: '删除',
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onClick: () => setDialog({ type: 'delete', node })
        }
      ];
    }
  };

  // Get parent directory path for new file/folder creation
  const getParentDirForCreate = (node: DirectoryTreeNode | null): string => {
    if (!node) return ''; // root directory
    if (node.type === 'dir') return node.path;
    // For files, get parent directory
    const parts = node.path.split('/');
    parts.pop();
    return parts.join('/');
  };

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      className={`flex flex-col border-l border-[var(--line)] bg-[var(--paper-strong)] outline-none ${isNarrowMode && isCollapsed ? 'h-12' : 'h-full'
        }`}
    >
      {/* Title bar - aligned with left panel header */}
      <div
        className={`flex h-12 flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-4 select-none ${isNarrowMode ? 'cursor-pointer hover:bg-[var(--paper-contrast)]/50' : ''
          }`}
        onClick={isNarrowMode ? () => setIsCollapsed(!isCollapsed) : undefined}
      >
        <div className="flex items-center gap-2">
          {/* Collapse toggle button - in wide mode, calls onCollapse */}
          {!isNarrowMode && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
              title="收起工作区"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
          {/* Collapse toggle button - only in narrow mode */}
          {isNarrowMode && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsCollapsed(!isCollapsed);
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
              title={isCollapsed ? '展开工作区' : '折叠工作区'}
            >
              <ChevronUp className={`h-4 w-4 transition-transform ${isCollapsed ? 'rotate-180' : ''}`} />
            </button>
          )}
          <span className="text-sm font-semibold text-[var(--ink)]">项目工作区</span>
        </div>
        {/* 项目设置 button on right */}
        {onOpenConfig && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenConfig();
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
            title="打开项目设置"
          >
            项目设置
          </button>
        )}
      </div>

      {/* Collapsible content - hidden in narrow mode when collapsed */}
      {!(isNarrowMode && isCollapsed) && (
        <>
          {/* Folder header with name, path, stats - two row layout */}
          <div className="border-b border-[var(--line)] px-4 py-3">
            {/* First row: folder icon, name, git branch, and stats */}
            <div className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-[var(--accent-cool)]" />
              <span className="truncate text-sm font-semibold text-[var(--ink)]">{folderName}</span>
              {gitBranch && (
                <span className="flex items-center gap-1 rounded bg-[var(--paper-strong)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                  <GitBranch className="h-3 w-3" />
                  {gitBranch}
                </span>
              )}
              {directoryInfo && (
                <span className="ml-auto flex-shrink-0 text-[10px] text-[var(--ink-muted)]">
                  {directoryInfo.summary.totalFiles} 文件 · {directoryInfo.summary.totalDirs} 文件夹
                </span>
              )}
            </div>
            {/* Second row: full path */}
            <div className="mt-1 truncate pl-6 text-[10px] text-[var(--ink-muted)]">{agentDir}</div>
            {/* Hidden file input for import functionality */}
            <input
              ref={importInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => handleImport(event.target.files)}
              disabled={isUploading}
            />
          </div>

          {/* Tree container */}
          <div
            ref={treeContainerRef}
            className={`min-h-0 flex-1 overflow-hidden ${isExternalDrop || isTauriDragActive ? 'ring-2 ring-inset ring-[var(--accent)]/30' : ''}`}
            onContextMenu={handleTreeContainerContextMenu}
            onDragEnter={handleTreeDragEnter}
            onDragOver={handleTreeDragOver}
            onDragLeave={handleTreeDragLeave}
            onDrop={handleTreeDrop}
            onClick={(e) => {
              // Clear selection when clicking empty area in tree container
              // Check if clicked on a tree row (has data-tree-row attribute) or its children
              const target = e.target as HTMLElement;
              const isTreeRow = target.closest('[data-tree-row]');
              if (!isTreeRow) {
                // Clicked on empty area, clear selection
                setSelectedNodes([]);
                lastClickedNodeRef.current = null;
              }
            }}
            data-tree-root
          >
            {error && <div className="px-4 py-3 text-xs text-[var(--error)]">{error}</div>}
            {!error && !directoryInfo && (
              <div className="px-4 py-3 text-xs text-[var(--ink-muted)]">Loading...</div>
            )}
            {directoryInfo && (
              <Tree
                data={treeData}
                openByDefault={false}
                disableDrag
                disableDrop
                disableMultiSelection
                disableEdit
                rowHeight={26}
                indent={16}
                height={treeHeight}
                width="100%"
              >
                {({ node, style }) => {
                  const data = node.data as DirectoryTreeNode;
                  const isDir = data.type === 'dir';
                  // Check if this is the myagents_files folder (special folder for imported files)
                  const isMyAgentsFiles = data.path === 'myagents_files' && isDir;
                  const Icon =
                    isDir ?
                      node.isOpen ?
                        FolderOpen
                        : Folder
                      : FileText;

                  const isLoadingDir = isDir && loadingDirs.has(data.path);
                  const isDropTarget = isDir && dropTargetPath === data.path && isExternalDrop;
                  const isSelected = isNodeSelected(data);

                  // Helper to execute file preview (extracted for reuse)
                  const executeFilePreview = async () => {
                    // Select the file immediately
                    setSelectedNodes([data]);
                    lastClickedNodeRef.current = data;

                    // Preview based on file type
                    if (isImageFile(data.name)) {
                      try {
                        // Use Tab-scoped fetch to ensure correct Sidecar in multi-Tab scenarios
                        const endpoint = `/agent/download?path=${encodeURIComponent(data.path)}`;
                        let response: Response;
                        if (isTauri()) {
                          const baseUrl = await getTabServerUrl(tabId);
                          response = await proxyFetch(`${baseUrl}${endpoint}`);
                        } else {
                          response = await fetch(endpoint);
                        }
                        const blob = await response.blob();
                        const dataUrl = await new Promise<string>((resolve) => {
                          const reader = new FileReader();
                          reader.onload = () => resolve(reader.result as string);
                          reader.readAsDataURL(blob);
                        });
                        openPreview(dataUrl, data.name);
                      } catch (err) {
                        console.error('[DirectoryPanel] Failed to load image:', err);
                        toast.error('图片加载失败');
                      }
                    } else if (isPreviewable(data.name)) {
                      void handlePreview(data);
                    } else {
                      // File type not supported for preview
                      toast.info('暂不支持预览此文件类型，可右键进入文件夹打开');
                    }
                  };

                  // Unified click handler with custom double-click detection
                  // We implement our own double-click detection because React's onDoubleClick
                  // is unreliable when state updates cause re-renders between clicks
                  const handleRowClick = (e: React.MouseEvent) => {
                    const now = Date.now();
                    const lastClick = lastClickRef.current;

                    // Check if this is a double-click (same path, within threshold)
                    const isDoubleClick = lastClick &&
                      lastClick.path === data.path &&
                      (now - lastClick.time) < DOUBLE_CLICK_THRESHOLD_MS;

                    // Update last click info for next click detection
                    lastClickRef.current = { path: data.path, time: now };

                    // Clear any pending single-click timer
                    if (clickTimerRef.current) {
                      clearTimeout(clickTimerRef.current);
                      clickTimerRef.current = null;
                    }

                    // Handle double-click on files (not directories)
                    if (isDoubleClick && !isDir) {
                      void executeFilePreview();
                      return;
                    }

                    // Handle single-click (selection logic)
                    const isMeta = e.metaKey || e.ctrlKey;
                    const isShift = e.shiftKey;

                    // Multi-select operations are immediate (no delay needed)
                    if (isMeta) {
                      // Ctrl/Cmd + click: toggle selection
                      setSelectedNodes(prev =>
                        prev.some(n => n.path === data.path)
                          ? prev.filter(n => n.path !== data.path)
                          : [...prev, data]
                      );
                      lastClickedNodeRef.current = data;
                    } else if (isShift && lastClickedNodeRef.current) {
                      // Shift + click: range selection
                      const startIdx = flattenedNodes.findIndex(n => n.path === lastClickedNodeRef.current!.path);
                      const endIdx = flattenedNodes.findIndex(n => n.path === data.path);
                      if (startIdx !== -1 && endIdx !== -1) {
                        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                        setSelectedNodes(flattenedNodes.slice(from, to + 1));
                      }
                    } else if (isSelected && selectedNodes.length === 1) {
                      // Already selected as single item - no state change needed
                      lastClickedNodeRef.current = data;
                    } else {
                      // Normal click: delay selection to allow double-click detection
                      clickTimerRef.current = setTimeout(() => {
                        setSelectedNodes([data]);
                        lastClickedNodeRef.current = data;
                        clickTimerRef.current = null;
                      }, SINGLE_CLICK_DELAY_MS);
                    }

                    // Toggle directory expand/collapse (immediate for better UX)
                    if (isDir) {
                      if (!node.isOpen && data.loaded === false) {
                        void expandDir(data.path);
                      }
                      node.toggle();
                    }
                  };

                  return (
                    <div
                      style={style}
                      data-tree-row
                      className={`flex h-full cursor-pointer items-center gap-2 px-3 text-[11px] transition-colors select-none ${
                        isDropTarget
                          ? 'ring-2 ring-inset ring-[var(--accent)]/50 bg-[var(--accent)]/10'
                          : isSelected
                            ? 'bg-[var(--paper-contrast)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]'
                        }`}
                      onClick={handleRowClick}
                      onContextMenu={(e) => handleContextMenu(e, data)}
                      onDragEnter={(e) => handleRowDragEnter(e, data.path, isDir)}
                      onDragLeave={handleRowDragLeave}
                    >
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--ink-muted)]">
                        {isLoadingDir ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : node.isInternal ? (
                          <ChevronRight
                            className={`h-3 w-3 transition-transform ${node.isOpen ? 'rotate-90' : ''}`}
                          />
                        ) : null}
                      </span>
                      <Icon
                        className={`h-3.5 w-3.5 flex-shrink-0 ${
                          isMyAgentsFiles
                            ? 'text-[var(--accent-warm)]'
                            : isDir
                              ? 'text-[var(--accent-cool)]'
                              : 'text-[var(--accent)]'
                          }`}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium select-none">{data.name}</span>
                    </div>
                  );
                }}
              </Tree>
            )}
          </div>
        </>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.node, contextMenu.isMultiSelect)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Rename Dialog */}
      {dialog?.type === 'rename' && dialog.node && (
        <RenameDialog
          currentName={dialog.node.name}
          itemType={dialog.node.type === 'dir' ? 'folder' : 'file'}
          onRename={(newName) => {
            void handleRename(dialog.node!.path, newName);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* New File Dialog */}
      {dialog?.type === 'new-file' && (
        <RenameDialog
          currentName=""
          itemType="file"
          onRename={(name) => {
            void handleNewFile(getParentDirForCreate(dialog.node), name);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* New Folder Dialog */}
      {dialog?.type === 'new-folder' && (
        <RenameDialog
          currentName=""
          itemType="folder"
          onRename={(name) => {
            void handleNewFolder(getParentDirForCreate(dialog.node), name);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Delete Confirm Dialog */}
      {dialog?.type === 'delete' && dialog.node && (
        <ConfirmDialog
          title={`删除${dialog.node.type === 'dir' ? '文件夹' : '文件'}`}
          message={`确定要删除 "${dialog.node.name}" 吗？此操作无法撤销。`}
          confirmLabel="删除"
          cancelLabel="取消"
          danger
          onConfirm={() => {
            void handleDelete(dialog.node!.path);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Multi-Delete Confirm Dialog */}
      {dialog?.type === 'delete-multi' && dialog.nodes && dialog.nodes.length > 0 && (
        <ConfirmDialog
          title={`删除 ${dialog.nodes.length} 个项目`}
          message={`确定要删除选中的 ${dialog.nodes.length} 个文件/文件夹吗？此操作无法撤销。`}
          confirmLabel="全部删除"
          cancelLabel="取消"
          danger
          onConfirm={() => {
            void handleDeleteMultiple(dialog.nodes!);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Preview modal - lazy loaded, no fallback (modal appears after module loads) */}
      {(preview || previewError || isPreviewLoading) && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={preview?.name ?? 'Preview'}
            content={preview?.content ?? ''}
            size={preview?.size ?? 0}
            path={preview?.path ?? ''}
            isLoading={isPreviewLoading}
            error={previewError}
            onClose={() => {
              setPreview(null);
              setPreviewError(null);
            }}
            onSaved={refresh}
          />
        </Suspense>
      )}
    </div>
  );
});

export default DirectoryPanel;
