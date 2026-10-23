// The language service (crates/movement-language), through the movement
// artifact's `language_query` export: completion, hover, go-to-definition
// and quick fixes for a program in this release's language, answered as the
// native service answers `lf lsp`.
//
// Positions are UTF-16 offsets into the source string (CodeMirror's unit,
// and a JavaScript string's own); the wasm counts 0-based lines and UTF-16
// columns, split on `\n` as the native service splits them. A definition in
// a library file is an offset into that file's text in `snapshot.files`.
//
// It loads with the engine artifact, which a browser never downloads: the
// editor asks it through the server, as it asks for the check.

import { callLanguageQuery } from '../wasm/loader';
import { languageVersionDiagnostic, type LanguageVersion } from '../language_version';
import { RustCheckRefused } from '../checker/rust_checker';
import type { CatalogSnapshot } from './snapshot';

export interface LanguageServiceOptions {
  /** The program's pin. A pin this release does not read gets empty answers,
   *  the artifact not asked. */
  languageVersion: LanguageVersion;
}

/** A 0-based line and a UTF-16 column within it, as the wasm counts. */
export interface LinePosition {
  line: number;
  character: number;
}

export type CompletionKind =
  | 'variable'
  | 'function'
  | 'field'
  | 'edge'
  | 'module'
  | 'keyword'
  | 'property'
  | 'credential'
  | 'type'
  | 'namespace';

/** An entry that opens a connection flow rather than inserting text: the
 *  adapter's snapshot entry declares it (`connectActions`). */
export interface CompletionConnectAction {
  kind: string;
  adapter: string;
  credential?: string;
}

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  detail?: string;
  /** The text to insert, where it is not the label. */
  insert?: string;
  /** What the item replaces: its own range, or the word before the cursor. */
  from: number;
  to: number;
  connectAction?: CompletionConnectAction;
}

export interface Completions {
  /** The word before the cursor, which an item replaces unless it says otherwise. */
  from: number;
  to: number;
  items: CompletionItem[];
}

export interface HoverCard {
  from: number;
  to: number;
  markdown: string;
}

export type ModuleNamespace = 'adapters' | 'credentials' | 'plugins';

/** Where a name is defined: this file (`file: null`), a library file of the
 *  snapshot (offsets into its text), or a module the name was imported from. */
export type Definition =
  | { file: null; from: number; to: number }
  | { file: string; from: number; to: number }
  | { module: { namespace: ModuleNamespace; name: string } };

export interface QuickFix {
  title: string;
  /** The diagnostic code the fix answers. */
  code: string;
  preferred: boolean;
  edits: Array<{ from: number; to: number; insert: string }>;
}

/** The completions at `offset`. */
export function completionsAt(source: string, offset: number, snapshot: CatalogSnapshot, options: LanguageServiceOptions): Completions {
  if (unread(options)) return { from: offset, to: offset, items: [] };
  const answer = ask(source, snapshot, { kind: 'complete', position: positionOf(source, offset) });
  if (!isRecord(answer) || !Array.isArray(answer.items)) throw malformed('completion', answer);
  const word = rangeOf(source, answer.word);
  return { ...word, items: answer.items.map(item => itemOf(source, item, word)) };
}

/** The card for what is under `offset`, or null where there is none. */
export function hoverAt(source: string, offset: number, snapshot: CatalogSnapshot, options: LanguageServiceOptions): HoverCard | null {
  if (unread(options)) return null;
  const answer = ask(source, snapshot, { kind: 'hover', position: positionOf(source, offset) });
  if (answer === null) return null;
  if (!isRecord(answer) || typeof answer.contents !== 'string') throw malformed('hover', answer);
  return { ...rangeOf(source, answer.range), markdown: answer.contents };
}

/** Where the name under `offset` is defined, or null. */
export function definitionAt(source: string, offset: number, snapshot: CatalogSnapshot, options: LanguageServiceOptions): Definition | null {
  if (unread(options)) return null;
  const answer = ask(source, snapshot, { kind: 'definition', position: positionOf(source, offset) });
  if (answer === null) return null;
  if (!isRecord(answer) || (answer.file !== null && typeof answer.file !== 'string')) throw malformed('definition', answer);
  if (answer.module !== undefined) return { module: moduleOf(answer.module) };
  if (answer.file === null) return { file: null, ...rangeOf(source, answer.range) };
  // A library file the snapshot does not carry has no text: its offsets clamp to 0.
  const text = snapshot.files?.[answer.file]?.source ?? '';
  return { file: answer.file, ...rangeOf(text, answer.range) };
}

