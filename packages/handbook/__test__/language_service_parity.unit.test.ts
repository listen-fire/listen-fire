// The wasm language service answers the handbook as the native one does.
// crates/movement-language/tests/handbook_parity.rs blesses the native
// service's answers on every core chapter's checked probe (answers.json);
// this asks the engine artifact's `language_query` the same questions, at
// the same positions, and holds it to the same file — raw, and through the
// binding's offsets. It also holds the corpus (programs.json, catalog.json)
// current with the chapters, so a chapter edit cannot leave the blessed
// answers describing a handbook that no longer exists.
//
// A probe is `{at, complete: {items, word}, codeActions}` (a completion
// trigger; `items` an index into `lists`) or `{at, hover, definition}` (a
// line's first identifier); one position can be both.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  LANGUAGE_VERSION,
  compatibilityKey,
  completionsAt,
  definitionAt,
  hoverAt,
  languageVersion,
  offsetOf,
  quickFixesIn,
  type CatalogSnapshot,
  type LinePosition,
} from 'movement-lang';
import { callLanguageQuery } from 'movement-lang/wasm/loader';

import { CORE_CHAPTERS } from '../index';
import { HANDBOOK_CATALOG, checkExemption, claimsOf } from '../testing';

const CORPUS = path.join(__dirname, '../../../crates/movement-language/tests/handbook');

interface Program {
  chapter: string;
  construct: string;
  source: string;
  files?: Record<string, string>;
}

type Probe =
  | { at: LinePosition; complete: { items: number; word: unknown }; codeActions: unknown }
  | { at: LinePosition; hover: unknown; definition: unknown };

interface Answers {
  lists: unknown[][];
  programs: Array<{ construct: string; probes: Probe[] }>;
}

const read = (file: string): string => fs.readFileSync(path.join(CORPUS, file), 'utf8');
const programs: Program[] = JSON.parse(read('programs.json'));
// Keys sorted, as the native test hands the snapshot over (serde_json's
// `Value` writes its keys sorted): completion lists follow the catalog's own
// key order, so the questions must be asked of the same snapshot.
const catalog: CatalogSnapshot = JSON.parse(read('catalog.json'), (_key, value: unknown) =>
  isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : value,
);
const answers: Answers = JSON.parse(read('answers.json'));

// The docs link's versioned base, which answers.json writes `<docs>`
// (movement_language::docs_base: a prerelease links `next`).
const release = languageVersion();
const DOCS_BASE = `https://listen-fire.github.io/listen-fire/docs/${release.includes('-') ? 'next' : compatibilityKey(release)}`;
const unversioned = (value: unknown): unknown => JSON.parse(JSON.stringify(value).split(DOCS_BASE).join('<docs>'));

function snapshotOf(program: Program): CatalogSnapshot {
  if (program.files === undefined) return catalog;
  return { ...catalog, files: Object.fromEntries(Object.entries(program.files).map(([file, source]) => [file, { source }])) };
}

