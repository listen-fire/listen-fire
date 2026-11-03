// The micro examples: every snippet checked as the whole program it stands for,
// the corpus held to its own shape and to the handbook's prose contract, and
// the lookup held to the quality table of realistic queries (the listen-fire
// command's ranking is held to the same table, in crates/lf/src/examples.rs).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import table from './example_queries.json';
import {
  MAX_EXAMPLES,
  microExampleProgram,
  microExamples,
  parseMicroExamples,
  renderExampleLookup,
  renderMicroExample,
  searchExamples,
} from '../micro_examples';
import { proseViolations } from '../prose_rules';
import { admitProbe } from '../testing';

const examples = microExamples();

/** The examples checked against a module's fake by `listen-fire check`
 *  (apps/cli/src/__test__/micro_examples.test.ts), not by the catalog here.
 *  Pinned, so a new one cannot slip past both checks. */
const CHECKED_AGAINST_A_FAKE = ['connect-with-a-setting', 'create-or-update', 'set-only-when-empty', 'read-a-table'];

describe('the corpus', () => {
  it('is a few dozen examples, each with a distinct id', () => {
    expect(examples.length).toBeGreaterThanOrEqual(30);
    expect(examples.length).toBeLessThanOrEqual(55);
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
    for (const e of examples) expect(e.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it.each(examples.map((e) => [e.id, e] as const))('%s is an intent, search words, a snippet of at most eight lines and at most one sentence', (_id, e) => {
    expect(e.intent).toMatch(/^[A-Z]/);
    expect(e.intent).not.toMatch(/\.$/);
    expect(e.search.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    const lines = e.code.split('\n');
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.every((line) => line.trim() !== '' || e.kind !== 'body')).toBe(true);
    if (e.note !== undefined) {
      expect(e.note).not.toMatch(/```/);
      const prose = e.note.replace(/`[^`]*`/g, 'code');
      expect(prose.match(/[.!?](\s|$)/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('pins the examples a fake checks', () => {
    expect(examples.filter((e) => e.fake).map((e) => e.id)).toEqual(CHECKED_AGAINST_A_FAKE);
  });

  // The examples are what an author copies, so they keep to the prose
  // contract the chapters do: recommended forms only, no tool names.
  it('holds the prose contract', () => {
    const content = examples.map((e) => `${e.intent}\n\`\`\`\n${e.code}\n\`\`\`\n${e.note ?? ''}`).join('\n\n');
    expect(proseViolations({ id: 'reference', title: 'Micro examples', content })).toEqual([]);
  });

  it('stays generic: no payments, no CRM, no one vendor of them', () => {
    const shown = examples.map((e) => `${e.intent} ${e.search} ${e.code} ${e.note ?? ''}`).join('\n');
    expect(shown).not.toMatch(/\b(stripe|attio|mcp|payments?|crm|invoices?|deals?)\b/i);
  });

  it('refuses a section it cannot read', () => {
    expect(() => parseMicroExamples('### x\n\nAn intent\n')).toThrow(/no fenced snippet/);
    expect(() => parseMicroExamples('### x\n\nAn intent\n```prose\nx\n```\n')).toThrow(/not one of body, program, file/);
  });
});

describe('every snippet is checked', () => {
  // The check a run passes before it executes, against the catalog the
  // handbook's examples are held to: 0 errors.
  it.each(examples.filter((e) => !e.fake).map((e) => [e.id, e] as const))('%s is admitted', (_id, e) => {
    expect(() => admitProbe({ construct: `micro example ${e.id}`, status: 'runs', probe: microExampleProgram(e) })).not.toThrow();
  });
});

describe('the lookup', () => {
  it.each(table.queries.map((row) => [row.query, row.top] as const))('"%s" answers %s first', (query, top) => {
    expect(searchExamples(query)[0]?.id).toBe(top);
  });

  it('names only examples that exist', () => {
    const ids = new Set(examples.map((e) => e.id));
    for (const row of table.queries) expect(ids.has(row.top)).toBe(true);
  });

  it('answers at most a few, and none for words it does not know', () => {
    for (const row of table.queries) expect(searchExamples(row.query).length).toBeLessThanOrEqual(MAX_EXAMPLES);
    expect(searchExamples('zzzz qqqq')).toEqual([]);
    expect(renderExampleLookup('zzzz', [])).toMatch(/^No example matches "zzzz"/);
  });

  it('shows the intent and the note as comments around the code, and nothing else', () => {
    const [found] = searchExamples('if then else expression');
    expect(renderMicroExample(found)).toBe(
      '# A value chosen by a condition\nlabel = Text.includes(m.Subject, "urgent") ? "urgent" : "normal"\n# `if` is a statement only; inside an expression write `c ? a : b`.',
    );
  });

  it('reads the examples the listen-fire command carries', () => {
    const file = readFileSync(join(__dirname, '../../../crates/lf/data/examples.md'), 'utf8');
    expect(parseMicroExamples(file)).toEqual(examples);
  });
});