/** The quick fixes for the diagnostics touching `from`..`to`. */
export function quickFixesIn(source: string, from: number, to: number, snapshot: CatalogSnapshot, options: LanguageServiceOptions): QuickFix[] {
  if (unread(options)) return [];
  const range = { start: positionOf(source, from), end: positionOf(source, to) };
  const answer = ask(source, snapshot, { kind: 'codeActions', position: range.start, range });
  if (!Array.isArray(answer)) throw malformed('code actions', answer);
  return answer.map(action => {
    if (
      !isRecord(action) ||
      typeof action.title !== 'string' ||
      typeof action.code !== 'string' ||
      typeof action.preferred !== 'boolean' ||
      !Array.isArray(action.edits)
    ) {
      throw malformed('code action', action);
    }
    return {
      title: action.title,
      code: action.code,
      preferred: action.preferred,
      edits: action.edits.map(edit => {
        if (!isRecord(edit) || typeof edit.newText !== 'string') throw malformed('edit', edit);
        return { ...rangeOf(source, edit.range), insert: edit.newText };
      }),
    };
  });
}

/** The UTF-16 offset of `position` in `text`, clamped to its line and to the text. */
export function offsetOf(text: string, position: LinePosition): number {
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) return text.length;
    start = newline + 1;
  }
  const newline = text.indexOf('\n', start);
  const end = newline === -1 ? text.length : newline;
  return Math.min(start + position.character, end);
}

/** The line and UTF-16 column of `offset` in `text`, `offset` clamped to the text. */
export function positionOf(text: string, offset: number): LinePosition {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let start = 0;
  for (let newline = text.indexOf('\n'); newline !== -1 && newline < at; newline = text.indexOf('\n', start)) {
    line += 1;
    start = newline + 1;
  }
  return { line, character: at - start };
}

function unread(options: LanguageServiceOptions): boolean {
  return languageVersionDiagnostic(options.languageVersion) !== undefined;
}

type Query =
  | { kind: 'complete' | 'hover' | 'definition'; position: LinePosition }
  | { kind: 'codeActions'; position: LinePosition; range: { start: LinePosition; end: LinePosition } };

function ask(source: string, snapshot: CatalogSnapshot, query: Query): unknown {
  const reply = callLanguageQuery(source, JSON.stringify(snapshot), JSON.stringify(query));
  if (!reply.ok) throw RustCheckRefused.of(reply.json);
  return reply.json;
}

const KINDS: ReadonlySet<string> = new Set<CompletionKind>([
  'variable',
  'function',
  'field',
  'edge',
  'module',
  'keyword',
  'property',
  'credential',
  'type',
  'namespace',
]);

function isKind(value: unknown): value is CompletionKind {
  return typeof value === 'string' && KINDS.has(value);
}

function itemOf(source: string, value: unknown, word: { from: number; to: number }): CompletionItem {
  if (!isRecord(value) || typeof value.label !== 'string' || !isKind(value.kind)) throw malformed('completion item', value);
  const { label, kind, detail, insert, replace, connectAction } = value;
  if ((detail !== undefined && typeof detail !== 'string') || (insert !== undefined && typeof insert !== 'string')) {
    throw malformed('completion item', value);
  }
  return {
    label,
    kind,
    ...(detail !== undefined ? { detail } : {}),
    ...(insert !== undefined ? { insert } : {}),
    ...(replace !== undefined ? rangeOf(source, replace) : word),
    ...(connectAction !== undefined ? { connectAction: connectActionOf(connectAction) } : {}),
  };
}

function connectActionOf(value: unknown): CompletionConnectAction {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    typeof value.adapter !== 'string' ||
    (value.credential !== undefined && typeof value.credential !== 'string')
  ) {
    throw malformed('connect action', value);
  }
  return { kind: value.kind, adapter: value.adapter, ...(value.credential !== undefined ? { credential: value.credential } : {}) };
}

function moduleOf(value: unknown): { namespace: ModuleNamespace; name: string } {
  if (!isRecord(value) || typeof value.name !== 'string') throw malformed('module', value);
  const { namespace, name } = value;
  if (namespace !== 'adapters' && namespace !== 'credentials' && namespace !== 'plugins') throw malformed('module', value);
  return { namespace, name };
}

function rangeOf(text: string, value: unknown): { from: number; to: number } {
  if (!isRecord(value)) throw malformed('range', value);
  return { from: offsetOf(text, linePositionOf(value.start)), to: offsetOf(text, linePositionOf(value.end)) };
}

function linePositionOf(value: unknown): LinePosition {
  if (!isRecord(value) || typeof value.line !== 'number' || typeof value.character !== 'number') throw malformed('position', value);
  return { line: value.line, character: value.character };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(what: string, value: unknown): Error {
  return new Error(`the language service answered a ${what} that is not one: ${JSON.stringify(value)?.slice(0, 200)}`);
}
