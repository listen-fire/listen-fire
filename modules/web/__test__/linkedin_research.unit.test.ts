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
  writer?: Record<string, unknown> | Error;
  profileText?: string | null;
  pages?: Record<string, string>;
  /** Runs inside each planner call, so a test can let the clock pass. */
  onPlan?: () => void;
}

function scripted(script: Script) {
  const asked = {
    searches: [] as string[],
    planner: [] as string[],
    writer: [] as string[],
    profiles: [] as string[],
    profileWaits: [] as Array<number | undefined>,
    fetches: [] as string[],
  };
  const plans = script.plans ?? [{ queries: [], terms: [], organisation: '', tied_down: true }];
  const tools: WebTools = {
    log: quiet,
    logFields: () => ({}),
    models: {
      anthropicChat: async (options) => {
        const plan = plans[Math.min(asked.planner.length, plans.length - 1)];
        script.onPlan?.();
        asked.planner.push(`${options.system}\n---\n${options.userMessage}`);
        return JSON.stringify(plan);
      },
      anthropicChatStructured: async (options) => {
        asked.writer.push(String(options.userMessage));
        if (script.writer instanceof Error) throw script.writer;
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
            getProfileTextByUrl: async (url, budget) => {
              asked.profiles.push(url);
              asked.profileWaits.push(budget?.maxWaitMs);
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

  it('tells the planner a location is never a term, and an organisation is never the caller\'s alone', async () => {
    const { tools, asked } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY] } });
    await research(tools);
    expect(asked.planner[0]).toContain('A location is never a term');
    expect(asked.planner[0]).toContain('Never report one that only the caller\'s text names');
  });

  it('refuses a query that searches on a location alone, and tells the planner why it should not write one', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: ['"Jane Doe" Sverige', '"Jane Doe" Sverige drones'], terms: ['Sverige'], organisation: '', tied_down: true }],
    });
    await research(tools);
    expect(asked.searches).toContain('"Jane Doe" Sverige drones');
    expect(asked.searches).not.toContain('"Jane Doe" Sverige');
    expect(asked.planner[0]).toContain('A location is never what a query searches on alone');
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
      plans: [{ queries: 'not a list' }],
      profileText: PROFILE_TEXT,
    });
    await research(tools);
    expect(asked.profiles).toEqual([]);
    expect(asked.searches).toEqual([SITE_QUERY]);
  });

  it('keeps the queries of a reply that forgot to say whether anything ties the person down, and buys no read', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY] },
      plans: [{ queries: ['"Jane Doe" Acme'], terms: ['Acme'], organisation: '' }],
      profileText: PROFILE_TEXT,
    });
    await research(tools);
    expect(asked.searches).toContain('"Jane Doe" Acme');
    expect(asked.profiles).toEqual([]);
    expect(asked.planner).toHaveLength(2);
  });

  describe('against the three minutes', () => {
    afterEach(() => jest.restoreAllMocks());

    const late = (elapsedMs: number) => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      return () => {
        now += elapsedMs;
      };
    };

    it('waits for the profile no longer than what is left of them', async () => {
      const pass = late(172_000);
      const { tools, asked } = scripted({
        index: { [SITE_QUERY]: [OWN_ENTRY] },
        plans: [{ queries: [], terms: [], organisation: '', tied_down: false }],
        profileText: PROFILE_TEXT,
        onPlan: pass,
      });
      await research(tools);
      expect(asked.profileWaits).toEqual([8_000]);
    });

    it('waits the fixed time when there is plenty left', async () => {
      const pass = late(1_000);
      const { tools, asked } = scripted({
        index: { [SITE_QUERY]: [OWN_ENTRY] },
        plans: [{ queries: [], terms: [], organisation: '', tied_down: false }],
        profileText: PROFILE_TEXT,
        onPlan: pass,
      });
      await research(tools);
      expect(asked.profileWaits).toEqual([75_000]);
    });
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
    expect(output.properties).toMatchObject({ activity_summary: 'Runs Acme [1].' });
    expect(output.properties?.activity_text).not.toContain('golfer');
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

  it('comes back as the text alone, with no summary and no confidence, when the writer finds nothing', async () => {
    const { tools } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [article] }, plans: [plan], writer: NOTHING });
    const { properties } = await research(tools);

    expect(Object.keys(properties ?? {})).toEqual(['activity_text']);
    expect(properties?.activity_text).toContain('https://news.example/acme\nAcme grows\nJane Doe, who runs Acme, said so.');
  });

  it('comes back the same way when the writer fails outright', async () => {
    const { tools } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [article] }, plans: [plan], writer: new Error('the writer is down') });
    const { properties } = await research(tools);
    expect(Object.keys(properties ?? {})).toEqual(['activity_text']);
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

  it('tries four addresses at most when pages will not load', async () => {
    const links = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => `https://news.example/${id}`);
    const { tools, asked } = scripted({
      index: {
        [SITE_QUERY]: [OWN_ENTRY],
        [query]: links.map((link) => ({ link, title: 'Acme', snippet: 'Jane Doe of Acme' })),
      },
      plans: [plan],
    });
    await research(tools);
    expect(asked.fetches).toEqual(links.slice(0, 4));
  });

  it('does not ask the writer to choose among namesakes when nothing ties the person to a result', async () => {
    const stranger = { link: 'https://stranger.example/team', title: 'Team', snippet: 'Jane Doe leads sales at Northwind' };
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY], '"Jane Doe" startup': [stranger] },
      plans: [{ queries: ['"Jane Doe" startup'], terms: [], organisation: '', tied_down: false }],
    });
    const output = await research(tools);
    expect(asked.writer).toEqual([]);
    expect(output.properties?.current_organisation).toBeUndefined();
    expect(output.properties?.activity_summary).toBeUndefined();
    expect(output.properties?.activity_text ?? '').not.toContain('Northwind');
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

