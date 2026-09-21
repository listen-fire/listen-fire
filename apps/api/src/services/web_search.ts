import { z } from 'zod';

import { SECOND } from '../constants';
import { Prompt } from '../lib/prompts';
import { openAiChat } from '../lib/openai';
import { getEnvVar } from '../lib/utils/environment';
import { neverAsAny } from '../lib/utils/types';
// Tavily is a legacy-only supplementary search (no DPA) — gated per-caller via
// `allowSupplementaryWebSearch`, which only the legacy pipelines pass.
import { webSearch as tavilySearch, isAvailable as tavilyAvailable } from '../lib/web_search';

// Google is discontinuing "search the entire web" in Programmable Search on
// 2027-01-01. Bright Data's SERP API returns Google's own results as JSON —
// same ranking, different transport — so it stands in as a second provider
// rather than a different search engine. Default stays `google` so an
// unset variable reproduces today's behaviour exactly.
type WebSearchProvider = 'google' | 'brightdata';

function resolveWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider {
  const value = env.WEB_SEARCH_PROVIDER ?? 'google';
  if (value === 'google' || value === 'brightdata') return value;
  throw new Error(
    `WEB_SEARCH_PROVIDER must be "google" or "brightdata" (got "${value}")`,
  );
}

// The SERP zone is provisioned separately from the Web Unlocker zone the page
// scraper uses (see scraper.ts's `missingBrightDataVars`) — a Bright Data
// account keeps one zone per product. The access token is shared.
function missingBrightDataSerpVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['BRIGHT_DATA_ACCESS_TOKEN', 'BRIGHT_DATA_SERP_ZONE'].filter((name) => !env[name]);
}

// SERP JSON is a few KB; these only guard a runaway or hung request, mirroring
// the ceilings scraper.ts holds a page fetch to.
const BRIGHT_DATA_SERP_TIMEOUT = 30 * SECOND;
const MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES = 1 * 1024 * 1024;

