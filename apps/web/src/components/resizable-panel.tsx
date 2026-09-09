"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ResizablePanelProps {
  children: React.ReactNode;
  side: "left" | "right";
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  storageKey?: string;
  className?: string;
}

function readStoredWidth(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const n = parseInt(stored, 10);
      if (!isNaN(n)) return n;
    }
  } catch {}
  return fallback;
}

export function ResizablePanel({
  children,
  side,
  defaultWidth,
  minWidth,
  maxWidth,
  storageKey,
  className = "",
}: ResizablePanelProps) {
  const [width, setWidth] = useState(() =>
    readStoredWidth(storageKey, defaultWidth),
  );
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newWidth =
        side === "left"
          ? startWidth.current + delta
          : startWidth.current - delta;
      setWidth(Math.max(minWidth, Math.min(maxWidth, newWidth)));
    },
    [side, minWidth, maxWidth],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(width));
        } catch {}
      }
    },
    [storageKey, width],
  );

  // Clamp stored width to current min/max on mount
  useEffect(() => {
    setWidth((w) => Math.max(minWidth, Math.min(maxWidth, w)));
  }, [minWidth, maxWidth]);

  const handle = (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={`absolute top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50 ${
        side === "left" ? "right-0" : "left-0"
      }`}
    />
  );

  return (
    <div
      style={{ width }}
      className={`relative flex h-full shrink-0 flex-col overflow-hidden ${className}`}
    >
      {children}
      {handle}
    </div>
  );
}
