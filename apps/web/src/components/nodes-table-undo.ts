import { create } from "zustand";

export interface CellEdit {
  rowId: string;
  colId: string;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
  propertyId: string | undefined;
  propertyTypeId: string;
  valueType: string;
}

interface UndoState {
  stack: CellEdit[];
  push: (edit: CellEdit) => void;
  pop: () => CellEdit | undefined;
  clear: () => void;
}

export const useTableUndoStore = create<UndoState>((set, get) => ({
  stack: [],
  push: (edit) => set((s) => ({ stack: [...s.stack, edit] })),
  pop: () => {
    const { stack } = get();
    if (stack.length === 0) return undefined;
    const edit = stack[stack.length - 1];
    set({ stack: stack.slice(0, -1) });
    return edit;
  },
  clear: () => set({ stack: [] }),
}));
