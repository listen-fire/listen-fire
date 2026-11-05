// What the plugin spends and what it hands back, over fake tools. The index entry
// is read first and kept whole; the planner decides whether anything ties the
// person down, and only its "no" buys the profile read; one retry, four searches;
// and text comes back only where it names the person and a consistency term.

import type { SearchResult, WebTools } from '../tools';

import { linkedinResearchPlugin } from '../linkedin_research';
import { withTools } from '../tools';
import { describeProfile, readProfile } from '../research/profile_read';
import { runSearch } from '../search_hygiene';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const PROFILE = 'https://www.linkedin.com/in/jane-doe';
const SITE_QUERY = 'site:linkedin.com/in/jane-doe';
const OWN_ENTRY = { link: PROFILE, title: 'Jane Doe - Sverige | Yrkesprofil', snippet: 'Experience: Acme · Education: Example University' };
const PROFILE_TEXT = [
  'Jane Doe',
  'Stealth',
  'Experience',
  'Stealth · Founder · 2023–present',
  'Acme Drones · Co-founder & CTO · 2013–2022 · Zürich',
].join('\n');

const FOUND = {
  found: true,
  confidence: 'medium',
  current_role: 'Founder',
  current_organisation: 'Acme',
  summary: 'Runs Acme [1].',
  sources: ['https://news.example/acme'],
};
const NOTHING = { found: false, confidence: 'low', current_role: '', current_organisation: '', summary: '', sources: [] };

interface Script {
  /** Each planner call's reply, in order; the last repeats. */
  plans?: Array<Record<string, unknown>>;
  /** What the index answers to a query. An unlisted query finds nothing. */
  index?: Record<string, SearchResult[]>;
  writer?: Record<string, unknown>;
  profileText?: string | null;
  pages?: Record<string, string>;
}

function scripted(script: Script) {
  const asked = {
    searches: [] as string[],
    planner: [] as string[],
    writer: [] as string[],
    profiles: [] as string[],
    fetches: [] as string[],
  };
  const plans = script.plans ?? [{ queries: [], terms: [], organisation: '', tied_down: true }];
  const tools: WebTools = {
    log: quiet,
    logFields: () => ({}),
    models: {
      anthropicChat: async (options) => {
        const plan = plans[Math.min(asked.planner.length, plans.length - 1)];
        asked.planner.push(`${options.system}\n---\n${options.userMessage}`);
        return JSON.stringify(plan);
      },
      anthropicChatStructured: async (options) => {
        asked.writer.push(String(options.userMessage));
        return (script.writer ?? FOUND) as never;
      },
      anthropicWebChat: async () => {
        throw new Error('not used');
      },
    },
    searchProvider: () => 'fake',
    search: async (query) => {
      asked.searches.push(query);
      return { items: script.index?.[query] ?? [] };
    },
    findLinkedIn: async () => [],
    scrape: async () => '',
    missingScraperSettings: () => [],
    profiles:
      script.profileText === undefined
        ? undefined
        : {
            getProfileTextByUrl: async (url) => {
              asked.profiles.push(url);
              return script.profileText ? { text: script.profileText } : null;
            },
          },
    isDocumentSource: () => false,
    fetchResource: async (url) => {
      asked.fetches.push(url);
      const content = script.pages?.[url];
      return content ? { url, content, file: null } : null;
    },
    fileValues: async (handles) => handles.map(() => undefined),
  };
  return { tools, asked };
}

const research = (tools: WebTools, config: Record<string, unknown> = {}) =>
  withTools(tools, () =>
    linkedinResearchPlugin.run({ kind: 'context-dependent', config: { url: PROFILE, ...config }, extractedContext: {} }),
  );

describe('finding the profile in the index', () => {
  it('asks the site query first, and the address only when that misses', async () => {
    const found = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY] } });
    await research(found.tools);
    expect(found.asked.searches).toEqual([SITE_QUERY]);

    const missed = scripted({ index: { [PROFILE]: [OWN_ENTRY] } });
    await research(missed.tools);
    expect(missed.asked.searches).toEqual([SITE_QUERY, PROFILE]);
  });

  it('gives up with no planner call when nothing says who holds the address', async () => {
    const { tools, asked } = scripted({ profileText: null });
    expect(await research(tools)).toEqual({});
    expect(asked.profiles).toEqual([PROFILE]);
    expect(asked.planner).toEqual([]);
  });
});

