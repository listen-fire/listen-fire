// linkedin-research — what a person is probably up to, from their address.
//
// The mirror image of `linkedin-enrichment`, which runs name-in / address-out.
// This one starts from the address, which is the identity anchor: whoever
// holds that profile is the person, so there is no namesake problem at the
// first step, only a freshness one. Everything after it is a namesake problem,
// which the acceptance rule answers — a search result is attributed to the
// person only when it is consistent with their own headline.
//
// The whole job of "find out what this person is doing" lives inside the
// plugin, synthesis included, so an author names it once in `through [ … ]`
// and gets an answer per person rather than a pile of search results to
// prompt over.
//
// Budget, acceptance rule and stop condition are fixed contracts, not author
// knobs: six searches, two fetches, two model calls, three minutes. Spending
// the budget without finding anything consistent returns nothing at all —
// the pipeline skips a stage whose plugins found nothing, and absent fields
// are the honest answer where no public signal exists.

import { z } from 'zod';

import { services } from '../../../../adapters/registry';
import { MINUTE, SECOND } from '../../../../constants';
import { anthropicChat, anthropicChatStructured } from '../../../../lib/anthropic';
import { DocumentSourceService } from '../../../../lib/document_sources';
import { runFields } from '../../../../lib/llm_usage';
import { parseJson } from '../../../../lib/utils/parse_json';
import { looksLikeNonHtmlAddress } from '../../../../lib/utils/url';
import { logger } from '../../../logger';
import { WebSearchService } from '../../../web_search';
import { resolvePersonContext } from './extracted_fields';
import { describeError, fetchWithTimeout } from './fetch_resource';
import { LINKEDIN_RESEARCH_HANDBOOK_SECTION } from './linkedin_research_handbook_section';
import { importIdentifier } from '../../movement/schema_projection';
import type { ResolvedField } from './extracted_fields';
import type { PluginManifest, TransformImpl, TransformOutput } from './registry';
import type { TransformSignature } from '../../types';

// ── Signature ─────────────────────────────────────────────────────────────

export const LINKEDIN_RESEARCH_SIGNATURE: TransformSignature = {
  name: 'linkedin-research',
  description:
    "From a LinkedIn profile address, research what that person is currently doing — their role, their organisation, and their recent public activity — and attach a summary, a confidence, and the sources it rests on.",
  params: [
    {
      name: 'url',
      type: { kind: 'string' },
      required: true,
      description:
        'The LinkedIn profile address of the person to research. Normally a field an earlier ' +
        'stage extracted, so each person is researched from their own address.',
    },
  ],
  // The address comes from the fields the enclosing extract has produced, and
  // the record's other fields are the extra search terms, so this only makes
  // sense as a stage of an extraction.
  dataDependency: 'extracted_context',
  // Searches, fetches pages, and asks two models — the planner and the one
  // that writes the answer.
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      activity_summary: { kind: 'string' },
      activity_confidence: { kind: 'string' },
      current_role: { kind: 'string' },
      current_organisation: { kind: 'string' },
      activity_sources: { kind: 'string' },
    },
  },
};

export const LINKEDIN_RESEARCH_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: LINKEDIN_RESEARCH_SIGNATURE.name,
  importName: importIdentifier(LINKEDIN_RESEARCH_SIGNATURE.name),
  displayName: 'LinkedIn activity',
  description:
    'Takes a person’s LinkedIn address and researches what they are currently ' +
    'doing — the role and organisation their profile shows, plus recent public ' +
    'activity found on the web — and writes it up with a confidence and its sources.',
  params: LINKEDIN_RESEARCH_SIGNATURE.params,
  contextAdditions:
    'Adds five fields to the record it runs on: a written summary of what the ' +
    'person appears to be doing, how confident that reading is, the role and ' +
    'organisation it read, and the addresses the summary cites. Adds nothing ' +
    'at all when no public signal consistent with the profile exists.',
  additions: LINKEDIN_RESEARCH_SIGNATURE.additions,
  handbookSection: LINKEDIN_RESEARCH_HANDBOOK_SECTION,
};

// ── Budget ────────────────────────────────────────────────────────────────

/** At most six searches: two to establish identity, three for activity, one
 *  for the organisation. Two fetches. Two model calls. */
