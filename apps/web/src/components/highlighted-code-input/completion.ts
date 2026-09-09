// Shared completion item + apply logic for the formula / source-traversal
// editor. Consumers compute the list (what to suggest, where it inserts);
// the editor primitive renders the dropdown and applies the choice via
// `applyCompletionTo` — pure, so it unit-tests in isolation.

export interface CompletionItem {
  /** Text shown in the dropdown row. */
  label: string;
  /** Category, rendered as a colored badge (e.g. "edge", "function",
   *  "property", "value", "keyword"). Free-form; the renderer maps known
   *  kinds to colors and falls back for the rest. */
  kind: string;
  /** Optional secondary text (e.g. "→ Company", ": text"). */
  detail?: string;
  /** Text spliced into the value. */
  insert: string;
  /** Range in the current value the insert replaces. */
  replaceFrom: number;
  replaceTo: number;
  /** Caret position within `insert` after applying (default: end of
   *  insert). Lets a function insert leave the caret between its parens. */
  caretOffset?: number;
}

/** Apply a completion to `value`, returning the new value and caret. */
export function applyCompletionTo(
  value: string,
  item: CompletionItem,
): { value: string; caret: number } {
  const before = value.slice(0, item.replaceFrom);
  const after = value.slice(item.replaceTo);
  return {
    value: before + item.insert + after,
    caret: item.replaceFrom + (item.caretOffset ?? item.insert.length),
  };
}
