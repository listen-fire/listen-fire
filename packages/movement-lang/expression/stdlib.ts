// The namespaced standard library — dotted pure-function families
// (`CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m")` → 1200000), per the
// 2026-06-11 ruling in `plans/2026-06-10-data-movement-language/
// 3_syntax_sketch.md` §"Composition, time, queries, failure":
// "Stdlib grows with namespaced families: flat pure built-ins plus
// dotted namespaces — a supported pattern for special-purpose pure
// tools".
//
// One registry serves every consumer:
//   - the BRIDGE folds `NS.FN(args)` (which the formula grammar already
//     parses as an alias-rooted traverse whose terminal is a function
//     call) into a plain `function` node with the dotted id, and rejects
//     unknown namespaces / unknown family members with the family's
//     inventory in the message — no @listen-fire/shared grammar change at all;
//   - the CHECKER types a folded call by the spec's declared return;
//   - the ENGINE evaluates the spec's `apply` exactly like its other
//     interpreted built-ins (deterministic, no LLM, no reads).
//
// Purity contract: same arguments → same value; no locale, no I/O.
// Null/undefined inputs yield null (the frozen built-ins' rule), and
// unparseable inputs yield null rather than throwing — a movement field
// write treats null as "no value", which is the right failure shape for
// "this string didn't contain a figure".
//
// ONE family of members steps outside the "arguments alone" half of that:
// a member marked `readsClock` (today only `DATE.TODAY(zone)`) also reads
// the run's PINNED INSTANT. That is a different shape, so it is a
// different type — such a spec has no `apply` at all, only `applyAt(args,
// now)`, so a pure member structurally cannot reach a clock and the
// engine cannot forget to hand one over. The instant is pinned once per
// run, so the determinism that matters survives: every clock read in a
// run answers from the same instant, and a replay computes the same
// window. The checker fires the effect row's `now` for these, exactly as
// it does for `@current_date`.
//
// FILE(content, "pdf" | "text") is related but NOT a member: it is a
// flat built-in with an effectful body (it renders an artifact), so only
// its NAME and argument contract live here (the bridge validates them);
// the rendering seam lives in the engine
// (apps/api/src/services/movement_engine/file_render.ts).

import { cronTimezoneError } from '@listen-fire/shared/cron';
import {
  instantAtZonedWallTime,
  readWallClockTime,
  wallClockTimeError,
  zonedDateString,
} from '@listen-fire/shared/timezone';

// ── Specs ────────────────────────────────────────────────────────────────────

interface StdlibFunctionCommon {
  /** The family, as written (`CURRENCY`). */
  namespace: string;
  /** The member's surface name (`GET_NUMBER_FROM_FIGURE`). */
  name: string;
  /** The dotted id carried in the parsed AST's `fn` slot —
   *  `<namespace>.<name>`, lowercased (`currency.get_number_from_figure`).
   *  The formula serializer's `fn.toUpperCase()` round-trips it. */
  id: string;
  /** Call shape for diagnostics and docs: `CURRENCY.GET_CODE_FROM_FIGURE(figure)`. */
  signature: string;
  /** One-line description (diagnostics list these per family). */
  summary: string;
  arity: { min: number; max: number };
  /** Shallow value type for the checker's write-field compatibility. */
  returns: 'text' | 'number' | 'date' | 'datetime';
  /**
   * The result may be ABSENT — the function returns null on an input it can't
   * read (`DATE.PARSE("not a date")`). The checker types the call as
   * `returns | absent` so the absence propagates (P20/F13) and fires
   * MOV_ABSENT_REQUIRED where a present value is required, discharged by `?:`,
   * a gate, or an `==` guard. Absent ⇒ the return is always present (the frozen
   * contract).
   */
  maybeAbsent?: boolean;
  /**
   * Arguments this function READS rather than merely passes on — a format
   * pattern, and nothing else so far. Such an argument is PARSED, which makes
   * it exactly the kind of string that drifts unless someone checks it, so the
   * checker demands a literal and runs `check` over it at save. `what` names
   * the argument in both diagnostics.
   */
  literalArgs?: ReadonlyArray<{
    index: number;
    what: string;
    /** A message when the literal is wrong, undefined when it is fine. */
    check: (value: string) => string | undefined;
  }>;
}

