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
// knobs: four searches at most, the identity ones included, two fetches, three
// planner calls, one writing call, three minutes. Searches are the scarce part:
// the search zone accepts about fourteen a minute across every run in the
// process, so each one a profile spends is time another profile waits. Spending
// the budget without finding one passage that names the person and a
// consistency term returns nothing at all — the pipeline skips a stage whose
// plugins found nothing, and absent fields are the honest answer where no public
// signal exists. Passages found with no account written from them come back on
// their own, as `activity_text` alone: the caller asked for what the web says,
// and the writing model declining to conclude does not make the text any less
// there. No confidence and no summary go with it, so a program that never reads
// `activity_text` sees what it saw before this field existed.
//
// What the caller already knows about the person arrives as `context`. It steers
// the searches and is never evidence: the writing model does not see it, and a
// result must still name the person. The planner may take consistency terms from
// it, which is what it is for, and may let it settle that the person is tied
// down, but the organisation the planner reports must come from the headline, the
// index or the profile, so the context alone can never name where someone works.
//
// A location ties nobody down, since everyone who lives there shares it. It is
// kept out of the consistency terms, and the writing model gets it on a line of
// its own as support for a result that matches a term, never as a reason to
// accept one.

import { z } from 'zod';

import type { ResolvedField } from './extracted_fields';
import type { PluginOutput, WebPlugin } from './plugin';
import type { Anchors, SearchHit } from './search_hygiene';
import type { ProfileIdentity } from './linkedin_identity';
import type { ProfileRead } from './research/profile_read';

import { parseJson } from '@listen-fire/anthropic';
import { describeError, looksLikeNonHtmlAddress } from './addresses';
import { resolvePersonContext } from './extracted_fields';
import { anthropicChat, anthropicChatStructured, logger, MINUTE, runFields, SECOND, tools } from './tools';
import {
  addHit,
  containsAnchor,
  distinctiveOrganisation,
  isConsistent,
  runSearch,
} from './search_hygiene';
import {
  belongsToAnotherProfile,
  belongsToProfile,
  isLinkedInLink,
  isThin,
  matchesSlug,
  profileSlug,
} from './linkedin_identity';
import { readProfileIndex, readProfilePage } from './research/profile_read';
import { LINKEDIN_RESEARCH_PLUGIN } from 'movement-engine/public/plugins';


// ── Budget ────────────────────────────────────────────────────────────────

/** At most four searches: one to establish identity (a second only when the
 *  first did not turn up the profile), up to two for activity, one retry when
 *  those found nothing that names the person with a consistency term, and one
 *  for the organisation only when a search is left and nothing has said anything
 *  about it. Two fetches. Three planner calls at most: the first plan, a second
 *  with the profile text, and the retry. One writing call. */
const MAX_SEARCHES = 4;
const MAX_ACTIVITY_QUERIES = 2;
const MAX_FETCHES = 2;

/** How long a fetched page is worth reading. The synthesiser sees an excerpt
 *  of each page, never the whole thing — the answer is a paragraph. */
const PAGE_EXCERPT_CHARS = 4000;

/** The shared fetch plumbing's own backstop is seven minutes, which is the
 *  right patience for a deck behind a login and far too much for one of two
 *  supporting pages inside a three-minute budget. */
const PAGE_FETCH_TIMEOUT_MS = 20 * SECOND;

/** The planner is the cheap model, and a whole email thread as context would
 *  make it the expensive call. */
const CONTEXT_CHARS = 2000;

/** Long enough for a caller to read what a page says about the person, short
 *  enough that one page cannot fill `activity_text`. */
const PASSAGE_CHARS = 800;
const ACTIVITY_TEXT_CHARS = 3000;

/** After this the plugin issues no new external work and writes up what it
 *  has. The profile service wait counts toward it. */
const WALL_CLOCK_MS = 3 * MINUTE;

const AGGREGATOR_SITES = [
  'site:crunchbase.com',
  'site:dealroom.co',
  'site:theorg.com',
  'site:cbinsights.com',
].join(' OR ');

