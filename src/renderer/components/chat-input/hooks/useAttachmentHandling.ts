import { open } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { Provider } from '@/config/types';
import { modelSupportsModality } from '@/config/services/providerService';
import { isTauriEnvironment } from '@/utils/browserMock';
import { renameIfBareClipboardImage } from '@/utils/clipboardImage';
import { isDebugMode } from '@/utils/debug';
import { resolveAttachmentUrl } from '@/utils/attachmentUrl';
import { ALLOWED_IMAGE_MIME_TYPES, isChatImageFile, isImageMimeType } from '@/../shared/fileTypes';
import type { FileReferenceUndoAction } from '@/hooks/useUndoStack';
import { normalizeWorkspacePathIdentity } from '@/../shared/workspacePath';

import type { ImageAttachment } from '../types';
import { MAX_IMAGES, MAX_IMAGE_SIZE } from '../constants';

interface PreparedImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  relativePath: string;
}

interface WorkspaceCopyResult {
  success: boolean;
  copiedFiles?: Array<{ targetPath: string }>;
}

interface AttachmentFileService {
  isAvailable: boolean;
  importBase64Files(input: {
    files: Array<{ name: string; content: string }>;
    targetDir: string;
  }): Promise<{ success: boolean; files?: string[] }>;
  addGitignore(input: { pattern: string }): Promise<unknown>;
  prepareUserImageAttachments(input: {
    sessionId: string;
    paths: string[];
  }): Promise<{
    attachments: PreparedImageAttachment[];
    errors: Array<{ code?: string; path: string }>;
  }>;
  copyPaths(input: {
    sourcePaths: string[];
    targetDir: string;
    autoRename: boolean;
  }): Promise<WorkspaceCopyResult>;
}

interface AttachmentUndoStack {
  generateBatchId: () => string;
  push: (action: FileReferenceUndoAction) => void;
}

interface AttachmentToast {
  warning: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
}

interface AttachmentImportScope {
  workspaceIdentity: string;
}

interface UseAttachmentHandlingParams {
  fileService: AttachmentFileService;
  workspacePath?: string | null;
  provider?: Provider | null;
  currentModelId?: string | null;
  isExternalRuntime: boolean;
  attachmentSessionId?: string | null;
  inputValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  toastRef: MutableRefObject<AttachmentToast>;
  undoStack: AttachmentUndoStack;
  setInputValue: Dispatch<SetStateAction<string>>;
  setShowPlusMenu: Dispatch<SetStateAction<boolean>>;
  notifyUnsupportedImageFallback: () => void;
  onWorkspaceRefresh?: () => void;
  isDraftLocked?: () => boolean;
}

