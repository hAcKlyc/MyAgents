import { useCallback, useRef, useState } from 'react';
import { track } from '@/analytics';
import { isDebugMode } from '@/utils/debug';

interface FileDropZoneOptions {
  /** Called when files are dropped */
  onFilesDropped: (files: File[]) => void;
  /** Called when external files start being dragged over the zone */
  onDragEnter?: () => void;
  /** Called when drag leaves the zone */
  onDragLeave?: () => void;
  /** Accept only specific file types (MIME types or extensions) */
  accept?: string[];
}

interface FileDropZoneResult {
  /** Whether external files are being dragged over the zone */
  isDragActive: boolean;
  /** Event handlers to attach to the drop zone element */
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  /** Manually reset the drag state */
  resetDragState: () => void;
}

/**
 * Hook for managing file drag-and-drop zones
 * Handles edge cases like nested elements and cross-browser compatibility
 */
export function useFileDropZone(options: FileDropZoneOptions): FileDropZoneResult {
  const { onFilesDropped, onDragEnter, onDragLeave, accept } = options;
  const [isDragActive, setIsDragActive] = useState(false);

  // Counter to handle nested element drag events
  // Increments on dragenter, decrements on dragleave
  // Only when counter reaches 0 do we actually leave the zone
  const dragCounterRef = useRef(0);

  const isExternalFileDrag = useCallback((e: React.DragEvent): boolean => {
    // Check if the drag contains files (external source)
    const types = e.dataTransfer?.types ?? [];
    return types.includes('Files');
  }, []);

  const filterFiles = useCallback((files: File[]): File[] => {
    if (!accept || accept.length === 0) {
      return files;
    }

    return files.filter(file => {
      return accept.some(accepted => {
        // Check MIME type match
        if (accepted.includes('/')) {
          if (accepted.endsWith('/*')) {
            // Wildcard like 'image/*'
            const prefix = accepted.slice(0, -2);
            return file.type.startsWith(prefix);
          }
          return file.type === accepted;
        }
        // Check extension match
        const ext = accepted.startsWith('.') ? accepted : `.${accepted}`;
        return file.name.toLowerCase().endsWith(ext.toLowerCase());
      });
    });
  }, [accept]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Only respond to external file drags
    if (!isExternalFileDrag(e)) {
      return;
    }

    dragCounterRef.current++;

    if (dragCounterRef.current === 1) {
      setIsDragActive(true);
      onDragEnter?.();
    }
  }, [isExternalFileDrag, onDragEnter]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isExternalFileDrag(e)) {
      return;
    }

    // Set drop effect
    e.dataTransfer.dropEffect = 'copy';
  }, [isExternalFileDrag]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current--;

    if (dragCounterRef.current === 0) {
      setIsDragActive(false);
      onDragLeave?.();
    }
  }, [onDragLeave]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Reset counter
    dragCounterRef.current = 0;
    setIsDragActive(false);

    // Get dropped files
    const droppedFiles = Array.from(e.dataTransfer?.files ?? []);

    if (droppedFiles.length === 0) {
      return;
    }

    // Filter files if accept is specified
    const filteredFiles = filterFiles(droppedFiles);

    if (filteredFiles.length > 0) {
      if (isDebugMode()) {
        console.log('[useFileDropZone] Dropped', filteredFiles.length, 'files');
      }

      // Track file_drop event
      track('file_drop', { file_count: filteredFiles.length });

      onFilesDropped(filteredFiles);
    }
  }, [filterFiles, onFilesDropped]);

  const resetDragState = useCallback(() => {
    dragCounterRef.current = 0;
    setIsDragActive(false);
  }, []);

  return {
    isDragActive,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    resetDragState,
  };
}
