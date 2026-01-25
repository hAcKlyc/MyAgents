import { useCallback, useRef, useState } from 'react';

/**
 * File reference undo action - stores info needed to undo a file copy + reference insert
 */
export interface FileReferenceUndoAction {
  type: 'file-reference';
  /** Unique batch ID - all files from same drop share this ID */
  batchId: string;
  /** The text that was inserted (e.g., "@myagents_files/document.pdf ") */
  insertedText: string;
  /** The position where text was inserted */
  insertPosition: number;
  /** The path of the copied file relative to workspace (e.g., "myagents_files/document.pdf") */
  copiedFilePath: string;
}

export type UndoAction = FileReferenceUndoAction;

interface UndoStackOptions {
  /** Maximum number of actions to keep in the stack */
  maxSize?: number;
}

interface UndoStackResult {
  /** Push a new action onto the stack */
  push: (action: UndoAction) => void;
  /** Pop and return the most recent action */
  pop: () => UndoAction | undefined;
  /** Pop all actions with the same batchId as the top action */
  popBatch: () => UndoAction[];
  /** Peek at the most recent action without removing it */
  peek: () => UndoAction | undefined;
  /** Clear all actions from the stack */
  clear: () => void;
  /** Check if the stack is empty */
  isEmpty: () => boolean;
  /** Get the current stack size */
  size: number;
  /** Get all actions (for debugging) */
  getAll: () => UndoAction[];
  /** Generate a new unique batch ID */
  generateBatchId: () => string;
}

/**
 * Hook for managing an undo stack for file operations
 *
 * This is a specialized undo stack for tracking file reference insertions,
 * allowing users to undo file copies and their corresponding text references.
 *
 * Supports batch operations - multiple files dropped at once share a batchId
 * and can be undone together.
 */
export function useUndoStack(options: UndoStackOptions = {}): UndoStackResult {
  const { maxSize = 50 } = options;

  // Use ref for actual data to avoid unnecessary re-renders
  const stackRef = useRef<UndoAction[]>([]);
  // State to trigger re-renders when stack changes (only tracks size)
  const [stackSize, setStackSize] = useState(0);
  // Counter for generating unique batch IDs
  const batchCounterRef = useRef(0);

  const push = useCallback((action: UndoAction) => {
    stackRef.current.push(action);

    // Trim if over max size
    if (stackRef.current.length > maxSize) {
      stackRef.current = stackRef.current.slice(-maxSize);
    }

    setStackSize(stackRef.current.length);
  }, [maxSize]);

  const pop = useCallback((): UndoAction | undefined => {
    const action = stackRef.current.pop();
    setStackSize(stackRef.current.length);
    return action;
  }, []);

  /**
   * Pop all actions with the same batchId as the top action.
   * This allows undoing an entire multi-file drop operation at once.
   */
  const popBatch = useCallback((): UndoAction[] => {
    const topAction = stackRef.current[stackRef.current.length - 1];
    if (!topAction) {
      return [];
    }

    const batchId = topAction.batchId;
    const batchActions: UndoAction[] = [];

    // Pop all actions with the same batchId (they should be consecutive at the end)
    while (stackRef.current.length > 0) {
      const lastAction = stackRef.current[stackRef.current.length - 1];
      if (lastAction.batchId === batchId) {
        batchActions.push(stackRef.current.pop()!);
      } else {
        break;
      }
    }

    setStackSize(stackRef.current.length);
    return batchActions;
  }, []);

  const peek = useCallback((): UndoAction | undefined => {
    return stackRef.current[stackRef.current.length - 1];
  }, []);

  const clear = useCallback(() => {
    stackRef.current = [];
    setStackSize(0);
  }, []);

  const isEmpty = useCallback((): boolean => {
    return stackRef.current.length === 0;
  }, []);

  const getAll = useCallback((): UndoAction[] => {
    return [...stackRef.current];
  }, []);

  const generateBatchId = useCallback((): string => {
    batchCounterRef.current++;
    return `batch-${Date.now()}-${batchCounterRef.current}`;
  }, []);

  return {
    push,
    pop,
    popBatch,
    peek,
    clear,
    isEmpty,
    size: stackSize,
    getAll,
    generateBatchId,
  };
}
