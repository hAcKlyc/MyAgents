import { ChevronDown, ChevronUp, Image, Plus, Send, Square, X, FileText, AtSign, Command, Wrench } from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';

import { useToast } from '@/components/Toast';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useTabStateOptional } from '@/context/TabContext';
import { type PermissionMode, PERMISSION_MODES, type Provider, type ProviderVerifyStatus, getModelDisplayName, type ModelEntity } from '@/config/types';
import SlashCommandMenu, { type SlashCommand, filterAndSortCommands } from './SlashCommandMenu';
import { useUndoStack } from '@/hooks/useUndoStack';
import { isImageFile, isImageMimeType, ALLOWED_IMAGE_MIME_TYPES } from '../../shared/fileTypes';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { isDebugMode } from '@/utils/debug';

// Image attachment type
export interface ImageAttachment {
  id: string;
  file: File;
  preview: string; // data URL for preview
}

interface SimpleChatInputProps {
  /** Optional external value for controlled scenarios (e.g., restoring draft) */
  value?: string;
  /** Optional callback when value changes - not recommended for performance reasons */
  onChange?: (value: string) => void;
  /** Called when user sends message. Text is managed internally for performance. */
  onSend: (text: string, images?: ImageAttachment[], permissionMode?: PermissionMode) => void;
  onStop?: () => void; // Called when stop button is clicked
  isLoading: boolean;
  /** System status (e.g., 'compacting') - when set, shows disabled send button instead of stop */
  systemStatus?: string | null;
  agentDir?: string; // For @file search
  // Provider/Model selection
  provider?: Provider | null; // Current provider for model selection
  providers?: Provider[]; // All available providers for switching
  onProviderChange?: (providerId: string) => void; // Called when provider is changed
  selectedModel?: string; // Current selected model ID
  onModelChange?: (modelId: string) => void; // Called when model is changed
  // Permission modes
  permissionMode?: PermissionMode; // Current permission mode from parent
  onPermissionModeChange?: (mode: PermissionMode) => void;
  apiKeys?: Record<string, string>; // API keys for providers
  providerVerifyStatus?: Record<string, ProviderVerifyStatus>; // Persisted verification status
  /** External ref for focus control (used for Tab switching) */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  // MCP workspace toggle
  workspaceMcpEnabled?: string[];  // IDs of MCPs enabled for this workspace
  globalMcpEnabled?: string[];     // IDs of globally enabled MCPs
  mcpServers?: Array<{ id: string; name: string; description?: string }>; // All available MCP servers
  onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
  /** Callback to refresh providers data when opening model menu */
  onRefreshProviders?: () => void;
  /** Callback to open Agent settings (WorkspaceConfigPanel) */
  onOpenAgentSettings?: () => void;
  /** Callback to refresh workspace after files are added */
  onWorkspaceRefresh?: () => void;
}

const LINE_HEIGHT = 24; // px per line
const MAX_LINES_COLLAPSED = 3;
const MAX_LINES_EXPANDED = 12;
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// Methods exposed to parent via ref
export interface SimpleChatInputHandle {
  /** Process dropped files - copies to myagents_files and inserts @references */
  processDroppedFiles: (files: File[]) => Promise<void>;
  /** Process dropped file paths from Tauri - copies to myagents_files and inserts @references */
  processDroppedFilePaths?: (paths: string[]) => Promise<void>;
  /** Insert @references at cursor position or end of input */
  insertReferences: (paths: string[]) => void;
}