const LOG = '[transform:linkedin-research]';

// ── What makes a query, or a result, about this person ────────────────────

/** The name without the decoration a LinkedIn name carries ("Dr. Jane Doe, PhD
 *  (she/her)"). Nobody searches for or writes about the decorated form, so a
 *  comparison against it would miss every result about them. */
function bareName(name: string): string {
  return name
    .replace(/\(.*?\)|,.*$/g, ' ')
    .trim()
    .replace(/^(?:\S+\.\s+)+(?=\S+\s)/, '');
}

/** The terms that make a query or a result about THIS person rather than about
 *  their subject in general: their name, their surname on its own — a page's
 *  title carries the surname alone often enough to matter — and their
 *  organisation, when they have a distinctive one. */
function anchorsOf(identity: ProfileIdentity, organisation: string | null): Anchors {
  const name = identity.name ? bareName(identity.name) : null;
  const parts = name ? name.split(/\s+/) : [];
  return [
    ...(name ? (parts.length > 1 ? [name, parts[parts.length - 1]] : [name]) : []),
    ...(organisation ? [organisation] : []),
  ];
}

/** Text as words a comparison can trust: no accents, no case, no punctuation,
 *  and a space at each end so that a term only ever matches whole words. "AI"
 *  must not be found in "said". */
function comparable(text: string): string {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return ` ${words} `;
}

function wordsOf(text: string): string[] {
  return comparable(text).split(' ').filter(Boolean);
}

/** Whether a text names this person, in full rather than by surname: this rule
 *  decides what is handed back as being about them, where a surname is what
 *  every namesake shares. Tolerates one word between the two names. */
function namesPerson(text: string, name: string | null): boolean {
  if (!name) return false;
  const words = wordsOf(bareName(name));
  const first = words[0];
  const last = words[words.length - 1];
  if (!first || !last) return false;
  const haystack = comparable(text);
  if (first === last) return haystack.includes(` ${first} `);
  return new RegExp(` ${first} (?:\\S+ )?${last} `, 'u').test(haystack);
}

/** The rule for a passage: it names the person and a consistency term, in the
 *  same stretch of text. With no terms nothing can pass, unlike `isConsistent`,
 *  because here there is no model downstream to catch a namesake. */
function namesPersonAndTerm(text: string, name: string | null, terms: string[]): boolean {
  if (!namesPerson(text, name)) return false;
  const haystack = comparable(text);
  return terms.some((term) => term.trim() && haystack.includes(comparable(term)));
}

/** Whether a query has nothing to search on but the person's name and where they
 *  live, which finds everyone of that name who lives there. Only a location the
 *  title gave can be checked here; the planner's prompt covers the rest. */
function searchesOnLocationAlone(query: string, identity: ProfileIdentity): boolean {
  if (!identity.location) return false;
  const place = new Set(wordsOf(identity.location));
  const name = new Set(wordsOf(identity.name ?? ''));
  const rest = wordsOf(query).filter((word) => !name.has(word));
  return rest.length > 0 && rest.every((word) => place.has(word));
}

/** Whether a term is only the place the title gave. A place says where someone
 *  is and not who, so it can never be what makes a passage theirs. */
function namesLocation(term: string, identity: ProfileIdentity): boolean {
  if (!identity.location) return false;
  const place = new Set(wordsOf(identity.location));
  const words = wordsOf(term);
  return words.length > 0 && words.every((word) => place.has(word));
}

/** The organisation the planner reports, unless the caller's text is the only
 *  place it can have come from. The planner is told to read it from the headline,
 *  the index or the profile; this holds it to that, because an organisation the
 *  caller merely mentioned would otherwise be shown to the writer as read from
 *  the headline and come back as where the person works. A name the caller's text
 *  does not contain is kept, since a planner may well write "Acme" for "Acme Inc". */