describe('planning', () => {
  it('gives the planner the index text and the context, labelled, and never the writer the context', async () => {
    const { tools, asked } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY] } });
    await research(tools, { context: 'Jane mentioned her work at Northwind in Slack' });

    expect(asked.planner[0]).toContain('What the search index says about them: Experience: Acme · Education: Example University');
    expect(asked.planner[0]).toContain('Text the caller already has about them');
    expect(asked.planner[0]).toContain('Jane mentioned her work at Northwind in Slack');
    expect(asked.writer[0]).not.toContain('Northwind');
  });

  it('runs at most two activity queries, whatever the planner writes', async () => {
    const queries = ['"Jane Doe" Acme', '"Jane Doe" drones', '"Jane Doe" founder'];
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [OWN_ENTRY],
        [queries[0]]: [{ link: 'https://news.example/acme', title: 'Acme', snippet: 'Jane Doe of Acme spoke' }],
      },
      plans: [{ queries, terms: ['Acme'], organisation: '', tied_down: true }],
    });
    await research(tools);
    expect(asked.searches).toEqual([SITE_QUERY, queries[0], queries[1]]);
  });

  it('refuses a query that searches on a location alone, and tells the planner why it should not write one', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: ['"Jane Doe" Sverige', '"Jane Doe" Sverige drones'], terms: ['Sverige'], organisation: '', tied_down: true }],
    });
    await research(tools);
    expect(asked.searches).toContain('"Jane Doe" Sverige drones');
    expect(asked.searches).not.toContain('"Jane Doe" Sverige');
    expect(asked.planner[0]).toContain('A location alone is a consistency term and never what a query searches on');
  });

  it('does not count a query with nothing distinctive in it towards the two', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: ['drone startups', '"Jane Doe" drones'], terms: ['drones'], organisation: '', tied_down: true }],
    });
    await research(tools);
    expect(asked.searches).not.toContain('drone startups');
    expect(asked.searches).toContain('"Jane Doe" drones');
  });
});

describe('the profile read as the last resort', () => {
  const plans = [
    { queries: ['"Jane Doe" first plan'], terms: [], organisation: '', tied_down: false },
    { queries: ['"Jane Doe" "Acme Drones" founder'], terms: ['Acme Drones'], organisation: '', tied_down: true },
  ];

  it('is skipped when the planner says something ties the person down, even on a thin title', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: [], terms: ['Acme'], organisation: 'Acme', tied_down: true }],
      profileText: PROFILE_TEXT,
    });
    await research(tools);
    expect(asked.profiles).toEqual([]);
    expect(asked.planner).toHaveLength(1);
  });

  it('runs when the planner says nothing does, and plans again on its text', async () => {
    const { tools, asked } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY] }, plans, profileText: PROFILE_TEXT });
    await research(tools);

    expect(asked.profiles).toEqual([PROFILE]);
    expect(asked.planner[0]).toContain('Location: Sverige');
    expect(asked.planner[1]).toContain('Headline: Stealth');
    expect(asked.planner[1]).toContain('Acme Drones · Co-founder & CTO');
    expect(asked.searches).toContain('"Jane Doe" "Acme Drones" founder');
    expect(asked.searches).not.toContain('"Jane Doe" first plan');
  });

  it('runs the first plan when there is no service to ask', async () => {
    const { tools, asked } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY] }, plans });
    await research(tools);
    expect(asked.searches).toContain('"Jane Doe" first plan');
  });

  it('is not bought by a planner that failed', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: [], terms: [] }],
      profileText: PROFILE_TEXT,
    });
    await research(tools);
    expect(asked.profiles).toEqual([]);
  });

  it('keeps the confidence once the profile has been read', async () => {
    const { tools } = scripted({
      index: {
        [SITE_QUERY]: [OWN_ENTRY],
        '"Jane Doe" "Acme Drones" founder': [
          { link: 'https://news.example/acme', title: 'Acme Drones', snippet: 'Jane Doe, CTO of Acme Drones' },
        ],
      },
      plans,
      profileText: PROFILE_TEXT,
    });
    expect((await research(tools)).properties).toMatchObject({ activity_confidence: 'medium' });
  });
});

