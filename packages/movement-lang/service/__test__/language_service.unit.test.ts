// The wasm language service through its binding, over the native service's
// own fixtures (crates/movement-language/tests/fixtures/service/, which
// tests/service.rs reads): offsets in and out, across a character outside
// the BMP, a definition in a library file, a definition that is a module,
// and an entry that opens a connection.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { LANGUAGE_VERSION } from '../../language_version';
import type { CatalogSnapshot } from '../snapshot';
import { completionsAt, definitionAt, hoverAt, offsetOf, positionOf, quickFixesIn } from '../language_service';

const FIXTURES = path.join(__dirname, '../../../../crates/movement-language/tests/fixtures/service');
const PROGRAM = fs.readFileSync(path.join(FIXTURES, 'program.mvt'), 'utf8');
const SNAPSHOT: CatalogSnapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'catalog.json'), 'utf8'));
const OPTIONS = { languageVersion: LANGUAGE_VERSION };

/** The offset just after the `n`th (0-based) occurrence of `marker`. */
function after(source: string, marker: string, n = 0): number {
  let at = -1;
  for (let i = 0; i <= n; i++) {
    at = source.indexOf(marker, at + 1);
    if (at === -1) throw new Error(`no ${marker}`);
  }
  return at + marker.length;
}

/** `source` with `inserted` written just after `marker`, and the offset after it. */
function typed(source: string, marker: string, inserted: string): [string, number] {
  const at = after(source, marker);
  const text = source.slice(0, at) + inserted + source.slice(at);
  return [text, at + inserted.length];
}

describe('offsets and positions', () => {
  it('count UTF-16 units, a character outside the BMP as two', () => {
    const text = 'a = "🔥"\nb = a\n';
    expect(positionOf(text, text.indexOf('"', 5) + 1)).toEqual({ line: 0, character: 8 });
    expect(positionOf(text, text.indexOf('b'))).toEqual({ line: 1, character: 0 });
    for (let offset = 0; offset <= text.length; offset++) {
      expect(offsetOf(text, positionOf(text, offset))).toBe(offset);
    }
  });

  it('clamp past a line end and past the text', () => {
    const text = 'ab\ncd';
    expect(offsetOf(text, { line: 0, character: 9 })).toBe(2);
    expect(offsetOf(text, { line: 7, character: 0 })).toBe(text.length);
    expect(positionOf(text, 99)).toEqual({ line: 1, character: 2 });
  });
});

