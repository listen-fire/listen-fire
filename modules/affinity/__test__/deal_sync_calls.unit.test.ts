// How many Affinity calls one deal of a recap costs, by what they were spent
// on. The recap of 26 October stopped at the run's ceiling with half its deals
// synced, nearly all of them ending "matched, nothing changed" — so these
// counts are the budget, and each expectation below is a number somebody
// decided to pay.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { withSegment } from 'movement-engine/public/adapter-support';

import {
  FakeAffinity,
  adapterOver,
  countCalls,
  dealFor,
  seedSyncedDeal,
  seedWorkspace,
  upsertDeal,
  type CallCounts,
} from './deal_sync_fixture';

/** One run segment, as the engine opens it for a run. */
const inARun = <T>(fn: () => Promise<T>) => withSegment({ teamId: '00000000-0000-0000-0000-000000000099' }, fn);

const VELTHA = { name: 'Veltha', host: 'veltha.ai', founder: { first: 'Ines', last: 'Veltha', linkedin: 'https://linkedin.com/in/ines' } };
const NORDA = { name: 'Norda Labs', host: 'norda.io', founder: { first: 'Ola', last: 'Norda', linkedin: 'https://linkedin.com/in/ola' } };
const FRESH = { name: 'Brandnew Robotics', host: 'brandnew.dev', founder: { first: 'Kai', last: 'Brandnew', linkedin: 'https://linkedin.com/in/kai' } };

const company = (n: number) => ({
  name: `Company ${n}`,
  host: `company${n}.example`,
  founder: { first: `Founder${n}`, last: `Of${n}`, linkedin: `https://linkedin.com/in/f${n}` },
});

/**
 * Where the adapter runs decides what a call costs.
 *
 * - `platform`: in process, each adapter call inside its run's segment, so a
 *   record or search read once in a run is read once (the run memo).
 * - `lf`: `lf` serves the module in a process of its own, and nothing opens a
 *   run scope around its calls there, so every read goes to Affinity. This is
 *   how Project A runs it. Measured through `lf run` of `Upsert Deal`
 *   (real_engine/): the requests match the `lf` rows here call for call, less
 *   the two `Deal Created` reads the copy run there could not check.
 */
type Host = 'platform' | 'lf';
const under = <T>(host: Host, fn: () => Promise<T>) => (host === 'platform' ? inARun(fn) : fn());

/** The calls one deal costs once the run is warm: the workspace's shape
 *  already read, and the owners already met on an earlier deal. */
async function warmDealCost(
  host: Host,
  setup: (fake: FakeAffinity, owners: ReturnType<typeof seedWorkspace>['owners']) => typeof VELTHA,
): Promise<CallCounts> {
  const fake = new FakeAffinity();
  const { owners } = seedWorkspace(fake);
  seedSyncedDeal(fake, owners, NORDA);
  const deal = setup(fake, owners);
  fake.install();
  const adapter = adapterOver(fake);
  return under(host, async () => {
    await upsertDeal(adapter, dealFor(NORDA));
    const before = fake.requests.length;
    await upsertDeal(adapter, dealFor(deal));
    return countCalls(fake.requests.slice(before));
  });
}

/** Half the recap's deals already exist untouched, a few gain a field, a few
 *  are new — in an order that puts every kind after every other. */
async function sixDealRun(host: Host): Promise<CallCounts> {
  const fake = new FakeAffinity();
  const { owners } = seedWorkspace(fake);
  const plan: Array<{ deal: ReturnType<typeof company>; seed: 'synced' | 'empty-field' | 'new' }> = [
    { deal: company(1), seed: 'synced' },
    { deal: company(2), seed: 'new' },
    { deal: company(3), seed: 'empty-field' },
    { deal: company(4), seed: 'synced' },
    { deal: company(5), seed: 'new' },
    { deal: company(6), seed: 'synced' },
  ];
  for (const { deal, seed } of plan) {
    if (seed !== 'new') seedSyncedDeal(fake, owners, deal, { emptyDealSource: seed === 'empty-field' });
  }
  fake.install();
  const adapter = adapterOver(fake);
  await under(host, async () => {
    for (const { deal } of plan) await upsertDeal(adapter, dealFor(deal));
  });
  return countCalls(fake.requests);
}

const counts = (orgSearch: number, personSearch: number, fieldValueRead: number, recordRead: number, schema: number, write: number) => ({
  orgSearch,
  personSearch,
  fieldValueRead,
  recordRead,
  schema,
  write,
  total: orgSearch + personSearch + fieldValueRead + recordRead + schema + write,
});

