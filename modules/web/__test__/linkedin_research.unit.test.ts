// A stealth headline reads the profile. The index entry says "Stealth", which
// names nothing to check a search result against, so the plugin reads the
// profile's experience and plans its search on the founder history there
// rather than on the bare name.

import type { WebTools } from '../tools';

import { linkedinResearchPlugin } from '../linkedin_research';
import { withTools } from '../tools';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const PROFILE = 'https://www.linkedin.com/in/jane-doe';
const PROFILE_TEXT = [
  'Jane Doe',
  'Stealth',
  'Experience',
  'Stealth · Founder · 2023–present',
  'Acme Drones · Co-founder & CTO · 2013–2022 · Zürich',
].join('\n');

function stealthTools(asked: { profiles: string[]; planner: string[] }): WebTools {
  return {
    log: quiet,
    logFields: () => ({}),
    models: {
      anthropicChat: async (options) => {
        asked.planner.push(JSON.stringify(options.userMessage));
        return JSON.stringify({
          organisation: '',
          queries: [{ query: '"Jane Doe" "Acme Drones" founder', worth_reading: false }],
          terms: ['Acme Drones', 'drones'],
        });
      },
      anthropicChatStructured: async () =>
        ({
          found: true,
          confidence: 'medium',
          current_role: 'Founder, in stealth (previously Co-founder & CTO)',
          current_organisation: 'Acme Drones',
          summary: 'Previously co-founded Acme Drones (drones) [1]; now in stealth.',
          sources: ['https://news.example/acme-drones'],
        }) as never,
      anthropicWebChat: async () => {
        throw new Error('not used');
      },
    },
    searchProvider: () => 'fake',
    search: async (query) =>
      query.includes('Acme Drones')
        ? { items: [{ link: 'https://news.example/acme-drones', title: 'Acme Drones', snippet: 'Jane Doe, CTO of Acme Drones' }] }
        : { items: [{ link: PROFILE, title: 'Jane Doe - Stealth | LinkedIn', snippet: '' }] },
    findLinkedIn: async () => [],
    scrape: async () => '',
    missingScraperSettings: () => [],
    profiles: {
      getProfileTextByUrl: async (url) => {
        asked.profiles.push(url);
        return { text: PROFILE_TEXT };
      },
    },
    isDocumentSource: () => false,
    fetchResource: async () => null,
    fileValues: async (handles) => handles.map(() => undefined),
  };
}

describe('linkedin-research on a stealth headline', () => {
  it('reads the profile, plans on its history, and keeps the confidence', async () => {
    const asked = { profiles: [] as string[], planner: [] as string[] };
    const output = await withTools(stealthTools(asked), () =>
      linkedinResearchPlugin.run({ kind: 'context-dependent', config: { url: PROFILE }, extractedContext: {} }),
    );

    expect(asked.profiles).toEqual([PROFILE]);
    expect(asked.planner[0]).toContain('Acme Drones · Co-founder & CTO');
    expect(output.properties).toMatchObject({
      activity_confidence: 'medium',
      current_organisation: 'Acme Drones',
    });
  });
});