describe('the language service over the wasm', () => {
  it('completes the scope at the cursor, replacing the word before it', () => {
    const [text, at] = typed(PROGRAM, '  greeting = Text.upper(run.`Text`)\n', '  x = gr');
    const found = completionsAt(text, at, SNAPSHOT, OPTIONS);
    const labels = found.items.map(i => i.label);
    for (const expected of ['greeting', 'run', 'hello', 'scan', 'chat', 'greet']) expect(labels).toContain(expected);
    expect(labels).not.toContain('ms');
    expect(text.slice(found.from, found.to)).toBe('gr');
    const greeting = found.items.find(i => i.label === 'greeting');
    expect(greeting).toMatchObject({ kind: 'variable', detail: 'text', from: found.from, to: found.to });
  });

  it('keeps offsets right after a character outside the BMP on the same line', () => {
    const [text, at] = typed(PROGRAM, '  greeting = Text.upper(run.`Text`)\n', '  x = ["🔥🔥", gree');
    const found = completionsAt(text, at, SNAPSHOT, OPTIONS);
    expect(text.slice(found.from, found.to)).toBe('gree');
    expect(found.items.map(i => i.label)).toContain('greeting');

    const [whole] = typed(PROGRAM, '  greeting = Text.upper(run.`Text`)\n', '  x = ["🔥🔥", greeting]\n');
    const card = hoverAt(whole, after(whole, '"🔥🔥", gre'), SNAPSHOT, OPTIONS);
    expect(card).not.toBeNull();
    expect(card?.markdown).toContain('greeting: text');
    expect(whole.slice(card?.from, card?.to)).toBe('greeting');
  });

  it('an item with its own range replaces that range', () => {
    const [text, at] = typed(PROGRAM, '  greeting = Text.upper(run.`Text`)\n', '  y = run.`Ru');
    const found = completionsAt(text, at, SNAPSHOT, OPTIONS);
    const item = found.items.find(i => i.label === 'Run by (name)');
    expect(item).toBeDefined();
    expect(text.slice(item?.from, item?.to)).toBe('Ru');
  });

  it('hovers with the native service\'s card', () => {
    const card = hoverAt(PROGRAM, after(PROGRAM, 'Text.up'), SNAPSHOT, OPTIONS);
    expect(card?.markdown).toContain('Text.upper(text)');
    expect(PROGRAM.slice(card?.from, card?.to)).toBe('upper');
    expect(hoverAt(PROGRAM, 0, SNAPSHOT, { languageVersion: '0.11.0' })).toBeNull();
  });

  it('defines a binding of this file at its name', () => {
    const found = definitionAt(PROGRAM, after(PROGRAM, 'return greet(gree'), SNAPSHOT, OPTIONS);
    expect(found).toMatchObject({ file: null });
    if (found === null || 'module' in found) throw new Error('not a place in a file');
    expect(PROGRAM.slice(found.from, found.to)).toBe('greeting');
    expect(positionOf(PROGRAM, found.from)).toEqual({ line: 5, character: 2 });
  });

  it('defines a library declaration as an offset into that file\'s text', () => {
    const library = SNAPSHOT.files?.['lib/greet']?.source ?? '';
    const found = definitionAt(PROGRAM, after(PROGRAM, 'return gre'), SNAPSHOT, OPTIONS);
    if (found === null || 'module' in found) throw new Error(`not a place in a file: ${JSON.stringify(found)}`);
    expect(found.file).toBe('lib/greet');
    expect(library.slice(found.from)).toMatch(/^export function greet/);
    expect(found.to).toBeGreaterThan(found.from);
    expect(found.to).toBeLessThanOrEqual(library.length);
    expect(definitionAt(PROGRAM, after(PROGRAM, 'from "lib/gr'), SNAPSHOT, OPTIONS)).toEqual({ file: 'lib/greet', from: 0, to: 0 });
  });

  it('defines a name from a module namespace as that module', () => {
    expect(definitionAt(PROGRAM, after(PROGRAM, 'chat = connect sla'), SNAPSHOT, OPTIONS)).toEqual({
      module: { namespace: 'adapters', name: 'slack' },
    });
    const source = `import { summarise } from plugins\n${PROGRAM}`;
    expect(definitionAt(source, after(source, 'import { summa'), SNAPSHOT, OPTIONS)).toEqual({
      module: { namespace: 'plugins', name: 'summarise' },
    });
  });

  it('offers an instance\'s connect actions after a dot', () => {
    const [text, at] = typed(PROGRAM, '  return count(ms)\n', '  x = chat.');
    const found = completionsAt(text, at, SNAPSHOT, OPTIONS);
    const connect = found.items.filter(i => i.connectAction !== undefined);
    expect(connect).toEqual([
      {
        label: '+ Connect a channel',
        kind: 'module',
        detail: 'slack',
        from: at,
        to: at,
        connectAction: { kind: 'slack-channel-picker', adapter: 'slack' },
      },
    ]);
    const [record, there] = typed(PROGRAM, '  greeting = Text.upper(run.`Text`)\n', '  y = run.');
    expect(completionsAt(record, there, SNAPSHOT, OPTIONS).items.every(i => i.connectAction === undefined)).toBe(true);
  });

  it('turns a did-you-mean into a fix whose edit replaces the misspelling', () => {
    const source = PROGRAM.replace('run.`Text`', 'run.`Txt`');
    const at = source.indexOf('Txt');
    const fixes = quickFixesIn(source, at, at, SNAPSHOT, OPTIONS);
    const fix = fixes.find(f => f.title.includes("'Text'"));
    expect(fix?.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(fix?.edits[0]?.insert).toBe('Text');
    expect(source.slice(fix?.edits[0]?.from, fix?.edits[0]?.to)).toBe('Txt');
  });

  it('answers nothing for a pin the release does not read', () => {
    const options = { languageVersion: '0.11.0' };
    expect(completionsAt(PROGRAM, 10, SNAPSHOT, options)).toEqual({ from: 10, to: 10, items: [] });
    expect(definitionAt(PROGRAM, after(PROGRAM, 'return gre'), SNAPSHOT, options)).toBeNull();
    expect(quickFixesIn(PROGRAM, 0, PROGRAM.length, SNAPSHOT, options)).toEqual([]);
  });
});
