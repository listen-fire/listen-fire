// A wind-down's CASH PAYOUT must land in the investment's realised value.
//
// The payout is booked as currency FROM THE WOUND-DOWN COMPANY to the investor
// (applyWindDown's per-investor `transactions` loop). The inventory walk
// (inventory/data.ts `getTransactionsForAssets`) only discovers a transaction
// when it either moves a tracked asset or names that asset's ISSUER as one of
// its two sides. For a direct holding the issuer IS the paying company, so the
// cash is found. For a position held through an SPV the tracked asset's issuer
// is the SPV, the payer is the company, and the cash is never associated with
// the position at all — it disappears from realised value.
//
//   (control) direct holding: payout reaches realised — this must pass.
//   (a) SPV interest whose `spv_investment_target_company_id` is the company.
//   (b) equity ISSUED by an SPV wrapper whose `underlying_company_id` is the
//       company.
//   (c) the same hole on a DIVIDEND: cash from a company held through an SPV,
//       with the position still open.
//
// Runs the REAL service (applyWindDown) through a write-abilitied Context +
// enterTransaction, exactly as the tRPC / REST callers do, then re-values
// through getInvestmentsValuation.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../kysely';
import { Context } from '../../../../services/context';
import { getInvestmentsValuation } from '../../valuation';
import { applyWindDown } from '../wind_down';
import { applyDividends } from '../dividends';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import PriceType from '../../../../generated/kysely/valuations/PriceType';
import InvestmentType from '../../../../generated/kysely/valuations/InvestmentType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../../services/principal';

const AS_OF_DATE = new Date('2024-12-31');
const WIND_DOWN_DATE = '2024-06-01';
const DIVIDEND_DATE = '2024-06-01';
const PAYOUT = 12000;
const DIVIDEND = 3000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

async function withTeamContext<T>(
  teamId: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx.runAsync(fn);
}

// The same seeding toolkit wind_down.integration.test.ts uses, plus a payout
// argument on `windDown` (the Funding tab's per-investor cash transfers).
class Scenario {
  readonly teamId: TeamId;
  readonly userId: UserId;
  readonly fundId: string;
  private readonly usdAssetIds = new Set<string>();

  private constructor(teamId: TeamId, userId: UserId, fundId: string) {
    this.teamId = teamId;
    this.userId = userId;
    this.fundId = fundId;
  }

  static async create(): Promise<Scenario> {
    const teamId = randomUUID() as TeamId;
    const userId = randomUUID() as UserId;
    await getCoreQb(['team'])
      .insertInto('team')
      .values(anyVals({ id: teamId, name: `wdr-${teamId.slice(0, 8)}` }))
      .execute();
    await getCoreQb(['user'])
      .insertInto('user')
      .values(
        anyVals({ id: userId, default_team_id: teamId, username: `wdr-${userId.slice(0, 8)}` }),
      )
      .execute();
    const s = new Scenario(teamId, userId, randomUUID());
    await s.entity({
      id: s.fundId,
      name: 'Our Fund',
      type: LegalEntityType.FUND,
      ownInvesting: true,
    });
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

  async transaction({
    date,
    investmentId = null,
    transfers,
  }: {
    date: string;
    investmentId?: string | null;
    transfers: { assetId: string; num: number; from: string; to: string }[];
  }): Promise<string> {
    const id = randomUUID();
    await getValuationsQb(['transaction'])
      .insertInto('transaction')
      .values(anyVals({ id, team_id: this.teamId, close_date: date, investment_id: investmentId }))
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

  /** Drive the real service exactly as the Funding tab does: the wind-down plus
   *  its per-investor cash payouts, in one transaction. */
  async windDown(
    companyId: string,
    { payout, date = WIND_DOWN_DATE }: { payout?: number; date?: string } = {},
  ): Promise<{ eventId: string }> {
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId: this.userId, teamId: this.teamId }));
    return ctx.runAsync(async () => {
      await ctx.enterTransaction();
      return applyWindDown({
        companyId,
        date,
        transactions: payout
          ? [{ numAssets: payout, currency: CurrencyIsoCode.USD, investorId: this.fundId }]
          : undefined,
      });
    });
  }

  /** The Funding tab's dividend, through the real service. */
  async dividend(
    companyId: string,
    { amount, date = DIVIDEND_DATE }: { amount: number; date?: string },
  ): Promise<{ eventId: string }> {
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId: this.userId, teamId: this.teamId }));
    return ctx.runAsync(async () => {
      await ctx.enterTransaction();
      return applyDividends({
        companyId,
        date,
        amount,
        currency: CurrencyIsoCode.USD,
        fundId: this.fundId,
      });
    });
  }

  value(investmentId: string) {
    return withTeamContext(this.teamId, this.userId, () =>
      getInvestmentsValuation({
        investments: [{ id: investmentId, date: null }],
        asOfDate: AS_OF_DATE,
        fxDate: AS_OF_DATE,
        targetCurrency: CurrencyIsoCode.USD,
      }),
    );
  }

  async cleanup(): Promise<void> {
    await getValuationsQb(['price'])
      .deleteFrom('price')
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['asset_transfer'])
      .deleteFrom('asset_transfer')
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['transaction'])
      .deleteFrom('transaction')
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['investment'])
      .deleteFrom('investment')
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['event'])
      .deleteFrom('event')
      .where('team_id', '=', this.teamId)
      .execute();
    for (const usdAssetId of this.usdAssetIds) {
      await getValuationsQb(['currency_asset'])
        .deleteFrom('currency_asset')
        .where('asset_id', '=', usdAssetId as never)
        .execute();
    }
    await getValuationsQb(['asset'])
      .deleteFrom('asset')
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['legal_entity'])
      .deleteFrom('legal_entity')
      .where('team_id', '=', this.teamId)
      .execute();
    await getValuationsQb(['valuations_change_outbox'])
      .deleteFrom('valuations_change_outbox')
      .where('team_id', '=', this.teamId)
      .execute();
    await getCoreQb(['user']).deleteFrom('user').where('id', '=', this.userId).execute();
    await getCoreQb(['team']).deleteFrom('team').where('id', '=', this.teamId).execute();
  }
}