describe('the retry', () => {
  const firstPlan = { queries: ['"Jane Doe" one', '"Jane Doe" two'], terms: ['Acme'], organisation: '', tied_down: true };
  const retryPlan = { queries: ['"Jane Doe" three', '"Jane Doe" four'], terms: ['Stranger Corp'], organisation: '', tied_down: true };
  const namesake = { link: 'https://news.example/namesake', title: 'Jane Doe wins', snippet: 'Jane Doe, a golfer' };

  it('fires once with what was seen, runs one query, and keeps the first terms', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY], '"Jane Doe" one': [namesake], '"Jane Doe" three': [namesake] },
      plans: [firstPlan, retryPlan],
    });
    const output = await research(tools);

    expect(asked.planner).toHaveLength(2);
    expect(asked.planner[1]).toContain('Searches already run: "Jane Doe" one; "Jane Doe" two');
    expect(asked.planner[1]).toContain('Jane Doe, a golfer');
    expect(asked.searches).toEqual([SITE_QUERY, '"Jane Doe" one', '"Jane Doe" two', '"Jane Doe" three']);
    expect(asked.writer[0]).toContain('Consistency terms (the acceptance rule): Acme');
    expect(output.properties).toBeDefined();
  });

  it('is not asked for when no search is left, the identity searches counting', async () => {
    const { tools, asked } = scripted({
      index: { [PROFILE]: [OWN_ENTRY] },
      plans: [firstPlan, retryPlan],
    });
    await research(tools);
    expect(asked.searches).toEqual([SITE_QUERY, PROFILE, '"Jane Doe" one', '"Jane Doe" two']);
    expect(asked.planner).toHaveLength(1);
  });

  it('does not fire when a result names the person with a term', async () => {
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [OWN_ENTRY],
        '"Jane Doe" one': [{ link: 'https://news.example/acme', title: 'Acme', snippet: 'Jane Doe of Acme spoke' }],
      },
      plans: [firstPlan, retryPlan],
    });
    await research(tools);
    expect(asked.planner).toHaveLength(1);
  });

  it('is not satisfied by the profile entry, which always agrees with its own terms', async () => {
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [{ link: PROFILE, title: 'Jane Doe - Founder - Acme | LinkedIn', snippet: 'Jane Doe runs Acme' }],
      },
      plans: [{ queries: ['"Jane Doe" one'], terms: ['Acme'], organisation: 'Acme', tied_down: true }, retryPlan],
    });
    await research(tools);
    expect(asked.planner).toHaveLength(2);
  });

  it('leaves the organisation search out once four searches are spent', async () => {
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [{ link: PROFILE, title: 'Jane Doe - Founder - Acme | LinkedIn', snippet: 'Runs things' }],
        '"Jane Doe" one': [namesake],
      },
      plans: [{ ...firstPlan, organisation: 'Acme' }, retryPlan],
    });
    await research(tools);
    expect(asked.searches).toHaveLength(4);
    expect(asked.searches.some((q) => q.includes('crunchbase'))).toBe(false);
  });
});

