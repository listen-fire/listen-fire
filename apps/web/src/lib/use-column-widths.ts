import { useCallback, useRef, useState, useEffect } from "react";

type ColumnWidths = Record<string, number>;

function readStored(key: string): ColumnWidths | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function writeStored(key: string, widths: ColumnWidths) {
  try {
    localStorage.setItem(key, JSON.stringify(widths));
  } catch {}
}

export function useColumnWidths(options: {
  storageKey: string;
  columns: Array<{ id: string; defaultWidth: number }>;
  minWidth?: number;
}) {
  const { storageKey, columns, minWidth = 80 } = options;

  const [widths, setWidths] = useState<ColumnWidths>(() => {
    const stored = readStored(storageKey);
    const result: ColumnWidths = {};
    for (const col of columns) {
      result[col.id] = stored?.[col.id] ?? col.defaultWidth;
    }
    return result;
  });

  // Update widths when columns change (new columns get defaults, removed columns get dropped)
  const prevColIds = useRef<string>(columns.map((c) => c.id).join(","));
  useEffect(() => {
    const newKey = columns.map((c) => c.id).join(",");
    if (newKey !== prevColIds.current) {
      prevColIds.current = newKey;
      setWidths((prev) => {
        const stored = readStored(storageKey);
        const result: ColumnWidths = {};
        for (const col of columns) {
          result[col.id] = stored?.[col.id] ?? prev[col.id] ?? col.defaultWidth;
        }
        return result;
      });
    }
  }, [columns, storageKey]);

  const getWidth = useCallback(
    (colId: string) => widths[colId] ?? minWidth,
    [widths, minWidth],
  );

  const totalWidth = columns.reduce((sum, col) => sum + getWidth(col.id), 0);

  // Drag state stored in refs so pointer handlers stay stable
  const dragState = useRef<{
    colId: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  const onPointerDown = useCallback(
    (colId: string, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragState.current = {
        colId,
        startX: e.clientX,
        startWidth: widths[colId] ?? minWidth,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [widths, minWidth],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState.current) return;
      const { colId, startX, startWidth } = dragState.current;
      const delta = e.clientX - startX;
      const newWidth = Math.max(minWidth, startWidth + delta);
      setWidths((prev) => ({ ...prev, [colId]: newWidth }));
    },
    [minWidth],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragState.current = null;
      // Persist
      setWidths((current) => {
        writeStored(storageKey, current);
        return current;
      });
    },
    [storageKey],
  );

  return { getWidth, totalWidth, onPointerDown, onPointerMove, onPointerUp };
}
