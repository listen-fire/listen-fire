// Reading the person behind a profile address — the one page neither engine
// can simply open.
//
// A profile address anchors identity: whoever holds it IS the person, so
// everything found afterwards is accepted only where it agrees with their own
// headline. But linkedin.com is closed. The shared scraper meets a login
// wall, and Anthropic's server fetcher refuses the host outright
// (`url_not_allowed`), so an engine that hands its loop to the model is blind
// to exactly the address that would settle who it is researching.
//
// So every engine reads the profile the same way, in code, before it researches
// anything: the search index first, because a profile's index entry carries the
// name, the headline and often the organisation; the profile service only when
// the caller decides the index was not enough, because it is slow and paid for.
//
// One reading, shared — two readings would attribute the same page to two
// different people.

import type { ProfileIdentity } from '../linkedin_identity';
import type { SearchHit } from '../search_hygiene';

import { describeError } from '../addresses';
import { logger, SECOND, tools } from '../tools';
import { canonicalProfileUrl, isThin, matchesSlug, readTitle } from '../linkedin_identity';

/** Only spent when the index was not enough, and it has to fit inside the wall
 *  clock alongside the searches. */
export const PROFILE_WAIT_MS = 75 * SECOND;

/** How much of the profile a prompt is shown. The answer is a few paragraphs;
 *  a whole career history buys nothing but tokens. */
export const PROFILE_EXCERPT_CHARS = 4000;

export interface ProfileRead {
  profileUrl: string;
  identity: ProfileIdentity;
  /** The snippet of the profile's own index entry. It often says what the title
   *  does not, such as "Experience: Acme · Education: Example University". */
  indexText: string | null;
  /** Everything the identity searches returned, the profile's own entry and
   *  strangers' results alike: the searches are paid for either way, and only
   *  the caller knows what it can use. */
  seen: SearchHit[];
  /** The profile's own text, when the service was asked and had it. Capped at
   *  `PROFILE_EXCERPT_CHARS`. */
  text: string | null;
}

interface ReadOptions {
  log: string;
  run: Record<string, unknown>;
}

/**
 * What the index says about this profile. Two searches at most, and the second
 * only when the first missed it. The site query goes first: over a sample of 20
 * people it found 17 profiles where the bare address found 5. The caller owns
 * the accounting, because a search costs a different engine a different thing.
 */
export async function readProfileIndex(
  args: ReadOptions & { slug: string; search: (query: string) => Promise<SearchHit[]> },
): Promise<ProfileRead> {
  const { slug, search, log, run } = args;
  const profileUrl = canonicalProfileUrl(slug);

  const seen: SearchHit[] = [];
  for (const query of [`site:linkedin.com/in/${slug}`, profileUrl]) {
    const results = await search(query);
    seen.push(...results);
    const match = results.find((r) => matchesSlug(r.link, slug));
    if (!match) continue;
    const identity = readTitle(match.title);
    logger.info(`${log} Identity from the index`, { slug, name: identity.name, ...run });
    return { profileUrl, identity, indexText: match.snippet.trim() || null, seen, text: null };
  }

  const identity = { name: null, headline: null, role: null, organisation: null, location: null };
  return { profileUrl, identity, indexText: null, seen, text: null };
}

/** The read with the profile service's text and whatever the index left unknown
 *  filled in from it. No service, or nothing from it, leaves the read as it was. */
export async function readProfilePage(read: ProfileRead, options: ReadOptions): Promise<ProfileRead> {
  const { profileUrl, identity } = read;
  const { log, run } = options;
  const profiles = tools().profiles;
  if (!profiles) return read;
  try {
    const profile = await profiles.getProfileTextByUrl(profileUrl, { maxWaitMs: PROFILE_WAIT_MS });
    const text = profile?.text?.trim();
    if (!text) return read;
    const { name, headline } = readProfileLines(text);
    logger.info(`${log} Read the profile`, { profileUrl, chars: text.length, ...run });
    return {
      ...read,
      identity: {
        ...identity,
        name: identity.name ?? name,
        headline: identity.headline ?? headline,
        role: identity.role ?? headline,
      },
      text: text.slice(0, PROFILE_EXCERPT_CHARS),
    };
  } catch (error) {
    logger.warn(`${log} The profile service failed`, {
      profileUrl,
      error: describeError(error),
      ...run,
    });
    return read;
  }
}

/**
 * Who holds this profile, as far as anything outside LinkedIn can tell: the
 * index, and the profile service only on a thin index.
 */
export async function readProfile(
  args: ReadOptions & { slug: string; search: (query: string) => Promise<SearchHit[]> },
): Promise<ProfileRead> {
  const index = await readProfileIndex(args);
  return isThin(index.identity) ? readProfilePage(index, args) : index;
}

/** A first line reading `Label: value` marks the labelled record the hosted
 *  reader writes. Plain text never opens that way, because its first line is a
 *  person's name. The labels are that reader's own field names, not LinkedIn's
 *  words, so they do not vary with the profile's language. */
const LABELLED_LINE = /^[\p{L} ]{1,30}:\s/u;

/** The name and headline in either form the service returns: plain lines, which
 *  open with the two of them, or a labelled record, where a field left empty is
 *  simply missing and so the next line must not be taken for it. */
function readProfileLines(text: string): { name: string | null; headline: string | null } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!LABELLED_LINE.test(lines[0] ?? '')) return { name: lines[0] ?? null, headline: lines[1] ?? null };
  const field = (label: string) =>
    lines.find((line) => line.startsWith(`${label}:`))?.slice(label.length + 1).trim() || null;
  return { name: field('Name'), headline: field('Position') };
}

/** The profile as a block of prompt: the address that anchors identity, what
 *  the index said about who holds it, and the profile's own words when they
 *  were read. */
export function describeProfile(read: ProfileRead): string {
  const { identity } = read;
  return [
    read.profileUrl,
    identity.name ? `Name: ${identity.name}` : null,
    identity.headline ? `Headline: ${identity.headline}` : null,
    identity.organisation ? `Organisation: ${identity.organisation}` : null,
    identity.location ? `Location: ${identity.location}` : null,
    read.indexText ? `What the search index says about them: ${read.indexText}` : null,
    read.text ? `\nThe profile's own text:\n${read.text}` : null,
    !identity.name && !read.text ? 'Nothing could be read about who holds it.' : null,
  ]
    .filter((line): line is string => line != null)
    .join('\n');
}
