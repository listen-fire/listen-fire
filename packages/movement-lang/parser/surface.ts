// The language surface of version 5 (plans/naming-rethink-2026-10-14/5_design.md):
// its spelling table and rewrite live in Rust (crates/movement-parser/src/surface);
// this is the TypeScript's view of them through the WASM.

import type { Span } from './ast';
import type { DiagnosticFix } from '../checker/fixes';
import { callParser } from '../wasm/loader';
import { LANGUAGE_VERSION, legacyPinOf, type LanguageVersion } from '../language_version';

/** An old spelling in a version 5 program: refused, its rewrite as the fix.
 *  `Program.spelling` carries them; both checkers report each as a diagnostic. */
export interface SpellingFinding {
  code: string;
  message: string;
  span: Span;
  fix?: DiagnosticFix;
  /** The bare name a call is written with, when the finding is about that
   *  name (`upper(x)`): it stands only where the program does not bind the
   *  name itself, which the checker, holding the scopes, decides. The span
   *  starts where the call does. */
  unlessBound?: string;
  /** The fix keeps the meaning only where the program binds none of these
   *  names at the finding (an old `SORT` key read an outer variable of its
   *  name first): the checker, holding the scopes, unmarks it there. The span
   *  starts where the call does. */
  unsafeIfBound?: string[];
  /** A call with named arguments (from version 5 they are positional): its
   *  arguments as written, for the checker to order by the callee's
   *  parameters. The finding stands only where the checker can. */
  named?: NamedCall;
}

export interface NamedCall {
  callee: string;
  args: Array<{ name: string; text: string; at: { line: number; col: number } }>;
}

// The spell entries still take the integer pin, and ignore it (`legacyPinOf`);
// Task 2 removes it.

/** `message` naming every built-in it quotes as the language spells it
 *  (`Text.upper`). */
export function spellMessage(message: string, version: LanguageVersion = LANGUAGE_VERSION): string {
  const { ok, json } = callParser('spell_message', message, [legacyPinOf(version)]);
  if (!ok || typeof json !== 'string') throw new Error(`spell_message: ${JSON.stringify(json)}`);
  return json;
}

/** A plugin's name from version 5: its registry name or catalog key in
 *  camelCase (`fetch_url` → `fetchUrl`), one spelling, matched exactly. */
export function pluginName(key: string): string {
  const { ok, json } = callParser('plugin_name', key, [legacyPinOf(LANGUAGE_VERSION)]);
  if (!ok || typeof json !== 'string') throw new Error(`plugin_name: ${JSON.stringify(json)}`);
  return json;
}

/** Program text a diagnostic suggests (`EXISTS(x)`, `AT(r, 0)`, `IF … THEN
 *  "Yes" ELSE "No" END`), written in the canonical spelling and rewritten by
 *  the parser's own spelling fixes (`x != null`, `r[0]`, `… ? "Yes" : "No"`).
 *  `…` stands for any expression. Pass only code: a text that parses is
 *  rewritten. */
export function spellCode(code: string, version: LanguageVersion = LANGUAGE_VERSION): string {
  const { ok, json } = callParser('spell_code', code, [legacyPinOf(version)]);
  if (!ok || typeof json !== 'string') throw new Error(`spell_code: ${JSON.stringify(json)}`);
  return json;
}

/** A word of code in prose (`negated by NOT`, `narrow with an IS test`),
 *  quoted as a symbol or lower case (`negated by '!'`). */
export function spellWord(word: string, version: LanguageVersion = LANGUAGE_VERSION): string {
  return `'${spellCode(word, version)}'`;
}

/** The head of an `if` a diagnostic suggests (`if EXISTS(x)`): its condition
 *  parenthesised and respelled (`if (x != null)`). For a suggestion whose
 *  body is not code. */
export function spellIf(condition: string, version: LanguageVersion = LANGUAGE_VERSION): string {
  return `if (${spellCode(condition, version)})`;
}

export interface SpellingRow {
  canonical: string;
  v5: string;
  shape: string;
  oldOnly: boolean;
  newOnly: boolean;
}

export interface SurfaceTable {
  spellings: SpellingRow[];
  namespaces: string[];
  coreWords: string[];
  walkCaps: [string, string][];
  operators: [string, string][];
  statementWords: [string, string][];
}

let table: SurfaceTable | undefined;

/** The spelling table, read once from the WASM. */
export function surfaceTable(): SurfaceTable {
  if (table === undefined) {
    const { ok, json } = callParser('surface_table', '', [legacyPinOf(LANGUAGE_VERSION)]);
    if (!ok || !isTable(json)) throw new Error(`surface_table: ${JSON.stringify(json)}`);
    table = json;
  }
  return table;
}

function isTable(value: unknown): value is SurfaceTable {
  return typeof value === 'object' && value !== null && Array.isArray((value as { spellings?: unknown }).spellings);
}

/** What a name a program binds hides from version 5, exactly as written: a
 *  core word or a standard namespace (Rust: `table::hidden_by`). */
export function hiddenBy(name: string): string | undefined {
  const { coreWords, namespaces } = surfaceTable();
  if (coreWords.includes(name)) return `the core word \`${name}\``;
  if (namespaces.includes(name)) return `the namespace \`${name}\``;
  return undefined;
}

/** Whether the spelling table respells the built-in the tree names
 *  `canonical` (in any letter case, as versions 1–4 read it). */
export function isRespelled(canonical: string): boolean {
  const folded = canonical.toUpperCase();
  return surfaceTable().spellings.some((s) => !s.newOnly && s.canonical.toUpperCase() === folded);
}