function organisationFromEvidence(
  organisation: string | null,
  args: { read: ProfileRead; ownFields: ResolvedField[]; context: string },
): string | null {
  if (!organisation) return null;
  const { read, ownFields, context } = args;
  const named = comparable(organisation);
  if (!comparable(context).includes(named)) return organisation;
  const evidence = comparable(
    [
      read.identity.headline,
      read.identity.organisation,
      read.indexText,
      read.text,
      ...ownFields.map((field) => String(field.value)),
    ]
      .filter(Boolean)
      .join(' '),
  );
  return evidence.includes(named) ? organisation : null;
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
  if (tools().isDocumentSource(link)) return 'a document source, not a page';
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
  tied_down: z.boolean().optional(),
});

type PlannedQuery = { query: string; worthReading: boolean };

interface Plan {
  queries: PlannedQuery[];
  terms: string[];
  organisation: string | null;
  /** The planner's judgement that something ties this person down. A word list
   *  could not make this call across LinkedIn's languages. */
  tiedDown: boolean;
}

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

You are given who they are, taken from their LinkedIn profile: what the search index says about them, any other fields the record about them carries, and sometimes text the caller already has about them. The caller's text steers your searches and is not itself evidence about what they are doing.

Return ONLY valid JSON, no markdown, with:
- "queries": up to TWO search queries most likely to surface their RECENT activity — posts and articles under their name, press, funding or launch announcements naming them, event, podcast or conference appearances, pages of their organisation that list them. Write a second only when it covers different ground from the first. Quote the person's name. Do not search for their LinkedIn profile — we already have it. Each entry is an object: { "query": "...", "worth_reading": true|false } where worth_reading says whether a result from this query is likely to repay loading the whole page rather than reading its snippet.
- "terms": the 2 or 3 terms that tie this person down, which a search result must be consistent with to be about THIS person and not a namesake: organisations, schools, specific fields. A location is never a term, because everyone who lives there shares it. Take them from the headline, what the search index says and the caller's text. When those name no organisation and you are given the profile page, take them from the most recent roles it lists instead.
- "organisation": the organisation the headline, what the search index says, or the profile page names, "" if they name none. A LinkedIn headline often reads as one phrase rather than segments, so this is where the organisation is read out of it. Never report one that only the caller's text names: that text steers the searches and says nothing about where this person works.
- "tied_down": true when anything you were given ties this person down to an employer, a school or a field; false otherwise. A location does not count. Whatever you were given may be in any language.

An organisation the caller's text names belongs in a query. A location is never what a query searches on alone: the person's name with a city finds everyone of that name in that city. When you have only a location, quote the name and add words such as founder, talk or interview.

A headline saying "Stealth", "Stealth Startup", "Stealth Mode", "Confidential", "Self-employed", "Independent" or "Freelance" names no organisation: it is what someone writes when they will not say where they work. Report "" for "organisation" in that case, never search for the placeholder as if it were a company, and do not use it as a consistency term. Every query must name the person, or a real organisation they are attached to.

When the headline is such a placeholder and the profile page lists earlier roles, someone in stealth is most often building a successor to what they did last. Search on that history — the person's name with the most recent organisation they founded or led, and words like founder, startup or launch — rather than on the bare name: a bare name finds whoever else holds it.`;