describe('wind-down cash payout → realised value', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario.cleanup();
  });

  it('(control) direct holding: the payout is realised against the investment', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const cShares = await scenario.asset({
      issuerId: companyC,
      name: 'Company C Shares',
      type: AssetType.EQUITY,
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
    await scenario.price({ assetId: cShares, issuerId: companyC, price: 2500, date: '2024-02-01' });

    const before = await scenario.value(investment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(37500, 2);
    expect(before.realizedCashTransactionDateValue).toBeCloseTo(0, 2);

    await scenario.windDown(companyC, { payout: PAYOUT });

    const after = await scenario.value(investment);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    // The company paid the fund PAYOUT on the way out — that is realised cash.
    expect(after.realizedCashTransactionDateValue).toBeCloseTo(PAYOUT, 2);
    expect(after.totalValuationDateValue).toBeCloseTo(PAYOUT, 2);
  });

  it('(a) SPV interest: the payout is realised against the SPV-held position', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    const spvInterest = await scenario.asset({
      issuerId: spv,
      name: 'C SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyC },
    });
    // The investment is profiled to the SPV; the fund's asset is the SPV
    // interest, whose ISSUER is the SPV — never Company C.
    const spvInvestment = await scenario.investment({ investeeId: spv });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: spvInvestment,
      transfers: [
        { assetId: usd, num: 20000, from: scenario.fundId, to: spv },
        { assetId: spvInterest, num: 1, from: spv, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: spvInterest, issuerId: spv, price: 20000, date: '2024-02-01' });

    const before = await scenario.value(spvInvestment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(20000, 2);

    await scenario.windDown(companyC, { payout: PAYOUT });

    const after = await scenario.value(spvInvestment);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(after.realizedCashTransactionDateValue).toBeCloseTo(PAYOUT, 2);
    expect(after.totalValuationDateValue).toBeCloseTo(PAYOUT, 2);
  });

  it('(b) SPV-issued equity: the payout is realised against the wrapped position', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C Wrapper SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    // Equity ISSUED by the SPV wrapper (issuer = spv, underlying = companyC).
    const spvEquity = await scenario.asset({
      issuerId: spv,
      name: 'SPV Wrapper Shares',
      type: AssetType.EQUITY,
    });
    const investment = await scenario.investment({ investeeId: companyC });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: investment,
      transfers: [
        { assetId: usd, num: 20000, from: scenario.fundId, to: spv },
        { assetId: spvEquity, num: 10, from: spv, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: spvEquity, issuerId: spv, price: 2000, date: '2024-02-01' });

    const before = await scenario.value(investment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(20000, 2);

    await scenario.windDown(companyC, { payout: PAYOUT });

    const after = await scenario.value(investment);
    expect(after.unrealizedValuationDateValue).toBeCloseTo(0, 2);
    expect(after.realizedCashTransactionDateValue).toBeCloseTo(PAYOUT, 2);
    expect(after.totalValuationDateValue).toBeCloseTo(PAYOUT, 2);
  });

  it('(c) dividend from a company held through an SPV is realised', async () => {
    scenario = await Scenario.create();
    const usd = await scenario.usd();
    const companyC = await scenario.entity({ name: 'Company C' });
    const spv = await scenario.entity({
      name: 'C SPV',
      type: LegalEntityType.SPV,
      underlyingCompanyId: companyC,
    });
    const spvInterest = await scenario.asset({
      issuerId: spv,
      name: 'C SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: { spv_investment_target_company_id: companyC },
    });
    const spvInvestment = await scenario.investment({ investeeId: spv });

    await scenario.transaction({
      date: '2024-01-01',
      investmentId: spvInvestment,
      transfers: [
        { assetId: usd, num: 20000, from: scenario.fundId, to: spv },
        { assetId: spvInterest, num: 1, from: spv, to: scenario.fundId },
      ],
    });
    await scenario.price({ assetId: spvInterest, issuerId: spv, price: 20000, date: '2024-02-01' });

    const before = await scenario.value(spvInvestment);
    expect(before.unrealizedValuationDateValue).toBeCloseTo(20000, 2);
    expect(before.realizedCashTransactionDateValue).toBeCloseTo(0, 2);

    // Company C pays the fund a dividend; the fund's asset is issued by the SPV.
    await scenario.dividend(companyC, { amount: DIVIDEND });

    const after = await scenario.value(spvInvestment);
    // The position is untouched — the dividend is cash out of it, not an exit.
    expect(after.unrealizedValuationDateValue).toBeCloseTo(20000, 2);
    expect(after.realizedCashTransactionDateValue).toBeCloseTo(DIVIDEND, 2);
    expect(after.totalValuationDateValue).toBeCloseTo(20000 + DIVIDEND, 2);
  });
});
