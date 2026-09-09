"use client";

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

// Typeahead-enabled single-row input for the constraint-text grammar
// (see `lib/uniqueness-constraints.ts` for the parser). Reused by both the
// ontology editor (`components/ontology/node-detail-panel.tsx`), so the
// authoring surface stays consistent everywhere uniqueness constraints are
// edited.

type Completion = {
  label: string;
  insert: string;
  kind: "property" | "edge" | "keyword";
  /**
   * Offset, relative to the end of `insert`, where the caret should land
   * post-insert. Negative places the caret inside (e.g. -1 lands between
   * the parens for `FUZZY()`). Undefined means caret at end.
   */
  caretAdjust?: number;
};

const WORD_BOUNDARY = /[A-Za-z0-9_-]*$/;

/**
 * Computes the current word at the caret + filtered completion options.
 * The constraint grammar is small enough that a flat completion pool
 * (every property, every reachable edge, plus the FUZZY/AND keywords)
 * filtered by the partial word does the job. No multi-state parser, no
 * context-sensitive disambiguation — the user can read the dropdown to
 * see what fits next.
 */
function computeCompletions(
  value: string,
  cursor: number,
  propertyNames: ReadonlyArray<string>,
  edgeNodeTypeNames: ReadonlyArray<string>,
  ancestorNames: ReadonlyArray<string>,
): { word: string; options: Completion[] } {
  const before = value.slice(0, cursor);
  const word = before.match(WORD_BOUNDARY)?.[0] ?? "";
  const lower = word.toLowerCase();

  // After typing `edge_to:` (with optional partial ancestor name), the
  // only relevant completions are the bound ancestor names. Match this
  // shape first so we don't drown the user in unrelated property/edge
  // suggestions.
  const edgeToCtx = before.match(/edge_to:\s*([A-Za-z0-9_-]*)$/i);
  if (edgeToCtx && ancestorNames.length > 0) {
    const partial = edgeToCtx[1].toLowerCase();
    const filtered = ancestorNames
      .filter((n) => !partial || n.toLowerCase().includes(partial))
      .map<Completion>((n) => ({ label: n, insert: n, kind: "keyword" }))
      .slice(0, 12);
    return { word: edgeToCtx[1], options: filtered };
  }

  const pool: Completion[] = [];
  for (const name of propertyNames) {
    pool.push({ label: name, insert: name, kind: "property" });
  }
  for (const name of edgeNodeTypeNames) {
    const text = `-[:${name}]->`;
    pool.push({ label: text, insert: text, kind: "edge" });
  }
  // FUZZY only makes sense at the start of an entry — i.e. immediately
  // after the start of the input, an opening paren, or " AND ". Skip
  // when we're partway through a property name.
  const justBeforeWord = before.slice(0, before.length - word.length).trimEnd();
  const atEntryStart =
    justBeforeWord.length === 0 || /\bAND$/i.test(justBeforeWord);
  if (atEntryStart) {
    pool.push({
      label: "FUZZY(…)",
      insert: "FUZZY()",
      kind: "keyword",
      caretAdjust: -1,
    });
    // `edge_to:` opens a compound-scope reference to an ancestor binding.
    // Only suggest when at least one ancestor is bound — for the ontology
    // editor (no TG scope) the prefix would just dead-end.
    if (ancestorNames.length > 0) {
      pool.push({
        label: "edge_to:…",
        insert: "edge_to:",
        kind: "keyword",
      });
    }
  }
  // AND only fits AFTER a complete entry — there has to be something
  // committed before it, and we shouldn't suggest it right after another
  // AND.
  if (
    !atEntryStart &&
    !/AND\s*$/i.test(before) &&
    !/-\[:[^\]]*$/.test(before)
  ) {
    pool.push({ label: "AND", insert: "AND ", kind: "keyword" });
  }

  const filtered = lower
    ? pool.filter((c) => c.label.toLowerCase().includes(lower))
    : pool;
  return { word, options: filtered.slice(0, 12) };
}

export function ConstraintInput({
  value,
  onChange,
  onCommit,
  onCancel,
  propertyNames,
  edgeNodeTypeNames,
  ancestorNames = [],
  error,
  autoFocus,
  placeholder = "e.g. FUZZY(Name) AND Website",
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  propertyNames: ReadonlyArray<string>;
  edgeNodeTypeNames: ReadonlyArray<string>;
  /** TG-ancestor binding names — drives `edge_to:` typeahead. */
  ancestorNames?: ReadonlyArray<string>;
  error: string | null;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cursorPos, setCursorPos] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const { options } = useMemo(
    () =>
      computeCompletions(
        value,
        cursorPos,
        propertyNames,
        edgeNodeTypeNames,
        ancestorNames,
      ),
    [value, cursorPos, propertyNames, edgeNodeTypeNames, ancestorNames],
  );
  const dropdownOpen = focused && options.length > 0;

  const applyCompletion = useCallback(
    (option: Completion) => {
      const input = inputRef.current;
      if (!input) return;
      const pos = input.selectionStart ?? value.length;
      const lastWord = value.slice(0, pos).match(WORD_BOUNDARY)?.[0] ?? "";
      const before = value.slice(0, pos - lastWord.length);
      const after = value.slice(pos);
      const needsTrailingSpace =
        option.kind === "property" &&
        !after.startsWith(" ") &&
        !after.startsWith(")");
      const insert = option.insert + (needsTrailingSpace ? " " : "");
      const newValue = before + insert + after;
      const adjust = option.caretAdjust ?? 0;
      const newCursor = before.length + insert.length + adjust;
      onChange(newValue);
      requestAnimationFrame(() => {
        input.setSelectionRange(newCursor, newCursor);
        input.focus();
        setCursorPos(newCursor);
      });
    },
    [value, onChange],
  );

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (dropdownOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, options.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && options[highlight]) {
        e.preventDefault();
        applyCompletion(options[highlight]);
        return;
      }
    }
    if (e.key === "Enter") {
      onCommit();
      return;
    }
    if (e.key === "Escape") {
      onCancel();
      return;
    }
  };

  return (
    <div className="relative flex-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCursorPos(e.target.selectionStart ?? e.target.value.length);
          setHighlight(0);
        }}
        onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
        onFocus={() => setFocused(true)}
        onBlur={() =>
          // Delay so a click on a dropdown option fires before we hide it.
          setTimeout(() => setFocused(false), 100)
        }
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={`w-full rounded-md border bg-white px-2.5 py-1.5 font-mono text-[12px] placeholder:text-gray-300 focus:outline-none ${
          error
            ? "border-red-300 text-red-700 focus:border-red-400"
            : "border-gray-200 text-gray-800 focus:border-gray-400"
        }`}
      />
      {dropdownOpen && (
        <ul className="absolute left-0 right-0 top-full z-10 mt-0.5 max-h-48 overflow-auto rounded-md border border-gray-200 bg-white py-0.5 shadow-md">
          {options.map((opt, i) => (
            <li
              key={`${opt.kind}:${opt.label}`}
              onMouseDown={(e) => {
                e.preventDefault();
                applyCompletion(opt);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-pointer items-center justify-between px-2.5 py-1 font-mono text-[11px] ${
                i === highlight ? "bg-gray-100 text-gray-900" : "text-gray-700"
              }`}
            >
              <span>{opt.label}</span>
              <span className="ml-2 text-[9px] uppercase tracking-wider text-gray-400">
                {opt.kind}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
