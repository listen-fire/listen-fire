// The text of a saved automation, as the editing tools see it: its revision,
// a window of its lines, a search across every program, and an edit anchored
// on a snippet rather than a line number.

import { createHash } from 'node:crypto';

import type { StoredProgram } from './host';

/**
 * The revision of a program's text: the sha256 of its UTF-8 bytes, in hex.
 * Byte identity is the only equivalence, so any change (whitespace too) is a
 * new revision. A host compares `revisionOf(stored.source)` with the
 * revision an agent expects; it never computes one any other way.
 */
export function revisionOf(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export type ContentEdit = { ok: true; source: string } | { ok: false; error: string };

/**
 * Replace `oldString` with `newString` in `source`. It refuses rather than
 * guess: no match means the anchor does not describe the current text, and
 * more than one (without `replaceAll`) means it does not pin one place.
 */
export function applyContentEdit(input: { source: string; oldString: string; newString: string; replaceAll?: boolean }): ContentEdit {
  const { source, oldString, newString, replaceAll = false } = input;
  if (oldString === '') return { ok: false, error: 'oldString must not be empty.' };
  const count = source.split(oldString).length - 1;
  if (count === 0) {
    return {
      ok: false,
      error:
        'oldString was not found in the current source. Read the automation again (readAutomation or getAutomation) and anchor the edit on text that is actually there.',
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error: `oldString matches ${count} places in the source. Either widen it to a snippet that pins one location, or pass replaceAll: true to change every match.`,
    };
  }
  if (replaceAll) return { ok: true, source: source.split(oldString).join(newString) };
  const at = source.indexOf(oldString);
  return { ok: true, source: source.slice(0, at) + newString + source.slice(at + oldString.length) };
}

export interface LineWindow {
  id: string;
  name: string;
  revision: string;
  totalLines: number;
  offset: number;
  lines: Array<{ n: number; text: string }>;
}

/** Lines `offset` (1-based) onwards, `limit` of them (default: the rest). */
export function readWindow(program: StoredProgram, window: { offset?: number; limit?: number }): LineWindow {
  const all = program.source.split('\n');
  const offset = window.offset ?? 1;
  const start = Math.max(0, offset - 1);
  const end = window.limit === undefined ? all.length : Math.min(all.length, start + window.limit);
  return {
    id: program.id,
    name: program.name,
    revision: revisionOf(program.source),
    totalLines: all.length,
    offset,
    lines: all.slice(start, end).map((text, i) => ({ n: start + i + 1, text })),
  };
}

export const GREP_MAX_MATCHES = 200;

export interface GrepMatch {
  id: string;
  name: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

/** Every line of `programs` that holds `pattern` (a literal, or with
 *  `isRegex` a regular expression), with `contextLines` around each; at most
 *  {@link GREP_MAX_MATCHES}, `truncated` when there were more. */
export function grepPrograms(
  programs: readonly StoredProgram[],
  input: { pattern: string; isRegex?: boolean; contextLines?: number },
): { matches: GrepMatch[]; truncated: boolean } | { error: string } {
  let matches = (line: string) => line.includes(input.pattern);
  if (input.isRegex === true) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(input.pattern);
    } catch (error) {
      return { error: `"${input.pattern}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}` };
    }
    matches = (line) => pattern.test(line);
  }
  const context = input.contextLines ?? 0;
  const found: GrepMatch[] = [];
  for (const program of programs) {
    const lines = program.source.split('\n');
    for (const [i, text] of lines.entries()) {
      if (!matches(text)) continue;
      if (found.length >= GREP_MAX_MATCHES) return { matches: found, truncated: true };
      found.push({
        id: program.id,
        name: program.name,
        line: i + 1,
        text,
        before: lines.slice(Math.max(0, i - context), i),
        after: lines.slice(i + 1, i + 1 + context),
      });
    }
  }
  return { matches: found, truncated: false };
}