const MAX_ACTIVITY_QUERIES = 3;
const MAX_FETCHES = 2;

/** How long a fetched page is worth reading. The synthesiser sees an excerpt
 *  of each page, never the whole thing — the answer is a paragraph. */
const PAGE_EXCERPT_CHARS = 4000;

/** The shared fetch plumbing's own backstop is seven minutes, which is the
 *  right patience for a deck behind a login and far too much for one of two
 *  supporting pages inside a three-minute budget. */
const PAGE_FETCH_TIMEOUT_MS = 20 * SECOND;

/** The profile service collects asynchronously, so waiting is the whole cost.
 *  This is only spent when the index gave a thin headline, and it has to fit
 *  inside the wall clock alongside the searches. */
const PROFILE_WAIT_MS = 75 * SECOND;

/** After this the plugin issues no new external work and writes up what it
 *  has. The profile service wait counts toward it. */
const WALL_CLOCK_MS = 3 * MINUTE;

/** What people write where an employer would go. Anchoring a search on one of
 *  these searches for the placeholder rather than for a company: "Stealth
 *  Startup" is thousands of unrelated people's answer to the same question, so
 *  every result is a namesake and every page fetched is wasted. Kept short and
 *  literal — a longer list starts discarding real companies. */
const PLACEHOLDER_ORGANISATIONS = new Set([
  'stealth',
  'stealth startup',
  'stealth mode',
  'confidential',
  'self employed',
  'independent',
  'freelance',
  'n/a',
  // Not an employer at all: it is the trailing segment of the index's own
  // title, and reading it as a company sends every query after the site
  // rather than after the person.
  'linkedin',
]);

const AGGREGATOR_SITES = [
  'site:crunchbase.com',
  'site:dealroom.co',
  'site:theorg.com',
  'site:cbinsights.com',
].join(' OR ');

const LOG = '[transform:linkedin-research]';

// ── The address ───────────────────────────────────────────────────────────

