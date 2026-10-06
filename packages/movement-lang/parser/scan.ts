// The ONE definition of "what is a name" in the movement language.
//
// A NAME is the verbatim name the adapter / ontology exposes: a bare identifier
// (`companies`) when the exposed name is identifier-safe, or backtick-quoted
// (`` `Funding Round` ``) when it carries spaces or punctuation. The two are the
// SAME name token. Both the parser (`Parser.readName` / `peekIdent` /
// `readBacktickName`) and the language service's completion cursor-context source
// their name recognition from here, so the grammar can never drift between them.

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

export interface ScannedName {
  /** The name verbatim — backticks stripped from a quoted name. */
  name: string;
  /** Index just past the scanned name (the closing backtick, for a quoted name). */
  end: number;
}

/**
 * Scan a bare identifier starting at `pos`. Returns the identifier and the index
 * just past it, or `null` when `src[pos]` is not an identifier start.
 */
export function scanIdent(src: string, pos: number): ScannedName | null {
  const c = src[pos];
  if (c === undefined || !IDENT_START.test(c)) return null;
  let end = pos + 1;
  while (end < src.length && IDENT_CHAR.test(src[end])) end++;
  return { name: src.slice(pos, end), end };
}

/**
 * Scan a backtick-quoted name starting at `pos` (which must be the opening
 * backtick). A quoted name is single-line. Returns the interior (backticks
 * stripped) and the index of the CLOSING backtick — callers advance past it.
 * Returns `null` when the name is unterminated (no closing backtick before EOF
 * or newline), leaving the specific error to the caller.
 */
export function scanBacktickName(src: string, pos: number): ScannedName | null {
  if (src[pos] !== '`') return null;
  let end = pos + 1;
  while (end < src.length && src[end] !== '`' && src[end] !== '\n') end++;
  if (end >= src.length || src[end] === '\n') return null;
  return { name: src.slice(pos + 1, end), end };
}

/**
 * Scan a NAME starting at `pos` — a backtick-quoted name when `src[pos]` is a
 * backtick, otherwise a bare identifier. Returns the name verbatim (backticks
 * stripped) and the index just past the token (the closing backtick for a quoted
 * name; one past the last identifier char for a bare one). `null` when no name
 * is present (or a quoted name is unterminated).
 */
export function scanName(src: string, pos: number): ScannedName | null {
  if (src[pos] === '`') {
    const quoted = scanBacktickName(src, pos);
    if (quoted === null) return null;
    // Report `end` one past the closing backtick so it is the index just past
    // the whole token, consistent with the bare-ident case.
    return { name: quoted.name, end: quoted.end + 1 };
  }
  return scanIdent(src, pos);
}

/**
 * Unwrap a raw credential argument value to its catalog-side name.
 *
 * A construction's credential argument is always a reference to an imported
 * credential — either a bare identifier (`cred`) or a backtick-quoted name
 * (`` `Dev-loop Attio` ``). Both forms denote the SAME catalog key (the
 * verbatim credential name with backticks stripped).
 *
 * Returns:
 *   - the unwrapped name for a bare identifier or a complete backtick name;
 *   - `null` for anything else (a real expression, a partial/malformed
 *     backtick, …) — the checker already diagnoses those, so callers treat
 *     null as "no credential name available".
 *
 * This is the ONE shared unwrap used everywhere a credential arg value is
 * read as a catalog key — provision, run, checker, IDE extractors — so the
 * sites can never drift from each other.
 */
export function unwrapCredentialArg(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('`')) {
    const scanned = scanBacktickName(trimmed, 0);
    // Require the closing backtick to be the very last character — anything
    // left over means it is not a plain name token.
    if (scanned === null || scanned.end !== trimmed.length - 1) return null;
    return scanned.name;
  }
  // Accept a bare identifier that spans the whole trimmed value.
  const ident = scanIdent(trimmed, 0);
  if (ident && ident.end === trimmed.length) return ident.name;
  return null;
}

/**
 * `IF(cond, a, b)` — IF called like a spreadsheet function. The language writes
 * it `IF cond THEN a ELSE b END`; a parenthesised condition (`IF (a OR b) THEN
 * …`) is the ordinary form, and only a top-level comma inside the parentheses
 * says the author meant a call. `open` is the offset of the `(` after `IF`.
 * Returns the message refusing it, with the rewrite where there are three
 * arguments; undefined when this is not a call.
 */
export function callStyleIfMessage(src: string, open: number): string | undefined {
  if (src[open] !== '(') return undefined;
  const args: string[] = [];
  const hops: boolean[] = [];
  let argStart = open + 1;
  let i = open;
  while (i < src.length) {
    const skipped = skipOpaque(src, i, { inHop: hops[hops.length - 1] ?? false });
    if (skipped !== undefined) {
      if (skipped.kind === 'unterminated') return undefined;
      i = skipped.end;
      continue;
    }
    const c = src[i];
    if (c in CLOSER) hops.push(opensHop(src, i));
    else if (c === ')' || c === ']' || c === '}') {
      hops.pop();
      if (hops.length === 0) {
        args.push(src.slice(argStart, i).trim());
        break;
      }
    } else if (c === ',' && hops.length === 1) {
      args.push(src.slice(argStart, i).trim());
      argStart = i + 1;
    }
    i++;
  }
  if (args.length < 2) return undefined;
  const rewrite =
    args.length === 3
      ? `IF ${args[0]} THEN ${args[1]} ELSE ${args[2]} END`
      : 'IF <condition> THEN <value> ELSE <otherwise> END';
  return `IF is written 'IF … THEN … ELSE … END', not called like a function — write '${rewrite}'`;
}