describe('the text handed back', () => {
  const query = '"Jane Doe" Acme';
  const plan = { queries: [{ query, worth_reading: true }], terms: ['Acme'], organisation: '', tied_down: true };
  const article = { link: 'https://news.example/acme', title: 'Acme grows', snippet: 'Jane Doe, who runs Acme, said so.' };

  it('comes back with low confidence and no summary when the writer finds nothing', async () => {
    const { tools } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [article] }, plans: [plan], writer: NOTHING });
    const { properties } = await research(tools);

    expect(properties?.activity_confidence).toBe('low');
    expect(properties?.activity_summary).toBeUndefined();
    expect(properties?.activity_text).toContain('https://news.example/acme\nAcme grows\nJane Doe, who runs Acme, said so.');
  });

  it('comes back alongside a summary when the writer found something', async () => {
    const { tools } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [article] }, plans: [plan] });
    const { properties } = await research(tools);
    expect(properties?.activity_summary).toBe('Runs Acme [1].');
    expect(properties?.activity_text).toContain('https://news.example/acme');
  });

  it('is absent, with everything else, when no passage names the person and a term', async () => {
    const { tools } = scripted({
      index: {
        [SITE_QUERY]: [{ ...OWN_ENTRY, snippet: 'A profile.' }],
        [query]: [
          { link: 'https://news.example/name-only', title: 'Jane Doe wins', snippet: 'A golfer called Jane Doe.' },
          { link: 'https://news.example/term-only', title: 'Acme grows', snippet: 'Acme is growing.' },
          { link: 'https://news.example/surname', title: 'Doe at Acme', snippet: 'Doe joined Acme.' },
        ],
      },
      plans: [plan],
      writer: NOTHING,
    });
    expect(await research(tools)).toEqual({});
  });

  it('excludes a namesake: another profile, its post, and a stranger from the identity search', async () => {
    const stranger = { link: 'https://news.example/other', title: 'Jane Doe of Acme', snippet: 'Jane Doe of Acme, in the identity search' };
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [stranger, OWN_ENTRY],
        [query]: [
          { link: 'https://www.linkedin.com/in/jane-doe-42', title: 'Jane Doe - Acme', snippet: 'Jane Doe at Acme, Oslo' },
          { link: 'https://www.linkedin.com/posts/jane-doe-42_acme-activity-1', title: 'Jane Doe on Acme', snippet: 'Jane Doe at Acme' },
          article,
        ],
      },
      plans: [plan],
    });
    const { properties } = await research(tools);

    expect(properties?.activity_text).toContain('https://news.example/acme');
    expect(properties?.activity_text).not.toContain('jane-doe-42');
    expect(properties?.activity_text).not.toContain('https://news.example/other');
    expect(asked.writer[0]).not.toContain('https://news.example/other');
  });

  it("counts the person's own post from an identity search, as a hit and as text", async () => {
    const post = {
      link: 'https://www.linkedin.com/posts/jane-doe_launch-activity-1-abc',
      title: 'Jane Doe on LinkedIn',
      snippet: 'Jane Doe: we launched at Acme this week',
    };
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY, post] },
      plans: [{ queries: [], terms: ['Acme'], organisation: '', tied_down: true }],
      writer: NOTHING,
    });
    const { properties } = await research(tools);

    expect(asked.writer[0]).toContain('Jane Doe on LinkedIn (their own address)');
    expect(properties?.activity_text).toContain('we launched at Acme this week');
  });

  it('caps the text, and takes a page only where the rule holds in one stretch of it', async () => {
    const page = [
      'Jane Doe appears in this list of attendees.',
      `${'Filler about something else entirely. '.repeat(40)}`,
      'Acme is mentioned far from her.',
      `${'More filler that says nothing at all. '.repeat(40)}`,
      'At the conference Jane Doe said Acme had grown.',
    ].join('\n');
    const { tools } = scripted({
      index: {
        [SITE_QUERY]: [OWN_ENTRY],
        [query]: [
          article,
          ...Array.from({ length: 40 }, (_, i) => ({
            link: `https://news.example/${i}`,
            title: `Acme ${i}`,
            snippet: `Jane Doe of Acme, item ${i}, ${'with some words '.repeat(5)}`,
          })),
        ],
      },
      plans: [plan],
      pages: { [article.link]: page },
    });
    const { properties } = await research(tools);

    const text = String(properties?.activity_text);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.startsWith(`${article.link}\n`)).toBe(true);
    expect(text).toContain('At the conference Jane Doe said Acme had grown.');
    expect(text).not.toContain('list of attendees');
  });

  it('reads two pages at most', async () => {
    const links = ['a', 'b', 'c'].map((id) => `https://news.example/${id}`);
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [OWN_ENTRY],
        [query]: links.map((link) => ({ link, title: 'Acme', snippet: 'Jane Doe of Acme' })),
      },
      plans: [plan],
      pages: Object.fromEntries(links.map((link) => [link, 'Jane Doe of Acme, a long enough page.'])),
    });
    await research(tools);
    expect(asked.fetches).toEqual(links.slice(0, 2));
  });

  it('reads a decorated name as the person, and one word between the names', async () => {
    const { tools } = scripted({
      index: {
        [SITE_QUERY]: [{ ...OWN_ENTRY, title: 'Dr. Jane Doe, PhD (she/her) - Sverige | Yrkesprofil', snippet: '' }],
        [query]: [{ link: 'https://news.example/acme', title: 'Acme grows', snippet: 'Jane M. Doe of ACME said so' }],
      },
      plans: [plan],
    });
    expect((await research(tools)).properties?.activity_text).toContain('https://news.example/acme');
  });
});

