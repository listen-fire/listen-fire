// HighlightedCodeInput — the shared formula / source-traversal editor:
// a wrapping, auto-expanding field with syntax highlighting, caret hints,
// a completion dropdown, and a validation display. Consumers decide WHAT
// to suggest and WHETHER the value is valid (via `getCompletions` and the
// `validation` prop); this component renders all of it uniformly.
//
// Technique (react-simple-code-editor pattern): an aria-hidden overlay
// <div> sits *in flow* and defines the box height; a transparent <textarea>
// is absolutely positioned on top of it, filling it exactly. Both layers
// share identical typography + box metrics, so the caret aligns to the
// colored glyphs to the pixel. The textarea never scrolls internally — it
// conforms to the overlay's height and the field grows with content.
//
// Pure logic lives in sibling modules (`./highlight`, `./brackets`,
// `./runs`, `./decorations`, `./hints`, `./completion`), each unit-tested;
// this file is the DOM wiring.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { highlightTokens, type HighlightClass } from "./highlight";
import { assembleRuns } from "./runs";
import { computeDecorations } from "./decorations";
import { contextStackAtCaret, type ResolveLeaf } from "./hints";
import type { ExtraSignatures } from "./function-signatures";
import { applyCompletionTo, type CompletionItem } from "./completion";

// Token color classes. Keywords use the theme purple (`primary`); the rest
// are semantic colors. Kept here so the palette lives in one place.
const CLASS_STYLE: Record<HighlightClass, string> = {
  keyword: "text-primary-700 font-semibold",
  function: "text-blue-600",
  string: "text-green-600",
  number: "text-amber-600",
  property: "text-teal-600",
  "meta-edge": "text-pink-600 font-semibold",
  global: "text-yellow-600",
  punctuation: "text-gray-400",
  plain: "text-gray-800",
};

// Completion-kind → badge color. Unknown kinds fall back to gray.
const KIND_COLOR: Record<string, string> = {
  edge: "text-cyan-500",
  function: "text-blue-500",
  property: "text-teal-500",
  value: "text-teal-500",
  option: "text-amber-500",
  operator: "text-gray-400",
  keyword: "text-primary-500",
  special: "text-yellow-600",
  "meta-edge": "text-pink-500",
  "meta-edge-arg": "text-pink-400",
};

// Shared typography + box metrics. MUST match between the textarea and the
// overlay or the colored glyphs will drift off the real ones. `min-h`
// reserves one row; `pr-7` reserves space for the validation check.
const SHARED_TEXT =
  "pl-3 pr-7 py-2 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words min-h-[calc(1.5em_+_1rem)]";

export interface ValidationState {
  valid: boolean;
  error?: string;
  warning?: string;
}

export interface HighlightedCodeInputProps {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  /** Extra classes for the outer box (border / validation state). */
  className?: string;
  spellCheck?: boolean;
  /** Resolve the leaf token (field / edge / alias) the caret is on into a
   *  hint. Injected by the consumer (it has the descriptor / ontology). */
  resolveLeafHint?: ResolveLeaf;
  /** Extra function signatures merged into the argument-hint lookup —
   *  the field functions advertised on the field being mapped (e.g.
   *  SLACK_MESSAGE). Keyed by uppercased name. */
  functionSignatures?: ExtraSignatures;
  /** How many inside-out hint layers to show: `0` none, `1` leaf only,
   *  `2` leaf + immediate container (default), `null` the whole stack. */
  hintDepth?: number | null;
  /** Consumer-computed completions for the caret position. The component
   *  renders the dropdown, navigates it, and applies the choice. */
  getCompletions?: (value: string, caret: number) => readonly CompletionItem[];
  /** Consumer-computed validation. The component renders the check /
   *  error / warning. */
  validation?: ValidationState;
}

export const HighlightedCodeInput = forwardRef<
  HTMLTextAreaElement,
  HighlightedCodeInputProps
