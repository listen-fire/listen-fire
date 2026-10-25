// The story analysis through its binding, over the checker's own story
// fixtures (crates/movement-checker/tests/fixtures/story/, which
// tests/story_analysis.rs reads): every name a record holds resolves through
// the scope table to the declaration the checker resolves there (asked of
// the language service's go-to-definition, the checker's own resolution
// over the same artifact); a source that does not parse is refused; a pin
// the release does not read is its version diagnostic alone; and an
// analysis version the binding does not read is refused by name.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as loader from '../../wasm/loader';
import { LANGUAGE_VERSION, languageVersionDiagnostic } from '../../language_version';
import type { Span } from '../../parser/ast';
import type { CatalogSnapshot } from '../../service/snapshot';
import { definitionAt, offsetOf } from '../../service/language_service';
import { RustCheckRefused, checkSourceInRust } from '../rust_checker';
import {
  STORY_ANALYSIS_VERSION,
  SUPPORTED_STORY_ANALYSIS_VERSIONS,
  resolveInAnalysis,
  storyAnalysisInRust,
  type StoryAnalysis,
  type StoryNode,
} from '../story_analysis';

const FIXTURES = path.join(__dirname, '../../../../crates/movement-checker/tests/fixtures/story');
const SNAPSHOT: CatalogSnapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'catalog.json'), 'utf8'));
const PROGRAMS = fs
  .readdirSync(FIXTURES)
  .filter(file => file.endsWith('.mvt'))
  .sort()
  .map(file => ({ name: file, source: fs.readFileSync(path.join(FIXTURES, file), 'utf8') }));
const OPTIONS = { languageVersion: LANGUAGE_VERSION };