const PROFILE_SLUG_REGEX =
  /^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/in\/([^/?#\s]+)/i;

/** The slug the address anchors on, or null when it is not a profile address
 *  at all. A company page, a post, a bare name: nothing to research from. */
function profileSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = PROFILE_SLUG_REGEX.exec(value.trim());
  if (!match) return null;
  const slug = decodeURIComponent(match[1]).trim();
  return slug ? slug : null;
}

function canonicalProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

function isLinkedInLink(link: string): boolean {
  return /(?:^|\/\/|\.)linkedin\.com\//i.test(link);
}

// ── Identity, from the index ──────────────────────────────────────────────

interface Identity {
  name: string | null;
  headline: string | null;
  role: string | null;
  organisation: string | null;
  /** The profile text, when the service was asked for it. */
  profileText: string | null;
}

/** A LinkedIn result's title reads "Name - Headline - Organisation | LinkedIn"
 *  in most vintages, and something else in the rest, so this is best effort:
 *  the first segment is the name, whatever follows is the headline, and a
 *  third segment is the organisation often enough to be worth taking.
 *
 *  The site's own name is never one of those segments, whichever punctuation
 *  the index used to append it — current vintages write "- LinkedIn" as often
 *  as "| LinkedIn", and taking that last segment for an employer is how a
 *  research run ends up searching Crunchbase for "LinkedIn". */
function readTitle(title: string): Pick<Identity, 'name' | 'headline' | 'role' | 'organisation'> {
  const stripped = title.replace(/\s*[|\-–—]\s*LinkedIn\s*$/i, '').trim();
  const parts = stripped
    .split(/\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const [name, ...rest] = parts;
  return {
    name: name ?? null,
    headline: rest.length ? rest.join(' - ') : null,
    role: rest[0] ?? null,
    organisation: rest.length > 1 ? rest[rest.length - 1] : null,
  };
}

/** Thin means the index told us nothing to check a search result against —
 *  no role and no organisation — which is exactly when the profile service
 *  is worth its wait. */
function isThin(identity: Identity): boolean {
  return !identity.role && !identity.organisation;
}

type SearchHit = { title: string; snippet: string; link: string };

// ── What makes a query, or a result, about this person ────────────────────

/** The organisation as something to search for, or null when the headline
 *  named a placeholder rather than an organisation. */
function distinctiveOrganisation(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const normalised = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
  if (!normalised) return null;
  // "Stealth", "Stealth Startup", "Stealth mode company" — one non-answer.
  if (normalised.startsWith('stealth')) return null;
  return PLACEHOLDER_ORGANISATIONS.has(normalised) ? null : trimmed;
}

/** The terms that make a query or a result about THIS person rather than about
 *  their subject in general: their name, their surname on its own — a page's
 *  title carries the surname alone often enough to matter — and their
 *  organisation, when they have a distinctive one. */
interface Anchors {
  name: string[];
  organisation: string[];
}

function anchorsOf(identity: Identity, organisation: string | null): Anchors {
  const name = identity.name?.trim();
  const parts = name ? name.split(/\s+/) : [];
  return {
    name: name ? (parts.length > 1 ? [name, parts[parts.length - 1]] : [name]) : [],
    organisation: organisation ? [organisation] : [],
  };
}

function containsAnchor(text: string, anchors: Anchors): boolean {
  const haystack = text.toLowerCase();
  return [...anchors.name, ...anchors.organisation].some((term) =>
    haystack.includes(term.toLowerCase()),
  );
}

/** Whether loading this result could tell us anything about the person at all:
 *  its title or snippet has to name them or their organisation. A result that
 *  names neither cannot enrich them however promising the query was, and
 *  reading it costs a paid fetch, a fifth of the wall clock, and the risk of a
 *  stranger's page colouring the answer. It stays as a snippet, which the
 *  synthesiser is free to ignore. */
function canEnrich(hit: SearchHit, anchors: Anchors): boolean {
  return containsAnchor(`${hit.title} ${hit.snippet}`, anchors);
}

/** Why this address must not be opened, or null when it is a page.
 *
 *  The plugin reads pages through the shared fetch, and that path routes a
 *  document address into the document pipeline — download to disk, upload to
 *  storage, then OCR — before the scraper's own file guard is ever reached. A
 *  plugin researching a person has no use for a PDF of a race result, a
 *  conference paper or a sixty-megabyte annual report, and no business paying
 *  to store one, so the address is declined here rather than downstream. */
function unreadableAddress(link: string): string | null {
  if (DocumentSourceService.isSupportedUrl(link)) return 'a document source, not a page';
  if (looksLikeNonHtmlAddress(link)) return 'an address that names a file';
  return null;
}

// ── The two model calls ───────────────────────────────────────────────────

const planSchema = z.object({
  organisation: z.string().nullish(),
  queries: z
    .array(
      z.union([
        z.string(),
        z.object({ query: z.string(), worth_reading: z.boolean().optional() }),
      ]),
    )
    .optional(),
  terms: z.array(z.string()).optional(),
});

type PlannedQuery = { query: string; worthReading: boolean };

/** Every field required, `found: false` carrying empty ones: a forced tool
 *  call has to fill the shape it is given, and "found nothing" is an answer
 *  rather than an absence. */
const synthesisSchema = z.object({
  found: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  current_role: z.string(),
  current_organisation: z.string(),
  summary: z.string(),
  sources: z.array(z.string()),
});

const PLANNER_SYSTEM = `You are planning web searches to find out what a specific person is doing NOW.

You are given who they are, taken from their LinkedIn profile, and any other fields the record about them carries.

Return ONLY valid JSON, no markdown, with:
- "queries": at most 3 search queries aimed at RECENT activity. Between them cover: posts and articles under the person's name; press, funding or launch announcements naming them; event, podcast or conference appearances; pages of their organisation that list them. Quote the person's name. Do not search for their LinkedIn profile — we already have it. Each entry is an object: { "query": "...", "worth_reading": true|false } where worth_reading says whether a result from this query is likely to repay loading the whole page rather than reading its snippet.
- "terms": the 2 or 3 terms from the headline — the organisation, the field, the location — that a search result must be consistent with to be about THIS person and not a namesake.
- "organisation": the organisation the headline names, "" if it names none. A LinkedIn headline often reads as one phrase rather than segments, so this is where the organisation is read out of it.

A headline saying "Stealth", "Stealth Startup", "Stealth Mode", "Confidential", "Self-employed", "Independent" or "Freelance" names no organisation: it is what someone writes when they will not say where they work. Report "" for "organisation" in that case, never search for the placeholder as if it were a company, and do not use it as a consistency term. Every query must name the person, or a real organisation they are attached to.`;

const SYNTHESIS_SYSTEM = `You are writing a short, honest account of what one person is currently doing, from their LinkedIn headline and a set of web search results.

THE ACCEPTANCE RULE. Attribute a result to this person only if it is consistent with the consistency terms you are given — the organisation, the field, or the location from their own headline. A result that merely matches the name is a namesake's news and must be excluded. If the evidence is thin, say it is thin; never pad the answer.

Report your answer through the tool. Every field is required; when nothing survives the acceptance rule, report found = false with empty strings and an empty source list.

- "found": true only if at least one source consistent with the headline was found.
- "confidence": "high" when the headline and at least two independent recent sources agree; "medium" when the headline plus one recent source agree, or when several sources agree but nothing is dated within about a year; "low" when you have the headline only, or sources that are consistent but thin.
- "current_role" and "current_organisation": as you read them, "" when unknown.
- "summary": the answer, in prose. Their current role and organisation, what they appear to be doing or building now, recent notable activity with dates where you know them, and an explicit hedge where the public record ends ("appears to be starting something in X, unconfirmed"). Cite every claim with a bracketed number, [1], [2].
- "sources": the addresses your citations refer to, in citation order.

A bracketed number is a position in the "sources" list YOU build, counting from 1 — never the position of a result in the list you were given. Every number in the summary must have an entry in "sources", and every entry must be cited.`;

// ── Public run ────────────────────────────────────────────────────────────

export const linkedinResearchImpl: TransformImpl = {
  signature: LINKEDIN_RESEARCH_SIGNATURE,
  run: async (input): Promise<TransformOutput> => {
    if (input.kind !== 'context-dependent') {
      throw new Error(`linkedin-research: expected context-dependent input, got ${input.kind}`);
    }

    const run = runFields();
    const deadline = Date.now() + WALL_CLOCK_MS;
    const budgetLeft = () => Date.now() < deadline;

    const slug = profileSlug(input.config.url);
    if (!slug) {
      logger.info(`${LOG} Not a profile address — nothing to research`, {
        value: typeof input.config.url === 'string' ? input.config.url : typeof input.config.url,
        ...run,
      });
      return {};
    }
    const profileUrl = canonicalProfileUrl(slug);

    // Ancestor context is deliberately dropped: a company's fields are not
    // this person's, and feeding them in is how a colleague's news ends up in
    // someone else's summary.
    const ownFields = resolvePersonContext(input.extractedContext).own;

    // ── 1. Identity from the index ────────────────────────────────────────
    const identity = await identityFromIndex(slug, profileUrl, run);

    // ── 2. The profile service, only when the index came back thin ────────
    let profileServiceRan = false;
    if (isThin(identity) && services.linkedin && budgetLeft()) {
      profileServiceRan = true;
      await readProfile(profileUrl, identity, run);
    }

    const thinAfterIdentity = isThin(identity);
    if (!identity.name && thinAfterIdentity) {
      logger.info(`${LOG} No identity established — giving up before planning`, {
        slug,
        profileServiceRan,
        ...run,
      });
      return {};
    }

    // ── 3. Plan and run the activity queries ──────────────────────────────
    const plan = budgetLeft()
      ? await planQueries(identity, ownFields, run)
      : { queries: [] as PlannedQuery[], terms: [] as string[], organisation: null };

    // The organisation the headline names is reported and given to the
    // synthesiser as it stands; only a distinctive one is something to search
    // for, and only a distinctive one tells a result apart from a stranger's.
    const organisation = identity.organisation ?? plan.organisation;
    const searchableOrganisation = distinctiveOrganisation(organisation);
    const anchors = anchorsOf(identity, searchableOrganisation);

    const hits: SearchHit[] = [];
    const fetchCandidates: string[] = [];
    const considerReading = (link: string) => {
      const unreadable = unreadableAddress(link);
      if (unreadable) {
        logger.info(`${LOG} Skipped a result that is not a page`, {
          url: link,
          reason: unreadable,
          ...run,
        });
        return;
      }
      fetchCandidates.push(link);
    };
    let activitySearches = 0;
    for (const planned of plan.queries.slice(0, MAX_ACTIVITY_QUERIES)) {
      if (!budgetLeft()) break;
      // A query naming neither the person nor a real organisation searches for
      // the topic, not for them — every result it returns is somebody else's.
      if (!containsAnchor(planned.query, anchors)) {
        logger.info(`${LOG} Dropped a query with nothing distinctive in it`, {
          query: planned.query,
          ...run,
        });
        continue;
      }
      activitySearches += 1;
      const results = await runSearch(planned.query, run);
      for (const hit of results) {
        if (!addHit(hits, hit)) continue;
        // Loading a page costs a large part of the wall clock, so a result
        // that already fails the acceptance rule is read as a snippet and
        // never opened: a namesake's page is not worth twenty seconds.
        if (
          planned.worthReading &&
          !isLinkedInLink(hit.link) &&
          isConsistent(hit, plan.terms) &&
          canEnrich(hit, anchors)
        ) {
          considerReading(hit.link);
        }
      }
    }

    // ── 4. Expand the organisation, then read the best two pages ──────────
    let organisationSearched = false;
    if (searchableOrganisation && budgetLeft()) {
      organisationSearched = true;
      const results = await runSearch(`"${searchableOrganisation}" ${AGGREGATOR_SITES}`, run);
      for (const hit of results) {
        if (!isConsistent(hit, plan.terms)) continue;
        if (addHit(hits, hit) && !isLinkedInLink(hit.link) && canEnrich(hit, anchors)) {
          considerReading(hit.link);
        }
      }
    }

    const excerpts: Array<{ url: string; text: string }> = [];
    for (const url of fetchCandidates) {
      if (excerpts.length >= MAX_FETCHES || !budgetLeft()) break;
      const text = await fetchExcerpt(url, run);
      if (text) excerpts.push({ url, text });
    }

    // ── 5. Synthesise ─────────────────────────────────────────────────────
    if (hits.length === 0 && thinAfterIdentity) {
      logger.info(`${LOG} Nothing to synthesise from`, { slug, profileServiceRan, ...run });
      return {};
    }

    const synthesis = await synthesise({
      identity,
      profileUrl,
      organisation,
      terms: plan.terms,
      ownFields,
      hits,
      excerpts,
      run,
    });

    if (!synthesis?.found || !synthesis.summary.trim()) {
      logger.info(`${LOG} Nothing consistent with the headline — attaching nothing`, {
        slug,
        searches: identity.searches + activitySearches + (organisationSearched ? 1 : 0),
        results: hits.length,
        profileServiceRan,
        ...run,
      });
      return {};
    }

    // The index alone cannot support more than a hedge, however many results
    // agreed with it: what they agreed with was two words of stale headline.
    const confidence = thinAfterIdentity ? 'low' : synthesis.confidence;
    const sources = synthesis.sources.filter((s) => s.trim());

    logger.info(`${LOG} Researched`, {
      slug,
      profileServiceRan,
      searches: identity.searches + activitySearches + (organisationSearched ? 1 : 0),
      results: hits.length,
      fetched: excerpts.length,
      confidence,
      sourceCount: sources.length,
      ...run,
    });

    return {
      properties: {
        activity_summary: synthesis.summary.trim(),
        activity_confidence: confidence,
        current_role: synthesis.current_role.trim() || identity.role || '',
        current_organisation: synthesis.current_organisation.trim() || organisation || '',
        activity_sources: sources.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      },
    };
  },
};

// ── Steps ─────────────────────────────────────────────────────────────────

/**
 * Ask the index about the address itself, then — if nothing it returned is
 * actually that profile — about the slug. Two searches at most, and the second
 * only buys anything when the first found the person's name attached to
 * somebody else's page.
 */
async function identityFromIndex(
  slug: string,
  profileUrl: string,
  run: Record<string, unknown>,
): Promise<Identity & { searches: number }> {
  const blank: Identity & { searches: number } = {
    name: null,
    headline: null,
    role: null,
    organisation: null,
    profileText: null,
    searches: 0,
  };

  for (const query of [profileUrl, `site:linkedin.com/in/${slug}`]) {
    blank.searches += 1;
    const results = await runSearch(query, run);
    const match = results.find((r) => matchesSlug(r.link, slug));
    if (!match) continue;
    const read = readTitle(match.title);
    logger.info(`${LOG} Identity from the index`, {
      slug,
      name: read.name,
      headline: read.headline,
      ...run,
    });
    return { ...blank, ...read };
  }

  logger.info(`${LOG} The index knows nothing about this address`, { slug, ...run });
  return blank;
}

function matchesSlug(link: string, slug: string): boolean {
  const linked = profileSlug(link);
  return linked != null && linked.toLowerCase() === slug.toLowerCase();
}

/**
 * Read the profile itself. Only reached when the index gave nothing to check a
 * result against, because it costs a paid fetch and up to its whole wait. The
 * text's first lines are the name and headline in every vintage the service
 * returns, so that is where identity comes from; the rest goes to the
 * synthesiser as evidence.
 */
async function readProfile(
  profileUrl: string,
  identity: Identity,
  run: Record<string, unknown>,
): Promise<void> {
  try {
    const profile = await services.linkedin?.getProfileTextByUrl(profileUrl, {
      maxWaitMs: PROFILE_WAIT_MS,
    });
    const text = profile?.text?.trim();
    if (!text) {
      logger.info(`${LOG} The profile service had nothing`, { profileUrl, ...run });
      return;
    }
    identity.profileText = text.slice(0, PAGE_EXCERPT_CHARS);
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    identity.name ??= lines[0] ?? null;
    const headline = lines[1] ?? null;
    identity.headline ??= headline;
    identity.role ??= headline;
    logger.info(`${LOG} Read the profile`, { profileUrl, chars: text.length, ...run });
  } catch (error) {
    logger.warn(`${LOG} The profile service failed`, {
      profileUrl,
      error: describeError(error),
      ...run,
    });
  }
}

async function planQueries(
  identity: Identity,
  ownFields: ResolvedField[],
  run: Record<string, unknown>,
): Promise<{ queries: PlannedQuery[]; terms: string[]; organisation: string | null }> {
  const empty = { queries: [] as PlannedQuery[], terms: [] as string[], organisation: null };
  const userMessage = [
    `Name: ${identity.name ?? 'unknown'}`,
    `Headline: ${identity.headline ?? 'unknown'}`,
    `Organisation: ${identity.organisation ?? 'unknown'}`,
    ownFields.length
      ? `Other fields on the record about them:\n${describeFields(ownFields)}`
      : 'No other fields on the record about them.',
  ].join('\n');

  try {
    const raw = await anthropicChat({
      system: PLANNER_SYSTEM,
      userMessage,
      model: 'claude-haiku-4-5-20251001',
      label: 'plugin_linkedin_research_plan',
    });
    const parsed = readReply(raw, planSchema, 'The query planner', run);
    if (!parsed) return empty;
    const queries = (parsed.queries ?? [])
      .map((q) =>
        typeof q === 'string'
          ? { query: q, worthReading: false }
          : { query: q.query, worthReading: q.worth_reading ?? false },
      )
      .filter((q) => q.query.trim());
    return {
      queries,
      // A placeholder is no consistency term either: "stealth" in a snippet says
      // nothing about whose news it is.
      terms: (parsed.terms ?? []).filter((t) => distinctiveOrganisation(t) !== null),
      organisation: parsed.organisation?.trim() || null,
    };
  } catch (error) {
    logger.warn(`${LOG} The query planner failed`, { error: describeError(error), ...run });
    return empty;
  }
}

async function synthesise(args: {
  identity: Identity;
  profileUrl: string;
  organisation: string | null;
  terms: string[];
  ownFields: ResolvedField[];
  hits: SearchHit[];
  excerpts: Array<{ url: string; text: string }>;
  run: Record<string, unknown>;
}): Promise<z.infer<typeof synthesisSchema> | null> {
  const { identity, profileUrl, organisation, terms, ownFields, hits, excerpts, run } = args;
  const userMessage = [
    `Profile address: ${profileUrl}`,
    `Name: ${identity.name ?? 'unknown'}`,
    `Headline: ${identity.headline ?? 'unknown'}`,
    `Organisation as read from the headline: ${organisation ?? 'unknown'}`,
    `Consistency terms (the acceptance rule): ${terms.length ? terms.join(', ') : 'the headline above'}`,
    identity.profileText ? `Profile page:\n${identity.profileText}` : null,
    ownFields.length ? `Fields on the record about them:\n${describeFields(ownFields)}` : null,
    hits.length
      ? `Search results:\n${hits
          .map((h) => `- ${h.title}\n  ${h.link}\n  ${h.snippet}`)
          .join('\n')}`
      : 'No search results.',
    excerpts.length
      ? `Pages read in full:\n${excerpts.map((e) => `${e.url}\n${e.text}`).join('\n\n')}`
      : null,
  ]
    .filter((part): part is string => part != null)
    .join('\n\n');

  try {
    // A forced tool call, not free text asked to be JSON. The summary is most
    // of a paragraph of prose inside a JSON string, and a live run showed the
    // model closing that string with a stray bracket — a whole answer thrown
    // away over one character. The tool's schema is the shape, so there is
    // nothing left to mis-punctuate. (It also settles the prefill question:
    // there is no assistant turn to prefill, which Sonnet 5 rejects anyway.)
    return await anthropicChatStructured({
      system: SYNTHESIS_SYSTEM,
      userMessage,
      schema: synthesisSchema,
      toolName: 'report_activity',
      toolDescription: 'Report what this person is currently doing, with a confidence and the sources it rests on.',
      model: 'claude-sonnet-5',
      label: 'plugin_linkedin_research_synthesise',
    });
  } catch (error) {
    logger.warn(`${LOG} The synthesis failed`, { error: describeError(error), ...run });
    return null;
  }
}

// ── Shared plumbing ───────────────────────────────────────────────────────

/** A model's reply as the value the plugin asked for, or null. Both failures
 *  log the reply itself: "the synthesiser returned nothing usable" is not a
 *  thing anyone can act on without seeing what it did return. */
function readReply<T>(
  raw: string,
  schema: z.ZodType<T>,
  what: string,
  run: Record<string, unknown>,
): T | null {
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    logger.warn(`${LOG} ${what} did not return JSON`, { raw, error: describeError(error), ...run });
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    logger.warn(`${LOG} ${what} returned an unexpected shape`, {
      raw,
      issues: result.error.issues,
      ...run,
    });
    return null;
  }
  return result.data;
}

function describeFields(fields: ResolvedField[]): string {
  return fields.map((f) => `  ${f.label}: ${f.value}`).join('\n');
}

/** Append a hit unless its address is already held. Returns whether it is new,
 *  so the caller can decide about fetching exactly once per address. */
function addHit(hits: SearchHit[], hit: SearchHit): boolean {
  if (hits.some((h) => h.link === hit.link)) return false;
  hits.push(hit);
  return true;
}

/** The acceptance rule, applied where we can apply it ourselves: an
 *  aggregator page about some other organisation of the same name is a
 *  namesake by another route. The synthesiser applies the rule again over
 *  everything, in prose, where the judgement is less mechanical. */
function isConsistent(hit: SearchHit, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

async function runSearch(query: string, run: Record<string, unknown>): Promise<SearchHit[]> {
  try {
    const results = await WebSearchService.search(query);
    const hits = (results.items ?? []).flatMap((item) =>
      item.link ? [{ title: item.title ?? '', snippet: item.snippet ?? '', link: item.link }] : [],
    );
    logger.info(`${LOG} Searched`, { query, results: hits.length, ...run });
    return hits;
  } catch (error) {
    logger.warn(`${LOG} A search failed`, { query, error: describeError(error), ...run });
    return [];
  }
}

/**
 * Load one supporting page. The shared plumbing's backstop is minutes long,
 * which is the wrong patience here — two supporting pages inside a
 * three-minute budget are worth twenty seconds each and no more — so the wait
 * is bounded again on top of it.
 */
async function fetchExcerpt(url: string, run: Record<string, unknown>): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const abandon = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.info(`${LOG} Gave up on a page`, { url, timeoutMs: PAGE_FETCH_TIMEOUT_MS, ...run });
      resolve(null);
    }, PAGE_FETCH_TIMEOUT_MS);
  });
  try {
    const fetched = await Promise.race([fetchWithTimeout(url, null), abandon]);
    const content = fetched?.content?.trim();
    if (!content) return null;
    logger.info(`${LOG} Read a page`, { url, chars: content.length, ...run });
    return content.slice(0, PAGE_EXCERPT_CHARS);
  } catch (error) {
    logger.warn(`${LOG} A page failed to load`, { url, error: describeError(error), ...run });
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
