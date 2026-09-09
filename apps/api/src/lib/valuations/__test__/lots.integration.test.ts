// Leaf lots — the roll-up's flows with their causal facts resolved.
//
// A lot is one attributed flow in one (investing entity, investee) bucket,
// carrying where the value came from (provenance) and how many exchanges it
// sits away from the company we invested in (degree). Degree is bucket-scoped:
// 0 when the asset tracks that bucket's investee, otherwise one more than its
// predecessor's, so a conversion INTO something that tracks resets to 0 while
// an acquirer's shares taken in a swap step out to 1.
//
// These are the first direct tests of three behaviours the valuation fixtures
// only ever exercised through their totals: canonicalInvestee anchoring,
// exchange-proportion attribution, and one-way (dividend) attribution. The last
// case pins the whole point of the annotation — lots must re-aggregate to the
// holdings the walk produced, or the two paths have silently diverged.
//
// Fixture toolkit mirrors tracks_investee_realisation.integration.test.ts.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { getCoreQb, getValuationsQb } from '../../kysely';
import { Context } from '../../../services/context';
import { userPrincipal } from '../../../services/principal';
import { getLotsForInvestments, Lot, rollUpHoldings } from '../inventory';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import InvestmentType from '../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';

const AS_OF_DATE = new Date('2024-12-31');

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
      .values(anyVals({ id: teamId, name: `lot-${teamId.slice(0, 8)}` }))
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
    underlyingCompanyId,
  }: {
    id?: string;
    name: string;
    type?: LegalEntityType;
    ownInvesting?: boolean;
    underlyingCompanyId?: string;
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
          underlying_company_id: underlyingCompanyId ?? null,
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
    properties = {},
  }: {
    id?: string;
    issuerId: string;
    name: string;
    type: AssetType;
    properties?: Record<string, unknown>;
  }): Promise<string> {
    await getValuationsQb(['asset'])
      .insertInto('asset')
      .values(
        anyVals({
          id,
          team_id: this.teamId,
          issued_by_legal_entity_id: issuerId,
          name,
          properties,
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
    type = InvestmentType.CASH,
  }: {
    investeeId: string;
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
          type,
        }),
      )
      .execute();
    return id;
  }

  /** One transaction with a set of transfers. `dueToRightsFromAssetId` is the
   *  explicit causal link a dividend carries when the source recorded which
   *  holding it was paid on. */
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

  lots(investmentId: string): Promise<Lot[]> {
    return withTeamContext(this.teamId, () =>
      getLotsForInvestments({ investmentIds: [investmentId], asOfDate: AS_OF_DATE }),
    );
  }

  holdings(investmentId: string) {
    return withTeamContext(this.teamId, async () => {
      const { holdings } = await rollUpHoldings({
        investmentIds: [investmentId],
        asOfDate: AS_OF_DATE,
      });
      return holdings;
    });
  }

  async cleanup(): Promise<void> {
    await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', this.teamId).execute();
    for (const usdAssetId of this.usdAssetIds) {
      await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', usdAssetId as never).execute();
    }
    await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', this.teamId).execute();
    await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', this.teamId).execute();
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

const forAsset = (lots: Lot[], assetId: string) =>
  lots.filter((lot) => lot.assetKey.split(':')[0] === assetId);

const total = (lots: Lot[]) => lots.reduce((sum, lot) => sum + lot.numAssets, 0);

describe('leaf lots — degree, provenance and tense', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('steps consideration and its cash component out to degree 1', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    // B acquires A for stock plus a $10k cash component.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 30, from: companyB, to: scenario.fundId },
        { assetId: usd, num: 10000, from: companyB, to: scenario.fundId },
      ],
    });

    const lots = await scenario.lots(investment);

    // The original equity tracks the investee both coming in and going out.
    expect(forAsset(lots, aShares).map((l) => [l.numAssets, l.degree, l.tense])).toEqual([
      [20, 0, 'live'],
      [-20, 0, 'live'],
    ]);

    // The acquirer's shares are one exchange out, and say so.
    const bLots = forAsset(lots, bShares);
    expect(bLots).toHaveLength(1);
    expect(bLots[0]).toMatchObject({ numAssets: 30, degree: 1, provenanceAssetId: aShares, tense: 'live' });

    // Cash paid in is a root outflow; cash taken in the deal descends from the
    // disposed equity, so it is degree 1 — not degree 0 alongside the invested
    // cash, and not degree 2 as if it had come out of the B-shares.
    const cash = forAsset(lots, usd);
    expect(cash.every((lot) => lot.tense === 'fact')).toBe(true);
    expect(cash.filter((l) => l.numAssets < 0)).toMatchObject([
      { numAssets: -50000, degree: 0, provenanceAssetId: null },
    ]);
    expect(cash.filter((l) => l.numAssets > 0)).toMatchObject([
      { numAssets: 10000, degree: 1, provenanceAssetId: aShares },
    ]);
  });

  it('resets to degree 0 when a SAFE converts into equity that tracks', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const safe = await scenario.asset({ issuerId: companyA, name: 'A SAFE', type: AssetType.CONVERTIBLE });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: safe, num: 1, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: safe, num: 1, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 100, from: companyA, to: scenario.fundId },
      ],
    });

    const lots = await scenario.lots(investment);

    // The received equity has a predecessor, but it tracks Company A, so the
    // count restarts rather than stepping to 1.
    const equity = forAsset(lots, aShares);
    expect(equity).toMatchObject([{ numAssets: 100, degree: 0, provenanceAssetId: safe }]);
    expect(forAsset(lots, safe).every((lot) => lot.degree === 0)).toBe(true);
  });

  // `due_to_rights_from_asset_id` is the walk edge that tells a dividend on the
  // original company apart from one on the stock we took for it. Both payments
  // below are identical in shape and amount-attribution; only the recorded
  // rights link differs, and it alone decides degree 1 vs degree 2.
  it('separates a dividend on the original company from one on acquirer stock', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    // Half the position is swapped, so the bucket holds both degrees at once.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 10, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 15, from: companyB, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-08-01',
      dueToRightsFromAssetId: aShares,
      transfers: [{ assetId: usd, num: 4000, from: companyA, to: scenario.fundId }],
    });
    await scenario.transaction({
      date: '2024-09-01',
      dueToRightsFromAssetId: bShares,
      transfers: [{ assetId: usd, num: 4000, from: companyA, to: scenario.fundId }],
    });

    const lots = await scenario.lots(investment);
    const received = forAsset(lots, usd).filter((lot) => lot.numAssets > 0);

    expect(received).toMatchObject([
      { numAssets: 4000, degree: 1, provenanceAssetId: aShares },
      { numAssets: 4000, degree: 2, provenanceAssetId: bShares },
    ]);
  });

  it('puts proceeds of an acquirer-share sale at degree 2', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const buyer = await scenario.entity({ name: 'Secondary Buyer' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 30, from: companyB, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-09-01',
      transfers: [
        { assetId: bShares, num: 5, from: scenario.fundId, to: buyer },
        { assetId: usd, num: 20000, from: buyer, to: scenario.fundId },
      ],
    });

    const lots = await scenario.lots(investment);

    // The disposal carries the degree its holding arrived at, so held-B nets to
    // 25 entirely within degree 1 — a disposal must never leave a partition.
    const bLots = forAsset(lots, bShares);
    expect(bLots.every((lot) => lot.degree === 1)).toBe(true);
    expect(total(bLots)).toBeCloseTo(25, 6);

    expect(forAsset(lots, usd).filter((lot) => lot.numAssets > 0)).toMatchObject([
      { numAssets: 20000, degree: 2, provenanceAssetId: bShares },
    ]);
  });

  it('splits an exchange by the same proportion the walk attributed', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const seller = await scenario.entity({ name: 'Secondary Seller' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });
    const secondary = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    // 10 more A-shares bought off a secondary seller — not this investment's.
    await scenario.transaction({
      date: '2024-03-01',
      investmentId: secondary,
      transfers: [
        { assetId: usd, num: 25000, from: scenario.fundId, to: seller },
        { assetId: aShares, num: 10, from: seller, to: scenario.fundId },
      ],
    });
    // Swap 25 of the 30 A-shares for 40 B-shares. FIFO takes the 20 investment
    // shares first, so 20/25 of the consideration is this investment's.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 25, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 40, from: companyB, to: scenario.fundId },
      ],
    });

    const lots = await scenario.lots(investment);
    const bLots = forAsset(lots, bShares);

    expect(bLots.every((lot) => lot.degree === 1 && lot.provenanceAssetId === aShares)).toBe(true);
    expect(bLots.filter((l) => l.source === 'INVESTMENT').map((l) => l.numAssets)).toEqual([32]);
    expect(bLots.filter((l) => l.source === 'OTHER').map((l) => l.numAssets)).toEqual([8]);
  });

  it('leaves a wound-down disposal interior, with no value beyond the payout', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    // Liquidation payout, then the void transfer of the worthless shares back.
    await scenario.transaction({
      date: '2024-11-01',
      dueToRightsFromAssetId: aShares,
      transfers: [{ assetId: usd, num: 2000, from: companyA, to: scenario.fundId }],
    });
    await scenario.transaction({
      date: '2024-11-02',
      transfers: [{ assetId: aShares, num: 20, from: scenario.fundId, to: companyA }],
    });

    const lots = await scenario.lots(investment);

    // Nothing held is left: the equity's lots cancel, and the disposal stays at
    // degree 0 rather than opening a new partition.
    const equity = forAsset(lots, aShares);
    expect(total(equity)).toBeCloseTo(0, 6);
    expect(equity.every((lot) => lot.degree === 0)).toBe(true);

    // The only value that leaves the DAG is the cash payout.
    expect(forAsset(lots, usd).filter((lot) => lot.numAssets > 0)).toMatchObject([
      { numAssets: 2000, degree: 1, provenanceAssetId: aShares },
    ]);
  });

  it('splits a one-way payment across a bucket holding two degrees at once', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    // Only half the position is swapped, so the bucket carries a degree-0
    // remainder alongside degree-1 consideration.
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 10, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 15, from: companyB, to: scenario.fundId },
      ],
    });
    // A payment attributed across both holdings by the existing equity split.
    await scenario.transaction({
      date: '2024-09-01',
      transfers: [{ assetId: usd, num: 5000, from: companyA, to: scenario.fundId }],
    });

    const lots = await scenario.lots(investment);
    const received = forAsset(lots, usd).filter((lot) => lot.numAssets > 0);

    // 10 A-shares and 15 B-shares → 2:3, and the split lands one leg per degree.
    expect(total(received)).toBeCloseTo(5000, 6);
    expect(received.find((l) => l.provenanceAssetId === aShares)).toMatchObject({ degree: 1 });
    expect(received.find((l) => l.provenanceAssetId === aShares)!.numAssets).toBeCloseTo(2000, 6);
    expect(received.find((l) => l.provenanceAssetId === bShares)).toMatchObject({ degree: 2 });
    expect(received.find((l) => l.provenanceAssetId === bShares)!.numAssets).toBeCloseTo(3000, 6);
  });
});