const SYNTHESIS_SYSTEM = `You are writing a short, honest account of what one person is currently doing, from their LinkedIn headline and a set of web search results.

THE ACCEPTANCE RULE. Attribute a result to this person only if it is consistent with the consistency terms you are given — the organisation, the school or the field from their own headline. A result that merely matches the name is a namesake's news and must be excluded. The location is given on its own line: it can support a result that also matches a term, and never suffices alone, because everyone who lives there shares it. If the evidence is thin, say it is thin; never pad the answer.

A result marked "(their own address)" is their own LinkedIn profile or a post of theirs, so it is theirs and the acceptance rule does not apply to it. The profile's own entry says no more than the headline does and never raises the confidence; a post of theirs is a source like any other.

Report your answer through the tool. Every field is required; when nothing survives the acceptance rule, report found = false with empty strings and an empty source list.

- "found": true only if at least one source consistent with the consistency terms was found.
- "confidence": "high" when the headline and at least two independent recent sources agree; "medium" when the headline plus one recent source agree, or when several sources agree but nothing is dated within about a year; "low" when you have the headline only, or sources that are consistent but thin.
- "current_role" and "current_organisation": as you read them, "" when unknown. When the headline is a placeholder ("Stealth", "Self-employed", "Independent") and the profile shows earlier founder, co-founder or CTO roles, report the most recent such venture as a likely guess: "current_organisation" is that venture's name and "current_role" says both, e.g. "Founder, in stealth (previously Co-founder & CTO)".
- "summary": the answer, in prose. In that same placeholder case, lead with the history: "Previously co-founded Acme (industrial drones); now in stealth." Otherwise, their current role and organisation, what they appear to be doing or building now, recent notable activity with dates where you know them, and an explicit hedge where the public record ends ("appears to be starting something in X, unconfirmed"). Cite every claim with a bracketed number, [1], [2].
- "sources": the addresses your citations refer to, in citation order.

A bracketed number is a position in the "sources" list YOU build, counting from 1 — never the position of a result in the list you were given. Every number in the summary must have an entry in "sources", and every entry must be cited.`;

// ── Public run ────────────────────────────────────────────────────────────

