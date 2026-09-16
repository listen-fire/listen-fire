// `CHUNKS(text, { size | entities, overlap })` — a long text cut into pieces
// small enough to reason over one at a time. The cutting itself is here: pure,
// total, and deterministic, so the same text always yields the same pieces and
// a run that is replayed reads the same way.
//
// There are two ways to say how big a piece is, and a call says exactly one:
//
// BY SIZE. Take at most `size` characters, then move the cut BACK to the last
// place a reader would have paused — a blank line, else a line break, else a
// space — provided that place is within the final tenth of the piece;
// otherwise cut where the ceiling falls. Looking no further back than a tenth
// is what keeps a piece close to the size asked for: a text with a single
// paragraph break near its start must not collapse every piece to that break.
//
// `size` counts UTF-16 code units — the same thing `LENGTH(t)` counts, so an
// author who measures a text and divides gets pieces the size they computed. A
// cut never lands between the two halves of a surrogate pair, so a piece is
// always well-formed text even though the unit is smaller than a character.
//
// BY ENTITIES. Take whole lines while the records they are estimated to hold
// (./density.ts) still fit in `entities`, then cut — preferring a paragraph
// break in the final tenth of the piece, the same cut-back the size mode
// makes. A line is never split for this, so a single line that already expects
// more records than a whole piece may hold becomes a piece of its own. This
// is the mode to reach for when what runs past a reading's output ceiling is
// the NUMBER of records it has to write, which is most of the time: a
// directory of one-line entries and an essay of the same length ask for wildly
// different amounts of answer.

import { estimateEntitiesInLine } from './density';

/** A cut by characters — at most `size` of them in a piece. */
export interface SizeChunkSpec {
  mode: 'size';
  size: number;
  overlap: number;
}

/** A cut by expected records — at most `entities` of them in a piece, except
 *  where one line expects more than that on its own. */
export interface EntitiesChunkSpec {
  mode: 'entities';
  entities: number;
  overlap: number;
}

/** Options a cut is actually made with — non-negative integers, and in the
 *  size mode an `overlap` below `size`. Only `readChunkSpec` mints one, so a
 *  caller cannot assemble a nonsense pair by hand. */
export type ChunkSpec = SizeChunkSpec | EntitiesChunkSpec;

/** The options as a run hands them over: every one of them is an EXPRESSION at
 *  author time, so nothing here is known to be a number, or to be there. */
export interface ChunkOptions {
  size?: unknown;
  entities?: unknown;
  overlap?: unknown;
}

/** How far back from the ceiling a cut may move to find a break, as a fraction
 *  of the piece. A tenth: near enough the ceiling that pieces stay even. */
const CUT_WINDOW = 0.1;

/**
 * The options as they came out of the expression, turned into a spec — or the
 * sentence to fail the run with. Both counts are EXPRESSIONS at author time
 * (`size: LENGTH(body) / 3` is a fraction), so a fractional count is rounded
 * down rather than refused: asking for thirds of a text that does not divide
 * by three is not a mistake.
 *
 * `size` and `entities` are two answers to one question, so a call gives one.
 * The bridge already refuses both spellings where an author wrote them down;
 * this is the same rule where a run computed them.
 */
export function readChunkSpec(options: ChunkOptions): { spec: ChunkSpec } | { error: string } {
  const bySize = options.size != null;
  const byEntities = options.entities != null;
  if (bySize && byEntities) {
    return {
      error: `CHUNKS is given both a size (${describe(options.size)}) and an expected ${describe(options.entities)} records — they are two ways of saying how big a piece is, so a cut is made by one of them`,
    };
  }
  if (!bySize && !byEntities) {
    return {
      error:
        'CHUNKS needs a size in characters or a number of expected records, and this run worked out neither',
    };
  }

  const overlapValue = options.overlap == null ? 0 : countOf(options.overlap);
  if (overlapValue === undefined || overlapValue < 0) {
    return {
      error: `CHUNKS overlaps pieces by a number of characters, and this run asked for ${describe(options.overlap)}`,
    };
  }

  if (byEntities) {
    const entities = countOf(options.entities);
    if (entities === undefined || entities < 1) {
      return {
        error: `CHUNKS needs to expect at least 1 record in a piece, and this run asked for ${describe(options.entities)}`,
      };
    }
    return { spec: { mode: 'entities', entities, overlap: overlapValue } };
  }

  const size = countOf(options.size);
  if (size === undefined || size < 1) {
    return {
      error: `CHUNKS needs a size of at least 1 character, and this run asked for ${describe(options.size)}`,
    };
  }
  if (overlapValue >= size) {
    return {
      error: `CHUNKS cannot overlap pieces by ${overlapValue} characters when each piece is at most ${size} — the overlap has to be smaller than the size, or a piece would never get past the one before it`,
    };
  }
  return { spec: { mode: 'size', size, overlap: overlapValue } };
}

function countOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function describe(value: unknown): string {
  if (value == null) return 'nothing';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `the text "${value}"`;
  return `a ${typeof value}`;
}

/**
 * The pieces of `text`, in order. A text with nothing in it (empty, or only
 * whitespace) has no pieces at all rather than one empty one — there is
 * nothing to read, and a piece that says nothing is worse than no piece. A
 * text that already fits is one piece, uncut.
 */
export function chunkText(text: string, spec: ChunkSpec): string[] {
  if (!Number.isInteger(spec.overlap) || spec.overlap < 0) {
    throw new RangeError('chunkText: overlap must be a non-negative integer');
  }
  if (text.trim().length === 0) return [];
  switch (spec.mode) {
    case 'size':
      return chunkBySize(text, spec);
    case 'entities':
      return chunkByEntities(text, spec);
  }
}