/** The ordinary member: its arguments are everything it sees. */
export interface StdlibPureFunctionSpec extends StdlibFunctionCommon {
  readsClock?: false;
  /** The deterministic implementation. Pure: no clock, no I/O. */
  apply: (args: unknown[]) => unknown;
}

/** A member that also reads the run's pinned instant (`DATE.TODAY(zone)`).
 *  It carries no `apply`, so it cannot be evaluated without one. */
export interface StdlibClockFunctionSpec extends StdlibFunctionCommon {
  readsClock: true;
  /** `now` is the run's ONE pinned instant, not a live clock read — two calls
   *  in a run, and a resume of a parked run, all get the same value. */
  applyAt: (args: unknown[], now: Date) => unknown;
}

export type StdlibFunctionSpec = StdlibPureFunctionSpec | StdlibClockFunctionSpec;

/** Evaluate a member — the ONE place a clock-reading member is handed the
 *  run's pinned instant, so no caller has to know which kind it has. */
export function applyStdlib(
  spec: StdlibFunctionSpec,
  args: unknown[],
  now: Date,
): unknown {
  return spec.readsClock === true ? spec.applyAt(args, now) : spec.apply(args);
}

export interface StdlibFamily {
  namespace: string;
  functions: StdlibFunctionSpec[];
}

// ── FILE() — the flat artifact built-in's contract (validated by the bridge) ─

/** The `fn` id FILE(content, type) parses to (a generic function call). */
export const FILE_FUNCTION_ID = 'file';

/** The artifact types FILE() renders. */
export const FILE_ARTIFACT_TYPES = ['pdf', 'text'] as const;
export type FileArtifactType = (typeof FILE_ARTIFACT_TYPES)[number];

export const FILE_SIGNATURE = 'FILE(content, "pdf" | "text")';

// ── CURRENCY ─────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: ReadonlyArray<[symbol: string, code: string]> = [
  ['£', 'GBP'],
  ['€', 'EUR'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['$', 'USD'],
];

const CURRENCY_CODES: ReadonlySet<string> = new Set([
  'USD', 'GBP', 'EUR', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD',
  'SEK', 'NOK', 'DKK', 'INR', 'SGD', 'HKD', 'KRW', 'BRL', 'MXN',
  'ZAR', 'PLN', 'AED', 'ILS', 'TRY',
]);

const MAGNITUDE_SUFFIXES: Readonly<Record<string, number>> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

/** The first number in the text, with thousands separators and an
 *  optional magnitude word stuck to it (`1.2m`, `3,500`, `2 billion`). */
const FIGURE_NUMBER = /(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]+)?/;

function figureNumber(args: unknown[]): unknown {
  const [figure] = args;
  if (figure == null) return null;
  if (typeof figure === 'number') return figure;
  const match = FIGURE_NUMBER.exec(String(figure));
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const suffix = match[2]?.toLowerCase();
  const magnitude = suffix !== undefined ? MAGNITUDE_SUFFIXES[suffix] ?? 1 : 1;
  return base * magnitude;
}

function figureCode(args: unknown[]): unknown {
  const [figure] = args;
  if (figure == null) return null;
  const text = String(figure);
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (text.includes(symbol)) return code;
  }
  for (const word of text.match(/[A-Za-z]{3}/g) ?? []) {
    const code = word.toUpperCase();
    if (CURRENCY_CODES.has(code)) return code;
  }
  return null;
}

// ── DATE ─────────────────────────────────────────────────────────────────────

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

interface DateParts { y: number; m: number; d: number }

/** Deterministic date reading — explicit patterns only (ISO,
 *  `2026/03/12`, `12 March 2026`, `March 12, 2026`), all UTC, English
 *  month names. Ambiguous numeric forms (`12/03/2026`) deliberately
 *  do not parse. */
function readDateParts(value: unknown): DateParts | null {
  if (value == null) return null;
  const s = String(value).trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (iso) return validParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (slashed) return validParts(Number(slashed[1]), Number(slashed[2]), Number(slashed[3]));

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/.exec(s);
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2].toLowerCase()];
    if (month === undefined) return null;
    return validParts(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1].toLowerCase()];
    if (month === undefined) return null;
    return validParts(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  return null;
}