export const linkedinResearchPlugin: WebPlugin = {
  declaration: LINKEDIN_RESEARCH_PLUGIN,
  run: async (input): Promise<PluginOutput> => {
    if (input.kind !== 'context-dependent') {
      throw new Error(`linkedin-research: expected context-dependent input, got ${input.kind}`);
    }

    const run = runFields();
    const deadline = Date.now() + WALL_CLOCK_MS;
    const budgetLeft = () => Date.now() < deadline;
    // The profile service waits as long as it is told to, so it is told only
    // what is left: a read started at the last minute must not outrun the deadline.
    const timeLeft = () => Math.max(0, deadline - Date.now());

    const slug = profileSlug(input.config.url);
    if (!slug) {
      logger.info(`${LOG} Not a profile address — nothing to research`, {
        value: typeof input.config.url === 'string' ? input.config.url : typeof input.config.url,
        ...run,
      });
      return {};
    }

    // Ancestor context is deliberately dropped: a company's fields are not
    // this person's, and feeding them in is how a colleague's news ends up in
    // someone else's summary.
    const ownFields = resolvePersonContext(input.extractedContext).own;
    const context =
      typeof input.config.context === 'string' ? input.config.context.trim().slice(0, CONTEXT_CHARS) : '';

    let searches = 0;
    const search = (query: string): Promise<SearchHit[]> => {
      searches += 1;
      return runSearch(query, LOG, run);
    };
    const canSearch = () => searches < MAX_SEARCHES && budgetLeft();

    // ── 1. Identity from the index ────────────────────────────────────────
    let read = await readProfileIndex({ slug, search, log: LOG, run });

    // With no name no query can be about this person, and the caller's text must
    // not supply one: that would make it the only evidence of who this is. So
    // there is nothing for a planner to judge, and the profile is all that's left.
    if (!read.identity.name && budgetLeft()) {
      read = await readProfilePage(read, { log: LOG, run, waitMs: timeLeft() });
    }
    if (!read.identity.name && !read.text) {
      logger.info(`${LOG} No identity established — giving up before planning`, { slug, ...run });
      return {};
    }

    // ── 2. Plan, with the profile as the last resort ──────────────────────
    let plan = budgetLeft() ? await planQueries({ read, ownFields, context, run }) : null;

    // A planner that failed said nothing about this person, so it buys no read.
    if (plan && !plan.tiedDown && !read.text && budgetLeft()) {
      const withProfile = await readProfilePage(read, { log: LOG, run, waitMs: timeLeft() });
      if (withProfile.text) {
        read = withProfile;
        const replanned = budgetLeft() ? await planQueries({ read, ownFields, context, run }) : null;
        plan = replanned ?? plan;
      }
    }

    const { identity } = read;
    const terms = plan?.terms ?? [];

    // The organisation the headline names is reported and given to the
    // synthesiser as it stands; only a distinctive one is something to search
    // for, and only a distinctive one tells a result apart from a stranger's.
    const organisation = identity.organisation ?? plan?.organisation ?? null;
    const searchableOrganisation = distinctiveOrganisation(organisation);
    const anchors = anchorsOf(identity, searchableOrganisation);
    const passageTerms = searchableOrganisation ? [...terms, searchableOrganisation] : terms;

    // ── 3. What the identity searches already paid for ────────────────────
    // A result with no snippet has only its title, which the identity already
    // read. Strangers in those searches are dropped by address, not by a model.
    const hits: SearchHit[] = [];
    for (const hit of read.seen) {
      if (belongsToProfile(hit.link, slug) && hit.snippet.trim()) addHit(hits, hit);
    }
    // The profile's own entry repeats the headline the terms came from, so it
    // always agrees with them and says nothing about whether anything was found.
    const beyondProfile = () => hits.filter((hit) => !matchesSlug(hit.link, slug));

    // ── 4. Run the activity queries, and retry once if they missed ────────
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

    const tried: string[] = [];
    const runQueries = async (queries: PlannedQuery[], limit: number) => {
      let ran = 0;
      for (const planned of queries) {
        if (ran >= limit || !canSearch()) break;
        // A query naming neither the person nor a real organisation searches for
        // the topic, not for them — every result it returns is somebody else's.
        if (!containsAnchor(planned.query, anchors)) {
          logger.info(`${LOG} Dropped a query with nothing distinctive in it`, {
            query: planned.query,
            ...run,
          });
          continue;
        }
        if (searchesOnLocationAlone(planned.query, identity)) {
          logger.info(`${LOG} Dropped a query that searches on a location alone`, {
            query: planned.query,
            ...run,
          });
          continue;
        }
        if (tried.includes(planned.query)) continue;
        ran += 1;
        tried.push(planned.query);
        const results = await search(planned.query);
        for (const hit of results) {
          if (!addHit(hits, hit)) continue;
          // Loading a page costs a large part of the wall clock, so a result
          // that already fails the acceptance rule is read as a snippet and
          // never opened: a namesake's page is not worth twenty seconds.
          if (
            planned.worthReading &&
            !isLinkedInLink(hit.link) &&
            isConsistent(hit, terms) &&
            canEnrich(hit, anchors)
          ) {
            considerReading(hit.link);
          }
        }
      }
    };

    await runQueries(plan?.queries ?? [], MAX_ACTIVITY_QUERIES);

    const foundSomething = beyondProfile().some(
      (hit) =>
        !belongsToAnotherProfile(hit.link, slug) &&
        namesPersonAndTerm(`${hit.title} ${hit.snippet}`, identity.name, passageTerms),
    );
    // Asked only when a search is left to spend on the answer. Only the query is
    // taken from it: terms written after seeing the results could be read off a
    // namesake's page, which would make that namesake consistent.
    if (plan && plan.queries.length > 0 && !foundSomething && canSearch()) {
      const retry = await planQueries({
        read,
        ownFields,
        context,
        missed: { tried, seen: beyondProfile() },
        run,
      });
      if (retry) await runQueries(retry.queries, 1);
    }

    // ── 5. Expand the organisation, then read the best two pages ──────────
    // Only when no search said anything about the organisation: a result that
    // already names it is the context this search would buy.
    const organisationCovered =
      searchableOrganisation !== null &&
      beyondProfile().some((hit) => containsAnchor(`${hit.title} ${hit.snippet}`, [searchableOrganisation]));
    if (searchableOrganisation && !organisationCovered && canSearch()) {
      const results = await search(`"${searchableOrganisation}" ${AGGREGATOR_SITES}`);
      for (const hit of results) {
        if (!isConsistent(hit, terms)) continue;
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

    // ── 6. Synthesise ─────────────────────────────────────────────────────
    const profileRead = read.text !== null;
    const thinAfterIdentity = isThin(identity) && !read.text;
    if (hits.length === 0 && thinAfterIdentity) {
      logger.info(`${LOG} Nothing to synthesise from`, { slug, profileRead, ...run });
      return {};
    }

    const activityText = activityTextOf({
      name: identity.name,
      terms: passageTerms,
      hits: hits.filter((hit) => !belongsToAnotherProfile(hit.link, slug)),
      excerpts,
    });

    const synthesis = await synthesise({
      identity,
      slug,
      profileUrl: read.profileUrl,
      profileText: read.text,
      organisation,
      terms,
      ownFields,
      hits,
      excerpts,
      run,
    });

    if (!synthesis?.found || !synthesis.summary.trim()) {
      logger.info(`${LOG} Nothing consistent with the headline — attaching ${activityText ? 'the passages' : 'nothing'}`, {
        slug,
        searches,
        results: hits.length,
        // A wrong empty can only be checked afterwards against what it was given.
        seen: hits.map((h) => ({ title: h.title, link: h.link })),
        profileRead,
        ...run,
      });
      // Text with no summary and no confidence: research could not confirm
      // anything beyond it, and a program that never reads the text sees an
      // empty answer, as before.
      return activityText ? { properties: { activity_text: activityText } } : {};
    }

    const sources = synthesis.sources.filter((s) => s.trim());
    // Agreement with the person's own addresses is agreement with a headline,
    // which says no more than the headline does. And a person nothing ever tied
    // down was searched for on a name alone, whatever the writer then concluded.
    const onlyTheirOwn = sources.every((source) => belongsToProfile(source, slug));
    const neverTiedDown = !plan?.tiedDown && !read.text;
    const confidence = onlyTheirOwn || neverTiedDown ? 'low' : synthesis.confidence;

    logger.info(`${LOG} Researched`, {
      slug,
      profileRead,
      searches,
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
        ...(activityText ? { activity_text: activityText } : {}),
      },
    };
  },
};

// ── Steps ─────────────────────────────────────────────────────────────────

async function planQueries(args: {
  read: ProfileRead;
  ownFields: ResolvedField[];
  context: string;
  /** Set on the retry: what the searches so far came back with. */
  missed?: { tried: string[]; seen: SearchHit[] };
  run: Record<string, unknown>;
}): Promise<Plan | null> {
  const { read, ownFields, context, missed, run } = args;
  const { identity } = read;
  const userMessage = [
    `Name: ${identity.name ?? 'unknown'}`,
    `Headline: ${identity.headline ?? 'unknown'}`,
    `Organisation: ${identity.organisation ?? 'unknown'}`,
    identity.location ? `Location: ${identity.location}` : null,
    read.indexText ? `What the search index says about them: ${read.indexText}` : null,
    ownFields.length
      ? `Other fields on the record about them:\n${describeFields(ownFields)}`
      : 'No other fields on the record about them.',
    context ? `Text the caller already has about them (it steers the searches, it is not evidence):\n${context}` : null,
    read.text ? `Profile page:\n${read.text}` : null,
    missed
      ? [
          'The searches so far found nothing that names this person together with a consistency term. Write ONE different query, using what these results suggest.',
          `Searches already run: ${missed.tried.join('; ') || 'none, because those you wrote named nobody or searched on a location alone'}`,
          `What came back:\n${missed.seen.map((h) => `- ${h.title}\n  ${h.snippet}`).join('\n') || 'nothing'}`,
        ].join('\n')
      : null,
  ]
    .filter((part): part is string => part != null)
    .join('\n');

  try {
    const raw = await anthropicChat({
      system: PLANNER_SYSTEM,
      userMessage,
      model: 'claude-haiku-4-5-20251001',
      label: 'plugin_linkedin_research_plan',
    });
    const parsed = readReply(raw, planSchema, 'The query planner', run);
    if (!parsed) return null;
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
      // nothing about whose news it is. Nor is the place the title gave, which a
      // planner told not to use as a term may still write.
      terms: (parsed.terms ?? []).filter(
        (term) => distinctiveOrganisation(term) !== null && !namesLocation(term, identity),
      ),
      organisation: organisationFromEvidence(parsed.organisation?.trim() || null, { read, ownFields, context }),
      // A reply that forgot the flag keeps its queries: calling the person tied
      // down only spends no paid read, which is the cheap way to be wrong.
      tiedDown: parsed.tied_down ?? true,
    };
  } catch (error) {
    logger.warn(`${LOG} The query planner failed`, { error: describeError(error), ...run });
    return null;
  }
}

/** The passage worth keeping from this text, under its source address, or null.
 *  Clipped first and tested after, so the rule holds of what the caller reads. */
function passageOf(args: { link: string; text: string; name: string | null; terms: string[] }): string | null {
  const clipped = args.text.slice(0, PASSAGE_CHARS);
  return namesPersonAndTerm(clipped, args.name, args.terms) ? `${args.link}\n${clipped}` : null;
}

/** The first stretch of a page around a mention of the person that holds the
 *  rule. A page is tested stretch by stretch: naming the person in a comment and
 *  the term in the footer says nothing about either. */
function pagePassage(args: { url: string; text: string; name: string | null; terms: string[] }): string | null {
  const { url, text, name, terms } = args;
  const sentences = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const [at, sentence] of sentences.entries()) {
    if (!namesPerson(sentence, name)) continue;
    const around = sentences.slice(Math.max(0, at - 1), at + 2).join(' ');
    const passage = passageOf({ link: url, text: around, name, terms });
    if (passage) return passage;
  }
  return null;
}