export function useAttachmentHandling({
  fileService,
  workspacePath,
  provider,
  currentModelId,
  isExternalRuntime,
  attachmentSessionId,
  inputValueRef,
  textareaRef,
  fileInputRef,
  toastRef,
  undoStack,
  setInputValue,
  setShowPlusMenu,
  notifyUnsupportedImageFallback,
  onWorkspaceRefresh,
  isDraftLocked,
}: UseAttachmentHandlingParams) {
  const { t } = useTranslation('chat');
  const [images, setImageState] = useState<ImageAttachment[]>([]);
  const imageCountRef = useRef(0);
  const pendingOperationsRef = useRef(0);
  const mountedRef = useRef(true);
  const activeReadersRef = useRef<Set<FileReader>>(new Set());
  const workspaceIdentity = normalizeWorkspacePathIdentity(workspacePath ?? '');
  const currentImportScopeRef = useRef<AttachmentImportScope>({ workspaceIdentity });

  useLayoutEffect(() => {
    if (currentImportScopeRef.current.workspaceIdentity === workspaceIdentity) return;
    currentImportScopeRef.current = { workspaceIdentity };
    // FileReader has no AbortSignal. Abort reads owned by the previous workspace
    // so a paste/drop cannot finish into the newly selected workspace draft.
    for (const reader of activeReadersRef.current) {
      if (reader.readyState === FileReader.LOADING) {
        reader.abort();
      }
    }
  }, [workspaceIdentity]);

  useEffect(
    () => {
      mountedRef.current = true;
      const activeReaders = activeReadersRef.current;
      return () => {
        mountedRef.current = false;
        for (const reader of activeReaders) {
          if (reader.readyState === FileReader.LOADING) {
            reader.abort();
          }
        }
        activeReaders.clear();
      };
    },
    [],
  );

  const forgetReader = useCallback((reader: FileReader) => {
    activeReadersRef.current.delete(reader);
  }, []);

  const isImportScopeCurrent = useCallback((scope: AttachmentImportScope) => {
    return mountedRef.current && currentImportScopeRef.current === scope;
  }, []);

  const setImages = useCallback<Dispatch<SetStateAction<ImageAttachment[]>>>((next) => {
    if (isDraftLocked?.()) return;
    if (typeof next === 'function') {
      setImageState((prev) => {
        const resolved = next(prev);
        imageCountRef.current = resolved.length;
        return resolved;
      });
      return;
    }
    imageCountRef.current = next.length;
    setImageState(next);
  }, [isDraftLocked]);

  const reserveImageSlot = useCallback(() => {
    if (imageCountRef.current >= MAX_IMAGES) {
      toastRef.current.warning(t('input.attachments.maxImages', { count: MAX_IMAGES }));
      return false;
    }
    imageCountRef.current += 1;
    return true;
  }, [t, toastRef]);

  const insertReferenceText = useCallback((paths: string[]): number => {
    const currentInput = inputValueRef.current;
    const cursorPos = Math.min(
      textareaRef.current?.selectionStart ?? currentInput.length,
      currentInput.length,
    );
    const references = paths.map(path => `@${path}`).join(' ');

    const before = currentInput.slice(0, cursorPos);
    const after = currentInput.slice(cursorPos);
    const insertedText = references + ' ';
    const newValue = before + insertedText + after;

    inputValueRef.current = newValue;
    setInputValue(newValue);
    return cursorPos;
  }, [inputValueRef, setInputValue, textareaRef]);

  const addImage = useCallback((file: File, importScope: AttachmentImportScope) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
      toastRef.current.warning(t('input.attachments.unsupportedImageType'));
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toastRef.current.warning(t('input.attachments.imageTooLarge'));
      return;
    }

    const reader = new FileReader();
    activeReadersRef.current.add(reader);
    reader.onload = (e) => {
      forgetReader(reader);
      if (!isImportScopeCurrent(importScope)) return;
      const dataUrl = e.target?.result as string;
      if (!reserveImageSlot()) return;
      setImageState((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          file,
          preview: dataUrl,
          source: 'inline_base64',
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        },
      ]);
    };
    reader.onerror = () => forgetReader(reader);
    reader.onabort = () => forgetReader(reader);
    reader.readAsDataURL(file);
  }, [forgetReader, isImportScopeCurrent, reserveImageSlot, toastRef, t]);

  const addPreparedImageAttachment = useCallback((attachment: PreparedImageAttachment) => {
    const preview = resolveAttachmentUrl({ relativePath: attachment.relativePath });
    if (!preview) {
      toastRef.current.warning(t('input.attachments.previewFailed', { name: attachment.name }));
      return;
    }
    if (!reserveImageSlot()) return;
    setImageState((prev) => [
      ...prev,
      {
        id: attachment.id,
        file: new File([], attachment.name, { type: attachment.mimeType }),
        preview,
        source: 'attachment_ref',
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        relativePath: attachment.relativePath,
      },
    ]);
  }, [reserveImageSlot, toastRef, t]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, [setImages]);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      activeReadersRef.current.add(reader);
      reader.onload = () => {
        forgetReader(reader);
        if (!mountedRef.current) {
          reject(new Error('read cancelled'));
          return;
        }
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = () => {
        forgetReader(reader);
        reject(reader.error ?? new Error('file read failed'));
      };
      reader.onabort = () => {
        forgetReader(reader);
        reject(new Error('read cancelled'));
      };
      reader.readAsDataURL(file);
    });
  }, [forgetReader]);

  const processDroppedFilesInner = useCallback(async (files: File[]) => {
    const importScope = currentImportScopeRef.current;
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFiles called with', files.length, 'files:', files.map(f => f.name));
    }

    const imageFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const file of files) {
      if (isChatImageFile(file.name) || isImageMimeType(file.type)) {
        imageFiles.push(file);
      } else {
        otherFiles.push(file);
      }
    }

    const userIntendedFileCount = otherFiles.length;

    const oversizedImageFiles = imageFiles.filter((file) => file.size > MAX_IMAGE_SIZE);
    if (oversizedImageFiles.length > 0) {
      toastRef.current.warning(
        oversizedImageFiles.length === 1
          ? t('input.attachments.oversizedImageAsFile')
          : t('input.attachments.oversizedImagesAsFile', { count: oversizedImageFiles.length }),
      );
      for (const img of oversizedImageFiles) {
        const idx = imageFiles.indexOf(img);
        if (idx >= 0) imageFiles.splice(idx, 1);
      }
    }

    const fallbackImagesToFiles =
      imageFiles.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image');

    if (fallbackImagesToFiles) {
      notifyUnsupportedImageFallback();
      for (const img of imageFiles) {
        otherFiles.push(renameIfBareClipboardImage(img));
      }
      imageFiles.length = 0;
    }

    for (const file of imageFiles) {
      addImage(file, importScope);
    }

    if (otherFiles.length > 0) {
      if (!fileService.isAvailable) {
        console.error('[SimpleChatInput] workspace file service unavailable');
        toastRef.current.error(
          workspacePath
            ? t('input.attachments.desktopRequiredForUpload')
            : t('input.attachments.selectWorkspaceForUpload'),
        );
        return;
      }
      try {
        const base64Files = await Promise.all(
          otherFiles.map(async (file) => ({
            name: file.name,
            content: await fileToBase64(file),
          }))
        );
        if (!isImportScopeCurrent(importScope)) return;

        const result = await fileService.importBase64Files({
          files: base64Files,
          targetDir: 'myagents_files',
        });
        if (!isImportScopeCurrent(importScope)) return;

        if (!result.success || !result.files || result.files.length === 0) {
          throw new Error(t('input.attachments.uploadFailed'));
        }

        try {
          await fileService.addGitignore({ pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently.
        }

        if (!isImportScopeCurrent(importScope)) return;
        const cursorPos = insertReferenceText(result.files);

        const batchId = undoStack.generateBatchId();

        for (const filePath of result.files) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${filePath} `,
            insertPosition: cursorPos,
            copiedFilePath: filePath,
          });
        }

        if (userIntendedFileCount > 0) {
          toastRef.current.success(t('input.attachments.filesAdded', { count: userIntendedFileCount }));
        }

        onWorkspaceRefresh?.();
      } catch (err) {
        if (!isImportScopeCurrent(importScope)) return;
        console.error('[SimpleChatInput] File upload error:', err);
        toastRef.current.error(err instanceof Error ? err.message : t('input.attachments.fileUploadFailed'));
      }
    }
  }, [fileService, workspacePath, addImage, undoStack, fileToBase64, isImportScopeCurrent, notifyUnsupportedImageFallback, onWorkspaceRefresh, provider, currentModelId, isExternalRuntime, toastRef, insertReferenceText, t]);

  const processDroppedFilePathsInner = useCallback(async (paths: string[]) => {
    const importScope = currentImportScopeRef.current;
    if (isDebugMode()) {
      console.log('[SimpleChatInput] processDroppedFilePaths called with', paths.length, 'paths:', paths);
    }

    if (!fileService.isAvailable) {
      console.error('[SimpleChatInput] workspace file service unavailable for path drop');
      toastRef.current.error(
        workspacePath
          ? t('input.attachments.desktopRequiredForProcess')
          : t('input.attachments.selectWorkspaceForProcess'),
      );
      return;
    }

    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    for (const path of paths) {
      const filename = path.split(/[\\/]/).pop() || path;
      if (isChatImageFile(filename)) {
        imagePaths.push(path);
      } else {
        otherPaths.push(path);
      }
    }

    const fallbackImagesToFiles =
      imagePaths.length > 0 &&
      !isExternalRuntime &&
      !modelSupportsModality(provider, currentModelId, 'image');

    const userIntendedPathCount = otherPaths.length;

    if (fallbackImagesToFiles) {
      notifyUnsupportedImageFallback();
      otherPaths.push(...imagePaths);
      imagePaths.length = 0;
    }

    if (imagePaths.length > 0) {
      if (!attachmentSessionId) {
        toastRef.current.error(t('input.attachments.sessionNotReadyForImage'));
        return;
      }
      const pendingFileReferencePaths: string[] = [];
      let oversizedCount = 0;
      try {
        const prepared = await fileService.prepareUserImageAttachments({
          sessionId: attachmentSessionId,
          paths: imagePaths,
        });
        if (!isImportScopeCurrent(importScope)) return;
        for (const attachment of prepared.attachments) {
          addPreparedImageAttachment(attachment);
        }
        for (const err of prepared.errors) {
          if (err.code === 'too_large') {
            oversizedCount += 1;
          } else if (isDebugMode()) {
            console.warn('[SimpleChatInput] Failed to prepare image attachment, treating as file:', err);
          }
          pendingFileReferencePaths.push(err.path);
        }
      } catch (err) {
        if (!isImportScopeCurrent(importScope)) return;
        if (isDebugMode()) {
          console.warn('[SimpleChatInput] Failed to prepare image attachments, treating as regular files:', err);
        }
        pendingFileReferencePaths.push(...imagePaths);
      }

      if (oversizedCount > 0) {
        toastRef.current.info(
          oversizedCount === 1
            ? t('input.attachments.oversizedImageAddedAsReference')
            : t('input.attachments.oversizedImagesAddedAsReference', { count: oversizedCount }),
        );
      }
      otherPaths.push(...pendingFileReferencePaths);
      imagePaths.length = 0;
    }

    if (otherPaths.length > 0) {
      try {
        const result = await fileService.copyPaths({
          sourcePaths: otherPaths,
          targetDir: 'myagents_files',
          autoRename: true,
        });
        if (!isImportScopeCurrent(importScope)) return;

        if (!result.success) {
          throw new Error(t('input.attachments.copyFailed'));
        }

        const successfulCopies = result.copiedFiles || [];
        if (successfulCopies.length === 0) {
          throw new Error(t('input.attachments.noFilesCopied'));
        }

        try {
          await fileService.addGitignore({ pattern: 'myagents_files/' });
        } catch {
          // Non-fatal, continue silently.
        }

        if (!isImportScopeCurrent(importScope)) return;
        const cursorPos = insertReferenceText(successfulCopies.map(f => f.targetPath));

        const batchId = undoStack.generateBatchId();

        for (const file of successfulCopies) {
          undoStack.push({
            type: 'file-reference',
            batchId,
            insertedText: `@${file.targetPath} `,
            insertPosition: cursorPos,
            copiedFilePath: file.targetPath,
          });
        }

        if (userIntendedPathCount > 0) {
          if (successfulCopies.length < otherPaths.length) {
            toastRef.current.warning(t('input.attachments.filesAddedPartial', {
              successCount: successfulCopies.length,
              totalCount: otherPaths.length,
            }));
          } else {
            toastRef.current.success(t('input.attachments.filesAdded', { count: userIntendedPathCount }));
          }
        }

        onWorkspaceRefresh?.();
      } catch (err) {
        if (!isImportScopeCurrent(importScope)) return;
        console.error('[SimpleChatInput] Tauri file copy error:', err);
        toastRef.current.error(err instanceof Error ? err.message : t('input.attachments.fileCopyFailed'));
      }
    }
  }, [fileService, workspacePath, addPreparedImageAttachment, undoStack, isImportScopeCurrent, notifyUnsupportedImageFallback, onWorkspaceRefresh, provider, currentModelId, isExternalRuntime, attachmentSessionId, toastRef, insertReferenceText, t]);

  // Count the whole import, including Rust IO after FileReader has finished.
  // Update checkpoint must reject it rather than drop a late attachment.
  const processDroppedFiles = useCallback(async (files: File[]) => {
    if (isDraftLocked?.()) return;
    pendingOperationsRef.current++;
    try { await processDroppedFilesInner(files); }
    finally { pendingOperationsRef.current--; }
  }, [isDraftLocked, processDroppedFilesInner]);
  const processDroppedFilePaths = useCallback(async (paths: string[]) => {
    if (isDraftLocked?.()) return;
    pendingOperationsRef.current++;
    try { await processDroppedFilePathsInner(paths); }
    finally { pendingOperationsRef.current--; }
  }, [isDraftLocked, processDroppedFilePathsInner]);

  const handleUploadButtonClick = useCallback(async () => {
    if (isDraftLocked?.()) return;
    setShowPlusMenu(false);
    if (isTauriEnvironment()) {
      pendingOperationsRef.current++;
      try {
        const selected = await open({
          multiple: true,
          directory: false,
          title: t('input.attachments.pickFilesTitle'),
        });
        if (!mountedRef.current) return;
        const paths = Array.isArray(selected)
          ? selected.filter((path): path is string => typeof path === 'string')
          : (typeof selected === 'string' ? [selected] : []);
        if (paths.length > 0) {
          await processDroppedFilePaths(paths);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        console.error('[SimpleChatInput] File picker error:', err);
        toastRef.current.error(t('input.attachments.pickFilesFailed'));
      } finally { pendingOperationsRef.current--; }
      return;
    }
    fileInputRef.current?.click();
  }, [isDraftLocked, processDroppedFilePaths, setShowPlusMenu, fileInputRef, toastRef, t]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      void processDroppedFiles(Array.from(files));
    }
    e.target.value = '';
    setShowPlusMenu(false);
  }, [processDroppedFiles, setShowPlusMenu]);

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
      void processDroppedFiles(files);
    }
  }, [processDroppedFiles]);

  const hasPendingAttachments = useCallback(() => pendingOperationsRef.current > 0 || activeReadersRef.current.size > 0, []);
  const getImageCount = useCallback(() => imageCountRef.current, []);

  return {
    hasPendingAttachments,
    getImageCount,
    images,
    setImages,
    removeImage,
    processDroppedFiles,
    processDroppedFilePaths,
    handleUploadButtonClick,
    handleFileChange,
    handlePaste,
  };
}