// A pure-cash payment names only its payer. Where the payer's assets live in
// some OTHER bucket — an acquirer paying a dividend on the stock it issued in a
// swap — the payment used to land in the payer's own empty bucket, attributed to
// nothing and invisible to every valuation. It now anchors where the holding it
// was paid on lives.
describe('one-way cash anchors into the bucket its rights live in', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('files an acquirer dividend as degree-2 cash under the acquired company', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 30, from: companyB, to: scenario.fundId },
      ],
    });
    // B pays a dividend on its own stock — the stock we took for Company A.
    await scenario.transaction({
      date: '2024-08-01',
      transfers: [{ assetId: usd, num: 4000, from: companyB, to: scenario.fundId }],
    });

    const lots = await scenario.lots(investment);
    const received = forAsset(lots, usd).filter((lot) => lot.numAssets > 0);

    expect(received).toMatchObject([
      { numAssets: 4000, degree: 2, provenanceAssetId: bShares, tense: 'fact', source: 'INVESTMENT' },
    ]);
    expect(received[0].investeeEntityKey.split(':')[0]).toEqual(companyA);
  });

  it('leaves a dividend in the payer\'s own bucket when that is where its assets live', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investmentA = await scenario.investment({ investeeId: companyA });
    const investmentB = await scenario.investment({ investeeId: companyB });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investmentA,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-02-01',
      investmentId: investmentB,
      transfers: [
        { assetId: usd, num: 40000, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 10, from: companyB, to: scenario.fundId },
      ],
    });
    // No swap: B's stock is its own investment, so B's dividend stays under B.
    await scenario.transaction({
      date: '2024-08-01',
      transfers: [{ assetId: usd, num: 4000, from: companyB, to: scenario.fundId }],
    });

    const lots = await withTeamContext(scenario.teamId, () =>
      getLotsForInvestments({ investmentIds: [investmentA, investmentB], asOfDate: AS_OF_DATE }),
    );
    const received = forAsset(lots, usd).filter((lot) => lot.numAssets > 0);

    expect(received).toMatchObject([
      { numAssets: 4000, degree: 1, provenanceAssetId: bShares },
    ]);
    expect(received[0].investeeEntityKey.split(':')[0]).toEqual(companyB);
  });
});