/** The names a node holds, as the Rust test reads them. */
function namesOf(node: StoryNode): string[] {
  switch (node.kind) {
    case 'instance':
      return [node.name];
    case 'listen':
      return [node.instance, node.fires];
    case 'link':
      return node.to.kind === 'handle' ? [node.from, node.to.name] : [node.from];
    case 'unlink':
      return [node.from, node.to.name];
    case 'delete':
    case 'refresh':
      return [node.subject];
    case 'call':
      return [node.callee];
    case 'traversal':
    case 'valuePath':
      return node.root === undefined ? [] : [node.root];
    case 'await':
      return node.source.kind === 'traversal' && node.source.root !== undefined ? [node.source.root] : [];
    case 'combinator':
    case 'branch':
    case 'extract':
    case 'callReading':
      return [];
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

function offsetAt(source: string, at: Span['start']): number {
  return offsetOf(source, { line: at.line - 1, character: at.col - 1 });
}

/** Where `name` is first written as a whole word at or after `from`. */
function written(source: string, name: string, from: number): number | undefined {
  const word = /[\p{L}\p{N}_]/u;
  for (let at = source.indexOf(name, from); at !== -1; at = source.indexOf(name, at + 1)) {
    const before = source[at - 1];
    const after = source[at + name.length];
    if ((before === undefined || !word.test(before)) && (after === undefined || !word.test(after))) return at;
  }
  return undefined;
}

describe('the story analysis over the wasm', () => {
  it.each(PROGRAMS)('$name: its diagnostics are the check\'s, under this binding\'s version', ({ source }) => {
    const analysis = storyAnalysisInRust(source, SNAPSHOT, OPTIONS);
    expect(analysis.storyAnalysisVersion).toBe(STORY_ANALYSIS_VERSION);
    expect(SUPPORTED_STORY_ANALYSIS_VERSIONS).toContain(STORY_ANALYSIS_VERSION);
    expect(analysis.diagnostics).toEqual(checkSourceInRust(source, SNAPSHOT, OPTIONS));
    expect(analysis.scopes[0]?.parent).toBeUndefined();
    expect(analysis.nodes.length).toBeGreaterThan(0);
  });

  it('every name a record holds resolves through the scope table to the declaration the checker resolves', () => {
    let compared = 0;
    for (const { name, source } of PROGRAMS) {
      const analysis: StoryAnalysis = storyAnalysisInRust(source, SNAPSHOT, OPTIONS);
      const held: Array<{ scope: number; span: Span; name: string }> = [
        ...analysis.nodes.flatMap(node => namesOf(node).map(held => ({ scope: node.scope, span: node.span, name: held }))),
        ...analysis.writes.flatMap(write => (write.binding === undefined ? [] : [{ scope: write.scope, span: write.span, name: write.binding }])),
      ];
      for (const each of held) {
        const ours = resolveInAnalysis(analysis, each.scope, each.name);
        const at = written(source, each.name, offsetAt(source, each.span.start));
        if (at === undefined) continue;
        const theirs = definitionAt(source, at, SNAPSHOT, OPTIONS);
        if (theirs === null) continue;
        const where = `${name}: '${each.name}' at ${each.span.start.line}:${each.span.start.col}`;
        expect({ where, resolved: ours !== undefined }).toEqual({ where, resolved: true });
        if (ours === undefined) continue;
        if ('module' in theirs) {
          expect({ where, kind: ours.kind }).toEqual({ where, kind: theirs.module.namespace.replace(/s$/, '') });
        } else {
          expect({ where, file: theirs.file }).toEqual({ where, file: null });
          expect({ where, name: ours.name }).toEqual({ where, name: each.name });
          expect({ where, declared: source.slice(theirs.from, theirs.to) }).toEqual({ where, declared: each.name });
          const declaration = { from: offsetAt(source, ours.span.start), to: offsetAt(source, ours.span.end) };
          expect({ where, inside: declaration.from <= theirs.from && theirs.to <= declaration.to }).toEqual({ where, inside: true });
        }
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(80);
  });

  it('an extraction field carries its resolved type as data, through the rebuilt wasm', () => {
    const extract = PROGRAMS.find(program => program.name === 'extract.mvt');
    const analysis = storyAnalysisInRust(extract?.source ?? '', SNAPSHOT, OPTIONS);
    const nodes = analysis.nodes.flatMap(node => (node.kind === 'extract' ? [node] : []));
    const fields = nodes.flatMap(node => node.node?.fields ?? []);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.find(field => field.type === 'number')?.fieldType).toBe('number');
  });

  it('a source that does not parse is refused', () => {
    expect(() => storyAnalysisInRust('function (', SNAPSHOT, OPTIONS)).toThrow(RustCheckRefused);
    expect(() => storyAnalysisInRust('function (', SNAPSHOT, OPTIONS)).toThrow(/line 1/);
  });

  it('a pin the release does not read is its version diagnostic alone, the artifact not asked', () => {
    const asked = jest.spyOn(loader, 'callStoryAnalysis');
    try {
      const analysis = storyAnalysisInRust(PROGRAMS[0]?.source ?? '', SNAPSHOT, { languageVersion: '0.11.0' });
      expect(analysis).toEqual({
        storyAnalysisVersion: STORY_ANALYSIS_VERSION,
        diagnostics: [languageVersionDiagnostic('0.11.0')],
        scopes: [],
        symbols: [],
        writes: [],
        nodes: [],
        bodies: [],
        shapes: [],
      });
      expect(asked).not.toHaveBeenCalled();
    } finally {
      asked.mockRestore();
    }
  });

  it('an analysis version the binding does not read is refused by name', () => {
    const asked = jest.spyOn(loader, 'callStoryAnalysis').mockReturnValue({
      ok: true,
      json: { storyAnalysisVersion: 2, diagnostics: [], scopes: [], symbols: [], writes: [], nodes: [], bodies: [], shapes: [] },
    });
    try {
      expect(() => storyAnalysisInRust('x = 1\n', SNAPSHOT, OPTIONS)).toThrow(RustCheckRefused);
      expect(() => storyAnalysisInRust('x = 1\n', SNAPSHOT, OPTIONS)).toThrow(/version 2, which this binding does not read/);
    } finally {
      asked.mockRestore();
    }
  });
});
