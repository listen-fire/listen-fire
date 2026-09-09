import { z } from 'zod';
import { parse } from 'tldts';

import { anthropicChat } from '../../lib/anthropic';
import { parseJson } from '../../lib/utils/parse_json';
import { safeToUrl } from '../../lib/utils/url';
import { AffinityAPIClient } from './apiClient';

/** Email addresses are compared case-insensitively across every Affinity write
 *  path. Affinity enforces one person per address and adjudicates it with a
 *  rule broader than `===` — a live create was rejected ("There exists a
 *  contact with this email address.") for an address the search had just
 *  returned and an exact compare walked past.
 *
 *  Normalization is for MATCHING only; addresses are written as authored.
 *  Returns null for an address that is absent or all whitespace, so callers
 *  can guard rather than compare null to null and "match" the first person
 *  with no email at all. */
function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/** True when `candidates` already contains `email`, ignoring case and padding.
 *  The predicate behind "does this person already own this address?" — an
 *  exact compare here appends a second, differently-cased copy of an address
 *  the record already has. */
function ownsEmail(candidates: (string | null | undefined)[] | null | undefined, email: string | null | undefined): boolean {
  const wanted = normalizeEmail(email);
  if (!wanted) return false;
  return (candidates ?? []).some((candidate) => normalizeEmail(candidate) === wanted);
}

/** The bare host of a domain as Affinity holds it — `veltha.ai` from
 *  `veltha.ai`, from `https://www.veltha.ai/careers`, from `  Veltha.ai  `.
 *
 *  Affinity stores an organization's domain as a bare host and its `term`
 *  search is a SUBSTRING match against that stored string. `https://veltha.ai`
 *  is not a substring of `veltha.ai`, so a search by URL origin matched
 *  nothing at all — the lookup fell through to the name search and, whenever
 *  the name had drifted, created a second company for one that was already
 *  there. A leading `www.` goes for the same reason: it is not in what
 *  Affinity stored.
 *
 *  Normalization is for MATCHING only, exactly like `normalizeEmail` — the
 *  domain is written as authored. */
function domainHost(domain: string): string | null {
  const host = safeToUrl(domain, { log: false })?.hostname;
  return host ? host.replace(/^www\./, '') : null;
}

/** Split a full name the way a person would if nobody asked a model: the last
 *  whitespace-separated token is the surname, everything before it the given
 *  name. Wrong for some names ("Hong Yan Hank Wu" is right; "Ana de Armas" is
 *  not), but it is the floor under the LLM split — a name it declines to split
 *  used to abort the whole write, and a plausible surname beats a dead run.
 *
 *  A single token has no surname to find. Affinity's own person records carry
 *  a nullable last name, so the surname is left BLANK rather than duplicating
 *  the token: a blank field reads as incomplete and is fixable, while "Cher
 *  Cher" is invented data nobody can tell from authored data. */
function splitNameByLastToken(name: string): { firstName: string; lastName: string } {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { firstName: tokens[0] ?? '', lastName: '' };
  return { firstName: tokens.slice(0, -1).join(' '), lastName: tokens[tokens.length - 1] };
}

async function findMatchingOrganisation(
  client: AffinityAPIClient,
  {
    name,
    domain,
  }: {
    name: string;
    domain?: string | null;
  },
) {
  const normalisedDomain = domain ? domainHost(domain) : null;
  if (normalisedDomain) {
    // Prioritize domain matching
    const orgsByDomain = await client.findManyOrganisations({
      search: normalisedDomain,
      includeGlobal: true,
    });
    const parsedDomain = parse(normalisedDomain);
    const orgByDomain = orgsByDomain.find((org) =>
      org.domain
        ? domainHost(org.domain) === normalisedDomain ||
          parsedDomain.domain === parse(org.domain)?.domain ||
          org.domains?.map((domain) => domainHost(domain)).includes(normalisedDomain)
        : false,
    );
    if (orgByDomain) {
      return orgByDomain;
    }

    // Fallback to close domain matches and exact name matches (within the private dataset)
    const orgByDomainByName = orgsByDomain.find(
      (org) => !org.global && org.name?.toLowerCase() === name.toLowerCase(),
    );
    if (orgByDomainByName) {
      return orgByDomainByName;
    }
  }

  // Fallback to name matches
  const orgsByName = await client.findManyOrganisations({
    search: name,
    includeGlobal: false,
  });
  const orgByName = orgsByName.find((org) => org.name?.toLowerCase() === name.toLowerCase());
  if (orgByName) {
    return orgByName;
  }

  if (!orgsByName.length) {
    return null;
  }

  const closeMatchId = await anthropicChat({
    label: 'affinity.findMatchingOrganisation',
    system: `You are a strict matcher that selects an organization ID from a provided list only when the match is highly likely. Otherwise, return null.

Input (from the user):
- A JSON object with shape { query: { name: string, domain: string | null }, organizations: Array<{ id: number, name: string | null, domain: string | null, domains: string[] | null }> }.

Matching rules (apply in this order):
1) If query.domain is present, prioritize exact domain match after normalizing (ignore protocol and www). Also consider any value in organization.domains.
2) If no domain match, consider name similarity but be conservative. Treat common or generic names (e.g. "BrightSpark", "Acme", "NextGen") as ambiguous unless there is a strong signal.
3) Distinctive or famous names (e.g. "HubSpot", "Nostos Genomics") can be accepted on exact name match.
4) Prefer returning null over a wrong match. Only output a match if you are confident.

Output: Strictly JSON: either a number (the id) or null. No extra text.`,
    userMessage: JSON.stringify(
      {
        query: { name, domain: domain ?? null },
        organizations: orgsByName.map((org) => ({
          id: org.id,
          name: org.name ?? null,
          domain: org.domain ?? null,
          domains: org.domains ?? null,
        })),
      },
      null,
      2,
    ),
  });

  const parsedCloseMatchId = z.number().nullable().parse(parseJson(closeMatchId));

  const closeMatch = parsedCloseMatchId
    ? orgsByName.find((org) => org.id === parsedCloseMatchId)
    : null;
  if (closeMatch) {
    return closeMatch;
  }

  return null;
}

export { findMatchingOrganisation, normalizeEmail, ownsEmail, splitNameByLastToken };