describe('what ties a person down', () => {
  const query = '"Jane Doe" Acme';
  const acme = { link: 'https://news.example/acme', title: 'Acme grows', snippet: 'Jane Doe, who runs Acme, said so.' };
  // The title gives Sverige as the place, as OWN_ENTRY's does.
  const dentist = { link: 'https://news.example/dentist', title: 'Jane Doe opens a clinic', snippet: 'Jane Doe, a dentist in Sverige, opened a second clinic.' };

  it('keeps a same city namesake out of the text, however the planner terms read', async () => {
    const { tools } = scripted({
      index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [dentist, acme] },
      plans: [{ queries: [query], terms: ['Acme', 'Sverige'], organisation: '', tied_down: true }],
    });
    const text = String((await research(tools)).properties?.activity_text);
    expect(text).toContain('https://news.example/acme');
    expect(text).not.toContain('dentist');
  });

  it('admits nothing on a location written as a term', async () => {
    const { tools, asked } = scripted({
      index: { [SITE_QUERY]: [{ ...OWN_ENTRY, snippet: 'A profile.' }], [query]: [dentist] },
      plans: [{ queries: [query], terms: ['Sverige'], organisation: '', tied_down: true }],
      writer: NOTHING,
    });
    expect(await research(tools)).toEqual({});
    expect(asked.writer[0]).toContain('Consistency terms (the acceptance rule): the headline above');
    expect(asked.writer[0]).toContain('Location: Sverige');
  });

  it('tells the writer a location supports a result and never suffices', async () => {
    const { tools, asked } = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY] } });
    await research(tools);
    expect(asked.writer[0]).toContain('Location: Sverige');
    expect(asked.writer[0]).not.toContain('Consistency terms (the acceptance rule): Sverige');
  });

  describe('and what the caller said', () => {
    const context = 'Jane mentioned her work at Northwind in Slack';

    it('never becomes the organisation by itself', async () => {
      const { tools, asked } = scripted({
        index: { [SITE_QUERY]: [OWN_ENTRY] },
        plans: [{ queries: [], terms: ['Northwind'], organisation: 'Northwind', tied_down: true }],
        writer: { ...FOUND, current_organisation: '' },
      });
      const { properties } = await research(tools, { context });
      expect(asked.writer[0]).toContain('Organisation as read from the headline: unknown');
      expect(properties?.current_organisation).toBe('');
    });

    it('stays the organisation when the index says it too', async () => {
      const { tools, asked } = scripted({
        index: { [SITE_QUERY]: [{ ...OWN_ENTRY, snippet: 'Experience: Northwind · Education: Example University' }] },
        plans: [{ queries: [], terms: ['Northwind'], organisation: 'Northwind', tied_down: true }],
        writer: { ...FOUND, current_organisation: '' },
      });
      const { properties } = await research(tools, { context });
      expect(asked.writer[0]).toContain('Organisation as read from the headline: Northwind');
      expect(properties?.current_organisation).toBe('Northwind');
    });

    it('still gives a term to a result that names the person and it', async () => {
      const northwind = { link: 'https://news.example/northwind', title: 'Northwind hires', snippet: 'Jane Doe joined Northwind this spring.' };
      const { tools } = scripted({
        index: { [SITE_QUERY]: [OWN_ENTRY], '"Jane Doe" Northwind': [northwind] },
        plans: [{ queries: ['"Jane Doe" Northwind'], terms: ['Northwind'], organisation: '', tied_down: true }],
      });
      const { properties } = await research(tools, { context });
      expect(properties?.activity_text).toContain('https://news.example/northwind\nNorthwind hires\nJane Doe joined Northwind this spring.');
    });

    it('may settle that the person is tied down, which skips the paid read', async () => {
      const { tools, asked } = scripted({
        index: { [SITE_QUERY]: [OWN_ENTRY] },
        plans: [{ queries: [], terms: ['Northwind'], organisation: '', tied_down: true }],
        profileText: PROFILE_TEXT,
      });
      await research(tools, { context });
      expect(asked.profiles).toEqual([]);
    });
  });

  describe('and the confidence', () => {
    const rich = { link: PROFILE, title: 'Jane Doe - Founder - Acme | LinkedIn', snippet: 'Runs Acme' };
    const tiedDown = { queries: [query], terms: ['Acme'], organisation: 'Acme', tied_down: true };
    const outside = { ...FOUND, confidence: 'high', sources: ['https://news.example/acme'] };

    it('is the writer\'s when an accepted source lies beyond their own addresses, even on a thin title', async () => {
      const thin = scripted({ index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [acme] }, plans: [tiedDown], writer: outside });
      expect((await research(thin.tools)).properties?.activity_confidence).toBe('high');

      const full = scripted({ index: { [SITE_QUERY]: [rich], [query]: [acme] }, plans: [tiedDown], writer: { ...outside, confidence: 'medium' } });
      expect((await research(full.tools)).properties?.activity_confidence).toBe('medium');
    });

    it('is low when the accepted sources are only their own addresses', async () => {
      const post = 'https://www.linkedin.com/posts/jane-doe_launch-activity-1-abc';
      const { tools } = scripted({
        index: { [SITE_QUERY]: [rich] },
        plans: [tiedDown],
        writer: { ...FOUND, confidence: 'high', sources: [PROFILE, post] },
      });
      expect((await research(tools)).properties?.activity_confidence).toBe('low');
    });

    it('is low when the writer cites nothing, whatever it claims', async () => {
      const { tools } = scripted({ index: { [SITE_QUERY]: [rich] }, plans: [tiedDown], writer: { ...FOUND, confidence: 'high', sources: [] } });
      expect((await research(tools)).properties?.activity_confidence).toBe('low');
    });

    it('is low when nothing tied the person down and no profile was read', async () => {
      const { tools } = scripted({
        index: { [SITE_QUERY]: [rich], [query]: [acme] },
        plans: [{ ...tiedDown, tied_down: false }],
        writer: outside,
      });
      expect((await research(tools)).properties?.activity_confidence).toBe('low');
    });

    it('is the writer\'s once the profile has been read, though the first plan found nothing to tie them down', async () => {
      const { tools } = scripted({
        index: { [SITE_QUERY]: [OWN_ENTRY], [query]: [acme] },
        plans: [{ ...tiedDown, tied_down: false }, tiedDown],
        profileText: PROFILE_TEXT,
        writer: outside,
      });
      expect((await research(tools)).properties?.activity_confidence).toBe('high');
    });
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

  it.each([
    ['Past experience', 'Past experience:\n  - Founder @ Acme (2020)'],
    ['Education', 'Education:\n  - BSc in Physics @ Example University'],
    ['Current company', 'Current company: Founder @ Acme'],
    ['City', 'City: Zürich'],
    ['Country', 'Country: CH'],
  ])('reads a record opening on %s as having no name and no headline', async (_header, text) => {
    const { read: profile } = await read({}, text);
    expect(profile.identity).toMatchObject({ name: null, headline: null });
  });

  it('finds the name and headline of a labelled record wherever they sit', async () => {
    const { read: profile } = await read({}, 'Past experience:\n  - Founder @ Acme\nName: Jane Doe\nPosition: Founder');
    expect(profile.identity).toMatchObject({ name: 'Jane Doe', headline: 'Founder' });
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
