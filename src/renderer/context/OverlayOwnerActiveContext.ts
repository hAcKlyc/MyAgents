import { createContext, useContext } from 'react';

/** A kept-mounted tab can hide its portaled dialogs and yield its close shortcuts. */
export const OverlayOwnerActiveContext = createContext(true);

export function useOverlayOwnerActive(): boolean {
  return useContext(OverlayOwnerActiveContext);
}