describe.each([
  {
    host: 'platform' as const,
    unchanged: counts(2, 1, 3, 2, 0, 0),
    oneField: counts(2, 1, 5, 2, 0, 1),
    fresh: counts(4, 1, 6, 1, 0, 13),
    run: counts(16, 12, 28, 12, 4, 27),
  },
  {
    host: 'lf' as const,
    unchanged: counts(3, 3, 10, 12, 0, 0),
    oneField: counts(3, 3, 12, 12, 0, 1),
    fresh: counts(6, 4, 8, 14, 0, 13),
    run: counts(24, 20, 58, 76, 4, 27),
  },
])('calls under $host', ({ host, unchanged, oneField, fresh, run }) => {
  it('(a) a warm deal where everything exists and nothing changes', async () => {
    expect(
      await warmDealCost(host, (fake, owners) => {
        seedSyncedDeal(fake, owners, VELTHA);
        return VELTHA;
      }),
    ).toEqual(unchanged);
  });

  it('(b) a warm deal where everything exists and one field changes', async () => {
    expect(
      await warmDealCost(host, (fake, owners) => {
        seedSyncedDeal(fake, owners, VELTHA, { emptyDealSource: true });
        return VELTHA;
      }),
    ).toEqual(oneField);
  });

  it('(c) a warm new deal', async () => {
    expect(await warmDealCost(host, () => FRESH)).toEqual(fresh);
  });

  it('(d) six deals: unchanged, new, one field changed, unchanged, new, unchanged', async () => {
    expect(await sixDealRun(host)).toEqual(run);
  });
});

// ── What the counts must not cost ───────────────────────────────────────────
//
// Every call saved above is a read not made, so each of these asks the
// question a missing read would answer wrongly.

describe('a deal sync reads what is there', () => {
  it('a field the deal fills is logged from empty to the value asked', async () => {
    const fake = new FakeAffinity();
    const { owners } = seedWorkspace(fake);
    seedSyncedDeal(fake, owners, VELTHA, { emptyDealSource: true });
    fake.install();
    const adapter = adapterOver(fake);

    const outcome = await inARun(() => upsertDeal(adapter, dealFor(VELTHA)));

    expect(outcome.changes).toEqual(['Deal Source: ∅ → `Quality Dealflow`']);
    expect(fake.requests.filter((r) => r.startsWith('POST /field-values'))).toHaveLength(1);
  });

  it('a plainly set field that differs is logged from the old value to the new', async () => {
    const fake = new FakeAffinity();
    const { owners } = seedWorkspace(fake);
    seedSyncedDeal(fake, owners, VELTHA, { orgName: 'Veltha GmbH' });
    fake.install();
    const adapter = adapterOver(fake);

    const outcome = await inARun(() => upsertDeal(adapter, dealFor(VELTHA)));

    expect(outcome.changes).toEqual(['Name: `Veltha GmbH` → `Veltha`']);
  });

  it('a value this run wrote reads back as written, so the same deal again changes nothing', async () => {
    const fake = new FakeAffinity();
    const { owners } = seedWorkspace(fake);
    seedSyncedDeal(fake, owners, VELTHA, { emptyDealSource: true });
    fake.install();
    const adapter = adapterOver(fake);

    const [first, second] = await inARun(async () => [
      await upsertDeal(adapter, dealFor(VELTHA)),
      await upsertDeal(adapter, dealFor(VELTHA)),
    ]);

    expect(first.changes).toEqual(['Deal Source: ∅ → `Quality Dealflow`']);
    expect(second.found.entry?.['Deal Source']).toBe('Quality Dealflow');
    expect(second.changes).toEqual([]);
    expect(fake.requests.filter((r) => r.startsWith('POST /field-values'))).toHaveLength(1);
  });

  it('a company this run created is found by a later deal in the same run, not created twice', async () => {
    const fake = new FakeAffinity();
    seedWorkspace(fake);
    fake.install();
    const adapter = adapterOver(fake);

    const [first, second] = await inARun(async () => [
      await upsertDeal(adapter, dealFor(FRESH)),
      await upsertDeal(adapter, dealFor(FRESH)),
    ]);

    expect(second.orgId).toBe(first.orgId);
    expect(second.entryId).toBe(first.entryId);
    expect(fake.requests.filter((r) => r === 'POST /organizations')).toHaveLength(1);
    expect(fake.requests.filter((r) => r === 'POST /persons')).toHaveLength(1);
    expect(fake.requests.filter((r) => r.startsWith('POST /lists/'))).toHaveLength(1);
  });

  it('a second run asks Affinity again: nothing one run read answers the next', async () => {
    const fake = new FakeAffinity();
    const { owners } = seedWorkspace(fake);
    seedSyncedDeal(fake, owners, VELTHA);
    fake.install();
    const adapter = adapterOver(fake);

    await inARun(() => upsertDeal(adapter, dealFor(VELTHA)));
    const firstRun = countCalls(fake.requests);
    // Somebody fills a value in Affinity between the runs.
    fake.org({ name: 'Veltha Two', domain: 'veltha-two.ai' });
    const before = fake.requests.length;
    await inARun(() => upsertDeal(adapter, dealFor(VELTHA)));
    const secondRun = countCalls(fake.requests.slice(before));

    expect(secondRun.orgSearch).toBe(firstRun.orgSearch);
    expect(secondRun.personSearch).toBe(firstRun.personSearch);
    expect(secondRun.fieldValueRead).toBe(firstRun.fieldValueRead);
  });
});
