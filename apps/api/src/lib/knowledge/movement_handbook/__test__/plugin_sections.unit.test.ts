// Plugin-declared handbook sections — the MACHINERY, not any one plugin's
// prose. The twin of `adapter_sections.unit.test.ts`, and deliberately the
// same shape: a synthetic manifest proves the assembly reads manifests at
// all, rather than passing on the day it stopped as long as one of the
// shipped plugins happened to still be listed somewhere.
//
// The prose contract is asserted BOTH ways — a well-written section holds it,
// and a sloppy one is caught — because a rule that never fails is a rule
// nobody can trust to be running.

import type { PluginManifest } from '../../../../services/translation_graph/engine/transforms/registry';
import { readBook } from '../../library';
import { pluginSectionChapters, getMovementHandbook } from '../index';
import { proseViolations } from './prose_rules';

const SECTION_MANIFEST: PluginManifest = {
  pluginName: 'tidy-up',
  importName: 'tidy_up',
  displayName: 'Tidy up',
  description: 'Strips the boilerplate off a message before anything reads it.',
  params: [],
  contextAdditions: 'Replaces the text the extraction reads with a tidier one.',
  additions: { properties: { tidied: { kind: 'string' } } },
  handbookSection: {
    title: 'Tidy up — trimming boilerplate before extraction',
    content: `## Tidy up — trimming boilerplate before extraction

A signature block and a quoted reply are noise the extraction pays for. This stage removes them.

### where-to-put-it

\`\`\`
extract from [msg.\`Text\`] through [tidy_up] {
  node company: "each company named" { name: "the company's name" }
}
\`\`\`

### Common mistakes

- **Putting it after the stage that reads the text.** Nothing has been tidied yet.`,
  },
};

const PLAIN_MANIFEST: PluginManifest = {
  pluginName: 'plainly',
  importName: 'plainly',
  displayName: 'Plainly',
  description: 'Does one thing and declares no chapter about it.',
  params: [],
  contextAdditions: 'Nothing worth a chapter.',
  additions: {},
};

describe('plugin-declared handbook sections', () => {
  it('renders a declared section as a chapter namespaced by the imported name', () => {
    const chapters = pluginSectionChapters([SECTION_MANIFEST]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].id).toBe('plugin:tidy_up');
    expect(chapters[0].title).toBe(SECTION_MANIFEST.handbookSection?.title);
    expect(chapters[0].content).toContain('trimming boilerplate');
  });

  it('contributes nothing for a plugin that declares no section', () => {
    expect(pluginSectionChapters([PLAIN_MANIFEST])).toEqual([]);
  });

  it('holds a declared section to the same prose contract as a written chapter', () => {
    expect(proseViolations(pluginSectionChapters([SECTION_MANIFEST])[0])).toEqual([]);
  });

  it('catches a section that breaks the contract (the rules genuinely bite)', () => {
    const sloppy: PluginManifest = {
      ...SECTION_MANIFEST,
      handbookSection: {
        title: 'Tidy up',
        content: 'Write a movement that tidies each message, one for each founder you meet.',
      },
    };
    expect(proseViolations(pluginSectionChapters([sloppy])[0])).toEqual([
      'teaches the retired `for each`',
      'is tuned to one use case: "founder"',
      'says "movement" outside code',
    ]);
  });
});

describe('the shipped plugin sections', () => {
  // Every bundled plugin, a namespaced chapter each, one assembly — which is
  // what makes this a mechanism rather than a feature of whichever plugin got
  // a chapter first. The two retrieval markers are the choice a reader is here
  // to make: scan a message, or load the link a record already carries; the
  // two LinkedIn ones are the other choice — a name in, or an address in. The
  // research one is the choice not to choose: it takes whatever the record has.
  it.each([
    ['plugin:vc_url_retrieval', 'through [vc_url_retrieval]'],
    ['plugin:fetch_url', 'through [fetch_url(url: website)]'],
    ['plugin:linkedin_enrichment', 'through [linkedin_enrichment]'],
    ['plugin:linkedin_research', 'through [linkedin_research(url: linkedin)]'],
    ['plugin:web_research', 'web_research(name: name, context: description'],
    ['plugin:research', 'questions: "what it does, which sector it is in, where it is based"'],
  ])('%s is on the shelf and reads back', (chapter, marker) => {
    const read = readBook({ bookId: 'automations', chapter });
    if (!('content' in read)) throw new Error('expected a chapter body');
    expect(read.content).toContain(marker);
  });

  it('assembles alongside the adapter sections and the written chapters', () => {
    const chapters = getMovementHandbook().chapters;
    expect(chapters['plugin:fetch_url']).toBeDefined();
    expect(chapters['system:slack']).toBeDefined();
    expect(chapters.foundations).toBeDefined();
  });

  it('teaches the placement choice each retrieval plugin is for', () => {
    const chapters = getMovementHandbook().chapters;
    // The scanning one warns against a per-record stage; the targeted one
    // warns against a top-of-extract stage. Between them an author is told
    // which placement each is for, which is the load-bearing decision.
    expect(chapters['plugin:vc_url_retrieval']?.content).toContain("behind a record's stage");
    expect(chapters['plugin:fetch_url']?.content).toContain('at the top of the extract');
  });

  it('teaches that a required argument resolving empty skips that record alone', () => {
    const fetchUrl = getMovementHandbook().chapters['plugin:fetch_url'];
    expect(fetchUrl?.content).toContain('when-the-field-is-empty');
    expect(fetchUrl?.content).toContain('skipped for that record alone');
  });

  it('teaches access carried in the content apart from a connection’s own keys', () => {
    const fetchUrl = getMovementHandbook().chapters['plugin:fetch_url'];
    expect(fetchUrl?.content).toContain('deck_password');
    expect(fetchUrl?.content).toContain('never written in source');
  });
});
