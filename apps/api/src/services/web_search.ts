import { Prompt } from '../lib/prompts';
import { openAiChat } from '../lib/openai';
import { getEnvVar } from '../lib/utils/environment';
// Tavily is a legacy-only supplementary search (no DPA) — gated per-caller via
// `allowSupplementaryWebSearch`, which only the legacy pipelines pass.
import { webSearch as tavilySearch, isAvailable as tavilyAvailable } from '../lib/web_search';

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
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', getEnvVar('GOOGLE_CUSTOM_SEARCH_API_KEY', { devDefault: 'local' }));
    url.searchParams.set('cx', getEnvVar('GOOGLE_CX', { devDefault: 'local' }));
    url.searchParams.set('q', query);

    const results = await fetch(url);
    return results.json();
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
