// The one-grammar differential: every expression text the corpora produce,
// through today's path (the bridge) and the new one (parse → lower), compared.
// Shared by the differential test and anything that wants the report.

import type { Expression } from '@listen-fire/shared/expression/types';
import {
  parseMovementCondition,
  parseMovementExpression,
  type MovementCondition,
} from '../../../expression/bridge';
import { lowerMovementCondition, lowerMovementExpression, LoweringError } from '../lower';
import { ExpressionSyntaxError, parseExpression } from '../parse_expression';

// This package carries no Node typings; jest's module scope has `require`,
// which reads the JSON fixture natively.
declare function require(id: string): unknown;

export interface SlotRecord {
  raw: string;
  /** How the text reached the current code: an ExprSlot of a parsed program
   *  (`slot`), or a call into the bridge's expression or condition entry. */
  entries: string[];
  versions: number[];
  corpora: string[];
  where?: string[];
}

export type Mode = 'expression' | 'condition';

type Result =
  | { ok: true; value: Expression | MovementCondition }
  | { ok: false; stage: 'syntax' | 'lowering' | 'bridge'; message: string; code?: string };

export type Outcome =
  | 'identical'
  | 'differing'
  | 'both-reject'
  | 'new-unparseable'
  | 'new-refuses'
  | 'bridge-refuses';

export interface Case {
  raw: string;
  mode: Mode;
  record: SlotRecord;
  outcome: Outcome;
  bridge: Result;
  next: Result;
}

/** Regenerate with ../harvest (see jest.harvest.cjs and build_fixture.cjs). */
export const SLOTS = require('./__fixtures__/expression_slots.json') as SlotRecord[];

/** The modes a text was consumed under. A text only ever seen as an ExprSlot
 *  (never handed to the bridge by the corpus) is compared as an expression. */
export function modesOf(record: SlotRecord): Mode[] {
  const modes: Mode[] = [];
  if (record.entries.includes('expression')) modes.push('expression');
  if (record.entries.includes('condition')) modes.push('condition');
  if (modes.length === 0) modes.push('expression');
  return modes;
}

