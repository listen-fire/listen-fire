// How many records a text is likely to YIELD — the figure `CHUNKS(t, {
// entities: N })` cuts by. Pure, total and deterministic, exactly like the cut
// itself (./chunk.ts), so the same text always gives the same estimate and a
// replayed run reads the same way.
//
// Why a count of records rather than a count of characters: what makes a
// reading run past its output ceiling is how much ANSWER it has to write, and
// that scales with the number of records in the piece. A directory of two
// hundred one-line entries and an essay of the same length ask for wildly
// different amounts of answer, and only the first one needs cutting.
//
// The heuristic, per LINE, in order:
//
//   1. LINKS. A link is a record — a profile link is a person, a company link
//      or a bare domain is a company. Repeats of the same link on one line are
//      one record, so a name written next to its own address counts once.
//   2. ITEMS. A line that opens with a bracketed source tag (`[Example · …]`)
//      or a bullet is one item, which is one record — unless it carries more
//      links than that, in which case the links win.
//   3. PROSE, where neither hit. A run of two or more capitalised words is a
//      proper noun, and distinct ones are counted; then damped to
//      PROSE_ENTITIES_PER_HUNDRED_CHARS, because prose names streets, months
//      and job titles as readily as it names companies.
//
// It ESTIMATES, and it is built to estimate HIGH rather than low: an
// over-estimate cuts smaller pieces, which costs calls, and an under-estimate
// loses records off the end of an answer, which is the failure this exists to
// prevent. A line is the unit, so the whole of a line always stays in one
// piece, and a name repeated across two lines counts twice.

/**
 * Prose names far more capitalised things than it has records in it, so a
 * proper-noun count is a ceiling rather than an answer: at most this many
 * records per hundred characters of prose. Half of one — a two-line paragraph
 * that mentions six proper nouns is a paragraph about one or two things.
 */
const PROSE_ENTITIES_PER_HUNDRED_CHARS = 0.5;

/** An http(s) link, or a bare domain with a path — what a message names a
 *  company or a person WITH. The bare form is held to a known suffix so that
 *  `Inc.`, `e.g.` and a version number are not addresses. */
const LINK =
  /https?:\/\/[^\s<>()[\]"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|ai|co|dev|app|uk|de|fr|nl|es|it|se|eu|us|vc|tech|cloud|me|xyz|info|biz)\b(?:\/[^\s<>()[\]"']*)?/gi;

/** A line that IS an item: a bracketed source tag, a bullet, or a number. */
const LIST_ITEM = /^[ \t]*(?:\[[^\]]+\]|[•·*\-–—][ \t]|\d+[.)][ \t])/;

/** Two or more capitalised words in a row — `Example Ventures`, `Jane Doe`. A
 *  single capitalised word is a sentence opening as often as it is a name, so
 *  it is not counted. */
const PROPER_NOUN_RUN = /\p{Lu}[\p{L}\p{N}'’&.-]*(?:[ \t]+\p{Lu}[\p{L}\p{N}'’&.-]*)+/gu;

/** The records `text` is likely to yield — the sum over its lines. */
export function estimateEntities(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) total += estimateEntitiesInLine(line);
  return total;
}

/** The records ONE line is likely to yield. The chunker walks with this, so
 *  the estimate of a piece is the sum of the estimates of its lines. */
export function estimateEntitiesInLine(line: string): number {
  const links = countDistinct(line, LINK, normalizeLink);
  const item = LIST_ITEM.test(line) ? 1 : 0;
  if (links > 0 || item > 0) return Math.max(links, item);
  return properNouns(line);
}

/** Prose's estimate: distinct proper nouns, capped by how much prose there is
 *  to hold records. */
function properNouns(line: string): number {
  const runs = countDistinct(line, PROPER_NOUN_RUN, (run) => run.toLowerCase());
  if (runs === 0) return 0;
  const room = Math.ceil((line.length / 100) * PROSE_ENTITIES_PER_HUNDRED_CHARS);
  return Math.min(runs, Math.max(1, room));
}

function countDistinct(
  line: string,
  pattern: RegExp,
  identity: (match: string) => string,
): number {
  const seen = new Set<string>();
  for (const match of line.matchAll(pattern)) seen.add(identity(match[0]));
  return seen.size;
}

/** The same address written two ways is one address: no scheme, no `www.`, no
 *  sentence punctuation stuck to the end, and case-insensitive. */
function normalizeLink(link: string): string {
  return link
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[.,;:!?)\]]+$/, '');
}
