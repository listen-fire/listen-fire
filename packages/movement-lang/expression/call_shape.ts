// The static shape of a built-in call — FILE's artifact type, READ's one
// argument, an options map's keys. Checked where a call is lowered
// (parser/expression/lower.ts), so every consumer — checker, interpretability
// scan, engine — shares the refusal.

import type { Expression } from '@listen-fire/shared/expression/types';
import { BridgeError } from './error';
import {
  FILE_FUNCTION_ID,
  FILE_ARTIFACT_TYPES,
  FILE_SIGNATURE,
  READ_FUNCTION_ID,
  READ_SIGNATURE,
  builtinOptionsFor,
  describeBuiltinOptions,
  type BuiltinOptionSpec,
  type BuiltinOptionsSpec,
} from './stdlib';

export function validateBuiltinCallShape(expr: Extract<Expression, { type: 'function' }>): void {
  validateFileCall(expr);
  validateReadCall(expr);
  validateOptionsCall(expr);
}

/** FILE(content, "pdf" | "text") — the artifact type is static call
 *  shape; reject anything else here so every consumer agrees. */
function validateFileCall(expr: Extract<Expression, { type: 'function' }>): void {
  if (expr.fn !== FILE_FUNCTION_ID) return;
  if (expr.args.length !== 2) {
    throw new BridgeError(
      `${FILE_SIGNATURE} takes exactly 2 arguments, got ${expr.args.length} — e.g. FILE(report_text, "pdf")`,
    );
  }
  const typeArg = expr.args[1];
  if (
    typeArg.type !== 'static' ||
    typeof typeArg.value !== 'string' ||
    !(FILE_ARTIFACT_TYPES as readonly string[]).includes(typeArg.value)
  ) {
    throw new BridgeError(
      `FILE()'s second argument is the artifact type — a literal ${FILE_ARTIFACT_TYPES.map((t) => `"${t}"`).join(' or ')}`,
    );
  }
}

/** READ(file) — one argument, and that is the whole static shape. WHAT it
 *  reads is a type question (the checker requires a file), not a parse one,
 *  so only the count is settled here. */
function validateReadCall(expr: Extract<Expression, { type: 'function' }>): void {
  if (expr.fn !== READ_FUNCTION_ID) return;
  if (expr.args.length !== 1) {
    throw new BridgeError(
      `${READ_SIGNATURE} takes exactly 1 argument, got ${expr.args.length} — e.g. READ(attachment)`,
    );
  }
}

/**
 * A built-in that takes its options as a map — CHUNKS(text, { size, … }) and
 * whatever declares a contract next. The KEYS are static call shape: they are
 * written into the source, nothing computes one, and a key nobody knows is a
 * typo the author must see at save. So the whole key surface is settled here —
 * that the map is a map, that every key is one the built-in has, that no key
 * is written twice, that the required ones are there, that a choice between
 * two spellings of one question is made exactly once, and that an option whose
 * value is a SPELLING (`unit: "chars"`) carries one of the spellings.
 *
 * The VALUES are ordinary expressions (`size: LENGTH(body) / 3`), so their
 * types belong to the checker — except where the author wrote a literal, which
 * needs no typing to be read, and is the form that gets a rule spanning two
 * options (an overlap under the size).
 */
function validateOptionsCall(expr: Extract<Expression, { type: 'function' }>): void {
  const spec = builtinOptionsFor(expr.fn);
  if (spec === undefined) return;
  const inventory = describeBuiltinOptions(spec);
  if (expr.args.length !== spec.arity) {
    throw new BridgeError(
      `${spec.signature} takes exactly ${spec.arity} arguments, got ${expr.args.length} — the options are a map: ${inventory}`,
    );
  }
  const map = expr.args[spec.index];
  if (map.type !== 'object') {
    throw new BridgeError(
      `${spec.signature} takes its options as a map — write { ${spec.options[0].key}: … }, not a bare value. The options are: ${inventory}`,
    );
  }

  const literals = new Map<string, string | number | boolean | null>();
  const seen = new Set<string>();
  for (const entry of map.entries) {
    const option = spec.options.find((o) => o.key === entry.key);
    if (option === undefined) {
      throw new BridgeError(
        `${spec.signature} has no option '${entry.key}'${didYouMean(entry.key, spec.options.map((o) => o.key))} — the options are: ${inventory}`,
      );
    }
    if (seen.has(entry.key)) {
      throw new BridgeError(`${spec.signature} is given '${entry.key}' twice — write it once`);
    }
    seen.add(entry.key);
    if (entry.value.type === 'static') literals.set(entry.key, entry.value.value);
    if (option.type === 'literal') validateLiteralOption(spec, option, entry.value);
  }

  for (const option of spec.options) {
    if (option.required && !seen.has(option.key)) {
      throw new BridgeError(
        `${spec.signature} needs '${option.key}' — ${option.summary}. The options are: ${inventory}`,
      );
    }
  }

  // Two spellings of one question (`size` and `entities`): both, or neither,
  // is a call that has not said what it wants. Which KEYS are written is the
  // whole of it, so it settles here beside the rest of the key surface.
  for (const choice of spec.exactlyOne ?? []) {
    const written = choice.keys.filter((key) => seen.has(key));
    const spellings = choice.keys.map((key) => `'${key}'`).join(' or ');
    if (written.length === 0) {
      const summaries = choice.keys
        .map((key) => spec.options.find((o) => o.key === key)?.summary)
        .filter((summary): summary is string => summary !== undefined)
        .join(', or ');
      throw new BridgeError(
        `${spec.signature} needs one of ${spellings} — ${summaries}. The options are: ${inventory}`,
      );
    }
    if (written.length > 1) {
      throw new BridgeError(
        `${spec.signature} is given ${written.map((key) => `'${key}'`).join(' and ')}, which are two ways of saying ${choice.what} — write one of them`,
      );
    }
  }

  const disagreement = spec.agree?.(literals);
  if (disagreement !== undefined) throw new BridgeError(`${spec.signature}: ${disagreement}`);
}

/** An option whose value is a SPELLING: it has to be written down (nothing
 *  computes one), it has to be a spelling the built-in knows, and a spelling
 *  the grammar reserves but nothing implements yet says so in its own words. */
function validateLiteralOption(
  spec: BuiltinOptionsSpec,
  option: BuiltinOptionSpec,
  value: Expression,
): void {
  const choices = (option.values ?? []).map((v) => `"${v}"`).join(' or ');
  if (value.type !== 'static' || typeof value.value !== 'string') {
    throw new BridgeError(
      `${spec.signature}: '${option.key}' is written down, not worked out — write ${option.key}: ${choices}`,
    );
  }
  if (!(option.values ?? []).includes(value.value)) {
    throw new BridgeError(
      `${spec.signature}: '${option.key}' has no value "${value.value}" — write ${option.key}: ${choices}`,
    );
  }
  const unavailable = option.unavailable?.[value.value];
  if (unavailable !== undefined) throw new BridgeError(`${spec.signature}: ${unavailable}`);
}

/** ` (did you mean 'size'?)` — the same nudge a typo'd enum value gets, by the
 *  same measure: one edit away, or a prefix of the real thing. */
function didYouMean(written: string, known: ReadonlyArray<string>): string {
  const near = known.find(
    (k) => k.startsWith(written) || written.startsWith(k) || editDistanceAtMostOne(k, written),
  );
  return near === undefined ? '' : ` (did you mean '${near}'?)`;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length > b.length) i++;
    else j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