function run(fn: () => Expression | MovementCondition, stage: 'bridge' | 'new'): Result {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    const code = (e as { code?: unknown }).code;
    return {
      ok: false,
      stage: stage === 'bridge' ? 'bridge' : e instanceof ExpressionSyntaxError ? 'syntax' : 'lowering',
      message: e.message,
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
}

/** Key order and `undefined` members are not part of a value. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

export function compare(record: SlotRecord, mode: Mode): Case {
  const { raw } = record;
  const bridge = run(() => (mode === 'expression' ? parseMovementExpression(raw) : parseMovementCondition(raw)), 'bridge');
  const next = run(() => (mode === 'expression' ? lowerMovementExpression(raw) : lowerMovementCondition(raw)), 'new');
  let outcome: Outcome;
  if (bridge.ok && next.ok) outcome = canonical(bridge.value) === canonical(next.value) ? 'identical' : 'differing';
  else if (!bridge.ok && !next.ok) outcome = 'both-reject';
  else if (bridge.ok) outcome = next.ok === false && next.stage === 'syntax' ? 'new-unparseable' : 'new-refuses';
  else outcome = 'bridge-refuses';
  return { raw, mode, record, outcome, bridge, next };
}

/** Texts that reached the bridge, or were an expression slot. */
const BRIDGE_ENTRIES = ['expression', 'condition', 'slot'];

export function compareAll(): Case[] {
  return SLOTS.filter(record => record.entries.some(e => BRIDGE_ENTRIES.includes(e))).flatMap(record =>
    modesOf(record).map(mode => compare(record, mode)),
  );
}

/** The constructs the statement layer reads today and the new grammar reads
 *  as expressions, with the tree kind each must parse to. */
export const CONSTRUCTS = { closure: 'closure', node: 'node', graph: 'graph', declaration: 'declaration' } as const;

export interface ConstructCase {
  raw: string;
  construct: keyof typeof CONSTRUCTS;
  /** The tree kind it parsed to, or the syntax error. */
  result: { ok: true; kind: string } | { ok: false; message: string };
}

export function parseConstructs(): ConstructCase[] {
  return SLOTS.flatMap(record =>
    record.entries
      .filter((e): e is keyof typeof CONSTRUCTS => e in CONSTRUCTS)
      // A callback's subject is stored as a closure, but written as a bare
      // block or parameter list — not the `(x) => …` form.
      .filter(construct => construct !== 'closure' || (record.raw.startsWith('(') && record.raw.includes('=>')))
      .map((construct): ConstructCase => {
        // `export` marks the declaration, at statement level; it is not part of it.
        const raw = construct === 'declaration' ? record.raw.replace(/^export\s+/, '') : record.raw;
        try {
          return { raw, construct, result: { ok: true, kind: parseExpression(raw).kind } };
        } catch (e) {
          if (!(e instanceof ExpressionSyntaxError)) throw e;
          return { raw, construct, result: { ok: false, message: e.message } };
        }
      }),
  );
}

/**
 * Hand-written texts for what the corpora never write — the hard cases the
 * plan names, and the bridge's text rewrites in positions no fixture reaches.
 * `expect` is the outcome observed and accepted; `why` says what a
 * disagreement means.
 */
export const SYNTHETIC: Array<{ raw: string; mode: Mode; expect: Outcome; why?: string }> = [
  // Names with spaces: an unquoted hop label runs to the bracket's next clause.
  { raw: 'x-[:Funding Round]->.`Amount`', mode: 'expression', expect: 'identical' },
  { raw: 'x-[r:Funding Round WHERE r.`Stage` == "A"]->.`Amount`', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:Funding Round ORDER BY `At` DESC LIMIT 2]->.`Amount`', mode: 'expression', expect: 'identical' },
  { raw: '`My Root`-[:co]->.`url`', mode: 'expression', expect: 'identical' },
  { raw: '`My Root`-[:co]->', mode: 'expression', expect: 'identical' },
  // Hops in every direction and form.
  { raw: '<-[:reports_to]-.name', mode: 'expression', expect: 'identical' },
  { raw: 'x<-[:reports_to]-.name', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:a]-.name', mode: 'expression', expect: 'identical' },
  { raw: '-[:a]->-[b:c]->.d', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:a]->.b-[:c]->.d', mode: 'expression', expect: 'identical' },
  { raw: 'x-[e:Entries ORDER BY e-[:Signal]->.`Discovered At` DESC]->.n', mode: 'expression', expect: 'identical' },
  { raw: 'msg-[t:#transform { plugin: "x", url: msg.u }]->.out', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:_resources:TEXT WHERE name == "a"]->.content', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:_resources]->.`Other`', mode: 'expression', expect: 'identical' },
  { raw: '-[#linked WHERE type = "ATTIO"]->.external_id', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:a WHERE b IN ["p", "q"] AND NOT c]->.d', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:a WHERE FIRST(y-[:b]->).url == "u"]->.d', mode: 'expression', expect: 'identical' },
  // Bracket filters: `{}` after a label is CONFIG on a meta hop, and dropped on a plain one.
  { raw: 'x-[:a { k: 1 }]->.b', mode: 'expression', expect: 'identical' },
  // `{}` as a value is a map.
  { raw: '{ "content-type": 1, `a b`: 2, c: [1, ...xs,] }', mode: 'expression', expect: 'identical' },
  // Interpolation.
  { raw: '"a ${x.`b`} c"', mode: 'expression', expect: 'identical' },
  { raw: '"a \\${x}"', mode: 'expression', expect: 'identical' },
  { raw: "'single ${x}'", mode: 'expression', expect: 'identical' },
  { raw: 'AI("p ${x}", "quick")', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:a WHERE n == "${y}"]->.d', mode: 'expression', expect: 'identical' },
  { raw: '"${-[:a]->}"', mode: 'expression', expect: 'identical' },
  // EXISTS, both spellings.
  { raw: 'x EXISTS', mode: 'expression', expect: 'identical' },
  { raw: 'NOT EXISTS(x)', mode: 'expression', expect: 'identical' },
  { raw: 'exists(x-[:a]->)', mode: 'expression', expect: 'identical' },
  { raw: 'EXISTS(<-[:a]-)', mode: 'expression', expect: 'identical' },
  { raw: 'x-[:a WHERE EXISTS(b)]->.c', mode: 'expression', expect: 'identical' },
  { raw: 'EXISTS(-[:a]-> WHERE b-[:c]->)', mode: 'expression', expect: 'identical' },
  // Aggregates over bare walks, and the case the rewrite never sees.
  { raw: 'FIRST(-[:a]->).`url`', mode: 'expression', expect: 'identical' },
  { raw: 'x.COUNT(-[:a]->)', mode: 'expression', expect: 'identical' },
  { raw: 'count(x-[:a]->)', mode: 'expression', expect: 'both-reject',
    why: 'the bare-walk rule is keyed on an upper-case aggregate name, so the lower-case spelling refuses on both paths' },
  { raw: 'CONCAT(x-[:a]->)', mode: 'expression', expect: 'both-reject',
    why: 'a bare walk is its landings only as the whole slot or an aggregate argument' },
  // Names resolve as the formula grammar resolves them.
  { raw: 'count(x.y) + `COUNT`(z)', mode: 'expression', expect: 'identical' },
  { raw: 'a.b.c', mode: 'expression', expect: 'identical' },
  { raw: 'edge.weight + x.edge.w', mode: 'expression', expect: 'identical' },
  { raw: 'a.f(1)', mode: 'expression', expect: 'identical' },
  { raw: 'SORT(xs, `DESC`)', mode: 'expression', expect: 'identical' },
  { raw: 'SORT(xs, k, desc)', mode: 'expression', expect: 'identical' },
  { raw: 'JOIN(xs, ", ") + COUNT(a, b)', mode: 'expression', expect: 'identical' },
  { raw: 'KG_EXISTS("q", a) AND KG_VALUE(1)', mode: 'expression', expect: 'identical' },
  { raw: '@parent.created + @resource.url + @id', mode: 'expression', expect: 'identical' },
  // Operators.
  { raw: 'a OR b AND c', mode: 'expression', expect: 'identical' },
  { raw: '(a AND b) AND c OR d', mode: 'expression', expect: 'identical' },
  { raw: '!a = b', mode: 'expression', expect: 'identical' },
  { raw: '(-5) + [-5] + -x - -5 * 2 % 3', mode: 'expression', expect: 'identical' },
  { raw: 'x = -5', mode: 'expression', expect: 'identical' },
  { raw: 'IF a THEN 1 ELSE IF b THEN 2 ELSE 3 END', mode: 'expression', expect: 'identical' },
  { raw: 'IF a THEN 1 ELSE IF b THEN 2 ELSE 3 END END', mode: 'expression', expect: 'identical' },
  { raw: 'IF a THEN 1 END', mode: 'expression', expect: 'identical' },
  { raw: 'x WITHIN 30D AND y WITHIN "2w"', mode: 'expression', expect: 'identical' },
  { raw: 'a CONTAINS "b" OR c IN [1, 2]', mode: 'expression', expect: 'identical' },
  { raw: 'true and NULL or False', mode: 'expression', expect: 'identical' },
  // Conditions.
  { raw: 'rec IS <crm-[:company]->> AND x == 1', mode: 'condition', expect: 'identical' },
  { raw: 'rec IS <at-[:`Record Change` WHERE `action` == "x"]->>', mode: 'condition', expect: 'identical' },
  { raw: 'rec IS <at-[:Record Change]->>', mode: 'condition', expect: 'identical' },
  { raw: '(a AND b) AND c', mode: 'condition', expect: 'identical' },
  { raw: 'x-[:a]-> AND y', mode: 'condition', expect: 'identical' },

  // ── Where the paths disagree ──
  { raw: 'a OR b AND c', mode: 'condition', expect: 'differing',
    why: 'the bridge splits a condition on every top-level AND before parsing, so `a OR b AND c` runs as (a OR b) AND c — the same text as an expression means a OR (b AND c)' },
  { raw: 'IF a AND b THEN 1 ELSE 0 END == 1', mode: 'condition', expect: 'bridge-refuses',
    why: 'the same split cuts an IF … END in half' },
  { raw: 'EXISTS(-[:a WHERE n == "${x}"]->)', mode: 'expression', expect: 'differing',
    why: 'the bridge parses the walk inside EXISTS from text it already rewrote, so the interpolation stays an unsubstituted placeholder property' },
  { raw: 'EXISTS(-[y:a WHERE EXISTS(y-[:r]->)]->)', mode: 'expression', expect: 'differing',
    why: 'likewise an EXISTS nested in an EXISTS walk survives as a placeholder property' },
  { raw: 'crm-[c:companies WHERE ]->.x', mode: 'expression', expect: 'new-unparseable',
    why: 'the formula grammar reads an empty WHERE as no filter at all' },
  { raw: 'COUNT(x) -1', mode: 'expression', expect: 'bridge-refuses',
    why: "the formula tokenizer reads '-1' after ')' as a negative number literal, so a subtraction with no space is a syntax error" },
  { raw: '-[ :a]->.b', mode: 'expression', expect: 'bridge-refuses',
    why: "the formula tokenizer needs ':' straight after '-['" },
];

export function compareSynthetic(): Array<Case & { expect: Outcome; why?: string }> {
  return SYNTHETIC.map(s => ({
    ...compare({ raw: s.raw, entries: [s.mode], versions: [], corpora: ['synthetic'] }, s.mode),
    expect: s.expect,
    ...(s.why ? { why: s.why } : {}),
  }));
}

export { LoweringError };
