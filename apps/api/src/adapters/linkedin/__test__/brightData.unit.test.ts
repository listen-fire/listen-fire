// How long the profile service is allowed to keep the caller waiting.
//
// The service collects a profile asynchronously and is polled every five
// seconds, so waiting IS the cost: a lookup of one named person can afford
// minutes, while a fetch of whatever link each record happens to carry, run
// once per record across a fan-out, cannot. The wait is therefore the
// caller's to name, and the caller that names nothing gets the patience the
// adapter has always had.

// Sleeping is what the poll loop does, and the loop measures itself against
// the wall clock — so the sleep moves the clock instead of the test.
jest.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    jest.setSystemTime(Date.now() + ms);
  },
}));

import { BrightDataAdapter } from '../brightData';

const PROFILE_URL = 'https://www.linkedin.com/in/ada-lovelace';

/** Answers as the dataset API does, with collection that never finishes
 *  unless `readyAfterPolls` says it does. Returns the poll counter. */
function serveProfileService({ readyAfterPolls }: { readyAfterPolls?: number } = {}) {
  const polls = { count: 0 };

  jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);

    if (url.includes('/datasets/v3/trigger')) {
      return new Response(JSON.stringify({ snapshot_id: 'snap-1' }), { status: 200 });
    }

    if (url.includes('/datasets/v3/progress/')) {
      polls.count += 1;
      const ready = readyAfterPolls != null && polls.count >= readyAfterPolls;
      return new Response(
        JSON.stringify({
          status: ready ? 'ready' : 'running',
          snapshot_id: 'snap-1',
          dataset_id: 'ds-1',
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify([{ id: 'p-1', name: 'Ada Lovelace' }]), { status: 200 });
  });

  return polls;
}

describe('the profile service’s wait', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('stops polling once the caller’s budget is spent, and returns nothing', async () => {
    const polls = serveProfileService();

    const result = await new BrightDataAdapter({ accessToken: 'k' }).getProfileTextByUrl(
      PROFILE_URL,
      { maxWaitMs: 15_000 },
    );

    // Three polls at five seconds apart, and then the caller has its answer:
    // nothing, fifteen seconds in, rather than nothing five minutes in.
    expect(polls.count).toBe(3);
    expect(result).toBeNull();
  });

  it('waits out the service’s own patience when the caller names no budget', async () => {
    const polls = serveProfileService();

    const result = await new BrightDataAdapter({ accessToken: 'k' }).getProfileTextByUrl(
      PROFILE_URL,
    );

    // Five minutes of five-second polls — the deliberate lookup's wait, left
    // exactly as it was.
    expect(polls.count).toBe(60);
    expect(result).toBeNull();
  });

  it('takes a profile that arrives inside the budget', async () => {
    const polls = serveProfileService({ readyAfterPolls: 2 });

    const result = await new BrightDataAdapter({ accessToken: 'k' }).getProfileTextByUrl(
      PROFILE_URL,
      { maxWaitMs: 15_000 },
    );

    expect(polls.count).toBe(2);
    expect(result?.text).toContain('Ada Lovelace');
  });

  it('honours a budget longer than the adapter’s own patience', async () => {
    const polls = serveProfileService();

    await new BrightDataAdapter({ accessToken: 'k', monitorTimeoutMs: 10_000 }).getProfileTextByUrl(
      PROFILE_URL,
      { maxWaitMs: 30_000 },
    );

    expect(polls.count).toBe(6);
  });
});
