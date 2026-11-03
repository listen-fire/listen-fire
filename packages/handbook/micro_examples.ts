// The micro examples: a few lines of listen-fire doing one thing each, found by
// asking in your own words. The front page shows the language's shape; this
// lookup answers "how do I write X" with the X, and nothing around it.
//
// The examples travel with the `listen-fire` command, which searches them too
// (`listen-fire example <words>`), so they live where the published crate can
// carry them: crates/lf/data/examples.md. In the repo they are read there; a
// build of this package carries a copy beside its own output
// (scripts/build-packages.cjs). The command ranks them by the same rule as
// this file, and a test drives it to prove the two answer alike.
//
// Every snippet is checked: `microExampleProgram` wraps it into the whole
// program the tests hand to the Rust checker. A snippet that names a system the
// handbook's catalog does not carry (fence word `fake`) is checked instead by
// `listen-fire check` against that module's fake (apps/cli).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scoreFields, searchTokens } from './language_search';

const IN_THE_REPO = join(__dirname, '../../crates/lf/data/examples.md');
const EXAMPLES_FILE = existsSync(IN_THE_REPO) ? IN_THE_REPO : join(__dirname, 'examples.md');

/** How a snippet becomes a whole program (see the file's own header). */
export const MICRO_EXAMPLE_KINDS = ['body', 'program', 'file'] as const;
export type MicroExampleKind = (typeof MICRO_EXAMPLE_KINDS)[number];

export interface MicroExample {
  id: string;
  /** What it does, in plain words. */
  intent: string;
  /** The words an author might ask with, beyond the intent's. */
  search: string;
  kind: MicroExampleKind;
  /** Checked by `listen-fire check` against a module's fake, not the handbook's catalog. */
  fake: boolean;
  code: string;
  /** At most one sentence, where the code cannot speak. */
  note?: string;
}

function isKind(word: string): word is MicroExampleKind {
  return (MICRO_EXAMPLE_KINDS as readonly string[]).includes(word);
}

/** The examples in `text`, in the order written. Throws on a section it cannot read. */
export function parseMicroExamples(text: string): MicroExample[] {
  const sections = text.split(/^### /m).slice(1);
  return sections.map((section) => {
    const [heading, ...lines] = section.split('\n');
    const id = heading.trim();
    const fenceAt = lines.findIndex((line) => line.startsWith('```'));
    const fenceEnd = lines.findIndex((line, i) => i > fenceAt && line.startsWith('```'));
    if (fenceAt < 0 || fenceEnd < 0) throw new Error(`micro example ${id}: no fenced snippet`);
    const [kind, ...flags] = lines[fenceAt].slice(3).trim().split(/\s+/);
    if (!isKind(kind)) throw new Error(`micro example ${id}: the fence says "${kind}", not one of ${MICRO_EXAMPLE_KINDS.join(', ')}`);
    const before = lines.slice(0, fenceAt).map((line) => line.trim()).filter(Boolean);
    const searchLine = before.find((line) => line.startsWith('search:'));
    const intent = before.find((line) => !line.startsWith('search:'));
    if (intent === undefined) throw new Error(`micro example ${id}: no intent line`);
    const note = lines.slice(fenceEnd + 1).map((line) => line.trim()).filter(Boolean).join(' ');
    return {
      id,
      intent,
      search: searchLine === undefined ? '' : searchLine.slice('search:'.length).trim(),
      kind,
      fake: flags.includes('fake'),
      code: lines.slice(fenceAt + 1, fenceEnd).join('\n'),
      ...(note !== '' ? { note } : {}),
    };
  });
}

let loaded: readonly MicroExample[] | undefined;

/** Every micro example, as the command and the authoring tools search them. */
export function microExamples(): readonly MicroExample[] {
  loaded ??= parseMicroExamples(readFileSync(EXAMPLES_FILE, 'utf8'));
  return loaded;
}

const PRELUDE = `gh   = connect \`@lf/github\` using my_github
mail = connect \`@lf/gmail\` using team_mail
chat = connect \`@lf/slack\` using team_chat
`;

/** The whole program a snippet stands for, as its check sees it. */
export function microExampleProgram(example: Pick<MicroExample, 'kind' | 'code'>): string {
  switch (example.kind) {
    case 'file':
      return `${example.code}\n`;
    case 'program':
      return `${PRELUDE}\n${example.code}\n`;
    case 'body': {
      const body = example.code
        .split('\n')
        .map((line) => (line === '' ? line : `  ${line}`))
        .join('\n');
      return `${PRELUDE}\nfunction \`Example\`(m: <mail-[:Message]->>) {\n${body}\n}\n`;
    }
    default: {
      const never: never = example.kind;
      throw new Error(`no such kind ${String(never)}`);
    }
  }
}

/** The most examples one lookup hands back. */
export const MAX_EXAMPLES = 3;

/**
 * The best few examples for `query`: the intent's and the search line's words
 * count three, the snippet's and the note's one, as the language search
 * weighs a purpose against a body. Only answers scoring at least half the best
 * one's are kept, so a lookup with one clear answer gives one.
 */
export function searchExamples(query: string, examples: readonly MicroExample[] = microExamples()): MicroExample[] {
  const scored = examples
    .map((example, order) => ({
      example,
      order,
      score: scoreFields(query, [
        { tokens: new Set(searchTokens(`${example.intent} ${example.search}`)), weight: 3 },
        { tokens: new Set(searchTokens(`${example.code} ${example.note ?? ''}`)), weight: 1 },
      ]),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((s) => s.score * 2 >= best)
    .slice(0, MAX_EXAMPLES)
    .map((s) => s.example);
}

/** One example as a lookup shows it: the intent and the note as comments around the code. */
export function renderMicroExample(example: MicroExample): string {
  return [`# ${example.intent}`, example.code, ...(example.note !== undefined ? [`# ${example.note}`] : [])].join('\n');
}

/** What a lookup prints: the examples one after another, or what to try when none matched. */
export function renderExampleLookup(query: string, found: readonly MicroExample[]): string {
  if (found.length === 0) {
    return `No example matches "${query}". Ask in other words ("create or update", "run every Monday", "value that may be missing"), or with none to list every example.`;
  }
  return found.map(renderMicroExample).join('\n\n');
}

/** Every example's intent, one a line: what a lookup with no words lists. */
export function renderExampleIndex(examples: readonly MicroExample[] = microExamples()): string {
  return examples.map((example) => `  ${example.intent}`).join('\n');
}
