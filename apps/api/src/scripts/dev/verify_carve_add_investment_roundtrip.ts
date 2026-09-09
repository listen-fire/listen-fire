/**
 * Phase 5.1 close-out: exercise the ported AddInvestment form's mutation
 * (views.portfolio.company.addInvestment) through the real tRPC path against
 * the seeded NewCo/Fund I fixture, then re-read getOverview to confirm the
 * new investment's money shows up. Throwaway — not part of the dev-loop
 * fixture, safe to delete after the close-out is recorded.
 */
import { runInContext } from '../../services/context/utils';
import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';

const COMPANY_SLUG = 'newco-carve-probe';

async function main() {
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'default_team_id'])
    .where('username', '=', 'dev-loop')
    .executeTakeFirstOrThrow();

  const [company, fund] = await Promise.all([
    getValuationsQb(['legal_entity'])
      .selectFrom('legal_entity')
      .select(['id'])
      .where('slug', '=', COMPANY_SLUG)
      .executeTakeFirstOrThrow(),
    getValuationsQb(['legal_entity'])
      .selectFrom('legal_entity')
      .select(['id'])
      .where('name', '=', 'Fund I')
      .executeTakeFirstOrThrow(),
  ]);

  await runInContext(
    async (ctx) => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });

      const before = await caller.views.portfolio.company.getOverview({
        slug: COMPANY_SLUG,
        config: { currency: 'GBP' },
      });
      console.log('BEFORE', JSON.stringify({ invested: before?.invested, value: before?.value, holdingsLength: before?.holdings?.length }, null, 2));

      const result = await caller.views.portfolio.company.addInvestment({
        entity: company.id,
        investingEntity: fund.id,
        investingEntityName: 'Fund I',
        investmentDate: '2026-08-01T00:00:00.000Z',
        investmentAmount: '250000',
        investmentCurrency: 'GBP',
        investmentType: 'EQUITY',
        pricePerShare: '125',
        pricePerShareCurrency: 'GBP',
        numberOfShares: '2000',
        roundName: 'Series A',
        totalRaisedAmount: '2000000',
        totalRaisedCurrency: 'GBP',
        valuationAmount: '10000000',
        valuationCurrency: 'GBP',
        valuationType: 'PRE_MONEY',
      } as never);
      console.log('MUTATION RESULT', JSON.stringify(result, null, 2));

      const after = await caller.views.portfolio.company.getOverview({
        slug: COMPANY_SLUG,
        config: { currency: 'GBP' },
      });
      console.log('AFTER', JSON.stringify({
        invested: after?.invested,
        value: after?.value,
        realizedValue: after?.realizedValue,
        totalShares: after?.totalShares,
        moic: after?.moic,
        holdingsLength: after?.holdings?.length,
        investmentsCount: after?.investments?.length,
      }, null, 2));
    },
    { id: user.id },
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
