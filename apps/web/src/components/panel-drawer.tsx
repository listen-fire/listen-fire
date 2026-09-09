"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

interface PanelDrawerProps {
  children: React.ReactNode;
  side: "left" | "right";
  open: boolean;
  onClose: () => void;
  title?: string;
}

export function PanelDrawer({
  children,
  side,
  open,
  onClose,
  title,
}: PanelDrawerProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [open]);

  const translateClosed =
    side === "left" ? "-translate-x-full" : "translate-x-full";
  const position = side === "left" ? "left-0" : "right-0";

  return (
    <div
      className={`fixed inset-0 z-50 transition-opacity duration-200 ${
        open
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0"
      }`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* Drawer */}
      <div
        className={`absolute ${position} top-0 flex h-full w-[85vw] max-w-md flex-col bg-white shadow-lg transition-transform duration-200 ${
          open ? "translate-x-0" : translateClosed
        }`}
      >
        {title && (
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-gray-100 px-4">
            <span className="text-[14px] font-semibold text-gray-900">
              {title}
            </span>
            <button
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
