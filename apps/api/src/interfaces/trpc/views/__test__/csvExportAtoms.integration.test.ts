// The portfolio CSV export's value columns, over the share-for-share deal the
// whole model was designed around.
//
// The export ships the June 2026 column set: what we put in, what we still
// hold, what has come back as cash, and their sum. A row means "what I hold in
// this company, due to this investment", so a company sold for shares leaves
// TWO lines: the company we bought, with the money we put in and the cash it
// returned and nothing still held; and the company that bought it, carrying
// the shares with the invested and MOIC cells empty — we never bought it.
//
// The invariants: Total Value is exactly Realized Value + Unrealized Value on
// every line, nothing is counted twice (the shares appear on one line, not
// both), and the portfolio totals are the same numbers whichever line carries
// the value.
//
// Fixture toolkit mirrors lib/valuations/__test__/query.integration.test.ts.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getCoreQb, getValuationsQb } from '../../../../lib/kysely';
import { Context } from '../../../../services/context';
import { userPrincipal } from '../../../../services/principal';
import { trpc } from '../../trpc';
import { investmentsRouter } from '../investments';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import EventType from '../../../../generated/kysely/valuations/EventType';
import InvestmentType from '../../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import PriceType from '../../../../generated/kysely/valuations/PriceType';

const VALUATION_DATE = '2022-12-31';
const A_SHARE_PRICE = 3000;
const B_SHARE_PRICE = 2000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

class Scenario {
  readonly teamId: TeamId;
  readonly fundId: string;
  private readonly usdAssetIds = new Set<string>();

  private constructor(teamId: TeamId, fundId: string) {
    this.teamId = teamId;
    this.fundId = fundId;
  }

  static async create(): Promise<Scenario> {
    const teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      .values(anyVals({ id: teamId, name: `csv-${teamId.slice(0, 8)}` }))
      .execute();
    const s = new Scenario(teamId, randomUUID());
    await s.entity({ id: s.fundId, name: 'Our Fund', type: LegalEntityType.FUND, ownInvesting: true });
    return s;
  }

  async entity({
    id = randomUUID(),
    name,
    type = LegalEntityType.COMPANY,
    ownInvesting = false,
  }: {
    id?: string;
    name: string;
    type?: LegalEntityType;
    ownInvesting?: boolean;
  }): Promise<string> {
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          name,
          type,
          is_own_investing_entity: ownInvesting || null,
        }),
      )
      .execute();
    return id;
  }

  async asset({
    id = randomUUID(),
    issuerId,
    name,
    type,
  }: {
    id?: string;
    issuerId: string;
    name: string;
    type: AssetType;
  }): Promise<string> {
    await getValuationsQb(['asset'])
      .insertInto('asset')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          issued_by_legal_entity_id: issuerId,
          name,
          properties: {},
          type,
        }),
      )
      .execute();
    return id;
  }

  async usd(): Promise<string> {
    const assetId = randomUUID();
    await this.asset({ id: assetId, issuerId: this.fundId, name: 'USD', type: AssetType.CURRENCY });
    await getValuationsQb(['currency_asset'])
      .insertInto('currency_asset')
      .values(
        anyVals({
          id: randomUUID(),
          asset_id: assetId,
          iso_code: CurrencyIsoCode.USD,
          name: 'US Dollar',
          symbol: '$',
          pair_order: 1,
        }),
      )
      .execute();
    this.usdAssetIds.add(assetId);
    return assetId;
  }

  async investment({
    investeeId,
    investedAt,
    eventId = null,
    type = InvestmentType.CASH,
  }: {
    investeeId: string;
    investedAt?: string;
    eventId?: string | null;
    type?: InvestmentType;
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['investment'])
      .insertInto('investment')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          investor_profile_id: this.fundId,
          investment_profile_id: investeeId,
          invested_at: investedAt ?? null,
          event_id: eventId,
          type,
        }),
      )
      .execute();
    return id;
  }

  async event({
    legalEntityId,
    date,
    type,
  }: {
    legalEntityId: string;
    date: string;
    type: EventType;
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['event'])
      .insertInto('event')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          legal_entity_id: legalEntityId,
          name: 'Acquisition exit',
          type,
          date,
        }),
      )
      .execute();
    return id;
  }

  async transaction({
    date,
    investmentId = null,
    dueToRightsFromAssetId = null,
    transfers,
  }: {
    date: string;
    investmentId?: string | null;
    dueToRightsFromAssetId?: string | null;
    transfers: { assetId: string; num: number; from: string; to: string }[];
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['transaction'])
      .insertInto('transaction')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          close_date: date,
          investment_id: investmentId,
          due_to_rights_from_asset_id: dueToRightsFromAssetId,
        }),
      )
      .execute();
    await getValuationsQb(['asset_transfer'])
      .insertInto('asset_transfer')
      .values(
        transfers.map((t) =>
          anyVals({
            id: randomUUID(),
            team_id: this.teamId,
            transaction_id: id,
            date,
            asset_id: t.assetId,
            num_assets: t.num,
            from_legal_entity_id: t.from,
            to_legal_entity_id: t.to,
          }),
        ),
      )
      .execute();
    return id;
  }

  async price({
    assetId,
    issuerId,
    price,
    date,
  }: {
    assetId: string;
    issuerId: string;
    price: number;
    date: string;
  }): Promise<void> {
    await getValuationsQb(['price'])
      .insertInto('price')
      .values(
        anyVals({
          id: randomUUID(),
          team_id: this.teamId,
          date,
          price,
          currency: CurrencyIsoCode.USD,
          asset_id: assetId,
          legal_entity_id: issuerId,
          type: PriceType.FROM_ASSET_HOLDER,
        }),
      )
      .execute();
  }

  async acquiredBy({ company, acquirer }: { company: string; acquirer: string }): Promise<void> {
    await getValuationsQb(['legal_entity'])
      .updateTable('legal_entity')
      .set(anyVals({ acquired_by_legal_entity_id: acquirer }))
      .where('id', '=', company as never)
      .execute();
  }

  private caller() {
    return investmentsRouter(trpc.procedure).createCaller({ authorise: async () => {} });
  }

  csvExport({ aggregation = 'company' as const, name }: { aggregation?: 'company' | 'investment'; name?: string } = {}) {
    return withTeamContext(this.teamId, () =>
      this.caller().getCSVExport({
        filter: { name },
        config: { currency: CurrencyIsoCode.USD, valuationDate: VALUATION_DATE, aggregation },
        grouping: 'investment_date',
      }),
    );
  }

  async cleanup(): Promise<void> {
    await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', this.teamId).execute();
    for (const usdAssetId of this.usdAssetIds) {
      await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', usdAssetId as never).execute();
    }
    await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', this.teamId).execute();
    // legal_entity references itself through the acquisition link.
    await getValuationsQb(['legal_entity'])
      .updateTable('legal_entity')
      .set(anyVals({ acquired_by_legal_entity_id: null }))
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', this.teamId).execute();
    // Every write above fires the audit trigger that populates the
    // change-outbox, whose rows FK the team — drain it LAST, before the team.
    await getValuationsQb(['valuations_change_outbox'])
      .deleteFrom('valuations_change_outbox')
      .where('team_id', '=', this.teamId)
      .execute();
    await getCoreQb(['team']).deleteFrom('team').where('id', '=', this.teamId).execute();
  }
}

