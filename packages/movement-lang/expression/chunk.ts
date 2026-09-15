// `CHUNKS(text, { size, overlap })` — a long text cut into pieces small enough
// to reason over one at a time. The cutting itself is here: pure, total, and
// deterministic, so the same text always yields the same pieces and a run that
// is replayed reads the same way.
//
// The rule, in one sentence: take at most `size` characters, then move the cut
// BACK to the last place a reader would have paused — a blank line, else a line
// break, else a space — provided that place is within the final tenth of the
// piece; otherwise cut where the ceiling falls. Looking no further back than a
// tenth is what keeps a piece close to the size asked for: a text with a single
// paragraph break near its start must not collapse every piece to that break.
//
// `size` counts UTF-16 code units — the same thing `LENGTH(t)` counts, so an
// author who measures a text and divides gets pieces the size they computed. A
// cut never lands between the two halves of a surrogate pair, so a piece is
// always well-formed text even though the unit is smaller than a character.

/** Options a cut is actually made with — non-negative integers, `overlap`
 *  below `size`. Only `readChunkSpec` mints one, so a caller cannot assemble
 *  a nonsense pair by hand. */
export interface ChunkSpec {
  size: number;
  overlap: number;
}

/** How far back from the ceiling a cut may move to find a break, as a fraction
 *  of the piece. A tenth: near enough the ceiling that pieces stay even. */
const CUT_WINDOW = 0.1;

/**
 * The options as they came out of the expression, turned into a spec — or the
 * sentence to fail the run with. Both values are EXPRESSIONS at author time
 * (`size: LENGTH(body) / 3` is a fraction), so a fractional count is rounded
 * down rather than refused: asking for thirds of a text that does not divide
 * by three is not a mistake.
 */
export function readChunkSpec(
  size: unknown,
  overlap: unknown,
): { spec: ChunkSpec } | { error: string } {
  const sizeValue = countOf(size);
  if (sizeValue === undefined || sizeValue < 1) {
    return {
      error: `CHUNKS needs a size of at least 1 character, and this run asked for ${describe(size)}`,
    };
  }
  const overlapValue = overlap == null ? 0 : countOf(overlap);
  if (overlapValue === undefined || overlapValue < 0) {
    return {
      error: `CHUNKS overlaps pieces by a number of characters, and this run asked for ${describe(overlap)}`,
    };
  }
  if (overlapValue >= sizeValue) {
    return {
      error: `CHUNKS cannot overlap pieces by ${overlapValue} characters when each piece is at most ${sizeValue} — the overlap has to be smaller than the size, or a piece would never get past the one before it`,
    };
  }
  return { spec: { size: sizeValue, overlap: overlapValue } };
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
  if (!Number.isInteger(spec.size) || spec.size < 1) {
    throw new RangeError('chunkText: size must be a positive integer');
  }
  if (!Number.isInteger(spec.overlap) || spec.overlap < 0 || spec.overlap >= spec.size) {
    throw new RangeError('chunkText: overlap must be a non-negative integer below size');
  }
  if (text.trim().length === 0) return [];
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