/** Round-trips through Date.UTC so `31 February` style inputs reject. */
function validParts(y: number, m: number, d: number): DateParts | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

function isoDate(parts: DateParts): string {
  const mm = String(parts.m).padStart(2, '0');
  const dd = String(parts.d).padStart(2, '0');
  return `${parts.y}-${mm}-${dd}`;
}

function dateParse(args: unknown[]): unknown {
  const parts = readDateParts(args[0]);
  return parts === null ? null : isoDate(parts);
}

function dateAddDays(args: unknown[]): unknown {
  const parts = readDateParts(args[0]);
  if (parts === null) return null;
  const days = Number(args[1]);
  if (!Number.isFinite(days)) return null;
  const epoch = Date.UTC(parts.y, parts.m - 1, parts.d) + Math.trunc(days) * 86_400_000;
  return new Date(epoch).toISOString().slice(0, 10);
}

/** Any readable date/timestamp/epoch as a full ISO 8601 UTC instant, or null. */
function dateFormatIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const date = new Date(s);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parts = readDateParts(s);
  if (parts === null) return null;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).toISOString();
}

// ── DATE.FORMAT — a CLOSED pattern language ──────────────────────────────────
//
// `DATE.FORMAT(d, "MMMM D, YYYY")` → "August 31, 2026". The tokens are the
// date-fns / moment spelling, because that is the one every author (and every
// authoring model) already knows.
//
// The pattern is PARSED, so it is checked where it is written: every run of
// letters must be a token, and a run that isn't one is a save error naming the
// closest token. Nothing passes through silently — a pattern that means to
// print a word ("Day") would otherwise print "3ay" and nobody would find out
// until a person read the output. Everything that is NOT a letter (spaces,
// commas, slashes, dashes) is literal.
//
// English names only. A locale would make the same pattern print differently
// per reader, which is a different feature and not this one.

/** The whole vocabulary. A token is a RUN of one letter, which is what makes
 *  the pattern checkable: `MMMMM` is not `MMMM` plus `M`, it is a run of five
 *  M's and no token, so it is refused rather than printed as "August8". */
const DATE_FORMAT_TOKENS: ReadonlyArray<string> = [
  'YYYY', 'YY',
  'MMMM', 'MMM', 'MM', 'M',
  'DD', 'D',
  'dddd', 'ddd',
  'HH', 'H',
  'mm', 'm',
  'ss', 's',
];

const DATE_FORMAT_TOKEN_SET: ReadonlySet<string> = new Set(DATE_FORMAT_TOKENS);

const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/** The tokens and literal characters a pattern is made of, or the first run of
 *  letters that is not made of tokens. */
function readDateFormat(
  pattern: string,
): { pieces: Array<{ token: string } | { literal: string }> } | { unknown: string } {
  const pieces: Array<{ token: string } | { literal: string }> = [];
  for (const part of pattern.match(/[A-Za-z]+|[^A-Za-z]+/g) ?? []) {
    if (!/^[A-Za-z]/.test(part)) {
      for (const char of part) pieces.push({ literal: char });
      continue;
    }
    // Split the run where the letter changes — `YYYYMMDD` is three tokens,
    // `Day` is `D` then `a` then `y`, and only the first of those is one.
    const runs = part.match(/(.)\1*/g) ?? [];
    if (!runs.every((run) => DATE_FORMAT_TOKEN_SET.has(run))) return { unknown: part };
    for (const run of runs) pieces.push({ token: run });
  }
  return { pieces };
}

/** The save-time check: the whole token vocabulary, and a did-you-mean. */
export function checkDateFormatPattern(pattern: string): string | undefined {
  const read = readDateFormat(pattern);
  if (!('unknown' in read)) return undefined;
  const closest = closestDateFormatToken(read.unknown);
  return (
    `'${read.unknown}' isn't a date format token.`
    + (closest !== undefined ? ` Did you mean '${closest}'?` : '')
    + ` The tokens are ${DATE_FORMAT_TOKENS.join(', ')}`
    + ' (year, month, day, weekday, hour, minute, second);'
    + ' anything that is not a letter is printed as written.'
  );
}

