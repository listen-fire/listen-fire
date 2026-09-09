"use client";

/**
 * The assistant's input row — textarea, attach button, send/stop —
 * plus pending-attachment chips and a drag-and-drop zone that wraps
 * the whole chat surface. Shared by both presentations.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Send, Square, X } from "lucide-react";
import type { AssistantChat } from "./use-assistant-chat";

/** File types the agent can actually read back as text. */
const ACCEPTED_FILE_TYPES = ".pdf,.pptx,.xlsx,.txt,.csv,.md,.json";

export function FileDropZone({
  onFiles,
  disabled,
  className,
  children,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  return (
    <div
      className={`relative ${className ?? ""}`}
      onDragEnter={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (disabled) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onFiles(e.dataTransfer.files);
        }
      }}
    >
      {children}
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/40 bg-primary-50/80">
          <div className="flex items-center gap-2 text-[13px] font-medium text-primary">
            <Paperclip size={15} />
            Drop files to attach
          </div>
        </div>
      )}
    </div>
  );
}

export function Composer({
  chat,
  placeholder = "Ask about anything…",
  contextLabel,
  autoFocus,
}: {
  chat: AssistantChat;
  placeholder?: string;
  /** Optional "Viewing: …" chip above the input (panel presentation). */
  contextLabel?: string | null;
  autoFocus?: boolean;
}) {
  const {
    input,
    setInput,
    send,
    cancel,
    isLoading,
    pendingFiles,
    removePendingFile,
    uploadFiles,
    isUploading,
  } = chat;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Focus whenever the surface (re)activates — `autoFocus` is treated
  // as a live signal, not just a mount-time attribute, so the panel
  // refocuses each time it slides open.
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleSend = useCallback(() => {
    void send();
    if (inputRef.current) inputRef.current.style.height = "auto";
  }, [send]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = !!input.trim() || pendingFiles.length > 0;

  return (
    <div className="shrink-0 border-t border-gray-100 px-4 py-3">
      {contextLabel && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] text-gray-400">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
          <span className="truncate">Viewing: {contextLabel}</span>
        </div>
      )}

      {pendingFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {pendingFiles.map((f) => (
            <span
              key={f.documentId}
              className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-[12px] text-gray-600"
            >
              <Paperclip size={11} className="text-gray-400" />
              {f.filename}
              <button
                onClick={() => removePendingFile(f.documentId)}
                className="cursor-pointer ml-0.5 text-gray-400 hover:text-gray-600"
                title="Remove attachment"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={ACCEPTED_FILE_TYPES}
          multiple
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              void uploadFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="cursor-pointer flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-gray-50 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          title="Attach file"
        >
          {isUploading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Paperclip size={14} />
          )}
        </button>
        <textarea
          ref={inputRef}
          value={input}
          autoFocus={autoFocus}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          className="max-h-[200px] flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-[13px] placeholder:text-gray-400 focus:border-primary/40 focus:bg-white focus:outline-none focus:ring-1 focus:ring-primary/20"
        />
        {isLoading && !canSend ? (
          <button
            onClick={cancel}
            className="cursor-pointer flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-600 text-white transition-colors hover:bg-gray-700"
            title="Stop"
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="cursor-pointer flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
            title="Send"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