>(function HighlightedCodeInput(
  {
    value,
    onChange,
    onFocus,
    onBlur,
    placeholder,
    className = "",
    spellCheck = false,
    resolveLeafHint,
    functionSignatures,
    hintDepth = 2,
    getCompletions,
    validation,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [hintPos, setHintPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const [dropdownPos, setDropdownPos] = useState<{
    top: number;
    left: number;
    direction: "up" | "down";
  } | null>(null);

  useImperativeHandle(ref, () => textareaRef.current!, []);

  const runs = useMemo(() => {
    const spans = highlightTokens(value);
    const deco = computeDecorations(value, caret);
    return assembleRuns(value, spans, deco);
  }, [value, caret]);

  // ── Caret hint stack ──────────────────────────────────────────────────
  const hintStack = useMemo(
    () => contextStackAtCaret(value, caret, { resolveLeaf: resolveLeafHint, functionSignatures }),
    [value, caret, resolveLeafHint, functionSignatures],
  );
  const visibleHints =
    hintDepth === null ? hintStack : hintStack.slice(0, Math.max(0, hintDepth));

  // ── Completions ───────────────────────────────────────────────────────
  const completions = useMemo<readonly CompletionItem[]>(
    () => getCompletions?.(value, caret) ?? [],
    [getCompletions, value, caret],
  );
  const dropdownOpen = focused && completions.length > 0;
  const showHint = focused && !dropdownOpen && visibleHints.length > 0;

  const syncCaret = () => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  };

  useEffect(() => setFocusIdx(0), [value, caret]);

  const applyCompletion = (item: CompletionItem) => {
    const { value: next, caret: nextCaret } = applyCompletionTo(value, item);
    onChange(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  // Anchor the hint above the field and the dropdown below it, portaled to
  // the document root so neither is clipped by the sidebar's overflow.
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setHintPos(showHint ? { top: rect.top - 6, left: rect.left } : null);
    if (dropdownOpen) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const direction = spaceBelow < 240 && rect.top > spaceBelow ? "up" : "down";
      setDropdownPos({
        top: direction === "down" ? rect.bottom + 2 : rect.top - 2,
        left: Math.min(rect.left, window.innerWidth - 240),
        direction,
      });
    } else {
      setDropdownPos(null);
    }
  }, [showHint, dropdownOpen, value, caret]);

  // Keep the focused completion in view within the dropdown's own scroller.
  useEffect(() => {
    if (!dropdownOpen) return;
    const container = scrollRef.current;
    const item = itemRefs.current[focusIdx];
    if (!container || !item) return;
    const above = item.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const below =
      item.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom;
    if (above < 0) container.scrollTop += above;
    else if (below > 0) container.scrollTop += below;
  }, [focusIdx, dropdownOpen]);

  // Click outside closes the field (and so the dropdown / hint).
  useEffect(() => {
    if (!focused) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !textareaRef.current?.contains(t) &&
        !dropdownRef.current?.contains(t)
      ) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [focused]);

  const showCheck = !!validation?.valid && value.trim().length > 0;
  const showError =
    !!validation && !validation.valid && !dropdownOpen && !!validation.error;
  const showWarning = !!validation?.warning && !dropdownOpen;

  return (
    <>
      <div
        ref={containerRef}
        className={`relative rounded-md border bg-white ${className}`}
      >
        {/* In-flow overlay — defines the box height; the textarea conforms. */}
        <div aria-hidden className={`pointer-events-none ${SHARED_TEXT}`}>
          {value.length === 0 && placeholder ? (
            <span className="text-gray-400">{placeholder}</span>
          ) : (
            runs.map((r, i) => (
              <span
                key={i}
                className={`${CLASS_STYLE[r.cls]}${r.bold ? " font-bold" : ""}${
                  r.matched ? " rounded bg-primary-100" : ""
                }${
                  r.error
                    ? " underline decoration-red-400 decoration-wavy"
                    : ""
                }`}
              >
                {r.text}
              </span>
            ))
          )}
          {value.endsWith("\n") ? " " : null}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          spellCheck={spellCheck}
          autoComplete="off"
          onChange={(e) => {
            onChange(e.target.value);
            syncCaret();
          }}
          onKeyDown={(e) => {
            if (dropdownOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setFocusIdx((i) => Math.min(i + 1, completions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setFocusIdx((i) => Math.max(i - 1, 0));
              } else if (
                (e.key === "Enter" || e.key === "Tab") &&
                completions[focusIdx]
              ) {
                e.preventDefault();
                applyCompletion(completions[focusIdx]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setFocused(false);
                textareaRef.current?.blur();
              }
            }
          }}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          className={`absolute inset-0 resize-none overflow-hidden bg-transparent text-transparent caret-gray-800 outline-none ${SHARED_TEXT}`}
        />
        {showCheck && (
          <svg
            className="pointer-events-none absolute right-2 top-2 h-3.5 w-3.5 text-green-500"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden
          >
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
          </svg>
        )}
      </div>
      {showError && (
        <div className="mt-1 text-[11px] text-red-500">{validation!.error}</div>
      )}
      {showWarning && (
        <div className="mt-1 text-[11px] text-amber-600">
          {validation!.warning}
        </div>
      )}

      {/* Caret hint — above the field. */}
      {showHint &&
        hintPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[9999] max-w-sm -translate-y-full rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] shadow-lg"
            style={{ top: hintPos.top, left: hintPos.left }}
          >
            {visibleHints.map((layer, idx) => (
              <div
                key={idx}
                className={
                  idx > 0
                    ? "mt-1.5 border-t border-gray-100 pt-1.5 opacity-70"
                    : ""
                }
              >
                {layer.kind === "function" ? (
                  <FunctionHintBody hint={layer} />
                ) : (
                  <>
                    <div
                      className={`font-mono ${
                        layer.kind === "meta-edge"
                          ? "font-semibold text-pink-600"
                          : layer.kind === "token"
                            ? "text-teal-600"
                            : "text-gray-900"
                      }`}
                    >
                      {layer.label}
                    </div>
                    <div className="mt-0.5 text-gray-500">{layer.summary}</div>
                  </>
                )}
              </div>
            ))}
          </div>,
          document.body,
        )}

      {/* Completion dropdown — below the field. */}
      {dropdownOpen &&
        dropdownPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={dropdownRef}
            onMouseDown={(e) => e.preventDefault()}
            className="fixed z-[9999] min-w-[220px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
            style={
              dropdownPos.direction === "down"
                ? { top: dropdownPos.top, left: dropdownPos.left }
                : { bottom: window.innerHeight - dropdownPos.top, left: dropdownPos.left }
            }
          >
            <div ref={scrollRef} className="max-h-60 overflow-auto py-1">
              {completions.map((c, i) => (
                <button
                  key={`${c.label}-${i}`}
                  type="button"
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  onMouseEnter={() => setFocusIdx(i)}
                  onMouseDown={() => applyCompletion(c)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                    i === focusIdx ? "bg-gray-100 text-gray-900" : "text-gray-700"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-medium uppercase ${
                        KIND_COLOR[c.kind] ?? "text-gray-400"
                      }`}
                    >
                      {c.kind}
                    </span>
                    <span className="font-mono">{c.label}</span>
                  </span>
                  {c.detail && c.detail !== c.label && (
                    <span className="text-[10px] text-gray-400">{c.detail}</span>
                  )}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
});

function FunctionHintBody({
  hint,
}: {
  hint: Extract<import("./hints").EditorHint, { kind: "function" }>;
}) {
  const activeIdx = Math.min(hint.activeParam, hint.params.length - 1);
  return (
    <>
      <div className="font-mono text-gray-500">
        <span className="text-blue-600">{hint.name}</span>(
        {hint.params.map((p, i) => (
          <span key={p.name}>
            <span
              className={
                i === activeIdx
                  ? "font-semibold text-gray-900"
                  : "text-gray-400"
              }
            >
              {p.name}
            </span>
            {i < hint.params.length - 1 ? ", " : ""}
          </span>
        ))}
        )
      </div>
      <div className="mt-0.5 text-gray-500">
        {hint.params[activeIdx]?.description ?? hint.summary}
      </div>
    </>
  );
}