/** The token a mistyped run is nearest to. Same CASE first — `M` and `m` are
 *  different tokens, and reading one as the other is the likeliest mistake —
 *  then the one closest in length, since `MMMMM` means `MMMM`. */
function closestDateFormatToken(run: string): string | undefined {
  const head = run[0]!;
  const sameCase = DATE_FORMAT_TOKENS.filter((t) => t[0] === head);
  const sameLetter = sameCase.length > 0
    ? sameCase
    : DATE_FORMAT_TOKENS.filter((t) => t[0]!.toLowerCase() === head.toLowerCase());
  if (sameLetter.length === 0) return undefined;
  return sameLetter.reduce((best, t) =>
    Math.abs(t.length - run.length) < Math.abs(best.length - run.length) ? t : best,
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function dateFormat(args: unknown[]): unknown {
  const instant = coerceToDatetime(args[0]);
  if (instant === null) return null;
  const pattern = args[1];
  if (pattern == null) return null;
  const read = readDateFormat(String(pattern));
  if ('unknown' in read) return null;
  const date = new Date(instant);
  const y = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const weekday = date.getUTCDay();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  let out = '';
  for (const piece of read.pieces) {
    if ('literal' in piece) {
      out += piece.literal;
      continue;
    }
    switch (piece.token) {
      case 'YYYY': out += pad(y, 4); break;
      case 'YY': out += pad(y % 100, 2); break;
      case 'MMMM': out += MONTH_FULL[month]; break;
      case 'MMM': out += MONTH_FULL[month]!.slice(0, 3); break;
      case 'MM': out += pad(month + 1, 2); break;
      case 'M': out += String(month + 1); break;
      case 'DD': out += pad(day, 2); break;
      case 'D': out += String(day); break;
      case 'dddd': out += WEEKDAY_FULL[weekday]; break;
      case 'ddd': out += WEEKDAY_FULL[weekday]!.slice(0, 3); break;
      case 'HH': out += pad(hours, 2); break;
      case 'H': out += String(hours); break;
      case 'mm': out += pad(minutes, 2); break;
      case 'm': out += String(minutes); break;
      case 'ss': out += pad(seconds, 2); break;
      case 's': out += String(seconds); break;
    }
  }
  return out;
}

// ── Zones — the day it is there, and the instant a wall time names ───────────
//
// Two members, and one rule between them: ARITHMETIC HAPPENS IN CALENDAR
// SPACE, ANCHORING HAPPENS LAST.
//
//   berlin_today = DATE.TODAY("Europe/Berlin")
//   win_end      = DATETIME.AT(berlin_today, "07:00", "Europe/Berlin")
//   win_start    = DATETIME.AT(DATE.ADD_DAYS(berlin_today, -1), "07:00", "Europe/Berlin")
//
// Moving whole days on the DATE, then anchoring each endpoint on its own, is
// what makes that window come out 23 or 25 hours long across a DST change with
// nobody having written that down. Anchoring first and subtracting 24 hours
// gets 06:00 or 08:00 local twice a year, silently.
//
// `DATE.TODAY` is the language's only clock-reading FUNCTION (`@current_date`
// is the only other clock read there is), and it reads the run's pinned
// instant, not the wall clock — so a run that asks twice gets one answer, and
// 00:30 in Berlin is today in Berlin rather than yesterday in UTC.
//
// The zone and the wall time are both PARSED, so both are demanded as written
// literals and checked at save (`literalArgs`) with the same probes the run
// uses — author-time and run-time cannot disagree about what a zone is.

function checkTimeZone(zone: string): string | undefined {
  return cronTimezoneError(zone) ?? undefined;
}

function checkWallClockTime(time: string): string | undefined {
  return wallClockTimeError(time) ?? undefined;
}

function dateToday(args: unknown[], now: Date): unknown {
  const zone = args[0];
  if (zone == null) return null;
  const problem = cronTimezoneError(String(zone));
  if (problem !== null) throw new Error(`DATE.TODAY(zone) — ${problem}`);
  return zonedDateString(now, String(zone));
}

function datetimeAt(args: unknown[]): unknown {
  const [date, time, zone] = args;
  if (date == null || time == null || zone == null) return null;
  // A date-typed adapter field arrives as a real Date; everything else that
  // reads as a date arrives as text.
  const parts = readDateParts(date instanceof Date ? date.toISOString() : date);
  if (parts === null) {
    throw new Error(
      `DATETIME.AT(date, time, zone) — '${String(date)}' is not a calendar date.`
      + ' Its first argument is a day: DATE.TODAY(zone), a date field, DATE.ADD_DAYS(…) or DATE.PARSE(text).',
    );
  }
  const wall = readWallClockTime(String(time));
  if (wall === null) throw new Error(`DATETIME.AT(date, time, zone) — ${wallClockTimeError(String(time))}`);
  const zoneProblem = cronTimezoneError(String(zone));
  if (zoneProblem !== null) throw new Error(`DATETIME.AT(date, time, zone) — ${zoneProblem}`);
  return instantAtZonedWallTime({
    year: parts.y,
    month: parts.m,
    day: parts.d,
    hour: wall.hour,
    minute: wall.minute,
    timezone: String(zone),
  }).toISOString();
}

// ── Coercers (DATE / DATETIME / NUMBER) ───────────────────────────────────────
//
// One value in, a value of the named scalar type out — the author-time
// type-check uses these to bridge a cross-category comparison (`date <=
// NUMBER(x)`). Pure and null-safe like every built-in: an unparseable
// input yields null. DATE normalises any readable date/timestamp to a
// midnight-UTC calendar day (date-only ISO); DATETIME to a full instant.
//
// These are the BARE built-in coercers `DATE(x)` / `DATETIME(x)` /
// `NUMBER(x)` — the formula grammar parses them as flat function calls
// (`{ fn: 'date' | 'datetime' | 'number' }`), the checker types them, and
// the engine runs them through these single-value implementations (it
// imports them rather than re-implementing, so there is one source of
// truth). Single-value signatures (not the `args[]` registry shape) so the
// engine can call them directly.

/** Any readable date/timestamp/epoch as a full ISO 8601 UTC instant, or null. */
export function coerceToDatetime(value: unknown): string | null {
  if (value == null) return null;
  return dateFormatIso(value);
}

/** The same instant, truncated to its calendar day (midnight UTC, date-only). */
export function coerceToDate(value: unknown): string | null {
  const instant = coerceToDatetime(value);
  return instant === null ? null : instant.slice(0, 10);
}

/** A value coerced to a finite number, or null when it doesn't parse. */
export function coerceToNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && String(value).trim() !== '' ? n : null;
}

/** A documented bare coercer — the editor's single source of truth for both
 *  the autocomplete item and its hover. One value in, a value of `returns`
 *  out; `summary` is user-facing (clear, jargon-free, with an example). */
export interface BareCoercerSpec {
  name: 'DATE' | 'DATETIME' | 'NUMBER';
  signature: string;
  summary: string;
  returns: 'date' | 'datetime' | 'number';
}

export const BARE_COERCERS: ReadonlyArray<BareCoercerSpec> = [
  {
    name: 'DATE',
    signature: 'DATE(value)',
    summary:
      'coerce a value to a calendar day (midnight UTC) — DATE("2026-03-12T09:30Z") is "2026-03-12"',
    returns: 'date',
  },
  {
    name: 'DATETIME',
    signature: 'DATETIME(value)',
    summary:
      'coerce a value to a full timestamp (UTC instant) — DATETIME("2026-03-12") is "2026-03-12T00:00:00.000Z"',
    returns: 'datetime',
  },
  {
    name: 'NUMBER',
    signature: 'NUMBER(value)',
    summary: 'coerce a value to a number — NUMBER("42") is 42; an unparseable value is empty',
    returns: 'number',
  },
];

const BARE_COERCER_BY_NAME = new Map(BARE_COERCERS.map((c) => [c.name, c]));

/** The coercer for a written name (case-insensitive, like the rest of the
 *  expression grammar) — `DATE` / `DATETIME` / `NUMBER`. */
export function bareCoercer(name: string): BareCoercerSpec | undefined {
  return BARE_COERCER_BY_NAME.get(name.toUpperCase() as BareCoercerSpec['name']);
}

// ── TEXT ─────────────────────────────────────────────────────────────────────

function textRegexExtract(args: unknown[]): unknown {
  const [text, pattern, group] = args;
  if (text == null || pattern == null) return null;
  let re: RegExp;
  try {
    re = new RegExp(String(pattern));
  } catch {
    return null;
  }
  const match = re.exec(String(text));
  if (!match) return null;
  const index =
    args.length > 2 ? Number(group) : match.length > 1 ? 1 : 0;
  if (!Number.isInteger(index) || index < 0 || index >= match.length) return null;
  return match[index] ?? null;
}

function textSlug(args: unknown[]): unknown {
  const [text] = args;
  if (text == null) return null;
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── The registry ─────────────────────────────────────────────────────────────

function spec(
  namespace: string,
  name: string,
  options: {
    args: string;
    summary: string;
    arity: StdlibFunctionSpec['arity'];
    returns: StdlibFunctionSpec['returns'];
    maybeAbsent?: boolean;
    literalArgs?: StdlibFunctionCommon['literalArgs'];
    apply: StdlibPureFunctionSpec['apply'];
  },
): StdlibPureFunctionSpec {
  return { ...common(namespace, name, options), apply: options.apply };
}

/** A member that reads the run's pinned instant — same shape, `applyAt`
 *  instead of `apply`, so the two can never be confused for each other. */
function clockSpec(
  namespace: string,
  name: string,
  options: {
    args: string;
    summary: string;
    arity: StdlibFunctionSpec['arity'];
    returns: StdlibFunctionSpec['returns'];
    maybeAbsent?: boolean;
    literalArgs?: StdlibFunctionCommon['literalArgs'];
    applyAt: StdlibClockFunctionSpec['applyAt'];
  },
): StdlibClockFunctionSpec {
  return { ...common(namespace, name, options), readsClock: true, applyAt: options.applyAt };
}

function common(
  namespace: string,
  name: string,
  options: {
    args: string;
    summary: string;
    arity: StdlibFunctionSpec['arity'];
    returns: StdlibFunctionSpec['returns'];
    maybeAbsent?: boolean;
    literalArgs?: StdlibFunctionCommon['literalArgs'];
  },
): StdlibFunctionCommon {
  return {
    namespace,
    name,
    id: `${namespace.toLowerCase()}.${name.toLowerCase()}`,
    signature: `${namespace}.${name}(${options.args})`,
    summary: options.summary,
    arity: options.arity,
    returns: options.returns,
    ...(options.maybeAbsent !== undefined ? { maybeAbsent: options.maybeAbsent } : {}),
    ...(options.literalArgs !== undefined ? { literalArgs: options.literalArgs } : {}),
  };
}

export const STDLIB_FAMILIES: ReadonlyArray<StdlibFamily> = [
  {
    namespace: 'CURRENCY',
    functions: [
      spec('CURRENCY', 'GET_NUMBER_FROM_FIGURE', {
        args: 'figure',
        summary: 'the numeric amount in a money figure — CURRENCY.GET_NUMBER_FROM_FIGURE("£1.2m") is 1200000',
        arity: { min: 1, max: 1 },
        returns: 'number',
        apply: figureNumber,
      }),
      spec('CURRENCY', 'GET_CODE_FROM_FIGURE', {
        args: 'figure',
        summary: 'the ISO currency code in a money figure — CURRENCY.GET_CODE_FROM_FIGURE("£1.2m") is "GBP"',
        arity: { min: 1, max: 1 },
        returns: 'text',
        apply: figureCode,
      }),
    ],
  },
  {
    namespace: 'DATE',
    functions: [
      spec('DATE', 'PARSE', {
        args: 'text',
        summary: 'a written date as an ISO date — DATE.PARSE("12 March 2026") is "2026-03-12"; unreadable text is absent',
        arity: { min: 1, max: 1 },
        returns: 'date',
        // Unreadable text yields absence — the checker types this `date | absent`
        // so an unguarded parse into a required field is caught at save (F13/P20).
        maybeAbsent: true,
        apply: dateParse,
      }),
      spec('DATE', 'ADD_DAYS', {
        args: 'date, days',
        summary: 'a date shifted by whole days — DATE.ADD_DAYS("2026-03-12", 7) is "2026-03-19"',
        arity: { min: 2, max: 2 },
        returns: 'date',
        apply: dateAddDays,
      }),
      spec('DATE', 'FORMAT', {
        args: 'value, pattern',
        summary:
          'a date written out — DATE.FORMAT("2026-08-31", "MMMM D, YYYY") is "August 31, 2026". Tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H mm m ss s; anything else is printed as written',
        arity: { min: 2, max: 2 },
        returns: 'text',
        // Same promise as FORMAT_ISO: a value it cannot read yields nothing,
        // and the write field treats that as "no value".
        literalArgs: [{ index: 1, what: 'the format pattern', check: checkDateFormatPattern }],
        apply: dateFormat,
      }),
      spec('DATE', 'FORMAT_ISO', {
        args: 'value',
        summary: 'any readable date or timestamp normalised to a full ISO 8601 UTC timestamp',
        arity: { min: 1, max: 1 },
        returns: 'date',
        apply: (args) => dateFormatIso(args[0]),
      }),
      clockSpec('DATE', 'TODAY', {
        args: 'zone',
        summary:
          'the calendar date it is right now in a place — DATE.TODAY("Europe/Berlin") is "2026-03-12" from 00:00 to 23:59 there. The zone is written down (an IANA name like "Europe/Berlin", "America/New_York", "UTC")',
        arity: { min: 1, max: 1 },
        returns: 'date',
        literalArgs: [{ index: 0, what: 'the time zone', check: checkTimeZone }],
        applyAt: dateToday,
      }),
    ],
  },
  {
    namespace: 'DATETIME',
    functions: [
      spec('DATETIME', 'AT', {
        args: 'date, time, zone',
        summary:
          'the instant a wall-clock time on a date names in a place — DATETIME.AT("2026-06-15", "07:00", "Europe/Berlin") is 05:00 UTC. Move days with DATE.ADD_DAYS on the date and anchor each end separately, and a daylight-saving change takes care of itself',
        arity: { min: 3, max: 3 },
        returns: 'datetime',
        literalArgs: [
          { index: 1, what: 'the time of day', check: checkWallClockTime },
          { index: 2, what: 'the time zone', check: checkTimeZone },
        ],
        apply: datetimeAt,
      }),
    ],
  },
  {
    namespace: 'TEXT',
    functions: [
      spec('TEXT', 'REGEX_EXTRACT', {
        args: 'text, pattern, group?',
        summary: 'the first regex match (the first capture group when the pattern has one) — null when nothing matches',
        arity: { min: 2, max: 3 },
        returns: 'text',
        apply: textRegexExtract,
      }),
      spec('TEXT', 'SLUG', {
        args: 'text',
        summary: 'a lowercase-hyphen slug — TEXT.SLUG("Acme Corp Ltd.") is "acme-corp-ltd"',
        arity: { min: 1, max: 1 },
        returns: 'text',
        apply: textSlug,
      }),
    ],
  },
];

const FAMILY_BY_NAMESPACE = new Map(
  STDLIB_FAMILIES.map((family) => [family.namespace, family]),
);

const SPEC_BY_ID = new Map(
  STDLIB_FAMILIES.flatMap((family) => family.functions.map((fn) => [fn.id, fn] as const)),
);

/** The family for a written namespace (case-insensitive — function names
 *  are case-insensitive throughout the expression grammar). */
export function stdlibFamily(namespace: string): StdlibFamily | undefined {
  return FAMILY_BY_NAMESPACE.get(namespace.toUpperCase());
}

/** The spec behind a parsed `function` node's dotted `fn` id. */
export function stdlibFunctionById(fn: string): StdlibFunctionSpec | undefined {
  return SPEC_BY_ID.get(fn);
}

export function listStdlibNamespaces(): string[] {
  return STDLIB_FAMILIES.map((family) => family.namespace);
}

/** `GET_NUMBER_FROM_FIGURE(figure), GET_CODE_FROM_FIGURE(figure)` — the
 *  inventory line diagnostics print for a family. */
export function describeStdlibFamily(family: StdlibFamily): string {
  return family.functions
    .map((fn) => `${fn.name}(${fn.signature.slice(fn.signature.indexOf('(') + 1)}`)
    .join(', ');
}