describe('the confidence on the index alone', () => {
  it('stays low on a thin title with a found answer', async () => {
    const { tools } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: [], terms: ['Acme'], organisation: '', tied_down: true }],
    });
    expect((await research(tools)).properties?.activity_confidence).toBe('low');
  });

  it('stays low on a rich title when the only result is the profile entry', async () => {
    const { tools } = scripted({
      index: { [SITE_QUERY]: [{ link: PROFILE, title: 'Jane Doe - Founder - Acme | LinkedIn', snippet: 'Runs Acme' }] },
      plans: [{ queries: [], terms: ['Acme'], organisation: 'Acme', tied_down: true }],
    });
    expect((await research(tools)).properties?.activity_confidence).toBe('low');
  });
});

describe('the shared profile reader', () => {
  const read = (index: Record<string, SearchResult[]>, profileText: string | null) => {
    const { tools, asked } = scripted({ index, profileText });
    return withTools(tools, async () => ({
      read: await readProfile({
        slug: 'jane-doe',
        search: (query) => runSearch(query, 'test', {}),
        log: 'test',
        run: {},
      }),
      asked,
    }));
  };

  it('reads plain profile lines as the name and headline', async () => {
    const { read: profile } = await read({}, 'Jane Doe\nFounder at Acme\nExperience');
    expect(profile.identity).toMatchObject({ name: 'Jane Doe', headline: 'Founder at Acme', role: 'Founder at Acme' });
  });

  it("reads the hosted reader's labelled record without its labels", async () => {
    const { read: profile } = await read({}, 'Name: Jane Doe\nPosition: Founder at Acme\nCity: Zürich');
    expect(profile.identity).toMatchObject({ name: 'Jane Doe', headline: 'Founder at Acme', role: 'Founder at Acme' });
  });

  it('never takes another field for a missing one in the labelled record', async () => {
    const { read: profile } = await read({}, 'Current company: Acme\nCity: Zürich');
    expect(profile.identity).toMatchObject({ name: null, headline: null });

    const { read: named } = await read({}, 'Name: Jane Doe\nCity: Zürich');
    expect(named.identity).toMatchObject({ name: 'Jane Doe', headline: null });
  });

  it('still reads the profile on its own when the index is thin, and not when it is rich', async () => {
    const thin = await read({ [SITE_QUERY]: [OWN_ENTRY] }, PROFILE_TEXT);
    expect(thin.asked.profiles).toEqual([PROFILE]);

    const rich = await read(
      { [SITE_QUERY]: [{ link: PROFILE, title: 'Jane Doe - Founder - Acme | LinkedIn', snippet: '' }] },
      PROFILE_TEXT,
    );
    expect(rich.asked.profiles).toEqual([]);
  });

  it('shows the snippet in the description of the profile', async () => {
    const { read: profile } = await read({ [SITE_QUERY]: [OWN_ENTRY] }, null);
    expect(describeProfile(profile)).toContain('What the search index says about them: Experience: Acme · Education: Example University');
  });
});