async function withTeamContext<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: randomUUID(), teamId }));
  return ctx.runAsync(fn);
}

/**
 * $50k for 20 A-shares; Company B buys Company A, paying for the whole
 * position in 15 B-shares plus $5k cash; then a $4k dividend from B on the
 * stock it issued in the swap. The deal also mints the acquirer-side
 * consideration investment the real acquisition command writes, tagged with
 * the exit's DISTRIBUTION event.
 *
 * So: $50k in, $9k of cash back, and 15 B-shares at $2k still held — held in
 * Company B, which is the line they belong on.
 */
async function seedShareForShare(scenario: Scenario) {
  const usd = await scenario.usd();
  const companyA = await scenario.entity({ name: 'Company A' });
  const companyB = await scenario.entity({ name: 'Company B' });
  const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
  const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
  const investment = await scenario.investment({ investeeId: companyA, investedAt: '2022-01-01' });

  await scenario.transaction({
    date: '2022-01-01',
    investmentId: investment,
    transfers: [
      { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
      { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
    ],
  });
  await scenario.transaction({
    date: '2022-06-01',
    transfers: [
      { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
      { assetId: bShares, num: 15, from: companyB, to: scenario.fundId },
      { assetId: usd, num: 5000, from: companyB, to: scenario.fundId },
    ],
  });
  await scenario.acquiredBy({ company: companyA, acquirer: companyB });
  await scenario.transaction({
    date: '2022-08-01',
    dueToRightsFromAssetId: bShares,
    transfers: [{ assetId: usd, num: 4000, from: companyB, to: scenario.fundId }],
  });

  // What addAcquisition writes alongside the swap: an investment INTO the
  // acquirer for the equity taken as proceeds, tagged via the exit's event.
  const exit = await scenario.event({
    legalEntityId: companyA,
    date: '2022-06-01',
    type: EventType.DISTRIBUTION,
  });
  const considerationInvestment = await scenario.investment({
    investeeId: companyB,
    investedAt: '2022-06-01',
    eventId: exit,
  });

  await scenario.price({ assetId: aShares, issuerId: companyA, price: A_SHARE_PRICE, date: '2022-01-02' });
  await scenario.price({ assetId: bShares, issuerId: companyB, price: B_SHARE_PRICE, date: '2022-06-02' });

  return { investment, considerationInvestment, companyA, companyB };
}

const SHARES_HELD = 15 * B_SHARE_PRICE;
const CASH_BACK = 9000;
const INVESTED = 50000;

describe('portfolio CSV export — the June column set', () => {
  let scenario: Scenario;
  let fixture: Awaited<ReturnType<typeof seedShareForShare>>;

  beforeAll(async () => {
    scenario = await Scenario.create();
    fixture = await seedShareForShare(scenario);
  });

  afterAll(async () => {
    await scenario.cleanup();
  });

  // One investment into one company, so the two aggregations differ only in
  // whether the projection is allowed to merge lines — and with a single
  // source there is nothing to merge, which is exactly the point: the row
  // contract is the same either way.
  describe.each(['company', 'investment'] as const)('aggregated by %s', (aggregation) => {
    it('leaves the sold company holding nothing, and reads as realised', async () => {
      const rows = await scenario.csvExport({ aggregation });
      const row = rows.find((r) => r.ID === fixture.companyA);
      if (!row) throw new Error('expected a line for the company we bought');

      expect(row['Total Invested']).toBeCloseTo(INVESTED, 6);
      // $5k of deal cash, plus $4k of dividend out of the stock the acquirer
      // paid with — cash is cash, and it came back on this investment.
      expect(row['Realized Value']).toBeCloseTo(CASH_BACK, 6);
      // The shares are a holding in Company B, and they are on its line.
      expect(row['Unrealized Value']).toBeNull();
      expect(row['Total Value']).toBeCloseTo(CASH_BACK, 6);
      expect(row.MOIC).toBeCloseTo(CASH_BACK / INVESTED, 6);
      // Nothing tracking Company A is still held, so nothing is left to come.
      expect(row.Status).toBe('realised');
      expect(row.Acquirer).toBe('Company B');
    });

    it('gives the acquirer a line for the shares, with the invested cells empty', async () => {
      const rows = await scenario.csvExport({ aggregation });
      const row = rows.find((r) => r.ID === fixture.companyB);
      if (!row) throw new Error('expected a line for the company that bought it');

      expect(row.Name).toBe('Company B');
      expect(row['Unrealized Value']).toBeCloseTo(SHARES_HELD, 6);
      expect(row['Total Value']).toBeCloseTo(SHARES_HELD, 6);
      expect(row['Realized Value']).toBeNull();
      // Blank, not zero: we never put money into Company B, so there is no
      // figure to put here and no return to state against it.
      expect(row['Total Invested']).toBeNull();
      expect(row.MOIC).toBeNull();
      expect(row.Status).toBe('active');

      // Exactly two lines, and the acquirer's own consideration investment is
      // not one of them.
      expect(rows).toHaveLength(2);
    });

    it('adds up without double counting: Total Value = Realized Value + Unrealized Value', async () => {
      const rows = await scenario.csvExport({ aggregation });

      for (const row of rows) {
        const realised = typeof row['Realized Value'] === 'number' ? row['Realized Value'] : 0;
        const unrealised = typeof row['Unrealized Value'] === 'number' ? row['Unrealized Value'] : 0;
        const total = typeof row['Total Value'] === 'number' ? row['Total Value'] : 0;

        expect(realised + unrealised).toBeCloseTo(total, 6);
      }
    });

    // The atoms are the deal: $50k in, $9k of cash back, $30k of shares still
    // held. Splitting them over two lines is all the projection does — the
    // portfolio totals, which sum the same atoms, are covered where a totals
    // caller exists (investmentsAcquisitionExclusion).
    it('spreads the same atoms over the two lines, creating none', async () => {
      const rows = await scenario.csvExport({ aggregation });

      const column = (name: string) =>
        rows.reduce(
          (sum, row) => sum + (typeof row[name] === 'number' ? (row[name] as number) : 0),
          0,
        );

      expect(column('Total Invested')).toBeCloseTo(INVESTED, 6);
      expect(column('Realized Value')).toBeCloseTo(CASH_BACK, 6);
      expect(column('Unrealized Value')).toBeCloseTo(SHARES_HELD, 6);
      expect(column('Total Value')).toBeCloseTo(CASH_BACK + SHARES_HELD, 6);
    });

    it('finds the acquirer by name, and returns only its line', async () => {
      const rows = await scenario.csvExport({ aggregation, name: 'Company B' });

      // Company A survives the SQL filter so this line can be minted from it,
      // and is dropped again once it has been: it is not what was searched for.
      expect(rows.map((row) => row.ID)).toEqual([fixture.companyB]);
      expect(rows[0]['Unrealized Value']).toBeCloseTo(SHARES_HELD, 6);
    });

    it('finds the company we bought by name, with what it turned into', async () => {
      const rows = await scenario.csvExport({ aggregation, name: 'Company A' });

      expect(rows.map((row) => row.ID)).toEqual([fixture.companyA, fixture.companyB]);
    });
  });
});