function ask(program: Program, snapshot: string, query: object): unknown {
  const reply = callLanguageQuery(program.source, snapshot, JSON.stringify(query));
  if (!reply.ok) throw new Error(`${program.construct}: ${JSON.stringify(reply.json)}`);
  return reply.json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A blessed `{start, end}`'s offsets into `text`. */
function offsets(text: string, range: unknown): { from: number; to: number } {
  if (!isRecord(range) || !isRecord(range.start) || !isRecord(range.end)) throw new Error(`not a range: ${JSON.stringify(range)}`);
  const position = (p: Record<string, unknown>): LinePosition => ({ line: Number(p.line), character: Number(p.character) });
  return { from: offsetOf(text, position(range.start)), to: offsetOf(text, position(range.end)) };
}

describe('the corpus is current with the chapters', () => {
  it('programs.json is every core chapter\'s checked probe', () => {
    const current = claimsOf(Object.values(CORE_CHAPTERS))
      .filter(claim => checkExemption(claim) === undefined)
      .map(claim => ({
        chapter: claim.chapter,
        construct: claim.construct,
        source: claim.probe,
        ...(claim.status === 'runs' && claim.files ? { files: claim.files } : {}),
      }));
    expect(read('programs.json')).toBe(`${JSON.stringify(current, null, 2)}\n`);
  });

  it('catalog.json is the handbook\'s catalog', () => {
    expect(read('catalog.json')).toBe(`${JSON.stringify(HANDBOOK_CATALOG, null, 2)}\n`);
  });

  it('answers.json answers every program', () => {
    expect(answers.programs.map(p => p.construct)).toEqual(programs.map(p => p.construct));
  });
});

describe('the wasm language service answers the handbook as the native one blessed', () => {
  const options = { languageVersion: LANGUAGE_VERSION };

  it.each(programs.map((program, index) => ({ program, blessed: answers.programs[index], construct: program.construct })))(
    '$construct',
    ({ program, blessed }) => {
      if (blessed === undefined) throw new Error('no blessed answers');
      const snapshot = snapshotOf(program);
      const snapshotJson = JSON.stringify(snapshot);
      const { source } = program;
      for (const probe of blessed.probes) {
        const where = `${program.construct} at ${probe.at.line}:${probe.at.character}`;
        const offset = offsetOf(source, probe.at);
        if ('complete' in probe) {
          const items = answers.lists[probe.complete.items];
          const raw = ask(program, snapshotJson, { kind: 'complete', position: probe.at });
          expect({ where, complete: unversioned(raw) }).toEqual({ where, complete: { items, word: probe.complete.word } });
          const actions = ask(program, snapshotJson, { kind: 'codeActions', position: probe.at, range: { start: probe.at, end: probe.at } });
          expect({ where, codeActions: actions }).toEqual({ where, codeActions: probe.codeActions });

          const bound = completionsAt(source, offset, snapshot, options);
          const word = offsets(source, probe.complete.word);
          expect({ where, from: bound.from, to: bound.to }).toEqual({ where, ...word });
          const expected = (items ?? []).map(item => {
            if (!isRecord(item)) throw new Error(`not an item: ${JSON.stringify(item)}`);
            return { label: item.label, ...(item.replace !== undefined ? offsets(source, item.replace) : word) };
          });
          const got = bound.items.map(item => ({ label: item.label, from: item.from, to: item.to }));
          expect({ where, items: unversioned(got) }).toEqual({ where, items: expected });
          expect({ where, fixes: quickFixesIn(source, offset, offset, snapshot, options).map(f => f.title) }).toEqual({
            where,
            fixes: Array.isArray(probe.codeActions) ? probe.codeActions.map(a => (isRecord(a) ? a.title : undefined)) : [],
          });
        }
        if ('hover' in probe) {
          const hover = ask(program, snapshotJson, { kind: 'hover', position: probe.at });
          expect({ where, hover: unversioned(hover) }).toEqual({ where, hover: probe.hover });
          const definition = ask(program, snapshotJson, { kind: 'definition', position: probe.at });
          expect({ where, definition }).toEqual({ where, definition: probe.definition });

          const card = hoverAt(source, offset, snapshot, options);
          const blessedCard = isRecord(probe.hover) ? { markdown: probe.hover.contents, ...offsets(source, probe.hover.range) } : null;
          expect({ where, card: card === null ? null : unversioned(card) }).toEqual({ where, card: blessedCard });
          const found = definitionAt(source, offset, snapshot, options);
          const blessedPlace = isRecord(probe.definition)
            ? isRecord(probe.definition.module)
              ? { module: probe.definition.module }
              : {
                  file: probe.definition.file,
                  ...offsets(typeof probe.definition.file === 'string' ? snapshot.files?.[probe.definition.file]?.source ?? '' : source, probe.definition.range),
                }
            : null;
          expect({ where, definition: found }).toEqual({ where, definition: blessedPlace });
        }
      }
    },
  );
});
