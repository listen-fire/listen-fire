"use client";

/**
 * Modal shell every ported financial form uses. Collapses Chakra's
 * useDisclosure + Modal/ModalOverlay/ModalContent/ModalHeader/ModalBody/
 * ModalFooter into one component so the ~38 call sites in the ported forms
 * only need an import-path swap, not a rewrite of the modal wiring.
 * Overlay/header chrome matches apps/web's existing ontology Modal.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export function useDisclosure(defaultOpen = false) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const onOpen = useCallback(() => setIsOpen(true), []);
  const onClose = useCallback(() => setIsOpen(false), []);
  return { isOpen, onOpen, onClose };
}

const SIZE_WIDTHS = {
  md: "max-w-md",
  lg: "max-w-xl",
  xl: "max-w-3xl",
} as const;

export function FormModal({
  isOpen,
  onClose,
  title,
  size = "md",
  children,
  footer,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  size?: keyof typeof SIZE_WIDTHS;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className={`flex max-h-[85vh] w-full flex-col rounded-xl border border-gray-200 bg-white shadow-xl ${SIZE_WIDTHS[size]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-gray-100 px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