/** The text behind the answer. Pages come first: they were opened because they
 *  looked worth reading, and a search's snippets could otherwise fill the cap. */
function activityTextOf(args: {
  name: string | null;
  terms: string[];
  hits: SearchHit[];
  excerpts: Array<{ url: string; text: string }>;
}): string | null {
  const { name, terms, hits, excerpts } = args;
  const passages = [
    ...excerpts.map((page) => pagePassage({ url: page.url, text: page.text, name, terms })),
    ...hits.map((hit) => passageOf({ link: hit.link, text: `${hit.title}\n${hit.snippet}`, name, terms })),
  ].filter((passage): passage is string => passage != null);

  const kept: string[] = [];
  let length = 0;
  for (const passage of passages) {
    if (length + passage.length > ACTIVITY_TEXT_CHARS) break;
    kept.push(passage);
    length += passage.length;
  }
  return kept.length ? kept.join('\n\n') : null;
}

async function synthesise(args: {
  identity: ProfileIdentity;
  slug: string;
  profileUrl: string;
  profileText: string | null;
  organisation: string | null;
  terms: string[];
  ownFields: ResolvedField[];
  hits: SearchHit[];
  excerpts: Array<{ url: string; text: string }>;
  run: Record<string, unknown>;
}): Promise<z.infer<typeof synthesisSchema> | null> {
  const { identity, slug, profileUrl, profileText, organisation, terms, ownFields, hits, excerpts, run } = args;
  const userMessage = [
    `Profile address: ${profileUrl}`,
    `Name: ${identity.name ?? 'unknown'}`,
    `Headline: ${identity.headline ?? 'unknown'}`,
    `Organisation as read from the headline: ${organisation ?? 'unknown'}`,
    identity.location ? `Location: ${identity.location}` : null,
    `Consistency terms (the acceptance rule): ${terms.length ? terms.join(', ') : 'the headline above'}`,
    profileText ? `Profile page:\n${profileText}` : null,
    ownFields.length ? `Fields on the record about them:\n${describeFields(ownFields)}` : null,
    hits.length
      ? `Search results:\n${hits
          .map((h) => `- ${h.title}${belongsToProfile(h.link, slug) ? ' (their own address)' : ''}\n  ${h.link}\n  ${h.snippet}`)
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
    const fetched = await Promise.race([tools().fetchResource(url, null), abandon]);
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
