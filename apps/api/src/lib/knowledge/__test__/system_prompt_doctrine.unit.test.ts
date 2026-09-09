import { buildSystemBlocks } from '../unified_agent';
import { getMovementDoctrine } from '../movement_handbook';
import { getLibraryShelf } from '../library';

// The movement-authoring doctrine ("write along edges, never flat rows",
// use-cases-first, factor-don't-copy) is sourced from the handbook's
// `foundations` chapter, NOT an inline prompt constant. These tests are
// the load-bearing guard that the DRY refactor kept the prompt
// content-equivalent AND the prompt-cache layout unchanged.

// movements.author WITHOUT knowledge.read keeps buildSystemBlocks free of
// any DB call (no graph schema, no recipes), so the test runs hermetically
// while still exercising the authoring section where the doctrine lives.
const AUTHORING_ONLY = ['movements.author'] as const;

describe('system prompt — doctrine sourced from the handbook', () => {
  it('the doctrine block IS the foundations chapter body (single source)', async () => {
    const doctrine = getMovementDoctrine();
    // It is the real chapter, not a stub.
    expect(doctrine).toMatch(/the\s+cardinal rule/i);
    expect(doctrine).toMatch(/write\s+them along their edges/i);
    expect(doctrine).toMatch(/use-cases/);
    expect(doctrine).toMatch(/Two near-identical automations\s+are a smell/);
  });

  it('the assembled authoring prompt contains the doctrine verbatim, in the authoring section', async () => {
    const blocks = await buildSystemBlocks({
      teamId: 'team-test',
      scopes: AUTHORING_ONLY as unknown as Parameters<typeof buildSystemBlocks>[0]['scopes'],
    });
    const block0 = blocks[0].text;
    const doctrine = getMovementDoctrine();

    // Whole doctrine present verbatim — content-equivalence with the old
    // inline constant's role.
    expect(block0).toContain(doctrine);

    // ...and positioned INSIDE the authoring section (after its heading,
    // before the build-stage / save instructions) — same stable slot the
    // inline constant occupied.
    const authoringIdx = block0.indexOf('## Authoring movements');
    const doctrineIdx = block0.indexOf(doctrine);
    expect(authoringIdx).toBeGreaterThanOrEqual(0);
    expect(doctrineIdx).toBeGreaterThan(authoringIdx);
  });

  it('the doctrine is deploy-static — identical across two builds (no per-request variability)', async () => {
    const a = await buildSystemBlocks({
      teamId: 'team-A',
      scopes: AUTHORING_ONLY as unknown as Parameters<typeof buildSystemBlocks>[0]['scopes'],
    });
    const b = await buildSystemBlocks({
      teamId: 'team-B',
      scopes: AUTHORING_ONLY as unknown as Parameters<typeof buildSystemBlocks>[0]['scopes'],
    });
    // Same scope set, different team, no knowledge.read → block 0 (the
    // cached prefix) must be byte-identical, doctrine included.
    expect(a[0].text).toEqual(b[0].text);
  });
});

describe('readBook / Library shelf surfaces the doctrine as a chapter', () => {
  it('the automations book lists `foundations`, body == the injected doctrine, discoverable via intent index', () => {
    const automations = getLibraryShelf().find((b) => b.bookId === 'automations');
    expect(automations).toBeDefined();
    const ch = automations!.chapters.find((c) => c.id === 'foundations');
    expect(ch).toBeDefined();
    expect(ch!.title).toMatch(/Foundations/);
    // The exact body readBook returns is the exact body the agent injects.
    expect(ch!.content).toEqual(getMovementDoctrine());
    // Discoverable: an intent entry routes to it.
    expect(automations!.intentIndex.some((e) => e.chapter === 'foundations')).toBe(true);
  });
});

describe('system prompt — cache layout is unchanged by the refactor', () => {
  it('authoring-only build is exactly one cached block (block 0), no extra breakpoints', async () => {
    const blocks = await buildSystemBlocks({
      teamId: 'team-test',
      scopes: AUTHORING_ONLY as unknown as Parameters<typeof buildSystemBlocks>[0]['scopes'],
    });
    // No knowledge.read, no funnel → exactly the shared prefix block.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cacheControl).toBe('ephemeral');
  });

  it('cache_control markers never exceed Anthropic\'s 4-breakpoint cap', async () => {
    // The widest layout: read + edit + author + funnel context. This is the
    // structural invariant the prior prompt-cache fix pinned; the doctrine
    // refactor must not have added a breakpoint.
    const blocks = await buildSystemBlocks({
      teamId: 'team-test',
      scopes: ['movements.author', 'runs.read'] as unknown as Parameters<
        typeof buildSystemBlocks
      >[0]['scopes'],
    });
    const cached = blocks.filter((b) => b.cacheControl === 'ephemeral');
    expect(cached.length).toBeLessThanOrEqual(4);
    // The doctrine still rides in the shared prefix block (block 0), the
    // first cached block — it did not become its own breakpoint.
    expect(blocks[0].cacheControl).toBe('ephemeral');
    expect(blocks[0].text).toContain(getMovementDoctrine());
  });
});