// ── The text a bracket scan steps over whole ──
//
// Both grammars find where a bracketed region ends without parsing it: the
// statement grammar to capture an expression slot, the expression grammar to
// find a closure's block body and a `${…}` interpolation. These are the ONE set
// of rules for what that scan steps over, so neither grammar can see a bracket
// the other reads as prose. They are the expression lexer's own rules — every
// region found this way is read by it — and it lexes with them too.

export const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/**
 * A string (`"…"` or `'…'`), a backtick-quoted name, or a `#` comment
 * starting at `pos`: the index just past it (a comment stops before its
 * newline), or where an unclosed one began.
 */
export type Opaque =
  | { kind: 'string' | 'name' | 'comment'; end: number }
  | { kind: 'unterminated'; what: 'string' | 'name'; start: number };

/**
 * What starts at `pos` that a bracket scan must step over whole, or undefined
 * when it is code. `inHop` is true directly inside a hop's brackets, where `#`
 * begins a head (`-[#linked]->`) rather than a comment.
 */
export function skipOpaque(
  src: string,
  pos: number,
  options: { inHop: boolean; limit?: number },
): Opaque | undefined {
  const limit = options.limit ?? src.length;
  const c = src[pos];
  if (c === '"' || c === "'") {
    const end = skipString(src, pos, limit);
    return end === undefined ? { kind: 'unterminated', what: 'string', start: pos } : { kind: 'string', end };
  }
  if (c === '`') {
    const end = skipBacktickName(src, pos, limit);
    return end === undefined ? { kind: 'unterminated', what: 'name', start: pos } : { kind: 'name', end };
  }
  if (c === '#' && !options.inHop) {
    let end = pos;
    while (end < limit && src[end] !== '\n') end++;
    return { kind: 'comment', end };
  }
  return undefined;
}

/**
 * The index just past the string opening at `pos` (`"` or `'`), or undefined
 * when it never closes. A backslash escapes the next character; a double-quoted
 * string's `${…}` is a balanced region, so a quote or brace inside it is code.
 */
export function skipString(src: string, pos: number, limit = src.length): number | undefined {
  const quote = src[pos];
  let i = pos + 1;
  while (i < limit) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (quote === '"' && c === '$' && src[i + 1] === '{') {
      const close = matchingClose(src, i + 1, limit);
      if (close === undefined) return undefined;
      i = close + 1;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return undefined;
}

/**
 * The index just past the backtick-quoted name opening at `pos`, or undefined
 * when it does not close on its line. A backslash escapes the next character,
 * so `` `a\`b` `` is one name.
 */
export function skipBacktickName(src: string, pos: number, limit = src.length): number | undefined {
  let i = pos + 1;
  while (i < limit && src[i] !== '\n') {
    if (src[i] === '`') return i + 1;
    i += src[i] === '\\' && src[i + 1] !== '\n' ? 2 : 1;
  }
  return undefined;
}

/** `start` is just inside `-[` / `<-[`: a hop opens with `:`, `#`, or an
 *  alias (`name:`). Anything else is a minus and a list. */
export function isHopInterior(src: string, start: number, limit = src.length): boolean {
  let i = start;
  while (i < limit && /\s/.test(src[i])) i++;
  const c = src[i];
  if (c === ':' || c === '#') return true;
  const end = c === '`' ? skipBacktickName(src, i, limit) : scanIdent(src, i)?.end;
  if (end === undefined || end > limit) return false;
  let j = end;
  while (j < limit && /\s/.test(src[j])) j++;
  return src[j] === ':';
}

/** Does the bracket at `open` begin a hop's interior (`-[…]->`, `<-[…]-`)? */
export function opensHop(src: string, open: number, limit = src.length): boolean {
  return src[open] === '[' && src[open - 1] === '-' && isHopInterior(src, open + 1, limit);
}

/**
 * The index of the bracket closing the one at `open`, or undefined when it is
 * unbalanced or a literal inside it never closes. Strings, quoted names and
 * comments are stepped over whole, at every depth: a `#` inside a block body
 * starts a comment whose prose is never read — except directly inside a hop's
 * brackets, where it begins a head.
 */
export function matchingClose(src: string, open: number, limit = src.length): number | undefined {
  const stack: Array<{ close: string; hop: boolean }> = [];
  let i = open;
  while (i < limit) {
    const skipped = skipOpaque(src, i, { inHop: stack[stack.length - 1]?.hop ?? false, limit });
    if (skipped !== undefined) {
      if (skipped.kind === 'unterminated') return undefined;
      i = skipped.end;
      continue;
    }
    const c = src[i];
    if (c in CLOSER) stack.push({ close: CLOSER[c], hop: opensHop(src, i, limit) });
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop()?.close !== c) return undefined;
      if (stack.length === 0) return i;
    }
    i++;
  }
  return undefined;
}