// File search result type
interface FileSearchResult {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

const SimpleChatInput = forwardRef<SimpleChatInputHandle, SimpleChatInputProps>(function SimpleChatInput({
  value: externalValue,
  onChange: externalOnChange,
  onSend,
  onStop,
  isLoading,
  systemStatus,
  agentDir,
  provider,
  providers = [],
  onProviderChange,
  selectedModel,
  onModelChange,
  permissionMode = 'auto',
  onPermissionModeChange,
  apiKeys = {},
  providerVerifyStatus = {},
  inputRef,
  workspaceMcpEnabled = [],
  globalMcpEnabled = [],
  mcpServers = [],
  onWorkspaceMcpToggle,
  onRefreshProviders,
  onOpenAgentSettings,
  onWorkspaceRefresh,
}, ref) {
  // PERFORMANCE FIX: Use internal state to avoid parent re-renders on every keystroke
  // This prevents MessageList from re-rendering when typing in long conversations
  const [inputValue, setInputValue] = useState(externalValue ?? '');

  // Sync with external value when it changes (e.g., after send clears input)
  // NOTE: Intentionally only depend on externalValue - we only want to sync when
  // external value changes, not when internal inputValue changes (would cause loop)
  useEffect(() => {
    if (externalValue !== undefined && externalValue !== inputValue) {
      setInputValue(externalValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalValue]);

  // Check if a provider is available:
  // - Subscription type: always available
  // - API type: must have key AND verification status must be 'valid' (or not yet verified)
  const isProviderAvailable = (p: Provider): boolean => {
    if (p.type === 'subscription') return true;
    const hasKey = !!apiKeys[p.id];
    if (!hasKey) return false;
    // If verified and invalid, not available. If not verified yet or valid, available.
    const verifyResult = providerVerifyStatus[p.id];
    return verifyResult?.status !== 'invalid';
  };

  // Get Tab-scoped API functions (for @file search and file operations)
  const tabContext = useTabStateOptional();
  const apiGet = tabContext?.apiGet;
  const apiPost = tabContext?.apiPost;

  const toast = useToast();
  // Stabilize toast reference to avoid unnecessary effect re-runs
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const { openPreview } = useImagePreview();
  // Use external ref if provided, otherwise use internal ref
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // Image attachments - moved up for processDroppedFiles to use
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // Undo stack for file reference insertions
  const undoStack = useUndoStack({ maxSize: 20 });

  // Ref for latest inputValue (for stable insertReferences callback)
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  // Plus menu
  const [showPlusMenu, setShowPlusMenu] = useState(false);


  // Mode and Model dropdown menus
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showProviderSubmenu, setShowProviderSubmenu] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);

  // Derive current model ID from prop or provider default
  const currentModelId = selectedModel ?? provider?.primaryModel ?? 'claude-sonnet-4-5-20250929';
  // Get display name for current model
  const currentModelName = provider ? getModelDisplayName(provider, currentModelId) : currentModelId;

  // @file search
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [fileSearchResults, setFileSearchResults] = useState<FileSearchResult[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [atPosition, setAtPosition] = useState<number | null>(null);
  const [isFileSearching, setIsFileSearching] = useState(false); // Track if actively searching

  // /slash command search
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashSearchQuery, setSlashSearchQuery] = useState('');
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [slashPosition, setSlashPosition] = useState<number | null>(null);

  // Pending user-level skill copies (SDK only reads from project .claude/skills/)
  // Use Map to track multiple concurrent copy operations and avoid race conditions
  const pendingSkillCopiesRef = useRef<Map<string, Promise<boolean>>>(new Map());

  // Close all dropdown menus (plus, mode, model, provider)
  const closeAllMenus = useCallback(() => {
    setShowPlusMenu(false);
    setShowModeMenu(false);
    setShowModelMenu(false);
    setShowProviderSubmenu(false);
    setShowToolMenu(false);
  }, []);

  // Close all menus when clicking outside (toolbar buttons use stopPropagation to prevent this)
  useEffect(() => {
    const handleClickOutside = () => {
      closeAllMenus();
      setShowSlashMenu(false);
      setSlashPosition(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [closeAllMenus]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (isExpanded) {
      textarea.style.height = `${LINE_HEIGHT * MAX_LINES_EXPANDED}px`;
    } else {
      textarea.style.height = 'auto';
      const maxHeight = LINE_HEIGHT * MAX_LINES_COLLAPSED;
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
    }
  }, [inputValue, isExpanded]);

  // Fetch slash commands function (extracted for reuse)
  const fetchCommands = useCallback(async () => {
    if (!apiGet) return;

    try {
      const response = await apiGet<{ success: boolean; commands: SlashCommand[] }>('/api/commands');
      if (response.success && response.commands.length > 0) {
        setSlashCommands(response.commands);
      } else {
        // Fallback to builtin commands imported from SlashCommandMenu
        console.warn('[slash-commands] API returned empty, using builtin fallback');
        setSlashCommands([
          { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
          { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
          { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
          { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
          { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
          { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
          { name: 'review', description: '对代码进行审查', source: 'builtin' },
          { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
        ]);
      }
    } catch (err) {
      console.error('Failed to fetch slash commands, using fallback:', err);
      // Fallback to builtin commands
      setSlashCommands([
        { name: 'compact', description: '压缩对话历史，释放上下文空间', source: 'builtin' },
        { name: 'context', description: '显示或管理当前上下文', source: 'builtin' },
        { name: 'cost', description: '查看 token 使用量和费用', source: 'builtin' },
        { name: 'init', description: '初始化项目配置 (.CLAUDE.md)', source: 'builtin' },
        { name: 'pr-comments', description: '生成 Pull Request 评论', source: 'builtin' },
        { name: 'release-notes', description: '根据最近提交生成发布说明', source: 'builtin' },
        { name: 'review', description: '对代码进行审查', source: 'builtin' },
        { name: 'security-review', description: '进行安全相关的代码审查', source: 'builtin' },
      ]);
    }
  }, [apiGet]);

  // Fetch slash commands on mount or when agentDir changes
  useEffect(() => {
    fetchCommands();
  }, [agentDir, fetchCommands]);

  // Listen for skill copy events to refresh commands list
  useEffect(() => {
    const handleSkillCopied = () => {
      // Delay slightly to ensure file system is updated
      setTimeout(() => {
        fetchCommands();
      }, 100);
    };
    window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
  }, [fetchCommands]);

  // Copy user-level skill to project directory (SDK only reads from <project>/.claude/skills/)
  const triggerSkillCopy = useCallback((skillName: string) => {
    if (!apiPost || !agentDir) return;

    // Skip if already copying this skill (avoid duplicate requests)
    if (pendingSkillCopiesRef.current.has(skillName)) return;

    const copyPromise = (async (): Promise<boolean> => {
      try {
        const response = await apiPost<{ success: boolean; alreadyExists?: boolean; error?: string }>(
          '/api/skill/copy',
          { skillName, agentDir }
        );
        if (response.success) {
          if (!response.alreadyExists) {
            toastRef.current.success(`已将 skill "${skillName}" 添加到本项目`);
          }
          // Notify workspace config panel to refresh (if open)
          window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, { detail: { skillName } }));
          return true;
        } else {
          toastRef.current.warning(response.error || `复制 skill "${skillName}" 失败`);
          return false;
        }
      } catch (err) {
        console.error('[skill-copy] Error:', err);
        toastRef.current.warning(`复制 skill "${skillName}" 失败`);
        return false;
      } finally {
        // Clean up after completion
        pendingSkillCopiesRef.current.delete(skillName);
      }
    })();

    pendingSkillCopiesRef.current.set(skillName, copyPromise);
  }, [apiPost, agentDir]);

  // Handle user-level skill selection - trigger copy if needed
  const handleSkillSelect = useCallback((cmd: SlashCommand) => {
    // If it's a user-level skill, trigger copy to project
    // Use folderName (actual folder name) instead of name (display name)
    if (cmd.source === 'skill' && cmd.scope === 'user' && cmd.folderName) {
      triggerSkillCopy(cmd.folderName);
    }
  }, [triggerSkillCopy]);

  // Validate and add image
  const addImage = useCallback((file: File) => {
    if (images.length >= MAX_IMAGES) {
      toastRef.current.warning(`最多只能上传 ${MAX_IMAGES} 张图片`);
      return;
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
      toastRef.current.warning('不支持的图片格式，请使用 PNG/JPG/GIF/WebP');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toastRef.current.warning('图片大小不能超过 5MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const preview = e.target?.result as string;
      setImages((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        file,
        preview,
      }]);
    };
    reader.readAsDataURL(file);
  }, [images.length]);

  // Remove image
  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

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

  // Process dropped files - copies to myagents_files and inserts @references
  const processDroppedFiles = useCallback(async (files: File[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFiles called with', files.length, 'files:', files.map(f => f.name));
    }

    if (!apiPost) {
      console.error('[SimpleChatInput] apiPost not available');
      toastRef.current.error('无法处理文件：API 未就绪');
      return;
    }

    // Separate images and non-images
    const imageFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of files) {
      if (isImageFile(file.name) || isImageMimeType(file.type)) {
        imageFiles.push(file);
      } else {
        otherFiles.push(file);
      }
    }

    // Handle image files with the original addImage logic
    for (const file of imageFiles) {
      addImage(file);
    }

    // Handle non-image files - upload to myagents_files and insert @references
    if (otherFiles.length > 0) {
      try {
        // Convert files to base64 for JSON upload (works in Tauri)
        const base64Files = await Promise.all(
          otherFiles.map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          }))
        );

        // Upload via base64 API endpoint
        const result = await apiPost<{ success: boolean; files: string[]; error?: string }>(
          '/api/files/import-base64',
          { files: base64Files, targetDir: 'myagents_files' }
        );

        if (!result.success || !result.files || result.files.length === 0) {
          throw new Error(result.error || '上传失败');
        }

        // Add .gitignore rule for myagents_files folder
        try {
          await apiPost('/api/files/add-gitignore', { pattern: 'myagents_files/' });
        } catch (err) {
          // Non-fatal, continue silently
        }

        // Insert @references into input
        const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
        const references = result.files.map(path => `@${path}`).join(' ');

        const before = inputValue.slice(0, cursorPos);
        const after = inputValue.slice(cursorPos);
        const insertedText = references + ' ';
        const newValue = before + insertedText + after;

        setInputValue(newValue);

        // Generate batch ID for this operation (all files in one drop share same batch)
        const batchId = undoStack.generateBatchId();

        // Push to undo stack for each file with same batchId
        for (const filePath of result.files) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${filePath} `,
            insertPosition: cursorPos,
            copiedFilePath: filePath,
          });
        }

        toastRef.current.success(`已添加 ${result.files.length} 个文件到工作区`);

        // Refresh workspace to show new files
        onWorkspaceRefresh?.();
      } catch (err) {
        console.error('[SimpleChatInput] File upload error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件上传失败');
      }
    }
  }, [apiPost, addImage, inputValue, textareaRef, undoStack, fileToBase64, onWorkspaceRefresh]);

  // Process file paths from Tauri drag-drop (uses /api/files/copy)
  const processDroppedFilePaths = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFilePaths called with', paths.length, 'paths:', paths);
    }

    if (!apiPost) {
      console.error('[SimpleChatInput] apiPost not available');
      toastRef.current.error('无法处理文件：API 未就绪');
      return;
    }

    // Separate images and non-images based on extension
    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    for (const path of paths) {
      // Support both / and \ path separators
      const filename = path.split(/[\\/]/).pop() || path;
      if (isImageFile(filename)) {
        imagePaths.push(path);
      } else {
        otherPaths.push(path);
      }
    }

    // Handle image files - read via backend API and add as image attachments
    if (imagePaths.length > 0) {
      try {
        const readResult = await apiPost<{
          success: boolean;
          files: Array<{
            path: string;
            name: string;
            mimeType: string;
            data: string;
            error?: string;
          }>;
        }>('/api/files/read-as-base64', { paths: imagePaths });

        if (readResult.success && readResult.files) {
          for (const fileData of readResult.files) {
            if (fileData.data && !fileData.error) {
              // Create a File object from base64 data
              const byteString = atob(fileData.data);
              const ab = new ArrayBuffer(byteString.length);
              const ia = new Uint8Array(ab);
              for (let i = 0; i < byteString.length; i++) {
                ia[i] = byteString.charCodeAt(i);
              }
              const blob = new Blob([ab], { type: fileData.mimeType });
              const file = new File([blob], fileData.name, { type: fileData.mimeType });
              addImage(file);
            }
          }
        }
      } catch (err) {
        // If image reading fails, fall back to treating them as regular files
        if (isDebugMode()) {
          console.warn('[SimpleChatInput] Failed to read images, treating as regular files:', err);
        }
        otherPaths.push(...imagePaths);
        imagePaths.length = 0;
      }
    }

    // Handle non-image files - copy to myagents_files and insert @references
    if (otherPaths.length > 0) {
      try {
        // Copy files to myagents_files using /api/files/copy
        const result = await apiPost<{
          success: boolean;
          copiedFiles: Array<{ sourcePath: string; targetPath: string; renamed: boolean }>;
          error?: string;
        }>('/api/files/copy', {
          sourcePaths: otherPaths,
          targetDir: 'myagents_files',
          autoRename: true,
        });

        if (!result.success) {
          throw new Error(result.error || '复制失败');
        }

        // Handle partial success - some files may have been copied
        const successfulCopies = result.copiedFiles || [];
        if (successfulCopies.length === 0) {
          throw new Error('没有文件被成功复制');
        }

        // Add .gitignore rule for myagents_files folder
        try {
          await apiPost('/api/files/add-gitignore', { pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently
        }

        // Insert @references into input
        const cursorPos = textareaRef.current?.selectionStart ?? inputValue.length;
        const references = successfulCopies.map(f => `@${f.targetPath}`).join(' ');

        const before = inputValue.slice(0, cursorPos);
        const after = inputValue.slice(cursorPos);
        const insertedText = references + ' ';
        const newValue = before + insertedText + after;

        setInputValue(newValue);

        // Generate batch ID for this operation
        const batchId = undoStack.generateBatchId();

        // Push to undo stack for each file with same batchId
        for (const file of successfulCopies) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${file.targetPath} `,
            insertPosition: cursorPos,
            copiedFilePath: file.targetPath,
          });
        }

        // Show appropriate message
        if (successfulCopies.length < otherPaths.length) {
          toastRef.current.warning(`已添加 ${successfulCopies.length}/${otherPaths.length} 个文件到工作区`);
        } else {
          toastRef.current.success(`已添加 ${successfulCopies.length} 个文件到工作区`);
        }

        // Refresh workspace to show new files
        onWorkspaceRefresh?.();
      } catch (err) {
        console.error('[SimpleChatInput] Tauri file copy error:', err);
        toastRef.current.error(err instanceof Error ? err.message : '文件复制失败');
      }
    }
  }, [apiPost, addImage, inputValue, textareaRef, undoStack, onWorkspaceRefresh]);

  // Insert @references at cursor position or end of input
  // Uses inputValueRef for stable callback (avoids rebuilding on every input change)
  const insertReferences = useCallback((paths: string[]) => {
    if (paths.length === 0) return;

    const currentInput = inputValueRef.current;

    // Build reference string with @paths separated by spaces
    const references = paths.map(p => `@${p}`).join(' ');

    // Get cursor position (or end if no focus)
    const cursorPos = textareaRef.current?.selectionStart ?? currentInput.length;
    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);

    // Add space before if needed (not at start, not after space/newline)
    const needsSpaceBefore = before.length > 0 && !/[\s]$/.test(before);
    // Add space after if needed (not at end, not before space/newline)
    const needsSpaceAfter = after.length > 0 && !/^[\s]/.test(after);

    const newValue = `${before}${needsSpaceBefore ? ' ' : ''}${references}${needsSpaceAfter ? ' ' : ''}${after}`;
    setInputValue(newValue);

    // Focus textarea and set cursor after the inserted references
    const newCursorPos = cursorPos + (needsSpaceBefore ? 1 : 0) + references.length + (needsSpaceAfter ? 1 : 0);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [textareaRef]);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    processDroppedFiles,
    processDroppedFilePaths,
    insertReferences,
  }), [processDroppedFiles, processDroppedFilePaths, insertReferences]);

  // Handle file input change
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach(addImage);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
    setShowPlusMenu(false);
  }, [addImage]);

  // Handle paste for images and files
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
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

    if (files.length > 0) {
      if (isDebugMode()) {
        console.log('[SimpleChatInput] Processing', files.length, 'pasted files');
      }
      e.preventDefault();
      // Use processDroppedFiles to handle all file types
      void processDroppedFiles(files);
    }
  }, [processDroppedFiles]);

  // @file search logic
  const searchFiles = useCallback(async (query: string) => {
    if (!agentDir || query.length < 1 || !apiGet) {
      setFileSearchResults([]);
      setIsFileSearching(false);
      return;
    }

    setIsFileSearching(true);
    try {
      const results = await apiGet<FileSearchResult[]>(`/agent/search-files?q=${encodeURIComponent(query)}`);
      setFileSearchResults(results.slice(0, 10)); // Limit to 10 results
      setSelectedFileIndex(0);
    } catch (err) {
      console.error('File search error:', err);
      setFileSearchResults([]);
    } finally {
      setIsFileSearching(false);
    }
  }, [agentDir, apiGet]);

  // Debounced file search
  useEffect(() => {
    if (!showFileSearch) return;

    // Set searching state immediately when query changes (to avoid flash of 'not found')
    if (fileSearchQuery.length > 0) {
      setIsFileSearching(true);
    }

    const timer = setTimeout(() => {
      searchFiles(fileSearchQuery);
    }, 150);

    return () => clearTimeout(timer);
  }, [fileSearchQuery, showFileSearch, searchFiles]);

  // Handle text input change (detect @ and / and backspace)
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart;

    // Track current state locally to avoid stale closure issues
    let currentShowFileSearch = showFileSearch;
    let currentAtPosition = atPosition;
    let currentShowSlashMenu = showSlashMenu;
    let currentSlashPosition = slashPosition;

    // Detect new @ or / character (only when adding)
    if (newValue.length > inputValue.length) {
      const addedChar = newValue[cursorPos - 1];
      if (addedChar === '@') {
        currentShowFileSearch = true;
        currentAtPosition = cursorPos - 1;
        setShowFileSearch(true);
        setAtPosition(cursorPos - 1);
        setFileSearchQuery('');
        setFileSearchResults([]);
        // Close slash menu if open
        currentShowSlashMenu = false;
        currentSlashPosition = null;
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else if (addedChar === '/') {
        currentShowSlashMenu = true;
        currentSlashPosition = cursorPos - 1;
        setShowSlashMenu(true);
        setSlashPosition(cursorPos - 1);
        setSlashSearchQuery('');
        setSelectedSlashIndex(0);
        // Close file search if open
        currentShowFileSearch = false;
        currentAtPosition = null;
        setShowFileSearch(false);
        setAtPosition(null);
      }
    }

    // Update file search query if @ is active (handles both add and delete)
    if (currentShowFileSearch && currentAtPosition !== null) {
      // Check if @ was deleted
      if (currentAtPosition >= newValue.length || newValue[currentAtPosition] !== '@') {
        setShowFileSearch(false);
        setAtPosition(null);
      } else {
        const textAfterAt = newValue.slice(currentAtPosition + 1, cursorPos);
        // If there's a space or newline after @, close search
        if (textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
          setShowFileSearch(false);
          setAtPosition(null);
        } else {
          setFileSearchQuery(textAfterAt);
        }
      }
    }

    // Update slash search query if / is active (handles both add and delete)
    if (currentShowSlashMenu && currentSlashPosition !== null) {
      // Check if / was deleted
      if (currentSlashPosition >= newValue.length || newValue[currentSlashPosition] !== '/') {
        setShowSlashMenu(false);
        setSlashPosition(null);
      } else {
        const textAfterSlash = newValue.slice(currentSlashPosition + 1, cursorPos);
        // If there's a space or newline after /, close menu
        if (textAfterSlash.includes(' ') || textAfterSlash.includes('\n')) {
          setShowSlashMenu(false);
          setSlashPosition(null);
        } else {
          setSlashSearchQuery(textAfterSlash);
          setSelectedSlashIndex(0);
        }
      }
    }

    setInputValue(newValue);
  }, [inputValue, showFileSearch, atPosition, showSlashMenu, slashPosition]);

  // Cycle permission mode: auto → plan → fullAgency → auto
  const cyclePermissionMode = useCallback(() => {
    const modeOrder: PermissionMode[] = ['auto', 'plan', 'fullAgency'];
    const currentIndex = modeOrder.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modeOrder.length;
    const nextMode = modeOrder[nextIndex];

    // Show warning toast for fullAgency mode (10 seconds)
    if (nextMode === 'fullAgency') {
      toastRef.current.warning('自主行动已启用：Agent 可能做出不可挽回的操作，请谨慎使用', 5000);
    }
    onPermissionModeChange?.(nextMode);
  }, [permissionMode, onPermissionModeChange]);

  // Global Shift+Tab handler with capture phase to prevent default Tab behavior
  useEffect(() => {
    const handleShiftTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        cyclePermissionMode();
      }
    };
    // Use capture phase to intercept before default Tab behavior
    document.addEventListener('keydown', handleShiftTab, { capture: true });
    return () => document.removeEventListener('keydown', handleShiftTab, { capture: true });
  }, [cyclePermissionMode]);

  // Send message - defined before handleKeyDown to avoid circular dependency
  const handleSend = useCallback(async () => {
    if (isLoading) return;
    const text = inputValue.trim();
    if (!text && images.length === 0) return;

    // Wait for all pending skill copies to complete (max 10s each)
    const pendingCopies = Array.from(pendingSkillCopiesRef.current.entries());
    if (pendingCopies.length > 0) {
      for (const [skillName, promise] of pendingCopies) {
        try {
          const timeoutPromise = new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 10000)
          );
          const success = await Promise.race([promise, timeoutPromise]);
          if (!success) {
            toastRef.current.warning(`Skill "${skillName}" 复制失败，请重试`);
            return;
          }
        } catch (err) {
          toastRef.current.warning(`Skill "${skillName}" 复制超时，请重试`);
          return;
        }
      }
    }

    onSend(text, images.length > 0 ? images : undefined);
    setInputValue(''); // Clear input after send
    setImages([]);
  }, [isLoading, onSend, images, inputValue]);

  // Handle keyboard navigation in file search and slash menu
  const handleKeyDown = useCallback(async (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab to cycle permission mode
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      cyclePermissionMode();
      return;
    }

    // Cmd+Z (Mac) or Ctrl+Z (Windows) to undo file reference insertion
    if ((event.metaKey || event.ctrlKey) && event.key === 'z' && !event.shiftKey) {
      const action = undoStack.peek();
      if (action?.type === 'file-reference') {
        event.preventDefault();

        // Pop all actions in the same batch (multi-file drop)
        const batchActions = undoStack.popBatch();
        if (batchActions.length === 0) return;

        // Remove all @references from input
        let newInputValue = inputValue;
        for (const a of batchActions) {
          if (newInputValue.includes(a.insertedText)) {
            newInputValue = newInputValue.replace(a.insertedText, '');
          }
        }
        setInputValue(newInputValue);

        // Delete all copied files
        if (apiPost) {
          let successCount = 0;
          let failCount = 0;

          for (const a of batchActions) {
            try {
              await apiPost('/agent/delete', { path: a.copiedFilePath });
              successCount++;
            } catch {
              failCount++;
            }
          }

          // Show appropriate message
          if (failCount === 0) {
            toastRef.current.success(`已撤销 ${successCount} 个文件的添加`);
          } else if (successCount > 0) {
            toastRef.current.warning(`已撤销 ${successCount} 个文件，${failCount} 个文件删除失败`);
          } else {
            toastRef.current.warning('已移除引用，但文件删除失败');
          }
        }
        return;
      }
      // If no file reference in undo stack, let browser handle default undo
    }

    // Use centralized filter/sort function for slash commands
    const filteredSlashCommands = filterAndSortCommands(slashCommands, slashSearchQuery);

    // Slash menu navigation
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.min(i + 1, filteredSlashCommands.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Tab or Enter to select
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = filteredSlashCommands[selectedSlashIndex];
        if (selected && slashPosition !== null) {
          // Trigger skill copy if user-level skill
          handleSkillSelect(selected);
          // Replace /query with /command
          const before = inputValue.slice(0, slashPosition);
          const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);
          setInputValue(`${before}/${selected.name} ${after}`);
          setShowSlashMenu(false);
          setSlashPosition(null);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowSlashMenu(false);
        setSlashPosition(null);
        return;
      }
    }

    // File search navigation
    if (showFileSearch && fileSearchResults.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((i) => Math.min(i + 1, fileSearchResults.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((i) => Math.max(i - 1, 0));
        return;
      }
      // Tab or Enter to select file
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const selected = fileSearchResults[selectedFileIndex];
        if (selected && atPosition !== null) {
          // Replace @query with @path
          const before = inputValue.slice(0, atPosition);
          const after = inputValue.slice(textareaRef.current?.selectionStart || atPosition + fileSearchQuery.length + 1);
          setInputValue(`${before}@${selected.path} ${after}`);
          setShowFileSearch(false);
          setAtPosition(null);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setShowFileSearch(false);
        setAtPosition(null);
        return;
      }
    }

    // Normal send - but NOT during IME composition (e.g., Chinese input)
    // Check both event.nativeEvent.isComposing (standard) and event.keyCode === 229 (legacy)
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!isLoading && (inputValue.trim() || images.length > 0)) {
        handleSend();
      }
    }
  }, [cyclePermissionMode, undoStack, apiPost, showSlashMenu, slashCommands, slashSearchQuery, selectedSlashIndex, slashPosition, showFileSearch, fileSearchResults, selectedFileIndex, inputValue, atPosition, fileSearchQuery, isLoading, images.length, handleSend, handleSkillSelect]);

  const toggleExpand = () => setIsExpanded((prev) => !prev);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      {/* Gradient fade overlay */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-32"
        style={{
          background: 'linear-gradient(to bottom, transparent, var(--paper-strong) 60%)'
        }}
      />

      {/* Input container */}
      <div className="pointer-events-auto relative w-full max-w-3xl">
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-xl">
          {/* Image attachments preview */}
          {images.length > 0 && (
            <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto">
              {images.map((img) => (
                <div key={img.id} className="relative group flex-shrink-0">
                  <img
                    src={img.preview}
                    alt="attachment"
                    className="h-16 w-16 rounded-lg object-cover border border-[var(--line)] cursor-pointer"
                    onDoubleClick={() => openPreview(img.preview, img.file.name)}
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[var(--error)] text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    title="删除图片"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea area */}
          <div className="relative px-4 pt-3">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="输入消息，使用 @ 引用文件，/ 使用技能..."
              rows={1}
              className="block w-full resize-none bg-transparent pr-8 text-[14px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
              style={{
                minHeight: `${LINE_HEIGHT}px`,
                maxHeight: `${LINE_HEIGHT * (isExpanded ? MAX_LINES_EXPANDED : MAX_LINES_COLLAPSED)}px`,
                overflowY: 'auto'
              }}
            />

            {/* @file search popup */}
            {showFileSearch && (
              <div className="absolute left-4 bottom-full mb-2 w-80 max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl">
                {fileSearchQuery.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    输入文件名搜索...
                  </div>
                ) : isFileSearching ? (
                  <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    搜索中...
                  </div>
                ) : fileSearchResults.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    未找到文件
                  </div>
                ) : (
                  fileSearchResults.map((file, idx) => (
                    <div
                      key={file.path}
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer text-sm ${idx === selectedFileIndex
                        ? 'bg-[var(--accent)]/10 text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)]'
                        }`}
                      onClick={() => {
                        if (atPosition !== null) {
                          const before = inputValue.slice(0, atPosition);
                          const after = inputValue.slice(textareaRef.current?.selectionStart || atPosition + fileSearchQuery.length + 1);
                          setInputValue(`${before}@${file.path} ${after}`);
                          setShowFileSearch(false);
                          setAtPosition(null);
                        }
                      }}
                    >
                      <FileText className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate">{file.path}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* /slash command popup */}
            {showSlashMenu && (
              <SlashCommandMenu
                commands={filterAndSortCommands(slashCommands, slashSearchQuery)}
                selectedIndex={selectedSlashIndex}
                isEmpty={slashSearchQuery.length > 0 && filterAndSortCommands(slashCommands, slashSearchQuery).length === 0}
                onSelect={(cmd) => {
                  if (slashPosition !== null) {
                    // Trigger skill copy if user-level skill
                    handleSkillSelect(cmd);
                    const before = inputValue.slice(0, slashPosition);
                    const after = inputValue.slice(textareaRef.current?.selectionStart || slashPosition + slashSearchQuery.length + 1);
                    setInputValue(`${before}/${cmd.name} ${after}`);
                    setShowSlashMenu(false);
                    setSlashPosition(null);
                  }
                }}
              />
            )}

            {/* Expand/Collapse button */}
            <button
              type="button"
              onClick={toggleExpand}
              className="absolute right-4 top-3 rounded-lg p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
              title={isExpanded ? '收起' : '展开'}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Toolbar row */}
          <div className="toolbar-menus flex items-center justify-between px-3 pb-2 pt-1">
            {/* Left side - action buttons */}
            <div className="flex items-center gap-1">
              {/* Plus menu */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Close other menus first
                    setShowModeMenu(false);
                    setShowModelMenu(false);
                    setShowToolMenu(false);
                    setShowPlusMenu(!showPlusMenu);
                  }}
                  className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                  title="添加"
                >
                  <Plus className="h-4 w-4" />
                </button>
                {showPlusMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-40 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl py-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Insert @ at cursor position and trigger file search
                        const textarea = textareaRef.current;
                        if (textarea) {
                          const cursorPos = textarea.selectionStart;
                          const before = inputValue.slice(0, cursorPos);
                          const after = inputValue.slice(cursorPos);
                          setInputValue(`${before}@${after}`);
                          setShowFileSearch(true);
                          setAtPosition(cursorPos);
                          setFileSearchQuery('');
                          textarea.focus();
                        }
                        setShowPlusMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                      <AtSign className="h-4 w-4" />
                      引用文件
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Insert / at cursor position and trigger slash menu
                        const textarea = textareaRef.current;
                        if (textarea) {
                          const cursorPos = textarea.selectionStart;
                          const before = inputValue.slice(0, cursorPos);
                          const after = inputValue.slice(cursorPos);
                          setInputValue(`${before}/${after}`);
                          setShowSlashMenu(true);
                          setSlashPosition(cursorPos);
                          setSlashSearchQuery('');
                          setSelectedSlashIndex(0);
                          textarea.focus();
                        }
                        setShowPlusMenu(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                      <span className="inline-flex h-4 w-4 items-center justify-center font-medium text-[var(--ink-muted)]">/</span>
                      使用技能
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                    >
                      <Image className="h-4 w-4" />
                      上传图片
                    </button>
                  </div>
                )}
              </div>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_IMAGE_MIME_TYPES.join(',')}
                multiple
                className="hidden"
                onChange={handleFileChange}
              />

              {/* Mode Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowModeMenu(!showModeMenu);
                    setShowModelMenu(false);
                    setShowPlusMenu(false);
                    setShowToolMenu(false);
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                  title="切换模式"
                >
                  <span>{PERMISSION_MODES.find(m => m.value === permissionMode)?.icon}</span>
                  <span>{PERMISSION_MODES.find(m => m.value === permissionMode)?.label}</span>
                  <ChevronUp className="h-3 w-3" />
                </button>
                {showModeMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-72 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl py-1">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--line)]">
                      <span className="text-xs font-medium text-[var(--ink-muted)]">会话模式</span>
                      {onOpenAgentSettings && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowModeMenu(false);
                            onOpenAgentSettings();
                          }}
                          className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-strong)] transition-colors"
                        >
                          Agent 设置
                        </button>
                      )}
                    </div>
                    {PERMISSION_MODES.map((mode) => (
                      <button
                        key={mode.value}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (mode.value === 'fullAgency') {
                            toastRef.current.warning('自主行动已启用：Agent 可能做出不可挽回的操作，请谨慎使用', 5000);
                          }
                          onPermissionModeChange?.(mode.value);
                          setShowModeMenu(false);
                        }}
                        className={`flex w-full flex-col items-start px-3 py-2 text-left ${permissionMode === mode.value
                          ? 'bg-[var(--accent)]/10'
                          : 'hover:bg-[var(--paper-contrast)]'
                          }`}
                      >
                        <span className={`text-sm font-medium flex items-center gap-1.5 ${permissionMode === mode.value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
                          }`}>
                          <span>{mode.icon}</span>
                          {mode.label}
                        </span>
                        <span className="text-xs text-[var(--ink-muted)] mt-0.5">{mode.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Tool/MCP Dropdown - always visible */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowToolMenu(!showToolMenu);
                    setShowModeMenu(false);
                    setShowModelMenu(false);
                    setShowPlusMenu(false);
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                  title="工具"
                >
                  <Wrench className="h-3.5 w-3.5" />
                  {workspaceMcpEnabled.length > 0 && (
                    <span className="text-[9px] text-[var(--ink-muted)]">
                      {workspaceMcpEnabled.length}
                    </span>
                  )}
                </button>
                {showToolMenu && (
                  <div className="absolute left-0 bottom-full mb-1 w-64 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl py-1">
                    <div className="px-3 py-2 text-xs font-medium text-[var(--ink-muted)] border-b border-[var(--line)]">
                      工具 (在此对话中启用)
                    </div>
                    {globalMcpEnabled.length > 0 ? (
                      mcpServers
                        .filter(s => globalMcpEnabled.includes(s.id))
                        .map((server) => {
                          const isEnabled = workspaceMcpEnabled.includes(server.id);
                          return (
                            <div
                              key={server.id}
                              className="flex items-center justify-between px-3 py-2 hover:bg-[var(--paper-contrast)]"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-[var(--ink)] truncate">
                                  {server.name}
                                </div>
                                {server.description && (
                                  <div className="text-[10px] text-[var(--ink-muted)] truncate">
                                    {server.description}
                                  </div>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onWorkspaceMcpToggle?.(server.id, !isEnabled);
                                }}
                                className={`relative ml-2 h-5 w-9 shrink-0 rounded-full transition-colors ${isEnabled ? 'bg-[var(--success)]' : 'bg-[var(--paper-inset)]'
                                  }`}
                              >
                                <span
                                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--paper-elevated)] shadow transition-transform ${isEnabled ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                />
                              </button>
                            </div>
                          );
                        })
                    ) : (
                      <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">
                        在
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowToolMenu(false);
                            // Dispatch custom event to open Settings with MCP section
                            window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, { detail: { section: 'mcp' } }));
                          }}
                          className="mx-1 text-[var(--accent)] hover:underline"
                        >
                          设置页面
                        </button>
                        安装开启 MCP 工具，即可使用浏览器等更多功能
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right side - model selector + send/stop button */}
            <div className="flex items-center gap-2">
              {/* Model Dropdown with Provider Selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const willOpen = !showModelMenu;
                    setShowModelMenu(willOpen);
                    setShowModeMenu(false);
                    setShowPlusMenu(false);
                    setShowProviderSubmenu(false);
                    setShowToolMenu(false);
                    // Refresh providers data when opening menu
                    if (willOpen && onRefreshProviders) {
                      onRefreshProviders();
                    }
                  }}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                  title="切换模型"
                >
                  <span>{currentModelName}</span>
                  <ChevronUp className="h-3 w-3" />
                </button>
                {showModelMenu && (
                  <div className="absolute right-0 bottom-full mb-1 w-64 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl py-1">
                    {/* Provider selector in header */}
                    <div className="relative px-3 py-2 border-b border-[var(--line)]">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-[var(--ink-muted)]">选择模型</span>
                        {providers.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowProviderSubmenu(!showProviderSubmenu);
                            }}
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]"
                          >
                            <span>{provider?.name ?? '选择供应商'}</span>
                            <ChevronDown className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </div>
                      {/* Provider submenu - opens upward */}
                      {showProviderSubmenu && providers.length > 0 && (
                        <div className="absolute right-0 bottom-full mb-1 w-48 rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-xl py-1 z-10">
                          {providers.map((p) => {
                            const available = isProviderAvailable(p);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!available) return; // Don't switch if unavailable
                                  onProviderChange?.(p.id);
                                  setShowProviderSubmenu(false);
                                  // Auto-select first model of new provider
                                  if (p.primaryModel) {
                                    onModelChange?.(p.primaryModel);
                                  }
                                }}
                                disabled={!available}
                                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${!available
                                  ? 'opacity-50 cursor-not-allowed text-[var(--ink-muted)]'
                                  : provider?.id === p.id
                                    ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                                    : 'text-[var(--ink)] hover:bg-[var(--paper-contrast)]'
                                  }`}
                                title={!available ? '请在设置面板配置您的 API-Key' : undefined}
                              >
                                <span className="font-medium">{p.name}</span>
                                <span className="text-[9px] text-[var(--ink-muted)] bg-[var(--paper-contrast)] px-1 py-0.5 rounded">
                                  {p.cloudProvider}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {/* Dynamic models from provider.models */}
                    {(provider?.models ?? [
                      { model: 'claude-sonnet-4-5-20250929', modelName: 'Claude Sonnet 4.5', modelSeries: 'claude' },
                      { model: 'claude-haiku-4-5-20251001', modelName: 'Claude Haiku 4.5', modelSeries: 'claude' },
                      { model: 'claude-opus-4-5-20251101', modelName: 'Claude Opus 4.5', modelSeries: 'claude' },
                    ] as ModelEntity[]).map((model) => (
                      <button
                        key={model.model}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onModelChange?.(model.model);
                          setShowModelMenu(false);
                          setShowProviderSubmenu(false);
                        }}
                        className={`flex w-full items-center px-3 py-2 text-left ${currentModelId === model.model
                          ? 'bg-[var(--accent)]/10'
                          : 'hover:bg-[var(--paper-contrast)]'
                          }`}
                      >
                        <span className={`text-sm font-medium ${currentModelId === model.model ? 'text-[var(--accent)]' : 'text-[var(--ink)]'
                          }`}>
                          {model.modelName}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Button states: system task (disabled send) → AI responding (stop) → normal (send) */}
              {systemStatus ? (
                // System task running (e.g., compacting) - not interruptible
                <button
                  type="button"
                  disabled
                  className="rounded-lg bg-[var(--ink-muted)]/15 p-2 text-[var(--ink-muted)]/60"
                  title="正在执行系统任务，请稍等"
                >
                  <Send className="h-4 w-4" />
                </button>
              ) : isLoading ? (
                // AI responding - can be stopped
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-lg bg-[var(--error)] p-2 text-white transition-colors hover:brightness-110"
                  title="停止"
                >
                  <Square className="h-4 w-4" />
                </button>
              ) : (
                // Normal state - can send
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!inputValue.trim() && images.length === 0}
                  className="rounded-lg bg-[var(--accent)] p-2 text-white transition-colors hover:bg-[var(--accent-strong)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60"
                  title="发送"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default SimpleChatInput;