// Verified against https://docs.brightdata.com/scraping-automation/serp-api/
// (2026-09-18): POST the target Google search URL through the SERP zone with
// `brd_json=1` in the query string, and the reply is Google's own parsed
// result set. Only the fields the callers below actually read are declared;
// everything else (`general`, `people_also_ask`, `knowledge`, …) passes
// through unparsed.
const BrightDataSerpOrganicResult = z.object({
  link: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const BrightDataSerpResponseShape = z.object({
  organic: z.array(BrightDataSerpOrganicResult),
});

/** Maps a parsed Bright Data reply onto the same `Search` shape the Google
 *  provider returns, so callers don't change. An `organic` array — even an
 *  empty one — is Google's own answer of "nothing found"; anything else
 *  (the key missing, the wrong type, an error envelope) is a shape this
 *  code doesn't understand, and fails rather than reading as "no results". */
function mapBrightDataSerpResponse(raw: unknown): Search {
  const parsed = BrightDataSerpResponseShape.safeParse(raw);
  if (!parsed.success) {
    const topLevelKeys =
      typeof raw === 'object' && raw !== null ? Object.keys(raw) : [];
    throw new Error(
      `Bright Data SERP response did not have the expected shape (top-level keys: ${
        topLevelKeys.length ? topLevelKeys.join(', ') : 'none'
      })`,
    );
  }

  const items: SearchResult[] = parsed.data.organic.map((hit) => ({
    link: hit.link,
    title: hit.title,
    snippet: hit.description,
  }));

  return { items };
}

/** The response body, read as a stream and abandoned at the cap — mirrors
 *  scraper.ts's `readCappedBytes`, sized down for a JSON reply rather than a
 *  whole page. */
async function readCappedText(response: Response): Promise<string> {
  if (!response.body) return response.text();

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    while (received < MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks, Math.min(received, MAX_BRIGHT_DATA_SERP_RESPONSE_BYTES)).toString(
    'utf8',
  );
}

interface ProfileSearchInput {
  name: string;
  description?: string | null;
  company?: string | null;
}

// A selection from https://github.com/googleapis/google-api-nodejs-client/blob/main/src/apis/customsearch/v1.ts
type Search = {
  items?: SearchResult[];
  searchInformation?: {
    formattedSearchTime?: string;
    formattedTotalResults?: string;
    searchTime?: number;
    totalResults?: string;
  } | null;
  spelling?: { correctedQuery?: string; htmlCorrectedQuery?: string } | null;
  url?: { template?: string; type?: string } | null;
};

type SearchResult = {
  link?: string | null;
  snippet?: string | null;
  title?: string | null;
};

class WebSearch {
  async search(query: string): Promise<Search> {
    const provider = resolveWebSearchProvider();
    switch (provider) {
      case 'google':
        return this.searchGoogle(query);
      case 'brightdata':
        return this.searchBrightData(query);
      default:
        return neverAsAny(provider);
    }
  }

  private async searchGoogle(query: string): Promise<Search> {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', getEnvVar('GOOGLE_CUSTOM_SEARCH_API_KEY', { devDefault: 'local' }));
    url.searchParams.set('cx', getEnvVar('GOOGLE_CX', { devDefault: 'local' }));
    url.searchParams.set('q', query);

    const results = await fetch(url);
    return results.json();
  }

  // Read lazily, same reason as scraper.ts's Bright Data path: importing this
  // module should never require the SERP zone to be provisioned.
  private async searchBrightData(query: string): Promise<Search> {
    const missing = missingBrightDataSerpVars();
    if (missing.length) {
      throw new Error(`Bright Data web search requires ${missing.join(' and ')} to be set`);
    }

    // The query text is the whole `q=` parameter, `site:` restriction and all
    // — the same string the Google provider would have received — so a
    // caller's existing `site:linkedin.com/in …` queries carry over unchanged.
    const searchUrl = new URL('https://www.google.com/search');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('brd_json', '1');

    const response = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getEnvVar('BRIGHT_DATA_ACCESS_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zone: getEnvVar('BRIGHT_DATA_SERP_ZONE'),
        url: searchUrl.toString(),
        format: 'raw',
      }),
      signal: AbortSignal.timeout(BRIGHT_DATA_SERP_TIMEOUT),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Bright Data SERP request failed: ${response.status} ${response.statusText}: ${text.slice(0, 200)}`,
      );
    }

    const text = await readCappedText(response);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error('Bright Data SERP response was not valid JSON');
    }

    return mapBrightDataSerpResponse(raw);
  }

  /**
   * Notes:
   *  - we use Google search results to avoid Linkedin's bot detection
   *  - the search is restricted to the linkedin.com/in namespace
   *  - results are sorted by Google's relevance
   */
  async findLinkedIn(
    { name, description, company }: ProfileSearchInput,
    { allowSupplementaryWebSearch = false }: { allowSupplementaryWebSearch?: boolean } = {},
  ): Promise<SearchResult[]> {
    const query = `site:linkedin.com/in ${name}`;

    const oldCompanies = description
      ? await openAiChat(
          [
            {
              role: 'system',
              content: `Your function is to output a company that someone used to work at.
      The input is a terse summary of someone's experience.
      Output a vbar-separated list of companies this person has worked at (e.g. "ex Facebook" -> "Facebook"). If there is one company, output just that company.
      Another example might be "ex Facebook, used to work at Google" -> "Facebook | Google".
      If you are not sure or there's not enough information, respond with "not sure".`,
            },
            {
              role: 'user',
              content: description,
            },
          ],
          {
            model: 'gpt-5-nano',
          },
        ).then((response) =>
          response.toLowerCase().replace(/"/g, '') === 'not sure' ? null : response,
        )
      : null;

    // by ORing the current company with the previous companies, we handle stealth founders who
    // haven't updated their LinkedIn yet, and increase the chance of a correct match
    const companies = (oldCompanies ? `${company} | ${oldCompanies}` : company ?? '').replace(
      / (\| )?/g,
      ' OR ',
    );

    // Combine query by name and extended by company
    const parsed = await this.search(query);
    const specific = await this.search(`${query} ${companies}`);

    // Google CSE is the primary path. Legacy pipelines may additionally fall back
    // to Tavily for the rare person+company empty case — gated, because Tavily has
    // no DPA and must never run for a movement (which stays Google-CSE-only).
    let supplementaryItems: SearchResult[] = [];
    if (
      allowSupplementaryWebSearch &&
      (specific.items ?? []).length === 0 &&
      companies.trim() &&
      tavilyAvailable()
    ) {
      try {
        const tavilyResults = await tavilySearch(`${name} ${companies} site:linkedin.com/in`, 5);
        supplementaryItems = tavilyResults
          .filter((r) => /linkedin\.com\/in\//.test(r.url))
          .map((r) => ({ link: r.url, title: r.title, snippet: r.snippet }));
      } catch {
        // Tavily unavailable — continue with Google results only
      }
    }

    const items = (specific.items ?? [])
      .concat(supplementaryItems)
      .concat(parsed.items ?? []);

    if (!items.length) {
      return [];
    }

    const itemsText = items
      .map(
        (item, index) => `${index + 1}. name: ${item.title}
        snippet: ${item.snippet}`,
      )
      .join('\n');

    const response = await Prompt.matchSearchResult({
      company: company ?? '',
      name,
      description: description ?? '',
      items: itemsText,
    });

    const match = response.find((res) => res.is_match);

    if (match) {
      return [items[match.number - 1]];
    }

    return [];
  }

  async findTwitter({ name, company }: ProfileSearchInput) {
    const parsed = await this.search(`site:twitter.com ${name}`);

    if (!parsed.items || !parsed.items.length) {
      return;
    }

    const lowerCompany = company?.toLowerCase();
    const profilesMentioningCompany = parsed.items.filter(
      ({ snippet }) => lowerCompany && snippet?.toLowerCase().includes(lowerCompany),
    );

    return profilesMentioningCompany.concat(parsed.items)[0]?.link;
  }
}

const WebSearchService = new WebSearch();

export { WebSearchService };