function chunkBySize(text: string, spec: SizeChunkSpec): string[] {
  if (!Number.isInteger(spec.size) || spec.size < 1) {
    throw new RangeError('chunkText: size must be a positive integer');
  }
  if (spec.overlap >= spec.size) {
    throw new RangeError('chunkText: overlap must be below size');
  }
  if (text.length <= spec.size) return [text];

  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const ceiling = start + spec.size;
    if (ceiling >= text.length) {
      pieces.push(text.slice(start));
      break;
    }
    const cut = wholeCodePoint(text, cutBefore(text, start, ceiling, spec.size));
    pieces.push(text.slice(start, cut));
    // A piece always ends past where the one before it began, so the walk
    // always advances — an overlap wide enough to undo a short piece is held
    // to one character of progress rather than looping.
    start = Math.max(wholeCodePoint(text, cut - spec.overlap), start + 1);
  }
  return pieces;
}

/** One line of the text, with the break that ended it, and what it is
 *  expected to yield. The break stays with the line so the pieces concatenate
 *  back into the text they came from. */
interface CountedLine {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's break — where the next line starts. */
  end: number;
  entities: number;
  blank: boolean;
}

function countedLines(text: string): CountedLine[] {
  const lines: CountedLine[] = [];
  let start = 0;
  while (start < text.length) {
    const brk = text.indexOf('\n', start);
    const end = brk === -1 ? text.length : brk + 1;
    const line = text.slice(start, end);
    lines.push({
      start,
      end,
      entities: estimateEntitiesInLine(line),
      blank: line.trim().length === 0,
    });
    start = end;
  }
  return lines;
}

/**
 * Whole lines until the running estimate reaches what was asked for. A line
 * that expects more on its own than a whole piece may hold is a piece by
 * itself — splitting it would cut a record in half, which is the one thing
 * this mode exists to avoid.
 */
function chunkByEntities(text: string, spec: EntitiesChunkSpec): string[] {
  if (!Number.isInteger(spec.entities) || spec.entities < 1) {
    throw new RangeError('chunkText: entities must be a positive integer');
  }
  const lines = countedLines(text);
  const pieces: string[] = [];
  let first = 0;

  while (first < lines.length) {
    // Lines go in while they still fit. The FIRST one goes in whatever it
    // expects: a line that already expects more than a whole piece may hold is
    // a piece by itself, since splitting it would cut a record in half.
    let running = 0;
    let last = first - 1;
    for (let i = first; i < lines.length; i++) {
      const withLine = running + lines[i].entities;
      if (last >= first && withLine > spec.entities) break;
      running = withLine;
      last = i;
    }
    if (last >= lines.length - 1) {
      pieces.push(text.slice(lines[first].start));
      break;
    }
    const cut = cutBackToParagraph(lines, first, last);
    pieces.push(text.slice(lines[first].start, cut.end));
    // The next piece opens on a whole line too, so an overlap is rounded back
    // to the line boundary at or before it — and never so far back that the
    // walk fails to advance.
    const resume = Math.min(lineHolding(lines, cut.end - spec.overlap), cut.line + 1);
    first = Math.max(resume, first + 1);
  }
  return pieces;
}

/** The line `offset` falls in — the one whose break is the first past it. An
 *  offset at a line boundary belongs to the line that STARTS there, so an
 *  overlap of none resumes on the next line rather than repeating the last. */
function lineHolding(lines: CountedLine[], offset: number): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].end > offset) return i;
  }
  return lines.length;
}

/**
 * Where the piece running from `start` through line `last` ends. The line
 * boundary after `last` is the answer, unless a blank line falls inside the
 * final tenth of the piece — a reader pauses harder at a paragraph than at a
 * line, which is the same preference the size mode makes.
 */
function cutBackToParagraph(
  lines: CountedLine[],
  first: number,
  last: number,
): { end: number; line: number } {
  const end = lines[last].end;
  const window = Math.max(1, Math.floor((end - lines[first].start) * CUT_WINDOW));
  for (let i = last - 1; i > first; i--) {
    if (end - lines[i].end > window) break;
    if (lines[i].blank) return { end: lines[i].end, line: i };
  }
  return { end, line: last };
}

/**
 * Where this piece ends: the last break within the final tenth before the
 * ceiling, preferring the biggest pause a reader would take (a blank line over
 * a line break over a space), and the ceiling itself when that window holds no
 * break at all. The cut falls AFTER the break, so the pieces concatenate back
 * into the text they came from.
 */
function cutBefore(text: string, start: number, ceiling: number, size: number): number {
  const windowStart = Math.max(start + 1, ceiling - Math.max(1, Math.floor(size * CUT_WINDOW)));
  const window = text.slice(windowStart, ceiling);

  const paragraph = lastMatchEnd(window, /\n[ \t]*\n/g);
  if (paragraph !== undefined) return windowStart + paragraph;

  const line = window.lastIndexOf('\n');
  if (line !== -1) return windowStart + line + 1;

  const space = window.lastIndexOf(' ');
  if (space !== -1) return windowStart + space + 1;

  return ceiling;
}

/** The end offset of the LAST match, or undefined when there is none. */
function lastMatchEnd(haystack: string, pattern: RegExp): number | undefined {
  let end: number | undefined;
  for (const match of haystack.matchAll(pattern)) end = match.index + match[0].length;
  return end;
}

/** The same offset, moved back off the seam of a surrogate pair. A cut between
 *  the two halves would leave both pieces holding half a character, which no
 *  reader — and no model — can do anything with. */
function wholeCodePoint(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) return offset;
  const before = text.charCodeAt(offset - 1);
  const at = text.charCodeAt(offset);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
  return splitsPair ? offset - 1 : offset;
}