// The annotation path and the walk must never drift apart: whatever the lots
// say, summing them back by bucket + asset + source has to reproduce the
// holdings the roll-up built. Run over the shapes the heavyweight valuation
// fixtures exercise — acquisition with a partial exit, an SPV roll-up, and a
// wind-down.
describe('lots re-aggregate to the holdings the walk produced', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  async function expectParity(investmentId: string): Promise<void> {
    const [lots, holdings] = await Promise.all([
      scenario.lots(investmentId),
      scenario.holdings(investmentId),
    ]);

    const summed = new Map<string, number>();
    for (const lot of lots) {
      const key = `${lot.investingEntityKey}|${lot.investeeEntityKey}|${lot.assetKey}|${lot.source}`;
      summed.set(key, (summed.get(key) ?? 0) + lot.numAssets);
    }

    let compared = 0;
    for (const [investingEntityKey, investeeEntityKey, investeeHoldings] of holdings.entries()) {
      for (const [assetKey, holding] of investeeHoldings.entries()) {
        const prefix = `${investingEntityKey}|${investeeEntityKey}|${assetKey}`;
        const { fromInvestment, fromOtherTransactions } = holding.sum();
        expect(summed.get(`${prefix}|INVESTMENT`) ?? 0).toBeCloseTo(fromInvestment, 6);
        expect(summed.get(`${prefix}|OTHER`) ?? 0).toBeCloseTo(fromOtherTransactions, 6);
        compared += 2;
        summed.delete(`${prefix}|INVESTMENT`);
        summed.delete(`${prefix}|OTHER`);
      }
    }

    // No lot may sit outside the holdings it was derived from.
    expect(Array.from(summed.keys())).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  }

  it('acquisition with a partial exit', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const companyB = await scenario.entity({ name: 'Company B' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const bShares = await scenario.asset({ issuerId: companyB, name: 'B Shares', type: AssetType.EQUITY });
    const investmentA = await scenario.investment({ investeeId: companyA });
    const investmentB = await scenario.investment({
      investeeId: companyB,
      type: InvestmentType.EQUITY_TRANSFER,
    });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investmentA,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      investmentId: investmentB,
      transfers: [
        { assetId: aShares, num: 20, from: scenario.fundId, to: companyB },
        { assetId: bShares, num: 30, from: companyB, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-09-01',
      transfers: [
        { assetId: bShares, num: 5, from: scenario.fundId, to: companyB },
        { assetId: usd, num: 20000, from: companyB, to: scenario.fundId },
      ],
    });

    await expectParity(investmentA);
    await expectParity(investmentB);
  });

  it('SPV roll-up', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    const cShares = await scenario.asset({ issuerId: companyC, name: 'C Shares', type: AssetType.EQUITY });
    const spvInterest = await scenario.asset({
      issuerId: spv,
      name: 'C SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyC },
    });
    const investment = await scenario.investment({ investeeId: companyC });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 30000, from: scenario.fundId, to: companyC },
        { assetId: cShares, num: 15, from: companyC, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-06-01',
      transfers: [
        { assetId: cShares, num: 15, from: scenario.fundId, to: spv },
        { assetId: spvInterest, num: 1, from: spv, to: scenario.fundId },
      ],
    });

    // The SPV interest tracks Company C through the issuer's underlying, so it
    // resets to degree 0 exactly as the SAFE conversion does.
    const lots = await scenario.lots(investment);
    expect(forAsset(lots, spvInterest)).toMatchObject([{ degree: 0, provenanceAssetId: cShares }]);

    await expectParity(investment);
  });

  it('wind-down', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyA = await scenario.entity({ name: 'Company A' });
    const aShares = await scenario.asset({ issuerId: companyA, name: 'A Shares', type: AssetType.EQUITY });
    const investment = await scenario.investment({ investeeId: companyA });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 50000, from: scenario.fundId, to: companyA },
        { assetId: aShares, num: 20, from: companyA, to: scenario.fundId },
      ],
    });
    await scenario.transaction({
      date: '2024-11-02',
      transfers: [{ assetId: aShares, num: 20, from: scenario.fundId, to: companyA }],
    });

    await expectParity(investment);
  });
});
