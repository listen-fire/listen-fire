// Pure helpers for the source-traversal editor's leaf hint: identify the
// token under the caret and the aliases bound in the traversal text. Split
// out of right-panel.tsx so they unit-test without the JSX import chain.

/** Whether the caret is inside a `"…"` / `'…'` string literal. Backticks
 *  are NOT string literals here — they quote property names — so they don't
 *  count. Used to suppress the leaf field hint when the caret is in prose
 *  (e.g. a `description:` string that happens to mention a field name). */
export function caretInStringLiteral(text: string, caret: number): boolean {
  let inQuote: string | null = null;
  for (let i = 0; i < caret; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "\\") i++;
      else if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "`") {
      i++;
      while (i < caret && text[i] !== "`") i++;
    }
  }
  return inQuote !== null;
}

/** The identifier the caret sits on — the content of an enclosing backtick
 *  pair (`` `Plain Body` ``) when inside one, else the contiguous bare-ident
 *  run. Null when the caret isn't on a name. */
export function wordAtCaret(text: string, caret: number): string | null {
  const prevTick = text.lastIndexOf("`", caret - 1);
  if (prevTick >= 0 && !text.slice(prevTick + 1, caret).includes("`")) {
    const nextTick = text.indexOf("`", caret);
    const inner = text.slice(prevTick + 1, nextTick >= 0 ? nextTick : caret);
    if (inner.trim()) return inner;
  }
  let s = caret;
  let e = caret;
  while (s > 0 && /[A-Za-z0-9_]/.test(text[s - 1])) s--;
  while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
  return e > s ? text.slice(s, e) : null;
}

/** Aliases bound in a traversal (`-[company:#extract …]->`, `-[c:Owns]->`)
 *  mapped (lowercased) to a human summary of what each binds to. */
export function collectBoundAliases(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /<?-\[\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*:\s*(#extract|#transform|#resources|`?[A-Za-z_][A-Za-z0-9_ ]*`?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const binding = m[2].trim();
    const summary =
      binding === "#extract"
        ? "the extracted node"
        : binding === "#transform"
          ? "the transform result"
          : binding === "#resources"
            ? "the selected resources"
            : `the ${binding.replace(/`/g, "")} step`;
    out.set(m[1].toLowerCase(), summary);
  }
  return out;
}
